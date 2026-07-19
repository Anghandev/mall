import { randomUUID } from 'node:crypto';
import { TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers';
import {
  normalizeAddress,
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import {
  NPL_ADDRESS,
  NPL_USDT_PAIR_ADDRESS,
  systemConfigKeys,
  USDT_ADDRESS,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const CONFIG_KEYS = systemConfigKeys;
type ConfigKey = (typeof CONFIG_KEYS)[number];

interface ConfigRow {
  config_version_id: string;
  config_key: ConfigKey;
  version: number;
  payload: Record<string, unknown>;
  payload_hash: string;
  effective_from: Date | string;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: Date | string;
}

export interface ConfigApprovalInput {
  action: string;
  resourceType: string;
  resourceId: string;
  policyVersion: string;
  oldValueHash: string;
  newValueHash: string;
  executorWallet: string;
  nonce: string;
  deadline: string;
  signature: string;
}

export class SystemConfigService {
  readonly #transactions: SqlTransactionRunner;
  readonly #secondarySigner: string;
  readonly #governanceWallet: string;
  readonly #verifyingContract: string;
  readonly #auditReady: () => boolean | Promise<boolean>;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    secondarySigner: string;
    governanceWallet: string;
    verifyingContract: string;
    auditReady: () => boolean | Promise<boolean>;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#secondarySigner = normalizeAddress(input.secondarySigner);
    this.#governanceWallet = normalizeAddress(input.governanceWallet);
    this.#verifyingContract = normalizeAddress(input.verifyingContract);
    this.#auditReady = input.auditReady;
    this.#clock = input.clock ?? (() => new Date());
  }

  createVersion(actor: FulfillmentActor, input: {
    configKey: ConfigKey;
    payload: unknown;
    effectiveFrom: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!CONFIG_KEYS.includes(input.configKey)) throw new CoreError('InvalidRequest', 'System config key is invalid');
    if (input.configKey === 'FREIGHT') {
      throw new CoreError('InvalidRequest', 'Freight is configured per product through defaultFreightUsdt');
    }
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey)) throw new CoreError('InvalidRequest', 'System config idempotency key is invalid');
    const payload = validateConfigPayload(input.configKey, input.payload);
    const effectiveFrom = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) throw new CoreError('InvalidRequest', 'System config effective time is invalid');
    const payloadHash = hashJson(payload);
    const requestHash = hashJson({ wallet, configKey: input.configKey, payload, effectiveFrom: effectiveFrom.toISOString() });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<ConfigRow>(
        'SELECT * FROM core.system_config_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'System config idempotency conflict', 409);
        return configProjection(existing.rows[0], false);
      }
      const latest = await executor.query<{ version: number }>(
        'SELECT COALESCE(max(version), 0)::integer + 1 AS version FROM core.system_config_versions WHERE config_key = $1',
        [input.configKey],
      );
      const version = Number(latest.rows[0]?.version ?? 1);
      const configVersionId = `system-config:${input.configKey.toLowerCase()}:${randomUUID()}`;
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.system_config_versions (
           config_version_id, config_key, version, payload, payload_hash,
           effective_from, idempotency_key, request_hash, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [configVersionId, input.configKey, version, JSON.stringify(payload), payloadHash, effectiveFrom, input.idempotencyKey, requestHash, wallet, now],
      );
      await operationalAudit(executor, {
        eventType: 'SystemConfigVersionCreated',
        configVersionId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { configKey: input.configKey, version, payloadHash, effectiveFrom: effectiveFrom.toISOString() },
        now,
      });
      return configProjection((await executor.query<ConfigRow>('SELECT * FROM core.system_config_versions WHERE config_version_id = $1', [configVersionId])).rows[0]!, false);
    });
  }

  approvalChallenge(
    actor: FulfillmentActor,
    configVersionId: string,
    input: { nonce: string; deadline: string },
  ) {
    requireSessionRole(actor, 'ADMIN');
    const wallet = normalizeAddress(actor.walletAddress);
    const nonce = unsignedBigInt(input.nonce, 'system config approval nonce');
    const deadline = unsignedBigInt(input.deadline, 'system config approval deadline');
    if (deadline < BigInt(Math.floor(this.#clock().getTime() / 1_000))) {
      throw new CoreError('NonceExpired', 'System config approval expired', 401);
    }
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedConfig(executor, configVersionId);
      assertConfigKeyActive(row.config_key);
      const current = await currentConfig(executor, row.config_key);
      const policyVersion = BigInt(await latestPolicyVersion(executor));
      const intent: SensitiveActionIntent = {
        action: 'PUBLISH_SYSTEM_CONFIG',
        resourceType: 'SYSTEM_CONFIG',
        resourceId: configVersionId,
        policyVersion,
        oldValueHash: current?.payload_hash ?? ZERO_HASH,
        newValueHash: row.payload_hash,
        executorWallet: this.#governanceWallet,
        nonce,
        deadline,
      };
      const typedData = {
        domain: sensitiveActionDomain(this.#verifyingContract),
        types: sensitiveActionTypes,
        primaryType: 'SensitiveAction' as const,
        message: serializableIntent(intent),
      };
      return Object.freeze({
        configVersionId,
        signer: this.#secondarySigner,
        ...serializableIntent(intent),
        typedData,
        digest: TypedDataEncoder.hash(typedData.domain, typedData.types, intent).toLowerCase(),
      });
    });
  }

  async publish(actor: FulfillmentActor, configVersionId: string, approval: ConfigApprovalInput) {
    requireSessionRole(actor, 'ADMIN');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!await this.#auditReady()) throw new CoreError('ExternalBlocked', 'Audit database is unavailable for system config publication', 503);
    const prepared = await this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedConfig(executor, configVersionId);
      assertConfigKeyActive(row.config_key);
      const existingPublication = await executor.query<{ action_digest: string; approval_signature_hash: string }>(
        `SELECT action_digest, approval_signature_hash
         FROM core.system_config_publication_events WHERE active_config_version_id = $1`,
        [configVersionId],
      );
      if (existingPublication.rows[0]) return { existing: existingPublication.rows[0], row } as const;
      const current = await currentConfig(executor, row.config_key);
      const latestVersion = await latestPolicyVersion(executor);
      const intent = approvalIntent(approval);
      if (
        intent.action !== 'PUBLISH_SYSTEM_CONFIG'
        || intent.resourceType !== 'SYSTEM_CONFIG'
        || intent.resourceId !== configVersionId
        || intent.policyVersion !== BigInt(latestVersion)
        || intent.oldValueHash.toLowerCase() !== (current?.payload_hash.toLowerCase() ?? ZERO_HASH)
        || intent.newValueHash.toLowerCase() !== row.payload_hash.toLowerCase()
      ) throw new CoreError('InvalidRequest', 'System config approval does not match the exact old/new version', 409);
      const verified = verifySensitiveActionApproval(
        intent,
        approval.signature,
        this.#secondarySigner,
        this.#governanceWallet,
        this.#verifyingContract,
        this.#clock(),
      );
      const actionDigest = TypedDataEncoder.hash(
        sensitiveActionDomain(this.#verifyingContract),
        sensitiveActionTypes,
        intent,
      ).toLowerCase();
      return { row, current, verified, intent, actionDigest } as const;
    });
    if ('existing' in prepared) return configProjection(prepared.row, true);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedConfig(executor, configVersionId);
      if (row.payload_hash !== prepared.row.payload_hash) {
        throw new CoreError('IdempotencyConflict', 'System config changed during signature verification', 409);
      }
      const current = await currentConfig(executor, row.config_key);
      if ((current?.payload_hash ?? ZERO_HASH).toLowerCase() !== prepared.intent.oldValueHash.toLowerCase()) {
        throw new CoreError('IdempotencyConflict', 'System config current version changed during approval', 409);
      }
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.system_config_publication_events (
           event_id, config_key, active_config_version_id, previous_config_version_id,
           action_digest, secondary_signer, governance_wallet_address, approval_signature_hash,
           actor_wallet, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          `system-config-publication:${randomUUID()}`,
          row.config_key,
          row.config_version_id,
          current?.config_version_id ?? null,
          prepared.actionDigest,
          prepared.verified.signer,
          this.#governanceWallet,
          keccak256(approval.signature).toLowerCase(),
          wallet,
          now,
        ],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload,
           idempotency_key, state
         ) VALUES ($1,'SYSTEM_CONFIG',$2,'SystemConfigPublished',$3,$1,'PENDING')`,
        [
          `outbox:system-config:${configVersionId}`,
          configVersionId,
          JSON.stringify({
            configKey: row.config_key,
            version: row.version,
            payloadHash: row.payload_hash,
            governanceWallet: this.#governanceWallet,
          }),
        ],
      );
      await operationalAudit(executor, {
        eventType: 'SystemConfigPublished',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        configVersionId,
        actorWallet: wallet,
        roles,
        correlationId: `system-config:${configVersionId}`,
        requestHash: prepared.actionDigest,
        payload: {
          configKey: row.config_key,
          version: row.version,
          oldValueHash: prepared.intent.oldValueHash,
          newValueHash: row.payload_hash,
          secondarySigner: prepared.verified.signer,
          governanceWallet: this.#governanceWallet,
          approvalSignatureHash: keccak256(approval.signature).toLowerCase(),
        },
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: keccak256(approval.signature).toLowerCase(),
          signer: prepared.verified.signer,
          digest: prepared.actionDigest,
          domain: `Abu24KV2Core:2:56:${this.#verifyingContract}`,
          nonce: prepared.intent.nonce.toString(),
          deadline: prepared.intent.deadline.toString(),
        },
        now,
      });
      return configProjection(row, true);
    });
  }

  list(actor: FulfillmentActor) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, normalizeAddress(actor.walletAddress), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const rows = await executor.query<ConfigRow & { published: boolean }>(
        `SELECT version.*, EXISTS (
           SELECT 1 FROM core.system_config_publication_events event
           WHERE event.active_config_version_id = version.config_version_id
         ) AS published
         FROM core.system_config_versions version
         WHERE version.config_key <> 'MERCHANT_LEVELS'
         ORDER BY config_key, version DESC`,
      );
      return rows.rows.map((row) => configProjection(row, row.published));
    });
  }
}

function assertConfigKeyActive(key: string) {
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new CoreError('InvalidRequest', 'System config key is retired', 409);
  }
}

function validateConfigPayload(key: ConfigKey, value: unknown) {
  const input = record(value, 'system config payload');
  if (key === 'BUSINESS') {
    exactKeys(input, ['unpaidReservationTimeoutSeconds', 'businessTimezone']);
    const timeout = boundedInteger(input.unpaidReservationTimeoutSeconds, 60, 86_400, 'unpaid reservation timeout');
    const timezone = stringValue(input.businessTimezone, 'business timezone');
    if (timezone !== 'Asia/Shanghai') throw new CoreError('InvalidRequest', 'Business timezone must be Asia/Shanghai');
    return { unpaidReservationTimeoutSeconds: timeout, businessTimezone: timezone };
  }
  if (key === 'FREIGHT') {
    exactKeys(input, ['mode', 'currency', 'defaultAmount', 'pickupFreeRegionCodes', 'remoteNoDeliveryRegionCodes']);
    if (!['PER_ITEM', 'PER_WEIGHT'].includes(String(input.mode)) || input.currency !== 'USDT') throw new CoreError('InvalidRequest', 'Freight mode or currency is invalid');
    return {
      mode: input.mode,
      currency: 'USDT',
      defaultAmount: unsigned(input.defaultAmount, 'freight default amount'),
      pickupFreeRegionCodes: regionCodes(input.pickupFreeRegionCodes),
      remoteNoDeliveryRegionCodes: regionCodes(input.remoteNoDeliveryRegionCodes),
    };
  }
  if (key === 'RPC') {
    exactKeys(input, ['chainId', 'primaryRpcSecretRef', 'fallbackRpcSecretRef', 'explorerApiSecretRef']);
    if (input.chainId !== 56) throw new CoreError('InvalidRequest', 'RPC config must use BSC 56');
    return {
      chainId: 56,
      primaryRpcSecretRef: secretRef(input.primaryRpcSecretRef, 'primary RPC'),
      fallbackRpcSecretRef: secretRef(input.fallbackRpcSecretRef, 'fallback RPC'),
      explorerApiSecretRef: secretRef(input.explorerApiSecretRef, 'explorer API'),
    };
  }
  if (key === 'NPL_QUOTE') {
    exactKeys(input, ['pairAddress', 'quoteValiditySeconds', 'minimumUsdtLiquidity']);
    const result = {
      pairAddress: normalizeAddress(stringValue(input.pairAddress, 'NPL quote pair')),
      quoteValiditySeconds: boundedInteger(input.quoteValiditySeconds, 1, 3_600, 'quote validity'),
      minimumUsdtLiquidity: unsigned(input.minimumUsdtLiquidity, 'NPL quote minimum liquidity'),
    };
    if (
      result.pairAddress !== NPL_USDT_PAIR_ADDRESS
      || result.quoteValiditySeconds !== 300
      || result.minimumUsdtLiquidity !== (50_000n * 10n ** 18n).toString()
    ) throw new CoreError('InvalidRequest', 'NPL quote config violates the frozen policy');
    return result;
  }
  if (key === 'GAS') {
    exactKeys(input, ['seckillMaxGasPriceWei', 'highGasRestrictionSeconds']);
    const restriction = boundedInteger(input.highGasRestrictionSeconds, 1, 7 * 86_400, 'high Gas restriction');
    if (restriction !== 86_400) throw new CoreError('InvalidRequest', 'High Gas restriction must be exactly 24 hours');
    return { seckillMaxGasPriceWei: unsigned(input.seckillMaxGasPriceWei, 'seckill max Gas price'), highGasRestrictionSeconds: restriction };
  }
  if (key === 'CHAIN') {
    exactKeys(input, [
      'chainId', 'usdtAddress', 'nplAddress', 'pairAddress', 'paymentRouterAddress',
      'policyRegistryAddress', 'beneficiaryRegistryAddress',
      'usdtSettlementWallet', 'nplRewardWallet', 'operationsWallet',
    ]);
    if (input.chainId !== 56) throw new CoreError('InvalidRequest', 'Chain config must use BSC 56');
    const result = Object.fromEntries(Object.entries(input).map(([name, child]) => [
      name,
      name === 'chainId' ? 56 : normalizeAddress(stringValue(child, name)),
    ])) as Record<string, unknown>;
    if (result.usdtAddress !== USDT_ADDRESS || result.nplAddress !== NPL_ADDRESS || result.pairAddress !== NPL_USDT_PAIR_ADDRESS) {
      throw new CoreError('InvalidRequest', 'Chain config changes a frozen asset or pair');
    }
    const wallets = [result.usdtSettlementWallet, result.nplRewardWallet, result.operationsWallet];
    if (new Set(wallets).size !== 3) {
      throw new CoreError('InvalidRequest', 'Settlement, Reward and Operations wallets must be distinct');
    }
    return result;
  }
  exactKeys(input, ['ossCredentialRef', 'cdnEnabled', 'aiPromptVersion', 'aiProviderSecretRef']);
  if (typeof input.cdnEnabled !== 'boolean') throw new CoreError('InvalidRequest', 'CDN enabled must be boolean');
  return {
    ossCredentialRef: secretRef(input.ossCredentialRef, 'OSS credential'),
    cdnEnabled: input.cdnEnabled,
    aiPromptVersion: boundedInteger(input.aiPromptVersion, 1, Number.MAX_SAFE_INTEGER, 'AI prompt version'),
    aiProviderSecretRef: secretRef(input.aiProviderSecretRef, 'AI provider'),
  };
}

function approvalIntent(input: ConfigApprovalInput): SensitiveActionIntent {
  return {
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    policyVersion: unsignedBigInt(input.policyVersion, 'policyVersion'),
    oldValueHash: hash(input.oldValueHash, 'oldValueHash'),
    newValueHash: hash(input.newValueHash, 'newValueHash'),
    executorWallet: normalizeAddress(input.executorWallet),
    nonce: unsignedBigInt(input.nonce, 'nonce'),
    deadline: unsignedBigInt(input.deadline, 'deadline'),
  };
}

function serializableIntent(intent: SensitiveActionIntent) {
  return Object.freeze({
    action: intent.action,
    resourceType: intent.resourceType,
    resourceId: intent.resourceId,
    policyVersion: intent.policyVersion.toString(),
    oldValueHash: intent.oldValueHash.toLowerCase(),
    newValueHash: intent.newValueHash.toLowerCase(),
    executorWallet: normalizeAddress(intent.executorWallet),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  });
}

async function latestPolicyVersion(executor: SqlExecutor) {
  const result = await executor.query<{ policy_version: string | number }>(
    'SELECT policy_version FROM core.canonical_policy_publications ORDER BY policy_version DESC LIMIT 1',
  );
  if (!result.rows[0]) throw new CoreError('DecisionBlocked', 'No canonical policy is available', 409);
  return Number(result.rows[0].policy_version);
}

async function lockedConfig(executor: SqlExecutor, configVersionId: string) {
  const result = await executor.query<ConfigRow>('SELECT * FROM core.system_config_versions WHERE config_version_id = $1 FOR UPDATE', [configVersionId]);
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'System config version not found', 404);
  return result.rows[0];
}

async function currentConfig(executor: SqlExecutor, key: ConfigKey) {
  const result = await executor.query<ConfigRow>(
    `SELECT version.* FROM core.current_system_config current
     JOIN core.system_config_versions version ON version.config_version_id = current.config_version_id
     WHERE current.config_key = $1`,
    [key],
  );
  return result.rows[0];
}

async function operationalAudit(executor: SqlExecutor, input: {
  eventType: string;
  evidenceProfile?: 'RBAC' | 'SIGNED_OFFCHAIN';
  configVersionId: string;
  actorWallet: string;
  roles: string[];
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  signatureEvidence?: {
    scheme: 'EIP712';
    signatureHash: string;
    signer: string;
    digest: string;
    domain: string;
    nonce: string;
    deadline: string;
  };
  now: Date;
}) {
  const evidenceHash = hashJson({ wallet: input.actorWallet, roles: input.roles, checkedAt: input.now.toISOString() });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:system-config', { eventType: input.eventType, configVersionId: input.configVersionId, requestHash: input.requestHash }),
    streamName: 'operational',
    evidenceProfile: input.evidenceProfile ?? 'RBAC',
    eventType: input.eventType,
    resourceType: 'SYSTEM_CONFIG',
    resourceId: input.configVersionId,
    actorWallet: input.actorWallet,
    actorRole: input.roles[0]!,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actorWallet,
      roles: input.roles,
      evidenceHash,
      checkedAt: input.now.toISOString(),
    },
    ...(input.signatureEvidence ? { signatureEvidence: input.signatureEvidence } : {}),
    createdAt: input.now,
  });
}

async function requireCurrentRole(executor: SqlExecutor, wallet: string, allowed: readonly string[]) {
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, [...allowed]],
  );
  if (result.rows.length === 0) throw new CoreError('Forbidden', 'Current wallet role cannot manage system config', 403);
  return result.rows.map((row) => row.role);
}

function configProjection(row: ConfigRow, published: boolean) {
  return Object.freeze({
    configVersionId: row.config_version_id,
    configKey: row.config_key,
    version: row.version,
    payload: row.payload,
    payloadHash: row.payload_hash,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    published,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function requireSessionRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Wallet session cannot manage system config', 403);
}

function secretRef(value: unknown, name: string) {
  const ref = stringValue(value, name);
  if (!/^(?:vault|secret):\/\/[^\s]+$/.test(ref)) throw new CoreError('InvalidRequest', `${name} must be a secret reference`);
  return ref;
}

function regionCodes(value: unknown) {
  if (!Array.isArray(value)) throw new CoreError('InvalidRequest', 'Region code list is invalid');
  const result = [...new Set(value.map((item) => stringValue(item, 'region code')))].sort();
  if (result.some((item) => !/^\d{6}$/.test(item))) throw new CoreError('InvalidRequest', 'Region code list is invalid');
  return result;
}

function unsigned(value: unknown, name: string) {
  try {
    const parsed = BigInt(typeof value === 'string' || typeof value === 'number' ? value : '');
    if (parsed < 0n) throw new Error('negative');
    return parsed.toString();
  } catch {
    throw new CoreError('InvalidRequest', `${name} must be an unsigned integer`);
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return parsed;
}

function unsignedBigInt(value: string, name: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return BigInt(value);
}

function hash(value: string, name: string) {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return normalized;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('InvalidRequest', `${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CoreError('InvalidRequest', 'System config payload contains unknown fields');
}

function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value;
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

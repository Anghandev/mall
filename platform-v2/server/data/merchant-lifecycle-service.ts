import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { TypedDataEncoder, keccak256 } from 'ethers';
import {
  normalizeAddress,
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  type SensitiveActionIntent,
} from '../api/auth.ts';
import {
  CORE_ARTIFACT_VERSION,
  merchantLevels,
  merchantLifecycleStatuses,
  merchantReviewActions,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { SystemConfigSafeApprover } from '../chain/system-config-governance.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import { currentMerchantLevelPolicy, merchantLevelRule } from './merchant-level-policy.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const LEVELS = merchantLevels;
const STATUSES = merchantLifecycleStatuses;
const REVIEW_ACTIONS = merchantReviewActions;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1_000;

type MerchantLevel = (typeof LEVELS)[number];
type MerchantStatus = (typeof STATUSES)[number];
type ReviewAction = (typeof REVIEW_ACTIONS)[number];

interface MerchantRow {
  merchant_id: string;
  settlement_wallet: string;
  status: MerchantStatus;
  level: MerchantLevel;
  profile: Record<string, unknown>;
  guarantee_status: string;
  profile_version: string | number;
  application_version: string | number;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ApplicationRow {
  merchant_id: string;
  version: string | number;
  encrypted_payload: Uint8Array;
  encryption_iv: Uint8Array;
  encryption_tag: Uint8Array;
  payload_hash: string;
  license_asset_id: string | null;
  actor_wallet: string;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
}

interface ReviewRow {
  action_id: string;
  merchant_id: string;
  action_kind: ReviewAction;
  from_status: MerchantStatus;
  to_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'BLACKLISTED';
  application_version: string | number;
  policy_version: string | number;
  reason_code: string;
  old_value_hash: string;
  new_value_hash: string;
  approval_nonce: string | number;
  approval_deadline: Date;
  state: 'DRAFT' | 'PUBLISHED' | 'EXPIRED';
  secondary_signer: string | null;
  secondary_signature_hash: string | null;
  action_digest: string | null;
  governance_safe_address: string;
  safe_tx_hash: string | null;
  approval_evidence_hash: string | null;
  actor_wallet: string;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface MerchantApplicationInput {
  shopName: string;
  legalName: string;
  legalId: string;
  contactPhone: string;
  settlementWallet: string;
  level: MerchantLevel;
  idempotencyKey: string;
  correlationId: string;
}

export interface MerchantApplicationUpdateInput {
  shopName: string;
  legalName: string;
  legalId: string;
  contactPhone: string;
  level: MerchantLevel;
  licenseAssetId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
  correlationId: string;
}

export class MerchantLifecycleService {
  readonly #transactions: SqlTransactionRunner;
  readonly #approver: SystemConfigSafeApprover;
  readonly #secondarySigner: string;
  readonly #governanceSafe: string;
  readonly #verifyingContract: string;
  readonly #encryptionKey: Buffer | undefined;
  readonly #retentionPolicyVersion: string | undefined;
  readonly #auditReady: () => boolean | Promise<boolean>;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    approver: SystemConfigSafeApprover;
    secondarySigner: string;
    governanceSafe: string;
    verifyingContract: string;
    encryptionKey?: string;
    retentionPolicyVersion?: string;
    auditReady: () => boolean | Promise<boolean>;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#approver = input.approver;
    this.#secondarySigner = normalizeAddress(input.secondarySigner);
    this.#governanceSafe = normalizeAddress(input.governanceSafe);
    this.#verifyingContract = normalizeAddress(input.verifyingContract);
    if (this.#secondarySigner === this.#governanceSafe) {
      throw new CoreError('InvalidRequest', 'Merchant review secondary signer must be independent from the governance Safe', 500);
    }
    this.#encryptionKey = parseEncryptionKey(input.encryptionKey);
    this.#retentionPolicyVersion = retentionPolicy(input.retentionPolicyVersion);
    this.#auditReady = input.auditReady;
    this.#clock = input.clock ?? (() => new Date());
  }

  list(actor: FulfillmentActor, query: {
    status?: MerchantStatus;
    search?: string;
    limit?: number;
    cursorCreatedAt?: Date;
    cursorMerchantId?: string;
  }) {
    const status = query.status === undefined ? undefined : merchantStatus(query.status);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CoreError('InvalidRequest', 'Merchant page limit must be between 1 and 100');
    }
    if ((query.cursorCreatedAt === undefined) !== (query.cursorMerchantId === undefined)) {
      throw new CoreError('InvalidRequest', 'Merchant cursor is incomplete');
    }
    const search = query.search?.trim();
    if (search && search.length > 100) throw new CoreError('InvalidRequest', 'Merchant search is too long');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const clauses: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        clauses.push(sql.replace('?', `$${params.length}`));
      };
      if (status) add('merchant.status = ?', status);
      if (search) {
        params.push(search, `%${escapeLike(search)}%`);
        clauses.push(`(merchant.merchant_id = $${params.length - 1}
          OR lower(merchant.settlement_wallet) = lower($${params.length - 1})
          OR merchant.profile->>'shopName' ILIKE $${params.length} ESCAPE '\\')`);
      }
      if (query.cursorCreatedAt && query.cursorMerchantId) {
        params.push(query.cursorCreatedAt, query.cursorMerchantId);
        clauses.push(`(merchant.created_at, merchant.merchant_id) < ($${params.length - 1}, $${params.length})`);
      }
      params.push(limit + 1);
      const result = await executor.query<MerchantRow & { qualification_complete: boolean }>(
        `SELECT merchant.*, EXISTS (
           SELECT 1 FROM core.merchant_application_versions application
           WHERE application.merchant_id = merchant.merchant_id
             AND application.version = merchant.application_version
             AND application.license_asset_id IS NOT NULL
         ) AS qualification_complete
         FROM core.merchants merchant
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY merchant.created_at DESC, merchant.merchant_id DESC LIMIT $${params.length}`,
        params,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        merchants: rows.map(merchantSummaryProjection),
        nextCursor: hasMore && last
          ? { createdAt: last.created_at.toISOString(), merchantId: last.merchant_id }
          : null,
      };
    });
  }

  get(actor: FulfillmentActor, merchantId: string) {
    validateResourceId(merchantId, 'merchant ID');
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return this.#merchantDetail(executor, merchantId, roles);
    });
  }

  createApplication(actor: FulfillmentActor, input: MerchantApplicationInput) {
    const normalized = applicationInput(input);
    const wallet = normalizeAddress(actor.walletAddress);
    const key = requireEncryptionKey(this.#encryptionKey);
    const retention = requireRetentionPolicy(this.#retentionPolicyVersion);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<ApplicationRow>(
        `SELECT application.* FROM core.merchant_application_versions application
         WHERE application.actor_wallet = $1 AND application.idempotency_key = $2`,
        [wallet, normalized.idempotencyKey],
      );
      const requestHash = keyedHashJson(key, 'ABU24K_MERCHANT_APPLICATION_REQUEST_V1', {
        domain: 'ABU24K_MERCHANT_APPLICATION_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: wallet,
        ...normalized,
        retentionPolicyVersion: retention,
      });
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Merchant application');
        return this.#merchantDetail(executor, existing.rows[0].merchant_id, roles);
      }
      const conflicting = await executor.query<{ merchant_id: string }>(
        `SELECT merchant_id FROM core.merchants WHERE lower(settlement_wallet) = $1
         UNION ALL
         SELECT merchant_id FROM core.wallet_role_bindings
         WHERE lower(wallet_address) = $1 AND role = 'MERCHANT' AND merchant_id IS NOT NULL
         LIMIT 1`,
        [normalized.settlementWallet],
      );
      if (conflicting.rows[0]) throw new CoreError('IdempotencyConflict', 'Settlement wallet is already merchant-bound', 409);
      const merchantId = `merchant:${randomUUID()}`;
      const now = this.#clock();
      const payload = {
        legalName: normalized.legalName,
        legalId: normalized.legalId,
        contactPhone: normalized.contactPhone,
        retentionPolicyVersion: retention,
      };
      const encrypted = encryptJson(payload, key, applicationAad(merchantId, 1));
      const payloadHash = keyedHashJson(key, 'ABU24K_MERCHANT_APPLICATION_PAYLOAD_V1', payload);
      await executor.query(
        `INSERT INTO core.merchants (
           merchant_id, settlement_wallet, status, level, profile, guarantee_status,
           application_version, created_at, updated_at
         ) VALUES ($1,$2,'PENDING',$3,$4,'DECISION_BLOCKED',1,$5,$5)`,
        [merchantId, normalized.settlementWallet, normalized.level, JSON.stringify({ shopName: normalized.shopName }), now],
      );
      await executor.query(
        `INSERT INTO core.merchant_application_versions (
           merchant_id, version, encrypted_payload, encryption_iv, encryption_tag,
           payload_hash, license_asset_id, actor_wallet, idempotency_key,
           request_hash, created_at
         ) VALUES ($1,1,$2,$3,$4,$5,NULL,$6,$7,$8,$9)`,
        [merchantId, encrypted.ciphertext, encrypted.iv, encrypted.tag, payloadHash, wallet, normalized.idempotencyKey, requestHash, now],
      );
      await lifecycleAudit(executor, {
        eventType: 'MerchantApplicationCreated',
        merchantId,
        actorWallet: wallet,
        roles,
        correlationId: normalized.correlationId,
        requestHash,
        payload: { applicationVersion: 1, payloadHash, level: normalized.level, qualificationComplete: false },
        now,
      });
      return this.#merchantDetail(executor, merchantId, roles);
    });
  }

  updateApplication(actor: FulfillmentActor, merchantId: string, input: MerchantApplicationUpdateInput) {
    validateResourceId(merchantId, 'merchant ID');
    const normalized = applicationUpdateInput(input);
    const wallet = normalizeAddress(actor.walletAddress);
    const key = requireEncryptionKey(this.#encryptionKey);
    const retention = requireRetentionPolicy(this.#retentionPolicyVersion);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<ApplicationRow>(
        `SELECT * FROM core.merchant_application_versions
         WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, normalized.idempotencyKey],
      );
      const requestHash = keyedHashJson(key, 'ABU24K_MERCHANT_APPLICATION_REQUEST_V1', {
        domain: 'ABU24K_MERCHANT_APPLICATION_UPDATE_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: wallet,
        merchantId,
        ...normalized,
        retentionPolicyVersion: retention,
      });
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash || existing.rows[0].merchant_id !== merchantId) {
          throw idempotencyConflict('Merchant application update');
        }
        return this.#merchantDetail(executor, merchantId, roles);
      }
      const merchant = await lockedMerchant(executor, merchantId);
      if (merchant.status !== 'PENDING') {
        throw new CoreError('UnknownState', 'Only pending merchant applications can change', 409);
      }
      if (Number(merchant.application_version) !== normalized.expectedVersion) {
        throw new CoreError('UnknownState', 'Merchant application version changed', 409);
      }
      if (normalized.licenseAssetId) await requireMerchantLicense(executor, merchantId, normalized.licenseAssetId);
      const nextVersion = normalized.expectedVersion + 1;
      const payload = {
        legalName: normalized.legalName,
        legalId: normalized.legalId,
        contactPhone: normalized.contactPhone,
        retentionPolicyVersion: retention,
      };
      const encrypted = encryptJson(payload, key, applicationAad(merchantId, nextVersion));
      const payloadHash = keyedHashJson(key, 'ABU24K_MERCHANT_APPLICATION_PAYLOAD_V1', payload);
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.merchant_application_versions (
           merchant_id, version, encrypted_payload, encryption_iv, encryption_tag,
           payload_hash, license_asset_id, actor_wallet, idempotency_key,
           request_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [merchantId, nextVersion, encrypted.ciphertext, encrypted.iv, encrypted.tag, payloadHash, normalized.licenseAssetId, wallet, normalized.idempotencyKey, requestHash, now],
      );
      await executor.query(
        `UPDATE core.merchants SET profile = $2, level = $3, status = 'PENDING',
           application_version = $4, reviewed_at = NULL, reviewed_by = NULL, updated_at = $5
         WHERE merchant_id = $1`,
        [merchantId, JSON.stringify({ ...merchant.profile, shopName: normalized.shopName }), normalized.level, nextVersion, now],
      );
      await lifecycleAudit(executor, {
        eventType: 'MerchantApplicationUpdated',
        merchantId,
        actorWallet: wallet,
        roles,
        correlationId: normalized.correlationId,
        requestHash,
        payload: { applicationVersion: nextVersion, payloadHash, level: normalized.level, qualificationComplete: Boolean(normalized.licenseAssetId) },
        now,
      });
      return this.#merchantDetail(executor, merchantId, roles);
    });
  }

  createReviewChallenge(actor: FulfillmentActor, merchantId: string, input: {
    action: ReviewAction;
    reasonCode: string;
    idempotencyKey: string;
    correlationId: string;
  }) {
    validateResourceId(merchantId, 'merchant ID');
    const action = reviewAction(input.action);
    const reasonCode = boundedCode(input.reasonCode, 'merchant review reason');
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = normalizeAddress(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN']);
      if (wallet === this.#secondarySigner) {
        throw new CoreError('Forbidden', 'Merchant review actor cannot be the secondary signer', 403);
      }
      const merchant = await lockedMerchant(executor, merchantId);
      const toStatus = reviewTransition(merchant.status, action);
      const application = await latestApplication(executor, merchant);
      if (action === 'APPROVE') {
        if (!application?.license_asset_id) throw new CoreError('ConfigurationRequired', 'Merchant license evidence is incomplete', 409);
      }
      const requestHash = hashJson({
        merchantId,
        action,
        reasonCode,
        applicationVersion: merchant.application_version,
      });
      const existing = await executor.query<ReviewRow>(
        'SELECT * FROM core.merchant_review_actions WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Merchant review challenge');
        return reviewProjection(existing.rows[0], this.#verifyingContract, this.#secondarySigner);
      }
      const policyVersion = await latestPolicyVersion(executor);
      const oldValueHash = merchantStateHash(merchant, merchant.status);
      const newValueHash = merchantStateHash(merchant, toStatus, reasonCode);
      const now = this.#clock();
      const row = (await executor.query<ReviewRow>(
        `INSERT INTO core.merchant_review_actions (
           action_id, merchant_id, action_kind, from_status, to_status,
           application_version, policy_version, reason_code, old_value_hash, new_value_hash,
           approval_nonce, approval_deadline, state, governance_safe_address,
           actor_wallet, idempotency_key, request_hash, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13,$14,$15,$16,$17,$17)
         RETURNING *`,
        [
          randomHash(), merchantId, action, merchant.status, toStatus,
          merchant.application_version, policyVersion, reasonCode, oldValueHash, newValueHash,
          randomNonce().toString(), new Date(now.getTime() + 5 * 60_000), this.#governanceSafe,
          wallet, input.idempotencyKey, requestHash, now,
        ],
      )).rows[0]!;
      await lifecycleAudit(executor, {
        eventType: 'MerchantReviewChallengeCreated', merchantId, actorWallet: wallet, roles,
        correlationId: input.correlationId, requestHash,
        payload: { actionId: row.action_id, action, fromStatus: merchant.status, toStatus, applicationVersion: Number(merchant.application_version) },
        now,
      });
      return reviewProjection(row, this.#verifyingContract, this.#secondarySigner);
    });
  }

  async publishReview(actor: FulfillmentActor, merchantId: string, actionId: string, signature: string) {
    validateResourceId(merchantId, 'merchant ID');
    assertHash(actionId, 'merchant review action ID');
    assertSignature(signature);
    const wallet = normalizeAddress(actor.walletAddress);
    if (wallet === this.#secondarySigner) {
      throw new CoreError('Forbidden', 'Merchant review actor cannot be the secondary signer', 403);
    }
    if (!await this.#auditReady()) throw new CoreError('ExternalBlocked', 'Audit database is unavailable for merchant review', 503);
    const prepared = await this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN']);
      const row = await lockedReview(executor, merchantId, actionId.toLowerCase());
      if (row.state === 'PUBLISHED') return { existing: true as const, row };
      if (row.state !== 'DRAFT') {
        throw new CoreError('NonceExpired', 'Merchant review challenge expired', 401);
      }
      if (row.approval_deadline <= this.#clock()) {
        await expireReview(executor, row.action_id, this.#clock());
        return { expired: true as const };
      }
      const merchant = await lockedMerchant(executor, merchantId);
      if (
        merchant.status !== row.from_status
        || Number(merchant.application_version) !== Number(row.application_version)
        || merchantStateHash(merchant, merchant.status) !== row.old_value_hash
      ) throw new CoreError('IdempotencyConflict', 'Merchant review snapshot changed', 409);
      if (row.action_kind === 'APPROVE') {
        const application = await latestApplication(executor, merchant);
        if (!application?.license_asset_id) throw new CoreError('ConfigurationRequired', 'Merchant license evidence is incomplete', 409);
      }
      const intent = reviewIntent(row);
      const verified = verifySensitiveActionApproval(
        intent,
        signature,
        this.#secondarySigner,
        this.#governanceSafe,
        this.#verifyingContract,
        this.#clock(),
      );
      const actionDigest = TypedDataEncoder.hash(
        sensitiveActionDomain(this.#verifyingContract),
        sensitiveActionTypes,
        intent,
      ).toLowerCase();
      return { row, merchant, intent, verified, actionDigest };
    });
    if ('existing' in prepared) {
      return this.#transactions.transaction(async (executor) => {
        const roles = await requireCurrentRole(executor, actor, ['ADMIN']);
        return this.#merchantDetail(executor, merchantId, roles);
      });
    }
    if ('expired' in prepared) {
      throw new CoreError('NonceExpired', 'Merchant review challenge expired', 401);
    }
    const safe = await this.#approver.verify({
      configVersionId: prepared.row.action_id,
      configKey: `MERCHANT_${prepared.row.action_kind}`,
      version: Number(prepared.row.application_version),
      safeAddress: this.#governanceSafe,
      actionDigest: prepared.actionDigest,
      oldValueHash: prepared.row.old_value_hash,
      newValueHash: prepared.row.new_value_hash,
    });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN']);
      const row = await lockedReview(executor, merchantId, actionId.toLowerCase());
      if (row.state === 'PUBLISHED') return this.#merchantDetail(executor, merchantId, roles);
      const merchant = await lockedMerchant(executor, merchantId);
      if (
        row.state !== 'DRAFT'
        || merchant.status !== row.from_status
        || Number(merchant.application_version) !== Number(row.application_version)
        || merchantStateHash(merchant, merchant.status) !== row.old_value_hash
      ) throw new CoreError('IdempotencyConflict', 'Merchant review changed during Safe approval', 409);
      const now = this.#clock();
      if (row.action_kind === 'APPROVE') {
        const binding = await executor.query<{ merchant_id: string | null }>(
          `SELECT merchant_id FROM core.wallet_role_bindings
           WHERE lower(wallet_address) = $1 AND role = 'MERCHANT' FOR UPDATE`,
          [merchant.settlement_wallet.toLowerCase()],
        );
        if (binding.rows[0]?.merchant_id && binding.rows[0].merchant_id !== merchantId) {
          throw new CoreError('Forbidden', 'Settlement wallet is bound to another merchant', 403);
        }
        await executor.query(
          `INSERT INTO core.wallet_role_bindings (
             wallet_address, role, merchant_id, status, evidence_hash, created_at, revoked_at
           ) VALUES ($1,'MERCHANT',$2,'ACTIVE',$3,$4,NULL)
           ON CONFLICT (wallet_address, role) DO UPDATE SET
             merchant_id = EXCLUDED.merchant_id, status = 'ACTIVE',
             evidence_hash = EXCLUDED.evidence_hash, revoked_at = NULL`,
          [merchant.settlement_wallet.toLowerCase(), merchantId, prepared.actionDigest, now],
        );
      } else {
        await executor.query(
          `UPDATE core.wallet_role_bindings SET status = 'SUSPENDED'
           WHERE lower(wallet_address) = $1 AND role = 'MERCHANT' AND merchant_id = $2`,
          [merchant.settlement_wallet.toLowerCase(), merchantId],
        );
      }
      await executor.query(
        `UPDATE core.merchant_review_actions SET state = 'PUBLISHED', secondary_signer = $2,
           secondary_signature_hash = $3, action_digest = $4, safe_tx_hash = $5,
           approval_evidence_hash = $6, updated_at = $7 WHERE action_id = $1`,
        [row.action_id, prepared.verified.signer, keccak256(signature).toLowerCase(), prepared.actionDigest, safe.safeTxHash, safe.approvalEvidenceHash, now],
      );
      await executor.query(
        `UPDATE core.merchants SET status = $2, reviewed_at = $3, reviewed_by = $4, updated_at = $3
         WHERE merchant_id = $1`,
        [merchantId, row.to_status, now, wallet],
      );
      await executor.query(
        `INSERT INTO core.outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
         ) VALUES ($1,'MERCHANT',$2,$3,$4,$1,'PENDING')`,
        [
          `outbox:merchant-review:${row.action_id}`,
          merchantId,
          'MerchantStatusChanged',
          JSON.stringify({
          artifactVersion: CORE_ARTIFACT_VERSION,
          merchantId,
          action: row.action_kind,
          fromStatus: row.from_status,
          toStatus: row.to_status,
          applicationVersion: Number(row.application_version),
          safeTxHash: safe.safeTxHash,
          }),
        ],
      );
      await lifecycleAudit(executor, {
        eventType: 'MerchantReviewPublished', merchantId, actorWallet: wallet, roles,
        correlationId: `merchant-review:${row.action_id}`, requestHash: prepared.actionDigest,
        payload: {
          actionId: row.action_id, action: row.action_kind, fromStatus: row.from_status,
          toStatus: row.to_status, applicationVersion: Number(row.application_version),
          secondarySigner: prepared.verified.signer, safeTxHash: safe.safeTxHash,
          approvalEvidenceHash: safe.approvalEvidenceHash,
        },
        signature: {
          signatureHash: keccak256(signature).toLowerCase(), signer: prepared.verified.signer,
          digest: prepared.actionDigest, nonce: prepared.intent.nonce.toString(),
          deadline: prepared.intent.deadline.toString(),
        },
        now,
      });
      return this.#merchantDetail(executor, merchantId, roles);
    });
  }

  async #merchantDetail(executor: SqlExecutor, merchantId: string, roles: string[]) {
    const merchant = await loadMerchant(executor, merchantId);
    const application = await latestApplication(executor, merchant);
    const qualification = application
      ? qualificationProjection(application, this.#encryptionKey, roles)
      : { access: 'UNAVAILABLE' as const, reason: 'PARTIAL_LEGACY' as const, licenseAssetId: null };
    const [levelPolicy, orders, fulfillment, risk, contributions, balances, settlements, reviews] = await Promise.all([
      merchantLevelPolicyProjection(executor, merchant.level),
      merchantOrderStats(executor, merchantId, businessDay(this.#clock())),
      merchantFulfillmentStats(executor, merchantId, this.#clock()),
      merchantRiskStats(executor, merchantId),
      merchantContributionStats(executor, merchantId),
      merchantBalanceStats(executor, merchantId),
      merchantSettlementHistory(executor, merchantId),
      executor.query<ReviewRow>('SELECT * FROM core.merchant_review_actions WHERE merchant_id = $1 ORDER BY created_at DESC, action_id DESC LIMIT 50', [merchantId]),
    ]);
    return {
      artifactVersion: CORE_ARTIFACT_VERSION,
      merchant: merchantSummaryProjection({ ...merchant, qualification_complete: Boolean(application?.license_asset_id) }),
      qualification,
      levelPolicy,
      analytics: { orders, fulfillment, risk, contributions },
      balances,
      settlements,
      reviews: reviews.rows.map(reviewEvidenceProjection),
    };
  }
}

function merchantSummaryProjection(row: MerchantRow & { qualification_complete: boolean }) {
  return {
    merchantId: row.merchant_id,
    shopName: typeof row.profile.shopName === 'string' ? row.profile.shopName : null,
    settlementWallet: row.settlement_wallet.toLowerCase(),
    settlementWalletMutable: false as const,
    status: row.status,
    level: row.level,
    guaranteeStatus: row.guarantee_status,
    applicationVersion: Number(row.application_version),
    qualificationComplete: row.qualification_complete,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewedBy: row.reviewed_by?.toLowerCase() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function qualificationProjection(row: ApplicationRow, key: Buffer | undefined, roles: string[]) {
  if (!roles.includes('ADMIN') && !roles.includes('OPERATOR')) {
    return {
      access: 'REDACTED' as const,
      legalName: null,
      legalId: null,
      contactPhone: null,
      licenseAssetId: null,
      payloadHash: row.payload_hash,
      retentionPolicyVersion: null,
      version: Number(row.version),
      updatedAt: row.created_at.toISOString(),
    };
  }
  const payload = decryptJson(row, requireEncryptionKey(key), applicationAad(row.merchant_id, Number(row.version)));
  return {
    access: 'FULL' as const,
    legalName: requiredPayloadString(payload, 'legalName'),
    legalId: requiredPayloadString(payload, 'legalId'),
    contactPhone: requiredPayloadString(payload, 'contactPhone'),
    licenseAssetId: row.license_asset_id,
    payloadHash: row.payload_hash,
    retentionPolicyVersion: requiredPayloadString(payload, 'retentionPolicyVersion'),
    version: Number(row.version),
    updatedAt: row.created_at.toISOString(),
  };
}

function reviewProjection(row: ReviewRow, verifyingContract: string, secondarySigner: string) {
  const intent = reviewIntent(row);
  const domain = sensitiveActionDomain(verifyingContract);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    actionId: row.action_id,
    merchantId: row.merchant_id,
    action: row.action_kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    applicationVersion: Number(row.application_version),
    reasonCode: row.reason_code,
    state: row.state,
    secondarySigner,
    expiresAt: row.approval_deadline.toISOString(),
    typedData: {
      domain,
      types: sensitiveActionTypes,
      primaryType: 'SensitiveAction',
      message: jsonIntent(intent),
    },
    digest: TypedDataEncoder.hash(domain, sensitiveActionTypes, intent),
  };
}

function reviewEvidenceProjection(row: ReviewRow) {
  return {
    actionId: row.action_id,
    action: row.action_kind,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    applicationVersion: Number(row.application_version),
    reasonCode: row.reason_code,
    state: row.state,
    secondarySigner: row.secondary_signer,
    actionDigest: row.action_digest,
    safeTxHash: row.safe_tx_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function reviewIntent(row: ReviewRow): SensitiveActionIntent {
  return {
    action: `${row.action_kind}_MERCHANT`,
    resourceType: 'MERCHANT',
    resourceId: row.merchant_id,
    policyVersion: BigInt(row.policy_version),
    oldValueHash: row.old_value_hash,
    newValueHash: row.new_value_hash,
    safeAddress: row.governance_safe_address,
    nonce: BigInt(row.approval_nonce),
    deadline: BigInt(Math.floor(row.approval_deadline.getTime() / 1_000)),
  };
}

function jsonIntent(intent: SensitiveActionIntent) {
  return {
    ...intent,
    policyVersion: intent.policyVersion.toString(),
    nonce: intent.nonce.toString(),
    deadline: intent.deadline.toString(),
  };
}

async function merchantOrderStats(executor: SqlExecutor, merchantId: string, window: ReturnType<typeof businessDay>) {
  const result = await executor.query<{
    total: string;
    ordinary: string;
    seckill: string;
    exact_amounts_valid: boolean;
    cumulative_list_price_usdt: string;
    cumulative_buyer_paid_usdt: string;
    cumulative_merchant_base_receivable_usdt: string;
    cumulative_merchant_net_receivable_usdt: string;
    today_list_price_usdt: string;
    today_buyer_paid_usdt: string;
    today_merchant_base_receivable_usdt: string;
    today_merchant_net_receivable_usdt: string;
  }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE cohort.order_kind IN ('ORDINARY','FALLBACK_RETAIL'))::text AS ordinary,
       count(*) FILTER (WHERE cohort.order_kind = 'SECKILL')::text AS seckill,
       COALESCE(bool_and(cohort.exact_amounts_valid), true) AS exact_amounts_valid,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts->>'listPriceUsdt')::numeric ELSE 0 END), 0)::text AS cumulative_list_price_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts->>'usdtPaymentAmount')::numeric ELSE 0 END), 0)::text AS cumulative_buyer_paid_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts->>'merchantBaseReceivableUsdt')::numeric ELSE 0 END), 0)::text AS cumulative_merchant_base_receivable_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts->>'merchantNetReceivableUsdt')::numeric ELSE 0 END), 0)::text AS cumulative_merchant_net_receivable_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid AND cohort.finalized_at >= $2 AND cohort.finalized_at < $3 THEN (cohort.exact_amounts->>'listPriceUsdt')::numeric ELSE 0 END), 0)::text AS today_list_price_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid AND cohort.finalized_at >= $2 AND cohort.finalized_at < $3 THEN (cohort.exact_amounts->>'usdtPaymentAmount')::numeric ELSE 0 END), 0)::text AS today_buyer_paid_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid AND cohort.finalized_at >= $2 AND cohort.finalized_at < $3 THEN (cohort.exact_amounts->>'merchantBaseReceivableUsdt')::numeric ELSE 0 END), 0)::text AS today_merchant_base_receivable_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid AND cohort.finalized_at >= $2 AND cohort.finalized_at < $3 THEN (cohort.exact_amounts->>'merchantNetReceivableUsdt')::numeric ELSE 0 END), 0)::text AS today_merchant_net_receivable_usdt
     FROM (
       SELECT finality.classification AS order_kind, orders.exact_amounts, finality.finalized_at,
         COALESCE(
           (orders.exact_amounts->>'listPriceUsdt') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts->>'usdtPaymentAmount') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts->>'merchantBaseReceivableUsdt') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts->>'merchantNetReceivableUsdt') ~ '^(0|[1-9][0-9]*)$',
           false
         ) AS exact_amounts_valid
       FROM core.orders orders
       JOIN LATERAL (
         SELECT finality.finalized_at, payment.classification
         FROM core.transaction_finality finality
         JOIN core.payment_events payment
           ON payment.order_id = orders.order_id
          AND payment.transaction_hash = finality.tx_hash
          AND payment.block_hash = finality.block_hash
         WHERE finality.resource_type = 'ORDER_PAYMENT'
           AND finality.resource_id = orders.order_id
           AND payment.canonical
           AND finality.state = 'FINAL'
           AND finality.receipt_status = 1
           AND finality.required_confirmations = 15
           AND finality.confirmations >= finality.required_confirmations
         ORDER BY finality.finalized_at DESC, finality.updated_at DESC, finality.transaction_id DESC
         LIMIT 1
       ) finality ON true
       WHERE orders.merchant_id = $1
     ) cohort`,
    [merchantId, window.start, window.end],
  );
  const row = result.rows[0];
  if (BigInt(row?.total ?? '0') > 0n && row?.exact_amounts_valid !== true) {
    throw new CoreError('UnknownState', 'Merchant analytics exact payment snapshot is invalid', 409);
  }
  return {
    totalFinalized: row?.total ?? '0',
    ordinaryFinalized: row?.ordinary ?? '0',
    seckillFinalized: row?.seckill ?? '0',
    cumulative: {
      listPriceUsdt: row?.cumulative_list_price_usdt ?? '0',
      buyerPaidUsdt: row?.cumulative_buyer_paid_usdt ?? '0',
      merchantBaseReceivableUsdt: row?.cumulative_merchant_base_receivable_usdt ?? '0',
      merchantNetReceivableUsdt: row?.cumulative_merchant_net_receivable_usdt ?? '0',
    },
    today: {
      listPriceUsdt: row?.today_list_price_usdt ?? '0',
      buyerPaidUsdt: row?.today_buyer_paid_usdt ?? '0',
      merchantBaseReceivableUsdt: row?.today_merchant_base_receivable_usdt ?? '0',
      merchantNetReceivableUsdt: row?.today_merchant_net_receivable_usdt ?? '0',
    },
    timezone: 'Asia/Shanghai' as const,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
  };
}

async function merchantLevelPolicyProjection(executor: SqlExecutor, level: MerchantLevel) {
  try {
    const policy = await currentMerchantLevelPolicy(executor);
    const rule = merchantLevelRule(policy, level);
    return {
      status: 'AVAILABLE' as const,
      configVersionId: policy.configVersionId,
      version: policy.version,
      effectiveFrom: policy.effectiveFrom.toISOString(),
      level: rule.level,
      maxProductSettlementUsdt: rule.maxProductSettlementUsdt,
      monthlySeckillQuota: rule.monthlySeckillQuota,
    };
  } catch (error) {
    if (error instanceof CoreError && error.code === 'DecisionBlocked') {
      return { status: 'DecisionBlocked' as const, reason: error.message };
    }
    throw error;
  }
}

async function merchantFulfillmentStats(executor: SqlExecutor, merchantId: string, now: Date) {
  const result = await executor.query<{
    pending: string; in_transit: string; completed: string; pickup_completed: string;
    fast_ship_numerator: string; fast_ship_denominator: string;
  }>(
    `WITH fast_ship_cohort AS (
       SELECT orders.shipped_at, finality.finalized_at
       FROM core.orders orders
       JOIN LATERAL (
         SELECT finality.finalized_at
         FROM core.transaction_finality finality
         JOIN core.payment_events payment
           ON payment.order_id = orders.order_id
          AND payment.transaction_hash = finality.tx_hash
          AND payment.block_hash = finality.block_hash
         WHERE finality.resource_type = 'ORDER_PAYMENT'
           AND finality.resource_id = orders.order_id
           AND payment.canonical
           AND finality.state = 'FINAL'
           AND finality.receipt_status = 1
           AND finality.required_confirmations = 15
           AND finality.confirmations >= finality.required_confirmations
         ORDER BY finality.finalized_at DESC, finality.updated_at DESC, finality.transaction_id DESC
         LIMIT 1
       ) finality ON true
       WHERE orders.merchant_id = $1
         AND orders.fulfillment_mode = 'DELIVERY'
         AND (orders.shipped_at IS NOT NULL OR finality.finalized_at <= $2::timestamptz - interval '48 hours')
     )
     SELECT
       (SELECT count(*)::text FROM core.orders WHERE merchant_id = $1 AND fulfillment_mode = 'DELIVERY' AND state = 'PAID') AS pending,
       (SELECT count(*)::text FROM core.orders WHERE merchant_id = $1 AND fulfillment_mode = 'DELIVERY' AND state IN ('SHIPPED','DELIVERED')) AS in_transit,
       (SELECT count(*)::text FROM core.orders WHERE merchant_id = $1 AND state = 'FULFILLED') AS completed,
       (SELECT count(*)::text FROM core.orders WHERE merchant_id = $1 AND fulfillment_mode = 'PICKUP' AND state = 'FULFILLED') AS pickup_completed,
       count(*) FILTER (WHERE shipped_at IS NOT NULL AND shipped_at <= finalized_at + interval '48 hours')::text AS fast_ship_numerator,
       count(*)::text AS fast_ship_denominator
     FROM fast_ship_cohort`,
    [merchantId, now],
  );
  const row = result.rows[0];
  const numerator = row?.fast_ship_numerator ?? '0';
  const denominator = row?.fast_ship_denominator ?? '0';
  return {
    pendingShipment: row?.pending ?? '0',
    inTransit: row?.in_transit ?? '0',
    completed: row?.completed ?? '0',
    pickupCompleted: row?.pickup_completed ?? '0',
    fastShip48h: denominator === '0'
      ? {
          status: 'UNAVAILABLE' as const,
          numerator,
          denominator,
          bps: null,
          reason: 'NO_ELIGIBLE_DELIVERY_ORDERS' as const,
        }
      : {
          status: 'AVAILABLE' as const,
          numerator,
          denominator,
          bps: Number(BigInt(numerator) * 10_000n / BigInt(denominator)),
          reason: null,
        },
  };
}

async function merchantRiskStats(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{
    takeover_count: string; guarantee_used: string; frozen_used: string; future_used: string; platform_advance: string; outstanding_debt: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM core.takeover_cases WHERE merchant_id = $1) AS takeover_count,
       (SELECT COALESCE(sum(guarantee_used_usdt), 0)::text FROM core.takeover_cases WHERE merchant_id = $1) AS guarantee_used,
       (SELECT COALESCE(sum(merchant_available_used_usdt), 0)::text FROM core.takeover_cases WHERE merchant_id = $1) AS frozen_used,
       (SELECT COALESCE(sum(future_proceeds_used_usdt), 0)::text FROM core.takeover_cases WHERE merchant_id = $1) AS future_used,
       (SELECT COALESCE(sum(platform_advance_usdt), 0)::text FROM core.takeover_cases WHERE merchant_id = $1) AS platform_advance,
       (SELECT COALESCE(outstanding_usdt, 0)::text FROM core.merchant_debts WHERE merchant_id = $1) AS outstanding_debt`,
    [merchantId],
  );
  const row = result.rows[0];
  return {
    takeoverCases: row?.takeover_count ?? '0',
    guaranteeUsedUsdt: row?.guarantee_used ?? '0',
    frozenReceivableUsedUsdt: row?.frozen_used ?? '0',
    futureProceedsUsedUsdt: row?.future_used ?? '0',
    platformAdvanceUsdt: row?.platform_advance ?? '0',
    outstandingDebtUsdt: row?.outstanding_debt ?? '0',
    abnormalOrderRateBps: null,
    unavailableReason: 'DecisionBlocked' as const,
  };
}

async function merchantContributionStats(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{
    finalized_orders: string;
    contribution_snapshots_valid: boolean;
    snapshot_npl_burn: string;
    ledger_npl_burn: string;
    snapshot_available_bnm: string;
    ledger_available_bnm: string;
  }>(
    `WITH merchant_orders AS (
       SELECT orders.order_id, orders.state, orders.exact_amounts,
         COALESCE(
           (orders.exact_amounts->>'nplBurnAmount') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts->>'bnmAmount') ~ '^(0|[1-9][0-9]*)$',
           false
         ) AS contribution_snapshots_valid
       FROM core.orders orders
       WHERE orders.merchant_id = $1
         AND EXISTS (
           SELECT 1
           FROM core.transaction_finality finality
           JOIN core.payment_events payment
             ON payment.order_id = orders.order_id
            AND payment.transaction_hash = finality.tx_hash
            AND payment.block_hash = finality.block_hash
           WHERE finality.resource_type = 'ORDER_PAYMENT'
             AND finality.resource_id = orders.order_id
             AND payment.canonical
             AND finality.state = 'FINAL'
             AND finality.receipt_status = 1
             AND finality.required_confirmations = 15
             AND finality.confirmations >= finality.required_confirmations
         )
     ), ledger AS (
       SELECT
         COALESCE(sum(CASE
           WHEN account.purpose = 'BURN' AND line.side = 'DEBIT' THEN line.amount
           WHEN account.purpose = 'BURN' AND line.side = 'CREDIT' THEN -line.amount
           ELSE 0
         END), 0)::text AS npl_burn,
         COALESCE(sum(CASE
           WHEN account.purpose = 'BNM_LIABILITY' AND line.balance_state = 'AVAILABLE' AND line.side = 'CREDIT' THEN line.amount
           WHEN account.purpose = 'BNM_LIABILITY' AND line.balance_state = 'AVAILABLE' AND line.side = 'DEBIT' THEN -line.amount
           ELSE 0
         END), 0)::text AS available_bnm
       FROM merchant_orders orders
       JOIN core.ledger_journals journal ON journal.order_id = orders.order_id
       JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE (account.asset = 'NPL' AND account.purpose = 'BURN')
          OR (account.asset = 'BNM_POINTS' AND account.purpose = 'BNM_LIABILITY')
     )
     SELECT
       count(*)::text AS finalized_orders,
       COALESCE(bool_and(orders.contribution_snapshots_valid), true) AS contribution_snapshots_valid,
       COALESCE(sum(CASE WHEN orders.contribution_snapshots_valid THEN (orders.exact_amounts->>'nplBurnAmount')::numeric ELSE 0 END), 0)::text AS snapshot_npl_burn,
       ledger.npl_burn AS ledger_npl_burn,
       COALESCE(sum(CASE WHEN orders.state = 'FULFILLED' AND orders.contribution_snapshots_valid THEN (orders.exact_amounts->>'bnmAmount')::numeric ELSE 0 END), 0)::text AS snapshot_available_bnm,
       ledger.available_bnm AS ledger_available_bnm
     FROM merchant_orders orders CROSS JOIN ledger
     GROUP BY ledger.npl_burn, ledger.available_bnm`,
    [merchantId],
  );
  const row = result.rows[0] ?? {
    finalized_orders: '0', contribution_snapshots_valid: true,
    snapshot_npl_burn: '0', ledger_npl_burn: '0',
    snapshot_available_bnm: '0', ledger_available_bnm: '0',
  };
  if (BigInt(row.finalized_orders) > 0n && row.contribution_snapshots_valid !== true) {
    throw new CoreError('UnknownState', 'Merchant contribution snapshot is invalid', 409);
  }
  if (BigInt(row.snapshot_npl_burn) !== BigInt(row.ledger_npl_burn)) {
    throw new CoreError('InvalidFinality', 'Merchant NPL Burn snapshot does not reconcile to the ledger', 409);
  }
  if (BigInt(row.snapshot_available_bnm) !== BigInt(row.ledger_available_bnm)) {
    throw new CoreError('InvalidFinality', 'Merchant Available BNM snapshot does not reconcile to the ledger', 409);
  }
  return {
    finalizedNplBurnAmount: row.snapshot_npl_burn,
    fulfillmentAvailableBnmAmount: row.snapshot_available_bnm,
    ledgerReconciled: true as const,
  };
}

async function merchantBalanceStats(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{ balance_state: string; amount: string }>(
    `SELECT line.balance_state,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     JOIN core.orders orders ON orders.order_id = journal.order_id
     WHERE orders.merchant_id = $1 AND account.owner_type = 'MERCHANT' AND account.asset = 'USDT'
       AND account.purpose = 'MERCHANT_RECEIVABLE' AND line.balance_state <> 'POSTED'
     GROUP BY line.balance_state ORDER BY line.balance_state`,
    [merchantId],
  );
  const byState = new Map(result.rows.map((row) => [row.balance_state, row.amount]));
  return ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED'].map((state) => ({ state, amount: byState.get(state) ?? '0' }));
}

async function merchantSettlementHistory(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<{
    request_id: string; asset: string; amount: string; state: string; requested_at: Date; final_safe_tx_hash: string | null; settled_at: Date | null;
  }>(
    `SELECT DISTINCT request.request_id, request.asset, request.amount::text, request.state,
       request.requested_at, request.final_safe_tx_hash, request.settled_at
     FROM core.settlement_requests request
     JOIN core.settlement_request_items item ON item.request_id = request.request_id
     JOIN core.orders orders ON orders.order_id = item.order_id
     WHERE orders.merchant_id = $1
     ORDER BY request.requested_at DESC, request.request_id DESC LIMIT 100`,
    [merchantId],
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    asset: row.asset,
    amount: row.amount,
    state: row.state,
    requestedAt: row.requested_at.toISOString(),
    safeTxHash: row.final_safe_tx_hash,
    settledAt: row.settled_at?.toISOString() ?? null,
  }));
}

async function requireCurrentRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: readonly string[]) {
  const wallet = normalizeAddress(actor.walletAddress);
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Merchant lifecycle role is forbidden', 403);
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings WHERE lower(wallet_address) = $1
       AND status = 'ACTIVE' AND role = ANY($2::text[])`,
    [wallet, [...allowed]],
  );
  const roles = [...new Set(result.rows.map((row) => row.role))];
  if (roles.length === 0) throw new CoreError('Forbidden', 'Merchant lifecycle role binding is inactive', 403);
  return roles;
}

async function loadMerchant(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<MerchantRow>('SELECT * FROM core.merchants WHERE merchant_id = $1', [merchantId]);
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Merchant was not found', 404);
  return result.rows[0];
}

async function lockedMerchant(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<MerchantRow>('SELECT * FROM core.merchants WHERE merchant_id = $1 FOR UPDATE', [merchantId]);
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Merchant was not found', 404);
  return result.rows[0];
}

async function latestApplication(executor: SqlExecutor, merchant: MerchantRow) {
  if (Number(merchant.application_version) === 0) return undefined;
  const result = await executor.query<ApplicationRow>(
    'SELECT * FROM core.merchant_application_versions WHERE merchant_id = $1 AND version = $2',
    [merchant.merchant_id, merchant.application_version],
  );
  if (!result.rows[0]) throw new CoreError('ExternalBlocked', 'Merchant application evidence is incomplete', 503);
  return result.rows[0];
}

async function lockedReview(executor: SqlExecutor, merchantId: string, actionId: string) {
  const result = await executor.query<ReviewRow>(
    'SELECT * FROM core.merchant_review_actions WHERE action_id = $1 AND merchant_id = $2 FOR UPDATE',
    [actionId, merchantId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Merchant review action was not found', 404);
  return result.rows[0];
}

async function latestPolicyVersion(executor: SqlExecutor) {
  const result = await executor.query<{ policy_version: string | number }>(
    `SELECT policy_version FROM core.policy_snapshots WHERE publication_status = 'PUBLISHED'
     ORDER BY policy_version DESC LIMIT 1`,
  );
  if (!result.rows[0]) throw new CoreError('DecisionBlocked', 'Published policy is unavailable', 409);
  return result.rows[0].policy_version;
}

async function requireMerchantLicense(executor: SqlExecutor, merchantId: string, assetId: string) {
  assertHash(assetId, 'merchant license asset ID');
  const result = await executor.query<{ asset_id: string }>(
    `SELECT asset_id FROM core.media_assets WHERE asset_id = $1
       AND resource_type = 'MERCHANT' AND resource_id = $2 AND purpose = 'MERCHANT_LICENSE'`,
    [assetId.toLowerCase(), merchantId],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Merchant license media is unverified or outside the merchant', 403);
}

async function expireReview(executor: SqlExecutor, actionId: string, now: Date) {
  await executor.query(
    `UPDATE core.merchant_review_actions SET state = 'EXPIRED', updated_at = $2
     WHERE action_id = $1 AND state = 'DRAFT'`,
    [actionId, now],
  );
}

function reviewTransition(status: MerchantStatus, action: ReviewAction) {
  if (action === 'APPROVE' && status === 'PENDING') return 'APPROVED' as const;
  if (action === 'REJECT' && status === 'PENDING') return 'REJECTED' as const;
  if (action === 'BLACKLIST' && status === 'APPROVED') return 'BLACKLISTED' as const;
  throw new CoreError('UnknownState', `Merchant ${status} cannot apply ${action}`, 409);
}

function merchantStateHash(
  merchant: MerchantRow,
  status: string,
  reasonCode?: string,
) {
  return hashJson({
    merchantId: merchant.merchant_id,
    settlementWallet: merchant.settlement_wallet.toLowerCase(),
    status,
    level: merchant.level,
    applicationVersion: Number(merchant.application_version),
    ...(reasonCode ? { reasonCode } : {}),
  });
}

function applicationInput(input: MerchantApplicationInput) {
  assertOnlyKeys(input, ['shopName', 'legalName', 'legalId', 'contactPhone', 'settlementWallet', 'level', 'idempotencyKey', 'correlationId']);
  validateIdempotencyKey(input.idempotencyKey);
  return {
    shopName: boundedText(input.shopName, 'shop name', 1, 80),
    legalName: boundedText(input.legalName, 'legal name', 2, 80),
    legalId: boundedText(input.legalId, 'legal ID', 6, 32),
    contactPhone: boundedText(input.contactPhone, 'contact phone', 6, 32),
    settlementWallet: normalizeAddress(input.settlementWallet),
    level: merchantLevel(input.level),
    idempotencyKey: input.idempotencyKey,
    correlationId: boundedText(input.correlationId, 'correlation ID', 1, 128),
  };
}

function applicationUpdateInput(input: MerchantApplicationUpdateInput) {
  assertOnlyKeys(input, ['shopName', 'legalName', 'legalId', 'contactPhone', 'level', 'licenseAssetId', 'expectedVersion', 'idempotencyKey', 'correlationId']);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CoreError('InvalidRequest', 'Merchant application expected version is invalid');
  validateIdempotencyKey(input.idempotencyKey);
  return {
    shopName: boundedText(input.shopName, 'shop name', 1, 80),
    legalName: boundedText(input.legalName, 'legal name', 2, 80),
    legalId: boundedText(input.legalId, 'legal ID', 6, 32),
    contactPhone: boundedText(input.contactPhone, 'contact phone', 6, 32),
    level: merchantLevel(input.level),
    licenseAssetId: input.licenseAssetId === null ? null : hashValue(input.licenseAssetId, 'merchant license asset ID'),
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    correlationId: boundedText(input.correlationId, 'correlation ID', 1, 128),
  };
}

function merchantLevel(value: string) {
  if (!LEVELS.includes(value as MerchantLevel)) throw new CoreError('InvalidRequest', 'Merchant level is invalid');
  return value as MerchantLevel;
}

function merchantStatus(value: string) {
  if (!STATUSES.includes(value as MerchantStatus)) throw new CoreError('InvalidRequest', 'Merchant status is invalid');
  return value as MerchantStatus;
}

function reviewAction(value: string) {
  if (!REVIEW_ACTIONS.includes(value as ReviewAction)) throw new CoreError('InvalidRequest', 'Merchant review action is invalid');
  return value as ReviewAction;
}

function boundedCode(value: string, name: string) {
  if (!/^[A-Z0-9_:-]{2,64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return value;
}

function boundedText(value: string, name: string, minimum: number, maximum: number) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minimum || normalized.length > maximum) throw new CoreError('InvalidRequest', `${name} has invalid length`);
  return normalized;
}

function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new CoreError('InvalidRequest', 'Merchant lifecycle idempotency key is invalid');
}

function validateResourceId(value: string, name: string) {
  if (!value || value.length > 256) throw new CoreError('InvalidRequest', `${name} is invalid`);
}

function assertHash(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
}

function hashValue(value: string, name: string) {
  assertHash(value, name);
  return value.toLowerCase();
}

function assertSignature(value: string) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new CoreError('InvalidRequest', 'Merchant lifecycle signature is invalid');
}

function assertOnlyKeys(value: object, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new CoreError('InvalidRequest', 'Merchant lifecycle input contains unknown fields');
}

function idempotencyConflict(resource: string) {
  return new CoreError('IdempotencyConflict', `${resource} idempotency key changed`, 409);
}

function randomHash() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function randomNonce() {
  return BigInt(`0x${randomBytes(16).toString('hex')}`);
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function keyedHashJson(key: Buffer, domain: string, value: unknown) {
  return `0x${createHmac('sha256', key).update(domain).update('\0').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function encryptJson(payload: Record<string, unknown>, key: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptJson(row: ApplicationRow, key: Buffer, aad: string) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.encryption_iv));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(row.encryption_tag));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(row.encrypted_payload)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('InvalidPayload');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CoreError('ExternalBlocked', 'Merchant qualification decryption failed', 503);
  }
}

function parseEncryptionKey(value: string | undefined) {
  if (!value) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new CoreError('InvalidRequest', 'MERCHANT_PII_ENCRYPTION_KEY must contain 32 bytes', 500);
  return key;
}

function requireEncryptionKey(value: Buffer | undefined) {
  if (!value) throw new CoreError('ConfigurationRequired', 'Merchant qualification encryption is unavailable', 503);
  return value;
}

function retentionPolicy(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(normalized)) throw new CoreError('InvalidRequest', 'PII retention policy version is invalid', 500);
  return normalized;
}

function requireRetentionPolicy(value: string | undefined) {
  if (!value) throw new CoreError('DecisionBlocked', 'PII retention policy version is not frozen', 409);
  return value;
}

function applicationAad(merchantId: string, version: number) {
  return `abu24k:merchant-qualification:${merchantId}:v${version}`;
}

function requiredPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('ExternalBlocked', `Merchant qualification ${key} is invalid`, 503);
  return value;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function businessDay(now: Date) {
  const local = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BUSINESS_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
}

async function lifecycleAudit(executor: SqlExecutor, input: {
  eventType: string;
  merchantId: string;
  actorWallet: string;
  roles: string[];
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  signature?: { signatureHash: string; signer: string; digest: string; nonce: string; deadline: string };
  now: Date;
}) {
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('merchant-lifecycle', { eventType: input.eventType, requestHash: input.requestHash }),
    streamName: input.signature ? 'governance' : 'operational',
    evidenceProfile: input.signature ? 'SAFE_APPROVED' : 'RBAC',
    eventType: input.eventType,
    resourceType: 'MERCHANT',
    resourceId: input.merchantId,
    actorWallet: input.actorWallet,
    actorRole: input.roles[0] ?? 'ADMIN',
    merchantId: input.merchantId,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actorWallet,
      roles: input.roles,
      evidenceHash: hashJson({ subject: input.actorWallet, roles: [...input.roles].sort(), checkedAt: input.now.toISOString() }),
      checkedAt: input.now.toISOString(),
    },
    ...(input.signature ? {
      signatureEvidence: {
        scheme: 'EIP712', signatureHash: input.signature.signatureHash,
        signer: input.signature.signer, digest: input.signature.digest,
        domain: 'Abu24KV2Core:2:56:merchant-lifecycle',
        nonce: input.signature.nonce, deadline: input.signature.deadline,
      },
    } : {}),
    createdAt: input.now,
  });
}

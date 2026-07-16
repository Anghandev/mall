import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { getAddress } from 'ethers';
import {
  CORE_ARTIFACT_VERSION,
  logisticsCarrierCodes,
  logisticsProviders as managedLogisticsProviders,
  logisticsWarehouseKinds,
  type LogisticsCarrierCode,
  type LogisticsProvider as ManagedLogisticsProvider,
  type LogisticsProviderReadiness,
  type LogisticsWarehouseKind,
  type ProviderReadinessState,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export interface CarrierConfigInput {
  carriers: Array<{ carrierCode: LogisticsCarrierCode; enabled: boolean }>;
  defaultCarrierCode: LogisticsCarrierCode;
  idempotencyKey: string;
}

export interface ProviderConfigInput {
  provider: ManagedLogisticsProvider;
  enabled: boolean;
  partnerIdSecretRef: string;
  credentialSecretRef: string;
  monthlyAccountSecretRef: string;
  callbackSecretRef: string;
  idempotencyKey: string;
}

export interface WarehouseInput {
  warehouseKind: LogisticsWarehouseKind;
  name: string;
  partnerName: string | null;
  contactName: string;
  phone: string;
  regionCode: string;
  addressLine: string;
  enabled: boolean;
  idempotencyKey: string;
}

export interface WarehouseUpdateInput extends WarehouseInput {
  expectedVersion: number;
}

interface CarrierVersionRow {
  config_version_id: string;
  version: string | number;
  default_carrier_code: LogisticsCarrierCode;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: Date;
}

interface ProviderVersionRow {
  provider_config_version_id: string;
  provider: ManagedLogisticsProvider;
  version: string | number;
  enabled: boolean;
  partner_id_secret_ref: string;
  credential_secret_ref: string;
  monthly_account_secret_ref: string;
  callback_secret_ref: string;
  config_hash: string;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: Date;
}

interface WarehouseVersionRow {
  warehouse_version_id: string;
  warehouse_id: string;
  version: string | number;
  warehouse_kind: LogisticsWarehouseKind;
  name: string;
  partner_name: string | null;
  region_code: string;
  encrypted_payload: Uint8Array;
  encryption_iv: Uint8Array;
  encryption_tag: Uint8Array;
  payload_hash: string;
  enabled: boolean;
  idempotency_key: string;
  request_hash: string;
  created_by: string;
  created_at: Date;
}

interface WarehousePayload {
  contactName: string;
  phone: string;
  addressLine: string;
}

export class LogisticsAdminService {
  readonly #transactions: SqlTransactionRunner;
  readonly #encryptionKey: Buffer | undefined;
  readonly #runtimeReadiness: Readonly<Partial<Record<ManagedLogisticsProvider, ProviderReadinessState>>>;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    encryptionKey?: string;
    runtimeReadiness?: Readonly<Partial<Record<ManagedLogisticsProvider, ProviderReadinessState>>>;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#encryptionKey = parseEncryptionKey(input.encryptionKey);
    this.#runtimeReadiness = input.runtimeReadiness ?? {};
    this.#clock = input.clock ?? (() => new Date());
  }

  listCarrierConfig(actor: FulfillmentActor) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const current = await executor.query<CarrierVersionRow>(
        'SELECT * FROM core.logistics_carrier_config_versions ORDER BY version DESC LIMIT 1',
      );
      if (!current.rows[0]) return emptyCarrierProjection();
      return carrierProjection(executor, current.rows[0]);
    });
  }

  createCarrierConfigVersion(actor: FulfillmentActor, input: CarrierConfigInput) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizedAddress(actor.walletAddress);
    validateIdempotencyKey(input.idempotencyKey);
    const carriers = normalizedCarriers(input.carriers);
    const defaultCarrierCode = carrierCode(input.defaultCarrierCode);
    if (!carriers.find((item) => item.carrierCode === defaultCarrierCode)?.enabled) {
      throw new CoreError('InvalidRequest', 'Default logistics carrier must be enabled');
    }
    const requestHash = hashJson({ carriers, defaultCarrierCode });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['logistics-carrier-config']);
      const existing = await executor.query<CarrierVersionRow>(
        'SELECT * FROM core.logistics_carrier_config_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Carrier config');
        return carrierProjection(executor, existing.rows[0]);
      }
      const next = await executor.query<{ version: string | number }>(
        'SELECT COALESCE(max(version), 0) + 1 AS version FROM core.logistics_carrier_config_versions',
      );
      const now = this.#clock();
      const configVersionId = randomHash();
      const version = Number(next.rows[0]?.version ?? 1);
      await executor.query(
        `INSERT INTO core.logistics_carrier_config_versions (
           config_version_id, version, default_carrier_code, idempotency_key,
           request_hash, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [configVersionId, version, defaultCarrierCode, input.idempotencyKey, requestHash, wallet, now],
      );
      for (const item of carriers) {
        await executor.query(
          `INSERT INTO core.logistics_carrier_config_entries (config_version_id, carrier_code, enabled)
           VALUES ($1,$2,$3)`,
          [configVersionId, item.carrierCode, item.enabled],
        );
      }
      await logisticsAudit(executor, {
        eventType: 'LogisticsCarrierConfigVersionCreated', resourceType: 'LOGISTICS_CARRIER_CONFIG',
        resourceId: configVersionId, actor, roles, requestHash,
        payload: { version, defaultCarrierCode, carriers }, now,
      });
      return carrierProjection(executor, {
        config_version_id: configVersionId, version, default_carrier_code: defaultCarrierCode,
        idempotency_key: input.idempotencyKey, request_hash: requestHash, created_by: wallet, created_at: now,
      });
    });
  }

  listProviderConfigs(actor: FulfillmentActor) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const result = await executor.query<ProviderVersionRow>(
        'SELECT * FROM core.logistics_provider_config_versions ORDER BY provider, version DESC',
      );
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        providers: managedLogisticsProviders.map((provider) => {
          const row = result.rows.find((candidate) => candidate.provider === provider);
          return row ? providerProjection(row, this.#runtimeReadiness[provider]) : emptyProviderProjection(provider);
        }),
      };
    });
  }

  createProviderConfigVersion(actor: FulfillmentActor, input: ProviderConfigInput) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizedAddress(actor.walletAddress);
    const provider = managedProvider(input.provider);
    validateIdempotencyKey(input.idempotencyKey);
    const refs = {
      partnerIdSecretRef: secretRef(input.partnerIdSecretRef, 'Partner ID'),
      credentialSecretRef: secretRef(input.credentialSecretRef, 'provider credential'),
      monthlyAccountSecretRef: secretRef(input.monthlyAccountSecretRef, 'monthly account'),
      callbackSecretRef: secretRef(input.callbackSecretRef, 'callback secret'),
    };
    const configHash = hashJson({ provider, enabled: input.enabled, ...refs });
    const requestHash = hashJson({ provider, enabled: input.enabled, configHash });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`logistics-provider:${provider}`]);
      const existing = await executor.query<ProviderVersionRow>(
        'SELECT * FROM core.logistics_provider_config_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Provider config');
        return providerProjection(existing.rows[0], this.#runtimeReadiness[provider]);
      }
      const next = await executor.query<{ version: string | number }>(
        `SELECT COALESCE(max(version), 0) + 1 AS version
         FROM core.logistics_provider_config_versions WHERE provider = $1`,
        [provider],
      );
      const version = Number(next.rows[0]?.version ?? 1);
      const providerConfigVersionId = randomHash();
      const now = this.#clock();
      const inserted = await executor.query<ProviderVersionRow>(
        `INSERT INTO core.logistics_provider_config_versions (
           provider_config_version_id, provider, version, enabled,
           partner_id_secret_ref, credential_secret_ref, monthly_account_secret_ref,
           callback_secret_ref, config_hash, idempotency_key, request_hash, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          providerConfigVersionId, provider, version, input.enabled,
          refs.partnerIdSecretRef, refs.credentialSecretRef, refs.monthlyAccountSecretRef,
          refs.callbackSecretRef, configHash, input.idempotencyKey, requestHash, wallet, now,
        ],
      );
      await logisticsAudit(executor, {
        eventType: 'LogisticsProviderConfigVersionCreated', resourceType: 'LOGISTICS_PROVIDER_CONFIG',
        resourceId: providerConfigVersionId, actor, roles, requestHash,
        payload: { provider, version, enabled: input.enabled, configHash, secretReferencesStored: 4 }, now,
      });
      return providerProjection(inserted.rows[0]!, this.#runtimeReadiness[provider]);
    });
  }

  listWarehouses(actor: FulfillmentActor) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    const key = requireEncryptionKey(this.#encryptionKey);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const result = await executor.query<WarehouseVersionRow>(
        `SELECT version.* FROM core.logistics_warehouse_versions version
         JOIN (
           SELECT warehouse_id, max(version) AS version
           FROM core.logistics_warehouse_versions GROUP BY warehouse_id
         ) current ON current.warehouse_id = version.warehouse_id AND current.version = version.version
         ORDER BY version.name, version.warehouse_id`,
      );
      const redacted = !roles.includes('ADMIN') && !roles.includes('OPERATOR');
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        warehouses: result.rows.map((row) => warehouseProjection(row, key, redacted)),
      };
    });
  }

  createWarehouse(actor: FulfillmentActor, input: WarehouseInput) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const key = requireEncryptionKey(this.#encryptionKey);
    const value = normalizedWarehouse(input);
    const wallet = normalizedAddress(actor.walletAddress);
    const requestHash = hashJson({ ...value, idempotencyKey: input.idempotencyKey });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<WarehouseVersionRow>(
        'SELECT * FROM core.logistics_warehouse_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Warehouse');
        return warehouseProjection(existing.rows[0], key, false);
      }
      const warehouseId = `warehouse:${randomUUID()}`;
      return this.#insertWarehouseVersion(executor, actor, roles, warehouseId, 1, value, input.idempotencyKey, requestHash, key);
    });
  }

  updateWarehouse(actor: FulfillmentActor, warehouseId: string, input: WarehouseUpdateInput) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    validateWarehouseId(warehouseId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new CoreError('InvalidRequest', 'Warehouse expected version is invalid');
    }
    const key = requireEncryptionKey(this.#encryptionKey);
    const value = normalizedWarehouse(input);
    const wallet = normalizedAddress(actor.walletAddress);
    const requestHash = hashJson({ warehouseId, expectedVersion: input.expectedVersion, ...value });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<WarehouseVersionRow>(
        'SELECT * FROM core.logistics_warehouse_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Warehouse');
        return warehouseProjection(existing.rows[0], key, false);
      }
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`logistics-warehouse:${warehouseId}`]);
      const current = await currentWarehouse(executor, warehouseId);
      if (Number(current.version) !== input.expectedVersion) {
        throw new CoreError('IdempotencyConflict', 'Warehouse version changed', 409);
      }
      return this.#insertWarehouseVersion(
        executor, actor, roles, warehouseId, input.expectedVersion + 1,
        value, input.idempotencyKey, requestHash, key,
      );
    });
  }

  deactivateWarehouse(actor: FulfillmentActor, warehouseId: string, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    validateWarehouseId(warehouseId);
    validateIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new CoreError('InvalidRequest', 'Warehouse expected version is invalid');
    }
    const key = requireEncryptionKey(this.#encryptionKey);
    const wallet = normalizedAddress(actor.walletAddress);
    const requestHash = hashJson({ warehouseId, expectedVersion: input.expectedVersion, enabled: false });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, actor, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<WarehouseVersionRow>(
        'SELECT * FROM core.logistics_warehouse_versions WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Warehouse');
        return warehouseProjection(existing.rows[0], key, false);
      }
      await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`logistics-warehouse:${warehouseId}`]);
      const current = await currentWarehouse(executor, warehouseId);
      if (Number(current.version) !== input.expectedVersion) {
        throw new CoreError('IdempotencyConflict', 'Warehouse version changed', 409);
      }
      const payload = decryptWarehouse(current, key);
      return this.#insertWarehouseVersion(executor, actor, roles, warehouseId, input.expectedVersion + 1, {
        warehouseKind: current.warehouse_kind,
        name: current.name,
        partnerName: current.partner_name,
        regionCode: current.region_code,
        enabled: false,
        ...payload,
      }, input.idempotencyKey, requestHash, key);
    });
  }

  async #insertWarehouseVersion(
    executor: SqlExecutor,
    actor: FulfillmentActor,
    roles: string[],
    warehouseId: string,
    version: number,
    value: ReturnType<typeof normalizedWarehouse>,
    idempotencyKey: string,
    requestHash: string,
    key: Buffer,
  ) {
    const now = this.#clock();
    const payload: WarehousePayload = {
      contactName: value.contactName,
      phone: value.phone,
      addressLine: value.addressLine,
    };
    const payloadHash = hashJson(payload);
    const encrypted = encryptWarehouse(payload, key, warehouseId, version);
    const warehouseVersionId = randomHash();
    const inserted = await executor.query<WarehouseVersionRow>(
      `INSERT INTO core.logistics_warehouse_versions (
         warehouse_version_id, warehouse_id, version, warehouse_kind, name, partner_name,
         region_code, encrypted_payload, encryption_iv, encryption_tag, payload_hash,
         enabled, idempotency_key, request_hash, created_by, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        warehouseVersionId, warehouseId, version, value.warehouseKind, value.name, value.partnerName,
        value.regionCode, encrypted.ciphertext, encrypted.iv, encrypted.tag, payloadHash,
        value.enabled, idempotencyKey, requestHash, normalizedAddress(actor.walletAddress), now,
      ],
    );
    await logisticsAudit(executor, {
      eventType: version === 1 ? 'LogisticsWarehouseCreated' : value.enabled ? 'LogisticsWarehouseUpdated' : 'LogisticsWarehouseDeactivated',
      resourceType: 'LOGISTICS_WAREHOUSE', resourceId: warehouseId, actor, roles, requestHash,
      payload: {
        warehouseVersionId, version, warehouseKind: value.warehouseKind,
        name: value.name, regionCode: value.regionCode, enabled: value.enabled, payloadHash,
      },
      now,
    });
    return warehouseProjection(inserted.rows[0]!, key, false);
  }
}

export async function assertLogisticsRouteReady(
  executor: SqlExecutor,
  provider: ManagedLogisticsProvider,
  carrier: LogisticsCarrierCode,
) {
  const carrierResult = await executor.query<{ enabled: boolean }>(
    `SELECT entry.enabled FROM core.logistics_carrier_config_versions version
     JOIN core.logistics_carrier_config_entries entry ON entry.config_version_id = version.config_version_id
     WHERE entry.carrier_code = $1 ORDER BY version.version DESC LIMIT 1`,
    [carrier],
  );
  if (!carrierResult.rows[0]) {
    throw new CoreError('ConfigurationRequired', 'Logistics carrier configuration is unavailable', 503);
  }
  if (!carrierResult.rows[0].enabled) throw new CoreError('InvalidRequest', 'Selected logistics carrier is disabled', 409);
  const providerResult = await executor.query<{ enabled: boolean }>(
    `SELECT enabled FROM core.logistics_provider_config_versions
     WHERE provider = $1 ORDER BY version DESC LIMIT 1`,
    [provider],
  );
  if (!providerResult.rows[0] || !providerResult.rows[0].enabled) {
    throw new CoreError('ConfigurationRequired', 'Waybill provider configuration is unavailable or disabled', 503);
  }
}

export async function requireCurrentLogisticsRole(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  allowed: readonly ('ADMIN' | 'OPERATOR' | 'AUDITOR')[] = ['ADMIN', 'OPERATOR'],
) {
  return requireCurrentRole(executor, actor, allowed);
}

export async function appendLogisticsOperationAudit(executor: SqlExecutor, input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
  actor: FulfillmentActor;
  roles: string[];
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  return logisticsAudit(executor, input);
}

function emptyCarrierProjection() {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    configVersionId: null,
    version: 0,
    defaultCarrierCode: null,
    readiness: 'CONFIGURATION_REQUIRED' as const,
    carriers: logisticsCarrierCodes.map((code) => ({ carrierCode: code, enabled: false })),
    createdBy: null,
    createdAt: null,
  };
}

async function carrierProjection(executor: SqlExecutor, row: CarrierVersionRow) {
  const entries = await executor.query<{ carrier_code: LogisticsCarrierCode; enabled: boolean }>(
    `SELECT carrier_code, enabled FROM core.logistics_carrier_config_entries
     WHERE config_version_id = $1 ORDER BY carrier_code`,
    [row.config_version_id],
  );
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    configVersionId: row.config_version_id,
    version: Number(row.version),
    defaultCarrierCode: row.default_carrier_code,
    readiness: 'READY' as const,
    carriers: entries.rows.map((entry) => ({ carrierCode: entry.carrier_code, enabled: entry.enabled })),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function emptyProviderProjection(provider: ManagedLogisticsProvider) {
  return {
    provider,
    providerConfigVersionId: null,
    version: 0,
    enabled: false,
    configured: false,
    configuredFields: { partnerId: false, credential: false, monthlyAccount: false, callbackSecret: false },
    configHash: null,
    readiness: 'CONFIGURATION_REQUIRED' as LogisticsProviderReadiness,
    createdBy: null,
    createdAt: null,
  };
}

function providerProjection(row: ProviderVersionRow, runtime: ProviderReadinessState | undefined) {
  const readiness: LogisticsProviderReadiness = !row.enabled
    ? 'DISABLED'
    : runtime === 'READY' ? 'READY' : 'CONFIGURATION_REQUIRED';
  return {
    provider: row.provider,
    providerConfigVersionId: row.provider_config_version_id,
    version: Number(row.version),
    enabled: row.enabled,
    configured: true,
    configuredFields: { partnerId: true, credential: true, monthlyAccount: true, callbackSecret: true },
    configHash: row.config_hash,
    readiness,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function warehouseProjection(row: WarehouseVersionRow, key: Buffer, redacted: boolean) {
  const payload = decryptWarehouse(row, key);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    warehouseId: row.warehouse_id,
    warehouseVersionId: row.warehouse_version_id,
    version: Number(row.version),
    warehouseKind: row.warehouse_kind,
    name: row.name,
    partnerName: row.partner_name,
    regionCode: row.region_code,
    enabled: row.enabled,
    access: redacted ? 'REDACTED' as const : 'FULL' as const,
    contactName: redacted ? null : payload.contactName,
    phone: redacted ? null : payload.phone,
    addressLine: redacted ? null : payload.addressLine,
    payloadHash: row.payload_hash,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

async function currentWarehouse(executor: SqlExecutor, warehouseId: string) {
  const result = await executor.query<WarehouseVersionRow>(
    `SELECT * FROM core.logistics_warehouse_versions
     WHERE warehouse_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
    [warehouseId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Logistics warehouse not found', 404);
  return result.rows[0];
}

function normalizedCarriers(input: CarrierConfigInput['carriers']) {
  if (!Array.isArray(input) || input.length !== logisticsCarrierCodes.length) {
    throw new CoreError('InvalidRequest', 'Carrier config must contain every built-in carrier exactly once');
  }
  const carriers = input.map((item) => ({ carrierCode: carrierCode(item.carrierCode), enabled: boolean(item.enabled, 'carrier enabled') }))
    .sort((left, right) => left.carrierCode.localeCompare(right.carrierCode));
  if (new Set(carriers.map((item) => item.carrierCode)).size !== logisticsCarrierCodes.length) {
    throw new CoreError('InvalidRequest', 'Carrier config contains duplicate carriers');
  }
  if (!carriers.some((item) => item.enabled)) throw new CoreError('InvalidRequest', 'At least one logistics carrier must be enabled');
  return carriers;
}

function normalizedWarehouse(input: WarehouseInput) {
  validateIdempotencyKey(input.idempotencyKey);
  const warehouseKind = warehouseKindValue(input.warehouseKind);
  const partnerName = input.partnerName === null ? null : boundedString(input.partnerName, 'partner name', 2, 120);
  if ((warehouseKind === 'PARTNER') !== (partnerName !== null)) {
    throw new CoreError('InvalidRequest', 'Partner warehouses require a partner name and platform warehouses forbid one');
  }
  const phone = boundedString(input.phone, 'warehouse phone', 6, 32);
  if (!/^\+?[0-9 ()-]{6,32}$/.test(phone)) throw new CoreError('InvalidRequest', 'Warehouse phone is invalid');
  if (!/^\d{6}$/.test(input.regionCode)) throw new CoreError('InvalidRequest', 'Warehouse region code is invalid');
  return {
    warehouseKind,
    name: boundedString(input.name, 'warehouse name', 2, 120),
    partnerName,
    contactName: boundedString(input.contactName, 'warehouse contact', 2, 80),
    phone,
    regionCode: input.regionCode,
    addressLine: boundedString(input.addressLine, 'warehouse address', 5, 500),
    enabled: boolean(input.enabled, 'warehouse enabled'),
  };
}

async function requireCurrentRole(executor: SqlExecutor, actor: FulfillmentActor, allowed: readonly string[]) {
  const wallet = normalizedAddress(actor.walletAddress);
  const sessionAllowed = allowed.filter((role) => actor.roles.includes(role as never));
  if (sessionAllowed.length === 0) throw new CoreError('Forbidden', 'Wallet session cannot manage logistics', 403);
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, sessionAllowed],
  );
  if (result.rows.length === 0) throw new CoreError('Forbidden', 'Current wallet role cannot manage logistics', 403);
  return result.rows.map((row) => row.role);
}

function requireSessionRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new CoreError('Forbidden', 'Wallet session cannot manage logistics', 403);
  }
}

async function logisticsAudit(executor: SqlExecutor, input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
  actor: FulfillmentActor;
  roles: string[];
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  const wallet = normalizedAddress(input.actor.walletAddress);
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('logistics-admin', {
      eventType: input.eventType, resourceType: input.resourceType,
      resourceId: input.resourceId, requestHash: input.requestHash,
    }),
    streamName: 'operational',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorWallet: wallet,
    actorRole: input.roles[0]!,
    correlationId: `logistics:${input.resourceId}`,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: wallet,
      roles: input.roles,
      evidenceHash: hashJson({ subject: wallet, roles: [...input.roles].sort(), checkedAt: input.now.toISOString() }),
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
}

function encryptWarehouse(payload: WarehousePayload, key: Buffer, warehouseId: string, version: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(warehouseAad(warehouseId, version)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptWarehouse(row: WarehouseVersionRow, key: Buffer): WarehousePayload {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.encryption_iv));
    decipher.setAAD(Buffer.from(warehouseAad(row.warehouse_id, Number(row.version))));
    decipher.setAuthTag(Buffer.from(row.encryption_tag));
    const value = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_payload)), decipher.final(),
    ]).toString('utf8')) as WarehousePayload;
    if (!value.contactName || !value.phone || !value.addressLine) throw new Error('invalid');
    return value;
  } catch {
    throw new CoreError('ExternalBlocked', 'Logistics warehouse address cannot be decrypted', 503);
  }
}

function warehouseAad(warehouseId: string, version: number) {
  return `abu24k:logistics-warehouse:${warehouseId}:v${version}`;
}

function parseEncryptionKey(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(normalized) ? Buffer.from(normalized, 'hex') : Buffer.from(normalized, 'base64');
  if (key.length !== 32) throw new CoreError('ConfigurationRequired', 'Logistics warehouse encryption key must contain 32 bytes', 503);
  return key;
}

function requireEncryptionKey(value: Buffer | undefined) {
  if (!value) throw new CoreError('ConfigurationRequired', 'Logistics warehouse encryption is unavailable', 503);
  return value;
}

function managedProvider(value: string): ManagedLogisticsProvider {
  if (!managedLogisticsProviders.includes(value as ManagedLogisticsProvider)) throw new CoreError('InvalidRequest', 'Unsupported logistics provider');
  return value as ManagedLogisticsProvider;
}

function carrierCode(value: string): LogisticsCarrierCode {
  if (!logisticsCarrierCodes.includes(value as LogisticsCarrierCode)) throw new CoreError('InvalidRequest', 'Unsupported logistics carrier');
  return value as LogisticsCarrierCode;
}

function warehouseKindValue(value: string): LogisticsWarehouseKind {
  if (!logisticsWarehouseKinds.includes(value as LogisticsWarehouseKind)) throw new CoreError('InvalidRequest', 'Unsupported warehouse kind');
  return value as LogisticsWarehouseKind;
}

function secretRef(value: string, name: string) {
  const normalized = value.trim();
  if (!/^(?:vault|secret):\/\/[^\s]{1,500}$/.test(normalized)) {
    throw new CoreError('InvalidRequest', `${name} must be a secret reference`);
  }
  return normalized;
}

function boundedString(value: string, name: string, minimum: number, maximum: number) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minimum || normalized.length > maximum) throw new CoreError('InvalidRequest', `${name} is invalid`);
  return normalized;
}

function boolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new CoreError('InvalidRequest', `${name} must be boolean`);
  return value;
}

function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new CoreError('InvalidRequest', 'Logistics idempotency key is invalid');
}

function validateWarehouseId(value: string) {
  if (!/^warehouse:[0-9a-f-]{36}$/.test(value)) throw new CoreError('InvalidRequest', 'Warehouse ID is invalid');
}

function normalizedAddress(value: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', 'Logistics actor wallet is invalid');
  }
}

function idempotencyConflict(resource: string) {
  return new CoreError('IdempotencyConflict', `${resource} idempotency key changed`, 409);
}

function randomHash() {
  return `0x${randomBytes(32).toString('hex')}`;
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

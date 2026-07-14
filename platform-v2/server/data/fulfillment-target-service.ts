import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdministrativeRegionResolver } from '../api/providers.ts';
import { CoreError } from '../api/errors.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const TARGET_TTL_MS = 30 * 60 * 1000;

export interface DeliveryTargetInput {
  idempotencyKey: string;
  recipientName: string;
  phone: string;
  address: string;
  longitude: number;
  latitude: number;
}

export interface PickupTargetInput {
  idempotencyKey: string;
  storeId: string;
}

export interface StoreInput {
  idempotencyKey: string;
  name: string;
  phone: string;
  longitude: number;
  latitude: number;
}

interface TargetRow {
  target_id: string;
  target_hash: string;
  buyer_wallet: string;
  idempotency_key: string;
  request_hash: string;
  fulfillment_mode: 'DELIVERY' | 'PICKUP';
  region_code: string;
  region_code_hash: string;
  store_id: string | null;
  encrypted_payload: Uint8Array;
  encryption_iv: Uint8Array;
  encryption_tag: Uint8Array;
  expires_at: Date;
  created_at: Date;
}

interface StoreRow {
  store_id: string;
  merchant_id: string;
  idempotency_key: string;
  request_hash: string;
  name: string;
  region_code: string;
  longitude: string | number;
  latitude: string | number;
  address: string;
  phone: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  version: string | number;
}

export class FulfillmentTargetService {
  readonly #transactions: SqlTransactionRunner;
  readonly #regions: AdministrativeRegionResolver;
  readonly #key: Buffer | undefined;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    regions: AdministrativeRegionResolver;
    encryptionKey?: string;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#regions = input.regions;
    this.#key = parseEncryptionKey(input.encryptionKey);
    this.#clock = input.clock ?? (() => new Date());
  }

  async createDeliveryTarget(actor: FulfillmentActor, input: DeliveryTargetInput) {
    assertBuyerRole(actor);
    validateDeliveryInput(input);
    const buyer = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson(input);
    const existing = await this.#transactions.transaction((executor) => loadTargetByIdempotency(
      executor,
      buyer,
      input.idempotencyKey,
      requestHash,
    ));
    if (existing) return targetSummary(existing);
    const key = requireEncryptionKey(this.#key);
    const region = await this.#regions.reverseGeocode({ longitude: input.longitude, latitude: input.latitude });
    const now = this.#clock();
    const payload = {
      recipientName: input.recipientName,
      phone: input.phone,
      address: input.address,
      longitude: input.longitude,
      latitude: input.latitude,
      regionCode: region.regionCode,
    };
    const encrypted = encrypt(payload, key);
    const targetId = `target:${randomUUID()}`;
    const targetHash = hashJson({
      targetId,
      buyer,
      mode: 'DELIVERY',
      regionCode: region.regionCode,
      ciphertext: encrypted.ciphertext.toString('hex'),
      iv: encrypted.iv.toString('hex'),
      tag: encrypted.tag.toString('hex'),
    });
    const regionCodeHash = hashJson({ regionCode: region.regionCode });
    const expiresAt = new Date(now.getTime() + TARGET_TTL_MS);
    return this.#transactions.transaction(async (executor) => {
      const raced = await loadTargetByIdempotency(executor, buyer, input.idempotencyKey, requestHash);
      if (raced) return targetSummary(raced);
      await ensureRegion(executor, region);
      await executor.query(
        `INSERT INTO core.fulfillment_targets (
           target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
           fulfillment_mode, region_code, region_code_hash, store_id,
           encrypted_payload, encryption_iv, encryption_tag, expires_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,'DELIVERY',$6,$7,NULL,$8,$9,$10,$11,$12)`,
        [
          targetId,
          targetHash,
          buyer,
          input.idempotencyKey,
          requestHash,
          region.regionCode,
          regionCodeHash,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          expiresAt,
          now,
        ],
      );
      return {
        targetId,
        targetHash,
        fulfillmentMode: 'DELIVERY' as const,
        regionCode: region.regionCode,
        regionCodeHash,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  createPickupTarget(actor: FulfillmentActor, input: PickupTargetInput) {
    assertBuyerRole(actor);
    validateIdempotencyKey(input.idempotencyKey);
    if (!input.storeId) throw new CoreError('InvalidRequest', 'storeId is required');
    const buyer = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson(input);
    const key = requireEncryptionKey(this.#key);
    return this.#transactions.transaction(async (executor) => {
      const existing = await loadTargetByIdempotency(executor, buyer, input.idempotencyKey, requestHash);
      if (existing) {
        if (!existing.store_id) throw new CoreError('IdempotencyConflict', 'Pickup target mode changed', 409);
        return { ...targetSummary(existing), store: storeProjection(await loadStore(executor, existing.store_id)) };
      }
      const store = await loadStore(executor, input.storeId);
      if (store.status !== 'ACTIVE') throw new CoreError('InvalidRequest', 'Pickup store is unavailable', 409);
      const now = this.#clock();
      const encrypted = encrypt(storeProjection(store), key);
      const targetId = `target:${randomUUID()}`;
      const targetHash = hashJson({
        targetId,
        buyer,
        mode: 'PICKUP',
        storeId: store.store_id,
        storeVersion: Number(store.version),
        ciphertext: encrypted.ciphertext.toString('hex'),
      });
      const regionCodeHash = hashJson({ regionCode: store.region_code });
      const expiresAt = new Date(now.getTime() + TARGET_TTL_MS);
      await executor.query(
        `INSERT INTO core.fulfillment_targets (
           target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
           fulfillment_mode, region_code, region_code_hash, store_id,
           encrypted_payload, encryption_iv, encryption_tag, expires_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,'PICKUP',$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          targetId,
          targetHash,
          buyer,
          input.idempotencyKey,
          requestHash,
          store.region_code,
          regionCodeHash,
          store.store_id,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          expiresAt,
          now,
        ],
      );
      return {
        targetId,
        targetHash,
        fulfillmentMode: 'PICKUP' as const,
        regionCode: store.region_code,
        regionCodeHash,
        storeId: store.store_id,
        store: storeProjection(store),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async createStore(actor: FulfillmentActor, input: StoreInput) {
    assertMerchantRole(actor);
    validateStoreInput(input);
    const requestHash = hashJson(input);
    const merchantId = actor.merchantId!;
    const existing = await this.#transactions.transaction((executor) => loadStoreByIdempotency(
      executor,
      merchantId,
      input.idempotencyKey,
      requestHash,
    ));
    if (existing) return storeProjection(existing);
    const region = await this.#regions.reverseGeocode({ longitude: input.longitude, latitude: input.latitude });
    return this.#transactions.transaction(async (executor) => {
      const raced = await loadStoreByIdempotency(executor, merchantId, input.idempotencyKey, requestHash);
      if (raced) return storeProjection(raced);
      const merchant = await executor.query<{ status: string }>(
        'SELECT status FROM core.merchants WHERE merchant_id = $1 FOR UPDATE',
        [merchantId],
      );
      if (merchant.rows[0]?.status !== 'APPROVED') throw new CoreError('Forbidden', 'Merchant is not approved', 403);
      await ensureRegion(executor, region);
      const storeId = `store:${randomUUID()}`;
      await executor.query(
        `INSERT INTO core.merchant_stores (
           store_id, merchant_id, idempotency_key, request_hash, name, region_code,
           longitude, latitude, address, phone, status, version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',1)`,
        [
          storeId,
          merchantId,
          input.idempotencyKey,
          requestHash,
          input.name,
          region.regionCode,
          input.longitude,
          input.latitude,
          region.formattedAddress,
          input.phone,
        ],
      );
      return {
        storeId,
        merchantId,
        name: input.name,
        regionCode: region.regionCode,
        longitude: input.longitude,
        latitude: input.latitude,
        address: region.formattedAddress,
        phone: input.phone,
        status: 'ACTIVE' as const,
        version: 1,
      };
    });
  }

  listStores(regionCode?: string) {
    if (regionCode !== undefined && !/^[0-9]{6}$/.test(regionCode)) {
      throw new CoreError('InvalidRequest', 'regionCode must contain six digits');
    }
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<StoreRow>(
        `SELECT * FROM core.merchant_stores WHERE status = 'ACTIVE'
         ${regionCode ? 'AND region_code = $1' : ''} ORDER BY name, store_id`,
        regionCode ? [regionCode] : [],
      );
      return result.rows.map(storeProjection);
    });
  }

  getOrderTarget(actor: FulfillmentActor, orderId: string) {
    const key = requireEncryptionKey(this.#key);
    const wallet = normalizedWallet(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<TargetRow & { buyer: string; merchant: string; merchant_id: string }>(
        `SELECT target.*, orders.buyer_wallet AS buyer, orders.merchant_wallet AS merchant,
           orders.merchant_id
         FROM core.orders orders
         JOIN core.fulfillment_targets target
           ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
         WHERE orders.order_id = $1`,
        [orderId],
      );
      const target = result.rows[0];
      if (!target) throw new CoreError('InvalidRequest', 'Order fulfillment target not found', 404);
      const privileged = actor.roles.some((role) => ['ADMIN', 'OPERATOR', 'ARBITRATOR'].includes(role));
      if (
        wallet !== target.buyer.toLowerCase()
        && wallet !== target.merchant.toLowerCase()
        && actor.merchantId !== target.merchant_id
        && !privileged
      ) throw new CoreError('Forbidden', 'Fulfillment target is outside the authenticated wallet scope', 403);
      return {
        ...targetSummary(target),
        payload: decrypt(target, key),
      };
    });
  }
}

export async function assertQuoteFulfillmentTarget(
  executor: SqlExecutor,
  input: {
    buyerWallet: string;
    fulfillmentMode: 'DELIVERY' | 'PICKUP';
    fulfillmentTargetHash: string;
    regionCodeHash: string;
    now: Date;
  },
) {
  const result = await executor.query<{
    fulfillment_mode: string;
    region_code_hash: string;
    expires_at: Date;
  }>(
    `SELECT fulfillment_mode, region_code_hash, expires_at
     FROM core.fulfillment_targets
     WHERE buyer_wallet = $1 AND lower(target_hash) = lower($2)`,
    [normalizedWallet(input.buyerWallet), input.fulfillmentTargetHash],
  );
  const target = result.rows[0];
  if (
    !target
    || target.fulfillment_mode !== input.fulfillmentMode
    || target.region_code_hash.toLowerCase() !== input.regionCodeHash.toLowerCase()
    || new Date(target.expires_at) <= input.now
  ) throw new CoreError('InvalidRequest', 'Fulfillment target is missing, expired or mismatched', 409);
}

async function loadTargetByIdempotency(
  executor: SqlExecutor,
  buyer: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const result = await executor.query<TargetRow>(
    `SELECT * FROM core.fulfillment_targets
     WHERE buyer_wallet = $1 AND idempotency_key = $2`,
    [buyer, idempotencyKey],
  );
  const target = result.rows[0];
  if (target && target.request_hash.toLowerCase() !== requestHash.toLowerCase()) {
    throw new CoreError('IdempotencyConflict', 'Fulfillment target key was reused with different input', 409);
  }
  return target;
}

async function loadStoreByIdempotency(
  executor: SqlExecutor,
  merchantId: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const result = await executor.query<StoreRow>(
    'SELECT * FROM core.merchant_stores WHERE merchant_id = $1 AND idempotency_key = $2',
    [merchantId, idempotencyKey],
  );
  const store = result.rows[0];
  if (store && store.request_hash.toLowerCase() !== requestHash.toLowerCase()) {
    throw new CoreError('IdempotencyConflict', 'Store idempotency key was reused with different input', 409);
  }
  return store;
}

async function loadStore(executor: SqlExecutor, storeId: string) {
  const result = await executor.query<StoreRow>('SELECT * FROM core.merchant_stores WHERE store_id = $1', [storeId]);
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Pickup store not found', 404);
  return result.rows[0];
}

async function ensureRegion(
  executor: SqlExecutor,
  region: {
    regionCode: string;
    province: string;
    city: string;
    district: string;
    sourceReferenceHash: string;
  },
) {
  await executor.query(
    `INSERT INTO core.administrative_regions (
       region_code, province, city, district, source, source_reference_hash, status
     ) VALUES ($1,$2,$3,$4,'AMAP',$5,'ACTIVE') ON CONFLICT (region_code) DO NOTHING`,
    [region.regionCode, region.province, region.city, region.district, region.sourceReferenceHash],
  );
  const persisted = await executor.query<{
    province: string;
    city: string;
    district: string;
    status: string;
  }>('SELECT province, city, district, status FROM core.administrative_regions WHERE region_code = $1', [region.regionCode]);
  const row = persisted.rows[0];
  if (
    !row
    || row.province !== region.province
    || row.city !== region.city
    || row.district !== region.district
    || row.status !== 'ACTIVE'
  ) throw new CoreError('IdempotencyConflict', 'Administrative region code conflicts with frozen evidence', 409);
}

function targetSummary(target: TargetRow) {
  return {
    targetId: target.target_id,
    targetHash: target.target_hash,
    fulfillmentMode: target.fulfillment_mode,
    regionCode: target.region_code,
    regionCodeHash: target.region_code_hash,
    ...(target.store_id ? { storeId: target.store_id } : {}),
    expiresAt: new Date(target.expires_at).toISOString(),
  };
}

function storeProjection(store: StoreRow) {
  return {
    storeId: store.store_id,
    merchantId: store.merchant_id,
    name: store.name,
    regionCode: store.region_code,
    longitude: Number(store.longitude),
    latitude: Number(store.latitude),
    address: store.address,
    phone: store.phone,
    status: store.status,
    version: Number(store.version),
  };
}

function encrypt(payload: Record<string, unknown>, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(target: TargetRow, key: Buffer) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(target.encryption_iv));
    decipher.setAuthTag(Buffer.from(target.encryption_tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(target.encrypted_payload)),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new CoreError('ExternalBlocked', 'Fulfillment target decryption failed', 503);
  }
}

function parseEncryptionKey(value: string | undefined) {
  if (!value) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new CoreError('InvalidRequest', 'DELIVERY_DATA_ENCRYPTION_KEY must contain 32 bytes', 500);
  return key;
}

function requireEncryptionKey(key: Buffer | undefined) {
  if (!key) throw new CoreError('ConfigurationRequired', 'Delivery data encryption is unavailable', 503);
  return key;
}

function validateDeliveryInput(input: DeliveryTargetInput) {
  validateIdempotencyKey(input.idempotencyKey);
  if (
    input.recipientName.trim().length < 1
    || input.recipientName.length > 64
    || !/^[+]?[0-9-]{7,20}$/.test(input.phone)
    || input.address.trim().length < 5
    || input.address.length > 300
  ) throw new CoreError('InvalidRequest', 'Invalid delivery target');
  validateCoordinates(input.longitude, input.latitude);
}

function validateStoreInput(input: StoreInput) {
  validateIdempotencyKey(input.idempotencyKey);
  if (input.name.trim().length < 1 || input.name.length > 100 || !/^[+]?[0-9-]{7,20}$/.test(input.phone)) {
    throw new CoreError('InvalidRequest', 'Invalid store input');
  }
  validateCoordinates(input.longitude, input.latitude);
}

function validateCoordinates(longitude: number, latitude: number) {
  if (
    !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
  ) throw new CoreError('InvalidRequest', 'Invalid coordinates');
}

function validateIdempotencyKey(value: string) {
  if (value.length < 8 || value.length > 128) {
    throw new CoreError('InvalidRequest', 'idempotencyKey must contain 8-128 characters');
  }
}

function assertBuyerRole(actor: FulfillmentActor) {
  if (!actor.roles.includes('BUYER')) throw new CoreError('Forbidden', 'Buyer role is required', 403);
}

function assertMerchantRole(actor: FulfillmentActor) {
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId) {
    throw new CoreError('Forbidden', 'Bound merchant role is required', 403);
  }
}

function normalizedWallet(value: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid actor wallet');
  return value.toLowerCase();
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

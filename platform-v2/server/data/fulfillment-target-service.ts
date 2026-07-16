import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AdministrativeRegionResolver } from '../api/providers.ts';
import {
  CORE_ARTIFACT_VERSION,
  fulfillmentModes,
  orderProjectionStates,
  type OrderState,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor, OrderKind } from './fulfillment-service.ts';
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
  businessHours: string;
  longitude: number;
  latitude: number;
  correlationId: string;
}

export interface StoreProfileInput {
  name: string;
  phone: string;
  businessHours: string;
  imageAssetIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
  correlationId: string;
}

export interface StoreVersionInput {
  expectedVersion: number;
  idempotencyKey: string;
  correlationId: string;
}

export interface MerchantOrderExportInput {
  from?: Date;
  to?: Date;
  skuId?: string;
  state?: OrderState;
  fulfillmentMode?: 'DELIVERY' | 'PICKUP';
  orderKind?: OrderKind;
  cursorCreatedAt?: Date;
  cursorOrderId?: string;
  limit?: number;
}

export interface MerchantOrderExportResult {
  artifactVersion: string;
  exportId: string;
  merchantId: string;
  contentType: 'application/vnd.ms-excel; charset=utf-8';
  filename: string;
  rowCount: number;
  contentHash: string;
  contentBase64: string;
  nextCursor: { createdAt: string; orderId: string } | null;
  filters: Record<string, unknown>;
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
  business_hours: string;
  image_asset_ids: unknown;
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface StoreCommandRow {
  request_hash: string;
  result: ReturnType<typeof managedStoreProjection>;
}

interface MerchantOrderExportRow extends TargetRow {
  order_id: string;
  payment_tx_hash: string | null;
  quantity: string | number;
  order_created_at: Date;
  order_state: string;
  order_fulfillment_mode: 'DELIVERY' | 'PICKUP';
  sku_id: string;
  quote_kind: 'ORDINARY' | 'SECKILL' | null;
  seckill_snapshot: unknown;
  shipment_tracking_hash: string | null;
  waybill_tracking: Uint8Array | null;
  waybill_iv: Uint8Array | null;
  waybill_tag: Uint8Array | null;
  manual_tracking: Uint8Array | null;
  manual_tracking_iv: Uint8Array | null;
  manual_tracking_tag: Uint8Array | null;
  pickup_verified_at: Date | null;
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
    const wallet = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson(storeCreatePayload(input));
    const merchantId = actor.merchantId!;
    const existing = await this.#transactions.transaction(async (executor) => {
      await requireMerchantStoreScope(executor, actor);
      return loadStoreCommand(executor, wallet, input.idempotencyKey, requestHash);
    });
    if (existing) return existing.result;
    const region = await this.#regions.reverseGeocode({ longitude: input.longitude, latitude: input.latitude });
    return this.#transactions.transaction(async (executor) => {
      await lockStoreCommand(executor, wallet, input.idempotencyKey);
      const raced = await loadStoreCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (raced) return raced.result;
      await requireMerchantStoreScope(executor, actor, true);
      await ensureRegion(executor, region);
      const storeId = `store:${randomUUID()}`;
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.merchant_stores (
           store_id, merchant_id, idempotency_key, request_hash, name, region_code,
           longitude, latitude, address, phone, business_hours, image_asset_ids,
           status, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,'DRAFT',1,$12,$12)`,
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
          input.businessHours.trim(),
          now,
        ],
      );
      const store = await requiredStore(executor, storeId, true);
      const projection = managedStoreProjection(store);
      const commandId = `store-command:${randomUUID()}`;
      await insertStoreCommand(executor, {
        commandId, storeId, merchantId, wallet, commandType: 'CREATE',
        idempotencyKey: input.idempotencyKey, requestHash, result: projection, now,
      });
      await insertStoreVersion(executor, store, commandId, wallet, now);
      await enqueueStoreAudit(executor, {
        eventType: 'MerchantStoreCreated', store, wallet, correlationId: input.correlationId,
        requestHash, commandId, now,
      });
      return projection;
    });
  }

  listMerchantStores(actor: FulfillmentActor) {
    assertMerchantRole(actor);
    return this.#transactions.transaction(async (executor) => {
      await requireMerchantStoreScope(executor, actor);
      const result = await executor.query<StoreRow>(
        `SELECT * FROM core.merchant_stores
         WHERE merchant_id = $1 ORDER BY created_at, store_id`,
        [actor.merchantId],
      );
      return result.rows.map(managedStoreProjection);
    });
  }

  updateStore(actor: FulfillmentActor, storeId: string, input: StoreProfileInput) {
    assertMerchantRole(actor);
    validateStoreProfileInput(input);
    const wallet = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson({ storeId, ...storeProfilePayload(input) });
    return this.#transactions.transaction(async (executor) => {
      await lockStoreCommand(executor, wallet, input.idempotencyKey);
      const existing = await loadStoreCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (existing) return existing.result;
      await requireMerchantStoreScope(executor, actor, true);
      const store = await requiredMerchantStore(executor, storeId, actor.merchantId!, true);
      assertExpectedStoreVersion(store, input.expectedVersion);
      if (store.status === 'CLOSED') throw new CoreError('Forbidden', 'Closed store profile is immutable', 409);
      if (store.status === 'SUSPENDED') throw new CoreError('Forbidden', 'Suspended store profile cannot be changed by merchant', 409);
      await verifyStoreImages(executor, store, wallet, input.imageAssetIds);
      const now = this.#clock();
      const nextVersion = Number(store.version) + 1;
      await executor.query(
        `UPDATE core.merchant_stores
         SET name = $2, phone = $3, business_hours = $4, image_asset_ids = $5,
             version = $6, updated_at = $7
         WHERE store_id = $1`,
        [
          storeId,
          input.name.trim(),
          input.phone,
          input.businessHours.trim(),
          JSON.stringify(input.imageAssetIds),
          nextVersion,
          now,
        ],
      );
      const updated = await requiredStore(executor, storeId, true);
      const projection = managedStoreProjection(updated);
      const commandId = `store-command:${randomUUID()}`;
      await insertStoreCommand(executor, {
        commandId, storeId, merchantId: actor.merchantId!, wallet, commandType: 'UPDATE_PROFILE',
        idempotencyKey: input.idempotencyKey, requestHash, result: projection, now,
      });
      await insertStoreVersion(executor, updated, commandId, wallet, now);
      await enqueueStoreAudit(executor, {
        eventType: 'MerchantStoreProfileUpdated', store: updated, wallet,
        correlationId: input.correlationId, requestHash, commandId, now,
      });
      return projection;
    });
  }

  activateStore(actor: FulfillmentActor, storeId: string, input: StoreVersionInput) {
    return this.transitionStore(actor, storeId, 'ACTIVATE', input);
  }

  closeStore(actor: FulfillmentActor, storeId: string, input: StoreVersionInput) {
    return this.transitionStore(actor, storeId, 'CLOSE', input);
  }

  private transitionStore(
    actor: FulfillmentActor,
    storeId: string,
    commandType: 'ACTIVATE' | 'CLOSE',
    input: StoreVersionInput,
  ) {
    assertMerchantRole(actor);
    validateStoreVersionInput(input);
    const wallet = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson({ storeId, commandType, expectedVersion: input.expectedVersion });
    return this.#transactions.transaction(async (executor) => {
      await lockStoreCommand(executor, wallet, input.idempotencyKey);
      const existing = await loadStoreCommand(executor, wallet, input.idempotencyKey, requestHash);
      if (existing) return existing.result;
      await requireMerchantStoreScope(executor, actor, commandType === 'ACTIVATE');
      const store = await requiredMerchantStore(executor, storeId, actor.merchantId!, true);
      assertExpectedStoreVersion(store, input.expectedVersion);
      if (commandType === 'ACTIVATE') {
        if (store.status !== 'DRAFT') throw new CoreError('Forbidden', 'Only a draft store can be activated', 409);
        if (!store.business_hours.trim() || storeImageIds(store.image_asset_ids).length === 0) {
          throw new CoreError('InvalidRequest', 'Store requires business hours and at least one verified image before activation', 409);
        }
      } else if (store.status === 'CLOSED') {
        throw new CoreError('IdempotencyConflict', 'Store is already closed', 409);
      }
      const now = this.#clock();
      const nextStatus = commandType === 'ACTIVATE' ? 'ACTIVE' : 'CLOSED';
      await executor.query(
        `UPDATE core.merchant_stores
         SET status = $2, version = $3, updated_at = $4 WHERE store_id = $1`,
        [storeId, nextStatus, Number(store.version) + 1, now],
      );
      const updated = await requiredStore(executor, storeId, true);
      const projection = managedStoreProjection(updated);
      const commandId = `store-command:${randomUUID()}`;
      await insertStoreCommand(executor, {
        commandId, storeId, merchantId: actor.merchantId!, wallet, commandType,
        idempotencyKey: input.idempotencyKey, requestHash, result: projection, now,
      });
      await insertStoreVersion(executor, updated, commandId, wallet, now);
      await enqueueStoreAudit(executor, {
        eventType: commandType === 'ACTIVATE' ? 'MerchantStoreActivated' : 'MerchantStoreClosed',
        store: updated, wallet, correlationId: input.correlationId, requestHash, commandId, now,
      });
      return projection;
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

  exportMerchantOrders(actor: FulfillmentActor, input: MerchantOrderExportInput = {}) {
    assertMerchantRole(actor);
    const query = merchantOrderExportQuery(input, this.#clock());
    const key = requireEncryptionKey(this.#key);
    return this.#transactions.transaction(async (executor) => {
      await requireMerchantStoreScope(executor, actor);
      const params: unknown[] = [actor.merchantId];
      const conditions = ['orders.merchant_id = $1'];
      const add = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      conditions.push(`orders.created_at >= ${add(query.from)}`);
      conditions.push(`orders.created_at <= ${add(query.to)}`);
      if (query.skuId) conditions.push(`orders.sku_id = ${add(query.skuId)}`);
      if (query.state) conditions.push(`orders.state = ${add(query.state)}`);
      if (query.fulfillmentMode) conditions.push(`orders.fulfillment_mode = ${add(query.fulfillmentMode)}`);
      if (query.orderKind) {
        conditions.push(`CASE
          WHEN orders.seckill_snapshot IS NOT NULL THEN 'SECKILL'
          WHEN quote.quote_kind = 'SECKILL' THEN 'FALLBACK_RETAIL'
          ELSE 'ORDINARY'
        END = ${add(query.orderKind)}`);
      }
      if (query.cursorCreatedAt && query.cursorOrderId) {
        conditions.push(`(orders.created_at, orders.order_id) < (${add(query.cursorCreatedAt)}, ${add(query.cursorOrderId)})`);
      }
      params.push(query.limit + 1);
      const result = await executor.query<MerchantOrderExportRow>(
        `SELECT target.*, orders.order_id, orders.payment_tx_hash,
           orders.quantity, orders.created_at AS order_created_at,
           orders.state AS order_state, orders.fulfillment_mode AS order_fulfillment_mode,
           orders.sku_id, orders.seckill_snapshot, quote.quote_kind,
           shipment.tracking_number_hash AS shipment_tracking_hash,
           waybill.encrypted_tracking_number AS waybill_tracking,
           waybill.tracking_iv AS waybill_iv, waybill.tracking_tag AS waybill_tag,
           manual.encrypted_tracking_number AS manual_tracking,
           manual.tracking_iv AS manual_tracking_iv, manual.tracking_tag AS manual_tracking_tag,
           pickup.attempted_at AS pickup_verified_at
         FROM core.orders orders
         JOIN core.fulfillment_targets target
           ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
         LEFT JOIN core.payment_quotes quote ON quote.order_id = orders.order_id
         LEFT JOIN LATERAL (
           SELECT tracking_number_hash FROM core.shipments
           WHERE order_id = orders.order_id ORDER BY created_at DESC, shipment_id DESC LIMIT 1
         ) shipment ON true
         LEFT JOIN LATERAL (
           SELECT encrypted_tracking_number, tracking_iv, tracking_tag
           FROM core.waybill_requests WHERE order_id = orders.order_id
             AND encrypted_tracking_number IS NOT NULL
           ORDER BY updated_at DESC, request_id DESC LIMIT 1
         ) waybill ON true
         LEFT JOIN LATERAL (
           SELECT encrypted_tracking_number, tracking_iv, tracking_tag
           FROM core.evidence_envelopes WHERE resource_id = orders.order_id
             AND purpose = 'SHIPMENT_TRACKING'
           ORDER BY created_at DESC, evidence_hash DESC LIMIT 1
         ) manual ON true
         LEFT JOIN LATERAL (
           SELECT attempted_at FROM core.pickup_verification_attempts
           WHERE order_id = orders.order_id AND successful
           ORDER BY attempted_at DESC, attempt_id DESC LIMIT 1
         ) pickup ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY orders.created_at DESC, orders.order_id DESC
         LIMIT $${params.length}`,
        params,
      );
      const pageRows = result.rows.slice(0, query.limit);
      const rows = pageRows.map((row) => merchantOrderExportRow(row, key));
      const content = merchantOrderExcel(rows);
      const contentHash = `0x${createHash('sha256').update(content).digest('hex')}`;
      const exportId = hashJson({
        domain: 'ABU24K_MERCHANT_ORDER_EXPORT_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        merchantId: actor.merchantId,
        query: exportQueryProjection(query),
        contentHash,
      });
      const last = pageRows.at(-1);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        exportId,
        merchantId: actor.merchantId!,
        contentType: 'application/vnd.ms-excel; charset=utf-8' as const,
        filename: `merchant-orders-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.xls`,
        rowCount: rows.length,
        contentHash,
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
        nextCursor: result.rows.length > query.limit && last
          ? { createdAt: last.order_created_at.toISOString(), orderId: last.order_id }
          : null,
        filters: exportQueryProjection(query),
      };
    });
  }

  getOrderTarget(actor: FulfillmentActor, orderId: string) {
    const key = requireEncryptionKey(this.#key);
    const wallet = normalizedWallet(actor.walletAddress);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<TargetRow & {
        buyer: string;
        merchant: string;
        merchant_id: string;
        replacement_merchant_id: string | null;
        replacement_wallet: string | null;
      }>(
        `SELECT target.*, orders.buyer_wallet AS buyer, orders.merchant_wallet AS merchant,
           orders.merchant_id, assignment.replacement_merchant_id, assignment.replacement_wallet
         FROM core.orders orders
         JOIN core.fulfillment_targets target
           ON lower(target.target_hash) = lower(orders.fulfillment_target_hash)
         LEFT JOIN core.takeover_cases takeover ON takeover.order_id = orders.order_id
         LEFT JOIN LATERAL (
           SELECT replacement_merchant_id, replacement_wallet
           FROM core.takeover_assignments current_assignment
           WHERE current_assignment.case_id = takeover.case_id
           ORDER BY assignment_version DESC LIMIT 1
         ) assignment ON true
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
        && (
          target.replacement_merchant_id === null
          || actor.merchantId !== target.replacement_merchant_id
          || wallet !== target.replacement_wallet
        )
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
    businessHours: store.business_hours,
    imageAssetIds: storeImageIds(store.image_asset_ids),
    status: store.status,
    version: Number(store.version),
  };
}

function managedStoreProjection(store: StoreRow) {
  const images = storeImageIds(store.image_asset_ids);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    ...storeProjection(store),
    allowedActions: [
      storeCapability('UPDATE_PROFILE', !['SUSPENDED', 'CLOSED'].includes(store.status), store.status),
      storeCapability('ACTIVATE', store.status === 'DRAFT' && store.business_hours.trim().length > 0 && images.length > 0, store.status, images.length),
      storeCapability('CLOSE', store.status !== 'CLOSED', store.status),
    ],
  };
}

function merchantOrderExportQuery(input: MerchantOrderExportInput, now: Date) {
  if ((input.from === undefined) !== (input.to === undefined)) {
    throw new CoreError('InvalidRequest', 'Merchant order export requires both from and to');
  }
  const to = input.to ?? now;
  const from = input.from ?? new Date(to.getTime() - 31 * 24 * 60 * 60 * 1_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw new CoreError('InvalidRequest', 'Merchant order export date range is invalid');
  }
  if (to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1_000) {
    throw new CoreError('InvalidRequest', 'Merchant order export range cannot exceed 31 days');
  }
  const limit = input.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new CoreError('InvalidRequest', 'Merchant order export limit must be 1-1000');
  }
  if ((input.cursorCreatedAt === undefined) !== (input.cursorOrderId === undefined)) {
    throw new CoreError('InvalidRequest', 'Merchant order export cursor is incomplete');
  }
  if (input.cursorCreatedAt && !Number.isFinite(input.cursorCreatedAt.getTime())) {
    throw new CoreError('InvalidRequest', 'Merchant order export cursor time is invalid');
  }
  if (input.cursorOrderId && (input.cursorOrderId.length < 1 || input.cursorOrderId.length > 256)) {
    throw new CoreError('InvalidRequest', 'Merchant order export cursor order is invalid');
  }
  if (input.skuId && (input.skuId.length < 1 || input.skuId.length > 256)) {
    throw new CoreError('InvalidRequest', 'Merchant order export SKU is invalid');
  }
  if (input.state && !orderProjectionStates.includes(input.state)) {
    throw new CoreError('InvalidRequest', 'Merchant order export state is invalid');
  }
  if (input.fulfillmentMode && !fulfillmentModes.includes(input.fulfillmentMode)) {
    throw new CoreError('InvalidRequest', 'Merchant order export fulfillment mode is invalid');
  }
  if (input.orderKind && !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(input.orderKind)) {
    throw new CoreError('InvalidRequest', 'Merchant order export kind is invalid');
  }
  return { ...input, from, to, limit };
}

function exportQueryProjection(query: ReturnType<typeof merchantOrderExportQuery>) {
  return {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    skuId: query.skuId ?? null,
    state: query.state ?? null,
    fulfillmentMode: query.fulfillmentMode ?? null,
    orderKind: query.orderKind ?? null,
    cursorCreatedAt: query.cursorCreatedAt?.toISOString() ?? null,
    cursorOrderId: query.cursorOrderId ?? null,
    limit: query.limit,
  };
}

function merchantOrderExportRow(row: MerchantOrderExportRow, key: Buffer) {
  if (row.order_fulfillment_mode !== row.fulfillment_mode) {
    throw new CoreError('UnknownState', 'Order fulfillment target mode changed', 409);
  }
  const target = decrypt(row, key);
  const delivery = row.fulfillment_mode === 'DELIVERY';
  const trackingNumber = row.waybill_tracking && row.waybill_iv && row.waybill_tag
    ? decryptTrackingText(row.waybill_tracking, row.waybill_iv, row.waybill_tag, key)
    : row.manual_tracking && row.manual_tracking_iv && row.manual_tracking_tag
      ? decryptTrackingText(row.manual_tracking, row.manual_tracking_iv, row.manual_tracking_tag, key)
      : null;
  if (delivery && row.shipment_tracking_hash && !trackingNumber) {
    throw new CoreError('UnknownState', 'Shipment tracking number is unavailable for export', 409);
  }
  return {
    orderId: row.order_id,
    paymentTxHash: row.payment_tx_hash ?? '',
    consignee: payloadText(target, delivery ? 'recipientName' : 'name'),
    phone: payloadText(target, 'phone'),
    fullAddress: payloadText(target, 'address'),
    quantity: String(row.quantity),
    orderedAt: row.order_created_at.toISOString(),
    trackingNumber: delivery ? trackingNumber ?? '' : '',
    verificationStatus: delivery ? 'NOT_APPLICABLE' : row.pickup_verified_at ? 'VERIFIED' : 'PENDING_PICKUP',
  };
}

const merchantOrderExportColumns = [
  ['orderId', '订单号'],
  ['paymentTxHash', '支付TxHash'],
  ['consignee', '收货人'],
  ['phone', '电话'],
  ['fullAddress', '完整地址'],
  ['quantity', '数量'],
  ['orderedAt', '下单时间'],
  ['trackingNumber', '物流单号'],
  ['verificationStatus', '核销状态'],
] as const;

function merchantOrderExcel(rows: Array<ReturnType<typeof merchantOrderExportRow>>) {
  const rowXml = [
    merchantOrderExportColumns.map(([, label]) => excelCell(label)),
    ...rows.map((row) => merchantOrderExportColumns.map(([key]) => excelCell(row[key]))),
  ].map((cells) => `<Row>${cells.join('')}</Row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Merchant Orders">` +
    `<Table>${rowXml}</Table></Worksheet></Workbook>`;
}

function excelCell(value: string) {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `<Cell><Data ss:Type="String">${xmlEscape(guarded)}</Data></Cell>`;
}

function xmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function payloadText(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoreError('UnknownState', `Fulfillment target ${key} is unavailable`, 409);
  }
  return value;
}

function decryptTrackingText(ciphertext: Uint8Array, iv: Uint8Array, tag: Uint8Array, key: Buffer) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]).toString('utf8');
  } catch {
    throw new CoreError('ExternalBlocked', 'Tracking number decryption failed', 503);
  }
}

function storeCapability(
  action: 'UPDATE_PROFILE' | 'ACTIVATE' | 'CLOSE',
  enabled: boolean,
  status: StoreRow['status'],
  imageCount = 0,
) {
  if (enabled) return { action, enabled: true as const };
  const reasonCode = action === 'ACTIVATE' && status === 'DRAFT' && imageCount === 0
    ? 'STORE_PROFILE_INCOMPLETE'
    : status === 'SUSPENDED'
      ? 'STORE_SUSPENDED'
      : status === 'CLOSED'
        ? 'STORE_CLOSED'
        : 'STORE_STATE_MISMATCH';
  return { action, enabled: false as const, reasonCode };
}

function storeImageIds(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CoreError('UnknownState', 'Store image projection is invalid', 409);
  }
  return value as string[];
}

function storeCreatePayload(input: StoreInput) {
  return {
    name: input.name.trim(),
    phone: input.phone,
    businessHours: input.businessHours.trim(),
    longitude: input.longitude,
    latitude: input.latitude,
  };
}

function storeProfilePayload(input: StoreProfileInput) {
  return {
    name: input.name.trim(),
    phone: input.phone,
    businessHours: input.businessHours.trim(),
    imageAssetIds: input.imageAssetIds,
    expectedVersion: input.expectedVersion,
  };
}

async function requireMerchantStoreScope(executor: SqlExecutor, actor: FulfillmentActor, approved = false) {
  const wallet = normalizedWallet(actor.walletAddress);
  const result = await executor.query<{ merchant_id: string; status: string }>(
    `SELECT merchant.merchant_id, merchant.status
     FROM core.wallet_role_bindings binding
     JOIN core.merchants merchant ON merchant.merchant_id = binding.merchant_id
     WHERE lower(binding.wallet_address) = $1 AND binding.role = 'MERCHANT'
       AND binding.status = 'ACTIVE' AND binding.merchant_id = $2`,
    [wallet, actor.merchantId],
  );
  const row = result.rows[0];
  if (!row || row.merchant_id !== actor.merchantId) {
    throw new CoreError('Forbidden', 'Merchant store scope is unavailable', 403);
  }
  if (approved && row.status !== 'APPROVED') {
    throw new CoreError('Forbidden', 'Merchant must be approved to activate pickup stores', 403);
  }
}

async function requiredStore(executor: SqlExecutor, storeId: string, write = false) {
  const result = await executor.query<StoreRow>(
    `SELECT * FROM core.merchant_stores WHERE store_id = $1${write ? ' FOR UPDATE' : ''}`,
    [storeId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Merchant store was not found', 404);
  return result.rows[0];
}

async function requiredMerchantStore(executor: SqlExecutor, storeId: string, merchantId: string, write = false) {
  const store = await requiredStore(executor, storeId, write);
  if (store.merchant_id !== merchantId) throw new CoreError('Forbidden', 'Store is outside the merchant scope', 403);
  return store;
}

function assertExpectedStoreVersion(store: StoreRow, expectedVersion: number) {
  if (Number(store.version) !== expectedVersion) {
    throw new CoreError('IdempotencyConflict', 'Store version changed; reload before retrying', 409);
  }
}

async function verifyStoreImages(executor: SqlExecutor, store: StoreRow, wallet: string, assetIds: string[]) {
  if (assetIds.length > 5 || new Set(assetIds.map((value) => value.toLowerCase())).size !== assetIds.length) {
    throw new CoreError('InvalidRequest', 'Store image assets must contain at most five unique items');
  }
  if (assetIds.some((assetId) => !/^0x[0-9a-fA-F]{64}$/.test(assetId))) {
    throw new CoreError('InvalidRequest', 'Store image asset ID is invalid');
  }
  if (store.status === 'ACTIVE' && assetIds.length === 0) {
    throw new CoreError('InvalidRequest', 'An active store must retain at least one image');
  }
  if (assetIds.length === 0) return;
  const result = await executor.query<{ asset_id: string }>(
    `SELECT asset_id FROM core.media_assets
     WHERE asset_id = ANY($1::text[]) AND owner_wallet = $2
       AND purpose = 'STORE_IMAGE' AND resource_type = 'STORE' AND resource_id = $3`,
    [assetIds, wallet, store.store_id],
  );
  if (result.rows.length !== assetIds.length) {
    throw new CoreError('InvalidRequest', 'Store images are not verified for this store and wallet', 409);
  }
}

async function lockStoreCommand(executor: SqlExecutor, wallet: string, idempotencyKey: string) {
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`merchant-store:${wallet}:${idempotencyKey}`],
  );
}

async function loadStoreCommand(
  executor: SqlExecutor,
  wallet: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const result = await executor.query<StoreCommandRow>(
    `SELECT request_hash, result FROM core.merchant_store_commands
     WHERE actor_wallet = $1 AND idempotency_key = $2`,
    [wallet, idempotencyKey],
  );
  const command = result.rows[0];
  if (command && command.request_hash !== requestHash) {
    throw new CoreError('IdempotencyConflict', 'Store command key was reused with different input', 409);
  }
  return command;
}

async function insertStoreCommand(executor: SqlExecutor, input: {
  commandId: string;
  storeId: string;
  merchantId: string;
  wallet: string;
  commandType: 'CREATE' | 'UPDATE_PROFILE' | 'ACTIVATE' | 'CLOSE';
  idempotencyKey: string;
  requestHash: string;
  result: ReturnType<typeof managedStoreProjection>;
  now: Date;
}) {
  await executor.query(
    `INSERT INTO core.merchant_store_commands (
       command_id, store_id, merchant_id, actor_wallet, command_type,
       idempotency_key, request_hash, result, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.commandId,
      input.storeId,
      input.merchantId,
      input.wallet,
      input.commandType,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(input.result),
      input.now,
    ],
  );
}

async function insertStoreVersion(
  executor: SqlExecutor,
  store: StoreRow,
  commandId: string,
  wallet: string,
  now: Date,
) {
  await executor.query(
    `INSERT INTO core.merchant_store_versions (
       store_id, version, command_id, name, business_hours, image_asset_ids,
       phone, status, actor_wallet, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      store.store_id,
      Number(store.version),
      commandId,
      store.name,
      store.business_hours,
      JSON.stringify(storeImageIds(store.image_asset_ids)),
      store.phone,
      store.status,
      wallet,
      now,
    ],
  );
}

async function enqueueStoreAudit(executor: SqlExecutor, input: {
  eventType: string;
  store: StoreRow;
  wallet: string;
  correlationId: string;
  requestHash: string;
  commandId: string;
  now: Date;
}) {
  const evidenceHash = hashJson({ wallet: input.wallet, merchantId: input.store.merchant_id, checkedAt: input.now.toISOString() });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:merchant-store', {
      eventType: input.eventType,
      resourceId: input.store.store_id,
      requestHash: input.requestHash,
    }),
    streamName: 'operational',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: 'MERCHANT_STORE',
    resourceId: input.store.store_id,
    actorWallet: input.wallet,
    actorRole: 'MERCHANT',
    merchantId: input.store.merchant_id,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: {
      commandId: input.commandId,
      version: Number(input.store.version),
      status: input.store.status,
      regionCode: input.store.region_code,
      imageCount: storeImageIds(input.store.image_asset_ids).length,
    },
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.wallet,
      roles: ['MERCHANT'],
      evidenceHash,
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
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
  if (
    input.name.trim().length < 1
    || input.name.length > 100
    || !/^[+]?[0-9-]{7,20}$/.test(input.phone)
    || input.businessHours.trim().length < 1
    || input.businessHours.length > 240
  ) {
    throw new CoreError('InvalidRequest', 'Invalid store input');
  }
  validateCoordinates(input.longitude, input.latitude);
}

function validateStoreProfileInput(input: StoreProfileInput) {
  validateIdempotencyKey(input.idempotencyKey);
  if (
    input.name.trim().length < 1
    || input.name.length > 100
    || !/^[+]?[0-9-]{7,20}$/.test(input.phone)
    || input.businessHours.trim().length < 1
    || input.businessHours.length > 240
    || !Array.isArray(input.imageAssetIds)
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 1
  ) throw new CoreError('InvalidRequest', 'Invalid store profile input');
}

function validateStoreVersionInput(input: StoreVersionInput) {
  validateIdempotencyKey(input.idempotencyKey);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CoreError('InvalidRequest', 'Invalid expected store version');
  }
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

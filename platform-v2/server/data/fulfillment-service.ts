import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { orderAllowedActions, type OrderProjection } from '../api/allowed-actions.ts';
import { CoreError } from '../api/errors.ts';
import {
  breakerScopes,
  executableOrderActionNames,
  fulfillmentModes,
  orderProjectionStates,
  type AllowedActionName,
  type BreakerScope,
  type OrderFinalityStatus,
  type OrderState,
  type UserRole,
} from '../api/enums.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { captureMerchantFutureProceeds } from './takeover-funding-service.ts';
import {
  assertTrackingEvidenceRecord,
  createTrackingEvidenceDecryptor,
  type Carrier,
} from './evidence-service.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PICKUP_ATTEMPTS = 5;

export interface FulfillmentActor {
  walletAddress: string;
  roles: readonly UserRole[];
  merchantId?: string;
}

export interface PickupReceiptEnqueuer {
  (
    executor: SqlExecutor,
    input: { orderId: string; merchantId: string; storeId: string; quantity: string; fulfilledAt: Date },
  ): Promise<unknown>;
}

export interface FulfillmentCommandInput {
  idempotencyKey: string;
  evidenceHash: string;
}

export interface ShipmentInput extends FulfillmentCommandInput {
  carrierCode: string;
  trackingNumberHash: string;
  providerReferenceHash?: string;
}

export interface ShipmentBatchItem extends ShipmentInput {
  orderId: string;
  carrierCode: Carrier;
}

export interface ShipmentBatchInput {
  idempotencyKey: string;
  items: ShipmentBatchItem[];
}

export type OrderKind = 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';

export interface OrderPageQuery {
  cursorCreatedAt?: Date;
  cursorOrderId?: string;
  limit?: number;
  from?: Date;
  to?: Date;
  skuId?: string;
  state?: OrderState;
  fulfillmentMode?: 'DELIVERY' | 'PICKUP';
  orderKind?: OrderKind;
  orderId?: string;
  productId?: string;
  txHash?: string;
  wallet?: string;
  pendingProductReview?: boolean;
  breakerScope?: BreakerScope;
}

export interface LogisticsUpdateInput extends FulfillmentCommandInput {
  provider: 'KUAIDI100' | 'CAINIAO';
  providerEventIdHash: string;
  status: 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'EXCEPTION';
  occurredAt: Date;
  locationHash?: string;
}

export interface PickupCredentialInput extends FulfillmentCommandInput {
  code: string;
  expiresAt: Date;
}

export interface PickupVerificationInput extends FulfillmentCommandInput {
  code: string;
  storeId: string;
}

export interface RequestInput extends FulfillmentCommandInput {
  reasonCode: string;
}

export interface DecisionInput extends FulfillmentCommandInput {
  approved: boolean;
  noteCode: string;
}

export interface FulfillmentRequestDecisionInput extends DecisionInput {
  requestId: string;
}

export interface ArbitrationDecisionInput extends FulfillmentCommandInput {
  outcome: 'FULFILL' | 'RESUME_FULFILLMENT';
  noteCode: string;
}

interface OrderRow {
  order_id: string;
  artifact_version: string;
  policy_version: string | number;
  buyer_wallet: string;
  merchant_id: string;
  merchant_wallet: string;
  product_id: string;
  sku_id: string;
  quantity: string | number;
  fulfillment_mode: 'DELIVERY' | 'PICKUP';
  fulfillment_target_hash: string;
  state: OrderState;
  finality_status: OrderFinalityStatus;
  paid_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  fulfilled_at: Date | null;
  takeover_opened_at: Date | null;
  arbitration_opened_at: Date | null;
  exact_amounts: Record<string, unknown>;
  seckill_snapshot: Record<string, unknown> | null;
  payment_tx_hash: string | null;
  created_at: Date;
  quote_kind: 'ORDINARY' | 'SECKILL' | null;
  payment_finalized_at: Date | null;
}

interface OrderPageRow extends OrderRow {
  requests: unknown;
  shipments: unknown;
  logistics: unknown;
  balances: unknown;
  shipment_evidence: boolean;
  takeover_opened: boolean;
  open_request_types: Array<'EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT'>;
  active_pickup_credential: boolean;
  approved_exchange: boolean;
}

interface ExistingCommandRow {
  command_id: string;
  order_id: string;
  command_type: string;
  content_hash: string;
  result: Record<string, unknown>;
}

interface LedgerStateRow {
  account_id: string;
  asset: 'USDT' | 'NPL' | 'BNM_POINTS';
  amount: string;
  purpose: string;
  backing_wallet_address: string | null;
}

type CommandType =
  | 'RECORD_SHIPMENT'
  | 'RECORD_LOGISTICS_UPDATE'
  | 'RECORD_DELIVERY'
  | 'REGISTER_PICKUP_CREDENTIAL'
  | 'VERIFY_PICKUP'
  | 'REQUEST_EXCHANGE'
  | 'REQUEST_DELAY'
  | 'DECIDE_FULFILLMENT_REQUEST'
  | 'OPEN_ARBITRATION'
  | 'DECIDE_ARBITRATION'
  | 'OPEN_TAKEOVER'
  | 'REQUEST_FORCED_RECEIPT'
  | 'DECIDE_FORCED_RECEIPT'
  | 'CONFIRM_RECEIPT';

export class FulfillmentService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;
  readonly #executableActions: ReadonlySet<AllowedActionName>;
  readonly #enqueuePickupReceipt: PickupReceiptEnqueuer | undefined;
  readonly #decryptTracking: ReturnType<typeof createTrackingEvidenceDecryptor> | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    clock?: () => Date;
    executableActions?: Iterable<AllowedActionName>;
    enqueuePickupReceipt?: PickupReceiptEnqueuer;
    trackingEncryptionKey?: string;
  }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
    this.#executableActions = new Set(input.executableActions ?? executableOrderActionNames);
    this.#enqueuePickupReceipt = input.enqueuePickupReceipt;
    this.#decryptTracking = input.trackingEncryptionKey
      ? createTrackingEvidenceDecryptor(input.trackingEncryptionKey)
      : undefined;
  }

  getOrder(actor: FulfillmentActor, orderId: string) {
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      const order = await loadOrder(executor, orderId);
      await assertCanRead(executor, currentActor, order);
      const pausedScopes = await loadPausedScopes(executor);
      return orderProjection(
        executor,
        order,
        await allowedActionsForOrder(executor, order, currentActor, this.#clock(), pausedScopes, this.#executableActions),
        this.#decryptTracking,
      );
    });
  }

  listOrders(actor: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      const privileged = hasRole(currentActor, 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR');
      const result = await executor.query<{ order_id: string }>(
        privileged
          ? 'SELECT order_id FROM core.orders ORDER BY created_at DESC, order_id'
          : `SELECT order_id FROM core.orders
             WHERE buyer_wallet = $1 OR merchant_wallet = $1 OR merchant_id = $2
             ORDER BY created_at DESC, order_id`,
        privileged ? [] : [normalizedWallet(currentActor.walletAddress), currentActor.merchantId ?? ''],
      );
      const orders = [];
      for (const row of result.rows) {
        const order = await loadOrder(executor, row.order_id);
        await assertCanRead(executor, currentActor, order);
        orders.push(await orderProjection(executor, order, [], this.#decryptTracking));
      }
      return orders;
    });
  }

  listOrderPage(actor: FulfillmentActor, input: OrderPageQuery = {}) {
    const query = orderPageQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      const now = this.#clock();
      const { sql, params } = orderPageSql(currentActor, query, now);
      const result = await executor.query<OrderPageRow>(sql, params);
      const pageRows = result.rows.slice(0, query.limit);
      const pausedScopes = await loadPausedScopes(executor);
      const orders = [];
      for (const row of pageRows) {
        const order = normalizeOrderDates(row);
        await assertCanRead(executor, currentActor, order);
        orders.push(orderPageProjection(
          order,
          allowedActionsFromState(order, order, currentActor, now, pausedScopes, this.#executableActions),
          this.#decryptTracking,
        ));
      }
      const last = pageRows.at(-1);
      return {
        orders,
        nextCursor: result.rows.length > query.limit && last
          ? { createdAt: new Date(last.created_at).toISOString(), orderId: last.order_id }
          : null,
      };
    });
  }

  searchAdminOrders(actor: FulfillmentActor, input: OrderPageQuery = {}) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    const query = orderPageQuery(input);
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      assertRole(currentActor, 'ADMIN', 'OPERATOR', 'AUDITOR');
      const now = this.#clock();
      const { sql, params } = orderPageSql(currentActor, query, now);
      const result = await executor.query<OrderPageRow>(sql, params);
      const pageRows = result.rows.slice(0, query.limit);
      const pausedScopes = await loadPausedScopes(executor);
      const orders = [];
      for (const row of pageRows) {
        const order = normalizeOrderDates(row);
        await assertCanRead(executor, currentActor, order);
        orders.push(orderPageProjection(
          order,
          allowedActionsFromState(order, order, currentActor, now, pausedScopes, this.#executableActions),
          this.#decryptTracking,
        ));
      }
      const last = pageRows.at(-1);
      return {
        orders,
        nextCursor: result.rows.length > query.limit && last
          ? { createdAt: new Date(last.created_at).toISOString(), orderId: last.order_id }
          : null,
        pausedScopes: [...pausedScopes].sort(),
        breaker: query.breakerScope
          ? { scope: query.breakerScope, active: pausedScopes.has(query.breakerScope) }
          : null,
        pendingProductReview: query.pendingProductReview ?? null,
      };
    });
  }

  previewOrderBatchActions(actor: FulfillmentActor, orderIds: string[]) {
    assertRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > 100) {
      throw new CoreError('InvalidRequest', 'Order action preview requires 1-100 orders');
    }
    if (orderIds.some((orderId) => orderId.length < 1 || orderId.length > 256)) {
      throw new CoreError('InvalidRequest', 'Order action preview contains an invalid order ID');
    }
    if (new Set(orderIds).size !== orderIds.length) {
      throw new CoreError('InvalidRequest', 'Order action preview contains duplicate orders');
    }
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      const now = this.#clock();
      const pausedScopes = await loadPausedScopes(executor);
      const rows: Array<{
        orderId: string;
        allowedActions: ReturnType<typeof orderAllowedActions>;
      }> = [];
      for (const orderId of [...orderIds].sort()) {
        const order = await loadOrder(executor, orderId);
        await assertCanRead(executor, currentActor, order);
        rows.push({
          orderId,
          allowedActions: await allowedActionsForOrder(
            executor,
            order,
            currentActor,
            now,
            pausedScopes,
            this.#executableActions,
          ),
        });
      }
      let intersection: Set<AllowedActionName> | undefined;
      for (const row of rows) {
        const enabled = new Set(row.allowedActions.filter((action) => action.enabled).map((action) => action.action));
        intersection = intersection === undefined
          ? enabled
          : new Set([...intersection].filter((action) => enabled.has(action)));
      }
      return {
        rows: orderIds.map((orderId) => rows.find((row) => row.orderId === orderId)!),
        enabledActionIntersection: [...(intersection ?? new Set())].sort(),
      };
    });
  }

  recordShipment(actor: FulfillmentActor, orderId: string, input: ShipmentInput) {
    validateShipment(input);
    return this.#command(actor, orderId, 'RECORD_SHIPMENT', input, (
      executor,
      order,
      command,
      currentActor,
    ) => recordShipmentCommand(executor, currentActor, order, input, command));
  }

  recordShipmentBatch(actor: FulfillmentActor, input: ShipmentBatchInput) {
    validateIdempotencyKey(input.idempotencyKey);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      throw new CoreError('InvalidRequest', 'Shipment batch must contain 1-100 items');
    }
    for (const item of input.items) {
      if (item.orderId.length < 1 || item.orderId.length > 256) {
        throw new CoreError('InvalidRequest', 'Shipment batch order ID is invalid');
      }
      validateShipment(item);
    }
    if (new Set(input.items.map((item) => item.orderId)).size !== input.items.length) {
      throw new CoreError('InvalidRequest', 'Shipment batch contains duplicate orders');
    }
    if (new Set(input.items.map((item) => item.idempotencyKey)).size !== input.items.length) {
      throw new CoreError('InvalidRequest', 'Shipment batch contains duplicate item idempotency keys');
    }
    const wallet = normalizedWallet(actor.walletAddress);
    const requestHash = hashJson({ type: 'RECORD_SHIPMENT_BATCH', input });
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      await executor.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`fulfillment-shipment-batch:${wallet}:${input.idempotencyKey}`],
      );
      const prior = await executor.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash, result FROM core.fulfillment_shipment_batches
         WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Shipment batch idempotency key was reused with different input', 409);
        }
        return prior.rows[0].result;
      }
      for (const idempotencyKey of input.items.map((item) => item.idempotencyKey).sort()) {
        await lockFulfillmentIdempotency(executor, wallet, idempotencyKey);
      }
      const results = new Map<string, Record<string, unknown>>();
      for (const item of [...input.items].sort((left, right) => left.orderId.localeCompare(right.orderId))) {
        const contentHash = hashJson({ orderId: item.orderId, type: 'RECORD_SHIPMENT', payload: shipmentPayload(item) });
        const existing = await executor.query<ExistingCommandRow>(
          `SELECT command_id, order_id, command_type, content_hash, result
           FROM core.fulfillment_commands WHERE actor_wallet = $1 AND idempotency_key = $2`,
          [wallet, item.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].order_id !== item.orderId
            || existing.rows[0].command_type !== 'RECORD_SHIPMENT'
            || existing.rows[0].content_hash !== contentHash
          ) throw new CoreError('IdempotencyConflict', 'Shipment item idempotency key was reused with different input', 409);
          results.set(item.orderId, existing.rows[0].result);
          continue;
        }
        const order = await loadOrder(executor, item.orderId, true);
        await assertTrackingEvidenceRecord(executor, currentActor, {
          orderId: item.orderId,
          carrierCode: item.carrierCode,
          trackingNumberHash: item.trackingNumberHash,
          evidenceHash: item.evidenceHash,
        });
        results.set(item.orderId, await recordShipmentCommand(executor, currentActor, order, item, {
          id: `command:${randomUUID()}`,
          actor: wallet,
          type: 'RECORD_SHIPMENT',
          idempotencyKey: item.idempotencyKey,
          contentHash,
          now: this.#clock(),
        }));
      }
      const batchId = `0x${randomBytes(32).toString('hex')}`;
      const result = {
        batchId,
        shipments: input.items.map((item) => results.get(item.orderId)!),
        createdAt: this.#clock().toISOString(),
      };
      await executor.query(
        `INSERT INTO core.fulfillment_shipment_batches (
           batch_id, actor_wallet, idempotency_key, request_hash, item_count, result, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [batchId, wallet, input.idempotencyKey, requestHash, input.items.length, JSON.stringify(result), result.createdAt],
      );
      return result;
    });
  }

  recordDelivery(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput) {
    validateCommand(input);
    return this.#command(actor, orderId, 'RECORD_DELIVERY', input, async (executor, order, command, currentActor) => {
      assertRole(currentActor, 'OPERATOR', 'ADMIN');
      assertFinalPayment(order);
      if (order.state !== 'SHIPPED') throw new CoreError('UnknownState', 'Delivery requires a shipped order', 409);
      const evidenceId = `evidence:${randomUUID()}`;
      const result = { orderId, state: 'DELIVERED', deliveredAt: command.now.toISOString() };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'DELIVERY',
        hash: input.evidenceHash,
        source: 'LOGISTICS_OR_OPERATOR',
        payload: {},
        actor: command.actor,
        at: command.now,
      });
      await transitionOrder(executor, order, command, evidenceId, 'DELIVERED');
      await executor.query(
        `UPDATE core.orders SET state = 'DELIVERED', delivered_at = $2, updated_at = clock_timestamp()
         WHERE order_id = $1 AND state = 'SHIPPED'`,
        [orderId, command.now],
      );
      await outbox(executor, orderId, command.id, 'DeliveryRecorded', result);
      return result;
    });
  }

  recordLogisticsUpdate(actor: FulfillmentActor, orderId: string, input: LogisticsUpdateInput) {
    validateCommand(input);
    if (
      !isHash(input.providerEventIdHash)
      || (input.locationHash !== undefined && !isHash(input.locationHash))
      || !Number.isFinite(input.occurredAt.getTime())
      || input.occurredAt.getTime() > this.#clock().getTime() + 5 * 60_000
    ) throw new CoreError('InvalidRequest', 'Invalid logistics update');
    return this.#command(actor, orderId, 'RECORD_LOGISTICS_UPDATE', input, async (executor, order, command, currentActor) => {
      assertRole(currentActor, 'OPERATOR', 'ADMIN');
      assertFinalPayment(order);
      if (order.fulfillment_mode !== 'DELIVERY' || !['SHIPPED', 'DELIVERED'].includes(order.state)) {
        throw new CoreError('UnknownState', 'Logistics update requires a shipped delivery order', 409);
      }
      const evidenceId = `evidence:${randomUUID()}`;
      const logisticsEventId = `logistics:${randomUUID()}`;
      const nextState = input.status === 'DELIVERED' ? 'DELIVERED' : order.state;
      const result = {
        orderId,
        logisticsEventId,
        provider: input.provider,
        status: input.status,
        state: nextState,
        occurredAt: input.occurredAt.toISOString(),
      };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'LOGISTICS_UPDATE',
        hash: input.evidenceHash,
        source: input.provider,
        providerReferenceHash: input.providerEventIdHash,
        payload: {
          status: input.status,
          occurredAt: input.occurredAt.toISOString(),
          ...(input.locationHash ? { locationHash: input.locationHash.toLowerCase() } : {}),
        },
        actor: command.actor,
        at: command.now,
      });
      await executor.query(
        `INSERT INTO core.logistics_events (
           logistics_event_id, order_id, command_id, provider, provider_event_id_hash,
           status, location_hash, evidence_id, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          logisticsEventId,
          orderId,
          command.id,
          input.provider,
          input.providerEventIdHash.toLowerCase(),
          input.status,
          input.locationHash?.toLowerCase() ?? null,
          evidenceId,
          input.occurredAt,
        ],
      );
      if (input.status === 'DELIVERED' && order.state === 'SHIPPED') {
        await transitionOrder(executor, order, command, evidenceId, 'DELIVERED');
        await executor.query(
          `UPDATE core.orders SET state = 'DELIVERED', delivered_at = $2,
             updated_at = clock_timestamp() WHERE order_id = $1 AND state = 'SHIPPED'`,
          [orderId, input.occurredAt],
        );
      }
      await outbox(executor, orderId, command.id, 'LogisticsUpdated', result);
      return result;
    });
  }

  registerPickupCredential(actor: FulfillmentActor, orderId: string, input: PickupCredentialInput) {
    validateCommand(input);
    if (!/^\d{6}$/.test(input.code) || !Number.isFinite(input.expiresAt.getTime())) {
      throw new CoreError('InvalidRequest', 'Pickup credential must be a six-digit code with an expiry');
    }
    return this.#command(
      actor,
      orderId,
      'REGISTER_PICKUP_CREDENTIAL',
      { ...input, code: sha256(input.code) },
      async (executor, order, command, currentActor) => {
        assertBuyer(currentActor, order);
        assertFinalPayment(order);
        if (order.fulfillment_mode !== 'PICKUP' || order.state !== 'PAID') {
          throw new CoreError('UnknownState', 'Pickup credential requires a paid pickup order', 409);
        }
        if (input.expiresAt <= command.now || input.expiresAt.getTime() > command.now.getTime() + SEVEN_DAYS_MS) {
          throw new CoreError('InvalidRequest', 'Pickup credential expiry is outside the allowed window');
        }
        await executor.query(
          `UPDATE core.pickup_credentials SET invalidated_at = $2
           WHERE order_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at <= $2`,
          [orderId, command.now],
        );
        const existing = await executor.query(
          `SELECT credential_id FROM core.pickup_credentials
           WHERE order_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [orderId],
        );
        if (existing.rows[0]) throw new CoreError('IdempotencyConflict', 'An active pickup credential already exists', 409);
        const storeId = await pickupStoreId(executor, order);
        const credentialId = `pickup:${randomUUID()}`;
        const evidenceId = `evidence:${randomUUID()}`;
        const salt = randomBytes(16).toString('hex');
        const result = { orderId, credentialId, expiresAt: input.expiresAt.toISOString() };
        await insertCommand(executor, command, result);
        await insertEvidence(executor, {
          evidenceId,
          orderId,
          type: 'PICKUP_CREDENTIAL',
          hash: input.evidenceHash,
          source: 'BUYER',
          payload: { credentialId, expiresAt: input.expiresAt.toISOString() },
          actor: command.actor,
          at: command.now,
        });
        await executor.query(
          `INSERT INTO core.pickup_credentials (
             credential_id, order_id, command_id, store_id, code_hash, salt,
             evidence_id, expires_at, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [credentialId, orderId, command.id, storeId, pickupCodeHash(input.code, salt), salt, evidenceId, input.expiresAt, command.now],
        );
        return result;
      },
    );
  }

  async verifyPickup(actor: FulfillmentActor, orderId: string, input: PickupVerificationInput) {
    validateCommand(input);
    if (!/^\d{6}$/.test(input.code)) throw new CoreError('InvalidRequest', 'Pickup code must contain six digits');
    if (!input.storeId || input.storeId.length > 128) throw new CoreError('InvalidRequest', 'storeId is invalid');
    const result = await this.#command(
      actor,
      orderId,
      'VERIFY_PICKUP',
      { ...input, code: sha256(input.code) },
      async (executor, order, command, currentActor) => {
        assertMerchantOrOperator(currentActor, order);
        assertFinalPayment(order);
        if (order.fulfillment_mode !== 'PICKUP' || order.state !== 'PAID') {
          throw new CoreError('UnknownState', 'Pickup verification requires a paid pickup order', 409);
        }
        const expectedStoreId = await pickupStoreId(executor, order);
        const credentials = await executor.query<{
          credential_id: string;
          store_id: string;
          code_hash: string;
          salt: string;
          expires_at: Date;
          failed_attempts: number;
        }>(
          `SELECT credential_id, store_id, code_hash, salt, expires_at, failed_attempts
           FROM core.pickup_credentials
           WHERE order_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL FOR UPDATE`,
          [orderId],
        );
        const credential = credentials.rows[0];
        const expired = Boolean(credential && new Date(credential.expires_at) <= command.now);
        const storeMismatch = input.storeId !== expectedStoreId || Boolean(credential && credential.store_id !== expectedStoreId);
        const codeMismatch = !credential || pickupCodeHash(input.code, credential.salt) !== credential.code_hash;
        if (!credential || expired || storeMismatch || codeMismatch) {
          const failedAttempts = credential ? credential.failed_attempts + 1 : MAX_PICKUP_ATTEMPTS;
          const invalidated = !credential || expired || failedAttempts >= MAX_PICKUP_ATTEMPTS;
          const failure = {
            orderId,
            verified: false,
            errorCode: 'PickupCredentialInvalid',
            remainingAttempts: Math.max(0, MAX_PICKUP_ATTEMPTS - failedAttempts),
            credentialInvalidated: invalidated,
          };
          await insertCommand(executor, command, failure);
          if (credential) {
            await executor.query(
              `UPDATE core.pickup_credentials SET failed_attempts = $2, last_failed_at = $3,
                 invalidated_at = CASE WHEN $4 THEN $3 ELSE invalidated_at END
               WHERE credential_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
              [credential.credential_id, Math.min(failedAttempts, MAX_PICKUP_ATTEMPTS), command.now, invalidated],
            );
          }
          await insertPickupAttempt(executor, {
            orderId,
            ...(credential ? { credentialId: credential.credential_id } : {}),
            commandId: command.id,
            actor: command.actor,
            storeId: input.storeId,
            evidenceHash: input.evidenceHash,
            successful: false,
            errorCode: 'PickupCredentialInvalid',
            at: command.now,
          });
          return failure;
        }
        const evidenceId = `evidence:${randomUUID()}`;
        const result = await completeOrder(executor, order, command, evidenceId, input.evidenceHash, 'PICKUP_VERIFICATION');
        await executor.query(
          `UPDATE core.pickup_credentials SET consumed_at = $2
           WHERE credential_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [credential.credential_id, command.now],
        );
        await insertPickupAttempt(executor, {
          orderId,
          credentialId: credential.credential_id,
          commandId: command.id,
          actor: command.actor,
          storeId: input.storeId,
          evidenceHash: input.evidenceHash,
          successful: true,
          at: command.now,
        });
        await this.#enqueuePickupReceipt?.(executor, {
          orderId,
          merchantId: order.merchant_id,
          storeId: input.storeId,
          quantity: String(order.quantity),
          fulfilledAt: command.now,
        });
        return result;
      },
    );
    if ('verified' in result && result.verified === false) {
      throw new CoreError('Forbidden', 'Pickup credential is invalid or expired', 403, {
        remainingAttempts: result.remainingAttempts,
        credentialInvalidated: result.credentialInvalidated,
      });
    }
    return result;
  }

  requestExchange(actor: FulfillmentActor, orderId: string, input: RequestInput) {
    return this.#request(actor, orderId, 'REQUEST_EXCHANGE', 'EXCHANGE', 'EXCHANGE_REQUEST', input);
  }

  requestDelay(actor: FulfillmentActor, orderId: string, input: RequestInput) {
    return this.#request(actor, orderId, 'REQUEST_DELAY', 'DELAY', 'DELAY_REQUEST', input);
  }

  decideFulfillmentRequest(actor: FulfillmentActor, orderId: string, input: FulfillmentRequestDecisionInput) {
    validateCommand(input);
    validateCode(input.noteCode, 'noteCode');
    if (!input.requestId) throw new CoreError('InvalidRequest', 'requestId is required');
    return this.#command(
      actor,
      orderId,
      'DECIDE_FULFILLMENT_REQUEST',
      input,
      async (executor, order, command, currentActor) => {
        assertMerchantOrOperator(currentActor, order);
        assertFinalPayment(order);
        if (!['PAID', 'SHIPPED', 'DELIVERED'].includes(order.state)) {
          throw new CoreError('UnknownState', 'Fulfillment request cannot be decided from the current order state', 409);
        }
        const request = await executor.query<{ request_id: string; request_type: 'EXCHANGE' | 'DELAY' }>(
          `SELECT request_id, request_type FROM core.fulfillment_requests
           WHERE request_id = $1 AND order_id = $2 AND state = 'OPEN' FOR UPDATE`,
          [input.requestId, orderId],
        );
        const pending = request.rows[0];
        if (!pending || !['EXCHANGE', 'DELAY'].includes(pending.request_type)) {
          throw new CoreError('UnknownState', 'Open exchange or delay request is unavailable', 409);
        }
        const evidenceId = `evidence:${randomUUID()}`;
        const state = input.approved ? 'APPROVED' : 'REJECTED';
        const result = {
          orderId,
          requestId: pending.request_id,
          requestType: pending.request_type,
          state,
          decidedAt: command.now.toISOString(),
        };
        await insertCommand(executor, command, result);
        await insertEvidence(executor, {
          evidenceId,
          orderId,
          type: 'REQUEST_DECISION',
          hash: input.evidenceHash,
          source: 'MERCHANT_OR_PLATFORM',
          payload: { requestType: pending.request_type, approved: input.approved, noteCode: input.noteCode },
          actor: command.actor,
          at: command.now,
        });
        await resolveRequest(executor, pending.request_id, evidenceId, command.actor, command.now, state);
        await outbox(executor, orderId, command.id, `${pending.request_type}RequestDecided`, result);
        return result;
      },
    );
  }

  openArbitration(actor: FulfillmentActor, orderId: string, input: RequestInput) {
    validateRequest(input);
    return this.#command(actor, orderId, 'OPEN_ARBITRATION', input, async (executor, order, command, currentActor) => {
      if (!isBuyer(currentActor, order) && !hasRole(currentActor, 'OPERATOR', 'ADMIN')) {
        throw new CoreError('Forbidden', 'Buyer or platform role is required', 403);
      }
      assertFinalPayment(order);
      if (!['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'].includes(order.state)) {
        throw new CoreError('UnknownState', 'Order cannot enter arbitration from its current state', 409);
      }
      const evidenceId = `evidence:${randomUUID()}`;
      const requestId = `request:${randomUUID()}`;
      const result = { orderId, requestId, state: 'ARBITRATION', openedAt: command.now.toISOString() };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'ARBITRATION',
        hash: input.evidenceHash,
        source: 'BUYER_OR_PLATFORM',
        payload: { reasonCode: input.reasonCode },
        actor: command.actor,
        at: command.now,
      });
      await insertRequest(executor, requestId, orderId, command, 'ARBITRATION', evidenceId);
      await moveLedgerState(executor, order, command, input.evidenceHash, 'LOCKED', 'DISPUTED', 'ARBITRATION_DISPUTED');
      await transitionOrder(executor, order, command, evidenceId, 'ARBITRATION');
      await executor.query(
        `UPDATE core.orders SET state = 'ARBITRATION', arbitration_opened_at = $2,
           updated_at = clock_timestamp() WHERE order_id = $1`,
        [orderId, command.now],
      );
      await outbox(executor, orderId, command.id, 'ArbitrationOpened', result);
      return result;
    });
  }

  decideArbitration(actor: FulfillmentActor, orderId: string, input: ArbitrationDecisionInput) {
    validateCommand(input);
    validateCode(input.noteCode, 'noteCode');
    return this.#command(actor, orderId, 'DECIDE_ARBITRATION', input, async (executor, order, command, currentActor) => {
      assertRole(currentActor, 'ARBITRATOR', 'ADMIN');
      if (order.state !== 'ARBITRATION') throw new CoreError('UnknownState', 'Order is not in arbitration', 409);
      const openRequest = await loadOpenRequest(executor, orderId, 'ARBITRATION');
      const evidenceId = `evidence:${randomUUID()}`;
      if (input.outcome === 'FULFILL') {
        const result = await completeOrder(
          executor,
          order,
          command,
          evidenceId,
          input.evidenceHash,
          'ARBITRATION',
          'DISPUTED',
        );
        await resolveRequest(executor, openRequest.request_id, evidenceId, command.actor, command.now, 'RESOLVED');
        return result;
      }
      const prior = await executor.query<{ from_state: string }>(
        `SELECT from_state FROM core.fulfillment_transitions
         WHERE order_id = $1 AND to_state = 'ARBITRATION' ORDER BY created_at DESC LIMIT 1`,
        [orderId],
      );
      const resumeState = prior.rows[0]?.from_state;
      if (!resumeState || !['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'].includes(resumeState)) {
        throw new CoreError('UnknownState', 'Arbitration resume state is unavailable', 409);
      }
      const result = { orderId, state: resumeState, outcome: input.outcome, decidedAt: command.now.toISOString() };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'ARBITRATION_DECISION',
        hash: input.evidenceHash,
        source: 'ARBITRATOR',
        payload: { outcome: input.outcome, noteCode: input.noteCode },
        actor: command.actor,
        at: command.now,
      });
      await moveLedgerState(executor, order, command, input.evidenceHash, 'DISPUTED', 'LOCKED', 'ARBITRATION_RESOLVED');
      await transitionOrder(executor, order, command, evidenceId, resumeState);
      await executor.query('UPDATE core.orders SET state = $2, updated_at = clock_timestamp() WHERE order_id = $1', [
        orderId,
        resumeState,
      ]);
      await resolveRequest(executor, openRequest.request_id, evidenceId, command.actor, command.now, 'RESOLVED');
      await outbox(executor, orderId, command.id, 'ArbitrationResolved', result);
      return result;
    });
  }

  openTakeover(actor: FulfillmentActor, orderId: string, input: RequestInput) {
    validateRequest(input);
    return this.#command(actor, orderId, 'OPEN_TAKEOVER', input, async (executor, order, command, currentActor) => {
      if (!isBuyer(currentActor, order) && !hasRole(currentActor, 'OPERATOR', 'ADMIN')) {
        throw new CoreError('Forbidden', 'Buyer or platform role is required', 403);
      }
      assertFinalPayment(order);
      if (order.fulfillment_mode === 'PICKUP') {
        throw new CoreError('PickupTakeoverDecisionBlocked', 'Pickup timeout evidence is not frozen', 409);
      }
      if (
        order.state !== 'PAID'
        || !order.payment_finalized_at
        || command.now.getTime() < order.payment_finalized_at.getTime() + SEVEN_DAYS_MS
      ) throw new CoreError('FinalityPending', 'Delivery takeover is not eligible', 409);
      const shipment = await executor.query('SELECT shipment_id FROM core.shipments WHERE order_id = $1', [orderId]);
      if (shipment.rows[0]) throw new CoreError('UnknownState', 'Valid shipment evidence already exists', 409);
      const evidenceId = `evidence:${randomUUID()}`;
      const caseId = `takeover:${randomUUID()}`;
      const result = { orderId, caseId, state: 'TAKEOVER', customerFundsRemainLocked: true };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'TAKEOVER',
        hash: input.evidenceHash,
        source: 'BUYER_OR_PLATFORM',
        payload: { reasonCode: input.reasonCode },
        actor: command.actor,
        at: command.now,
      });
      await executor.query(
        `INSERT INTO core.takeover_cases (
           case_id, order_id, merchant_id, policy_version, state, required_usdt,
           evidence_hash, opened_at
         ) VALUES ($1,$2,$3,$4,'OPEN',NULL,$5,$6)`,
        [caseId, orderId, order.merchant_id, order.policy_version, input.evidenceHash.toLowerCase(), command.now],
      );
      await insertTakeoverTransition(executor, {
        caseId,
        orderId,
        fromState: null,
        toState: 'OPEN',
        evidenceType: 'TAKEOVER_OPENED',
        evidenceHash: input.evidenceHash,
        occurredAt: command.now,
      });
      await transitionOrder(executor, order, command, evidenceId, 'TAKEOVER');
      await executor.query(
        `UPDATE core.orders SET state = 'TAKEOVER', takeover_opened_at = $2,
           updated_at = clock_timestamp() WHERE order_id = $1`,
        [orderId, command.now],
      );
      await executor.query(
        `UPDATE core.merchants SET status = 'SUSPENDED', guarantee_status = 'FROZEN',
           updated_at = clock_timestamp() WHERE merchant_id = $1`,
        [order.merchant_id],
      );
      await executor.query(
        `UPDATE core.products SET lifecycle_state = 'LOCKED', updated_at = clock_timestamp()
         WHERE merchant_id = $1 AND lifecycle_state IN ('ACTIVE', 'REVIEW')`,
        [order.merchant_id],
      );
      await outbox(executor, orderId, command.id, 'TakeoverOpened', result);
      return result;
    });
  }

  requestForcedReceipt(actor: FulfillmentActor, orderId: string, input: RequestInput) {
    validateRequest(input);
    return this.#command(actor, orderId, 'REQUEST_FORCED_RECEIPT', input, async (executor, order, command, currentActor) => {
      assertMerchant(currentActor, order);
      assertFinalPayment(order);
      if (
        order.state !== 'DELIVERED'
        || !order.delivered_at
        || command.now.getTime() < order.delivered_at.getTime() + SEVEN_DAYS_MS
      ) throw new CoreError('FinalityPending', 'Forced receipt review is not eligible', 409);
      const evidenceId = `evidence:${randomUUID()}`;
      const requestId = `request:${randomUUID()}`;
      const result = { orderId, requestId, state: 'OPEN', platformReviewRequired: true, canFinalizeDirectly: false };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'FORCED_RECEIPT_REQUEST',
        hash: input.evidenceHash,
        source: 'MERCHANT',
        payload: { reasonCode: input.reasonCode },
        actor: command.actor,
        at: command.now,
      });
      await insertRequest(executor, requestId, orderId, command, 'FORCED_RECEIPT', evidenceId);
      await outbox(executor, orderId, command.id, 'ForcedReceiptRequested', result);
      return result;
    });
  }

  decideForcedReceipt(actor: FulfillmentActor, orderId: string, input: DecisionInput) {
    validateCommand(input);
    validateCode(input.noteCode, 'noteCode');
    return this.#command(actor, orderId, 'DECIDE_FORCED_RECEIPT', input, async (executor, order, command, currentActor) => {
      assertRole(currentActor, 'OPERATOR', 'ADMIN');
      if (order.state !== 'DELIVERED') throw new CoreError('UnknownState', 'Order is not delivered', 409);
      const openRequest = await loadOpenRequest(executor, orderId, 'FORCED_RECEIPT');
      const evidenceId = `evidence:${randomUUID()}`;
      if (input.approved) {
        const result = await completeOrder(executor, order, command, evidenceId, input.evidenceHash, 'FORCED_RECEIPT');
        await resolveRequest(executor, openRequest.request_id, evidenceId, command.actor, command.now, 'APPROVED');
        return result;
      }
      const result = { orderId, state: 'DELIVERED', approved: false, decidedAt: command.now.toISOString() };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: 'FORCED_RECEIPT_REVIEW',
        hash: input.evidenceHash,
        source: 'PLATFORM',
        payload: { approved: false, noteCode: input.noteCode },
        actor: command.actor,
        at: command.now,
      });
      await resolveRequest(executor, openRequest.request_id, evidenceId, command.actor, command.now, 'REJECTED');
      await outbox(executor, orderId, command.id, 'ForcedReceiptRejected', result);
      return result;
    });
  }

  confirmReceipt(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput) {
    validateCommand(input);
    return this.#command(actor, orderId, 'CONFIRM_RECEIPT', input, async (executor, order, command, currentActor) => {
      assertBuyer(currentActor, order);
      assertFinalPayment(order);
      if (order.state !== 'DELIVERED') throw new CoreError('UnknownState', 'Receipt requires a delivered order', 409);
      return completeOrder(executor, order, command, `evidence:${randomUUID()}`, input.evidenceHash, 'CUSTOMER_RECEIPT');
    });
  }

  #request(
    actor: FulfillmentActor,
    orderId: string,
    commandType: 'REQUEST_EXCHANGE' | 'REQUEST_DELAY',
    requestType: 'EXCHANGE' | 'DELAY',
    evidenceType: 'EXCHANGE_REQUEST' | 'DELAY_REQUEST',
    input: RequestInput,
  ) {
    validateRequest(input);
    return this.#command(actor, orderId, commandType, input, async (executor, order, command, currentActor) => {
      assertBuyer(currentActor, order);
      assertFinalPayment(order);
      if (!['PAID', 'SHIPPED', 'DELIVERED'].includes(order.state)) {
        throw new CoreError('UnknownState', `${requestType} is unavailable for this order`, 409);
      }
      const requestId = `request:${randomUUID()}`;
      const evidenceId = `evidence:${randomUUID()}`;
      const result = { orderId, requestId, requestType, state: 'OPEN', requestedAt: command.now.toISOString() };
      await insertCommand(executor, command, result);
      await insertEvidence(executor, {
        evidenceId,
        orderId,
        type: evidenceType,
        hash: input.evidenceHash,
        source: 'BUYER',
        payload: { reasonCode: input.reasonCode },
        actor: command.actor,
        at: command.now,
      });
      await insertRequest(executor, requestId, orderId, command, requestType, evidenceId);
      await outbox(executor, orderId, command.id, `${requestType}Requested`, result);
      return result;
    });
  }

  #command<Result extends Record<string, unknown>>(
    actor: FulfillmentActor,
    orderId: string,
    type: CommandType,
    payload: unknown,
    operation: (
      executor: SqlExecutor,
      order: OrderRow,
      command: { id: string; actor: string; type: CommandType; idempotencyKey: string; contentHash: string; now: Date },
      currentActor: FulfillmentActor,
    ) => Promise<Result>,
  ): Promise<Result> {
    const wallet = normalizedWallet(actor.walletAddress);
    const idempotencyKey = (payload as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new CoreError('InvalidRequest', 'idempotencyKey must contain 8-128 characters');
    }
    const contentHash = hashJson({ orderId, type, payload });
    return this.#transactions.transaction(async (executor) => {
      const currentActor = await revalidateActor(executor, actor);
      await lockFulfillmentIdempotency(executor, wallet, idempotencyKey);
      const prior = await executor.query<ExistingCommandRow>(
        `SELECT command_id, order_id, command_type, content_hash, result
         FROM core.fulfillment_commands WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, idempotencyKey],
      );
      if (prior.rows[0]) {
        const existing = prior.rows[0];
        if (existing.order_id !== orderId || existing.command_type !== type || existing.content_hash !== contentHash) {
          throw new CoreError('IdempotencyConflict', 'Fulfillment idempotency key was reused with different input', 409);
        }
        return existing.result as Result;
      }
      const order = await loadOrder(executor, orderId, true);
      return operation(executor, order, {
        id: `command:${randomUUID()}`,
        actor: wallet,
        type,
        idempotencyKey,
        contentHash,
        now: this.#clock(),
      }, currentActor);
    });
  }
}

async function lockFulfillmentIdempotency(executor: SqlExecutor, wallet: string, idempotencyKey: string) {
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`fulfillment-command:${wallet}:${idempotencyKey}`],
  );
}

async function recordShipmentCommand(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  order: OrderRow,
  input: ShipmentInput,
  command: {
    id: string;
    actor: string;
    type: CommandType;
    idempotencyKey: string;
    contentHash: string;
    now: Date;
  },
) {
  const orderId = order.order_id;
  assertFinalPayment(order);
  const platform = hasRole(actor, 'OPERATOR', 'ADMIN');
  const assignment = order.state === 'TAKEOVER'
    ? await currentTakeoverAssignment(executor, orderId)
    : undefined;
  const replacementMerchant = assignment?.case_state === 'FUNDED'
    && actor.roles.includes('MERCHANT')
    && (
      normalizedWallet(actor.walletAddress) === assignment.replacement_wallet
      || actor.merchantId === assignment.replacement_merchant_id
    );
  if (order.state === 'TAKEOVER') {
    if (!platform && !replacementMerchant) {
      throw new CoreError('Forbidden', 'Funded replacement merchant or platform role is required', 403);
    }
  } else {
    assertMerchantOrOperator(actor, order);
  }
  const exchange = order.state === 'PAID'
    ? undefined
    : (await executor.query<{ request_id: string }>(
      `SELECT request_id FROM core.fulfillment_requests
       WHERE order_id = $1 AND request_type = 'EXCHANGE' AND state = 'APPROVED'
       ORDER BY resolved_at DESC LIMIT 1 FOR UPDATE`,
      [orderId],
    )).rows[0];
  const takeover = order.state === 'TAKEOVER' && (platform || replacementMerchant);
  if (
    order.fulfillment_mode !== 'DELIVERY'
    || (
      order.state !== 'PAID'
      && !(['SHIPPED', 'DELIVERED'].includes(order.state) && exchange)
      && !takeover
    )
  ) throw new CoreError('UnknownState', 'Shipment requires a paid delivery order', 409);
  const evidenceId = `evidence:${randomUUID()}`;
  const shipmentId = `shipment:${randomUUID()}`;
  const result = {
    orderId,
    state: 'SHIPPED',
    shipmentId,
    carrierCode: input.carrierCode,
    trackingNumberHash: input.trackingNumberHash.toLowerCase(),
    recordedAt: command.now.toISOString(),
  };
  await insertCommand(executor, command, result);
  await insertEvidence(executor, {
    evidenceId,
    orderId,
    type: 'SHIPMENT',
    hash: input.evidenceHash,
    source: 'MERCHANT_OR_OPERATOR',
    ...(input.providerReferenceHash ? { providerReferenceHash: input.providerReferenceHash } : {}),
    payload: { carrierCode: input.carrierCode, trackingNumberHash: input.trackingNumberHash.toLowerCase() },
    actor: command.actor,
    at: command.now,
  });
  await executor.query(
    `INSERT INTO core.shipments (
       shipment_id, order_id, command_id, carrier_code, tracking_number_hash,
       provider_reference_hash, evidence_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      shipmentId,
      orderId,
      command.id,
      input.carrierCode,
      input.trackingNumberHash.toLowerCase(),
      input.providerReferenceHash?.toLowerCase() ?? null,
      evidenceId,
    ],
  );
  await transitionOrder(executor, order, command, evidenceId, 'SHIPPED');
  await executor.query(
    `UPDATE core.orders SET state = 'SHIPPED', shipped_at = $2,
       delivered_at = CASE WHEN $3 THEN NULL ELSE delivered_at END,
       updated_at = clock_timestamp() WHERE order_id = $1`,
    [orderId, command.now, Boolean(exchange)],
  );
  if (exchange) {
    await executor.query(
      `UPDATE core.fulfillment_requests SET state = 'RESOLVED', resolution_evidence_id = $2,
         resolved_by = $3, resolved_at = $4 WHERE request_id = $1 AND state = 'APPROVED'`,
      [exchange.request_id, evidenceId, command.actor, command.now],
    );
  }
  if (takeover) {
    const takeoverCase = await executor.query<{ case_id: string; state: string }>(
      `SELECT case_id, state FROM core.takeover_cases
       WHERE order_id = $1 AND state IN ('OPEN', 'FUNDED') FOR UPDATE`,
      [orderId],
    );
    const activeCase = takeoverCase.rows[0];
    if (!activeCase) throw new CoreError('UnknownState', 'Active takeover case is unavailable', 409);
    await executor.query(
      `UPDATE core.takeover_cases SET state = 'FULFILLING', updated_at = clock_timestamp()
       WHERE order_id = $1 AND state IN ('OPEN', 'FUNDED')`,
      [orderId],
    );
    await insertTakeoverTransition(executor, {
      caseId: activeCase.case_id,
      orderId,
      fromState: activeCase.state,
      toState: 'FULFILLING',
      evidenceType: 'REPLACEMENT_SHIPMENT_ACCEPTED',
      evidenceHash: input.evidenceHash,
      occurredAt: command.now,
    });
  }
  await outbox(executor, orderId, command.id, 'ShipmentRecorded', result);
  return result;
}

async function completeOrder(
  executor: SqlExecutor,
  order: OrderRow,
  command: { id: string; actor: string; type: CommandType; idempotencyKey: string; contentHash: string; now: Date },
  evidenceId: string,
  evidenceHash: string,
  method: 'CUSTOMER_RECEIPT' | 'PICKUP_VERIFICATION' | 'FORCED_RECEIPT' | 'ARBITRATION',
  fromBalanceState: 'LOCKED' | 'DISPUTED' = 'LOCKED',
) {
  const result = { orderId: order.order_id, state: 'FULFILLED', method, fulfilledAt: command.now.toISOString() };
  await insertCommand(executor, command, result);
  await insertEvidence(executor, {
    evidenceId,
    orderId: order.order_id,
    type: method === 'PICKUP_VERIFICATION'
      ? 'PICKUP_SCAN'
      : method === 'ARBITRATION'
        ? 'ARBITRATION_DECISION'
        : method === 'FORCED_RECEIPT'
          ? 'FORCED_RECEIPT_REVIEW'
          : 'RECEIPT_CONFIRMATION',
    hash: evidenceHash,
    source: method,
    payload: { method },
    actor: command.actor,
    at: command.now,
  });
  await moveLedgerState(
    executor,
    order,
    command,
    evidenceHash,
    fromBalanceState,
    'AVAILABLE',
    method === 'ARBITRATION' ? 'ARBITRATION_RESOLVED' : 'FULFILLMENT_AVAILABLE',
  );
  await captureMerchantFutureProceeds(executor, {
    orderId: order.order_id,
    merchantId: order.merchant_id,
    evidenceHash,
    correlationId: `fulfillment:${command.id}`,
    capturedAt: command.now,
  });
  await transitionOrder(executor, order, command, evidenceId, 'FULFILLED', method);
  const bnmState = await executor.query<{ state_version: string }>(
    `UPDATE core.orders SET state = 'FULFILLED', fulfilled_at = $2,
       bnm_state_version = bnm_state_version + 1, updated_at = clock_timestamp()
     WHERE order_id = $1 RETURNING bnm_state_version::text AS state_version`,
    [order.order_id, command.now],
  );
  if (!bnmState.rows[0]) throw new CoreError('UnknownState', 'Order BNM state version is unavailable', 409);
  const closingTakeover = await executor.query<{ case_id: string; state: string }>(
    `SELECT case_id, state FROM core.takeover_cases
     WHERE order_id = $1 AND state IN ('FULFILLING', 'FULFILLMENT_PENDING') FOR UPDATE`,
    [order.order_id],
  );
  await executor.query(
    `UPDATE core.takeover_cases SET state = 'CLOSED', closed_at = $2,
       updated_at = clock_timestamp() WHERE order_id = $1 AND state IN ('FULFILLING', 'FULFILLMENT_PENDING')`,
    [order.order_id, command.now],
  );
  if (closingTakeover.rows[0]) {
    await insertTakeoverTransition(executor, {
      caseId: closingTakeover.rows[0].case_id,
      orderId: order.order_id,
      fromState: closingTakeover.rows[0].state,
      toState: 'CLOSED',
      evidenceType: 'FULFILLMENT_FINALIZED',
      evidenceHash,
      occurredAt: command.now,
    });
  }
  await executor.query(
    `UPDATE core.fulfillment_requests SET state = 'RESOLVED', resolution_evidence_id = $2,
       resolved_by = $3, resolved_at = $4
     WHERE order_id = $1 AND state = 'OPEN' AND request_type IN ('EXCHANGE', 'DELAY')`,
    [order.order_id, evidenceId, command.actor, command.now],
  );
  await outbox(executor, order.order_id, command.id, 'FulfillmentFinalized', result);
  await outbox(executor, order.order_id, `${command.id}:bnm`, 'BnmAvailabilityRequested', {
    orderId: order.order_id,
    buyerWallet: order.buyer_wallet,
    amount: canonicalAmount(order.exact_amounts.bnmAmount, 'bnmAmount'),
    state: 'AVAILABLE',
    stateVersion: bnmState.rows[0].state_version,
    reason: method,
    sourceEvidenceHash: evidenceHash.toLowerCase(),
  });
  return result;
}

async function moveLedgerState(
  executor: SqlExecutor,
  order: OrderRow,
  command: { id: string; contentHash: string },
  evidenceHash: string,
  from: 'LOCKED' | 'DISPUTED',
  to: 'LOCKED' | 'DISPUTED' | 'AVAILABLE',
  eventType: 'ARBITRATION_DISPUTED' | 'ARBITRATION_RESOLVED' | 'FULFILLMENT_AVAILABLE',
) {
  const balances = await executor.query<LedgerStateRow>(
    `SELECT line.account_id, account.asset, account.purpose, line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND line.balance_state = $2
     GROUP BY line.account_id, account.asset, account.purpose, line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY line.account_id`,
    [order.order_id, from],
  );
  if (balances.rows.length === 0) throw new CoreError('FinalityPending', `No ${from} balances are available`, 409);
  const lines = balances.rows.flatMap((row) => {
    const target = to === 'AVAILABLE' && row.purpose === 'SECKILL_PRIZE_LIABILITY' ? 'LOCKED' : to;
    if (target === from) return [];
    return [
      {
        account_id: row.account_id,
        side: 'DEBIT',
        amount: row.amount,
        balance_state: from,
        backing_wallet_address: row.backing_wallet_address,
      },
      {
        account_id: row.account_id,
        side: 'CREDIT',
        amount: row.amount,
        balance_state: target,
        backing_wallet_address: row.backing_wallet_address,
      },
    ];
  });
  if (lines.length === 0) throw new CoreError('FinalityPending', `No ${from} balances can change state`, 409);
  const eventKey = `fulfillment:${order.order_id}:${command.id}:${from}:${to}`;
  await executor.query(
    'SELECT core.post_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)',
    [
      `journal:${command.id}:${from}:${to}`,
      eventKey,
      eventType,
      order.order_id,
      Number(order.policy_version),
      hashJson({ eventKey, commandHash: command.contentHash, lines }),
      evidenceHash.toLowerCase(),
      null,
      JSON.stringify({ commandId: command.id, from, to }),
      JSON.stringify(lines),
    ],
  );
}

async function loadOrder(executor: SqlExecutor, orderId: string, forUpdate = false) {
  const result = await executor.query<OrderRow>(
    `SELECT orders.order_id, orders.artifact_version, orders.policy_version,
       orders.buyer_wallet, orders.merchant_id, orders.merchant_wallet,
       orders.product_id, orders.sku_id, orders.quantity, orders.fulfillment_mode, orders.fulfillment_target_hash, orders.state,
       orders.finality_status, orders.paid_at, orders.shipped_at, orders.delivered_at,
       orders.fulfilled_at, orders.takeover_opened_at, orders.arbitration_opened_at,
       orders.exact_amounts, orders.seckill_snapshot, orders.payment_tx_hash,
       orders.created_at, quote.quote_kind,
       finality.finalized_at AS payment_finalized_at
     FROM core.orders orders
     LEFT JOIN core.payment_quotes quote ON quote.order_id = orders.order_id
     LEFT JOIN core.transaction_finality finality
       ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
       AND finality.state = 'FINAL'
     WHERE orders.order_id = $1${forUpdate ? ' FOR UPDATE OF orders' : ''}`,
    [orderId],
  );
  const order = result.rows[0];
  if (!order) throw new CoreError('InvalidRequest', 'Order not found', 404);
  return {
    ...normalizeOrderDates(order),
  };
}

async function orderProjection(
  executor: SqlExecutor,
  order: OrderRow,
  allowedActions: ReturnType<typeof orderAllowedActions> = [],
  decryptTracking?: ReturnType<typeof createTrackingEvidenceDecryptor>,
) {
  const [requests, shipments, logistics, balances] = await Promise.all([
    executor.query<{
      request_id: string;
      request_type: string;
      state: string;
      requested_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT request_id, request_type, state, requested_at, resolved_at
       FROM core.fulfillment_requests WHERE order_id = $1 ORDER BY requested_at, request_id`,
      [order.order_id],
    ),
    executor.query<{
      shipment_id: string;
      carrier_code: string;
      tracking_number_hash: string;
      provider_reference_hash: string | null;
      evidence_hash: string;
      media_asset_ids: unknown;
      encrypted_tracking_number: Uint8Array | null;
      tracking_iv: Uint8Array | null;
      tracking_tag: Uint8Array | null;
      created_at: Date;
    }>(
      `SELECT shipment.shipment_id, shipment.carrier_code, shipment.tracking_number_hash,
         shipment.provider_reference_hash, evidence.evidence_hash,
         envelope.media_asset_ids, envelope.encrypted_tracking_number,
         envelope.tracking_iv, envelope.tracking_tag, shipment.created_at
       FROM core.shipments shipment
       JOIN core.fulfillment_evidence evidence ON evidence.evidence_id = shipment.evidence_id
       LEFT JOIN core.evidence_envelopes envelope ON envelope.evidence_hash = evidence.evidence_hash
       WHERE shipment.order_id = $1 ORDER BY shipment.created_at, shipment.shipment_id`,
      [order.order_id],
    ),
    executor.query<{
      logistics_event_id: string;
      provider: string;
      status: string;
      location_hash: string | null;
      occurred_at: Date;
    }>(
      `SELECT logistics_event_id, provider, status, location_hash, occurred_at
       FROM core.logistics_events WHERE order_id = $1 ORDER BY occurred_at, logistics_event_id`,
      [order.order_id],
    ),
    executor.query<{ asset: string; balance_state: string; amount: string }>(
      `SELECT account.asset, line.balance_state,
         sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
       FROM core.ledger_journals journal
       JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
       JOIN core.ledger_accounts account ON account.account_id = line.account_id
       WHERE journal.order_id = $1 AND line.balance_state <> 'POSTED'
       GROUP BY account.asset, line.balance_state
       HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
       ORDER BY account.asset, line.balance_state`,
      [order.order_id],
    ),
  ]);
  return {
    ...orderSummary(order, allowedActions),
    requests: requests.rows.map((row) => ({
      requestId: row.request_id,
      requestType: row.request_type,
      state: row.state,
      requestedAt: new Date(row.requested_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    })),
    shipments: shipments.rows.map((row) => shipmentProjection({
      shipmentId: row.shipment_id,
      carrierCode: row.carrier_code,
      trackingNumberHash: row.tracking_number_hash,
      providerReferenceHash: row.provider_reference_hash,
      evidenceHash: row.evidence_hash,
      mediaAssetIds: row.media_asset_ids,
      encryptedTrackingNumber: row.encrypted_tracking_number,
      trackingIv: row.tracking_iv,
      trackingTag: row.tracking_tag,
      createdAt: new Date(row.created_at).toISOString(),
    }, decryptTracking)),
    logistics: logistics.rows.map((row) => ({
      logisticsEventId: row.logistics_event_id,
      provider: row.provider,
      status: row.status,
      locationHash: row.location_hash,
      occurredAt: new Date(row.occurred_at).toISOString(),
    })),
    balances: balances.rows.map((row) => ({ asset: row.asset, state: row.balance_state, amount: row.amount })),
  };
}

function orderPageProjection(
  order: OrderPageRow,
  allowedActions: ReturnType<typeof orderAllowedActions>,
  decryptTracking?: ReturnType<typeof createTrackingEvidenceDecryptor>,
) {
  const requests = recordArray(order.requests, 'order requests');
  const shipments = recordArray(order.shipments, 'order shipments');
  const logistics = recordArray(order.logistics, 'order logistics');
  const balances = recordArray(order.balances, 'order balances');
  return {
    ...orderSummary(order, allowedActions),
    requests: requests.map((row) => ({
      requestId: requiredText(row.requestId, 'requestId'),
      requestType: requiredText(row.requestType, 'requestType'),
      state: requiredText(row.state, 'request state'),
      requestedAt: requiredTimestamp(row.requestedAt, 'requestedAt'),
      resolvedAt: nullableTimestamp(row.resolvedAt, 'resolvedAt'),
    })),
    shipments: shipments.map((row) => shipmentProjection({
      shipmentId: requiredText(row.shipmentId, 'shipmentId'),
      carrierCode: requiredText(row.carrierCode, 'carrierCode'),
      trackingNumberHash: requiredText(row.trackingNumberHash, 'trackingNumberHash'),
      providerReferenceHash: nullableText(row.providerReferenceHash, 'providerReferenceHash'),
      evidenceHash: requiredText(row.evidenceHash, 'shipment evidenceHash'),
      mediaAssetIds: row.mediaAssetIds,
      encryptedTrackingNumber: optionalHexBytes(row.encryptedTrackingNumber, 'encryptedTrackingNumber'),
      trackingIv: optionalHexBytes(row.trackingIv, 'trackingIv'),
      trackingTag: optionalHexBytes(row.trackingTag, 'trackingTag'),
      createdAt: requiredTimestamp(row.createdAt, 'shipment createdAt'),
    }, decryptTracking)),
    logistics: logistics.map((row) => ({
      logisticsEventId: requiredText(row.logisticsEventId, 'logisticsEventId'),
      provider: requiredText(row.provider, 'logistics provider'),
      status: requiredText(row.status, 'logistics status'),
      locationHash: nullableText(row.locationHash, 'locationHash'),
      occurredAt: requiredTimestamp(row.occurredAt, 'logistics occurredAt'),
    })),
    balances: balances.map((row) => ({
      asset: requiredText(row.asset, 'balance asset'),
      state: requiredText(row.state, 'balance state'),
      amount: requiredText(row.amount, 'balance amount'),
    })),
  };
}

function orderSummary(order: OrderRow, allowedActions: ReturnType<typeof orderAllowedActions>) {
  return {
    orderId: order.order_id,
    artifactVersion: order.artifact_version,
    buyerWallet: order.buyer_wallet,
    merchantId: order.merchant_id,
    merchantWallet: order.merchant_wallet,
    productId: order.product_id,
    skuId: order.sku_id,
    quantity: String(order.quantity),
    createdAt: order.created_at.toISOString(),
    orderKind: orderKind(order),
    paymentTxHash: order.payment_tx_hash,
    fulfillmentMode: order.fulfillment_mode,
    state: order.state,
    finalityStatus: order.finality_status,
    exactAmounts: order.exact_amounts,
    paidAt: iso(order.paid_at),
    paymentFinalizedAt: iso(order.payment_finalized_at),
    shippedAt: iso(order.shipped_at),
    deliveredAt: iso(order.delivered_at),
    fulfilledAt: iso(order.fulfilled_at),
    takeoverOpenedAt: iso(order.takeover_opened_at),
    arbitrationOpenedAt: iso(order.arbitration_opened_at),
    allowedActions,
  };
}

async function allowedActionsForOrder(
  executor: SqlExecutor,
  order: OrderRow,
  actor: FulfillmentActor,
  now: Date,
  pausedScopes: ReadonlySet<BreakerScope>,
  executableActions: ReadonlySet<AllowedActionName>,
) {
  const result = await executor.query<{
    shipment_evidence: boolean;
    takeover_opened: boolean;
    open_request_types: Array<'EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT'>;
    active_pickup_credential: boolean;
    approved_exchange: boolean;
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM core.fulfillment_evidence evidence
         WHERE evidence.order_id = $1 AND evidence.evidence_type = 'SHIPMENT'
       ) AS shipment_evidence,
       EXISTS (SELECT 1 FROM core.takeover_cases takeover WHERE takeover.order_id = $1) AS takeover_opened,
       ARRAY(
         SELECT request.request_type FROM core.fulfillment_requests request
         WHERE request.order_id = $1 AND request.state = 'OPEN'
         ORDER BY request.request_type
       ) AS open_request_types,
       EXISTS (
         SELECT 1 FROM core.pickup_credentials credential
         WHERE credential.order_id = $1 AND credential.consumed_at IS NULL
           AND credential.invalidated_at IS NULL AND credential.expires_at > $2
       ) AS active_pickup_credential,
       EXISTS (
         SELECT 1 FROM core.fulfillment_requests request
         WHERE request.order_id = $1 AND request.request_type = 'EXCHANGE'
           AND request.state = 'APPROVED'
       ) AS approved_exchange`,
    [order.order_id, now],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Order action projection is unavailable', 409);
  const assignment = await currentTakeoverAssignment(executor, order.order_id);
  return allowedActionsFromState(order, row, actor, now, pausedScopes, executableActions, assignment);
}

function allowedActionsFromState(
  order: OrderRow,
  row: {
    shipment_evidence: boolean;
    takeover_opened: boolean;
    open_request_types: Array<'EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT'>;
    active_pickup_credential: boolean;
    approved_exchange: boolean;
  },
  actor: FulfillmentActor,
  now: Date,
  pausedScopes: ReadonlySet<BreakerScope>,
  executableActions: ReadonlySet<AllowedActionName>,
  assignment?: Awaited<ReturnType<typeof currentTakeoverAssignment>>,
) {
  const projection: OrderProjection = {
    state: order.state,
    fulfillmentMode: order.fulfillment_mode,
    buyerWallet: order.buyer_wallet,
    merchantId: order.merchant_id,
    merchantWallet: order.merchant_wallet,
    ...(order.payment_finalized_at ? { paidAt: order.payment_finalized_at } : {}),
    ...(order.delivered_at ? { deliveredAt: order.delivered_at } : {}),
    paymentFinalityStatus: order.finality_status,
    shipmentEvidence: row.shipment_evidence,
    takeoverOpened: row.takeover_opened,
    openRequestTypes: row.open_request_types,
    activePickupCredential: row.active_pickup_credential,
    approvedExchange: row.approved_exchange,
    ...(assignment ? {
      replacementMerchantId: assignment.replacement_merchant_id,
      replacementMerchantWallet: assignment.replacement_wallet,
      takeoverFunded: assignment.case_state === 'FUNDED',
    } : {}),
  };
  return orderAllowedActions(projection, {
    actorWallet: normalizedWallet(actor.walletAddress),
    ...(actor.merchantId ? { actorMerchantId: actor.merchantId } : {}),
    roles: actor.roles,
    now,
    pausedScopes,
    executableActions,
  });
}

async function loadPausedScopes(executor: SqlExecutor) {
  const result = await executor.query<{ scope: BreakerScope }>(
    'SELECT scope FROM core.circuit_breakers WHERE paused ORDER BY scope',
  );
  const known = new Set<string>(breakerScopes);
  if (result.rows.some((row) => !known.has(row.scope))) {
    throw new CoreError('UnknownState', 'Circuit-breaker scope projection is invalid', 409);
  }
  return new Set(result.rows.map((row) => row.scope));
}

function orderPageQuery(input: OrderPageQuery) {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CoreError('InvalidRequest', 'Order page limit must be between 1 and 100');
  }
  const hasCursorTime = input.cursorCreatedAt !== undefined;
  const hasCursorId = input.cursorOrderId !== undefined;
  if (hasCursorTime !== hasCursorId) {
    throw new CoreError('InvalidRequest', 'Order cursor requires createdAt and orderId together');
  }
  for (const [name, value] of [
    ['cursorCreatedAt', input.cursorCreatedAt],
    ['from', input.from],
    ['to', input.to],
  ] as const) {
    if (value && !Number.isFinite(value.getTime())) throw new CoreError('InvalidRequest', `${name} is invalid`);
  }
  if (input.from && input.to && input.from > input.to) {
    throw new CoreError('InvalidRequest', 'Order date range is invalid');
  }
  if (input.cursorOrderId !== undefined && (input.cursorOrderId.length < 1 || input.cursorOrderId.length > 256)) {
    throw new CoreError('InvalidRequest', 'Order cursor ID is invalid');
  }
  if (input.skuId !== undefined && (input.skuId.length < 1 || input.skuId.length > 256)) {
    throw new CoreError('InvalidRequest', 'Order SKU filter is invalid');
  }
  if (input.state !== undefined && !orderProjectionStates.includes(input.state)) {
    throw new CoreError('InvalidRequest', 'Order state filter is invalid');
  }
  if (input.fulfillmentMode !== undefined && !fulfillmentModes.includes(input.fulfillmentMode)) {
    throw new CoreError('InvalidRequest', 'Order fulfillment filter is invalid');
  }
  if (input.orderKind !== undefined && !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(input.orderKind)) {
    throw new CoreError('InvalidRequest', 'Order kind filter is invalid');
  }
  for (const [name, value] of [['orderId', input.orderId], ['productId', input.productId]] as const) {
    if (value !== undefined && (value.length < 1 || value.length > 256)) {
      throw new CoreError('InvalidRequest', `${name} filter is invalid`);
    }
  }
  if (input.txHash !== undefined && !isHash(input.txHash)) {
    throw new CoreError('InvalidRequest', 'Order transaction hash filter is invalid');
  }
  const wallet = input.wallet === undefined ? undefined : normalizedWallet(input.wallet);
  if (input.breakerScope !== undefined && !breakerScopes.includes(input.breakerScope)) {
    throw new CoreError('InvalidRequest', 'Order breaker filter is invalid');
  }
  return { ...input, ...(wallet ? { wallet } : {}), limit };
}

function orderPageSql(actor: FulfillmentActor, query: ReturnType<typeof orderPageQuery>, now: Date) {
  const params: unknown[] = [];
  const conditions: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (!hasRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR')) {
    const scope: string[] = [];
    const wallet = normalizedWallet(actor.walletAddress);
    if (actor.roles.includes('BUYER')) scope.push(`orders.buyer_wallet = ${add(wallet)}`);
    if (actor.roles.includes('MERCHANT')) {
      const merchantScope = [`orders.merchant_wallet = ${add(wallet)}`];
      if (actor.merchantId) merchantScope.push(`orders.merchant_id = ${add(actor.merchantId)}`);
      scope.push(`(${merchantScope.join(' OR ')})`);
    }
    conditions.push(scope.length > 0 ? `(${scope.join(' OR ')})` : 'FALSE');
  }
  if (query.from) conditions.push(`orders.created_at >= ${add(query.from)}`);
  if (query.to) conditions.push(`orders.created_at <= ${add(query.to)}`);
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
  if (query.orderId) conditions.push(`orders.order_id = ${add(query.orderId)}`);
  if (query.productId) conditions.push(`orders.product_id = ${add(query.productId)}`);
  if (query.txHash) {
    conditions.push(`(orders.payment_tx_hash = ${add(query.txHash.toLowerCase())}
      OR quote.submitted_tx_hash = ${add(query.txHash.toLowerCase())})`);
  }
  if (query.wallet) {
    conditions.push(`(orders.buyer_wallet = ${add(query.wallet)} OR orders.merchant_wallet = ${add(query.wallet)})`);
  }
  if (query.pendingProductReview !== undefined) {
    conditions.push(`(product.lifecycle_state = 'REVIEW') = ${add(query.pendingProductReview)}`);
  }
  if (query.cursorCreatedAt && query.cursorOrderId) {
    conditions.push(`(orders.created_at, orders.order_id) < (${add(query.cursorCreatedAt)}, ${add(query.cursorOrderId)})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const activeAt = add(now);
  const limit = add(query.limit + 1);
  return {
    sql: `SELECT orders.order_id, orders.artifact_version, orders.policy_version,
        orders.buyer_wallet, orders.merchant_id, orders.merchant_wallet,
        orders.product_id, orders.sku_id, orders.quantity, orders.fulfillment_mode,
        orders.fulfillment_target_hash, orders.state, orders.finality_status,
        orders.paid_at, orders.shipped_at, orders.delivered_at, orders.fulfilled_at,
        orders.takeover_opened_at, orders.arbitration_opened_at, orders.exact_amounts,
        orders.seckill_snapshot, orders.payment_tx_hash, orders.created_at,
        quote.quote_kind, finality.finalized_at AS payment_finalized_at,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'requestId', request.request_id,
            'requestType', request.request_type,
            'state', request.state,
            'requestedAt', request.requested_at,
            'resolvedAt', request.resolved_at
          ) ORDER BY request.requested_at, request.request_id)
          FROM core.fulfillment_requests request WHERE request.order_id = orders.order_id
        ), '[]'::jsonb) AS requests,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'shipmentId', shipment.shipment_id,
            'carrierCode', shipment.carrier_code,
            'trackingNumberHash', shipment.tracking_number_hash,
            'providerReferenceHash', shipment.provider_reference_hash,
            'evidenceHash', evidence.evidence_hash,
            'mediaAssetIds', COALESCE(envelope.media_asset_ids, '[]'::jsonb),
            'encryptedTrackingNumber', CASE WHEN envelope.encrypted_tracking_number IS NULL
              THEN NULL ELSE encode(envelope.encrypted_tracking_number, 'hex') END,
            'trackingIv', CASE WHEN envelope.tracking_iv IS NULL
              THEN NULL ELSE encode(envelope.tracking_iv, 'hex') END,
            'trackingTag', CASE WHEN envelope.tracking_tag IS NULL
              THEN NULL ELSE encode(envelope.tracking_tag, 'hex') END,
            'createdAt', shipment.created_at
          ) ORDER BY shipment.created_at, shipment.shipment_id)
          FROM core.shipments shipment
          JOIN core.fulfillment_evidence evidence ON evidence.evidence_id = shipment.evidence_id
          LEFT JOIN core.evidence_envelopes envelope ON envelope.evidence_hash = evidence.evidence_hash
          WHERE shipment.order_id = orders.order_id
        ), '[]'::jsonb) AS shipments,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'logisticsEventId', event.logistics_event_id,
            'provider', event.provider,
            'status', event.status,
            'locationHash', event.location_hash,
            'occurredAt', event.occurred_at
          ) ORDER BY event.occurred_at, event.logistics_event_id)
          FROM core.logistics_events event WHERE event.order_id = orders.order_id
        ), '[]'::jsonb) AS logistics,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'asset', balance.asset, 'state', balance.balance_state, 'amount', balance.amount
          ) ORDER BY balance.asset, balance.balance_state)
          FROM (
            SELECT account.asset, line.balance_state,
              sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
            FROM core.ledger_journals journal
            JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
            JOIN core.ledger_accounts account ON account.account_id = line.account_id
            WHERE journal.order_id = orders.order_id AND line.balance_state <> 'POSTED'
            GROUP BY account.asset, line.balance_state
            HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
          ) balance
        ), '[]'::jsonb) AS balances,
        EXISTS (
          SELECT 1 FROM core.fulfillment_evidence evidence
          WHERE evidence.order_id = orders.order_id AND evidence.evidence_type = 'SHIPMENT'
        ) AS shipment_evidence,
        EXISTS (
          SELECT 1 FROM core.takeover_cases takeover WHERE takeover.order_id = orders.order_id
        ) AS takeover_opened,
        ARRAY(
          SELECT request.request_type FROM core.fulfillment_requests request
          WHERE request.order_id = orders.order_id AND request.state = 'OPEN'
          ORDER BY request.request_type
        ) AS open_request_types,
        EXISTS (
          SELECT 1 FROM core.pickup_credentials credential
          WHERE credential.order_id = orders.order_id AND credential.consumed_at IS NULL
            AND credential.invalidated_at IS NULL AND credential.expires_at > ${activeAt}
        ) AS active_pickup_credential,
        EXISTS (
          SELECT 1 FROM core.fulfillment_requests request
          WHERE request.order_id = orders.order_id AND request.request_type = 'EXCHANGE'
            AND request.state = 'APPROVED'
        ) AS approved_exchange
      FROM core.orders orders
      LEFT JOIN core.payment_quotes quote ON quote.order_id = orders.order_id
      JOIN core.products product ON product.product_id = orders.product_id
      LEFT JOIN core.transaction_finality finality
        ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
        AND finality.state = 'FINAL'
      ${where}
      ORDER BY orders.created_at DESC, orders.order_id DESC
      LIMIT ${limit}`,
    params,
  };
}

function orderKind(order: Pick<OrderRow, 'seckill_snapshot' | 'quote_kind'>): OrderKind {
  if (order.seckill_snapshot !== null) {
    if (order.seckill_snapshot.classification !== 'SECKILL') {
      throw new CoreError('UnknownState', 'Seckill order classification snapshot is invalid', 409);
    }
    return 'SECKILL';
  }
  return order.quote_kind === 'SECKILL' ? 'FALLBACK_RETAIL' : 'ORDINARY';
}

function normalizeOrderDates<Row extends OrderRow>(order: Row): Row {
  return {
    ...order,
    paid_at: asDate(order.paid_at),
    shipped_at: asDate(order.shipped_at),
    delivered_at: asDate(order.delivered_at),
    fulfilled_at: asDate(order.fulfilled_at),
    takeover_opened_at: asDate(order.takeover_opened_at),
    arbitration_opened_at: asDate(order.arbitration_opened_at),
    created_at: new Date(order.created_at),
    payment_finalized_at: asDate(order.payment_finalized_at),
  };
}

function recordArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new CoreError('UnknownState', `${label} projection is invalid`, 409);
  }
  return value as Record<string, unknown>[];
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('UnknownState', `${label} projection is invalid`, 409);
  return value;
}

function nullableText(value: unknown, label: string) {
  return value === null ? null : requiredText(value, label);
}

function optionalHexBytes(value: unknown, label: string) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new CoreError('UnknownState', `${label} projection is invalid`, 409);
  }
  return Buffer.from(value, 'hex');
}

function shipmentProjection(
  row: {
    shipmentId: string;
    carrierCode: string;
    trackingNumberHash: string;
    providerReferenceHash: string | null;
    evidenceHash: string;
    mediaAssetIds: unknown;
    encryptedTrackingNumber: Uint8Array | null;
    trackingIv: Uint8Array | null;
    trackingTag: Uint8Array | null;
    createdAt: string;
  },
  decryptTracking?: ReturnType<typeof createTrackingEvidenceDecryptor>,
) {
  const cipherParts = [row.encryptedTrackingNumber, row.trackingIv, row.trackingTag];
  if (cipherParts.some(Boolean) && !cipherParts.every(Boolean)) {
    throw new CoreError('UnknownState', 'Shipment tracking cipher is incomplete', 409);
  }
  const details = row.encryptedTrackingNumber && row.trackingIv && row.trackingTag
    ? (decryptTracking ?? createTrackingEvidenceDecryptor(undefined))(
      row.encryptedTrackingNumber,
      row.trackingIv,
      row.trackingTag,
    )
    : { trackingNumber: null, note: null };
  const mediaAssetIds = Array.isArray(row.mediaAssetIds)
    && row.mediaAssetIds.every((item) => typeof item === 'string' && /^0x[0-9a-f]{64}$/.test(item))
    ? row.mediaAssetIds as string[]
    : [];
  return {
    shipmentId: row.shipmentId,
    carrierCode: row.carrierCode,
    trackingNumber: details.trackingNumber,
    trackingNumberHash: row.trackingNumberHash,
    note: details.note,
    evidenceHash: row.evidenceHash,
    mediaAssetIds,
    providerReferenceHash: row.providerReferenceHash,
    createdAt: row.createdAt,
  };
}

function requiredTimestamp(value: unknown, label: string) {
  if (typeof value !== 'string') throw new CoreError('UnknownState', `${label} projection is invalid`, 409);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CoreError('UnknownState', `${label} projection is invalid`, 409);
  return date.toISOString();
}

function nullableTimestamp(value: unknown, label: string) {
  return value === null ? null : requiredTimestamp(value, label);
}

async function insertCommand(
  executor: SqlExecutor,
  command: { id: string; actor: string; type: CommandType; idempotencyKey: string; contentHash: string; now: Date },
  result: Record<string, unknown>,
) {
  await executor.query(
    `INSERT INTO core.fulfillment_commands (
       command_id, order_id, actor_wallet, command_type, idempotency_key, content_hash, result, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      command.id,
      result.orderId,
      command.actor,
      command.type,
      command.idempotencyKey,
      command.contentHash,
      JSON.stringify(result),
      command.now,
    ],
  );
}

async function insertEvidence(
  executor: SqlExecutor,
  input: {
    evidenceId: string;
    orderId: string;
    type: string;
    hash: string;
    source: string;
    providerReferenceHash?: string;
    payload: Record<string, unknown>;
    actor: string;
    at: Date;
  },
) {
  await executor.query(
    `INSERT INTO core.fulfillment_evidence (
       evidence_id, order_id, evidence_type, evidence_hash, source,
       provider_reference_hash, payload, recorded_by, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.evidenceId,
      input.orderId,
      input.type,
      input.hash.toLowerCase(),
      input.source,
      input.providerReferenceHash?.toLowerCase() ?? null,
      JSON.stringify(input.payload),
      input.actor,
      input.at,
    ],
  );
}

async function transitionOrder(
  executor: SqlExecutor,
  order: OrderRow,
  command: { id: string; actor: string; now: Date },
  evidenceId: string,
  toState: string,
  method?: string,
) {
  await executor.query(
    `INSERT INTO core.fulfillment_transitions (
       transition_id, order_id, command_id, from_state, to_state, method,
       evidence_id, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      `transition:${randomUUID()}`,
      order.order_id,
      command.id,
      order.state,
      toState,
      method ?? null,
      evidenceId,
      command.actor,
      command.now,
    ],
  );
}

async function insertRequest(
  executor: SqlExecutor,
  requestId: string,
  orderId: string,
  command: { id: string; actor: string; now: Date },
  requestType: 'EXCHANGE' | 'DELAY' | 'ARBITRATION' | 'FORCED_RECEIPT',
  evidenceId: string,
) {
  await executor.query(
    `INSERT INTO core.fulfillment_requests (
       request_id, order_id, command_id, request_type, state, evidence_id,
       requested_by, requested_at
     ) VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7)`,
    [requestId, orderId, command.id, requestType, evidenceId, command.actor, command.now],
  );
}

async function pickupStoreId(executor: SqlExecutor, order: OrderRow) {
  const result = await executor.query<{ store_id: string }>(
    `SELECT target.store_id FROM core.fulfillment_targets target
     JOIN core.merchant_stores store ON store.store_id = target.store_id
     WHERE target.target_hash = $1 AND target.fulfillment_mode = 'PICKUP'
       AND store.merchant_id = $2`,
    [order.fulfillment_target_hash, order.merchant_id],
  );
  if (!result.rows[0]?.store_id) {
    throw new CoreError('InvalidFinality', 'Order pickup-store snapshot is unavailable', 409);
  }
  return result.rows[0].store_id;
}

async function insertPickupAttempt(
  executor: SqlExecutor,
  input: {
    orderId: string;
    credentialId?: string;
    commandId: string;
    actor: string;
    storeId: string;
    evidenceHash: string;
    successful: boolean;
    errorCode?: string;
    at: Date;
  },
) {
  await executor.query(
    `INSERT INTO core.pickup_verification_attempts (
       attempt_id, order_id, credential_id, command_id, actor_wallet, store_id,
       evidence_hash, successful, error_code, attempted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      `pickup-attempt:${randomUUID()}`,
      input.orderId,
      input.credentialId ?? null,
      input.commandId,
      input.actor,
      input.storeId,
      input.evidenceHash.toLowerCase(),
      input.successful,
      input.errorCode ?? null,
      input.at,
    ],
  );
}

async function loadOpenRequest(executor: SqlExecutor, orderId: string, requestType: string) {
  const result = await executor.query<{ request_id: string }>(
    `SELECT request_id FROM core.fulfillment_requests
     WHERE order_id = $1 AND request_type = $2 AND state = 'OPEN' FOR UPDATE`,
    [orderId, requestType],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', `Open ${requestType} request is unavailable`, 409);
  return result.rows[0];
}

async function resolveRequest(
  executor: SqlExecutor,
  requestId: string,
  evidenceId: string,
  actor: string,
  at: Date,
  state: 'APPROVED' | 'REJECTED' | 'RESOLVED',
) {
  await executor.query(
    `UPDATE core.fulfillment_requests SET state = $2, resolution_evidence_id = $3,
       resolved_by = $4, resolved_at = $5 WHERE request_id = $1 AND state = 'OPEN'`,
    [requestId, state, evidenceId, actor, at],
  );
}

async function outbox(
  executor: SqlExecutor,
  orderId: string,
  eventIdentity: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const eventId = `outbox:${eventIdentity}`;
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'ORDER',$2,$3,$4,$5,'PENDING')`,
    [eventId, orderId, eventType, JSON.stringify(payload), eventId],
  );
}

async function assertCanRead(executor: SqlExecutor, actor: FulfillmentActor, order: OrderRow) {
  if (
    isBuyer(actor, order)
    || (actor.roles.includes('MERCHANT') && actor.merchantId === order.merchant_id)
    || hasRole(actor, 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR')
  ) return;
  const assignment = await currentTakeoverAssignment(executor, order.order_id);
  if (
    assignment
    && actor.roles.includes('MERCHANT')
    && (
      normalizedWallet(actor.walletAddress) === assignment.replacement_wallet
      || actor.merchantId === assignment.replacement_merchant_id
    )
  ) return;
  throw new CoreError('Forbidden', 'Order is outside the authenticated wallet scope', 403);
}

async function revalidateActor(executor: SqlExecutor, actor: FulfillmentActor): Promise<FulfillmentActor> {
  const walletAddress = normalizedWallet(actor.walletAddress);
  const bindings = await executor.query<{ role: UserRole; merchant_id: string | null }>(
    `SELECT role, merchant_id FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])
     ORDER BY role`,
    [walletAddress, [...actor.roles]],
  );
  const merchantBinding = bindings.rows.find((binding) => (
    binding.role === 'MERCHANT'
    && actor.merchantId !== undefined
    && binding.merchant_id === actor.merchantId
  ));
  const roles = bindings.rows
    .filter((binding) => binding.role !== 'MERCHANT' || binding === merchantBinding)
    .map((binding) => binding.role);
  return {
    walletAddress,
    roles,
    ...(merchantBinding ? { merchantId: merchantBinding.merchant_id! } : {}),
  };
}

async function currentTakeoverAssignment(executor: SqlExecutor, orderId: string) {
  const result = await executor.query<{
    replacement_merchant_id: string;
    replacement_wallet: string;
    case_state: string;
  }>(
    `SELECT assignment.replacement_merchant_id, assignment.replacement_wallet,
       takeover.state AS case_state
     FROM core.takeover_cases takeover
     JOIN LATERAL (
       SELECT replacement_merchant_id, replacement_wallet
       FROM core.takeover_assignments current_assignment
       WHERE current_assignment.case_id = takeover.case_id
       ORDER BY assignment_version DESC LIMIT 1
     ) assignment ON true
     WHERE takeover.order_id = $1`,
    [orderId],
  );
  return result.rows[0];
}

function assertBuyer(actor: FulfillmentActor, order: OrderRow) {
  if (!isBuyer(actor, order)) throw new CoreError('Forbidden', 'Buyer wallet is required', 403);
}

function isBuyer(actor: FulfillmentActor, order: OrderRow) {
  return actor.roles.includes('BUYER') && normalizedWallet(actor.walletAddress) === order.buyer_wallet.toLowerCase();
}

function assertMerchant(actor: FulfillmentActor, order: OrderRow) {
  if (
    !actor.roles.includes('MERCHANT')
    || (normalizedWallet(actor.walletAddress) !== order.merchant_wallet.toLowerCase() && actor.merchantId !== order.merchant_id)
  ) throw new CoreError('Forbidden', 'Order merchant is required', 403);
}

function assertMerchantOrOperator(actor: FulfillmentActor, order: OrderRow) {
  if (hasRole(actor, 'OPERATOR', 'ADMIN')) return;
  assertMerchant(actor, order);
}

function assertRole(actor: FulfillmentActor, ...roles: UserRole[]) {
  if (!hasRole(actor, ...roles)) throw new CoreError('Forbidden', `${roles.join(' or ')} role is required`, 403);
}

function hasRole(actor: FulfillmentActor, ...roles: UserRole[]) {
  return roles.some((role) => actor.roles.includes(role));
}

function assertFinalPayment(order: OrderRow) {
  if (order.finality_status !== 'FINAL' || !order.payment_finalized_at) {
    throw new CoreError('FinalityPending', 'Payment must reach 15 canonical confirmations', 409);
  }
}

async function insertTakeoverTransition(executor: SqlExecutor, input: {
  caseId: string;
  orderId: string;
  fromState: string | null;
  toState: string;
  evidenceType: string;
  evidenceHash: string;
  occurredAt: Date;
}) {
  await executor.query(
    `INSERT INTO core.takeover_case_transitions (
       transition_id, case_id, order_id, from_state, to_state,
       public_evidence_type, public_evidence_hash, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      `takeover-transition:${randomUUID()}`,
      input.caseId,
      input.orderId,
      input.fromState,
      input.toState,
      input.evidenceType,
      input.evidenceHash.toLowerCase(),
      input.occurredAt,
    ],
  );
}

function validateRequest(input: RequestInput) {
  validateCommand(input);
  validateCode(input.reasonCode, 'reasonCode');
}

function validateCommand(input: FulfillmentCommandInput) {
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128 || !isHash(input.evidenceHash)) {
    throw new CoreError('InvalidRequest', 'Invalid fulfillment command');
  }
}

function validateShipment(input: ShipmentInput) {
  validateCommand(input);
  if (!/^[A-Z0-9_-]{2,32}$/.test(input.carrierCode) || !isHash(input.trackingNumberHash)) {
    throw new CoreError('InvalidRequest', 'Invalid shipment identity');
  }
  if (input.providerReferenceHash && !isHash(input.providerReferenceHash)) {
    throw new CoreError('InvalidRequest', 'Invalid provider reference hash');
  }
}

function validateIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new CoreError('InvalidRequest', 'idempotencyKey must contain 8-128 characters');
  }
}

function shipmentPayload(input: ShipmentInput): ShipmentInput {
  return {
    idempotencyKey: input.idempotencyKey,
    evidenceHash: input.evidenceHash,
    carrierCode: input.carrierCode,
    trackingNumberHash: input.trackingNumberHash,
    ...(input.providerReferenceHash ? { providerReferenceHash: input.providerReferenceHash } : {}),
  };
}

function validateCode(value: string, name: string) {
  if (!/^[A-Z0-9_:-]{2,64}$/.test(value)) throw new CoreError('InvalidRequest', `${name} is invalid`);
}

function normalizedWallet(value: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid actor wallet');
  return value.toLowerCase();
}

function pickupCodeHash(code: string, salt: string) {
  return sha256(`${salt}:${code}`);
}

function hashJson(value: unknown) {
  return `0x${sha256(stableJson(value))}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function canonicalAmount(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new CoreError('InvalidFinality', `${name} is unavailable from the immutable order snapshot`, 409);
  }
  return value;
}

function asDate(value: Date | null) {
  return value ? new Date(value) : null;
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

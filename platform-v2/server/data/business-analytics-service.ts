import {
  CORE_ARTIFACT_VERSION,
  breakerScopes,
  type BreakerScope,
  type CatalogProductLifecycleState,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { effectiveSeckillPhase, type StoredSeckillPhase } from './seckill-phase.ts';

const BUSINESS_TIMEZONE = 'Asia/Shanghai' as const;
const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1_000;

interface MerchantRow {
  merchant_id: string;
  status: string;
  guarantee_status: string;
  settlement_wallet: string;
}

interface ProductRow {
  product_id: string;
  title: string;
  lifecycle_state: CatalogProductLifecycleState;
  updated_at: Date;
  stock_total: string;
  stock_available: string;
  stock_reserved: string;
  session_id: string | null;
  session_phase: StoredSeckillPhase | null;
  session_starts_at: Date | null;
  session_main_deadline: Date | null;
  session_relay_deadline: Date | null;
  session_count: string;
}

interface PaymentAggregateRow {
  order_count: string;
  list_price_usdt: string;
  buyer_usdt_paid: string;
  merchant_base_receivable_usdt: string;
  merchant_net_receivable_usdt: string;
  shipped_count: string;
  exact_amounts_valid: boolean | null;
}

interface StateCountRow {
  state: string;
  count: string;
}

interface RequestCountRow {
  request_type: string;
  count: string;
}

export interface BusinessAnalyticsServiceInput {
  transactions: SqlTransactionRunner;
  clock?: () => Date;
}

export class BusinessAnalyticsService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: BusinessAnalyticsServiceInput) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  merchantDashboard(actor: FulfillmentActor) {
    if (!actor.roles.includes('MERCHANT') || !actor.merchantId) {
      throw new CoreError('Forbidden', 'Merchant dashboard requires a merchant-bound session', 403);
    }
    const now = validNow(this.#clock());
    const window = businessDay(now);
    return this.#transactions.transaction(async (executor) => {
      const merchant = await requireMerchantScope(executor, actor);
      const [product, payments, states, pickup, settlements] = await Promise.all([
        currentMerchantProduct(executor, merchant.merchant_id),
        paymentAggregate(executor, window, merchant.merchant_id),
        orderStateCounts(executor, merchant.merchant_id, true),
        pickupCount(executor, window, merchant.merchant_id),
        merchantSettlementToday(executor, window, merchant.settlement_wallet),
      ]);
      const stateCounts = countMap(states.rows);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        timezone: BUSINESS_TIMEZONE,
        window: windowProjection(window, now),
        merchant: {
          merchantId: merchant.merchant_id,
          status: merchant.status,
          guaranteeStatus: merchant.guarantee_status,
        },
        product: product ? merchantProductProjection(product, now) : null,
        orders: {
          finalizedToday: payments.order_count,
          pendingShipment: stateCounts.get('PAID') ?? '0',
          shipped: stateCounts.get('SHIPPED') ?? '0',
          delivered: stateCounts.get('DELIVERED') ?? '0',
          fulfilled: stateCounts.get('FULFILLED') ?? '0',
          arbitration: stateCounts.get('ARBITRATION') ?? '0',
          takeover: stateCounts.get('TAKEOVER') ?? '0',
          pickupVerifiedToday: pickup,
        },
        sales: {
          listPriceUsdt: payments.list_price_usdt,
          buyerUsdtPaid: payments.buyer_usdt_paid,
          merchantBaseReceivableUsdt: payments.merchant_base_receivable_usdt,
          merchantNetReceivableUsdt: payments.merchant_net_receivable_usdt,
        },
        shipmentRate: ratio(payments.shipped_count, payments.order_count),
        settlements,
      };
    });
  }

  adminDashboard(actor: FulfillmentActor) {
    assertPlatformReader(actor);
    const now = validNow(this.#clock());
    const window = businessDay(now);
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformScope(executor, actor);
      const [payments, states, buyers, merchants, products, sessions, requests, takeovers, settlements, coverage, breakers, risk] = await Promise.all([
        paymentAggregate(executor, window),
        orderStateCounts(executor),
        buyerUidCounts(executor, window),
        merchantCounts(executor, window),
        productCounts(executor),
        seckillCounts(executor, window, now),
        fulfillmentRequestCounts(executor),
        takeoverCount(executor),
        adminSettlementToday(executor, window),
        latestCoverage(executor, now),
        breakerProjection(executor),
        riskProjection(executor, window, now),
      ]);
      const stateCounts = countMap(states.rows);
      const requestCounts = countMap(requests.rows, 'request_type');
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        timezone: BUSINESS_TIMEZONE,
        window: windowProjection(window, now),
        orders: {
          finalizedToday: payments.order_count,
          listPriceUsdt: payments.list_price_usdt,
          buyerUsdtPaid: payments.buyer_usdt_paid,
          pendingShipment: stateCounts.get('PAID') ?? '0',
          shipped: stateCounts.get('SHIPPED') ?? '0',
          delivered: stateCounts.get('DELIVERED') ?? '0',
          fulfilled: stateCounts.get('FULFILLED') ?? '0',
          shipmentRate: ratio(payments.shipped_count, payments.order_count),
        },
        buyers,
        merchants,
        products,
        seckill: sessions,
        fulfillmentQueues: {
          exchange: requestCounts.get('EXCHANGE') ?? '0',
          delay: requestCounts.get('DELAY') ?? '0',
          arbitration: requestCounts.get('ARBITRATION') ?? '0',
          forcedReceipt: requestCounts.get('FORCED_RECEIPT') ?? '0',
          takeover: takeovers,
        },
        settlements,
        coverage: coverage.items,
        breakers,
        risk,
        unavailable: [
          { metric: 'LOW_STOCK_PRODUCTS', reasonCode: 'ExternalBlocked', detail: 'Below-100 low-stock count is not published by Core' },
          ...(coverage.unavailable ? [coverage.unavailable] : []),
        ],
      };
    });
  }
}

async function buyerUidCounts(executor: SqlExecutor, window: ReturnType<typeof businessDay>) {
  const result = await executor.query<{ total: string; new_today: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::text AS new_today
     FROM core.buyer_accounts`,
    [window.start, window.end],
  );
  return { total: result.rows[0]?.total ?? '0', newToday: result.rows[0]?.new_today ?? '0' };
}

function validNow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new CoreError('UnknownState', 'Business clock is invalid', 409);
  return now;
}

function businessDay(now: Date) {
  const local = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BUSINESS_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1_000) };
}

function windowProjection(window: ReturnType<typeof businessDay>, now: Date) {
  return { start: window.start.toISOString(), end: window.end.toISOString(), generatedAt: now.toISOString() };
}

async function requireMerchantScope(executor: SqlExecutor, actor: FulfillmentActor) {
  const wallet = actor.walletAddress.toLowerCase();
  const result = await executor.query<MerchantRow>(
    `SELECT merchant.merchant_id, merchant.status,
       merchant.guarantee_status, lower(merchant.settlement_wallet) AS settlement_wallet
     FROM core.wallet_role_bindings binding
     JOIN core.merchants merchant ON merchant.merchant_id = binding.merchant_id
     WHERE lower(binding.wallet_address) = $1 AND binding.role = 'MERCHANT'
       AND binding.status = 'ACTIVE' AND binding.merchant_id = $2`,
    [wallet, actor.merchantId],
  );
  const merchant = result.rows[0];
  if (!merchant) throw new CoreError('Forbidden', 'Merchant dashboard scope is unavailable', 403);
  return merchant;
}

async function requirePlatformScope(executor: SqlExecutor, actor: FulfillmentActor) {
  const wallet = actor.walletAddress.toLowerCase();
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE'
       AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, actor.roles.filter((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role))],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Platform dashboard scope is unavailable', 403);
}

function assertPlatformReader(actor: FulfillmentActor) {
  if (!actor.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role))) {
    throw new CoreError('Forbidden', 'Platform dashboard requires an authorized role', 403);
  }
}

async function currentMerchantProduct(executor: SqlExecutor, merchantId: string) {
  const result = await executor.query<ProductRow>(
    `SELECT product.product_id, product.title, product.lifecycle_state, product.updated_at,
       COALESCE(sum(sku.stock_total), 0)::text AS stock_total,
       COALESCE(sum(sku.stock_available), 0)::text AS stock_available,
       COALESCE(sum(sku.stock_reserved), 0)::text AS stock_reserved,
       session.session_id, session.phase AS session_phase, session.starts_at AS session_starts_at,
       session.main_deadline AS session_main_deadline,
       session.relay_deadline AS session_relay_deadline,
       COALESCE(session.session_count, 0)::text AS session_count
     FROM core.products product
     LEFT JOIN core.skus sku ON sku.product_id = product.product_id
     LEFT JOIN LATERAL (
       SELECT session_id, phase, starts_at, main_deadline, relay_deadline,
         count(*) OVER () AS session_count
       FROM core.seckill_sessions
       WHERE product_id = product.product_id AND phase NOT IN ('SETTLED','FORCE_CLOSED')
       ORDER BY starts_at, session_id LIMIT 1
     ) session ON true
     WHERE product.merchant_id = $1
     GROUP BY product.product_id, session.session_id, session.phase, session.starts_at,
       session.main_deadline, session.relay_deadline, session.session_count
     ORDER BY product.updated_at DESC, product.product_id DESC LIMIT 1`,
    [merchantId],
  );
  return result.rows[0] ?? null;
}

function merchantProductProjection(row: ProductRow, now: Date) {
  let state = row.lifecycle_state;
  if (state === 'ACTIVE' && BigInt(row.stock_available) + BigInt(row.stock_reserved) === 0n) state = 'SOLD_OUT';
  const seckill = seckillProjection(row, now);
  return {
    productId: row.product_id,
    title: row.title,
    state,
    stock: { total: row.stock_total, available: row.stock_available, reserved: row.stock_reserved },
    seckill,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function seckillProjection(row: ProductRow, now: Date) {
  if (!row.session_id) return null;
  if (BigInt(row.session_count) !== 1n) {
    throw new CoreError('UnknownState', 'Merchant dashboard has overlapping active seckill sessions', 409);
  }
  if (!row.session_phase || !row.session_starts_at || !row.session_main_deadline || !row.session_relay_deadline) {
    throw new CoreError('UnknownState', 'Merchant dashboard seckill projection is incomplete', 409);
  }
  return {
    sessionId: row.session_id,
    phase: effectiveSeckillPhase({
      phase: row.session_phase,
      starts_at: row.session_starts_at,
      main_deadline: row.session_main_deadline,
      relay_deadline: row.session_relay_deadline,
    }, now),
  };
}

async function paymentAggregate(executor: SqlExecutor, window: ReturnType<typeof businessDay>, merchantId?: string) {
  const result = await executor.query<PaymentAggregateRow>(
    `SELECT count(*)::text AS order_count,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts ->> 'listPriceUsdt')::numeric ELSE 0 END), 0)::text AS list_price_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts ->> 'usdtPaymentAmount')::numeric ELSE 0 END), 0)::text AS buyer_usdt_paid,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts ->> 'merchantBaseReceivableUsdt')::numeric ELSE 0 END), 0)::text AS merchant_base_receivable_usdt,
       COALESCE(sum(CASE WHEN cohort.exact_amounts_valid THEN (cohort.exact_amounts ->> 'merchantNetReceivableUsdt')::numeric ELSE 0 END), 0)::text AS merchant_net_receivable_usdt,
       count(*) FILTER (WHERE cohort.shipped_at IS NOT NULL)::text AS shipped_count,
       bool_and(cohort.exact_amounts_valid) AS exact_amounts_valid
     FROM (
       SELECT orders.*,
         COALESCE(
           (orders.exact_amounts ->> 'listPriceUsdt') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts ->> 'usdtPaymentAmount') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts ->> 'merchantBaseReceivableUsdt') ~ '^(0|[1-9][0-9]*)$'
           AND (orders.exact_amounts ->> 'merchantNetReceivableUsdt') ~ '^(0|[1-9][0-9]*)$',
           false
         ) AS exact_amounts_valid
       FROM core.orders orders
       JOIN LATERAL (
       SELECT finality.finalized_at FROM core.transaction_finality finality
       JOIN core.payment_events payment
         ON payment.order_id = orders.order_id
        AND payment.transaction_hash = finality.tx_hash
        AND payment.block_hash = finality.block_hash
       WHERE finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
         AND payment.canonical AND finality.state = 'FINAL' AND finality.receipt_status = 1
         AND finality.required_confirmations = 15
         AND finality.confirmations >= finality.required_confirmations
         AND finality.finalized_at >= $1 AND finality.finalized_at < $2
       ORDER BY finality.finalized_at DESC, finality.updated_at DESC, finality.transaction_id DESC LIMIT 1
       ) finality ON true
       WHERE ($3::text IS NULL OR orders.merchant_id = $3)
     ) cohort`,
    [window.start, window.end, merchantId ?? null],
  );
  const aggregate = result.rows[0] ?? zeroPaymentAggregate();
  if (BigInt(aggregate.order_count) > 0n && aggregate.exact_amounts_valid !== true) {
    throw new CoreError('UnknownState', 'Business analytics exact payment snapshot is invalid', 409);
  }
  return aggregate;
}

function zeroPaymentAggregate(): PaymentAggregateRow {
  return { order_count: '0', list_price_usdt: '0', buyer_usdt_paid: '0', merchant_base_receivable_usdt: '0', merchant_net_receivable_usdt: '0', shipped_count: '0', exact_amounts_valid: null };
}

function orderStateCounts(executor: SqlExecutor, merchantId?: string, deliveryPendingOnly = false) {
  return executor.query<StateCountRow>(
    `SELECT orders.state, count(*)::text AS count FROM core.orders orders
     WHERE ($1::text IS NULL OR orders.merchant_id = $1)
       AND (NOT $2::boolean OR orders.state <> 'PAID' OR orders.fulfillment_mode = 'DELIVERY')
       AND EXISTS (
         SELECT 1 FROM core.transaction_finality finality
         JOIN core.payment_events payment
           ON payment.order_id = orders.order_id
          AND payment.transaction_hash = finality.tx_hash
          AND payment.block_hash = finality.block_hash
         WHERE finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
           AND payment.canonical AND finality.state = 'FINAL' AND finality.receipt_status = 1
           AND finality.required_confirmations = 15
           AND finality.confirmations >= finality.required_confirmations
       )
     GROUP BY orders.state ORDER BY orders.state`,
    [merchantId ?? null, deliveryPendingOnly],
  );
}

async function pickupCount(executor: SqlExecutor, window: ReturnType<typeof businessDay>, merchantId: string) {
  const result = await executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM core.fulfillment_evidence evidence
     JOIN core.orders orders ON orders.order_id = evidence.order_id
     WHERE orders.merchant_id = $1 AND evidence.evidence_type = 'PICKUP_SCAN'
       AND evidence.recorded_at >= $2 AND evidence.recorded_at < $3`,
    [merchantId, window.start, window.end],
  );
  return result.rows[0]?.count ?? '0';
}

async function merchantSettlementToday(executor: SqlExecutor, window: ReturnType<typeof businessDay>, wallet: string) {
  const result = await executor.query<{ requested_count: string; requested_amount: string; settled_count: string; settled_amount: string }>(
    `SELECT
       count(*) FILTER (WHERE requested_at >= $2 AND requested_at < $3)::text AS requested_count,
       COALESCE(sum(amount) FILTER (WHERE requested_at >= $2 AND requested_at < $3), 0)::text AS requested_amount,
       count(*) FILTER (WHERE settled_at >= $2 AND settled_at < $3)::text AS settled_count,
       COALESCE(sum(amount) FILTER (WHERE settled_at >= $2 AND settled_at < $3), 0)::text AS settled_amount
     FROM core.settlement_requests WHERE wallet_address = $1 AND rail = 'MERCHANT_USDT'`,
    [wallet, window.start, window.end],
  );
  const row = result.rows[0];
  return { requestedCount: row?.requested_count ?? '0', requestedUsdt: row?.requested_amount ?? '0', settledCount: row?.settled_count ?? '0', settledUsdt: row?.settled_amount ?? '0' };
}

async function merchantCounts(executor: SqlExecutor, window: ReturnType<typeof businessDay>) {
  const result = await executor.query<{ total: string; new_today: string; pending: string; approved: string; suspended: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::text AS new_today,
       count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
       count(*) FILTER (WHERE status = 'APPROVED')::text AS approved,
       count(*) FILTER (WHERE status IN ('SUSPENDED','BLACKLISTED'))::text AS suspended
     FROM core.merchants`,
    [window.start, window.end],
  );
  const row = result.rows[0];
  return { total: row?.total ?? '0', newToday: row?.new_today ?? '0', pending: row?.pending ?? '0', approved: row?.approved ?? '0', suspended: row?.suspended ?? '0' };
}

async function productCounts(executor: SqlExecutor) {
  const result = await executor.query<{ total: string; pending_review: string; sold_out: string }>(
    `SELECT count(DISTINCT product.product_id)::text AS total,
       count(DISTINCT product.product_id) FILTER (WHERE product.lifecycle_state = 'REVIEW')::text AS pending_review,
       count(DISTINCT product.product_id) FILTER (WHERE product.lifecycle_state = 'SOLD_OUT' OR (
         product.lifecycle_state = 'ACTIVE' AND NOT EXISTS (
           SELECT 1 FROM core.skus active_sku WHERE active_sku.product_id = product.product_id
             AND (active_sku.stock_available > 0 OR active_sku.stock_reserved > 0)
         )
       ))::text AS sold_out
     FROM core.products product`,
  );
  const row = result.rows[0];
  return { total: row?.total ?? '0', pendingReview: row?.pending_review ?? '0', soldOut: row?.sold_out ?? '0' };
}

async function seckillCounts(executor: SqlExecutor, window: ReturnType<typeof businessDay>, now: Date) {
  const result = await executor.query<{
    phase: StoredSeckillPhase;
    starts_at: Date;
    main_deadline: Date;
    relay_deadline: Date;
    created_at: Date;
  }>(
    `SELECT phase, starts_at, main_deadline, relay_deadline, created_at
     FROM core.seckill_sessions ORDER BY session_id`,
  );
  let createdToday = 0n;
  let active = 0n;
  let settling = 0n;
  for (const row of result.rows) {
    const createdAt = new Date(row.created_at);
    if (createdAt >= window.start && createdAt < window.end) createdToday += 1n;
    const phase = effectiveSeckillPhase(row, now);
    if (phase === 'PREHEAT' || phase === 'LIVE') active += 1n;
    else if (phase === 'SETTLING') settling += 1n;
  }
  return { createdToday: String(createdToday), active: String(active), settling: String(settling) };
}

function fulfillmentRequestCounts(executor: SqlExecutor) {
  return executor.query<RequestCountRow>(
    `SELECT request_type, count(*)::text AS count FROM core.fulfillment_requests
     WHERE state = 'OPEN' GROUP BY request_type ORDER BY request_type`,
  );
}

async function takeoverCount(executor: SqlExecutor) {
  const result = await executor.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM core.takeover_cases WHERE state <> 'CLOSED'`,
  );
  return result.rows[0]?.count ?? '0';
}

async function adminSettlementToday(executor: SqlExecutor, window: ReturnType<typeof businessDay>) {
  const result = await executor.query<{ requested_count: string; requested_usdt: string; settled_count: string; settled_usdt: string; failed_transactions: string }>(
    `SELECT
       (SELECT count(*)::text FROM core.settlement_requests WHERE requested_at >= $1 AND requested_at < $2) AS requested_count,
       (SELECT COALESCE(sum(amount), 0)::text FROM core.settlement_requests WHERE asset = 'USDT' AND requested_at >= $1 AND requested_at < $2) AS requested_usdt,
       (SELECT count(*)::text FROM core.settlement_requests WHERE settled_at >= $1 AND settled_at < $2) AS settled_count,
       (SELECT COALESCE(sum(amount), 0)::text FROM core.settlement_requests WHERE asset = 'USDT' AND settled_at >= $1 AND settled_at < $2) AS settled_usdt,
       (SELECT count(*)::text FROM core.transaction_finality
        WHERE resource_type = 'SETTLEMENT_BATCH' AND state = 'FAILED' AND receipt_status = 0
          AND updated_at >= $1 AND updated_at < $2) AS failed_transactions`,
    [window.start, window.end],
  );
  const row = result.rows[0];
  return { requestedCount: row?.requested_count ?? '0', requestedUsdt: row?.requested_usdt ?? '0', settledCount: row?.settled_count ?? '0', settledUsdt: row?.settled_usdt ?? '0', failedTransactions: row?.failed_transactions ?? '0' };
}

async function latestCoverage(executor: SqlExecutor, now: Date) {
  const result = await executor.query<{
    snapshot_id: string;
    block_number: string;
    recorded_at: Date;
    canonical: boolean | null;
    asset: string | null;
    wallet_address: string | null;
    verified_asset_balance: string | null;
    unsettled_liability: string | null;
    coverage_met: boolean | null;
  }>(
    `WITH latest AS (
       SELECT snapshot.snapshot_id, snapshot.block_number, snapshot.recorded_at,
         canonicality.canonical
       FROM core.coverage_snapshots snapshot
       JOIN LATERAL (
         SELECT bool_and(observation.canonical) AS canonical
         FROM core.coverage_snapshot_canonicality observation
         WHERE observation.snapshot_id = snapshot.snapshot_id
           AND observation.observed_at = (
             SELECT max(last_observation.observed_at)
             FROM core.coverage_snapshot_canonicality last_observation
             WHERE last_observation.snapshot_id = snapshot.snapshot_id
           )
       ) canonicality ON true
       ORDER BY snapshot.recorded_at DESC, snapshot.block_number DESC, snapshot.snapshot_id DESC
       LIMIT 1
     )
     SELECT latest.snapshot_id, latest.block_number::text, latest.recorded_at,
       latest.canonical, item.asset, item.wallet_address,
       item.verified_asset_balance::text, item.unsettled_liability::text,
       item.coverage_met
     FROM latest LEFT JOIN core.coverage_snapshot_items item
       ON item.snapshot_id = latest.snapshot_id
     ORDER BY item.asset, item.wallet_address`,
  );
  const latest = result.rows[0];
  const unavailable = {
    metric: 'WALLET_COVERAGE',
    reasonCode: 'ExternalBlocked' as const,
    detail: 'Fresh canonical wallet coverage evidence is unavailable',
  };
  if (
    !latest
    || !latest.canonical
    || now.getTime() - new Date(latest.recorded_at).getTime() > 5 * 60_000
    || result.rows.some((row) => !row.asset || !row.wallet_address || row.coverage_met === null)
  ) return { items: [], unavailable };
  return {
    items: result.rows.map((row) => ({
      snapshotId: row.snapshot_id,
      blockNumber: row.block_number,
      recordedAt: new Date(row.recorded_at).toISOString(),
      asset: row.asset!,
      walletAddress: row.wallet_address!,
      verifiedAssets: row.verified_asset_balance!,
      unsettledLiabilities: row.unsettled_liability!,
      covered: row.coverage_met!,
    })),
    unavailable: null,
  };
}

async function breakerProjection(executor: SqlExecutor) {
  const result = await executor.query<{ scope: BreakerScope; paused: boolean }>(
    `SELECT scope, paused FROM core.circuit_breakers ORDER BY scope`,
  );
  const values = new Map(result.rows.map((row) => [row.scope, row.paused]));
  return breakerScopes.map((scope) => ({ scope, paused: values.get(scope) ?? false }));
}

async function riskProjection(executor: SqlExecutor, window: ReturnType<typeof businessDay>, now: Date) {
  const result = await executor.query<{
    abnormal_observations_today: string;
    blacklist_blocks_today: string;
    active_restrictions: string;
    pending_appeals: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM core.risk_observations
        WHERE observed_at >= $1 AND observed_at < $2) AS abnormal_observations_today,
       (SELECT count(*)::text FROM core.risk_restrictions
        WHERE restriction_kind = 'BLACKLIST' AND created_at >= $1 AND created_at < $2) AS blacklist_blocks_today,
       (SELECT count(*)::text FROM core.risk_restrictions
        WHERE state = 'ACTIVE' AND starts_at <= $3 AND (expires_at IS NULL OR expires_at > $3)) AS active_restrictions,
       (SELECT count(*)::text FROM core.risk_appeals WHERE state = 'PENDING') AS pending_appeals`,
    [window.start, window.end, now],
  );
  const row = result.rows[0];
  return {
    abnormalObservationsToday: row?.abnormal_observations_today ?? '0',
    blacklistBlocksToday: row?.blacklist_blocks_today ?? '0',
    activeRestrictions: row?.active_restrictions ?? '0',
    pendingAppeals: row?.pending_appeals ?? '0',
  };
}

function countMap(rows: Array<{ state?: string; request_type?: string; count: string }>, key: 'state' | 'request_type' = 'state') {
  return new Map(rows.map((row) => [row[key]!, row.count]));
}

function ratio(numerator: string, denominator: string) {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  return { numerator, denominator, bps: bottom === 0n ? null : ((top * 10_000n) / bottom).toString() };
}

import { CORE_ARTIFACT_VERSION, type BalanceState } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { FulfillmentActor, OrderKind } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export interface OrderStatementQuery {
  kind?: OrderKind;
  cursorCreatedAt?: Date;
  cursorOrderId?: string;
  limit?: number;
}

interface OrderRow {
  order_id: string;
  buyer_wallet: string;
  merchant_id: string;
  merchant_wallet: string;
  product_id: string;
  sku_id: string;
  quantity: string | number;
  state: string;
  exact_amounts: Record<string, unknown>;
  payment_tx_hash: string;
  classification: OrderKind;
  confirmations: string | number;
  required_confirmations: string | number;
  payment_finalized_at: Date | string;
  fulfilled_at: Date | string | null;
  created_at: Date | string;
}

interface BalanceRow {
  order_id: string;
  balance_state: BalanceState;
  amount: string;
  journal_ids: string[];
}

interface JournalRow {
  order_id: string;
  journal_id: string;
  event_type: string;
  balance_state: BalanceState;
  delta: string;
  source_kind: string;
  source_reference_hash: string;
  created_at: Date | string;
}

interface SettlementRow {
  order_id: string;
  request_id: string;
  amount: string;
  state: string;
  transfer_id: string | null;
  final_execution_tx_hash: string | null;
  requested_journal_id: string;
  submitted_journal_id: string | null;
  settled_journal_id: string | null;
  requested_at: Date | string;
  submitted_at: Date | string | null;
  settled_at: Date | string | null;
}

export class OrderStatementService {
  readonly #transactions: SqlTransactionRunner;

  constructor(input: { transactions: SqlTransactionRunner }) {
    this.#transactions = input.transactions;
  }

  listBuyerShopping(actor: FulfillmentActor, input: OrderStatementQuery = {}) {
    const query = statementQuery(input, false);
    const wallet = normalizedWallet(actor.walletAddress);
    if (!actor.roles.includes('BUYER')) throw new CoreError('Forbidden', 'Buyer role is required', 403);
    return this.#transactions.transaction(async (executor) => {
      await requireActiveBinding(executor, wallet, 'BUYER');
      const result = await loadOrders(executor, { ...query, buyerWallet: wallet, excludeSeckill: true });
      const page = result.rows.slice(0, query.limit);
      const orderIds = page.map((row) => row.order_id);
      const balances = await loadBalances(executor, orderIds, {
        ownerType: 'BUYER', ownerId: wallet, asset: 'BNM_POINTS', purposes: ['BNM_LIABILITY'],
      });
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        buyerWallet: wallet,
        statements: page.map((row) => buyerStatement(row, balances.get(row.order_id) ?? [])),
        nextCursor: cursor(result.rows.length, query.limit, page.at(-1)),
      };
    });
  }

  listMerchantReceivables(actor: FulfillmentActor, input: OrderStatementQuery = {}) {
    const query = statementQuery(input, true);
    const wallet = normalizedWallet(actor.walletAddress);
    if (!actor.roles.includes('MERCHANT') || !actor.merchantId) {
      throw new CoreError('Forbidden', 'Merchant role and tenant are required', 403);
    }
    const merchantId = actor.merchantId;
    return this.#transactions.transaction(async (executor) => {
      await requireActiveBinding(executor, wallet, 'MERCHANT', merchantId);
      const merchant = await executor.query<{ settlement_wallet: string }>(
        `SELECT settlement_wallet FROM core.merchants
         WHERE merchant_id = $1 AND lower(settlement_wallet) = $2`,
        [merchantId, wallet],
      );
      if (!merchant.rows[0]) throw new CoreError('Forbidden', 'Merchant settlement scope is invalid', 403);
      const result = await loadOrders(executor, { ...query, merchantId });
      const page = result.rows.slice(0, query.limit);
      const orderIds = page.map((row) => row.order_id);
      const owner = {
        ownerType: 'MERCHANT',
        ownerId: wallet,
        asset: 'USDT',
        purposes: ['MERCHANT_RECEIVABLE', 'MERCHANT_FREIGHT_RECEIVABLE'],
      } as const;
      const [balances, journals, settlements] = await Promise.all([
        loadBalances(executor, orderIds, owner),
        loadJournals(executor, orderIds, owner),
        loadSettlements(executor, orderIds, wallet),
      ]);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        merchantId,
        settlementWallet: wallet,
        statements: page.map((row) => merchantStatement(
          row,
          balances.get(row.order_id) ?? [],
          journals.get(row.order_id) ?? [],
          settlements.get(row.order_id) ?? [],
        )),
        nextCursor: cursor(result.rows.length, query.limit, page.at(-1)),
      };
    });
  }
}

function statementQuery(input: OrderStatementQuery, allowSeckill: boolean) {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CoreError('InvalidRequest', 'Statement limit must be between 1 and 100');
  }
  if ((input.cursorCreatedAt === undefined) !== (input.cursorOrderId === undefined)) {
    throw new CoreError('InvalidRequest', 'Statement cursor fields must be supplied together');
  }
  if (input.cursorCreatedAt && !Number.isFinite(input.cursorCreatedAt.getTime())) {
    throw new CoreError('InvalidRequest', 'Statement cursor time is invalid');
  }
  if (input.cursorOrderId !== undefined && (input.cursorOrderId.length < 1 || input.cursorOrderId.length > 256)) {
    throw new CoreError('InvalidRequest', 'Statement cursor order ID is invalid');
  }
  if (input.kind && !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(input.kind)) {
    throw new CoreError('InvalidRequest', 'Statement order kind is invalid');
  }
  if (!allowSeckill && input.kind === 'SECKILL') {
    throw new CoreError('DecisionBlocked', 'Buyer seckill prize statement is not yet ledger-authoritative', 409);
  }
  return { ...input, limit };
}

async function loadOrders(
  executor: SqlExecutor,
  input: ReturnType<typeof statementQuery> & {
    buyerWallet?: string;
    merchantId?: string;
    excludeSeckill?: boolean;
  },
) {
  const params: unknown[] = [];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const clauses = [
    "finality.state = 'FINAL'",
    'finality.receipt_status = 1',
    'finality.confirmations >= finality.required_confirmations',
    'payment.canonical = true',
    'payment.transaction_hash = orders.payment_tx_hash',
  ];
  if (input.buyerWallet) clauses.push(`orders.buyer_wallet = ${add(input.buyerWallet)}`);
  if (input.merchantId) clauses.push(`orders.merchant_id = ${add(input.merchantId)}`);
  if (input.excludeSeckill) clauses.push("payment.classification <> 'SECKILL'");
  if (input.kind) clauses.push(`payment.classification = ${add(input.kind)}`);
  if (input.cursorCreatedAt && input.cursorOrderId) {
    clauses.push(`(orders.created_at, orders.order_id) < (${add(input.cursorCreatedAt)}, ${add(input.cursorOrderId)})`);
  }
  params.push(input.limit + 1);
  return executor.query<OrderRow>(
    `SELECT orders.order_id, lower(orders.buyer_wallet) AS buyer_wallet,
       orders.merchant_id, lower(orders.merchant_wallet) AS merchant_wallet,
       orders.product_id, orders.sku_id, orders.quantity, orders.state,
       orders.exact_amounts, lower(orders.payment_tx_hash) AS payment_tx_hash,
       payment.classification, finality.confirmations, finality.required_confirmations,
       finality.finalized_at AS payment_finalized_at, orders.fulfilled_at, orders.created_at
     FROM core.orders orders
     JOIN core.payment_events payment ON payment.order_id = orders.order_id
     JOIN core.transaction_finality finality
       ON finality.resource_type = 'ORDER_PAYMENT' AND finality.resource_id = orders.order_id
       AND finality.tx_hash = payment.transaction_hash
     WHERE ${clauses.join(' AND ')}
     ORDER BY orders.created_at DESC, orders.order_id DESC
     LIMIT $${params.length}`,
    params,
  );
}

async function loadBalances(
  executor: SqlExecutor,
  orderIds: string[],
  owner: { ownerType: string; ownerId: string; asset: string; purposes: readonly string[] },
) {
  const grouped = new Map<string, BalanceRow[]>();
  if (orderIds.length === 0) return grouped;
  const result = await executor.query<BalanceRow>(
    `SELECT journal.order_id,
       CASE WHEN line.balance_state = 'DISPUTED' AND $3 = 'BNM_POINTS'
         THEN 'LOCKED' ELSE line.balance_state END AS balance_state,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount,
       array_agg(DISTINCT journal.journal_id ORDER BY journal.journal_id) AS journal_ids
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = ANY($1::text[]) AND account.owner_type = $2
       AND account.asset = $3 AND account.purpose = ANY($4::text[]) AND lower(account.owner_id) = $5
       AND line.balance_state <> 'POSTED'
     GROUP BY journal.order_id,
       CASE WHEN line.balance_state = 'DISPUTED' AND $3 = 'BNM_POINTS'
         THEN 'LOCKED' ELSE line.balance_state END
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY journal.order_id, balance_state`,
    [orderIds, owner.ownerType, owner.asset, [...owner.purposes], owner.ownerId],
  );
  for (const row of result.rows) append(grouped, row.order_id, row);
  return grouped;
}

async function loadJournals(
  executor: SqlExecutor,
  orderIds: string[],
  owner: { ownerType: string; ownerId: string; asset: string; purposes: readonly string[] },
) {
  const grouped = new Map<string, JournalRow[]>();
  if (orderIds.length === 0) return grouped;
  const result = await executor.query<JournalRow>(
    `SELECT journal.order_id, journal.journal_id, journal.event_type,
       line.balance_state,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS delta,
       journal.source_kind, journal.source_reference_hash, journal.created_at
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = ANY($1::text[]) AND account.owner_type = $2
       AND account.asset = $3 AND account.purpose = ANY($4::text[]) AND lower(account.owner_id) = $5
       AND line.balance_state <> 'POSTED'
     GROUP BY journal.order_id, journal.journal_id, journal.event_type,
       line.balance_state, journal.source_kind, journal.source_reference_hash, journal.created_at
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY journal.order_id, journal.created_at, journal.journal_id, line.balance_state`,
    [orderIds, owner.ownerType, owner.asset, [...owner.purposes], owner.ownerId],
  );
  for (const row of result.rows) append(grouped, row.order_id, row);
  return grouped;
}

async function loadSettlements(executor: SqlExecutor, orderIds: string[], wallet: string) {
  const grouped = new Map<string, SettlementRow[]>();
  if (orderIds.length === 0) return grouped;
  const result = await executor.query<SettlementRow>(
    `SELECT item.order_id, request.request_id, item.amount::text, request.state,
       transfer.transfer_id, final_attempt.execution_tx_hash AS final_execution_tx_hash,
       item.requested_journal_id, item.submitted_journal_id, item.settled_journal_id,
       request.requested_at, request.submitted_at, request.settled_at
     FROM core.settlement_request_items item
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     JOIN core.ledger_accounts account ON account.account_id = item.account_id
     LEFT JOIN core.settlement_transfers transfer
       ON transfer.request_id = item.request_id AND transfer.request_item_index = item.item_index
     LEFT JOIN LATERAL (
       SELECT attempt.execution_tx_hash
       FROM core.settlement_transfer_attempts attempt
       WHERE attempt.transfer_id = transfer.transfer_id AND attempt.state = 'SETTLED'
       ORDER BY attempt.attempt_number DESC LIMIT 1
     ) final_attempt ON true
     WHERE item.order_id = ANY($1::text[]) AND request.wallet_address = $2
       AND request.rail = 'MERCHANT_USDT'
       AND account.purpose IN ('MERCHANT_RECEIVABLE','MERCHANT_FREIGHT_RECEIVABLE')
     ORDER BY item.order_id, request.requested_at, request.request_id`,
    [orderIds, wallet],
  );
  for (const row of result.rows) append(grouped, row.order_id, row);
  return grouped;
}

function buyerStatement(row: OrderRow, balances: BalanceRow[]) {
  const amounts = exactAmounts(row.exact_amounts);
  if (balances.length !== 1 || !['LOCKED', 'AVAILABLE'].includes(balances[0]!.balance_state)) {
    throw new CoreError('UnknownState', 'Buyer BNM statement is not authoritative', 409);
  }
  const bnm = balances[0]!;
  if (bnm.amount !== amounts.bnmAmount) throw new CoreError('UnknownState', 'Buyer BNM statement does not reconcile', 409);
  return {
    ...baseStatement(row),
    orderKind: row.classification as Exclude<OrderKind, 'SECKILL'>,
    paymentAmounts: {
      productUsdtPaymentAmount: amounts.productUsdtPaymentAmount,
      platformServiceFeeUsdt: amounts.platformServiceFeeUsdt,
      custodyProductUsdt: amounts.custodyProductUsdt,
      freightUsdt: amounts.freightUsdt,
      usdtPaymentAmount: amounts.usdtPaymentAmount,
      nplPaymentAmount: amounts.nplPaymentAmount,
    },
    bnm: {
      amount: bnm.amount,
      state: bnm.balance_state as 'LOCKED' | 'AVAILABLE',
      transferable: false as const,
      journalIds: bnm.journal_ids,
    },
  };
}

function merchantStatement(
  row: OrderRow,
  balances: BalanceRow[],
  journals: JournalRow[],
  settlements: SettlementRow[],
) {
  const amounts = exactAmounts(row.exact_amounts);
  const current = balances.reduce((sum, balance) => sum + BigInt(balance.amount), 0n);
  const snapshot = BigInt(amounts.merchantNetReceivableUsdt) + BigInt(amounts.freightUsdt);
  if (current > snapshot) throw new CoreError('UnknownState', 'Merchant receivable exceeds the frozen order snapshot', 409);
  return {
    ...baseStatement(row),
    orderKind: row.classification,
    frozenAmounts: {
      listPriceUsdt: amounts.listPriceUsdt,
      productUsdtPaymentAmount: amounts.productUsdtPaymentAmount,
      platformServiceFeeUsdt: amounts.platformServiceFeeUsdt,
      custodyProductUsdt: amounts.custodyProductUsdt,
      freightUsdt: amounts.freightUsdt,
      buyerPaidUsdt: amounts.usdtPaymentAmount,
      merchantBaseReceivableUsdt: amounts.merchantBaseReceivableUsdt,
      merchantConcessionAmount: amounts.merchantConcessionAmount,
      merchantNetReceivableUsdt: amounts.merchantNetReceivableUsdt,
    },
    currentReceivableUsdt: current.toString(),
    removedFromReceivableUsdt: (snapshot - current).toString(),
    receivableLifecycle: balances.map((balance) => ({
      state: balance.balance_state,
      amount: balance.amount,
      journalIds: balance.journal_ids,
    })),
    journalEvidence: journals.map((journal) => ({
      journalId: journal.journal_id,
      eventType: journal.event_type,
      state: journal.balance_state,
      delta: journal.delta,
      sourceKind: journal.source_kind,
      sourceReferenceHash: journal.source_reference_hash,
      createdAt: iso(journal.created_at),
    })),
    settlementRefs: settlements.map((settlement) => ({
      requestId: settlement.request_id,
      amount: settlement.amount,
      state: settlement.state,
      transferId: settlement.transfer_id,
      finalExecutionTxHash: settlement.final_execution_tx_hash,
      journals: {
        requested: settlement.requested_journal_id,
        submitted: settlement.submitted_journal_id,
        settled: settlement.settled_journal_id,
      },
      requestedAt: iso(settlement.requested_at),
      submittedAt: nullableIso(settlement.submitted_at),
      settledAt: nullableIso(settlement.settled_at),
    })),
  };
}

function baseStatement(row: OrderRow) {
  if (Number(row.confirmations) < Number(row.required_confirmations)) {
    throw new CoreError('InvalidFinality', 'Statement payment has insufficient confirmations', 409);
  }
  return {
    orderId: row.order_id,
    productId: row.product_id,
    skuId: row.sku_id,
    quantity: String(row.quantity),
    orderState: row.state,
    paymentTxHash: row.payment_tx_hash,
    paymentFinalizedAt: iso(row.payment_finalized_at),
    fulfilledAt: nullableIso(row.fulfilled_at),
    createdAt: iso(row.created_at),
  };
}

function exactAmounts(value: Record<string, unknown>) {
  return {
    listPriceUsdt: atomic(value.listPriceUsdt, 'listPriceUsdt'),
    productUsdtPaymentAmount: atomic(value.productUsdtPaymentAmount, 'productUsdtPaymentAmount'),
    platformServiceFeeUsdt: atomic(value.platformServiceFeeUsdt, 'platformServiceFeeUsdt'),
    custodyProductUsdt: atomic(value.custodyProductUsdt, 'custodyProductUsdt'),
    freightUsdt: atomic(value.freightUsdt, 'freightUsdt'),
    usdtPaymentAmount: atomic(value.usdtPaymentAmount, 'usdtPaymentAmount'),
    nplPaymentAmount: atomic(value.nplPaymentAmount, 'nplPaymentAmount'),
    merchantBaseReceivableUsdt: atomic(value.merchantBaseReceivableUsdt, 'merchantBaseReceivableUsdt'),
    merchantConcessionAmount: atomic(value.merchantConcessionAmount, 'merchantConcessionAmount'),
    merchantNetReceivableUsdt: atomic(value.merchantNetReceivableUsdt, 'merchantNetReceivableUsdt'),
    bnmAmount: atomic(value.bnmAmount, 'bnmAmount'),
  };
}

async function requireActiveBinding(
  executor: SqlExecutor,
  wallet: string,
  role: 'BUYER' | 'MERCHANT',
  merchantId?: string,
) {
  const result = await executor.query<{ wallet_address: string }>(
    `SELECT wallet_address FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND role = $2 AND status = 'ACTIVE'
       AND ($3::text IS NULL OR merchant_id = $3)`,
    [wallet, role, merchantId ?? null],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', `${role} binding is not active`, 403);
}

function cursor(rowCount: number, limit: number, row: OrderRow | undefined) {
  return rowCount > limit && row
    ? { createdAt: iso(row.created_at), orderId: row.order_id }
    : null;
}

function append<T>(map: Map<string, T[]>, key: string, value: T) {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function atomic(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CoreError('UnknownState', `Statement ${label} is invalid`, 409);
  }
  return value;
}

function normalizedWallet(value: string) {
  const wallet = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new CoreError('Forbidden', 'Wallet identity is invalid', 403);
  return wallet;
}

function iso(value: Date | string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CoreError('UnknownState', 'Statement timestamp is invalid', 409);
  return date.toISOString();
}

function nullableIso(value: Date | string | null) {
  return value === null ? null : iso(value);
}

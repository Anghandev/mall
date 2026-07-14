import { createHash } from 'node:crypto';
import { buildPaymentIntent, type CanonicalPaymentIntent } from '../api/checkout.ts';
import { CoreError } from '../api/errors.ts';
import { buildOtherUsdtAllocations, parsePaymentPolicySnapshot } from '../api/payment-policy.ts';
import { paymentIntentHash } from '../api/payment-signing.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const REQUIRED_CONFIRMATIONS = 15;
const USDT = 'USDT';
const NPL = 'NPL';
const BNM = 'BNM_POINTS';

interface PaymentEventRow {
  event_key: string;
  order_id: string;
  journal_id: string;
  transaction_hash: string;
  block_hash: string;
  snapshot_hash: string;
  confirmations: string | number;
  canonical: boolean;
}

interface JournalLineRow {
  account_id: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  balance_state: LedgerLine['balanceState'];
}

interface LedgerLine {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  balanceState: 'POSTED' | 'LOCKED' | 'AVAILABLE' | 'REQUESTED' | 'BATCHED' | 'SETTLED' | 'DISPUTED';
}

interface LedgerAccount {
  accountId: string;
  ownerType: 'SYSTEM' | 'SAFE' | 'MERCHANT' | 'BUYER' | 'BENEFICIARY';
  ownerId: string;
  asset: typeof USDT | typeof NPL | typeof BNM;
  purpose:
    | 'SAFE_ASSET'
    | 'PAYMENT_CLEARING'
    | 'BURN'
    | 'MERCHANT_RECEIVABLE'
    | 'CONCESSION'
    | 'POLICY_ALLOCATION'
    | 'REWARD_LIABILITY'
    | 'BNM_ISSUANCE'
    | 'BNM_LIABILITY';
  safeAddress?: string;
}

interface LedgerAccountRow {
  owner_type: LedgerAccount['ownerType'];
  owner_id: string;
  asset: LedgerAccount['asset'];
  purpose: LedgerAccount['purpose'];
  safe_address: string | null;
}

export interface CanonicalPaymentEvent {
  artifactVersion: string;
  orderId: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: Date;
  contractAddress: string;
  eventHash: string;
  snapshotHash: string;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
  buyer: string;
  merchant: string;
  policyVersion: number;
  listPriceUsdt: string;
  usdtPaid: string;
  nplPaid: string;
  nplBurned: string;
  nplRewarded: string;
  bnmLocked: string;
  reservationId: string;
  confirmations: number;
  replacementForTxHash?: string;
}

export interface RecordPaymentInput {
  event: CanonicalPaymentEvent;
}

export class PostgresPaymentStore {
  readonly #transactions: SqlTransactionRunner;

  constructor(transactions: SqlTransactionRunner) {
    this.#transactions = transactions;
  }

  record(input: RecordPaymentInput) {
    validatePaymentInput(input);
    return this.#transactions.transaction((executor) => recordPaymentProjection(executor, input));
  }

  reverse(eventKey: string, replacementBlockHash: string) {
    if (!isHash(replacementBlockHash)) throw new CoreError('InvalidFinality', 'Invalid replacement block hash');
    return this.#transactions.transaction((executor) => reversePaymentProjection(executor, eventKey, replacementBlockHash));
  }
}

export async function recordPaymentProjection(executor: SqlExecutor, input: RecordPaymentInput) {
  const eventKey = paymentEventKey(input.event.transactionHash, input.event.logIndex, input.event.blockHash);
  const existing = await executor.query<PaymentEventRow>(
    'SELECT * FROM core.payment_events WHERE event_key = $1 FOR UPDATE',
    [eventKey],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.order_id !== input.event.orderId || row.snapshot_hash.toLowerCase() !== input.event.snapshotHash.toLowerCase()) {
      throw new CoreError('InvalidRequest', 'Payment event idempotency conflict', 409);
    }
    return { status: 'IDEMPOTENT' as const, orderId: row.order_id, journalId: row.journal_id };
  }

  const quote = await loadQuoteContext(executor, input.event);
  const intent = quote.intent;
  const unitListPrice = input.event.classification === 'SECKILL'
    ? quote.seckillListPriceUsdt
    : quote.listPriceUsdt;
  if (unitListPrice === undefined) throw new CoreError('InvalidFinality', 'Seckill price snapshot is unavailable', 409);
  const policy = parsePaymentPolicySnapshot(quote.policyVersion, quote.oracleVersion, quote.policyPayload);
  const rebuilt = buildPaymentIntent(
    {
      orderId: input.event.orderId,
      latestPolicyVersion: quote.policyVersion,
      buyer: quote.buyerWallet,
      merchant: quote.merchantWallet,
      productId: quote.chainProductId,
      skuId: quote.chainSkuId,
      quantity: intent.quantity,
      fulfillmentMode: intent.fulfillmentMode,
      fulfillmentTargetHash: intent.fulfillmentTargetHash,
      regionCodeHash: intent.regionCodeHash,
      productPolicyHash: quote.productPolicyHash,
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      reservationDeadline: intent.reservationDeadline,
      issuedAt: intent.issuedAt,
      deadline: intent.deadline,
      nonce: BigInt(intent.nonce),
      listPriceUsdt: unitListPrice * BigInt(intent.quantity),
      nplQuoteAmount: BigInt(intent.nplQuoteAmount),
      merchantBaseReceivableUsdt: quote.merchantCostUsdt * BigInt(intent.quantity),
      merchantConcessionBps: quote.merchantConcessionBps,
      otherUsdtAllocations: buildOtherUsdtAllocations(
        unitListPrice * BigInt(intent.quantity),
        quote.merchantCostUsdt * BigInt(intent.quantity),
        policy,
      ),
      ...(intent.seckill ? { sessionId: intent.sessionId } : {}),
      beneficiaries: intent.beneficiaries,
    },
    policy,
    input.event.classification,
    intent.issuedAt,
  );
  if (stableJson(rebuilt) !== stableJson(intent)) {
    throw new CoreError('InvalidFinality', 'Persisted payment quote does not match authoritative catalog and policy', 409);
  }

  const priorOrder = await executor.query<{ state: string; quote_snapshot: CanonicalPaymentIntent }>(
    'SELECT state, quote_snapshot FROM core.orders WHERE order_id = $1 FOR UPDATE',
    [intent.orderId],
  );
  if (priorOrder.rows[0] && priorOrder.rows[0].state !== 'REORG_PENDING') {
    throw new CoreError('InvalidRequest', 'Order already has a canonical payment', 409);
  }
  if (priorOrder.rows[0] && stableJson(priorOrder.rows[0].quote_snapshot) !== stableJson(intent)) {
    if (priorOrder.rows[0].state === 'REORG_PENDING') {
      await quarantineDeepReorgPayment(executor, input.event, eventKey, 'ALTERNATE_SIGNED_LEG');
      return { status: 'QUARANTINED' as const, orderId: intent.orderId };
    }
    throw new CoreError('InvalidRequest', 'Replacement payment changed the immutable quote snapshot', 409);
  }

  const reservation = await executor.query<{
    reservation_hash: string;
    policy_version: string;
    sku_id: string;
    buyer_wallet: string;
    quantity: string;
    classification: string;
    state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
    consumed_order_id: string | null;
  }>(
    `SELECT reservation_hash, policy_version, sku_id, buyer_wallet, quantity, classification,
       state, consumed_order_id
     FROM core.inventory_reservations WHERE reservation_id = $1 FOR UPDATE`,
    [intent.reservationId],
  );
  const reserved = reservation.rows[0];
  if (
    !reserved || reserved.reservation_hash.toLowerCase() !== intent.reservationHash.toLowerCase()
      || Number(reserved.policy_version) !== intent.policyVersion || reserved.sku_id !== quote.skuId
      || reserved.buyer_wallet.toLowerCase() !== intent.buyer.toLowerCase()
      || BigInt(reserved.quantity) !== BigInt(intent.quantity)
      || reserved.classification !== input.event.classification
  ) throw new CoreError('InvalidRequest', 'Payment event does not match the inventory reservation', 409);

  if (priorOrder.rows[0]?.state === 'REORG_PENDING') {
    if (reserved.state === 'ACTIVE') {
      await executor.query('SELECT core.consume_reorged_inventory_reservation($1, $2)', [
        intent.reservationId,
        intent.orderId,
      ]);
    } else if (reserved.state !== 'CONSUMED' || reserved.consumed_order_id !== intent.orderId) {
      await quarantineDeepReorgPayment(executor, input.event, eventKey, reserved.state);
      return { status: 'QUARANTINED' as const, orderId: intent.orderId };
    }
  } else {
    await executor.query('SELECT core.consume_inventory_reservation_at($1, $2, $3)', [
      intent.reservationId,
      intent.orderId,
      input.event.blockTimestamp,
    ]);
  }

  const finalityState = input.event.confirmations >= REQUIRED_CONFIRMATIONS ? 'FINAL' : 'PENDING';
  if (!priorOrder.rows[0]) {
    await executor.query(
      `INSERT INTO core.orders (
         order_id, artifact_version, policy_version, oracle_version, buyer_wallet,
         merchant_id, merchant_wallet, product_id, sku_id, quantity, fulfillment_mode,
         fulfillment_target_hash, region_code_hash, product_policy_hash, reservation_id,
         quote_snapshot, allocation_snapshot, seckill_snapshot, exact_amounts, buyer_nonce,
         quote_deadline, state, finality_status, payment_tx_hash, payment_block_hash, paid_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,'PAID',$22,$23,$24,$25
       )`,
      [
        intent.orderId,
        input.event.artifactVersion,
        intent.policyVersion,
        intent.oracleVersion,
        intent.buyer,
        quote.merchantId,
        intent.merchant,
        quote.productId,
        quote.skuId,
        intent.quantity,
        intent.fulfillmentMode,
        intent.fulfillmentTargetHash,
        intent.regionCodeHash,
        intent.productPolicyHash,
        intent.reservationId,
        JSON.stringify(intent),
        JSON.stringify({
          beneficiaries: intent.beneficiaries,
          concession: intent.merchantConcessionAllocations,
          otherUsdt: intent.otherUsdtAllocations,
          nplRewards: intent.nplRewardAllocations,
        }),
        intent.seckill ? JSON.stringify({ sessionId: intent.sessionId, classification: input.event.classification }) : null,
        JSON.stringify(exactAmounts(intent)),
        intent.nonce,
        new Date(intent.deadline * 1000),
        finalityState,
        input.event.transactionHash,
        input.event.blockHash,
        input.event.blockTimestamp,
      ],
    );
  } else {
    await executor.query(
      `UPDATE core.orders SET state = 'PAID', finality_status = $2,
         payment_tx_hash = $3, payment_block_hash = $4, paid_at = $5,
         updated_at = clock_timestamp() WHERE order_id = $1`,
      [intent.orderId, finalityState, input.event.transactionHash, input.event.blockHash, input.event.blockTimestamp],
    );
  }

  const safes = { usdtCustodySafe: policy.usdtCustodySafe!, nplRewardSafe: policy.nplRewardSafe! };
  const { accounts, lines } = paymentJournal(intent, safes);
  for (const account of accounts) await ensureAccount(executor, account);
  const journalId = `payment:${intent.orderId}:${eventKey}`;
  const contentHash = hashJson({ eventKey, intent, lines });
  await postJournal(executor, {
    journalId,
    eventKey,
    eventType: 'PAYMENT_LOCKED',
    orderId: intent.orderId,
    policyVersion: intent.policyVersion,
    contentHash,
    sourceTxHash: input.event.transactionHash,
    sourceBlockHash: input.event.blockHash,
    payload: { classification: input.event.classification, snapshotHash: input.event.snapshotHash },
    lines,
  });

  await executor.query(
    `INSERT INTO core.payment_events (
       event_key, order_id, journal_id, transaction_hash, log_index, block_number,
       block_hash, snapshot_hash, classification, confirmations, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      eventKey,
      intent.orderId,
      journalId,
      input.event.transactionHash,
      input.event.logIndex,
      input.event.blockNumber,
      input.event.blockHash,
      input.event.snapshotHash,
      input.event.classification,
      input.event.confirmations,
      input.event.blockTimestamp,
    ],
  );
  await executor.query(
    `INSERT INTO core.transaction_finality (
       transaction_id, resource_type, resource_id, chain_id, contract_address,
       expected_event_hash, tx_hash, replacement_for_tx_hash, block_number,
       block_hash, confirmations, required_confirmations, receipt_status, state,
       evidence, submitted_at, finalized_at
     ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,$6,$7,$8,$9,15,1,$10,$11,$12,$13)
     ON CONFLICT (transaction_id) DO UPDATE SET
       contract_address = EXCLUDED.contract_address,
       expected_event_hash = EXCLUDED.expected_event_hash,
       replacement_for_tx_hash = COALESCE(EXCLUDED.replacement_for_tx_hash, core.transaction_finality.replacement_for_tx_hash),
       block_number = EXCLUDED.block_number,
       block_hash = EXCLUDED.block_hash,
       confirmations = EXCLUDED.confirmations,
       receipt_status = EXCLUDED.receipt_status,
       state = EXCLUDED.state,
       evidence = EXCLUDED.evidence,
       submitted_at = EXCLUDED.submitted_at,
       finalized_at = EXCLUDED.finalized_at,
       updated_at = clock_timestamp()`,
    [
      `payment:${eventKey}`,
      intent.orderId,
      input.event.contractAddress,
      input.event.eventHash,
      input.event.transactionHash,
      input.event.replacementForTxHash ?? null,
      input.event.blockNumber,
      input.event.blockHash,
      input.event.confirmations,
      input.event.confirmations >= REQUIRED_CONFIRMATIONS ? 'FINAL' : 'MINED',
      JSON.stringify({ snapshotHash: input.event.snapshotHash, eventKey }),
      input.event.blockTimestamp,
      input.event.confirmations >= REQUIRED_CONFIRMATIONS ? input.event.blockTimestamp : null,
    ],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'ORDER',$2,'PaymentIndexed',$3,$4,'PENDING')`,
    [`outbox:${eventKey}`, intent.orderId, JSON.stringify({ eventKey, journalId }), `payment-indexed:${eventKey}`],
  );
  await executor.query(
    `UPDATE core.payment_quotes SET state = 'PAID', submitted_tx_hash = $2,
       submitted_at = COALESCE(submitted_at, $3), updated_at = clock_timestamp() WHERE order_id = $1`,
    [intent.orderId, input.event.transactionHash, input.event.blockTimestamp],
  );
  return { status: 'RECORDED' as const, orderId: intent.orderId, journalId };
}

export async function reversePaymentProjection(executor: SqlExecutor, eventKey: string, replacementBlockHash: string) {
  const payment = await executor.query<PaymentEventRow>(
    'SELECT * FROM core.payment_events WHERE event_key = $1 FOR UPDATE',
    [eventKey],
  );
  const row = payment.rows[0];
  if (!row) throw new CoreError('InvalidFinality', 'Unknown payment event', 404);
  if (!row.canonical) return { status: 'IDEMPOTENT' as const, orderId: row.order_id };
  const originalLines = await executor.query<JournalLineRow>(
    `SELECT account_id, side, amount::text, balance_state
     FROM core.ledger_lines WHERE journal_id = $1 ORDER BY line_id`,
    [row.journal_id],
  );
  const reversalLines: LedgerLine[] = originalLines.rows.map((line) => ({
    accountId: line.account_id,
    side: line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
    amount: line.amount,
    balanceState: line.balance_state,
  }));
  const reversalEventKey = `reorg:${eventKey}:${replacementBlockHash.toLowerCase()}`;
  await postJournal(executor, {
    journalId: `reversal:${row.journal_id}:${replacementBlockHash.toLowerCase()}`,
    eventKey: reversalEventKey,
    eventType: 'PAYMENT_REORG_REVERSAL',
    orderId: row.order_id,
    policyVersion: Number((await executor.query<{ policy_version: string }>(
      'SELECT policy_version FROM core.orders WHERE order_id = $1',
      [row.order_id],
    )).rows[0]!.policy_version),
    contentHash: hashJson({ reversalOf: row.journal_id, replacementBlockHash, lines: reversalLines }),
    sourceTxHash: row.transaction_hash,
    sourceBlockHash: replacementBlockHash,
    reversalOf: row.journal_id,
    payload: { replacedEventKey: eventKey },
    lines: reversalLines,
  });
  const reservation = await executor.query<{ reservation_id: string }>(
    'SELECT reservation_id FROM core.orders WHERE order_id = $1',
    [row.order_id],
  );
  const deepFinalized = Number(row.confirmations) >= REQUIRED_CONFIRMATIONS;
  if (!deepFinalized) {
    await executor.query('SELECT core.restore_reorged_inventory_reservation($1)', [reservation.rows[0]!.reservation_id]);
  }
  await executor.query(
    `UPDATE core.payment_events SET canonical = false, replacement_block_hash = $2,
       replaced_at = clock_timestamp() WHERE event_key = $1`,
    [eventKey, replacementBlockHash],
  );
  await executor.query(
    `UPDATE core.orders SET state = 'REORG_PENDING', finality_status = 'REORGED',
       updated_at = clock_timestamp() WHERE order_id = $1`,
    [row.order_id],
  );
  await executor.query(
    `UPDATE core.payment_quotes SET state = 'REORGED', updated_at = clock_timestamp()
     WHERE order_id = $1`,
    [row.order_id],
  );
  await executor.query(
    `UPDATE core.transaction_finality SET state = 'REORGED', updated_at = clock_timestamp()
     WHERE transaction_id = $1`,
    [`payment:${eventKey}`],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'ORDER',$2,'PaymentReorged',$3,$4,'PENDING')`,
    [
      `outbox:${reversalEventKey}`,
      row.order_id,
      JSON.stringify({ eventKey, replacementBlockHash, deepFinalized }),
      `payment-reorged:${reversalEventKey}`,
    ],
  );
  if (deepFinalized) {
    await executor.query(
      `INSERT INTO core.durable_jobs (
         job_id, job_type, resource_id, payload, idempotency_key, state
       ) VALUES ($1,'RECONCILE',$2,$3,$4,'READY')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `deep-reorg:${eventKey}`,
        row.order_id,
        JSON.stringify({ eventKey, replacementBlockHash, selectedInventoryHeld: true }),
        `deep-payment-reorg:${eventKey}`,
      ],
    );
  }
  return { status: 'REVERSED' as const, orderId: row.order_id };
}

async function quarantineDeepReorgPayment(
  executor: SqlExecutor,
  event: CanonicalPaymentEvent,
  eventKey: string,
  reservationState: string,
) {
  await executor.query(
    `INSERT INTO core.durable_jobs (
       job_id, job_type, resource_id, payload, idempotency_key, state
     ) VALUES ($1,'RECONCILE',$2,$3,$4,'READY')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `quarantined-payment:${eventKey}`,
      event.orderId,
      JSON.stringify({
        eventKey,
        transactionHash: event.transactionHash,
        blockHash: event.blockHash,
        classification: event.classification,
        reservationId: event.reservationId,
        reservationState,
      }),
      `quarantined-payment:${eventKey}`,
    ],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'ORDER',$2,'DeepReorgPaymentQuarantined',$3,$4,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:quarantined:${eventKey}`,
      event.orderId,
      JSON.stringify({ eventKey, classification: event.classification, reservationState }),
      `quarantined-payment:${eventKey}`,
    ],
  );
}

export async function advancePaymentFinality(executor: SqlExecutor, canonicalHead: number) {
  if (!Number.isSafeInteger(canonicalHead) || canonicalHead < 0) {
    throw new CoreError('InvalidFinality', 'Invalid canonical head');
  }
  await executor.query(
    `UPDATE core.payment_events
     SET confirmations = $1 - block_number + 1
     WHERE canonical AND block_number <= $1`,
    [canonicalHead],
  );
  await executor.query(
    `UPDATE core.transaction_finality finality
     SET confirmations = payment.confirmations,
         state = CASE WHEN payment.confirmations >= 15 THEN 'FINAL' ELSE 'MINED' END,
         finalized_at = CASE
           WHEN payment.confirmations >= 15 THEN COALESCE(finality.finalized_at, clock_timestamp())
           ELSE NULL
         END,
         updated_at = clock_timestamp()
     FROM core.payment_events payment
     WHERE payment.canonical AND finality.resource_type = 'ORDER_PAYMENT'
       AND finality.resource_id = payment.order_id
       AND finality.tx_hash = payment.transaction_hash
       AND finality.block_hash = payment.block_hash`,
  );
  await executor.query(
    `UPDATE core.orders orders
     SET finality_status = CASE WHEN payment.confirmations >= 15 THEN 'FINAL' ELSE 'PENDING' END,
         updated_at = clock_timestamp()
     FROM core.payment_events payment
     WHERE payment.canonical AND orders.order_id = payment.order_id`,
  );
  const unusedReservations = await executor.query<{ reservation_id: string }>(
    `SELECT leg.reservation_id
     FROM core.payment_quote_legs leg
     JOIN core.orders orders ON orders.order_id = leg.order_id
     JOIN core.payment_events payment ON payment.order_id = orders.order_id AND payment.canonical
     JOIN core.inventory_reservations reservation ON reservation.reservation_id = leg.reservation_id
     WHERE payment.confirmations >= 15 AND reservation.state = 'ACTIVE'
       AND leg.reservation_id <> orders.reservation_id
     FOR UPDATE`,
  );
  for (const reservation of unusedReservations.rows) {
    await executor.query("SELECT core.release_inventory_reservation($1, 'RELEASED')", [reservation.reservation_id]);
  }
}

interface QuoteRow {
  artifact_version: string;
  buyer_wallet: string;
  merchant_id: string;
  merchant_wallet: string;
  product_id: string;
  sku_id: string;
  chain_product_id: string;
  chain_sku_id: string;
  product_policy_hash: string;
  list_price_usdt: string;
  seckill_list_price_usdt: string | null;
  merchant_cost_usdt: string;
  merchant_concession_bps: number;
  policy_version: string;
  quote_kind: 'ORDINARY' | 'SECKILL';
  session_id: string | null;
  deadline: Date;
  state: 'QUOTED' | 'SUBMITTED' | 'PAID' | 'REORGED' | 'EXPIRED';
}

interface QuoteLegRow {
  reservation_id: string;
  snapshot_hash: string;
  intent: CanonicalPaymentIntent;
}

async function loadQuoteContext(executor: SqlExecutor, event: CanonicalPaymentEvent) {
  const quoteResult = await executor.query<QuoteRow>(
    'SELECT * FROM core.payment_quotes WHERE order_id = $1 FOR UPDATE',
    [event.orderId],
  );
  const quote = quoteResult.rows[0];
  if (!quote || !['QUOTED', 'SUBMITTED', 'REORGED'].includes(quote.state)) {
    throw new CoreError('InvalidFinality', 'Payment event has no active immutable quote', 409);
  }
  const legResult = await executor.query<QuoteLegRow>(
    `SELECT reservation_id, snapshot_hash, intent FROM core.payment_quote_legs
     WHERE order_id = $1 AND classification = $2 FOR UPDATE`,
    [event.orderId, event.classification],
  );
  const leg = legResult.rows[0];
  if (!leg || leg.snapshot_hash.toLowerCase() !== event.snapshotHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Payment event does not match a signed quote leg', 409);
  }
  const intent = leg.intent;
  if (paymentIntentHash(intent).toLowerCase() !== event.snapshotHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Persisted quote hash does not match Router snapshot', 409);
  }
  if (
    quote.artifact_version !== event.artifactVersion
      || quote.buyer_wallet.toLowerCase() !== event.buyer.toLowerCase()
      || quote.merchant_wallet.toLowerCase() !== event.merchant.toLowerCase()
      || Number(quote.policy_version) !== event.policyVersion
      || intent.orderId.toLowerCase() !== event.orderId.toLowerCase()
      || intent.buyer.toLowerCase() !== event.buyer.toLowerCase()
      || intent.merchant.toLowerCase() !== event.merchant.toLowerCase()
      || intent.policyVersion !== event.policyVersion
      || intent.listPriceUsdt !== event.listPriceUsdt
      || intent.usdtPaymentAmount !== event.usdtPaid
      || intent.nplPaymentAmount !== event.nplPaid
      || intent.nplBurnAmount !== event.nplBurned
      || intent.nplRewardAmount !== event.nplRewarded
      || intent.bnmAmount !== event.bnmLocked
      || intent.reservationId.toLowerCase() !== event.reservationId.toLowerCase()
      || leg.reservation_id !== intent.reservationId
      || quote.chain_product_id.toLowerCase() !== intent.productId.toLowerCase()
      || quote.chain_sku_id.toLowerCase() !== intent.skuId.toLowerCase()
      || quote.product_policy_hash.toLowerCase() !== intent.productPolicyHash.toLowerCase()
      || (quote.quote_kind === 'ORDINARY' && event.classification !== 'ORDINARY')
      || (quote.quote_kind === 'SECKILL' && event.classification === 'ORDINARY')
  ) throw new CoreError('InvalidFinality', 'Payment event values do not match the signed quote', 409);

  const policyResult = await executor.query<{ oracle_version: string; payload: unknown }>(
    `SELECT oracle_version, payload FROM core.policy_snapshots
     WHERE policy_version = $1 AND artifact_version = $2 AND publication_status = 'PUBLISHED'`,
    [quote.policy_version, quote.artifact_version],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new CoreError('InvalidFinality', 'Published quote policy is unavailable', 409);
  return {
    intent,
    policyVersion: Number(quote.policy_version),
    oracleVersion: policy.oracle_version,
    policyPayload: policy.payload,
    buyerWallet: quote.buyer_wallet,
    merchantId: quote.merchant_id,
    merchantWallet: quote.merchant_wallet,
    productId: quote.product_id,
    skuId: quote.sku_id,
    chainProductId: quote.chain_product_id,
    chainSkuId: quote.chain_sku_id,
    productPolicyHash: quote.product_policy_hash,
    merchantConcessionBps: Number(quote.merchant_concession_bps),
    listPriceUsdt: BigInt(quote.list_price_usdt),
    seckillListPriceUsdt: quote.seckill_list_price_usdt === null
      ? undefined
      : BigInt(quote.seckill_list_price_usdt),
    merchantCostUsdt: BigInt(quote.merchant_cost_usdt),
  };
}

function paymentJournal(
  intent: CanonicalPaymentIntent,
  safes: { usdtCustodySafe: string; nplRewardSafe: string },
) {
  const accounts = new Map<string, LedgerAccount>();
  const lines: LedgerLine[] = [];
  const add = (account: LedgerAccount, side: LedgerLine['side'], amount: string, balanceState: LedgerLine['balanceState']) => {
    if (BigInt(amount) === 0n) return;
    accounts.set(account.accountId, account);
    lines.push({ accountId: account.accountId, side, amount, balanceState });
  };
  add(safeAccount('usdt-custody', safes.usdtCustodySafe, USDT), 'DEBIT', intent.usdtPaymentAmount, 'POSTED');
  add(account(`merchant:${intent.merchant}:usdt`, 'MERCHANT', intent.merchant, USDT, 'MERCHANT_RECEIVABLE'), 'CREDIT', intent.merchantNetReceivableUsdt, 'LOCKED');
  for (const allocation of intent.merchantConcessionAllocations) {
    add(account(`concession:${allocation.account}:usdt`, 'BENEFICIARY', allocation.account, USDT, 'CONCESSION'), 'CREDIT', allocation.amount, 'LOCKED');
  }
  for (const allocation of intent.otherUsdtAllocations) {
    add(account(`policy:${allocation.account}:usdt`, 'BENEFICIARY', allocation.account, USDT, 'POLICY_ALLOCATION'), 'CREDIT', allocation.amount, 'LOCKED');
  }
  add(account('burn:npl', 'SYSTEM', 'npl-burn', NPL, 'BURN'), 'DEBIT', intent.nplBurnAmount, 'POSTED');
  add(account('clearing:buyer-burn:npl', 'SYSTEM', 'buyer-burn-payment', NPL, 'PAYMENT_CLEARING'), 'CREDIT', intent.nplBurnAmount, 'POSTED');
  add(safeAccount('npl-reward', safes.nplRewardSafe, NPL), 'DEBIT', intent.nplRewardAmount, 'POSTED');
  for (const allocation of intent.nplRewardAllocations) {
    add(
      account(
        `reward:${allocation.role}:${allocation.account}:npl`,
        'BENEFICIARY',
        allocation.account,
        NPL,
        'REWARD_LIABILITY',
      ),
      'CREDIT',
      allocation.amount,
      'LOCKED',
    );
  }
  add(account('issuance:bnm', 'SYSTEM', 'bnm-issuance', BNM, 'BNM_ISSUANCE'), 'DEBIT', intent.bnmAmount, 'POSTED');
  add(account(`buyer:${intent.buyer}:bnm`, 'BUYER', intent.buyer, BNM, 'BNM_LIABILITY'), 'CREDIT', intent.bnmAmount, 'LOCKED');
  return { accounts: [...accounts.values()], lines };
}

function safeAccount(
  name: 'usdt-custody' | 'npl-reward',
  safeAddress: string,
  asset: typeof USDT | typeof NPL,
): LedgerAccount {
  const normalizedSafe = safeAddress.toLowerCase();
  return account(
    `safe:${name}:${normalizedSafe}:${asset.toLowerCase()}`,
    'SAFE',
    normalizedSafe,
    asset,
    'SAFE_ASSET',
    normalizedSafe,
  );
}

function account(
  accountId: string,
  ownerType: LedgerAccount['ownerType'],
  ownerId: string,
  asset: LedgerAccount['asset'],
  purpose: LedgerAccount['purpose'],
  safeAddress?: string,
): LedgerAccount {
  return { accountId, ownerType, ownerId, asset, purpose, ...(safeAddress ? { safeAddress } : {}) };
}

async function ensureAccount(executor: SqlExecutor, value: LedgerAccount) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, safe_address
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id) DO NOTHING`,
    [value.accountId, value.ownerType, value.ownerId, value.asset, value.purpose, value.safeAddress ?? null],
  );
  const persisted = await executor.query<LedgerAccountRow>(
    `SELECT owner_type, owner_id, asset, purpose, safe_address
     FROM core.ledger_accounts WHERE account_id = $1`,
    [value.accountId],
  );
  const row = persisted.rows[0];
  if (
    !row
      || row.owner_type !== value.ownerType
      || row.owner_id !== value.ownerId
      || row.asset !== value.asset
      || row.purpose !== value.purpose
      || row.safe_address !== (value.safeAddress ?? null)
  ) {
    throw new CoreError('InvalidFinality', 'Ledger account metadata does not match the immutable account identity', 409);
  }
}

async function postJournal(
  executor: SqlExecutor,
  input: {
    journalId: string;
    eventKey: string;
    eventType: 'PAYMENT_LOCKED' | 'PAYMENT_REORG_REVERSAL';
    orderId: string;
    policyVersion: number;
    contentHash: string;
    sourceTxHash: string;
    sourceBlockHash: string;
    reversalOf?: string;
    payload: Record<string, unknown>;
    lines: LedgerLine[];
  },
) {
  await executor.query(
    'SELECT core.post_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      input.journalId,
      input.eventKey,
      input.eventType,
      input.orderId,
      input.policyVersion,
      input.contentHash,
      input.sourceTxHash,
      input.sourceBlockHash,
      input.reversalOf ?? null,
      JSON.stringify(input.payload),
      JSON.stringify(input.lines.map((line) => ({
        account_id: line.accountId,
        side: line.side,
        amount: line.amount,
        balance_state: line.balanceState,
      }))),
    ],
  );
}

function validatePaymentInput(input: RecordPaymentInput) {
  const event = input.event;
  const amounts = [
    event.listPriceUsdt,
    event.usdtPaid,
    event.nplPaid,
    event.nplBurned,
    event.nplRewarded,
    event.bnmLocked,
  ];
  if (
    !isHash(event.transactionHash) || !isHash(event.blockHash) || !isHash(event.eventHash)
      || !isHash(event.snapshotHash) || !isHash(event.orderId) || !isHash(event.reservationId)
      || !isAddress(event.buyer) || !isAddress(event.merchant) || event.artifactVersion.length === 0
      || !isAddress(event.contractAddress) || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0
      || !Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0
      || !Number.isSafeInteger(event.policyVersion) || event.policyVersion <= 0
      || !Number.isSafeInteger(event.confirmations) || event.confirmations < 0
      || !Number.isFinite(event.blockTimestamp.getTime())
      || !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(event.classification)
      || amounts.some((amount) => !/^(0|[1-9][0-9]*)$/.test(amount))
  ) throw new CoreError('InvalidFinality', 'Invalid canonical payment event');
  if (BigInt(event.nplBurned) + BigInt(event.nplRewarded) !== BigInt(event.nplPaid)) {
    throw new CoreError('InvalidRequest', 'NPL payment is not conserved');
  }
}

function exactAmounts(intent: CanonicalPaymentIntent) {
  return {
    listPriceUsdt: intent.listPriceUsdt,
    usdtPaymentAmount: intent.usdtPaymentAmount,
    nplQuoteAmount: intent.nplQuoteAmount,
    nplPaymentAmount: intent.nplPaymentAmount,
    nplBurnAmount: intent.nplBurnAmount,
    nplRewardAmount: intent.nplRewardAmount,
    merchantBaseReceivableUsdt: intent.merchantBaseReceivableUsdt,
    merchantConcessionAmount: intent.merchantConcessionAmount,
    merchantNetReceivableUsdt: intent.merchantNetReceivableUsdt,
    bnmAmount: intent.bnmAmount,
  };
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

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function paymentEventKey(transactionHash: string, logIndex: number, blockHash: string) {
  return `${transactionHash.toLowerCase()}:${logIndex}:${blockHash.toLowerCase()}`;
}

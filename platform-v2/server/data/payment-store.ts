import { createHash } from 'node:crypto';
import { id } from 'ethers';
import { buildPaymentIntent, type CanonicalPaymentIntent } from '../api/checkout.ts';
import { CoreError } from '../api/errors.ts';
import { parsePaymentPolicySnapshot } from '../api/payment-policy.ts';
import { paymentIntentHash } from '../api/payment-signing.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const REQUIRED_CONFIRMATIONS = 15;
const USDT = 'USDT';
const NPL = 'NPL';
const BNM = 'BNM_POINTS';
const PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH = id(
  'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
).toLowerCase();

interface PaymentEventRow {
  event_key: string;
  order_id: string;
  journal_id: string;
  transaction_hash: string;
  log_index: string | number;
  block_hash: string;
  snapshot_hash: string;
  confirmations: string | number;
  canonical: boolean;
}

interface JournalBalanceRow {
  account_id: string;
  net_credit: string;
  balance_state: LedgerLine['balanceState'];
  backing_safe_address: string | null;
}

interface SettlementReorgRow {
  request_id: string;
  item_index: number;
  batch_id: string | null;
  request_state: string;
  asset: 'USDT' | 'NPL';
  amount: string;
  final_safe_tx_hash: string | null;
  final_execution_tx_hash: string | null;
}

interface LedgerLine {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  balanceState: 'POSTED' | 'LOCKED' | 'AVAILABLE' | 'REQUESTED' | 'BATCHED' | 'SETTLED' | 'DISPUTED';
  backingSafeAddress?: string;
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
    | 'MERCHANT_FREIGHT_RECEIVABLE'
    | 'PLATFORM_SERVICE_FEE_REVENUE'
    | 'CONCESSION'
    | 'POLICY_ALLOCATION'
    | 'SECKILL_PRIZE_LIABILITY'
    | 'NODE_REWARD_POOL'
    | 'REWARD_RESERVE_POOL'
    | 'REWARD_LIABILITY'
    | 'BNM_ISSUANCE'
    | 'BNM_LIABILITY';
  safeAddress?: string;
  subtype?: RewardSubtype;
}

type RewardSubtype =
  | 'GENESIS'
  | 'DIRECT_REFERRAL'
  | 'DISTRICT'
  | 'CITY'
  | 'PROVINCE'
  | 'REGION'
  | 'OPERATIONS'
  | 'ROUNDING_REMAINDER';

interface LedgerAccountRow {
  owner_type: LedgerAccount['ownerType'];
  owner_id: string;
  asset: LedgerAccount['asset'];
  purpose: LedgerAccount['purpose'];
  safe_address: string | null;
  subtype: RewardSubtype | null;
}

export interface CanonicalPaymentEvent {
  artifactVersion: string;
  orderId: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: Date;
  finalizedAt?: Date;
  contractAddress: string;
  eventHash: string;
  snapshotHash: string;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
  buyer: string;
  merchant: string;
  policyVersion: number;
  listPriceUsdt: string;
  productUsdtPaid: string;
  platformServiceFeeUsdt: string;
  custodyProductUsdt: string;
  freightUsdt: string;
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
  const policy = parsePaymentPolicySnapshot(quote.policyVersion, quote.policyPayload);
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
      freightUsdt: quote.freightUsdt,
      nplQuoteAmount: BigInt(intent.nplQuoteAmount),
      merchantConcessionBps: quote.merchantConcessionBps,
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
         order_id, artifact_version, policy_version, buyer_wallet,
         merchant_id, merchant_wallet, product_id, sku_id, quantity, fulfillment_mode,
         fulfillment_target_hash, region_code_hash, product_policy_hash, reservation_id,
         quote_snapshot, allocation_snapshot, seckill_snapshot, exact_amounts, buyer_nonce,
         quote_deadline, state, finality_status, payment_tx_hash, payment_block_hash, paid_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         $15,$16,$17,$18,$19,$20,'PAID',$21,$22,$23,$24
       )`,
      [
        intent.orderId,
        input.event.artifactVersion,
        intent.policyVersion,
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

  const safes = {
    platformServiceFeeSafe: policy.platformServiceFeeSafe,
    usdtCustodySafe: policy.usdtCustodySafe,
    nplRewardSafe: policy.nplRewardSafe,
  };
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
    payload: {
      classification: input.event.classification,
      snapshotHash: input.event.snapshotHash,
      productUsdtPaymentAmount: intent.productUsdtPaymentAmount,
      freightUsdt: intent.freightUsdt,
    },
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
  if (intent.seckill) {
    const contribution = intent.merchantConcessionAllocations.find((allocation) => allocation.pool === 'SECKILL_PRIZE');
    if (contribution && BigInt(contribution.amount) > 0n) {
      const accountId = `seckill-prize:${intent.sessionId}:usdt`;
      await executor.query(
        `INSERT INTO core.seckill_prize_contributions (
           order_id, session_id, payment_event_key, account_id, amount_usdt, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [intent.orderId, intent.sessionId, eventKey, accountId, contribution.amount, input.event.blockTimestamp],
      );
      const updated = await executor.query<{ session_id: string }>(
        `UPDATE core.seckill_sessions
         SET prize_pool_usdt = prize_pool_usdt + $2, updated_at = clock_timestamp()
         WHERE session_id = $1 RETURNING session_id`,
        [intent.sessionId, contribution.amount],
      );
      if (!updated.rows[0]) throw new CoreError('InvalidFinality', 'Seckill prize session is unavailable', 409);
    }
  }
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
      input.event.confirmations >= REQUIRED_CONFIRMATIONS ? input.event.finalizedAt : null,
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
  await reverseSeckillRelayProjection(executor, row.order_id, replacementBlockHash);
  const settlementItems = await executor.query<SettlementReorgRow>(
    `SELECT request.request_id, item.item_index, request.batch_id,
       request.state AS request_state, request.asset, item.amount::text,
       request.final_safe_tx_hash, request.final_execution_tx_hash
     FROM core.settlement_request_items item
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     WHERE item.order_id = $1
     ORDER BY request.request_id, item.item_index
     FOR UPDATE OF request, item`,
    [row.order_id],
  );
  const batchIds = [...new Set(settlementItems.rows.flatMap((item) => item.batch_id ? [item.batch_id] : []))].sort();
  const batchStates = new Map<string, string>();
  if (batchIds.length > 0) {
    const placeholders = batchIds.map((_, index) => `$${index + 1}`).join(',');
    const batches = await executor.query<{ batch_id: string; state: string }>(
      `SELECT batch_id, state FROM core.settlement_batches
       WHERE batch_id IN (${placeholders}) ORDER BY batch_id FOR UPDATE`,
      batchIds,
    );
    for (const batch of batches.rows) batchStates.set(batch.batch_id, batch.state);
  }
  const currentBalances = await executor.query<JournalBalanceRow>(
    `SELECT line.account_id, line.balance_state, line.backing_safe_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS net_credit
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     WHERE journal.order_id = $1
     GROUP BY line.account_id, line.balance_state, line.backing_safe_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY line.account_id, line.balance_state`,
    [row.order_id],
  );
  const reversalLines: LedgerLine[] = currentBalances.rows.map((line) => ({
    accountId: line.account_id,
    side: BigInt(line.net_credit) > 0n ? 'DEBIT' : 'CREDIT',
    amount: (BigInt(line.net_credit) < 0n ? -BigInt(line.net_credit) : BigInt(line.net_credit)).toString(),
    balanceState: line.balance_state,
    ...(line.backing_safe_address ? { backingSafeAddress: line.backing_safe_address } : {}),
  }));
  const reversalEventKey = `reorg:${eventKey}:${replacementBlockHash.toLowerCase()}`;
  const reversalJournalId = `reversal:${row.journal_id}:${replacementBlockHash.toLowerCase()}`;
  const paymentIdentity = await executor.query<{ policy_version: string; contract_address: string }>(
    `SELECT orders.policy_version::text, finality.contract_address
     FROM core.orders orders
     JOIN core.transaction_finality finality
       ON finality.transaction_id = $2
     WHERE orders.order_id = $1`,
    [row.order_id, `payment:${eventKey}`],
  );
  const identity = paymentIdentity.rows[0];
  if (!identity) throw new CoreError('InvalidFinality', 'Payment reorg identity is unavailable', 409);
  await postJournal(executor, {
    journalId: reversalJournalId,
    eventKey: reversalEventKey,
    eventType: 'PAYMENT_REORG_REVERSAL',
    orderId: row.order_id,
    policyVersion: Number(identity.policy_version),
    contentHash: hashJson({ reversalOf: row.journal_id, replacementBlockHash, lines: reversalLines }),
    sourceTxHash: row.transaction_hash,
    sourceBlockHash: replacementBlockHash,
    reversalOf: row.journal_id,
    payload: { replacedEventKey: eventKey },
    lines: reversalLines,
  });
  const contribution = await executor.query<{
    session_id: string;
    amount_usdt: string;
    reversed_at: Date | null;
  }>(
    `SELECT session_id, amount_usdt::text, reversed_at
     FROM core.seckill_prize_contributions WHERE payment_event_key = $1 FOR UPDATE`,
    [eventKey],
  );
  const prizeContribution = contribution.rows[0];
  if (prizeContribution && !prizeContribution.reversed_at) {
    const updated = await executor.query<{ session_id: string }>(
      `UPDATE core.seckill_sessions
       SET prize_pool_usdt = prize_pool_usdt - $2, updated_at = clock_timestamp()
       WHERE session_id = $1 AND prize_pool_usdt >= $2 RETURNING session_id`,
      [prizeContribution.session_id, prizeContribution.amount_usdt],
    );
    if (!updated.rows[0]) throw new CoreError('UnknownState', 'Seckill prize pool cannot reverse the payment contribution', 409);
    await executor.query(
      `UPDATE core.seckill_prize_contributions
       SET reversed_at = clock_timestamp(), reversal_event_key = $2
       WHERE payment_event_key = $1`,
      [eventKey, reversalEventKey],
    );
    await quarantineSeckillPrizeOutcome(
      executor,
      prizeContribution.session_id,
      replacementBlockHash.toLowerCase(),
      row.order_id,
    );
  }
  await quarantineReorgedSettlements(executor, {
    paymentEventKey: eventKey,
    orderId: row.order_id,
    replacementBlockHash,
    reversalJournalId,
    items: settlementItems.rows,
    batchStates,
  });
  const debtRecovery = await executor.query<{ merchant_id: string; amount: string }>(
    `SELECT merchant_id, amount_usdt::text AS amount
     FROM core.merchant_debt_recoveries
     WHERE order_id = $1 AND reversed_at IS NULL
     ORDER BY recovery_id FOR UPDATE`,
    [row.order_id],
  );
  const recoveredByMerchant = new Map<string, bigint>();
  for (const recovery of debtRecovery.rows) {
    recoveredByMerchant.set(
      recovery.merchant_id,
      (recoveredByMerchant.get(recovery.merchant_id) ?? 0n) + BigInt(recovery.amount),
    );
  }
  for (const [merchantId, amount] of recoveredByMerchant) {
    await executor.query(
      `UPDATE core.merchant_debts SET recovered_usdt = recovered_usdt - $2,
         outstanding_usdt = outstanding_usdt + $2,
         latest_evidence_hash = $3, updated_at = clock_timestamp()
       WHERE merchant_id = $1 AND recovered_usdt >= $2`,
      [merchantId, amount.toString(), replacementBlockHash],
    );
  }
  await executor.query(
    `UPDATE core.merchant_debt_recoveries SET reversed_at = clock_timestamp(),
       reversal_evidence_hash = $2 WHERE order_id = $1 AND reversed_at IS NULL`,
    [row.order_id, replacementBlockHash],
  );
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
  const reorgedOrder = await executor.query<{ bnm_state_version: string }>(
    `UPDATE core.orders SET state = 'REORG_PENDING', finality_status = 'REORGED',
       bnm_state_version = bnm_state_version + 1, updated_at = clock_timestamp()
     WHERE order_id = $1 RETURNING bnm_state_version::text`,
    [row.order_id],
  );
  if (!reorgedOrder.rows[0]) throw new CoreError('UnknownState', 'Reorged order is unavailable', 409);
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
  await executor.query(
    `UPDATE core.outbox_events SET state = 'DEAD_LETTER', locked_by = NULL,
       locked_until = NULL, last_error_code = 'PaymentReorged'
     WHERE aggregate_id = $1 AND event_type = 'BnmAvailabilityRequested'
       AND state = 'PENDING'`,
    [row.order_id],
  );
  await executor.query(
    `UPDATE core.outbox_events SET last_error_code = 'PaymentReorgCancellationPending'
     WHERE aggregate_id = $1 AND event_type = 'BnmAvailabilityRequested'
       AND state = 'PROCESSING'`,
    [row.order_id],
  );
  const bnm = await executor.query<{
    buyer_wallet: string;
    merchant_id: string;
    amount: string;
  }>(
    `SELECT orders.buyer_wallet, orders.merchant_id,
            orders.exact_amounts ->> 'bnmAmount' AS amount
     FROM core.orders orders
     WHERE orders.order_id = $1`,
    [row.order_id],
  );
  if (bnm.rows[0]) {
    await executor.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
       ) VALUES ($1,'ORDER',$2,'BnmLockRequested',$3,$1,'PENDING')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `outbox:bnm-lock:${reversalEventKey}`,
        row.order_id,
        JSON.stringify({
          orderId: row.order_id,
          buyerWallet: bnm.rows[0].buyer_wallet,
          amount: bnm.rows[0].amount,
          state: 'LOCKED',
          stateVersion: reorgedOrder.rows[0].bnm_state_version,
          reason: 'PAYMENT_REORG',
          sourceEvidenceHash: replacementBlockHash.toLowerCase(),
        }),
      ],
    );
  }
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
  const reorgAuditHash = hashJson({
    eventKey,
    transactionHash: row.transaction_hash,
    previousBlockHash: row.block_hash,
    canonicalBlockHash: replacementBlockHash.toLowerCase(),
    deepFinalized,
  });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:payment-reorg', {
      eventKey,
      replacementBlockHash: replacementBlockHash.toLowerCase(),
    }),
    streamName: 'financial',
    evidenceProfile: 'CHAIN_OBSERVED',
    eventType: 'PaymentFinalityReorged',
    resourceType: 'ORDER',
    resourceId: row.order_id,
    ...(bnm.rows[0]?.merchant_id ? { merchantId: bnm.rows[0].merchant_id } : {}),
    actorRole: 'PAYMENT_INDEXER',
    correlationId: `payment-reorg:${row.order_id}`,
    requestHash: reorgAuditHash.slice(2),
    payload: {
      eventKey,
      previousBlockHash: row.block_hash,
      canonicalBlockHash: replacementBlockHash.toLowerCase(),
      deepFinalized,
      reversedDebtRecoveries: debtRecovery.rows.length,
    },
    transactionEvidence: {
      txHash: row.transaction_hash,
      chainId: 56,
      contractAddress: identity.contract_address,
      eventSignatureHash: PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
      logIndex: Number(row.log_index),
      resourceId: row.order_id,
      policyVersion: Number(identity.policy_version),
      blockHash: row.block_hash,
      confirmations: 0,
    },
    createdAt: new Date(),
  });
  return { status: 'REVERSED' as const, orderId: row.order_id };
}

async function quarantineReorgedSettlements(
  executor: SqlExecutor,
  input: {
    paymentEventKey: string;
    orderId: string;
    replacementBlockHash: string;
    reversalJournalId: string;
    items: readonly SettlementReorgRow[];
    batchStates: ReadonlyMap<string, string>;
  },
) {
  if (input.items.length === 0) return;
  const evidenceHash = input.replacementBlockHash.toLowerCase();
  for (const item of input.items) {
    await executor.query(
      `INSERT INTO core.settlement_payment_reorg_exposures (
         exposure_id, payment_event_key, order_id, request_id, request_item_index,
         batch_id, previous_request_state, previous_batch_state, asset, amount,
         final_safe_tx_hash, final_execution_tx_hash, reversal_journal_id,
         evidence_hash, resolution_state, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'OPEN',clock_timestamp())
       ON CONFLICT (payment_event_key, request_id, request_item_index) DO NOTHING`,
      [
        hashJson({
          paymentEventKey: input.paymentEventKey,
          requestId: item.request_id,
          itemIndex: item.item_index,
        }),
        input.paymentEventKey,
        input.orderId,
        item.request_id,
        item.item_index,
        item.batch_id,
        item.request_state,
        item.batch_id ? input.batchStates.get(item.batch_id) ?? null : null,
        item.asset,
        item.amount,
        item.final_safe_tx_hash,
        item.final_execution_tx_hash,
        input.reversalJournalId,
        evidenceHash,
      ],
    );
  }
  const requestIds = [...new Set(input.items.map((item) => item.request_id))].sort();
  for (const requestId of requestIds) {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'QUARANTINED'
       WHERE request_id = $1 AND state <> 'QUARANTINED'`,
      [requestId],
    );
  }
  const batchIds = [...input.batchStates.keys()].sort();
  for (const batchId of batchIds) {
    await executor.query(
      `UPDATE core.settlement_batches SET state = 'QUARANTINED'
       WHERE batch_id = $1 AND state <> 'QUARANTINED'`,
      [batchId],
    );
    await executor.query(
      `UPDATE core.settlement_execution_attempts SET state = 'QUARANTINED',
         updated_at = clock_timestamp()
       WHERE batch_id = $1 AND state <> 'QUARANTINED'`,
      [batchId],
    );
    await executor.query(
      `UPDATE core.safe_nonce_reservations SET state = 'QUARANTINED'
       WHERE batch_id = $1 AND state <> 'QUARANTINED'`,
      [batchId],
    );
  }
  const causeId = `payment-reorg:${input.orderId}`;
  await executor.query(
    `INSERT INTO core.breaker_causes (
       scope, cause_type, cause_id, active, evidence_hash, updated_at
     ) VALUES ('NEW_SETTLEMENT_BATCH','SECURITY',$1,true,$2,clock_timestamp())
     ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
       SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
    [causeId, evidenceHash],
  );
  await executor.query(
    `INSERT INTO core.breaker_events (
       breaker_event_id, scope, action, cause_type, cause_id,
       evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ($1,'NEW_SETTLEMENT_BATCH','PAUSE','SECURITY',$2,$3,NULL,'PAYMENT_REORG',clock_timestamp())
     ON CONFLICT (breaker_event_id) DO NOTHING`,
    [hashJson({ causeId, evidenceHash, action: 'PAUSE' }), causeId, evidenceHash],
  );
  await executor.query(
    `INSERT INTO core.circuit_breakers (
       scope, paused, evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ('NEW_SETTLEMENT_BATCH',true,$1,NULL,'PAYMENT_REORG',clock_timestamp())
     ON CONFLICT (scope) DO UPDATE SET paused = true, evidence_hash = EXCLUDED.evidence_hash,
       policy_version = NULL, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [evidenceHash],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state
     ) VALUES ($1,'ORDER',$2,'SettlementPaymentReorgQuarantined',$3,$1,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:settlement-payment-reorg:${hashJson({
        paymentEventKey: input.paymentEventKey,
        orderId: input.orderId,
      }).slice(2)}`,
      input.orderId,
      JSON.stringify({
        paymentEventKey: input.paymentEventKey,
        reversalJournalId: input.reversalJournalId,
        requestIds,
        batchIds,
        evidenceHash,
      }),
    ],
  );
  if (input.items.some((item) => item.final_execution_tx_hash)) {
    await executor.query(
      `INSERT INTO core.durable_jobs (
         job_id, job_type, resource_id, payload, idempotency_key, state
       ) VALUES ($1,'RECONCILE',$2,$3,$1,'READY')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `settlement-payment-reorg:${hashJson({
          paymentEventKey: input.paymentEventKey,
          orderId: input.orderId,
        }).slice(2)}`,
        input.orderId,
        JSON.stringify({
          paymentEventKey: input.paymentEventKey,
          requestIds,
          finalExecutionTxHashes: input.items.flatMap((item) =>
            item.final_execution_tx_hash ? [item.final_execution_tx_hash] : []),
          evidenceHash,
        }),
      ],
    );
  }
}

async function quarantineSeckillPrizeOutcome(
  executor: SqlExecutor,
  sessionId: string,
  evidenceHash: string,
  orderId: string,
) {
  const outcome = await executor.query<{ state: string }>(
    `SELECT state FROM core.seckill_prize_settlements
     WHERE session_id = $1 FOR UPDATE`,
    [sessionId],
  );
  if (!outcome.rows[0]) return;
  await executor.query(
    `UPDATE core.seckill_prize_settlements
     SET state = 'QUARANTINED', updated_at = clock_timestamp()
     WHERE session_id = $1 AND state <> 'QUARANTINED'`,
    [sessionId],
  );
  const eventId = hashJson({ sessionId, evidenceHash, orderId, eventType: 'QUARANTINED' });
  await executor.query(
    `INSERT INTO core.seckill_prize_settlement_events (
       event_id, session_id, event_type, evidence_hash, payload, created_at
     ) VALUES ($1,$2,'QUARANTINED',$3,$4,clock_timestamp())
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, sessionId, evidenceHash, JSON.stringify({ orderId, reasonCode: 'PAYMENT_REORG' })],
  );
  const causeId = `seckill-prize-reorg:${sessionId}`;
  await executor.query(
    `INSERT INTO core.breaker_causes (
       scope, cause_type, cause_id, active, evidence_hash, updated_at
     ) VALUES ('NEW_SETTLEMENT_BATCH','SECURITY',$1,true,$2,clock_timestamp())
     ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
       SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
    [causeId, evidenceHash],
  );
  await executor.query(
    `INSERT INTO core.circuit_breakers (
       scope, paused, evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ('NEW_SETTLEMENT_BATCH',true,$1,NULL,'SECKILL_PRIZE_REORG',clock_timestamp())
     ON CONFLICT (scope) DO UPDATE SET paused = true, evidence_hash = EXCLUDED.evidence_hash,
       policy_version = NULL, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [evidenceHash],
  );
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
           WHEN payment.confirmations >= 15 THEN COALESCE(
             finality.finalized_at,
             (
               SELECT to_timestamp(confirmation.block_timestamp)
               FROM core.chain_blocks confirmation
               WHERE confirmation.canonical
                 AND confirmation.block_number = payment.block_number + 14
             ),
             clock_timestamp()
           )
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
  const finalizedPayments = await executor.query<{ aggregate_id: string }>(
    `WITH inserted AS (
       INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state
       )
       SELECT
         'outbox:payment-final:' || payment.event_key,
         'ORDER', payment.order_id, 'PaymentFinalized',
         jsonb_build_object(
           'eventKey', payment.event_key,
           'orderId', payment.order_id,
           'transactionHash', payment.transaction_hash,
           'blockHash', payment.block_hash,
           'confirmations', payment.confirmations
         ),
         'payment-finalized:' || payment.event_key,
         'PENDING'
       FROM core.payment_events payment
       WHERE payment.canonical AND payment.confirmations >= 15
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING aggregate_id
     )
     SELECT inserted.aggregate_id
     FROM inserted
     JOIN core.payment_events payment
       ON payment.order_id = inserted.aggregate_id AND payment.canonical
     ORDER BY payment.block_number, payment.log_index`,
  );
  for (const payment of finalizedPayments.rows) {
    await finalizeSeckillRelayProjection(executor, payment.aggregate_id);
  }
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

async function finalizeSeckillRelayProjection(executor: SqlExecutor, orderId: string) {
  const payment = await executor.query<{ classification: string }>(
    `SELECT classification FROM core.payment_events
     WHERE order_id = $1 AND canonical AND confirmations >= 15`,
    [orderId],
  );
  if (payment.rows[0]?.classification !== 'SECKILL') return;
  const finalized = await executor.query<{
    relay_event_key: string;
    payment_event_key: string;
    session_id: string;
    buyer_wallet: string;
    transaction_hash: string;
    previous_relay_deadline: Date;
    relay_deadline: Date;
    finalized_at: Date;
  }>(
    `UPDATE core.seckill_relay_events relay
     SET finalized = true, finalized_at = finality.finalized_at
     FROM core.transaction_finality finality
     WHERE relay.order_id = $1 AND relay.canonical AND NOT relay.finalized
       AND finality.resource_type = 'ORDER_PAYMENT'
       AND finality.resource_id = relay.order_id
       AND finality.tx_hash = relay.transaction_hash
       AND finality.block_hash = relay.block_hash
       AND finality.state = 'FINAL' AND finality.finalized_at IS NOT NULL
     RETURNING relay.relay_event_key, relay.payment_event_key, relay.session_id,
       relay.buyer_wallet, relay.transaction_hash,
       relay.previous_relay_deadline, relay.relay_deadline, relay.finalized_at`,
    [orderId],
  );
  const row = finalized.rows[0];
  if (!row) throw new CoreError('InvalidFinality', 'Final seckill payment is missing its Router relay event', 409);
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload,
       idempotency_key, state
     ) VALUES ($1,'SECKILL_SESSION',$2,'SeckillRelayExtended',$3,$1,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:seckill-relay:${row.relay_event_key}`,
      row.session_id,
      JSON.stringify({
        sessionId: row.session_id,
        orderId,
        eventKey: row.relay_event_key,
        paymentEventKey: row.payment_event_key,
        transactionHash: row.transaction_hash,
        buyerWallet: row.buyer_wallet,
        finalizedAt: row.finalized_at,
        previousRelayDeadline: row.previous_relay_deadline,
        relayDeadline: row.relay_deadline,
      }),
    ],
  );
}

async function reverseSeckillRelayProjection(
  executor: SqlExecutor,
  orderId: string,
  replacementBlockHash: string,
) {
  const relay = await executor.query<{
    relay_event_key: string;
    session_id: string;
    previous_relay_deadline: Date;
    relay_deadline: Date;
    finalized: boolean;
  }>(
    `SELECT relay_event_key, session_id, previous_relay_deadline,
       relay_deadline, finalized
     FROM core.seckill_relay_events
     WHERE order_id = $1 AND canonical
     FOR UPDATE`,
    [orderId],
  );
  const row = relay.rows[0];
  if (!row) return;
  const session = await executor.query<{ relay_deadline: Date }>(
    `SELECT relay_deadline FROM core.seckill_sessions
     WHERE session_id = $1 FOR UPDATE`,
    [row.session_id],
  );
  if (session.rows[0]?.relay_deadline.getTime() !== row.relay_deadline.getTime()) {
    throw new CoreError('ReorgPending', 'Seckill relay reorg is not the latest session transition', 409);
  }
  await executor.query(
    `UPDATE core.seckill_relay_events
     SET canonical = false, finalized = false, finalized_at = NULL,
       replacement_block_hash = $2, replaced_at = clock_timestamp()
     WHERE relay_event_key = $1`,
    [row.relay_event_key, replacementBlockHash.toLowerCase()],
  );
  const previous = await executor.query<{ buyer_wallet: string }>(
    `SELECT buyer_wallet FROM core.seckill_relay_events
     WHERE session_id = $1 AND canonical
     ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    [row.session_id],
  );
  await executor.query(
    `UPDATE core.seckill_sessions
     SET relay_deadline = $2, last_buyer_wallet = $3,
       updated_at = clock_timestamp()
     WHERE session_id = $1`,
    [row.session_id, row.previous_relay_deadline, previous.rows[0]?.buyer_wallet ?? null],
  );
  if (row.finalized) {
    await executor.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state
       ) VALUES ($1,'SECKILL_SESSION',$2,'SeckillRelayReorged',$3,$1,'PENDING')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `outbox:seckill-relay-reorg:${row.relay_event_key}:${replacementBlockHash.toLowerCase()}`,
        row.session_id,
        JSON.stringify({
          sessionId: row.session_id,
          orderId,
          relayEventKey: row.relay_event_key,
          restoredRelayDeadline: row.previous_relay_deadline,
          replacementBlockHash: replacementBlockHash.toLowerCase(),
        }),
      ],
    );
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
  freight_usdt: string;
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
      || intent.productUsdtPaymentAmount !== event.productUsdtPaid
      || intent.platformServiceFeeUsdt !== event.platformServiceFeeUsdt
      || intent.custodyProductUsdt !== event.custodyProductUsdt
      || intent.freightUsdt !== event.freightUsdt
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

  const policyResult = await executor.query<{ payload: unknown }>(
    `SELECT payload FROM core.policy_snapshots
     WHERE policy_version = $1 AND artifact_version = $2 AND publication_status = 'PUBLISHED'`,
    [quote.policy_version, quote.artifact_version],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new CoreError('InvalidFinality', 'Published quote policy is unavailable', 409);
  return {
    intent,
    policyVersion: Number(quote.policy_version),
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
    freightUsdt: BigInt(quote.freight_usdt),
    listPriceUsdt: BigInt(quote.list_price_usdt),
    seckillListPriceUsdt: quote.seckill_list_price_usdt === null
      ? undefined
      : BigInt(quote.seckill_list_price_usdt),
    merchantCostUsdt: BigInt(quote.merchant_cost_usdt),
  };
}

function paymentJournal(
  intent: CanonicalPaymentIntent,
  safes: { platformServiceFeeSafe: string; usdtCustodySafe: string; nplRewardSafe: string },
) {
  const accounts = new Map<string, LedgerAccount>();
  const lines: LedgerLine[] = [];
  const add = (
    account: LedgerAccount,
    side: LedgerLine['side'],
    amount: string,
    balanceState: LedgerLine['balanceState'],
    backingSafeAddress?: string,
  ) => {
    if (BigInt(amount) === 0n) return;
    accounts.set(account.accountId, account);
    lines.push({
      accountId: account.accountId,
      side,
      amount,
      balanceState,
      ...(backingSafeAddress ? { backingSafeAddress: backingSafeAddress.toLowerCase() } : {}),
    });
  };
  add(
    safeAccount('platform-service-fee', safes.platformServiceFeeSafe, USDT),
    'DEBIT',
    intent.platformServiceFeeUsdt,
    'POSTED',
    safes.platformServiceFeeSafe,
  );
  add(
    account('platform:service-fee:usdt', 'SYSTEM', 'platform-service-fee', USDT, 'PLATFORM_SERVICE_FEE_REVENUE'),
    'CREDIT',
    intent.platformServiceFeeUsdt,
    'POSTED',
    safes.platformServiceFeeSafe,
  );
  const custodyUsdt = (BigInt(intent.custodyProductUsdt) + BigInt(intent.freightUsdt)).toString();
  add(safeAccount('usdt-custody', safes.usdtCustodySafe, USDT), 'DEBIT', custodyUsdt, 'POSTED', safes.usdtCustodySafe);
  add(account(`merchant:${intent.merchant}:usdt`, 'MERCHANT', intent.merchant, USDT, 'MERCHANT_RECEIVABLE'), 'CREDIT', intent.merchantNetReceivableUsdt, 'LOCKED', safes.usdtCustodySafe);
  add(account(`merchant:${intent.merchant}:freight:usdt`, 'MERCHANT', intent.merchant, USDT, 'MERCHANT_FREIGHT_RECEIVABLE'), 'CREDIT', intent.freightUsdt, 'LOCKED', safes.usdtCustodySafe);
  for (const allocation of intent.merchantConcessionAllocations) {
    const pool = concessionPoolAccount(allocation.pool, intent);
    add(
      account(pool.accountId, pool.ownerType, pool.ownerId, USDT, pool.purpose),
      'CREDIT',
      allocation.amount,
      'LOCKED',
      safes.usdtCustodySafe,
    );
  }
  add(account('burn:npl', 'SYSTEM', 'npl-burn', NPL, 'BURN'), 'DEBIT', intent.nplBurnAmount, 'POSTED');
  add(account('clearing:buyer-burn:npl', 'SYSTEM', 'buyer-burn-payment', NPL, 'PAYMENT_CLEARING'), 'CREDIT', intent.nplBurnAmount, 'POSTED');
  add(safeAccount('npl-reward', safes.nplRewardSafe, NPL), 'DEBIT', intent.nplRewardAmount, 'POSTED', safes.nplRewardSafe);
  for (const allocation of intent.nplRewardAllocations) {
    add(
      account(
        `reward:${allocation.role}:${allocation.account}:npl`,
        'BENEFICIARY',
        allocation.account,
        NPL,
        'REWARD_LIABILITY',
        undefined,
        rewardSubtype(allocation.role),
      ),
      'CREDIT',
      allocation.amount,
      'LOCKED',
      safes.nplRewardSafe,
    );
  }
  add(account('issuance:bnm', 'SYSTEM', 'bnm-issuance', BNM, 'BNM_ISSUANCE'), 'DEBIT', intent.bnmAmount, 'POSTED');
  add(account(`buyer:${intent.buyer}:bnm`, 'BUYER', intent.buyer, BNM, 'BNM_LIABILITY'), 'CREDIT', intent.bnmAmount, 'LOCKED');
  return { accounts: [...accounts.values()], lines };
}

function concessionPoolAccount(
  pool: CanonicalPaymentIntent['merchantConcessionAllocations'][number]['pool'],
  intent: CanonicalPaymentIntent,
) {
  if (pool === 'SECKILL_PRIZE') {
    if (intent.seckill) {
      return {
        accountId: `seckill-prize:${intent.sessionId}:usdt`,
        ownerType: 'BENEFICIARY' as const,
        ownerId: intent.sessionId,
        purpose: 'SECKILL_PRIZE_LIABILITY' as const,
      };
    }
    return {
      accountId: 'pool:seckill-prize:usdt',
      ownerType: 'SYSTEM' as const,
      ownerId: 'seckill-prize',
      purpose: 'SECKILL_PRIZE_LIABILITY' as const,
    };
  }
  if (pool === 'NODE_REWARD') {
    return {
      accountId: 'pool:node-reward:usdt',
      ownerType: 'SYSTEM' as const,
      ownerId: 'node-reward',
      purpose: 'NODE_REWARD_POOL' as const,
    };
  }
  return {
    accountId: 'pool:reward-reserve:usdt',
    ownerType: 'SYSTEM' as const,
    ownerId: 'reward-reserve',
    purpose: 'REWARD_RESERVE_POOL' as const,
  };
}

function safeAccount(
  name: 'platform-service-fee' | 'usdt-custody' | 'npl-reward',
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
  subtype?: RewardSubtype,
): LedgerAccount {
  return {
    accountId,
    ownerType,
    ownerId,
    asset,
    purpose,
    ...(safeAddress ? { safeAddress } : {}),
    ...(subtype ? { subtype } : {}),
  };
}

async function ensureAccount(executor: SqlExecutor, value: LedgerAccount) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, safe_address, subtype
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id) DO NOTHING`,
    [
      value.accountId,
      value.ownerType,
      value.ownerId,
      value.asset,
      value.purpose,
      value.safeAddress ?? null,
      value.subtype ?? null,
    ],
  );
  const persisted = await executor.query<LedgerAccountRow>(
    `SELECT owner_type, owner_id, asset, purpose, safe_address, subtype
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
      || row.subtype !== (value.subtype ?? null)
  ) {
    throw new CoreError('InvalidFinality', 'Ledger account metadata does not match the immutable account identity', 409);
  }
}

function rewardSubtype(role: string): RewardSubtype {
  const subtype = {
    genesis: 'GENESIS',
    directReferral: 'DIRECT_REFERRAL',
    district: 'DISTRICT',
    city: 'CITY',
    province: 'PROVINCE',
    region: 'REGION',
    operations: 'OPERATIONS',
    roundingRemainder: 'ROUNDING_REMAINDER',
  }[role];
  if (!subtype) throw new CoreError('InvalidFinality', 'NPL reward subtype is unavailable', 409);
  return subtype as RewardSubtype;
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
        backing_safe_address: line.backingSafeAddress ?? null,
      }))),
    ],
  );
}

function validatePaymentInput(input: RecordPaymentInput) {
  const event = input.event;
  const amounts = [
    event.listPriceUsdt,
    event.productUsdtPaid,
    event.platformServiceFeeUsdt,
    event.custodyProductUsdt,
    event.freightUsdt,
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
      || (
        event.confirmations >= REQUIRED_CONFIRMATIONS
        && (!event.finalizedAt || !Number.isFinite(event.finalizedAt.getTime()))
      )
      || !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(event.classification)
      || amounts.some((amount) => !/^(0|[1-9][0-9]*)$/.test(amount))
  ) throw new CoreError('InvalidFinality', 'Invalid canonical payment event');
  if (BigInt(event.nplBurned) + BigInt(event.nplRewarded) !== BigInt(event.nplPaid)) {
    throw new CoreError('InvalidRequest', 'NPL payment is not conserved');
  }
  if (BigInt(event.productUsdtPaid) + BigInt(event.freightUsdt) !== BigInt(event.usdtPaid)) {
    throw new CoreError('InvalidRequest', 'USDT payment is not conserved');
  }
  if (BigInt(event.platformServiceFeeUsdt) + BigInt(event.custodyProductUsdt) !== BigInt(event.productUsdtPaid)) {
    throw new CoreError('InvalidRequest', 'Product USDT split is not conserved');
  }
}

function exactAmounts(intent: CanonicalPaymentIntent) {
  return {
    listPriceUsdt: intent.listPriceUsdt,
    productUsdtPaymentAmount: intent.productUsdtPaymentAmount,
    platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
    custodyProductUsdt: intent.custodyProductUsdt,
    freightUsdt: intent.freightUsdt,
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

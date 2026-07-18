import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { effectiveSeckillPhase, type StoredSeckillPhase } from './seckill-phase.ts';

interface SessionRow {
  session_id: string;
  policy_version: string | number;
  merchant_id: string;
  product_id: string;
  sku_id: string;
  title: string;
  metadata: unknown;
  attributes: unknown;
  starts_at: Date;
  main_deadline: Date;
  relay_deadline: Date;
  inventory: string | number;
  sold: string | number;
  reserved: string | number;
  seckill_list_price_usdt: string;
  phase: StoredSeckillPhase;
  last_buyer_wallet: string | null;
  prize_pool_usdt: string;
  snapshot: unknown;
  allowed_actions: unknown;
  governance_action_id: string | null;
  rules_content_hash: string | null;
  publication_tx_hash: string | null;
  relay_initial: string | number;
  relay_increment: string | number;
  relay_cap: string | number;
  main_duration: string | number;
  prize_settlement_state: string | null;
  prize_cutoff_at: Date | null;
  candidate_order_id: string | null;
  candidate_buyer_wallet: string | null;
  candidate_payment_event_key: string | null;
  candidate_block_number: string | number | null;
  candidate_log_index: string | number | null;
  candidate_evidence_hash: string | null;
  pool_snapshot_amount_usdt: string | null;
  pool_snapshot_hash: string | null;
  review_decision: string | null;
  review_reason_code: string | null;
  review_evidence_hash: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  award_journal_id: string | null;
  rollover_target_session_id: string | null;
  rollover_journal_id: string | null;
  payout_state: string | null;
  payout_request_id: string | null;
  payout_transfer_id: string | null;
  payout_execution_tx_hash: string | null;
}

interface RelayEventRow {
  cursor: string | number;
  relay_event_key: string;
  payment_event_key: string;
  session_id: string;
  order_id: string;
  buyer_wallet: string;
  transaction_hash: string;
  block_number: string | number;
  block_hash: string;
  previous_relay_deadline: Date;
  relay_deadline: Date;
  finalized_at: Date;
}

export class SeckillService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  current() {
    return this.#transactions.transaction(async (executor) => {
      const now = this.#clock();
      const result = await executor.query<SessionRow>(
        `${sessionSelect()}
         WHERE session.phase <> 'FORCE_CLOSED'
         ORDER BY
           CASE
             WHEN session.phase = 'SETTLED' THEN 3
             WHEN $1 < session.starts_at THEN 2
             WHEN $1 < session.main_deadline AND $1 < session.relay_deadline THEN 0
             ELSE 1
           END,
           session.starts_at DESC
         LIMIT 1`,
        [now],
      );
      if (!result.rows[0]) throw new CoreError('UnknownState', 'No seckill session is published', 404);
      return sessionProjection(result.rows[0], now);
    });
  }

  get(sessionId: string) {
    assertSessionId(sessionId);
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<SessionRow>(
        `${sessionSelect()} WHERE session.session_id = $1`,
        [sessionId.toLowerCase()],
      );
      if (!result.rows[0]) throw new CoreError('UnknownState', 'Seckill session was not found', 404);
      return sessionProjection(result.rows[0], this.#clock());
    });
  }

  history(input: { cursor?: string; limit?: number } = {}) {
    const cursor = cursorValue(input.cursor);
    const limit = pageLimit(input.limit);
    return this.#transactions.transaction(async (executor) => {
      const rows = await executor.query<SessionRow>(
        `${sessionSelect()}
         WHERE session.phase IN ('SETTLED', 'FORCE_CLOSED')
           AND ($1::timestamptz IS NULL OR session.starts_at < $1)
         ORDER BY session.starts_at DESC
         LIMIT $2`,
        [cursor ? new Date(Number(cursor)) : null, limit],
      );
      const now = this.#clock();
      return {
        items: rows.rows.map((row) => sessionProjection(row, now)),
        nextCursor: rows.rows.length === limit
          ? String(rows.rows.at(-1)!.starts_at.getTime())
          : null,
      };
    });
  }

  events(sessionId: string, input: { cursor?: string; limit?: number } = {}) {
    assertSessionId(sessionId);
    const cursor = eventCursor(input.cursor);
    const limit = pageLimit(input.limit);
    return this.#transactions.transaction(async (executor) => {
      await requireSession(executor, sessionId.toLowerCase());
      const rows = await executor.query<RelayEventRow>(
        `SELECT cursor, relay_event_key, payment_event_key, session_id,
           order_id, buyer_wallet, transaction_hash, block_number, block_hash,
           previous_relay_deadline, relay_deadline, finalized_at
         FROM core.seckill_relay_events
         WHERE session_id = $1 AND canonical AND finalized AND cursor > $2
         ORDER BY cursor
         LIMIT $3`,
        [sessionId.toLowerCase(), cursor, limit],
      );
      return {
        items: rows.rows.map((row) => ({
          artifactVersion: CORE_ARTIFACT_VERSION,
          protocolVersion: 1,
          eventId: row.relay_event_key,
          channel: `seckill:${row.session_id}`,
          cursor: String(row.cursor),
          eventType: 'SeckillRelayExtended' as const,
          resourceType: 'SECKILL_SESSION' as const,
          resourceId: row.session_id,
          occurredAt: iso(row.finalized_at),
          finality: 'FINAL' as const,
          payload: {
            orderId: row.order_id,
            buyerWallet: row.buyer_wallet,
            transactionHash: row.transaction_hash,
            blockNumber: String(row.block_number),
            blockHash: row.block_hash,
            paymentEventKey: row.payment_event_key,
            previousRelayDeadline: iso(row.previous_relay_deadline),
            relayDeadline: iso(row.relay_deadline),
            extensionSeconds: Math.max(
              0,
              Math.round((row.relay_deadline.getTime() - row.previous_relay_deadline.getTime()) / 1000),
            ),
          },
        })),
        nextCursor: rows.rows.length === 0 ? String(cursor) : String(rows.rows.at(-1)!.cursor),
      };
    });
  }
}

function sessionSelect() {
  return `SELECT session.session_id, session.policy_version, session.merchant_id,
    session.product_id, session.sku_id, product.title, product.metadata,
    sku.attributes, session.starts_at, session.main_deadline,
    session.relay_deadline, session.inventory, session.sold, session.reserved,
    session.seckill_list_price_usdt::text, session.phase,
    session.last_buyer_wallet, session.prize_pool_usdt::text,
    session.snapshot, session.allowed_actions, session.governance_action_id,
    session.rules_content_hash, session.publication_tx_hash,
    policy.payload ->> 'relayInitial' AS relay_initial,
    policy.payload ->> 'relayIncrement' AS relay_increment,
    policy.payload ->> 'relayCap' AS relay_cap,
    policy.payload ->> 'seckillMainDuration' AS main_duration,
    prize.state AS prize_settlement_state, prize.cutoff_at AS prize_cutoff_at,
    prize.candidate_order_id, prize.candidate_buyer_wallet,
    prize.candidate_payment_event_key, prize.candidate_block_number,
    prize.candidate_log_index, prize.candidate_evidence_hash,
    prize.pool_amount_usdt::text AS pool_snapshot_amount_usdt,
    prize.pool_snapshot_hash, prize.review_decision, prize.review_reason_code,
    prize.review_evidence_hash, prize.reviewed_by, prize.reviewed_at, prize.award_journal_id,
    prize.rollover_target_session_id, prize.rollover_journal_id,
    payout.state AS payout_state, payout.request_id AS payout_request_id,
    payout.payout_transfer_id,
    payout.final_execution_tx_hash AS payout_execution_tx_hash
  FROM core.seckill_sessions session
  JOIN core.products product ON product.product_id = session.product_id
  JOIN core.skus sku ON sku.sku_id = session.sku_id
  JOIN core.policy_snapshots policy ON policy.policy_version = session.policy_version
  LEFT JOIN core.seckill_prize_settlements prize ON prize.session_id = session.session_id
  LEFT JOIN LATERAL (
    SELECT request.request_id, request.state, transfer.transfer_id AS payout_transfer_id,
      final_attempt.execution_tx_hash AS final_execution_tx_hash
    FROM core.settlement_request_items item
    JOIN core.settlement_requests request ON request.request_id = item.request_id
    LEFT JOIN core.settlement_transfers transfer
      ON transfer.request_id = item.request_id AND transfer.request_item_index = item.item_index
    LEFT JOIN LATERAL (
      SELECT attempt.execution_tx_hash
      FROM core.settlement_transfer_attempts attempt
      WHERE attempt.transfer_id = transfer.transfer_id AND attempt.state = 'SETTLED'
      ORDER BY attempt.attempt_number DESC LIMIT 1
    ) final_attempt ON true
    WHERE item.order_id = prize.candidate_order_id
      AND item.account_id = prize.award_account_id
    ORDER BY request.requested_at DESC, request.request_id DESC LIMIT 1
  ) payout ON true`;
}

function sessionProjection(row: SessionRow, now: Date) {
  const phase = effectiveSeckillPhase(row, now);
  const end = new Date(Math.min(row.main_deadline.getTime(), row.relay_deadline.getTime()));
  const available = Number(row.inventory) - Number(row.sold) - Number(row.reserved);
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new CoreError('UnknownState', 'Seckill inventory projection is invalid', 409);
  }
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    sessionId: row.session_id,
    policyVersion: String(row.policy_version),
    merchantId: row.merchant_id,
    product: {
      productId: row.product_id,
      skuId: row.sku_id,
      title: row.title,
      metadata: object(row.metadata),
      attributes: object(row.attributes),
      seckillListPriceUsdt: row.seckill_list_price_usdt,
    },
    phase,
    storedPhase: row.phase,
    serverTime: iso(now),
    startsAt: iso(row.starts_at),
    mainDeadline: iso(row.main_deadline),
    relayDeadline: iso(row.relay_deadline),
    settlementEarliestAt: iso(new Date(end.getTime() + 5 * 60_000)),
    settlementDeadline: iso(new Date(end.getTime() + 10 * 60_000)),
    timers: {
      mainDurationSeconds: positiveInteger(row.main_duration, 'seckill main duration'),
      relayInitialSeconds: positiveInteger(row.relay_initial, 'relay initial'),
      relayIncrementSeconds: positiveInteger(row.relay_increment, 'relay increment'),
      relayCapSeconds: positiveInteger(row.relay_cap, 'relay cap'),
    },
    inventory: {
      total: String(row.inventory),
      sold: String(row.sold),
      reserved: String(row.reserved),
      available: String(available),
    },
    prizePoolUsdt: row.prize_pool_usdt,
    lastBuyerWallet: row.last_buyer_wallet,
    winnerWallet: row.review_decision === 'APPROVED' ? row.candidate_buyer_wallet : null,
    prizeSettlement: row.prize_settlement_state ? {
      state: row.prize_settlement_state,
      cutoffAt: iso(row.prize_cutoff_at!),
      candidate: row.candidate_order_id ? {
        orderId: row.candidate_order_id,
        buyerWallet: row.candidate_buyer_wallet,
        paymentEventKey: row.candidate_payment_event_key,
        blockNumber: String(row.candidate_block_number),
        logIndex: String(row.candidate_log_index),
        evidenceHash: row.candidate_evidence_hash,
      } : null,
      poolAmountUsdt: row.pool_snapshot_amount_usdt,
      poolSnapshotHash: row.pool_snapshot_hash,
      review: row.review_decision ? {
        decision: row.review_decision,
        reasonCode: row.review_reason_code,
        evidenceHash: row.review_evidence_hash,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
      } : null,
      awardJournalId: row.award_journal_id,
      rolloverTargetSessionId: row.rollover_target_session_id,
      rolloverJournalId: row.rollover_journal_id,
      payout: row.review_decision === 'APPROVED' ? {
        state: row.payout_state ?? (BigInt(row.pool_snapshot_amount_usdt ?? '0') > 0n ? 'AVAILABLE' : 'SETTLED'),
        requestId: row.payout_request_id,
        transferId: row.payout_transfer_id,
        finalExecutionTxHash: row.payout_execution_tx_hash,
      } : null,
    } : null,
    snapshot: object(row.snapshot),
    governanceActionId: row.governance_action_id,
    rulesContentHash: row.rules_content_hash,
    publicationTxHash: row.publication_tx_hash,
    allowedActions: stringArray(row.allowed_actions),
  };
}

async function requireSession(executor: SqlExecutor, sessionId: string) {
  const result = await executor.query<{ session_id: string }>(
    'SELECT session_id FROM core.seckill_sessions WHERE session_id = $1',
    [sessionId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Seckill session was not found', 404);
}

function assertSessionId(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid seckill session ID');
}

function pageLimit(value: number | undefined) {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('InvalidRequest', 'Invalid page limit');
  return limit;
}

function eventCursor(value: string | undefined) {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid event cursor');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new CoreError('InvalidRequest', 'Event cursor is outside the supported range');
  return cursor;
}

function cursorValue(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid history cursor');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new CoreError('InvalidRequest', 'History cursor is outside the supported range');
  return String(cursor);
}

function positiveInteger(value: string | number, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new CoreError('UnknownState', `${label} is invalid`, 409);
  return number;
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CoreError('UnknownState', 'Seckill action projection is invalid', 409);
  }
  return value;
}

function iso(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CoreError('UnknownState', 'Seckill timestamp projection is invalid', 409);
  }
  return value.toISOString();
}

import { keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor } from './migrations.ts';

interface PrizeSettlementRow {
  session_id: string;
  state: 'REVIEW_PENDING' | 'APPROVED' | 'ROLLOVER_PENDING' | 'ROLLED_OVER' | 'QUARANTINED';
  candidate_order_id: string | null;
  candidate_buyer_wallet: string | null;
  candidate_payment_event_key: string | null;
  candidate_block_number: string | number | null;
  candidate_log_index: string | number | null;
  candidate_evidence_hash: string | null;
  pool_amount_usdt: string;
  pool_snapshot_hash: string;
  review_decision: 'APPROVED' | 'REJECTED' | null;
  review_reason_code: string | null;
  review_evidence_hash: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_idempotency_key: string | null;
  review_request_hash: string | null;
  award_account_id: string | null;
  award_journal_id: string | null;
  rollover_target_session_id: string | null;
  rollover_journal_id: string | null;
  cutoff_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface WinnerRow {
  order_id: string;
  buyer_wallet: string;
  event_key: string;
  transaction_hash: string;
  block_number: string | number;
  log_index: string | number;
  block_hash: string;
  finalized_at: Date;
}

export async function settleMaturedSeckillPrizes(executor: SqlExecutor, now: Date) {
  const sessions = await executor.query<{
    session_id: string;
    phase: string;
    starts_at: Date;
    cutoff_at: Date;
    policy_version: string | number;
    prize_pool_usdt: string;
    settlement_wallet_address: string;
    force_close_block_number: string | number | null;
  }>(
    `SELECT session.session_id, session.phase, session.starts_at,
       LEAST(session.main_deadline, session.relay_deadline) AS cutoff_at,
       session.policy_version, session.prize_pool_usdt::text,
       lower(policy.payload ->> 'usdtSettlementWallet') AS settlement_wallet_address,
       force_action.block_number AS force_close_block_number
     FROM core.seckill_sessions session
     JOIN core.policy_snapshots policy ON policy.policy_version = session.policy_version
     LEFT JOIN core.seckill_governance_actions force_action
       ON force_action.session_id = session.session_id
      AND force_action.action_kind = 'FORCE_CLOSE' AND force_action.state = 'FINAL'
     WHERE session.phase NOT IN ('SETTLED')
       AND NOT EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements prize
         WHERE prize.session_id = session.session_id
       )
       AND (
         session.phase = 'FORCE_CLOSED'
         OR LEAST(session.main_deadline, session.relay_deadline) + interval '5 minutes' <= $1
       )
       AND NOT EXISTS (
         SELECT 1 FROM core.payment_quotes quote
         WHERE quote.session_id = session.session_id
           AND (
             quote.state = 'SUBMITTED'
             OR (quote.state IN ('QUOTED','REORGED') AND quote.deadline > $1)
           )
       )
     ORDER BY session.starts_at, session.session_id
     FOR UPDATE OF session`,
    [now],
  );

  const settled: string[] = [];
  for (const session of sessions.rows) {
    const winner = await selectWinner(executor, session.session_id, session.cutoff_at, session.force_close_block_number);
    const accountId = `seckill-prize:${session.session_id}:usdt`;
    const ledgerAmount = await lockedPrizeBalance(executor, accountId, session.settlement_wallet_address);
    if (ledgerAmount !== BigInt(session.prize_pool_usdt)) {
      throw new CoreError('InvalidFinality', 'Seckill prize projection does not match its Custody ledger', 409);
    }
    const poolSnapshotHash = hashJson({
      sessionId: session.session_id,
      cutoffAt: session.cutoff_at.toISOString(),
      poolAmountUsdt: ledgerAmount.toString(),
      accountId,
      settlementWalletAddress: session.settlement_wallet_address,
      candidateOrderId: winner?.order_id ?? null,
      candidatePaymentEventKey: winner?.event_key ?? null,
    });
    const candidateEvidenceHash = winner ? hashJson({
      sessionId: session.session_id,
      orderId: winner.order_id,
      buyerWallet: winner.buyer_wallet,
      paymentEventKey: winner.event_key,
      transactionHash: winner.transaction_hash,
      blockNumber: String(winner.block_number),
      logIndex: String(winner.log_index),
      blockHash: winner.block_hash,
      finalizedAt: winner.finalized_at.toISOString(),
      cutoffAt: session.cutoff_at.toISOString(),
    }) : null;
    const state = winner ? 'REVIEW_PENDING' : 'ROLLOVER_PENDING';
    await executor.query(
      `INSERT INTO core.seckill_prize_settlements (
         session_id, cutoff_at, state, candidate_order_id, candidate_buyer_wallet,
         candidate_payment_event_key, candidate_block_number, candidate_log_index,
         candidate_evidence_hash, pool_amount_usdt, pool_snapshot_hash,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        session.session_id,
        session.cutoff_at,
        state,
        winner?.order_id ?? null,
        winner?.buyer_wallet ?? null,
        winner?.event_key ?? null,
        winner?.block_number ?? null,
        winner?.log_index ?? null,
        candidateEvidenceHash,
        ledgerAmount.toString(),
        poolSnapshotHash,
        now,
      ],
    );
    await appendPrizeEvent(executor, {
      sessionId: session.session_id,
      eventType: winner ? 'WINNER_FROZEN' : 'EMPTY_SESSION',
      evidenceHash: candidateEvidenceHash ?? poolSnapshotHash,
      payload: winner
        ? { orderId: winner.order_id, paymentEventKey: winner.event_key, poolSnapshotHash }
        : { poolSnapshotHash, poolAmountUsdt: ledgerAmount.toString() },
      at: now,
    });
    if (!winner) {
      await executor.query(
        `UPDATE core.seckill_sessions
         SET phase = CASE WHEN phase = 'FORCE_CLOSED' THEN phase ELSE 'SETTLED' END,
           updated_at = $2 WHERE session_id = $1`,
        [session.session_id, now],
      );
      await rollPendingSeckillPrize(executor, session.session_id, now);
    }
    settled.push(session.session_id);
  }
  return settled;
}

export async function reviewSeckillPrize(
  executor: SqlExecutor,
  input: {
    sessionId: string;
    actorWallet: string;
    decision: 'APPROVE' | 'REJECT';
    reasonCode: string;
    evidenceHash: string;
    idempotencyKey: string;
    requestHash: string;
    at: Date;
  },
) {
  const result = await executor.query<PrizeSettlementRow>(
    'SELECT * FROM core.seckill_prize_settlements WHERE session_id = $1 FOR UPDATE',
    [input.sessionId],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('FinalityPending', 'Seckill winner candidate is not frozen', 409);
  if (row.review_idempotency_key === input.idempotencyKey) {
    if (row.review_request_hash !== input.requestHash) {
      throw new CoreError('IdempotencyConflict', 'Seckill winner review idempotency conflict', 409);
    }
    return prizeSettlementProjection(executor, row);
  }
  if (row.state !== 'REVIEW_PENDING' || !row.candidate_order_id || !row.candidate_buyer_wallet) {
    throw new CoreError('InvalidRequest', 'Seckill winner is not awaiting review', 409);
  }

  if (input.decision === 'APPROVE') {
    let awardAccountId: string | null = null;
    let awardJournalId: string | null = null;
    if (BigInt(row.pool_amount_usdt) > 0n) {
      const sourceAccountId = `seckill-prize:${row.session_id}:usdt`;
      const backingWallet = await prizeBackingWallet(executor, sourceAccountId, row.pool_amount_usdt);
      awardAccountId = `buyer:${row.candidate_buyer_wallet}:prize:usdt`;
      await ensurePrizeAccount(executor, {
        accountId: awardAccountId,
        ownerType: 'BUYER',
        ownerId: row.candidate_buyer_wallet,
        walletAddress: null,
      });
      awardJournalId = `journal:seckill-prize-award:${row.session_id}`;
      const contentHash = hashJson({
        sessionId: row.session_id,
        orderId: row.candidate_order_id,
        winner: row.candidate_buyer_wallet,
        amountUsdt: row.pool_amount_usdt,
        poolSnapshotHash: row.pool_snapshot_hash,
        reviewEvidenceHash: input.evidenceHash,
      });
      await executor.query(
        'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [
          awardJournalId,
          `seckill-prize-award:${row.session_id}`,
          'SECKILL_PRIZE_AWARDED',
          'SECKILL_SESSION',
          row.session_id,
          row.candidate_order_id,
          null,
          contentHash,
          null,
          null,
          'GOVERNED_EVIDENCE',
          input.evidenceHash,
          null,
          JSON.stringify({
            winner: row.candidate_buyer_wallet,
            candidateEvidenceHash: row.candidate_evidence_hash,
            poolSnapshotHash: row.pool_snapshot_hash,
          }),
          JSON.stringify([
            {
              account_id: sourceAccountId,
              side: 'DEBIT',
              amount: row.pool_amount_usdt,
              balance_state: 'LOCKED',
              backing_wallet_address: backingWallet,
            },
            {
              account_id: awardAccountId,
              side: 'CREDIT',
              amount: row.pool_amount_usdt,
              balance_state: 'AVAILABLE',
              backing_wallet_address: backingWallet,
            },
          ]),
        ],
      );
    }
    await executor.query(
      `UPDATE core.seckill_prize_settlements SET
         state = 'APPROVED', review_decision = 'APPROVED', review_reason_code = $2,
         review_evidence_hash = $3, reviewed_by = $4, reviewed_at = $5,
         review_idempotency_key = $6, review_request_hash = $7,
         award_account_id = $8, award_journal_id = $9, updated_at = $5
       WHERE session_id = $1`,
      [
        row.session_id,
        input.reasonCode,
        input.evidenceHash,
        input.actorWallet,
        input.at,
        input.idempotencyKey,
        input.requestHash,
        awardAccountId,
        awardJournalId,
      ],
    );
    await appendPrizeEvent(executor, {
      sessionId: row.session_id,
      eventType: 'REVIEW_APPROVED',
      evidenceHash: input.evidenceHash,
      payload: { orderId: row.candidate_order_id, awardJournalId, poolSnapshotHash: row.pool_snapshot_hash },
      actorWallet: input.actorWallet,
      at: input.at,
    });
  } else {
    await executor.query(
      `UPDATE core.seckill_prize_settlements SET
         state = 'ROLLOVER_PENDING', review_decision = 'REJECTED', review_reason_code = $2,
         review_evidence_hash = $3, reviewed_by = $4, reviewed_at = $5,
         review_idempotency_key = $6, review_request_hash = $7, updated_at = $5
       WHERE session_id = $1`,
      [
        row.session_id,
        input.reasonCode,
        input.evidenceHash,
        input.actorWallet,
        input.at,
        input.idempotencyKey,
        input.requestHash,
      ],
    );
    await appendPrizeEvent(executor, {
      sessionId: row.session_id,
      eventType: 'REVIEW_REJECTED',
      evidenceHash: input.evidenceHash,
      payload: { orderId: row.candidate_order_id, replacementWinner: null },
      actorWallet: input.actorWallet,
      at: input.at,
    });
  }
  await executor.query(
    `UPDATE core.seckill_sessions
     SET phase = CASE WHEN phase = 'FORCE_CLOSED' THEN phase ELSE 'SETTLED' END,
       updated_at = $2 WHERE session_id = $1`,
    [row.session_id, input.at],
  );
  if (input.decision === 'REJECT') await rollPendingSeckillPrize(executor, row.session_id, input.at);
  const updated = await executor.query<PrizeSettlementRow>(
    'SELECT * FROM core.seckill_prize_settlements WHERE session_id = $1',
    [row.session_id],
  );
  return prizeSettlementProjection(executor, updated.rows[0]!);
}

export async function rollPendingSeckillPrizesIntoSession(
  executor: SqlExecutor,
  targetSessionId: string,
  at: Date,
) {
  const pending = await executor.query<{ session_id: string }>(
    `SELECT source.session_id
     FROM core.seckill_prize_settlements source
     JOIN core.seckill_sessions source_session ON source_session.session_id = source.session_id
     JOIN core.seckill_sessions target ON target.session_id = $1
     WHERE source.state = 'ROLLOVER_PENDING'
       AND source_session.starts_at < target.starts_at
     ORDER BY source_session.starts_at, source.session_id
     FOR UPDATE OF source`,
    [targetSessionId],
  );
  for (const row of pending.rows) await rollPendingSeckillPrize(executor, row.session_id, at, targetSessionId);
}

export async function prizeSettlementProjection(executor: SqlExecutor, row: PrizeSettlementRow) {
  const request = row.award_account_id && row.candidate_order_id
    ? (await executor.query<{
      request_id: string;
      state: string;
      transfer_ids: string[];
      final_execution_tx_hashes: string[];
    }>(
      `SELECT request.request_id, request.state,
         COALESCE(array_agg(DISTINCT transfer.transfer_id)
           FILTER (WHERE transfer.transfer_id IS NOT NULL), '{}') AS transfer_ids,
         COALESCE(array_agg(DISTINCT attempt.execution_tx_hash)
           FILTER (WHERE attempt.state = 'SETTLED' AND attempt.execution_tx_hash IS NOT NULL), '{}')
           AS final_execution_tx_hashes
       FROM core.settlement_request_items item
       JOIN core.settlement_requests request ON request.request_id = item.request_id
       LEFT JOIN core.settlement_transfers transfer
         ON transfer.request_id = item.request_id AND transfer.request_item_index = item.item_index
       LEFT JOIN core.settlement_transfer_attempts attempt ON attempt.transfer_id = transfer.transfer_id
       WHERE item.order_id = $1 AND item.account_id = $2
       GROUP BY request.request_id
       ORDER BY request.requested_at DESC, request.request_id DESC LIMIT 1`,
      [row.candidate_order_id, row.award_account_id],
    )).rows[0]
    : undefined;
  return Object.freeze({
    state: row.state,
    cutoffAt: row.cutoff_at.toISOString(),
    candidate: row.candidate_order_id ? Object.freeze({
      orderId: row.candidate_order_id,
      buyerWallet: row.candidate_buyer_wallet!,
      paymentEventKey: row.candidate_payment_event_key!,
      blockNumber: String(row.candidate_block_number),
      logIndex: String(row.candidate_log_index),
      evidenceHash: row.candidate_evidence_hash!,
    }) : null,
    poolAmountUsdt: row.pool_amount_usdt,
    poolSnapshotHash: row.pool_snapshot_hash,
    review: row.review_decision ? Object.freeze({
      decision: row.review_decision,
      reasonCode: row.review_reason_code!,
      evidenceHash: row.review_evidence_hash!,
      reviewedBy: row.reviewed_by!,
      reviewedAt: row.reviewed_at!.toISOString(),
    }) : null,
    awardJournalId: row.award_journal_id,
    rolloverTargetSessionId: row.rollover_target_session_id,
    rolloverJournalId: row.rollover_journal_id,
    payout: row.state === 'APPROVED' ? Object.freeze({
      state: request?.state ?? (BigInt(row.pool_amount_usdt) > 0n ? 'AVAILABLE' : 'SETTLED'),
      requestId: request?.request_id ?? null,
      transferIds: request?.transfer_ids ?? [],
      finalExecutionTxHashes: request?.final_execution_tx_hashes ?? [],
    }) : null,
  });
}

async function rollPendingSeckillPrize(
  executor: SqlExecutor,
  sourceSessionId: string,
  at: Date,
  explicitTargetSessionId?: string,
) {
  const source = await executor.query<PrizeSettlementRow & { starts_at: Date; settlement_wallet_address: string }>(
    `SELECT prize.*, session.starts_at,
       lower(policy.payload ->> 'usdtSettlementWallet') AS settlement_wallet_address
     FROM core.seckill_prize_settlements prize
     JOIN core.seckill_sessions session ON session.session_id = prize.session_id
     JOIN core.policy_snapshots policy ON policy.policy_version = session.policy_version
     WHERE prize.session_id = $1 FOR UPDATE OF prize`,
    [sourceSessionId],
  );
  const row = source.rows[0];
  if (!row || row.state !== 'ROLLOVER_PENDING') return;
  if (BigInt(row.pool_amount_usdt) === 0n) {
    await executor.query(
      "UPDATE core.seckill_prize_settlements SET state = 'ROLLED_OVER', updated_at = $2 WHERE session_id = $1",
      [sourceSessionId, at],
    );
    return;
  }
  const target = await executor.query<{ session_id: string; settlement_wallet_address: string }>(
    explicitTargetSessionId
      ? `SELECT session.session_id, lower(policy.payload ->> 'usdtSettlementWallet') AS settlement_wallet_address
         FROM core.seckill_sessions session
         JOIN core.policy_snapshots policy ON policy.policy_version = session.policy_version
         WHERE session.session_id = $1 AND session.starts_at > $2`
      : `SELECT session.session_id, lower(policy.payload ->> 'usdtSettlementWallet') AS settlement_wallet_address
         FROM core.seckill_sessions session
         JOIN core.policy_snapshots policy ON policy.policy_version = session.policy_version
         WHERE session.starts_at > $1 AND session.phase <> 'FORCE_CLOSED'
         ORDER BY session.starts_at, session.session_id LIMIT 1`,
    explicitTargetSessionId ? [explicitTargetSessionId, row.starts_at] : [row.starts_at],
  );
  const next = target.rows[0];
  if (!next) return;
  if (next.settlement_wallet_address !== row.settlement_wallet_address) {
    throw new CoreError('InvalidFinality', 'Seckill rollover cannot cross settlement wallet snapshots', 409);
  }
  const sourceAccountId = `seckill-prize:${sourceSessionId}:usdt`;
  const targetAccountId = `seckill-prize:${next.session_id}:usdt`;
  await prizeBackingWallet(executor, sourceAccountId, row.pool_amount_usdt);
  await ensurePrizeAccount(executor, {
    accountId: targetAccountId,
    ownerType: 'BENEFICIARY',
    ownerId: next.session_id,
    walletAddress: null,
  });
  const journalId = `journal:seckill-prize-rollover:${sourceSessionId}`;
  const contentHash = hashJson({
    sourceSessionId,
    targetSessionId: next.session_id,
    amountUsdt: row.pool_amount_usdt,
    poolSnapshotHash: row.pool_snapshot_hash,
  });
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize-rollover:${sourceSessionId}`,
      'SECKILL_PRIZE_ROLLED_OVER',
      'SECKILL_SESSION',
      sourceSessionId,
      row.candidate_order_id,
      null,
      contentHash,
      null,
      null,
      'GOVERNED_EVIDENCE',
      row.review_evidence_hash ?? row.pool_snapshot_hash,
      null,
      JSON.stringify({ sourceSessionId, targetSessionId: next.session_id, poolSnapshotHash: row.pool_snapshot_hash }),
      JSON.stringify([
        {
          account_id: sourceAccountId,
          side: 'DEBIT',
          amount: row.pool_amount_usdt,
          balance_state: 'LOCKED',
          backing_wallet_address: row.settlement_wallet_address,
        },
        {
          account_id: targetAccountId,
          side: 'CREDIT',
          amount: row.pool_amount_usdt,
          balance_state: 'LOCKED',
          backing_wallet_address: row.settlement_wallet_address,
        },
      ]),
    ],
  );
  await executor.query(
    `UPDATE core.seckill_sessions SET prize_pool_usdt = CASE
       WHEN session_id = $1 THEN prize_pool_usdt - $3
       WHEN session_id = $2 THEN prize_pool_usdt + $3
       ELSE prize_pool_usdt END,
       updated_at = $4
     WHERE session_id IN ($1,$2)`,
    [sourceSessionId, next.session_id, row.pool_amount_usdt, at],
  );
  await executor.query(
    `UPDATE core.seckill_prize_settlements
     SET state = 'ROLLED_OVER', rollover_target_session_id = $2,
       rollover_journal_id = $3, updated_at = $4 WHERE session_id = $1`,
    [sourceSessionId, next.session_id, journalId, at],
  );
  await appendPrizeEvent(executor, {
    sessionId: sourceSessionId,
    eventType: 'ROLLED_OVER',
    evidenceHash: contentHash,
    payload: { targetSessionId: next.session_id, amountUsdt: row.pool_amount_usdt, journalId },
    at,
  });
}

async function selectWinner(
  executor: SqlExecutor,
  sessionId: string,
  cutoffAt: Date,
  forceCloseBlockNumber: string | number | null,
) {
  const result = await executor.query<WinnerRow>(
    `SELECT orders.order_id, lower(orders.buyer_wallet) AS buyer_wallet,
       payment.event_key, payment.transaction_hash, payment.block_number,
       payment.log_index, payment.block_hash, relay.finalized_at
     FROM core.seckill_relay_events relay
     JOIN core.payment_events payment ON payment.event_key = relay.payment_event_key
     JOIN core.orders orders ON orders.order_id = relay.order_id
     JOIN core.transaction_finality finality
       ON finality.resource_type = 'ORDER_PAYMENT'
      AND finality.resource_id = orders.order_id
      AND finality.tx_hash = payment.transaction_hash
      AND finality.block_hash = payment.block_hash
     WHERE relay.session_id = $1 AND relay.canonical AND relay.finalized
       AND relay.finalized_at <= $2
       AND payment.canonical AND payment.classification = 'SECKILL'
       AND payment.observed_at <= $2
       AND ($3::bigint IS NULL OR payment.block_number <= $3)
       AND finality.state = 'FINAL' AND finality.receipt_status = 1
       AND finality.confirmations >= finality.required_confirmations
       AND orders.finality_status = 'FINAL' AND orders.state <> 'REORG_PENDING'
     ORDER BY payment.block_number DESC, payment.log_index DESC, orders.order_id DESC
     LIMIT 1`,
    [sessionId, cutoffAt, forceCloseBlockNumber],
  );
  return result.rows[0];
}

async function lockedPrizeBalance(executor: SqlExecutor, accountId: string, walletAddress: string) {
  if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) {
    throw new CoreError('ConfigurationRequired', 'Seckill settlement wallet snapshot is unavailable', 503);
  }
  const result = await executor.query<{ amount: string }>(
    `SELECT COALESCE(sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END),0)::text AS amount
     FROM core.ledger_lines line
     WHERE line.account_id = $1 AND line.balance_state = 'LOCKED'
       AND line.backing_wallet_address = $2`,
    [accountId, walletAddress],
  );
  return BigInt(result.rows[0]?.amount ?? '0');
}

async function prizeBackingWallet(executor: SqlExecutor, accountId: string, amount: string) {
  const result = await executor.query<{ backing_wallet_address: string; amount: string }>(
    `SELECT line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_lines line
     WHERE line.account_id = $1 AND line.balance_state = 'LOCKED'
       AND line.backing_wallet_address IS NOT NULL
     GROUP BY line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0`,
    [accountId],
  );
  if (result.rows.length !== 1 || BigInt(result.rows[0]!.amount) < BigInt(amount)) {
    throw new CoreError('InvalidFinality', 'Seckill prize is not fully backed by one settlement wallet', 409);
  }
  return result.rows[0]!.backing_wallet_address;
}

async function ensurePrizeAccount(
  executor: SqlExecutor,
  input: {
    accountId: string;
    ownerType: 'BUYER' | 'BENEFICIARY';
    ownerId: string;
    walletAddress: string | null;
  },
) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, wallet_address
     ) VALUES ($1,$2,$3,'USDT','SECKILL_PRIZE_LIABILITY',$4)
     ON CONFLICT (account_id) DO NOTHING`,
    [input.accountId, input.ownerType, input.ownerId, input.walletAddress],
  );
  const row = (await executor.query<{
    owner_type: string;
    owner_id: string;
    asset: string;
    purpose: string;
    wallet_address: string | null;
  }>(
    `SELECT owner_type, owner_id, asset, purpose, wallet_address
     FROM core.ledger_accounts WHERE account_id = $1`,
    [input.accountId],
  )).rows[0];
  if (
    !row || row.owner_type !== input.ownerType || row.owner_id !== input.ownerId
      || row.asset !== 'USDT' || row.purpose !== 'SECKILL_PRIZE_LIABILITY'
      || row.wallet_address !== input.walletAddress
  ) throw new CoreError('InvalidFinality', 'Seckill prize account identity mismatch', 409);
}

async function appendPrizeEvent(
  executor: SqlExecutor,
  input: {
    sessionId: string;
    eventType: 'WINNER_FROZEN' | 'EMPTY_SESSION' | 'REVIEW_APPROVED' | 'REVIEW_REJECTED' | 'ROLLED_OVER';
    evidenceHash: string;
    payload: Record<string, unknown>;
    actorWallet?: string;
    at: Date;
  },
) {
  const eventId = hashJson({
    sessionId: input.sessionId,
    eventType: input.eventType,
    evidenceHash: input.evidenceHash,
  });
  await executor.query(
    `INSERT INTO core.seckill_prize_settlement_events (
       event_id, session_id, event_type, evidence_hash, payload, actor_wallet, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      input.sessionId,
      input.eventType,
      input.evidenceHash,
      JSON.stringify(input.payload),
      input.actorWallet ?? null,
      input.at,
    ],
  );
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

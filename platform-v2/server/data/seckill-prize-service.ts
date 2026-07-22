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

interface PrizeFundingReversalInput {
  fundingKind: 'INJECTION' | 'PAYMENT_CONTRIBUTION' | 'PAYOUT_RECOVERY';
  fundingId: string;
  sourceSessionId: string;
  amountUsdt: string;
  settlementWalletAddress: string;
  evidenceHash: string;
  sourceTxHash: string;
  sourceBlockHash: string;
  at: Date;
  preserveRecoveredPayout?: true;
}

export interface PrizeFundingReversalPlan {
  exposureId: string;
  mode: 'STANDARD_REVERSAL' | 'DEFICIT_MONITORING';
  poolSessionId: string;
  recoverySessionId: string;
  debitAccountId: string;
  debitBalanceState: 'LOCKED' | 'POSTED';
}

interface PrizePayoutSnapshotRow {
  request_id: string;
  item_index: number;
  request_state: string;
  transfer_id: string | null;
  transfer_state: string | null;
  attempt_id: string | null;
  attempt_state: string | null;
  execution_tx_hash: string | null;
  finality_state: string | null;
  receipt_status: number | null;
  confirmations: string | number | null;
  block_hash: string | null;
}

export interface FinalizedPrizeInjectionReversalInput {
  actionId: string;
  sessionId: string;
  policyVersion: number;
  evidenceHash: string;
  sourceTxHash: string;
  sourceBlockHash: string;
  canonicalBlockHash: string;
  at: Date;
}

export async function lockSeckillPrizeFundingMutation(executor: SqlExecutor) {
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['seckill-prize-funding-mutation'],
  );
}

export async function settleMaturedSeckillPrizes(executor: SqlExecutor, now: Date) {
  await lockSeckillPrizeFundingMutation(executor);
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
           AND quote.state IN ('QUOTED','SUBMITTED','REORGED')
       )
     ORDER BY session.starts_at, session.session_id
     FOR UPDATE OF session`,
    [now],
  );

  const settled: string[] = [];
  for (const session of sessions.rows) {
    if (await hasUnsettledWinnerCandidate(executor, session.session_id, session.cutoff_at, session.force_close_block_number)) {
      continue;
    }
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

async function hasUnsettledWinnerCandidate(
  executor: SqlExecutor,
  sessionId: string,
  cutoffAt: Date,
  forceCloseBlockNumber: string | number | null,
) {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM core.orders orders
       JOIN core.payment_events payment
         ON payment.order_id = orders.order_id
       LEFT JOIN core.seckill_relay_events relay
         ON relay.payment_event_key = payment.event_key
        AND relay.canonical
       LEFT JOIN core.transaction_finality finality
         ON finality.resource_type = 'ORDER_PAYMENT'
        AND finality.resource_id = orders.order_id
        AND finality.tx_hash = payment.transaction_hash
        AND finality.block_hash = payment.block_hash
       WHERE orders.seckill_snapshot ->> 'sessionId' = $1
         AND payment.canonical
         AND payment.classification = 'SECKILL'
         AND payment.observed_at <= $2
         AND ($3::bigint IS NULL OR payment.block_number <= $3)
         AND (
           relay.relay_event_key IS NULL
           OR relay.finalized = false
           OR finality.transaction_id IS NULL
           OR finality.state <> 'FINAL'
           OR finality.receipt_status <> 1
           OR finality.confirmations < finality.required_confirmations
           OR orders.finality_status <> 'FINAL'
         )
     ) AS exists`,
    [sessionId, cutoffAt, forceCloseBlockNumber],
  );
  return result.rows[0]?.exists === true;
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
  await lockSeckillPrizeFundingMutation(executor);
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

export async function reverseFinalizedSeckillPrizeInjection(
  executor: SqlExecutor,
  input: FinalizedPrizeInjectionReversalInput,
) {
  const injection = await executor.query<{
    amount_usdt: string;
    settlement_wallet_address: string;
    final_journal_id: string | null;
    reversal_journal_id: string | null;
  }>(
    `SELECT amount_usdt::text, settlement_wallet_address, final_journal_id, reversal_journal_id
     FROM core.seckill_prize_injections WHERE action_id = $1 FOR UPDATE`,
    [input.actionId],
  );
  const row = injection.rows[0];
  if (!row?.final_journal_id || row.reversal_journal_id) return;
  const plan = await prepareSeckillPrizeFundingReversal(executor, {
    fundingKind: 'INJECTION',
    fundingId: input.actionId,
    sourceSessionId: input.sessionId,
    amountUsdt: row.amount_usdt,
    settlementWalletAddress: row.settlement_wallet_address,
    evidenceHash: input.evidenceHash,
    sourceTxHash: input.sourceTxHash,
    sourceBlockHash: input.sourceBlockHash,
    at: input.at,
  });
  if (
    plan.mode === 'STANDARD_REVERSAL'
    && await lockedPrizeBalance(executor, plan.debitAccountId, row.settlement_wallet_address)
      < BigInt(row.amount_usdt)
  ) {
    throw new CoreError('UnknownState', 'Reorged prize funding is no longer available at its source account', 409);
  }
  const walletAccountId = `wallet:usdt-custody:${row.settlement_wallet_address}:usdt`;
  const journalId = `journal:seckill-prize-reversal:${input.actionId}`;
  const lines = [
    {
      account_id: plan.debitAccountId,
      side: 'DEBIT',
      amount: row.amount_usdt,
      balance_state: plan.debitBalanceState,
      backing_wallet_address: row.settlement_wallet_address,
    },
    {
      account_id: walletAccountId,
      side: 'CREDIT',
      amount: row.amount_usdt,
      balance_state: 'POSTED',
      backing_wallet_address: row.settlement_wallet_address,
    },
  ];
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize:${input.actionId}:reorg:${input.canonicalBlockHash}`,
      'SECKILL_PRIZE_INJECTION_REVERSED',
      'SECKILL_SESSION',
      input.sessionId,
      null,
      input.policyVersion,
      hashJson({ actionId: input.actionId, evidenceHash: input.evidenceHash, lines }),
      input.sourceTxHash,
      input.sourceBlockHash,
      'CHAIN_EVENT',
      input.evidenceHash,
      row.final_journal_id,
      JSON.stringify({
        actionId: input.actionId,
        sessionId: input.sessionId,
        amountUsdt: row.amount_usdt,
        resolutionMode: plan.mode,
        exposureId: plan.exposureId,
      }),
      JSON.stringify(lines),
    ],
  );
  const updated = await executor.query<{ session_id: string }>(
    `UPDATE core.seckill_sessions SET prize_pool_usdt = prize_pool_usdt - $2, updated_at = $3
     WHERE session_id = $1 AND prize_pool_usdt >= $2 RETURNING session_id`,
    [plan.poolSessionId, row.amount_usdt, input.at],
  );
  if (!updated.rows[0]) throw new CoreError('UnknownState', 'Prize pool cannot reverse the reorged injection', 409);
  await executor.query(
    `UPDATE core.seckill_prize_injections SET reversal_journal_id = $2, updated_at = $3
     WHERE action_id = $1`,
    [input.actionId, journalId, input.at],
  );
  await recordSeckillPrizeFundingReversed(executor, {
    plan,
    journalId,
    evidenceHash: input.evidenceHash,
    at: input.at,
  });
}

export async function prepareSeckillPrizeFundingReversal(
  executor: SqlExecutor,
  input: PrizeFundingReversalInput,
) : Promise<PrizeFundingReversalPlan> {
  await lockSeckillPrizeFundingMutation(executor);
  const visited = new Set<string>();
  const outcomes: PrizeSettlementRow[] = [];
  let liabilitySessionId = input.sourceSessionId;
  while (true) {
    if (visited.has(liabilitySessionId)) {
      throw new CoreError('UnknownState', 'Seckill prize rollover chain contains a cycle', 409);
    }
    visited.add(liabilitySessionId);
    const lockedSession = await executor.query<{ session_id: string }>(
      'SELECT session_id FROM core.seckill_sessions WHERE session_id = $1 FOR UPDATE',
      [liabilitySessionId],
    );
    if (!lockedSession.rows[0]) throw new CoreError('UnknownState', 'Seckill prize session is unavailable', 409);
    const outcome = (await executor.query<PrizeSettlementRow>(
      'SELECT * FROM core.seckill_prize_settlements WHERE session_id = $1 FOR UPDATE',
      [liabilitySessionId],
    )).rows[0];
    if (!outcome) break;
    outcomes.push(outcome);
    if (outcome.rollover_target_session_id) {
      liabilitySessionId = outcome.rollover_target_session_id;
      continue;
    }
    break;
  }

  const awardedOutcome = [...outcomes].reverse().find((outcome) => (
    outcome.award_journal_id && outcome.award_account_id && outcome.candidate_order_id
  ));
  const payout = awardedOutcome
    ? await lockPrizePayoutSnapshot(executor, awardedOutcome)
    : [];
  const hasPotentialBroadcastPayout = payout.some((row) => (
    row.execution_tx_hash !== null
    || ['LEASED', 'RETRYABLE', 'SUBMITTED', 'MINED', 'SETTLED'].includes(row.attempt_state ?? '')
  )) && !prizePayoutTerminallyFailed(payout);
  for (const outcome of outcomes) await quarantinePrizeOutcome(executor, outcome.session_id, input);
  const exposureId = await recordPrizeReorgExposure(executor, {
    input,
    liabilitySessionId,
    outcomes,
    payout,
    mode: hasPotentialBroadcastPayout ? 'DEFICIT_MONITORING' : 'STANDARD_REVERSAL',
  });
  await quarantinePrizePayout(executor, payout, input, exposureId, hasPotentialBroadcastPayout);
  if (hasPotentialBroadcastPayout) {
    const deficitAccountId = 'system:seckill-prize-reorg-deficit:usdt';
    await ensurePrizeDeficitAccount(executor, deficitAccountId);
    await lockLedgerAccounts(executor, [deficitAccountId]);
    await enqueuePrizeReorgReconciliation(executor, exposureId, input, payout);
    await pausePrizeFundingReorg(executor, input, 1);
    return {
      exposureId,
      mode: 'DEFICIT_MONITORING',
      poolSessionId: liabilitySessionId,
      recoverySessionId: liabilitySessionId,
      debitAccountId: deficitAccountId,
      debitBalanceState: 'POSTED',
    };
  }

  for (const outcome of outcomes) {
    if (
      !input.preserveRecoveredPayout
      && outcome.award_journal_id
      && outcome.award_account_id
      && outcome.candidate_order_id
    ) {
      await reversePrizeAward(executor, outcome, input);
    }
  }
  const liabilityAccountId = `seckill-prize:${liabilitySessionId}:usdt`;
  await lockLedgerAccounts(executor, [
    liabilityAccountId,
    `seckill-prize:${input.sourceSessionId}:usdt`,
  ]);
  const liabilityBalance = await lockedPrizeBalance(
    executor,
    liabilityAccountId,
    input.settlementWalletAddress,
  );
  if (liabilityBalance < BigInt(input.amountUsdt)) {
    throw new CoreError('UnknownState', 'Reorged prize funding is not fully backed by its current pool', 409);
  }
  if (liabilitySessionId !== input.sourceSessionId) {
    const sourceAccountId = `seckill-prize:${input.sourceSessionId}:usdt`;
    const journalId = `journal:seckill-prize-funding-recall:${hashJson({
      fundingId: input.fundingId,
      sourceSessionId: input.sourceSessionId,
      liabilitySessionId,
    }).slice(2)}`;
    const lines = [
      {
        account_id: liabilityAccountId,
        side: 'DEBIT',
        amount: input.amountUsdt,
        balance_state: 'LOCKED',
        backing_wallet_address: input.settlementWalletAddress,
      },
      {
        account_id: sourceAccountId,
        side: 'CREDIT',
        amount: input.amountUsdt,
        balance_state: 'LOCKED',
        backing_wallet_address: input.settlementWalletAddress,
      },
    ];
    await executor.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        journalId,
        `seckill-prize-funding-recall:${input.fundingId}`,
        'SECKILL_PRIZE_FUNDING_RECALLED',
        'SECKILL_SESSION',
        input.sourceSessionId,
        null,
        null,
        hashJson({ fundingId: input.fundingId, evidenceHash: input.evidenceHash, lines }),
        null,
        null,
        'RECONCILIATION',
        input.evidenceHash,
        null,
        JSON.stringify({
          fundingId: input.fundingId,
          sourceSessionId: input.sourceSessionId,
          liabilitySessionId,
          amountUsdt: input.amountUsdt,
        }),
        JSON.stringify(lines),
      ],
    );
    const moved = await executor.query<{ session_id: string }>(
      `UPDATE core.seckill_sessions SET prize_pool_usdt = CASE
         WHEN session_id = $1 THEN prize_pool_usdt + $3
         WHEN session_id = $2 THEN prize_pool_usdt - $3
         ELSE prize_pool_usdt END,
         updated_at = $4
       WHERE session_id IN ($1,$2)
         AND (session_id <> $2 OR prize_pool_usdt >= $3)
       RETURNING session_id`,
      [input.sourceSessionId, liabilitySessionId, input.amountUsdt, input.at],
    );
    if (moved.rows.length !== 2) {
      throw new CoreError('UnknownState', 'Rolled prize pool cannot recall reorged funding', 409);
    }
  }
  await pausePrizeFundingReorg(executor, input, 1);
  return {
    exposureId,
    mode: 'STANDARD_REVERSAL',
    poolSessionId: input.sourceSessionId,
    recoverySessionId: liabilitySessionId,
    debitAccountId: `seckill-prize:${input.sourceSessionId}:usdt`,
    debitBalanceState: 'LOCKED',
  };
}

async function reversePrizeAward(
  executor: SqlExecutor,
  outcome: PrizeSettlementRow,
  input: PrizeFundingReversalInput,
  recoveryEpisode = 1,
  recoveryIdentity = String(recoveryEpisode),
) {
  const journalId = recoveryEpisode === 1
    ? `journal:seckill-prize-award-reversal:${outcome.session_id}`
    : `journal:seckill-prize-award-reversal:${outcome.session_id}:${recoveryIdentity}`;
  const existing = await executor.query<{ journal_id: string }>(
    'SELECT journal_id FROM core.ledger_journals WHERE journal_id = $1',
    [journalId],
  );
  if (existing.rows[0]) return;
  await lockLedgerAccounts(executor, [
    outcome.award_account_id!,
    `seckill-prize:${outcome.session_id}:usdt`,
  ]);
  const balances = await executor.query<{
    balance_state: string;
    backing_wallet_address: string | null;
    amount: string;
  }>(
    `SELECT line.balance_state, line.backing_wallet_address,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_lines line
     JOIN core.ledger_journals journal ON journal.journal_id = line.journal_id
     WHERE journal.order_id = $1 AND line.account_id = $2
     GROUP BY line.balance_state, line.backing_wallet_address
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY line.balance_state, line.backing_wallet_address`,
    [outcome.candidate_order_id, outcome.award_account_id],
  );
  if (
    balances.rows.some((balance) => (
      BigInt(balance.amount) <= 0n
      || balance.backing_wallet_address !== input.settlementWalletAddress
    ))
    || balances.rows.reduce((total, balance) => total + BigInt(balance.amount), 0n)
      !== BigInt(outcome.pool_amount_usdt)
  ) {
    throw new CoreError('UnknownState', 'Awarded prize liability cannot be safely reversed', 409);
  }
  const sourceAccountId = `seckill-prize:${outcome.session_id}:usdt`;
  const lines = [
    ...balances.rows.map((balance) => ({
      account_id: outcome.award_account_id!,
      side: 'DEBIT',
      amount: balance.amount,
      balance_state: balance.balance_state,
      backing_wallet_address: balance.backing_wallet_address,
    })),
    {
      account_id: sourceAccountId,
      side: 'CREDIT',
      amount: outcome.pool_amount_usdt,
      balance_state: 'LOCKED',
      backing_wallet_address: input.settlementWalletAddress,
    },
  ];
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize-award-reversal:${outcome.session_id}:${recoveryIdentity}`,
      'SECKILL_PRIZE_AWARD_REVERSED',
      'SECKILL_SESSION',
      outcome.session_id,
      outcome.candidate_order_id,
      null,
      hashJson({ sessionId: outcome.session_id, evidenceHash: input.evidenceHash, lines }),
      null,
      null,
      'RECONCILIATION',
      input.evidenceHash,
      outcome.award_journal_id,
      JSON.stringify({
        sessionId: outcome.session_id,
        fundingId: input.fundingId,
        awardJournalId: outcome.award_journal_id,
      }),
      JSON.stringify(lines),
    ],
  );
}

async function lockPrizePayoutSnapshot(
  executor: SqlExecutor,
  outcome: PrizeSettlementRow,
): Promise<PrizePayoutSnapshotRow[]> {
  const items = await executor.query<{
    request_id: string;
    item_index: number;
    request_state: string;
  }>(
    `SELECT item.request_id, item.item_index, request.state AS request_state
     FROM core.settlement_request_items item
     JOIN core.settlement_requests request ON request.request_id = item.request_id
     WHERE item.order_id = $1 AND item.account_id = $2
     ORDER BY item.request_id, item.item_index
     FOR UPDATE OF request, item`,
    [outcome.candidate_order_id, outcome.award_account_id],
  );
  if (items.rows.length === 0) return [];
  const requestIds = [...new Set(items.rows.map((row) => row.request_id))].sort();
  const transfers = await executor.query<{
    request_id: string;
    request_item_index: number;
    transfer_id: string;
    transfer_state: string;
  }>(
    `SELECT request_id, request_item_index, transfer_id, state AS transfer_state
     FROM core.settlement_transfers
     WHERE request_id = ANY($1::text[])
     ORDER BY request_id, request_item_index
     FOR UPDATE`,
    [requestIds],
  );
  const transferIds = transfers.rows.map((row) => row.transfer_id);
  const attempts = transferIds.length === 0
    ? []
    : (await executor.query<{
      transfer_id: string;
      attempt_id: string;
      attempt_state: string;
      execution_tx_hash: string | null;
      finality_state: string | null;
      receipt_status: number | null;
      confirmations: string | number | null;
      block_hash: string | null;
    }>(
      `SELECT attempt.transfer_id, attempt.attempt_id, attempt.state AS attempt_state,
         attempt.execution_tx_hash, finality.state AS finality_state,
         finality.receipt_status, finality.confirmations, finality.block_hash
       FROM core.settlement_transfer_attempts attempt
       LEFT JOIN core.transaction_finality finality
         ON finality.transaction_id = 'settlement-finality:' || attempt.attempt_id
       WHERE attempt.transfer_id = ANY($1::text[])
       ORDER BY attempt.transfer_id, attempt.attempt_number
       FOR UPDATE OF attempt`,
      [transferIds],
    )).rows;
  const transferByItem = new Map(transfers.rows.map((row) => (
    [`${row.request_id}:${row.request_item_index}`, row] as const
  )));
  const attemptsByTransfer = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    attemptsByTransfer.set(attempt.transfer_id, [
      ...(attemptsByTransfer.get(attempt.transfer_id) ?? []),
      attempt,
    ]);
  }
  const snapshot: PrizePayoutSnapshotRow[] = [];
  for (const item of items.rows) {
    const transfer = transferByItem.get(`${item.request_id}:${item.item_index}`);
    if (!transfer) {
      snapshot.push({
        ...item,
        transfer_id: null,
        transfer_state: null,
        attempt_id: null,
        attempt_state: null,
        execution_tx_hash: null,
        finality_state: null,
        receipt_status: null,
        confirmations: null,
        block_hash: null,
      });
      continue;
    }
    const transferAttempts = attemptsByTransfer.get(transfer.transfer_id) ?? [];
    if (transferAttempts.length === 0) {
      snapshot.push({
        ...item,
        transfer_id: transfer.transfer_id,
        transfer_state: transfer.transfer_state,
        attempt_id: null,
        attempt_state: null,
        execution_tx_hash: null,
        finality_state: null,
        receipt_status: null,
        confirmations: null,
        block_hash: null,
      });
      continue;
    }
    for (const attempt of transferAttempts) {
      snapshot.push({
        ...item,
        transfer_id: transfer.transfer_id,
        transfer_state: transfer.transfer_state,
        attempt_id: attempt.attempt_id,
        attempt_state: attempt.attempt_state,
        execution_tx_hash: attempt.execution_tx_hash,
        finality_state: attempt.finality_state,
        receipt_status: attempt.receipt_status,
        confirmations: attempt.confirmations,
        block_hash: attempt.block_hash,
      });
    }
  }
  return snapshot;
}

function prizePayoutTerminallyFailed(payout: readonly PrizePayoutSnapshotRow[]) {
  const byTransfer = new Map<string, PrizePayoutSnapshotRow[]>();
  for (const row of payout) {
    if (!row.transfer_id) return false;
    byTransfer.set(row.transfer_id, [...(byTransfer.get(row.transfer_id) ?? []), row]);
  }
  return byTransfer.size > 0 && [...byTransfer.values()].every((attempts) => {
    if (attempts[0]?.transfer_state !== 'QUARANTINED') return false;
    const terminalFailure = attempts.some((attempt) => (
      attempt.execution_tx_hash !== null
      && ['FAILED', 'QUARANTINED'].includes(attempt.attempt_state ?? '')
      && attempt.finality_state === 'FAILED'
      && attempt.receipt_status === 0
      && Number(attempt.confirmations) >= 15
      && attempt.block_hash !== null
    ));
    return terminalFailure && attempts.every((attempt) => (
      (attempt.execution_tx_hash === null && attempt.attempt_state === 'QUARANTINED')
      || (attempt.execution_tx_hash !== null && attempt.attempt_state === 'REPLACED')
      || (
        attempt.execution_tx_hash !== null
        && ['FAILED', 'QUARANTINED'].includes(attempt.attempt_state ?? '')
        && attempt.finality_state === 'FAILED'
        && attempt.receipt_status === 0
        && Number(attempt.confirmations) >= 15
        && attempt.block_hash !== null
      )
    ));
  });
}

async function quarantinePrizePayout(
  executor: SqlExecutor,
  payout: readonly PrizePayoutSnapshotRow[],
  input: PrizeFundingReversalInput,
  exposureId: string,
  preserveBroadcastFinality: boolean,
) {
  const requestIds = [...new Set(payout.map((row) => row.request_id))].sort();
  const transferIds = [...new Set(payout.flatMap((row) => row.transfer_id ? [row.transfer_id] : []))].sort();
  if (requestIds.length > 0) {
    await executor.query(
      `UPDATE core.settlement_requests SET state = 'QUARANTINED'
       WHERE request_id = ANY($1::text[]) AND state <> 'QUARANTINED'`,
      [requestIds],
    );
  }
  if (!preserveBroadcastFinality && transferIds.length > 0) {
    await executor.query(
      `UPDATE core.settlement_transfers SET state = 'QUARANTINED'
       WHERE transfer_id = ANY($1::text[])
         AND state IN ('PENDING','LEASED','RETRYABLE','SUBMITTED','MINED','SETTLED')`,
      [transferIds],
    );
    await executor.query(
      `UPDATE core.settlement_transfer_attempts SET state = 'QUARANTINED', updated_at = $2
       WHERE transfer_id = ANY($1::text[])
         AND state IN ('LEASED','RETRYABLE','SUBMITTED','MINED','SETTLED')`,
      [transferIds, input.at],
    );
  }
  await appendPrizeReorgTransition(executor, {
    exposureId,
    transitionType: 'QUARANTINED',
    evidenceHash: input.evidenceHash,
    payload: {
      fundingId: input.fundingId,
      requestIds,
      transferIds,
      preserveBroadcastFinality,
      previousStates: payout,
    },
    at: input.at,
  });
}

async function recordPrizeReorgExposure(
  executor: SqlExecutor,
  context: {
    input: PrizeFundingReversalInput;
    liabilitySessionId: string;
    outcomes: readonly PrizeSettlementRow[];
    payout: readonly PrizePayoutSnapshotRow[];
    mode: PrizeFundingReversalPlan['mode'];
  },
) {
  const exposureId = hashJson({
    fundingKind: context.input.fundingKind,
    fundingId: context.input.fundingId,
    evidenceHash: context.input.evidenceHash,
  });
  await executor.query(
    `INSERT INTO core.seckill_prize_reorg_exposures (
       exposure_id, funding_kind, funding_id, source_session_id, liability_session_id,
       amount_usdt, settlement_wallet_address, evidence_hash, source_tx_hash,
       source_block_hash, resolution_mode, payout_snapshot, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (funding_kind, funding_id, evidence_hash) DO NOTHING`,
    [
      exposureId,
      context.input.fundingKind,
      context.input.fundingId,
      context.input.sourceSessionId,
      context.liabilitySessionId,
      context.input.amountUsdt,
      context.input.settlementWalletAddress,
      context.input.evidenceHash,
      context.input.sourceTxHash,
      context.input.sourceBlockHash,
      context.mode,
      JSON.stringify({
        outcomes: context.outcomes.map((outcome) => ({
          sessionId: outcome.session_id,
          state: outcome.state,
          awardJournalId: outcome.award_journal_id,
          rolloverJournalId: outcome.rollover_journal_id,
          rolloverTargetSessionId: outcome.rollover_target_session_id,
        })),
        payout: context.payout,
      }),
      context.input.at,
    ],
  );
  return exposureId;
}

async function enqueuePrizeReorgReconciliation(
  executor: SqlExecutor,
  exposureId: string,
  input: PrizeFundingReversalInput,
  payout: readonly PrizePayoutSnapshotRow[],
) {
  const transferIds = [...new Set(payout.flatMap((row) => row.transfer_id ? [row.transfer_id] : []))].sort();
  const executionTxHashes = [...new Set(payout.flatMap((row) => (
    row.execution_tx_hash ? [row.execution_tx_hash] : []
  )))].sort();
  const jobId = `seckill-prize-funding-reorg:${exposureId.slice(2)}`;
  await executor.query(
    `INSERT INTO core.durable_jobs (
       job_id, job_type, resource_id, payload, idempotency_key, state
     ) VALUES ($1,'RECONCILE',$2,$3,$1,'READY')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      jobId,
      input.sourceSessionId,
      JSON.stringify({
        kind: 'SECKILL_PRIZE_FUNDING_REORG',
        exposureId,
        fundingId: input.fundingId,
        transferIds,
        executionTxHashes,
        evidenceHash: input.evidenceHash,
      }),
    ],
  );
}

async function ensurePrizeDeficitAccount(executor: SqlExecutor, accountId: string) {
  await executor.query(
    `INSERT INTO core.ledger_accounts (
       account_id, owner_type, owner_id, asset, purpose, wallet_address
     ) VALUES ($1,'SYSTEM','SECKILL_PRIZE_REORG','USDT','SECKILL_PRIZE_REORG_DEFICIT',NULL)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

async function lockLedgerAccounts(executor: SqlExecutor, accountIds: readonly string[]) {
  const ids = [...new Set(accountIds)].sort();
  const locked = await executor.query<{ account_id: string }>(
    `SELECT account_id FROM core.ledger_accounts
     WHERE account_id = ANY($1::text[]) ORDER BY account_id FOR UPDATE`,
    [ids],
  );
  if (locked.rows.length !== ids.length) {
    throw new CoreError('UnknownState', 'Seckill prize ledger account is unavailable', 409);
  }
}

async function prizeRecoveryEpisode(executor: SqlExecutor, exposureId: string) {
  const result = await executor.query<{ recovery_episode: string | number }>(
    `SELECT 1 + count(*) AS recovery_episode
     FROM core.seckill_prize_reorg_transitions
     WHERE exposure_id = $1 AND transition_type = 'PAYOUT_REORGED'`,
    [exposureId],
  );
  return Number(result.rows[0]!.recovery_episode);
}

export async function recordSeckillPrizeFundingReversed(
  executor: SqlExecutor,
  input: {
    plan: PrizeFundingReversalPlan;
    journalId: string;
    evidenceHash: string;
    at: Date;
    deferResolution?: true;
  },
) {
  const recoveryEpisode = await prizeRecoveryEpisode(executor, input.plan.exposureId);
  await appendPrizeReorgTransition(executor, {
    exposureId: input.plan.exposureId,
    transitionType: 'FUNDING_REVERSED',
    evidenceHash: input.evidenceHash,
    payload: { journalId: input.journalId, resolutionMode: input.plan.mode, recoveryEpisode },
    at: input.at,
  });
  if (input.plan.mode === 'STANDARD_REVERSAL') {
    const remainderId = await recordRecoverablePrizeRemainder(
      executor,
      input.plan,
      recoveryEpisode,
      input.at,
    );
    if (!input.deferResolution) {
      await appendPrizeReorgTransition(executor, {
        exposureId: input.plan.exposureId,
        transitionType: 'RESOLVED',
        evidenceHash: input.evidenceHash,
        payload: {
          resolution: 'STANDARD_REVERSAL',
          journalId: input.journalId,
          remainderId,
          recoveryEpisode,
        },
        at: input.at,
      });
    }
  }
}

async function recordRecoverablePrizeRemainder(
  executor: SqlExecutor,
  plan: PrizeFundingReversalPlan,
  recoveryEpisode: number,
  at: Date,
) {
  const existing = await executor.query<{ remainder_id: string }>(
    `SELECT remainder_id FROM core.seckill_prize_reorg_remainders
     WHERE exposure_id = $1 AND recovery_episode = $2`,
    [plan.exposureId, recoveryEpisode],
  );
  if (existing.rows[0]) return existing.rows[0].remainder_id;
  const context = await executor.query<{
    settlement_wallet_address: string;
    evidence_hash: string;
    prize_pool_usdt: string;
    settlement_state: string | null;
  }>(
    `SELECT exposure.settlement_wallet_address, exposure.evidence_hash,
       session.prize_pool_usdt::text,
       settlement.state AS settlement_state
     FROM core.seckill_prize_reorg_exposures exposure
     JOIN core.seckill_sessions session ON session.session_id = $2
     LEFT JOIN core.seckill_prize_settlements settlement ON settlement.session_id = session.session_id
     WHERE exposure.exposure_id = $1
     FOR UPDATE OF session`,
    [plan.exposureId, plan.recoverySessionId],
  );
  const row = context.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Prize reorg exposure is unavailable', 409);
  if (row.settlement_state !== 'QUARANTINED') return null;
  const balance = await lockedPrizeBalance(
    executor,
    `seckill-prize:${plan.recoverySessionId}:usdt`,
    row.settlement_wallet_address,
  );
  if (balance !== BigInt(row.prize_pool_usdt)) {
    throw new CoreError('UnknownState', 'Recovered prize remainder does not match its pool projection', 409);
  }
  await executor.query(
    `UPDATE core.seckill_prize_reorg_remainders
     SET state = 'SUPERSEDED', resolved_at = $2
     WHERE session_id = $1 AND state = 'PENDING'`,
    [plan.recoverySessionId, at],
  );
  if (balance === 0n) return null;
  const amountUsdt = balance.toString();
  const remainderId = hashJson({
    exposureId: plan.exposureId,
    recoveryEpisode,
    sessionId: plan.recoverySessionId,
    amountUsdt,
  });
  await executor.query(
    `INSERT INTO core.seckill_prize_reorg_remainders (
       remainder_id, exposure_id, recovery_episode, session_id, amount_usdt,
       settlement_wallet_address, evidence_hash, state, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)`,
    [
      remainderId,
      plan.exposureId,
      recoveryEpisode,
      plan.recoverySessionId,
      amountUsdt,
      row.settlement_wallet_address,
      row.evidence_hash,
      at,
    ],
  );
  await appendPrizeReorgTransition(executor, {
    exposureId: plan.exposureId,
    transitionType: 'REMAINDER_RECOVERABLE',
    evidenceHash: row.evidence_hash,
    payload: { remainderId, recoveryEpisode, sessionId: plan.recoverySessionId, amountUsdt },
    at,
  });
  return remainderId;
}

export async function reopenRecoveredSeckillPrizePayoutFinality(
  executor: SqlExecutor,
  input: {
    transferId: string;
    attemptId: string;
    executionTxHash: string;
    finalityTransactionId: string;
    previousFinalityState: 'FINAL' | 'FAILED';
    sourceBlockHash: string;
    evidenceHash: string;
    at: Date;
  },
) {
  await lockSeckillPrizeFundingMutation(executor);
  const affected = await executor.query<{
    exposure_id: string;
    funding_kind: PrizeFundingReversalInput['fundingKind'];
    funding_id: string;
    source_session_id: string;
    amount_usdt: string;
    settlement_wallet_address: string;
    payout_snapshot: {
      outcomes?: Array<{ sessionId: string; awardJournalId: string | null }>;
      payout?: PrizePayoutSnapshotRow[];
    };
  }>(
    `SELECT exposure_id, funding_kind, funding_id, source_session_id,
       amount_usdt::text, settlement_wallet_address, payout_snapshot
     FROM core.seckill_prize_reorg_exposures exposure
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(exposure.payout_snapshot -> 'payout', '[]')) payout
       WHERE payout ->> 'transfer_id' = $1
     )
       AND EXISTS (
         SELECT 1 FROM core.seckill_prize_reorg_transitions resolved
         WHERE resolved.exposure_id = exposure.exposure_id
           AND resolved.transition_type = 'RESOLVED'
           AND NOT EXISTS (
             SELECT 1 FROM core.seckill_prize_reorg_transitions later_reorg
             WHERE later_reorg.exposure_id = exposure.exposure_id
               AND later_reorg.transition_type = 'PAYOUT_REORGED'
               AND (later_reorg.created_at, later_reorg.transition_id)
                 >= (resolved.created_at, resolved.transition_id)
           )
       )
     ORDER BY exposure.created_at, exposure.exposure_id`,
    [input.transferId],
  );
  if (affected.rows.length === 0) return 0;
  const awardedSessionIds = new Set(affected.rows.flatMap((row) => (
    [...(row.payout_snapshot.outcomes ?? [])]
      .reverse()
      .find((outcome) => outcome.awardJournalId)?.sessionId ?? []
  )));
  if (awardedSessionIds.size !== 1) {
    throw new CoreError('UnknownState', 'Recovered prize payout outcome is ambiguous', 409);
  }
  const awardedSessionId = [...awardedSessionIds][0]!;
  const outcome = (await executor.query<PrizeSettlementRow>(
    'SELECT * FROM core.seckill_prize_settlements WHERE session_id = $1 FOR UPDATE',
    [awardedSessionId],
  )).rows[0];
  if (!outcome?.award_account_id || !outcome.candidate_order_id) {
    throw new CoreError('UnknownState', 'Recovered prize payout settlement is unavailable', 409);
  }

  const reversalPlans: Array<{ plan: PrizeFundingReversalPlan; amountUsdt: string }> = [];
  if (input.previousFinalityState === 'FAILED') {
    const exposureIds = affected.rows.map((row) => row.exposure_id);
    const remainders = await executor.query<{
      remainder_id: string;
      session_id: string;
      amount_usdt: string;
      state: 'PENDING' | 'ROLLED_OVER';
      target_session_id: string | null;
    }>(
      `SELECT remainder_id, session_id, amount_usdt::text, state, target_session_id
       FROM core.seckill_prize_reorg_remainders
       WHERE exposure_id = ANY($1::text[]) AND state IN ('PENDING','ROLLED_OVER')
       ORDER BY created_at, remainder_id FOR UPDATE`,
      [exposureIds],
    );
    const fundingAmount = affected.rows.reduce((sum, row) => (
      row.funding_kind === 'PAYOUT_RECOVERY' ? sum : sum + BigInt(row.amount_usdt)
    ), 0n);
    const remainderAmount = remainders.rows.reduce((sum, row) => sum + BigInt(row.amount_usdt), 0n);
    const payoutAmount = BigInt(outcome.pool_amount_usdt);
    if (fundingAmount + remainderAmount !== payoutAmount) {
      throw new CoreError('UnknownState', 'Recovered prize payout funding no longer conserves', 409);
    }
    for (const remainder of remainders.rows) {
      const plan = await prepareSeckillPrizeFundingReversal(executor, {
        fundingKind: 'PAYOUT_RECOVERY',
        fundingId: `payout-recovery:${remainder.remainder_id}`,
        sourceSessionId: remainder.target_session_id ?? remainder.session_id,
        amountUsdt: remainder.amount_usdt,
        settlementWalletAddress: affected.rows[0]!.settlement_wallet_address,
        evidenceHash: input.evidenceHash,
        sourceTxHash: input.executionTxHash,
        sourceBlockHash: input.sourceBlockHash,
        at: input.at,
        preserveRecoveredPayout: true,
      });
      reversalPlans.push({ plan, amountUsdt: remainder.amount_usdt });
    }
    const deficitAccountId = 'system:seckill-prize-reorg-deficit:usdt';
    await ensurePrizeDeficitAccount(executor, deficitAccountId);
    await lockLedgerAccounts(executor, [
      outcome.award_account_id,
      deficitAccountId,
      ...reversalPlans.map(({ plan }) => plan.debitAccountId),
    ]);
    const debits = new Map<string, {
      account_id: string;
      side: 'DEBIT';
      amount: string;
      balance_state: 'LOCKED' | 'POSTED';
      backing_wallet_address: string;
    }>();
    const addDebit = (
      accountId: string,
      amount: bigint,
      balanceState: 'LOCKED' | 'POSTED',
    ) => {
      if (amount === 0n) return;
      const key = `${accountId}:${balanceState}`;
      const prior = debits.get(key);
      debits.set(key, {
        account_id: accountId,
        side: 'DEBIT',
        amount: (BigInt(prior?.amount ?? 0) + amount).toString(),
        balance_state: balanceState,
        backing_wallet_address: affected.rows[0]!.settlement_wallet_address,
      });
    };
    addDebit(deficitAccountId, fundingAmount, 'POSTED');
    for (const { plan, amountUsdt } of reversalPlans) {
      addDebit(plan.debitAccountId, BigInt(amountUsdt), plan.debitBalanceState);
    }
    const lines = [
      ...debits.values(),
      {
        account_id: outcome.award_account_id,
        side: 'CREDIT' as const,
        amount: outcome.pool_amount_usdt,
        balance_state: 'REQUESTED',
        backing_wallet_address: affected.rows[0]!.settlement_wallet_address,
      },
    ];
    const recoveryIdentity = `${input.attemptId}:${input.sourceBlockHash.slice(2)}`;
    const journalId = `journal:seckill-prize-payout-recovery-reversed:${recoveryIdentity}`;
    await executor.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        journalId,
        `seckill-prize-payout-recovery-reversed:${recoveryIdentity}`,
        'SECKILL_PRIZE_PAYOUT_RECOVERY_REVERSED',
        'SECKILL_SESSION',
        awardedSessionId,
        outcome.candidate_order_id,
        null,
        hashJson({ input, exposureIds, lines }),
        input.executionTxHash,
        input.sourceBlockHash,
        'EOA_TRANSFER',
        input.evidenceHash,
        null,
        JSON.stringify({
          exposureIds,
          attemptId: input.attemptId,
          previousFinalityState: input.previousFinalityState,
        }),
        JSON.stringify(lines),
      ],
    );
    for (const { plan, amountUsdt } of reversalPlans) {
      const updated = await executor.query<{ session_id: string }>(
        `UPDATE core.seckill_sessions SET prize_pool_usdt = prize_pool_usdt - $2, updated_at = $3
         WHERE session_id = $1 AND prize_pool_usdt >= $2 RETURNING session_id`,
        [plan.poolSessionId, amountUsdt, input.at],
      );
      if (!updated.rows[0]) {
        throw new CoreError('UnknownState', 'Recovered prize pool cannot be quarantined', 409);
      }
      await recordSeckillPrizeFundingReversed(executor, {
        plan,
        journalId,
        evidenceHash: input.evidenceHash,
        at: input.at,
        deferResolution: true,
      });
    }
    if (reversalPlans.length === 0) {
      await executor.query(
        `UPDATE core.seckill_prize_reorg_remainders
         SET state = 'SUPERSEDED', resolved_at = $2
         WHERE exposure_id = ANY($1::text[]) AND state = 'PENDING'`,
        [exposureIds, input.at],
      );
    }
  }

  await executor.query(
    `UPDATE core.transaction_finality SET state = 'REORGED', finalized_at = NULL,
       evidence = evidence || $2::jsonb, updated_at = $3
     WHERE transaction_id = $1 AND state = $4`,
    [
      input.finalityTransactionId,
      JSON.stringify({ reorgEvidenceHash: input.evidenceHash }),
      input.at,
      input.previousFinalityState,
    ],
  );
  for (const exposure of affected.rows) {
    const payout = exposure.payout_snapshot.payout ?? [];
    const recoveryEpisode = await prizeRecoveryEpisode(executor, exposure.exposure_id) + 1;
    if (exposure.funding_kind !== 'PAYOUT_RECOVERY') {
      await enqueuePrizeReorgReconciliation(executor, exposure.exposure_id, {
        fundingKind: exposure.funding_kind,
        fundingId: exposure.funding_id,
        sourceSessionId: exposure.source_session_id,
        amountUsdt: exposure.amount_usdt,
        settlementWalletAddress: exposure.settlement_wallet_address,
        evidenceHash: input.evidenceHash,
        sourceTxHash: input.executionTxHash,
        sourceBlockHash: input.sourceBlockHash,
        at: input.at,
      }, payout);
      await executor.query(
        `UPDATE core.durable_jobs SET state = 'RETRY', available_at = $2,
           lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = 'PAYOUT_FINALITY_REORGED', updated_at = $2
         WHERE idempotency_key = $1`,
        [`seckill-prize-funding-reorg:${exposure.exposure_id.slice(2)}`, input.at],
      );
    }
    const payload = {
      transferId: input.transferId,
      attemptId: input.attemptId,
      executionTxHash: input.executionTxHash,
      finalityTransactionId: input.finalityTransactionId,
      previousFinalityState: input.previousFinalityState,
      reorgEvidenceHash: input.evidenceHash,
      recoveredRemainderExposures: reversalPlans.map(({ plan }) => plan.exposureId),
      recoveryEpisode,
    };
    await appendPrizeReorgTransition(executor, {
      exposureId: exposure.exposure_id,
      transitionType: 'PAYOUT_REORGED',
      evidenceHash: input.evidenceHash,
      payload,
      at: input.at,
    });
    await pausePrizeFundingReorg(executor, {
      fundingKind: exposure.funding_kind,
      fundingId: exposure.funding_id,
      sourceSessionId: exposure.source_session_id,
      amountUsdt: exposure.amount_usdt,
      settlementWalletAddress: exposure.settlement_wallet_address,
      evidenceHash: input.evidenceHash,
      sourceTxHash: input.executionTxHash,
      sourceBlockHash: input.sourceBlockHash,
      at: input.at,
    }, recoveryEpisode);
  }
  return affected.rows.length;
}

export async function reconcileSeckillPrizeFundingReorgOnce(
  executor: SqlExecutor,
  now: Date,
) {
  await lockSeckillPrizeFundingMutation(executor);
  const leased = await executor.query<{
    job_id: string;
    payload: {
      kind: string;
      exposureId: string;
      transferIds: string[];
      evidenceHash: string;
    };
  }>(
    `WITH selected AS (
       SELECT job_id FROM core.durable_jobs
       WHERE job_type = 'RECONCILE' AND state IN ('READY','RETRY')
         AND payload ->> 'kind' = 'SECKILL_PRIZE_FUNDING_REORG'
         AND available_at <= $1
         AND (lease_expires_at IS NULL OR lease_expires_at < $1)
       ORDER BY available_at, created_at, job_id
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE core.durable_jobs job
     SET state = 'LEASED', lease_owner = 'SECKILL_PRIZE_RECONCILER',
       lease_expires_at = $1::timestamptz + interval '30 seconds', attempt_count = attempt_count + 1,
       updated_at = $1
     FROM selected WHERE job.job_id = selected.job_id
     RETURNING job.job_id, job.payload`,
    [now],
  );
  const job = leased.rows[0];
  if (!job) return 0;
  const transferIds = Array.isArray(job.payload.transferIds) ? job.payload.transferIds : [];
  if (!/^0x[0-9a-f]{64}$/.test(job.payload.exposureId) || transferIds.length === 0) {
    await failPrizeReorgJob(executor, job.job_id, 'INVALID_RECONCILE_PAYLOAD', now);
    return 1;
  }
  const transfers = await executor.query<{
    transfer_id: string;
    state: string;
    request_id: string;
    request_item_index: number;
    settled_journal_id: string | null;
  }>(
    `SELECT transfer.transfer_id, transfer.state, transfer.request_id,
       transfer.request_item_index, item.settled_journal_id
     FROM core.settlement_transfers transfer
     JOIN core.settlement_request_items item
       ON item.request_id = transfer.request_id
      AND item.item_index = transfer.request_item_index
     WHERE transfer.transfer_id = ANY($1::text[])
     ORDER BY transfer.transfer_id FOR UPDATE OF transfer, item`,
    [transferIds],
  );
  if (transfers.rows.length !== transferIds.length) {
    await failPrizeReorgJob(executor, job.job_id, 'MISSING_RECONCILE_TRANSFER', now);
    return 1;
  }
  const attempts = await executor.query<{
    transfer_id: string;
    attempt_id: string;
    attempt_number: number;
    state: string;
    execution_tx_hash: string | null;
    finality_state: string | null;
    block_number: string | number | null;
    block_hash: string | null;
    confirmations: string | number | null;
    receipt_status: number | null;
    finality_evidence: Record<string, unknown> | null;
  }>(
    `SELECT attempt.transfer_id, attempt.attempt_id, attempt.attempt_number,
       attempt.state, attempt.execution_tx_hash,
       finality.state AS finality_state, finality.block_number,
       finality.block_hash, finality.confirmations, finality.receipt_status,
       finality.evidence AS finality_evidence
     FROM core.settlement_transfer_attempts attempt
     LEFT JOIN core.transaction_finality finality
       ON finality.transaction_id = 'settlement-finality:' || attempt.attempt_id
     WHERE attempt.transfer_id = ANY($1::text[])
     ORDER BY attempt.transfer_id, attempt.attempt_number
     FOR UPDATE OF attempt`,
    [transferIds],
  );
  const attemptsByTransfer = new Map<string, typeof attempts.rows>();
  for (const attempt of attempts.rows) {
    attemptsByTransfer.set(attempt.transfer_id, [
      ...(attemptsByTransfer.get(attempt.transfer_id) ?? []),
      attempt,
    ]);
  }
  const active = transfers.rows.some((transfer) => (
    ['PENDING', 'LEASED', 'RETRYABLE', 'SUBMITTED', 'MINED'].includes(transfer.state)
    || (attemptsByTransfer.get(transfer.transfer_id) ?? []).some((attempt) => (
      ['LEASED', 'RETRYABLE', 'SUBMITTED', 'MINED'].includes(attempt.state)
    ))
  ));
  if (active) {
    await retryPrizeReorgJob(executor, job.job_id, 'PAYOUT_FINALITY_PENDING', now);
    return 1;
  }
  const payoutFinal = transfers.rows.every((transfer) => (
    ['SETTLED', 'QUARANTINED'].includes(transfer.state)
    && (attemptsByTransfer.get(transfer.transfer_id) ?? []).some((attempt) => (
      attempt.execution_tx_hash !== null
      && attempt.finality_state === 'FINAL'
      && attempt.receipt_status === 1
      && Number(attempt.confirmations) >= 15
      && attempt.block_hash !== null
      && transfer.settled_journal_id !== null
    ))
  ));
  const payoutFailed = transfers.rows.every((transfer) => {
    const transferAttempts = attemptsByTransfer.get(transfer.transfer_id) ?? [];
    const terminalFailure = transferAttempts.some((attempt) => (
      attempt.execution_tx_hash !== null
      && ['FAILED', 'QUARANTINED'].includes(attempt.state)
      && attempt.finality_state === 'FAILED'
      && attempt.receipt_status === 0
      && Number(attempt.confirmations) >= 15
      && attempt.block_hash !== null
    ));
    return transfer.state === 'QUARANTINED'
      && transferAttempts.length > 0
      && transferAttempts.every((attempt) => (
        (attempt.execution_tx_hash === null && attempt.state === 'QUARANTINED')
        || (attempt.execution_tx_hash !== null && attempt.state === 'REPLACED' && terminalFailure)
        || (
          attempt.execution_tx_hash !== null
          && ['FAILED', 'QUARANTINED'].includes(attempt.state)
          && attempt.finality_state === 'FAILED'
          && attempt.receipt_status === 0
          && Number(attempt.confirmations) >= 15
          && attempt.block_hash !== null
        )
      ));
  });
  if (!payoutFinal && !payoutFailed) {
    await retryPrizeReorgJob(executor, job.job_id, 'PAYOUT_TERMINAL_EVIDENCE_INCOMPLETE', now);
    return 1;
  }
  const terminalEvidence = {
    transfers: transfers.rows,
    attempts: attempts.rows,
  };
  const terminalEvidenceHash = hashJson(terminalEvidence);
  const recoveryEpisode = await prizeRecoveryEpisode(executor, job.payload.exposureId);
  if (payoutFailed) {
    await recoverFailedPrizePayout(executor, {
      exposureId: job.payload.exposureId,
      terminalEvidence,
      terminalEvidenceHash,
      at: now,
    });
    await finalizeFailedPrizePayoutRecovery(executor, {
      transferIds,
      terminalEvidenceHash,
      at: now,
    });
  } else {
    await appendPrizeReorgTransition(executor, {
      exposureId: job.payload.exposureId,
      transitionType: 'PAYOUT_FINAL',
      evidenceHash: terminalEvidenceHash,
      payload: { ...terminalEvidence, recoveryEpisode },
      at: now,
    });
    await appendPrizeReorgTransition(executor, {
      exposureId: job.payload.exposureId,
      transitionType: 'RESOLVED',
      evidenceHash: terminalEvidenceHash,
      payload: { resolution: 'PAYOUT_FINAL', terminalEvidenceHash, recoveryEpisode },
      at: now,
    });
  }
  await resolvePayoutRecoveryDependencies(executor, {
    transferIds,
    terminalResolution: payoutFailed ? 'PAYOUT_FAILED' : 'PAYOUT_FINAL',
    terminalEvidenceHash,
    at: now,
  });
  await executor.query(
    `UPDATE core.durable_jobs SET state = 'SUCCEEDED', lease_owner = NULL,
       lease_expires_at = NULL, last_error_code = NULL, updated_at = $2
     WHERE job_id = $1 AND state = 'LEASED'`,
    [job.job_id, now],
  );
  return 1;
}

async function resolvePayoutRecoveryDependencies(
  executor: SqlExecutor,
  input: {
    transferIds: readonly string[];
    terminalResolution: 'PAYOUT_FINAL' | 'PAYOUT_FAILED';
    terminalEvidenceHash: string;
    at: Date;
  },
) {
  const recoveries = await executor.query<{ exposure_id: string }>(
    `SELECT recovery.exposure_id
     FROM core.seckill_prize_reorg_exposures recovery
     WHERE recovery.funding_kind = 'PAYOUT_RECOVERY'
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(recovery.payout_snapshot -> 'payout', '[]'::jsonb)) payout
         WHERE payout ->> 'transfer_id' = ANY($1::text[])
       )
       AND (
         SELECT count(*) FROM core.seckill_prize_reorg_transitions transition
         WHERE transition.exposure_id = recovery.exposure_id
           AND transition.transition_type = 'RESOLVED'
       ) <= (
         SELECT count(*) FROM core.seckill_prize_reorg_transitions transition
         WHERE transition.exposure_id = recovery.exposure_id
           AND transition.transition_type = 'PAYOUT_REORGED'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM core.seckill_prize_reorg_exposures original
         WHERE original.funding_kind <> 'PAYOUT_RECOVERY'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(original.payout_snapshot -> 'payout', '[]'::jsonb)) original_payout
             JOIN jsonb_array_elements(COALESCE(recovery.payout_snapshot -> 'payout', '[]'::jsonb)) recovery_payout
               ON recovery_payout ->> 'transfer_id' = original_payout ->> 'transfer_id'
             WHERE original_payout ->> 'transfer_id' = ANY($1::text[])
           )
           AND (
             SELECT count(*) FROM core.seckill_prize_reorg_transitions transition
             WHERE transition.exposure_id = original.exposure_id
               AND transition.transition_type = 'RESOLVED'
           ) <= (
             SELECT count(*) FROM core.seckill_prize_reorg_transitions transition
             WHERE transition.exposure_id = original.exposure_id
               AND transition.transition_type = 'PAYOUT_REORGED'
           )
       )
     ORDER BY recovery.created_at, recovery.exposure_id`,
    [[...new Set(input.transferIds)].sort()],
  );
  for (const recovery of recoveries.rows) {
    const recoveryEpisode = await prizeRecoveryEpisode(executor, recovery.exposure_id);
    await appendPrizeReorgTransition(executor, {
      exposureId: recovery.exposure_id,
      transitionType: 'RESOLVED',
      evidenceHash: input.terminalEvidenceHash,
      payload: {
        resolution: input.terminalResolution === 'PAYOUT_FINAL'
          ? 'PAYOUT_RECOVERY_INVALIDATED'
          : 'PAYOUT_RECOVERY_RESTORED',
        terminalResolution: input.terminalResolution,
        terminalEvidenceHash: input.terminalEvidenceHash,
        transferIds: [...new Set(input.transferIds)].sort(),
        recoveryEpisode,
      },
      at: input.at,
    });
  }
}

async function retryPrizeReorgJob(
  executor: SqlExecutor,
  jobId: string,
  errorCode: string,
  now: Date,
) {
  await executor.query(
    `UPDATE core.durable_jobs SET state = 'RETRY', available_at = $2::timestamptz + interval '5 seconds',
       lease_owner = NULL, lease_expires_at = NULL, last_error_code = $3,
       updated_at = $2 WHERE job_id = $1 AND state = 'LEASED'`,
    [jobId, now, errorCode],
  );
}

async function finalizeFailedPrizePayoutRecovery(
  executor: SqlExecutor,
  input: {
    transferIds: readonly string[];
    terminalEvidenceHash: string;
    at: Date;
  },
) {
  const transferIds = [...new Set(input.transferIds)].sort();
  const originals = await executor.query<{
    exposure_id: string;
    settlement_wallet_address: string;
    payout_snapshot: {
      outcomes?: Array<{ sessionId: string; awardJournalId: string | null }>;
    };
  }>(
    `SELECT exposure_id, settlement_wallet_address, payout_snapshot
     FROM core.seckill_prize_reorg_exposures exposure
     WHERE exposure.funding_kind <> 'PAYOUT_RECOVERY'
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(exposure.payout_snapshot -> 'payout', '[]'::jsonb)) payout
         WHERE payout ->> 'transfer_id' = ANY($1::text[])
       )
     ORDER BY exposure.created_at, exposure.exposure_id`,
    [transferIds],
  );
  if (originals.rows.length === 0) {
    throw new CoreError('UnknownState', 'Prize payout recovery has no original funding exposure', 409);
  }
  const counts = await executor.query<{
    exposure_id: string;
    resolved_count: string | number;
    reorg_count: string | number;
  }>(
    `SELECT exposure.exposure_id,
       count(transition.transition_id) FILTER (WHERE transition.transition_type = 'RESOLVED') AS resolved_count,
       count(transition.transition_id) FILTER (WHERE transition.transition_type = 'PAYOUT_REORGED') AS reorg_count
     FROM core.seckill_prize_reorg_exposures exposure
     LEFT JOIN core.seckill_prize_reorg_transitions transition
       ON transition.exposure_id = exposure.exposure_id
     WHERE exposure.exposure_id = ANY($1::text[])
     GROUP BY exposure.exposure_id`,
    [originals.rows.map((exposure) => exposure.exposure_id)],
  );
  if (counts.rows.some((row) => Number(row.resolved_count) <= Number(row.reorg_count))) return;

  const awardedSessionIds = new Set(originals.rows.flatMap((exposure) => (
    [...(exposure.payout_snapshot.outcomes ?? [])]
      .reverse()
      .find((outcome) => outcome.awardJournalId)?.sessionId ?? []
  )));
  const settlementWallets = new Set(originals.rows.map((exposure) => exposure.settlement_wallet_address));
  if (awardedSessionIds.size !== 1 || settlementWallets.size !== 1) {
    throw new CoreError('UnknownState', 'Prize payout recovery funding context is ambiguous', 409);
  }
  const awardedSessionId = [...awardedSessionIds][0]!;
  const settlementWallet = [...settlementWallets][0]!;
  const session = await executor.query<{ prize_pool_usdt: string; settlement_state: string | null }>(
    `SELECT session.prize_pool_usdt::text, settlement.state AS settlement_state
     FROM core.seckill_sessions session
     LEFT JOIN core.seckill_prize_settlements settlement ON settlement.session_id = session.session_id
     WHERE session.session_id = $1 FOR UPDATE OF session`,
    [awardedSessionId],
  );
  const context = session.rows[0];
  if (!context || context.settlement_state !== 'QUARANTINED') {
    throw new CoreError('UnknownState', 'Failed prize payout recovery session is unavailable', 409);
  }
  const poolAccountId = `seckill-prize:${awardedSessionId}:usdt`;
  const poolBalance = await lockedPrizeBalance(executor, poolAccountId, settlementWallet);
  const projectedPool = BigInt(context.prize_pool_usdt);
  if (poolBalance < projectedPool) {
    throw new CoreError('UnknownState', 'Failed prize payout recovery reduced the projected prize pool', 409);
  }
  const restoredAmount = poolBalance - projectedPool;
  if (restoredAmount > 0n) {
    const superseded = await executor.query<{ amount_usdt: string }>(
      `WITH latest AS (
         SELECT max(remainder.resolved_at) AS resolved_at
         FROM core.seckill_prize_reorg_remainders remainder
         WHERE remainder.exposure_id = ANY($1::text[]) AND remainder.state = 'SUPERSEDED'
       )
       SELECT COALESCE(sum(remainder.amount_usdt), 0)::text AS amount_usdt
       FROM core.seckill_prize_reorg_remainders remainder
       JOIN latest ON latest.resolved_at = remainder.resolved_at
       WHERE remainder.exposure_id = ANY($1::text[]) AND remainder.state = 'SUPERSEDED'`,
      [originals.rows.map((exposure) => exposure.exposure_id)],
    );
    if (BigInt(superseded.rows[0]?.amount_usdt ?? 0) !== restoredAmount) {
      throw new CoreError('UnknownState', 'Recovered prize remainder has no matching superseded episode', 409);
    }
    await executor.query(
      `UPDATE core.seckill_sessions SET prize_pool_usdt = $2, updated_at = $3
       WHERE session_id = $1`,
      [awardedSessionId, poolBalance.toString(), input.at],
    );
  }
  const anchor = originals.rows[0]!;
  await recordRecoverablePrizeRemainder(
    executor,
    {
      exposureId: anchor.exposure_id,
      mode: 'DEFICIT_MONITORING',
      poolSessionId: awardedSessionId,
      recoverySessionId: awardedSessionId,
      debitAccountId: 'system:seckill-prize-reorg-deficit:usdt',
      debitBalanceState: 'POSTED',
    },
    await prizeRecoveryEpisode(executor, anchor.exposure_id),
    input.at,
  );
}

async function recoverFailedPrizePayout(
  executor: SqlExecutor,
  input: {
    exposureId: string;
    terminalEvidence: Record<string, unknown>;
    terminalEvidenceHash: string;
    at: Date;
  },
) {
  const exposure = await executor.query<{
    funding_kind: PrizeFundingReversalInput['fundingKind'];
    funding_id: string;
    source_session_id: string;
    liability_session_id: string;
    amount_usdt: string;
    settlement_wallet_address: string;
    evidence_hash: string;
    source_tx_hash: string;
    source_block_hash: string;
    payout_snapshot: {
      outcomes?: Array<{
        sessionId: string;
        awardJournalId: string | null;
      }>;
    };
  }>(
    `SELECT funding_kind, funding_id, source_session_id, liability_session_id,
       amount_usdt::text, settlement_wallet_address, evidence_hash,
       source_tx_hash, source_block_hash, payout_snapshot
     FROM core.seckill_prize_reorg_exposures WHERE exposure_id = $1`,
    [input.exposureId],
  );
  const row = exposure.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Prize reorg exposure is unavailable', 409);
  const awardedSessionId = [...(row.payout_snapshot.outcomes ?? [])]
    .reverse()
    .find((outcome) => outcome.awardJournalId)?.sessionId;
  if (!awardedSessionId) throw new CoreError('UnknownState', 'Prize payout recovery outcome is unavailable', 409);
  const outcome = (await executor.query<PrizeSettlementRow>(
    'SELECT * FROM core.seckill_prize_settlements WHERE session_id = $1 FOR UPDATE',
    [awardedSessionId],
  )).rows[0];
  if (!outcome) throw new CoreError('UnknownState', 'Prize payout recovery settlement is unavailable', 409);
  const reversalInput: PrizeFundingReversalInput = {
    fundingKind: row.funding_kind,
    fundingId: row.funding_id,
    sourceSessionId: row.source_session_id,
    amountUsdt: row.amount_usdt,
    settlementWalletAddress: row.settlement_wallet_address,
    evidenceHash: row.evidence_hash,
    sourceTxHash: row.source_tx_hash,
    sourceBlockHash: row.source_block_hash,
    at: input.at,
  };
  const recoveryEpisode = await prizeRecoveryEpisode(executor, input.exposureId);
  await reversePrizeAward(
    executor,
    outcome,
    reversalInput,
    recoveryEpisode,
    input.terminalEvidenceHash.slice(2),
  );
  const deficitAccountId = 'system:seckill-prize-reorg-deficit:usdt';
  const poolAccountId = `seckill-prize:${awardedSessionId}:usdt`;
  await lockLedgerAccounts(executor, [deficitAccountId, poolAccountId]);
  const journalId = recoveryEpisode === 1
    ? `journal:seckill-prize-deficit-recovered:${input.exposureId.slice(2)}`
    : `journal:seckill-prize-deficit-recovered:${input.exposureId.slice(2)}:${recoveryEpisode}`;
  const existing = await executor.query<{ journal_id: string }>(
    'SELECT journal_id FROM core.ledger_journals WHERE journal_id = $1',
    [journalId],
  );
  if (!existing.rows[0]) {
    const poolBalance = await lockedPrizeBalance(executor, poolAccountId, row.settlement_wallet_address);
    if (poolBalance < BigInt(row.amount_usdt)) {
      throw new CoreError('UnknownState', 'Failed payout cannot restore the reorged prize deficit', 409);
    }
    const lines = [
      {
        account_id: poolAccountId,
        side: 'DEBIT',
        amount: row.amount_usdt,
        balance_state: 'LOCKED',
        backing_wallet_address: row.settlement_wallet_address,
      },
      {
        account_id: deficitAccountId,
        side: 'CREDIT',
        amount: row.amount_usdt,
        balance_state: 'POSTED',
        backing_wallet_address: row.settlement_wallet_address,
      },
    ];
    await executor.query(
      'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [
        journalId,
        `seckill-prize-deficit-recovered:${input.exposureId}:${recoveryEpisode}`,
        'SECKILL_PRIZE_DEFICIT_RECOVERED',
        'SECKILL_SESSION',
        awardedSessionId,
        null,
        null,
        hashJson({ exposureId: input.exposureId, terminalEvidenceHash: input.terminalEvidenceHash, lines }),
        null,
        null,
        'RECONCILIATION',
        input.terminalEvidenceHash,
        null,
        JSON.stringify({
          exposureId: input.exposureId,
          recoveryEpisode,
          terminalEvidenceHash: input.terminalEvidenceHash,
        }),
        JSON.stringify(lines),
      ],
    );
  }
  await appendPrizeReorgTransition(executor, {
    exposureId: input.exposureId,
    transitionType: 'PAYOUT_FAILED',
    evidenceHash: input.terminalEvidenceHash,
    payload: {
      ...input.terminalEvidence,
      recoveryEpisode,
      recoveryJournalId: journalId,
    },
    at: input.at,
  });
  await appendPrizeReorgTransition(executor, {
    exposureId: input.exposureId,
    transitionType: 'RESOLVED',
    evidenceHash: input.terminalEvidenceHash,
    payload: {
      resolution: 'PAYOUT_FAILED_RECOVERED',
      recoveryJournalId: journalId,
      recoveryEpisode,
    },
    at: input.at,
  });
}

async function failPrizeReorgJob(executor: SqlExecutor, jobId: string, errorCode: string, now: Date) {
  await executor.query(
    `UPDATE core.durable_jobs SET state = 'CONFIGURATION_REQUIRED', lease_owner = NULL,
       lease_expires_at = NULL, last_error_code = $2, updated_at = $3
     WHERE job_id = $1 AND state = 'LEASED'`,
    [jobId, errorCode, now],
  );
}

async function appendPrizeReorgTransition(
  executor: SqlExecutor,
  input: {
    exposureId: string;
    transitionType:
      | 'QUARANTINED'
      | 'FUNDING_REVERSED'
      | 'PAYOUT_FINAL'
      | 'PAYOUT_FAILED'
      | 'PAYOUT_REORGED'
      | 'REMAINDER_RECOVERABLE'
      | 'REMAINDER_ROLLED_OVER'
      | 'RESOLVED'
      | 'BREAKER_RESUMED';
    evidenceHash: string;
    payload: Record<string, unknown>;
    at: Date;
  },
) {
  const transitionId = hashJson({
    exposureId: input.exposureId,
    transitionType: input.transitionType,
    payload: input.payload,
  });
  await executor.query(
    `INSERT INTO core.seckill_prize_reorg_transitions (
       transition_id, exposure_id, transition_type, evidence_hash, payload, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (transition_id) DO NOTHING`,
    [
      transitionId,
      input.exposureId,
      input.transitionType,
      input.evidenceHash,
      JSON.stringify(input.payload),
      input.at,
    ],
  );
}

async function quarantinePrizeOutcome(
  executor: SqlExecutor,
  sessionId: string,
  input: PrizeFundingReversalInput,
) {
  await executor.query(
    `UPDATE core.seckill_prize_settlements
     SET state = 'QUARANTINED', updated_at = $2
     WHERE session_id = $1 AND state <> 'QUARANTINED'`,
    [sessionId, input.at],
  );
  await appendPrizeEvent(executor, {
    sessionId,
    eventType: 'QUARANTINED',
    evidenceHash: input.evidenceHash,
    identity: input.fundingId,
    payload: { fundingId: input.fundingId, reasonCode: 'PRIZE_FUNDING_REORG' },
    at: input.at,
  });
}

async function pausePrizeFundingReorg(
  executor: SqlExecutor,
  input: PrizeFundingReversalInput,
  recoveryEpisode: number,
) {
  const causeId = `seckill-prize-funding-reorg:${input.fundingId}`;
  await executor.query(
    `INSERT INTO core.breaker_causes (
       scope, cause_type, cause_id, active, evidence_hash, updated_at
     ) VALUES ('NEW_SETTLEMENT_BATCH','SECURITY',$1,true,$2,$3)
     ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
       SET active = true, evidence_hash = EXCLUDED.evidence_hash, updated_at = EXCLUDED.updated_at`,
    [causeId, input.evidenceHash, input.at],
  );
  await executor.query(
    `INSERT INTO core.breaker_events (
       breaker_event_id, scope, action, cause_type, cause_id,
       evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ($1,'NEW_SETTLEMENT_BATCH','PAUSE','SECURITY',$2,$3,NULL,'SECKILL_PRIZE_REORG',$4)
     ON CONFLICT (breaker_event_id) DO NOTHING`,
    [
      hashJson({ causeId, evidenceHash: input.evidenceHash, action: 'PAUSE', recoveryEpisode }),
      causeId,
      input.evidenceHash,
      input.at,
    ],
  );
  await executor.query(
    `INSERT INTO core.circuit_breakers (
       scope, paused, evidence_hash, policy_version, changed_by, changed_at
     ) VALUES ('NEW_SETTLEMENT_BATCH',true,$1,NULL,'SECKILL_PRIZE_REORG',$2)
     ON CONFLICT (scope) DO UPDATE SET paused = true, evidence_hash = EXCLUDED.evidence_hash,
       policy_version = NULL, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
    [input.evidenceHash, input.at],
  );
  await executor.query(
    `INSERT INTO core.outbox_events (
       event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
     ) VALUES ($1,'SECKILL_SESSION',$2,'SeckillPrizeFundingReorgQuarantined',$3,$1,'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `outbox:seckill-prize-funding-reorg:${hashJson({
        fundingId: input.fundingId,
        sourceSessionId: input.sourceSessionId,
        recoveryEpisode,
      }).slice(2)}`,
      input.sourceSessionId,
      JSON.stringify({
        fundingId: input.fundingId,
        sourceSessionId: input.sourceSessionId,
        amountUsdt: input.amountUsdt,
        evidenceHash: input.evidenceHash,
        recoveryEpisode,
      }),
    ],
  );
}

export async function rollPendingSeckillPrizesIntoSession(
  executor: SqlExecutor,
  targetSessionId: string,
  at: Date,
) {
  await lockSeckillPrizeFundingMutation(executor);
  const pending = await executor.query<{ session_id: string }>(
    `SELECT source.session_id
     FROM core.seckill_prize_settlements source
     JOIN core.seckill_sessions source_session ON source_session.session_id = source.session_id
     JOIN core.seckill_sessions target ON target.session_id = $1
     WHERE source.state = 'ROLLOVER_PENDING'
       AND source_session.starts_at < target.starts_at
       AND NOT EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements target_outcome
         WHERE target_outcome.session_id = target.session_id
       )
     ORDER BY source_session.starts_at, source.session_id
     FOR UPDATE OF source`,
    [targetSessionId],
  );
  for (const row of pending.rows) await rollPendingSeckillPrize(executor, row.session_id, at, targetSessionId);
  const remainders = await executor.query<{ remainder_id: string }>(
    `SELECT remainder.remainder_id
     FROM core.seckill_prize_reorg_remainders remainder
     JOIN core.seckill_sessions source ON source.session_id = remainder.session_id
     JOIN core.seckill_sessions target ON target.session_id = $1
     WHERE remainder.state = 'PENDING'
       AND source.starts_at < target.starts_at
       AND NOT EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements target_outcome
         WHERE target_outcome.session_id = target.session_id
       )
     ORDER BY source.starts_at, remainder.created_at, remainder.remainder_id
     FOR UPDATE OF remainder`,
    [targetSessionId],
  );
  for (const row of remainders.rows) {
    await rollPrizeReorgRemainder(executor, row.remainder_id, targetSessionId, at);
  }
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

async function rollPrizeReorgRemainder(
  executor: SqlExecutor,
  remainderId: string,
  targetSessionId: string,
  at: Date,
) {
  const result = await executor.query<{
    exposure_id: string;
    session_id: string;
    amount_usdt: string;
    settlement_wallet_address: string;
    evidence_hash: string;
    state: string;
    source_starts_at: Date;
    target_starts_at: Date;
    target_wallet_address: string;
  }>(
    `SELECT remainder.exposure_id, remainder.session_id,
       remainder.amount_usdt::text, remainder.settlement_wallet_address,
       remainder.evidence_hash, remainder.state,
       source.starts_at AS source_starts_at, target.starts_at AS target_starts_at,
       lower(policy.payload ->> 'usdtSettlementWallet') AS target_wallet_address
     FROM core.seckill_prize_reorg_remainders remainder
     JOIN core.seckill_sessions source ON source.session_id = remainder.session_id
     JOIN core.seckill_sessions target ON target.session_id = $2
     JOIN core.policy_snapshots policy ON policy.policy_version = target.policy_version
     WHERE remainder.remainder_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM core.seckill_prize_settlements target_outcome
         WHERE target_outcome.session_id = target.session_id
       )
     FOR UPDATE OF remainder, source, target`,
    [remainderId, targetSessionId],
  );
  const row = result.rows[0];
  if (!row || row.state !== 'PENDING') return;
  if (row.source_starts_at >= row.target_starts_at) {
    throw new CoreError('InvalidFinality', 'Prize reorg remainder cannot roll backward', 409);
  }
  if (row.target_wallet_address !== row.settlement_wallet_address) {
    throw new CoreError('InvalidFinality', 'Prize reorg remainder cannot cross settlement wallets', 409);
  }
  const sourceAccountId = `seckill-prize:${row.session_id}:usdt`;
  const targetAccountId = `seckill-prize:${targetSessionId}:usdt`;
  await ensurePrizeAccount(executor, {
    accountId: targetAccountId,
    ownerType: 'BENEFICIARY',
    ownerId: targetSessionId,
    walletAddress: null,
  });
  await lockLedgerAccounts(executor, [sourceAccountId, targetAccountId]);
  const sourceBalance = await lockedPrizeBalance(
    executor,
    sourceAccountId,
    row.settlement_wallet_address,
  );
  if (sourceBalance < BigInt(row.amount_usdt)) {
    throw new CoreError('UnknownState', 'Prize reorg remainder is not fully backed', 409);
  }
  const journalId = `journal:seckill-prize-reorg-remainder:${remainderId.slice(2)}`;
  const lines = [
    {
      account_id: sourceAccountId,
      side: 'DEBIT',
      amount: row.amount_usdt,
      balance_state: 'LOCKED',
      backing_wallet_address: row.settlement_wallet_address,
    },
    {
      account_id: targetAccountId,
      side: 'CREDIT',
      amount: row.amount_usdt,
      balance_state: 'LOCKED',
      backing_wallet_address: row.settlement_wallet_address,
    },
  ];
  const contentHash = hashJson({ remainderId, targetSessionId, lines });
  await executor.query(
    'SELECT core.post_resource_balanced_journal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [
      journalId,
      `seckill-prize-reorg-remainder:${remainderId}`,
      'SECKILL_PRIZE_REORG_REMAINDER_ROLLED_OVER',
      'SECKILL_SESSION',
      row.session_id,
      null,
      null,
      contentHash,
      null,
      null,
      'RECONCILIATION',
      row.evidence_hash,
      null,
      JSON.stringify({ remainderId, targetSessionId, amountUsdt: row.amount_usdt }),
      JSON.stringify(lines),
    ],
  );
  const moved = await executor.query<{ session_id: string }>(
    `UPDATE core.seckill_sessions SET prize_pool_usdt = CASE
       WHEN session_id = $1 THEN prize_pool_usdt - $3
       WHEN session_id = $2 THEN prize_pool_usdt + $3
       ELSE prize_pool_usdt END,
       updated_at = $4
     WHERE session_id IN ($1,$2)
       AND (session_id <> $1 OR prize_pool_usdt >= $3)
     RETURNING session_id`,
    [row.session_id, targetSessionId, row.amount_usdt, at],
  );
  if (moved.rows.length !== 2) {
    throw new CoreError('UnknownState', 'Prize reorg remainder pool cannot roll forward', 409);
  }
  await executor.query(
    `UPDATE core.seckill_prize_reorg_remainders
     SET state = 'ROLLED_OVER', target_session_id = $2,
       rollover_journal_id = $3, resolved_at = $4
     WHERE remainder_id = $1 AND state = 'PENDING'`,
    [remainderId, targetSessionId, journalId, at],
  );
  await appendPrizeReorgTransition(executor, {
    exposureId: row.exposure_id,
    transitionType: 'REMAINDER_ROLLED_OVER',
    evidenceHash: contentHash,
    payload: { remainderId, targetSessionId, amountUsdt: row.amount_usdt, journalId },
    at,
  });
  await appendPrizeEvent(executor, {
    sessionId: row.session_id,
    eventType: 'ROLLED_OVER',
    evidenceHash: contentHash,
    identity: remainderId,
    payload: { targetSessionId, amountUsdt: row.amount_usdt, journalId, remainderId },
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
    eventType: 'WINNER_FROZEN' | 'EMPTY_SESSION' | 'REVIEW_APPROVED' | 'REVIEW_REJECTED'
      | 'ROLLED_OVER' | 'QUARANTINED';
    evidenceHash: string;
    payload: Record<string, unknown>;
    identity?: string;
    actorWallet?: string;
    at: Date;
  },
) {
  const eventId = hashJson({
    sessionId: input.sessionId,
    eventType: input.eventType,
    evidenceHash: input.evidenceHash,
    identity: input.identity ?? null,
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

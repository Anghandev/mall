import { keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type {
  ExpiredUnresolvedPaymentQuote,
  FinalPaymentReceipt,
  PaymentReceiptCandidate,
  PaymentReceiptObservation,
  PaymentReceiptRepository,
  UnresolvedOrderEvidence,
} from '../chain/payment-receipt-worker.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import { canonicalPaymentEvent, recordSeckillRelayProjection } from './indexer-store.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import {
  PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
  finalizePaymentProjection,
  recordPaymentProjection,
  reversePaymentProjection,
} from './payment-store.ts';

const EXPIRED_LIMIT = 100;
const ORDINARY_FINAL_AUDIT_HOURS = 24;

interface PendingRow {
  order_id: string;
  quote_kind: 'ORDINARY' | 'SECKILL';
  submitted_tx_hash: string;
  replacement_for_tx_hash: string | null;
  finality_state: 'SUBMITTED' | 'MINED' | 'REPLACED' | 'REORGED' | 'FINAL';
  block_number: string | number | null;
  block_hash: string | null;
  payment_event_key: string | null;
}

export class PostgresPaymentReceiptRepository implements PaymentReceiptRepository {
  readonly #transactions: SqlTransactionRunner;
  readonly #routerAddress: string;

  constructor(input: { transactions: SqlTransactionRunner; routerAddress: string }) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.routerAddress)) {
      throw new CoreError('ExternalBlocked', 'PaymentRouter deployment address is unavailable', 503);
    }
    this.#transactions = input.transactions;
    this.#routerAddress = input.routerAddress.toLowerCase();
  }

  pendingReceipts() {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<PendingRow>(
        `WITH candidates AS (
           SELECT DISTINCT ON (quote.order_id, COALESCE(finality.tx_hash, quote.submitted_tx_hash))
             quote.order_id, quote.quote_kind,
             COALESCE(finality.tx_hash, quote.submitted_tx_hash) AS submitted_tx_hash,
             finality.replacement_for_tx_hash,
             COALESCE(finality.state, 'SUBMITTED') AS finality_state,
             finality.block_number, finality.block_hash,
             payment.event_key AS payment_event_key,
             payment.log_index AS payment_log_index,
             finality.evidence ->> 'paymentLogIndex' AS observed_log_index,
             quote.submitted_at
           FROM core.payment_quotes quote
           LEFT JOIN core.transaction_finality finality
             ON finality.resource_type = 'ORDER_PAYMENT'
            AND finality.resource_id = quote.order_id
           LEFT JOIN core.payment_events payment
             ON payment.order_id = quote.order_id
            AND payment.transaction_hash = finality.tx_hash
            AND payment.canonical
           LEFT JOIN core.seckill_sessions session ON session.session_id = quote.session_id
           WHERE quote.submitted_tx_hash IS NOT NULL
             AND COALESCE(finality.evidence ->> 'manualReconciliationRequired', 'false') <> 'true'
             AND (
               (quote.state IN ('SUBMITTED','REORGED')
                 AND COALESCE(finality.state, 'SUBMITTED') IN ('SUBMITTED','MINED','REPLACED','REORGED'))
               OR (quote.state = 'PAID' AND finality.state = 'MINED')
               OR (
                 quote.state = 'PAID' AND finality.state = 'FINAL'
                 AND (
                   (quote.session_id IS NOT NULL AND session.phase NOT IN ('SETTLED','FORCE_CLOSED'))
                   OR (quote.session_id IS NULL AND finality.finalized_at >=
                     clock_timestamp() - ($1 * interval '1 hour'))
                 )
               )
             )
           ORDER BY quote.order_id, COALESCE(finality.tx_hash, quote.submitted_tx_hash),
             (finality.transaction_id LIKE 'payment-submission:%') DESC,
             finality.updated_at DESC NULLS LAST
         )
         SELECT order_id, quote_kind, submitted_tx_hash, replacement_for_tx_hash,
           finality_state, block_number, block_hash, payment_event_key
         FROM candidates
         ORDER BY block_number NULLS LAST,
           COALESCE(payment_log_index, observed_log_index::bigint) NULLS LAST,
           submitted_at, order_id, submitted_tx_hash`,
        [ORDINARY_FINAL_AUDIT_HOURS],
      );
      return result.rows.map(paymentCandidate);
    });
  }

  expiredUnresolvedQuotes(now: Date) {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<{ order_id: string; deadline: Date }>(
        `SELECT order_id, deadline FROM core.payment_quotes
         WHERE deadline <= $1
           AND (
             (state = 'QUOTED' AND submitted_tx_hash IS NULL)
             OR state IN ('SUBMITTED','REORGED')
           )
         ORDER BY deadline, order_id LIMIT $2`,
        [now, EXPIRED_LIMIT],
      );
      return result.rows.map((row) => ({ orderId: row.order_id, deadline: row.deadline }));
    });
  }

  recordMined(
    candidate: PaymentReceiptCandidate,
    observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>,
  ) {
    return this.#transactions.transaction(async (executor) => {
      await lockKnownQuote(executor, candidate);
      await ensureSubmissionFinality(executor, candidate, this.#routerAddress);
      await adoptMinedSubmission(executor, candidate);
      const updated = await executor.query<{ transaction_id: string }>(
        `UPDATE core.transaction_finality
         SET block_number = $3, block_hash = $4, confirmations = $5,
           receipt_status = 1, state = 'MINED', finalized_at = NULL,
           evidence = evidence || $6::jsonb, updated_at = clock_timestamp()
         WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash = $2
           AND state IN ('SUBMITTED','MINED','REPLACED','REORGED')
         RETURNING transaction_id`,
        [
          candidate.orderId,
          candidate.txHash,
          observation.block.number,
          observation.block.hash,
          observation.confirmations,
          JSON.stringify({
            source: 'PAYMENT_RECEIPT_WORKER',
            canonical: true,
            paymentLogIndex: observation.paymentLogIndex,
          }),
        ],
      );
      if (updated.rows.length !== 1) {
        throw new CoreError('InvalidFinality', 'Pending payment finality row is ambiguous', 409);
      }
      await executor.query(
        `UPDATE core.payment_quotes SET state = 'SUBMITTED', updated_at = clock_timestamp()
         WHERE order_id = $1 AND submitted_tx_hash = $2`,
        [candidate.orderId, candidate.txHash],
      );
    });
  }

  recordFinal(input: FinalPaymentReceipt) {
    return this.#transactions.transaction(async (executor) => {
      await lockKnownQuote(executor, input.candidate);
      await ensureSubmissionFinality(executor, input.candidate, this.#routerAddress);
      await adoptMinedSubmission(executor, input.candidate);
      const payment = input.events.find((event) => event.eventName === 'PaymentCompleted');
      if (!payment || !input.observation.confirmationBlock) {
        throw new CoreError('InvalidFinality', 'Final payment receipt event is unavailable', 409);
      }
      await recordPaymentProjection(executor, {
        event: {
          ...canonicalPaymentEvent(
            input.observation.block,
            payment,
            input.observation.confirmations,
            input.observation.confirmationBlock.timestamp,
          ),
          ...(input.candidate.replacementForTxHash
            ? { replacementForTxHash: input.candidate.replacementForTxHash }
            : {}),
        },
      });
      for (const event of input.events) {
        if (event.eventName !== 'SeckillRelayExtended') continue;
        try {
          await recordSeckillRelayProjection(executor, input.observation.block, event);
        } catch (error) {
          if (
            error instanceof CoreError
            && error.code === 'InvalidFinality'
            && error.message === 'Seckill relay deadline does not match the Router event'
            && await hasEarlierUnprojectedSeckillRelay(executor, event)
          ) {
            throw new CoreError('ReorgPending', 'Earlier canonical seckill relay is not projected yet', 409, {
              cause: error.message,
            });
          }
          throw error;
        }
      }
      await finalizePaymentProjection(executor, {
        orderId: input.candidate.orderId,
        transactionHash: input.candidate.txHash,
        blockHash: input.observation.block.hash,
        confirmations: input.observation.confirmations,
        finalizedAt: new Date(input.observation.confirmationBlock.timestamp * 1_000),
      });
      await resolveRecoveryJob(executor, input.candidate.orderId, 'PAYMENT_FINAL');
    });
  }

  recordReorged(candidate: PaymentReceiptCandidate, canonicalBlockHash: string) {
    return this.#transactions.transaction(async (executor) => {
      await lockKnownQuote(executor, candidate);
      const payment = await executor.query<{
        event_key: string;
        confirmations: string | number;
      }>(
        `SELECT event_key, confirmations FROM core.payment_events
         WHERE order_id = $1 AND transaction_hash = $2 AND canonical
         FOR UPDATE`,
        [candidate.orderId, candidate.txHash],
      );
      if (payment.rows[0]) {
        const deepFinal = Number(payment.rows[0].confirmations) >= 15;
        await reversePaymentProjection(executor, payment.rows[0].event_key, canonicalBlockHash);
        if (deepFinal) {
          await executor.query(
            `UPDATE core.transaction_finality
             SET evidence = evidence || $3::jsonb, updated_at = clock_timestamp()
             WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash = $2`,
            [
              candidate.orderId,
              candidate.txHash,
              JSON.stringify({ manualReconciliationRequired: true, canonicalBlockHash }),
            ],
          );
          await pauseDeepReorgBreakers(executor, candidate, canonicalBlockHash);
        }
        return;
      }
      await ensureSubmissionFinality(executor, candidate, this.#routerAddress);
      await executor.query(
        `UPDATE core.transaction_finality
         SET state = 'REORGED', block_number = NULL, block_hash = NULL,
           confirmations = 0, receipt_status = NULL, finalized_at = NULL,
           evidence = evidence || $3::jsonb, updated_at = clock_timestamp()
         WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash = $2`,
        [candidate.orderId, candidate.txHash, JSON.stringify({ canonicalBlockHash })],
      );
      await executor.query(
        `UPDATE core.payment_quotes SET state = 'REORGED', updated_at = clock_timestamp()
         WHERE order_id = $1 AND submitted_tx_hash = $2`,
        [candidate.orderId, candidate.txHash],
      );
    });
  }

  recordFailed(candidate: PaymentReceiptCandidate, reasonCode: string) {
    return this.#transactions.transaction(async (executor) => {
      await lockKnownQuote(executor, candidate);
      await ensureSubmissionFinality(executor, candidate, this.#routerAddress);
      await executor.query(
        `UPDATE core.transaction_finality
         SET state = 'FAILED', finalized_at = NULL,
           evidence = evidence || $3::jsonb, updated_at = clock_timestamp()
         WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash = $2
           AND state <> 'FINAL'`,
        [candidate.orderId, candidate.txHash, JSON.stringify({ reasonCode })],
      );
    });
  }

  recordRecoveryRequired(
    input: ExpiredUnresolvedPaymentQuote,
    evidence: UnresolvedOrderEvidence,
    now: Date,
  ) {
    return this.#transactions.transaction(async (executor) => {
      if (evidence.state !== 'USED') throw new CoreError('InvalidFinality', 'Payment recovery proof is invalid');
      const quote = await lockUnresolvedQuote(executor, input, now);
      if (!quote) return;
      const payload = unresolvedEvidencePayload(input, evidence);
      await executor.query(
        `INSERT INTO core.durable_jobs (
           job_id, job_type, resource_id, payload, idempotency_key, state,
           last_error_code, available_at, created_at, updated_at
         ) VALUES ($1,'RECONCILE',$2,$3,$1,'CONFIGURATION_REQUIRED',
           'PAYMENT_TXHASH_RECOVERY_REQUIRED',$4,$4,$4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [`payment-txhash-recovery:${input.orderId}`, input.orderId, JSON.stringify(payload), now],
      );
    });
  }

  expireUnresolvedQuote(
    input: ExpiredUnresolvedPaymentQuote,
    evidence: UnresolvedOrderEvidence,
    now: Date,
  ) {
    return this.#transactions.transaction(async (executor) => {
      if (evidence.state !== 'UNUSED_AFTER_DEADLINE') {
        throw new CoreError('InvalidFinality', 'Unused payment order proof is invalid');
      }
      const quote = await lockUnresolvedQuote(executor, input, now);
      if (!quote) return;
      const reservations = await executor.query<{ reservation_id: string }>(
        `SELECT reservation.capacity_reservation_id AS reservation_id
         FROM core.payment_quote_legs leg
         JOIN core.inventory_reservations reservation ON reservation.reservation_id = leg.reservation_id
         WHERE leg.order_id = $1 AND reservation.state = 'ACTIVE'
         FOR UPDATE OF reservation`,
        [input.orderId],
      );
      for (const reservation of reservations.rows) {
        await executor.query("SELECT core.release_inventory_reservation($1, 'EXPIRED')", [reservation.reservation_id]);
      }
      await executor.query(
        `UPDATE core.payment_quotes SET state = 'EXPIRED', submitted_tx_hash = NULL,
           submitted_at = NULL, updated_at = $2
         WHERE order_id = $1 AND deadline = $3`,
        [input.orderId, now, input.deadline],
      );
      await resolveRecoveryJob(executor, input.orderId, 'UNUSED_AFTER_DEADLINE');
      const payload = unresolvedEvidencePayload(input, evidence);
      const evidenceHash = hashJson(payload);
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:payment-unused', payload),
        streamName: 'financial',
        evidenceProfile: 'SYSTEM',
        eventType: 'PAYMENT_ORDER_PROVEN_UNUSED',
        resourceType: 'ORDER_PAYMENT',
        resourceId: input.orderId,
        correlationId: `payment-unused:${input.orderId}`,
        requestHash: evidenceHash.slice(2),
        payload: { ...payload, evidenceHash },
        createdAt: now,
      });
    });
  }
}

function paymentCandidate(row: PendingRow): PaymentReceiptCandidate {
  const blockNumber = row.block_number === null ? undefined : Number(row.block_number);
  if (blockNumber !== undefined && (!Number.isSafeInteger(blockNumber) || blockNumber < 0)) {
    throw new CoreError('InvalidFinality', 'Stored payment receipt block is invalid');
  }
  return {
    orderId: row.order_id,
    quoteKind: row.quote_kind,
    txHash: row.submitted_tx_hash,
    finalityState: row.finality_state,
    ...(row.replacement_for_tx_hash ? { replacementForTxHash: row.replacement_for_tx_hash } : {}),
    ...(blockNumber !== undefined ? { observedBlockNumber: blockNumber } : {}),
    ...(row.block_hash ? { observedBlockHash: row.block_hash } : {}),
    ...(row.payment_event_key ? { paymentEventKey: row.payment_event_key } : {}),
  };
}

async function lockKnownQuote(executor: SqlExecutor, candidate: PaymentReceiptCandidate) {
  const quote = await executor.query<{ state: string; submitted_tx_hash: string; known: boolean }>(
    `SELECT quote.state, quote.submitted_tx_hash,
       EXISTS (
         SELECT 1 FROM core.transaction_finality finality
         WHERE finality.resource_type = 'ORDER_PAYMENT'
           AND finality.resource_id = quote.order_id AND finality.tx_hash = $2
       ) AS known
     FROM core.payment_quotes quote
     WHERE quote.order_id = $1 AND quote.state IN ('SUBMITTED','REORGED','PAID')
     FOR UPDATE`,
    [candidate.orderId, candidate.txHash],
  );
  const row = quote.rows[0];
  if (!row || (row.submitted_tx_hash.toLowerCase() !== candidate.txHash.toLowerCase() && !row.known)) {
    throw new CoreError('InvalidFinality', 'Submitted payment quote changed concurrently', 409);
  }
}

async function hasEarlierUnprojectedSeckillRelay(
  executor: SqlExecutor,
  event: FinalPaymentReceipt['events'][number],
) {
  const sessionId = event.values.sessionId?.toLowerCase();
  const orderId = event.values.orderId?.toLowerCase();
  if (!sessionId || !orderId) return false;
  const pending = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM core.payment_quotes quote
       LEFT JOIN core.seckill_relay_events relay
         ON relay.order_id = quote.order_id AND relay.canonical
       WHERE quote.session_id = $1 AND quote.order_id <> $2
         AND relay.order_id IS NULL
         AND (
           (quote.state = 'QUOTED' AND quote.submitted_tx_hash IS NULL)
           OR EXISTS (
             SELECT 1
             FROM core.transaction_finality finality
             WHERE finality.resource_type = 'ORDER_PAYMENT'
               AND finality.resource_id = quote.order_id
               AND finality.state IN ('SUBMITTED','MINED','REPLACED','REORGED','FINAL')
               AND (
                 finality.block_number IS NULL
                 OR finality.block_number < $3
                 OR (
                   finality.block_number = $3
                   AND CASE
                     WHEN finality.evidence ->> 'paymentLogIndex' ~ '^[0-9]+$'
                       THEN (finality.evidence ->> 'paymentLogIndex')::bigint
                     ELSE 9223372036854775807
                   END < $4
                 )
               )
           )
         )
     ) AS exists`,
    [sessionId, orderId, event.blockNumber, event.logIndex],
  );
  return pending.rows[0]?.exists === true;
}

async function adoptMinedSubmission(executor: SqlExecutor, candidate: PaymentReceiptCandidate) {
  const conflict = await executor.query<{ tx_hash: string }>(
    `SELECT tx_hash FROM core.transaction_finality
     WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash <> $2
       AND receipt_status = 1 AND state IN ('MINED','FINAL')
     FOR UPDATE`,
    [candidate.orderId, candidate.txHash],
  );
  if (conflict.rows[0]) throw new CoreError('InvalidFinality', 'Another payment submission is already mined', 409);
  await executor.query(
    `UPDATE core.transaction_finality SET state = 'REPLACED', updated_at = clock_timestamp()
     WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash <> $2
       AND receipt_status IS NULL AND state IN ('SUBMITTED','REORGED')`,
    [candidate.orderId, candidate.txHash],
  );
  await executor.query(
    `UPDATE core.payment_quotes
     SET state = CASE WHEN state = 'PAID' THEN state ELSE 'SUBMITTED' END,
       submitted_tx_hash = $2,
       updated_at = clock_timestamp() WHERE order_id = $1`,
    [candidate.orderId, candidate.txHash],
  );
}

async function ensureSubmissionFinality(
  executor: SqlExecutor,
  candidate: PaymentReceiptCandidate,
  routerAddress: string,
) {
  const existing = await executor.query<{
    transaction_id: string;
    chain_id: string | number;
    contract_address: string;
    expected_event_hash: string;
  }>(
    `SELECT transaction_id, chain_id, contract_address, expected_event_hash
     FROM core.transaction_finality
     WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1 AND tx_hash = $2
     FOR UPDATE`,
    [candidate.orderId, candidate.txHash],
  );
  if (existing.rows.length > 1) {
    throw new CoreError('InvalidFinality', 'Pending payment finality row is ambiguous', 409);
  }
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      Number(row.chain_id) !== 56
      || row.contract_address.toLowerCase() !== routerAddress
      || row.expected_event_hash.toLowerCase() !== PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH.toLowerCase()
    ) {
      throw new CoreError('InvalidFinality', 'Existing payment finality identity does not match the submission', 409);
    }
    return;
  }
  await executor.query(
    `INSERT INTO core.transaction_finality (
       transaction_id, resource_type, resource_id, chain_id, contract_address,
       expected_event_hash, tx_hash, replacement_for_tx_hash,
       confirmations, required_confirmations, state, evidence, submitted_at
     ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,$6,0,15,'SUBMITTED',$7,clock_timestamp())
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      `payment-submission:${candidate.orderId}:${candidate.txHash}`,
      candidate.orderId,
      routerAddress,
      PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
      candidate.txHash,
      candidate.replacementForTxHash ?? null,
      JSON.stringify({ source: 'PAYMENT_RECEIPT_WORKER_RECOVERY' }),
    ],
  );
}

async function lockUnresolvedQuote(
  executor: SqlExecutor,
  input: ExpiredUnresolvedPaymentQuote,
  now: Date,
) {
  const quote = await executor.query<{ order_id: string }>(
    `SELECT order_id FROM core.payment_quotes
     WHERE order_id = $1 AND state IN ('QUOTED','SUBMITTED','REORGED')
       AND deadline = $2 AND deadline <= $3
     FOR UPDATE`,
    [input.orderId, input.deadline, now],
  );
  return quote.rows[0];
}

async function resolveRecoveryJob(executor: SqlExecutor, orderId: string, resolution: string) {
  await executor.query(
    `UPDATE core.durable_jobs
     SET state = 'SUCCEEDED', payload = payload || $2::jsonb,
       last_error_code = NULL, updated_at = clock_timestamp()
     WHERE job_id = $1 AND job_type = 'RECONCILE'
       AND state = 'CONFIGURATION_REQUIRED'`,
    [`payment-txhash-recovery:${orderId}`, JSON.stringify({ resolution })],
  );
}

async function pauseDeepReorgBreakers(
  executor: SqlExecutor,
  candidate: PaymentReceiptCandidate,
  evidenceHash: string,
) {
  const scopes = candidate.quoteKind === 'SECKILL'
    ? ['NEW_PAYMENT', 'SECKILL_PURCHASE']
    : ['NEW_PAYMENT'];
  const causeId = `deep-payment-reorg:${candidate.orderId}`;
  for (const scope of scopes) {
    const breakerEventId = hashJson({ scope, causeId, evidenceHash, action: 'PAUSE' });
    await executor.query(
      `INSERT INTO core.breaker_causes (
         scope, cause_type, cause_id, active, evidence_hash, updated_at
       ) VALUES ($1,'SECURITY',$2,true,$3,clock_timestamp())
       ON CONFLICT (scope, cause_type, cause_id) DO UPDATE
         SET active = true, evidence_hash = EXCLUDED.evidence_hash,
           updated_at = EXCLUDED.updated_at`,
      [scope, causeId, evidenceHash],
    );
    await executor.query(
      `INSERT INTO core.breaker_events (
         breaker_event_id, scope, action, cause_type, cause_id,
         evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,$2,'PAUSE','SECURITY',$3,$4,NULL,
         'PAYMENT_RECEIPT_WORKER',clock_timestamp())
       ON CONFLICT (breaker_event_id) DO NOTHING`,
      [breakerEventId, scope, causeId, evidenceHash],
    );
    await executor.query(
      `INSERT INTO core.circuit_breakers (
         scope, paused, evidence_hash, policy_version, changed_by, changed_at
       ) VALUES ($1,true,$2,NULL,'PAYMENT_RECEIPT_WORKER',clock_timestamp())
       ON CONFLICT (scope) DO UPDATE SET paused = true,
         evidence_hash = EXCLUDED.evidence_hash, policy_version = NULL,
         changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [scope, evidenceHash],
    );
  }
}

function unresolvedEvidencePayload(
  input: ExpiredUnresolvedPaymentQuote,
  evidence: UnresolvedOrderEvidence,
) {
  return {
    orderId: input.orderId,
    deadline: input.deadline.toISOString(),
    usedOrderId: evidence.state === 'USED',
    proofBlockNumber: evidence.block.number,
    proofBlockHash: evidence.block.hash,
    proofBlockTimestamp: evidence.block.timestamp,
  };
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(JSON.stringify(value)));
}

import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

export interface BnmAvailabilityInput {
  orderId: string;
  buyerWallet: string;
  amount: string;
  state: 'LOCKED' | 'AVAILABLE';
  stateVersion: string;
  reason: string;
  sourceEvidenceHash: string;
  idempotencyKey: string;
}

export interface BnmAvailabilityAdapter {
  setState(input: BnmAvailabilityInput): Promise<{
    providerReference: string;
    syncedAt: string;
    state: 'LOCKED' | 'AVAILABLE';
    stateVersion: string;
  }>;
}

export class HttpBnmAvailabilityAdapter implements BnmAvailabilityAdapter {
  readonly #url: string | undefined;
  readonly #token: string | undefined;
  readonly #projectId: string | undefined;
  readonly #conformanceEvidenceHash: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    projectId?: string;
    conformanceEvidenceHash?: string;
    fetch?: typeof fetch;
  }) {
    if (input.url && new URL(input.url).protocol !== 'https:') {
      throw new CoreError('InvalidRequest', 'BNM availability endpoint must use HTTPS', 500);
    }
    this.#url = input.url;
    this.#token = input.token;
    this.#projectId = input.projectId;
    if (input.conformanceEvidenceHash && !/^0x[0-9a-fA-F]{64}$/.test(input.conformanceEvidenceHash)) {
      throw new CoreError('InvalidRequest', 'BNM monotonic conformance evidence must be bytes32', 500);
    }
    this.#conformanceEvidenceHash = input.conformanceEvidenceHash?.toLowerCase();
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  async setState(input: BnmAvailabilityInput) {
    validateBnmInput(input);
    if (!this.#url || !this.#token || !this.#projectId || !this.#conformanceEvidenceHash) {
      throw new CoreError('ConfigurationRequired', 'Existing BNM backend integration is unavailable', 503, {
        provider: 'BNM',
      });
    }
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify({
        projectId: this.#projectId,
        conformanceEvidenceHash: this.#conformanceEvidenceHash,
        orderId: input.orderId,
        walletAddress: input.buyerWallet,
        amount: input.amount,
        state: input.state,
        stateVersion: input.stateVersion,
        reason: input.reason,
        sourceEvidenceHash: input.sourceEvidenceHash,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new CoreError('ExternalBlocked', 'BNM backend request failed', 503, { provider: 'BNM' });
    });
    if (!response.ok) {
      throw new CoreError('ExternalBlocked', 'BNM backend rejected availability sync', 503, {
        provider: 'BNM',
        status: response.status,
      });
    }
    const body = await response.json().catch(() => undefined) as
      | {
        providerReference?: unknown;
        orderId?: unknown;
        amount?: unknown;
        state?: unknown;
        stateVersion?: unknown;
        conformanceEvidenceHash?: unknown;
        syncedAt?: unknown;
      }
      | undefined;
    if (
      !body
      || typeof body.providerReference !== 'string'
      || body.providerReference.length === 0
      || body.orderId !== input.orderId
      || body.amount !== input.amount
      || body.state !== input.state
      || body.stateVersion !== input.stateVersion
      || typeof body.conformanceEvidenceHash !== 'string'
      || body.conformanceEvidenceHash.toLowerCase() !== this.#conformanceEvidenceHash
      || typeof body.syncedAt !== 'string'
      || !Number.isFinite(Date.parse(body.syncedAt))
    ) throw new CoreError('ExternalBlocked', 'BNM backend returned an invalid acknowledgement', 503, { provider: 'BNM' });
    return {
      providerReference: body.providerReference,
      syncedAt: new Date(body.syncedAt).toISOString(),
      state: input.state,
      stateVersion: input.stateVersion,
    };
  }
}

interface LeasedBnmEvent {
  event_id: string;
  aggregate_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

export class BnmAvailabilityWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #adapter: BnmAvailabilityAdapter;
  readonly #workerId: string;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopping = false;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    adapter: BnmAvailabilityAdapter;
    workerId?: string;
    intervalMs?: number;
  }) {
    this.#transactions = input.transactions;
    this.#adapter = input.adapter;
    this.#workerId = input.workerId ?? `bnm-availability:${randomUUID()}`;
    this.#intervalMs = input.intervalMs ?? 5_000;
  }

  async pollOnce() {
    const events = await this.#transactions.transaction((executor) => leaseBnmEvents(executor, this.#workerId, 20));
    for (const event of events) {
      try {
        const input = bnmInput(event);
        const result = await this.#adapter.setState(input);
        validateBnmAcknowledgement(result, input);
        await this.#transactions.transaction(async (executor) => {
          const lease = await executor.query<{ state: string; locked_by: string | null; attempt_count: number }>(
            'SELECT state, locked_by, attempt_count FROM core.outbox_events WHERE event_id = $1 FOR UPDATE',
            [event.event_id],
          );
          if (
            lease.rows[0]?.state !== 'PROCESSING'
            || lease.rows[0].locked_by !== this.#workerId
            || lease.rows[0].attempt_count !== event.attempt_count
          ) return;
          const existing = await executor.query<{
            amount: string;
            source_evidence_hash: string;
            provider_reference_hash: string;
            state: string;
            state_version: string;
          }>(
            `SELECT amount::text, source_evidence_hash, provider_reference_hash, state,
               state_version::text
             FROM core.bnm_state_syncs WHERE event_id = $1`,
            [event.event_id],
          );
          const providerReferenceHash = hash(result.providerReference);
          if (existing.rows[0]) {
            const row = existing.rows[0];
            if (
              row.amount !== input.amount
              || row.source_evidence_hash.toLowerCase() !== input.sourceEvidenceHash.toLowerCase()
              || row.provider_reference_hash.toLowerCase() !== providerReferenceHash
              || row.state !== input.state
              || row.state_version !== input.stateVersion
            ) throw new CoreError('IdempotencyConflict', 'BNM availability acknowledgement changed', 409);
          } else {
            await executor.query(
              `INSERT INTO core.bnm_state_syncs (
                 sync_id, event_id, order_id, amount, source_evidence_hash,
                 provider_reference_hash, state, state_version, synced_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                `bnm-sync:${event.event_id}`,
                event.event_id,
                input.orderId,
                input.amount,
                input.sourceEvidenceHash,
                providerReferenceHash,
                input.state,
                input.stateVersion,
                new Date(result.syncedAt),
              ],
            );
          }
          await executor.query(
            `UPDATE core.outbox_events SET state = 'DELIVERED', delivered_at = clock_timestamp(),
               locked_by = NULL, locked_until = NULL, last_error_code = NULL
             WHERE event_id = $1 AND state = 'PROCESSING' AND locked_by = $2
               AND attempt_count = $3`,
            [event.event_id, this.#workerId, event.attempt_count],
          );
        });
      } catch (error) {
        await this.#transactions.transaction((executor) => retryBnmEvent(executor, event, this.#workerId, error));
      }
    }
    this.#lastErrorCode = undefined;
    return events.length;
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }

  start() {
    if (this.#timer || this.#running) return;
    this.#stopping = false;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => { this.#lastErrorCode = undefined; })
        .catch((error) => { this.#lastErrorCode = errorCode(error, 'UnexpectedBnmWorkerFailure'); })
        .finally(() => {
        this.#running = undefined;
        if (!this.#stopping) this.#timer = setTimeout(tick, this.#intervalMs);
      });
    };
    this.#timer = setTimeout(tick, this.#intervalMs);
  }

  async stop() {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}

async function leaseBnmEvents(executor: SqlExecutor, workerId: string, limit: number) {
  const result = await executor.query<LeasedBnmEvent>(
    `WITH ordered AS (
       SELECT event_id, aggregate_id, state, available_at, locked_until,
         row_number() OVER (
           PARTITION BY aggregate_id ORDER BY created_at, event_id
         ) AS order_position
       FROM core.outbox_events
       WHERE event_type IN ('BnmAvailabilityRequested', 'BnmLockRequested')
         AND state IN ('PENDING', 'PROCESSING')
     ), selected AS (
       SELECT event.event_id FROM core.outbox_events event
       JOIN ordered ON ordered.event_id = event.event_id
       WHERE ordered.order_position = 1
         AND ordered.available_at <= clock_timestamp()
         AND (
           ordered.state = 'PENDING'
           OR (ordered.state = 'PROCESSING' AND ordered.locked_until < clock_timestamp())
         )
       ORDER BY event.available_at, event.created_at, event.event_id
       FOR UPDATE OF event SKIP LOCKED LIMIT $1
     )
     UPDATE core.outbox_events event
     SET state = 'PROCESSING', locked_by = $2,
         locked_until = clock_timestamp() + interval '30 seconds',
         attempt_count = attempt_count + 1
     FROM selected WHERE event.event_id = selected.event_id
     RETURNING event.event_id, event.aggregate_id, event.idempotency_key,
       event.payload, event.attempt_count`,
    [limit, workerId],
  );
  return result.rows;
}

async function retryBnmEvent(
  executor: SqlExecutor,
  event: LeasedBnmEvent,
  workerId: string,
  error: unknown,
) {
  const code = error instanceof CoreError ? error.code : 'ExternalBlocked';
  const configurationMissing = code === 'ConfigurationRequired' || code === 'ExternalBlocked';
  const deadLetter = !configurationMissing && event.attempt_count >= 5;
  await executor.query(
    `UPDATE core.outbox_events SET state = CASE
         WHEN last_error_code = 'PaymentReorgCancellationPending' THEN 'DEAD_LETTER'
         ELSE $3
       END,
       available_at = clock_timestamp() + ($4 * interval '1 second'),
       locked_by = NULL, locked_until = NULL,
       last_error_code = CASE
         WHEN last_error_code = 'PaymentReorgCancellationPending' THEN 'PaymentReorged'
         ELSE $5
       END
     WHERE event_id = $1 AND state = 'PROCESSING' AND locked_by = $2
       AND attempt_count = $6`,
    [
      event.event_id,
      workerId,
      deadLetter ? 'DEAD_LETTER' : 'PENDING',
      configurationMissing ? 300 : 30,
      code,
      event.attempt_count,
    ],
  );
}

function bnmInput(event: LeasedBnmEvent): BnmAvailabilityInput {
  const { orderId, buyerWallet, amount, state, stateVersion, reason, sourceEvidenceHash } = event.payload;
  const input = {
    orderId,
    buyerWallet,
    amount,
    state,
    stateVersion,
    reason,
    sourceEvidenceHash,
    idempotencyKey: event.idempotency_key,
  };
  validateBnmInput(input);
  return input;
}

function errorCode(error: unknown, fallback: string) {
  return error instanceof CoreError ? error.code : fallback;
}

function validateBnmInput(input: {
  orderId: unknown;
  buyerWallet: unknown;
  amount: unknown;
    state: unknown;
    stateVersion: unknown;
  reason: unknown;
  sourceEvidenceHash: unknown;
  idempotencyKey: unknown;
}): asserts input is BnmAvailabilityInput {
  if (
    typeof input.orderId !== 'string'
    || typeof input.buyerWallet !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(input.buyerWallet)
    || typeof input.amount !== 'string'
    || !/^[1-9][0-9]*$/.test(input.amount)
    || (input.state !== 'LOCKED' && input.state !== 'AVAILABLE')
    || typeof input.stateVersion !== 'string'
    || !/^[1-9][0-9]*$/.test(input.stateVersion)
    || typeof input.reason !== 'string'
    || input.reason.length === 0
    || typeof input.sourceEvidenceHash !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(input.sourceEvidenceHash)
    || typeof input.idempotencyKey !== 'string'
    || input.idempotencyKey.length === 0
  ) throw new CoreError('InvalidRequest', 'Invalid BNM availability event', 409);
}

function validateBnmAcknowledgement(
  result: { providerReference: unknown; syncedAt: unknown; state: unknown; stateVersion: unknown },
  input: BnmAvailabilityInput,
) {
  if (
    typeof result.providerReference !== 'string'
    || result.providerReference.length === 0
    || typeof result.syncedAt !== 'string'
    || !Number.isFinite(Date.parse(result.syncedAt))
    || result.state !== input.state
    || result.stateVersion !== input.stateVersion
  ) throw new CoreError('ExternalBlocked', 'BNM backend acknowledgement did not prove monotonic state', 503);
}

function hash(value: string) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

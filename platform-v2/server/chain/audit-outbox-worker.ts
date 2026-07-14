import { appendAuditEntry, type AuditInput } from '../data/audit-chain.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;

interface AuditOutboxRow {
  source_event_id: string;
  stream_name: AuditInput['streamName'];
  evidence_profile: AuditInput['evidenceProfile'];
  event_type: string;
  resource_type: string;
  resource_id: string;
  actor_wallet: string | null;
  actor_role: string | null;
  correlation_id: string;
  request_hash: string;
  payload: Record<string, unknown>;
  authorization_evidence: Record<string, unknown>;
  signature_evidence: Record<string, unknown>;
  transaction_evidence: Record<string, unknown>;
  attempt_count: number;
}

export class AuditOutboxWorker {
  readonly #business: SqlTransactionRunner;
  readonly #audit: SqlTransactionRunner;
  readonly #workerId: string;
  readonly #clock: () => Date;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    business: SqlTransactionRunner;
    audit: SqlTransactionRunner;
    workerId?: string;
    clock?: () => Date;
  }) {
    this.#business = input.business;
    this.#audit = input.audit;
    this.#workerId = input.workerId ?? `audit-${process.pid}`;
    this.#clock = input.clock ?? (() => new Date());
  }

  async pollOnce() {
    const event = await this.#business.transaction((executor) => lease(executor, this.#workerId, this.#clock()));
    if (!event) return false;
    try {
      await appendAuditEntry(this.#audit, {
        sourceEventId: event.source_event_id,
        streamName: event.stream_name,
        evidenceProfile: event.evidence_profile,
        eventType: event.event_type,
        resourceType: event.resource_type,
        resourceId: event.resource_id,
        ...(event.actor_wallet ? { actorWallet: event.actor_wallet } : {}),
        ...(event.actor_role ? { actorRole: event.actor_role } : {}),
        correlationId: event.correlation_id,
        requestHash: event.request_hash,
        payload: withoutContentHash(event.payload),
        ...(Object.keys(event.authorization_evidence).length > 0
          ? { authorizationEvidence: event.authorization_evidence as unknown as NonNullable<AuditInput['authorizationEvidence']> }
          : {}),
        ...(Object.keys(event.signature_evidence).length > 0
          ? { signatureEvidence: event.signature_evidence as unknown as NonNullable<AuditInput['signatureEvidence']> }
          : {}),
        ...(Object.keys(event.transaction_evidence).length > 0
          ? { transactionEvidence: event.transaction_evidence as unknown as NonNullable<AuditInput['transactionEvidence']> }
          : {}),
      });
      await this.#business.transaction((executor) => delivered(executor, event.source_event_id, this.#workerId, this.#clock()));
      this.#lastErrorCode = undefined;
    } catch (error) {
      const code = errorCode(error);
      this.#lastErrorCode = code;
      await this.#business.transaction((executor) => failed(
        executor,
        event.source_event_id,
        this.#workerId,
        event.attempt_count,
        code,
        this.#clock(),
      ));
    }
    return true;
  }

  start(intervalMs = 1_000) {
    if (this.#timer || this.#running) return;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error); })
        .finally(() => {
          this.#running = undefined;
          if (this.#timer) this.#timer = setTimeout(tick, intervalMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }
}

async function lease(executor: SqlExecutor, workerId: string, now: Date) {
  const result = await executor.query<AuditOutboxRow>(
    `WITH candidate AS (
       SELECT source_event_id FROM core.audit_outbox_events
       WHERE (state IN ('PENDING', 'RETRY') AND available_at <= $1)
          OR (state = 'PROCESSING' AND locked_until <= $1)
       ORDER BY available_at, created_at, source_event_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE core.audit_outbox_events event
     SET state = 'PROCESSING', locked_by = $2, locked_until = $3,
         attempt_count = event.attempt_count + 1
     FROM candidate WHERE event.source_event_id = candidate.source_event_id
     RETURNING event.*`,
    [now, workerId, new Date(now.getTime() + LEASE_MS)],
  );
  return result.rows[0];
}

async function delivered(executor: SqlExecutor, sourceEventId: string, workerId: string, now: Date) {
  const result = await executor.query(
    `UPDATE core.audit_outbox_events
     SET state = 'DELIVERED', delivered_at = $3, locked_by = NULL,
         locked_until = NULL, last_error_code = NULL
     WHERE source_event_id = $1 AND state = 'PROCESSING' AND locked_by = $2
     RETURNING source_event_id`,
    [sourceEventId, workerId, now],
  );
  if (!result.rows[0]) throw new Error('AuditLeaseLost');
}

async function failed(
  executor: SqlExecutor,
  sourceEventId: string,
  workerId: string,
  attemptCount: number,
  code: string,
  now: Date,
) {
  const terminal = attemptCount >= MAX_ATTEMPTS;
  await executor.query(
    `UPDATE core.audit_outbox_events
     SET state = $3, available_at = $4, locked_by = NULL, locked_until = NULL,
         last_error_code = $5
     WHERE source_event_id = $1 AND state = 'PROCESSING' AND locked_by = $2`,
    [
      sourceEventId,
      workerId,
      terminal ? 'DEAD_LETTER' : 'RETRY',
      new Date(now.getTime() + Math.min(300_000, 2 ** Math.min(attemptCount, 8) * 1_000)),
      code,
    ],
  );
}

function withoutContentHash(payload: Record<string, unknown>) {
  const { _contentHash: _ignored, ...rest } = payload;
  return rest;
}

function errorCode(error: unknown) {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.message)) return error.message;
  return 'AuditDeliveryFailed';
}

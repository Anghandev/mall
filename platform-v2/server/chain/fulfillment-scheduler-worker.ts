import { createHash } from 'node:crypto';
import type { UserRole } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface SchedulerActor {
  walletAddress: string;
  roles: readonly UserRole[];
}

interface SchedulerOrder {
  orderId: string;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  state: string;
  paymentFinalizedAt: string | null;
  shipments: readonly unknown[];
}

export interface FulfillmentSchedulerService {
  listOrders(actor: SchedulerActor): Promise<readonly SchedulerOrder[]>;
  openTakeover(
    actor: SchedulerActor,
    orderId: string,
    input: { idempotencyKey: string; evidenceHash: string; reasonCode: string },
  ): Promise<unknown>;
}

export class FulfillmentSchedulerWorker {
  readonly #service: FulfillmentSchedulerService;
  readonly #actor: SchedulerActor;
  readonly #clock: () => Date;
  readonly #intervalMs: number;
  readonly #transactions: SqlTransactionRunner;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopping = false;
  #lastErrorCode: string | undefined;

  constructor(input: {
    service: FulfillmentSchedulerService;
    platformWallet: string;
    transactions: SqlTransactionRunner;
    clock?: () => Date;
    intervalMs?: number;
  }) {
    this.#service = input.service;
    this.#actor = { walletAddress: input.platformWallet, roles: ['OPERATOR'] };
    this.#clock = input.clock ?? (() => new Date());
    this.#intervalMs = input.intervalMs ?? 60_000;
    this.#transactions = input.transactions;
  }

  async pollOnce() {
    const now = this.#clock();
    const orders = await this.#service.listOrders(this.#actor);
    let opened = 0;
    let pickupBlocked = 0;
    let deferred = 0;
    let failed = 0;
    let retryPending = false;
    let deadLettered = false;
    for (const order of orders) {
      if (order.state !== 'PAID' || !order.paymentFinalizedAt || order.shipments.length > 0) continue;
      if (order.fulfillmentMode === 'PICKUP') {
        pickupBlocked += 1;
        continue;
      }
      const finalizedAt = new Date(order.paymentFinalizedAt);
      if (!Number.isFinite(finalizedAt.getTime()) || now.getTime() < finalizedAt.getTime() + SEVEN_DAYS_MS) continue;
      const disposition = await this.#transactions.transaction(
        (executor) => takeoverJobDisposition(executor, order.orderId),
      );
      if (disposition !== 'RUN') {
        deferred += 1;
        retryPending ||= disposition === 'RETRY_WAIT';
        deadLettered ||= disposition === 'DEAD_LETTER';
        continue;
      }
      try {
        await this.#service.openTakeover(this.#actor, order.orderId, {
          idempotencyKey: `auto-takeover:${order.orderId}`,
          evidenceHash: takeoverEvidenceHash(order.orderId, finalizedAt),
          reasonCode: 'SEVEN_DAY_NO_SHIPMENT',
        });
        opened += 1;
        await this.#transactions.transaction((executor) => markTakeoverJobSucceeded(executor, order.orderId));
      } catch (error) {
        if (
          error instanceof CoreError
          && ['FinalityPending', 'UnknownState', 'IdempotencyConflict'].includes(error.code)
        ) {
          deferred += 1;
          continue;
        }
        failed += 1;
        await this.#transactions.transaction((executor) => recordTakeoverFailure(executor, order.orderId, error));
      }
    }
    this.#lastErrorCode = failed > 0
      ? 'TakeoverOrderFailure'
      : deadLettered
        ? 'TakeoverOrderDeadLetter'
        : retryPending
          ? 'TakeoverOrderRetryPending'
          : undefined;
    return { checked: orders.length, opened, pickupBlocked, deferred, failed };
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }

  start() {
    if (this.#timer || this.#running) return;
    this.#stopping = false;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error, 'UnexpectedFulfillmentSchedulerFailure'); })
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

async function takeoverJobDisposition(
  executor: SqlExecutor,
  orderId: string,
): Promise<'RUN' | 'RETRY_WAIT' | 'DEAD_LETTER' | 'DONE'> {
  const result = await executor.query<{
    state: string;
    available: boolean;
    lease_expired: boolean;
  }>(
    `SELECT state,
       available_at <= clock_timestamp() AS available,
       lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp() AS lease_expired
     FROM core.durable_jobs WHERE idempotency_key = $1`,
    [`auto-takeover:${orderId}`],
  );
  const job = result.rows[0];
  if (!job) return 'RUN';
  if (job.state === 'DEAD_LETTER' || job.state === 'CONFIGURATION_REQUIRED') return 'DEAD_LETTER';
  if (job.state === 'SUCCEEDED') return 'DONE';
  if ((job.state === 'READY' || job.state === 'RETRY') && job.available) return 'RUN';
  if (job.state === 'LEASED' && job.lease_expired) return 'RUN';
  return 'RETRY_WAIT';
}

async function recordTakeoverFailure(executor: SqlExecutor, orderId: string, error: unknown) {
  const code = errorCode(error, 'UnexpectedTakeoverFailure');
  await executor.query(
    `INSERT INTO core.durable_jobs (
       job_id, job_type, resource_id, payload, idempotency_key, state,
       attempt_count, available_at, last_error_code
     ) VALUES ($1,'OPEN_TAKEOVER',$2,$3,$1,'RETRY',1,clock_timestamp() + interval '5 minutes',$4)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       state = CASE WHEN core.durable_jobs.attempt_count + 1 >= 5 THEN 'DEAD_LETTER' ELSE 'RETRY' END,
       attempt_count = core.durable_jobs.attempt_count + 1,
       available_at = clock_timestamp() + interval '5 minutes',
       lease_owner = NULL, lease_expires_at = NULL,
       last_error_code = EXCLUDED.last_error_code,
       updated_at = clock_timestamp()`,
    [`auto-takeover:${orderId}`, orderId, JSON.stringify({ source: 'FULFILLMENT_SCHEDULER' }), code],
  );
}

async function markTakeoverJobSucceeded(executor: SqlExecutor, orderId: string) {
  await executor.query(
    `UPDATE core.durable_jobs SET state = 'SUCCEEDED', lease_owner = NULL,
       lease_expires_at = NULL, last_error_code = NULL, updated_at = clock_timestamp()
     WHERE idempotency_key = $1 AND state IN ('READY', 'LEASED', 'RETRY')`,
    [`auto-takeover:${orderId}`],
  );
}

function errorCode(error: unknown, fallback: string) {
  return error instanceof CoreError ? error.code : fallback;
}

function takeoverEvidenceHash(orderId: string, finalizedAt: Date) {
  return `0x${createHash('sha256')
    .update(`delivery-takeover-v1:${orderId}:${finalizedAt.toISOString()}`)
    .digest('hex')}`;
}

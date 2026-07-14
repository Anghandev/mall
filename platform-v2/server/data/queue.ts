import type { SqlExecutor } from './migrations.ts';

export interface LeasedJob {
  job_id: string;
  job_type: string;
  resource_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  lease_owner: string;
  lease_expires_at: Date | string;
}

export async function leaseDurableJobs(executor: SqlExecutor, worker: string, limit: number, leaseSeconds: number) {
  if (!worker || limit < 1 || limit > 100 || leaseSeconds < 1 || leaseSeconds > 900) {
    throw new Error('InvalidJobLease');
  }
  const result = await executor.query<LeasedJob>(
    `WITH selected AS (
       SELECT job_id
       FROM core.durable_jobs
       WHERE state IN ('READY', 'RETRY')
         AND available_at <= clock_timestamp()
         AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE core.durable_jobs AS jobs
     SET state = 'LEASED',
         lease_owner = $2,
         lease_expires_at = clock_timestamp() + ($3 * interval '1 second'),
         attempt_count = attempt_count + 1,
         updated_at = clock_timestamp()
     FROM selected
     WHERE jobs.job_id = selected.job_id
     RETURNING jobs.job_id, jobs.job_type, jobs.resource_id, jobs.payload,
               jobs.attempt_count, jobs.lease_owner, jobs.lease_expires_at`,
    [limit, worker, leaseSeconds],
  );
  return result.rows;
}

export async function leaseOutboxEvents(executor: SqlExecutor, worker: string, limit: number, leaseSeconds: number) {
  if (!worker || limit < 1 || limit > 100 || leaseSeconds < 1 || leaseSeconds > 900) {
    throw new Error('InvalidOutboxLease');
  }
  const result = await executor.query(
    `WITH selected AS (
       SELECT event_id
       FROM core.outbox_events
       WHERE state = 'PENDING'
         AND available_at <= clock_timestamp()
         AND (locked_until IS NULL OR locked_until < clock_timestamp())
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE core.outbox_events AS events
     SET state = 'PROCESSING', locked_by = $2,
         locked_until = clock_timestamp() + ($3 * interval '1 second'),
         attempt_count = attempt_count + 1
     FROM selected
     WHERE events.event_id = selected.event_id
     RETURNING events.*`,
    [limit, worker, leaseSeconds],
  );
  return result.rows;
}

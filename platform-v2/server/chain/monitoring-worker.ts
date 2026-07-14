import { randomUUID } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import { CoreError } from '../api/errors.ts';
import { auditSourceId, enqueueAudit } from '../data/audit-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';

export interface MetricObservation {
  component:
    | 'HOST'
    | 'REDIS'
    | 'MQ'
    | 'DATABASE'
    | 'HTTP'
    | 'PAYMENT'
    | 'FULFILLMENT'
    | 'RPC_PRIMARY'
    | 'RPC_FALLBACK'
    | 'EXPLORER';
  metricName: string;
  unit: 'PERCENT' | 'BYTES' | 'COUNT' | 'MILLISECONDS' | 'BLOCK' | 'PER_SECOND';
  value: number | null;
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNAVAILABLE' | 'CONFIGURATION_REQUIRED';
  windowStartedAt: Date;
  windowEndedAt: Date;
  evidence: Record<string, unknown>;
}

export interface MonitoringSource {
  readonly name: string;
  collect(now: Date): Promise<readonly MetricObservation[]>;
}

export class RuntimeMetricsRegistry implements MonitoringSource {
  readonly name = 'runtime';
  readonly #samples: Array<{ kind: 'HTTP' | 'PAYMENT' | 'FULFILLMENT'; durationMs: number; error: boolean; at: Date }> = [];
  readonly #windowMs: number;

  constructor(windowMs = 5 * 60_000) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new Error('InvalidMetricsWindow');
    this.#windowMs = windowMs;
  }

  record(kind: 'HTTP' | 'PAYMENT' | 'FULFILLMENT', durationMs: number, error: boolean, at = new Date()) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('InvalidRuntimeMetric');
    this.#samples.push({ kind, durationMs, error, at });
    this.#trim(at);
  }

  async collect(now: Date) {
    this.#trim(now);
    const started = new Date(now.getTime() - this.#windowMs);
    const result: MetricObservation[] = [];
    for (const kind of ['HTTP', 'PAYMENT', 'FULFILLMENT'] as const) {
      const samples = this.#samples.filter((sample) => sample.kind === kind);
      if (samples.length === 0) {
        result.push(unavailable(kind, 'throughput', 'PER_SECOND', started, now, 'NoSamplesInWindow'));
        result.push(unavailable(kind, 'average_latency', 'MILLISECONDS', started, now, 'NoSamplesInWindow'));
        if (kind === 'HTTP') result.push(unavailable(kind, 'error_rate', 'PERCENT', started, now, 'NoSamplesInWindow'));
        continue;
      }
      const seconds = this.#windowMs / 1_000;
      result.push(observation(kind, 'throughput', 'PER_SECOND', samples.length / seconds, 'HEALTHY', started, now, { sampleCount: samples.length }));
      const average = samples.reduce((sum, sample) => sum + sample.durationMs, 0) / samples.length;
      result.push(observation(kind, 'average_latency', 'MILLISECONDS', average, average >= 5_000 ? 'CRITICAL' : average >= 2_000 ? 'WARNING' : 'HEALTHY', started, now, { sampleCount: samples.length }));
      if (kind === 'HTTP') {
        const errorRate = (samples.filter((sample) => sample.error).length / samples.length) * 100;
        result.push(observation(kind, 'error_rate', 'PERCENT', errorRate, errorRate >= 5 ? 'CRITICAL' : errorRate >= 1 ? 'WARNING' : 'HEALTHY', started, now, { sampleCount: samples.length }));
      }
    }
    return result;
  }

  #trim(now: Date) {
    const cutoff = now.getTime() - this.#windowMs;
    while (this.#samples[0] && this.#samples[0].at.getTime() < cutoff) this.#samples.shift();
  }
}

export class OperationsMonitoringWorker {
  readonly #transactions: SqlTransactionRunner;
  readonly #sources: readonly MonitoringSource[];
  readonly #clock: () => Date;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    sources: readonly MonitoringSource[];
    clock?: () => Date;
    intervalMs?: number;
  }) {
    if (input.sources.length === 0) throw new Error('MonitoringSourcesRequired');
    this.#transactions = input.transactions;
    this.#sources = input.sources;
    this.#clock = input.clock ?? (() => new Date());
    this.#intervalMs = input.intervalMs ?? 15_000;
  }

  async pollOnce() {
    const now = this.#clock();
    const observations: MetricObservation[] = [];
    const failures: Array<{ sourceName: string; errorCode: string }> = [];
    for (const source of this.#sources) {
      try {
        observations.push(...await source.collect(now));
      } catch {
        failures.push({ sourceName: source.name, errorCode: `${source.name}ProbeUnavailable` });
      }
    }
    validateObservations(observations);
    await this.#transactions.transaction(async (executor) => {
      for (const item of observations) await persistObservation(executor, item, now);
      for (const failure of failures) await persistProbeFailure(executor, failure, now);
    });
    this.#lastErrorCode = failures[0]?.errorCode;
    return observations.length;
  }

  start() {
    if (this.#timer || this.#running) return;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error); })
        .finally(() => {
          this.#running = undefined;
          if (this.#timer) this.#timer = setTimeout(tick, this.#intervalMs);
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

async function persistObservation(executor: SqlExecutor, item: MetricObservation, observedAt: Date) {
  const snapshotId = `metric:${randomUUID()}`;
  await executor.query(
    `INSERT INTO core.operations_metric_snapshots (
       snapshot_id, component, metric_name, unit, metric_value, status,
       window_started_at, window_ended_at, evidence, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      snapshotId,
      item.component,
      item.metricName,
      item.unit,
      item.value,
      item.status,
      item.windowStartedAt,
      item.windowEndedAt,
      JSON.stringify(item.evidence),
      observedAt,
    ],
  );
  const alertKey = `${item.component}:${item.metricName}`;
  const current = await executor.query<{ event_type: string; severity: string }>(
    'SELECT event_type, severity FROM core.current_operations_alerts WHERE alert_key = $1',
    [alertKey],
  );
  const severity = item.status === 'CRITICAL' ? 'CRITICAL'
    : item.status === 'WARNING' || item.status === 'UNAVAILABLE' ? 'WARNING'
      : undefined;
  if (severity) {
    if (current.rows[0]?.event_type === 'ACKNOWLEDGED' && current.rows[0].severity === severity) return;
    if (current.rows[0]?.event_type === 'OPENED' && current.rows[0].severity === severity) return;
    const inserted = await insertAlert(executor, alertKey, 'OPENED', severity, snapshotId, null, item, observedAt);
    await persistSystemAlertAudit(executor, {
      ...inserted,
      alertKey,
      eventType: 'MonitoringAlertOpened',
      severity,
      snapshotId,
      observedAt,
    });
  } else if (item.status === 'HEALTHY' && current.rows[0] && current.rows[0].event_type !== 'RECOVERED') {
    const severity = current.rows[0].severity as 'WARNING' | 'CRITICAL';
    const inserted = await insertAlert(executor, alertKey, 'RECOVERED', severity, snapshotId, null, item, observedAt);
    await persistSystemAlertAudit(executor, {
      ...inserted,
      alertKey,
      eventType: 'MonitoringAlertRecovered',
      severity,
      snapshotId,
      observedAt,
    });
  }
}

async function insertAlert(
  executor: SqlExecutor,
  alertKey: string,
  eventType: 'OPENED' | 'ACKNOWLEDGED' | 'RECOVERED',
  severity: 'WARNING' | 'CRITICAL',
  snapshotId: string,
  actorWallet: string | null,
  evidence: unknown,
  now: Date,
) {
  const evidenceHash = hashJson({ alertKey, eventType, severity, snapshotId, actorWallet, evidence });
  const alertEventId = `alert:${randomUUID()}`;
  await executor.query(
    `INSERT INTO core.operations_alert_events (
       alert_event_id, alert_key, event_type, severity, snapshot_id,
       evidence_hash, actor_wallet, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [alertEventId, alertKey, eventType, severity, snapshotId, evidenceHash, actorWallet, now],
  );
  return { alertEventId, evidenceHash };
}

async function persistSystemAlertAudit(executor: SqlExecutor, input: {
  alertEventId: string;
  alertKey: string;
  eventType: 'MonitoringAlertOpened' | 'MonitoringAlertRecovered';
  evidenceHash: string;
  severity: 'WARNING' | 'CRITICAL';
  snapshotId: string;
  observedAt: Date;
}) {
  const sourceEventId = auditSourceId('audit:monitoring-alert', { alertEventId: input.alertEventId });
  await enqueueAudit(executor, {
    sourceEventId,
    streamName: 'operational',
    evidenceProfile: 'SYSTEM',
    eventType: input.eventType,
    resourceType: 'MONITORING_ALERT',
    resourceId: input.alertKey,
    actorRole: 'MONITORING_WORKER',
    correlationId: sourceEventId,
    requestHash: input.evidenceHash.slice(2),
    payload: {
      alertEventId: input.alertEventId,
      alertKey: input.alertKey,
      snapshotId: input.snapshotId,
      severity: input.severity,
      evidenceHash: input.evidenceHash,
    },
    createdAt: input.observedAt,
  });
}

async function persistProbeFailure(
  executor: SqlExecutor,
  failure: { sourceName: string; errorCode: string },
  observedAt: Date,
) {
  const evidenceHash = hashJson({ ...failure, observedAt: observedAt.toISOString() });
  const sourceEventId = auditSourceId('audit:monitoring-probe', {
    ...failure,
    observedAt: observedAt.toISOString(),
    evidenceHash,
  });
  await enqueueAudit(executor, {
    sourceEventId,
    streamName: 'operational',
    evidenceProfile: 'SYSTEM',
    eventType: 'MonitoringProbeUnavailable',
    resourceType: 'MONITORING_SOURCE',
    resourceId: failure.sourceName,
    actorRole: 'MONITORING_WORKER',
    correlationId: sourceEventId,
    requestHash: evidenceHash.slice(2),
    payload: { ...failure, evidenceHash },
    createdAt: observedAt,
  });
}

function validateObservations(items: readonly MetricObservation[]) {
  const identities = new Set<string>();
  for (const item of items) {
    const identity = `${item.component}:${item.metricName}`;
    if (identities.has(identity)) throw new CoreError('InvalidRequest', 'Monitoring source emitted a duplicate metric');
    identities.add(identity);
    if (
      !/^[a-z][a-z0-9_]{1,95}$/.test(item.metricName)
      || item.windowEndedAt < item.windowStartedAt
      || ((item.status === 'UNAVAILABLE' || item.status === 'CONFIGURATION_REQUIRED') !== (item.value === null))
      || (item.value !== null && !Number.isFinite(item.value))
    ) throw new CoreError('InvalidRequest', 'Monitoring source emitted an invalid metric');
  }
}

function observation(
  component: MetricObservation['component'],
  metricName: string,
  unit: MetricObservation['unit'],
  value: number,
  status: MetricObservation['status'],
  windowStartedAt: Date,
  windowEndedAt: Date,
  evidence: Record<string, unknown>,
): MetricObservation {
  return { component, metricName, unit, value, status, windowStartedAt, windowEndedAt, evidence };
}

function unavailable(
  component: MetricObservation['component'],
  metricName: string,
  unit: MetricObservation['unit'],
  windowStartedAt: Date,
  windowEndedAt: Date,
  reason: string,
): MetricObservation {
  return { component, metricName, unit, value: null, status: 'UNAVAILABLE', windowStartedAt, windowEndedAt, evidence: { reason } };
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function errorCode(error: unknown) {
  return error instanceof CoreError ? error.code : 'MonitoringWorkerUnavailable';
}

const monitoringHash = hashJson;

export { insertAlert, monitoringHash };

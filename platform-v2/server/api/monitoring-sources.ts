import { statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { CoreError } from './errors.ts';
import type { MetricObservation, MonitoringSource } from '../chain/monitoring-worker.ts';
import type { SqlExecutor } from '../data/migrations.ts';

export class NodeHostMonitoringSource implements MonitoringSource {
  readonly name = 'host';
  readonly #mountPath: string;
  #previousCpu: { idle: number; total: number } | undefined;

  constructor(mountPath = '/') {
    this.#mountPath = mountPath;
  }

  async collect(now: Date) {
    const currentCpu = cpuCounters();
    const cpuPercent = this.#previousCpu
      ? percent(1 - (currentCpu.idle - this.#previousCpu.idle) / (currentCpu.total - this.#previousCpu.total))
      : undefined;
    this.#previousCpu = currentCpu;
    const memoryPercent = percent(1 - freemem() / totalmem());
    try {
      const disk = await statfs(this.#mountPath);
      const total = Number(disk.blocks) * Number(disk.bsize);
      const available = Number(disk.bavail) * Number(disk.bsize);
      return [
        percentageMetric('HOST', 'cpu_usage', cpuPercent, now, { source: 'os.cpus' }),
        percentageMetric('HOST', 'memory_usage', memoryPercent, now, { totalBytes: totalmem() }),
        percentageMetric('HOST', 'disk_usage', total > 0 ? percent(1 - available / total) : undefined, now, { mountPath: this.#mountPath, totalBytes: total }),
      ];
    } catch {
      return [
        percentageMetric('HOST', 'cpu_usage', cpuPercent, now, { source: 'os.cpus' }),
        percentageMetric('HOST', 'memory_usage', memoryPercent, now, { totalBytes: totalmem() }),
        unavailableMetric('HOST', 'disk_usage', 'PERCENT', now, 'DiskProbeUnavailable'),
      ];
    }
  }
}

export interface RedisStatsReader {
  info(section?: string): Promise<string>;
}

export class MiddlewareMonitoringSource implements MonitoringSource {
  readonly name = 'middleware';
  readonly #database: SqlExecutor;
  readonly #redis: RedisStatsReader | undefined;
  readonly #dbPool: (() => { active: number; maximum: number }) | undefined;
  readonly #mqBacklog: (() => Promise<number>) | undefined;

  constructor(input: {
    database: SqlExecutor;
    redis?: RedisStatsReader;
    dbPool?: () => { active: number; maximum: number };
    mqBacklog?: () => Promise<number>;
  }) {
    this.#database = input.database;
    this.#redis = input.redis;
    this.#dbPool = input.dbPool;
    this.#mqBacklog = input.mqBacklog;
  }

  async collect(now: Date) {
    const metrics: MetricObservation[] = [];
    if (!this.#redis) {
      metrics.push(configurationMetric('REDIS', 'hit_rate', 'PERCENT', now, 'RedisProbeConfigurationRequired'));
    } else {
      try {
        const values = parseRedisInfo(await this.#redis.info('stats'));
        const hits = integer(values.keyspace_hits);
        const misses = integer(values.keyspace_misses);
        const total = hits + misses;
        metrics.push(total === 0
          ? unavailableMetric('REDIS', 'hit_rate', 'PERCENT', now, 'NoRedisRequestsInWindow')
          : percentageMetric('REDIS', 'hit_rate', (hits / total) * 100, now, { hits, misses }));
      } catch {
        metrics.push(unavailableMetric('REDIS', 'hit_rate', 'PERCENT', now, 'RedisProbeUnavailable'));
      }
    }
    if (!this.#dbPool) {
      metrics.push(configurationMetric('DATABASE', 'pool_active', 'COUNT', now, 'DatabasePoolProbeConfigurationRequired'));
    } else {
      const pool = this.#dbPool();
      if (!Number.isSafeInteger(pool.active) || !Number.isSafeInteger(pool.maximum) || pool.active < 0 || pool.maximum < 1 || pool.active > pool.maximum) {
        metrics.push(unavailableMetric('DATABASE', 'pool_active', 'COUNT', now, 'InvalidDatabasePoolSample'));
      } else {
        metrics.push(metric('DATABASE', 'pool_active', 'COUNT', pool.active, statusForRatio(pool.active / pool.maximum), now, pool));
      }
    }
    const backlog = await this.#database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM core.outbox_events
       WHERE state IN ('PENDING', 'PROCESSING')`,
    );
    const outboxCount = Number(backlog.rows[0]?.count ?? NaN);
    metrics.push(Number.isSafeInteger(outboxCount)
      ? metric('DATABASE', 'outbox_backlog', 'COUNT', outboxCount, countStatus(outboxCount, 1_000, 10_000), now, {})
      : unavailableMetric('DATABASE', 'outbox_backlog', 'COUNT', now, 'OutboxBacklogUnavailable'));
    if (!this.#mqBacklog) {
      metrics.push(configurationMetric('MQ', 'backlog', 'COUNT', now, 'MqProbeConfigurationRequired'));
    } else {
      try {
        const value = await this.#mqBacklog();
        metrics.push(Number.isSafeInteger(value) && value >= 0
          ? metric('MQ', 'backlog', 'COUNT', value, countStatus(value, 1_000, 10_000), now, {})
          : unavailableMetric('MQ', 'backlog', 'COUNT', now, 'InvalidMqBacklog'));
      } catch {
        metrics.push(unavailableMetric('MQ', 'backlog', 'COUNT', now, 'MqProbeUnavailable'));
      }
    }
    return metrics;
  }
}

export class RpcExplorerHeightSource implements MonitoringSource {
  readonly name = 'chain-height';
  readonly #primaryRpcUrl: string | undefined;
  readonly #fallbackRpcUrl: string | undefined;
  readonly #explorerApiUrl: string | undefined;
  readonly #explorerApiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    explorerApiUrl?: string;
    explorerApiKey?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#primaryRpcUrl = input.primaryRpcUrl;
    this.#fallbackRpcUrl = input.fallbackRpcUrl;
    this.#explorerApiUrl = input.explorerApiUrl;
    this.#explorerApiKey = input.explorerApiKey;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async collect(now: Date) {
    if (!this.#primaryRpcUrl || !this.#fallbackRpcUrl || !this.#explorerApiUrl || !this.#explorerApiKey) {
      return [
        configurationMetric('RPC_PRIMARY', 'height_lag', 'BLOCK', now, 'ChainHeightConfigurationRequired'),
        configurationMetric('RPC_FALLBACK', 'height_lag', 'BLOCK', now, 'ChainHeightConfigurationRequired'),
      ];
    }
    try {
      const [primary, fallback, explorer] = await Promise.all([
        rpcHeight(this.#fetch, this.#primaryRpcUrl),
        rpcHeight(this.#fetch, this.#fallbackRpcUrl),
        explorerHeight(this.#fetch, this.#explorerApiUrl, this.#explorerApiKey),
      ]);
      return [
        blockLagMetric('RPC_PRIMARY', primary, explorer, now),
        blockLagMetric('RPC_FALLBACK', fallback, explorer, now),
        metric('EXPLORER', 'block_height', 'BLOCK', explorer, 'HEALTHY', now, { explorer }),
      ];
    } catch {
      return [
        unavailableMetric('RPC_PRIMARY', 'height_lag', 'BLOCK', now, 'ChainHeightProbeUnavailable'),
        unavailableMetric('RPC_FALLBACK', 'height_lag', 'BLOCK', now, 'ChainHeightProbeUnavailable'),
        unavailableMetric('EXPLORER', 'block_height', 'BLOCK', now, 'ChainHeightProbeUnavailable'),
      ];
    }
  }
}

function blockLagMetric(component: 'RPC_PRIMARY' | 'RPC_FALLBACK', rpc: number, explorer: number, now: Date) {
  const lag = Math.abs(rpc - explorer);
  return metric(component, 'height_lag', 'BLOCK', lag, lag > 3 ? 'CRITICAL' : 'HEALTHY', now, { rpc, explorer });
}

async function rpcHeight(fetchImpl: typeof fetch, url: string) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  if (!response.ok) throw new Error('RpcHeightUnavailable');
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error('InvalidRpcHeight');
  const value = Number(BigInt(body.result));
  if (!Number.isSafeInteger(value)) throw new Error('InvalidRpcHeight');
  return value;
}

async function explorerHeight(fetchImpl: typeof fetch, rawUrl: string, apiKey: string) {
  const url = new URL(rawUrl);
  url.searchParams.set('module', 'proxy');
  url.searchParams.set('action', 'eth_blockNumber');
  url.searchParams.set('apikey', apiKey);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error('ExplorerHeightUnavailable');
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error('InvalidExplorerHeight');
  const value = Number(BigInt(body.result));
  if (!Number.isSafeInteger(value)) throw new Error('InvalidExplorerHeight');
  return value;
}

function cpuCounters() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function parseRedisInfo(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':');
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

function integer(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('InvalidCounter');
  return parsed;
}

function percent(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value * (value <= 1 ? 100 : 1))) : undefined;
}

function percentageMetric(component: MetricObservation['component'], name: string, value: number | undefined, now: Date, evidence: Record<string, unknown>) {
  return value === undefined
    ? unavailableMetric(component, name, 'PERCENT', now, 'MetricSampleUnavailable')
    : metric(component, name, 'PERCENT', value, value >= 90 ? 'CRITICAL' : value >= 80 ? 'WARNING' : 'HEALTHY', now, evidence);
}

function countStatus(value: number, warning: number, critical: number) {
  return value >= critical ? 'CRITICAL' as const : value >= warning ? 'WARNING' as const : 'HEALTHY' as const;
}

function statusForRatio(value: number) {
  return value >= 0.9 ? 'CRITICAL' as const : value >= 0.8 ? 'WARNING' as const : 'HEALTHY' as const;
}

function metric(
  component: MetricObservation['component'],
  metricName: string,
  unit: MetricObservation['unit'],
  value: number,
  status: MetricObservation['status'],
  now: Date,
  evidence: Record<string, unknown>,
): MetricObservation {
  return { component, metricName, unit, value, status, windowStartedAt: now, windowEndedAt: now, evidence };
}

function unavailableMetric(component: MetricObservation['component'], metricName: string, unit: MetricObservation['unit'], now: Date, reason: string): MetricObservation {
  return { component, metricName, unit, value: null, status: 'UNAVAILABLE', windowStartedAt: now, windowEndedAt: now, evidence: { reason } };
}

function configurationMetric(component: MetricObservation['component'], metricName: string, unit: MetricObservation['unit'], now: Date, reason: string): MetricObservation {
  return { component, metricName, unit, value: null, status: 'CONFIGURATION_REQUIRED', windowStartedAt: now, windowEndedAt: now, evidence: { reason } };
}

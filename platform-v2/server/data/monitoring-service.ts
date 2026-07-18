import { normalizeAddress } from '../api/auth.ts';
import { CoreError } from '../api/errors.ts';
import { insertAlert, monitoringHash } from '../chain/monitoring-worker.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

export class MonitoringService {
  readonly #transactions: SqlTransactionRunner;
  readonly #clock: () => Date;

  constructor(input: { transactions: SqlTransactionRunner; clock?: () => Date }) {
    this.#transactions = input.transactions;
    this.#clock = input.clock ?? (() => new Date());
  }

  dashboard(actor: FulfillmentActor) {
    requireRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, normalizeAddress(actor.walletAddress), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const metrics = await executor.query<{
        snapshot_id: string;
        component: string;
        metric_name: string;
        unit: string;
        metric_value: string | number | null;
        status: string;
        window_started_at: Date | string;
        window_ended_at: Date | string;
        evidence: Record<string, unknown>;
        observed_at: Date | string;
      }>(
        `SELECT DISTINCT ON (component, metric_name) *
         FROM core.operations_metric_snapshots
         ORDER BY component, metric_name, observed_at DESC, snapshot_id DESC`,
      );
      const alerts = await executor.query<{
        alert_event_id: string;
        alert_key: string;
        event_type: string;
        severity: string;
        snapshot_id: string;
        actor_wallet: string | null;
        created_at: Date | string;
      }>('SELECT * FROM core.current_operations_alerts ORDER BY alert_key');
      const coverage = await executor.query<Record<string, unknown>>(
        `SELECT item.asset, item.wallet_address,
           item.verified_asset_balance::text AS assets,
           item.unsettled_liability::text AS unsettled_liabilities,
           item.coverage_met AS covered, snapshot.recorded_at AS observed_at
         FROM core.coverage_snapshot_items item
         JOIN core.coverage_snapshots snapshot USING (snapshot_id)
         WHERE item.snapshot_id = (
           SELECT snapshot_id FROM core.coverage_snapshots
           WHERE canonical ORDER BY recorded_at DESC, snapshot_id DESC LIMIT 1
         ) ORDER BY item.asset, item.wallet_address`,
      );
      return Object.freeze({
        metrics: metrics.rows.map((row) => Object.freeze({
          snapshotId: row.snapshot_id,
          component: row.component,
          metricName: row.metric_name,
          unit: row.unit,
          value: row.metric_value === null ? null : Number(row.metric_value),
          status: row.status,
          windowStartedAt: new Date(row.window_started_at).toISOString(),
          windowEndedAt: new Date(row.window_ended_at).toISOString(),
          evidence: row.evidence,
          observedAt: new Date(row.observed_at).toISOString(),
        })),
        alerts: alerts.rows.map((row) => Object.freeze({
          alertEventId: row.alert_event_id,
          alertKey: row.alert_key,
          state: row.event_type,
          severity: row.severity,
          snapshotId: row.snapshot_id,
          actorWallet: row.actor_wallet,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        coverage: coverage.rows,
      });
    });
  }

  acknowledge(actor: FulfillmentActor, alertKey: string, correlationId: string) {
    requireRole(actor, 'ADMIN', 'OPERATOR');
    const wallet = normalizeAddress(actor.walletAddress);
    if (!/^[A-Z_]+:[a-z][a-z0-9_]{1,95}$/.test(alertKey)) throw new CoreError('InvalidRequest', 'Monitoring alert key is invalid');
    if (!correlationId || correlationId.length > 128) throw new CoreError('InvalidRequest', 'Monitoring correlation id is invalid');
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const current = await executor.query<{
        event_type: string;
        severity: 'WARNING' | 'CRITICAL';
        snapshot_id: string;
      }>(
        `SELECT event_type, severity, snapshot_id FROM core.operations_alert_events
         WHERE alert_key = $1 ORDER BY alert_sequence DESC LIMIT 1 FOR UPDATE`,
        [alertKey],
      );
      if (!current.rows[0] || current.rows[0].event_type === 'RECOVERED') throw new CoreError('InvalidRequest', 'Monitoring alert is not open', 409);
      if (current.rows[0].event_type === 'ACKNOWLEDGED') return { alertKey, state: 'ACKNOWLEDGED' as const };
      const inserted = await insertAlert(
        executor,
        alertKey,
        'ACKNOWLEDGED',
        current.rows[0].severity,
        current.rows[0].snapshot_id,
        wallet,
        { acknowledgedBy: wallet },
        this.#clock(),
      );
      const checkedAt = this.#clock();
      const authorizationEvidenceHash = monitoringHash({
        wallet,
        roles,
        alertKey,
        checkedAt: checkedAt.toISOString(),
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:monitoring-alert', { alertEventId: inserted.alertEventId }),
        streamName: 'operational',
        evidenceProfile: 'RBAC',
        eventType: 'MonitoringAlertAcknowledged',
        resourceType: 'MONITORING_ALERT',
        resourceId: alertKey,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId,
        requestHash: inserted.evidenceHash.slice(2),
        payload: {
          alertEventId: inserted.alertEventId,
          alertKey,
          snapshotId: current.rows[0].snapshot_id,
          severity: current.rows[0].severity,
          state: 'ACKNOWLEDGED',
          evidenceHash: inserted.evidenceHash,
        },
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles,
          evidenceHash: authorizationEvidenceHash,
          checkedAt: checkedAt.toISOString(),
        },
        createdAt: checkedAt,
      });
      return { alertKey, state: 'ACKNOWLEDGED' as const };
    });
  }
}

async function requireCurrentRole(executor: SqlExecutor, wallet: string, allowed: readonly string[]) {
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[]) ORDER BY role`,
    [wallet, [...allowed]],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Current wallet role cannot read or acknowledge monitoring', 403);
  return result.rows.map((row) => row.role);
}

function requireRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) throw new CoreError('Forbidden', 'Wallet session cannot read or acknowledge monitoring', 403);
}

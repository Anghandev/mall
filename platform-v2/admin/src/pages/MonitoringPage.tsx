import type { MonitoringDashboard } from '@abu24k/core-artifacts';
import { Activity, AlertTriangle, Ban, CheckCircle2, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
import { formatNpl, formatUsdt, humanizeError } from '../display';
import { useCoreSession } from '../coreSession';
import { acknowledgeMonitoringAlert, fetchMonitoringDashboard } from '../settlementAdminApi';

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const byteFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

export function MonitoringPage() {
  const { connect, session, status } = useCoreSession();
  const [dashboard, setDashboard] = useState<MonitoringDashboard | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canAcknowledge = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;

  useEffect(() => {
    setDashboard(null);
    setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchMonitoringDashboard(session.token, controller.signal)
      .then(setDashboard)
      .catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const acknowledge = async (alertKey: string) => {
    if (!session || !canAcknowledge) return;
    setLoading(true);
    setError(null);
    setNotice('');
    try {
      const result = await acknowledgeMonitoringAlert(alertKey, session.token);
      setNotice(`告警“${alertKeyLabel(result.alertKey)}”已确认`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(asCoreError(cause));
      setLoading(false);
    }
  };

  return <>
    <header className="page-header">
      <div className="page-icon"><Activity aria-hidden="true" /></div>
      <div><p className="eyebrow">运行监控</p><h1>运维监控</h1><p>看服务器、接口、消息队列和链上节点是否正常；资金覆盖用两位金额展示，技术编号放到核验信息里。</p></div>
      <div className="requirement-list"><code>监控</code><code>告警</code><code>资金覆盖</code></div>
    </header>
    <section className="panel admin-resource-panel">
      <div className="panel-heading"><div><p className="section-kicker">运行状态</p><h2>系统水位与资金覆盖</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
      {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>未连接时不显示假数据；缺失指标会明确写“未返回数据”。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />连接钱包</button></div> : !canRead ? <ErrorView error={invalid('当前会话没有监控读取权限')} /> : null}
      {error ? <ErrorView error={error} /> : null}
      {dashboard ? <>
        <section className="coverage-grid" aria-label="逐资产普通钱包覆盖率">
          {dashboard.coverage.map((item) => <article key={`${item.asset}:${item.wallet_address}`} className={item.covered ? 'coverage-card is-covered' : 'coverage-card is-breached'}>
            <span>{item.asset} 资金覆盖</span>
            <strong>{item.covered ? '资金覆盖充足' : '低于 100%，需处理'}</strong>
            <dl><div><dt>钱包现有资产</dt><dd>{formatCoverageAmount(item.assets, item.asset)}</dd></div><div><dt>还没结清的负债</dt><dd>{formatCoverageAmount(item.unsettled_liabilities, item.asset)}</dd></div></dl>
            <details className="technical-details compact"><summary>钱包核验信息</summary><code title={item.wallet_address}>{shortAddress(item.wallet_address)}</code><small>{item.observed_at}</small></details>
          </article>)}
        </section>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>模块</th><th>监控项</th><th>当前值</th><th>状态</th><th>时间窗口</th></tr></thead><tbody>{dashboard.metrics.map((metric) => <tr key={metric.snapshotId}>
          <td><strong>{componentLabel(metric.component)}</strong><small>{metric.observedAt}</small></td>
          <td>{metricLabel(metric.metricName)}<details className="technical-details compact"><summary>指标核验名</summary><code>{metric.component}</code><code>{metric.metricName}</code></details></td>
          <td>{formatMetricValue(metric.value, metric.unit)}</td>
          <td><span className={metric.status === 'HEALTHY' ? 'status-chip status-ready' : 'status-chip status-blocked'}>{metric.status === 'HEALTHY' ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{statusLabel(metric.status)}</span></td>
          <td>{metric.windowStartedAt}<small>{metric.windowEndedAt}</small></td>
        </tr>)}</tbody></table></div>
        <div className="alert-list"><h3>告警事件</h3>{dashboard.alerts.length ? dashboard.alerts.map((alert) => <article key={alert.alertEventId}>
          <AlertTriangle aria-hidden="true" />
          <div><strong>{alertKeyLabel(alert.alertKey)}</strong><p>{severityLabel(alert.severity)} · {alertStateLabel(alert.state)} · {alert.createdAt}</p><details className="technical-details compact"><summary>告警核验编号</summary><code>{alert.alertKey}</code><small>{shortId(alert.alertEventId)}</small></details></div>
          {alert.state === 'OPENED' ? <button className="button button-quiet" type="button" onClick={() => void acknowledge(alert.alertKey)} disabled={!canAcknowledge || loading}>确认告警</button> : <span className="status-chip status-ready"><ShieldCheck aria-hidden="true" />{alertStateLabel(alert.state)}</span>}
        </article>) : <p className="muted-copy">当前没有告警事件。</p>}</div>
      </> : null}
      {notice ? <p className="healthy-copy" role="status">{notice}</p> : null}
    </section>
  </>;
}

function formatCoverageAmount(amount: string, asset: string) {
  return asset === 'USDT' ? formatUsdt(amount) : asset === 'NPL' ? formatNpl(amount) : `${amount} ${asset}`;
}

function formatMetricValue(value: number | null, unit: string) {
  if (value === null) return '未返回数据';
  if (unit === 'BYTES') return formatBytes(value);
  if (unit === 'PERCENT') return `${numberFormatter.format(value)}%`;
  if (unit === 'MILLISECONDS') return `${numberFormatter.format(value)} 毫秒`;
  if (unit === 'BLOCK') return `${numberFormatter.format(value)} 个区块`;
  if (unit === 'PER_SECOND') return `${numberFormatter.format(value)} 次/秒`;
  return `${numberFormatter.format(value)}${unitLabel(unit) ? ` ${unitLabel(unit)}` : ''}`;
}

function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
  return `${byteFormatter.format(current)} ${units[index]}`;
}

function unitLabel(value: string) {
  return ({ COUNT: '次' } as Record<string, string>)[value] ?? '';
}
function componentLabel(value: string) {
  return ({
    HOST: '服务器',
    REDIS: '缓存服务',
    MQ: '任务队列',
    DATABASE: '数据库',
    HTTP: '接口服务',
    PAYMENT: '支付服务',
    FULFILLMENT: '履约服务',
    RPC_PRIMARY: '主网主节点',
    RPC_FALLBACK: '主网备用节点',
    EXPLORER: '区块浏览器',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function metricLabel(value: string) {
  return ({
    heightLag: '区块高度延迟',
    latency: '响应耗时',
    errorRate: '错误率',
    queueDepth: '排队任务数',
    memoryUsed: '内存占用',
    diskUsed: '磁盘占用',
    requestRate: '请求速度',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function alertKeyLabel(value: string) {
  return ({
    'rpc-height': '链上节点高度异常',
    'rpc-lag': '链上节点同步延迟',
    'queue-depth': '任务队列积压',
    'http-error-rate': '接口错误率偏高',
    'coverage-breach': '资金覆盖不足',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function humanizeKey(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || value;
}
function statusLabel(value: string) { return ({ HEALTHY: '正常', WARNING: '预警', DEGRADED: '轻微异常', CRITICAL: '严重', BREACHED: '已告警', UNAVAILABLE: '未返回数据', CONFIGURATION_REQUIRED: '需要配置' } as Record<string, string>)[value] ?? humanizeKey(value); }
function severityLabel(value: string) { return ({ INFO: '提示', WARNING: '预警', CRITICAL: '严重', BLOCKER: '严重限制' } as Record<string, string>)[value] ?? value; }
function alertStateLabel(value: string) { return ({ OPENED: '待处理', ACKNOWLEDGED: '已确认', RESOLVED: '已恢复' } as Record<string, string>)[value] ?? value; }
function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function shortAddress(value: string) { return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value; }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '监控服务暂时无法连接', status: 503 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }

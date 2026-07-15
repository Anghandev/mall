import type { AdminBusinessDashboard } from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  Database,
  KeyRound,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShoppingBag,
  Store,
  WalletCards,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { fetchAdminBusinessDashboard } from '../settlementAdminApi';

type Metric = Readonly<{ label: string; value: string; detail: string; blocked?: boolean }>;
type MetricGroup = Readonly<{ title: string; icon: LucideIcon; metrics: readonly Metric[] }>;

export function DashboardPage() {
  const { connect, session, status } = useCoreSession();
  const [dashboard, setDashboard] = useState<AdminBusinessDashboard | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;

  useEffect(() => {
    setDashboard(null);
    setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchAdminBusinessDashboard(session.token, controller.signal)
      .then(setDashboard)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(asCoreError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const hasBlockedEvidence = dashboard
    ? dashboard.unavailable.length > 0
      || dashboard.breakers.some((item) => item.paused)
      || dashboard.coverage.some((item) => !item.covered)
    : true;

  return (
    <>
      <header className="page-header dashboard-header">
        <div className="page-icon"><Database aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">AUTHORITATIVE BUSINESS WINDOW</p>
          <h1>今日运营态势</h1>
          <p>订单金额只显示 Core 的不可变支付快照；当前履约队列与今日终局窗口分开呈现。</p>
        </div>
        <div className="requirement-list"><code>ADM-DASH-001—004</code><code>GET /v2/admin/dashboard</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt dashboard-session-prompt" role="status" aria-label="Dashboard 数据状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>仅 ADMIN、OPERATOR 或 AUDITOR 可读取业务聚合；未认证时数据不可用，不显示合成数据。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}
          </button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有平台 Dashboard 读取权限', status: 403 })} />
      ) : null}

      {loading ? <div className="resource-state" role="status"><RefreshCw className="spin" aria-hidden="true" /><div><strong>正在读取 Core 业务投影</strong><p>金额、终局和队列均等待真实响应。</p></div></div> : null}
      {error ? <ErrorView error={error} /> : null}

      {dashboard ? (
        <>
          <section className={hasBlockedEvidence ? 'dashboard-alert' : 'dashboard-alert dashboard-alert-ready'} role="status">
            <span>{hasBlockedEvidence ? <ShieldAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}</span>
            <div>
              <strong>{hasBlockedEvidence ? 'Core 投影已载入，存在显式阻断证据' : 'Core 投影已载入'}</strong>
              <p>这里不使用运维告警充当交易风险，也不会把缺失投影当成 0 或健康状态。</p>
            </div>
          </section>

          <section className="readiness-strip dashboard-window" aria-label="Asia Shanghai 业务窗口">
            <div><span>Artifact</span><strong>{dashboard.artifactVersion}</strong></div>
            <div><span>Timezone</span><strong>{dashboard.timezone}</strong></div>
            <div><span>Window start</span><strong>{dashboard.window.start}</strong></div>
            <div><span>Window end</span><strong>{dashboard.window.end}</strong></div>
            <div><span>Generated</span><strong>{dashboard.window.generatedAt}</strong></div>
            <button className="icon-button light-icon-button" type="button" aria-label="重新读取业务 Dashboard" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" /></button>
          </section>

          <section className="metric-board" aria-label="Core Dashboard 指标组">
            {dashboardMetricGroups(dashboard).map(({ title, icon: Icon, metrics }) => (
              <article className="metric-group" key={title}>
                <div className="metric-group-heading"><Icon aria-hidden="true" /><h2>{title}</h2><span className={metrics.some((metric) => metric.blocked) ? 'is-blocked' : undefined}>{metrics.some((metric) => metric.blocked) ? 'FAIL CLOSED' : 'CORE'}</span></div>
                <dl>
                  {metrics.map((metric) => (
                    <div key={metric.label}>
                      <dt>{metric.label}</dt>
                      <dd className={metric.blocked ? 'metric-blocked' : undefined}>{metric.value}<small>{metric.detail}</small></dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </section>

          <section className="dashboard-evidence-grid">
            <article className="panel dashboard-evidence-panel">
              <div className="panel-heading"><div><p className="section-kicker">SAFE COVERAGE</p><h2>逐资产覆盖证据</h2></div><WalletCards aria-hidden="true" /></div>
              {dashboard.coverage.length > 0 ? (
                <div className="coverage-grid" aria-label="Safe assets / unsettled liabilities coverage">
                  {dashboard.coverage.map((item) => (
                    <article className={item.covered ? 'coverage-card is-covered' : 'coverage-card is-breached'} key={`${item.snapshotId}:${item.asset}:${item.safeAddress}`}>
                      <span>{item.asset} · Safe assets / unsettled liabilities coverage</span>
                      <strong>{item.covered ? 'COVERED' : 'BELOW 100%'}</strong>
                      <dl><div><dt>Verified assets</dt><dd>{item.verifiedAssets}</dd></div><div><dt>Unsettled liabilities</dt><dd>{item.unsettledLiabilities}</dd></div></dl>
                      <code>{item.safeAddress}</code><small>Block {item.blockNumber} · {item.recordedAt}</small>
                    </article>
                  ))}
                </div>
              ) : <UnavailableEmpty label="Coverage 投影不可用" />}
            </article>

            <article className="panel dashboard-evidence-panel">
              <div className="panel-heading"><div><p className="section-kicker">CIRCUIT BREAKERS</p><h2>独立断路器</h2></div><Zap aria-hidden="true" /></div>
              <div className="breaker-list">
                {dashboard.breakers.map((item) => (
                  <div key={item.scope} className={item.paused ? 'breaker-row is-paused' : 'breaker-row'}>
                    {item.paused ? <Ban aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                    <span><strong>{item.scope}</strong><small>paused = {String(item.paused)}</small></span>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="panel dashboard-blockers">
            <div className="panel-heading"><div><p className="section-kicker">FAIL-CLOSED EVIDENCE</p><h2>DecisionBlocked / ExternalBlocked</h2></div><AlertTriangle aria-hidden="true" /></div>
            {dashboard.unavailable.length > 0 ? (
              <div className="dashboard-blocker-list">
                {dashboard.unavailable.map((item) => (
                  <article key={`${item.metric}:${item.reasonCode}`}>
                    <AlertTriangle aria-hidden="true" />
                    <div><strong>{item.metric}</strong><p>{item.detail}</p></div>
                    <span className="status-chip status-blocked">{item.reasonCode}</span>
                  </article>
                ))}
              </div>
            ) : <p className="healthy-copy"><CheckCircle2 aria-hidden="true" />Core 未返回 unavailable 项。</p>}
          </section>
        </>
      ) : null}
    </>
  );
}

function dashboardMetricGroups(dashboard: AdminBusinessDashboard): readonly MetricGroup[] {
  const blocked = (metric: string): Metric => {
    const item = dashboard.unavailable.find((candidate) => candidate.metric === metric);
    return item
      ? { label: metricLabel(metric), value: item.reasonCode, detail: item.detail, blocked: true }
      : { label: metricLabel(metric), value: '不可用', detail: 'Core 未发布该指标，不解读为 0', blocked: true };
  };
  const shipmentRate = dashboard.orders.shipmentRate;
  return [
    {
      title: '今日终局与当前履约', icon: ShoppingBag, metrics: [
        metric('今日终局订单', dashboard.orders.finalizedToday, '15-confirmation ORDER_PAYMENT'),
        metric('GMV · USDT atomic', dashboard.orders.listPriceUsdt, 'immutable orders.exact_amounts'),
        metric('买家已付 · USDT atomic', dashboard.orders.buyerUsdtPaid, 'immutable orders.exact_amounts'),
        metric('今日发货率', shipmentRate.bps === null ? '不可计算' : `${shipmentRate.bps} bps`, `${shipmentRate.numerator} / ${shipmentRate.denominator}; bps=${shipmentRate.bps ?? 'null'}`, shipmentRate.bps === null),
        metric('待发货', dashboard.orders.pendingShipment, '当前队列'),
        metric('已发货', dashboard.orders.shipped, '当前状态'),
        metric('已送达', dashboard.orders.delivered, '当前状态'),
        metric('已履约', dashboard.orders.fulfilled, '当前状态'),
        blocked('NEW_UID_USERS'),
      ],
    },
    {
      title: '商家与商品', icon: Store, metrics: [
        metric('商家总数', dashboard.merchants.total, 'Core merchant projection'),
        metric('今日新商家', dashboard.merchants.newToday, dashboard.timezone),
        metric('待审核商家', dashboard.merchants.pending, '当前状态'),
        metric('已通过商家', dashboard.merchants.approved, '当前状态'),
        metric('暂停商家', dashboard.merchants.suspended, '当前状态'),
        metric('商品总数', dashboard.products.total, 'Core catalog projection'),
        metric('待审核商品', dashboard.products.pendingReview, '当前状态'),
        metric('售罄商品', dashboard.products.soldOut, '当前状态'),
        blocked('LOW_STOCK_PRODUCTS'),
      ],
    },
    {
      title: '秒杀与履约队列', icon: PackageCheck, metrics: [
        metric('今日创建秒杀', dashboard.seckill.createdToday, dashboard.timezone),
        metric('活动中秒杀', dashboard.seckill.active, '当前会场'),
        metric('结算中秒杀', dashboard.seckill.settling, '当前会场'),
        metric('Exchange', dashboard.fulfillmentQueues.exchange, '无业务退款'),
        metric('Delay', dashboard.fulfillmentQueues.delay, '无业务退款'),
        metric('Arbitration', dashboard.fulfillmentQueues.arbitration, '当前队列'),
        metric('Forced receipt', dashboard.fulfillmentQueues.forcedReceipt, '当前队列'),
        metric('Takeover', dashboard.fulfillmentQueues.takeover, '平台接管履约'),
      ],
    },
    {
      title: '签名结算与交易证据', icon: ShieldAlert, metrics: [
        metric('今日结算申请', dashboard.settlements.requestedCount, '签名请求'),
        metric('申请 · USDT atomic', dashboard.settlements.requestedUsdt, '今日窗口'),
        metric('今日已结算', dashboard.settlements.settledCount, 'Safe finality'),
        metric('已结算 · USDT atomic', dashboard.settlements.settledUsdt, 'Safe finality'),
        metric('链上失败交易', dashboard.settlements.failedTransactions, '今日结算窗口'),
        blocked('ABNORMAL_ORDERS'),
        blocked('BLACKLIST_BLOCKS'),
      ],
    },
  ];
}

function metric(label: string, value: string, detail: string, blocked = false): Metric {
  return { label, value, detail, blocked };
}

function metricLabel(metricName: string) {
  return ({
    NEW_UID_USERS: '新增 UID',
    LOW_STOCK_PRODUCTS: '库存预警',
    ABNORMAL_ORDERS: '异常订单',
    BLACKLIST_BLOCKS: '黑名单拦截',
  } as const)[metricName as 'NEW_UID_USERS'] ?? metricName;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div>;
}

function UnavailableEmpty({ label }: { label: string }) {
  return <div className="empty-inline"><Clock3 aria-hidden="true" /><div><strong>{label}</strong><p>空列表不解读为 0 或健康。</p></div></div>;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message: 'Dashboard Core 能力不可用', status: 503 });
}

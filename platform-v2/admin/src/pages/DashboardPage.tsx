import type { AdminBusinessDashboard, CoverageBreakerActionProjection } from '@abu24k/core-artifacts';
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
import { useEffect, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { commonStateLabel, formatBpsAsPercent, formatNpl, formatUsdt, humanizeError, shortAddress, shortId } from '../display';
import {
  authorizeCoverageBreakerResume,
  createCoverageBreakerResumeChallenge,
  fetchAdminBusinessDashboard,
  fetchCoverageBreakerActions,
} from '../settlementAdminApi';

type Metric = Readonly<{ label: string; value: string; detail: string; blocked?: boolean }>;
type MetricGroup = Readonly<{ title: string; icon: LucideIcon; metrics: readonly Metric[] }>;

export function DashboardPage() {
  const { connect, session, status } = useCoreSession();
  const [dashboard, setDashboard] = useState<AdminBusinessDashboard | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [coverageActions, setCoverageActions] = useState<readonly CoverageBreakerActionProjection[] | null>(null);
  const [coverageActionsError, setCoverageActionsError] = useState<CoreApiError | null>(null);
  const [coverageActionsLoading, setCoverageActionsLoading] = useState(false);
  const [resumeNonce, setResumeNonce] = useState(() => dashboardCommandNonce());
  const [resumeDeadline, setResumeDeadline] = useState(() => dashboardCommandDeadline());
  const [resumeError, setResumeError] = useState<CoreApiError | null>(null);
  const [resumePending, setResumePending] = useState(false);
  const [resumeNotice, setResumeNotice] = useState('');
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;

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

  useEffect(() => {
    setCoverageActions(null);
    setCoverageActionsError(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    setCoverageActionsLoading(true);
    void fetchCoverageBreakerActions(session.token, controller.signal)
      .then(setCoverageActions)
      .catch((cause) => {
        if (!controller.signal.aborted) setCoverageActionsError(asCoreError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCoverageActionsLoading(false);
      });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const newPaymentPaused = dashboard?.breakers.find((item) => item.scope === 'NEW_PAYMENT')?.paused === true;
  const coverageHealthy = Boolean(dashboard?.coverage.length) && dashboard!.coverage.every((item) => item.covered);
  const canRequestResume = isAdmin && newPaymentPaused && coverageHealthy;

  const submitCoverageResume = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canRequestResume) return;
    if (!window.ethereum) {
      setResumeError(new CoreApiError({ code: 'ExternalBlocked', message: '未检测到可用的二次签名钱包', status: 503 }));
      return;
    }
    setResumePending(true);
    setResumeError(null);
    setResumeNotice('');
    try {
      const challenge = await createCoverageBreakerResumeChallenge({ nonce: resumeNonce, deadline: resumeDeadline }, session.token);
      if (challenge.signer.toLowerCase() === session.walletAddress.toLowerCase()) {
        throw new CoreApiError({ code: 'InvalidResponse', message: '系统未提供独立的二次确认钱包', status: 502 });
      }
      let signature: unknown;
      try {
        signature = await window.ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [challenge.signer, JSON.stringify(challenge.typedData)],
        });
      } catch {
        throw new CoreApiError({ code: 'InvalidResponse', message: '二次钱包拒绝签名或签名请求失败', status: 400 });
      }
      if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        throw new CoreApiError({ code: 'InvalidResponse', message: '二次钱包返回了无效签名', status: 400 });
      }
      const action = await authorizeCoverageBreakerResume({
        snapshotId: challenge.snapshotId,
        nonce: resumeNonce,
        deadline: resumeDeadline,
        signature,
      }, challenge, session.walletAddress, session.token);
      setCoverageActions((current) => [action, ...(current ?? []).filter((item) => item.actionId !== action.actionId)]);
      setResumeNotice(action.state === 'FINAL'
        ? '恢复动作已最终确认，正在刷新断路器状态。'
        : `恢复动作已提交，当前状态：${commonStateLabel(action.state)}；最终确认前不视为已恢复。`);
      setResumeNonce(dashboardCommandNonce());
      setResumeDeadline(dashboardCommandDeadline());
      setReload((value) => value + 1);
    } catch (cause) {
      setResumeError(asCoverageResumeError(cause));
    } finally {
      setResumePending(false);
    }
  };

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
          <p className="eyebrow">今日数据</p>
          <h1>今日运营态势</h1>
          <p>订单金额只显示系统确认过的支付快照；当前履约队列与今日终局窗口分开呈现。</p>
        </div>
        <div className="requirement-list"><code>运营总览</code><code>实时安全状态</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt dashboard-session-prompt" role="status" aria-label="Dashboard 数据状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>只有平台授权钱包可以查看业务数据；未连接时不会显示假数据。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}
          </button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前钱包没有平台工作台读取权限', status: 403 })} />
      ) : null}

      {loading ? <div className="resource-state" role="status"><RefreshCw className="spin" aria-hidden="true" /><div><strong>正在读取业务数据</strong><p>金额、终局和队列均等待真实响应。</p></div></div> : null}
      {error ? <ErrorView error={error} /> : null}

      {dashboard ? (
        <>
          <section className={hasBlockedEvidence ? 'dashboard-alert' : 'dashboard-alert dashboard-alert-ready'} role="status">
            <span>{hasBlockedEvidence ? <ShieldAlert aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}</span>
            <div>
              <strong>{hasBlockedEvidence ? '业务数据已载入，存在明确阻断' : '业务数据已载入'}</strong>
              <p>这里不会把缺失数据当成 0，也不会把未确认状态显示成健康。</p>
            </div>
          </section>

          <section className="readiness-strip dashboard-window" aria-label="Asia Shanghai 业务窗口">
            <div><span>系统状态</span><strong>已连接</strong><details className="technical-details compact"><summary>高级版本信息</summary><code>{dashboard.artifactVersion}</code></details></div>
            <div><span>统计时区</span><strong>{dashboard.timezone}</strong></div>
            <div><span>开始时间</span><strong>{dashboard.window.start}</strong></div>
            <div><span>结束时间</span><strong>{dashboard.window.end}</strong></div>
            <div><span>生成时间</span><strong>{dashboard.window.generatedAt}</strong></div>
            <button className="icon-button light-icon-button" type="button" aria-label="重新读取业务工作台" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" /></button>
          </section>

          <section className="metric-board" aria-label="平台工作台指标组">
            {dashboardMetricGroups(dashboard).map(({ title, icon: Icon, metrics }) => (
              <article className="metric-group" key={title}>
                <div className="metric-group-heading"><Icon aria-hidden="true" /><h2>{title}</h2><span className={metrics.some((metric) => metric.blocked) ? 'is-blocked' : undefined}>{metrics.some((metric) => metric.blocked) ? '已安全关闭' : '系统确认'}</span></div>
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
              <div className="panel-heading"><div><p className="section-kicker">资金覆盖</p><h2>逐资产覆盖证据</h2></div><WalletCards aria-hidden="true" /></div>
              {dashboard.coverage.length > 0 ? (
                <div className="coverage-grid" aria-label="钱包资产与未结算负债覆盖">
                  {dashboard.coverage.map((item) => (
                    <article className={item.covered ? 'coverage-card is-covered' : 'coverage-card is-breached'} key={`${item.snapshotId}:${item.asset}:${item.walletAddress}`}>
                      <span>{item.asset} · 钱包资产 / 未结算负债</span>
                      <strong>{item.covered ? '覆盖充足' : '低于 100%'}</strong>
                      <dl><div><dt>已验证资产</dt><dd>{formatCoverageAmount(item.verifiedAssets, item.asset)}</dd></div><div><dt>未结算负债</dt><dd>{formatCoverageAmount(item.unsettledLiabilities, item.asset)}</dd></div></dl>
                      <code title={item.walletAddress}>{shortAddress(item.walletAddress)}</code>
                      <details className="technical-details compact"><summary>高级确认记录</summary><small>区块 {item.blockNumber} · {item.recordedAt}</small></details>
                    </article>
                  ))}
                </div>
              ) : <UnavailableEmpty label="覆盖检查暂不可用" />}
            </article>

            <article className="panel dashboard-evidence-panel">
              <div className="panel-heading"><div><p className="section-kicker">安全开关</p><h2>独立断路器</h2></div><Zap aria-hidden="true" /></div>
              <div className="breaker-list">
                {dashboard.breakers.map((item) => (
                  <div key={item.scope} className={item.paused ? 'breaker-row is-paused' : 'breaker-row'}>
                    {item.paused ? <Ban aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                    <span><strong>{breakerScopeLabel(item.scope)}</strong><small>{item.paused ? '已暂停新操作' : '正常开放'}</small></span>
                  </div>
                ))}
              </div>
              {isAdmin ? (
                <form className="coverage-recovery-form" onSubmit={(event) => void submitCoverageResume(event)}>
                  <div><strong>恢复新支付</strong><p>{coverageRecoveryReason(newPaymentPaused, coverageHealthy)}</p></div>
                  <details className="technical-details compact">
                    <summary>高级签名参数</summary>
                    <label>确认编号<input inputMode="numeric" pattern="0|[1-9][0-9]*" value={resumeNonce} onChange={(event) => setResumeNonce(event.target.value)} disabled={!canRequestResume || resumePending} required /></label>
                    <label>签名截止时间<input inputMode="numeric" pattern="0|[1-9][0-9]*" value={resumeDeadline} onChange={(event) => setResumeDeadline(event.target.value)} disabled={!canRequestResume || resumePending} required /></label>
                  </details>
                  <button className="button button-primary" type="submit" disabled={!canRequestResume || resumePending || !/^(0|[1-9][0-9]*)$/.test(resumeNonce) || !/^(0|[1-9][0-9]*)$/.test(resumeDeadline)}>
                    <KeyRound aria-hidden="true" />{resumePending ? '等待二次签名' : '请求二次签名并提交'}
                  </button>
                </form>
              ) : <p className="coverage-readonly-note">当前角色仅可读取断路器治理证据。</p>}
              {resumeError ? <ErrorView error={resumeError} /> : null}
              {resumeNotice ? <p className="healthy-copy" role="status">{resumeNotice}</p> : null}
            </article>
          </section>

          <section className="panel dashboard-blockers coverage-action-panel">
              <div className="panel-heading"><div><p className="section-kicker">恢复记录</p><h2>覆盖断路器动作</h2></div><button className="icon-button light-icon-button" type="button" aria-label="刷新断路器动作" onClick={() => setReload((value) => value + 1)} disabled={coverageActionsLoading}><RefreshCw aria-hidden="true" /></button></div>
            {coverageActionsLoading ? <div className="resource-state" role="status"><RefreshCw className="spin" aria-hidden="true" /><div><strong>正在读取恢复动作</strong><p>恢复状态以系统最终确认为准。</p></div></div> : null}
            {coverageActionsError ? <ErrorView error={coverageActionsError} /> : null}
            {coverageActions ? <CoverageBreakerActionTable actions={coverageActions} /> : null}
          </section>

          <section className="panel dashboard-blockers">
            <div className="panel-heading"><div><p className="section-kicker">安全阻断证据</p><h2>安全阻断证据</h2></div><AlertTriangle aria-hidden="true" /></div>
            {dashboard.unavailable.length > 0 ? (
              <div className="dashboard-blocker-list">
                {dashboard.unavailable.map((item) => (
                  <article key={`${item.metric}:${item.reasonCode}`}>
                    <AlertTriangle aria-hidden="true" />
                    <div><strong>{metricLabel(item.metric)}</strong><p>{item.detail}</p><details className="technical-details compact"><summary>高级阻断代码</summary><code>{item.metric}</code><code>{item.reasonCode}</code></details></div>
                    <span className="status-chip status-blocked">{reasonCodeLabel(item.reasonCode)}</span>
                  </article>
                ))}
              </div>
            ) : <p className="healthy-copy"><CheckCircle2 aria-hidden="true" />系统当前没有阻断项。</p>}
          </section>
        </>
      ) : null}
    </>
  );
}

function CoverageBreakerActionTable({ actions }: { actions: readonly CoverageBreakerActionProjection[] }) {
  if (!actions.length) return <UnavailableEmpty label="尚无断路器治理动作" />;
  return (
    <div className="table-scroll">
      <table className="data-table coverage-action-table">
        <thead><tr><th>动作</th><th>状态</th><th>确认数</th><th>更新时间</th><th>高级记录</th></tr></thead>
        <tbody>{actions.map((action) => (
          <tr key={action.actionId}>
            <td><strong>{coverageActionLabel(action.action)}</strong><small>{action.targetPaused ? '目标：暂停' : '目标：恢复'}</small></td>
            <td><span className={action.state === 'FINAL' ? 'status-chip status-ready' : 'status-chip status-blocked'}>{coverageActionState(action)}</span></td>
            <td>{action.confirmations}</td>
            <td>{action.updatedAt}</td>
            <td><details className="technical-details compact"><summary>查看编号</summary><dl><div><dt>平台处理号</dt><dd><code>{action.executorNonce ?? '待分配'}</code></dd></div><div><dt>提交记录</dt><dd><code title={action.submittedTxHash ?? undefined}>{action.submittedTxHash ? shortId(action.submittedTxHash) : '未提交'}</code></dd></div><div><dt>生效记录</dt><dd><code title={action.executionTxHash ?? undefined}>{action.executionTxHash ? shortId(action.executionTxHash) : '未执行'}</code></dd></div></dl></details></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function coverageActionState(action: CoverageBreakerActionProjection) {
  if (action.state === 'FINAL') return action.action === 'RESUME' ? '恢复已生效' : '暂停已生效';
  if (action.state === 'SUPERSEDED') return action.action === 'RESUME' ? '已被后续暂停作废' : '已被后续操作作废';
  if (action.state === 'MINED') return `确认中，等待 15 次确认（${action.confirmations}）`;
  if (action.state === 'SUBMITTED') return '已提交，等待链上确认';
  if (action.state === 'PENDING_EXECUTION') return '等待平台执行确认';
  return `${commonStateLabel(action.state)}，未生效`;
}

function coverageRecoveryReason(newPaymentPaused: boolean, coverageHealthy: boolean) {
  if (!newPaymentPaused) return '新支付没有暂停，不需要恢复动作。';
  if (!coverageHealthy) return '覆盖证据为空或未全部达到 100%，恢复保持关闭。';
  return '需要独立二次钱包签名和最终确认；提交不等于已恢复。';
}

function coverageActionLabel(action: string) {
  return ({ RESUME: '恢复', PAUSE: '暂停' } as Record<string, string>)[action] ?? action;
}

function formatCoverageAmount(amount: string, asset: string) {
  if (asset === 'USDT') return formatUsdt(amount);
  if (asset === 'NPL') return formatNpl(amount);
  return `${amount} ${asset}`;
}

function reasonCodeLabel(value: string) {
  return ({
    LOW_STOCK_PRODUCTS: '库存不足',
    COVERAGE_BELOW_100: '资金覆盖不足',
    WALLET_COVERAGE_BREACHED: '钱包覆盖不足',
    CONFIGURATION_REQUIRED: '需要配置',
    EXTERNAL_BLOCKED: '外部服务阻断',
    DECISION_BLOCKED: '缺少业务决策',
  } as Record<string, string>)[value] ?? metricLabel(value);
}

function breakerScopeLabel(scope: string) {
  return ({
    NEW_PAYMENT: '新支付',
    SECKILL_PURCHASE: '秒杀购买',
    SETTLEMENT_TRANSFER_CREATION: '新结算转账',
  } as Record<string, string>)[scope] ?? scope;
}

function dashboardMetricGroups(dashboard: AdminBusinessDashboard): readonly MetricGroup[] {
  const blocked = (metric: string): Metric => {
    const item = dashboard.unavailable.find((candidate) => candidate.metric === metric);
    return item
      ? { label: metricLabel(metric), value: item.reasonCode, detail: item.detail, blocked: true }
      : { label: metricLabel(metric), value: '不可用', detail: '系统未返回该指标，不解读为 0', blocked: true };
  };
  const shipmentRate = dashboard.orders.shipmentRate;
  return [
    {
      title: '今日终局与当前履约', icon: ShoppingBag, metrics: [
        metric('今日终局订单', dashboard.orders.finalizedToday, '15 次确认订单'),
        metric('GMV', formatUsdt(dashboard.orders.listPriceUsdt), '今日最终确认订单金额'),
        metric('买家已付', formatUsdt(dashboard.orders.buyerUsdtPaid), '今日最终确认订单金额'),
        metric('今日发货率', shipmentRate.bps === null ? '不可计算' : formatBpsAsPercent(Number(shipmentRate.bps)), `${shipmentRate.numerator} / ${shipmentRate.denominator}`, shipmentRate.bps === null),
        metric('待发货', dashboard.orders.pendingShipment, '当前队列'),
        metric('已发货', dashboard.orders.shipped, '当前状态'),
        metric('已送达', dashboard.orders.delivered, '当前状态'),
        metric('已履约', dashboard.orders.fulfilled, '当前状态'),
        metric('买家 UID 总数', dashboard.buyers.total, '系统买家账户'),
        metric('今日新增 UID', dashboard.buyers.newToday, dashboard.timezone),
      ],
    },
    {
      title: '商家与商品', icon: Store, metrics: [
        metric('商家总数', dashboard.merchants.total, '系统商家数据'),
        metric('今日新商家', dashboard.merchants.newToday, dashboard.timezone),
        metric('待审核商家', dashboard.merchants.pending, '当前状态'),
        metric('已通过商家', dashboard.merchants.approved, '当前状态'),
        metric('暂停商家', dashboard.merchants.suspended, '当前状态'),
        metric('商品总数', dashboard.products.total, '系统商品数据'),
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
        metric('换货处理', dashboard.fulfillmentQueues.exchange, '无业务退款'),
        metric('延期处理', dashboard.fulfillmentQueues.delay, '无业务退款'),
        metric('仲裁中', dashboard.fulfillmentQueues.arbitration, '当前队列'),
        metric('强制收货', dashboard.fulfillmentQueues.forcedReceipt, '当前队列'),
        metric('平台接管', dashboard.fulfillmentQueues.takeover, '平台接管履约'),
      ],
    },
    {
      title: '签名结算与交易证据', icon: ShieldAlert, metrics: [
        metric('今日结算申请', dashboard.settlements.requestedCount, '签名请求'),
        metric('申请金额', formatUsdt(dashboard.settlements.requestedUsdt), '今日窗口'),
        metric('今日已结算', dashboard.settlements.settledCount, '最终到账确认'),
        metric('已结算金额', formatUsdt(dashboard.settlements.settledUsdt), '最终到账确认'),
        metric('链上失败交易', dashboard.settlements.failedTransactions, '今日结算窗口'),
        metric('今日异常观察', dashboard.risk.abnormalObservationsToday, '风控记录'),
        metric('今日黑名单拦截', dashboard.risk.blacklistBlocksToday, '黑名单拦截'),
        metric('生效风险限制', dashboard.risk.activeRestrictions, '已生效限制'),
        metric('待处理风险申诉', dashboard.risk.pendingAppeals, '待处理申诉'),
      ],
    },
  ];
}

function metric(label: string, value: string, detail: string, blocked = false): Metric {
  return { label, value, detail, blocked };
}

function metricLabel(metricName: string) {
  return ({
    LOW_STOCK_PRODUCTS: '库存预警',
    COVERAGE_BELOW_100: '资金覆盖不足',
    WALLET_COVERAGE_BREACHED: '钱包覆盖不足',
  } as Record<string, string>)[metricName] ?? metricName.replace(/[_-]+/g, ' ').toLowerCase();
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>加载失败</strong><p>{humanizeError(error)}</p></div></div>;
}

function UnavailableEmpty({ label }: { label: string }) {
  return <div className="empty-inline"><Clock3 aria-hidden="true" /><div><strong>{label}</strong><p>空列表不解读为 0 或健康。</p></div></div>;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message: '平台工作台服务暂时不可用', status: 503 });
}

function asCoverageResumeError(cause: unknown) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'InvalidResponse', message: '覆盖断路器恢复未获得有效签名或系统授权', status: 400 });
}

function dashboardCommandNonce() {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString();
}

function dashboardCommandDeadline() {
  return String(Math.floor(Date.now() / 1_000) + 300);
}

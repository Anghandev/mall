import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Database, RefreshCw, ServerCog, ShieldCheck, ShoppingBag, Store, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchCoreBootstrap } from '../coreApi';
import { coreState } from '../coreState';
import { adminModules } from '../domain/adminModules';
import { useCoreResource } from '../useCoreResource';

const metricGroups = [
  {
    title: '今日核心业务',
    icon: ShoppingBag,
    metrics: ['总订单数', 'GMV · USDT', '发货率', '秒杀场次', '新增 UID', '新增商家'],
  },
  {
    title: '待办与履约',
    icon: Store,
    metrics: ['待审核商家', '待审核商品', 'exchange / delay / arbitration', 'Takeover cases', '库存预警'],
  },
  {
    title: 'Web3 资管与风控',
    icon: ShieldCheck,
    metrics: ['签名结算申请', 'Safe settled · USDT', '链上失败', '异常订单', '黑名单拦截', '逐资产覆盖率'],
  },
  {
    title: '基础设施',
    icon: ServerCog,
    metrics: ['RPC latency', 'Oracle deviation', 'CPU / memory', 'Redis hit', 'MQ backlog', 'block height'],
  },
] as const;

export function DashboardPage() {
  const bootstrap = useCoreResource(fetchCoreBootstrap);
  const readiness = bootstrap.data?.readiness;

  return (
    <>
      <header className="page-header dashboard-header">
        <div className="page-icon"><Database aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">OPERATIONS CONTROL ROOM</p>
          <h1>今日运营态势</h1>
          <p>以 authoritative timezone 和 Core 聚合为准。当前未连接，指标显示不可用而非 0。</p>
        </div>
        <div className="requirement-list"><code>ADM-DASH-001—004</code><code>2026-07-14 · UTC+8</code></div>
      </header>

      <section className={readiness?.writesEnabled ? 'dashboard-alert dashboard-alert-ready' : 'dashboard-alert'} role="status">
        <span>{readiness?.writesEnabled ? <CheckCircle2 aria-hidden="true" /> : <Ban aria-hidden="true" />}</span>
        <div>
          <strong>{bootstrap.loading ? '正在读取支付 readiness' : bootstrap.error ? `${bootstrap.error.code}: ${bootstrap.error.message}` : readiness?.writesEnabled ? '支付运行时允许新报价' : '新支付保持 fail-closed'}</strong>
          <p>业务聚合、风险队列和基础设施探针尚未发布；支付门禁状态来自 Core bootstrap，不以静态值代替。</p>
        </div>
        <Link to="/core-status">查看证据 <ArrowRight aria-hidden="true" /></Link>
      </section>

      <section className="readiness-strip" aria-label="支付 checkpoint 状态">
        <div><span>Artifact</span><strong>{coreState.artifactVersion}</strong></div>
        <div><span>Chain</span><strong>{readiness?.chainId ?? '—'}</strong></div>
        <div><span>Payment DecisionBlocked</span><strong>{readiness ? readiness.paymentDecisionBlocked.length : '—'}</strong></div>
        <div><span>Payment ExternalBlocked</span><strong>{readiness ? readiness.paymentExternalBlocked.length : '—'}</strong></div>
        <button className="icon-button light-icon-button" type="button" aria-label="重新读取支付 readiness" onClick={bootstrap.reload} disabled={bootstrap.loading}><RefreshCw aria-hidden="true" /></button>
      </section>

      <section className="metric-board" aria-label="Dashboard 指标组">
        {metricGroups.map(({ title, icon: Icon, metrics }) => (
          <article className="metric-group" key={title}>
            <div className="metric-group-heading"><Icon aria-hidden="true" /><h2>{title}</h2><span>UNAVAILABLE</span></div>
            <dl>
              {metrics.map((metric) => <div key={metric}><dt>{metric}</dt><dd aria-label={`${metric}不可用`}>—<small>不可用</small></dd></div>)}
            </dl>
          </article>
        ))}
      </section>

      <section className="dashboard-lower">
        <article className="panel incident-panel">
          <div className="panel-heading"><div><p className="section-kicker">风险队列</p><h2>需要证据的事件</h2></div><AlertTriangle aria-hidden="true" /></div>
          <div className="empty-inline"><ShieldCheck aria-hidden="true" /><div><strong>风险事件投影不可用</strong><p>不以空列表证明系统安全；等待 GAP-ADM-011。</p></div></div>
        </article>
        <article className="panel">
          <div className="panel-heading"><div><p className="section-kicker">快速入口</p><h2>关键运营工作流</h2></div><WalletCards aria-hidden="true" /></div>
          <nav className="quick-links" aria-label="关键运营工作流">
            {adminModules.filter((module) => ['takeover', 'policy', 'risk', 'audit'].includes(module.id)).map((module) => (
              <Link key={module.id} to={module.path}><module.icon aria-hidden="true" /><span><strong>{module.label}</strong><small>{module.eyebrow}</small></span><ArrowRight aria-hidden="true" /></Link>
            ))}
          </nav>
        </article>
      </section>
    </>
  );
}

import { artifactVersion, chainIdentity } from '@abu24k/core-artifacts';
import { capabilityStatus, deploymentAuthorized, publicationStatus } from '@abu24k/core-artifacts/manifest';
import { Ban, CheckCircle2, CircleDot, RadioTower, RefreshCw, ShieldCheck } from 'lucide-react';
import { fetchCoreBootstrap } from '../coreApi';
import { useCoreResource } from '../useCoreResource';

export function CoreStatusPage() {
  const bootstrap = useCoreResource(fetchCoreBootstrap);
  const readiness = bootstrap.data?.readiness;

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><RadioTower aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">Coordinated logistics checkpoint</p>
          <h1>Core 状态</h1>
          <p>版本、HTTP 能力和运行时 readiness 均来自同一发布物。未部署、未配置或未发布不会显示为健康。</p>
        </div>
        <div className="requirement-list"><code>ADM-SYS-005</code><code>{artifactVersion}</code></div>
      </header>

      <section className="status-overview" aria-label="Core 发布状态">
        <article><span>Artifact</span><strong>{artifactVersion}</strong><small>{publicationStatus}</small></article>
        <article><span>Network</span><strong>BSC · {chainIdentity.chainId}</strong><small>固定链身份</small></article>
        <article><span>Deployment</span><strong>{deploymentAuthorized ? 'Authorized' : 'ExternalBlocked'}</strong><small>没有地址时不推断</small></article>
        <article>
          <span>New payment</span>
          <strong>{bootstrap.loading ? 'Checking' : bootstrap.error ? 'Unavailable' : readiness?.writesEnabled ? 'Enabled' : 'Fail closed'}</strong>
          <small>{bootstrap.error?.code ?? (readiness ? 'Core authoritative' : '无运行时证据')}</small>
        </article>
      </section>

      <section className="status-columns">
        <article className="panel">
          <div className="panel-heading">
            <div><p className="section-kicker">GET /v2/bootstrap</p><h2>支付运行时 readiness</h2></div>
            <button className="button button-quiet" type="button" onClick={bootstrap.reload} disabled={bootstrap.loading}>
              <RefreshCw aria-hidden="true" /> {bootstrap.loading ? '检查中' : '重新检查'}
            </button>
          </div>
          {bootstrap.error ? (
            <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{bootstrap.error.code}</strong><p>{bootstrap.error.message}</p></div></div>
          ) : null}
          {readiness ? (
            <dl className="definition-grid">
              <div><dt>Core status</dt><dd>{bootstrap.data?.status}</dd></div>
              <div><dt>Chain ID</dt><dd>{readiness.chainId}</dd></div>
              <div><dt>USDT</dt><dd><code>{readiness.assets.usdt}</code></dd></div>
              <div><dt>NPL</dt><dd><code>{readiness.assets.npl}</code></dd></div>
              <div><dt>NPL / USDT pair</dt><dd>{readiness.assets.nplUsdtPair ? <code>{readiness.assets.nplUsdtPair}</code> : '未公开'}</dd></div>
              <div><dt>新支付写入</dt><dd>{readiness.writesEnabled ? 'Enabled' : 'Fail closed'}</dd></div>
            </dl>
          ) : null}
        </article>

        <aside className="panel">
          <p className="section-kicker">Checkpoint capabilities</p><h2>Core 全局发布面</h2>
          <ul className="capability-list">
            {Object.entries(capabilityStatus).map(([name, status]) => (
              <li key={name} className={status === 'AVAILABLE' ? 'capability-available' : 'capability-blocked'}>
                {status === 'AVAILABLE' ? <CheckCircle2 aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
                <span><strong>{name}</strong><small>{status}</small></span>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <section className="status-columns">
        <BlockedList title="Payment DecisionBlocked" values={readiness?.paymentDecisionBlocked} loading={bootstrap.loading} />
        <BlockedList title="Payment ExternalBlocked" values={readiness?.paymentExternalBlocked} loading={bootstrap.loading} />
      </section>

      <section className="snapshot-rule">
        <ShieldCheck aria-hidden="true" />
        <div><strong>Admin 边界</strong><p>运单、打印机绑定与打印作业仅发布 Merchant 路径，不会因 Core 全局能力显示 AVAILABLE 而成为 Admin 操作。Admin 物流配置、批量打印和生产部署仍保持 fail-closed。</p></div>
      </section>
    </>
  );
}

function BlockedList({ title, values, loading }: { title: string; values: readonly string[] | undefined; loading: boolean }) {
  return (
    <article className="panel blocker-panel">
      <p className="section-kicker">Runtime gate</p><h2>{title}</h2>
      {loading ? <p className="muted-copy">正在读取 Core...</p> : null}
      {!loading && values?.length === 0 ? <p className="healthy-copy"><CheckCircle2 aria-hidden="true" /> Core 返回无阻断项</p> : null}
      {values && values.length > 0 ? <ul>{values.map((value) => <li key={value}><Ban aria-hidden="true" /> <code>{value}</code></li>)}</ul> : null}
    </article>
  );
}

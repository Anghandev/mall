import type { CanonicalPaymentIntent, PaymentProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, Gauge, KeyRound, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CoreApiError, fetchPaymentProjection } from '../coreApi';
import { useCoreSession } from '../coreSession';

export function PaymentTracePage() {
  const { connect, error: sessionError, session, status } = useCoreSession();
  const [orderId, setOrderId] = useState('');
  const [projection, setProjection] = useState<PaymentProjection | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session) return;
    setLoading(true);
    setProjection(null);
    setError(null);
    try {
      setProjection(await fetchPaymentProjection(orderId.trim(), session.token));
    } catch (cause) {
      setError(cause instanceof CoreApiError
        ? cause
        : new CoreApiError({ code: 'ExternalBlocked', message: '支付投影不可用', status: 503 }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Gauge aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">PaymentRouter trace</p>
          <h1>支付提交与最终性</h1>
          <p>展示 Core 返回的报价快照、库存预约、Router call、提交 TxHash 和链上最终性，不在前端重算金额或状态。</p>
        </div>
        <div className="requirement-list"><code>ADM-CLEAR-001 · partial</code><code>ADM-CLEAR-004 · partial</code></div>
      </header>

      <section className="trace-query panel">
        <div className="panel-heading">
          <div><p className="section-kicker">GET /v2/payments/{'{orderId}'}</p><h2>钱包绑定支付投影</h2></div>
          <span className={session ? 'status-chip status-ready' : 'status-chip status-blocked'}>
            {session ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
            {session ? session.roles.join(' / ') : '需要 SIWE'}
          </span>
        </div>

        {!session ? (
          <div className="session-prompt">
            <div><strong>先连接已授权钱包</strong><p>JWT 只保存在当前页面内存中。Core 当前支付投影按买家钱包隔离。</p></div>
            <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
              <KeyRound aria-hidden="true" /> {status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}
            </button>
          </div>
        ) : (
          <form className="trace-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="trace-order">Order ID · bytes32</label>
            <div><input id="trace-order" value={orderId} onChange={(event) => setOrderId(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" /><button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" /> {loading ? '读取中' : '读取投影'}</button></div>
          </form>
        )}
        {sessionError ? <p className="inline-notice" role="alert">{sessionError}</p> : null}
        {error ? (
          <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p></div></div>
        ) : null}
      </section>

      {projection ? <PaymentProjectionView projection={projection} /> : null}

      <section className="blocked-callout" aria-labelledby="admin-payment-gap">
        <ShieldAlert aria-hidden="true" />
        <div><strong id="admin-payment-gap">所需 Core 能力</strong><p>fulfillment.1 的支付投影读取仍绑定买家钱包；Admin 全局支付审计、Gas、Safe 与账本核验需要 GAP-ADM-017 的 RBAC 审计投影。</p></div>
        <span>全局审计 fail-closed</span>
      </section>
    </>
  );
}

function PaymentProjectionView({ projection }: { projection: PaymentProjection }) {
  const intents = 'intent' in projection
    ? [{ label: 'Ordinary', intent: projection.intent }]
    : [{ label: 'Seckill', intent: projection.dual.seckill }, { label: 'Fallback retail', intent: projection.dual.fallback }];

  return (
    <section className="trace-results" aria-live="polite">
      <article className="panel trace-summary">
        <div className="panel-heading"><div><p className="section-kicker">Core projection</p><h2>{projection.state}</h2></div><span className="status-chip status-ready"><RefreshCw aria-hidden="true" /> {projection.routerCall.functionName}</span></div>
        <dl className="definition-grid">
          <div><dt>Order ID</dt><dd><code>{projection.orderId}</code></dd></div>
          <div><dt>Submitted TxHash</dt><dd>{projection.submittedTxHash ? <code>{projection.submittedTxHash}</code> : '尚未提交'}</dd></div>
          <div><dt>Router</dt><dd><code>{projection.paymentRouterAddress}</code></dd></div>
          <div><dt>Artifact</dt><dd>{projection.artifactVersion}</dd></div>
        </dl>
      </article>

      {intents.map(({ label, intent }) => <PaymentIntentPanel key={label} label={label} intent={intent} />)}

      <article className="panel finality-panel">
        <p className="section-kicker">Indexed finality</p><h2>{projection.finality?.state ?? 'NOT_SUBMITTED'}</h2>
        {projection.finality ? (
          <dl className="definition-grid">
            <div><dt>Classification</dt><dd>{projection.finality.classification}</dd></div>
            <div><dt>Confirmations</dt><dd>{projection.finality.confirmations} / {projection.finality.requiredConfirmations}</dd></div>
            <div><dt>Block</dt><dd>{projection.finality.blockNumber}</dd></div>
            <div><dt>Canonical</dt><dd>{projection.finality.canonicalBlock ? 'Yes' : 'No'}</dd></div>
            <div><dt>TxHash</dt><dd><code>{projection.finality.transactionHash}</code></dd></div>
            <div><dt>Block hash</dt><dd><code>{projection.finality.blockHash}</code></dd></div>
          </dl>
        ) : <p className="muted-copy">Core 尚未返回链上最终性证据。</p>}
      </article>
    </section>
  );
}

function PaymentIntentPanel({ label, intent }: { label: string; intent: CanonicalPaymentIntent }) {
  return (
    <article className="panel intent-panel">
      <p className="section-kicker">{label} intent</p><h2>政策与原子金额快照</h2>
      <dl className="definition-grid">
        <div><dt>Policy version</dt><dd>{intent.policyVersion}</dd></div>
        <div><dt>Reservation</dt><dd><code>{intent.reservationId}</code></dd></div>
        <div><dt>Reservation deadline</dt><dd>{intent.reservationDeadline}</dd></div>
        <div><dt>Quantity</dt><dd>{intent.quantity}</dd></div>
        <div><dt>List price</dt><dd>{intent.listPriceUsdt}<small>USDT atomic</small></dd></div>
        <div><dt>Buyer USDT</dt><dd>{intent.usdtPaymentAmount}<small>atomic</small></dd></div>
        <div><dt>Buyer NPL</dt><dd>{intent.nplPaymentAmount}<small>atomic</small></dd></div>
        <div><dt>NPL Burn</dt><dd>{intent.nplBurnAmount}<small>atomic</small></dd></div>
        <div><dt>NPL Reward Safe</dt><dd>{intent.nplRewardAmount}<small>atomic</small></dd></div>
        <div><dt>Merchant net receivable</dt><dd>{intent.merchantNetReceivableUsdt}<small>USDT atomic</small></dd></div>
      </dl>
    </article>
  );
}

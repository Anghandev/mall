import type { MerchantFinanceProjection } from '@abu24k/core-artifacts';
import { Ban, Building2, KeyRound, Search, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { fetchMerchantFinance } from '../settlementAdminApi';

export function MerchantFinancePage() {
  const { connect, session, status } = useCoreSession();
  const [merchantId, setMerchantId] = useState('');
  const [projection, setProjection] = useState<MerchantFinanceProjection | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR', 'ARBITRATOR'].includes(role)) ?? false;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canRead) return;
    setLoading(true); setError(null); setProjection(null);
    try { setProjection(await fetchMerchantFinance(merchantId, session.token)); }
    catch (cause) { setError(asCoreError(cause)); }
    finally { setLoading(false); }
  };

  return (
    <>
      <header className="page-header"><div className="page-icon"><Building2 aria-hidden="true" /></div><div><p className="eyebrow">MERCHANT FINANCE</p><h1>商家资金与保证金</h1><p>查看 Operations Safe 保证金、接管筹资、平台垫资债务和冻结状态；金额全部来自 Core 账本。</p></div><div className="requirement-list"><code>ADM-MER-004 / 006</code><code>ADM-TAKE-003 / 004</code></div></header>
      <section className="panel admin-resource-panel">
        <div className="panel-heading"><div><p className="section-kicker">GET /v2/finance/merchant</p><h2>商家资金穿透</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? session.roles.join(' / ') : '需要 SIWE'}</span></div>
        {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>仅 ADMIN、OPERATOR、ARBITRATOR 或 AUDITOR 可按 merchantId 查询。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />SIWE 连接</button></div>
          : !canRead ? <div className="resource-state resource-state-error"><Ban aria-hidden="true" /><div><strong>Forbidden</strong><p>当前会话没有平台资金读取权限。</p></div></div>
            : <form className="inline-query-form" onSubmit={submit}><label>Merchant ID<input value={merchantId} onChange={(event) => setMerchantId(event.target.value)} required /></label><button className="button button-primary" type="submit" disabled={loading || !merchantId.trim()}><Search aria-hidden="true" />{loading ? '查询中' : '读取资金状态'}</button></form>}
        {error ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div> : null}
        {projection ? <MerchantFinanceDetail projection={projection} /> : null}
      </section>
    </>
  );
}

function MerchantFinanceDetail({ projection }: { projection: MerchantFinanceProjection }) {
  return <div className="admin-detail-stack"><div className="status-overview compact-overview"><article><span>保证金状态</span><strong>{projection.merchant.guarantee_status}</strong><small>{projection.merchant.merchant_id}</small></article><article><span>保证金 · USDT atomic</span><strong>{projection.guarantee?.balance_usdt ?? '不可用'}</strong><small>最低 {projection.guarantee?.minimum_usdt ?? '不可用'}</small></article><article><span>未偿债务 · USDT atomic</span><strong>{projection.debt?.outstanding_usdt ?? '0'}</strong><small>{projection.debt ? 'append-only debt ledger' : 'Core 返回无债务'}</small></article><article><span>接管案件</span><strong>{projection.takeovers.length}</strong><small>不可物理删除</small></article></div><div className="table-scroll"><table className="data-table"><thead><tr><th>接管案件</th><th>状态</th><th>保证金</th><th>冻结应收</th><th>未来货款</th><th>平台垫资 / 债务</th></tr></thead><tbody>{projection.takeovers.map((item) => <tr key={item.case_id}><td><strong>{item.case_id}</strong><small>{item.order_id}</small></td><td>{item.state}</td><td>{item.guarantee_used_usdt ?? '—'}</td><td>{item.merchant_available_used_usdt ?? '—'}</td><td>{item.future_proceeds_used_usdt ?? '—'}</td><td>{item.platform_advance_usdt ?? '—'} / {item.merchant_debt_usdt ?? '—'}</td></tr>)}</tbody></table></div></div>;
}

function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '商家资金投影不可用', status: 503 }); }

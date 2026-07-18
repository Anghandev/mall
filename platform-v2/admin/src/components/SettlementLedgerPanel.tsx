import type { SettlementListProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, RefreshCw, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { fetchSettlementLedger } from '../settlementAdminApi';

export function SettlementLedgerPanel() {
  const { session } = useCoreSession();
  const [projection, setProjection] = useState<SettlementListProjection | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setProjection(null);
    setError(null);
    if (!session) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchSettlementLedger(session.token, controller.signal)
      .then(setProjection)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(asCoreError(cause, '签名结算投影不可用'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, session]);

  return (
    <section className="panel admin-resource-panel" aria-labelledby="settlement-ledger-title">
      <div className="panel-heading">
        <div><p className="section-kicker">GET /v2/settlements</p><h2 id="settlement-ledger-title">签名结算与普通钱包最终状态</h2></div>
        {session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}
      </div>
      {!session ? (
        <div className="session-prompt"><div><strong>等待当前页面钱包会话</strong><p>使用上方支付投影的 SIWE 入口连接。Core 按钱包与角色返回余额和申请，后台不会越权聚合。</p></div></div>
      ) : error ? (
        <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div>
      ) : loading ? <div className="catalog-loading" aria-label="正在读取签名结算"><span /><span /><span /></div>
        : projection ? (
          <>
            {projection.balances.length || projection.points.length ? <div className="status-overview compact-overview">
              {projection.balances.map((balance) => <article key={`${balance.asset}:${balance.purpose}:${balance.rewardSubtype ?? 'NONE'}:${balance.state}`}><span>{balance.asset} · {balance.purpose}</span><strong>{balance.amount}</strong><small>{balance.rewardSubtype ?? 'NO_SUBTYPE'} · {balance.state}</small></article>)}
              {projection.points.map((points) => <article key={`${points.pointsType}:${points.purpose}:${points.state}`}><span>{points.pointsType} backend points</span><strong>{points.amount}</strong><small>{points.state} · NON_TRANSFERABLE</small></article>)}
            </div> : <div className="empty-inline"><WalletCards aria-hidden="true" /><div><strong>当前钱包没有资产或 BNM points 余额</strong><p>这是 Core 返回的真实空投影。</p></div></div>}
            {projection.requests.length ? (
              <div className="table-scroll"><table className="data-table"><thead><tr><th>申请</th><th>Rail / Asset</th><th>金额</th><th>状态</th><th>Execution TxHash</th></tr></thead><tbody>{projection.requests.map((request) => <tr key={request.request_id}><td><code>{request.request_id}</code><small>{request.requested_at}</small></td><td><strong>{request.rail}</strong><small>{request.asset}</small></td><td><strong>{request.amount}</strong><small>{request.recipient_address}</small></td><td><span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />{request.state}</span></td><td><code>{request.final_execution_tx_hashes[0] ?? '等待最终确认'}</code><small>{request.final_execution_tx_hashes.length} final transfers</small></td></tr>)}</tbody></table></div>
            ) : <div className="empty-inline"><WalletCards aria-hidden="true" /><div><strong>当前钱包没有结算申请</strong><p>这是 Core 返回的真实空列表。</p></div></div>}
          </>
        ) : null}
    </section>
  );
}

function asCoreError(cause: unknown, fallback: string) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: fallback, status: 503 });
}

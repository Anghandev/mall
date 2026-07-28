import type { SettlementListProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, RefreshCw, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { commonStateLabel, formatBnm, formatNpl, formatTokenAmount, formatUsdt, humanizeError, shortAddress, shortId } from '../display';
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
        if (!controller.signal.aborted) setError(asCoreError(cause, '签名结算投影暂时无法连接'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, session]);

  return (
    <section className="panel admin-resource-panel" aria-labelledby="settlement-ledger-title">
      <div className="panel-heading">
        <div><p className="section-kicker">结算记录</p><h2 id="settlement-ledger-title">签名结算与到账状态</h2></div>
        {session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}
      </div>
      {!session ? (
        <div className="session-prompt"><div><strong>等待当前页面钱包会话</strong><p>使用上方入口连接。系统按钱包与角色返回余额和申请，后台不会越权聚合。</p></div></div>
      ) : error ? (
        <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>读取失败</strong><p>{humanizeError(error)}</p></div></div>
      ) : loading ? <div className="catalog-loading" aria-label="正在读取签名结算"><span /><span /><span /></div>
        : projection ? (
          <>
            {projection.balances.length || projection.points.length ? <div className="status-overview compact-overview">
              {projection.balances.map((balance) => <article key={`${balance.asset}:${balance.purpose}:${balance.rewardSubtype ?? 'NONE'}:${balance.state}`}><span>{balance.asset} · {assetPurposeLabel(balance.purpose)}</span><strong>{formatAssetAmount(balance.amount, balance.asset)}</strong><small>{balance.rewardSubtype ? rewardSubtypeLabel(balance.rewardSubtype) : '普通余额'} · {commonStateLabel(balance.state)}</small></article>)}
              {projection.points.map((points) => <article key={`${points.pointsType}:${points.purpose}:${points.state}`}><span>{points.pointsType} 后台积分</span><strong>{formatBnm(points.amount)}</strong><small>{commonStateLabel(points.state)} · 不可链上转账</small></article>)}
            </div> : <div className="empty-inline"><WalletCards aria-hidden="true" /><div><strong>当前钱包没有资产或 BNM 余额</strong><p>系统当前没有可展示余额。</p></div></div>}
            {projection.requests.length ? (
              <div className="table-scroll"><table className="data-table"><thead><tr><th>申请</th><th>类型 / 资产</th><th>金额</th><th>状态</th><th>到账记录</th></tr></thead><tbody>{projection.requests.map((request) => <tr key={request.request_id}><td><code title={request.request_id}>{shortId(request.request_id)}</code><small>{request.requested_at}</small></td><td><strong>{railLabel(request.rail)}</strong><small>{request.asset}</small></td><td><strong>{formatAssetAmount(request.amount, request.asset)}</strong><small title={request.recipient_address}>{shortAddress(request.recipient_address)}</small></td><td><span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />{commonStateLabel(request.state)}</span></td><td><strong>{request.final_execution_tx_hashes.length ? '已到账' : '等待到账确认'}</strong><small>{request.final_execution_tx_hashes.length} 笔已确认转账</small>{request.final_execution_tx_hashes.length ? <details className="technical-details compact"><summary>客服核验编号</summary>{request.final_execution_tx_hashes.map((hash) => <code key={hash} title={hash}>{shortId(hash)}</code>)}</details> : null}</td></tr>)}</tbody></table></div>
            ) : <div className="empty-inline"><WalletCards aria-hidden="true" /><div><strong>当前钱包没有结算申请</strong><p>系统当前没有结算申请。</p></div></div>}
          </>
        ) : null}
    </section>
  );
}

function asCoreError(cause: unknown, fallback: string) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: fallback, status: 503 });
}

function formatAssetAmount(amount: string, asset: string) {
  if (asset === 'USDT') return formatUsdt(amount);
  if (asset === 'NPL') return formatNpl(amount);
  return formatTokenAmount(amount, asset);
}

function railLabel(value: string) {
  return ({
    MERCHANT_USDT: '商家货款',
    NPL_REWARD: 'NPL 奖励',
    BNM_POINTS: 'BNM 积分',
  } as Record<string, string>)[value] ?? value;
}

function assetPurposeLabel(value: string) {
  return ({
    MERCHANT_RECEIVABLE: '商家货款',
    MERCHANT_FREIGHT_RECEIVABLE: '运费应收',
    REWARD_DISTRIBUTION: '奖励发放',
    SECKILL_PRIZE: '秒杀奖池',
    NODE_REWARD: '节点奖励',
    REWARD_RESERVE: '奖励预留',
  } as Record<string, string>)[value] ?? value;
}

function rewardSubtypeLabel(value: string) {
  return ({
    GENESIS: '创世奖励',
    DIRECT_REFERRAL: '直推奖励',
    DISTRICT: '区县奖励',
    CITY: '城市奖励',
    PROVINCE: '省级奖励',
    REGION: '大区奖励',
    OPERATIONS: '运营奖励',
    ROUNDING_REMAINDER: '取整余额',
  } as Record<string, string>)[value] ?? value;
}

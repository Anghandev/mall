import type {
  AdminSettlementRequestDetail,
  AdminSettlementRequestList,
  AdminSettlementTransferDetail,
  AdminSettlementTransferList,
  CanonicalPaymentIntent,
  PaymentProjection,
  SettlementRequestState,
  SettlementRail,
  SettlementTransferState,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  FileSignature,
  Gauge,
  KeyRound,
  Landmark,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { formatBnm, formatNpl, formatTokenAmount, formatUsdt, humanizeError } from '../display';
import {
  fetchAdminSettlementRequest,
  fetchAdminSettlementRequests,
  fetchAdminSettlementTransfer,
  fetchAdminSettlementTransfers,
  fetchGlobalPaymentTrace,
  settlementRails,
  settlementRequestStates,
  settlementTransferStates,
  type AdminSettlementRequestFilters,
  type AdminSettlementTransferFilters,
  type SettlementAsset,
} from '../settlementClearingApi';

type View = 'PAYMENT' | 'REQUESTS' | 'TRANSFERS';
const readableRoles = ['ADMIN', 'OPERATOR', 'AUDITOR'];

export function PaymentTracePage() {
  const { connect, error: sessionError, session, status } = useCoreSession();
  const [view, setView] = useState<View>('PAYMENT');
  const canRead = session?.roles.some((role) => readableRoles.includes(role)) ?? false;

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Gauge aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">全局清算</p>
          <h1>全局清算审计</h1>
          <p>按订单、结算申请和到账记录追踪资金状态。金额、权限和最终结果都以系统确认为准。</p>
        </div>
        <div className="requirement-list"><code>支付</code><code>结算</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt clearing-session-gate" role="status" aria-label="清算工作台状态">
          <div><strong>连接平台授权钱包</strong><p>这里只能查看，不提供转账或执行按钮。</p></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}
          </button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有全局清算读取权限', status: 403 })} />
      ) : (
        <>
          <section className="clearing-toolbar" aria-label="清算工作区导航">
            <div className="merchant-status-tabs" role="tablist" aria-label="清算视图">
              <ViewTab active={view === 'PAYMENT'} onClick={() => setView('PAYMENT')}>订单支付记录</ViewTab>
              <ViewTab active={view === 'REQUESTS'} onClick={() => setView('REQUESTS')}>结算申请</ViewTab>
              <ViewTab active={view === 'TRANSFERS'} onClick={() => setView('TRANSFERS')}>平台打款记录</ViewTab>
            </div>
            <span className="status-chip status-ready"><ShieldCheck aria-hidden="true" />{session.roles.map(roleLabel).join(' / ')} · 只读</span>
          </section>
          {view === 'PAYMENT' ? <PaymentWorkspace token={session.token} /> : null}
          {view === 'REQUESTS' ? <RequestWorkspace token={session.token} /> : null}
          {view === 'TRANSFERS' ? <TransferWorkspace token={session.token} /> : null}
        </>
      )}
      {sessionError ? <p className="inline-notice" role="alert">{sessionError}</p> : null}
    </>
  );
}

function PaymentWorkspace({ token }: { token: string }) {
  const [orderId, setOrderId] = useState('');
  const [projection, setProjection] = useState<PaymentProjection | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true); setProjection(null); setError(null);
    try { setProjection(await fetchGlobalPaymentTrace(orderId.trim(), token)); }
    catch (cause) { setError(asCoreError(cause, '支付记录暂时无法连接')); }
    finally { setLoading(false); }
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">订单查询</p><h2>订单支付记录</h2></div><CircleDollarSign aria-hidden="true" /></div>
      <form className="trace-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="clearing-order-id">订单编号</label>
        <div><input id="clearing-order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} autoComplete="off" placeholder="输入完整订单编号" required /><button className="button button-primary" type="submit" disabled={loading || !orderId.trim()}><Search aria-hidden="true" />{loading ? '读取中' : '读取支付证据'}</button></div>
      </form>
      {loading ? <LoadingState label="正在读取支付记录" /> : null}
      {error ? <ErrorView error={error} /> : null}
      {!loading && !error && !projection ? <EmptyState title="等待订单编号" detail="请输入完整订单编号后查询。" /> : null}
    </article>
    {projection ? <PaymentProjectionView projection={projection} /> : null}
  </section>;
}

const emptyRequestFilters: AdminSettlementRequestFilters = { limit: 25 };

function RequestWorkspace({ token }: { token: string }) {
  const [draft, setDraft] = useState<AdminSettlementRequestFilters>(emptyRequestFilters);
  const [applied, setApplied] = useState<AdminSettlementRequestFilters>(emptyRequestFilters);
  const [result, setResult] = useState<AdminSettlementRequestList | null>(null);
  const [detail, setDetail] = useState<AdminSettlementRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);

  const load = async (filters: AdminSettlementRequestFilters, append = false) => {
    setLoading(true); setError(null);
    try {
      const next = await fetchAdminSettlementRequests(filters, token);
      setResult((current) => append && current ? { ...next, requests: [...current.requests, ...next.requests] } : next);
      setApplied(filters);
    } catch (cause) { setError(asCoreError(cause, '结算申请列表暂时无法连接')); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(emptyRequestFilters); }, [token]);

  const select = async (requestId: string) => {
    setDetailLoading(true); setError(null); setDetail(null);
    try { setDetail(await fetchAdminSettlementRequest(requestId, token)); }
    catch (cause) { setError(asCoreError(cause, '结算申请详情暂时无法连接')); }
    finally { setDetailLoading(false); }
  };

  const more = () => {
    if (!result?.nextCursor) return;
    void load({ ...applied, cursorRequestedAt: result.nextCursor.requestedAt, cursorRequestId: result.nextCursor.requestId }, true);
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">结算申请查询</p><h2>结算申请</h2></div><FileSignature aria-hidden="true" /></div>
      <form className="clearing-filter-grid" onSubmit={(event) => { event.preventDefault(); setDetail(null); void load({ ...draft, cursorRequestedAt: undefined, cursorRequestId: undefined }); }}>
        <TextFilter label="申请编号" value={draft.requestId} setValue={(value) => setDraft({ ...draft, requestId: value })} />
        <TextFilter label="商家编号" value={draft.merchantId} setValue={(value) => setDraft({ ...draft, merchantId: value })} />
        <TextFilter label="钱包地址" value={draft.walletAddress} setValue={(value) => setDraft({ ...draft, walletAddress: value })} />
        <TextFilter label="订单编号" value={draft.orderId} setValue={(value) => setDraft({ ...draft, orderId: value })} />
        <TextFilter label="转账编号" value={draft.transferId} setValue={(value) => setDraft({ ...draft, transferId: value })} />
        <TextFilter label="到账记录" value={draft.executionTxHash} setValue={(value) => setDraft({ ...draft, executionTxHash: value })} />
        <label>类型<select value={draft.rail ?? ''} onChange={(event) => setDraft({ ...draft, rail: (event.target.value || undefined) as SettlementRail | undefined })}><option value="">全部</option>{settlementRails.map((value) => <option key={value} value={value}>{railLabel(value)}</option>)}</select></label>
        <label>资产<select value={draft.asset ?? ''} onChange={(event) => setDraft({ ...draft, asset: (event.target.value || undefined) as SettlementAsset | undefined })}><option value="">全部</option><option>USDT</option><option>NPL</option></select></label>
        <label>状态<select value={draft.state ?? ''} onChange={(event) => setDraft({ ...draft, state: (event.target.value || undefined) as SettlementRequestState | undefined })}><option value="">全部</option>{settlementRequestStates.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label>
        <DateFilter label="开始时间" setValue={(value) => setDraft({ ...draft, from: value })} />
        <DateFilter label="结束时间" setValue={(value) => setDraft({ ...draft, to: value })} />
        <label>数量<input type="number" min="1" max="100" value={draft.limit ?? 25} onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })} /></label>
        <button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" />{loading ? '查询中' : '查询'}</button>
      </form>
    </article>
    {error ? <ErrorView error={error} /> : null}
    <div className="clearing-master-detail">
      <article className="panel clearing-list-panel" aria-busy={loading}>
        <div className="panel-heading"><div><p className="section-kicker">申请列表</p><h2>申请列表</h2></div><span className="status-chip">{result?.requests.length ?? 0} 条</span></div>
        {loading && !result ? <LoadingState label="正在读取申请列表" /> : null}
        {result?.requests.length ? <div className="clearing-list">{result.requests.map((item) => <button key={item.requestId} className={detail?.request.requestId === item.requestId ? 'clearing-list-row is-selected' : 'clearing-list-row'} type="button" onClick={() => void select(item.requestId)}><span><strong>{railLabel(item.rail)} · {item.asset}</strong><small>{shortHash(item.requestId)}</small><small>{item.merchantId ? shortHash(item.merchantId) : '非商家类型'} · {shortAddress(item.walletAddress)}</small></span><span><StateChip state={item.state} /> <small>{formatSettlementAmount(item.amount, item.asset)}</small></span></button>)}</div> : !loading ? <EmptyState title="暂无结算申请" detail="当前筛选下没有记录。" /> : null}
        {result?.nextCursor ? <button className="button button-quiet button-full" type="button" onClick={more} disabled={loading}>加载下一页</button> : null}
      </article>
      <article className="panel clearing-detail-panel" aria-live="polite" aria-busy={detailLoading}>
        {detailLoading ? <LoadingState label="正在读取申请明细" /> : detail ? <RequestDetail detail={detail} /> : <EmptyState title="选择一笔申请" detail="查看申请金额、状态、到账记录和核验信息。" />}
      </article>
    </div>
  </section>;
}

const emptyTransferFilters: AdminSettlementTransferFilters = { limit: 25 };

function TransferWorkspace({ token }: { token: string }) {
  const [draft, setDraft] = useState<AdminSettlementTransferFilters>(emptyTransferFilters);
  const [applied, setApplied] = useState<AdminSettlementTransferFilters>(emptyTransferFilters);
  const [result, setResult] = useState<AdminSettlementTransferList | null>(null);
  const [detail, setDetail] = useState<AdminSettlementTransferDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);

  const load = async (filters: AdminSettlementTransferFilters, append = false) => {
    setLoading(true); setError(null);
    try {
      const next = await fetchAdminSettlementTransfers(filters, token);
      setResult((current) => append && current ? { ...next, transfers: [...current.transfers, ...next.transfers] } : next);
      setApplied(filters);
    } catch (cause) { setError(asCoreError(cause, '结算转账列表暂时无法连接')); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(emptyTransferFilters); }, [token]);

  const select = async (transferId: string) => {
    setDetailLoading(true); setError(null); setDetail(null);
    try { setDetail(await fetchAdminSettlementTransfer(transferId, token)); }
    catch (cause) { setError(asCoreError(cause, '结算转账详情暂时无法连接')); }
    finally { setDetailLoading(false); }
  };

  const more = () => {
    if (!result?.nextCursor) return;
    void load({ ...applied, cursorCreatedAt: result.nextCursor.createdAt, cursorTransferId: result.nextCursor.transferId }, true);
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">结算转账查询</p><h2>结算转账</h2></div><Landmark aria-hidden="true" /></div>
      <form className="clearing-filter-grid" onSubmit={(event) => { event.preventDefault(); setDetail(null); void load({ ...draft, cursorCreatedAt: undefined, cursorTransferId: undefined }); }}>
        <TextFilter label="转账编号" value={draft.transferId} setValue={(value) => setDraft({ ...draft, transferId: value })} />
        <TextFilter label="商家编号" value={draft.merchantId} setValue={(value) => setDraft({ ...draft, merchantId: value })} />
        <TextFilter label="订单编号" value={draft.orderId} setValue={(value) => setDraft({ ...draft, orderId: value })} />
        <TextFilter label="平台打款账户" value={draft.executorWallet} setValue={(value) => setDraft({ ...draft, executorWallet: value })} />
        <TextFilter label="到账记录" value={draft.executionTxHash} setValue={(value) => setDraft({ ...draft, executionTxHash: value })} />
        <label>资产<select value={draft.asset ?? ''} onChange={(event) => setDraft({ ...draft, asset: (event.target.value || undefined) as SettlementAsset | undefined })}><option value="">全部</option><option>USDT</option><option>NPL</option></select></label>
        <label>状态<select value={draft.state ?? ''} onChange={(event) => setDraft({ ...draft, state: (event.target.value || undefined) as SettlementTransferState | undefined })}><option value="">全部</option>{settlementTransferStates.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label>
        <DateFilter label="开始时间" setValue={(value) => setDraft({ ...draft, from: value })} />
        <DateFilter label="结束时间" setValue={(value) => setDraft({ ...draft, to: value })} />
        <label>数量<input type="number" min="1" max="100" value={draft.limit ?? 25} onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })} /></label>
        <button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" />{loading ? '查询中' : '查询'}</button>
      </form>
    </article>
    {error ? <ErrorView error={error} /> : null}
    <div className="clearing-master-detail clearing-batch-layout">
      <article className="panel clearing-list-panel" aria-busy={loading}>
        <div className="panel-heading"><div><p className="section-kicker">转账列表</p><h2>转账列表</h2></div><span className="status-chip">{result?.transfers.length ?? 0} 条</span></div>
        {loading && !result ? <LoadingState label="正在读取转账列表" /> : null}
        {result?.transfers.length ? <div className="clearing-list">{result.transfers.map((item) => <button key={item.transferId} className={detail?.transfer.transferId === item.transferId ? 'clearing-list-row is-selected' : 'clearing-list-row'} type="button" onClick={() => void select(item.transferId)}><span><strong>{item.asset} · 平台处理号 {item.executorNonce}</strong><small>{shortHash(item.transferId)}</small><small>{formatDateTime(item.createdAt)}</small></span><span><StateChip state={item.state} /> <small>{formatSettlementAmount(item.amount, item.asset)}</small></span></button>)}</div> : !loading ? <EmptyState title="暂无结算转账" detail="当前筛选下没有记录。" /> : null}
        {result?.nextCursor ? <button className="button button-quiet button-full" type="button" onClick={more} disabled={loading}>加载下一页</button> : null}
      </article>
      <article className="panel clearing-detail-panel" aria-live="polite" aria-busy={detailLoading}>
        {detailLoading ? <LoadingState label="正在读取转账详情" /> : detail ? <TransferDetail detail={detail} /> : <EmptyState title="选择一笔转账" detail="查看到账状态、金额、收款地址和核验信息。" />}
      </article>
    </div>
  </section>;
}

function RequestDetail({ detail }: { detail: AdminSettlementRequestDetail }) {
  const request = detail.request;
  return <div className="clearing-detail-stack">
    <div className="panel-heading"><div><p className="section-kicker">结算申请详情</p><h2>{railLabel(request.rail)} · {stateLabel(request.state)}</h2></div><StateChip state={request.state} /></div>
    <dl className="definition-grid clearing-facts">
      <Fact label="申请编号" value={request.requestId} code />
      <Fact label="申请钱包 / 收款钱包" value={shortAddress(request.walletAddress)} note={shortAddress(request.recipientAddress)} />
      <Fact label="资产 / 金额" value={`${request.asset} · ${formatSettlementAmount(request.amount, request.asset)}`} />
      <Fact label="平台打款记录" value={shortAddress(request.executorWallet)} note={`${request.transferIds.length} 笔转账`} />
      <Fact
        label="到账记录"
        value={request.finalExecutionTxHashes.length ? '已到账' : '未到账'}
        note={`${request.finalExecutionTxHashes.length} 笔已确认交易`}
      />
      <Fact label="申请 / 到账时间" value={formatDateTime(request.requestedAt)} note={formatDateTime(request.settledAt) || '未结算'} />
    </dl>
    <details className="technical-details">
      <summary>申请核验信息</summary>
      <dl className="definition-grid clearing-facts">
        <Fact label="申请摘要" value={request.intentDigest} code />
        <Fact label="签名摘要" value={request.signatureHash} code />
      </dl>
      <EvidenceTable title="申请明细" headers={['序号 / 订单', '金额', '规则 / 凭证', '账本']}>
        {detail.items.map((item) => <tr key={item.itemIndex}><td><strong>#{item.itemIndex}</strong><code>{shortHash(item.orderId)}</code></td><td>{formatSettlementAmount(item.amount, request.asset)}<small>{shortAddress(item.backingWalletAddress)}</small></td><td>规则已绑定<small>编号 {item.policyVersion}</small><code>{shortHash(item.itemHash)}</code></td><td><code>{shortHash(item.journals.requested)}</code><small>{shortHash(item.journals.submitted) || '未提交'} / {shortHash(item.journals.settled) || '未结算'}</small></td></tr>)}
      </EvidenceTable>
      <EvidenceTable title="状态变更记录" headers={['序号', '类型', '转账', '账本 / 时间']}>
        {detail.transitions.map((item) => <tr key={item.transitionId}><td>#{item.sequence}<small>item {item.requestItemIndex}</small></td><td>{transitionTypeLabel(item.type)}</td><td><code>{shortHash(item.transferId) || '无'}</code></td><td><code>{shortHash(item.journalId)}</code><small>{item.createdAt}</small></td></tr>)}
      </EvidenceTable>
    </details>
  </div>;
}

function TransferDetail({ detail }: { detail: AdminSettlementTransferDetail }) {
  const transfer = detail.transfer;
  return <div className="clearing-detail-stack">
    <div className="panel-heading"><div><p className="section-kicker">转账详情</p><h2>{transfer.asset} · {stateLabel(transfer.state)}</h2></div><StateChip state={transfer.state} /></div>
    <dl className="definition-grid clearing-facts">
      <Fact label="转账编号" value={transfer.transferId} code />
      <Fact label="收款地址 / 金额" value={shortAddress(transfer.recipientAddress)} note={formatSettlementAmount(transfer.amount, transfer.asset)} />
      <Fact label="平台打款账户" value={shortAddress(transfer.executorWallet)} note={`平台处理号 ${transfer.executorNonce}`} />
      <Fact label="到账记录" value={transfer.executionTxHash ? '已提交' : '未提交'} />
    </dl>
    <FinalityEvidence detail={detail} />
    <details className="technical-details">
      <summary>转账核验信息</summary>
      <dl className="definition-grid clearing-facts">
        <Fact label="转账内容摘要" value={transfer.contentHash} note={`申请 ${shortHash(transfer.requestId)}`} code />
        <Fact label="运行凭证" value={transfer.runtimeEvidenceHash} note={transfer.runtimeCheckedAt} code />
        <Fact label="代币校验" value={transfer.tokenCodeHash} note={shortHash(transfer.tokenTransferConformanceEvidenceHash)} code />
      </dl>
      <section className="clearing-evidence-grid" aria-label="覆盖率、熔断与对账">
        <article className={detail.coverage?.covered ? 'clearing-evidence is-ok' : 'clearing-evidence is-alert'}><span>覆盖检查</span><strong>{detail.coverage ? detail.coverage.covered ? '已覆盖' : '低于 100%' : '未返回数据'}</strong>{detail.coverage ? <><small>{formatSettlementAmount(detail.coverage.verifiedAssets, transfer.asset)} / {formatSettlementAmount(detail.coverage.unsettledLiabilities, transfer.asset)}</small><code>{shortHash(detail.coverage.evidenceHash)}</code></> : <small>系统未返回覆盖快照</small>}</article>
        <article className={detail.breakers.some((item) => item.paused) ? 'clearing-evidence is-alert' : 'clearing-evidence is-ok'}><span>暂停开关</span><strong>{detail.breakers.some((item) => item.paused) ? '部分暂停' : '全部打开'}</strong>{detail.breakers.map((item) => <small key={item.scope}>{breakerScopeLabel(item.scope)}：{item.paused ? '暂停' : '打开'}</small>)}</article>
        <article className={detail.reconciliation.conserved ? 'clearing-evidence is-ok' : 'clearing-evidence is-alert'}><span>系统对账</span><strong>{detail.reconciliation.conserved ? '金额守恒' : '金额不一致'}</strong><small>{detail.reconciliation.actualItemCount}/{detail.reconciliation.expectedItemCount} 项</small><small>{formatSettlementAmount(detail.reconciliation.actualTotalAmount, transfer.asset)} / {formatSettlementAmount(detail.reconciliation.expectedTotalAmount, transfer.asset)}</small></article>
      </section>
      <EvidenceTable title="系统打款尝试记录" headers={['尝试', '状态', '交易 / 打款账户', '替换 / 更新时间']}>
        {detail.attempts.map((item) => <tr key={item.attemptId}><td>#{item.attemptNumber}<code>{shortHash(item.attemptId)}</code></td><td><StateChip state={item.state} /></td><td><code>{shortHash(item.executionTxHash) || '未提交'}</code><small>{shortAddress(item.executorWallet)} · 处理号 {item.executorNonce}</small></td><td>{shortHash(item.replacementForAttemptId) || '原始尝试'}<small>{formatDateTime(item.updatedAt)}</small></td></tr>)}
      </EvidenceTable>
      <EvidenceTable title="账本对账" headers={['事件', '资产', '借方', '贷方 / 是否平衡']}>
        {detail.reconciliation.ledgerMovements.map((item, index) => <tr key={`${item.eventType}:${index}`}><td>{eventTypeLabel(item.eventType)}</td><td>{item.asset}</td><td>{formatSettlementAmount(item.debits, item.asset)}</td><td>{formatSettlementAmount(item.credits, item.asset)}<small>{item.balanced ? '已平衡' : '不一致'}</small></td></tr>)}
      </EvidenceTable>
    </details>
  </div>;
}

function FinalityEvidence({ detail }: { detail: AdminSettlementTransferDetail }) {
  const finality = detail.finality;
  if (!finality) return <div className="resource-state clearing-inline-state"><AlertTriangle aria-hidden="true" /><div><strong>到账最终确认尚未提交</strong><p>转账状态为 {stateLabel(detail.transfer.state)}，系统还没有返回最终确认。</p></div></div>;
  const failed = ['FAILED', 'REORGED'].includes(finality.state);
  const final = finality.state === 'FINAL' && finality.confirmations >= 15;
  const label = final ? `已最终确认 · ${finality.confirmations}/15` : finality.state === 'MINED' ? `确认中 · ${finality.confirmations}/15` : stateLabel(finality.state);
  return <section className={failed ? 'clearing-finality is-failed' : final ? 'clearing-finality is-final' : 'clearing-finality is-pending'} aria-label="到账最终确认">
    {failed ? <AlertTriangle aria-hidden="true" /> : final ? <CheckCircle2 aria-hidden="true" /> : <LoaderCircle aria-hidden="true" />}
    <div><span>到账最终确认</span><strong>{label}</strong><small>到账记录 {receiptStatusLabel(finality.receiptStatus)}</small></div>
    <details className="technical-details compact">
      <summary>最终确认核验信息</summary>
      <code title={finality.executionTxHash}>{shortHash(finality.executionTxHash)}</code>
      <small>区块 {finality.blockNumber ?? '未打包'} · 预期事件 {shortHash(finality.expectedEventHash)}{finality.replacementForTxHash ? ` · 替换 ${shortHash(finality.replacementForTxHash)}` : ''}</small>
    </details>
  </section>;
}

function PaymentProjectionView({ projection }: { projection: PaymentProjection }) {
  const intents = 'intent' in projection
    ? [{ label: '普通订单', intent: projection.intent }]
    : [{ label: '秒杀订单', intent: projection.dual.seckill }, { label: '普通价成交', intent: projection.dual.fallback }];
  return <section className="trace-results" aria-live="polite">
    <article className="panel trace-summary"><div className="panel-heading"><div><p className="section-kicker">支付记录</p><h2>{stateLabel(projection.state)}</h2></div><span className="status-chip status-ready"><RefreshCw aria-hidden="true" />系统返回</span></div><dl className="definition-grid"><Fact label="订单编号" value={projection.orderId} code /><Fact label="付款提交" value={projection.submittedTxHash ? '钱包付款已提交' : '尚未提交'} /></dl><details className="technical-details compact"><summary>支付核验信息</summary><dl className="definition-grid"><Fact label="钱包付款编号" value={projection.submittedTxHash ?? '尚未提交'} code /><Fact label="支付路由" value={projection.paymentRouterAddress} code /><Fact label="系统版本" value={projection.artifactVersion} /><Fact label="调用方法" value={projection.routerCall.functionName} /></dl></details></article>
    {intents.map(({ label, intent }) => <PaymentIntentPanel key={label} label={label} intent={intent} />)}
    <article className="panel finality-panel"><p className="section-kicker">最终确认</p><h2>{projection.finality ? stateLabel(projection.finality.state) : '尚未提交'}</h2>{projection.finality ? <><dl className="definition-grid"><Fact label="成交分类" value={classificationLabel(projection.finality.classification)} /><Fact label="确认进度" value={`${projection.finality.confirmations} / ${projection.finality.requiredConfirmations}`} /><Fact label="是否已确认" value={projection.finality.canonicalBlock ? '是' : '否'} /></dl><details className="technical-details compact"><summary>确认核验信息</summary><dl className="definition-grid"><Fact label="区块" value={String(projection.finality.blockNumber)} /><Fact label="交易记录" value={projection.finality.transactionHash} code /><Fact label="区块凭证" value={projection.finality.blockHash} code /></dl></details></> : <p className="muted-copy">系统还没有返回最终确认凭证。</p>}</article>
  </section>;
}

function PaymentIntentPanel({ label, intent }: { label: string; intent: CanonicalPaymentIntent }) {
  return <article className="panel intent-panel"><p className="section-kicker">{label}支付快照</p><h2>金额快照</h2><dl className="definition-grid"><Fact label="数量" value={String(intent.quantity)} /><Fact label="商品标价" value={formatUsdt(intent.listPriceUsdt)} /><Fact label="商品 USDT" value={formatUsdt(intent.productUsdtPaymentAmount)} /><Fact label="运费 USDT" value={formatUsdt(intent.freightUsdt)} /><Fact label="买家 USDT" value={formatUsdt(intent.usdtPaymentAmount)} /><Fact label="买家 NPL" value={formatNpl(intent.nplPaymentAmount)} /><Fact label="NPL 销毁" value={formatNpl(intent.nplBurnAmount)} /><Fact label="NPL 奖励" value={formatNpl(intent.nplRewardAmount)} /><Fact label="商家净应收" value={formatUsdt(intent.merchantNetReceivableUsdt)} /></dl><details className="technical-details compact"><summary>规则与预留核验信息</summary><dl className="definition-grid"><Fact label="规则编号" value={String(intent.policyVersion)} /><Fact label="预留编号" value={intent.reservationId} code /><Fact label="预留截止" value={String(intent.reservationDeadline)} /></dl></details></article>;
}

function ViewTab({ active, children, onClick }: { active: boolean; children: ReactNode; onClick(): void }) {
  return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : undefined} onClick={onClick}>{children}</button>;
}

function TextFilter({ label, value, setValue }: { label: string; value: string | undefined; setValue(value: string | undefined): void }) {
  return <label>{label}<input value={value ?? ''} onChange={(event) => setValue(event.target.value || undefined)} autoComplete="off" /></label>;
}

function DateFilter({ label, setValue }: { label: string; setValue(value: string | undefined): void }) {
  return <label>{label}<input type="datetime-local" onChange={(event) => setValue(event.target.value ? new Date(event.target.value).toISOString() : undefined)} /></label>;
}

function Fact({ code = false, label, note, value }: { code?: boolean; label: string; note?: string; value: string }) {
  return <div><dt>{label}</dt><dd>{code ? <code title={value}>{shortHash(value)}</code> : value}{note ? <small>{note}</small> : null}</dd></div>;
}


function formatDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function receiptStatusLabel(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '未返回';
  if (value === 1 || value === '1' || value === 'SUCCESS') return '成功';
  if (value === 0 || value === '0' || value === 'FAILED' || value === 'REVERTED') return '失败';
  if (value === 'PENDING') return '确认中';
  return String(value);
}

function StateChip({ state }: { state: string }) {
  const danger = ['FAILED', 'REORGED', 'QUARANTINED'].includes(state);
  const ready = ['FINAL', 'SETTLED'].includes(state);
  return <span className={`status-chip ${danger ? 'status-blocked' : ready ? 'status-ready' : ''}`}>{danger ? <AlertTriangle aria-hidden="true" /> : ready ? <CheckCircle2 aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{stateLabel(state)}</span>;
}

function EvidenceTable({ children, headers, title }: { children: ReactNode; headers: readonly string[]; title: string }) {
  return <section className="clearing-table-section"><h3>{title}</h3><div className="table-scroll"><table className="data-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div></section>;
}

function LoadingState({ label }: { label: string }) {
  return <div className="resource-state clearing-inline-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>等待系统真实响应，不显示测试数据或推测状态。</p></div></div>;
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return <div className="clearing-empty"><Search aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></div>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error clearing-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p>{error.correlationId ? <details className="technical-details compact"><summary>错误编号</summary><code>{error.correlationId}</code></details> : null}</div></div>;
}

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}

function formatSettlementAmount(amount: string | null | undefined, asset: string) {
  if (asset === 'USDT') return formatUsdt(amount);
  if (asset === 'NPL') return formatNpl(amount);
  if (asset === 'BNM' || asset === 'BNM_POINTS') return formatBnm(amount);
  return formatTokenAmount(amount, asset);
}

function shortHash(value: string | null | undefined) {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortAddress(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function railLabel(value: string) {
  return ({
    MERCHANT_USDT: '商家货款',
    REWARD_NPL: 'NPL 奖励',
    PRIZE_USDT: '秒杀大奖',
    TAKEOVER_USDT: '接管垫付',
    OPERATIONS_REIMBURSEMENT_USDT: '运营报销',
  } as Record<string, string>)[value] ?? value;
}

function stateLabel(value: string) {
  return ({
    REQUESTED: '已申请',
    SUBMITTED: '已提交',
    SETTLED: '已到账',
    FINAL: '已最终确认',
    MINED: '确认中',
    PENDING: '处理中',
    RETRYABLE: '等待重试',
    FAILED: '失败',
    REORGED: '已回滚',
    QUARANTINED: '已隔离',
    NOT_SUBMITTED: '未提交',
  } as Record<string, string>)[value] ?? value;
}

function classificationLabel(value: string) {
  return ({
    ORDINARY: '普通订单',
    SECKILL: '秒杀订单',
    FALLBACK_RETAIL: '普通价成交',
  } as Record<string, string>)[value] ?? value;
}

function transitionTypeLabel(value: string) {
  return ({
    REQUESTED: '发起申请',
    SUBMITTED: '提交转账',
    SETTLED: '已到账',
    EXECUTION_REVERSED: '执行回滚',
    FINALITY_REVERSED: '最终确认回滚',
  } as Record<string, string>)[value] ?? value;
}

function eventTypeLabel(value: string) {
  return ({
    REQUESTED: '发起申请',
    SUBMITTED: '提交转账',
    SETTLED: '已到账',
  } as Record<string, string>)[value] ?? value;
}

function breakerScopeLabel(value: string) {
  return ({
    NEW_PAYMENT: '新支付',
    SECKILL_PURCHASE: '秒杀购买',
    SETTLEMENT_TRANSFER: '结算转账',
  } as Record<string, string>)[value] ?? value;
}

function roleLabel(value: string) {
  return ({
    ADMIN: '管理员',
    OPERATOR: '运营',
    AUDITOR: '审计',
    MERCHANT: '商家',
    BUYER: '买家',
  } as Record<string, string>)[value] ?? value;
}

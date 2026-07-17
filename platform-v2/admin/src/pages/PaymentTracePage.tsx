import type {
  AdminSettlementBatchDetail,
  AdminSettlementBatchList,
  AdminSettlementRequestDetail,
  AdminSettlementRequestList,
  CanonicalPaymentIntent,
  PaymentProjection,
  SettlementBatchState,
  SettlementRequestState,
  SettlementRail,
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
import {
  fetchAdminSettlementBatch,
  fetchAdminSettlementBatches,
  fetchAdminSettlementRequest,
  fetchAdminSettlementRequests,
  fetchGlobalPaymentTrace,
  settlementBatchStates,
  settlementRails,
  settlementRequestStates,
  type AdminSettlementBatchFilters,
  type AdminSettlementRequestFilters,
  type SettlementAsset,
} from '../settlementClearingApi';

type View = 'PAYMENT' | 'REQUESTS' | 'BATCHES';
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
          <p className="eyebrow">GLOBAL CLEARING EVIDENCE</p>
          <h1>全局清算审计</h1>
          <p>按订单、签名结算申请和不可变 Safe 批次追踪 Core 证据。金额、守恒、权限与终态均不在浏览器计算。</p>
        </div>
        <div className="requirement-list"><code>ADM-CLEAR-001 / 002 / 004</code><code>ADM-CLEAR-005 / 006 / 007</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt clearing-session-gate" role="status" aria-label="清算工作台状态">
          <div><strong>连接平台授权钱包</strong><p>ADMIN、OPERATOR、AUDITOR 只读；页面不提供转账、组批或执行按钮。</p></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}
          </button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有全局清算读取权限', status: 403 })} />
      ) : (
        <>
          <section className="clearing-toolbar" aria-label="清算工作区导航">
            <div className="merchant-status-tabs" role="tablist" aria-label="清算视图">
              <ViewTab active={view === 'PAYMENT'} onClick={() => setView('PAYMENT')}>支付穿透</ViewTab>
              <ViewTab active={view === 'REQUESTS'} onClick={() => setView('REQUESTS')}>结算申请</ViewTab>
              <ViewTab active={view === 'BATCHES'} onClick={() => setView('BATCHES')}>Safe 批次</ViewTab>
            </div>
            <span className="status-chip status-ready"><ShieldCheck aria-hidden="true" />{session.roles.join(' / ')} · READ ONLY</span>
          </section>
          {view === 'PAYMENT' ? <PaymentWorkspace token={session.token} /> : null}
          {view === 'REQUESTS' ? <RequestWorkspace token={session.token} /> : null}
          {view === 'BATCHES' ? <BatchWorkspace token={session.token} /> : null}
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
    catch (cause) { setError(asCoreError(cause, '全局支付投影不可用')); }
    finally { setLoading(false); }
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/payments/{'{orderId}'}</p><h2>独立于买家钱包的支付追踪</h2></div><CircleDollarSign aria-hidden="true" /></div>
      <form className="trace-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="clearing-order-id">Order ID · bytes32</label>
        <div><input id="clearing-order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" required /><button className="button button-primary" type="submit" disabled={loading || !orderId.trim()}><Search aria-hidden="true" />{loading ? '读取中' : '读取支付证据'}</button></div>
      </form>
      {loading ? <LoadingState label="正在读取支付、Router 和最终性证据" /> : null}
      {error ? <ErrorView error={error} /> : null}
      {!loading && !error && !projection ? <EmptyState title="等待 Order ID" detail="Core 只接受精确 bytes32，不提供钱包模糊搜索。" /> : null}
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
    } catch (cause) { setError(asCoreError(cause, '结算申请列表不可用')); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(emptyRequestFilters); }, [token]);

  const select = async (requestId: string) => {
    setDetailLoading(true); setError(null); setDetail(null);
    try { setDetail(await fetchAdminSettlementRequest(requestId, token)); }
    catch (cause) { setError(asCoreError(cause, '结算申请详情不可用')); }
    finally { setDetailLoading(false); }
  };

  const more = () => {
    if (!result?.nextCursor) return;
    void load({ ...applied, cursorRequestedAt: result.nextCursor.requestedAt, cursorRequestId: result.nextCursor.requestId }, true);
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/settlement-requests</p><h2>全局签名结算申请</h2></div><FileSignature aria-hidden="true" /></div>
      <form className="clearing-filter-grid" onSubmit={(event) => { event.preventDefault(); setDetail(null); void load({ ...draft, cursorRequestedAt: undefined, cursorRequestId: undefined }); }}>
        <TextFilter label="Request ID" value={draft.requestId} setValue={(value) => setDraft({ ...draft, requestId: value })} />
        <TextFilter label="Merchant ID" value={draft.merchantId} setValue={(value) => setDraft({ ...draft, merchantId: value })} />
        <TextFilter label="Wallet address" value={draft.walletAddress} setValue={(value) => setDraft({ ...draft, walletAddress: value })} />
        <TextFilter label="Order ID" value={draft.orderId} setValue={(value) => setDraft({ ...draft, orderId: value })} />
        <TextFilter label="Batch ID" value={draft.batchId} setValue={(value) => setDraft({ ...draft, batchId: value })} />
        <TextFilter label="Safe TxHash" value={draft.safeTxHash} setValue={(value) => setDraft({ ...draft, safeTxHash: value })} />
        <label>Rail<select value={draft.rail ?? ''} onChange={(event) => setDraft({ ...draft, rail: (event.target.value || undefined) as SettlementRail | undefined })}><option value="">全部</option>{settlementRails.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Asset<select value={draft.asset ?? ''} onChange={(event) => setDraft({ ...draft, asset: (event.target.value || undefined) as SettlementAsset | undefined })}><option value="">全部</option><option>USDT</option><option>NPL</option></select></label>
        <label>State<select value={draft.state ?? ''} onChange={(event) => setDraft({ ...draft, state: (event.target.value || undefined) as SettlementRequestState | undefined })}><option value="">全部</option>{settlementRequestStates.map((value) => <option key={value}>{value}</option>)}</select></label>
        <DateFilter label="Start" setValue={(value) => setDraft({ ...draft, from: value })} />
        <DateFilter label="End" setValue={(value) => setDraft({ ...draft, to: value })} />
        <label>Limit<input type="number" min="1" max="100" value={draft.limit ?? 25} onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })} /></label>
        <button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" />{loading ? '查询中' : '服务端筛选'}</button>
      </form>
    </article>
    {error ? <ErrorView error={error} /> : null}
    <div className="clearing-master-detail">
      <article className="panel clearing-list-panel" aria-busy={loading}>
        <div className="panel-heading"><div><p className="section-kicker">Request cursor</p><h2>申请列表</h2></div><span className="status-chip">{result?.requests.length ?? 0} rows</span></div>
        {loading && !result ? <LoadingState label="正在读取申请列表" /> : null}
        {result?.requests.length ? <div className="clearing-list">{result.requests.map((item) => <button key={item.requestId} className={detail?.request.requestId === item.requestId ? 'clearing-list-row is-selected' : 'clearing-list-row'} type="button" onClick={() => void select(item.requestId)}><span><strong>{item.rail} · {item.asset}</strong><small>{item.requestId}</small><small>{item.merchantId ?? '非商家 rail'} · {item.walletAddress}</small></span><span><StateChip state={item.state} /> <small>{item.amount} atomic</small></span></button>)}</div> : !loading ? <EmptyState title="无结算申请" detail="Core 对当前组合筛选返回真实空结果。" /> : null}
        {result?.nextCursor ? <button className="button button-quiet button-full" type="button" onClick={more} disabled={loading}>加载下一页</button> : null}
      </article>
      <article className="panel clearing-detail-panel" aria-live="polite" aria-busy={detailLoading}>
        {detailLoading ? <LoadingState label="正在读取不可变申请明细" /> : detail ? <RequestDetail detail={detail} /> : <EmptyState title="选择一笔申请" detail="查看 item hash、policyVersion、journal 和状态迁移。" />}
      </article>
    </div>
  </section>;
}

const emptyBatchFilters: AdminSettlementBatchFilters = { limit: 25 };

function BatchWorkspace({ token }: { token: string }) {
  const [draft, setDraft] = useState<AdminSettlementBatchFilters>(emptyBatchFilters);
  const [applied, setApplied] = useState<AdminSettlementBatchFilters>(emptyBatchFilters);
  const [result, setResult] = useState<AdminSettlementBatchList | null>(null);
  const [detail, setDetail] = useState<AdminSettlementBatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);

  const load = async (filters: AdminSettlementBatchFilters, append = false) => {
    setLoading(true); setError(null);
    try {
      const next = await fetchAdminSettlementBatches(filters, token);
      setResult((current) => append && current ? { ...next, batches: [...current.batches, ...next.batches] } : next);
      setApplied(filters);
    } catch (cause) { setError(asCoreError(cause, 'Safe 结算批次列表不可用')); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(emptyBatchFilters); }, [token]);

  const select = async (batchId: string) => {
    setDetailLoading(true); setError(null); setDetail(null);
    try { setDetail(await fetchAdminSettlementBatch(batchId, token)); }
    catch (cause) { setError(asCoreError(cause, 'Safe 结算批次详情不可用')); }
    finally { setDetailLoading(false); }
  };

  const more = () => {
    if (!result?.nextCursor) return;
    void load({ ...applied, cursorCreatedAt: result.nextCursor.createdAt, cursorBatchId: result.nextCursor.batchId }, true);
  };

  return <section className="clearing-stack">
    <article className="panel clearing-query">
      <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/settlement-batches</p><h2>不可变 Safe MultiSend 批次</h2></div><Landmark aria-hidden="true" /></div>
      <form className="clearing-filter-grid" onSubmit={(event) => { event.preventDefault(); setDetail(null); void load({ ...draft, cursorCreatedAt: undefined, cursorBatchId: undefined }); }}>
        <TextFilter label="Batch ID" value={draft.batchId} setValue={(value) => setDraft({ ...draft, batchId: value })} />
        <TextFilter label="Merchant ID" value={draft.merchantId} setValue={(value) => setDraft({ ...draft, merchantId: value })} />
        <TextFilter label="Order ID" value={draft.orderId} setValue={(value) => setDraft({ ...draft, orderId: value })} />
        <TextFilter label="Safe address" value={draft.safeAddress} setValue={(value) => setDraft({ ...draft, safeAddress: value })} />
        <TextFilter label="Safe TxHash" value={draft.safeTxHash} setValue={(value) => setDraft({ ...draft, safeTxHash: value })} />
        <label>Asset<select value={draft.asset ?? ''} onChange={(event) => setDraft({ ...draft, asset: (event.target.value || undefined) as SettlementAsset | undefined })}><option value="">全部</option><option>USDT</option><option>NPL</option></select></label>
        <label>State<select value={draft.state ?? ''} onChange={(event) => setDraft({ ...draft, state: (event.target.value || undefined) as SettlementBatchState | undefined })}><option value="">全部</option>{settlementBatchStates.map((value) => <option key={value}>{value}</option>)}</select></label>
        <DateFilter label="Start" setValue={(value) => setDraft({ ...draft, from: value })} />
        <DateFilter label="End" setValue={(value) => setDraft({ ...draft, to: value })} />
        <label>Limit<input type="number" min="1" max="100" value={draft.limit ?? 25} onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })} /></label>
        <button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" />{loading ? '查询中' : '服务端筛选'}</button>
      </form>
    </article>
    {error ? <ErrorView error={error} /> : null}
    <div className="clearing-master-detail clearing-batch-layout">
      <article className="panel clearing-list-panel" aria-busy={loading}>
        <div className="panel-heading"><div><p className="section-kicker">Batch cursor</p><h2>批次列表</h2></div><span className="status-chip">{result?.batches.length ?? 0} rows</span></div>
        {loading && !result ? <LoadingState label="正在读取批次列表" /> : null}
        {result?.batches.length ? <div className="clearing-list">{result.batches.map((item) => <button key={item.batchId} className={detail?.batch.batchId === item.batchId ? 'clearing-list-row is-selected' : 'clearing-list-row'} type="button" onClick={() => void select(item.batchId)}><span><strong>{item.asset} · nonce {item.safeNonce}</strong><small>{item.batchId}</small><small>{item.contentHash}</small></span><span><StateChip state={item.state} /> <small>{item.approvalCount}/{item.approvalThreshold} approvals</small></span></button>)}</div> : !loading ? <EmptyState title="无 Safe 批次" detail="Core 对当前组合筛选返回真实空结果。" /> : null}
        {result?.nextCursor ? <button className="button button-quiet button-full" type="button" onClick={more} disabled={loading}>加载下一页</button> : null}
      </article>
      <article className="panel clearing-detail-panel" aria-live="polite" aria-busy={detailLoading}>
        {detailLoading ? <LoadingState label="正在读取 Safe、链上和账本证据" /> : detail ? <BatchDetail detail={detail} /> : <EmptyState title="选择一个批次" detail="查看内容哈希、审批、执行替换、最终性、覆盖率与对账。" />}
      </article>
    </div>
  </section>;
}

function RequestDetail({ detail }: { detail: AdminSettlementRequestDetail }) {
  const request = detail.request;
  return <div className="clearing-detail-stack">
    <div className="panel-heading"><div><p className="section-kicker">Immutable request</p><h2>{request.rail} · {request.state}</h2></div><StateChip state={request.state} /></div>
    <dl className="definition-grid clearing-facts">
      <Fact label="Request ID" value={request.requestId} code />
      <Fact label="Wallet / recipient" value={request.walletAddress} note={request.recipientAddress} code />
      <Fact label="Asset / amount" value={`${request.asset} · ${request.amount}`} note="Core atomic value" />
      <Fact label="Safe / batch" value={request.safeAddress} note={request.batchId ?? '未组批'} code />
      <Fact label="Intent digest" value={request.intentDigest} code />
      <Fact label="Signature hash" value={request.signatureHash} code />
      <Fact label="Final Safe TxHash" value={request.finalSafeTxHash ?? '未终局'} note={request.finalExecutionTxHash ?? '无 execution TxHash'} code />
      <Fact label="Requested / settled" value={request.requestedAt} note={request.settledAt ?? '未结算'} />
    </dl>
    <EvidenceTable title="不可变申请 items" headers={['Index / order', 'Amount', 'Policy / item hash', 'Journals']}>
      {detail.items.map((item) => <tr key={item.itemIndex}><td><strong>#{item.itemIndex}</strong><code>{item.orderId}</code></td><td>{item.amount}<small>atomic</small></td><td>{item.policyVersion}<code>{item.itemHash}</code></td><td><code>{item.journals.requested}</code><small>{item.journals.batched ?? '未组批'} / {item.journals.settled ?? '未结算'}</small></td></tr>)}
    </EvidenceTable>
    <EvidenceTable title="追加式状态迁移" headers={['Sequence', 'Type', 'Batch', 'Journal / time']}>
      {detail.transitions.map((item) => <tr key={item.transitionId}><td>#{item.sequence}<small>item {item.requestItemIndex}</small></td><td>{item.type}</td><td><code>{item.batchId ?? '无'}</code></td><td><code>{item.journalId}</code><small>{item.createdAt}</small></td></tr>)}
    </EvidenceTable>
  </div>;
}

function BatchDetail({ detail }: { detail: AdminSettlementBatchDetail }) {
  const batch = detail.batch;
  return <div className="clearing-detail-stack">
    <div className="panel-heading"><div><p className="section-kicker">Immutable Safe envelope</p><h2>{batch.asset} · nonce {batch.safeNonce}</h2></div><StateChip state={batch.state} /></div>
    <dl className="definition-grid clearing-facts">
      <Fact label="Batch ID" value={batch.batchId} code />
      <Fact label="Content hash" value={batch.contentHash} note={`items hash ${batch.itemsHash}`} code />
      <Fact label="Safe / nonce" value={batch.safeAddress} note={`nonce ${batch.safeNonce} · chain ${batch.chainId}`} code />
      <Fact label="Total / items" value={`${batch.totalAmount} ${batch.asset} atomic`} note={`${batch.itemCount} items`} />
      <Fact label="Safe TxHash" value={batch.safeTxHash} note={batch.proposalReferenceHash ?? '无 proposal reference'} code />
      <Fact label="Approval" value={`${batch.approvalCount} / ${batch.approvalThreshold}`} note={batch.approvalEvidenceHash ?? '无 approval evidence'} code />
      <Fact label="Safe runtime evidence" value={batch.safeRuntimeEvidenceHash} note={`${batch.safeVersion} · ${batch.safeRuntimeCheckedAt}`} code />
      <Fact label="MultiSend / token conformance" value={batch.multisendCodeHash} note={batch.tokenTransferConformanceEvidenceHash} code />
    </dl>
    <FinalityEvidence detail={detail} />
    <section className="clearing-evidence-grid" aria-label="覆盖率、熔断与对账">
      <article className={detail.coverage?.covered ? 'clearing-evidence is-ok' : 'clearing-evidence is-alert'}><span>Coverage</span><strong>{detail.coverage ? detail.coverage.covered ? 'COVERED' : 'BELOW 100%' : 'UNAVAILABLE'}</strong>{detail.coverage ? <><small>{detail.coverage.verifiedAssets} assets / {detail.coverage.unsettledLiabilities} liabilities</small><code>{detail.coverage.evidenceHash}</code></> : <small>Core 未返回覆盖快照</small>}</article>
      <article className={detail.breakers.some((item) => item.paused) ? 'clearing-evidence is-alert' : 'clearing-evidence is-ok'}><span>Independent breakers</span><strong>{detail.breakers.some((item) => item.paused) ? 'PAUSED SCOPE' : 'ALL OPEN'}</strong>{detail.breakers.map((item) => <small key={item.scope}>{item.scope}: {item.paused ? 'PAUSED' : 'OPEN'}</small>)}</article>
      <article className={detail.reconciliation.conserved ? 'clearing-evidence is-ok' : 'clearing-evidence is-alert'}><span>Core reconciliation</span><strong>{detail.reconciliation.conserved ? 'CONSERVED' : 'MISMATCH'}</strong><small>{detail.reconciliation.actualItemCount}/{detail.reconciliation.expectedItemCount} items</small><small>{detail.reconciliation.actualTotalAmount}/{detail.reconciliation.expectedTotalAmount} atomic</small></article>
    </section>
    <EvidenceTable title="批次 transfer items" headers={['Index / request', 'Order / merchant', 'Recipient', 'Amount / item hash']}>
      {detail.items.map((item) => <tr key={item.itemIndex}><td>#{item.itemIndex}<code>{item.requestId}</code></td><td><code>{item.orderId}</code><small>{item.merchantId ?? '非商家 rail'}</small></td><td><code>{item.recipientAddress}</code></td><td>{item.amount}<code>{item.itemHash}</code></td></tr>)}
    </EvidenceTable>
    <EvidenceTable title="Safe owner approvals" headers={['Owner', 'Safe TxHash', 'Signature hash', 'Approved at']}>
      {detail.approvals.map((item) => <tr key={`${item.ownerAddress}:${item.approvedAt}`}><td><code>{item.ownerAddress}</code></td><td><code>{item.safeTxHash}</code></td><td><code>{item.signatureHash}</code></td><td>{item.approvedAt}</td></tr>)}
    </EvidenceTable>
    <EvidenceTable title="执行与替换尝试" headers={['Attempt', 'State', 'Execution / sender', 'Replacement / updated']}>
      {detail.attempts.map((item) => <tr key={item.attemptId}><td>#{item.attemptNumber}<code>{item.attemptId}</code></td><td><StateChip state={item.state} /></td><td><code>{item.executionTxHash ?? '未提交'}</code><small>{item.outerSender ?? '无 outer sender'} · nonce {item.outerNonce ?? '无'}</small></td><td>{item.replacementForAttemptId ?? '原始尝试'}<small>{item.updatedAt}</small></td></tr>)}
    </EvidenceTable>
    <EvidenceTable title="双录账本对账" headers={['Event', 'Asset', 'Debits', 'Credits / balanced']}>
      {detail.reconciliation.ledgerMovements.map((item, index) => <tr key={`${item.eventType}:${index}`}><td>{item.eventType}</td><td>{item.asset}</td><td>{item.debits}</td><td>{item.credits}<small>{item.balanced ? 'BALANCED' : 'MISMATCH'}</small></td></tr>)}
    </EvidenceTable>
  </div>;
}

function FinalityEvidence({ detail }: { detail: AdminSettlementBatchDetail }) {
  const finality = detail.finality;
  if (!finality) return <div className="resource-state clearing-inline-state"><AlertTriangle aria-hidden="true" /><div><strong>链上最终性尚未提交</strong><p>批次状态为 {detail.batch.state}，Core 未返回 transaction finality。</p></div></div>;
  const failed = ['FAILED', 'REORGED'].includes(finality.state);
  const final = finality.state === 'FINAL' && finality.confirmations >= 15;
  const label = final ? `FINAL · ${finality.confirmations}/15` : finality.state === 'MINED' ? `MINED · ${finality.confirmations}/15 · NOT FINAL` : finality.state;
  return <section className={failed ? 'clearing-finality is-failed' : final ? 'clearing-finality is-final' : 'clearing-finality is-pending'} aria-label="链上最终性">
    {failed ? <AlertTriangle aria-hidden="true" /> : final ? <CheckCircle2 aria-hidden="true" /> : <LoaderCircle aria-hidden="true" />}
    <div><span>Core transaction finality</span><strong>{label}</strong><small>Receipt {finality.receiptStatus ?? '未回执'} · block {finality.blockNumber ?? '未打包'}</small></div>
    <code>{finality.executionTxHash}</code>
    <small>Expected event {finality.expectedEventHash}{finality.replacementForTxHash ? ` · replaces ${finality.replacementForTxHash}` : ''}</small>
  </section>;
}

function PaymentProjectionView({ projection }: { projection: PaymentProjection }) {
  const intents = 'intent' in projection
    ? [{ label: 'Ordinary', intent: projection.intent }]
    : [{ label: 'Seckill', intent: projection.dual.seckill }, { label: 'Fallback retail', intent: projection.dual.fallback }];
  return <section className="trace-results" aria-live="polite">
    <article className="panel trace-summary"><div className="panel-heading"><div><p className="section-kicker">Authoritative Core projection</p><h2>{projection.state}</h2></div><span className="status-chip status-ready"><RefreshCw aria-hidden="true" />{projection.routerCall.functionName}</span></div><dl className="definition-grid"><Fact label="Order ID" value={projection.orderId} code /><Fact label="Submitted TxHash" value={projection.submittedTxHash ?? '尚未提交'} code /><Fact label="Router" value={projection.paymentRouterAddress} code /><Fact label="Artifact" value={projection.artifactVersion} /></dl></article>
    {intents.map(({ label, intent }) => <PaymentIntentPanel key={label} label={label} intent={intent} />)}
    <article className="panel finality-panel"><p className="section-kicker">Indexed finality</p><h2>{projection.finality?.state ?? 'NOT_SUBMITTED'}</h2>{projection.finality ? <dl className="definition-grid"><Fact label="Classification" value={projection.finality.classification} /><Fact label="Confirmations" value={`${projection.finality.confirmations} / ${projection.finality.requiredConfirmations}`} /><Fact label="Block" value={String(projection.finality.blockNumber)} /><Fact label="Canonical" value={projection.finality.canonicalBlock ? 'YES' : 'NO'} /><Fact label="TxHash" value={projection.finality.transactionHash} code /><Fact label="Block hash" value={projection.finality.blockHash} code /></dl> : <p className="muted-copy">Core 尚未返回链上最终性证据。</p>}</article>
  </section>;
}

function PaymentIntentPanel({ label, intent }: { label: string; intent: CanonicalPaymentIntent }) {
  return <article className="panel intent-panel"><p className="section-kicker">{label} intent</p><h2>政策与原子金额快照</h2><dl className="definition-grid"><Fact label="Policy version" value={String(intent.policyVersion)} /><Fact label="Reservation" value={intent.reservationId} code /><Fact label="Reservation deadline" value={String(intent.reservationDeadline)} /><Fact label="Quantity" value={String(intent.quantity)} /><Fact label="List price" value={intent.listPriceUsdt} note="USDT atomic" /><Fact label="Product USDT" value={intent.productUsdtPaymentAmount} note="atomic" /><Fact label="Freight USDT" value={intent.freightUsdt} note="atomic" /><Fact label="Buyer USDT" value={intent.usdtPaymentAmount} note="atomic" /><Fact label="Buyer NPL" value={intent.nplPaymentAmount} note="atomic" /><Fact label="NPL Burn" value={intent.nplBurnAmount} note="atomic" /><Fact label="NPL Reward Safe" value={intent.nplRewardAmount} note="atomic" /><Fact label="Merchant net receivable" value={intent.merchantNetReceivableUsdt} note="USDT atomic" /></dl></article>;
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
  return <div><dt>{label}</dt><dd>{code ? <code>{value}</code> : value}{note ? <small>{note}</small> : null}</dd></div>;
}

function StateChip({ state }: { state: string }) {
  const danger = ['FAILED', 'REORGED', 'QUARANTINED'].includes(state);
  const ready = ['FINAL', 'SETTLED'].includes(state);
  return <span className={`status-chip ${danger ? 'status-blocked' : ready ? 'status-ready' : ''}`}>{danger ? <AlertTriangle aria-hidden="true" /> : ready ? <CheckCircle2 aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{state}</span>;
}

function EvidenceTable({ children, headers, title }: { children: ReactNode; headers: readonly string[]; title: string }) {
  return <section className="clearing-table-section"><h3>{title}</h3><div className="table-scroll"><table className="data-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div></section>;
}

function LoadingState({ label }: { label: string }) {
  return <div className="resource-state clearing-inline-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>等待 Core 权威响应，不显示测试数据或推测状态。</p></div></div>;
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return <div className="clearing-empty"><Search aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></div>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error clearing-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code} · HTTP {error.status}</strong><p>{error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p></div></div>;
}

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}

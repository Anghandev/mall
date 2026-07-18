import {
  merchantLifecycleStatuses,
  type MerchantApplicationCreateRequest,
  type MerchantApplicationUpdateRequest,
  type MerchantLifecycleDetail,
  type MerchantLifecycleList,
  type MerchantLifecycleStatus,
  type MerchantReviewAction,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  ExternalLink,
  FileCheck2,
  FileUp,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  WalletCards,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import {
  createMerchantApplication,
  createMerchantReviewChallenge,
  fetchMerchantLicenseAccess,
  getMerchantLifecycle,
  listMerchantLifecycle,
  publishMerchantReview,
  updateMerchantApplication,
  uploadMerchantLicense,
} from '../merchantLifecycleApi';

type StatusFilter = MerchantLifecycleStatus | 'ALL';

const statusFilters: readonly StatusFilter[] = ['ALL', ...merchantLifecycleStatuses];
const emptyCreate: MerchantApplicationCreateRequest = {
  shopName: '', legalName: '', legalId: '', contactPhone: '', settlementWallet: '', idempotencyKey: '',
};

export function MerchantFinancePage() {
  const { connect, session, status: sessionStatus } = useCoreSession();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState<MerchantLifecycleList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MerchantLifecycleDetail | null>(null);
  const [listError, setListError] = useState<CoreApiError | null>(null);
  const [detailError, setDetailError] = useState<CoreApiError | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const roles = session?.roles ?? [];
  const canRead = roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role));
  const canWrite = roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role));
  const canReview = roles.includes('ADMIN');

  useEffect(() => {
    if (!session || !canRead) {
      setList(null); setSelectedId(null); setDetail(null); setListError(null); setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setListLoading(true); setListError(null);
    listMerchantLifecycle({ ...(statusFilter === 'ALL' ? {} : { status: statusFilter }), ...(search ? { search } : {}), limit: 50 }, session.token, controller.signal)
      .then((next) => {
        setList(next);
        setSelectedId((current) => current && next.merchants.some((merchant) => merchant.merchantId === current)
          ? current
          : next.merchants[0]?.merchantId ?? null);
      })
      .catch((cause) => { if (!controller.signal.aborted) setListError(asCoreError(cause, '商家列表不可用')); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [canRead, reloadKey, search, session, statusFilter]);

  useEffect(() => {
    if (!session || !canRead || !selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailLoading(true); setDetailError(null);
    getMerchantLifecycle(selectedId, session.token, controller.signal)
      .then(setDetail)
      .catch((cause) => { if (!controller.signal.aborted) setDetailError(asCoreError(cause, '商家详情不可用')); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [canRead, reloadKey, selectedId, session]);

  const reload = () => setReloadKey((value) => value + 1);
  const showDetail = (next: MerchantLifecycleDetail, message: string) => {
    setDetail(next); setSelectedId(next.merchant.merchantId); setNotice(message); reload();
  };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setSearch(searchDraft.trim()); };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><Building2 aria-hidden="true" /></div>
        <div><p className="eyebrow">MERCHANT LIFECYCLE</p><h1>商家准入与经营穿透</h1><p>资质版本、履约指标和五态应收均直接消费 Core；结算钱包审核通过后永久不可变更。</p></div>
        <div className="requirement-list"><code>ADM-MER-001</code><code>ADM-MER-003..006</code></div>
      </header>

      {!session ? (
        <section className="panel catalog-session-gate merchant-session-gate">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>ADMIN / OPERATOR 可维护资质，AUDITOR 仅接收脱敏投影。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={sessionStatus === 'CONNECTING'}><WalletCards aria-hidden="true" />{sessionStatus === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}</button>
        </section>
      ) : !canRead ? (
        <div className="resource-state resource-state-error merchant-access-error"><Ban aria-hidden="true" /><div><strong>Forbidden</strong><p>当前会话没有商家生命周期读取权限。</p></div></div>
      ) : (
        <>
          <section className="merchant-toolbar" aria-label="商家状态与检索">
            <div className="merchant-status-tabs" role="group" aria-label="商家状态">
              {statusFilters.map((item) => <button key={item} className={statusFilter === item ? 'is-active' : ''} type="button" aria-pressed={statusFilter === item} onClick={() => setStatusFilter(item)}>{statusLabel(item)}</button>)}
            </div>
            <form className="merchant-search" role="search" onSubmit={submitSearch}>
              <label><span className="sr-only">检索商家</span><Search aria-hidden="true" /><input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="商家 ID / 店铺 / 结算钱包" maxLength={100} /></label>
              <button className="button button-quiet" type="submit">检索</button>
              <button className="icon-button light-icon-button" type="button" aria-label="刷新商家数据" onClick={reload}><RefreshCw aria-hidden="true" /></button>
            </form>
          </section>

          {notice ? <div className="catalog-notice" role="status"><CheckCircle2 aria-hidden="true" /> {notice}</div> : null}
          {listError ? <CoreErrorState error={listError} /> : null}
          {canWrite ? <CreateApplication token={session.token} onCreated={(next) => showDetail(next, `已创建 ${next.merchant.merchantId} 的加密资质申请`)} /> : null}

          <div className="merchant-workspace">
            <section className="panel merchant-list-panel" aria-busy={listLoading}>
              <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/merchants</p><h2>商家状态队列</h2></div><span className="status-chip">{list?.merchants.length ?? 0} 条</span></div>
              {listLoading && !list ? <LoadingRows /> : null}
              {!listLoading && list?.merchants.length === 0 ? <div className="catalog-list-empty" role="status"><Building2 aria-hidden="true" /><span>Core 返回真实空列表</span></div> : null}
              <div className="merchant-list" role="list">
                {list?.merchants.map((merchant) => (
                  <button className={selectedId === merchant.merchantId ? 'merchant-row is-selected' : 'merchant-row'} key={merchant.merchantId} type="button" onClick={() => setSelectedId(merchant.merchantId)}>
                    <span><strong>{merchant.shopName ?? '未命名商家'}</strong><small>{merchant.merchantId}</small></span>
                    <StatusBadge status={merchant.status} />
                    <dl><div><dt>资质</dt><dd>{merchant.qualificationComplete ? '完整' : '缺失'}</dd></div><div><dt>保证金</dt><dd>{merchant.guaranteeStatus}</dd></div></dl>
                  </button>
                ))}
              </div>
              {list?.nextCursor ? <p className="merchant-continuation">还有更多结果，游标：{list.nextCursor.createdAt} / {list.nextCursor.merchantId}</p> : null}
            </section>

            <section className="panel merchant-detail-panel" aria-busy={detailLoading}>
              {detailLoading && !detail ? <LoadingRows /> : detailError ? <CoreErrorState error={detailError} /> : detail ? (
                <MerchantDetail
                  canReview={canReview}
                  canWrite={canWrite}
                  detail={detail}
                  sessionWallet={session.walletAddress}
                  token={session.token}
                  onChanged={(next, message) => showDetail(next, message)}
                  onError={setDetailError}
                />
              ) : <div className="catalog-detail-empty"><Building2 aria-hidden="true" /><h2>选择商家</h2><p>从状态队列打开真实 Core 详情。</p></div>}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function CreateApplication({ token, onCreated }: { token: string; onCreated(detail: MerchantLifecycleDetail): void }) {
  const [input, setInput] = useState(emptyCreate);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try { const detail = await createMerchantApplication(input, token); onCreated(detail); setInput(emptyCreate); setOpen(false); }
    catch (cause) { setError(asCoreError(cause, '创建商家资质失败')); }
    finally { setSaving(false); }
  };
  return (
    <section className={open ? 'panel merchant-create is-open' : 'panel merchant-create'}>
      <div className="panel-heading"><div><p className="section-kicker">POST /v2/admin/merchants</p><h2>新建商家资质</h2></div><button className="button button-quiet" type="button" aria-expanded={open} aria-controls="merchant-create-form" onClick={() => setOpen((value) => !value)}><UserPlus aria-hidden="true" />{open ? '收起' : '创建申请'}</button></div>
      {open ? <form id="merchant-create-form" className="merchant-form" onSubmit={submit}>
        <div className="form-grid merchant-form-grid">
          <label>店铺名称<input value={input.shopName} onChange={(event) => setInput({ ...input, shopName: event.target.value })} maxLength={80} required /></label>
          <label>主体名称<input value={input.legalName} onChange={(event) => setInput({ ...input, legalName: event.target.value })} minLength={2} maxLength={80} required /></label>
          <label>证件编号<input value={input.legalId} onChange={(event) => setInput({ ...input, legalId: event.target.value })} minLength={6} maxLength={32} required /></label>
          <label>联系电话<input value={input.contactPhone} onChange={(event) => setInput({ ...input, contactPhone: event.target.value })} minLength={6} maxLength={32} required /></label>
          <label>结算钱包<input value={input.settlementWallet} onChange={(event) => setInput({ ...input, settlementWallet: event.target.value })} pattern="0x[0-9a-fA-F]{40}" required /><small>审核通过后永久不可变更；填错时请拒绝旧申请后重新申请</small></label>
          <label>Idempotency key<input value={input.idempotencyKey} onChange={(event) => setInput({ ...input, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label>
        </div>
        {error ? <CoreErrorState error={error} /> : null}
        <button className="button button-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}{saving ? '创建中' : '创建 PENDING 申请'}</button>
      </form> : null}
    </section>
  );
}

function MerchantDetail(props: {
  canReview: boolean; canWrite: boolean; detail: MerchantLifecycleDetail; sessionWallet: string; token: string;
  onChanged(detail: MerchantLifecycleDetail, message: string): void; onError(error: CoreApiError | null): void;
}) {
  const { detail } = props;
  const q = detail.qualification;
  return (
    <div className="merchant-detail">
      <div className="panel-heading merchant-detail-heading"><div><p className="section-kicker">GET /v2/admin/merchants/{'{merchantId}'}</p><h2>{detail.merchant.shopName ?? detail.merchant.merchantId}</h2><code>{detail.merchant.merchantId}</code></div><StatusBadge status={detail.merchant.status} /></div>
      <dl className="merchant-facts">
        <Fact label="结算钱包" value={detail.merchant.settlementWallet} note="审核通过后永久不可更换" code />
        <Fact label="资质版本" value={`v${detail.merchant.applicationVersion}`} note={detail.merchant.qualificationComplete ? '完整' : '缺少已验证证照'} />
        <Fact label="保证金状态" value={detail.merchant.guaranteeStatus} note="Core 投影" />
      </dl>
      <section className="merchant-section" aria-labelledby="merchant-qualification-title">
        <div className="merchant-section-heading"><div><p className="section-kicker">ENCRYPTED QUALIFICATION</p><h3 id="merchant-qualification-title">资质与联系人</h3></div><span className="status-chip">{q.access}</span></div>
        {q.access === 'UNAVAILABLE' ? <DecisionNotice label="PARTIAL_LEGACY" reason="历史商家没有完整的版本化资质。" /> : (
          <>
            <dl className="merchant-qualification">
              <Fact label="主体名称" value={q.legalName ?? '不可用'} />
              <Fact label="证件编号" value={q.legalId ?? '不可用'} />
              <Fact label="联系电话" value={q.contactPhone ?? '不可用'} />
              <Fact label="保留策略" value={q.retentionPolicyVersion ?? '不可用'} note={`payload ${shortHash(q.payloadHash)}`} />
            </dl>
            {q.licenseAssetId && props.canWrite ? <LicenseAccess merchantId={detail.merchant.merchantId} assetId={q.licenseAssetId} token={props.token} /> : null}
            {q.access === 'REDACTED' ? <div className="merchant-readonly"><ShieldCheck aria-hidden="true" /><span>AUDITOR 仅显示 Core 脱敏字段，不提供证照读取或资质写入。</span></div> : null}
          </>
        )}
        {props.canWrite && q.access === 'FULL' ? <ApplicationEditor detail={detail} token={props.token} sessionWallet={props.sessionWallet} onChanged={props.onChanged} /> : null}
      </section>

      {props.canReview ? <ReviewWorkspace detail={detail} sessionWallet={props.sessionWallet} token={props.token} onChanged={props.onChanged} onError={props.onError} /> : null}
      <DecisionBlocks />
      <Analytics detail={detail} />
      <SettlementEvidence detail={detail} />
    </div>
  );
}

function ApplicationEditor({ detail, token, sessionWallet, onChanged }: { detail: MerchantLifecycleDetail; token: string; sessionWallet: string; onChanged(detail: MerchantLifecycleDetail, message: string): void }) {
  const qualification = detail.qualification;
  if (qualification.access !== 'FULL') return null;
  const [input, setInput] = useState<MerchantApplicationUpdateRequest>(() => ({
    shopName: detail.merchant.shopName ?? '', legalName: qualification.legalName ?? '', legalId: qualification.legalId ?? '',
    contactPhone: qualification.contactPhone ?? '', licenseAssetId: qualification.licenseAssetId,
    expectedVersion: detail.merchant.applicationVersion, idempotencyKey: '',
  }));
  const [file, setFile] = useState<File | null>(null);
  const [uploadKey, setUploadKey] = useState('');
  const [busy, setBusy] = useState<'UPLOAD' | 'SAVE' | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);

  useEffect(() => {
    setInput({ shopName: detail.merchant.shopName ?? '', legalName: qualification.legalName ?? '', legalId: qualification.legalId ?? '', contactPhone: qualification.contactPhone ?? '', licenseAssetId: qualification.licenseAssetId, expectedVersion: detail.merchant.applicationVersion, idempotencyKey: '' });
    setFile(null); setUploadKey(''); setError(null);
  }, [detail.merchant.applicationVersion, detail.merchant.shopName, qualification.contactPhone, qualification.legalId, qualification.legalName, qualification.licenseAssetId]);

  const upload = async () => {
    if (!file) return; setBusy('UPLOAD'); setError(null);
    try {
      const asset = await uploadMerchantLicense(detail.merchant.merchantId, file, uploadKey, sessionWallet, token);
      setInput((current) => ({ ...current, licenseAssetId: asset.assetId })); setFile(null);
    } catch (cause) { setError(asCoreError(cause, '证照上传失败')); }
    finally { setBusy(null); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy('SAVE'); setError(null);
    try {
      const next = await updateMerchantApplication(detail.merchant.merchantId, input, token);
      onChanged(next, `资质已更新至 v${next.merchant.applicationVersion}`);
    } catch (cause) { setError(asCoreError(cause, '资质版本更新失败')); }
    finally { setBusy(null); }
  };
  return <form className="merchant-form merchant-update-form" onSubmit={save}>
    <div className="merchant-section-heading"><div><p className="section-kicker">PUT /application</p><h3>更新资质版本</h3></div><span className="status-chip">expected v{input.expectedVersion}</span></div>
    <div className="form-grid merchant-form-grid">
      <label>店铺名称<input value={input.shopName} onChange={(event) => setInput({ ...input, shopName: event.target.value })} maxLength={80} required /></label>
      <label>主体名称<input value={input.legalName} onChange={(event) => setInput({ ...input, legalName: event.target.value })} minLength={2} maxLength={80} required /></label>
      <label>证件编号<input value={input.legalId} onChange={(event) => setInput({ ...input, legalId: event.target.value })} minLength={6} maxLength={32} required /></label>
      <label>联系电话<input value={input.contactPhone} onChange={(event) => setInput({ ...input, contactPhone: event.target.value })} minLength={6} maxLength={32} required /></label>
      <label>Idempotency key<input value={input.idempotencyKey} onChange={(event) => setInput({ ...input, idempotencyKey: event.target.value })} minLength={8} maxLength={128} required /></label>
    </div>
    <div className="merchant-license-upload">
      <label>营业执照 / 资质文件<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <label>上传 Idempotency key<input value={uploadKey} onChange={(event) => setUploadKey(event.target.value)} minLength={8} maxLength={128} /></label>
      <button className="button button-quiet" type="button" onClick={() => void upload()} disabled={!file || uploadKey.length < 8 || busy !== null}>{busy === 'UPLOAD' ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileUp aria-hidden="true" />}{busy === 'UPLOAD' ? '上传验证中' : '上传并验证证照'}</button>
    </div>
    <p className="merchant-asset-line">当前证照 asset：<code>{input.licenseAssetId ?? '尚未绑定'}</code></p>
    {error ? <CoreErrorState error={error} /> : null}
    <button className="button button-primary" type="submit" disabled={busy !== null}>{busy === 'SAVE' ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}{busy === 'SAVE' ? '保存中' : '保存新资质版本'}</button>
  </form>;
}

function ReviewWorkspace(props: { detail: MerchantLifecycleDetail; sessionWallet: string; token: string; onChanged(detail: MerchantLifecycleDetail, message: string): void; onError(error: CoreApiError | null): void }) {
  const actions = allowedReviewActions(props.detail.merchant.status);
  const [action, setAction] = useState<MerchantReviewAction | ''>(actions[0] ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAction(actions[0] ?? ''); setReasonCode(''); setIdempotencyKey(''); }, [props.detail.merchant.merchantId, props.detail.merchant.status]);
  if (actions.length === 0) return null;
  const publish = async (event: FormEvent) => {
    event.preventDefault(); if (!action) return; setBusy(true); props.onError(null);
    try {
      const challenge = await createMerchantReviewChallenge(props.detail, {
        action,
        reasonCode,
        idempotencyKey,
      }, props.sessionWallet, props.token);
      if (!window.ethereum) throw new CoreApiError({ code: 'ConfigurationRequired', message: '未检测到支持 EIP-1193 的二次签名钱包', status: 503 });
      const signature = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [challenge.secondarySigner, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string') throw new CoreApiError({ code: 'InvalidResponse', message: '钱包没有返回签名', status: 502 });
      const next = await publishMerchantReview(challenge, signature, props.token);
      const review = next.reviews.find((item) => item.actionId.toLowerCase() === challenge.actionId.toLowerCase());
      props.onChanged(next, `${actionLabel(action)}已发布，签名证据 ${review?.approvalSignatureHash ?? '不可用'}`);
    } catch (cause) { props.onError(asCoreError(cause, '商家审核发布失败')); }
    finally { setBusy(false); }
  };
  return <section className="merchant-section merchant-review" aria-labelledby="merchant-review-title">
    <div className="merchant-section-heading"><div><p className="section-kicker">SECONDARY EIP-712</p><h3 id="merchant-review-title">商家审核发布</h3></div><ShieldCheck aria-hidden="true" /></div>
    <form className="merchant-review-form" onSubmit={publish}>
      <label>审核动作<select value={action} onChange={(event) => setAction(event.target.value as MerchantReviewAction)}>{actions.map((item) => <option key={item} value={item}>{actionLabel(item)}</option>)}</select></label>
      <label>原因代码<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} pattern="[A-Z0-9_:-]{2,64}" maxLength={64} placeholder="QUALIFICATION_APPROVED" required /></label>
      <label>Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} minLength={8} maxLength={128} required /></label>
      <button className={action === 'BLACKLIST' || action === 'REJECT' ? 'button button-danger' : 'button button-primary'} type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{busy ? '等待签名验证' : '二次签名并发布'}</button>
    </form>
    <p className="merchant-governance-note">Core 固定当前状态、资质版本和独立 secondarySigner；签名证据未确认时不会改变商家状态。</p>
  </section>;
}

function DecisionBlocks() {
  return <section className="merchant-decision-grid" aria-label="不可用经营指标">
    <DecisionNotice label="异常订单率" reason="异常订单分类与分母尚未冻结，Core 返回 bps=null。" />
  </section>;
}

function Analytics({ detail }: { detail: MerchantLifecycleDetail }) {
  const { analytics } = detail;
  return <section className="merchant-section" aria-labelledby="merchant-analytics-title">
    <div className="merchant-section-heading"><div><p className="section-kicker">NAMED AMOUNTS</p><h3 id="merchant-analytics-title">经营与履约看板</h3></div><span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />账本已对账</span></div>
    <div className="merchant-counts">
      <Fact label="终局订单" value={analytics.orders.totalFinalized} note={`普通 ${analytics.orders.ordinaryFinalized} / 秒杀 ${analytics.orders.seckillFinalized}`} />
      <Fact label="待发货" value={analytics.fulfillment.pendingShipment} note={`运输中 ${analytics.fulfillment.inTransit}`} />
      <Fact label="已履约" value={analytics.fulfillment.completed} note={`自提 ${analytics.fulfillment.pickupCompleted}`} />
      <Fact label="48H 发货率" value={analytics.fulfillment.fastShip48h.status === 'AVAILABLE' ? `${analytics.fulfillment.fastShip48h.bps} bps` : '不可用'} note={fastShipNote(analytics.fulfillment.fastShip48h)} />
      <Fact label="接管案件" value={analytics.risk.takeoverCases} note={`未偿债务 ${analytics.risk.outstandingDebtUsdt}`} />
    </div>
    <div className="table-scroll"><table className="data-table merchant-amount-table"><thead><tr><th>命名金额 · USDT atomic</th><th>累计</th><th>今日</th></tr></thead><tbody>
      {amountRows(analytics.orders).map((row) => <tr key={row.label}><td><strong>{row.label}</strong></td><td>{row.cumulative}</td><td>{row.today}</td></tr>)}
    </tbody></table></div>
    <p className="merchant-window">今日窗口：{formatDate(analytics.orders.window.start)} 至 {formatDate(analytics.orders.window.end)} · {analytics.orders.timezone}</p>
    <dl className="merchant-contribution">
      <Fact label="NPL Burn · FINAL" value={analytics.contributions.finalizedNplBurnAmount} note="BURN ledger reconciled" />
      <Fact label="BNM Available · 已履约" value={analytics.contributions.fulfillmentAvailableBnmAmount} note="BNM_LIABILITY reconciled" />
      <Fact label="保证金使用 · USDT" value={analytics.risk.guaranteeUsedUsdt} note={`冻结应收 ${analytics.risk.frozenReceivableUsedUsdt}`} />
      <Fact label="平台垫资 · USDT" value={analytics.risk.platformAdvanceUsdt} note={`未来货款 ${analytics.risk.futureProceedsUsedUsdt}`} />
    </dl>
  </section>;
}

function SettlementEvidence({ detail }: { detail: MerchantLifecycleDetail }) {
  return <section className="merchant-section" aria-labelledby="merchant-settlement-title">
    <div className="merchant-section-heading"><div><p className="section-kicker">APPEND-ONLY LEDGER</p><h3 id="merchant-settlement-title">五态应收与结算历史</h3></div></div>
    <dl className="merchant-balances">{detail.balances.map((balance) => <Fact key={balance.state} label={balance.state} value={balance.amount} note="USDT atomic" />)}</dl>
    <div className="table-scroll"><table className="data-table merchant-settlement-table"><thead><tr><th>Request</th><th>资产 / 金额</th><th>状态</th><th>Execution TxHash</th><th>时间</th></tr></thead><tbody>
      {detail.settlements.length ? detail.settlements.map((item) => <tr key={item.requestId}><td><code>{item.requestId}</code></td><td><strong>{item.asset} · {item.amount}</strong></td><td>{item.state}</td><td>{item.finalExecutionTxHashes[0] ? <code>{item.finalExecutionTxHashes[0]}</code> : '—'}<small>{item.finalExecutionTxHashes.length} final transfers</small></td><td>{formatDate(item.settledAt ?? item.requestedAt)}</td></tr>) : <tr><td colSpan={5}>Core 返回真实空结算历史</td></tr>}
    </tbody></table></div>
    <div className="table-scroll"><table className="data-table merchant-review-table"><thead><tr><th>审核动作</th><th>状态迁移</th><th>资质版本</th><th>二次签名者</th><th>签名证据</th></tr></thead><tbody>
      {detail.reviews.length ? detail.reviews.map((review) => <tr key={review.actionId}><td><strong>{review.action} · {review.state}</strong><small>{review.reasonCode}</small></td><td>{review.fromStatus} → {review.toStatus}</td><td>v{review.applicationVersion}</td><td>{review.secondarySigner ? <code>{review.secondarySigner}</code> : '—'}</td><td>{review.approvalSignatureHash ? <code>{review.approvalSignatureHash}</code> : '—'}</td></tr>) : <tr><td colSpan={5}>尚无审核动作</td></tr>}
    </tbody></table></div>
  </section>;
}

function LicenseAccess({ merchantId, assetId, token }: { merchantId: string; assetId: string; token: string }) {
  const [access, setAccess] = useState<Awaited<ReturnType<typeof fetchMerchantLicenseAccess>> | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); setError(null); try { setAccess(await fetchMerchantLicenseAccess(merchantId, assetId, token)); } catch (cause) { setError(asCoreError(cause, '证照读取授权失败')); } finally { setLoading(false); } };
  return <div className="merchant-license-access"><span><FileCheck2 aria-hidden="true" /><strong>已验证证照</strong><code>{assetId}</code></span>{access ? <a className="button button-quiet" href={access.readUrl} target="_blank" rel="noreferrer">受控查看<ExternalLink aria-hidden="true" /></a> : <button className="button button-quiet" type="button" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}{loading ? '授权中' : '获取受控地址'}</button>}{error ? <CoreErrorState error={error} /> : null}</div>;
}

function DecisionNotice({ label, reason }: { label: string; reason: string }) { return <article className="merchant-decision"><AlertTriangle aria-hidden="true" /><div><strong>{label}</strong><p>{reason}</p></div><span>DecisionBlocked</span></article>; }
function CoreErrorState({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error merchant-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p>{error.correlationId ? <code>{error.correlationId}</code> : null}</div></div>; }
function LoadingRows() { return <div className="table-skeleton merchant-loading" aria-label="正在加载" role="status"><span /><span /><span /></div>; }
function StatusBadge({ status }: { status: MerchantLifecycleStatus }) { return <span className={`merchant-status merchant-status-${status.toLowerCase()}`}>{statusLabel(status)}</span>; }
function Fact({ label, value, note, code = false }: { label: string; value: string; note?: string; code?: boolean }) { return <div><dt>{label}</dt><dd>{code ? <code>{value}</code> : value}{note ? <small>{note}</small> : null}</dd></div>; }

function allowedReviewActions(status: MerchantLifecycleStatus): readonly MerchantReviewAction[] { if (status === 'PENDING') return ['APPROVE', 'REJECT']; if (status === 'APPROVED') return ['BLACKLIST']; return []; }
function statusLabel(status: StatusFilter) { return status === 'ALL' ? '全部' : status === 'PENDING' ? '待审核' : status === 'APPROVED' ? '已通过' : status === 'REJECTED' ? '已拒绝' : status === 'SUSPENDED' ? '已暂停' : '黑名单'; }
function actionLabel(action: MerchantReviewAction) { return action === 'APPROVE' ? '通过资质' : action === 'REJECT' ? '拒绝资质' : '加入黑名单'; }
function fastShipNote(metric: MerchantLifecycleDetail['analytics']['fulfillment']['fastShip48h']) { return metric.status === 'AVAILABLE' ? `numerator ${metric.numerator} / denominator ${metric.denominator}` : `${metric.reason} · numerator ${metric.numerator} / denominator ${metric.denominator}`; }
function amountRows(orders: MerchantLifecycleDetail['analytics']['orders']) { return [
  { label: '商品标价', cumulative: orders.cumulative.listPriceUsdt, today: orders.today.listPriceUsdt },
  { label: '买家实付 USDT', cumulative: orders.cumulative.buyerPaidUsdt, today: orders.today.buyerPaidUsdt },
  { label: '商家基础应收', cumulative: orders.cumulative.merchantBaseReceivableUsdt, today: orders.today.merchantBaseReceivableUsdt },
  { label: '商家净应收', cumulative: orders.cumulative.merchantNetReceivableUsdt, today: orders.today.merchantNetReceivableUsdt },
]; }
function shortHash(value: string) { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function asCoreError(cause: unknown, message: string) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 }); }

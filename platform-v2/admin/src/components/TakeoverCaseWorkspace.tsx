import {
  takeoverStates,
  type TakeoverCandidateList,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
  type TakeoverState,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ClipboardList,
  History,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  UserRoundCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError, type CoreSession } from '../coreApi';
import {
  assignTakeoverReplacementMerchant,
  getAdminTakeoverCase,
  listAdminTakeoverCases,
  listTakeoverCandidates,
  type TakeoverCaseFilters,
} from '../takeoverCaseApi';

type TakeoverCaseWorkspaceProps = Readonly<{
  connecting: boolean;
  session: CoreSession | null;
}>;

type FilterDraft = { state: string; originalMerchantId: string; replacementMerchantId: string };
const emptyFilters: FilterDraft = { state: '', originalMerchantId: '', replacementMerchantId: '' };

export function TakeoverCaseWorkspace({ connecting, session }: TakeoverCaseWorkspaceProps) {
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(emptyFilters);
  const [activeFilters, setActiveFilters] = useState<TakeoverCaseFilters>({});
  const [casePage, setCasePage] = useState<TakeoverCaseList | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [detail, setDetail] = useState<TakeoverCaseDetail | null>(null);
  const [candidates, setCandidates] = useState<TakeoverCandidateList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [listError, setListError] = useState<CoreApiError | null>(null);
  const [detailError, setDetailError] = useState<CoreApiError | null>(null);
  const [candidateError, setCandidateError] = useState<CoreApiError | null>(null);
  const [replacementMerchantId, setReplacementMerchantId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [evidenceHash, setEvidenceHash] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [assignmentPending, setAssignmentPending] = useState(false);
  const [assignmentError, setAssignmentError] = useState<CoreApiError | null>(null);
  const [assignmentNotice, setAssignmentNotice] = useState<string | null>(null);

  const roles = session?.roles ?? [];
  const canRead = roles.some((role) => role === 'ADMIN' || role === 'OPERATOR' || role === 'AUDITOR');
  const canAssignByRole = roles.some((role) => role === 'ADMIN' || role === 'OPERATOR');
  const auditorOnly = roles.includes('AUDITOR') && !canAssignByRole;

  useEffect(() => {
    setFilterDraft(emptyFilters);
    setActiveFilters({});
    setCasePage(null);
    setSelectedCaseId('');
    setDetail(null);
    setCandidates(null);
    setListError(null);
    setDetailError(null);
    setCandidateError(null);
    setAssignmentError(null);
    setAssignmentNotice(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    void loadCasePage({}, controller.signal);
    return () => controller.abort();
  }, [canRead, session?.token]);

  useEffect(() => {
    setDetail(null);
    setCandidates(null);
    setDetailError(null);
    setCandidateError(null);
    setAssignmentError(null);
    setAssignmentNotice(null);
    if (!session || !canRead || !selectedCaseId) return;
    const controller = new AbortController();
    void loadCaseResources(selectedCaseId, controller.signal);
    return () => controller.abort();
  }, [canRead, selectedCaseId, session?.token]);

  useEffect(() => {
    const selectable = candidates?.candidates.find(
      (candidate) => candidate.merchantId !== detail?.case.currentAssignment?.replacementMerchantId,
    );
    setReplacementMerchantId(selectable?.merchantId ?? '');
  }, [candidates, detail?.case.currentAssignment?.replacementMerchantId]);

  async function loadCasePage(filters: TakeoverCaseFilters, signal?: AbortSignal) {
    if (!session) return;
    setListLoading(true);
    setListError(null);
    try {
      const page = await listAdminTakeoverCases(filters, session.token, signal);
      setCasePage(page);
      setSelectedCaseId((current) => page.cases.some((item) => item.caseId === current)
        ? current
        : page.cases[0]?.caseId ?? '');
    } catch (cause) {
      if (!signal?.aborted) {
        setCasePage(null);
        setSelectedCaseId('');
        setListError(asCoreError(cause, '接管案件列表不可用'));
      }
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }

  async function loadCaseResources(caseId: string, signal?: AbortSignal) {
    if (!session) return;
    setDetailLoading(true);
    setCandidateLoading(true);
    const [detailResult, candidateResult] = await Promise.allSettled([
      getAdminTakeoverCase(caseId, session.token, signal),
      listTakeoverCandidates(caseId, session.token, signal),
    ]);
    if (signal?.aborted) return;
    if (detailResult.status === 'fulfilled') setDetail(detailResult.value);
    else setDetailError(asCoreError(detailResult.reason, '接管案件详情不可用'));
    if (candidateResult.status === 'fulfilled') setCandidates(candidateResult.value);
    else setCandidateError(asCoreError(candidateResult.reason, '替代商家候选列表不可用'));
    setDetailLoading(false);
    setCandidateLoading(false);
  }

  const handleFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const filters: TakeoverCaseFilters = {
      ...(filterDraft.state ? { state: filterDraft.state as TakeoverState } : {}),
      ...(filterDraft.originalMerchantId.trim() ? { originalMerchantId: filterDraft.originalMerchantId.trim() } : {}),
      ...(filterDraft.replacementMerchantId.trim() ? { replacementMerchantId: filterDraft.replacementMerchantId.trim() } : {}),
    };
    setActiveFilters(filters);
    setAssignmentNotice(null);
    void loadCasePage(filters);
  };

  const handleReset = () => {
    setFilterDraft(emptyFilters);
    setActiveFilters({});
    setAssignmentNotice(null);
    void loadCasePage({});
  };

  const handleAssignment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !detail || !canAssignByRole || !replacementMerchantId) return;
    setAssignmentPending(true);
    setAssignmentError(null);
    setAssignmentNotice(null);
    try {
      const result = await assignTakeoverReplacementMerchant(detail.case.caseId, {
        replacementMerchantId,
        reasonCode,
        evidenceHash,
        idempotencyKey,
      }, session.token);
      setAssignmentNotice(
        `${detail.case.currentAssignment ? '改派' : '分配'}已由 Core 确认·v${result.assignment.version}·${result.assignment.replacementMerchantId}`,
      );
      setEvidenceHash('');
      setIdempotencyKey('');
      await Promise.all([
        loadCasePage(activeFilters),
        loadCaseResources(detail.case.caseId),
      ]);
    } catch (cause) {
      setAssignmentError(asCoreError(cause, '接管替代商家分配失败'));
    } finally {
      setAssignmentPending(false);
    }
  };

  const assignmentStateAllowsWrite = Boolean(
    detail
    && (detail.case.state === 'OPEN' || detail.case.state === 'FUNDED')
    && detail.case.order.fulfillmentMode === 'DELIVERY',
  );
  const alternativeCandidates = useMemo(
    () => candidates?.candidates.filter(
      (candidate) => candidate.merchantId !== detail?.case.currentAssignment?.replacementMerchantId,
    ) ?? [],
    [candidates, detail?.case.currentAssignment?.replacementMerchantId],
  );

  return (
    <section className="takeover-case-workspace" aria-labelledby="takeover-case-heading">
      <div className="panel takeover-case-query">
        <div className="panel-heading">
          <div><p className="section-kicker">GET /v2/admin/takeover-cases</p><h2 id="takeover-case-heading">接管案件队列</h2></div>
          <span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>
            {canRead ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
            {session ? roles.join(' / ') : '需要 SIWE'}
          </span>
        </div>
        {!session ? (
          <div className="takeover-readonly takeover-case-session" role="status"><KeyRound aria-hidden="true" /><div><strong>{connecting ? '等待钱包签名' : '需要平台会话'}</strong><p>未认证时案件、候选资格与写入操作保持关闭。</p></div></div>
        ) : !canRead ? (
          <ResourceError error={new CoreApiError({ code: 'Forbidden', message: '当前会话无权读取接管案件', status: 403 })} />
        ) : (
          <form className="takeover-case-filters" onSubmit={handleFilter}>
            <label>案件状态<select value={filterDraft.state} onChange={(event) => setFilterDraft((current) => ({ ...current, state: event.target.value }))}>
              <option value="">全部状态</option>
              {takeoverStates.map((state) => <option key={state} value={state}>{state}</option>)}
            </select></label>
            <label>原商家 ID<input value={filterDraft.originalMerchantId} onChange={(event) => setFilterDraft((current) => ({ ...current, originalMerchantId: event.target.value }))} placeholder="merchant-id" /></label>
            <label>替代商家 ID<input value={filterDraft.replacementMerchantId} onChange={(event) => setFilterDraft((current) => ({ ...current, replacementMerchantId: event.target.value }))} placeholder="replacement-id" /></label>
            <div className="button-row"><button className="button button-primary" type="submit" disabled={listLoading}><Search aria-hidden="true" />筛选</button><button className="button button-quiet" type="button" onClick={handleReset} disabled={listLoading}><RefreshCw aria-hidden="true" />重置</button></div>
          </form>
        )}
      </div>

      {session && canRead ? (
        <div className="takeover-case-master-detail">
          <article className="panel takeover-case-list-panel">
            <div className="panel-heading"><div><p className="section-kicker">稳定游标队列</p><h2>{casePage?.cases.length ?? 0} 个案件</h2></div><ClipboardList aria-hidden="true" /></div>
            {listLoading ? <LoadingState label="正在读取接管案件" />
              : listError ? <ResourceError error={listError} />
                : !casePage || casePage.cases.length === 0 ? <EmptyState title="没有匹配案件" detail="当前筛选下 Core 返回真实空队列。" />
                  : <div className="takeover-case-list" role="list">{casePage.cases.map((item) => (
                    <button key={item.caseId} className={`takeover-case-row${item.caseId === selectedCaseId ? ' is-selected' : ''}`} type="button" role="listitem" aria-pressed={item.caseId === selectedCaseId} onClick={() => setSelectedCaseId(item.caseId)}>
                      <span><strong>{item.state}</strong><code>{item.caseId}</code><small>{item.order.productId} · {item.order.skuId} · qty {item.order.quantity}</small></span>
                      <span><small>{item.originalMerchantId}</small><strong>{item.currentAssignment?.replacementMerchantId ?? '待分配'}</strong><small>{formatDate(item.openedAt)}</small></span>
                    </button>
                  ))}</div>}
            {casePage?.nextCursor ? <button className="button button-quiet button-full" type="button" disabled={listLoading} onClick={() => void loadCasePage({ ...activeFilters, cursorOpenedAt: casePage.nextCursor!.openedAt, cursorCaseId: casePage.nextCursor!.caseId })}>读取下一页</button> : null}
          </article>

          <article className="panel takeover-case-detail-panel" aria-live="polite">
            {detailLoading ? <LoadingState label="正在读取案件详情" />
              : detailError ? <ResourceError error={detailError} />
                : detail ? <TakeoverCaseDetailView detail={detail} />
                  : <EmptyState title="选择接管案件" detail="队列选中后读取 Core 详情、分配历史和状态转移。" />}

            {detail ? (
              <section className="takeover-candidates" aria-labelledby="takeover-candidate-heading">
                <div className="takeover-subheading"><div><p className="section-kicker">GET /candidates</p><h3 id="takeover-candidate-heading">合格替代商家</h3></div><Store aria-hidden="true" /></div>
                {candidateLoading ? <LoadingState label="正在读取候选商家" />
                  : candidateError ? <ResourceError error={candidateError} />
                    : !candidates || candidates.candidates.length === 0 ? <EmptyState title="暂无合格候选商家" detail="Core 未返回同时满足审核、保证金、资质媒体与钱包绑定的商家。" />
                      : <div className="takeover-candidate-list">{candidates.candidates.map((candidate) => {
                        const isCurrent = candidate.merchantId === detail.case.currentAssignment?.replacementMerchantId;
                        return <label key={candidate.merchantId} className={isCurrent ? 'is-current' : undefined}>
                          <input type="radio" name="replacementMerchantId" value={candidate.merchantId} checked={replacementMerchantId === candidate.merchantId} onChange={() => setReplacementMerchantId(candidate.merchantId)} disabled={!canAssignByRole || isCurrent || assignmentPending} />
                          <span><strong>{candidate.shopName}</strong><code>{candidate.merchantId}</code><small>application v{candidate.applicationVersion}</small></span>
                          <span><CheckCircle2 aria-hidden="true" /><small>{isCurrent ? '当前分配' : '资质完整 · 保证金 READY'}</small></span>
                        </label>;
                      })}</div>}

                {auditorOnly ? <div className="takeover-readonly"><ShieldCheck aria-hidden="true" /><div><strong>AUDITOR 只读</strong><p>可查看案件、候选资格和不可变分配历史；分配与改派写入不可用。</p></div></div>
                  : canAssignByRole && assignmentStateAllowsWrite ? (
                    <form className="takeover-assignment-form" onSubmit={handleAssignment}>
                      <div className="takeover-subheading"><div><p className="section-kicker">POST /assignments</p><h3>{detail.case.currentAssignment ? '发货前改派' : '分配替代商家'}</h3></div><UserRoundCheck aria-hidden="true" /></div>
                      <label>替代商家<select value={replacementMerchantId} onChange={(event) => setReplacementMerchantId(event.target.value)} required disabled={assignmentPending || alternativeCandidates.length === 0}>
                        <option value="">选择 Core 合格候选</option>
                        {alternativeCandidates.map((candidate) => <option key={candidate.merchantId} value={candidate.merchantId}>{candidate.shopName} · {candidate.merchantId}</option>)}
                      </select></label>
                      <label>原因代码<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} placeholder="WAREHOUSE_MATCH" pattern="[A-Z0-9_:-]{2,64}" minLength={2} maxLength={64} required disabled={assignmentPending} /></label>
                      <label>审计证据哈希<input value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} placeholder="0x…bytes32" pattern="0x[0-9a-fA-F]{64}" required disabled={assignmentPending} /></label>
                      <label>Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} minLength={8} maxLength={128} required disabled={assignmentPending} /></label>
                      <button className="button button-primary" type="submit" disabled={assignmentPending || alternativeCandidates.length === 0 || !replacementMerchantId}>
                        {assignmentPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <UserRoundCheck aria-hidden="true" />}{assignmentPending ? '提交中' : detail.case.currentAssignment ? '确认改派' : '确认分配'}
                      </button>
                    </form>
                  ) : <div className="takeover-readonly"><Ban aria-hidden="true" /><div><strong>当前案件不可分配</strong><p>只有 OPEN / FUNDED 的配送案件可在发货前分配或改派；最终决定由 Core 执行。</p></div></div>}
                {assignmentNotice ? <p className="healthy-copy takeover-assignment-result" role="status"><CheckCircle2 aria-hidden="true" />{assignmentNotice}</p> : null}
                {assignmentError ? <ResourceError error={assignmentError} /> : null}
              </section>
            ) : null}
          </article>
        </div>
      ) : null}
    </section>
  );
}

function TakeoverCaseDetailView({ detail }: { detail: TakeoverCaseDetail }) {
  const item = detail.case;
  return <>
    <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/takeover-cases/{'{caseId}'}</p><h2>{item.state} · {item.caseId}</h2></div><span className="status-chip">{item.order.fulfillmentMode}</span></div>
    <dl className="takeover-case-facts">
      <div><dt>订单</dt><dd><code>{item.orderId}</code><small>{item.order.productId} · {item.order.skuId} · qty {item.order.quantity}</small></dd></div>
      <div><dt>原商家</dt><dd>{item.originalMerchantId}<small>policy v{item.policyVersion}</small></dd></div>
      <div><dt>当前替代商家</dt><dd>{item.currentAssignment?.replacementMerchantId ?? '未分配'}<small>{item.currentAssignment ? `assignment v${item.currentAssignment.version}` : '等待 ADMIN / OPERATOR'}</small></dd></div>
      <div><dt>履约权限</dt><dd>{item.allowedActions.filter((action) => action.enabled).map((action) => action.action).join(' · ') || '无可用操作'}<small>Core allowedActions</small></dd></div>
    </dl>
    <div className="takeover-funding-evidence" aria-label="Core 筹资证据">
      <span><small>保证金</small><strong>{item.funding.guaranteeUsedUsdt}</strong></span>
      <span><small>冻结应收</small><strong>{item.funding.frozenReceivablesUsedUsdt}</strong></span>
      <span><small>未来货款</small><strong>{item.funding.futureProceedsUsedUsdt}</strong></span>
      <span><small>平台垫资</small><strong>{item.funding.platformAdvanceUsdt}</strong></span>
      <span><small>商家债务</small><strong>{item.funding.merchantDebtUsdt}</strong></span>
    </div>
    <div className="takeover-history-grid">
      <section><div className="takeover-subheading"><h3><History aria-hidden="true" />分配历史</h3><span>{detail.assignments.length}</span></div>{detail.assignments.length ? <ol>{detail.assignments.map((assignment) => <li key={assignment.assignmentId}><strong>v{assignment.version} · {assignment.replacementMerchantId}</strong><code>{assignment.replacementWallet}</code><small>{assignment.reasonCode} · {formatDate(assignment.assignedAt)}</small><small>{assignment.supersedesAssignmentId ? `supersedes ${assignment.supersedesAssignmentId}` : '初始分配'}</small></li>)}</ol> : <p>暂无分配记录</p>}</section>
      <section><div className="takeover-subheading"><h3><ClipboardList aria-hidden="true" />状态转移</h3><span>{detail.transitions.length}</span></div>{detail.transitions.length ? <ol>{detail.transitions.map((transition) => <li key={transition.transitionId}><strong>{transition.fromState ?? '初始'} → {transition.toState}</strong><code>{transition.evidenceHash}</code><small>{transition.evidenceType} · {formatDate(transition.occurredAt)}</small></li>)}</ol> : <p>暂无状态转移记录</p>}</section>
    </div>
  </>;
}

function LoadingState({ label }: { label: string }) {
  return <div className="takeover-resource-state" role="status" aria-label={label}><LoaderCircle className="spin" aria-hidden="true" /><span>{label}</span></div>;
}

function EmptyState({ detail, title }: { detail: string; title: string }) {
  return <div className="takeover-empty" role="status"><ClipboardList aria-hidden="true" /><h3>{title}</h3><p>{detail}</p></div>;
}

function ResourceError({ error }: { error: CoreApiError }) {
  const configurationRequired = error.code === 'ConfigurationRequired';
  return <div className={`resource-state resource-state-error takeover-case-error${configurationRequired ? ' is-configuration' : ''}`} role="alert">
    {configurationRequired ? <AlertTriangle aria-hidden="true" /> : <Ban aria-hidden="true" />}
    <div><strong>{error.code}</strong><p>{configurationRequired ? '缺少生产配置，当前操作保持关闭。' : error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p>{configurationRequired ? <small>{error.message}</small> : null}</div>
  </div>;
}

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

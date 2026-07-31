import type {
  CmsPublicItem,
  CmsVersionProjection,
  ManagedCatalogProduct,
  ManagedCatalogSku,
  SeckillGovernanceActionProjection,
  SeckillSessionCreateRequest,
  SeckillSessionProjection,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Scale,
  TimerReset,
  WalletCards,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError, fetchCoreBootstrap, signTypedDataWithWallet, type CoreBootstrap } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { formatUsdt, formatUsdtInput, humanizeError, parseUsdtInput } from '../display';
import { fetchAdminCatalogProducts } from '../catalogAdminApi';
import { fetchCmsVersion, fetchPublishedCms } from '../settlementAdminApi';
import {
  cancelSeckillGovernanceAction,
  createSeckillBreakerResume,
  createSeckillForceClose,
  createSeckillGovernanceChallenge,
  createSeckillPrizeInjection,
  createSeckillSessionDraft,
  fetchSeckillGovernanceAction,
  fetchSeckillGovernanceActions,
  executeSeckillGovernanceAction,
  reviewSeckillWinner,
  submitSeckillGovernanceApproval,
} from '../seckillAdminApi';

const emptySessionDraft: SeckillSessionCreateRequest = {
  policyVersion: '', rulesContentHash: '', productId: '', skuId: '', inventory: 1,
  seckillListPriceUsdt: '', startsAt: '', idempotencyKey: '',
};

type SeckillRulesBinding = Readonly<{
  versionId: string;
  version: number;
  slug: string;
  placement: string;
  contentType: 'SECKILL_RULES';
  policyVersion: string;
  contentHash: string;
  published: boolean;
}>;

type RulesLookupState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type ProductLookupState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type RuntimeGateState =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; readiness: CoreBootstrap['readiness'] }
  | { phase: 'error'; message: string };

export function SeckillGovernanceWorkspace({ current, onRefresh }: {
  current: SeckillSessionProjection | null;
  onRefresh(): void;
}) {
  const { connect, session, status } = useCoreSession();
  const [actions, setActions] = useState<readonly SeckillGovernanceActionProjection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<SeckillGovernanceActionProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<SeckillSessionCreateRequest>(() => ({ ...emptySessionDraft, idempotencyKey: seckillCommandKey('seckill-session') }));
  const [rulesVersionId, setRulesVersionId] = useState('');
  const [rulesBinding, setRulesBinding] = useState<SeckillRulesBinding | null>(null);
  const [rulesLookupState, setRulesLookupState] = useState<RulesLookupState>('idle');
  const [catalogProducts, setCatalogProducts] = useState<readonly ManagedCatalogProduct[]>([]);
  const [productLookupState, setProductLookupState] = useState<ProductLookupState>('idle');
  const [productLookupError, setProductLookupError] = useState('');
  const [runtimeGate, setRuntimeGate] = useState<RuntimeGateState>({ phase: 'idle' });
  const [targetSessionId, setTargetSessionId] = useState('');
  const [forceReason, setForceReason] = useState('');
  const [forceKey, setForceKey] = useState(() => seckillCommandKey('seckill-force-close'));
  const [prize金额, setPrize金额] = useState('');
  const [prizeKey, setPrizeKey] = useState(() => seckillCommandKey('seckill-prize'));
  const [resumeKey, setResumeKey] = useState(() => seckillCommandKey('seckill-resume'));
  const [nonce, setNonce] = useState(() => seckillCommandNonce());
  const [deadline, setDeadline] = useState(() => seckillCommandDeadline());
  const [winnerDecision, setWinnerDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [winnerReason, setWinnerReason] = useState('');
  const [winnerEvidenceHash, setWinnerEvidenceHash] = useState('');
  const [winnerReviewKey, setWinnerReviewKey] = useState(() => seckillCommandKey('seckill-winner'));

  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canCreate = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const isOperator = !isAdmin && (session?.roles.includes('OPERATOR') ?? false);
  const canCancel = Boolean(selected?.allowedActions.includes('CANCEL'))
    && (isAdmin || (isOperator && selected?.actionKind === 'OPEN_SESSION'));
  const runtimeReady = runtimeGate.phase === 'ready';

  const applyRulesBinding = (binding: SeckillRulesBinding) => {
    setRulesVersionId(binding.versionId);
    setRulesBinding(binding);
    setRulesLookupState('ready');
    setDraft((current) => ({
      ...current,
      policyVersion: binding.policyVersion,
      rulesContentHash: binding.contentHash,
      idempotencyKey: seckillCommandKey('seckill-session'),
    }));
  };

  const loadLatestPublishedRules = async (silent = false) => {
    if (!canCreate || pendingAction) return;
    setRulesLookupState('loading');
    setError(null);
    if (!silent) setNotice('');
    try {
      const latest = pickLatestSeckillRules(await fetchPublishedCms(session?.token));
      if (!latest) {
        setRulesBinding(null);
        setRulesLookupState('empty');
        if (!silent) setNotice('还没有发布秒杀规则，请先去内容中心发布。');
        return;
      }
      applyRulesBinding(publicRulesBinding(latest));
      if (!silent) setNotice('已自动选择最新版秒杀规则，可以继续创建活动。');
    } catch (cause) {
      setRulesLookupState('error');
      if (!silent) setError(asCoreError(cause));
    }
  };

  useEffect(() => {
    if (current && !targetSessionId) setTargetSessionId(current.sessionId);
  }, [current, targetSessionId]);

  useEffect(() => {
    setActions([]); setSelected(null); setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchSeckillGovernanceActions(session.token, controller.signal)
      .then((items) => {
        setActions(items);
        setSelectedId((value) => items.some((item) => item.actionId === value) ? value : (items[0]?.actionId ?? ''));
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  useEffect(() => {
    setSelected(null);
    if (!session || !canRead || !selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    void fetchSeckillGovernanceAction(selectedId, session.token, controller.signal)
      .then(setSelected)
      .catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [canRead, selectedId, session]);

  useEffect(() => {
    if (!session || !canCreate || rulesBinding || rulesVersionId.trim()) return;
    const controller = new AbortController();
    setRulesLookupState('loading');
    setError(null);
    void fetchPublishedCms(session?.token, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        const latest = pickLatestSeckillRules(items);
        if (!latest) {
          setRulesLookupState('empty');
          return;
        }
        applyRulesBinding(publicRulesBinding(latest));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setRulesLookupState('error');
          setError(asCoreError(cause));
        }
      });
    return () => controller.abort();
  }, [canCreate, rulesBinding, rulesVersionId, session]);

  useEffect(() => {
    setCatalogProducts([]);
    setProductLookupError('');
    if (!session || !canCreate) {
      setProductLookupState('idle');
      return;
    }
    const controller = new AbortController();
    setProductLookupState('loading');
    void fetchAdminCatalogProducts(session.token, controller.signal)
      .then((products) => {
        if (controller.signal.aborted) return;
        setCatalogProducts(products);
        setProductLookupState(seckillReadyProducts(products).length ? 'ready' : 'empty');
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setProductLookupState('error');
        setProductLookupError(humanizeError(asCoreError(cause)));
      });
    return () => controller.abort();
  }, [canCreate, reload, session]);

  useEffect(() => {
    if (!session || !canCreate) {
      setRuntimeGate({ phase: 'idle' });
      return;
    }
    const controller = new AbortController();
    setRuntimeGate({ phase: 'loading' });
    void fetchCoreBootstrap(controller.signal)
      .then((bootstrap) => {
        if (!controller.signal.aborted) setRuntimeGate({ phase: 'ready', readiness: bootstrap.readiness });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setRuntimeGate({ phase: 'error', message: humanizeError(asCoreError(cause)) });
      });
    return () => controller.abort();
  }, [canCreate, reload, session]);

  const run = async (name: string, operation: () => Promise<SeckillGovernanceActionProjection>, message: string) => {
    if (pendingAction) return;
    setPendingAction(name); setError(null); setNotice('');
    try {
      const updated = await operation();
      setActions((items) => [updated, ...items.filter((item) => item.actionId !== updated.actionId)]);
      setSelectedId(updated.actionId); setSelected(updated);
      setNotice(message.replace('{state}', updated.state));
      onRefresh();
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const submitSession = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canCreate || !rulesBinding || !runtimeReady) return;
    void run('create', async () => {
      const action = await createSeckillSessionDraft({
        ...draft,
        seckillListPriceUsdt: parseUsdtInput(draft.seckillListPriceUsdt, '秒杀价', true),
      }, session.token);
      setDraft((current) => ({ ...current, idempotencyKey: seckillCommandKey('seckill-session') }));
      return action;
    }, '场次草稿已创建，当前 {state}；活动库存以系统锁定结果为准。');
  };

  const loadRulesBinding = async () => {
    if (!session || !canCreate || !rulesVersionId.trim() || pendingAction) return;
    setPendingAction('rules'); setError(null); setNotice(''); setRulesBinding(null);
    try {
      const version = await fetchCmsVersion(rulesVersionId.trim(), session.token);
      if (!version.published || version.contentType !== 'SECKILL_RULES' || !version.policyVersion) {
        throw new CoreApiError({ code: 'InvalidResponse', message: '请选择已发布的秒杀规则。', status: 409 });
      }
      applyRulesBinding(cmsRulesBinding(version));
      setNotice('已读取指定秒杀规则，可以继续创建活动。');
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const changeRulesVersion = (value: string) => {
    setRulesVersionId(value); setRulesBinding(null); setRulesLookupState('idle');
    setDraft((current) => ({ ...current, policyVersion: '', rulesContentHash: '', idempotencyKey: seckillCommandKey('seckill-session') }));
  };

  const submitForceClose = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('force-close', async () => {
      const action = await createSeckillForceClose(targetSessionId, { reasonCode: forceReason, idempotencyKey: forceKey }, session.token);
      setForceKey(seckillCommandKey('seckill-force-close'));
      return action;
    }, '强制截止动作已创建，当前 {state}；最终确认前不会生效。');
  };

  const submitPrize = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('prize', async () => {
      const action = await createSeckillPrizeInjection(targetSessionId, {
        amountUsdt: parseUsdtInput(prize金额, '奖池金额', true),
        idempotencyKey: prizeKey,
      }, session.token);
      setPrizeKey(seckillCommandKey('seckill-prize'));
      return action;
    }, '奖池注入动作已创建，当前 {state}；账本仅在最终确认后入账。');
  };

  const submitResume = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('resume', async () => {
      const action = await createSeckillBreakerResume({ sessionId: targetSessionId, idempotencyKey: resumeKey }, session.token);
      setResumeKey(seckillCommandKey('seckill-resume'));
      return action;
    }, '秒杀购买恢复动作已创建，当前 {state}；最终确认前仍保持暂停。');
  };

  const signSecondary = async () => {
    if (!session || !isAdmin || !selected) return;
    if (!window.ethereum) {
      setError(new CoreApiError({ code: 'ExternalBlocked', message: '未检测到可用的钱包', status: 503 }));
      return;
    }
    setPendingAction('sign'); setError(null); setNotice('');
    try {
      const nextNonce = seckillCommandNonce();
      const nextDeadline = seckillCommandDeadline();
      setNonce(nextNonce);
      setDeadline(nextDeadline);
      const challenge = await createSeckillGovernanceChallenge(selected, { nonce: nextNonce, deadline: nextDeadline }, session.token);
      const signature = await signTypedDataWithWallet(window.ethereum, challenge.signer, challenge.typedData);
      const updated = await submitSeckillGovernanceApproval(
        selected, challenge, { nonce: nextNonce, deadline: nextDeadline, signature }, session.token,
      );
      setActions((items) => items.map((item) => item.actionId === updated.actionId ? updated : item));
      setSelected(updated);
      setNonce(seckillCommandNonce());
      setDeadline(seckillCommandDeadline());
      setNotice('二次确认已通过；还需要点击“提交执行”，等待系统最终确认。');
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const executeAction = () => {
    if (!session || !selected || !isAdmin) return;
    void run('execute', () => executeSeckillGovernanceAction(selected, session.token), '执行请求已提交，当前 {state}；等待系统最终确认。');
  };

  const cancelAction = () => {
    if (!session || !selected || !canCancel) return;
    void run('cancel', () => cancelSeckillGovernanceAction(selected, session.token), '动作已取消，当前 {state}；未执行开场的库存由系统释放。');
  };

  const submitWinnerReview = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin || !current || current.prizeSettlement?.state !== 'REVIEW_PENDING' || pendingAction) return;
    setPendingAction('winner-review'); setError(null); setNotice('');
    try {
      const updated = await reviewSeckillWinner(current, {
        decision: winnerDecision,
        reasonCode: winnerReason,
        evidenceHash: winnerEvidenceHash,
        idempotencyKey: winnerReviewKey,
      }, session.token);
      setNotice(`中奖候选审核已提交，系统状态 ${updated.state}；候选订单与钱包保持不可变。`);
      setWinnerReason(''); setWinnerEvidenceHash(''); setWinnerReviewKey(seckillCommandKey('seckill-winner'));
      onRefresh();
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const currentAction = useMemo(() => selected ?? actions.find((item) => item.actionId === selectedId) ?? null, [actions, selected, selectedId]);
  const currentActionExpired = isActionApprovalExpired(currentAction);

  return (
    <section className="seckill-governance-stack" aria-label="秒杀后台操作区">
      <div className="panel seckill-governance-header">
        <div className="panel-heading"><div><p className="section-kicker">后台操作</p><h2>秒杀后台操作</h2></div>{session && canRead ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新操作</button> : null}</div>
        {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>秒杀后台需要平台钱包登录；关键操作会再弹一次钱包确认。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}</button></div>
          : !canRead ? <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有秒杀后台读取权限', status: 403 })} />
            : <RoleBoundary isAdmin={isAdmin} canCreate={canCreate} />}
        {error ? <ErrorView error={error} /> : null}
        {notice ? <p className="healthy-copy" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}
      </div>

      {session && canRead ? (
        <>
          {isAdmin && current?.prizeSettlement?.state === 'REVIEW_PENDING'
            ? <WinnerReviewForm session={current} decision={winnerDecision} setDecision={setWinnerDecision} reasonCode={winnerReason} setReasonCode={setWinnerReason} evidenceHash={winnerEvidenceHash} setEvidenceHash={setWinnerEvidenceHash} idempotencyKey={winnerReviewKey} setIdempotencyKey={setWinnerReviewKey} pending={pendingAction === 'winner-review'} onSubmit={submitWinnerReview} />
            : null}
          {canCreate ? <SessionDraftForm input={draft} setInput={setDraft} rulesVersionId={rulesVersionId} setRulesVersionId={changeRulesVersion} rulesBinding={rulesBinding} rulesLookupState={rulesLookupState} products={catalogProducts} productLookupState={productLookupState} productLookupError={productLookupError} runtimeGate={runtimeGate} pending={Boolean(pendingAction)} onLoadLatestRules={() => void loadLatestPublishedRules()} onLoadRules={() => void loadRulesBinding()} onSubmit={submitSession} /> : null}

          <div className="seckill-governance-layout">
            <article className="panel seckill-action-list">
              <div className="panel-heading"><div><p className="section-kicker">操作记录</p><h2>后台操作记录</h2></div><span className="status-chip">{actions.length} 条</span></div>
              {loading ? <LoadingView label="正在读取操作记录" /> : null}
              {!loading && !actions.length ? <p className="muted-copy">当前没有后台操作记录。</p> : null}
              <div className="seckill-action-items">{actions.map((action) => <button key={action.actionId} className={action.actionId === selectedId ? 'seckill-action-row is-selected' : 'seckill-action-row'} type="button" onClick={() => setSelectedId(action.actionId)}><span><strong>{actionKindLabel(action.actionKind)}</strong><small>场次 {shortHash(action.sessionId)}</small></span><ActionState state={action.state} confirmations={action.confirmations} /></button>)}</div>
            </article>

            <article className="panel seckill-action-detail">
              <div className="panel-heading"><div><p className="section-kicker">操作详情</p><h2>处理进度</h2></div><ShieldCheck aria-hidden="true" /></div>
              {detailLoading ? <LoadingView label="正在读取动作详情" /> : null}
              {currentAction ? <ActionDetail action={currentAction} /> : !detailLoading ? <p className="muted-copy">选择一条操作，查看处理进度和最终确认记录。</p> : null}
            </article>

            <aside className="panel seckill-governance-command">
              <p className="section-kicker">下一步操作</p><h2>下一步处理</h2>
              {!currentAction ? <p className="muted-copy">先从左侧选择一条动作。</p> : currentActionExpired ? <div className="resource-state resource-state-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>这条确认已过期</strong><p>不要继续点提交执行。请取消旧动作后重新创建，或重新走二次确认。</p></div></div> : currentAction.allowedActions.length === 0 ? <div className="empty-inline"><ShieldCheck aria-hidden="true" /><div><strong>这个动作已结束</strong><p>当前没有需要人工处理的按钮。</p></div></div> : null}
              {currentAction?.allowedActions.includes('APPROVE_SECONDARY') ? (
                <>
                  <details className="technical-details compact">
                    <summary>二次确认参数（已自动填写）</summary>
                    <label>确认流水号<input inputMode="numeric" pattern="0|[1-9][0-9]*" value={nonce} onChange={(event) => setNonce(event.target.value)} disabled={!isAdmin || Boolean(pendingAction)} /></label>
                    <label>有效期<input inputMode="numeric" pattern="[1-9][0-9]*" value={deadline} onChange={(event) => setDeadline(event.target.value)} disabled={!isAdmin || Boolean(pendingAction)} placeholder="自动生成或平台提供" /></label>
                  </details>
                  <button className="button button-primary button-full" type="button" onClick={() => void signSecondary()} disabled={!isAdmin || !nonce || !deadline || Boolean(pendingAction)}><KeyRound aria-hidden="true" />{pendingAction === 'sign' ? '等待二次确认' : '请求二次确认'}</button>
                </>
              ) : null}
              {currentAction?.allowedActions.includes('EXECUTE') ? <button className="button button-quiet button-full" type="button" onClick={executeAction} disabled={!isAdmin || currentActionExpired || Boolean(pendingAction)}><WalletCards aria-hidden="true" />{currentActionExpired ? '确认已过期' : pendingAction === 'execute' ? '提交中' : '提交执行'}</button> : null}
              {canCancel ? <button className="button button-danger button-full" type="button" onClick={cancelAction} disabled={Boolean(pendingAction)}><XCircle aria-hidden="true" />{pendingAction === 'cancel' ? '取消中' : '取消未执行动作'}</button> : null}
              <p className="button-explanation">只显示当前动作能做的按钮；最终是否生效以系统确认结果为准。</p>
            </aside>
          </div>
          {isAdmin ? <ControlForms targetSessionId={targetSessionId} setTargetSessionId={setTargetSessionId} forceReason={forceReason} setForceReason={setForceReason} forceKey={forceKey} setForceKey={setForceKey} prize金额={prize金额} setPrize金额={setPrize金额} prizeKey={prizeKey} setPrizeKey={setPrizeKey} resumeKey={resumeKey} setResumeKey={setResumeKey} pendingAction={pendingAction} onForceClose={submitForceClose} onPrize={submitPrize} onResume={submitResume} /> : null}
        </>
      ) : null}
    </section>
  );
}

function WinnerReviewForm({ session, decision, setDecision, reasonCode, setReasonCode, evidenceHash, setEvidenceHash, idempotencyKey, setIdempotencyKey, pending, onSubmit }: {
  session: SeckillSessionProjection;
  decision: 'APPROVE' | 'REJECT';
  setDecision(value: 'APPROVE' | 'REJECT'): void;
  reasonCode: string; setReasonCode(value: string): void;
  evidenceHash: string; setEvidenceHash(value: string): void;
  idempotencyKey: string; setIdempotencyKey(value: string): void;
  pending: boolean;
  onSubmit(event: FormEvent): void;
}) {
  const candidate = session.prizeSettlement!.candidate!;
  return <form className="panel seckill-winner-review" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">中奖审核</p><h2>中奖候选审核</h2></div><Scale aria-hidden="true" /></div><dl className="definition-grid seckill-winner-review-candidate"><div><dt>候选订单</dt><dd>{shortHash(candidate.orderId)}</dd></div><div><dt>候选钱包</dt><dd>{shortAddress(candidate.buyerWallet)}</dd></div></dl><div className="seckill-winner-review-fields"><label>审核决定<select value={decision} onChange={(event) => setDecision(event.target.value as 'APPROVE' | 'REJECT')} disabled={pending}><option value="APPROVE">通过，有效</option><option value="REJECT">拒绝，无效</option></select></label><label>原因<input minLength={2} maxLength={128} value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} disabled={pending} required /><small>可写简单原因；系统会保存为审核记录。</small></label><label>审核证据编号<input pattern="0x[0-9a-fA-F]{64}" value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} disabled={pending} required /><small>从系统证据里复制 0x 编号，没有编号不要手填。</small></label><IdempotencyInput value={idempotencyKey} setValue={setIdempotencyKey} pending={pending} /></div><button className={decision === 'REJECT' ? 'button button-danger' : 'button button-primary'} type="submit" disabled={pending}>{pending ? '提交中' : '提交审核结果'}</button><p className="button-explanation">只能批准或拒绝系统冻结的候选；不能手动换中奖人。</p></form>;
}


function RoleBoundary({ isAdmin, canCreate }: { isAdmin: boolean; canCreate: boolean }) {
  const label = isAdmin ? '管理员：完整权限' : canCreate ? '运营：可建场和取消草稿' : '审核员：只读';
  return <div className="seckill-role-boundary" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{label}</strong><p>最终写入仍由系统重新校验权限、二次确认和最终确认结果。</p></div></div>;
}

function SessionDraftForm({ input, setInput, rulesVersionId, setRulesVersionId, rulesBinding, rulesLookupState, products, productLookupState, productLookupError, runtimeGate, pending, onLoadLatestRules, onLoadRules, onSubmit }: {
  input: SeckillSessionCreateRequest;
  setInput(value: SeckillSessionCreateRequest): void;
  rulesVersionId: string;
  setRulesVersionId(value: string): void;
  rulesBinding: SeckillRulesBinding | null;
  rulesLookupState: RulesLookupState;
  products: readonly ManagedCatalogProduct[];
  productLookupState: ProductLookupState;
  productLookupError: string;
  runtimeGate: RuntimeGateState;
  pending: boolean;
  onLoadLatestRules(): void;
  onLoadRules(): void;
  onSubmit(event: FormEvent): void;
}) {
  const rulesLoading = rulesLookupState === 'loading' || pending;
  const productOptions = seckillReadyProducts(products);
  const lockedSkuHints = lockedSeckillSkuHints(products);
  const selectedProduct = productOptions.find((product) => product.productId === input.productId) ?? null;
  const skuOptions = selectedProduct ? seckillReadySkus(selectedProduct) : [];
  const selectedSku = skuOptions.find((sku) => sku.skuId === input.skuId) ?? null;
  const selectedSkuCap = selectedSku ? skuInventoryCap(selectedSku) : 0;
  const runtimeUnavailable = runtimeGate.phase !== 'ready';
  const selectProduct = (productId: string) => {
    const product = productOptions.find((item) => item.productId === productId) ?? null;
    const skus = product ? seckillReadySkus(product) : [];
    const sku = skus.length === 1 ? skus[0]! : null;
    setInput({
      ...input,
      productId,
      skuId: sku?.skuId ?? '',
      ...(sku ? seckillDraftFromSku(sku) : {}),
    });
  };
  const selectSku = (skuId: string) => {
    const sku = skuOptions.find((item) => item.skuId === skuId) ?? null;
    setInput({
      ...input,
      skuId,
      ...(sku ? seckillDraftFromSku(sku) : {}),
    });
  };
  const chooseStart = (kind: '15m' | '1h' | 'tomorrow10') => setInput({ ...input, startsAt: quickStartIso(kind) });
  return <form className="panel seckill-session-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">开新场</p><h2>创建场次草稿</h2></div><Plus aria-hidden="true" /></div><div className="seckill-fixed-timers" aria-label="固定秒杀计时参数"><div><span>主场</span><strong>60 分钟</strong></div><div><span>初始接力</span><strong>60 秒</strong></div><div><span>成功购买</span><strong>+30 秒</strong></div><div><span>接力上限</span><strong>60 秒</strong></div><LockKeyhole aria-hidden="true" /></div>
    <div className="resource-state"><ShieldCheck aria-hidden="true" /><div><strong>{rulesBinding ? '已自动选择已发布秒杀规则' : rulesLookupState === 'loading' ? '正在自动查找秒杀规则' : '还没有可用秒杀规则'}</strong><p>{rulesBinding ? `当前规则：${rulesBinding.slug}，资金规则版本 ${rulesBinding.policyVersion}` : rulesLookupState === 'empty' ? '请先到内容中心发布秒杀规则，再回来创建活动。' : rulesLookupState === 'error' ? '自动读取失败，可以刷新或手动指定。' : '系统会自动读取内容中心最新版，不用复制编号。'}</p></div></div>
    <RuntimeGateNotice runtimeGate={runtimeGate} />
    <div className={productLookupState === 'error' || productLookupState === 'empty' ? 'resource-state resource-state-error' : 'resource-state'}>
      {productLookupState === 'ready' ? <ShieldCheck aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <div>
        <strong>{productLookupState === 'loading' ? '正在读取可开秒杀商品' : productLookupState === 'ready' ? '选择商品和规格就行' : productLookupState === 'empty' ? '没有可开秒杀的商品' : productLookupState === 'error' ? '商品列表暂时无法读取' : '等待读取商品'}</strong>
        <p>{productLookupState === 'ready' ? '这里只显示已上架、有可售库存、已提报秒杀库存的商品和规格；旧草稿锁住的库存会自动扣掉。' : productLookupState === 'empty' ? '先到商品主数据把商品发布上架，并确认规格有可售库存和秒杀库存；如果旧秒杀草稿占着库存，先取消旧动作释放。' : productLookupState === 'error' ? productLookupError : '连接平台钱包后自动读取。'}</p>
        {lockedSkuHints.length ? <ul className="inline-hint-list">{lockedSkuHints.map((hint) => <li key={`${hint.productId}:${hint.skuId}`}>{hint.text}</li>)}</ul> : null}
      </div>
    </div>
    <div className="seckill-form-grid">
      <button className="button button-quiet" type="button" onClick={onLoadLatestRules} disabled={rulesLoading}><RefreshCw aria-hidden="true" />{rulesLookupState === 'loading' ? '读取中' : '重新读取最新版规则'}</button>
      <details className="technical-details compact"><summary>手动指定规则版本</summary><label>内容版本编号<input value={rulesVersionId} onChange={(event) => setRulesVersionId(event.target.value)} disabled={pending} placeholder="cms-version:…" /><small>只有自动读取失败时才需要手动粘贴。</small></label><button className="button button-quiet" type="button" onClick={onLoadRules} disabled={pending || !rulesVersionId.trim()}><RefreshCw aria-hidden="true" />读取指定规则</button></details>
      <label>选择商品<select aria-label="选择商品" value={input.productId} onChange={(event) => selectProduct(event.target.value)} disabled={pending || productLookupState !== 'ready'} required><option value="">请选择商品</option>{productOptions.map((product) => <option key={product.productId} value={product.productId}>{product.title} · {product.subtitle || product.merchantId}</option>)}</select><small>不用复制商品编号，只选要开的商品。</small></label>
      <label>选择规格<select aria-label="选择规格" value={input.skuId} onChange={(event) => selectSku(event.target.value)} disabled={pending || !selectedProduct} required><option value="">请选择规格</option>{skuOptions.map((sku) => <option key={sku.skuId} value={sku.skuId}>{attributeText(sku.attributes)} · 可开 {skuInventoryCap(sku)} 件 · {skuInventorySummary(sku)} · 原价 {formatUsdt(sku.listPriceUsdt)}</option>)}</select><small>{selectedSku ? skuInventorySummary(selectedSku) : selectedProduct ? '选规格后自动带出库存和价格。' : '先选择商品。'}</small></label>
      <label>活动库存<input type="number" min="1" max={selectedSkuCap || undefined} step="1" value={input.inventory} onChange={(event) => setInput({ ...input, inventory: Number(event.target.value) })} disabled={pending || !selectedSku} required /><small>{selectedSku ? `最多 ${selectedSkuCap} 件，可少不能超。` : '选规格后自动填写。'}</small></label>
      <label>秒杀价（USDT）<input inputMode="decimal" value={input.seckillListPriceUsdt} onChange={(event) => setInput({ ...input, seckillListPriceUsdt: event.target.value })} disabled={pending || !selectedSku} required /><small>{selectedSku ? `默认按原价 ${formatUsdt(selectedSku.listPriceUsdt)}，需要折扣可改。` : '选规格后自动填写。'}</small></label>
      <label className="seckill-start-time-field">开始时间<span className="seckill-quick-start" role="group" aria-label="快捷开始时间"><button type="button" onClick={() => chooseStart('15m')} disabled={pending}>15 分钟后</button><button type="button" onClick={() => chooseStart('1h')} disabled={pending}>1 小时后</button><button type="button" onClick={() => chooseStart('tomorrow10')} disabled={pending}>明天 10:00</button></span><input type="datetime-local" value={isoToDateTimeLocal(input.startsAt)} onChange={(event) => setInput({ ...input, startsAt: dateTimeLocalToIso(event.target.value) })} disabled={pending} required /><small>不会让你算时区，点上面快捷时间即可。</small></label>
    </div>{rulesBinding ? <p className={runtimeGate.phase === 'ready' && runtimeGate.readiness.writesEnabled ? 'healthy-copy' : 'muted-copy'} role="status"><ShieldCheck aria-hidden="true" />{runtimeGate.phase === 'ready' && runtimeGate.readiness.writesEnabled ? '规则和系统开关都准备好，可以创建场次。' : '规则已准备好；提交时由系统按当前授权和开关再次判断，不能创建会直接说明原因。'}</p> : <p className="muted-copy">没有已发布规则时不能开秒杀。先去内容中心发布秒杀规则。</p>}<details className="technical-details"><summary>校验信息</summary><dl className="definition-grid"><div><dt>资金规则版本</dt><dd>{input.policyVersion || '未读取'}</dd></div><div><dt>规则校验编号</dt><dd>{shortHash(input.rulesContentHash) || '未读取'}</dd></div><div><dt>商品编号</dt><dd>{input.productId || '未选择'}</dd></div><div><dt>规格编号</dt><dd>{input.skuId || '未选择'}</dd></div></dl></details><button className="button button-primary" type="submit" disabled={pending || runtimeUnavailable || !rulesBinding || !selectedSku || !input.startsAt}><TimerReset aria-hidden="true" />{pending ? '提交中' : '创建并锁定活动库存'}</button></form>;
}

function RuntimeGateNotice({ runtimeGate }: { runtimeGate: RuntimeGateState }) {
  if (runtimeGate.phase === 'idle' || runtimeGate.phase === 'loading') {
    return <div className="resource-state"><AlertTriangle aria-hidden="true" /><div><strong>正在检查系统开关</strong><p>系统确认可以写入后，才允许创建新秒杀。</p></div></div>;
  }
  if (runtimeGate.phase === 'error') {
    return <div className="resource-state resource-state-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>系统开关读取失败</strong><p>{runtimeGate.message}</p></div></div>;
  }
  const readiness = runtimeGate.phase === 'ready' ? runtimeGate.readiness : null;
  if (!readiness) return null;
  if (!readiness.writesEnabled) {
    return <div className="resource-state resource-state-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>系统开关当前未完全放开</strong><p>{runtimeBlockerCopy(readiness)}。可以提交给系统确认；最终能不能开场以系统返回为准，不是你表单填错了。</p></div></div>;
  }
  return <div className="resource-state"><ShieldCheck aria-hidden="true" /><div><strong>系统开关已开启</strong><p>付款确认服务正常，可以提交新秒杀场次。</p></div></div>;
}

function runtimeBlockerCopy(readiness: CoreBootstrap['readiness']) {
  const blockers = [
    ...readiness.runtimeBlockers,
    ...readiness.paymentExternalBlocked,
    ...readiness.paymentDecisionBlocked,
  ];
  if (!blockers.length) return '系统写入开关当前关闭';
  return blockers.map(runtimeBlockerLabel).join('；');
}

function runtimeBlockerLabel(value: string) {
  return ({
    PAYMENT_RECEIPT_WORKER_UNHEALTHY: '付款回执确认服务异常',
    RUNTIME_SNAPSHOT_EXPIRED: '系统运行检查过期',
    RPC_DIVERGENCE: '链上 RPC 返回不一致',
    PAYMENT_CONFIGURATION_REQUIRED: '支付运行配置未完成',
  } as Record<string, string>)[value] ?? value;
}

function cmsRulesBinding(version: CmsVersionProjection): SeckillRulesBinding {
  if (version.contentType !== 'SECKILL_RULES' || !version.policyVersion) {
    throw new CoreApiError({ code: 'InvalidResponse', message: '请选择已发布的秒杀规则。', status: 409 });
  }
  return {
    versionId: version.versionId,
    version: version.version,
    slug: version.slug,
    placement: version.placement,
    contentType: 'SECKILL_RULES',
    policyVersion: version.policyVersion,
    contentHash: version.contentHash,
    published: version.published,
  };
}

function publicRulesBinding(item: CmsPublicItem): SeckillRulesBinding {
  if (item.contentType !== 'SECKILL_RULES' || !item.policyVersion) {
    throw new CoreApiError({ code: 'InvalidResponse', message: '请选择已发布的秒杀规则。', status: 409 });
  }
  return {
    versionId: item.versionId,
    version: item.version,
    slug: item.slug,
    placement: item.placement,
    contentType: 'SECKILL_RULES',
    policyVersion: item.policyVersion,
    contentHash: item.contentHash,
    published: true,
  };
}

function pickLatestSeckillRules(items: readonly CmsPublicItem[]) {
  return [...items]
    .filter((item) => item.contentType === 'SECKILL_RULES' && Boolean(item.policyVersion))
    .sort((left, right) => {
      const policyScore = comparePolicyVersionDesc(left.policyVersion, right.policyVersion);
      if (policyScore !== 0) return policyScore;
      const placementScore = Number(right.placement === 'mall.seckill.rules') - Number(left.placement === 'mall.seckill.rules');
      if (placementScore !== 0) return placementScore;
      return right.version - left.version;
    })[0] ?? null;
}

function comparePolicyVersionDesc(left?: string | null, right?: string | null) {
  const leftValue = parsePolicyVersion(left);
  const rightValue = parsePolicyVersion(right);
  if (leftValue === rightValue) return 0;
  return leftValue > rightValue ? -1 : 1;
}

function parsePolicyVersion(value?: string | null) {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : -1n;
}

function seckillReadyProducts(products: readonly ManagedCatalogProduct[]) {
  return products.filter((product) => (
    product.lifecycleState === 'ACTIVE'
    && !product.writeLock
    && seckillReadySkus(product).length > 0
  ));
}

function seckillReadySkus(product: ManagedCatalogProduct) {
  return product.skus.filter((sku) => (
    sku.lifecycleState === 'ACTIVE'
    && skuInventoryCap(sku) > 0
  ));
}

function lockedSeckillSkuHints(products: readonly ManagedCatalogProduct[]) {
  return products.flatMap((product) => product.skus
    .filter((sku) => sku.lifecycleState === 'ACTIVE' && safeAmount(sku.stockSeckillLocked) > 0n && skuInventoryCap(sku) === 0)
    .map((sku) => ({
      productId: product.productId,
      skuId: sku.skuId,
      text: `${product.title} / ${attributeText(sku.attributes)}：旧秒杀草稿锁着 ${safeAmount(sku.stockSeckillLocked).toString()} 件，先取消旧动作释放。`,
    })))
    .slice(0, 3);
}

function seckillDraftFromSku(sku: ManagedCatalogSku): Pick<SeckillSessionCreateRequest, 'inventory' | 'seckillListPriceUsdt'> {
  return {
    inventory: skuInventoryCap(sku),
    seckillListPriceUsdt: formatUsdtInput(sku.listPriceUsdt),
  };
}

function skuInventoryCap(sku: ManagedCatalogSku) {
  const available = safeAmount(sku.stockAvailable);
  const proposed = safeAmount(sku.proposedSeckillInventory);
  const locked = safeAmount(sku.stockSeckillLocked);
  const remainingProposal = proposed > locked ? proposed - locked : 0n;
  const cap = available < remainingProposal ? available : remainingProposal;
  if (cap <= 0n) return 0;
  return cap > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(cap);
}

function skuInventorySummary(sku: ManagedCatalogSku) {
  const available = safeAmount(sku.stockAvailable);
  const proposed = safeAmount(sku.proposedSeckillInventory);
  const locked = safeAmount(sku.stockSeckillLocked);
  const remainingProposal = proposed > locked ? proposed - locked : 0n;
  return `可售 ${available.toString()}，旧草稿锁 ${locked.toString()}，剩余可开 ${remainingProposal.toString()}`;
}

function safeAmount(value: string) {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : 0n;
}

function attributeText(attributes: Readonly<Record<string, unknown>>) {
  return Object.entries(attributes)
    .map(([key, value]) => key === 'spec' ? String(value) : `${key}: ${String(value)}`)
    .join(' · ') || '默认规格';
}

function quickStartIso(kind: '15m' | '1h' | 'tomorrow10') {
  const now = new Date();
  if (kind === 'tomorrow10') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    return tomorrow.toISOString();
  }
  return new Date(now.getTime() + (kind === '15m' ? 15 : 60) * 60_000).toISOString();
}

function ControlForms(props: {
  targetSessionId: string; setTargetSessionId(value: string): void;
  forceReason: string; setForceReason(value: string): void; forceKey: string; setForceKey(value: string): void;
  prize金额: string; setPrize金额(value: string): void; prizeKey: string; setPrizeKey(value: string): void;
  resumeKey: string; setResumeKey(value: string): void; pendingAction: string;
  onForceClose(event: FormEvent): void; onPrize(event: FormEvent): void; onResume(event: FormEvent): void;
}) {
  const pending = Boolean(props.pendingAction);
  return <section className="seckill-control-grid" aria-label="管理员秒杀控制动作"><div className="panel seckill-control-target"><div className="panel-heading"><div><p className="section-kicker">管理员操作</p><h2>目标场次</h2></div><ShieldCheck aria-hidden="true" /></div><label>场次编号<input pattern="0x[0-9a-fA-F]{64}" value={props.targetSessionId} onChange={(event) => props.setTargetSessionId(event.target.value)} disabled={pending} required /><small>从当前场次或历史场次复制，别手打。</small></label><p className="muted-copy">恢复购买需指向已完成强制截止的历史场次。</p></div>
    <form className="panel seckill-control-form" onSubmit={props.onForceClose}><div className="panel-heading"><div><p className="section-kicker">危险操作</p><h2>强制截止</h2></div><Ban aria-hidden="true" /></div><label>截止原因<input minLength={2} maxLength={128} value={props.forceReason} onChange={(event) => props.setForceReason(event.target.value.toUpperCase())} disabled={pending} required /></label><IdempotencyInput value={props.forceKey} setValue={props.setForceKey} pending={pending} /><button className="button button-danger" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'force-close' ? '创建中' : '创建强制截止动作'}</button></form>
    <form className="panel seckill-control-form" onSubmit={props.onPrize}><div className="panel-heading"><div><p className="section-kicker">奖池</p><h2>奖池注入</h2></div><WalletCards aria-hidden="true" /></div><label>金额（USDT）<input inputMode="decimal" value={props.prize金额} onChange={(event) => props.setPrize金额(event.target.value)} disabled={pending} required /></label><IdempotencyInput value={props.prizeKey} setValue={props.setPrizeKey} pending={pending} /><button className="button button-primary" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'prize' ? '创建中' : '创建奖池注入动作'}</button></form>
    <form className="panel seckill-control-form" onSubmit={props.onResume}><div className="panel-heading"><div><p className="section-kicker">恢复</p><h2>恢复购买</h2></div><Send aria-hidden="true" /></div><IdempotencyInput value={props.resumeKey} setValue={props.setResumeKey} pending={pending} /><button className="button button-primary" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'resume' ? '创建中' : '创建恢复购买动作'}</button></form>
  </section>;
}

function IdempotencyInput({ value }: { value: string; setValue(value: string): void; pending: boolean }) {
  return <input type="hidden" value={value} readOnly />;
}

function ActionDetail({ action }: { action: SeckillGovernanceActionProjection }) {
  const expired = isActionApprovalExpired(action);
  return <>
    <div className="seckill-action-status">
      <ActionState state={action.state} confirmations={action.confirmations} />
      <span>{action.canonical === null ? '等待最终确认' : action.canonical ? '已确认生效' : '未生效'}</span>
    </div>
    <dl className="definition-grid seckill-governance-facts">
      <div><dt>动作类型</dt><dd>{actionKindLabel(action.actionKind)}</dd></div>
      <div><dt>场次</dt><dd>{shortHash(action.sessionId)}</dd></div>
      <div><dt>规则状态</dt><dd>已绑定</dd></div>
      <div><dt>下一步</dt><dd>{action.allowedActions.length ? action.allowedActions.map(actionAllowedLabel).join('、') : '无需人工处理'}</dd></div>
    </dl>
    {action.sessionPlan ? <PlanEvidence action={action} /> : null}
    {action.prizeInjection ? <PrizeEvidence action={action} /> : null}
    {expired ? <div className="resource-state resource-state-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>二次确认已过期</strong><p>这条动作不会再执行成功。请取消旧动作，然后重新创建/重新确认。</p></div></div> : null}
    <details className="technical-details">
      <summary>核验证据</summary>
      <dl className="definition-grid seckill-governance-facts">
        <div><dt>动作编号</dt><dd><code>{action.actionId}</code><small>{action.sessionId}</small></dd></div>
        <div><dt>处理账户</dt><dd>{shortAddress(action.executorWallet)}<small>{action.executorNonce ? `处理号 ${action.executorNonce}` : '等待分配'}</small></dd></div>
        <div><dt>执行编号占用</dt><dd>{action.nonceReservedAt ?? '未占用'}<small>{shortHash(action.nonceReservationEvidenceHash)}</small></dd></div>
        <div><dt>执行请求校验</dt><dd>{action.executionArtifactVersion ?? '未绑定'}<small>{shortHash(action.executionRequestDigest)}</small></dd></div>
        <div><dt>执行编号释放</dt><dd>{action.nonceReleasedAt ?? '未释放'}<small>{shortHash(action.nonceReleaseEvidenceHash)}</small></dd></div>
        <div><dt>已提交交易 / 凭证</dt><dd><code title={action.submittedTxHash ?? undefined}>{shortHash(action.submittedTxHash) || '未提交'}</code><small>{shortHash(action.executionEvidenceHash)}</small></dd></div>
        <div><dt>执行记录 / 区块</dt><dd><code title={action.executionTxHash ?? undefined}>{shortHash(action.executionTxHash) || '未执行'}</code><small>{action.blockNumber ?? '—'} / {shortHash(action.blockHash)}</small></dd></div>
        <div><dt>凭证 / 调用内容校验</dt><dd><code title={action.evidenceHash}>{shortHash(action.evidenceHash)}</code><small>{shortHash(action.calldataHash)}</small></dd></div>
        <div><dt>二次确认钱包</dt><dd><code title={action.secondarySigner ?? undefined}>{shortAddress(action.secondarySigner)}</code><small>{action.secondarySigner ? '可与当前登录钱包一致' : '等待确认'} · 编号 {action.approvalNonce ?? '—'} / {action.approvalDeadline ?? '—'}</small></dd></div>
      </dl>
    </details>
    {['REORGED', 'FAILED', 'RECONCILE_REQUIRED'].includes(action.state) ? <div className="resource-state resource-state-error"><AlertTriangle aria-hidden="true" /><div><strong>{stateText(action.state)} · 动作未生效</strong><p>{action.state === 'REORGED' ? '最终确认记录已回滚；等待系统修复或新动作。' : action.state === 'RECONCILE_REQUIRED' ? '处理号已占用且交易状态不明；后续资金动作会暂停，系统只重放已冻结请求并持续对账。' : '执行失败；不改写场次或账本终态。'}</p></div></div> : null}
  </>;
}

function PlanEvidence({ action }: { action: SeckillGovernanceActionProjection }) {
  const plan = action.sessionPlan!;
  return <div className="seckill-plan-evidence"><h3>场次计划</h3><dl><div><dt>商品 / 规格</dt><dd>{shortHash(plan.productId)} / {shortHash(plan.skuId)}</dd></div><div><dt>库存</dt><dd>{plan.inventory}<small>{inventoryLockLabel(plan.inventoryLockState)}</small></dd></div><div><dt>秒杀价</dt><dd>{formatUsdt(plan.seckillListPriceUsdt)}</dd></div><div><dt>计时</dt><dd>主场 {Math.round(plan.timers.mainDurationSeconds / 60)} 分钟，接力 {plan.timers.relayInitialSeconds} 秒，成功购买 +{plan.timers.relayIncrementSeconds} 秒</dd></div></dl><details className="technical-details"><summary>规则核验信息</summary><dl className="definition-grid"><div><dt>规则校验编号</dt><dd><code title={plan.rulesContentHash}>{shortHash(plan.rulesContentHash)}</code><small>规则编号 {action.policyVersion}</small></dd></div><div><dt>库存释放</dt><dd>{plan.releasedAt ?? '未释放'}</dd></div></dl></details></div>;
}

function PrizeEvidence({ action }: { action: SeckillGovernanceActionProjection }) {
  const item = action.prizeInjection!;
  return <div className="seckill-plan-evidence"><h3>奖池注入</h3><dl><div><dt>金额</dt><dd>{formatUsdt(item.amountUsdt)}</dd></div><div><dt>运营钱包</dt><dd>{shortAddress(item.operationsWalletAddress)}</dd></div><div><dt>结算钱包</dt><dd>{shortAddress(item.settlementWalletAddress)}</dd></div><div><dt>入账状态</dt><dd>{item.finalJournalId ? '已入账' : '等待最终确认'}</dd></div></dl><details className="technical-details"><summary>账本核验信息</summary><dl className="definition-grid"><div><dt>账本记录</dt><dd>{shortHash(item.finalJournalId) || '等待最终确认'}</dd></div><div><dt>回滚记录</dt><dd>{shortHash(item.reversalJournalId) || '无回滚分录'}</dd></div></dl></details></div>;
}

function ActionState({ state, confirmations }: Pick<SeckillGovernanceActionProjection, 'state' | 'confirmations'>) {
  const ready = state === 'FINAL';
  const failed = ['REORGED', 'FAILED', 'RECONCILE_REQUIRED'].includes(state);
  const label = stateText(state, confirmations);
  return <span className={ready ? 'status-chip status-ready' : failed ? 'status-chip status-blocked' : 'status-chip'}>{ready ? <CheckCircle2 aria-hidden="true" /> : failed ? <AlertTriangle aria-hidden="true" /> : <TimerReset aria-hidden="true" />}{label}</span>;
}

function LoadingView({ label }: { label: string }) {
  return <div className="resource-state" role="status" aria-busy="true"><RefreshCw className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>等待系统真实响应。</p></div></div>;
}

function actionKindLabel(kind: string) {
  return ({
    OPEN_SESSION: '开场',
    FORCE_CLOSE: '强制截止',
    RESUME_PURCHASES: '恢复购买',
    PRIZE_INJECTION: '注入奖池',
    REVIEW_WINNER: '审核中奖',
  } as Record<string, string>)[kind] ?? kind;
}

function actionAllowedLabel(action: string) {
  return ({
    APPROVE_SECONDARY: '二次确认',
    EXECUTE: '提交执行',
    CANCEL: '取消',
  } as Record<string, string>)[action] ?? action;
}

function stateText(state: string, confirmations?: number) {
  return ({
    FINAL: '已完成',
    MINED: `确认中 ${confirmations ?? 0}/15`,
    PENDING: '待处理',
    DRAFT: '草稿',
    CANCELLED: '已取消',
    REORGED: '已回滚',
    FAILED: '未生效',
    RECONCILE_REQUIRED: '等待对账',
    SECONDARY_SIGNED: '已二次确认，待提交执行',
    PENDING_EXECUTION: '等待系统执行',
    SUBMITTED: '已提交链上',
    SUPERSEDED: '已被替换',
  } as Record<string, string>)[state] ?? state;
}

function isActionApprovalExpired(action: SeckillGovernanceActionProjection | null) {
  if (!action || action.state !== 'SECONDARY_SIGNED' || !action.approvalDeadline) return false;
  const deadline = new Date(action.approvalDeadline).getTime();
  return Number.isFinite(deadline) && deadline <= Date.now();
}

function inventoryLockLabel(state: string) {
  return ({
    LOCKED: '库存已锁定',
    RELEASED: '库存已释放',
  } as Record<string, string>)[state] ?? state;
}

function shortHash(value: string | null | undefined) {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function shortAddress(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function isoToDateTimeLocal(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string) {
  return value ? new Date(value).toISOString() : '';
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>;
}

function asCoreError(cause: unknown) {
  if (cause instanceof CoreApiError) return cause;
  if (cause instanceof Error) return new CoreApiError({ code: 'InvalidRequest', message: cause.message, status: 400 });
  return new CoreApiError({ code: 'ExternalBlocked', message: '秒杀后台服务暂时无法连接', status: 503 });
}

function seckillCommandKey(scope: string) {
  return `${scope}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function seckillCommandNonce() {
  const values = globalThis.crypto?.getRandomValues?.(new Uint32Array(2));
  if (!values) return `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString();
}

function seckillCommandDeadline() {
  return String(Math.floor(Date.now() / 1_000) + 300);
}

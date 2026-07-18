import type {
  CmsVersionProjection,
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
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { fetchCmsVersion } from '../settlementAdminApi';
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
  const [draft, setDraft] = useState<SeckillSessionCreateRequest>(emptySessionDraft);
  const [rulesVersionId, setRulesVersionId] = useState('');
  const [rulesBinding, setRulesBinding] = useState<CmsVersionProjection | null>(null);
  const [targetSessionId, setTargetSessionId] = useState('');
  const [forceReason, setForceReason] = useState('');
  const [forceKey, setForceKey] = useState('');
  const [prizeAmount, setPrizeAmount] = useState('');
  const [prizeKey, setPrizeKey] = useState('');
  const [resumeKey, setResumeKey] = useState('');
  const [nonce, setNonce] = useState('');
  const [deadline, setDeadline] = useState('');
  const [winnerDecision, setWinnerDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [winnerReason, setWinnerReason] = useState('');
  const [winnerEvidenceHash, setWinnerEvidenceHash] = useState('');
  const [winnerReviewKey, setWinnerReviewKey] = useState('');

  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canCreate = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const isOperator = !isAdmin && (session?.roles.includes('OPERATOR') ?? false);
  const canCancel = Boolean(selected?.allowedActions.includes('CANCEL'))
    && (isAdmin || (isOperator && selected?.actionKind === 'OPEN_SESSION'));

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
    if (!session || !canCreate || !rulesBinding) return;
    void run('create', () => createSeckillSessionDraft(draft, session.token), '场次草稿已创建，当前 {state}；活动库存以 Core 锁定证据为准。');
  };

  const loadRulesBinding = async () => {
    if (!session || !canCreate || !rulesVersionId.trim() || pendingAction) return;
    setPendingAction('rules'); setError(null); setNotice(''); setRulesBinding(null);
    try {
      const version = await fetchCmsVersion(rulesVersionId.trim(), session.token);
      if (!version.published || version.contentType !== 'SECKILL_RULES' || !version.policyVersion) {
        throw new CoreApiError({ code: 'InvalidResponse', message: 'CMS version 必须是已发布且已绑定 policyVersion 的 SECKILL_RULES', status: 409 });
      }
      setRulesBinding(version);
      setDraft({ ...draft, policyVersion: version.policyVersion, rulesContentHash: version.contentHash });
      setNotice(`已绑定 CMS ${version.versionId} · policyVersion ${version.policyVersion}；建场时 Core 会重新校验当前发布状态。`);
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const changeRulesVersion = (value: string) => {
    setRulesVersionId(value); setRulesBinding(null);
    setDraft({ ...draft, policyVersion: '', rulesContentHash: '' });
  };

  const submitForceClose = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('force-close', () => createSeckillForceClose(targetSessionId, { reasonCode: forceReason, idempotencyKey: forceKey }, session.token), '强制截止治理动作已创建，当前 {state}；链上 FINAL 前未生效。');
  };

  const submitPrize = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('prize', () => createSeckillPrizeInjection(targetSessionId, { amountUsdt: prizeAmount, idempotencyKey: prizeKey }, session.token), '奖池注入动作已创建，当前 {state}；账本仅在链上终局后入账。');
  };

  const submitResume = (event: FormEvent) => {
    event.preventDefault(); if (!session || !isAdmin) return;
    void run('resume', () => createSeckillBreakerResume({ sessionId: targetSessionId, idempotencyKey: resumeKey }, session.token), '秒杀购买恢复动作已创建，当前 {state}；链上 FINAL 前 breaker 仍保持。');
  };

  const signSecondary = async () => {
    if (!session || !isAdmin || !selected) return;
    if (!window.ethereum) {
      setError(new CoreApiError({ code: 'ExternalBlocked', message: '未检测到可用的二次签名钱包', status: 503 }));
      return;
    }
    setPendingAction('sign'); setError(null); setNotice('');
    try {
      const challenge = await createSeckillGovernanceChallenge(selected, { nonce, deadline }, session.token);
      if (challenge.signer.toLowerCase() === session.walletAddress.toLowerCase()) {
        throw new CoreApiError({ code: 'Forbidden', message: 'Core 未提供独立的秒杀二次签名钱包', status: 403 });
      }
      let signature: unknown;
      try {
        signature = await window.ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [challenge.signer, JSON.stringify(challenge.typedData)],
        });
      } catch {
        throw new CoreApiError({ code: 'InvalidResponse', message: '二次钱包拒绝签名或签名请求失败', status: 400 });
      }
      if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
        throw new CoreApiError({ code: 'InvalidResponse', message: '二次钱包返回了无效签名', status: 400 });
      }
      const updated = await submitSeckillGovernanceApproval(
        selected, challenge, { nonce, deadline, signature }, session.walletAddress, session.token,
      );
      setActions((items) => items.map((item) => item.actionId === updated.actionId ? updated : item));
      setSelected(updated);
      setNotice('二次签名已由 Core 验证；尚未提交治理钱包执行。');
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const executeAction = () => {
    if (!session || !selected || !isAdmin) return;
    void run('execute', () => executeSeckillGovernanceAction(selected, session.token), '治理钱包执行请求已提交，当前 {state}；等待交易和 15 确认。');
  };

  const cancelAction = () => {
    if (!session || !selected || !canCancel) return;
    void run('cancel', () => cancelSeckillGovernanceAction(selected, session.token), '动作已取消，当前 {state}；未提案开场库存由 Core 释放。');
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
      setNotice(`中奖候选审核已提交，Core 状态 ${updated.state}；候选订单与钱包保持不可变。`);
      setWinnerReason(''); setWinnerEvidenceHash(''); setWinnerReviewKey('');
      onRefresh();
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setPendingAction(''); }
  };

  const currentAction = useMemo(() => selected ?? actions.find((item) => item.actionId === selectedId) ?? null, [actions, selected, selectedId]);

  return (
    <section className="seckill-governance-stack" aria-label="秒杀治理工作台">
      <div className="panel seckill-governance-header">
        <div className="panel-heading"><div><p className="section-kicker">ADMIN GOVERNANCE · .9</p><h2>场次与治理钱包动作</h2></div>{session && canRead ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新动作</button> : null}</div>
        {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>治理读写由 SIWE、实时 RBAC、独立二次钱包和普通治理钱包共同约束。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}</button></div>
          : !canRead ? <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有秒杀治理读取权限', status: 403 })} />
            : <RoleBoundary isAdmin={isAdmin} canCreate={canCreate} />}
        {error ? <ErrorView error={error} /> : null}
        {notice ? <p className="healthy-copy" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}
      </div>

      {session && canRead ? (
        <>
          {isAdmin && current?.prizeSettlement?.state === 'REVIEW_PENDING'
            ? <WinnerReviewForm session={current} decision={winnerDecision} setDecision={setWinnerDecision} reasonCode={winnerReason} setReasonCode={setWinnerReason} evidenceHash={winnerEvidenceHash} setEvidenceHash={setWinnerEvidenceHash} idempotencyKey={winnerReviewKey} setIdempotencyKey={setWinnerReviewKey} pending={pendingAction === 'winner-review'} onSubmit={submitWinnerReview} />
            : null}
          <div className="seckill-governance-layout">
            <article className="panel seckill-action-list">
              <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/seckill/actions</p><h2>治理动作</h2></div><span className="status-chip">{actions.length} actions</span></div>
              {loading ? <LoadingView label="正在读取治理动作" /> : null}
              {!loading && !actions.length ? <p className="muted-copy">Core 返回真实空动作列表。</p> : null}
              <div className="seckill-action-items">{actions.map((action) => <button key={action.actionId} className={action.actionId === selectedId ? 'seckill-action-row is-selected' : 'seckill-action-row'} type="button" onClick={() => setSelectedId(action.actionId)}><span><strong>{action.actionKind}</strong><small>{action.sessionId}</small></span><ActionState state={action.state} confirmations={action.confirmations} /></button>)}</div>
            </article>

            <article className="panel seckill-action-detail">
              <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/seckill/actions/:id</p><h2>动作证据</h2></div><ShieldCheck aria-hidden="true" /></div>
              {detailLoading ? <LoadingView label="正在读取动作详情" /> : null}
              {currentAction ? <ActionDetail action={currentAction} /> : !detailLoading ? <p className="muted-copy">选择动作查看钱包执行与终局证据。</p> : null}
            </article>

            <aside className="panel seckill-governance-command">
              <p className="section-kicker">SECONDARY WALLET → GOVERNANCE WALLET</p><h2>批准与执行</h2>
              <label>Approval nonce<input inputMode="numeric" pattern="0|[1-9][0-9]*" value={nonce} onChange={(event) => setNonce(event.target.value)} disabled={!isAdmin || !currentAction?.allowedActions.includes('APPROVE_SECONDARY') || Boolean(pendingAction)} /></label>
              <label>Deadline · Unix seconds<input inputMode="numeric" pattern="[1-9][0-9]*" value={deadline} onChange={(event) => setDeadline(event.target.value)} disabled={!isAdmin || !currentAction?.allowedActions.includes('APPROVE_SECONDARY') || Boolean(pendingAction)} /></label>
              <button className="button button-primary button-full" type="button" onClick={() => void signSecondary()} disabled={!isAdmin || !currentAction?.allowedActions.includes('APPROVE_SECONDARY') || !nonce || !deadline || Boolean(pendingAction)}><KeyRound aria-hidden="true" />{pendingAction === 'sign' ? '等待二次签名' : '请求二次钱包签名'}</button>
              <button className="button button-quiet button-full" type="button" onClick={executeAction} disabled={!isAdmin || !currentAction?.allowedActions.includes('EXECUTE') || Boolean(pendingAction)}><WalletCards aria-hidden="true" />{pendingAction === 'execute' ? '提交中' : '提交治理钱包执行'}</button>
              <button className="button button-danger button-full" type="button" onClick={cancelAction} disabled={!canCancel || Boolean(pendingAction)}><XCircle aria-hidden="true" />{pendingAction === 'cancel' ? '取消中' : '取消未执行动作'}</button>
              <p className="button-explanation">DRAFT 可取消；执行提交后不提供本地终局按钮。`FINAL` 只来自 Core 15-confirmation 证据。</p>
            </aside>
          </div>

          {canCreate ? <SessionDraftForm input={draft} setInput={setDraft} rulesVersionId={rulesVersionId} setRulesVersionId={changeRulesVersion} rulesBinding={rulesBinding} pending={Boolean(pendingAction)} onLoadRules={() => void loadRulesBinding()} onSubmit={submitSession} /> : null}
          {isAdmin ? <ControlForms targetSessionId={targetSessionId} setTargetSessionId={setTargetSessionId} forceReason={forceReason} setForceReason={setForceReason} forceKey={forceKey} setForceKey={setForceKey} prizeAmount={prizeAmount} setPrizeAmount={setPrizeAmount} prizeKey={prizeKey} setPrizeKey={setPrizeKey} resumeKey={resumeKey} setResumeKey={setResumeKey} pendingAction={pendingAction} onForceClose={submitForceClose} onPrize={submitPrize} onResume={submitResume} /> : null}
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
  return <form className="panel seckill-winner-review" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">POST /v2/admin/seckill/sessions/:id/winner-review</p><h2>不可变中奖候选审核</h2></div><Scale aria-hidden="true" /></div><dl className="definition-grid seckill-winner-review-candidate"><div><dt>Candidate order</dt><dd><code>{candidate.orderId}</code></dd></div><div><dt>Candidate wallet</dt><dd><code>{candidate.buyerWallet}</code></dd></div></dl><div className="seckill-winner-review-fields"><label>审核决定<select value={decision} onChange={(event) => setDecision(event.target.value as 'APPROVE' | 'REJECT')} disabled={pending}><option value="APPROVE">APPROVE · 有效</option><option value="REJECT">REJECT · 作弊或无效</option></select></label><label>Reason code<input minLength={2} maxLength={128} value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} disabled={pending} required /></label><label>Evidence hash<input pattern="0x[0-9a-fA-F]{64}" value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} disabled={pending} required /></label><IdempotencyInput value={idempotencyKey} setValue={setIdempotencyKey} pending={pending} /></div><button className={decision === 'REJECT' ? 'button button-danger' : 'button button-primary'} type="submit" disabled={pending}>{pending ? '提交中' : `提交 ${decision}`}</button><p className="button-explanation">只能批准或拒绝 Core 冻结的候选；表单不接受 winner、order 或 wallet 修改。拒绝后由 Core 执行 rollover，不选择替代中奖人。</p></form>;
}

function RoleBoundary({ isAdmin, canCreate }: { isAdmin: boolean; canCreate: boolean }) {
  const label = isAdmin ? 'ADMIN · 完整治理' : canCreate ? 'OPERATOR · 建场/取消开场草稿' : 'AUDITOR · 只读';
  return <div className="seckill-role-boundary" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{label}</strong><p>最终写入仍由 Core 重新校验 RBAC、二次钱包、治理钱包和链上终局。</p></div></div>;
}

function SessionDraftForm({ input, setInput, rulesVersionId, setRulesVersionId, rulesBinding, pending, onLoadRules, onSubmit }: { input: SeckillSessionCreateRequest; setInput(value: SeckillSessionCreateRequest): void; rulesVersionId: string; setRulesVersionId(value: string): void; rulesBinding: CmsVersionProjection | null; pending: boolean; onLoadRules(): void; onSubmit(event: FormEvent): void }) {
  return <form className="panel seckill-session-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">ADMIN / OPERATOR</p><h2>创建场次草稿</h2></div><Plus aria-hidden="true" /></div><div className="seckill-fixed-timers" aria-label="固定秒杀计时参数"><div><span>主场</span><strong>3600s</strong></div><div><span>初始接力</span><strong>60s</strong></div><div><span>终局购买</span><strong>+30s</strong></div><div><span>接力上限</span><strong>60s</strong></div><LockKeyhole aria-hidden="true" /></div><div className="seckill-form-grid">
    <label>CMS rules version ID<input value={rulesVersionId} onChange={(event) => setRulesVersionId(event.target.value)} disabled={pending} required /></label>
    <button className="button button-quiet" type="button" onClick={onLoadRules} disabled={pending || !rulesVersionId.trim()}><RefreshCw aria-hidden="true" />{pending && !rulesBinding ? '读取中' : '读取已发布秒杀规则'}</button>
    <label>Policy version<input value={input.policyVersion} readOnly aria-readonly="true" required /></label>
    <label>Rules content hash<input value={input.rulesContentHash} readOnly aria-readonly="true" required /></label>
    <label>Product ID<input value={input.productId} onChange={(event) => setInput({ ...input, productId: event.target.value })} disabled={pending} required /></label>
    <label>SKU ID<input value={input.skuId} onChange={(event) => setInput({ ...input, skuId: event.target.value })} disabled={pending} required /></label>
    <label>活动库存<input type="number" min="1" step="1" value={input.inventory} onChange={(event) => setInput({ ...input, inventory: Number(event.target.value) })} disabled={pending} required /></label>
    <label>秒杀价 · USDT atomic<input inputMode="numeric" pattern="[1-9][0-9]*" value={input.seckillListPriceUsdt} onChange={(event) => setInput({ ...input, seckillListPriceUsdt: event.target.value })} disabled={pending} required /></label>
    <label>开始时间 · ISO 8601<input value={input.startsAt} onChange={(event) => setInput({ ...input, startsAt: event.target.value })} placeholder="2026-07-18T01:00:00.000Z" disabled={pending} required /></label>
    <label>Idempotency key<input minLength={8} maxLength={128} value={input.idempotencyKey} onChange={(event) => setInput({ ...input, idempotencyKey: event.target.value })} disabled={pending} required /></label>
  </div>{rulesBinding ? <p className="healthy-copy" role="status"><ShieldCheck aria-hidden="true" />{rulesBinding.versionId} · {rulesBinding.contentType} · PUBLISHED</p> : <p className="muted-copy">必须先从 Core 读取已发布的 SECKILL_RULES；不允许手写 policyVersion 或 content hash。</p>}<button className="button button-primary" type="submit" disabled={pending || !rulesBinding}><TimerReset aria-hidden="true" />{pending ? '提交中' : '创建并锁定活动库存'}</button></form>;
}

function ControlForms(props: {
  targetSessionId: string; setTargetSessionId(value: string): void;
  forceReason: string; setForceReason(value: string): void; forceKey: string; setForceKey(value: string): void;
  prizeAmount: string; setPrizeAmount(value: string): void; prizeKey: string; setPrizeKey(value: string): void;
  resumeKey: string; setResumeKey(value: string): void; pendingAction: string;
  onForceClose(event: FormEvent): void; onPrize(event: FormEvent): void; onResume(event: FormEvent): void;
}) {
  const pending = Boolean(props.pendingAction);
  return <section className="seckill-control-grid" aria-label="ADMIN 秒杀控制动作"><div className="panel seckill-control-target"><div className="panel-heading"><div><p className="section-kicker">ADMIN ONLY</p><h2>目标场次</h2></div><ShieldCheck aria-hidden="true" /></div><label>Session ID<input pattern="0x[0-9a-fA-F]{64}" value={props.targetSessionId} onChange={(event) => props.setTargetSessionId(event.target.value)} disabled={pending} required /></label><p className="muted-copy">Breaker 恢复需指向已终局强制截止的历史场次。</p></div>
    <form className="panel seckill-control-form" onSubmit={props.onForceClose}><div className="panel-heading"><div><p className="section-kicker">GOVERNANCE SAFE</p><h2>强制截止</h2></div><Ban aria-hidden="true" /></div><label>原因代码<input minLength={2} maxLength={128} value={props.forceReason} onChange={(event) => props.setForceReason(event.target.value.toUpperCase())} disabled={pending} required /></label><IdempotencyInput value={props.forceKey} setValue={props.setForceKey} pending={pending} /><button className="button button-danger" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'force-close' ? '创建中' : '创建强制截止动作'}</button></form>
    <form className="panel seckill-control-form" onSubmit={props.onPrize}><div className="panel-heading"><div><p className="section-kicker">OPERATIONS SAFE → CUSTODY SAFE</p><h2>奖池注入</h2></div><WalletCards aria-hidden="true" /></div><label>金额 · USDT atomic<input inputMode="numeric" pattern="[1-9][0-9]*" value={props.prizeAmount} onChange={(event) => props.setPrizeAmount(event.target.value)} disabled={pending} required /></label><IdempotencyInput value={props.prizeKey} setValue={props.setPrizeKey} pending={pending} /><button className="button button-primary" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'prize' ? '创建中' : '创建奖池注入动作'}</button></form>
    <form className="panel seckill-control-form" onSubmit={props.onResume}><div className="panel-heading"><div><p className="section-kicker">SECKILL_PURCHASE BREAKER</p><h2>恢复购买</h2></div><Send aria-hidden="true" /></div><IdempotencyInput value={props.resumeKey} setValue={props.setResumeKey} pending={pending} /><button className="button button-primary" type="submit" disabled={pending || !props.targetSessionId}>{props.pendingAction === 'resume' ? '创建中' : '创建 breaker 恢复动作'}</button></form>
  </section>;
}

function IdempotencyInput({ value, setValue, pending }: { value: string; setValue(value: string): void; pending: boolean }) {
  return <label>Idempotency key<input minLength={8} maxLength={128} value={value} onChange={(event) => setValue(event.target.value)} disabled={pending} required /></label>;
}

function ActionDetail({ action }: { action: SeckillGovernanceActionProjection }) {
  return <><div className="seckill-action-status"><ActionState state={action.state} confirmations={action.confirmations} /><span>{action.canonical === null ? 'canonical 待验证' : `canonical = ${String(action.canonical)}`}</span></div><dl className="definition-grid seckill-governance-facts"><div><dt>Action / Session</dt><dd><code>{action.actionId}</code><small>{action.sessionId}</small></dd></div><div><dt>Policy / Kind</dt><dd>{action.policyVersion} / {action.actionKind}</dd></div><div><dt>Executor / nonce</dt><dd><code>{action.executorWallet}</code><small>{action.executorNonce ?? '待分配'}</small></dd></div><div><dt>Submitted Tx / evidence</dt><dd><code>{action.submittedTxHash ?? '未提交'}</code><small>{action.executionEvidenceHash ?? '—'}</small></dd></div><div><dt>Execution / block</dt><dd><code>{action.executionTxHash ?? '未执行'}</code><small>{action.blockNumber ?? '—'} / {action.blockHash ?? '—'}</small></dd></div><div><dt>Evidence / calldata</dt><dd><code>{action.evidenceHash}</code><small>{action.calldataHash}</small></dd></div><div><dt>Secondary signer</dt><dd><code>{action.secondarySigner ?? '未签名'}</code><small>nonce {action.approvalNonce ?? '—'} / {action.approvalDeadline ?? '—'}</small></dd></div><div><dt>Allowed actions</dt><dd>{action.allowedActions.join(', ') || '无'}</dd></div></dl>{action.sessionPlan ? <PlanEvidence action={action} /> : null}{action.prizeInjection ? <PrizeEvidence action={action} /> : null}{['REORGED', 'FAILED'].includes(action.state) ? <div className="resource-state resource-state-error"><AlertTriangle aria-hidden="true" /><div><strong>{action.state} · 动作未生效</strong><p>{action.state === 'REORGED' ? '链上证据已回滚；等待 Core 修复或新动作。' : '治理钱包执行失败；不改写场次或账本终态。'}</p></div></div> : null}</>;
}

function PlanEvidence({ action }: { action: SeckillGovernanceActionProjection }) {
  const plan = action.sessionPlan!;
  return <div className="seckill-plan-evidence"><h3>场次计划 · 参数只读</h3><dl><div><dt>Product / SKU</dt><dd>{plan.productId} / {plan.skuId}</dd></div><div><dt>CMS rules / policy</dt><dd><code>{plan.rulesContentHash}</code><small>policyVersion {action.policyVersion}</small></dd></div><div><dt>Inventory lock</dt><dd>{plan.inventory} · {plan.inventoryLockState}<small>{plan.releasedAt ?? '未释放'}</small></dd></div><div><dt>Price</dt><dd>{plan.seckillListPriceUsdt} USDT atomic</dd></div><div><dt>Timers</dt><dd>{plan.timers.mainDurationSeconds}s / {plan.timers.relayInitialSeconds}s / +{plan.timers.relayIncrementSeconds}s / cap {plan.timers.relayCapSeconds}s</dd></div></dl></div>;
}

function PrizeEvidence({ action }: { action: SeckillGovernanceActionProjection }) {
  const item = action.prizeInjection!;
  return <div className="seckill-plan-evidence"><h3>奖池注入证据</h3><dl><div><dt>Amount</dt><dd>{item.amountUsdt} USDT atomic</dd></div><div><dt>Operations wallet</dt><dd><code>{item.operationsWalletAddress}</code></dd></div><div><dt>Settlement wallet</dt><dd><code>{item.settlementWalletAddress}</code></dd></div><div><dt>Journal / reversal</dt><dd>{item.finalJournalId ?? '等待 FINAL'}<small>{item.reversalJournalId ?? '无回滚分录'}</small></dd></div></dl></div>;
}

function ActionState({ state, confirmations }: Pick<SeckillGovernanceActionProjection, 'state' | 'confirmations'>) {
  const ready = state === 'FINAL';
  const failed = ['REORGED', 'FAILED'].includes(state);
  const label = state === 'FINAL' ? 'FINAL · 已终局' : state === 'MINED' ? `MINED · ${confirmations}/15` : state === 'REORGED' ? 'REORGED · 已回滚' : state === 'FAILED' ? 'FAILED · 未生效' : state;
  return <span className={ready ? 'status-chip status-ready' : failed ? 'status-chip status-blocked' : 'status-chip'}>{ready ? <CheckCircle2 aria-hidden="true" /> : failed ? <AlertTriangle aria-hidden="true" /> : <TimerReset aria-hidden="true" />}{label}</span>;
}

function LoadingView({ label }: { label: string }) {
  return <div className="resource-state" role="status" aria-busy="true"><RefreshCw className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>等待 Core 真实响应。</p></div></div>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div>;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '秒杀治理 Core 能力不可用', status: 503 });
}

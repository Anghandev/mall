import type {
  RiskAppeal,
  RiskAppealDecisionRequest,
  RiskOverview,
  RiskRestriction,
  RiskRestrictionCreateRequest,
  RiskSubjectType,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  FileWarning,
  KeyRound,
  RefreshCw,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { commonStateLabel, humanizeError, shortAddress, shortId } from '../display';
import {
  createRiskRestriction,
  decideRiskAppeal,
  fetchRiskOverview,
  overrideRiskRestriction,
  submitRiskAppeal,
} from '../riskAdminApi';

const emptyRestriction: RiskRestrictionCreateRequest = {
  subjectType: 'WALLET',
  subjectValue: '',
  restrictionKind: 'NEW_PAYMENT',
  reasonCode: '',
  evidenceHash: '',
  idempotencyKey: '',
};

export function RiskPage() {
  const { connect, session, status } = useCoreSession();
  const [overview, setOverview] = useState<RiskOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [mutationError, setMutationError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [restrictionInput, setRestrictionInput] = useState<RiskRestrictionCreateRequest>(() => ({ ...emptyRestriction, idempotencyKey: riskCommandKey('risk-restriction') }));
  const [appealRestrictionId, setAppealRestrictionId] = useState('');
  const [appealStatementHash, setAppealStatementHash] = useState('');
  const [appealEvidenceHash, setAppealEvidenceHash] = useState('');
  const [appealIdempotencyKey, setAppealIdempotencyKey] = useState(() => riskCommandKey('risk-appeal'));
  const [overrideRestrictionId, setOverrideRestrictionId] = useState('');
  const [overrideReasonCode, setOverrideReasonCode] = useState('');
  const [overrideEvidenceHash, setOverrideEvidenceHash] = useState('');
  const [decisionAppealId, setDecisionAppealId] = useState('');
  const [decision, setDecision] = useState<RiskAppealDecisionRequest['decision']>('APPROVE');
  const [decisionReasonCode, setDecisionReasonCode] = useState('');
  const [decisionEvidenceHash, setDecisionEvidenceHash] = useState('');

  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const canAppeal = isAdmin || (session?.roles.includes('OPERATOR') ?? false);

  useEffect(() => {
    setOverview(null);
    setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchRiskOverview(session.token, controller.signal)
      .then(setOverview)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(asCoreError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const runMutation = async (key: string, action: () => Promise<unknown>, success: string) => {
    if (!session) return;
    setPendingAction(key);
    setMutationError(null);
    setNotice('');
    try {
      await action();
      setNotice(success);
      setReload((value) => value + 1);
    } catch (cause) {
      setMutationError(asCoreError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const submitRestriction = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin) return;
    void runMutation('restriction', async () => {
      await createRiskRestriction({
        ...restrictionInput,
        reasonCode: toReasonCode(restrictionInput.reasonCode, 'MANUAL_RISK_REVIEW'),
      }, session.token);
      setRestrictionInput((current) => ({ ...current, idempotencyKey: riskCommandKey('risk-restriction') }));
    }, '人工限制已由系统记录，正在刷新证据。');
  };

  const submitAppeal = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canAppeal) return;
    void runMutation('appeal', async () => {
      await submitRiskAppeal({
        restrictionId: appealRestrictionId,
        statementHash: appealStatementHash,
        evidenceHash: appealEvidenceHash,
        idempotencyKey: appealIdempotencyKey,
      }, session.token);
      setAppealIdempotencyKey(riskCommandKey('risk-appeal'));
    }, '申诉已提交，等待管理员裁决。');
  };

  const submitOverride = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin) return;
    void runMutation('override', () => overrideRiskRestriction(overrideRestrictionId, {
      reasonCode: toReasonCode(overrideReasonCode, 'MANUAL_RELEASE'),
      evidenceHash: overrideEvidenceHash,
    }, session.token), '限制已标记为已解除。');
  };

  const submitDecision = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin) return;
    void runMutation('decision', () => decideRiskAppeal(decisionAppealId, {
      decision,
      reasonCode: toReasonCode(decisionReasonCode, decision === 'APPROVE' ? 'APPEAL_APPROVED' : 'APPEAL_REJECTED'),
      evidenceHash: decisionEvidenceHash,
    }, session.token), `申诉已${decision === 'APPROVE' ? '批准' : '拒绝'}，正在刷新证据。`);
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">交易风控</p>
          <h1>风控处置中心</h1>
          <p>调查高链上手续费、IP/设备关联和取消行为；限制只阻断新下单，履约、接管、仲裁、对账和最终确认保持可用。</p>
        </div>
        <div className="requirement-list"><code>限制处置</code><code>申诉裁决</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt risk-session-prompt" role="status" aria-label="风控数据状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>真实风险证据仅向管理员、运营和审计开放。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}
          </button>
        </section>
      ) : !canRead ? (
        <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有平台风控读取权限', status: 403 })} />
      ) : null}

      {loading ? <LoadingView /> : null}
      {error ? <ErrorView error={error} /> : null}
      {mutationError ? <ErrorView error={mutationError} /> : null}
      {notice ? <p className="healthy-copy risk-notice" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}

      {overview ? (
        <>
          <section className="risk-toolbar" aria-label="风控投影摘要">
            <div><span>生成时间</span><strong>{overview.generatedAt}</strong></div>
            <div><span>异常观察</span><strong>{overview.observations.length}</strong></div>
            <div><span>生效限制</span><strong>{overview.restrictions.filter((item) => item.state === 'ACTIVE').length}</strong></div>
            <div><span>待处理申诉</span><strong>{overview.appeals.filter((item) => item.state === 'PENDING').length}</strong></div>
            <button className="icon-button light-icon-button" type="button" aria-label="刷新风控证据" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" /></button>
          </section>

          <RoleBoundary isAdmin={isAdmin} canAppeal={canAppeal} />

          <section className="risk-grid">
            <article className="panel risk-data-panel risk-restrictions-panel">
              <div className="panel-heading"><div><p className="section-kicker">限制记录</p><h2>限制与黑名单</h2></div><Ban aria-hidden="true" /></div>
              <RestrictionTable
                restrictions={overview.restrictions}
                isAdmin={isAdmin}
                canAppeal={canAppeal}
                onAppeal={setAppealRestrictionId}
                onOverride={setOverrideRestrictionId}
              />
            </article>

            <article className="panel risk-data-panel">
              <div className="panel-heading"><div><p className="section-kicker">申诉记录</p><h2>申诉与裁决</h2></div><Scale aria-hidden="true" /></div>
              <AppealTable appeals={overview.appeals} isAdmin={isAdmin} onDecide={setDecisionAppealId} />
            </article>
          </section>

          {(isAdmin || canAppeal) ? (
            <section className="risk-command-grid" aria-label="风控授权操作">
              {isAdmin ? (
                <ManualRestrictionForm
                  input={restrictionInput}
                  setInput={setRestrictionInput}
                  pending={pendingAction === 'restriction'}
                  onSubmit={submitRestriction}
                />
              ) : null}
              {canAppeal ? (
                <AppealForm
                  restrictionId={appealRestrictionId}
                  setRestrictionId={setAppealRestrictionId}
                  statementHash={appealStatementHash}
                  setStatementHash={setAppealStatementHash}
                  evidenceHash={appealEvidenceHash}
                  setEvidenceHash={setAppealEvidenceHash}
                  idempotencyKey={appealIdempotencyKey}
                  setIdempotencyKey={setAppealIdempotencyKey}
                  pending={pendingAction === 'appeal'}
                  onSubmit={submitAppeal}
                />
              ) : null}
              {isAdmin ? (
                <OverrideForm
                  restrictionId={overrideRestrictionId}
                  setRestrictionId={setOverrideRestrictionId}
                  reasonCode={overrideReasonCode}
                  setReasonCode={setOverrideReasonCode}
                  evidenceHash={overrideEvidenceHash}
                  setEvidenceHash={setOverrideEvidenceHash}
                  pending={pendingAction === 'override'}
                  onSubmit={submitOverride}
                />
              ) : null}
              {isAdmin ? (
                <DecisionForm
                  appealId={decisionAppealId}
                  setAppealId={setDecisionAppealId}
                  decision={decision}
                  setDecision={setDecision}
                  reasonCode={decisionReasonCode}
                  setReasonCode={setDecisionReasonCode}
                  evidenceHash={decisionEvidenceHash}
                  setEvidenceHash={setDecisionEvidenceHash}
                  pending={pendingAction === 'decision'}
                  onSubmit={submitDecision}
                />
              ) : null}
            </section>
          ) : null}

          <section className="panel risk-data-panel">
            <div className="panel-heading"><div><p className="section-kicker">异常信号</p><h2>异常观察证据</h2></div><FileWarning aria-hidden="true" /></div>
            <ObservationTable overview={overview} />
          </section>

          {overview.decisionBlocked.length > 0 ? (
            <section className="panel dashboard-blockers">
              <div className="panel-heading"><div><p className="section-kicker">安全关闭</p><h2>暂未发布的能力</h2></div><AlertTriangle aria-hidden="true" /></div>
              <div className="dashboard-blocker-list">{overview.decisionBlocked.map((item) => (
                <article key={item.capability}><AlertTriangle aria-hidden="true" /><div><strong>{capabilityLabel(item.capability)}</strong><p>系统明确返回不可用，当前界面不推断、不模拟。</p></div><span className="status-chip status-blocked">{reasonLabel(item.reasonCode)}</span></article>
              ))}</div>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function RoleBoundary({ isAdmin, canAppeal }: { isAdmin: boolean; canAppeal: boolean }) {
  const label = isAdmin ? '管理员可人工限制、解除、申诉和裁决' : canAppeal ? '运营只可提交申诉' : '审计只读';
  return <div className="risk-role-boundary" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{label}</strong><p>所有写操作仍由系统重新验证权限并写入审计证据。</p></div></div>;
}

function RestrictionTable({ restrictions, isAdmin, canAppeal, onAppeal, onOverride }: {
  restrictions: readonly RiskRestriction[];
  isAdmin: boolean;
  canAppeal: boolean;
  onAppeal(value: string): void;
  onOverride(value: string): void;
}) {
  if (!restrictions.length) return <EmptyState title="没有限制记录" detail="当前没有限制记录。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>对象</th><th>限制</th><th>状态</th><th>处理依据</th><th>时间</th><th>操作</th></tr></thead><tbody>{restrictions.map((item) => (
    <tr key={item.restrictionId}>
      <td><strong>{subjectTypeLabel(item.subjectType)}</strong><code title={item.subjectValue}>{item.subjectType === 'WALLET' ? shortAddress(item.subjectValue) : shortId(item.subjectValue)}</code></td>
      <td><strong>{restrictionKindLabel(item.restrictionKind)}</strong><small>{triggerTypeLabel(item.triggerType)} · {reasonLabel(item.reasonCode)}</small></td>
      <td><StateChip state={item.state} /></td>
      <td><strong>{item.sourceObservationId ? '来自异常观察' : '人工提交'}</strong><details className="technical-details compact"><summary>高级证据</summary><code title={item.evidenceHash}>{shortId(item.evidenceHash)}</code><small>{item.sourceObservationId ? shortId(item.sourceObservationId) : '人工证据'}</small></details></td>
      <td><strong>{item.startsAt}</strong><small>{item.expiresAt ? `到期 ${item.expiresAt}` : '无自动过期时间'}</small></td>
      <td><div className="risk-row-actions">{canAppeal && item.state === 'ACTIVE' ? <button className="button button-quiet" type="button" onClick={() => onAppeal(item.restrictionId)}>选择申诉</button> : null}{isAdmin && item.state === 'ACTIVE' ? <button className="button button-danger" type="button" onClick={() => onOverride(item.restrictionId)}>选择解除</button> : null}{item.state !== 'ACTIVE' ? <span>只读终态</span> : null}</div></td>
    </tr>
  ))}</tbody></table></div>;
}

function AppealTable({ appeals, isAdmin, onDecide }: { appeals: readonly RiskAppeal[]; isAdmin: boolean; onDecide(value: string): void }) {
  if (!appeals.length) return <EmptyState title="没有申诉记录" detail="待处理数量以系统返回为准。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>申诉</th><th>限制</th><th>状态</th><th>提交依据</th><th>裁决结果</th><th>操作</th></tr></thead><tbody>{appeals.map((item) => (
    <tr key={item.appealId}>
      <td><code title={item.appealId}>{shortId(item.appealId)}</code><small title={item.submittedBy}>{shortAddress(item.submittedBy)}</small></td>
      <td><code title={item.restrictionId}>{shortId(item.restrictionId)}</code></td>
      <td><StateChip state={item.state} /></td>
      <td><strong>已提交</strong><details className="technical-details compact"><summary>高级申诉证据</summary><code title={item.statementHash}>{shortId(item.statementHash)}</code><small title={item.evidenceHash}>{shortId(item.evidenceHash)}</small></details></td>
      <td><strong>{item.decisionReasonCode ? reasonLabel(item.decisionReasonCode) : '待裁决'}</strong><details className="technical-details compact"><summary>高级裁决证据</summary><code title={item.decisionEvidenceHash ?? undefined}>{item.decisionEvidenceHash ? shortId(item.decisionEvidenceHash) : '—'}</code></details></td>
      <td>{isAdmin && item.state === 'PENDING' ? <button className="button button-primary" type="button" onClick={() => onDecide(item.appealId)}>选择裁决</button> : <span>只读</span>}</td>
    </tr>
  ))}</tbody></table></div>;
}

function ObservationTable({ overview }: { overview: RiskOverview }) {
  if (!overview.observations.length) return <EmptyState title="没有异常观察" detail="空列表表示当前查询无记录，不等同于系统健康。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>风险信号</th><th>钱包</th><th>IP / 设备</th><th>处理建议</th><th>时间</th></tr></thead><tbody>{overview.observations.map((item) => (
    <tr key={item.observationId}>
      <td><strong>{signalTypeLabel(item.signalType)}</strong><small>{sourceTypeLabel(item.sourceType)}</small></td>
      <td><code title={item.walletAddress}>{shortAddress(item.walletAddress)}</code><small>{item.resourceId ? shortId(item.resourceId) : '—'}</small></td>
      <td><code title={item.ipHash ?? undefined}>{item.ipHash ? shortId(item.ipHash) : '—'}</code><small title={item.deviceHash ?? undefined}>{item.deviceHash ? shortId(item.deviceHash) : '—'}</small></td>
      <td><strong>{riskSuggestion(item.signalType)}</strong><details className="technical-details compact"><summary>高级证据</summary><code title={item.evidenceHash}>{shortId(item.evidenceHash)}</code><small>{item.txHash ? `交易 ${shortId(item.txHash)}` : '无交易凭证'} · 手续费价格 ${item.gasPriceWei ?? '—'}</small></details></td>
      <td><strong>{item.observedAt}</strong><small>记录 {item.recordedAt}</small></td>
    </tr>
  ))}</tbody></table></div>;
}

function ManualRestrictionForm({ input, setInput, pending, onSubmit }: {
  input: RiskRestrictionCreateRequest;
  setInput(value: RiskRestrictionCreateRequest): void;
  pending: boolean;
  onSubmit(event: FormEvent): void;
}) {
  const setSubjectType = (subjectType: RiskSubjectType) => setInput({ ...input, subjectType, subjectValue: '' });
  const setExpiresAt = (expiresAt: string) => {
    if (expiresAt) setInput({ ...input, expiresAt });
    else {
      const { expiresAt: _removed, ...withoutExpiry } = input;
      setInput(withoutExpiry);
    }
  };
  return <form className="panel risk-command-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">管理员操作</p><h2>人工限制</h2></div><Ban aria-hidden="true" /></div><div className="risk-form-grid">
    <label>主体类型<select value={input.subjectType} onChange={(event) => setSubjectType(event.target.value as RiskSubjectType)} disabled={pending}><option value="WALLET">钱包</option><option value="IP">IP</option><option value="DEVICE">设备</option></select></label>
    <label>限制类型<select value={input.restrictionKind} onChange={(event) => setInput({ ...input, restrictionKind: event.target.value as RiskRestrictionCreateRequest['restrictionKind'] })} disabled={pending}><option value="NEW_PAYMENT">限制新下单</option><option value="BLACKLIST">黑名单</option></select></label>
    <label className="risk-field-wide">主体值<input value={input.subjectValue} onChange={(event) => setInput({ ...input, subjectValue: event.target.value })} placeholder={input.subjectType === 'WALLET' ? '0x... 钱包地址' : '0x... 系统凭证'} pattern={input.subjectType === 'WALLET' ? '0x[0-9a-fA-F]{40}' : '0x[0-9a-fA-F]{64}'} aria-describedby="risk-subject-hint" disabled={pending} required /><small id="risk-subject-hint">IP 和设备只提交不可逆系统凭证，不提交原始隐私信息。</small></label>
    <ReasonField label="限制原因（可不填）" value={input.reasonCode} setValue={(reasonCode) => setInput({ ...input, reasonCode })} pending={pending} />
    <HashField label="系统证据编号" help="从风险观察、订单或客服凭证里复制；没有系统编号不要手填。" value={input.evidenceHash} setValue={(evidenceHash) => setInput({ ...input, evidenceHash })} pending={pending} />
    <label>过期时间（可不填）<input type="datetime-local" value={isoToDateTimeLocal(input.expiresAt ?? '')} onChange={(event) => setExpiresAt(dateTimeLocalToIso(event.target.value))} disabled={pending} /><small>不填表示不自动过期。</small></label>
    <IdempotencyField value={input.idempotencyKey} setValue={(idempotencyKey) => setInput({ ...input, idempotencyKey })} pending={pending} />
  </div><button className="button button-primary" type="submit" disabled={pending}><ShieldCheck aria-hidden="true" />{pending ? '提交中' : '创建人工限制'}</button></form>;
}

function AppealForm(props: HashCommandProps & { statementHash: string; setStatementHash(value: string): void; idempotencyKey: string; setIdempotencyKey(value: string): void }) {
  return <form className="panel risk-command-form" onSubmit={props.onSubmit}><div className="panel-heading"><div><p className="section-kicker">管理员 / 运营</p><h2>提交申诉</h2></div><FileWarning aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="限制编号" help="点上方限制记录里的“选择申诉”会自动填。" value={props.restrictionId} setValue={props.setRestrictionId} pending={props.pending} />
    <HashField label="申诉说明编号" help="从客服/审核系统复制，不懂不要手填。" value={props.statementHash} setValue={props.setStatementHash} pending={props.pending} />
    <HashField label="补充证据编号" help="从系统证据里复制 0x 编号。" value={props.evidenceHash} setValue={props.setEvidenceHash} pending={props.pending} />
    <IdempotencyField value={props.idempotencyKey} setValue={props.setIdempotencyKey} pending={props.pending} />
  </div><button className="button button-primary" type="submit" disabled={props.pending}><FileWarning aria-hidden="true" />{props.pending ? '提交中' : '提交申诉'}</button></form>;
}

type HashCommandProps = {
  restrictionId: string;
  setRestrictionId(value: string): void;
  evidenceHash: string;
  setEvidenceHash(value: string): void;
  pending: boolean;
  onSubmit(event: FormEvent): void;
};

function OverrideForm(props: HashCommandProps & { reasonCode: string; setReasonCode(value: string): void }) {
  return <form className="panel risk-command-form" onSubmit={props.onSubmit}><div className="panel-heading"><div><p className="section-kicker">管理员操作</p><h2>人工解除</h2></div><CheckCircle2 aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="限制编号" help="点上方限制记录里的“选择解除”会自动填。" value={props.restrictionId} setValue={props.setRestrictionId} pending={props.pending} />
    <ReasonField label="解除原因（可不填）" value={props.reasonCode} setValue={props.setReasonCode} pending={props.pending} />
    <HashField label="解除证据编号" help="从系统证据里复制 0x 编号。" value={props.evidenceHash} setValue={props.setEvidenceHash} pending={props.pending} />
  </div><button className="button button-danger" type="submit" disabled={props.pending}><CheckCircle2 aria-hidden="true" />{props.pending ? '提交中' : '解除生效限制'}</button></form>;
}

function DecisionForm({ appealId, setAppealId, decision, setDecision, reasonCode, setReasonCode, evidenceHash, setEvidenceHash, pending, onSubmit }: {
  appealId: string; setAppealId(value: string): void; decision: RiskAppealDecisionRequest['decision']; setDecision(value: RiskAppealDecisionRequest['decision']): void;
  reasonCode: string; setReasonCode(value: string): void; evidenceHash: string; setEvidenceHash(value: string): void; pending: boolean; onSubmit(event: FormEvent): void;
}) {
  return <form className="panel risk-command-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">管理员操作</p><h2>申诉裁决</h2></div><Scale aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="申诉编号" help="点上方申诉记录里的“选择裁决”会自动填。" value={appealId} setValue={setAppealId} pending={pending} />
    <label>裁决<select value={decision} onChange={(event) => setDecision(event.target.value as RiskAppealDecisionRequest['decision'])} disabled={pending}><option value="APPROVE">通过申诉</option><option value="REJECT">拒绝申诉</option></select></label>
    <ReasonField label="裁决原因（可不填）" value={reasonCode} setValue={setReasonCode} pending={pending} />
    <HashField label="裁决证据编号" help="从系统证据里复制 0x 编号。" value={evidenceHash} setValue={setEvidenceHash} pending={pending} />
  </div><button className="button button-primary" type="submit" disabled={pending}><Scale aria-hidden="true" />{pending ? '提交中' : '提交裁决'}</button></form>;
}

function HashField({ help, label, value, setValue, pending }: { help?: string; label: string; value: string; setValue(value: string): void; pending: boolean }) {
  return <label>{label}<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="0x 开头的系统编号" pattern="0x[0-9a-fA-F]{64}" disabled={pending} required />{help ? <small>{help}</small> : null}</label>;
}

function ReasonField({ label, value, setValue, pending }: { label: string; value: string; setValue(value: string): void; pending: boolean }) {
  return <label>{label}<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="例如：人工复核" disabled={pending} /><small>不填会使用系统默认原因；填写中文也会自动转成系统可保存的原因码。</small></label>;
}

function IdempotencyField({ value }: { value: string; setValue(value: string): void; pending: boolean }) {
  return <input type="hidden" value={value} readOnly />;
}

function toReasonCode(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const upper = trimmed.toUpperCase();
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(upper)) return upper;
  return `${fallback}_${reasonHash(trimmed)}`.slice(0, 64);
}

function reasonHash(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
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

function StateChip({ state }: { state: RiskRestriction['state'] | RiskAppeal['state'] }) {
  const complete = ['EXPIRED', 'OVERRIDDEN', 'APPROVED', 'REJECTED'].includes(state);
  return <span className={complete ? 'status-chip status-ready' : 'status-chip status-blocked'}>{complete ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{commonStateLabel(state)}</span>;
}

function LoadingView() {
  return <div className="resource-state risk-loading" role="status" aria-busy="true"><RefreshCw className="spin" aria-hidden="true" /><div><strong>正在读取风控数据</strong><p>观察、限制和申诉均等待真实响应。</p></div></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-table"><ShieldCheck aria-hidden="true" /><h3>{title}</h3><p>{detail}</p></div>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error risk-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.status === 403 ? '没有权限' : '操作失败'}</strong><p>{humanizeError(error)}</p></div></div>;
}

function asCoreError(cause: unknown) {
  if (cause instanceof CoreApiError) return cause;
  if (cause instanceof Error) return new CoreApiError({ code: 'InvalidRequest', message: cause.message, status: 400 });
  return new CoreApiError({ code: 'ExternalBlocked', message: '风控服务暂时不可用', status: 503 });
}

function subjectTypeLabel(value: string) {
  return ({ WALLET: '钱包', IP: 'IP', DEVICE: '设备' } as Record<string, string>)[value] ?? value;
}

function restrictionKindLabel(value: string) {
  return ({ NEW_PAYMENT: '限制新下单', BLACKLIST: '黑名单' } as Record<string, string>)[value] ?? value;
}

function triggerTypeLabel(value: string) {
  return ({
    HIGH_GAS: '高链上手续费',
    TOO_MANY_WALLETS: '钱包关联过多',
    CANCEL_BURST: '频繁取消',
    MANUAL: '人工处理',
  } as Record<string, string>)[value] ?? value;
}

function signalTypeLabel(value: string) {
  return ({
    HIGH_GAS: '高链上手续费',
    WALLET_CLUSTER: '钱包关联',
    DEVICE_CLUSTER: '设备关联',
    CANCEL_BURST: '频繁取消',
    MANUAL_OBSERVATION: '人工观察',
  } as Record<string, string>)[value] ?? value;
}

function riskSuggestion(value: string) {
  return ({
    HIGH_GAS: '复核是否抢跑或异常加价',
    WALLET_CLUSTER: '复核同设备或同 IP 钱包',
    DEVICE_CLUSTER: '复核设备关联',
    CANCEL_BURST: '复核频繁取消订单',
    MANUAL_OBSERVATION: '等待人工判断',
  } as Record<string, string>)[value] ?? '等待人工判断';
}

function sourceTypeLabel(value: string) {
  return ({
    PAYMENT: '支付',
    ORDER: '订单',
    WALLET: '钱包',
    DEVICE: '设备',
    MANUAL: '人工',
  } as Record<string, string>)[value] ?? value;
}

function reasonLabel(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\bMANUAL\b/g, '人工')
    .replace(/\bREVIEW\b/g, '复核')
    .replace(/\bHIGH GAS\b/g, '高链上手续费')
    .replace(/\bBLACKLIST\b/g, '黑名单')
    .replace(/\bNEW PAYMENT\b/g, '新下单')
    .replace(/\bOVERRIDE\b/g, '解除');
}

function capabilityLabel(value: string) {
  return ({
    RISK_RESTRICTIONS: '风险限制',
    RISK_APPEALS: '风险申诉',
    RISK_OBSERVATIONS: '异常观察',
  } as Record<string, string>)[value] ?? value;
}

function riskCommandKey(scope: string) {
  return `${scope}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

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
  const [restrictionInput, setRestrictionInput] = useState<RiskRestrictionCreateRequest>(emptyRestriction);
  const [appealRestrictionId, setAppealRestrictionId] = useState('');
  const [appealStatementHash, setAppealStatementHash] = useState('');
  const [appealEvidenceHash, setAppealEvidenceHash] = useState('');
  const [appealIdempotencyKey, setAppealIdempotencyKey] = useState('');
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
    void runMutation('restriction', () => createRiskRestriction(restrictionInput, session.token), '人工限制已由 Core 记录，正在刷新证据。');
  };

  const submitAppeal = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canAppeal) return;
    void runMutation('appeal', () => submitRiskAppeal({
      restrictionId: appealRestrictionId,
      statementHash: appealStatementHash,
      evidenceHash: appealEvidenceHash,
      idempotencyKey: appealIdempotencyKey,
    }, session.token), '申诉已提交，等待 ADMIN 裁决。');
  };

  const submitOverride = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin) return;
    void runMutation('override', () => overrideRiskRestriction(overrideRestrictionId, {
      reasonCode: overrideReasonCode,
      evidenceHash: overrideEvidenceHash,
    }, session.token), '限制已由 Core 标记为 OVERRIDDEN。');
  };

  const submitDecision = (event: FormEvent) => {
    event.preventDefault();
    if (!session || !isAdmin) return;
    void runMutation('decision', () => decideRiskAppeal(decisionAppealId, {
      decision,
      reasonCode: decisionReasonCode,
      evidenceHash: decisionEvidenceHash,
    }, session.token), `申诉已${decision === 'APPROVE' ? '批准' : '拒绝'}，正在刷新证据。`);
  };

  return (
    <>
      <header className="page-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div>
          <p className="eyebrow">TRANSACTION RISK EVIDENCE</p>
          <h1>风控处置中心</h1>
          <p>调查高 Gas、IP/设备关联和取消行为；限制只阻断新报价，履约、接管、仲裁、对账和 finality 保持可用。</p>
        </div>
        <div className="requirement-list"><code>ADM-RISK-001 / 004—006</code><code>GAP-ADM-011</code></div>
      </header>

      {!session ? (
        <section className="panel session-prompt risk-session-prompt" role="status" aria-label="风控数据状态">
          <div><KeyRound aria-hidden="true" /><span><strong>连接平台钱包</strong><small>真实风险证据仅向 ADMIN、OPERATOR 和 AUDITOR 开放。</small></span></div>
          <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
            <KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}
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
            <div><span>Generated</span><strong>{overview.generatedAt}</strong></div>
            <div><span>异常观察</span><strong>{overview.observations.length}</strong></div>
            <div><span>生效限制</span><strong>{overview.restrictions.filter((item) => item.state === 'ACTIVE').length}</strong></div>
            <div><span>待处理申诉</span><strong>{overview.appeals.filter((item) => item.state === 'PENDING').length}</strong></div>
            <button className="icon-button light-icon-button" type="button" aria-label="刷新风控证据" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" /></button>
          </section>

          <RoleBoundary isAdmin={isAdmin} canAppeal={canAppeal} />

          <section className="risk-grid">
            <article className="panel risk-data-panel risk-restrictions-panel">
              <div className="panel-heading"><div><p className="section-kicker">ACTIVE / EXPIRED / OVERRIDDEN</p><h2>限制与黑名单</h2></div><Ban aria-hidden="true" /></div>
              <RestrictionTable
                restrictions={overview.restrictions}
                isAdmin={isAdmin}
                canAppeal={canAppeal}
                onAppeal={setAppealRestrictionId}
                onOverride={setOverrideRestrictionId}
              />
            </article>

            <article className="panel risk-data-panel">
              <div className="panel-heading"><div><p className="section-kicker">APPEAL AUDIT</p><h2>申诉与裁决</h2></div><Scale aria-hidden="true" /></div>
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
            <div className="panel-heading"><div><p className="section-kicker">IMMUTABLE SIGNALS</p><h2>异常观察证据</h2></div><FileWarning aria-hidden="true" /></div>
            <ObservationTable overview={overview} />
          </section>

          {overview.decisionBlocked.length > 0 ? (
            <section className="panel dashboard-blockers">
              <div className="panel-heading"><div><p className="section-kicker">FAIL-CLOSED EVIDENCE</p><h2>暂未发布的能力</h2></div><AlertTriangle aria-hidden="true" /></div>
              <div className="dashboard-blocker-list">{overview.decisionBlocked.map((item) => (
                <article key={item.capability}><AlertTriangle aria-hidden="true" /><div><strong>{item.capability}</strong><p>Core 明确返回，当前界面不推断、不模拟。</p></div><span className="status-chip status-blocked">{item.reasonCode}</span></article>
              ))}</div>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function RoleBoundary({ isAdmin, canAppeal }: { isAdmin: boolean; canAppeal: boolean }) {
  const label = isAdmin ? 'ADMIN 可人工限制、解除、申诉和裁决' : canAppeal ? 'OPERATOR 只可提交申诉' : 'AUDITOR 只读';
  return <div className="risk-role-boundary" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{label}</strong><p>所有写操作仍由 Core 重新验证数据库 RBAC 并写入审计证据。</p></div></div>;
}

function RestrictionTable({ restrictions, isAdmin, canAppeal, onAppeal, onOverride }: {
  restrictions: readonly RiskRestriction[];
  isAdmin: boolean;
  canAppeal: boolean;
  onAppeal(value: string): void;
  onOverride(value: string): void;
}) {
  if (!restrictions.length) return <EmptyState title="没有限制记录" detail="Core 返回真实空列表，未填充合成记录。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>主体</th><th>限制</th><th>状态</th><th>证据</th><th>时间</th><th>授权操作</th></tr></thead><tbody>{restrictions.map((item) => (
    <tr key={item.restrictionId}>
      <td><strong>{item.subjectType}</strong><code>{item.subjectValue}</code></td>
      <td><strong>{item.restrictionKind}</strong><small>{item.triggerType} · {item.reasonCode}</small></td>
      <td><StateChip state={item.state} /></td>
      <td><code>{item.evidenceHash}</code><small>{item.sourceObservationId ?? '人工证据'}</small></td>
      <td><strong>{item.startsAt}</strong><small>{item.expiresAt ? `expires ${item.expiresAt}` : '无自动过期时间'}</small></td>
      <td><div className="risk-row-actions">{canAppeal && item.state === 'ACTIVE' ? <button className="button button-quiet" type="button" onClick={() => onAppeal(item.restrictionId)}>选择申诉</button> : null}{isAdmin && item.state === 'ACTIVE' ? <button className="button button-danger" type="button" onClick={() => onOverride(item.restrictionId)}>选择解除</button> : null}{item.state !== 'ACTIVE' ? <span>只读终态</span> : null}</div></td>
    </tr>
  ))}</tbody></table></div>;
}

function AppealTable({ appeals, isAdmin, onDecide }: { appeals: readonly RiskAppeal[]; isAdmin: boolean; onDecide(value: string): void }) {
  if (!appeals.length) return <EmptyState title="没有申诉记录" detail="待处理数量以 Core 返回为准。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>申诉</th><th>限制</th><th>状态</th><th>提交证据</th><th>裁决证据</th><th>授权操作</th></tr></thead><tbody>{appeals.map((item) => (
    <tr key={item.appealId}>
      <td><code>{item.appealId}</code><small>{item.submittedBy}</small></td>
      <td><code>{item.restrictionId}</code></td>
      <td><StateChip state={item.state} /></td>
      <td><code>{item.statementHash}</code><small>{item.evidenceHash}</small></td>
      <td><strong>{item.decisionReasonCode ?? '—'}</strong><code>{item.decisionEvidenceHash ?? '—'}</code></td>
      <td>{isAdmin && item.state === 'PENDING' ? <button className="button button-primary" type="button" onClick={() => onDecide(item.appealId)}>选择裁决</button> : <span>只读</span>}</td>
    </tr>
  ))}</tbody></table></div>;
}

function ObservationTable({ overview }: { overview: RiskOverview }) {
  if (!overview.observations.length) return <EmptyState title="没有异常观察" detail="空列表表示当前查询无记录，不等同于系统健康。" />;
  return <div className="table-scroll"><table className="data-table risk-table"><thead><tr><th>信号</th><th>钱包</th><th>IP / Device</th><th>链上证据</th><th>时间</th></tr></thead><tbody>{overview.observations.map((item) => (
    <tr key={item.observationId}>
      <td><strong>{item.signalType}</strong><small>{item.sourceType}</small></td>
      <td><code>{item.walletAddress}</code><small>{item.resourceId ?? '—'}</small></td>
      <td><code>{item.ipHash ?? '—'}</code><small>{item.deviceHash ?? '—'}</small></td>
      <td><code>{item.evidenceHash}</code><small>{item.txHash ?? '无 TxHash'} · gas {item.gasPriceWei ?? '—'}</small></td>
      <td><strong>{item.observedAt}</strong><small>recorded {item.recordedAt}</small></td>
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
  return <form className="panel risk-command-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">ADMIN ONLY</p><h2>人工限制</h2></div><Ban aria-hidden="true" /></div><div className="risk-form-grid">
    <label>主体类型<select value={input.subjectType} onChange={(event) => setSubjectType(event.target.value as RiskSubjectType)} disabled={pending}><option value="WALLET">WALLET</option><option value="IP">IP</option><option value="DEVICE">DEVICE</option></select></label>
    <label>限制类型<select value={input.restrictionKind} onChange={(event) => setInput({ ...input, restrictionKind: event.target.value as RiskRestrictionCreateRequest['restrictionKind'] })} disabled={pending}><option value="NEW_PAYMENT">NEW_PAYMENT</option><option value="BLACKLIST">BLACKLIST</option></select></label>
    <label className="risk-field-wide">主体值<input value={input.subjectValue} onChange={(event) => setInput({ ...input, subjectValue: event.target.value })} placeholder={input.subjectType === 'WALLET' ? '0x... wallet address' : '0x... bytes32 hash'} pattern={input.subjectType === 'WALLET' ? '0x[0-9a-fA-F]{40}' : '0x[0-9a-fA-F]{64}'} aria-describedby="risk-subject-hint" disabled={pending} required /><small id="risk-subject-hint">IP 和设备只提交不可逆 bytes32 哈希，不提交原始 PII。</small></label>
    <ReasonField label="原因代码" value={input.reasonCode} setValue={(reasonCode) => setInput({ ...input, reasonCode })} pending={pending} />
    <HashField label="证据哈希" value={input.evidenceHash} setValue={(evidenceHash) => setInput({ ...input, evidenceHash })} pending={pending} />
    <label>过期时间 · ISO 8601<input value={input.expiresAt ?? ''} onChange={(event) => setExpiresAt(event.target.value)} placeholder="2026-07-17T08:00:00.000Z" disabled={pending} /></label>
    <IdempotencyField value={input.idempotencyKey} setValue={(idempotencyKey) => setInput({ ...input, idempotencyKey })} pending={pending} />
  </div><button className="button button-primary" type="submit" disabled={pending}><ShieldCheck aria-hidden="true" />{pending ? '提交中' : '创建人工限制'}</button></form>;
}

function AppealForm(props: HashCommandProps & { statementHash: string; setStatementHash(value: string): void; idempotencyKey: string; setIdempotencyKey(value: string): void }) {
  return <form className="panel risk-command-form" onSubmit={props.onSubmit}><div className="panel-heading"><div><p className="section-kicker">ADMIN / OPERATOR</p><h2>提交申诉</h2></div><FileWarning aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="限制 ID" value={props.restrictionId} setValue={props.setRestrictionId} pending={props.pending} />
    <HashField label="陈述哈希" value={props.statementHash} setValue={props.setStatementHash} pending={props.pending} />
    <HashField label="证据哈希" value={props.evidenceHash} setValue={props.setEvidenceHash} pending={props.pending} />
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
  return <form className="panel risk-command-form" onSubmit={props.onSubmit}><div className="panel-heading"><div><p className="section-kicker">ADMIN ONLY</p><h2>人工解除</h2></div><CheckCircle2 aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="限制 ID" value={props.restrictionId} setValue={props.setRestrictionId} pending={props.pending} />
    <ReasonField label="解除原因" value={props.reasonCode} setValue={props.setReasonCode} pending={props.pending} />
    <HashField label="解除证据哈希" value={props.evidenceHash} setValue={props.setEvidenceHash} pending={props.pending} />
  </div><button className="button button-danger" type="submit" disabled={props.pending}><CheckCircle2 aria-hidden="true" />{props.pending ? '提交中' : '解除生效限制'}</button></form>;
}

function DecisionForm({ appealId, setAppealId, decision, setDecision, reasonCode, setReasonCode, evidenceHash, setEvidenceHash, pending, onSubmit }: {
  appealId: string; setAppealId(value: string): void; decision: RiskAppealDecisionRequest['decision']; setDecision(value: RiskAppealDecisionRequest['decision']): void;
  reasonCode: string; setReasonCode(value: string): void; evidenceHash: string; setEvidenceHash(value: string): void; pending: boolean; onSubmit(event: FormEvent): void;
}) {
  return <form className="panel risk-command-form" onSubmit={onSubmit}><div className="panel-heading"><div><p className="section-kicker">ADMIN ONLY</p><h2>申诉裁决</h2></div><Scale aria-hidden="true" /></div><div className="risk-form-grid">
    <HashField label="申诉 ID" value={appealId} setValue={setAppealId} pending={pending} />
    <label>裁决<select value={decision} onChange={(event) => setDecision(event.target.value as RiskAppealDecisionRequest['decision'])} disabled={pending}><option value="APPROVE">APPROVE</option><option value="REJECT">REJECT</option></select></label>
    <ReasonField label="裁决原因" value={reasonCode} setValue={setReasonCode} pending={pending} />
    <HashField label="裁决证据哈希" value={evidenceHash} setValue={setEvidenceHash} pending={pending} />
  </div><button className="button button-primary" type="submit" disabled={pending}><Scale aria-hidden="true" />{pending ? '提交中' : '提交裁决'}</button></form>;
}

function HashField({ label, value, setValue, pending }: { label: string; value: string; setValue(value: string): void; pending: boolean }) {
  return <label>{label}<input value={value} onChange={(event) => setValue(event.target.value)} placeholder="0x... 64 hex" pattern="0x[0-9a-fA-F]{64}" disabled={pending} required /></label>;
}

function ReasonField({ label, value, setValue, pending }: { label: string; value: string; setValue(value: string): void; pending: boolean }) {
  return <label>{label}<input value={value} onChange={(event) => setValue(event.target.value.toUpperCase())} placeholder="MANUAL_REVIEW" pattern="[A-Z][A-Z0-9_]{1,63}" disabled={pending} required /></label>;
}

function IdempotencyField({ value, setValue, pending }: { value: string; setValue(value: string): void; pending: boolean }) {
  return <label>幂等键<input value={value} onChange={(event) => setValue(event.target.value)} minLength={8} maxLength={128} placeholder="risk-command-unique-key" disabled={pending} required /></label>;
}

function StateChip({ state }: { state: RiskRestriction['state'] | RiskAppeal['state'] }) {
  const complete = ['EXPIRED', 'OVERRIDDEN', 'APPROVED', 'REJECTED'].includes(state);
  return <span className={complete ? 'status-chip status-ready' : 'status-chip status-blocked'}>{complete ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{state}</span>;
}

function LoadingView() {
  return <div className="resource-state risk-loading" role="status" aria-busy="true"><RefreshCw className="spin" aria-hidden="true" /><div><strong>正在读取 Core 风控投影</strong><p>观察、限制和申诉均等待真实响应。</p></div></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-table"><ShieldCheck aria-hidden="true" /><h3>{title}</h3><p>{detail}</p></div>;
}

function ErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error risk-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.status === 403 ? 'Forbidden' : error.code}</strong><p>{error.message}</p></div></div>;
}

function asCoreError(cause: unknown) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message: '风控 Core 能力不可用', status: 503 });
}

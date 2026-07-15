import type { PolicyDraftProjection } from '@abu24k/core-artifacts';
import { AlertTriangle, Ban, Check, FileDiff, KeyRound, LockKeyhole, Plus, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import {
  createPolicyApprovalChallenge,
  createPolicyDraft,
  fetchPolicyDrafts,
  proposePolicyToSafe,
  submitPolicySecondarySignature,
} from '../settlementAdminApi';

const governanceSteps = [
  { label: 'RBAC 授权', detail: 'ADMIN 创建批准挑战', icon: ShieldCheck },
  { label: '二次钱包签名', detail: 'eth_signTypedData_v4 / nonce / deadline', icon: KeyRound },
  { label: 'Safe 多签', detail: 'Core 提交不可变 calldata 提案', icon: WalletCards },
  { label: '发布 policyVersion', detail: '15 confirmations 后仅未来生效', icon: FileDiff },
] as const;

export function PolicyPage() {
  const { connect, session, status } = useCoreSession();
  const [drafts, setDrafts] = useState<readonly PolicyDraftProjection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [payload, setPayload] = useState('{}');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [nonce, setNonce] = useState('');
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canEdit = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const selected = useMemo(() => drafts.find((draft) => draft.draftId === selectedId) ?? null, [drafts, selectedId]);

  useEffect(() => {
    setDrafts([]); setSelectedId(''); setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController(); setLoading(true);
    void fetchPolicyDrafts(session.token, controller.signal).then((items) => { setDrafts(items); setSelectedId(items[0]?.draftId ?? ''); }).catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const createDraft = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canEdit) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(payload) as Record<string, unknown>; if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); }
    catch { setError(new CoreApiError({ code: 'InvalidResponse', message: '政策 payload 必须是 JSON object', status: 400 })); return; }
    setLoading(true); setError(null); setNotice('');
    try { const created = await createPolicyDraft({ payload: parsed, idempotencyKey }, session.token); setDrafts((current) => [created, ...current]); setSelectedId(created.draftId); setNotice(`Core 已创建草稿 ${created.draftId}`); }
    catch (cause) { setError(asCoreError(cause)); }
    finally { setLoading(false); }
  };

  const signSecondary = async () => {
    if (!session || !isAdmin || !selected || !window.ethereum) return;
    setLoading(true); setError(null); setNotice('');
    try {
      const challenge = await createPolicyApprovalChallenge(selected.draftId, nonce, deadline, session.token);
      const signature = await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [session.walletAddress, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw new CoreApiError({ code: 'InvalidResponse', message: '钱包未返回二次签名', status: 400 });
      const updated = await submitPolicySecondarySignature(selected.draftId, { nonce, deadline, signature }, session.token);
      replaceDraft(updated); setNotice(`二次签名已由 Core 验证，状态 ${updated.state}`);
    } catch (cause) { setError(asCoreError(cause)); }
    finally { setLoading(false); }
  };

  const proposeSafe = async () => {
    if (!session || !isAdmin || !selected) return;
    setLoading(true); setError(null); setNotice('');
    try { const updated = await proposePolicyToSafe(selected.draftId, session.token); replaceDraft(updated); setNotice(`Safe 提案已创建，状态 ${updated.state}`); }
    catch (cause) { setError(asCoreError(cause)); }
    finally { setLoading(false); }
  };

  const replaceDraft = (updated: PolicyDraftProjection) => setDrafts((current) => current.map((draft) => draft.draftId === updated.draftId ? updated : draft));

  return (
    <>
      <header className="page-header"><div className="page-icon"><FileDiff aria-hidden="true" /></div><div><p className="eyebrow">版本化资金规则</p><h1>政策治理工作台</h1><p>草稿、校验、二次签名和 Safe 提案均由 Core 绑定；页面不计算比例或 calldata。</p></div><div className="requirement-list"><code>ADM-POL-001—006</code><code>ADM-CLEAR-002 / 003</code></div></header>
      <section className="policy-layout">
        <article className="panel policy-editor">
          <div className="panel-heading"><div><p className="section-kicker">GET /v2/admin/policy-drafts</p><h2>政策草稿</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
          {!session ? <div className="session-prompt"><div><strong>连接平台治理钱包</strong><p>读取需平台角色；批准挑战、二次签名与 Safe 提案仅 ADMIN。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />SIWE 连接</button></div>
            : !canRead ? <ErrorView title="Forbidden" message="当前会话没有政策读取权限。" />
              : <><div className="table-scroll"><table className="data-table"><thead><tr><th>草稿</th><th>版本</th><th>状态</th><th>校验</th><th>更新时间</th></tr></thead><tbody>{drafts.map((draft) => <tr key={draft.draftId} className={selectedId === draft.draftId ? 'is-selected' : undefined}><td><button className="table-link" type="button" onClick={() => setSelectedId(draft.draftId)}>{draft.draftId}</button></td><td>{draft.nextPolicyVersion}</td><td>{draft.state}</td><td>{draft.validationErrors.length ? `${draft.validationErrors.length} 项阻断` : '通过'}</td><td>{draft.updatedAt}</td></tr>)}</tbody></table></div>{!drafts.length && !loading ? <p className="muted-copy">Core 返回真实空草稿列表。</p> : null}</>}
          {canEdit ? <form className="admin-editor-form" onSubmit={createDraft}><h3>创建新草稿</h3><label>政策 payload · JSON object<textarea rows={8} value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck={false} /></label><label>Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} minLength={8} required /></label><button className="button button-primary" type="submit" disabled={loading || idempotencyKey.length < 8}><Plus aria-hidden="true" />提交 Core 校验</button></form> : null}
        </article>
        <aside className="panel governance-panel">
          <p className="section-kicker">Publish evidence</p><h2>{selected ? `Draft ${selected.draftId}` : '选择草稿'}</h2>
          <ol className="governance-steps">{governanceSteps.map(({ label, detail, icon: Icon }, index) => <li key={label}><span className="step-index">{index + 1}</span><Icon aria-hidden="true" /><div><strong>{label}</strong><small>{detail}</small></div><span className="step-state">{selected?.state ?? '等待草稿'}</span></li>)}</ol>
          {selected ? <><dl className="definition-grid"><div><dt>Policy hash</dt><dd><code>{selected.policyHash ?? '待校验'}</code></dd></div><div><dt>Safe TxHash</dt><dd><code>{selected.safeTxHash ?? '待提案'}</code></dd></div></dl>{selected.validationErrors.length ? <ul className="validation-list">{selected.validationErrors.map((item) => <li key={`${item.code}:${item.field}`}><AlertTriangle aria-hidden="true" />{item.field}: {item.code}</li>)}</ul> : null}</> : null}
          <label>二次签名 nonce<input inputMode="numeric" value={nonce} onChange={(event) => setNonce(event.target.value)} disabled={!isAdmin || !selected} /></label><label>签名 deadline · Unix 秒<input inputMode="numeric" value={deadline} onChange={(event) => setDeadline(event.target.value)} disabled={!isAdmin || !selected} /></label>
          <button className="button button-primary button-full" type="button" onClick={() => void signSecondary()} disabled={!isAdmin || !selected || !nonce || !deadline || loading}><Check aria-hidden="true" />请求并提交二次签名</button>
          <button className="button button-quiet button-full" type="button" onClick={() => void proposeSafe()} disabled={!isAdmin || selected?.state !== 'SECONDARY_SIGNED' || loading}><WalletCards aria-hidden="true" />提交 Safe 多签提案</button>
          <p className="button-explanation">Safe 达到 15 confirmations 前，历史订单与进行中场次不受影响。</p>
        </aside>
      </section>
      {error ? <ErrorView title={error.code} message={error.message} /> : null}{notice ? <p className="healthy-copy" role="status"><Check aria-hidden="true" />{notice}</p> : null}
      <section className="snapshot-rule"><LockKeyhole aria-hidden="true" /><div><strong>不可变快照边界</strong><p>新版本只影响未来报价、新订单和新场次；历史订单与进行中场次永久使用原快照。</p></div></section>
    </>
  );
}

function ErrorView({ title, message }: { title: string; message: string }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{title}</strong><p>{message}</p></div></div>; }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '政策治理 Core 能力不可用', status: 503 }); }

import type { PolicyDraftProjection } from '@abu24k/core-artifacts';
import { AlertTriangle, Ban, Check, FileDiff, KeyRound, LockKeyhole, Plus, RefreshCw, Save, ShieldCheck, Trash2, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import {
  createPolicyApprovalChallenge,
  createPolicyDraft,
  fetchPolicyDrafts,
  proposePolicyToSafe,
  submitPolicySecondarySignature,
  updatePolicyDraft,
} from '../settlementAdminApi';

type Destination = { account: string; weightBps: string };
type PolicyField = { name: string; label: string; kind: 'number' | 'atomic' | 'address' | 'hash'; locked?: boolean };

const governanceSteps = [
  { label: 'RBAC 授权', detail: 'ADMIN 创建批准挑战', icon: ShieldCheck },
  { label: '二次钱包签名', detail: 'Core 指定独立 signer', icon: KeyRound },
  { label: 'Safe 多签', detail: 'Core 提交不可变 calldata 提案', icon: WalletCards },
  { label: '发布 policyVersion', detail: '15 confirmations 后仅未来生效', icon: FileDiff },
] as const;

const policyGroups: readonly { title: string; fields: readonly PolicyField[] }[] = [
  { title: '支付与 NPL 路由', fields: [
    { name: 'usdtPaymentBps', label: 'USDT 支付 BPS', kind: 'number', locked: true },
    { name: 'nplPaymentBps', label: 'NPL 支付 BPS', kind: 'number', locked: true },
    { name: 'nplBurnListPriceBps', label: 'NPL Burn BPS', kind: 'number', locked: true },
    { name: 'nplRewardListPriceBps', label: 'NPL 奖励 BPS', kind: 'number', locked: true },
    { name: 'platformFeeBps', label: '平台服务费 BPS', kind: 'number', locked: true },
    { name: 'seckillPrizeBps', label: '额外商家秒杀收益 BPS', kind: 'number', locked: true },
  ] },
  { title: 'NPL 奖励分配', fields: [
    { name: 'genesisBps', label: 'Genesis BPS', kind: 'number', locked: true },
    { name: 'directReferralBps', label: '直推 BPS', kind: 'number', locked: true },
    { name: 'districtBps', label: '区县 BPS', kind: 'number', locked: true },
    { name: 'cityBps', label: '城市 BPS', kind: 'number', locked: true },
    { name: 'provinceBps', label: '省级 BPS', kind: 'number', locked: true },
    { name: 'regionBps', label: '区域 BPS', kind: 'number', locked: true },
    { name: 'operationsBps', label: '运营 BPS', kind: 'number', locked: true },
  ] },
  { title: '秒杀计时', fields: [
    { name: 'seckillMainDuration', label: '主场秒数', kind: 'number', locked: true },
    { name: 'relayInitial', label: '接力初始秒数', kind: 'number', locked: true },
    { name: 'relayIncrement', label: '每单增加秒数', kind: 'number', locked: true },
    { name: 'relayCap', label: '接力上限秒数', kind: 'number', locked: true },
  ] },
  { title: '确认与保证金', fields: [
    { name: 'requiredConfirmations', label: '最终确认数', kind: 'number', locked: true },
    { name: 'merchantGuaranteeMinimumUsdt', label: '商家保证金下限 atomic', kind: 'atomic', locked: true },
  ] },
  { title: '钱包与证据', fields: [
    { name: 'platformServiceFeeSafe', label: 'Platform Service Fee Safe', kind: 'address' },
    { name: 'usdtCustodySafe', label: 'USDT Custody Safe', kind: 'address' },
    { name: 'nplRewardSafe', label: 'NPL Reward Safe', kind: 'address' },
    { name: 'operationsTreasurySafe', label: 'Operations Treasury Safe', kind: 'address' },
    { name: 'circulationPool', label: '流通池账户', kind: 'address' },
    { name: 'concessionDestinationSetHash', label: '让利目的集合哈希', kind: 'hash' },
    { name: 'decisionEvidenceHash', label: '商业决定证据哈希', kind: 'hash' },
  ] },
] as const;

const allPolicyFields = policyGroups.flatMap((group) => group.fields);
const frozenDefaults: Record<string, string> = {
  usdtPaymentBps: '7000', nplPaymentBps: '3000', nplBurnListPriceBps: '2000', nplRewardListPriceBps: '1000',
  platformFeeBps: '100', seckillPrizeBps: '0',
  genesisBps: '200', directReferralBps: '100', districtBps: '120', cityBps: '80', provinceBps: '60', regionBps: '40', operationsBps: '400',
  seckillMainDuration: '3600', relayInitial: '60', relayIncrement: '30', relayCap: '60',
  requiredConfirmations: '15', merchantGuaranteeMinimumUsdt: '1000000000000000000000',
};

export function PolicyPage() {
  const { connect, session, status } = useCoreSession();
  const [drafts, setDrafts] = useState<readonly PolicyDraftProjection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [rulesContentHash, setRulesContentHash] = useState('');
  const [fields, setFields] = useState<Record<string, string>>(() => initialFields());
  const [genesisNodeDestinations, setGenesisNodeDestinations] = useState<Destination[]>([]);
  const [operationsDestinations, setOperationsDestinations] = useState<Destination[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newKey('policy'));
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canEdit = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const selected = useMemo(() => drafts.find((draft) => draft.draftId === selectedId) ?? null, [drafts, selectedId]);
  const editedPayload = useMemo(() => policyPayload(rulesContentHash, fields, genesisNodeDestinations, operationsDestinations), [rulesContentHash, fields, genesisNodeDestinations, operationsDestinations]);
  const hasUnsavedChanges = selected ? canonicalJson(selected.payload) !== canonicalJson(editedPayload) : false;

  useEffect(() => {
    setDrafts([]); setSelectedId(''); setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController(); setLoading(true);
    void fetchPolicyDrafts(session.token, controller.signal).then((items) => { setDrafts(items); setSelectedId(items[0]?.draftId ?? ''); }).catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  useEffect(() => {
    if (selected) loadPayload(selected.payload, setRulesContentHash, setFields, setGenesisNodeDestinations, setOperationsDestinations);
  }, [selected?.draftId, selected?.updatedAt]);

  const createDraft = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canEdit) return;
    await run(async () => {
      const created = await createPolicyDraft({ payload: editedPayload, idempotencyKey }, session.token);
      setDrafts((current) => [created, ...current]); setSelectedId(created.draftId); setIdempotencyKey(newKey('policy'));
      setNotice(`Core 已创建草稿 ${created.draftId}`);
    });
  };

  const saveDraft = async () => {
    if (!session || !canEdit || !selected) return;
    await run(async () => { const updated = await updatePolicyDraft(selected.draftId, { payload: editedPayload }, session.token); replaceDraft(updated); setNotice(`草稿 ${updated.draftId} 已保存并重新校验`); });
  };

  const signSecondary = async () => {
    if (!session || !isAdmin || !selected || !window.ethereum) return;
    await run(async () => {
      const { nonce, deadline } = approvalWindow();
      const challenge = await createPolicyApprovalChallenge(selected.draftId, nonce, deadline, session.token);
      const signature = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [challenge.signer, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw invalid('钱包未返回二次签名');
      const updated = await submitPolicySecondarySignature(selected.draftId, { nonce, deadline, signature }, session.token);
      replaceDraft(updated); setNotice(`二次签名已由 Core 验证，状态 ${updated.state}`);
    });
  };

  const proposeSafe = async () => {
    if (!session || !isAdmin || !selected) return;
    await run(async () => { const updated = await proposePolicyToSafe(selected.draftId, session.token); replaceDraft(updated); setNotice(`Safe 提案已创建，状态 ${updated.state}`); });
  };

  const replaceDraft = (updated: PolicyDraftProjection) => setDrafts((current) => current.map((draft) => draft.draftId === updated.draftId ? updated : draft));
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };

  return <>
    <header className="page-header"><div className="page-icon"><FileDiff aria-hidden="true" /></div><div><p className="eyebrow">版本化资金规则</p><h1>政策治理工作台</h1><p>填写现有政策字段，由 Core 校验、生成签名挑战和 Safe 提案。未确认比例保持空值并显示 DecisionBlocked。</p></div><div className="requirement-list"><code>ADM-POL-001—006</code><code>ADM-CLEAR-002 / 003</code></div></header>
    <section className="policy-layout">
      <article className="panel policy-editor">
        <div className="panel-heading"><div><p className="section-kicker">政策草稿</p><h2>版本与表单</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
        {!session ? <div className="session-prompt"><div><strong>连接平台治理钱包</strong><p>读取需平台角色；签名挑战和 Safe 提案仅 ADMIN。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />SIWE 连接</button></div>
          : !canRead ? <ErrorView title="Forbidden" message="当前会话没有政策读取权限。" />
            : <><div className="table-scroll"><table className="data-table"><thead><tr><th>草稿</th><th>版本</th><th>状态</th><th>校验</th><th>更新时间</th></tr></thead><tbody>{drafts.map((draft) => <tr key={draft.draftId} className={selectedId === draft.draftId ? 'is-selected' : undefined}><td><button className="table-link" type="button" onClick={() => setSelectedId(draft.draftId)}>{draft.draftId}</button></td><td>{draft.nextPolicyVersion}</td><td>{draft.state}</td><td>{draft.validationErrors.length ? `${draft.validationErrors.length} 项阻断` : '通过'}</td><td>{draft.updatedAt}</td></tr>)}</tbody></table></div>{!drafts.length && !loading ? <p className="muted-copy">Core 返回真实空草稿列表。</p> : null}</>}
        {canEdit ? <form className="governed-form" onSubmit={createDraft}>
          <fieldset><legend>版本绑定</legend><div className="form-grid"><label>规则内容 hash<input value={rulesContentHash} onChange={(event) => setRulesContentHash(event.target.value)} placeholder="0x…" required /></label></div></fieldset>
          {policyGroups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend><div className="governed-field-grid">{group.fields.map((field) => <label key={field.name}>{field.label}<input inputMode={field.kind === 'number' || field.kind === 'atomic' ? 'numeric' : undefined} value={fields[field.name] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.name]: event.target.value }))} /></label>)}</div></fieldset>)}
          <DestinationEditor title="Genesis 节点奖励目的账户" value={genesisNodeDestinations} onChange={setGenesisNodeDestinations} />
          <DestinationEditor title="运营目的账户" value={operationsDestinations} onChange={setOperationsDestinations} />
          <div className="governed-form-actions"><button className="button button-primary" type="submit" disabled={loading}><Plus aria-hidden="true" />创建新草稿</button><button className="button button-quiet" type="button" onClick={() => void saveDraft()} disabled={!selected || !hasUnsavedChanges || loading}><Save aria-hidden="true" />保存选中草稿</button><span className={hasUnsavedChanges ? 'status-chip status-warning' : 'status-chip status-ready'}>{hasUnsavedChanges ? '存在未保存修改' : '编辑值与草稿一致'}</span></div>
        </form> : null}
      </article>
      <aside className="panel governance-panel">
        <p className="section-kicker">Publish evidence</p><h2>{selected ? `Draft ${selected.draftId}` : '选择草稿'}</h2>
        <ol className="governance-steps">{governanceSteps.map(({ label, detail, icon: Icon }, index) => <li key={label}><span className="step-index">{index + 1}</span><Icon aria-hidden="true" /><div><strong>{label}</strong><small>{detail}</small></div><span className="step-state">{selected?.state ?? '等待草稿'}</span></li>)}</ol>
        {selected ? <><dl className="definition-grid"><div><dt>保存草稿 hash</dt><dd><code>{selected.policyHash ?? '待校验'}</code></dd></div><div><dt>Safe TxHash</dt><dd><code>{selected.safeTxHash ?? '待提案'}</code></dd></div></dl>{selected.validationErrors.length ? <ul className="validation-list">{selected.validationErrors.map((item) => <li key={`${item.code}:${item.field}`}><AlertTriangle aria-hidden="true" />{item.field}: {item.code}</li>)}</ul> : null}<div className="value-comparison"><div><span>Core 保存的草稿值</span><code>{canonicalJson(selected.payload)}</code></div><div><span>当前编辑值</span><code>{canonicalJson(editedPayload)}</code></div></div></> : null}
        <button className="button button-primary button-full" type="button" onClick={() => void signSecondary()} disabled={!isAdmin || !selected || hasUnsavedChanges || selected.validationErrors.length > 0 || loading}><Check aria-hidden="true" />请求并提交二次签名</button>
        <button className="button button-quiet button-full" type="button" onClick={() => void proposeSafe()} disabled={!isAdmin || selected?.state !== 'SECONDARY_SIGNED' || loading}><WalletCards aria-hidden="true" />提交 Safe 多签提案</button>
        <p className="button-explanation">签名 nonce 与 5 分钟 deadline 由页面自动生成；钱包地址使用 Core challenge.signer。</p>
      </aside>
    </section>
    {error ? <ErrorView title={error.code} message={error.message} /> : null}{notice ? <p className="healthy-copy" role="status"><Check aria-hidden="true" />{notice}</p> : null}
    <section className="snapshot-rule"><LockKeyhole aria-hidden="true" /><div><strong>不可变快照边界</strong><p>新版本只影响未来报价、新订单和新场次；历史订单与进行中场次永久使用原快照。</p></div></section>
  </>;
}

function DestinationEditor({ title, value, onChange }: { title: string; value: Destination[]; onChange: (value: Destination[]) => void }) {
  return <fieldset><legend>{title}</legend><div className="destination-list">{value.map((item, index) => <div className="destination-row" key={`${title}-${index}`}><label>账户 {index + 1}<input aria-label={`${title}账户 ${index + 1}`} value={item.account} onChange={(event) => onChange(value.map((entry, child) => child === index ? { ...entry, account: event.target.value } : entry))} placeholder="0x…" /></label><label>权重 BPS<input aria-label={`${title}权重 ${index + 1}`} inputMode="numeric" value={item.weightBps} onChange={(event) => onChange(value.map((entry, child) => child === index ? { ...entry, weightBps: event.target.value } : entry))} /></label><button className="icon-button" type="button" title="删除目的账户" aria-label={`删除${title} ${index + 1}`} onClick={() => onChange(value.filter((_, child) => child !== index))}><Trash2 aria-hidden="true" /></button></div>)}</div><button className="button button-quiet" type="button" onClick={() => onChange([...value, { account: '', weightBps: '' }])}><Plus aria-hidden="true" />添加目的账户</button></fieldset>;
}

function initialFields() { return Object.fromEntries(allPolicyFields.map((field) => [field.name, frozenDefaults[field.name] ?? ''])); }
function policyPayload(rulesContentHash: string, fields: Record<string, string>, genesisNodeDestinations: Destination[], operationsDestinations: Destination[]) {
  const policy: Record<string, unknown> = {};
  for (const field of allPolicyFields) {
    const value = fields[field.name]?.trim();
    if (!value) continue;
    policy[field.name] = field.kind === 'number' ? integerValue(value) : value;
  }
  if (genesisNodeDestinations.length) policy.genesisNodeDestinations = destinations(genesisNodeDestinations);
  if (operationsDestinations.length) policy.operationsDestinations = destinations(operationsDestinations);
  return { rulesContentHash: rulesContentHash.trim(), policy };
}
function destinations(value: Destination[]) { return value.map((item) => ({ account: item.account.trim(), weightBps: integerValue(item.weightBps) })); }
function integerValue(value: string) { const parsed = Number(value); return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(parsed) ? parsed : value; }
function loadPayload(value: Record<string, unknown>, setRulesContentHash: (value: string) => void, setFields: (value: Record<string, string>) => void, setGenesisNodes: (value: Destination[]) => void, setOperations: (value: Destination[]) => void) {
  setRulesContentHash(String(value.rulesContentHash ?? ''));
  const policy = record(value.policy); const next = initialFields();
  for (const field of allPolicyFields) if (policy[field.name] !== undefined) next[field.name] = String(policy[field.name]);
  setFields(next); setGenesisNodes(readDestinations(policy.genesisNodeDestinations)); setOperations(readDestinations(policy.operationsDestinations));
}
function readDestinations(value: unknown): Destination[] { return Array.isArray(value) ? value.map((item) => { const child = record(item); return { account: String(child.account ?? ''), weightBps: String(child.weightBps ?? '') }; }) : []; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonicalJson(value: unknown) { return JSON.stringify(sortJson(value), null, 2); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)])); }
function approvalWindow() { return { nonce: randomNonce(), deadline: String(Math.floor(Date.now() / 1_000) + 300) }; }
function randomNonce() { const values = crypto.getRandomValues(new Uint32Array(2)); return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString(); }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function ErrorView({ title, message }: { title: string; message: string }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{title}</strong><p>{message}</p></div></div>; }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '政策治理 Core 能力不可用', status: 503 }); }

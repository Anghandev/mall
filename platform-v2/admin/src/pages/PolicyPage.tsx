import type { PolicyDraftProjection } from '@abu24k/core-artifacts';
import { AlertTriangle, Ban, Check, FileDiff, KeyRound, LockKeyhole, Plus, RefreshCw, Save, ShieldCheck, Trash2, WalletCards } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { commonStateLabel, formatUsdtInput, humanizeError, shortAddress, shortId } from '../display';
import { useCoreSession } from '../coreSession';
import {
  createPolicyApprovalChallenge,
  createPolicyDraft,
  fetchPolicyDrafts,
  executePolicyDraft,
  submitPolicySecondarySignature,
  updatePolicyDraft,
} from '../settlementAdminApi';

type Destination = { account: string; weightBps: string };
type PolicyField = { name: string; label: string; kind: 'number' | 'percent' | 'usdt' | 'address' | 'hash'; locked?: boolean };

const governanceSteps = [
  { label: '平台权限检查', detail: '只有管理员可以发布新规则', icon: ShieldCheck },
  { label: '二次钱包确认', detail: '系统会引导正确钱包签名', icon: KeyRound },
  { label: '提交发布执行', detail: '提交后等待系统最终确认', icon: WalletCards },
  { label: '发布规则版本', detail: '确认完成后只影响未来订单', icon: FileDiff },
] as const;

const policyGroups: readonly { title: string; fields: readonly PolicyField[] }[] = [
  { title: '支付与 NPL 路由', fields: [
    { name: 'usdtPaymentBps', label: 'USDT 支付比例（%）', kind: 'percent', locked: true },
    { name: 'nplPaymentBps', label: 'NPL 支付比例（%）', kind: 'percent', locked: true },
    { name: 'nplBurnListPriceBps', label: 'NPL 销毁比例（%）', kind: 'percent', locked: true },
    { name: 'nplRewardListPriceBps', label: 'NPL 奖励比例（%）', kind: 'percent', locked: true },
    { name: 'platformFeeBps', label: '平台服务费比例（%）', kind: 'percent', locked: true },
    { name: 'seckillPrizeBps', label: '额外商家秒杀收益比例（%）', kind: 'percent', locked: true },
  ] },
  { title: 'NPL 奖励分配', fields: [
    { name: 'genesisBps', label: '创世节点比例（%）', kind: 'percent', locked: true },
    { name: 'directReferralBps', label: '直推比例（%）', kind: 'percent', locked: true },
    { name: 'districtBps', label: '区县比例（%）', kind: 'percent', locked: true },
    { name: 'cityBps', label: '城市比例（%）', kind: 'percent', locked: true },
    { name: 'provinceBps', label: '省级比例（%）', kind: 'percent', locked: true },
    { name: 'regionBps', label: '区域比例（%）', kind: 'percent', locked: true },
    { name: 'operationsBps', label: '运营比例（%）', kind: 'percent', locked: true },
  ] },
  { title: '秒杀计时', fields: [
    { name: 'seckillMainDuration', label: '主场秒数', kind: 'number', locked: true },
    { name: 'relayInitial', label: '接力初始秒数', kind: 'number', locked: true },
    { name: 'relayIncrement', label: '每单增加秒数', kind: 'number', locked: true },
    { name: 'relayCap', label: '接力上限秒数', kind: 'number', locked: true },
  ] },
  { title: '确认参数', fields: [
    { name: 'requiredConfirmations', label: '最终确认数', kind: 'number', locked: true },
    { name: 'merchantGuaranteeMinimumUsdt', label: '历史链上资金字段（不作为经营门槛）', kind: 'usdt', locked: true },
  ] },
  { title: '钱包与证据', fields: [
    { name: 'platformServiceFeeWallet', label: '平台服务费收款钱包', kind: 'address' },
    { name: 'usdtSettlementWallet', label: 'USDT 货款结算钱包', kind: 'address' },
    { name: 'nplRewardWallet', label: 'NPL 奖励发放钱包', kind: 'address' },
    { name: 'operationsWallet', label: '运营钱包', kind: 'address' },
    { name: 'circulationPool', label: '流通池账户', kind: 'address' },
    { name: 'concessionDestinationSetHash', label: '让利分配凭证', kind: 'hash' },
    { name: 'decisionEvidenceHash', label: '商业决定凭证', kind: 'hash' },
  ] },
] as const;

const allPolicyFields = policyGroups.flatMap((group) => group.fields);
const frozenDefaults: Record<string, string> = {
  usdtPaymentBps: '7000', nplPaymentBps: '3000', nplBurnListPriceBps: '2000', nplRewardListPriceBps: '1000',
  platformFeeBps: '100', seckillPrizeBps: '0',
  genesisBps: '200', directReferralBps: '100', districtBps: '120', cityBps: '80', provinceBps: '60', regionBps: '40', operationsBps: '400',
  seckillMainDuration: '3600', relayInitial: '60', relayIncrement: '30', relayCap: '60',
  requiredConfirmations: '15', merchantGuaranteeMinimumUsdt: '0',
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
      setNotice(`系统已创建政策草稿 ${shortId(created.draftId)}。`);
    });
  };

  const saveDraft = async () => {
    if (!session || !canEdit || !selected) return;
    await run(async () => { const updated = await updatePolicyDraft(selected.draftId, { payload: editedPayload }, session.token); replaceDraft(updated); setNotice(`草稿 ${shortId(updated.draftId)} 已保存并重新校验。`); });
  };

  const signSecondary = async () => {
    if (!session || !isAdmin || !selected || !window.ethereum) return;
    await run(async () => {
      const { nonce, deadline } = approvalWindow();
      const challenge = await createPolicyApprovalChallenge(selected.draftId, nonce, deadline, session.token);
      const signature = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [challenge.signer, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw invalid('钱包未返回二次签名');
      const updated = await submitPolicySecondarySignature(selected.draftId, { nonce, deadline, signature }, session.token);
      replaceDraft(updated); setNotice(`二次确认已通过，当前状态：${commonStateLabel(updated.state)}。`);
    });
  };

  const executeDraft = async () => {
    if (!session || !isAdmin || !selected) return;
    await run(async () => { const updated = await executePolicyDraft(selected.draftId, session.token); replaceDraft(updated); setNotice(`政策执行已提交，当前状态：${commonStateLabel(updated.state)}。`); });
  };

  const replaceDraft = (updated: PolicyDraftProjection) => setDrafts((current) => current.map((draft) => draft.draftId === updated.draftId ? updated : draft));
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };

  return <>
    <header className="page-header">
      <div className="page-icon"><FileDiff aria-hidden="true" /></div>
      <div><p className="eyebrow">资金与交易规则</p><h1>规则治理工作台</h1><p>编辑未来生效的资金规则。页面负责引导签名和执行，历史订单、进行中场次不会被新版本改写。</p></div>
      <div className="requirement-list"><code>规则草稿</code><code>发布确认</code></div>
    </header>
    <section className="policy-layout">
      <article className="panel policy-editor">
        <div className="panel-heading"><div><p className="section-kicker">政策草稿</p><h2>版本与表单</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
        {!session ? <div className="session-prompt"><div><strong>连接平台治理钱包</strong><p>读取需要平台角色；发布需要管理员钱包确认。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}</button></div>
          : !canRead ? <ErrorView error={new CoreApiError({ code: 'Forbidden', message: '当前会话没有政策读取权限。', status: 403 })} />
            : <><div className="table-scroll"><table className="data-table"><thead><tr><th>草稿编号</th><th>版本</th><th>状态</th><th>校验</th><th>更新时间</th></tr></thead><tbody>{drafts.map((draft) => <tr key={draft.draftId} className={selectedId === draft.draftId ? 'is-selected' : undefined}><td><button className="table-link" type="button" onClick={() => setSelectedId(draft.draftId)} title={draft.draftId}>{shortId(draft.draftId)}</button></td><td>{draft.nextPolicyVersion}</td><td>{commonStateLabel(draft.state)}</td><td>{draft.validationErrors.length ? `${draft.validationErrors.length} 项需要处理` : '通过'}</td><td>{draft.updatedAt}</td></tr>)}</tbody></table></div>{!drafts.length && !loading ? <p className="muted-copy">当前没有政策草稿。</p> : null}</>}
        {canEdit ? <form className="governed-form" onSubmit={createDraft}>
          <fieldset><legend>版本绑定</legend><div className="form-grid"><label>规则文件编号<input value={rulesContentHash} onChange={(event) => setRulesContentHash(event.target.value)} placeholder="0x…" required /><small className="field-help">从内容中心已发布规则复制；系统保存完整编号。</small></label></div></fieldset>
          {policyGroups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend><div className="governed-field-grid">{group.fields.map((field) => <label key={field.name}>{field.label}<input inputMode={field.kind === 'number' ? 'numeric' : field.kind === 'percent' || field.kind === 'usdt' ? 'decimal' : undefined} value={fields[field.name] ?? ''} onChange={(event) => setFields((current) => ({ ...current, [field.name]: event.target.value }))} /></label>)}</div></fieldset>)}
          <DestinationEditor title="创世节点奖励目的账户" value={genesisNodeDestinations} onChange={setGenesisNodeDestinations} />
          <DestinationEditor title="运营奖励目的账户" value={operationsDestinations} onChange={setOperationsDestinations} />
          <div className="governed-form-actions"><button className="button button-primary" type="submit" disabled={loading}><Plus aria-hidden="true" />创建新草稿</button><button className="button button-quiet" type="button" onClick={() => void saveDraft()} disabled={!selected || !hasUnsavedChanges || loading}><Save aria-hidden="true" />保存选中草稿</button><span className={hasUnsavedChanges ? 'status-chip status-warning' : 'status-chip status-ready'}>{hasUnsavedChanges ? '存在未保存修改' : '编辑值与草稿一致'}</span></div>
        </form> : null}
      </article>
      <aside className="panel governance-panel">
        <p className="section-kicker">发布确认</p><h2>{selected ? `草稿 ${shortId(selected.draftId)}` : '选择草稿'}</h2>
        <ol className="governance-steps">{governanceSteps.map(({ label, detail, icon: Icon }, index) => <li key={label}><span className="step-index">{index + 1}</span><Icon aria-hidden="true" /><div><strong>{label}</strong><small>{detail}</small></div><span className="step-state">{commonStateLabel(selected?.state ?? '等待草稿')}</span></li>)}</ol>
        {selected ? <>
          {selected.validationErrors.length ? <ul className="validation-list">{selected.validationErrors.map((item) => <li key={`${item.code}:${item.field}`}><AlertTriangle aria-hidden="true" />{policyFieldLabel(item.field)}：{validationLabel(item.code)}</li>)}</ul> : <p className="healthy-copy"><Check aria-hidden="true" />草稿校验通过，可以继续二次确认。</p>}
          <details className="technical-details">
            <summary>发布核验信息</summary>
            <dl className="definition-grid"><div><dt>草稿凭证</dt><dd><code>{selected.policyHash ?? '待校验'}</code></dd></div><div><dt>执行记录</dt><dd><code>{selected.executionTxHash ?? '待执行'}</code></dd></div></dl>
            <div className="value-comparison"><div><span>系统保存的草稿值</span><code>{canonicalJson(selected.payload)}</code></div><div><span>当前编辑值</span><code>{canonicalJson(editedPayload)}</code></div></div>
          </details>
        </> : null}
        <button className="button button-primary button-full" type="button" onClick={() => void signSecondary()} disabled={!isAdmin || !selected || hasUnsavedChanges || selected.validationErrors.length > 0 || loading}><Check aria-hidden="true" />请求并提交二次确认</button>
        <button className="button button-quiet button-full" type="button" onClick={() => void executeDraft()} disabled={!isAdmin || selected?.state !== 'SECONDARY_SIGNED' || loading}><WalletCards aria-hidden="true" />提交发布执行</button>
        <p className="button-explanation">页面自动生成签名参数并引导正确钱包，不需要手填编号。</p>
      </aside>
    </section>
    {error ? <ErrorView error={error} /> : null}{notice ? <p className="healthy-copy" role="status"><Check aria-hidden="true" />{notice}</p> : null}
    <section className="snapshot-rule"><LockKeyhole aria-hidden="true" /><div><strong>不可变快照边界</strong><p>新版本只影响未来报价、新订单和新场次；历史订单与进行中场次永久使用原快照。</p></div></section>
  </>;
}

function DestinationEditor({ title, value, onChange }: { title: string; value: Destination[]; onChange: (value: Destination[]) => void }) {
  return <fieldset><legend>{title}</legend><div className="destination-list">{value.map((item, index) => <div className="destination-row" key={`${title}-${index}`}><label>账户 {index + 1}<input aria-label={`${title}账户 ${index + 1}`} value={item.account} onChange={(event) => onChange(value.map((entry, child) => child === index ? { ...entry, account: event.target.value } : entry))} placeholder="0x…" /></label><label>权重比例（%）<input aria-label={`${title}权重 ${index + 1}`} inputMode="decimal" value={item.weightBps} onChange={(event) => onChange(value.map((entry, child) => child === index ? { ...entry, weightBps: event.target.value } : entry))} /></label><button className="icon-button" type="button" title="删除目的账户" aria-label={`删除${title} ${index + 1}`} onClick={() => onChange(value.filter((_, child) => child !== index))}><Trash2 aria-hidden="true" /></button></div>)}</div><button className="button button-quiet" type="button" onClick={() => onChange([...value, { account: '', weightBps: '' }])}><Plus aria-hidden="true" />添加目的账户</button></fieldset>;
}

function initialFields() { return Object.fromEntries(allPolicyFields.map((field) => [field.name, frozenDefaults[field.name] ?? ''])); }
function policyPayload(rulesContentHash: string, fields: Record<string, string>, genesisNodeDestinations: Destination[], operationsDestinations: Destination[]) {
  const policy: Record<string, unknown> = {};
  for (const field of allPolicyFields) {
    const value = fields[field.name]?.trim();
    if (!value) continue;
    policy[field.name] = field.kind === 'number'
      ? integerValue(value)
      : field.kind === 'percent'
        ? percentToBps(value)
        : field.kind === 'usdt'
          ? usdtInputToAtomic(value)
          : value;
  }
  if (genesisNodeDestinations.length) policy.genesisNodeDestinations = destinations(genesisNodeDestinations);
  if (operationsDestinations.length) policy.operationsDestinations = destinations(operationsDestinations);
  return { rulesContentHash: rulesContentHash.trim(), policy };
}
function destinations(value: Destination[]) { return value.map((item) => ({ account: item.account.trim(), weightBps: percentToBps(item.weightBps) })); }
function integerValue(value: string) { const parsed = Number(value); return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(parsed) ? parsed : value; }
function percentToBps(value: string) {
  const text = value.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text)) return value;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : value;
}
function bpsToPercentInput(value: unknown) {
  const text = String(value ?? '');
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return text;
  const percent = Number(text) / 100;
  return percent.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
function usdtInputToAtomic(value: string) {
  const text = value.trim().replace(/,/g, '');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) return value;
  const [whole = '0', fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
}
function displayPolicyField(field: PolicyField, value: unknown) {
  if (field.kind === 'percent') return bpsToPercentInput(value);
  if (field.kind === 'usdt') return formatUsdtInput(String(value ?? ''));
  return String(value ?? '');
}
function loadPayload(value: Record<string, unknown>, setRulesContentHash: (value: string) => void, setFields: (value: Record<string, string>) => void, setGenesisNodes: (value: Destination[]) => void, setOperations: (value: Destination[]) => void) {
  setRulesContentHash(String(value.rulesContentHash ?? ''));
  const policy = record(value.policy); const next = initialFields();
  for (const field of allPolicyFields) if (policy[field.name] !== undefined) next[field.name] = displayPolicyField(field, policy[field.name]);
  setFields(next); setGenesisNodes(readDestinations(policy.genesisNodeDestinations)); setOperations(readDestinations(policy.operationsDestinations));
}
function readDestinations(value: unknown): Destination[] { return Array.isArray(value) ? value.map((item) => { const child = record(item); return { account: String(child.account ?? ''), weightBps: bpsToPercentInput(child.weightBps) }; }) : []; }
function policyFieldLabel(value: string) {
  if (value === 'rulesContentHash') return '规则文件编号';
  return allPolicyFields.find((field) => field.name === value)?.label ?? value;
}
function validationLabel(value: string) {
  return ({
    REQUIRED: '请填写必填项',
    INVALID: '格式不正确',
    IMMUTABLE_FIELD_CHANGED: '锁定字段不能修改',
    WALLET_REQUIRED: '请填写钱包地址',
    WEIGHT_MISMATCH: '分配比例合计不正确',
  } as Record<string, string>)[value] ?? value;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonicalJson(value: unknown) { return JSON.stringify(sortJson(value), null, 2); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)])); }
function approvalWindow() { return { nonce: randomNonce(), deadline: String(Math.floor(Date.now() / 1_000) + 300) }; }
function randomNonce() { const values = crypto.getRandomValues(new Uint32Array(2)); return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString(); }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '政策治理服务暂时无法连接', status: 503 }); }

import { systemConfigKeys, type SensitiveApproval, type SystemConfigKey, type SystemConfigProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, KeyRound, Plus, RefreshCw, Send, Settings2, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { commonStateLabel, formatUsdtInput, humanizeError, shortAddress, shortId } from '../display';
import { useCoreSession } from '../coreSession';
import { createSystemConfigApprovalChallenge, createSystemConfigVersion, fetchSystemConfigVersions, publishSystemConfigVersion } from '../settlementAdminApi';

type WritableConfigKey = Exclude<SystemConfigKey, 'FREIGHT'>;

const writableConfigKeys = systemConfigKeys.filter((key): key is WritableConfigKey => key !== 'FREIGHT');
const configFields: Record<WritableConfigKey, readonly { name: string; label: string; kind?: 'number' | 'boolean' | 'usdt'; fixed?: string }[]> = {
  BUSINESS: [
    { name: 'unpaidReservationTimeoutSeconds', label: '未付款库存保留秒数', kind: 'number' },
    { name: 'businessTimezone', label: '业务时区', fixed: 'Asia/Shanghai' },
  ],
  RPC: [
    { name: 'chainId', label: '运行网络编号（固定 56）', kind: 'number', fixed: '56' },
    { name: 'primaryRpcSecretRef', label: '主网连接密钥名（平台提供）' },
    { name: 'fallbackRpcSecretRef', label: '备用连接密钥名（平台提供）' },
    { name: 'explorerApiSecretRef', label: '浏览器查询密钥名（平台提供）' },
  ],
  NPL_QUOTE: [
    { name: 'pairAddress', label: 'NPL / USDT 交易对地址', fixed: '0x2955e33bb120714abf11ace2766e614e6e5955b2' },
    { name: 'quoteValiditySeconds', label: '报价有效秒数', kind: 'number', fixed: '300' },
    { name: 'minimumUsdtLiquidity', label: '最小 USDT 流动性（USDT）', kind: 'usdt', fixed: '50000.00' },
  ],
  GAS: [
    { name: 'seckillMaxGasPriceWei', label: '秒杀最高手续费阈值（平台提供）' },
    { name: 'highGasRestrictionSeconds', label: '异常手续费限制时长（秒）', kind: 'number', fixed: '86400' },
  ],
  CHAIN: [
    { name: 'chainId', label: '运行网络编号（固定 56）', kind: 'number', fixed: '56' },
    { name: 'usdtAddress', label: 'USDT 地址（固定）', fixed: '0x55d398326f99059fF775485246999027B3197955' },
    { name: 'nplAddress', label: 'NPL 地址（固定）', fixed: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2' },
    { name: 'pairAddress', label: 'NPL/USDT 价格池地址（固定）', fixed: '0x2955e33bb120714abf11ace2766e614e6e5955b2' },
    { name: 'paymentRouterAddress', label: '支付合约地址（高级，平台提供）' },
    { name: 'policyRegistryAddress', label: '资金规则合约地址（高级，平台提供）' },
    { name: 'beneficiaryRegistryAddress', label: '受益人规则合约地址（高级，平台提供）' },
    { name: 'usdtSettlementWallet', label: 'USDT 货款结算钱包' },
    { name: 'nplRewardWallet', label: 'NPL 奖励发放钱包' },
    { name: 'operationsWallet', label: '运营钱包' },
  ],
  INTEGRATIONS: [
    { name: 'ossCredentialRef', label: 'OSS 密钥引用' },
    { name: 'cdnEnabled', label: '启用 CDN', kind: 'boolean' },
    { name: 'aiPromptVersion', label: 'AI Prompt 版本', kind: 'number' },
    { name: 'aiProviderSecretRef', label: 'AI 服务密钥引用' },
  ],
};

export function SystemConfigPage() {
  const { connect, session, status } = useCoreSession();
  const [items, setItems] = useState<readonly SystemConfigProjection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [configKey, setConfigKey] = useState<WritableConfigKey>('BUSINESS');
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialConfigValues('BUSINESS'));
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => newKey('config'));
  const [approvalEvidence, setApprovalEvidence] = useState<{ signer: string; oldValueHash: string; newValueHash: string; digest: string } | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'AUDITOR'].includes(role)) ?? false;
  const canWrite = session?.roles.some((role) => ['ADMIN', 'OPERATOR'].includes(role)) ?? false;
  const isAdmin = session?.roles.includes('ADMIN') ?? false;
  const selected = useMemo(() => items.find((item) => item.configVersionId === selectedId) ?? null, [items, selectedId]);
  const newPayload = useMemo(() => buildConfigPayload(configKey, values), [configKey, values]);

  useEffect(() => {
    setItems([]); setSelectedId(''); setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController(); setLoading(true);
    void fetchSystemConfigVersions(session.token, controller.signal).then((result) => { setItems(result); setSelectedId(result[0]?.configVersionId ?? ''); }).catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const changeKey = (next: WritableConfigKey) => { setConfigKey(next); setValues(initialConfigValues(next)); setApprovalEvidence(null); };
  const loadSelected = () => {
    if (!selected || selected.configKey === 'FREIGHT') return;
    if (!writableConfigKeys.includes(selected.configKey as WritableConfigKey)) return;
    setConfigKey(selected.configKey); setValues(configValues(selected.configKey, selected.payload)); setApprovalEvidence(null);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canWrite) return;
    await run(async () => {
      const result = await createSystemConfigVersion({ configKey, payload: newPayload, effectiveFrom: new Date(effectiveFrom).toISOString(), idempotencyKey }, session.token);
      setItems((current) => [result, ...current]); setSelectedId(result.configVersionId); setIdempotencyKey(newKey('config')); setApprovalEvidence(null);
      setNotice(`系统已创建配置版本 ${shortId(result.configVersionId)}。`);
    });
  };
  const publish = async () => {
    if (!session || !selectedId || !isAdmin || !window.ethereum) return;
    await run(async () => {
      const { nonce, deadline } = approvalWindow();
      const challenge = await createSystemConfigApprovalChallenge(selectedId, { nonce, deadline }, session.token);
      const signature = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [challenge.signer, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw invalid('钱包未返回二次签名');
      const approval: SensitiveApproval = {
        action: challenge.action, resourceType: challenge.resourceType, resourceId: challenge.resourceId,
        policyVersion: challenge.policyVersion, oldValueHash: challenge.oldValueHash, newValueHash: challenge.newValueHash,
        executorWallet: challenge.executorWallet, nonce: challenge.nonce, deadline: challenge.deadline, signature,
      };
      const result = await publishSystemConfigVersion(selectedId, approval, session.token);
      setItems((current) => current.map((item) => item.configVersionId === result.configVersionId ? result : item));
      setApprovalEvidence({ signer: challenge.signer, oldValueHash: challenge.oldValueHash, newValueHash: challenge.newValueHash, digest: challenge.digest });
      setNotice(`配置 ${shortId(result.configVersionId)} 已发布。`);
    });
  };
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };

  return <>
    <header className="page-header"><div className="page-icon"><Settings2 aria-hidden="true" /></div><div><p className="eyebrow">高危配置</p><h1>系统配置</h1><p>只按平台提供的内容填写。密钥只填引用名，不展示真实密钥；发布前必须二次签名确认。</p></div><div className="requirement-list"><code>配置版本</code><code>未来生效</code></div></header>
    <div className="resource-state" role="status"><ShieldCheck aria-hidden="true" /><div><strong>不要自己猜配置</strong><p>这里会影响主网连接、报价、手续费和收款地址。看不懂的字段保持不动，先找技术或财务确认。</p></div></div>
    <section className="workspace-grid"><article className="panel panel-main admin-resource-panel">
      <div className="panel-heading"><div><p className="section-kicker">系统配置版本</p><h2>版本清单</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
      {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>审核员只读；管理员和运营可创建，只有管理员可发布。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />{status === 'CONNECTING' ? '等待签名' : '连接钱包'}</button></div>
        : !canRead ? <ErrorView error={invalid('当前会话没有系统配置权限')} />
          : <><div className="table-scroll"><table className="data-table"><thead><tr><th>版本编号</th><th>配置类型</th><th>版本</th><th>生效时间</th><th>状态</th></tr></thead><tbody>{items.map((item) => <tr key={item.configVersionId} className={selectedId === item.configVersionId ? 'is-selected' : undefined}><td><button className="table-link" type="button" onClick={() => setSelectedId(item.configVersionId)} title={item.configVersionId}>{shortId(item.configVersionId)}</button></td><td>{configKeyLabel(item.configKey)}</td><td>{item.version}</td><td>{item.effectiveFrom}</td><td>{item.published ? <span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />已发布</span> : '草稿'}</td></tr>)}</tbody></table></div>{canWrite ? <form className="governed-form" onSubmit={create}><fieldset><legend>创建配置版本</legend><div className="form-grid"><label>配置类型<select value={configKey} onChange={(event) => changeKey(event.target.value as WritableConfigKey)}>{writableConfigKeys.map((value) => <option key={value} value={value}>{configKeyLabel(value)}</option>)}</select></label><label>未来生效时间<input type="datetime-local" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} required /></label></div></fieldset><ConfigFields configKey={configKey} values={values} setValues={setValues} /><div className="governed-form-actions"><button className="button button-primary" type="submit" disabled={loading || !effectiveFrom}><Plus aria-hidden="true" />提交系统校验</button><button className="button button-quiet" type="button" onClick={loadSelected} disabled={!selected || selected.configKey === 'FREIGHT'}>载入选中版本</button></div></form> : null}</>}
    </article><aside className="panel evidence-panel"><p className="section-kicker">发布确认</p><h2>旧值 / 新值</h2>{selected ? <><dl className="definition-grid"><div><dt>选中版本</dt><dd title={selected.configVersionId}>{shortId(selected.configVersionId)}</dd></div><div><dt>配置类型</dt><dd>{configKeyLabel(selected.configKey)}</dd></div><div><dt>状态</dt><dd>{selected.published ? '已发布' : commonStateLabel('DRAFT')}</dd></div></dl><details className="technical-details"><summary>高级配置凭证</summary><dl className="definition-grid"><div><dt>配置凭证</dt><dd><code>{selected.payloadHash}</code></dd></div></dl><div className="value-comparison"><div><span>选中版本值</span><code>{pretty(selected.payload)}</code></div><div><span>当前表单值</span><code>{pretty(newPayload)}</code></div></div></details></> : <p className="muted-copy">选择一个配置版本后发布。</p>}{approvalEvidence ? <details className="technical-details"><summary>二次确认凭证</summary><dl className="definition-grid"><div><dt>二次确认钱包</dt><dd><code title={approvalEvidence.signer}>{shortAddress(approvalEvidence.signer)}</code></dd></div><div><dt>旧值凭证</dt><dd><code>{approvalEvidence.oldValueHash}</code></dd></div><div><dt>新值凭证</dt><dd><code>{approvalEvidence.newValueHash}</code></dd></div><div><dt>签名摘要</dt><dd><code>{approvalEvidence.digest}</code></dd></div></dl></details> : null}<button className="button button-primary button-full" type="button" onClick={() => void publish()} disabled={!isAdmin || !selectedId || loading}><Send aria-hidden="true" />签名并发布未来版本</button><p className="button-explanation">页面会自动请求签名参数并引导独立钱包确认；不需要手工填写技术参数。</p></aside></section>
    {error ? <ErrorView error={error} /> : null}{notice ? <p className="healthy-copy" role="status">{notice}</p> : null}
  </>;
}

function ConfigFields({ configKey, values, setValues }: { configKey: WritableConfigKey; values: Record<string, string | boolean>; setValues: (value: Record<string, string | boolean>) => void }) {
  return <fieldset><legend>{configKeyLabel(configKey)}设置项</legend><div className="governed-field-grid">{configFields[configKey].map((field) => field.kind === 'boolean' ? <label className="binary-field" key={field.name}><input type="checkbox" checked={Boolean(values[field.name])} onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })} />{field.label}</label> : <label key={field.name}>{field.label}<input inputMode={field.kind === 'number' ? 'numeric' : undefined} value={String(values[field.name] ?? field.fixed ?? '')} readOnly={field.fixed !== undefined} aria-readonly={field.fixed !== undefined} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} required /></label>)}</div></fieldset>;
}

function initialConfigValues(configKey: WritableConfigKey) { return Object.fromEntries(configFields[configKey].map((field) => [field.name, field.kind === 'boolean' ? false : field.fixed ?? ''])); }
function buildConfigPayload(configKey: WritableConfigKey, values: Record<string, string | boolean>) {
  return Object.fromEntries(configFields[configKey].map((field) => {
    const value = field.fixed ?? values[field.name];
    return [field.name, field.kind === 'number'
      ? integerValue(String(value ?? ''))
      : field.kind === 'boolean'
        ? Boolean(value)
        : field.kind === 'usdt'
          ? usdtInputToAtomic(String(value ?? ''))
          : String(value ?? '').trim()];
  }));
}
function integerValue(value: string) { const parsed = Number(value); return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(parsed) ? parsed : value; }
function usdtInputToAtomic(value: string) {
  const text = value.trim().replace(/,/g, '');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) return value;
  const [whole = '0', fraction = ''] = text.split('.');
  return (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
}
function configValues(configKey: WritableConfigKey, payload: Record<string, unknown>) { return Object.fromEntries(configFields[configKey].map((field) => [field.name, field.kind === 'boolean' ? Boolean(payload[field.name]) : field.kind === 'usdt' ? formatUsdtInput(String(payload[field.name] ?? '')) : String(payload[field.name] ?? field.fixed ?? '')])); }
function configKeyLabel(value: string) {
  return ({
    BUSINESS: '业务基础',
    RPC: '主网连接',
    NPL_QUOTE: 'NPL 报价',
    GAS: '手续费风控',
    CHAIN: '链上地址（高级）',
    INTEGRATIONS: '外部服务',
    FREIGHT: '运费',
  } as Record<string, string>)[value] ?? value;
}
function approvalWindow() { return { nonce: randomNonce(), deadline: String(Math.floor(Date.now() / 1_000) + 300) }; }
function randomNonce() { const values = crypto.getRandomValues(new Uint32Array(2)); return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString(); }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '系统配置服务暂时不可用', status: 503 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }

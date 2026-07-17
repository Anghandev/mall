import { systemConfigKeys, type SensitiveApproval, type SystemConfigKey, type SystemConfigProjection } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, KeyRound, Plus, RefreshCw, Send, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { createSystemConfigApprovalChallenge, createSystemConfigVersion, fetchSystemConfigVersions, publishSystemConfigVersion } from '../settlementAdminApi';

type WritableConfigKey = Exclude<SystemConfigKey, 'FREIGHT'>;
type MerchantLevelValue = { level: string; maxProductSettlementUsdt: string; monthlySeckillQuota: string };

const writableConfigKeys = systemConfigKeys.filter((key): key is WritableConfigKey => key !== 'FREIGHT');
const configFields: Record<Exclude<WritableConfigKey, 'MERCHANT_LEVELS'>, readonly { name: string; label: string; kind?: 'number' | 'boolean'; fixed?: string }[]> = {
  BUSINESS: [
    { name: 'unpaidReservationTimeoutSeconds', label: '未付款库存保留秒数', kind: 'number' },
    { name: 'businessTimezone', label: '业务时区', fixed: 'Asia/Shanghai' },
  ],
  RPC: [
    { name: 'chainId', label: 'Chain ID', kind: 'number', fixed: '56' },
    { name: 'primaryRpcSecretRef', label: 'Primary RPC secret ref' },
    { name: 'fallbackRpcSecretRef', label: 'Fallback RPC secret ref' },
    { name: 'explorerApiSecretRef', label: 'Explorer API secret ref' },
  ],
  ORACLE: [
    { name: 'pairAddress', label: 'NPL / USDT Pair', fixed: '0x2955e33bb120714abf11ace2766e614e6e5955b2' },
    { name: 'windowSeconds', label: 'TWAP 窗口秒数', kind: 'number', fixed: '1800' },
    { name: 'maxDeviationBps', label: '最大偏差 BPS', kind: 'number', fixed: '500' },
    { name: 'quoteValiditySeconds', label: '报价有效秒数', kind: 'number', fixed: '300' },
    { name: 'maxAgeSeconds', label: '最大陈旧秒数', kind: 'number', fixed: '600' },
    { name: 'minimumUsdtLiquidity', label: '最小 USDT 流动性 atomic', fixed: '50000000000000000000000' },
  ],
  GAS: [
    { name: 'seckillMaxGasPriceWei', label: '秒杀最大 Gas price Wei' },
    { name: 'highGasRestrictionSeconds', label: '高 Gas 限制秒数', kind: 'number', fixed: '86400' },
  ],
  CHAIN: [
    { name: 'chainId', label: 'Chain ID', kind: 'number', fixed: '56' },
    { name: 'usdtAddress', label: 'USDT 地址', fixed: '0x55d398326f99059fF775485246999027B3197955' },
    { name: 'nplAddress', label: 'NPL 地址', fixed: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2' },
    { name: 'pairAddress', label: 'NPL / USDT Pair', fixed: '0x2955e33bb120714abf11ace2766e614e6e5955b2' },
    { name: 'paymentRouterAddress', label: 'PaymentRouter 地址' },
    { name: 'policyRegistryAddress', label: 'PolicyRegistry 地址' },
    { name: 'beneficiaryRegistryAddress', label: 'BeneficiaryRegistry 地址' },
    { name: 'twapOracleAddress', label: 'TWAP Oracle 地址' },
    { name: 'usdtCustodySafe', label: 'USDT Custody Safe' },
    { name: 'nplRewardSafe', label: 'NPL Reward Safe' },
    { name: 'operationsTreasurySafe', label: 'Operations Treasury Safe' },
  ],
  INTEGRATIONS: [
    { name: 'ossCredentialRef', label: 'OSS credential secret ref' },
    { name: 'cdnEnabled', label: '启用 CDN', kind: 'boolean' },
    { name: 'aiPromptVersion', label: 'AI Prompt 版本', kind: 'number' },
    { name: 'aiProviderSecretRef', label: 'AI Provider secret ref' },
  ],
};

export function SystemConfigPage() {
  const { connect, session, status } = useCoreSession();
  const [items, setItems] = useState<readonly SystemConfigProjection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [configKey, setConfigKey] = useState<WritableConfigKey>('BUSINESS');
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialConfigValues('BUSINESS'));
  const [merchantLevels, setMerchantLevels] = useState<MerchantLevelValue[]>(() => initialMerchantLevels());
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
  const newPayload = useMemo(() => buildConfigPayload(configKey, values, merchantLevels), [configKey, values, merchantLevels]);

  useEffect(() => {
    setItems([]); setSelectedId(''); setError(null);
    if (!session || !canRead) return;
    const controller = new AbortController(); setLoading(true);
    void fetchSystemConfigVersions(session.token, controller.signal).then((result) => { setItems(result); setSelectedId(result[0]?.configVersionId ?? ''); }).catch((cause) => { if (!controller.signal.aborted) setError(asCoreError(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [canRead, reload, session]);

  const changeKey = (next: WritableConfigKey) => { setConfigKey(next); setValues(initialConfigValues(next)); setMerchantLevels(initialMerchantLevels()); setApprovalEvidence(null); };
  const loadSelected = () => {
    if (!selected || selected.configKey === 'FREIGHT') return;
    setConfigKey(selected.configKey); setValues(configValues(selected.configKey, selected.payload)); setMerchantLevels(readMerchantLevels(selected.payload)); setApprovalEvidence(null);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!session || !canWrite) return;
    await run(async () => {
      const result = await createSystemConfigVersion({ configKey, payload: newPayload, effectiveFrom: new Date(effectiveFrom).toISOString(), idempotencyKey }, session.token);
      setItems((current) => [result, ...current]); setSelectedId(result.configVersionId); setIdempotencyKey(newKey('config')); setApprovalEvidence(null);
      setNotice(`Core 已创建 ${result.configVersionId}`);
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
        safeAddress: challenge.safeAddress, nonce: challenge.nonce, deadline: challenge.deadline, signature,
      };
      const result = await publishSystemConfigVersion(selectedId, approval, session.token);
      setItems((current) => current.map((item) => item.configVersionId === result.configVersionId ? result : item));
      setApprovalEvidence({ signer: challenge.signer, oldValueHash: challenge.oldValueHash, newValueHash: challenge.newValueHash, digest: challenge.digest });
      setNotice(`配置 ${result.configVersionId} 已发布`);
    });
  };
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };

  return <>
    <header className="page-header"><div className="page-icon"><Settings2 aria-hidden="true" /></div><div><p className="eyebrow">TYPED PRODUCTION CONFIG</p><h1>系统配置</h1><p>通过现有 Core key 创建配置版本；秘密值只填写 secret reference。商品运费只在商品 defaultFreightUsdt 中配置。</p></div><div className="requirement-list"><code>ADM-SYS-001—006</code></div></header>
    <section className="workspace-grid"><article className="panel panel-main admin-resource-panel">
      <div className="panel-heading"><div><p className="section-kicker">系统配置版本</p><h2>版本清单</h2></div>{session ? <button className="button button-quiet" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />刷新</button> : null}</div>
      {!session ? <div className="session-prompt"><div><strong>连接平台钱包</strong><p>AUDITOR 只读；ADMIN / OPERATOR 可创建，只有 ADMIN 可发布。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />SIWE 连接</button></div>
        : !canRead ? <ErrorView error={invalid('当前会话没有系统配置权限')} />
          : <><div className="table-scroll"><table className="data-table"><thead><tr><th>版本 ID</th><th>Key</th><th>版本</th><th>生效时间</th><th>状态</th></tr></thead><tbody>{items.map((item) => <tr key={item.configVersionId} className={selectedId === item.configVersionId ? 'is-selected' : undefined}><td><button className="table-link" type="button" onClick={() => setSelectedId(item.configVersionId)}>{item.configVersionId}</button></td><td>{item.configKey}</td><td>{item.version}</td><td>{item.effectiveFrom}</td><td>{item.published ? <span className="status-chip status-ready"><CheckCircle2 aria-hidden="true" />PUBLISHED</span> : 'DRAFT'}</td></tr>)}</tbody></table></div>{canWrite ? <form className="governed-form" onSubmit={create}><fieldset><legend>创建配置版本</legend><div className="form-grid"><label>Config key<select value={configKey} onChange={(event) => changeKey(event.target.value as WritableConfigKey)}>{writableConfigKeys.map((value) => <option key={value}>{value}</option>)}</select></label><label>未来生效时间<input type="datetime-local" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} required /></label></div></fieldset><ConfigFields configKey={configKey} values={values} setValues={setValues} merchantLevels={merchantLevels} setMerchantLevels={setMerchantLevels} /><div className="governed-form-actions"><button className="button button-primary" type="submit" disabled={loading || !effectiveFrom}><Plus aria-hidden="true" />提交 Core 校验</button><button className="button button-quiet" type="button" onClick={loadSelected} disabled={!selected || selected.configKey === 'FREIGHT'}>载入选中版本</button></div></form> : null}</>}
    </article><aside className="panel evidence-panel"><p className="section-kicker">Governed publish</p><h2>旧值 / 新值</h2>{selected ? <><dl className="definition-grid"><div><dt>选中版本</dt><dd>{selected.configVersionId}</dd></div><div><dt>Payload hash</dt><dd><code>{selected.payloadHash}</code></dd></div></dl><div className="value-comparison"><div><span>选中版本值</span><code>{pretty(selected.payload)}</code></div><div><span>当前表单值</span><code>{pretty(newPayload)}</code></div></div></> : <p className="muted-copy">选择一个配置版本后发布。</p>}{approvalEvidence ? <dl className="definition-grid"><div><dt>Secondary signer</dt><dd><code>{approvalEvidence.signer}</code></dd></div><div><dt>旧值 hash</dt><dd><code>{approvalEvidence.oldValueHash}</code></dd></div><div><dt>新值 hash</dt><dd><code>{approvalEvidence.newValueHash}</code></dd></div><div><dt>Digest</dt><dd><code>{approvalEvidence.digest}</code></dd></div></dl> : null}<button className="button button-primary button-full" type="button" onClick={() => void publish()} disabled={!isAdmin || !selectedId || loading}><Send aria-hidden="true" />签名并发布未来版本</button><p className="button-explanation">页面请求 Core challenge，使用独立 signer 完成钱包签名，再提交完整 SensitiveApproval。无需手工 JSON。</p></aside></section>
    {error ? <ErrorView error={error} /> : null}{notice ? <p className="healthy-copy" role="status">{notice}</p> : null}
  </>;
}

function ConfigFields({ configKey, values, setValues, merchantLevels, setMerchantLevels }: { configKey: WritableConfigKey; values: Record<string, string | boolean>; setValues: (value: Record<string, string | boolean>) => void; merchantLevels: MerchantLevelValue[]; setMerchantLevels: (value: MerchantLevelValue[]) => void }) {
  if (configKey === 'MERCHANT_LEVELS') return <fieldset><legend>V1-V5 价格上限与月度秒杀配额</legend><div className="merchant-level-config">{merchantLevels.map((item, index) => <div key={item.level}><strong>{item.level}</strong><label>商品结算价上限 atomic<input aria-label={`${item.level} 商品结算价上限 atomic`} inputMode="numeric" value={item.maxProductSettlementUsdt} onChange={(event) => setMerchantLevels(merchantLevels.map((entry, child) => child === index ? { ...entry, maxProductSettlementUsdt: event.target.value } : entry))} /></label><label>月度秒杀配额<input aria-label={`${item.level} 月度秒杀配额`} inputMode="numeric" value={item.monthlySeckillQuota} onChange={(event) => setMerchantLevels(merchantLevels.map((entry, child) => child === index ? { ...entry, monthlySeckillQuota: event.target.value } : entry))} /></label></div>)}</div></fieldset>;
  return <fieldset><legend>{configKey} 字段</legend><div className="governed-field-grid">{configFields[configKey].map((field) => field.kind === 'boolean' ? <label className="binary-field" key={field.name}><input type="checkbox" checked={Boolean(values[field.name])} onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })} />{field.label}</label> : <label key={field.name}>{field.label}<input inputMode={field.kind === 'number' ? 'numeric' : undefined} value={String(values[field.name] ?? field.fixed ?? '')} readOnly={field.fixed !== undefined} aria-readonly={field.fixed !== undefined} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} required /></label>)}</div></fieldset>;
}

function initialConfigValues(configKey: WritableConfigKey) { if (configKey === 'MERCHANT_LEVELS') return {}; return Object.fromEntries(configFields[configKey].map((field) => [field.name, field.kind === 'boolean' ? false : field.fixed ?? ''])); }
function initialMerchantLevels(): MerchantLevelValue[] { return ['V1', 'V2', 'V3', 'V4', 'V5'].map((level) => ({ level, maxProductSettlementUsdt: '', monthlySeckillQuota: '' })); }
function buildConfigPayload(configKey: WritableConfigKey, values: Record<string, string | boolean>, merchantLevels: MerchantLevelValue[]) {
  if (configKey === 'MERCHANT_LEVELS') return { levels: merchantLevels.map((item) => ({ level: item.level, maxProductSettlementUsdt: item.maxProductSettlementUsdt.trim(), monthlySeckillQuota: integerValue(item.monthlySeckillQuota) })) };
  return Object.fromEntries(configFields[configKey].map((field) => { const value = field.fixed ?? values[field.name]; return [field.name, field.kind === 'number' ? integerValue(String(value ?? '')) : field.kind === 'boolean' ? Boolean(value) : String(value ?? '').trim()]; }));
}
function integerValue(value: string) { const parsed = Number(value); return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(parsed) ? parsed : value; }
function configValues(configKey: WritableConfigKey, payload: Record<string, unknown>) { if (configKey === 'MERCHANT_LEVELS') return {}; return Object.fromEntries(configFields[configKey].map((field) => [field.name, field.kind === 'boolean' ? Boolean(payload[field.name]) : String(payload[field.name] ?? field.fixed ?? '')])); }
function readMerchantLevels(payload: Record<string, unknown>): MerchantLevelValue[] { const value = payload.levels; if (!Array.isArray(value)) return initialMerchantLevels(); const byLevel = new Map(value.map((item) => { const child = record(item); return [String(child.level), child] as const; })); return initialMerchantLevels().map((item) => { const found = byLevel.get(item.level); return found ? { level: item.level, maxProductSettlementUsdt: String(found.maxProductSettlementUsdt ?? ''), monthlySeckillQuota: String(found.monthlySeckillQuota ?? '') } : item; }); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function approvalWindow() { return { nonce: randomNonce(), deadline: String(Math.floor(Date.now() / 1_000) + 300) }; }
function randomNonce() { const values = crypto.getRandomValues(new Uint32Array(2)); return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString(); }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '系统配置 Core 能力不可用', status: 503 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div>; }

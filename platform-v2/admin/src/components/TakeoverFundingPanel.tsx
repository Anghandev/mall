import type { SensitiveApproval, TakeoverFundingDetail } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, CircleDollarSign, KeyRound, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { formatUsdt, humanizeError, parseUsdtInput } from '../display';
import { createTakeoverFundingChallenge, fetchTakeoverFunding, fundTakeover } from '../settlementAdminApi';

export function TakeoverFundingPanel() {
  const { session } = useCoreSession();
  const [caseId, setCaseId] = useState('');
  const [requiredUsdt, setRequiredUsdt] = useState('');
  const [nonce, setNonce] = useState(() => adminNonce());
  const [deadline, setDeadline] = useState(() => adminDeadline());
  const [idempotencyKey, setIdempotencyKey] = useState(() => adminCommandKey('takeover-funding'));
  const [detail, setDetail] = useState<TakeoverFundingDetail | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'].includes(role)) ?? false; const canFund = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'ARBITRATOR'].includes(role)) ?? false;
  const lookup = async (event: FormEvent) => { event.preventDefault(); if (!session || !canRead) return; await run(async () => setDetail(await fetchTakeoverFunding(caseId, session.token))); };
  useEffect(() => {
    setIdempotencyKey(adminCommandKey('takeover-funding'));
    setNonce(adminNonce());
    setDeadline(adminDeadline());
  }, [caseId, requiredUsdt]);
  const approveAndFund = async () => {
    if (!session || !canFund || !window.ethereum) return;
    await run(async () => {
      const requiredUsdtAtomic = parseUsdtInput(requiredUsdt, '需要筹资金额', true);
      const challenge = await createTakeoverFundingChallenge({ caseId, requiredUsdt: requiredUsdtAtomic, nonce, deadline }, session.token);
      const signature = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [session.walletAddress, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw invalid('钱包未返回二次签名');
      const approval = approvalFromChallenge(challenge.typedData.message, signature);
      const result = await fundTakeover({ caseId: challenge.plan.caseId, requiredUsdt: challenge.plan.requiredUsdt, idempotencyKey, approval }, session.token);
      setNotice(`筹资已完成。平台垫资 ${formatUsdt(result.platformAdvanceUsdt)}，商家债务 ${formatUsdt(result.merchantDebtUsdt)}。`);
      setDetail(await fetchTakeoverFunding(caseId, session.token));
      setIdempotencyKey(adminCommandKey('takeover-funding'));
      setNonce(adminNonce());
      setDeadline(adminDeadline());
    });
  };
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };
  return <section className="panel admin-resource-panel"><div className="panel-heading"><div><p className="section-kicker">接管资金</p><h2>筹资、垫资与商家债务</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? roleListLabel(session.roles) : '需要平台会话'}</span></div>{session && canRead ? <><form className="inline-query-form" onSubmit={lookup}><label>接管案件编号<input value={caseId} onChange={(event) => setCaseId(event.target.value)} required /></label><button className="button button-quiet" type="submit" disabled={loading || !caseId.trim()}><Search aria-hidden="true" />读取筹资证据</button></form>{detail ? <><div className="status-overview compact-overview"><article><span>案件状态</span><strong>{stateLabel(detail.state)}</strong><small>{detail.case_id}</small></article><article><span>冻结应收</span><strong>{formatUsdt(detail.merchant_available_used_usdt)}</strong><small>先用已冻结货款</small></article><article><span>未来货款</span><strong>{formatUsdt(detail.future_proceeds_used_usdt)}</strong><small>后续成交自动追偿</small></article><article><span>平台垫资 / 商家债务</span><strong>{formatUsdt(detail.platform_advance_usdt)} / {formatUsdt(detail.merchant_debt_usdt)}</strong><small>不足部分形成债务</small></article></div></> : null}{canFund ? <div className="admin-editor-form"><h3>签名并执行筹资</h3><div className="form-grid"><label>需要筹资金额（USDT）<input inputMode="decimal" value={requiredUsdt} onChange={(event) => setRequiredUsdt(event.target.value)} placeholder="例如 100.00" /></label></div><details className="technical-details compact"><summary>高级签名参数</summary><div className="form-grid"><label>确认编号<input inputMode="numeric" value={nonce} onChange={(event) => setNonce(event.target.value)} /></label><label>签名截止时间<input inputMode="numeric" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label></div></details><p className="button-explanation">提交编号和签名参数由页面自动生成；你只需要确认金额并完成钱包签名。</p><button className="button button-primary" type="button" onClick={() => void approveAndFund()} disabled={loading || !caseId || !requiredUsdt || !nonce || !deadline}><CircleDollarSign aria-hidden="true" />签名并执行筹资</button></div> : null}</> : <div className="resource-state resource-state-error"><Ban aria-hidden="true" /><div><strong>没有权限</strong><p>连接管理员、运营、仲裁或审计会话后读取；审计角色不可筹资。</p></div></div>}{error ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div> : null}{notice ? <p className="healthy-copy" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}</section>;
}

function approvalFromChallenge(message: Readonly<Record<string, unknown>>, signature: string): SensitiveApproval {
  const fields = ['action', 'resourceType', 'resourceId', 'policyVersion', 'oldValueHash', 'newValueHash', 'executorWallet', 'nonce', 'deadline'] as const;
  const values = Object.fromEntries(fields.map((field) => [field, message[field]]));
  if (!fields.every((field) => typeof values[field] === 'string' || typeof values[field] === 'number' || typeof values[field] === 'bigint')) throw invalid('系统返回的签名信息不完整，请刷新后重试。');
  return { action: String(values.action), resourceType: String(values.resourceType), resourceId: String(values.resourceId), policyVersion: String(values.policyVersion), oldValueHash: String(values.oldValueHash), newValueHash: String(values.newValueHash), executorWallet: String(values.executorWallet), nonce: String(values.nonce), deadline: String(values.deadline), signature };
}
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) {
  if (cause instanceof CoreApiError) return cause;
  if (cause instanceof Error) return new CoreApiError({ code: 'InvalidRequest', message: cause.message, status: 400 });
  return new CoreApiError({ code: 'ExternalBlocked', message: '接管筹资服务暂时不可用', status: 503 });
}
function adminCommandKey(scope: string) {
  return `${scope}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
function adminNonce() {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(values[0]!) << 32n) | BigInt(values[1]!)).toString();
}
function adminDeadline() {
  return String(Math.floor(Date.now() / 1_000) + 300);
}
function roleListLabel(roles: readonly string[]) {
  return roles.join(' / ')
    .replace(/\bADMIN\b/g, '管理员')
    .replace(/\bOPERATOR\b/g, '运营')
    .replace(/\bARBITRATOR\b/g, '仲裁')
    .replace(/\bAUDITOR\b/g, '审计');
}
function stateLabel(value: string) {
  return ({
    OPEN: '处理中',
    FUNDED: '资金已处理',
    ASSIGNED: '已分配',
    COMPLETED: '已完成',
  } as Record<string, string>)[value] ?? value;
}

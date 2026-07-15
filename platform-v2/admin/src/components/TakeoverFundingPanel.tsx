import type { SensitiveApproval, TakeoverFundingDetail } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, CircleDollarSign, KeyRound, Search, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { useCoreSession } from '../coreSession';
import { createTakeoverFundingChallenge, fetchTakeoverFunding, fundTakeover } from '../settlementAdminApi';

export function TakeoverFundingPanel() {
  const { session } = useCoreSession(); const [caseId, setCaseId] = useState(''); const [requiredUsdt, setRequiredUsdt] = useState(''); const [nonce, setNonce] = useState(''); const [deadline, setDeadline] = useState(''); const [idempotencyKey, setIdempotencyKey] = useState(''); const [detail, setDetail] = useState<TakeoverFundingDetail | null>(null); const [error, setError] = useState<CoreApiError | null>(null); const [notice, setNotice] = useState(''); const [loading, setLoading] = useState(false);
  const canRead = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'].includes(role)) ?? false; const canFund = session?.roles.some((role) => ['ADMIN', 'OPERATOR', 'ARBITRATOR'].includes(role)) ?? false;
  const lookup = async (event: FormEvent) => { event.preventDefault(); if (!session || !canRead) return; await run(async () => setDetail(await fetchTakeoverFunding(caseId, session.token))); };
  const approveAndFund = async () => {
    if (!session || !canFund || !window.ethereum) return;
    await run(async () => {
      const challenge = await createTakeoverFundingChallenge({ caseId, requiredUsdt, nonce, deadline }, session.token);
      const signature = await window.ethereum!.request({ method: 'eth_signTypedData_v4', params: [session.walletAddress, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string' || !signature) throw invalid('钱包未返回二次签名');
      const approval = approvalFromChallenge(challenge.typedData.message, signature);
      const result = await fundTakeover({ caseId: challenge.plan.caseId, requiredUsdt: challenge.plan.requiredUsdt, idempotencyKey, approval }, session.token);
      setNotice(`Core 已按保证金 → 冻结应收 → 未来货款完成筹资；平台垫资 ${result.platformAdvanceUsdt}，商家债务 ${result.merchantDebtUsdt}`);
      setDetail(await fetchTakeoverFunding(caseId, session.token));
    });
  };
  const run = async (action: () => Promise<void>) => { setLoading(true); setError(null); setNotice(''); try { await action(); } catch (cause) { setError(asCoreError(cause)); } finally { setLoading(false); } };
  return <section className="panel admin-resource-panel"><div className="panel-heading"><div><p className="section-kicker">Takeover funding governance</p><h2>筹资、垫资与商家债务</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? session.roles.join(' / ') : '需要平台会话'}</span></div>{session && canRead ? <><form className="inline-query-form" onSubmit={lookup}><label>Case ID<input value={caseId} onChange={(event) => setCaseId(event.target.value)} required /></label><button className="button button-quiet" type="submit" disabled={loading || !caseId.trim()}><Search aria-hidden="true" />读取筹资证据</button></form>{detail ? <><div className="status-overview compact-overview"><article><span>Case state</span><strong>{detail.state}</strong><small>{detail.case_id}</small></article><article><span>Guarantee used</span><strong>{detail.guarantee_used_usdt ?? '—'}</strong><small>USDT atomic</small></article><article><span>Frozen / future</span><strong>{detail.merchant_available_used_usdt ?? '—'} / {detail.future_proceeds_used_usdt ?? '—'}</strong><small>USDT atomic</small></article><article><span>Advance / debt</span><strong>{detail.platform_advance_usdt ?? '—'} / {detail.merchant_debt_usdt ?? '—'}</strong><small>USDT atomic</small></article></div></> : null}{canFund ? <div className="admin-editor-form"><h3>Core challenge → 二次签名 → 原子筹资</h3><div className="form-grid"><label>Required USDT · atomic<input inputMode="numeric" value={requiredUsdt} onChange={(event) => setRequiredUsdt(event.target.value)} /></label><label>Nonce<input inputMode="numeric" value={nonce} onChange={(event) => setNonce(event.target.value)} /></label><label>Deadline · Unix 秒<input inputMode="numeric" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label>Idempotency key<input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /></label></div><button className="button button-primary" type="button" onClick={() => void approveAndFund()} disabled={loading || !caseId || !requiredUsdt || !nonce || !deadline || idempotencyKey.length < 8}><CircleDollarSign aria-hidden="true" />签名并执行筹资</button></div> : null}</> : <div className="resource-state resource-state-error"><Ban aria-hidden="true" /><div><strong>Forbidden</strong><p>连接 ADMIN、OPERATOR、ARBITRATOR 或 AUDITOR 会话后读取；AUDITOR 不可筹资。</p></div></div>}{error ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}</p></div></div> : null}{notice ? <p className="healthy-copy" role="status"><CheckCircle2 aria-hidden="true" />{notice}</p> : null}</section>;
}

function approvalFromChallenge(message: Readonly<Record<string, unknown>>, signature: string): SensitiveApproval {
  const fields = ['action', 'resourceType', 'resourceId', 'policyVersion', 'oldValueHash', 'newValueHash', 'safeAddress', 'nonce', 'deadline'] as const;
  const values = Object.fromEntries(fields.map((field) => [field, message[field]]));
  if (!fields.every((field) => typeof values[field] === 'string' || typeof values[field] === 'number' || typeof values[field] === 'bigint')) throw invalid('Core challenge missing governed approval fields');
  return { action: String(values.action), resourceType: String(values.resourceType), resourceId: String(values.resourceId), policyVersion: String(values.policyVersion), oldValueHash: String(values.oldValueHash), newValueHash: String(values.newValueHash), safeAddress: String(values.safeAddress), nonce: String(values.nonce), deadline: String(values.deadline), signature };
}
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '接管筹资 Core 能力不可用', status: 503 }); }

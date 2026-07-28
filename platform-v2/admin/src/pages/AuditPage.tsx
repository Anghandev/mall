import { auditStreamNames, type AuditListResponse } from '@abu24k/core-artifacts';
import { Ban, CheckCircle2, FileCheck2, KeyRound, Search, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CoreApiError } from '../coreApi';
import { humanizeError, shortAddress, shortId } from '../display';
import { useCoreSession } from '../coreSession';
import { fetchAuditEntries, type AuditFilters } from '../settlementAdminApi';

export function AuditPage() {
  const { connect, session, status } = useCoreSession();
  const [filters, setFilters] = useState<AuditFilters>({ limit: 50 });
  const [result, setResult] = useState<AuditListResponse | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const canRead = session?.roles.some((role) => ['ADMIN', 'AUDITOR'].includes(role)) ?? false;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session || !canRead) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fetchAuditEntries(filters, session.token));
    } catch (cause) {
      setError(asCoreError(cause));
    } finally {
      setLoading(false);
    }
  };
  const set = (name: keyof AuditFilters, value: string | number | undefined) => setFilters((current) => ({ ...current, [name]: value }));

  return <><header className="page-header"><div className="page-icon"><FileCheck2 aria-hidden="true" /></div><div><p className="eyebrow">审计日志</p><h1>日志中心</h1><p>按日志类型、业务对象和问题编号查只读记录；系统会显示记录是否连续。</p></div><div className="requirement-list"><code>日志查询</code><code>连续校验</code></div></header><section className="panel admin-resource-panel"><div className="panel-heading"><div><p className="section-kicker">审计记录</p><h2>日志查询</h2></div><span className={canRead ? 'status-chip status-ready' : 'status-chip status-blocked'}>{canRead ? <ShieldCheck aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{session ? session.roles.map(roleLabel).join(' / ') : '需要连接钱包'}</span></div>{!session ? <div className="session-prompt"><div><strong>连接审计授权钱包</strong><p>该页面从不提供删除或修改操作。</p></div><button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}><KeyRound aria-hidden="true" />连接钱包</button></div> : !canRead ? <ErrorView error={invalid('当前会话没有审计读取权限')} /> : <form className="search-grid audit-search" onSubmit={submit}><label>日志类型<select value={filters.streamName ?? ''} onChange={(event) => set('streamName', event.target.value || undefined)}><option value="">全部</option>{auditStreamNames.map((value) => <option key={value} value={value}>{auditStreamLabel(value)}</option>)}</select></label><label>业务对象类型<input value={filters.resourceType ?? ''} onChange={(event) => set('resourceType', event.target.value)} placeholder="例如订单、商品、商家" /></label><label>业务对象编号<input value={filters.resourceId ?? ''} onChange={(event) => set('resourceId', event.target.value)} /></label><label>问题编号（可不填）<input value={filters.correlationId ?? ''} onChange={(event) => set('correlationId', event.target.value)} placeholder="报错时复制页面显示的编号" /></label><label>开始时间<input type="datetime-local" onChange={(event) => set('from', event.target.value ? new Date(event.target.value).toISOString() : undefined)} /></label><label>结束时间<input type="datetime-local" onChange={(event) => set('to', event.target.value ? new Date(event.target.value).toISOString() : undefined)} /></label><label>数量上限<input type="number" min="1" max="200" value={filters.limit ?? 50} onChange={(event) => set('limit', Number(event.target.value))} /></label><button className="button button-primary" type="submit" disabled={loading}><Search aria-hidden="true" />{loading ? '查询中' : '查询日志'}</button></form>}{error ? <ErrorView error={error} /> : null}{result ? <><div className="status-overview compact-overview">{auditStreamNames.map((stream) => { const proof = result.chainProof[stream]; return <article key={stream}><span>{auditStreamLabel(stream)}</span><strong>{proof ? proof.verified ? '已验证' : '异常' : '无记录'}</strong><small>{proof ? `${proof.entries} 条记录` : '无审计记录'}</small></article>; })}</div><div className="table-scroll"><table className="data-table"><thead><tr><th>时间 / 类型</th><th>事件</th><th>业务对象</th><th>操作人</th><th>问题编号</th><th>日志凭证</th></tr></thead><tbody>{result.entries.map((entry) => <tr key={entry.entryId}><td><strong>{auditStreamLabel(entry.streamName)}</strong><small>{entry.createdAt}</small></td><td><strong>{eventTypeLabel(entry.eventType)}</strong><small>{evidenceProfileLabel(entry.evidenceProfile)}</small></td><td><strong>{resourceTypeLabel(entry.resourceType)}</strong><small title={entry.resourceId}>{shortId(entry.resourceId)}</small></td><td>{entry.actorWallet ? <span title={entry.actorWallet}>{shortAddress(entry.actorWallet)}</span> : '系统'}<small>{roleLabel(entry.actorRole ?? '') || '—'}</small></td><td><code title={entry.correlationId}>{shortId(entry.correlationId)}</code></td><td><code title={entry.entryHash}>{shortId(entry.entryHash)}</code><details className="technical-details compact"><summary>高级原始值</summary><code>{entry.eventType}</code><code>{entry.resourceType}</code></details></td></tr>)}</tbody></table></div>{!result.entries.length ? <p className="healthy-copy"><CheckCircle2 aria-hidden="true" />当前没有匹配结果，空结果不代表系统健康。</p> : null}</> : null}</section></>;
}

function auditStreamLabel(value: string) {
  return ({
    financial: '资金记录',
    governance: '治理操作',
    authentication: '登录授权',
    operational: '运营操作',
    backup: '备份恢复',
    admin_operations: '平台操作',
    auth_sessions: '登录与钱包',
    catalog: '商品与库存',
    clearing: '清算审计',
    fulfillment: '履约',
    merchant: '商家',
    notification: '消息通知',
    payment: '支付',
    risk: '风控',
    seckill: '秒杀',
    settlement: '结算',
    system: '系统配置',
    takeover: '接管履约',
  } as Record<string, string>)[value] ?? value;
}
function eventTypeLabel(value: string) {
  return ({
    PAYMENT_FINALIZED: '支付已确认',
    PAYMENT_REORGED: '支付确认回滚',
    SETTLEMENT_REQUESTED: '结算申请',
    SETTLEMENT_SUBMITTED: '提交打款',
    SETTLEMENT_SETTLED: '打款到账',
    MERCHANT_APPROVED: '商家通过',
    MERCHANT_REJECTED: '商家拒绝',
    PRODUCT_REVIEWED: '商品审核',
    POLICY_PUBLISHED: '规则发布',
    SECKILL_ACTION_EXECUTED: '秒杀动作执行',
    RISK_RESTRICTION_CREATED: '风控限制',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function evidenceProfileLabel(value: string) {
  return ({
    RBAC: '角色权限',
    AUTHORIZATION: '授权记录',
    SIGNED_OFFCHAIN: '钱包签名',
    SAFE_APPROVED: '多签历史记录',
    CHAIN_OBSERVED: '链上观察',
    CHAIN_FINAL: '链上最终确认',
    SYSTEM: '系统记录',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function resourceTypeLabel(value: string) {
  return ({
    ORDER: '订单',
    PAYMENT: '支付',
    MERCHANT: '商家',
    STORE: '门店',
    PRODUCT: '商品',
    SKU: '规格',
    SETTLEMENT: '结算',
    SETTLEMENT_TRANSFER: '打款',
    POLICY: '规则',
    SECKILL: '秒杀',
    RISK: '风控',
  } as Record<string, string>)[value] ?? humanizeKey(value);
}
function roleLabel(value: string) {
  return ({
    ADMIN: '管理员',
    OPERATOR: '运营',
    AUDITOR: '审计',
    MERCHANT: '商家',
    BUYER: '买家',
    SYSTEM: '系统',
  } as Record<string, string>)[value] ?? value;
}
function humanizeKey(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || value;
}
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 400 }); }
function asCoreError(cause: unknown) { return cause instanceof CoreApiError ? cause : new CoreApiError({ code: 'ExternalBlocked', message: '审计服务暂时不可用', status: 503 }); }
function ErrorView({ error }: { error: CoreApiError }) { return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>; }

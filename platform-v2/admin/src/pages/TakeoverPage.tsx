import {
  executableOrderActionNames,
  type AllowedAction,
  type FulfillmentOrder,
  type TakeoverOpenedResult,
} from '@abu24k/core-artifacts';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FileLock2,
  KeyRound,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BatchActionBar } from '../components/BatchActionBar';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  CoreApiError,
  fetchFulfillmentOrders,
  fetchOrderAllowedActions,
  openTakeover,
} from '../coreApi';
import { useCoreSession } from '../coreSession';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;
const stages = [
  { label: '自动建案', detail: 'payment finality 后 7 × 24h 无有效发货证据', icon: Clock3 },
  { label: '冻结商家权限', detail: '新订单、上架与商家结算申请', icon: Ban },
  { label: '顺序筹资', detail: '保证金 → 冻结应收 → 未来货款', icon: CircleDollarSign },
  { label: '完成履约', detail: '平台或替代商家发货，进入普通 finality', icon: Truck },
] as const;

export function TakeoverPage() {
  const { connect, error: sessionError, session, status } = useCoreSession();
  const [orders, setOrders] = useState<readonly FulfillmentOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [actions, setActions] = useState<readonly AllowedAction[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [resourceError, setResourceError] = useState<CoreApiError | null>(null);
  const [commandError, setCommandError] = useState<CoreApiError | null>(null);
  const [commandResult, setCommandResult] = useState<TakeoverOpenedResult | null>(null);
  const [evidenceHash, setEvidenceHash] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const hasPlatformRole = session?.roles.some((role) => role === 'ADMIN' || role === 'OPERATOR') ?? false;
  const selectedOrder = useMemo(
    () => orders.find((order) => order.orderId === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );
  const takeoverAction = actions.find((action) => action.action === 'OPEN_TAKEOVER');
  const takeoverPublished = executableOrderActionNames.includes('OPEN_TAKEOVER');
  const disabledReason = takeoverDisabledReason({
    actionsLoading,
    evidenceHash,
    hasPlatformRole,
    reasonCode,
    selectedOrder,
    session: Boolean(session),
    takeoverAction,
    takeoverPublished,
  });

  useEffect(() => {
    setOrders([]);
    setSelectedOrderId('');
    setActions([]);
    setResourceError(null);
    setCommandError(null);
    setCommandResult(null);
    if (!session || !hasPlatformRole) return;
    const controller = new AbortController();
    setOrdersLoading(true);
    void fetchFulfillmentOrders(session.token, controller.signal)
      .then((nextOrders) => {
        setOrders(nextOrders);
        setSelectedOrderId(nextOrders[0]?.orderId ?? '');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setResourceError(asCoreError(cause, '履约订单不可用'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setOrdersLoading(false);
      });
    return () => controller.abort();
  }, [hasPlatformRole, session]);

  useEffect(() => {
    setActions([]);
    setResourceError(null);
    setCommandError(null);
    setCommandResult(null);
    setEvidenceHash('');
    setReasonCode('');
    setIdempotencyKey('');
    if (!session || !hasPlatformRole || !selectedOrderId) return;
    const controller = new AbortController();
    setActionsLoading(true);
    void fetchOrderAllowedActions(selectedOrderId, session.token, controller.signal)
      .then(setActions)
      .catch((cause) => {
        if (!controller.signal.aborted) setResourceError(asCoreError(cause, '订单权限不可用'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setActionsLoading(false);
      });
    return () => controller.abort();
  }, [hasPlatformRole, selectedOrderId, session]);

  const submitTakeover = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !selectedOrder || disabledReason) return;
    const nextIdempotencyKey = idempotencyKey || `admin-takeover:${globalThis.crypto.randomUUID()}`;
    setIdempotencyKey(nextIdempotencyKey);
    setSubmitting(true);
    setCommandError(null);
    setCommandResult(null);
    try {
      const result = await openTakeover(selectedOrder.orderId, {
        idempotencyKey: nextIdempotencyKey,
        evidenceHash: evidenceHash.trim(),
        reasonCode: reasonCode.trim(),
      }, session.token);
      setCommandResult(result);
      try {
        const [nextOrders, nextActions] = await Promise.all([
          fetchFulfillmentOrders(session.token),
          fetchOrderAllowedActions(selectedOrder.orderId, session.token),
        ]);
        setOrders(nextOrders);
        setActions(nextActions);
      } catch (cause) {
        setResourceError(asCoreError(cause, '接管已提交，但最新订单状态读取失败'));
      }
    } catch (cause) {
      setCommandError(asCoreError(cause, '接管命令失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header className="page-header takeover-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div><p className="eyebrow">MERCHANT TAKEOVER</p><h1>商家接管履约中心</h1><p>接管不是资金返还流程。订单继续履约，支付与全部奖励保持 Locked。</p></div>
        <div className="requirement-list"><code>ADM-TAKE-001—002 · partial</code><code>D-V2-004 / 005 / 020</code></div>
      </header>

      <GlobalSearch />

      <section className="takeover-stage-grid" aria-label="接管履约阶段">
        {stages.map(({ label, detail, icon: Icon }, index) => (
          <article key={label}><span className="stage-number">0{index + 1}</span><Icon aria-hidden="true" /><h2>{label}</h2><p>{detail}</p>{index < stages.length - 1 ? <ArrowRight className="stage-arrow" aria-hidden="true" /> : null}</article>
        ))}
      </section>

      <section className="workspace-grid">
        <article className="panel panel-main takeover-console">
          <div className="panel-heading">
            <div><p className="section-kicker">GET /v2/orders · POST /v2/actions/order</p><h2>订单与实时操作权限</h2></div>
            <span className={hasPlatformRole ? 'status-chip status-ready' : 'status-chip status-blocked'}>
              {hasPlatformRole ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
              {session ? session.roles.join(' / ') : '需要 SIWE'}
            </span>
          </div>

          {!session ? (
            <div className="session-prompt">
              <div><strong>连接已授权的平台钱包</strong><p>Core 按当前钱包、角色、订单状态和断路器计算 allowedActions。</p></div>
              <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
                <KeyRound aria-hidden="true" /> {status === 'CONNECTING' ? '等待签名' : 'SIWE 连接'}
              </button>
            </div>
          ) : !hasPlatformRole ? (
            <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>Forbidden</strong><p>当前会话缺少 ADMIN 或 OPERATOR 角色，平台订单读取与接管写入均保持关闭。</p></div></div>
          ) : ordersLoading ? (
            <div className="catalog-loading" aria-label="正在读取履约订单"><span /><span /><span /></div>
          ) : resourceError ? (
            <CoreErrorView error={resourceError} />
          ) : orders.length === 0 ? (
            <div className="empty-table" role="status"><FileLock2 aria-hidden="true" /><h3>当前没有可见履约订单</h3><p>这是 Core 对当前 ADMIN / OPERATOR 会话返回的真实空列表。</p></div>
          ) : (
            <>
              <div className="table-scroll takeover-orders">
                <table className="data-table">
                  <thead><tr><th>订单</th><th>商家 / SKU</th><th>状态</th><th>最终性</th><th>接管</th><th>查看</th></tr></thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.orderId} className={order.orderId === selectedOrderId ? 'is-selected' : undefined}>
                        <td><code>{order.orderId}</code><small>{order.fulfillmentMode}</small></td>
                        <td><strong>{order.merchantId}</strong><small>{order.productId} / {order.skuId}</small></td>
                        <td><strong>{order.state}</strong><small>{formatDate(order.paidAt)}</small></td>
                        <td><strong>{order.finalityStatus}</strong><small>{formatDate(order.paymentFinalizedAt)}</small></td>
                        <td><strong>{order.takeoverOpenedAt ? 'OPEN' : 'NOT_OPEN'}</strong><small>{formatDate(order.takeoverOpenedAt)}</small></td>
                        <td><button className="button button-quiet" type="button" onClick={() => setSelectedOrderId(order.orderId)} aria-pressed={order.orderId === selectedOrderId}>查看</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedOrder ? (
                <div className="takeover-order-detail" aria-live="polite">
                  <div className="takeover-evidence">
                    <p className="section-kicker">Core fulfillment projection</p><h3>{selectedOrder.state} · {selectedOrder.fulfillmentMode}</h3>
                    <dl className="definition-grid">
                      <div><dt>Shipment evidence</dt><dd>{selectedOrder.shipments.length}</dd></div>
                      <div><dt>Logistics events</dt><dd>{selectedOrder.logistics.length}</dd></div>
                      <div><dt>Open requests</dt><dd>{selectedOrder.requests.filter((request) => request.state === 'OPEN').length}</dd></div>
                      <div><dt>Balance states</dt><dd>{selectedOrder.balances.map((balance) => `${balance.asset}:${balance.state}`).join(' · ') || '无'}</dd></div>
                    </dl>
                  </div>
                  <form className="takeover-command" onSubmit={(event) => void submitTakeover(event)}>
                    <div className="panel-heading"><div><p className="section-kicker">POST /v2/orders/{'{orderId}'}/takeover</p><h3>打开接管案件</h3></div><span className={takeoverAction?.enabled ? 'status-chip status-ready' : 'status-chip status-blocked'}>{actionsLoading ? 'Checking' : takeoverAction?.enabled ? 'Core allowed' : takeoverAction?.reasonCode ?? 'Not allowed'}</span></div>
                    <label htmlFor="takeover-evidence">履约证据哈希 · bytes32</label>
                    <input id="takeover-evidence" value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" />
                    <label htmlFor="takeover-reason">原因代码</label>
                    <input id="takeover-reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} autoComplete="off" placeholder="NO_SHIPMENT_AFTER_FINALITY" />
                    <button className="button button-primary button-full" type="submit" disabled={Boolean(disabledReason) || submitting}>
                      <PackageCheck aria-hidden="true" /> {submitting ? '提交中' : '打开接管案件'}
                    </button>
                    <p className="button-explanation">{disabledReason ?? '当前 ADMIN / OPERATOR 会话与 Core allowedActions 均已授权。'}</p>
                    {commandError ? <CoreErrorView error={commandError} /> : null}
                  </form>
                </div>
              ) : null}
            </>
          )}
          {commandResult ? <p className="healthy-copy takeover-command-result" role="status"><CheckCircle2 aria-hidden="true" /> Case {commandResult.caseId} 已打开，客户资金保持 Locked。</p> : null}
          {sessionError ? <p className="inline-notice" role="alert">{sessionError}</p> : null}
        </article>
        <aside className="panel takeover-guard">
          <p className="section-kicker">不可暂停能力</p><h2>履约与恢复通道</h2>
          <ul className="check-list"><li><ShieldCheck aria-hidden="true" /> 接管履约</li><li><ShieldCheck aria-hidden="true" /> 技术恢复与 reconciliation</li><li><ShieldCheck aria-hidden="true" /> finality synchronization</li><li><ShieldCheck aria-hidden="true" /> append-only audit reads</li></ul>
          <div className="debt-note"><AlertTriangle aria-hidden="true" /><p><strong>垫资记为商家债务</strong><br />保证金、冻结应收、未来货款和商家债务属于 settlement/admin checkpoint，本页不推算。</p></div>
          <button className="button button-quiet button-full" type="button" disabled title="未发布案件资金投影"><RefreshCw aria-hidden="true" /> 筹资与债务证据未发布</button>
        </aside>
      </section>

      <BatchActionBar ordinarySoftDelete={false} immutable />
    </>
  );
}

function takeoverDisabledReason(input: {
  actionsLoading: boolean;
  evidenceHash: string;
  hasPlatformRole: boolean;
  reasonCode: string;
  selectedOrder: FulfillmentOrder | null;
  session: boolean;
  takeoverAction: AllowedAction | undefined;
  takeoverPublished: boolean;
}) {
  if (!input.session) return '需要已认证的 Core 会话。';
  if (!input.hasPlatformRole) return '当前会话缺少 ADMIN 或 OPERATOR 角色。';
  if (!input.selectedOrder) return '请选择 Core 返回的履约订单。';
  if (!input.takeoverPublished) return '当前 artifact 未发布 OPEN_TAKEOVER 能力。';
  if (input.selectedOrder.state !== 'PAID') return `订单状态 ${input.selectedOrder.state} 不允许打开接管案件。`;
  if (input.actionsLoading) return '正在读取当前订单 allowedActions。';
  if (!input.takeoverAction) return 'Core 未向当前会话返回 OPEN_TAKEOVER。';
  if (!input.takeoverAction.enabled) return `Core 拒绝 OPEN_TAKEOVER：${input.takeoverAction.reasonCode ?? 'UnknownState'}${input.takeoverAction.deadline ? ` · ${input.takeoverAction.deadline}` : ''}`;
  if (!bytes32Pattern.test(input.evidenceHash.trim())) return '请输入 Core 要求的 bytes32 履约证据哈希。';
  if (!reasonCodePattern.test(input.reasonCode.trim())) return '原因代码必须为 2—64 位大写字母、数字、下划线、冒号或连字符。';
  return null;
}

function CoreErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p></div></div>;
}

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
}

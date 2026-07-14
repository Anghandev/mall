import {
  type AllowedAction,
  type FulfillmentOrder,
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
  RefreshCw,
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BatchActionBar } from '../components/BatchActionBar';
import { FulfillmentCommandPanel } from '../components/FulfillmentCommandPanel';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  CoreApiError,
  fetchFulfillmentOrders,
  fetchOrderAllowedActions,
  type PlatformFulfillmentCommandResult,
} from '../coreApi';
import { useCoreSession } from '../coreSession';

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
  const [commandPending, setCommandPending] = useState(false);
  const [resourceError, setResourceError] = useState<CoreApiError | null>(null);
  const [commandResult, setCommandResult] = useState<PlatformFulfillmentCommandResult | null>(null);
  const hasPlatformRole = session?.roles.some((role) => role === 'ADMIN' || role === 'OPERATOR') ?? false;
  const selectedOrder = useMemo(
    () => orders.find((order) => order.orderId === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );
  useEffect(() => {
    setOrders([]);
    setSelectedOrderId('');
    setActions([]);
    setResourceError(null);
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
    setCommandResult(null);
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

  const handleCommandCompleted = async (result: PlatformFulfillmentCommandResult) => {
    if (!session || !selectedOrder) return;
    setCommandResult(result);
    try {
      const [nextOrders, nextActions] = await Promise.all([
        fetchFulfillmentOrders(session.token),
        fetchOrderAllowedActions(selectedOrder.orderId, session.token),
      ]);
      setOrders(nextOrders);
      setActions(nextActions);
    } catch (cause) {
      setResourceError(asCoreError(cause, '命令已提交，但最新订单状态读取失败'));
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
                        <td><button className="button button-quiet" type="button" onClick={() => setSelectedOrderId(order.orderId)} aria-pressed={order.orderId === selectedOrderId} disabled={commandPending}>查看</button></td>
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
                    <div className="fulfillment-evidence-streams">
                      <EvidenceGroup title="Shipments" empty="无发货证据">
                        {selectedOrder.shipments.map((shipment) => <li key={shipment.shipmentId}><strong>{shipment.carrierCode} · {shipment.shipmentId}</strong><code>{shipment.trackingNumberHash}</code><small>{formatDate(shipment.createdAt)}</small></li>)}
                      </EvidenceGroup>
                      <EvidenceGroup title="Logistics" empty="无物流事件">
                        {selectedOrder.logistics.map((event) => <li key={event.logisticsEventId}><strong>{event.provider} · {event.status}</strong><code>{event.locationHash ?? '无位置哈希'}</code><small>{formatDate(event.occurredAt)}</small></li>)}
                      </EvidenceGroup>
                      <EvidenceGroup title="Requests" empty="无售后 / 仲裁申请">
                        {selectedOrder.requests.map((request) => <li key={request.requestId}><strong>{request.requestType} · {request.state}</strong><code>{request.requestId}</code><small>{formatDate(request.requestedAt)}</small></li>)}
                      </EvidenceGroup>
                      <EvidenceGroup title="Balances" empty="无资金状态投影">
                        {selectedOrder.balances.map((balance) => <li key={`${balance.asset}:${balance.state}`}><strong>{balance.asset} · {balance.state}</strong><code>{balance.amount}</code><small>Core atomic amount</small></li>)}
                      </EvidenceGroup>
                    </div>
                  </div>
                  <FulfillmentCommandPanel
                    actions={actions}
                    actionsLoading={actionsLoading}
                    onBusyChange={setCommandPending}
                    onCompleted={handleCommandCompleted}
                    order={selectedOrder}
                    roles={session.roles}
                    token={session.token}
                  />
                </div>
              ) : null}
            </>
          )}
          {commandResult ? <p className="healthy-copy takeover-command-result" role="status"><CheckCircle2 aria-hidden="true" /> Core 已确认订单状态 {commandResult.state}，订单 {commandResult.orderId}。</p> : null}
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

function CoreErrorView({ error }: { error: CoreApiError }) {
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p></div></div>;
}

function EvidenceGroup({ children, empty, title }: { children: ReactNode; empty: string; title: string }) {
  const hasEvidence = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section><h4>{title}</h4>{hasEvidence ? <ul>{children}</ul> : <p>{empty}</p>}</section>;
}

function asCoreError(cause: unknown, message: string) {
  return cause instanceof CoreApiError
    ? cause
    : new CoreApiError({ code: 'ExternalBlocked', message, status: 503 });
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
}

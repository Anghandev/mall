import {
  type AdminOrderSearchPage,
  type FulfillmentOrder,
  type OrderBatchActionPreview,
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
  ShieldCheck,
  Truck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BatchActionBar } from '../components/BatchActionBar';
import { FulfillmentCommandPanel } from '../components/FulfillmentCommandPanel';
import { GlobalSearch } from '../components/GlobalSearch';
import { TakeoverCaseWorkspace } from '../components/TakeoverCaseWorkspace';
import { TakeoverFundingPanel } from '../components/TakeoverFundingPanel';
import {
  CoreApiError,
  previewAdminOrderBatchActions,
  searchAdminOrders,
  type AdminOrderSearchFilters,
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
  const [page, setPage] = useState<AdminOrderSearchPage | null>(null);
  const [filters, setFilters] = useState<AdminOrderSearchFilters>({});
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedBatchOrderIds, setSelectedBatchOrderIds] = useState<readonly string[]>([]);
  const [batchPreview, setBatchPreview] = useState<OrderBatchActionPreview | null>(null);
  const [batchPreviewError, setBatchPreviewError] = useState<string | null>(null);
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [resourceError, setResourceError] = useState<CoreApiError | null>(null);
  const [commandResult, setCommandResult] = useState<PlatformFulfillmentCommandResult | null>(null);
  const hasPlatformRole = session?.roles.some((role) => role === 'ADMIN' || role === 'OPERATOR' || role === 'AUDITOR') ?? false;
  const orders = page?.orders ?? [];
  const selectedOrder = useMemo(
    () => orders.find((order) => order.orderId === selectedOrderId) ?? null,
    [orders, selectedOrderId],
  );
  useEffect(() => {
    setPage(null);
    setFilters({});
    setSelectedOrderId('');
    setSelectedBatchOrderIds([]);
    setBatchPreview(null);
    setBatchPreviewError(null);
    setResourceError(null);
    setCommandResult(null);
    if (!session || !hasPlatformRole) return;
    const controller = new AbortController();
    setOrdersLoading(true);
    void searchAdminOrders(session.token, {}, controller.signal)
      .then((nextPage) => {
        setPage(nextPage);
        setSelectedOrderId(nextPage.orders[0]?.orderId ?? '');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setResourceError(asCoreError(cause, '履约订单不可用'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setOrdersLoading(false);
      });
    return () => controller.abort();
  }, [hasPlatformRole, session]);

  const handleSearch = async (nextFilters: AdminOrderSearchFilters) => {
    if (!session || !hasPlatformRole) return;
    setOrdersLoading(true);
    setResourceError(null);
    setCommandResult(null);
    setSelectedBatchOrderIds([]);
    setBatchPreview(null);
    setBatchPreviewError(null);
    try {
      const nextPage = await searchAdminOrders(session.token, nextFilters);
      setFilters(nextFilters);
      setPage(nextPage);
      setSelectedOrderId(nextPage.orders[0]?.orderId ?? '');
    } catch (cause) {
      setResourceError(asCoreError(cause, 'Admin 订单查询不可用'));
    } finally {
      setOrdersLoading(false);
    }
  };

  const handleCommandCompleted = async (result: PlatformFulfillmentCommandResult) => {
    if (!session || !selectedOrder) return;
    setCommandResult(result);
    try {
      const nextPage = await searchAdminOrders(session.token, filters);
      setPage(nextPage);
      setSelectedBatchOrderIds([]);
      setBatchPreview(null);
      setBatchPreviewError(null);
    } catch (cause) {
      setResourceError(asCoreError(cause, '命令已提交，但最新订单状态读取失败'));
    }
  };

  const toggleBatchOrder = (orderId: string) => {
    setSelectedBatchOrderIds((current) => current.includes(orderId)
      ? current.filter((item) => item !== orderId)
      : [...current, orderId]);
    setBatchPreview(null);
    setBatchPreviewError(null);
  };

  const previewBatch = async () => {
    if (!session || selectedBatchOrderIds.length === 0) return;
    setBatchPreviewLoading(true);
    setBatchPreview(null);
    setBatchPreviewError(null);
    try {
      setBatchPreview(await previewAdminOrderBatchActions(selectedBatchOrderIds, session.token));
    } catch (cause) {
      const error = asCoreError(cause, '批次 allowedActions 预览不可用');
      setBatchPreviewError(`${error.code}: ${error.message}${error.correlationId ? ` · ${error.correlationId}` : ''}`);
    } finally {
      setBatchPreviewLoading(false);
    }
  };

  return (
    <>
      <header className="page-header takeover-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div><p className="eyebrow">MERCHANT TAKEOVER</p><h1>商家接管履约中心</h1><p>接管不是资金返还流程。订单继续履约，支付与全部奖励保持 Locked。</p></div>
        <div className="requirement-list"><code>ADM-TAKE-001—002</code><code>D-V2-004 / 005 / 020</code></div>
      </header>

      <GlobalSearch enabled={Boolean(session && hasPlatformRole)} loading={ordersLoading} onSearch={(nextFilters) => void handleSearch(nextFilters)} />

      {page ? (
        <section className="admin-order-projection" aria-label="Admin 订单查询投影">
          <div><span>结果</span><strong>{page.orders.length}</strong><small>{page.nextCursor ? '存在下一页稳定游标' : '当前页结束'}</small></div>
          <div><span>商品审核</span><strong>{page.pendingProductReview === null ? '未筛选' : page.pendingProductReview ? 'PENDING' : 'NOT_PENDING'}</strong><small>Core product-review projection</small></div>
          <div><span>Breaker</span><strong>{page.breaker ? page.breaker.active ? 'ACTIVE' : 'INACTIVE' : '未筛选'}</strong><small>{page.breaker?.scope ?? '选择 scope 后读取'}</small></div>
          <div><span>Paused scopes</span><strong>{page.pausedScopes.length}</strong><small>{page.pausedScopes.join(' · ') || '无'}</small></div>
        </section>
      ) : null}

      <section className="takeover-stage-grid" aria-label="接管履约阶段">
        {stages.map(({ label, detail, icon: Icon }, index) => (
          <article key={label}><span className="stage-number">0{index + 1}</span><Icon aria-hidden="true" /><h2>{label}</h2><p>{detail}</p>{index < stages.length - 1 ? <ArrowRight className="stage-arrow" aria-hidden="true" /> : null}</article>
        ))}
      </section>

      <TakeoverCaseWorkspace
        connecting={status === 'CONNECTING'}
        session={session}
      />

      <section className="workspace-grid">
        <article className="panel panel-main takeover-console">
          <div className="panel-heading">
            <div><p className="section-kicker">GET /v2/admin/orders</p><h2>订单与实时操作权限</h2></div>
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
            <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>Forbidden</strong><p>当前会话缺少 ADMIN、OPERATOR 或 AUDITOR 角色，平台订单读取与接管写入均保持关闭。</p></div></div>
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
                  <thead><tr><th><span className="sr-only">批次选择</span></th><th>订单</th><th>商品 / SKU</th><th>类型 / 支付</th><th>状态</th><th>最终性</th><th>查看</th></tr></thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.orderId} className={order.orderId === selectedOrderId ? 'is-selected' : undefined}>
                        <td><input type="checkbox" aria-label={`选择订单 ${order.orderId}`} checked={selectedBatchOrderIds.includes(order.orderId)} onChange={() => toggleBatchOrder(order.orderId)} disabled={commandPending} /></td>
                        <td><code>{order.orderId}</code><small>{formatDate(order.createdAt)}</small></td>
                        <td><strong>{order.productId}</strong><small>{order.skuId} · qty {order.quantity}</small></td>
                        <td><strong>{order.orderKind}</strong><code>{order.paymentTxHash ?? '未提交 TxHash'}</code></td>
                        <td><strong>{order.state}</strong><small>{formatDate(order.paidAt)}</small></td>
                        <td><strong>{order.finalityStatus}</strong><small>{order.fulfillmentMode} · {order.allowedActions.filter((action) => action.enabled).length} enabled</small></td>
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
                    actions={selectedOrder.allowedActions}
                    actionsLoading={false}
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
          <div className="debt-note"><AlertTriangle aria-hidden="true" /><p><strong>垫资记为商家债务</strong><br />下方直接消费 Core 的筹资、垫资与债务投影；本页不推算金额。</p></div>
        </aside>
      </section>

      <TakeoverFundingPanel />

      <BatchActionBar
        ordinarySoftDelete={false}
        immutable
        selectedCount={selectedBatchOrderIds.length}
        preview={batchPreview}
        previewError={batchPreviewError}
        previewLoading={batchPreviewLoading}
        onPreview={() => void previewBatch()}
      />
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

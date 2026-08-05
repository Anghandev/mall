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
import { CopyableWallet } from '../components/CopyableWallet';
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
import { commonStateLabel, formatBnm, formatNpl, formatTokenAmount, formatUsdt, humanizeError, shortId } from '../display';

const stages = [
  { label: '自动建案', detail: '支付最终确认后 7 天仍无有效发货证据', icon: Clock3 },
  { label: '冻结商家权限', detail: '新订单、上架与商家结算申请', icon: Ban },
  { label: '顺序筹资', detail: '冻结应收 → 未来货款 → 平台垫资', icon: CircleDollarSign },
  { label: '完成履约', detail: '平台或替代商家发货，继续等待最终确认', icon: Truck },
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
        if (!controller.signal.aborted) setResourceError(asCoreError(cause, '履约订单暂时无法连接'));
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
      setResourceError(asCoreError(cause, '订单查询暂时无法连接'));
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
      const error = asCoreError(cause, '批次操作预览暂时无法连接');
      setBatchPreviewError(humanizeError(error));
    } finally {
      setBatchPreviewLoading(false);
    }
  };

  return (
    <>
      <header className="page-header takeover-header">
        <div className="page-icon"><ShieldCheck aria-hidden="true" /></div>
        <div><p className="eyebrow">接管履约</p><h1>商家接管履约中心</h1><p>接管不是退款。订单继续履约，支付和奖励在最终处理前保持锁定。</p></div>
        <div className="requirement-list"><code>逾期发货</code><code>平台接管</code></div>
      </header>

      <GlobalSearch enabled={Boolean(session && hasPlatformRole)} loading={ordersLoading} onSearch={(nextFilters) => void handleSearch(nextFilters)} />

      {page ? (
        <section className="admin-order-projection" aria-label="平台订单查询概览">
          <div><span>结果</span><strong>{page.orders.length}</strong><small>{page.nextCursor ? '存在下一页稳定游标' : '当前页结束'}</small></div>
          <div><span>商品审核</span><strong>{page.pendingProductReview === null ? '未筛选' : page.pendingProductReview ? '待审核' : '非待审核'}</strong><small>商品审核筛选结果</small></div>
          <div><span>安全开关</span><strong>{page.breaker ? page.breaker.active ? '已启用' : '未启用' : '未筛选'}</strong><small>{page.breaker?.scope ? breakerScopeLabel(page.breaker.scope) : '选择范围后读取'}</small></div>
          <div><span>已暂停范围</span><strong>{page.pausedScopes.length}</strong><small>{page.pausedScopes.map(breakerScopeLabel).join(' · ') || '无'}</small></div>
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
            <div><p className="section-kicker">履约订单</p><h2>订单与实时操作权限</h2></div>
            <span className={hasPlatformRole ? 'status-chip status-ready' : 'status-chip status-blocked'}>
              {hasPlatformRole ? <CheckCircle2 aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
              {session ? roleListLabel(session.roles) : '需要连接钱包'}
            </span>
          </div>

          {!session ? (
            <div className="session-prompt">
              <div><strong>连接已授权的平台钱包</strong><p>系统按当前钱包、角色、订单状态和安全开关显示能点哪些按钮。</p></div>
              <button className="button button-primary" type="button" onClick={() => void connect()} disabled={status === 'CONNECTING'}>
                <KeyRound aria-hidden="true" /> {status === 'CONNECTING' ? '等待签名' : '连接钱包'}
              </button>
            </div>
          ) : !hasPlatformRole ? (
            <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>没有权限</strong><p>当前钱包缺少 ADMIN、OPERATOR 或 AUDITOR 角色，平台订单读取与接管写入保持关闭。</p></div></div>
          ) : ordersLoading ? (
            <div className="catalog-loading" aria-label="正在读取履约订单"><span /><span /><span /></div>
          ) : resourceError ? (
            <CoreErrorView error={resourceError} />
          ) : orders.length === 0 ? (
            <div className="empty-table" role="status"><FileLock2 aria-hidden="true" /><h3>当前没有可见履约订单</h3><p>这是系统对当前平台钱包返回的真实空列表。</p></div>
          ) : (
            <>
              <div className="table-scroll takeover-orders">
                <table className="data-table">
                  <thead><tr><th><span className="sr-only">批次选择</span></th><th>订单</th><th>商品 / 规格</th><th>类型 / 支付</th><th>状态</th><th>确认</th><th>查看</th></tr></thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.orderId} className={order.orderId === selectedOrderId ? 'is-selected' : undefined}>
                        <td><input type="checkbox" aria-label={`选择订单 ${order.orderId}`} checked={selectedBatchOrderIds.includes(order.orderId)} onChange={() => toggleBatchOrder(order.orderId)} disabled={commandPending} /></td>
                        <td><code title={order.orderId}>{shortId(order.orderId)}</code><small>{formatDate(order.createdAt)}</small></td>
                        <td><strong title={order.productId}>{shortId(order.productId)}</strong><small title={order.skuId}>{shortId(order.skuId)} · 数量 {order.quantity}</small></td>
                        <td><strong>{orderKindLabel(order.orderKind)}</strong>{order.paymentTxHash ? <details className="technical-details compact"><summary>付款已提交</summary><code title={order.paymentTxHash}>{shortId(order.paymentTxHash)}</code></details> : <small>未提交付款记录</small>}</td>
                        <td><strong>{orderStateLabel(order.state)}</strong><small>{formatDate(order.paidAt)}</small></td>
                        <td><strong>{finalityStatusLabel(order.finalityStatus)}</strong><small>{fulfillmentModeLabel(order.fulfillmentMode)} · {order.allowedActions.filter((action) => action.enabled).length} 个可操作</small></td>
                        <td><button className="button button-quiet" type="button" onClick={() => setSelectedOrderId(order.orderId)} aria-pressed={order.orderId === selectedOrderId} disabled={commandPending}>查看</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedOrder ? (
                <div className="takeover-order-detail" aria-live="polite">
                  <div className="takeover-evidence">
                    <p className="section-kicker">履约详情</p><h3>{orderStateLabel(selectedOrder.state)} · {fulfillmentModeLabel(selectedOrder.fulfillmentMode)}</h3>
                    <dl className="definition-grid">
                      <div><dt>买家钱包</dt><dd><CopyableWallet label="买家钱包" value={selectedOrder.buyerWallet} /></dd></div>
                      <div><dt>发货凭证</dt><dd>{selectedOrder.shipments.length}</dd></div>
                      <div><dt>物流记录</dt><dd>{selectedOrder.logistics.length}</dd></div>
                      <div><dt>处理中申请</dt><dd>{selectedOrder.requests.filter((request) => request.state === 'OPEN').length}</dd></div>
                      <div><dt>资金状态</dt><dd>{selectedOrder.balances.map((balance) => `${assetLabel(balance.asset)}：${commonStateLabel(balance.state)}`).join(' · ') || '无'}</dd></div>
                    </dl>
                    <div className="fulfillment-evidence-streams">
                      <EvidenceGroup title="发货凭证" empty="无发货证据">
                        {selectedOrder.shipments.map((shipment) => (
                          <li key={shipment.shipmentId}>
                            <strong>{shipment.carrierCode} · {shipment.trackingNumber ?? '暂无运单号'}</strong>
                            {shipment.note ? <span>{shipment.note}</span> : null}
                            <code title={shipment.evidenceHash}>{shortId(shipment.evidenceHash)}</code>
                            <small>{shipment.mediaAssetIds.length} 个凭证 · {formatDate(shipment.createdAt)}</small>
                          </li>
                        ))}
                      </EvidenceGroup>
                      <EvidenceGroup title="物流记录" empty="无物流事件">
                        {selectedOrder.logistics.map((event) => <li key={event.logisticsEventId}><strong>{event.provider} · {event.status}</strong><code title={event.locationHash ?? undefined}>{event.locationHash ? shortId(event.locationHash) : '无位置凭证'}</code><small>{formatDate(event.occurredAt)}</small></li>)}
                      </EvidenceGroup>
                      <EvidenceGroup title="售后 / 仲裁申请" empty="无售后 / 仲裁申请">
                        {selectedOrder.requests.map((request) => <li key={request.requestId}><strong>{requestTypeLabel(request.requestType)} · {commonStateLabel(request.state)}</strong><code title={request.requestId}>{shortId(request.requestId)}</code><small>{formatDate(request.requestedAt)}</small></li>)}
                      </EvidenceGroup>
                      <EvidenceGroup title="资金状态" empty="无资金状态">
                        {selectedOrder.balances.map((balance) => <li key={`${balance.asset}:${balance.state}`}><strong>{assetLabel(balance.asset)} · {commonStateLabel(balance.state)}</strong><code>{formatAssetBalance(balance.amount, balance.asset)}</code><small>系统真实资金状态</small></li>)}
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
          {commandResult ? <p className="healthy-copy takeover-command-result" role="status"><CheckCircle2 aria-hidden="true" /> 系统已确认订单状态：{orderStateLabel(commandResult.state)}，订单 {shortId(commandResult.orderId)}。</p> : null}
          {sessionError ? <p className="inline-notice" role="alert">{sessionError}</p> : null}
        </article>
        <aside className="panel takeover-guard">
          <p className="section-kicker">不可暂停能力</p><h2>履约与恢复通道</h2>
          <ul className="check-list"><li><ShieldCheck aria-hidden="true" /> 接管履约</li><li><ShieldCheck aria-hidden="true" /> 技术恢复与对账</li><li><ShieldCheck aria-hidden="true" /> 最终确认同步</li><li><ShieldCheck aria-hidden="true" /> 审计读取</li></ul>
          <div className="debt-note"><AlertTriangle aria-hidden="true" /><p><strong>垫资记为商家债务</strong><br />下方直接展示系统的筹资、垫资与债务结果；本页不推算金额。</p></div>
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
  return <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div>;
}

function formatAssetBalance(amount: string, asset: string) {
  if (asset === 'USDT') return formatUsdt(amount);
  if (asset === 'NPL') return formatNpl(amount);
  if (asset === 'BNM' || asset === 'BNM_POINTS') return formatBnm(amount);
  return formatTokenAmount(amount, asset);
}

function assetLabel(asset: string) {
  return asset === 'BNM_POINTS' ? 'BNM 积分' : asset;
}

function orderKindLabel(value: string) {
  return ({
    ORDINARY: '普通订单',
    SECKILL: '秒杀订单',
    SECKILL_FALLBACK: '秒杀后备订单',
  } as Record<string, string>)[value] ?? value;
}

function orderStateLabel(value: string) {
  return ({
    QUOTED: '待付款',
    SUBMITTED: '已提交付款',
    PAID: '已支付',
    SHIPPED: '已发货',
    DELIVERED: '已送达',
    FULFILLED: '已履约',
    ARBITRATION: '仲裁中',
    TAKEOVER: '平台接管',
    CLOSED: '已关闭',
  } as Record<string, string>)[value] ?? commonStateLabel(value);
}

function finalityStatusLabel(value: string) {
  return ({
    NOT_SUBMITTED: '未提交',
    SUBMITTED: '已提交',
    PENDING: '确认中',
    FINAL: '已最终确认',
    REORGED: '已回滚',
    FAILED: '确认失败',
  } as Record<string, string>)[value] ?? commonStateLabel(value);
}

function fulfillmentModeLabel(value: string) {
  return ({
    DELIVERY: '快递发货',
    PICKUP: '到店自提',
  } as Record<string, string>)[value] ?? value;
}

function requestTypeLabel(value: string) {
  return ({
    EXCHANGE: '换货',
    DELAY: '延期',
    ARBITRATION: '仲裁',
    FORCED_RECEIPT: '强制收货',
  } as Record<string, string>)[value] ?? value;
}

function breakerScopeLabel(scope: string) {
  return ({
    NEW_PAYMENT: '新支付',
    SECKILL_PURCHASE: '秒杀购买',
    SETTLEMENT_TRANSFER_CREATION: '新结算转账',
  } as Record<string, string>)[scope] ?? scope;
}

function roleListLabel(roles: readonly string[]) {
  return roles.join(' / ')
    .replace(/\bADMIN\b/g, '管理员')
    .replace(/\bOPERATOR\b/g, '运营')
    .replace(/\bAUDITOR\b/g, '审计');
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

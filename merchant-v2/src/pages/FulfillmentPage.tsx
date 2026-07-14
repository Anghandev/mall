import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  orderProjectionStates,
  type AllowedAction,
  type AllowedActionName,
  type FulfillmentOrder,
  type FulfillmentTarget,
} from '@abu24k/core-artifacts';
import {
  Box,
  Download,
  FileSpreadsheet,
  PackageCheck,
  Printer,
  RefreshCw,
  ScanLine,
  Search,
  Send,
} from 'lucide-react';
import { EmptyState, LoadingRows, PageHeader } from '../components/ui';
import { canExecuteOrderAction } from '../core-boundary';
import { readableError, useCoreRuntime } from '../core-runtime';

type LoadState<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string };

type CommandKind = 'shipment' | 'forced-receipt' | 'pickup';
type CommandState =
  | { phase: 'idle' }
  | { phase: 'submitting'; kind: CommandKind }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const carrierPattern = /^[A-Z0-9_-]{2,32}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;
const pickupCodePattern = /^[0-9]{6}$/;
const deliveryColumns = ['订单号', '订单类型', 'SKU', '订单状态', '支付最终性', '下单时间', '物流单号哈希', '操作'];
const pickupColumns = ['订单号', '订单类型', 'SKU', '订单状态', '核销门店', '完成时间', '支付最终性', '操作'];

export function FulfillmentPage() {
  const { api, bootstrap, session } = useCoreRuntime();
  const [tab, setTab] = useState<'delivery' | 'pickup'>('delivery');
  const [ordersState, setOrdersState] = useState<LoadState<readonly FulfillmentOrder[]>>({ phase: 'idle' });
  const [selectedOrderId, setSelectedOrderId] = useState<string>();
  const [actionsState, setActionsState] = useState<LoadState<readonly AllowedAction[]>>({ phase: 'idle' });
  const [targetState, setTargetState] = useState<LoadState<FulfillmentTarget>>({ phase: 'idle' });
  const [commandState, setCommandState] = useState<CommandState>({ phase: 'idle' });
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [skuFilter, setSkuFilter] = useState('');
  const [carrierCode, setCarrierCode] = useState('');
  const [trackingNumberHash, setTrackingNumberHash] = useState('');
  const [shipmentEvidenceHash, setShipmentEvidenceHash] = useState('');
  const [receiptEvidenceHash, setReceiptEvidenceHash] = useState('');
  const [receiptReasonCode, setReceiptReasonCode] = useState('');
  const [pickupCode, setPickupCode] = useState('');
  const [pickupEvidenceHash, setPickupEvidenceHash] = useState('');
  const commandKeys = useRef<Partial<Record<CommandKind, string>>>({});
  const selectedOrderRef = useRef<string | undefined>(undefined);
  const sessionTokenRef = useRef(session?.token);
  sessionTokenRef.current = session?.token;

  const loadOrders = useCallback(async (quiet = false) => {
    if (!session) {
      setOrdersState({ phase: 'idle' });
      return;
    }
    if (!quiet) setOrdersState({ phase: 'loading' });
    const token = session.token;
    try {
      const value = await api.listFulfillmentOrders(token);
      if (sessionTokenRef.current === token) setOrdersState({ phase: 'ready', value });
    } catch (error) {
      if (sessionTokenRef.current === token) {
        setOrdersState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [api, session]);

  const loadActions = useCallback(async (quiet = false) => {
    if (!session || !selectedOrderId) {
      setActionsState({ phase: 'idle' });
      return;
    }
    if (!quiet) setActionsState({ phase: 'loading' });
    const orderId = selectedOrderId;
    const token = session.token;
    try {
      const value = await api.getOrderAllowedActions(orderId, token);
      if (selectedOrderRef.current === orderId && sessionTokenRef.current === token) {
        setActionsState({ phase: 'ready', value });
      }
    } catch (error) {
      if (selectedOrderRef.current === orderId && sessionTokenRef.current === token) {
        setActionsState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [api, selectedOrderId, session]);

  const loadTarget = useCallback(async (quiet = false) => {
    if (!session || !selectedOrderId) {
      setTargetState({ phase: 'idle' });
      return;
    }
    if (!quiet) setTargetState({ phase: 'loading' });
    const orderId = selectedOrderId;
    const token = session.token;
    try {
      const value = await api.getOrderFulfillmentTarget(orderId, token);
      if (selectedOrderRef.current === orderId && sessionTokenRef.current === token) {
        setTargetState({ phase: 'ready', value });
      }
    } catch (error) {
      if (selectedOrderRef.current === orderId && sessionTokenRef.current === token) {
        setTargetState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [api, selectedOrderId, session]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    void loadActions();
    void loadTarget();
  }, [loadActions, loadTarget]);

  const orders = ordersState.phase === 'ready' ? ordersState.value : [];
  const selectedOrder = orders.find((order) => order.orderId === selectedOrderId);
  const allowedActions = actionsState.phase === 'ready' ? actionsState.value : undefined;
  const selectedTarget = targetState.phase === 'ready' ? targetState.value : undefined;
  const targetMatchesOrder = Boolean(
    selectedOrder && selectedTarget && selectedOrder.fulfillmentMode === selectedTarget.fulfillmentMode,
  );
  const visibleOrders = useMemo(() => orders.filter((order) => {
    if (order.fulfillmentMode !== (tab === 'delivery' ? 'DELIVERY' : 'PICKUP')) return false;
    if (stateFilter && order.state !== stateFilter) return false;
    if (skuFilter && !order.skuId.toLowerCase().includes(skuFilter.trim().toLowerCase())) return false;
    const query = search.trim().toLowerCase();
    return !query || order.orderId.toLowerCase().includes(query) || order.skuId.toLowerCase().includes(query);
  }), [orders, search, skuFilter, stateFilter, tab]);
  const columns = tab === 'delivery' ? deliveryColumns : pickupColumns;
  const submitting = commandState.phase === 'submitting';
  const canExecute = (action: AllowedActionName) => (
    Boolean(session && selectedOrder && targetMatchesOrder)
    && canExecuteOrderAction(action, allowedActions)
  );
  const shipmentAllowed = selectedOrder?.fulfillmentMode === 'DELIVERY' && canExecute('RECORD_SHIPMENT');
  const receiptAllowed = selectedOrder?.fulfillmentMode === 'DELIVERY' && canExecute('REQUEST_FORCED_RECEIPT');
  const pickupAllowed = selectedOrder?.fulfillmentMode === 'PICKUP' && canExecute('VERIFY_PICKUP');
  const shipmentValid = carrierPattern.test(carrierCode)
    && bytes32Pattern.test(trackingNumberHash)
    && bytes32Pattern.test(shipmentEvidenceHash);
  const receiptValid = bytes32Pattern.test(receiptEvidenceHash)
    && reasonCodePattern.test(receiptReasonCode);
  const pickupValid = pickupCodePattern.test(pickupCode)
    && bytes32Pattern.test(pickupEvidenceHash)
    && selectedTarget?.fulfillmentMode === 'PICKUP';

  function selectOrder(order: FulfillmentOrder) {
    selectedOrderRef.current = order.orderId;
    setSelectedOrderId(order.orderId);
    setActionsState({ phase: 'loading' });
    setTargetState({ phase: 'loading' });
    setTab(order.fulfillmentMode === 'DELIVERY' ? 'delivery' : 'pickup');
    setCommandState({ phase: 'idle' });
    commandKeys.current = {};
    setCarrierCode('');
    setTrackingNumberHash('');
    setShipmentEvidenceHash('');
    setReceiptEvidenceHash('');
    setReceiptReasonCode('');
    setPickupCode('');
    setPickupEvidenceHash('');
  }

  function updateCommandInput(kind: CommandKind, update: () => void) {
    delete commandKeys.current[kind];
    setCommandState({ phase: 'idle' });
    update();
  }

  function idempotencyKey(kind: CommandKind) {
    const existing = commandKeys.current[kind];
    if (existing) return existing;
    const random = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const next = `merchant-${kind}-${random}`;
    commandKeys.current[kind] = next;
    return next;
  }

  async function runCommand(kind: CommandKind, operation: (key: string) => Promise<string>) {
    if (!session || !selectedOrder) return;
    setCommandState({ phase: 'submitting', kind });
    try {
      const message = await operation(idempotencyKey(kind));
      delete commandKeys.current[kind];
      setCommandState({ phase: 'success', message });
      void loadOrders(true);
      void loadActions(true);
      void loadTarget(true);
    } catch (error) {
      setCommandState({ phase: 'error', message: readableError(error) });
    }
  }

  function submitShipment() {
    if (!session || !selectedOrder || !shipmentAllowed || !shipmentValid) return;
    void runCommand('shipment', async (key) => {
      const result = await api.recordShipment(selectedOrder.orderId, {
        idempotencyKey: key,
        evidenceHash: shipmentEvidenceHash,
        carrierCode,
        trackingNumberHash,
      }, session.token);
      return `发货证据已记录：${result.shipmentId}`;
    });
  }

  function submitForcedReceipt() {
    if (!session || !selectedOrder || !receiptAllowed || !receiptValid) return;
    void runCommand('forced-receipt', async (key) => {
      const result = await api.requestForcedReceipt(selectedOrder.orderId, {
        idempotencyKey: key,
        evidenceHash: receiptEvidenceHash,
        reasonCode: receiptReasonCode,
      }, session.token);
      return `平台审核申请已提交：${result.requestId}`;
    });
  }

  function submitPickup() {
    if (
      !session
      || !selectedOrder
      || !pickupAllowed
      || !pickupValid
      || selectedTarget?.fulfillmentMode !== 'PICKUP'
    ) return;
    void runCommand('pickup', async (key) => {
      const result = await api.verifyPickup(selectedOrder.orderId, {
        idempotencyKey: key,
        evidenceHash: pickupEvidenceHash,
        code: pickupCode,
        storeId: selectedTarget.storeId,
      }, session.token);
      return `门店核销已完成：${result.fulfilledAt}`;
    });
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <div className="button-group">
            <button className="button secondary" disabled type="button"><Printer aria-hidden="true" size={16} /> 批量打印</button>
            <button className="button secondary" disabled type="button"><Download aria-hidden="true" size={16} /> 导出 Excel</button>
            <button className="button primary" disabled={!session || ordersState.phase === 'loading'} onClick={() => void loadOrders()} type="button"><RefreshCw aria-hidden="true" size={16} /> 刷新订单</button>
          </div>
        )}
        description="秒杀与常规订单统一履约。商家不能改价、退款或直接完成签收。"
        eyebrow="03 / 订单与发货"
        title="履约交付"
      />

      <section className="section-block fulfillment-workspace" aria-labelledby="orders-title">
        <div className="tabs" role="group" aria-label="履约方式">
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'delivery'} className={tab === 'delivery' ? 'active' : undefined} id="delivery-tab" onClick={() => setTab('delivery')} type="button"><Box aria-hidden="true" size={17} /> 快递邮寄</button>
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'pickup'} className={tab === 'pickup' ? 'active' : undefined} id="pickup-tab" onClick={() => setTab('pickup')} type="button"><ScanLine aria-hidden="true" size={17} /> 到店自提</button>
        </div>
        <div className="section-heading"><div><p className="eyebrow">Merchant-scoped orders</p><h2 id="orders-title">商家履约订单</h2></div><span>{ordersState.phase === 'ready' ? `${visibleOrders.length} 笔` : '实时 Core 读取'}</span></div>
        <p className="section-intro">订单来自当前 SIWE 商家会话的 `GET /v2/orders`。当前 artifact 未提供普通/秒杀分类字段，列表明确显示未发布，不按价格、商品或时间猜测。</p>
        <div className="filter-bar" aria-label="订单筛选">
          <div className="search-field"><Search aria-hidden="true" size={17} /><input aria-label="搜索订单号或 SKU" disabled={ordersState.phase !== 'ready'} onChange={(event) => setSearch(event.target.value)} placeholder="搜索订单号 / SKU" type="search" value={search} /></div>
          <label><span>SKU</span><input aria-label="SKU 筛选" disabled={ordersState.phase !== 'ready'} onChange={(event) => setSkuFilter(event.target.value)} placeholder="输入 SKU" type="text" value={skuFilter} /></label>
          <label><span>订单状态</span><select aria-label="订单状态" disabled={ordersState.phase !== 'ready'} onChange={(event) => setStateFilter(event.target.value)} value={stateFilter}><option value="">全部状态</option>{orderProjectionStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <label><span>时间范围</span><input disabled aria-label="开始日期" type="date" /></label>
          <button className="button secondary" disabled type="button"><FileSpreadsheet aria-hidden="true" size={16} /> 批量发货</button>
        </div>
        <div aria-live="polite" className="table-wrap" id="fulfillment-orders">
          <table>
            <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>
              {ordersState.phase === 'loading' ? <tr><td colSpan={columns.length}><LoadingRows count={4} /></td></tr> : null}
              {ordersState.phase === 'error' ? <tr><td colSpan={columns.length}><EmptyState blocked description={ordersState.message} title="订单读取失败" /></td></tr> : null}
              {ordersState.phase === 'idle' ? <tr><td colSpan={columns.length}><EmptyState blocked description="连接授权商家钱包后读取订单。" title="商家会话不可用" /></td></tr> : null}
              {ordersState.phase === 'ready' && visibleOrders.length === 0 ? <tr><td colSpan={columns.length}><EmptyState description="当前履约方式和筛选条件下没有订单。" title="暂无匹配订单" /></td></tr> : null}
              {visibleOrders.map((order) => (
                <OrderRow
                  key={order.orderId}
                  onSelect={() => selectOrder(order)}
                  order={order}
                  selected={order.orderId === selectedOrderId}
                  selectionDisabled={submitting}
                  target={order.orderId === selectedOrderId ? selectedTarget : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="panel-note">Cursor pagination、PII-safe Excel 导出和批量发货契约尚未发布；相关控件保持关闭，不在浏览器拼装平行接口。</p>
      </section>

      <section className="section-block order-check" aria-labelledby="order-check-title">
        <div className="section-heading"><div><p className="eyebrow">Fulfillment checkpoint</p><h2 id="order-check-title">单订单履约控制</h2></div><span>{selectedOrder ? selectedOrder.fulfillmentMode : '尚未选择'}</span></div>
        {!selectedOrder ? <EmptyState description="从上方列表选择一笔订单，读取门店/地址快照和实时可执行动作。" title="选择订单后继续" /> : (
          <>
            <OrderSummary order={selectedOrder} />
            <div className="two-panel-grid">
              <TargetPanel state={targetState} />
              <BalancePanel order={selectedOrder} />
            </div>
            {targetState.phase === 'ready' && !targetMatchesOrder ? <p className="form-error" role="alert">订单履约方式与 Core 目标快照不一致，所有命令已关闭。</p> : null}
            {actionsState.phase === 'loading' ? <LoadingRows count={3} /> : null}
            {actionsState.phase === 'error' ? <p className="form-error" role="alert">{actionsState.message}</p> : null}
            {actionsState.phase === 'ready' ? <AllowedActionsTable actions={actionsState.value} /> : null}
          </>
        )}
      </section>

      {selectedOrder?.fulfillmentMode === 'DELIVERY' ? (
        <div className="two-panel-grid">
          <form className="section-block compact-section" onSubmit={(event) => { event.preventDefault(); submitShipment(); }}>
            <div className="section-heading"><div><p className="eyebrow">Shipment evidence</p><h2>提交发货证据</h2></div><PackageCheck aria-hidden="true" size={19} /></div>
            <div className="field"><label htmlFor="carrier-code">承运商代码</label><input autoComplete="off" disabled={!shipmentAllowed || submitting} id="carrier-code" onChange={(event) => updateCommandInput('shipment', () => setCarrierCode(event.target.value.toUpperCase()))} pattern="[A-Z0-9_-]{2,32}" placeholder="例如 SF_EXPRESS" value={carrierCode} /></div>
            <div className="field"><label htmlFor="tracking-number-hash">物流单号哈希</label><input autoComplete="off" disabled={!shipmentAllowed || submitting} id="tracking-number-hash" onChange={(event) => updateCommandInput('shipment', () => setTrackingNumberHash(event.target.value))} pattern="0x[0-9a-fA-F]{64}" placeholder="0x + 64 位十六进制" value={trackingNumberHash} /><span className="field-help">Core 当前只接收已生成的 trackingNumberHash；本页不猜测原始单号哈希规则。</span></div>
            <div className="field"><label htmlFor="shipment-evidence-hash">发货证据哈希</label><input autoComplete="off" disabled={!shipmentAllowed || submitting} id="shipment-evidence-hash" onChange={(event) => updateCommandInput('shipment', () => setShipmentEvidenceHash(event.target.value))} pattern="0x[0-9a-fA-F]{64}" placeholder="0x + 64 位十六进制" value={shipmentEvidenceHash} /></div>
            <button className="button primary wide" disabled={!shipmentAllowed || !shipmentValid || submitting} type="submit"><Send aria-hidden="true" size={16} /> 提交发货证据</button>
            <ActionBlockReason action="RECORD_SHIPMENT" actions={allowedActions} enabled={shipmentAllowed} />
            <p className="panel-note">发货只提交幂等履约证据，不代表签收或资产结算。</p>
          </form>
          <form className="section-block compact-section" onSubmit={(event) => { event.preventDefault(); submitForcedReceipt(); }}>
            <div className="section-heading"><div><p className="eyebrow">Receipt review</p><h2>申请平台确认签收</h2></div></div>
            <p>物流确认送达满 7 天后，商家仅可提交证据申请，由平台审核。仲裁期间资产继续 Locked。</p>
            <div className="field"><label htmlFor="receipt-reason-code">申请原因代码</label><input autoComplete="off" disabled={!receiptAllowed || submitting} id="receipt-reason-code" onChange={(event) => updateCommandInput('forced-receipt', () => setReceiptReasonCode(event.target.value.toUpperCase()))} pattern="[A-Z0-9_:-]{2,64}" placeholder="平台约定的原因代码" value={receiptReasonCode} /></div>
            <div className="field"><label htmlFor="receipt-evidence-hash">签收证据哈希</label><input autoComplete="off" disabled={!receiptAllowed || submitting} id="receipt-evidence-hash" onChange={(event) => updateCommandInput('forced-receipt', () => setReceiptEvidenceHash(event.target.value))} pattern="0x[0-9a-fA-F]{64}" placeholder="0x + 64 位十六进制" value={receiptEvidenceHash} /></div>
            <button className="button secondary wide" disabled={!receiptAllowed || !receiptValid || submitting} type="submit">申请平台审核</button>
            <ActionBlockReason action="REQUEST_FORCED_RECEIPT" actions={allowedActions} enabled={receiptAllowed} />
            <p className="panel-note">本工作台没有“商家强制签收”或直接完成订单的操作。</p>
          </form>
        </div>
      ) : null}

      {selectedOrder?.fulfillmentMode === 'PICKUP' ? (
        <div className="two-panel-grid">
          <form className="section-block compact-section" onSubmit={(event) => { event.preventDefault(); submitPickup(); }}>
            <div className="section-heading"><div><p className="eyebrow">Pickup verification</p><h2>门店核销自提</h2></div><ScanLine aria-hidden="true" size={19} /></div>
            <div className="field"><label htmlFor="pickup-store-id">订单绑定门店</label><input id="pickup-store-id" readOnly value={selectedTarget?.fulfillmentMode === 'PICKUP' ? selectedTarget.storeId : '读取中'} /></div>
            <div className="field"><label htmlFor="pickup-code">六位核销码</label><input autoComplete="one-time-code" disabled={!pickupAllowed || submitting} id="pickup-code" inputMode="numeric" maxLength={6} onChange={(event) => updateCommandInput('pickup', () => setPickupCode(event.target.value))} pattern="[0-9]{6}" placeholder="000000" value={pickupCode} /></div>
            <div className="field"><label htmlFor="pickup-evidence-hash">门店核销证据哈希</label><input autoComplete="off" disabled={!pickupAllowed || submitting} id="pickup-evidence-hash" onChange={(event) => updateCommandInput('pickup', () => setPickupEvidenceHash(event.target.value))} pattern="0x[0-9a-fA-F]{64}" placeholder="0x + 64 位十六进制" value={pickupEvidenceHash} /></div>
            <button className="button primary wide" disabled={!pickupAllowed || !pickupValid || submitting} type="submit">确认门店核销</button>
            <ActionBlockReason action="VERIFY_PICKUP" actions={allowedActions} enabled={pickupAllowed} />
            <p className="panel-note">Core 绑定订单快照门店并持久化失败尝试；本页不能更换 storeId，也不能离线提交。</p>
          </form>
          <section className="section-block compact-section" aria-labelledby="pickup-print-title">
            <div className="section-heading"><div><p className="eyebrow">Two-copy receipt</p><h2 id="pickup-print-title">核销双联小票</h2></div><Printer aria-hidden="true" size={19} /></div>
            <p>核销最终确认后才可生成双联打印任务。当前打印 provider 完整契约和真实设备尚未具备。</p>
            <button className="button secondary wide" disabled type="button">检查打印设备</button>
            <p className="panel-note">Requirement MER-FUL-003：需要 Feie/Yilianyun 任务、重试与设备状态契约；当前 fail closed。</p>
          </section>
        </div>
      ) : null}

      {commandState.phase === 'submitting' ? <div className="system-notice" role="status"><RefreshCw aria-hidden="true" size={18} /><div><strong>正在提交 Core</strong><span>使用稳定幂等键等待权威响应。</span></div></div> : null}
      {commandState.phase === 'success' ? <div className="system-notice ready" role="status"><PackageCheck aria-hidden="true" size={18} /><div><strong>履约命令已确认</strong><span>{commandState.message}</span></div></div> : null}
      {commandState.phase === 'error' ? <p className="form-error" role="alert">{commandState.message}</p> : null}

      <div className="provider-strip" role="status">
        <ProviderStatus bootstrap={bootstrap} name="KUAIDI100" label="快递接口" />
        <ProviderStatus bootstrap={bootstrap} name="FEIE" label="云打印机" />
        <span><i className={`provider-dot ${ordersState.phase === 'ready' ? 'ready' : 'offline'}`} />Core 订单流：{ordersState.phase === 'ready' ? 'Connected' : 'Unavailable'}</span>
      </div>
    </div>
  );
}

function OrderRow({
  order,
  selected,
  selectionDisabled,
  target,
  onSelect,
}: {
  order: FulfillmentOrder;
  selected: boolean;
  selectionDisabled: boolean;
  target: FulfillmentTarget | undefined;
  onSelect(): void;
}) {
  const latestShipment = order.shipments.at(-1);
  const pickupStore = target?.fulfillmentMode === 'PICKUP' ? target.payload.name : '选择后读取';
  const shared = [
    <td key="order"><code className="hash-value">{order.orderId}</code></td>,
    <td key="type"><span className="state-text blocked" title="FulfillmentOrder 未发布普通/秒杀分类字段">未发布</span></td>,
    <td key="sku">{order.skuId}</td>,
    <td key="state"><span className="state-text">{order.state}</span></td>,
  ];
  return (
    <tr aria-selected={selected}>
      {shared}
      {order.fulfillmentMode === 'DELIVERY' ? (
        <>
          <td><span className={order.finalityStatus === 'FINAL' ? 'state-text success' : 'state-text blocked'}>{order.finalityStatus}</span></td>
          <td>{timestamp(order.paidAt)}</td>
          <td>{latestShipment ? <code className="hash-value">{latestShipment.trackingNumberHash}</code> : '—'}</td>
        </>
      ) : (
        <>
          <td>{pickupStore}</td>
          <td>{timestamp(order.fulfilledAt)}</td>
          <td><span className={order.finalityStatus === 'FINAL' ? 'state-text success' : 'state-text blocked'}>{order.finalityStatus}</span></td>
        </>
      )}
      <td><button aria-label={`处理订单 ${order.orderId}`} className={selected ? 'button primary' : 'button secondary'} disabled={selectionDisabled} onClick={onSelect} type="button">{selected ? '处理中' : '选择'}</button></td>
    </tr>
  );
}

function OrderSummary({ order }: { order: FulfillmentOrder }) {
  return (
    <div className="table-wrap compact-table">
      <table>
        <thead><tr><th scope="col">订单号</th><th scope="col">SKU</th><th scope="col">状态</th><th scope="col">支付最终性</th><th scope="col">付款最终确认</th><th scope="col">履约完成</th></tr></thead>
        <tbody><tr><td><code className="hash-value">{order.orderId}</code></td><td>{order.skuId}</td><td>{order.state}</td><td>{order.finalityStatus}</td><td>{timestamp(order.paymentFinalizedAt)}</td><td>{timestamp(order.fulfilledAt)}</td></tr></tbody>
      </table>
    </div>
  );
}

function TargetPanel({ state }: { state: LoadState<FulfillmentTarget> }) {
  return (
    <section className="fulfillment-detail-panel" aria-labelledby="target-title">
      <div className="section-heading"><div><p className="eyebrow">Immutable snapshot</p><h2 id="target-title">履约目标快照</h2></div></div>
      {state.phase === 'loading' ? <LoadingRows count={3} /> : null}
      {state.phase === 'error' ? <p className="form-error" role="alert">{state.message}</p> : null}
      {state.phase === 'idle' ? <p>选择订单后读取。</p> : null}
      {state.phase === 'ready' && state.value.fulfillmentMode === 'DELIVERY' ? (
        <dl className="balance-list">
          <div><dt>收货人</dt><dd>{state.value.payload.recipientName}</dd></div>
          <div><dt>电话</dt><dd>{state.value.payload.phone}</dd></div>
          <div><dt>地址</dt><dd>{state.value.payload.address}</dd></div>
          <div><dt>行政区</dt><dd>{state.value.payload.regionCode}</dd></div>
        </dl>
      ) : null}
      {state.phase === 'ready' && state.value.fulfillmentMode === 'PICKUP' ? (
        <dl className="balance-list">
          <div><dt>门店</dt><dd>{state.value.payload.name}</dd></div>
          <div><dt>Store ID</dt><dd>{state.value.storeId}</dd></div>
          <div><dt>地址</dt><dd>{state.value.payload.address}</dd></div>
          <div><dt>行政区</dt><dd>{state.value.payload.regionCode}</dd></div>
          <div><dt>状态</dt><dd>{state.value.payload.status}</dd></div>
        </dl>
      ) : null}
    </section>
  );
}

function BalancePanel({ order }: { order: FulfillmentOrder }) {
  return (
    <section className="fulfillment-detail-panel" aria-labelledby="balance-title">
      <div className="section-heading"><div><p className="eyebrow">Core balances</p><h2 id="balance-title">履约资产状态</h2></div></div>
      <div className="table-wrap compact-table">
        <table>
          <thead><tr><th scope="col">资产</th><th scope="col">状态</th><th scope="col">原子金额</th></tr></thead>
          <tbody>{order.balances.map((balance) => <tr key={`${balance.asset}:${balance.state}`}><td>{balance.asset}</td><td>{balance.state}</td><td className="numeric-cell">{balance.amount}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="panel-note">BNM 仅展示后台积分 Locked/Available，不提供 Token、Claim 或 Safe 转账。</p>
    </section>
  );
}

function AllowedActionsTable({ actions }: { actions: readonly AllowedAction[] }) {
  return (
    <div aria-live="polite" className="table-wrap compact-table">
      <table>
        <thead><tr><th scope="col">操作</th><th scope="col">Core 判定</th><th scope="col">原因</th><th scope="col">截止时间</th></tr></thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.action}>
              <td><code>{action.action}</code></td>
              <td><span className={action.enabled ? 'state-text success' : 'state-text blocked'}>{action.enabled ? '允许' : '阻断'}</span></td>
              <td>{action.reasonCode ?? '—'}</td>
              <td>{action.deadline ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionBlockReason({
  action,
  actions,
  enabled,
}: {
  action: AllowedActionName;
  actions: readonly AllowedAction[] | undefined;
  enabled: boolean;
}) {
  if (enabled) return null;
  const item = actions?.find((candidate) => candidate.action === action);
  return <p className="panel-note" role="status">Core 阻断：{item?.reasonCode ?? '当前订单状态未授权此操作'}</p>;
}

function ProviderStatus({
  bootstrap,
  name,
  label,
}: {
  bootstrap: ReturnType<typeof useCoreRuntime>['bootstrap'];
  name: string;
  label: string;
}) {
  const state = bootstrap.phase === 'ready'
    ? bootstrap.value.readiness.providers[name] ?? 'CONFIGURATION_REQUIRED'
    : 'CONFIGURATION_REQUIRED';
  return <span><i className={`provider-dot ${state === 'READY' ? 'ready' : 'warning'}`} />{label}：{state === 'READY' ? 'Ready' : 'ConfigurationRequired'}</span>;
}

function timestamp(value: string | null) {
  return value ? <time dateTime={value}>{value}</time> : '—';
}

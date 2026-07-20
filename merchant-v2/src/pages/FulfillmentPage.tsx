import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  logisticsCarrierCodes,
  orderProjectionStates,
  type AllowedAction,
  type AllowedActionName,
  type FulfillmentOrder,
  type FulfillmentOrderCursor,
  type FulfillmentOrderPage,
  type FulfillmentTarget,
  type MerchantOrderExport,
  type MerchantOrderExportRequest,
  type OrderKind,
  type OrderProjectionState,
} from '@abu24k/core-artifacts';
import {
  Box,
  Download,
  ListFilter,
  PackageCheck,
  RefreshCw,
  ScanLine,
  Send,
} from 'lucide-react';
import { EmptyState, LoadingRows, PageHeader } from '../components/ui';
import { PickupCodeScanner } from '../components/PickupCodeScanner';
import { canExecuteOrderAction } from '../core-boundary';
import { CoreApiError } from '../core-api';
import { readableError, useCoreRuntime } from '../core-runtime';
import { useSearchParams } from 'react-router-dom';

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

type ExportState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

type FilterDraft = Readonly<{
  from: string;
  to: string;
  skuId: string;
  state: '' | OrderProjectionState;
  orderKind: '' | OrderKind;
}>;

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;
const pickupCodePattern = /^[0-9]{6}$/;
const orderKinds = ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] satisfies readonly OrderKind[];
const emptyFilters: FilterDraft = { from: '', to: '', skuId: '', state: '', orderKind: '' };
const deliveryColumns = ['订单号', '订单类型', 'SKU', '数量', '订单状态', '支付 TxHash', '下单时间', '支付最终性', '运单号', '操作'];
const pickupColumns = ['订单号', '订单类型', 'SKU', '数量', '订单状态', '支付 TxHash', '下单时间', '核销门店', '完成时间', '支付最终性', '操作'];

export function FulfillmentPage() {
  const { api, session } = useCoreRuntime();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'delivery' | 'pickup'>(() => (
    searchParams.get('mode') === 'pickup' ? 'pickup' : 'delivery'
  ));
  const [ordersState, setOrdersState] = useState<LoadState<FulfillmentOrderPage>>({ phase: 'idle' });
  const [selectedOrderId, setSelectedOrderId] = useState<string>();
  const [targetState, setTargetState] = useState<LoadState<FulfillmentTarget>>({ phase: 'idle' });
  const [commandState, setCommandState] = useState<CommandState>({ phase: 'idle' });
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(emptyFilters);
  const [activeFilters, setActiveFilters] = useState<FilterDraft>(emptyFilters);
  const [cursorHistory, setCursorHistory] = useState<readonly (FulfillmentOrderCursor | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [carrierCode, setCarrierCode] = useState<(typeof logisticsCarrierCodes)[number]>('SF');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipmentNote, setShipmentNote] = useState('');
  const [receiptReasonCode, setReceiptReasonCode] = useState('');
  const [pickupCode, setPickupCode] = useState('');
  const [pickupEvidenceHash, setPickupEvidenceHash] = useState('');
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const commandKeys = useRef<Partial<Record<CommandKind, string>>>({});
  const exportAttempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
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
      const value = await api.listFulfillmentOrders(token, {
        limit: 100,
        fulfillmentMode: tab === 'delivery' ? 'DELIVERY' : 'PICKUP',
        ...(cursorHistory[pageIndex] ? { cursor: cursorHistory[pageIndex] } : {}),
        ...(activeFilters.from ? { from: localDateTimeToIso(activeFilters.from) } : {}),
        ...(activeFilters.to ? { to: localDateTimeToIso(activeFilters.to) } : {}),
        ...(activeFilters.skuId ? { skuId: activeFilters.skuId } : {}),
        ...(activeFilters.state ? { state: activeFilters.state } : {}),
        ...(activeFilters.orderKind ? { orderKind: activeFilters.orderKind } : {}),
      });
      if (sessionTokenRef.current === token) setOrdersState({ phase: 'ready', value });
    } catch (error) {
      if (sessionTokenRef.current === token) {
        setOrdersState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [activeFilters, api, cursorHistory, pageIndex, session, tab]);

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
    void loadTarget();
  }, [loadTarget]);

  const orders = ordersState.phase === 'ready' ? ordersState.value.orders : [];
  const selectedOrder = orders.find((order) => order.orderId === selectedOrderId);
  const allowedActions = selectedOrder?.allowedActions;
  const selectedTarget = targetState.phase === 'ready' ? targetState.value : undefined;
  const targetMatchesOrder = Boolean(
    selectedOrder && selectedTarget && selectedOrder.fulfillmentMode === selectedTarget.fulfillmentMode,
  );
  const visibleOrders = useMemo(
    () => orders.filter((order) => order.fulfillmentMode === (tab === 'delivery' ? 'DELIVERY' : 'PICKUP')),
    [orders, tab],
  );
  const columns = tab === 'delivery' ? deliveryColumns : pickupColumns;
  const submitting = commandState.phase === 'submitting';
  const canExecute = (action: AllowedActionName) => (
    Boolean(session && selectedOrder && targetMatchesOrder)
    && canExecuteOrderAction(action, allowedActions)
  );
  const shipmentAllowed = selectedOrder?.fulfillmentMode === 'DELIVERY' && canExecute('RECORD_SHIPMENT');
  const receiptAllowed = selectedOrder?.fulfillmentMode === 'DELIVERY' && canExecute('REQUEST_FORCED_RECEIPT');
  const pickupAllowed = selectedOrder?.fulfillmentMode === 'PICKUP' && canExecute('VERIFY_PICKUP');
  const shipmentValid = logisticsCarrierCodes.includes(carrierCode)
    && /^[A-Za-z0-9\s-]{6,64}$/.test(trackingNumber.trim())
    && shipmentNote.trim().length <= 500;
  const receiptValid = reasonCodePattern.test(receiptReasonCode);
  const pickupValid = pickupCodePattern.test(pickupCode)
    && bytes32Pattern.test(pickupEvidenceHash)
    && selectedTarget?.fulfillmentMode === 'PICKUP';

  function selectOrder(order: FulfillmentOrder) {
    selectedOrderRef.current = order.orderId;
    setSelectedOrderId(order.orderId);
    setTargetState({ phase: 'loading' });
    setTab(order.fulfillmentMode === 'DELIVERY' ? 'delivery' : 'pickup');
    setCommandState({ phase: 'idle' });
    commandKeys.current = {};
    setCarrierCode('SF');
    setTrackingNumber('');
    setShipmentNote('');
    setReceiptReasonCode('');
    setPickupCode('');
    setPickupEvidenceHash('');
  }

  function resetOrderContext() {
    selectedOrderRef.current = undefined;
    setSelectedOrderId(undefined);
    setTargetState({ phase: 'idle' });
  }

  function changeTab(next: 'delivery' | 'pickup') {
    if (next === tab) return;
    setTab(next);
    setCursorHistory([undefined]);
    setPageIndex(0);
    setExportState({ phase: 'idle' });
    resetOrderContext();
  }

  function applyFilters() {
    if (filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to) return;
    setActiveFilters(filterDraft);
    setCursorHistory([undefined]);
    setPageIndex(0);
    setExportState({ phase: 'idle' });
    resetOrderContext();
  }

  function resetFilters() {
    setFilterDraft(emptyFilters);
    setActiveFilters(emptyFilters);
    setCursorHistory([undefined]);
    setPageIndex(0);
    setExportState({ phase: 'idle' });
    resetOrderContext();
  }

  function goToPreviousPage() {
    if (pageIndex === 0) return;
    setPageIndex((current) => current - 1);
    setExportState({ phase: 'idle' });
    resetOrderContext();
  }

  function goToNextPage() {
    if (ordersState.phase !== 'ready' || !ordersState.value.nextCursor) return;
    const nextCursor = ordersState.value.nextCursor;
    setCursorHistory((history) => [
      ...history.slice(0, pageIndex + 1),
      nextCursor,
    ]);
    setPageIndex((current) => current + 1);
    setExportState({ phase: 'idle' });
    resetOrderContext();
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
    if (!session) return;
    setCommandState({ phase: 'submitting', kind });
    try {
      const message = await operation(idempotencyKey(kind));
      delete commandKeys.current[kind];
      setCommandState({ phase: 'success', message });
      void loadOrders(true);
      void loadTarget(true);
    } catch (error) {
      setCommandState({ phase: 'error', message: readableError(error) });
    }
  }

  function submitShipment() {
    if (!session || !selectedOrder || !shipmentAllowed || !shipmentValid) return;
    void runCommand('shipment', async (key) => {
      const evidence = await api.createOrderTrackingEvidence(selectedOrder.orderId, {
        carrierCode,
        trackingNumber: trackingNumber.trim(),
        note: shipmentNote.trim() || null,
        idempotencyKey: `${key}-evidence`,
      }, session.token);
      if (!evidence.trackingNumberHash) throw new CoreApiError('InvalidResponse', '发货证据缺少运单标识。');
      const result = await api.recordShipment(selectedOrder.orderId, {
        idempotencyKey: key,
        evidenceHash: evidence.evidenceHash,
        carrierCode,
        trackingNumberHash: evidence.trackingNumberHash,
      }, session.token);
      setTrackingNumber('');
      setShipmentNote('');
      return `发货证据已记录：${result.shipmentId}`;
    });
  }

  function submitForcedReceipt() {
    if (!session || !selectedOrder || !receiptAllowed || !receiptValid) return;
    void runCommand('forced-receipt', async (key) => {
      const evidence = await api.createOrderActionEvidence(selectedOrder.orderId, {
        action: 'REQUEST_FORCED_RECEIPT',
        reasonCode: receiptReasonCode,
        idempotencyKey: `${key}-evidence`,
      }, session.token);
      const result = await api.requestForcedReceipt(selectedOrder.orderId, {
        idempotencyKey: key,
        evidenceHash: evidence.evidenceHash,
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

  async function exportOrders() {
    if (!session || ordersState.phase !== 'ready' || exportState.phase === 'submitting') return;
    let input: Omit<MerchantOrderExportRequest, 'idempotencyKey'>;
    try {
      input = merchantOrderExportInput(activeFilters, tab, cursorHistory[pageIndex]);
    } catch (error) {
      setExportState({ phase: 'error', message: readableError(error) });
      return;
    }
    const fingerprint = JSON.stringify(input);
    if (exportAttempt.current?.fingerprint !== fingerprint) {
      exportAttempt.current = {
        fingerprint,
        key: `merchant-order-export-${commandNonce()}`,
      };
    }
    setExportState({ phase: 'submitting' });
    try {
      const result = await api.exportMerchantOrders({
        ...input,
        idempotencyKey: exportAttempt.current.key,
      }, session.token);
      assertMerchantOrderExportScope(result, input, session.merchantId);
      if (result.rowCount === 0) {
        setExportState({ phase: 'success', message: '当前筛选与页游标下没有可导出的订单。' });
      } else {
        await downloadMerchantOrderExport(result);
        setExportState({ phase: 'success', message: `已下载 ${result.rowCount} 笔 Core 授权订单。` });
      }
      exportAttempt.current = undefined;
    } catch (error) {
      setExportState({ phase: 'error', message: exportErrorMessage(error) });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <div className="button-group">
            <button className="button secondary" disabled={!session || ordersState.phase !== 'ready' || exportState.phase === 'submitting'} onClick={() => void exportOrders()} type="button"><Download aria-hidden="true" size={16} /> {exportState.phase === 'submitting' ? '正在导出' : '导出 Excel'}</button>
            <button className="button primary" disabled={!session || ordersState.phase === 'loading'} onClick={() => void loadOrders()} type="button"><RefreshCw aria-hidden="true" size={16} /> 刷新订单</button>
          </div>
        )}
        description="秒杀与常规订单统一履约。商家不能改价、退款或直接完成签收。"
        eyebrow="03 / 订单与发货"
        title="履约交付"
      />

      <section className="section-block fulfillment-workspace" aria-labelledby="orders-title">
        <div className="tabs" role="group" aria-label="履约方式">
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'delivery'} className={tab === 'delivery' ? 'active' : undefined} id="delivery-tab" onClick={() => changeTab('delivery')} type="button"><Box aria-hidden="true" size={17} /> 快递邮寄</button>
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'pickup'} className={tab === 'pickup' ? 'active' : undefined} id="pickup-tab" onClick={() => changeTab('pickup')} type="button"><ScanLine aria-hidden="true" size={17} /> 到店自提</button>
        </div>
        <div className="section-heading"><div><p className="eyebrow">Merchant-scoped orders</p><h2 id="orders-title">商家履约订单</h2></div><span>{ordersState.phase === 'ready' ? `${visibleOrders.length} 笔` : '实时 Core 读取'}</span></div>
        <p className="section-intro">筛选、订单分类、数量、支付 TxHash、下单时间和可执行动作均来自 Core `.5`。浏览器只提交筛选条件，不重算或补写订单字段。</p>
        {exportState.phase === 'success' ? <p className="form-success export-feedback" role="status">{exportState.message}</p> : null}
        {exportState.phase === 'error' ? <p className="form-error export-feedback" role="alert">{exportState.message}</p> : null}
        <form className="filter-bar" aria-label="订单筛选" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <label><span>开始时间</span><input aria-label="开始时间" disabled={!session} onChange={(event) => setFilterDraft((value) => ({ ...value, from: event.target.value }))} type="datetime-local" value={filterDraft.from} /></label>
          <label><span>结束时间</span><input aria-label="结束时间" disabled={!session} onChange={(event) => setFilterDraft((value) => ({ ...value, to: event.target.value }))} type="datetime-local" value={filterDraft.to} /></label>
          <label><span>SKU</span><input aria-label="SKU 筛选" disabled={!session} onChange={(event) => setFilterDraft((value) => ({ ...value, skuId: event.target.value }))} placeholder="精确 SKU ID" type="text" value={filterDraft.skuId} /></label>
          <label><span>订单状态</span><select aria-label="订单状态" disabled={!session} onChange={(event) => setFilterDraft((value) => ({ ...value, state: event.target.value as FilterDraft['state'] }))} value={filterDraft.state}><option value="">全部状态</option>{orderProjectionStates.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <label><span>订单类型</span><select aria-label="订单类型" disabled={!session} onChange={(event) => setFilterDraft((value) => ({ ...value, orderKind: event.target.value as FilterDraft['orderKind'] }))} value={filterDraft.orderKind}><option value="">全部类型</option>{orderKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <div className="filter-actions"><button className="button primary" disabled={!session || (Boolean(filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to))} type="submit"><ListFilter aria-hidden="true" size={16} /> 应用筛选</button><button className="button secondary" disabled={!session} onClick={resetFilters} type="button">重置</button></div>
        </form>
        {filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to ? <p className="form-error filter-error" role="alert">开始时间不能晚于结束时间。</p> : null}
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
        <div className="selection-bar">
          <span>第 {pageIndex + 1} 页 · 选择单笔订单处理履约</span>
          <div className="button-group"><button className="button secondary" disabled={pageIndex === 0 || ordersState.phase === 'loading'} onClick={goToPreviousPage} type="button">上一页</button><button className="button secondary" disabled={ordersState.phase !== 'ready' || !ordersState.value.nextCursor} onClick={goToNextPage} type="button">下一页</button></div>
        </div>
        <p className="panel-note">Excel 由 Core 在商家租户范围内解密 PII、审计并生成；首发发货仅使用单订单手工履约。</p>
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
            <AllowedActionsTable actions={selectedOrder.allowedActions} />
          </>
        )}
      </section>

      {selectedOrder?.fulfillmentMode === 'DELIVERY' ? (
        <div>
          <form className="section-block compact-section" onSubmit={(event) => { event.preventDefault(); submitShipment(); }}>
            <div className="section-heading"><div><p className="eyebrow">Shipment evidence</p><h2>提交发货证据</h2></div><PackageCheck aria-hidden="true" size={19} /></div>
            <div className="field"><label htmlFor="carrier-code">快递公司</label><select disabled={!shipmentAllowed || submitting} id="carrier-code" onChange={(event) => updateCommandInput('shipment', () => setCarrierCode(event.target.value as (typeof logisticsCarrierCodes)[number]))} value={carrierCode}>{logisticsCarrierCodes.map((code) => <option key={code} value={code}>{carrierLabel(code)}</option>)}</select></div>
            <div className="field"><label htmlFor="tracking-number">运单号</label><input autoComplete="off" disabled={!shipmentAllowed || submitting} id="tracking-number" maxLength={64} onChange={(event) => updateCommandInput('shipment', () => setTrackingNumber(event.target.value))} placeholder="输入快递单上的运单号" value={trackingNumber} /><span className="field-help">原始运单号由 Core 加密保存，页面不计算哈希。</span></div>
            <div className="field"><label htmlFor="shipment-note">发货备注 / 凭证说明</label><textarea disabled={!shipmentAllowed || submitting} id="shipment-note" maxLength={500} onChange={(event) => updateCommandInput('shipment', () => setShipmentNote(event.target.value))} placeholder="可选：包裹数量、交接情况或其他发货凭证说明" value={shipmentNote} /></div>
            <button className="button primary wide" disabled={!shipmentAllowed || !shipmentValid || submitting} type="submit"><Send aria-hidden="true" size={16} /> 提交发货证据</button>
            <ActionBlockReason action="RECORD_SHIPMENT" actions={allowedActions} enabled={shipmentAllowed} />
            <p className="panel-note">发货只提交幂等履约证据，不代表签收或资产结算。</p>
          </form>
          <form className="section-block compact-section" onSubmit={(event) => { event.preventDefault(); submitForcedReceipt(); }}>
            <div className="section-heading"><div><p className="eyebrow">Receipt review</p><h2>申请平台确认签收</h2></div></div>
            <p>物流确认送达满 7 天后，商家仅可提交证据申请，由平台审核。仲裁期间资产继续 Locked。</p>
            <div className="field"><label htmlFor="receipt-reason-code">申请原因代码</label><input autoComplete="off" disabled={!receiptAllowed || submitting} id="receipt-reason-code" onChange={(event) => updateCommandInput('forced-receipt', () => setReceiptReasonCode(event.target.value.toUpperCase()))} pattern="[A-Z0-9_:-]{2,64}" placeholder="平台约定的原因代码" value={receiptReasonCode} /></div>
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
            <PickupCodeScanner key={selectedOrder.orderId} disabled={!pickupAllowed || submitting} onCode={(code) => updateCommandInput('pickup', () => setPickupCode(code))} />
            <div className="field"><label htmlFor="pickup-code">六位核销码</label><input autoComplete="one-time-code" disabled={!pickupAllowed || submitting} id="pickup-code" inputMode="numeric" maxLength={6} onChange={(event) => updateCommandInput('pickup', () => setPickupCode(event.target.value.replace(/[^0-9]/g, '')))} pattern="[0-9]{6}" placeholder="000000" value={pickupCode} /><span className="field-help">相机不可用或权限被拒绝时，可直接手工输入。</span></div>
            <div className="field"><label htmlFor="pickup-evidence-hash">门店核销证据哈希</label><input autoComplete="off" disabled={!pickupAllowed || submitting} id="pickup-evidence-hash" onChange={(event) => updateCommandInput('pickup', () => setPickupEvidenceHash(event.target.value))} pattern="0x[0-9a-fA-F]{64}" placeholder="0x + 64 位十六进制" value={pickupEvidenceHash} /></div>
            <button className="button primary wide" disabled={!pickupAllowed || !pickupValid || submitting} type="submit">确认门店核销</button>
            <ActionBlockReason action="VERIFY_PICKUP" actions={allowedActions} enabled={pickupAllowed} />
            <p className="panel-note">Core 绑定订单快照门店并持久化失败尝试；本页不能更换 storeId，也不能离线提交。</p>
          </form>
        </div>
      ) : null}

      {commandState.phase === 'submitting' ? <div className="system-notice" role="status"><RefreshCw aria-hidden="true" size={18} /><div><strong>正在提交 Core</strong><span>使用稳定幂等键等待权威响应。</span></div></div> : null}
      {commandState.phase === 'success' ? <div className="system-notice ready" role="status"><PackageCheck aria-hidden="true" size={18} /><div><strong>履约命令已确认</strong><span>{commandState.message}</span></div></div> : null}
      {commandState.phase === 'error' ? <p className="form-error" role="alert">{commandState.message}</p> : null}

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
    <td key="type"><span className="state-text">{order.orderKind}</span></td>,
    <td key="sku">{order.skuId}</td>,
    <td className="numeric-cell" key="quantity">{order.quantity}</td>,
    <td key="state"><span className="state-text">{order.state}</span></td>,
    <td key="tx">{order.paymentTxHash ? <code className="hash-value">{order.paymentTxHash}</code> : '—'}</td>,
    <td key="created">{timestamp(order.createdAt)}</td>,
  ];
  return (
    <tr aria-selected={selected}>
      {shared}
      {order.fulfillmentMode === 'DELIVERY' ? (
        <>
          <td><span className={order.finalityStatus === 'FINAL' ? 'state-text success' : 'state-text blocked'}>{order.finalityStatus}</span></td>
          <td>{latestShipment?.trackingNumber ?? '—'}</td>
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
        <thead><tr><th scope="col">订单号</th><th scope="col">类型</th><th scope="col">SKU</th><th scope="col">数量</th><th scope="col">支付 TxHash</th><th scope="col">状态</th><th scope="col">支付最终性</th><th scope="col">付款最终确认</th><th scope="col">履约完成</th></tr></thead>
        <tbody><tr><td><code className="hash-value">{order.orderId}</code></td><td>{order.orderKind}</td><td>{order.skuId}</td><td>{order.quantity}</td><td>{order.paymentTxHash ? <code className="hash-value">{order.paymentTxHash}</code> : '—'}</td><td>{order.state}</td><td>{order.finalityStatus}</td><td>{timestamp(order.paymentFinalizedAt)}</td><td>{timestamp(order.fulfilledAt)}</td></tr></tbody>
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
      <p className="panel-note">BNM 仅展示后台积分 Locked/Available，不提供 Token、Claim 或钱包转账。</p>
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

function timestamp(value: string | null) {
  return value ? <time dateTime={value}>{value}</time> : '—';
}

function carrierLabel(code: (typeof logisticsCarrierCodes)[number]) {
  return ({ SF: '顺丰', JD: '京东物流', YTO: '圆通', ZTO: '中通', STO: '申通', EMS: 'EMS' } as const)[code];
}

function localDateTimeToIso(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('筛选时间无效。');
  return parsed.toISOString();
}

function commandNonce() {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return random;
}

function merchantOrderExportInput(
  filters: FilterDraft,
  tab: 'delivery' | 'pickup',
  cursor?: FulfillmentOrderCursor,
): Omit<MerchantOrderExportRequest, 'idempotencyKey'> {
  if (Boolean(filters.from) !== Boolean(filters.to)) {
    throw new Error('订单导出必须同时选择开始和结束时间。');
  }
  const from = filters.from ? localDateTimeToIso(filters.from) : undefined;
  const to = filters.to ? localDateTimeToIso(filters.to) : undefined;
  if (from && to) {
    if (Date.parse(from) > Date.parse(to)) throw new Error('开始时间不能晚于结束时间。');
    if (Date.parse(to) - Date.parse(from) > 31 * 24 * 60 * 60 * 1_000) {
      throw new Error('订单导出时间范围不能超过 31 天。');
    }
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(filters.skuId.trim() ? { skuId: filters.skuId.trim() } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    fulfillmentMode: tab === 'delivery' ? 'DELIVERY' : 'PICKUP',
    ...(filters.orderKind ? { orderKind: filters.orderKind } : {}),
    ...(cursor ? { cursorCreatedAt: cursor.createdAt, cursorOrderId: cursor.orderId } : {}),
    limit: 1_000,
  };
}

function assertMerchantOrderExportScope(
  result: MerchantOrderExport,
  input: Omit<MerchantOrderExportRequest, 'idempotencyKey'>,
  merchantId: string,
) {
  if (result.merchantId !== merchantId) {
    throw new CoreApiError('InvalidResponse', '订单导出与当前商家会话不一致。');
  }
  const expected = {
    skuId: input.skuId ?? null,
    state: input.state ?? null,
    fulfillmentMode: input.fulfillmentMode ?? null,
    orderKind: input.orderKind ?? null,
    cursorCreatedAt: input.cursorCreatedAt ?? null,
    cursorOrderId: input.cursorOrderId ?? null,
    limit: input.limit ?? 1_000,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (result.filters[key as keyof typeof expected] !== value) {
      throw new CoreApiError('InvalidResponse', '订单导出筛选快照与当前列表不一致。');
    }
  }
  if ((input.from && result.filters.from !== input.from) || (input.to && result.filters.to !== input.to)) {
    throw new CoreApiError('InvalidResponse', '订单导出时间范围与当前列表不一致。');
  }
}

async function downloadMerchantOrderExport(result: MerchantOrderExport) {
  let binary: string;
  try {
    binary = globalThis.atob(result.contentBase64);
  } catch {
    throw new CoreApiError('InvalidResponse', '订单导出内容不是有效 Base64。');
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const contentHash = `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (contentHash.toLowerCase() !== result.contentHash.toLowerCase()) {
    throw new CoreApiError('InvalidResponse', '订单导出内容哈希校验失败。');
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: result.contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportErrorMessage(error: unknown) {
  if (error instanceof CoreApiError && error.status === 403) {
    return `导出权限被拒绝（403）：${error.message}`;
  }
  if (error instanceof CoreApiError && error.status === 409) {
    return `导出状态已变化（409）：${error.message}`;
  }
  return readableError(error);
}

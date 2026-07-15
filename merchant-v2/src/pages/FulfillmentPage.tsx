import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  orderProjectionStates,
  type AllowedAction,
  type AllowedActionName,
  type FulfillmentOrder,
  type FulfillmentOrderCursor,
  type FulfillmentOrderPage,
  type FulfillmentTarget,
  type MerchantStore,
  type OrderKind,
  type OrderProjectionState,
  type PrintJob,
  type ShipmentBatchItemRequest,
  type WaybillBatchRequest,
  type WaybillBatchResult,
  type WaybillProvider,
  waybillProviders,
} from '@abu24k/core-artifacts';
import {
  Box,
  Download,
  ListFilter,
  PackageCheck,
  Printer,
  RefreshCw,
  ScanLine,
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

type CommandKind = 'shipment' | 'batch-shipment' | 'forced-receipt' | 'pickup';
type CommandState =
  | { phase: 'idle' }
  | { phase: 'submitting'; kind: CommandKind }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

type WaybillCommandState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'ready'; value: WaybillBatchResult }
  | { phase: 'error'; message: string };

type BatchCarrierCode = ShipmentBatchItemRequest['carrierCode'];
type WaybillCarrierCode = WaybillBatchRequest['carrierCode'];
type BatchItemDraft = Readonly<{
  carrierCode: BatchCarrierCode;
  trackingNumberHash: string;
  evidenceHash: string;
}>;

type FilterDraft = Readonly<{
  from: string;
  to: string;
  skuId: string;
  state: '' | OrderProjectionState;
  orderKind: '' | OrderKind;
}>;

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const carrierPattern = /^[A-Z0-9_-]{2,32}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;
const pickupCodePattern = /^[0-9]{6}$/;
const orderKinds = ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] satisfies readonly OrderKind[];
const batchCarrierCodes = ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] satisfies readonly BatchCarrierCode[];
const emptyFilters: FilterDraft = { from: '', to: '', skuId: '', state: '', orderKind: '' };
const deliveryColumns = ['选择', '订单号', '订单类型', 'SKU', '数量', '订单状态', '支付 TxHash', '下单时间', '支付最终性', '物流单号哈希', '操作'];
const pickupColumns = ['订单号', '订单类型', 'SKU', '数量', '订单状态', '支付 TxHash', '下单时间', '核销门店', '完成时间', '支付最终性', '操作'];

export function FulfillmentPage() {
  const { api, bootstrap, session } = useCoreRuntime();
  const [tab, setTab] = useState<'delivery' | 'pickup'>('delivery');
  const [ordersState, setOrdersState] = useState<LoadState<FulfillmentOrderPage>>({ phase: 'idle' });
  const [selectedOrderId, setSelectedOrderId] = useState<string>();
  const [targetState, setTargetState] = useState<LoadState<FulfillmentTarget>>({ phase: 'idle' });
  const [commandState, setCommandState] = useState<CommandState>({ phase: 'idle' });
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(emptyFilters);
  const [activeFilters, setActiveFilters] = useState<FilterDraft>(emptyFilters);
  const [cursorHistory, setCursorHistory] = useState<readonly (FulfillmentOrderCursor | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [batchSelection, setBatchSelection] = useState<readonly string[]>([]);
  const [batchItems, setBatchItems] = useState<Readonly<Record<string, BatchItemDraft>>>({});
  const [storesState, setStoresState] = useState<LoadState<readonly MerchantStore[]>>({ phase: 'idle' });
  const [waybillProvider, setWaybillProvider] = useState<WaybillProvider>('KUAIDI100');
  const [waybillCarrierCode, setWaybillCarrierCode] = useState<WaybillCarrierCode>('SF');
  const [waybillStoreId, setWaybillStoreId] = useState('');
  const [waybillState, setWaybillState] = useState<WaybillCommandState>({ phase: 'idle' });
  const [printJobsState, setPrintJobsState] = useState<LoadState<readonly PrintJob[]>>({ phase: 'idle' });
  const [retryingPrintJobId, setRetryingPrintJobId] = useState<string>();
  const [printRetryError, setPrintRetryError] = useState<string>();
  const [carrierCode, setCarrierCode] = useState('');
  const [trackingNumberHash, setTrackingNumberHash] = useState('');
  const [shipmentEvidenceHash, setShipmentEvidenceHash] = useState('');
  const [receiptEvidenceHash, setReceiptEvidenceHash] = useState('');
  const [receiptReasonCode, setReceiptReasonCode] = useState('');
  const [pickupCode, setPickupCode] = useState('');
  const [pickupEvidenceHash, setPickupEvidenceHash] = useState('');
  const commandKeys = useRef<Partial<Record<CommandKind, string>>>({});
  const batchItemKeys = useRef<Record<string, string>>({});
  const waybillAttempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const printRetryKeys = useRef<Record<string, string>>({});
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

  const loadStores = useCallback(async () => {
    if (!session) {
      setStoresState({ phase: 'idle' });
      setWaybillStoreId('');
      return;
    }
    const token = session.token;
    setStoresState({ phase: 'loading' });
    try {
      const stores = (await api.listMerchantStores()).filter((store) => store.merchantId === session.merchantId);
      if (sessionTokenRef.current !== token) return;
      setStoresState({ phase: 'ready', value: stores });
      setWaybillStoreId((current) => stores.some((store) => store.storeId === current)
        ? current
        : stores[0]?.storeId ?? '');
    } catch (error) {
      if (sessionTokenRef.current === token) setStoresState({ phase: 'error', message: readableError(error) });
    }
  }, [api, session]);

  const loadPrintJobs = useCallback(async (quiet = false) => {
    if (!session) {
      setPrintJobsState({ phase: 'idle' });
      return;
    }
    const token = session.token;
    if (!quiet) setPrintJobsState({ phase: 'loading' });
    try {
      const jobs = await api.listMerchantPrintJobs(token, 100);
      if (sessionTokenRef.current === token) setPrintJobsState({ phase: 'ready', value: jobs });
    } catch (error) {
      if (sessionTokenRef.current === token) {
        setPrintJobsState({ phase: 'error', message: readableError(error) });
      }
    }
  }, [api, session]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    void loadTarget();
  }, [loadTarget]);

  useEffect(() => {
    void loadStores();
    void loadPrintJobs();
  }, [loadPrintJobs, loadStores]);

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
  const waybillSubmitting = waybillState.phase === 'submitting';
  const operationPending = submitting || waybillSubmitting || Boolean(retryingPrintJobId);
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
  const selectedBatchOrders = batchSelection
    .map((orderId) => orders.find((order) => order.orderId === orderId))
    .filter((order): order is FulfillmentOrder => Boolean(order));
  const batchValid = selectedBatchOrders.length > 0
    && selectedBatchOrders.length <= 100
    && selectedBatchOrders.every((order) => {
      const draft = batchItems[order.orderId];
      return draft !== undefined
        && batchCarrierCodes.includes(draft.carrierCode)
        && bytes32Pattern.test(draft.trackingNumberHash)
        && bytes32Pattern.test(draft.evidenceHash)
        && canExecuteOrderAction('RECORD_SHIPMENT', order.allowedActions);
    });
  const merchantStores = storesState.phase === 'ready' ? storesState.value : [];
  const waybillStore = merchantStores.find((store) => store.storeId === waybillStoreId);
  const waybillProviderReadiness = bootstrap.phase === 'ready'
    ? bootstrap.value.readiness.providers[waybillProvider]
    : undefined;
  const waybillProviderReady = waybillProviderReadiness === 'READY';
  const waybillValid = Boolean(
    session
    && waybillStore
    && waybillStore.merchantId === session.merchantId
    && waybillProviderReady
    && selectedBatchOrders.length > 0
    && selectedBatchOrders.length <= 100
    && selectedBatchOrders.every((order) => (
      order.fulfillmentMode === 'DELIVERY'
      && canExecuteOrderAction('RECORD_SHIPMENT', order.allowedActions)
    )),
  );
  const printJobs = printJobsState.phase === 'ready' ? printJobsState.value : [];
  const selectedPickupJob = selectedOrder?.fulfillmentMode === 'PICKUP'
    ? printJobs.find((job) => job.orderId === selectedOrder.orderId && job.jobKind === 'PICKUP_RECEIPT')
    : undefined;

  function selectOrder(order: FulfillmentOrder) {
    selectedOrderRef.current = order.orderId;
    setSelectedOrderId(order.orderId);
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

  function resetOrderContext() {
    selectedOrderRef.current = undefined;
    setSelectedOrderId(undefined);
    setTargetState({ phase: 'idle' });
    setBatchSelection([]);
    setBatchItems({});
    delete commandKeys.current['batch-shipment'];
    batchItemKeys.current = {};
    resetWaybillAttempt();
  }

  function changeTab(next: 'delivery' | 'pickup') {
    if (next === tab) return;
    setTab(next);
    setCursorHistory([undefined]);
    setPageIndex(0);
    resetOrderContext();
  }

  function applyFilters() {
    if (filterDraft.from && filterDraft.to && filterDraft.from > filterDraft.to) return;
    setActiveFilters(filterDraft);
    setCursorHistory([undefined]);
    setPageIndex(0);
    resetOrderContext();
  }

  function resetFilters() {
    setFilterDraft(emptyFilters);
    setActiveFilters(emptyFilters);
    setCursorHistory([undefined]);
    setPageIndex(0);
    resetOrderContext();
  }

  function goToPreviousPage() {
    if (pageIndex === 0) return;
    setPageIndex((current) => current - 1);
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
    resetOrderContext();
  }

  function toggleBatchOrder(order: FulfillmentOrder) {
    if (!canExecuteOrderAction('RECORD_SHIPMENT', order.allowedActions)) return;
    setBatchSelection((selection) => (
      selection.includes(order.orderId)
        ? selection.filter((orderId) => orderId !== order.orderId)
        : [...selection, order.orderId]
    ));
    setBatchItems((items) => {
      if (batchSelection.includes(order.orderId)) {
        const remaining = { ...items };
        delete remaining[order.orderId];
        return remaining;
      }
      return {
        ...items,
        [order.orderId]: { carrierCode: 'SF', trackingNumberHash: '', evidenceHash: '' },
      };
    });
    delete commandKeys.current['batch-shipment'];
    delete batchItemKeys.current[order.orderId];
    resetWaybillAttempt();
    setCommandState({ phase: 'idle' });
  }

  function resetWaybillAttempt() {
    waybillAttempt.current = undefined;
    setWaybillState({ phase: 'idle' });
  }

  function updateWaybillInput(update: () => void) {
    resetWaybillAttempt();
    update();
  }

  function updateBatchItem(orderId: string, patch: Partial<BatchItemDraft>) {
    setBatchItems((items) => ({ ...items, [orderId]: { ...items[orderId]!, ...patch } }));
    delete commandKeys.current['batch-shipment'];
    delete batchItemKeys.current[orderId];
    setCommandState({ phase: 'idle' });
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
      if (kind === 'batch-shipment') batchItemKeys.current = {};
      setCommandState({ phase: 'success', message });
      void loadOrders(true);
      void loadTarget(true);
      void loadPrintJobs(true);
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

  function submitShipmentBatch() {
    if (!session || !batchValid) return;
    void runCommand('batch-shipment', async (key) => {
      const result = await api.recordShipmentBatch({
        idempotencyKey: key,
        items: selectedBatchOrders.map((order) => {
          const draft = batchItems[order.orderId]!;
          const itemKey = batchItemKeys.current[order.orderId]
            ?? idempotencyKeyForOrder('shipment-item', order.orderId);
          batchItemKeys.current[order.orderId] = itemKey;
          return { orderId: order.orderId, idempotencyKey: itemKey, ...draft };
        }),
      }, session.token);
      setBatchSelection([]);
      setBatchItems({});
      return `批量发货已原子确认：${result.batchId} / ${result.shipments.length} 笔`;
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

  async function submitWaybillBatch() {
    if (!session || !waybillStore || !waybillValid || waybillSubmitting) return;
    const orderIds = selectedBatchOrders.map((order) => order.orderId);
    const fingerprint = [waybillProvider, waybillCarrierCode, waybillStore.storeId, ...orderIds].join(':');
    const attempt = waybillAttempt.current?.fingerprint === fingerprint
      ? waybillAttempt.current
      : { fingerprint, key: idempotencyKeyForOrder('waybill-batch', orderIds.join('-')) };
    waybillAttempt.current = attempt;
    setWaybillState({ phase: 'submitting' });
    try {
      const result = await api.createMerchantWaybillBatch({
        provider: waybillProvider,
        carrierCode: waybillCarrierCode,
        storeId: waybillStore.storeId,
        orderIds,
        idempotencyKey: attempt.key,
      }, session.token);
      setWaybillState({ phase: 'ready', value: result });
      void loadOrders(true);
      void loadPrintJobs(true);
    } catch (error) {
      setWaybillState({ phase: 'error', message: readableError(error) });
    }
  }

  async function retryPrintJob(job: PrintJob) {
    if (!session || job.state === 'ACCEPTED' || !job.provider || !job.deviceId || retryingPrintJobId) return;
    const key = printRetryKeys.current[job.printJobId]
      ?? idempotencyKeyForOrder('print-retry', job.printJobId);
    printRetryKeys.current[job.printJobId] = key;
    setRetryingPrintJobId(job.printJobId);
    setPrintRetryError(undefined);
    try {
      const updated = await api.retryMerchantPrintJob(job.printJobId, key, session.token);
      delete printRetryKeys.current[job.printJobId];
      setPrintJobsState((state) => state.phase === 'ready'
        ? { phase: 'ready', value: state.value.map((item) => item.printJobId === updated.printJobId ? updated : item) }
        : state);
    } catch (error) {
      setPrintRetryError(readableError(error));
    } finally {
      setRetryingPrintJobId(undefined);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        actions={(
          <div className="button-group">
            <button className="button secondary" disabled={!session || printJobsState.phase === 'loading'} onClick={() => void loadPrintJobs()} type="button"><Printer aria-hidden="true" size={16} /> 刷新打印任务</button>
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
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'delivery'} className={tab === 'delivery' ? 'active' : undefined} id="delivery-tab" onClick={() => changeTab('delivery')} type="button"><Box aria-hidden="true" size={17} /> 快递邮寄</button>
          <button aria-controls="fulfillment-orders" aria-pressed={tab === 'pickup'} className={tab === 'pickup' ? 'active' : undefined} id="pickup-tab" onClick={() => changeTab('pickup')} type="button"><ScanLine aria-hidden="true" size={17} /> 到店自提</button>
        </div>
        <div className="section-heading"><div><p className="eyebrow">Merchant-scoped orders</p><h2 id="orders-title">商家履约订单</h2></div><span>{ordersState.phase === 'ready' ? `${visibleOrders.length} 笔` : '实时 Core 读取'}</span></div>
        <p className="section-intro">筛选、订单分类、数量、支付 TxHash、下单时间和可执行动作均来自 Core `.5`。浏览器只提交筛选条件，不重算或补写订单字段。</p>
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
                  batchSelected={batchSelection.includes(order.orderId)}
                  onToggleBatch={() => toggleBatchOrder(order)}
                  selected={order.orderId === selectedOrderId}
                  selectionDisabled={operationPending}
                  target={order.orderId === selectedOrderId ? selectedTarget : undefined}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="selection-bar">
          <span>第 {pageIndex + 1} 页 · {tab === 'delivery' ? `已选 ${batchSelection.length} 笔可发货订单` : '到店自提不进入发货批次'}</span>
          <div className="button-group"><button className="button secondary" disabled={pageIndex === 0 || ordersState.phase === 'loading'} onClick={goToPreviousPage} type="button">上一页</button><button className="button secondary" disabled={ordersState.phase !== 'ready' || !ordersState.value.nextCursor} onClick={goToNextPage} type="button">下一页</button></div>
        </div>
        {tab === 'delivery' && batchSelection.length > 0 ? (
          <>
          <form className="batch-shipment-panel waybill-panel" onSubmit={(event) => { event.preventDefault(); void submitWaybillBatch(); }}>
            <div className="section-heading"><div><p className="eyebrow">Provider waybill batch</p><h3>电子面单与自动发货</h3></div><span>{batchSelection.length} / 100</span></div>
            <div className="waybill-controls">
              <div className="field"><label htmlFor="waybill-provider">面单服务</label><select disabled={operationPending} id="waybill-provider" onChange={(event) => updateWaybillInput(() => setWaybillProvider(event.target.value as WaybillProvider))} value={waybillProvider}>{waybillProviders.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
              <div className="field"><label htmlFor="waybill-carrier">承运商</label><select disabled={operationPending} id="waybill-carrier" onChange={(event) => updateWaybillInput(() => setWaybillCarrierCode(event.target.value as WaybillCarrierCode))} value={waybillCarrierCode}>{batchCarrierCodes.map((code) => <option key={code} value={code}>{code}</option>)}</select></div>
              <div className="field"><label htmlFor="waybill-store">发货门店</label><select disabled={operationPending || storesState.phase !== 'ready' || merchantStores.length === 0} id="waybill-store" onChange={(event) => updateWaybillInput(() => setWaybillStoreId(event.target.value))} value={waybillStoreId}><option value="">选择门店</option>{merchantStores.map((store) => <option key={store.storeId} value={store.storeId}>{store.name} / {store.storeId}</option>)}</select></div>
            </div>
            {storesState.phase === 'error' ? <p className="form-error" role="alert">{storesState.message}</p> : null}
            {storesState.phase === 'ready' && merchantStores.length === 0 ? <p className="form-error" role="alert">ConfigurationRequired：当前商家没有可用发货门店。</p> : null}
            {waybillProviderReadiness !== 'READY' ? <p className="form-error" role="alert">ConfigurationRequired：{waybillProvider} 服务未就绪，面单提交已关闭。</p> : null}
            <div className="selection-bar"><span>Core 向服务商取号，写入真实 tracking number、发货证据和打印任务。</span><button className="button primary" disabled={!waybillValid || operationPending} type="submit"><Printer aria-hidden="true" size={16} /> {waybillSubmitting ? '正在创建面单' : '创建电子面单批次'}</button></div>
            {waybillState.phase === 'error' ? <p className="form-error" role="alert">{waybillState.message}</p> : null}
            {waybillState.phase === 'ready' ? <WaybillResults result={waybillState.value} /> : null}
          </form>
          <form className="batch-shipment-panel" onSubmit={(event) => { event.preventDefault(); submitShipmentBatch(); }}>
            <div className="section-heading"><div><p className="eyebrow">Atomic manual batch</p><h3>手工批量发货</h3></div><span>{batchSelection.length} / 100</span></div>
            <div className="table-wrap compact-table"><table><thead><tr><th scope="col">订单号</th><th scope="col">承运商</th><th scope="col">物流单号哈希</th><th scope="col">发货证据哈希</th></tr></thead><tbody>{selectedBatchOrders.map((order) => {
              const draft = batchItems[order.orderId]!;
              return <tr key={order.orderId}><td><code className="hash-value">{order.orderId}</code></td><td><select aria-label={`批量承运商 ${order.orderId}`} disabled={submitting} onChange={(event) => updateBatchItem(order.orderId, { carrierCode: event.target.value as BatchCarrierCode })} value={draft.carrierCode}>{batchCarrierCodes.map((code) => <option key={code} value={code}>{code}</option>)}</select></td><td><input aria-label={`批量物流单号哈希 ${order.orderId}`} disabled={submitting} onChange={(event) => updateBatchItem(order.orderId, { trackingNumberHash: event.target.value })} placeholder="0x + 64 位十六进制" value={draft.trackingNumberHash} /></td><td><input aria-label={`批量发货证据哈希 ${order.orderId}`} disabled={submitting} onChange={(event) => updateBatchItem(order.orderId, { evidenceHash: event.target.value })} placeholder="0x + 64 位十六进制" value={draft.evidenceHash} /></td></tr>;
            })}</tbody></table></div>
            <div className="selection-bar"><span>整批在 Core 单事务中成功或失败；失败重试复用同一批次和单项幂等键。</span><button className="button primary" disabled={!batchValid || operationPending} type="submit"><Send aria-hidden="true" size={16} /> 原子提交批量发货</button></div>
          </form>
          </>
        ) : null}
        <p className="panel-note">PII-safe Excel 导出仍保持关闭。电子面单路径仅提交 provider、carrier、store 和 orderIds，不在浏览器生成运单号、证据哈希或打印内容。</p>
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
            {printJobsState.phase === 'loading' ? <LoadingRows count={2} /> : null}
            {printJobsState.phase === 'error' ? <EmptyState blocked description={printJobsState.message} title="打印任务读取失败" /> : null}
            {printJobsState.phase === 'ready' && !selectedPickupJob ? <EmptyState description="核销最终确认后，Core 会自动创建一份双联小票任务。" title="尚未生成小票" /> : null}
            {selectedPickupJob ? <dl className="binding-summary">
              <div><dt>任务状态</dt><dd>{selectedPickupJob.state}</dd></div>
              <div><dt>打印份数</dt><dd>{selectedPickupJob.copyCount}</dd></div>
              <div><dt>设备</dt><dd>{selectedPickupJob.provider ?? '未绑定'} / {selectedPickupJob.deviceId ?? '未绑定'}</dd></div>
              <div><dt>内容哈希</dt><dd><code>{selectedPickupJob.contentHash}</code></dd></div>
            </dl> : null}
            <p className="panel-note">浏览器只读取 Core 的 PICKUP_RECEIPT / 2 联任务，不生成、编辑或重算打印内容。</p>
          </section>
        </div>
      ) : null}

      <section className="section-block print-jobs-panel" aria-labelledby="print-jobs-title">
        <div className="section-heading"><div><p className="eyebrow">Durable print queue</p><h2 id="print-jobs-title">打印作业</h2></div><button className="button secondary" disabled={!session || printJobsState.phase === 'loading'} onClick={() => void loadPrintJobs()} type="button"><RefreshCw aria-hidden="true" size={16} /> 刷新</button></div>
        {printJobsState.phase === 'loading' ? <LoadingRows count={3} /> : null}
        {printJobsState.phase === 'idle' ? <EmptyState blocked description="连接授权商家钱包后读取作业。" title="商家会话不可用" /> : null}
        {printJobsState.phase === 'error' ? <EmptyState blocked description={printJobsState.message} title="打印作业读取失败" /> : null}
        {printRetryError ? <p className="form-error" role="alert">{printRetryError}</p> : null}
        {printJobsState.phase === 'ready' && printJobs.length === 0 ? <EmptyState description="电子面单或到店核销后，Core 会在此创建作业。" title="暂无打印作业" /> : null}
        {printJobs.length > 0 ? <div className="table-wrap"><table><thead><tr><th scope="col">任务</th><th scope="col">类型</th><th scope="col">订单 / 门店</th><th scope="col">设备</th><th scope="col">份数</th><th scope="col">状态</th><th scope="col">Provider reference</th><th scope="col">错误 / 下次重试</th><th scope="col">操作</th></tr></thead><tbody>{printJobs.map((job) => {
          const retryBlocked = !job.provider || !job.deviceId;
          return <tr key={job.printJobId}><td><code className="hash-value">{job.printJobId}</code></td><td>{job.jobKind}</td><td><code className="hash-value">{job.orderId}</code><small className="table-subline">{job.storeId}</small></td><td>{job.provider ?? '—'}<small className="table-subline">{job.deviceId ?? '未绑定设备'}</small></td><td className="numeric-cell">{job.copyCount}</td><td><span className={`state-text ${job.state === 'ACCEPTED' ? 'success' : job.state === 'FAILED' || job.state === 'CONFIGURATION_REQUIRED' ? 'blocked' : ''}`}>{job.state}</span></td><td>{job.providerReference ?? '—'}</td><td>{job.errorCode ?? '—'}<small className="table-subline">{job.nextAttemptAt ?? '无调度时间'}</small></td><td>{job.state === 'ACCEPTED' ? <span className="state-text success">已受理</span> : <button className="button secondary" disabled={!session || retryBlocked || Boolean(retryingPrintJobId)} onClick={() => void retryPrintJob(job)} type="button"><RefreshCw aria-hidden="true" size={15} /> {retryingPrintJobId === job.printJobId ? '重试中' : '重试'}</button>}{retryBlocked && job.state !== 'ACCEPTED' ? <small className="table-subline">ConfigurationRequired</small> : null}</td></tr>;
        })}</tbody></table></div> : null}
      </section>

      {commandState.phase === 'submitting' ? <div className="system-notice" role="status"><RefreshCw aria-hidden="true" size={18} /><div><strong>正在提交 Core</strong><span>使用稳定幂等键等待权威响应。</span></div></div> : null}
      {commandState.phase === 'success' ? <div className="system-notice ready" role="status"><PackageCheck aria-hidden="true" size={18} /><div><strong>履约命令已确认</strong><span>{commandState.message}</span></div></div> : null}
      {commandState.phase === 'error' ? <p className="form-error" role="alert">{commandState.message}</p> : null}

      <div className="provider-strip" role="status">
        <ProviderStatus bootstrap={bootstrap} name="KUAIDI100" label="快递接口" />
        <ProviderStatus bootstrap={bootstrap} name="CAINIAO" label="菜鸟面单" />
        <ProviderStatus bootstrap={bootstrap} name="FEIE" label="云打印机" />
        <ProviderStatus bootstrap={bootstrap} name="YILIANYUN" label="易联云打印" />
        <span><i className={`provider-dot ${ordersState.phase === 'ready' ? 'ready' : 'offline'}`} />Core 订单流：{ordersState.phase === 'ready' ? 'Connected' : 'Unavailable'}</span>
      </div>
    </div>
  );
}

function WaybillResults({ result }: { result: WaybillBatchResult }) {
  return (
    <div aria-live="polite" className="waybill-results">
      <div className="section-heading"><div><p className="eyebrow">Core result</p><h4>面单批次 {result.batchId}</h4></div><span>{result.items.length} 笔</span></div>
      <div className="table-wrap compact-table"><table><thead><tr><th scope="col">订单</th><th scope="col">状态</th><th scope="col">真实运单号</th><th scope="col">Provider reference</th><th scope="col">跟踪 / 证据哈希</th><th scope="col">打印任务</th><th scope="col">错误</th></tr></thead><tbody>{result.items.map((item) => (
        <tr key={item.requestId}>
          <td><code className="hash-value">{item.orderId}</code></td>
          <td><span className={`state-text ${item.state === 'COMPLETED' ? 'success' : item.state === 'FAILED' || item.state === 'CONFIGURATION_REQUIRED' ? 'blocked' : ''}`}>{item.state}</span></td>
          <td>{item.trackingNumber ?? '—'}</td>
          <td>{item.providerReference ?? '—'}</td>
          <td>{item.trackingNumberHash ? <code className="hash-value">{item.trackingNumberHash}</code> : '—'}{item.shipmentEvidenceHash ? <code className="hash-value table-subline">{item.shipmentEvidenceHash}</code> : null}</td>
          <td>{item.printJobId ? <code className="hash-value">{item.printJobId}</code> : '—'}</td>
          <td>{item.errorCode ?? '—'}</td>
        </tr>
      ))}</tbody></table></div>
    </div>
  );
}

function OrderRow({
  order,
  batchSelected,
  selected,
  selectionDisabled,
  target,
  onToggleBatch,
  onSelect,
}: {
  order: FulfillmentOrder;
  batchSelected: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  target: FulfillmentTarget | undefined;
  onToggleBatch(): void;
  onSelect(): void;
}) {
  const latestShipment = order.shipments.at(-1);
  const pickupStore = target?.fulfillmentMode === 'PICKUP' ? target.payload.name : '选择后读取';
  const batchAllowed = order.fulfillmentMode === 'DELIVERY'
    && canExecuteOrderAction('RECORD_SHIPMENT', order.allowedActions);
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
      {order.fulfillmentMode === 'DELIVERY' ? <td><input aria-label={`选择批量发货 ${order.orderId}`} checked={batchSelected} disabled={!batchAllowed || selectionDisabled} onChange={onToggleBatch} type="checkbox" /></td> : null}
      {shared}
      {order.fulfillmentMode === 'DELIVERY' ? (
        <>
          <td><span className={order.finalityStatus === 'FINAL' ? 'state-text success' : 'state-text blocked'}>{order.finalityStatus}</span></td>
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

function localDateTimeToIso(value: string) {
  return new Date(value).toISOString();
}

function idempotencyKeyForOrder(kind: string, orderId: string) {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `merchant-${kind}-${orderId.slice(2, 10)}-${random}`;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCheck,
  KeyRound,
  MapPin,
  PackageCheck,
  RefreshCw,
  Send,
  ShieldAlert,
} from 'lucide-react';
import {
  logisticsCarrierCodes,
  takeoverStates,
  type EvidenceEnvelopeProjection,
  type FulfillmentTarget,
  type LogisticsCarrierCode,
  type ShipmentResult,
  type TakeoverCase,
  type TakeoverCaseCursor,
  type TakeoverCaseDetail,
  type TakeoverState,
} from '@abu24k/core-artifacts';
import { CoreApiError } from '../core-api';
import { canExecuteOrderAction } from '../core-boundary';
import { readableError, useCoreRuntime } from '../core-runtime';
import { EmptyState, LoadingRows, PageHeader } from '../components/ui';

type DataState<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; error: string };

interface CasePage {
  cases: readonly TakeoverCase[];
  nextCursor: TakeoverCaseCursor | null;
}

const stateLabels: Record<TakeoverState, string> = {
  OPEN: '待资助',
  FUNDED: '已资助',
  FULFILLING: '已发货',
  FULFILLMENT_PENDING: '待完成',
  CLOSED: '已关闭',
  DECISION_BLOCKED: '等待平台决策',
};

export function TakeoverPage() {
  const { api, session } = useCoreRuntime();
  const [stateFilter, setStateFilter] = useState<TakeoverState | ''>('FUNDED');
  const [appliedState, setAppliedState] = useState<TakeoverState | ''>('FUNDED');
  const [cursor, setCursor] = useState<TakeoverCaseCursor>();
  const [cursorHistory, setCursorHistory] = useState<readonly (TakeoverCaseCursor | undefined)[]>([]);
  const [casePage, setCasePage] = useState<DataState<CasePage>>({ phase: 'loading' });
  const [selected, setSelected] = useState<DataState<TakeoverCaseDetail> | undefined>();
  const [target, setTarget] = useState<DataState<FulfillmentTarget> | undefined>();
  const [carrierCode, setCarrierCode] = useState<LogisticsCarrierCode>('SF');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingEvidence, setTrackingEvidence] = useState<EvidenceEnvelopeProjection>();
  const [evidencePending, setEvidencePending] = useState(false);
  const [shipmentPending, setShipmentPending] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [shipmentResult, setShipmentResult] = useState<ShipmentResult>();
  const commandKeys = useRef<{ evidence?: string; shipment?: string }>({});

  const loadCases = useCallback(async () => {
    if (!session) return;
    setCasePage({ phase: 'loading' });
    try {
      const result = await api.listMerchantTakeoverCases(session.token, {
        ...(appliedState ? { state: appliedState } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 25,
      });
      for (const takeover of result.cases) assertAssignedToSession(takeover, session);
      setCasePage({ phase: 'ready', value: { cases: result.cases, nextCursor: result.nextCursor } });
    } catch (error) {
      setCasePage({ phase: 'error', error: readableError(error) });
    }
  }, [api, appliedState, cursor, session]);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const loadDetail = useCallback(async (caseId: string) => {
    if (!session) return;
    setSelected({ phase: 'loading' });
    setTarget({ phase: 'loading' });
    setCommandError(undefined);
    setShipmentResult(undefined);
    setTrackingEvidence(undefined);
    commandKeys.current = {};
    try {
      const detail = await api.getMerchantTakeoverCase(caseId, session.token);
      assertDetailAssignedToSession(detail, session);
      setSelected({ phase: 'ready', value: detail });
      const nextTarget = await api.getOrderFulfillmentTarget(detail.case.orderId, session.token);
      assertTargetMatchesCase(nextTarget, detail.case);
      setTarget({ phase: 'ready', value: nextTarget });
    } catch (error) {
      const message = readableError(error);
      setSelected({ phase: 'error', error: message });
      setTarget({ phase: 'error', error: message });
    }
  }, [api, session]);

  const selectedDetail = selected?.phase === 'ready' ? selected.value : undefined;
  const selectedCase = selectedDetail?.case;
  const assignment = selectedCase?.currentAssignment;
  const action = selectedCase?.allowedActions.find((item) => item.action === 'RECORD_SHIPMENT');
  const targetReady = target?.phase === 'ready' && target.value.fulfillmentMode === 'DELIVERY';
  const canCreateEvidence = Boolean(
    session
    && selectedCase?.state === 'FUNDED'
    && selectedCase.order.fulfillmentMode === 'DELIVERY'
    && assignment
    && assignment.replacementMerchantId === session.merchantId
    && assignment.replacementWallet.toLowerCase() === session.walletAddress.toLowerCase()
    && targetReady
    && canExecuteOrderAction('RECORD_SHIPMENT', selectedCase.allowedActions),
  );
  const trackingValid = trackingNumber.trim().length >= 6 && trackingNumber.trim().length <= 64;

  const resetTrackingCommand = useCallback(() => {
    setTrackingEvidence(undefined);
    setShipmentResult(undefined);
    setCommandError(undefined);
    commandKeys.current = {};
  }, []);

  const createEvidence = async () => {
    if (!session || !selectedCase || !canCreateEvidence || !trackingValid) return;
    setEvidencePending(true);
    setCommandError(undefined);
    try {
      commandKeys.current.evidence ??= commandKey('merchant-takeover-tracking', selectedCase.orderId);
      const evidence = await api.createOrderTrackingEvidence(selectedCase.orderId, {
        carrierCode,
        trackingNumber: trackingNumber.trim(),
        idempotencyKey: commandKeys.current.evidence,
      }, session.token);
      if (evidence.ownerWallet.toLowerCase() !== session.walletAddress.toLowerCase()) {
        throw new CoreApiError('InvalidResponse', '物流证据与当前商家钱包不一致。');
      }
      setTrackingEvidence(evidence);
    } catch (error) {
      const message = readableError(error);
      setCommandError(message);
      if (error instanceof CoreApiError && (error.code === 'Forbidden' || error.code === 'InvalidResponse')) {
        setTrackingEvidence(undefined);
        setSelected({ phase: 'error', error: message });
        setTarget({ phase: 'error', error: message });
        void loadCases();
      }
    } finally {
      setEvidencePending(false);
    }
  };

  const ship = async () => {
    if (
      !session
      || !selectedCase
      || !trackingEvidence
      || !trackingEvidence.trackingNumberHash
      || !canCreateEvidence
    ) return;
    setShipmentPending(true);
    setCommandError(undefined);
    try {
      commandKeys.current.shipment ??= commandKey('merchant-takeover-shipment', selectedCase.orderId);
      const result = await api.recordShipment(selectedCase.orderId, {
        carrierCode,
        trackingNumberHash: trackingEvidence.trackingNumberHash,
        evidenceHash: trackingEvidence.evidenceHash,
        idempotencyKey: commandKeys.current.shipment,
      }, session.token);
      setShipmentResult(result);
      setTrackingNumber('');
      await Promise.all([loadCases(), loadDetail(selectedCase.caseId)]);
      setShipmentResult(result);
    } catch (error) {
      const message = readableError(error);
      setCommandError(message);
      if (error instanceof CoreApiError && error.code === 'Forbidden') {
        setTrackingEvidence(undefined);
        setSelected({ phase: 'error', error: message });
        setTarget({ phase: 'error', error: message });
        void loadCases();
      }
    } finally {
      setShipmentPending(false);
    }
  };

  const applyFilter = () => {
    setAppliedState(stateFilter);
    setCursor(undefined);
    setCursorHistory([]);
    setSelected(undefined);
    setTarget(undefined);
  };

  const nextPage = () => {
    if (casePage.phase !== 'ready' || !casePage.value.nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(casePage.value.nextCursor);
    setSelected(undefined);
    setTarget(undefined);
  };

  const previousPage = () => {
    const previous = cursorHistory.at(-1);
    setCursor(previous);
    setCursorHistory((history) => history.slice(0, -1));
    setSelected(undefined);
    setTarget(undefined);
  };

  return (
    <div className="page-stack takeover-page">
      <PageHeader
        eyebrow="接管履约"
        title="接管履约"
        description="平台分配给当前钱包的接管订单，按系统给出的地址发货。"
        actions={<span className="header-status ready"><ClipboardCheck aria-hidden="true" size={16} />本页案件 {casePage.phase === 'ready' ? casePage.value.cases.length : '--'}</span>}
      />

      <section aria-labelledby="takeover-queue-title" className="section-block takeover-queue">
        <div className="section-heading takeover-heading">
          <div><p className="eyebrow">我的任务</p><h2 id="takeover-queue-title">分配给我</h2></div>
          <button aria-label="刷新接管案件" className="button secondary" disabled={casePage.phase === 'loading'} onClick={() => void loadCases()} type="button">
            <RefreshCw aria-hidden="true" size={16} /> 刷新
          </button>
        </div>
        <div className="takeover-filter-bar">
          <label>
            <span>案件状态</span>
            <select aria-label="案件状态" onChange={(event) => setStateFilter(event.target.value as TakeoverState | '')} value={stateFilter}>
              <option value="">全部状态</option>
              {takeoverStates.map((state) => <option key={state} value={state}>{stateLabels[state]}</option>)}
            </select>
          </label>
          <button className="button primary" onClick={applyFilter} type="button">应用筛选</button>
        </div>

        {casePage.phase === 'loading' ? <LoadingRows count={4} /> : null}
        {casePage.phase === 'error' ? (
          <div className="takeover-load-error" role="alert"><ShieldAlert aria-hidden="true" size={18} /><span>{casePage.error}</span></div>
        ) : null}
        {casePage.phase === 'ready' && casePage.value.cases.length === 0 ? (
          <EmptyState title="当前没有分配案件" description="系统没有返回符合筛选条件且仍属于当前商家的接管分配。" />
        ) : null}
        {casePage.phase === 'ready' && casePage.value.cases.length > 0 ? (
          <div className="table-wrap">
            <table className="takeover-table">
              <thead><tr><th>案件 / 订单</th><th>商品</th><th>状态</th><th>当前分配</th><th>更新时间</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>{casePage.value.cases.map((takeover) => (
                <TakeoverRow key={takeover.caseId} onSelect={() => void loadDetail(takeover.caseId)} takeover={takeover} />
              ))}</tbody>
            </table>
          </div>
        ) : null}
        {casePage.phase === 'ready' ? (
          <div className="takeover-pagination">
            <span>本页 {casePage.value.cases.length} 个案件</span>
            <div className="button-group">
              <button className="button secondary" disabled={cursorHistory.length === 0} onClick={previousPage} type="button"><ArrowLeft aria-hidden="true" size={16} /> 上一页</button>
              <button className="button secondary" disabled={!casePage.value.nextCursor} onClick={nextPage} type="button">下一页 <ArrowRight aria-hidden="true" size={16} /></button>
            </div>
          </div>
        ) : null}
      </section>

      {selected ? (
        <section aria-labelledby="takeover-detail-title" className="section-block takeover-detail">
          {selected.phase === 'loading' ? <LoadingRows count={4} /> : null}
          {selected.phase === 'error' ? <EmptyState blocked title="案件读取被拒绝" description={selected.error} /> : null}
          {selectedDetail && selectedCase && assignment ? (
            <>
              <div className="section-heading takeover-heading">
                <div><p className="eyebrow">分配记录</p><h2 id="takeover-detail-title">案件与当前分配</h2></div>
                <span className={`status-text status-${selectedCase.state.toLowerCase()}`}>{stateLabels[selectedCase.state]}</span>
              </div>
              <dl className="takeover-facts">
                <Fact label="案件编号" value={selectedCase.caseId} mono />
                <Fact label="订单编号" value={selectedCase.orderId} mono />
                <Fact label="分配版本" value={`v${assignment.version}`} />
                <Fact label="分配编号" value={assignment.assignmentId} mono />
                <Fact label="替代商家" value={assignment.replacementMerchantId} />
                <Fact label="接单钱包" value={assignment.replacementWallet} mono />
                <Fact label="分配原因" value={assignment.reasonCode} />
                <Fact label="分配时间" value={formatDateTime(assignment.assignedAt)} />
                <Fact label="分配证据" value={assignment.evidenceHash} mono />
                <Fact label="接管证据" value={selectedCase.evidenceHash} mono />
              </dl>

              <div className="takeover-work-grid">
                <section aria-labelledby="takeover-target-title" className="takeover-pane">
                  <div className="section-heading"><div><p className="eyebrow">收货信息</p><h3 id="takeover-target-title">履约目标</h3></div><MapPin aria-hidden="true" size={18} /></div>
                  <FulfillmentTargetState state={target} />
                </section>

                <section aria-labelledby="takeover-shipment-title" className="takeover-pane">
                  <div className="section-heading"><div><p className="eyebrow">物流凭证</p><h3 id="takeover-shipment-title">物流证据与发货</h3></div><KeyRound aria-hidden="true" size={18} /></div>
                  <div className="takeover-action-state">
                    <span>案件状态 <strong>{stateLabels[selectedCase.state]}</strong></span>
                    <span>系统判断 <strong>{action?.enabled ? '允许发货' : takeoverReasonLabel(action?.reasonCode)}</strong></span>
                  </div>
                  <div className="two-column-fields">
                    <label className="field"><span className="field-label">承运商</span><select disabled={!canCreateEvidence || Boolean(trackingEvidence)} onChange={(event) => { setCarrierCode(event.target.value as LogisticsCarrierCode); resetTrackingCommand(); }} value={carrierCode}>{logisticsCarrierCodes.map((carrier) => <option key={carrier} value={carrier}>{carrierLabel(carrier)}</option>)}</select></label>
                    <label className="field"><span className="field-label">物流单号</span><input autoComplete="off" disabled={!canCreateEvidence || Boolean(trackingEvidence)} maxLength={64} minLength={6} onChange={(event) => { setTrackingNumber(event.target.value); resetTrackingCommand(); }} value={trackingNumber} /></label>
                  </div>
                  <button className="button secondary wide" disabled={!canCreateEvidence || !trackingValid || evidencePending || Boolean(trackingEvidence)} onClick={() => void createEvidence()} type="button">
                    <KeyRound aria-hidden="true" size={16} /> {evidencePending ? '正在创建证据' : '创建物流证据'}
                  </button>
                  {trackingEvidence ? (
                    <div className="takeover-evidence" role="status">
                      <PackageCheck aria-hidden="true" size={18} />
                      <div><strong>系统已保存物流凭证</strong><code title={trackingEvidence.trackingNumberHash ?? undefined}>{shortId(trackingEvidence.trackingNumberHash)}</code><code title={trackingEvidence.evidenceHash}>{shortId(trackingEvidence.evidenceHash)}</code></div>
                    </div>
                  ) : null}
                  <button className="button primary wide" disabled={!canCreateEvidence || !trackingEvidence || shipmentPending} onClick={() => void ship()} type="button">
                    <Send aria-hidden="true" size={16} /> {shipmentPending ? '正在提交发货' : '确认发货'}
                  </button>
                  {!canCreateEvidence ? <p className="takeover-block-reason">仅“已资助”且系统允许发货的当前分配可以发货。</p> : null}
                  {commandError ? <div className="command-feedback error" role="alert">{commandError}</div> : null}
                  {shipmentResult ? <div className="command-feedback success" role="status">已发货：{shipmentResult.shipmentId}</div> : null}
                </section>
              </div>

              <section aria-labelledby="takeover-history-title" className="takeover-history">
                <div className="section-heading"><h3 id="takeover-history-title">案件状态证据</h3><span>{selectedDetail.transitions.length} 条</span></div>
                {selectedDetail.transitions.length === 0 ? <p className="panel-note">系统还没有状态迁移记录。</p> : (
                  <ol>{selectedDetail.transitions.map((transition) => (
                    <li key={transition.transitionId}><time dateTime={transition.occurredAt}>{formatDateTime(transition.occurredAt)}</time><strong>{stateLabels[transition.fromState as TakeoverState] ?? transition.fromState ?? '创建'} → {stateLabels[transition.toState as TakeoverState] ?? transition.toState}</strong><span>{transition.evidenceType}</span><code title={transition.evidenceHash}>{shortId(transition.evidenceHash)}</code></li>
                  ))}</ol>
                )}
              </section>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function TakeoverRow({ takeover, onSelect }: { takeover: TakeoverCase; onSelect(): void }) {
  const assignment = takeover.currentAssignment!;
  return (
    <tr>
      <td><strong title={takeover.caseId}>{friendlyCaseId(takeover.caseId)}</strong><code className="hash-value" title={takeover.orderId}>{friendlyOrderId(takeover.orderId)}</code></td>
      <td title={takeover.order.productId}>{friendlyProductId(takeover.order.productId)}<span className="table-secondary" title={takeover.order.skuId}>规格 {friendlyTail(takeover.order.skuId)} · 数量 {takeover.order.quantity}</span></td>
      <td><span className={`status-text status-${takeover.state.toLowerCase()}`}>{stateLabels[takeover.state]}</span><span className="table-secondary">订单 {orderStateLabel(takeover.order.state)}</span></td>
      <td>v{assignment.version}<code className="hash-value" title={assignment.assignmentId}>{shortId(assignment.assignmentId)}</code></td>
      <td><time dateTime={takeover.updatedAt}>{formatDateTime(takeover.updatedAt)}</time></td>
      <td><button className="button secondary" onClick={onSelect} type="button">处理案件</button></td>
    </tr>
  );
}

function FulfillmentTargetState({ state }: { state: DataState<FulfillmentTarget> | undefined }) {
  if (!state || state.phase === 'loading') return <LoadingRows count={3} />;
  if (state.phase === 'error') return <EmptyState blocked title="履约目标加载失败" description={state.error} />;
  if (state.value.fulfillmentMode !== 'DELIVERY') return <EmptyState blocked title="履约模式不匹配" description="替代商家发货只接受系统发布的快递履约目标。" />;
  return (
    <dl className="takeover-target">
      <div><dt>收件人</dt><dd>{state.value.payload.recipientName}</dd></div>
      <div><dt>联系电话</dt><dd>{state.value.payload.phone}</dd></div>
      <div><dt>完整地址</dt><dd>{state.value.payload.address}</dd></div>
      <div><dt>行政区</dt><dd>{state.value.payload.regionCode}</dd></div>
      <details className="technical-details compact"><summary>地址核验信息</summary><div><dt>地址校验编号</dt><dd><code title={state.value.targetHash}>{shortId(state.value.targetHash)}</code></dd></div></details>
    </dl>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'hash-value' : undefined} title={mono ? value : undefined}>{mono ? shortId(value) : value}</dd></div>;
}



function orderStateLabel(value: string) {
  return ({
    CREATED: '已创建',
    PAID: '已付款',
    READY_TO_SHIP: '待发货',
    SHIPPED: '已发货',
    DELIVERED: '已送达',
    FULFILLED: '已履约',
    DISPUTED: '仲裁中',
    TAKEOVER: '平台接管',
    CANCELLED: '已取消',
  } as Record<string, string>)[value] ?? value;
}

function carrierLabel(value: LogisticsCarrierCode) {
  return ({ SF: '顺丰', JD: '京东物流', YTO: '圆通', ZTO: '中通', STO: '申通', EMS: 'EMS' } as Record<string, string>)[value] ?? value;
}

function friendlyTail(value: string | null | undefined) {
  if (!value) return '';
  return value.length > 6 ? `#${value.slice(-6)}` : value;
}

function friendlyCaseId(value: string) {
  return `案件 ${friendlyTail(value)}`;
}

function friendlyOrderId(value: string) {
  return `订单 ${friendlyTail(value)}`;
}

function friendlyProductId(value: string) {
  return `商品 ${friendlyTail(value)}`;
}

function shortId(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function takeoverReasonLabel(value: string | null | undefined) {
  if (!value) return '未发布';
  return ({
    STATE_NOT_ALLOWED: '当前案件状态不允许',
    FULFILLMENT_MODE_MISMATCH: '履约方式不匹配',
    WAITING_FINALITY: '等待付款最终确认',
    DEADLINE_NOT_REACHED: '还没到可操作时间',
    DISPUTED: '订单仲裁中',
  } as Record<string, string>)[value] ?? value;
}

function assertAssignedToSession(
  takeover: TakeoverCase,
  session: { merchantId: string; walletAddress: string },
) {
  const assignment = takeover.currentAssignment;
  if (
    !assignment
    || assignment.replacementMerchantId !== session.merchantId
    || assignment.replacementWallet.toLowerCase() !== session.walletAddress.toLowerCase()
  ) throw new CoreApiError('InvalidResponse', '接管案件与当前商家会话不一致。');
}

function assertDetailAssignedToSession(
  detail: TakeoverCaseDetail,
  session: { merchantId: string; walletAddress: string },
) {
  assertAssignedToSession(detail.case, session);
  if (
    detail.assignments.length !== 1
    || detail.assignments[0]?.assignmentId !== detail.case.currentAssignment?.assignmentId
  ) throw new CoreApiError('InvalidResponse', '接管详情未绑定唯一当前分配。');
}

function assertTargetMatchesCase(target: FulfillmentTarget, takeover: TakeoverCase) {
  if (
    target.fulfillmentMode !== 'DELIVERY'
    || takeover.order.fulfillmentMode !== 'DELIVERY'
    || target.targetHash.toLowerCase() !== takeover.order.fulfillmentTargetHash.toLowerCase()
  ) throw new CoreApiError('InvalidResponse', '履约目标与接管订单快照不一致。');
}

function commandKey(prefix: string, resourceId: string) {
  return `${prefix}-${resourceId.slice(-12)}-${crypto.randomUUID()}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

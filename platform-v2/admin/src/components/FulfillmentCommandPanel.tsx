import {
  executableOrderActionNames,
  type AllowedAction,
  type AllowedActionName,
  type FulfillmentOrder,
  type UserRole,
} from '@abu24k/core-artifacts';
import { Ban, PackageCheck } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CoreApiError,
  createOrderActionEvidence,
  createOrderTrackingEvidence,
  decideArbitration,
  decideForcedReceipt,
  decideFulfillmentRequest,
  openArbitration,
  openTakeover,
  recordDelivery,
  recordShipment,
  type PlatformFulfillmentCommandResult,
} from '../coreApi';
import { humanizeError } from '../display';

type PlatformFulfillmentAction = Extract<AllowedActionName,
  | 'RECORD_SHIPMENT'
  | 'RECORD_DELIVERY'
  | 'DECIDE_FULFILLMENT_REQUEST'
  | 'OPEN_ARBITRATION'
  | 'DECIDE_ARBITRATION'
  | 'OPEN_TAKEOVER'
  | 'DECIDE_FORCED_RECEIPT'>;

type DecisionValue = '' | 'APPROVE' | 'REJECT';
type ArbitrationOutcomeValue = '' | 'FULFILL' | 'RESUME_FULFILLMENT';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;
const actionDefinitions = [
  { action: 'RECORD_SHIPMENT', label: '记录发货', states: ['PAID', 'TAKEOVER', 'SHIPPED', 'DELIVERED'], roles: ['ADMIN', 'OPERATOR'] },
  { action: 'RECORD_DELIVERY', label: '记录送达', states: ['SHIPPED'], roles: ['ADMIN', 'OPERATOR'] },
  { action: 'DECIDE_FULFILLMENT_REQUEST', label: '处理换货 / 延期', states: ['PAID', 'SHIPPED', 'DELIVERED'], roles: ['ADMIN', 'OPERATOR'] },
  { action: 'OPEN_ARBITRATION', label: '发起仲裁', states: ['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'], roles: ['ADMIN', 'OPERATOR'] },
  { action: 'DECIDE_ARBITRATION', label: '裁决仲裁', states: ['ARBITRATION'], roles: ['ADMIN'] },
  { action: 'OPEN_TAKEOVER', label: '打开接管案件', states: ['PAID'], roles: ['ADMIN', 'OPERATOR'] },
  { action: 'DECIDE_FORCED_RECEIPT', label: '裁决强制签收', states: ['DELIVERED'], roles: ['ADMIN', 'OPERATOR'] },
] as const satisfies readonly {
  action: PlatformFulfillmentAction;
  label: string;
  states: readonly FulfillmentOrder['state'][];
  roles: readonly UserRole[];
}[];

export function FulfillmentCommandPanel({
  actions,
  actionsLoading,
  onBusyChange,
  onCompleted,
  order,
  roles,
  token,
}: {
  actions: readonly AllowedAction[];
  actionsLoading: boolean;
  onBusyChange(busy: boolean): void;
  onCompleted(result: PlatformFulfillmentCommandResult): Promise<void>;
  order: FulfillmentOrder;
  roles: readonly UserRole[];
  token: string;
}) {
  const definitions = useMemo(
    () => actionDefinitions.filter(({ action }) => executableOrderActionNames.includes(action)),
    [],
  );
  const [actionName, setActionName] = useState<PlatformFulfillmentAction>('OPEN_TAKEOVER');
  const [evidenceHash, setEvidenceHash] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [noteCode, setNoteCode] = useState('');
  const [carrierCode, setCarrierCode] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipmentNote, setShipmentNote] = useState('');
  const [requestId, setRequestId] = useState('');
  const [decision, setDecision] = useState<DecisionValue>('');
  const [outcome, setOutcome] = useState<ArbitrationOutcomeValue>('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CoreApiError | null>(null);
  const definition = definitions.find((item) => item.action === actionName) ?? definitions[0]!;
  const coreAction = actions.find((item) => item.action === definition.action);
  const openRequests = order.requests.filter((request) =>
    request.state === 'OPEN' && (request.requestType === 'EXCHANGE' || request.requestType === 'DELAY'));
  const disabledReason = commandDisabledReason({
    action: coreAction,
    actionsLoading,
    carrierCode,
    decision,
    definition,
    evidenceHash,
    noteCode,
    order,
    outcome,
    reasonCode,
    requestId,
    roles,
    trackingNumber,
  });

  useEffect(() => {
    const preferred = definitions.find(({ action }) => actions.some((item) => item.action === action && item.enabled))
      ?? definitions.find(({ action }) => actions.some((item) => item.action === action))
      ?? definitions[0];
    if (preferred) setActionName(preferred.action);
  }, [actions, definitions]);

  useEffect(() => {
    setEvidenceHash('');
    setReasonCode('');
    setNoteCode('');
    setCarrierCode('');
    setTrackingNumber('');
    setShipmentNote('');
    setRequestId('');
    setDecision('');
    setOutcome('');
    setIdempotencyKey('');
    setError(null);
  }, [actionName, order.orderId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabledReason) return;
    const nextIdempotencyKey = idempotencyKey || `admin:${definition.action.toLowerCase()}:${globalThis.crypto.randomUUID()}`;
    setIdempotencyKey(nextIdempotencyKey);
    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    try {
      const base = { idempotencyKey: nextIdempotencyKey, evidenceHash: evidenceHash.trim() };
      let result: PlatformFulfillmentCommandResult;
      switch (definition.action) {
        case 'RECORD_SHIPMENT': {
          const evidence = await createOrderTrackingEvidence(order.orderId, {
            carrierCode: carrierCode.trim(),
            trackingNumber: trackingNumber.trim(),
            ...(shipmentNote.trim() ? { note: shipmentNote.trim() } : {}),
            mediaAssetIds: [],
            idempotencyKey: `${nextIdempotencyKey}:evidence`,
          }, token);
          result = await recordShipment(order.orderId, {
            idempotencyKey: `${nextIdempotencyKey}:command`,
            evidenceHash: evidence.evidenceHash,
            carrierCode: carrierCode.trim(),
            trackingNumberHash: evidence.trackingNumberHash!,
          }, token);
          break;
        }
        case 'RECORD_DELIVERY':
          result = await recordDelivery(order.orderId, base, token);
          break;
        case 'DECIDE_FULFILLMENT_REQUEST':
          result = await decideFulfillmentRequest(order.orderId, {
            ...base,
            requestId,
            approved: decision === 'APPROVE',
            noteCode: normalizedReason(noteCode, decision === 'APPROVE' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED'),
          }, token);
          break;
        case 'OPEN_ARBITRATION': {
          const evidence = await createOrderActionEvidence(order.orderId, {
            action: 'OPEN_ARBITRATION',
            reasonCode: normalizedReason(reasonCode, 'ARBITRATION_REQUIRED'),
            idempotencyKey: `${nextIdempotencyKey}:evidence`,
          }, token);
          result = await openArbitration(order.orderId, {
            idempotencyKey: `${nextIdempotencyKey}:command`,
            evidenceHash: evidence.evidenceHash,
            reasonCode: normalizedReason(reasonCode, 'ARBITRATION_REQUIRED'),
          }, token);
          break;
        }
        case 'DECIDE_ARBITRATION':
          if (!outcome) return;
          result = await decideArbitration(order.orderId, { ...base, outcome, noteCode: normalizedReason(noteCode, 'EVIDENCE_VERIFIED') }, token);
          break;
        case 'OPEN_TAKEOVER':
          result = await openTakeover(order.orderId, { ...base, reasonCode: normalizedReason(reasonCode, 'NO_SHIPMENT_AFTER_FINALITY') }, token);
          break;
        case 'DECIDE_FORCED_RECEIPT':
          result = await decideForcedReceipt(order.orderId, {
            ...base,
            approved: decision === 'APPROVE',
            noteCode: normalizedReason(noteCode, decision === 'APPROVE' ? 'FORCED_RECEIPT_APPROVED' : 'FORCED_RECEIPT_REJECTED'),
          }, token);
          break;
      }
      await onCompleted(result);
    } catch (cause) {
      setError(cause instanceof CoreApiError
        ? cause
        : new CoreApiError({ code: 'ExternalBlocked', message: '履约命令失败', status: 503 }));
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  };

  return (
    <form className="takeover-command" onSubmit={(event) => void submit(event)}>
      <div className="panel-heading">
        <div><p className="section-kicker">履约操作</p><h3>履约操作台</h3></div>
        <span className={coreAction?.enabled ? 'status-chip status-ready' : 'status-chip status-blocked'}>
          {actionsLoading ? '检查中' : coreAction?.enabled ? '可执行' : coreAction?.reasonCode ?? '暂不可执行'}
        </span>
      </div>

      <label htmlFor="fulfillment-action">操作</label>
      <select id="fulfillment-action" value={definition.action} onChange={(event) => setActionName(event.target.value as PlatformFulfillmentAction)} disabled={submitting}>
        {definitions.map((item) => {
          const action = actions.find((candidate) => candidate.action === item.action);
          return <option key={item.action} value={item.action}>{item.label} · {action?.enabled ? '可执行' : action?.reasonCode ? reasonLabel(action.reasonCode) : '暂不能做'}</option>;
        })}
      </select>

      {definition.action !== 'RECORD_SHIPMENT' && definition.action !== 'OPEN_ARBITRATION' ? (
        <>
          <label htmlFor="fulfillment-evidence">系统凭证编号（高级）</label>
          <input id="fulfillment-evidence" value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} autoComplete="off" placeholder="从系统证据里复制 0x 编号" />
          <small>没有系统生成的编号不要手填；发货和发起仲裁会自动生成凭证。</small>
        </>
      ) : null}

      {definition.action === 'RECORD_SHIPMENT' ? (
        <>
          <label htmlFor="fulfillment-carrier">快递公司</label>
          <select id="fulfillment-carrier" value={carrierCode} onChange={(event) => setCarrierCode(event.target.value)}>
            <option value="">请选择</option>
            <option value="SF">顺丰</option><option value="JD">京东物流</option><option value="YTO">圆通</option>
            <option value="ZTO">中通</option><option value="STO">申通</option><option value="EMS">EMS</option>
          </select>
          <label htmlFor="fulfillment-tracking">运单号</label>
          <input id="fulfillment-tracking" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} autoComplete="off" maxLength={64} placeholder="输入快递单上的运单号" />
          <label htmlFor="fulfillment-shipment-note">发货备注 / 凭证说明</label>
          <textarea id="fulfillment-shipment-note" value={shipmentNote} onChange={(event) => setShipmentNote(event.target.value)} maxLength={500} placeholder="可选" />
        </>
      ) : null}

      {definition.action === 'DECIDE_FULFILLMENT_REQUEST' ? (
        <>
          <label htmlFor="fulfillment-request">待处理申请</label>
          <select id="fulfillment-request" value={requestId} onChange={(event) => setRequestId(event.target.value)}>
            <option value="">请选择</option>
            {openRequests.map((request) => <option key={request.requestId} value={request.requestId}>{request.requestType} · {request.requestId}</option>)}
          </select>
        </>
      ) : null}

      {definition.action === 'OPEN_ARBITRATION' || definition.action === 'OPEN_TAKEOVER' ? (
        <>
          <label htmlFor="fulfillment-reason">处理原因</label>
          <input id="fulfillment-reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} autoComplete="off" placeholder="不填则自动生成" />
        </>
      ) : null}

      {definition.action === 'DECIDE_ARBITRATION' ? (
        <>
          <label htmlFor="arbitration-outcome">仲裁结果</label>
          <select id="arbitration-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as ArbitrationOutcomeValue)}>
            <option value="">请选择</option><option value="FULFILL">确认履约完成</option><option value="RESUME_FULFILLMENT">恢复履约</option>
          </select>
        </>
      ) : null}

      {definition.action === 'DECIDE_FULFILLMENT_REQUEST' || definition.action === 'DECIDE_FORCED_RECEIPT' ? (
        <fieldset className="segmented-field fulfillment-decision">
          <legend>决定</legend>
          <span className="segmented">
            <button className={decision === 'APPROVE' ? 'is-active' : undefined} type="button" aria-pressed={decision === 'APPROVE'} onClick={() => setDecision('APPROVE')}>批准</button>
            <button className={decision === 'REJECT' ? 'is-active' : undefined} type="button" aria-pressed={decision === 'REJECT'} onClick={() => setDecision('REJECT')}>拒绝</button>
          </span>
        </fieldset>
      ) : null}

      {definition.action === 'DECIDE_FULFILLMENT_REQUEST' || definition.action === 'DECIDE_ARBITRATION' || definition.action === 'DECIDE_FORCED_RECEIPT' ? (
        <>
          <label htmlFor="fulfillment-note">裁决原因</label>
          <input id="fulfillment-note" value={noteCode} onChange={(event) => setNoteCode(event.target.value.toUpperCase())} autoComplete="off" placeholder="不填则自动生成" />
        </>
      ) : null}

      <button className="button button-primary button-full" type="submit" disabled={Boolean(disabledReason) || submitting}>
        <PackageCheck aria-hidden="true" /> {submitting ? '提交中' : `执行${definition.label}`}
      </button>
      <p className="button-explanation">{disabledReason ?? '当前平台角色、订单状态与系统授权均已通过。'}</p>
      {error ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>操作失败</strong><p>{humanizeError(error)}</p></div></div> : null}
    </form>
  );
}

function commandDisabledReason(input: {
  action: AllowedAction | undefined;
  actionsLoading: boolean;
  carrierCode: string;
  decision: DecisionValue;
  definition: (typeof actionDefinitions)[number];
  evidenceHash: string;
  noteCode: string;
  order: FulfillmentOrder;
  outcome: ArbitrationOutcomeValue;
  reasonCode: string;
  requestId: string;
  roles: readonly UserRole[];
  trackingNumber: string;
}) {
  if (!input.definition.roles.some((role) => input.roles.includes(role))) {
    return `当前平台角色不能执行“${input.definition.label}”。`;
  }
  if (!(input.definition.states as readonly FulfillmentOrder['state'][]).includes(input.order.state)) {
    return `当前订单状态不允许执行“${input.definition.label}”。`;
  }
  if (input.actionsLoading) return '正在读取当前订单能做什么。';
  if (!input.action) return `系统暂未开放“${input.definition.label}”。`;
  if (!input.action.enabled) return `系统暂不允许“${input.definition.label}”：${reasonLabel(input.action.reasonCode)}${input.action.deadline ? ` · 截止 ${input.action.deadline}` : ''}`;
  if (!['RECORD_SHIPMENT', 'OPEN_ARBITRATION'].includes(input.definition.action)
    && !bytes32Pattern.test(input.evidenceHash.trim())) return '请从系统证据里复制 0x 凭证编号；没有编号不要手填。';
  if (input.definition.action === 'RECORD_SHIPMENT') {
    if (!['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'].includes(input.carrierCode)) return '请选择快递公司。';
    if (!/^[A-Za-z0-9-]{3,64}$/.test(input.trackingNumber.trim())) return '请输入有效运单号。';
  }
  if (input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' && !input.requestId) return '请选择系统返回的待处理换货或延期申请。';
  if ((input.definition.action === 'OPEN_ARBITRATION' || input.definition.action === 'OPEN_TAKEOVER') && input.reasonCode.trim() && !reasonCodePattern.test(input.reasonCode.trim())) return '处理原因可以不填；如需填写，请使用大写字母、数字或下划线。';
  if (input.definition.action === 'DECIDE_ARBITRATION' && !input.outcome) return '请选择仲裁结果。';
  if ((input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' || input.definition.action === 'DECIDE_FORCED_RECEIPT') && !input.decision) return '请选择批准或拒绝。';
  if ((input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' || input.definition.action === 'DECIDE_ARBITRATION' || input.definition.action === 'DECIDE_FORCED_RECEIPT') && input.noteCode.trim() && !reasonCodePattern.test(input.noteCode.trim())) return '裁决原因可以不填；如需填写，请使用大写字母、数字或下划线。';
  return null;
}

function normalizedReason(value: string, fallback: string) {
  const normalized = value.trim().toUpperCase();
  return reasonCodePattern.test(normalized) ? normalized : fallback;
}

function reasonLabel(value: string | null | undefined) {
  if (!value) return '状态不匹配';
  return ({
    NO_SHIPMENT_AFTER_FINALITY: '超过时限仍未发货',
    ARBITRATION_REQUIRED: '需要平台仲裁',
    EVIDENCE_VERIFIED: '证据已核实',
    STATE_NOT_ALLOWED: '当前订单状态不允许',
    ROLE_NOT_ALLOWED: '当前角色不允许',
  } as Record<string, string>)[value] ?? value.replaceAll('_', ' ').toLowerCase();
}

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
  decideArbitration,
  decideForcedReceipt,
  decideFulfillmentRequest,
  openArbitration,
  openTakeover,
  recordDelivery,
  recordShipment,
  type PlatformFulfillmentCommandResult,
} from '../coreApi';

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
  const [trackingNumberHash, setTrackingNumberHash] = useState('');
  const [providerReferenceHash, setProviderReferenceHash] = useState('');
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
    providerReferenceHash,
    reasonCode,
    requestId,
    roles,
    trackingNumberHash,
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
    setTrackingNumberHash('');
    setProviderReferenceHash('');
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
        case 'RECORD_SHIPMENT':
          result = await recordShipment(order.orderId, {
            ...base,
            carrierCode: carrierCode.trim(),
            trackingNumberHash: trackingNumberHash.trim(),
            ...(providerReferenceHash.trim() ? { providerReferenceHash: providerReferenceHash.trim() } : {}),
          }, token);
          break;
        case 'RECORD_DELIVERY':
          result = await recordDelivery(order.orderId, base, token);
          break;
        case 'DECIDE_FULFILLMENT_REQUEST':
          result = await decideFulfillmentRequest(order.orderId, {
            ...base,
            requestId,
            approved: decision === 'APPROVE',
            noteCode: noteCode.trim(),
          }, token);
          break;
        case 'OPEN_ARBITRATION':
          result = await openArbitration(order.orderId, { ...base, reasonCode: reasonCode.trim() }, token);
          break;
        case 'DECIDE_ARBITRATION':
          if (!outcome) return;
          result = await decideArbitration(order.orderId, { ...base, outcome, noteCode: noteCode.trim() }, token);
          break;
        case 'OPEN_TAKEOVER':
          result = await openTakeover(order.orderId, { ...base, reasonCode: reasonCode.trim() }, token);
          break;
        case 'DECIDE_FORCED_RECEIPT':
          result = await decideForcedReceipt(order.orderId, {
            ...base,
            approved: decision === 'APPROVE',
            noteCode: noteCode.trim(),
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
        <div><p className="section-kicker">Core order command</p><h3>履约操作台</h3></div>
        <span className={coreAction?.enabled ? 'status-chip status-ready' : 'status-chip status-blocked'}>
          {actionsLoading ? 'Checking' : coreAction?.enabled ? 'Core allowed' : coreAction?.reasonCode ?? 'Not allowed'}
        </span>
      </div>

      <label htmlFor="fulfillment-action">操作</label>
      <select id="fulfillment-action" value={definition.action} onChange={(event) => setActionName(event.target.value as PlatformFulfillmentAction)} disabled={submitting}>
        {definitions.map((item) => {
          const action = actions.find((candidate) => candidate.action === item.action);
          return <option key={item.action} value={item.action}>{item.label} · {action?.enabled ? '可执行' : action?.reasonCode ?? '未授权'}</option>;
        })}
      </select>

      <label htmlFor="fulfillment-evidence">证据哈希 · bytes32</label>
      <input id="fulfillment-evidence" value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" />

      {definition.action === 'RECORD_SHIPMENT' ? (
        <>
          <label htmlFor="fulfillment-carrier">承运商代码</label>
          <input id="fulfillment-carrier" value={carrierCode} onChange={(event) => setCarrierCode(event.target.value.toUpperCase())} autoComplete="off" placeholder="SF" />
          <label htmlFor="fulfillment-tracking">运单号哈希 · bytes32</label>
          <input id="fulfillment-tracking" value={trackingNumberHash} onChange={(event) => setTrackingNumberHash(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" />
          <label htmlFor="fulfillment-provider-reference">Provider reference hash · optional</label>
          <input id="fulfillment-provider-reference" value={providerReferenceHash} onChange={(event) => setProviderReferenceHash(event.target.value)} autoComplete="off" placeholder="0x + 64 hex" />
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
          <label htmlFor="fulfillment-reason">原因代码</label>
          <input id="fulfillment-reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value.toUpperCase())} autoComplete="off" placeholder={definition.action === 'OPEN_TAKEOVER' ? 'NO_SHIPMENT_AFTER_FINALITY' : 'ARBITRATION_REQUIRED'} />
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
          <label htmlFor="fulfillment-note">裁决代码</label>
          <input id="fulfillment-note" value={noteCode} onChange={(event) => setNoteCode(event.target.value.toUpperCase())} autoComplete="off" placeholder="EVIDENCE_VERIFIED" />
        </>
      ) : null}

      <button className="button button-primary button-full" type="submit" disabled={Boolean(disabledReason) || submitting}>
        <PackageCheck aria-hidden="true" /> {submitting ? '提交中' : `执行${definition.label}`}
      </button>
      <p className="button-explanation">{disabledReason ?? '当前平台角色、订单状态与 Core allowedActions 均已授权。'}</p>
      {error ? <div className="resource-state resource-state-error" role="alert"><Ban aria-hidden="true" /><div><strong>{error.code}</strong><p>{error.message}{error.correlationId ? ` · Correlation ${error.correlationId}` : ''}</p></div></div> : null}
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
  providerReferenceHash: string;
  reasonCode: string;
  requestId: string;
  roles: readonly UserRole[];
  trackingNumberHash: string;
}) {
  if (!input.definition.roles.some((role) => input.roles.includes(role))) {
    return `${input.definition.action} 不允许当前平台角色执行。`;
  }
  if (!(input.definition.states as readonly FulfillmentOrder['state'][]).includes(input.order.state)) {
    return `订单状态 ${input.order.state} 不允许 ${input.definition.action}。`;
  }
  if (input.actionsLoading) return '正在读取当前订单 allowedActions。';
  if (!input.action) return `Core 未向当前会话返回 ${input.definition.action}。`;
  if (!input.action.enabled) return `Core 拒绝 ${input.definition.action}：${input.action.reasonCode ?? 'UnknownState'}${input.action.deadline ? ` · ${input.action.deadline}` : ''}`;
  if (!bytes32Pattern.test(input.evidenceHash.trim())) return '请输入 Core 要求的 bytes32 证据哈希。';
  if (input.definition.action === 'RECORD_SHIPMENT') {
    if (!/^[A-Z0-9_-]{2,32}$/.test(input.carrierCode.trim())) return '承运商代码必须为 2—32 位大写字母、数字、下划线或连字符。';
    if (!bytes32Pattern.test(input.trackingNumberHash.trim())) return '请输入 bytes32 运单号哈希。';
    if (input.providerReferenceHash.trim() && !bytes32Pattern.test(input.providerReferenceHash.trim())) return 'Provider reference hash 必须为空或 bytes32。';
  }
  if (input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' && !input.requestId) return '请选择 Core 返回的待处理换货或延期申请。';
  if ((input.definition.action === 'OPEN_ARBITRATION' || input.definition.action === 'OPEN_TAKEOVER') && !reasonCodePattern.test(input.reasonCode.trim())) return '请输入 2—64 位有效原因代码。';
  if (input.definition.action === 'DECIDE_ARBITRATION' && !input.outcome) return '请选择仲裁结果。';
  if ((input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' || input.definition.action === 'DECIDE_FORCED_RECEIPT') && !input.decision) return '请选择批准或拒绝。';
  if ((input.definition.action === 'DECIDE_FULFILLMENT_REQUEST' || input.definition.action === 'DECIDE_ARBITRATION' || input.definition.action === 'DECIDE_FORCED_RECEIPT') && !reasonCodePattern.test(input.noteCode.trim())) return '请输入 2—64 位有效裁决代码。';
  return null;
}

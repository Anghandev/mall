import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  orderProjectionStates,
  takeoverStates,
  type TakeoverAssignment,
  type TakeoverAssignmentRequest,
  type TakeoverAssignmentResult,
  type TakeoverCandidate,
  type TakeoverCandidateList,
  type TakeoverCase,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
  type TakeoverCaseTransition,
  type TakeoverState,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const reasonCodePattern = /^[A-Z0-9_:-]{2,64}$/;

export type TakeoverCaseFilters = Readonly<{
  state?: TakeoverState;
  originalMerchantId?: string;
  replacementMerchantId?: string;
  cursorOpenedAt?: string;
  cursorCaseId?: string;
  limit?: number;
}>;

export async function listAdminTakeoverCases(
  filters: TakeoverCaseFilters,
  token: string,
  signal?: AbortSignal,
): Promise<TakeoverCaseList> {
  const query = takeoverQuery(filters);
  const body = await requestCoreJson(`/v2/admin/takeover-cases?${query}`, authenticated(token, signal));
  if (!isTakeoverCaseList(body)) throw invalidResponse('Takeover case list does not match the coordinated generated type');
  return body;
}

export async function getAdminTakeoverCase(
  caseId: string,
  token: string,
  signal?: AbortSignal,
): Promise<TakeoverCaseDetail> {
  const normalizedCaseId = resourceId(caseId, 'caseId');
  const body = await requestCoreJson(
    `/v2/admin/takeover-cases/${encodeURIComponent(normalizedCaseId)}`,
    authenticated(token, signal),
  );
  if (!isTakeoverCaseDetail(body) || body.case.caseId !== normalizedCaseId) {
    throw invalidResponse('Takeover case detail does not match the coordinated generated type');
  }
  return body;
}

export async function listTakeoverCandidates(
  caseId: string,
  token: string,
  signal?: AbortSignal,
): Promise<TakeoverCandidateList> {
  const normalizedCaseId = resourceId(caseId, 'caseId');
  const body = await requestCoreJson(
    `/v2/admin/takeover-cases/${encodeURIComponent(normalizedCaseId)}/candidates`,
    authenticated(token, signal),
  );
  if (!isTakeoverCandidateList(body) || body.caseId !== normalizedCaseId) {
    throw invalidResponse('Takeover candidate list does not match the coordinated generated type');
  }
  return body;
}

export async function assignTakeoverReplacementMerchant(
  caseId: string,
  input: TakeoverAssignmentRequest,
  token: string,
): Promise<TakeoverAssignmentResult> {
  const normalizedCaseId = resourceId(caseId, 'caseId');
  validateAssignmentRequest(input);
  const body = await requestCoreJson(
    `/v2/admin/takeover-cases/${encodeURIComponent(normalizedCaseId)}/assignments`,
    authenticatedJson(token, input),
  );
  if (!isTakeoverAssignmentResult(body)
    || body.assignment.caseId !== normalizedCaseId
    || body.assignment.replacementMerchantId !== input.replacementMerchantId) {
    throw invalidResponse('Takeover assignment result does not match the coordinated generated type');
  }
  return body;
}

function takeoverQuery(filters: TakeoverCaseFilters) {
  const query = new URLSearchParams();
  if (filters.state !== undefined) {
    if (!takeoverStates.includes(filters.state)) throw invalidRequest('Takeover state filter is invalid');
    query.set('state', filters.state);
  }
  if (filters.originalMerchantId !== undefined) {
    query.set('originalMerchantId', resourceId(filters.originalMerchantId, 'originalMerchantId'));
  }
  if (filters.replacementMerchantId !== undefined) {
    query.set('replacementMerchantId', resourceId(filters.replacementMerchantId, 'replacementMerchantId'));
  }
  if ((filters.cursorOpenedAt === undefined) !== (filters.cursorCaseId === undefined)) {
    throw invalidRequest('Takeover cursor requires openedAt and caseId');
  }
  if (filters.cursorOpenedAt !== undefined && filters.cursorCaseId !== undefined) {
    if (!isCanonicalDate(filters.cursorOpenedAt)) throw invalidRequest('Takeover cursor timestamp is invalid');
    query.set('cursorOpenedAt', filters.cursorOpenedAt);
    query.set('cursorCaseId', resourceId(filters.cursorCaseId, 'cursorCaseId'));
  }
  const limit = filters.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidRequest('Takeover list limit must be 1-100');
  query.set('limit', String(limit));
  return query.toString();
}

function validateAssignmentRequest(input: TakeoverAssignmentRequest) {
  resourceId(input.replacementMerchantId, 'replacementMerchantId');
  if (!reasonCodePattern.test(input.reasonCode)) throw invalidRequest('Assignment reason code is invalid');
  if (!bytes32Pattern.test(input.evidenceHash)) throw invalidRequest('Assignment evidence hash must be bytes32');
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
    throw invalidRequest('Assignment idempotency key must contain 8-128 characters');
  }
}

function isTakeoverCaseList(value: unknown): value is TakeoverCaseList {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && Array.isArray(value.cases)
    && value.cases.every(isTakeoverCase)
    && (value.nextCursor === null || (isRecord(value.nextCursor)
      && isDate(value.nextCursor.openedAt)
      && validResourceId(value.nextCursor.caseId)));
}

function isTakeoverCaseDetail(value: unknown): value is TakeoverCaseDetail {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !isRecord(value.case)
    || !isTakeoverCase(value.case)) return false;
  return Array.isArray(value.case.allowedActions)
    && value.case.allowedActions.every((action: unknown) => isRecord(action)
      && allowedActionNames.includes(action.action as never)
      && typeof action.enabled === 'boolean'
      && (action.reasonCode === undefined || allowedActionReasonCodes.includes(action.reasonCode as never))
      && (action.deadline === undefined || isDate(action.deadline)))
    && Array.isArray(value.assignments)
    && value.assignments.every(isTakeoverAssignment)
    && Array.isArray(value.transitions)
    && value.transitions.every(isTakeoverTransition);
}

function isTakeoverCandidateList(value: unknown): value is TakeoverCandidateList {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && validResourceId(value.caseId)
    && Array.isArray(value.candidates)
    && value.candidates.every(isTakeoverCandidate);
}

function isTakeoverAssignmentResult(value: unknown): value is TakeoverAssignmentResult {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && isTakeoverAssignment(value.assignment);
}

function isTakeoverCase(value: unknown): value is TakeoverCase {
  return isRecord(value)
    && validResourceId(value.caseId)
    && validResourceId(value.orderId)
    && validResourceId(value.originalMerchantId)
    && amountPattern.test(String(value.policyVersion))
    && takeoverStates.includes(value.state as never)
    && (value.requiredUsdt === null || amountPattern.test(String(value.requiredUsdt)))
    && isFunding(value.funding)
    && bytes32Pattern.test(String(value.evidenceHash))
    && isDate(value.openedAt)
    && (value.closedAt === null || isDate(value.closedAt))
    && isDate(value.updatedAt)
    && isRecord(value.order)
    && validResourceId(value.order.productId)
    && validResourceId(value.order.skuId)
    && amountPattern.test(String(value.order.quantity))
    && (value.order.fulfillmentMode === 'DELIVERY' || value.order.fulfillmentMode === 'PICKUP')
    && bytes32Pattern.test(String(value.order.fulfillmentTargetHash))
    && orderProjectionStates.includes(value.order.state as never)
    && typeof value.order.paymentFinal === 'boolean'
    && (value.currentAssignment === null || isTakeoverAssignment(value.currentAssignment));
}

function isFunding(value: unknown) {
  return isRecord(value) && [
    'guaranteeUsedUsdt',
    'frozenReceivablesUsedUsdt',
    'futureProceedsUsedUsdt',
    'platformAdvanceUsdt',
    'disbursedUsdt',
    'merchantDebtUsdt',
  ].every((field) => amountPattern.test(String(value[field])));
}

function isTakeoverAssignment(value: unknown): value is TakeoverAssignment {
  return isRecord(value)
    && bytes32Pattern.test(String(value.assignmentId))
    && validResourceId(value.caseId)
    && validResourceId(value.orderId)
    && Number.isSafeInteger(value.version)
    && Number(value.version) >= 1
    && validResourceId(value.originalMerchantId)
    && validResourceId(value.replacementMerchantId)
    && addressPattern.test(String(value.replacementWallet))
    && Number.isSafeInteger(value.replacementApplicationVersion)
    && Number(value.replacementApplicationVersion) >= 1
    && bytes32Pattern.test(String(value.replacementLicenseAssetId))
    && (value.supersedesAssignmentId === null || bytes32Pattern.test(String(value.supersedesAssignmentId)))
    && reasonCodePattern.test(String(value.reasonCode))
    && bytes32Pattern.test(String(value.evidenceHash))
    && addressPattern.test(String(value.assignedBy))
    && typeof value.correlationId === 'string'
    && value.correlationId.length >= 1
    && isDate(value.assignedAt);
}

function isTakeoverCandidate(value: unknown): value is TakeoverCandidate {
  return isRecord(value)
    && validResourceId(value.merchantId)
    && addressPattern.test(String(value.settlementWallet))
    && typeof value.shopName === 'string'
    && value.shopName.length >= 1
    && Number.isSafeInteger(value.applicationVersion)
    && Number(value.applicationVersion) >= 1
    && value.qualificationComplete === true
    && (value.guaranteeReady === undefined || typeof value.guaranteeReady === 'boolean');
}

function isTakeoverTransition(value: unknown): value is TakeoverCaseTransition {
  return isRecord(value)
    && validResourceId(value.transitionId)
    && (value.fromState === null || takeoverStates.includes(value.fromState as never))
    && takeoverStates.includes(value.toState as never)
    && typeof value.evidenceType === 'string'
    && value.evidenceType.length >= 1
    && bytes32Pattern.test(String(value.evidenceHash))
    && isDate(value.occurredAt);
}

function authenticated(token: string, signal?: AbortSignal): RequestInit {
  return { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) };
}

function authenticatedJson(token: string, body: object): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  };
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!validResourceId(normalized)) throw invalidRequest(`${field} must contain 1-256 characters`);
  return normalized;
}

function validResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function isCanonicalDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string) {
  return new CoreApiError({ code: 'InvalidRequest', message, status: 400 });
}

function invalidResponse(message: string) {
  return new CoreApiError({ code: 'InvalidResponse', message, status: 502 });
}

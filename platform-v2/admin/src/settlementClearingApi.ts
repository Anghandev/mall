import {
  artifactVersion,
  breakerScopes,
  finalityStates,
  settlementBatchStates,
  settlementRails,
  settlementRequestStates,
  type AdminSettlementApproval,
  type AdminSettlementAttempt,
  type AdminSettlementBatch,
  type AdminSettlementBatchDetail,
  type AdminSettlementBatchList,
  type AdminSettlementBreaker,
  type AdminSettlementCoverage,
  type AdminSettlementFinality,
  type AdminSettlementLedgerMovement,
  type AdminSettlementRequest,
  type AdminSettlementRequestDetail,
  type AdminSettlementRequestList,
  type SettlementBatchState,
  type SettlementRequestState,
  type PaymentProjection,
  type SettlementRail,
} from '@abu24k/core-artifacts';
import { CoreApiError, fetchAdminPaymentProjection, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})+$/;
const assets = ['USDT', 'NPL'] as const;

export type SettlementAsset = typeof assets[number];
export type AdminSettlementRequestFilters = Readonly<{
  requestId?: string | undefined;
  merchantId?: string | undefined;
  walletAddress?: string | undefined;
  orderId?: string | undefined;
  batchId?: string | undefined;
  safeTxHash?: string | undefined;
  rail?: SettlementRail | undefined;
  asset?: SettlementAsset | undefined;
  state?: SettlementRequestState | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursorRequestedAt?: string | undefined;
  cursorRequestId?: string | undefined;
  limit?: number | undefined;
}>;

export type AdminSettlementBatchFilters = Readonly<{
  batchId?: string | undefined;
  merchantId?: string | undefined;
  orderId?: string | undefined;
  safeAddress?: string | undefined;
  safeTxHash?: string | undefined;
  asset?: SettlementAsset | undefined;
  state?: SettlementBatchState | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursorCreatedAt?: string | undefined;
  cursorBatchId?: string | undefined;
  limit?: number | undefined;
}>;

export { settlementBatchStates, settlementRails, settlementRequestStates };

export function fetchGlobalPaymentTrace(
  orderId: string,
  token: string,
  signal?: AbortSignal,
): Promise<PaymentProjection> {
  return fetchAdminPaymentProjection(orderId, token, signal);
}

export async function fetchAdminSettlementRequests(
  filters: AdminSettlementRequestFilters,
  token: string,
  signal?: AbortSignal,
): Promise<AdminSettlementRequestList> {
  const body = await authenticatedGet(`/v2/admin/settlement-requests?${requestQuery(filters)}`, token, signal);
  if (!isRequestList(body)) throw invalid('Admin settlement request list does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementRequest(
  requestId: string,
  token: string,
  signal?: AbortSignal,
): Promise<AdminSettlementRequestDetail> {
  requireBytes32(requestId, 'requestId');
  const body = await authenticatedGet(`/v2/admin/settlement-requests/${encodeURIComponent(requestId)}`, token, signal);
  if (!isRequestDetail(body)) throw invalid('Admin settlement request detail does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementBatches(
  filters: AdminSettlementBatchFilters,
  token: string,
  signal?: AbortSignal,
): Promise<AdminSettlementBatchList> {
  const body = await authenticatedGet(`/v2/admin/settlement-batches?${batchQuery(filters)}`, token, signal);
  if (!isBatchList(body)) throw invalid('Admin settlement batch list does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementBatch(
  batchId: string,
  token: string,
  signal?: AbortSignal,
): Promise<AdminSettlementBatchDetail> {
  requireBytes32(batchId, 'batchId');
  const body = await authenticatedGet(`/v2/admin/settlement-batches/${encodeURIComponent(batchId)}`, token, signal);
  if (!isBatchDetail(body)) throw invalid('Admin settlement batch detail does not match generated OpenAPI');
  return body;
}

function requestQuery(filters: AdminSettlementRequestFilters) {
  validateLimit(filters.limit);
  const query = new URLSearchParams({ limit: String(filters.limit ?? 25) });
  appendHash(query, 'requestId', filters.requestId);
  appendText(query, 'merchantId', filters.merchantId);
  appendAddress(query, 'walletAddress', filters.walletAddress);
  appendHash(query, 'orderId', filters.orderId);
  appendHash(query, 'batchId', filters.batchId);
  appendHash(query, 'safeTxHash', filters.safeTxHash);
  appendEnum(query, 'rail', filters.rail, settlementRails);
  appendEnum(query, 'asset', filters.asset, assets);
  appendEnum(query, 'state', filters.state, settlementRequestStates);
  appendDate(query, 'from', filters.from);
  appendDate(query, 'to', filters.to);
  appendDate(query, 'cursorRequestedAt', filters.cursorRequestedAt);
  appendHash(query, 'cursorRequestId', filters.cursorRequestId);
  requireCompleteCursor(filters.cursorRequestedAt, filters.cursorRequestId, 'request');
  return query.toString();
}

function batchQuery(filters: AdminSettlementBatchFilters) {
  validateLimit(filters.limit);
  const query = new URLSearchParams({ limit: String(filters.limit ?? 25) });
  appendHash(query, 'batchId', filters.batchId);
  appendText(query, 'merchantId', filters.merchantId);
  appendHash(query, 'orderId', filters.orderId);
  appendAddress(query, 'safeAddress', filters.safeAddress);
  appendHash(query, 'safeTxHash', filters.safeTxHash);
  appendEnum(query, 'asset', filters.asset, assets);
  appendEnum(query, 'state', filters.state, settlementBatchStates);
  appendDate(query, 'from', filters.from);
  appendDate(query, 'to', filters.to);
  appendDate(query, 'cursorCreatedAt', filters.cursorCreatedAt);
  appendHash(query, 'cursorBatchId', filters.cursorBatchId);
  requireCompleteCursor(filters.cursorCreatedAt, filters.cursorBatchId, 'batch');
  return query.toString();
}

const requestKeys = [
  'requestId', 'merchantId', 'walletAddress', 'recipientAddress', 'rail', 'asset',
  'safeAddress', 'amount', 'state', 'batchId', 'intentDigest', 'signatureHash',
  'finalSafeTxHash', 'finalExecutionTxHash', 'itemCount', 'requestedAt', 'batchedAt', 'settledAt',
] as const satisfies readonly (keyof AdminSettlementRequest)[];
const batchKeys = [
  'batchId', 'asset', 'safeAddress', 'safeNonce', 'itemCount', 'totalAmount', 'contentHash',
  'safeTxHash', 'state', 'approvalThreshold', 'approvalCount', 'createdBy', 'createdAt',
  'approvedAt', 'submittedAt', 'settledAt',
] as const satisfies readonly (keyof AdminSettlementBatch)[];
const batchEnvelopeKeys = [
  ...batchKeys, 'chainId', 'assetAddress', 'safeVersion', 'safeSingletonAddress',
  'safeSingletonCodeHash', 'ownerSetHash', 'safeRuntimeEvidenceHash', 'safeRuntimeCheckedAt',
  'multisendAddress', 'multisendCodeHash', 'tokenCodeHash',
  'tokenTransferConformanceEvidenceHash', 'itemsHash', 'multisendTransactions',
  'multisendCalldata', 'safeTxData', 'proposalReferenceHash', 'approvalEvidenceHash',
] as const;

function isRequestList(value: unknown): value is AdminSettlementRequestList {
  return isRecord(value)
    && exactKeys(value, ['artifactVersion', 'requests', 'nextCursor'])
    && value.artifactVersion === artifactVersion
    && Array.isArray(value.requests)
    && value.requests.every(isRequest)
    && (value.nextCursor === null || (isRecord(value.nextCursor)
      && exactKeys(value.nextCursor, ['requestedAt', 'requestId'])
      && isDateTime(value.nextCursor.requestedAt)
      && isBytes32(value.nextCursor.requestId)));
}

function isRequest(value: unknown): value is AdminSettlementRequest {
  return isRecord(value)
    && exactKeys(value, requestKeys)
    && isBytes32(value.requestId)
    && nullableNonEmpty(value.merchantId)
    && isAddress(value.walletAddress)
    && isAddress(value.recipientAddress)
    && settlementRails.includes(value.rail as SettlementRail)
    && assets.includes(value.asset as SettlementAsset)
    && isAddress(value.safeAddress)
    && isAmount(value.amount)
    && settlementRequestStates.includes(value.state as SettlementRequestState)
    && nullableBytes32(value.batchId)
    && isBytes32(value.intentDigest)
    && isBytes32(value.signatureHash)
    && nullableBytes32(value.finalSafeTxHash)
    && nullableBytes32(value.finalExecutionTxHash)
    && isInteger(value.itemCount, 1)
    && isDateTime(value.requestedAt)
    && nullableDateTime(value.batchedAt)
    && nullableDateTime(value.settledAt);
}

function isRequestDetail(value: unknown): value is AdminSettlementRequestDetail {
  return isRecord(value)
    && exactKeys(value, ['artifactVersion', 'request', 'items', 'transitions'])
    && value.artifactVersion === artifactVersion
    && isRequest(value.request)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item)
      && exactKeys(item, ['itemIndex', 'orderId', 'accountId', 'backingSafeAddress', 'amount', 'itemHash', 'policyVersion', 'journals'])
      && isInteger(item.itemIndex, 0)
      && isBytes32(item.orderId)
      && isNonEmpty(item.accountId)
      && isAddress(item.backingSafeAddress)
      && isAmount(item.amount)
      && isBytes32(item.itemHash)
      && isAmount(item.policyVersion)
      && isRecord(item.journals)
      && exactKeys(item.journals, ['requested', 'batched', 'settled'])
      && isNonEmpty(item.journals.requested)
      && nullableNonEmpty(item.journals.batched)
      && nullableNonEmpty(item.journals.settled))
    && Array.isArray(value.transitions)
    && value.transitions.every((item) => isRecord(item)
      && exactKeys(item, ['transitionId', 'requestItemIndex', 'batchId', 'sequence', 'type', 'journalId', 'createdAt'])
      && isNonEmpty(item.transitionId)
      && isInteger(item.requestItemIndex, 0)
      && nullableBytes32(item.batchId)
      && isInteger(item.sequence, 1)
      && ['REQUESTED', 'BATCHED', 'SETTLED', 'BATCH_REVERSED', 'FINALITY_REVERSED'].includes(String(item.type))
      && isNonEmpty(item.journalId)
      && isDateTime(item.createdAt));
}

function isBatchList(value: unknown): value is AdminSettlementBatchList {
  return isRecord(value)
    && exactKeys(value, ['artifactVersion', 'batches', 'nextCursor'])
    && value.artifactVersion === artifactVersion
    && Array.isArray(value.batches)
    && value.batches.every(isBatch)
    && (value.nextCursor === null || (isRecord(value.nextCursor)
      && exactKeys(value.nextCursor, ['createdAt', 'batchId'])
      && isDateTime(value.nextCursor.createdAt)
      && isBytes32(value.nextCursor.batchId)));
}

function isBatch(value: unknown): value is AdminSettlementBatch {
  return isRecord(value)
    && exactKeys(value, batchKeys)
    && isBatchFields(value);
}

function isBatchFields(value: Record<string, unknown>) {
  return isBytes32(value.batchId)
    && assets.includes(value.asset as SettlementAsset)
    && isAddress(value.safeAddress)
    && isAmount(value.safeNonce)
    && isInteger(value.itemCount, 1, 256)
    && isAmount(value.totalAmount)
    && isBytes32(value.contentHash)
    && isBytes32(value.safeTxHash)
    && settlementBatchStates.includes(value.state as SettlementBatchState)
    && isInteger(value.approvalThreshold, 1)
    && isInteger(value.approvalCount, 0)
    && isAddress(value.createdBy)
    && isDateTime(value.createdAt)
    && nullableDateTime(value.approvedAt)
    && nullableDateTime(value.submittedAt)
    && nullableDateTime(value.settledAt);
}

function isBatchDetail(value: unknown): value is AdminSettlementBatchDetail {
  if (!isRecord(value) || !exactKeys(value, [
    'artifactVersion', 'batch', 'items', 'approvals', 'attempts', 'finality',
    'coverage', 'breakers', 'reconciliation',
  ]) || value.artifactVersion !== artifactVersion || !isBatchEnvelope(value.batch)) return false;
  return Array.isArray(value.items) && value.items.every(isBatchItem)
    && Array.isArray(value.approvals) && value.approvals.every(isApproval)
    && Array.isArray(value.attempts) && value.attempts.every(isAttempt)
    && (value.finality === null || isFinality(value.finality))
    && (value.coverage === null || isCoverage(value.coverage))
    && Array.isArray(value.breakers) && value.breakers.every(isBreaker)
    && isReconciliation(value.reconciliation);
}

function isBatchEnvelope(value: unknown) {
  return isRecord(value)
    && exactKeys(value, batchEnvelopeKeys)
    && isBatchFields(value)
    && value.chainId === 56
    && isAddress(value.assetAddress)
    && isNonEmpty(value.safeVersion)
    && isAddress(value.safeSingletonAddress)
    && isBytes32(value.safeSingletonCodeHash)
    && isBytes32(value.ownerSetHash)
    && isBytes32(value.safeRuntimeEvidenceHash)
    && isDateTime(value.safeRuntimeCheckedAt)
    && isAddress(value.multisendAddress)
    && isBytes32(value.multisendCodeHash)
    && isBytes32(value.tokenCodeHash)
    && isBytes32(value.tokenTransferConformanceEvidenceHash)
    && isBytes32(value.itemsHash)
    && isHexData(value.multisendTransactions)
    && isHexData(value.multisendCalldata)
    && isHexData(value.safeTxData)
    && nullableBytes32(value.proposalReferenceHash)
    && nullableBytes32(value.approvalEvidenceHash);
}

function isBatchItem(value: unknown) {
  return isRecord(value)
    && exactKeys(value, ['itemIndex', 'requestId', 'requestItemIndex', 'orderId', 'merchantId', 'accountId', 'recipientAddress', 'tokenAddress', 'amount', 'transferCalldata', 'itemHash'])
    && isInteger(value.itemIndex, 0)
    && isBytes32(value.requestId)
    && isInteger(value.requestItemIndex, 0)
    && isBytes32(value.orderId)
    && nullableNonEmpty(value.merchantId)
    && isNonEmpty(value.accountId)
    && isAddress(value.recipientAddress)
    && isAddress(value.tokenAddress)
    && isAmount(value.amount)
    && isHexData(value.transferCalldata)
    && isBytes32(value.itemHash);
}

function isApproval(value: unknown): value is AdminSettlementApproval {
  return isRecord(value)
    && exactKeys(value, ['ownerAddress', 'safeTxHash', 'signatureHash', 'approvedAt'])
    && isAddress(value.ownerAddress)
    && isBytes32(value.safeTxHash)
    && isBytes32(value.signatureHash)
    && isDateTime(value.approvedAt);
}

function isAttempt(value: unknown): value is AdminSettlementAttempt {
  return isRecord(value)
    && exactKeys(value, ['attemptId', 'attemptNumber', 'requestDigest', 'safeTxHash', 'executionTxHash', 'outerSender', 'outerNonce', 'replacementForAttemptId', 'state', 'createdAt', 'submittedAt', 'updatedAt'])
    && isNonEmpty(value.attemptId)
    && isInteger(value.attemptNumber, 1)
    && isBytes32(value.requestDigest)
    && isBytes32(value.safeTxHash)
    && nullableBytes32(value.executionTxHash)
    && nullableAddress(value.outerSender)
    && (value.outerNonce === null || isAmount(value.outerNonce))
    && nullableNonEmpty(value.replacementForAttemptId)
    && ['LEASED', 'SUBMITTED', 'MINED', 'SETTLED', 'REPLACED', 'FAILED', 'REORGED', 'QUARANTINED'].includes(String(value.state))
    && isDateTime(value.createdAt)
    && nullableDateTime(value.submittedAt)
    && isDateTime(value.updatedAt);
}

function isFinality(value: unknown): value is AdminSettlementFinality {
  if (!isRecord(value) || !exactKeys(value, [
    'transactionId', 'expectedEventHash', 'executionTxHash', 'replacementForTxHash',
    'receiptStatus', 'blockNumber', 'blockHash', 'confirmations', 'requiredConfirmations',
    'state', 'evidence', 'submittedAt', 'finalizedAt', 'updatedAt',
  ])) return false;
  if (
    !isNonEmpty(value.transactionId)
      || !isBytes32(value.expectedEventHash)
      || !isBytes32(value.executionTxHash)
      || !nullableBytes32(value.replacementForTxHash)
      || ![null, 0, 1].includes(value.receiptStatus as null | number)
      || (value.blockNumber !== null && !isAmount(value.blockNumber))
      || !nullableBytes32(value.blockHash)
      || !isInteger(value.confirmations, 0)
      || value.requiredConfirmations !== 15
      || !finalityStates.includes(value.state as never)
      || !isRecord(value.evidence)
      || !isDateTime(value.submittedAt)
      || !nullableDateTime(value.finalizedAt)
      || !isDateTime(value.updatedAt)
  ) return false;
  if (value.state === 'FINAL') return Number(value.confirmations) >= 15 && value.receiptStatus === 1 && value.finalizedAt !== null;
  if (value.state === 'MINED') return Number(value.confirmations) < 15 && value.finalizedAt === null;
  return true;
}

function isCoverage(value: unknown): value is AdminSettlementCoverage {
  return isRecord(value)
    && exactKeys(value, ['snapshotId', 'blockNumber', 'blockHash', 'evidenceHash', 'recordedAt', 'safeAddress', 'asset', 'verifiedAssets', 'unsettledLiabilities', 'covered'])
    && isNonEmpty(value.snapshotId)
    && isAmount(value.blockNumber)
    && isBytes32(value.blockHash)
    && isBytes32(value.evidenceHash)
    && isDateTime(value.recordedAt)
    && isAddress(value.safeAddress)
    && assets.includes(value.asset as SettlementAsset)
    && isAmount(value.verifiedAssets)
    && isAmount(value.unsettledLiabilities)
    && typeof value.covered === 'boolean';
}

function isBreaker(value: unknown): value is AdminSettlementBreaker {
  return isRecord(value)
    && exactKeys(value, ['scope', 'paused', 'evidenceHash', 'policyVersion', 'changedBy', 'changedAt'])
    && breakerScopes.includes(value.scope as never)
    && typeof value.paused === 'boolean'
    && isBytes32(value.evidenceHash)
    && (value.policyVersion === null || isAmount(value.policyVersion))
    && isNonEmpty(value.changedBy)
    && isDateTime(value.changedAt);
}

function isReconciliation(value: unknown) {
  return isRecord(value)
    && exactKeys(value, ['expectedItemCount', 'actualItemCount', 'expectedTotalAmount', 'actualTotalAmount', 'ledgerMovements', 'conserved'])
    && isInteger(value.expectedItemCount, 1)
    && isInteger(value.actualItemCount, 0)
    && isAmount(value.expectedTotalAmount)
    && isAmount(value.actualTotalAmount)
    && Array.isArray(value.ledgerMovements)
    && value.ledgerMovements.every(isLedgerMovement)
    && typeof value.conserved === 'boolean';
}

function isLedgerMovement(value: unknown): value is AdminSettlementLedgerMovement {
  return isRecord(value)
    && exactKeys(value, ['eventType', 'asset', 'debits', 'credits', 'balanced'])
    && isNonEmpty(value.eventType)
    && assets.includes(value.asset as SettlementAsset)
    && isAmount(value.debits)
    && isAmount(value.credits)
    && typeof value.balanced === 'boolean';
}

function appendHash(query: URLSearchParams, name: string, value: string | undefined) {
  if (value === undefined || value === '') return;
  requireBytes32(value, name);
  query.set(name, value);
}

function appendAddress(query: URLSearchParams, name: string, value: string | undefined) {
  if (value === undefined || value === '') return;
  if (!addressPattern.test(value)) throw invalidInput(`${name} must be an address`);
  query.set(name, value);
}

function appendText(query: URLSearchParams, name: string, value: string | undefined) {
  if (value === undefined || value === '') return;
  const trimmed = value.trim();
  if (!trimmed) throw invalidInput(`${name} must not be blank`);
  query.set(name, trimmed);
}

function appendDate(query: URLSearchParams, name: string, value: string | undefined) {
  if (value === undefined || value === '') return;
  if (!isDateTime(value)) throw invalidInput(`${name} must be an ISO date-time`);
  query.set(name, value);
}

function appendEnum<Value extends string>(
  query: URLSearchParams,
  name: string,
  value: Value | undefined,
  allowed: readonly Value[],
) {
  if (value === undefined) return;
  if (!allowed.includes(value)) throw invalidInput(`${name} is not a generated enum value`);
  query.set(name, value);
}

function requireCompleteCursor(first: string | undefined, second: string | undefined, label: string) {
  if (Boolean(first) !== Boolean(second)) throw invalidInput(`${label} cursor requires both fields`);
}

function validateLimit(limit: number | undefined) {
  if (limit !== undefined && !isInteger(limit, 1, 100)) throw invalidInput('limit must be an integer between 1 and 100');
}

function requireBytes32(value: string, name: string) {
  if (!bytes32Pattern.test(value)) throw invalidInput(`${name} must be bytes32`);
}

function authenticatedGet(path: string, token: string, signal?: AbortSignal) {
  return requestCoreJson(path, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableNonEmpty(value: unknown) {
  return value === null || isNonEmpty(value);
}

function isBytes32(value: unknown) {
  return bytes32Pattern.test(String(value));
}

function nullableBytes32(value: unknown) {
  return value === null || isBytes32(value);
}

function isAddress(value: unknown) {
  return addressPattern.test(String(value));
}

function nullableAddress(value: unknown) {
  return value === null || isAddress(value);
}

function isAmount(value: unknown) {
  return amountPattern.test(String(value));
}

function isHexData(value: unknown) {
  return hexDataPattern.test(String(value));
}

function isInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableDateTime(value: unknown) {
  return value === null || isDateTime(value);
}

function invalidInput(message: string) {
  return new CoreApiError({ code: 'InvalidRequest', message, status: 400 });
}

function invalid(message: string) {
  return new CoreApiError({ code: 'InvalidResponse', message, status: 502 });
}

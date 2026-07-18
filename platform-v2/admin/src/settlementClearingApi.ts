import {
  artifactVersion,
  breakerScopes,
  finalityStates,
  settlementRails,
  settlementRequestStates,
  settlementTransferStates,
  type AdminSettlementRequestDetail,
  type AdminSettlementRequestList,
  type AdminSettlementTransferDetail,
  type AdminSettlementTransferList,
  type PaymentProjection,
  type SettlementRail,
  type SettlementRequestState,
  type SettlementTransferState,
} from '@abu24k/core-artifacts';
import { CoreApiError, fetchAdminPaymentProjection, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})+$/;
const assets = ['USDT', 'NPL'] as const;
export type SettlementAsset = typeof assets[number];

export type AdminSettlementRequestFilters = Readonly<{
  requestId?: string | undefined; merchantId?: string | undefined; walletAddress?: string | undefined; orderId?: string | undefined;
  transferId?: string | undefined; executionTxHash?: string | undefined; rail?: SettlementRail | undefined; asset?: SettlementAsset | undefined;
  state?: SettlementRequestState | undefined; from?: string | undefined; to?: string | undefined; cursorRequestedAt?: string | undefined;
  cursorRequestId?: string | undefined; limit?: number | undefined;
}>;

export type AdminSettlementTransferFilters = Readonly<{
  transferId?: string | undefined; merchantId?: string | undefined; orderId?: string | undefined; executorWallet?: string | undefined;
  executionTxHash?: string | undefined; asset?: SettlementAsset | undefined; state?: SettlementTransferState | undefined;
  from?: string | undefined; to?: string | undefined; cursorCreatedAt?: string | undefined; cursorTransferId?: string | undefined; limit?: number | undefined;
}>;

export { settlementRails, settlementRequestStates, settlementTransferStates };

export function fetchGlobalPaymentTrace(orderId: string, token: string, signal?: AbortSignal): Promise<PaymentProjection> {
  return fetchAdminPaymentProjection(orderId, token, signal);
}

export async function fetchAdminSettlementRequests(filters: AdminSettlementRequestFilters, token: string, signal?: AbortSignal): Promise<AdminSettlementRequestList> {
  const body = await authenticatedGet(`/v2/admin/settlement-requests?${requestQuery(filters)}`, token, signal);
  if (!isRequestList(body)) throw invalid('Admin settlement request list does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementRequest(requestId: string, token: string, signal?: AbortSignal): Promise<AdminSettlementRequestDetail> {
  requireHash(requestId, 'requestId');
  const body = await authenticatedGet(`/v2/admin/settlement-requests/${encodeURIComponent(requestId)}`, token, signal);
  if (!isRequestDetail(body)) throw invalid('Admin settlement request detail does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementTransfers(filters: AdminSettlementTransferFilters, token: string, signal?: AbortSignal): Promise<AdminSettlementTransferList> {
  const body = await authenticatedGet(`/v2/admin/settlement-transfers?${transferQuery(filters)}`, token, signal);
  if (!isTransferList(body)) throw invalid('Admin settlement transfer list does not match generated OpenAPI');
  return body;
}

export async function fetchAdminSettlementTransfer(transferId: string, token: string, signal?: AbortSignal): Promise<AdminSettlementTransferDetail> {
  requireHash(transferId, 'transferId');
  const body = await authenticatedGet(`/v2/admin/settlement-transfers/${encodeURIComponent(transferId)}`, token, signal);
  if (!isTransferDetail(body)) throw invalid('Admin settlement transfer detail does not match generated OpenAPI');
  return body;
}

function requestQuery(filters: AdminSettlementRequestFilters) {
  const query = baseQuery(filters.limit);
  appendHash(query, 'requestId', filters.requestId); appendText(query, 'merchantId', filters.merchantId);
  appendAddress(query, 'walletAddress', filters.walletAddress); appendHash(query, 'orderId', filters.orderId);
  appendHash(query, 'transferId', filters.transferId); appendHash(query, 'executionTxHash', filters.executionTxHash);
  appendEnum(query, 'rail', filters.rail, settlementRails); appendEnum(query, 'asset', filters.asset, assets);
  appendEnum(query, 'state', filters.state, settlementRequestStates); appendDates(query, filters.from, filters.to);
  appendDate(query, 'cursorRequestedAt', filters.cursorRequestedAt); appendHash(query, 'cursorRequestId', filters.cursorRequestId);
  requireCompleteCursor(filters.cursorRequestedAt, filters.cursorRequestId);
  return query.toString();
}

function transferQuery(filters: AdminSettlementTransferFilters) {
  const query = baseQuery(filters.limit);
  appendHash(query, 'transferId', filters.transferId); appendText(query, 'merchantId', filters.merchantId);
  appendHash(query, 'orderId', filters.orderId); appendAddress(query, 'executorWallet', filters.executorWallet);
  appendHash(query, 'executionTxHash', filters.executionTxHash); appendEnum(query, 'asset', filters.asset, assets);
  appendEnum(query, 'state', filters.state, settlementTransferStates); appendDates(query, filters.from, filters.to);
  appendDate(query, 'cursorCreatedAt', filters.cursorCreatedAt); appendHash(query, 'cursorTransferId', filters.cursorTransferId);
  requireCompleteCursor(filters.cursorCreatedAt, filters.cursorTransferId);
  return query.toString();
}

function isRequestList(value: unknown): value is AdminSettlementRequestList {
  return isRecord(value) && exact(value, ['artifactVersion', 'requests', 'nextCursor'])
    && value.artifactVersion === artifactVersion && Array.isArray(value.requests) && value.requests.every(isRequest)
    && (value.nextCursor === null || (isRecord(value.nextCursor) && exact(value.nextCursor, ['requestedAt', 'requestId']) && isDate(value.nextCursor.requestedAt) && isHash(value.nextCursor.requestId)));
}

function isRequest(value: unknown) {
  return isRecord(value) && exact(value, ['requestId','merchantId','walletAddress','recipientAddress','rail','asset','executorWallet','amount','state','transferIds','intentDigest','signatureHash','finalExecutionTxHashes','itemCount','requestedAt','submittedAt','settledAt'])
    && isHash(value.requestId) && (value.merchantId === null || isText(value.merchantId)) && isAddress(value.walletAddress)
    && isAddress(value.recipientAddress) && settlementRails.includes(value.rail as SettlementRail) && assets.includes(value.asset as SettlementAsset)
    && isAddress(value.executorWallet) && isAmount(value.amount) && settlementRequestStates.includes(value.state as SettlementRequestState)
    && isHashArray(value.transferIds) && isHash(value.intentDigest) && isHash(value.signatureHash) && isHashArray(value.finalExecutionTxHashes)
    && isInteger(value.itemCount, 1) && isDate(value.requestedAt) && nullableDate(value.submittedAt) && nullableDate(value.settledAt);
}

function isRequestDetail(value: unknown): value is AdminSettlementRequestDetail {
  return isRecord(value) && exact(value, ['artifactVersion','request','items','transitions']) && value.artifactVersion === artifactVersion
    && isRequest(value.request) && Array.isArray(value.items) && value.items.every((item) => isRecord(item)
      && exact(item, ['itemIndex','orderId','accountId','backingWalletAddress','amount','itemHash','policyVersion','journals'])
      && isInteger(item.itemIndex, 0) && isHash(item.orderId) && isText(item.accountId) && isAddress(item.backingWalletAddress)
      && isAmount(item.amount) && isHash(item.itemHash) && isAmount(item.policyVersion) && isRecord(item.journals)
      && exact(item.journals, ['requested','submitted','settled']) && isText(item.journals.requested)
      && nullableText(item.journals.submitted) && nullableText(item.journals.settled))
    && Array.isArray(value.transitions) && value.transitions.every((item) => isRecord(item)
      && exact(item, ['transitionId','requestItemIndex','transferId','sequence','type','journalId','createdAt'])
      && isText(item.transitionId) && isInteger(item.requestItemIndex, 0) && (item.transferId === null || isHash(item.transferId))
      && isInteger(item.sequence, 1) && ['REQUESTED','SUBMITTED','SETTLED','EXECUTION_REVERSED','FINALITY_REVERSED'].includes(String(item.type))
      && isText(item.journalId) && isDate(item.createdAt));
}

const transferKeys = ['transferId','asset','executorWallet','executorNonce','requestId','requestItemIndex','orderId','accountId','recipientAddress','tokenAddress','amount','transferCalldata','contentHash','gasCap','executionTxHash','state','createdBy','createdAt','submittedAt','settledAt'] as const;
function isTransfer(value: unknown) {
  return isRecord(value) && exact(value, transferKeys) && isTransferFields(value);
}

function isTransferFields(value: Record<string, unknown>) {
  return isHash(value.transferId) && assets.includes(value.asset as SettlementAsset) && isAddress(value.executorWallet) && isAmount(value.executorNonce)
    && isHash(value.requestId) && isInteger(value.requestItemIndex, 0) && isHash(value.orderId) && isText(value.accountId)
    && isAddress(value.recipientAddress) && isAddress(value.tokenAddress) && isAmount(value.amount) && isHex(value.transferCalldata)
    && isHash(value.contentHash) && isAmount(value.gasCap) && (value.executionTxHash === null || isHash(value.executionTxHash))
    && settlementTransferStates.includes(value.state as SettlementTransferState) && isAddress(value.createdBy)
    && isDate(value.createdAt) && nullableDate(value.submittedAt) && nullableDate(value.settledAt);
}

function isTransferList(value: unknown): value is AdminSettlementTransferList {
  return isRecord(value) && exact(value, ['artifactVersion','transfers','nextCursor']) && value.artifactVersion === artifactVersion
    && Array.isArray(value.transfers) && value.transfers.every(isTransfer)
    && (value.nextCursor === null || (isRecord(value.nextCursor) && exact(value.nextCursor, ['createdAt','transferId']) && isDate(value.nextCursor.createdAt) && isHash(value.nextCursor.transferId)));
}

function isTransferDetail(value: unknown): value is AdminSettlementTransferDetail {
  return isRecord(value) && exact(value, ['artifactVersion','transfer','attempts','finality','coverage','breakers','reconciliation'])
    && value.artifactVersion === artifactVersion && isRecord(value.transfer) && isTransferFields(value.transfer)
    && exact(value.transfer, [...transferKeys,'chainId','artifactVersion','tokenCodeHash','tokenTransferConformanceEvidenceHash','runtimeEvidenceHash','runtimeCheckedAt'])
    && value.transfer.chainId === 56 && value.transfer.artifactVersion === artifactVersion && isHash(value.transfer.tokenCodeHash)
    && isHash(value.transfer.tokenTransferConformanceEvidenceHash) && isHash(value.transfer.runtimeEvidenceHash) && isDate(value.transfer.runtimeCheckedAt)
    && Array.isArray(value.attempts) && value.attempts.every(isAttempt)
    && (value.finality === null || isFinality(value.finality)) && (value.coverage === null || isCoverage(value.coverage))
    && Array.isArray(value.breakers) && value.breakers.every((item) => isRecord(item) && breakerScopes.includes(item.scope as never) && typeof item.paused === 'boolean' && isHash(item.evidenceHash) && (item.policyVersion === null || isAmount(item.policyVersion)) && isText(item.changedBy) && isDate(item.changedAt))
    && isRecord(value.reconciliation) && isInteger(value.reconciliation.expectedItemCount, 1) && isInteger(value.reconciliation.actualItemCount, 0)
    && isAmount(value.reconciliation.expectedTotalAmount) && isAmount(value.reconciliation.actualTotalAmount)
    && Array.isArray(value.reconciliation.ledgerMovements) && value.reconciliation.ledgerMovements.every((item) => isRecord(item) && isText(item.eventType) && assets.includes(item.asset as SettlementAsset) && isAmount(item.debits) && isAmount(item.credits) && typeof item.balanced === 'boolean')
    && typeof value.reconciliation.conserved === 'boolean';
}

function isAttempt(value: unknown) {
  return isRecord(value) && exact(value, ['attemptId','attemptNumber','requestDigest','executionTxHash','executorWallet','executorNonce','transactionTo','transactionCalldata','replacementForAttemptId','state','createdAt','submittedAt','updatedAt'])
    && isText(value.attemptId) && isInteger(value.attemptNumber, 1) && isHash(value.requestDigest) && (value.executionTxHash === null || isHash(value.executionTxHash))
    && isAddress(value.executorWallet) && isAmount(value.executorNonce) && isAddress(value.transactionTo) && isHex(value.transactionCalldata)
    && nullableText(value.replacementForAttemptId) && ['LEASED','SUBMITTED','MINED','SETTLED','REPLACED','FAILED','REORGED','QUARANTINED'].includes(String(value.state))
    && isDate(value.createdAt) && nullableDate(value.submittedAt) && isDate(value.updatedAt);
}

function isFinality(value: unknown) {
  return isRecord(value) && isText(value.transactionId) && isHash(value.expectedEventHash) && isHash(value.executionTxHash)
    && (value.replacementForTxHash === null || isHash(value.replacementForTxHash)) && [null,0,1].includes(value.receiptStatus as never)
    && (value.blockNumber === null || isAmount(value.blockNumber)) && (value.blockHash === null || isHash(value.blockHash))
    && isInteger(value.confirmations, 0) && value.requiredConfirmations === 15 && finalityStates.includes(value.state as never)
    && isRecord(value.evidence) && isDate(value.submittedAt) && nullableDate(value.finalizedAt) && isDate(value.updatedAt);
}

function isCoverage(value: unknown) {
  return isRecord(value) && exact(value, ['snapshotId','blockNumber','blockHash','evidenceHash','recordedAt','executorWallet','asset','verifiedAssets','unsettledLiabilities','covered'])
    && isText(value.snapshotId) && isAmount(value.blockNumber) && isHash(value.blockHash) && isHash(value.evidenceHash)
    && isDate(value.recordedAt) && isAddress(value.executorWallet) && assets.includes(value.asset as SettlementAsset)
    && isAmount(value.verifiedAssets) && isAmount(value.unsettledLiabilities) && typeof value.covered === 'boolean';
}

function baseQuery(limit = 25) { if (!isInteger(limit, 1, 100)) throw invalidInput('limit must be an integer between 1 and 100'); return new URLSearchParams({ limit: String(limit) }); }
function appendDates(query: URLSearchParams, from?: string, to?: string) { appendDate(query, 'from', from); appendDate(query, 'to', to); }
function appendHash(query: URLSearchParams, key: string, value?: string) { if (value) { requireHash(value, key); query.set(key, value); } }
function appendAddress(query: URLSearchParams, key: string, value?: string) { if (value) { if (!isAddress(value)) throw invalidInput(`${key} must be an address`); query.set(key, value); } }
function appendText(query: URLSearchParams, key: string, value?: string) { if (value !== undefined) { const trimmed = value.trim(); if (!trimmed) throw invalidInput(`${key} must not be blank`); query.set(key, trimmed); } }
function appendDate(query: URLSearchParams, key: string, value?: string) { if (value) { if (!isDate(value)) throw invalidInput(`${key} must be an ISO date-time`); query.set(key, value); } }
function appendEnum<T extends string>(query: URLSearchParams, key: string, value: T | undefined, allowed: readonly T[]) { if (value !== undefined) { if (!allowed.includes(value)) throw invalidInput(`${key} must be a generated enum value`); query.set(key, value); } }
function requireCompleteCursor(first?: string, second?: string) { if (Boolean(first) !== Boolean(second)) throw invalidInput('cursor requires both fields'); }
function requireHash(value: string, key: string) { if (!isHash(value)) throw invalidInput(`${key} must be bytes32`); }
function authenticatedGet(path: string, token: string, signal?: AbortSignal) { return requestCoreJson(path, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]) { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
function isText(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function nullableText(value: unknown) { return value === null || isText(value); }
function isHash(value: unknown) { return bytes32Pattern.test(String(value)); }
function isHashArray(value: unknown) { return Array.isArray(value) && value.every(isHash); }
function isAddress(value: unknown) { return addressPattern.test(String(value)); }
function isAmount(value: unknown) { return amountPattern.test(String(value)); }
function isHex(value: unknown) { return hexDataPattern.test(String(value)); }
function isInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function isDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function nullableDate(value: unknown) { return value === null || isDate(value); }
function invalidInput(message: string) { return new CoreApiError({ code: 'InvalidRequest', message, status: 400 }); }
function invalid(message: string) { return new CoreApiError({ code: 'InvalidResponse', message, status: 502 }); }

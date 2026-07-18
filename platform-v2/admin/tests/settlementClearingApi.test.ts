import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAdminSettlementRequest, fetchAdminSettlementRequests, fetchAdminSettlementTransfer, fetchAdminSettlementTransfers } from '../src/settlementClearingApi';

afterEach(() => vi.unstubAllGlobals());

describe('EOA settlement clearing Core client', () => {
  it('serializes request filters and stable cursors server-side', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(requestList())); vi.stubGlobal('fetch', fetchMock);
    await fetchAdminSettlementRequests({ merchantId: 'merchant-1', transferId: hash('7'), state: 'SUBMITTED', cursorRequestedAt: iso(0), cursorRequestId: hash('5'), limit: 40 }, 'jwt');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://core.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '40', merchantId: 'merchant-1', transferId: hash('7'), state: 'SUBMITTED', cursorRequestedAt: iso(0), cursorRequestId: hash('5') });
    await expect(fetchAdminSettlementRequests({ cursorRequestId: hash('5') }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });
  });

  it('validates immutable request journals and transfer transitions', async () => {
    const detail = requestDetail(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)));
    await expect(fetchAdminSettlementRequest(hash('5'), 'jwt')).resolves.toMatchObject({ transitions: [{ type: 'SUBMITTED', transferId: hash('7') }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...detail, uiAmount: '10' })));
    await expect(fetchAdminSettlementRequest(hash('5'), 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('uses transfer filters and preserves Core RBAC errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(transferList())).mockResolvedValueOnce(jsonResponse({ error: { code: 'Forbidden', message: 'Platform role required', correlationId: 'rbac' } }, 403)); vi.stubGlobal('fetch', fetchMock);
    await fetchAdminSettlementTransfers({ executorWallet: address('4'), executionTxHash: hash('a'), state: 'MINED', limit: 25 }, 'jwt');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://core.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '25', executorWallet: address('4'), executionTxHash: hash('a'), state: 'MINED' });
    await expect(fetchAdminSettlementTransfers({}, 'buyer')).rejects.toMatchObject({ code: 'Forbidden', correlationId: 'rbac' });
  });

  it.each([['MINED', 14], ['FAILED', 2], ['REORGED', 2]] as const)('accepts explicit %s EOA finality', async (state, confirmations) => {
    const detail = transferDetail(state, confirmations); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)));
    await expect(fetchAdminSettlementTransfer(hash('7'), 'jwt')).resolves.toMatchObject({ transfer: { executorNonce: '12' }, finality: { state, confirmations }, reconciliation: { conserved: true } });
  });
});

function request() { return { requestId: hash('5'), merchantId: 'merchant-1', walletAddress: address('1'), recipientAddress: address('2'), rail: 'MERCHANT_USDT', asset: 'USDT', executorWallet: address('4'), amount: '10', state: 'SUBMITTED', transferIds: [hash('7')], intentDigest: hash('8'), signatureHash: hash('9'), finalExecutionTxHashes: [], itemCount: 1, requestedAt: iso(0), submittedAt: iso(1), settledAt: null }; }
function requestList() { return { artifactVersion, requests: [request()], nextCursor: { requestedAt: iso(0), requestId: hash('5') } }; }
function requestDetail() { return { artifactVersion, request: request(), items: [{ itemIndex: 0, orderId: hash('2'), accountId: 'merchant-1:receivable', backingWalletAddress: address('4'), amount: '10', itemHash: hash('a'), policyVersion: '7', journals: { requested: 'journal-requested', submitted: 'journal-submitted', settled: null } }], transitions: [{ transitionId: 'transition-2', requestItemIndex: 0, transferId: hash('7'), sequence: 2, type: 'SUBMITTED', journalId: 'journal-submitted', createdAt: iso(1) }] }; }
function transfer() { return { transferId: hash('7'), asset: 'USDT', executorWallet: address('4'), executorNonce: '12', requestId: hash('5'), requestItemIndex: 0, orderId: hash('2'), accountId: 'merchant-1:receivable', recipientAddress: address('2'), tokenAddress: address('5'), amount: '10', transferCalldata: '0xa1', contentHash: hash('6'), gasCap: '90000', executionTxHash: hash('a'), state: 'MINED', createdBy: address('3'), createdAt: iso(2), submittedAt: iso(4), settledAt: null }; }
function transferList() { return { artifactVersion, transfers: [transfer()], nextCursor: { createdAt: iso(2), transferId: hash('7') } }; }
function transferDetail(state: string, confirmations: number) { return { artifactVersion, transfer: { ...transfer(), chainId: 56, artifactVersion, tokenCodeHash: hash('1'), tokenTransferConformanceEvidenceHash: hash('2'), runtimeEvidenceHash: hash('3'), runtimeCheckedAt: iso(1) }, attempts: [{ attemptId: 'attempt-2', attemptNumber: 2, requestDigest: hash('9'), executionTxHash: hash('a'), executorWallet: address('4'), executorNonce: '12', transactionTo: address('5'), transactionCalldata: '0xa1', replacementForAttemptId: 'attempt-1', state, createdAt: iso(4), submittedAt: iso(4), updatedAt: iso(5) }], finality: { transactionId: 'transaction-1', expectedEventHash: hash('7'), executionTxHash: hash('a'), replacementForTxHash: hash('0'), receiptStatus: state === 'FAILED' ? 0 : 1, blockNumber: '123', blockHash: hash('4'), confirmations, requiredConfirmations: 15, state, evidence: { source: 'indexer' }, submittedAt: iso(4), finalizedAt: null, updatedAt: iso(5) }, coverage: { snapshotId: 'coverage-1', blockNumber: '123', blockHash: hash('4'), evidenceHash: hash('5'), recordedAt: iso(5), executorWallet: address('4'), asset: 'USDT', verifiedAssets: '100', unsettledLiabilities: '90', covered: true }, breakers: [{ scope: 'NEW_SETTLEMENT_BATCH', paused: false, evidenceHash: hash('6'), policyVersion: '7', changedBy: 'SYSTEM', changedAt: iso(5) }], reconciliation: { expectedItemCount: 1, actualItemCount: 1, expectedTotalAmount: '10', actualTotalAmount: '10', ledgerMovements: [{ eventType: 'SettlementTransferMined', asset: 'USDT', debits: '10', credits: '10', balanced: true }], conserved: true } }; }
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }
function iso(minute: number) { return `2026-07-15T00:0${minute}:00.000Z`; }

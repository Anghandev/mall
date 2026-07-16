import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAdminSettlementBatch,
  fetchAdminSettlementBatches,
  fetchAdminSettlementRequest,
  fetchAdminSettlementRequests,
  fetchGlobalPaymentTrace,
} from '../src/settlementClearingApi';

afterEach(() => vi.unstubAllGlobals());

describe('global settlement clearing Core client', () => {
  it('reads the Admin payment endpoint independently of the buyer wallet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(paymentProjection()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGlobalPaymentTrace(hash('1'), 'jwt')).resolves.toMatchObject({ orderId: hash('1'), state: 'SUBMITTED' });
    expect(fetchMock).toHaveBeenCalledWith(`/v2/admin/payments/${hash('1')}`, {
      headers: { authorization: 'Bearer jwt' },
    });
  });

  it('serializes request filters and the complete stable cursor server-side', async () => {
    const response = requestList();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAdminSettlementRequests({
      merchantId: 'merchant-1', walletAddress: address('1'), orderId: hash('2'),
      rail: 'MERCHANT_USDT', asset: 'USDT', state: 'BATCHED',
      from: '2026-07-15T00:00:00.000Z', to: '2026-07-16T00:00:00.000Z',
      cursorRequestedAt: '2026-07-15T12:00:00.000Z', cursorRequestId: hash('3'), limit: 40,
    }, 'jwt')).resolves.toEqual(response);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://core.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '40', merchantId: 'merchant-1', walletAddress: address('1'), orderId: hash('2'),
      rail: 'MERCHANT_USDT', asset: 'USDT', state: 'BATCHED',
      from: '2026-07-15T00:00:00.000Z', to: '2026-07-16T00:00:00.000Z',
      cursorRequestedAt: '2026-07-15T12:00:00.000Z', cursorRequestId: hash('3'),
    });
    await expect(fetchAdminSettlementRequests({ cursorRequestId: hash('3') }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest', status: 400 });
  });

  it('validates immutable request items and append-only journal transitions', async () => {
    const detail = requestDetail();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)));
    await expect(fetchAdminSettlementRequest(detail.request.requestId, 'jwt')).resolves.toMatchObject({
      items: [{ policyVersion: '7', journals: { requested: 'journal-requested' } }],
      transitions: [{ type: 'BATCHED', sequence: 2 }],
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...detail, uiAmount: '10' })));
    await expect(fetchAdminSettlementRequest(detail.request.requestId, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('serializes batch filters and preserves Core 403 errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(batchList())).mockResolvedValueOnce(jsonResponse({
      error: { code: 'Forbidden', message: 'Platform role required', correlationId: 'clearing-rbac' },
    }, 403));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAdminSettlementBatches({ merchantId: 'merchant-1', orderId: hash('2'), safeAddress: address('4'), asset: 'USDT', state: 'MINED', limit: 25 }, 'jwt');
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://core.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '25', merchantId: 'merchant-1', orderId: hash('2'), safeAddress: address('4'), asset: 'USDT', state: 'MINED' });
    await expect(fetchAdminSettlementBatches({}, 'buyer-jwt')).rejects.toMatchObject({ code: 'Forbidden', status: 403, correlationId: 'clearing-rbac' });
  });

  it('accepts MINED 14/15 as pending and rejects a non-final MINED 15/15 response', async () => {
    const detail = batchDetail({ state: 'MINED', confirmations: 14, finalizedAt: null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)));
    await expect(fetchAdminSettlementBatch(detail.batch.batchId, 'jwt')).resolves.toMatchObject({
      batch: { safeNonce: '12', contentHash: hash('6') },
      finality: { state: 'MINED', confirmations: 14, requiredConfirmations: 15 },
      reconciliation: { conserved: true },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(batchDetail({ state: 'MINED', confirmations: 15, finalizedAt: null }))));
    await expect(fetchAdminSettlementBatch(detail.batch.batchId, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it.each(['FAILED', 'REORGED'] as const)('accepts explicit %s finality without relabeling it FINAL', async (state) => {
    const detail = batchDetail({ state, confirmations: 2, finalizedAt: null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)));
    await expect(fetchAdminSettlementBatch(detail.batch.batchId, 'jwt')).resolves.toMatchObject({ finality: { state } });
  });
});

function requestList() {
  return { artifactVersion, requests: [request()], nextCursor: { requestedAt: '2026-07-15T00:00:00.000Z', requestId: hash('5') } };
}

function request() {
  return {
    requestId: hash('5'), merchantId: 'merchant-1', walletAddress: address('1'), recipientAddress: address('2'),
    rail: 'MERCHANT_USDT', asset: 'USDT', safeAddress: address('4'), amount: '10', state: 'BATCHED', batchId: hash('7'),
    intentDigest: hash('8'), signatureHash: hash('9'), finalSafeTxHash: null, finalExecutionTxHash: null, itemCount: 1,
    requestedAt: '2026-07-15T00:00:00.000Z', batchedAt: '2026-07-15T00:01:00.000Z', settledAt: null,
  };
}

function requestDetail() {
  return {
    artifactVersion, request: request(),
    items: [{ itemIndex: 0, orderId: hash('2'), accountId: 'merchant-1:receivable', backingSafeAddress: address('4'), amount: '10', itemHash: hash('a'), policyVersion: '7', journals: { requested: 'journal-requested', batched: 'journal-batched', settled: null } }],
    transitions: [{ transitionId: 'transition-2', requestItemIndex: 0, batchId: hash('7'), sequence: 2, type: 'BATCHED', journalId: 'journal-batched', createdAt: '2026-07-15T00:01:00.000Z' }],
  };
}

function batchList() {
  return { artifactVersion, batches: [batch()], nextCursor: { createdAt: '2026-07-15T00:02:00.000Z', batchId: hash('7') } };
}

function batch() {
  return {
    batchId: hash('7'), asset: 'USDT', safeAddress: address('4'), safeNonce: '12', itemCount: 1, totalAmount: '10',
    contentHash: hash('6'), safeTxHash: hash('b'), state: 'MINED', approvalThreshold: 2, approvalCount: 2,
    createdBy: address('3'), createdAt: '2026-07-15T00:02:00.000Z', approvedAt: '2026-07-15T00:03:00.000Z', submittedAt: '2026-07-15T00:04:00.000Z', settledAt: null,
  };
}

function batchDetail(finalityOverride: { state: string; confirmations: number; finalizedAt: string | null }) {
  return {
    artifactVersion,
    batch: {
      ...batch(), chainId: 56, assetAddress: address('5'), safeVersion: '1.4.1', safeSingletonAddress: address('6'),
      safeSingletonCodeHash: hash('c'), ownerSetHash: hash('d'), safeRuntimeEvidenceHash: hash('e'), safeRuntimeCheckedAt: '2026-07-15T00:01:00.000Z',
      multisendAddress: address('7'), multisendCodeHash: hash('f'), tokenCodeHash: hash('1'), tokenTransferConformanceEvidenceHash: hash('2'),
      itemsHash: hash('3'), multisendTransactions: '0x12', multisendCalldata: '0x34', safeTxData: '0x56', proposalReferenceHash: hash('4'), approvalEvidenceHash: hash('5'),
    },
    items: [{ itemIndex: 0, requestId: hash('5'), requestItemIndex: 0, orderId: hash('2'), merchantId: 'merchant-1', accountId: 'merchant-1:receivable', recipientAddress: address('2'), tokenAddress: address('5'), amount: '10', transferCalldata: '0xa1', itemHash: hash('a') }],
    approvals: [{ ownerAddress: address('8'), safeTxHash: hash('b'), signatureHash: hash('8'), approvedAt: '2026-07-15T00:03:00.000Z' }],
    attempts: [{ attemptId: 'attempt-2', attemptNumber: 2, requestDigest: hash('9'), safeTxHash: hash('b'), executionTxHash: hash('a'), outerSender: address('9'), outerNonce: '4', replacementForAttemptId: 'attempt-1', state: finalityOverride.state === 'REORGED' ? 'REORGED' : finalityOverride.state === 'FAILED' ? 'FAILED' : 'MINED', createdAt: '2026-07-15T00:04:00.000Z', submittedAt: '2026-07-15T00:04:00.000Z', updatedAt: '2026-07-15T00:05:00.000Z' }],
    finality: { transactionId: 'transaction-1', expectedEventHash: hash('7'), executionTxHash: hash('a'), replacementForTxHash: hash('0'), receiptStatus: finalityOverride.state === 'FAILED' ? 0 : 1, blockNumber: '123', blockHash: hash('4'), confirmations: finalityOverride.confirmations, requiredConfirmations: 15, state: finalityOverride.state, evidence: { source: 'indexer' }, submittedAt: '2026-07-15T00:04:00.000Z', finalizedAt: finalityOverride.finalizedAt, updatedAt: '2026-07-15T00:05:00.000Z' },
    coverage: { snapshotId: 'coverage-1', blockNumber: '123', blockHash: hash('4'), evidenceHash: hash('5'), recordedAt: '2026-07-15T00:05:00.000Z', safeAddress: address('4'), asset: 'USDT', verifiedAssets: '100', unsettledLiabilities: '90', covered: true },
    breakers: [{ scope: 'NEW_SETTLEMENT_BATCH', paused: false, evidenceHash: hash('6'), policyVersion: '7', changedBy: 'SYSTEM', changedAt: '2026-07-15T00:05:00.000Z' }],
    reconciliation: { expectedItemCount: 1, actualItemCount: 1, expectedTotalAmount: '10', actualTotalAmount: '10', ledgerMovements: [{ eventType: 'SettlementBatchMined', asset: 'USDT', debits: '10', credits: '10', balanced: true }], conserved: true },
  };
}

function paymentProjection() {
  return {
    artifactVersion, orderId: hash('1'), state: 'SUBMITTED', paymentRouterAddress: address('3'), submittedTxHash: hash('2'),
    routerCall: { functionName: 'pay', intent: {}, quoteSignature: '0x12' },
    intent: { orderId: hash('1'), policyVersion: 7, reservationId: hash('3'), reservationDeadline: 1_800_000_000, quantity: 1, listPriceUsdt: '100', usdtPaymentAmount: '70', nplPaymentAmount: '30', nplBurnAmount: '20', nplRewardAmount: '10', merchantNetReceivableUsdt: '60' },
    finality: { transactionHash: hash('2'), replacementForTxHash: null, blockNumber: 42, blockHash: hash('4'), confirmations: 14, requiredConfirmations: 15, receiptStatus: 1, state: 'MINED', canonicalBlock: true, classification: 'ORDINARY' },
  };
}

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }

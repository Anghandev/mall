import {
  artifactVersion,
  type AdminSettlementBatchDetail,
  type AdminSettlementBatchList,
  type AdminSettlementRequestDetail,
  type AdminSettlementRequestList,
} from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  fetchAdminSettlementBatch,
  fetchAdminSettlementBatches,
  fetchAdminSettlementRequest,
  fetchAdminSettlementRequests,
} from '../src/settlementClearingApi';

vi.mock('../src/settlementClearingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/settlementClearingApi')>()),
  fetchAdminSettlementBatch: vi.fn(),
  fetchAdminSettlementBatches: vi.fn(),
  fetchAdminSettlementRequest: vi.fn(),
  fetchAdminSettlementRequests: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('global clearing workspace', () => {
  it('stays closed before SIWE and exposes no money movement commands', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/clearing');

    expect(screen.getByRole('heading', { name: '全局清算审计' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SIWE 连接' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /转账|组批|执行批次/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows BUYER as Forbidden without calling a settlement list', async () => {
    installSession('BUYER');
    const user = userEvent.setup();
    renderAt('/clearing');
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('Forbidden · HTTP 403')).toBeTruthy();
    expect(screen.getByText('当前会话没有全局清算读取权限')).toBeTruthy();
    expect(fetchAdminSettlementRequests).not.toHaveBeenCalled();
    expect(fetchAdminSettlementBatches).not.toHaveBeenCalled();
  });

  it('lets AUDITOR filter and inspect immutable settlement-request journals read-only', async () => {
    installSession('AUDITOR');
    vi.mocked(fetchAdminSettlementRequests).mockResolvedValue(requestList());
    vi.mocked(fetchAdminSettlementRequest).mockResolvedValue(requestDetail());
    const user = userEvent.setup();
    renderAt('/clearing');
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: '结算申请' }));

    expect(await screen.findByText('MERCHANT_USDT · USDT')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /MERCHANT_USDT/ }));
    expect(await screen.findByRole('heading', { name: 'MERCHANT_USDT · BATCHED' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '不可变申请 items' })).toBeTruthy();
    expect(screen.getByText('journal-requested')).toBeTruthy();
    expect(screen.getByText('BATCH_REVERSED')).toBeTruthy();
    expect(fetchAdminSettlementRequests).toHaveBeenCalledWith({ limit: 25 }, 'jwt');
    expect(fetchAdminSettlementRequest).toHaveBeenCalledWith(hash('5'), 'jwt');
    expect(screen.queryByRole('button', { name: /转账|组批|提交 Safe|执行/ })).toBeNull();
  });

  it('renders MINED 14/15 as non-final with approvals, replacement, coverage and reconciliation', async () => {
    installSession('ADMIN');
    vi.mocked(fetchAdminSettlementBatches).mockResolvedValue(batchList());
    vi.mocked(fetchAdminSettlementBatch).mockResolvedValue(batchDetail('MINED', 14));
    const user = userEvent.setup();
    renderAt('/clearing');
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: 'Safe 批次' }));
    await user.click(await screen.findByRole('button', { name: /USDT · nonce 12/ }));

    expect(await screen.findByText('MINED · 14/15 · NOT FINAL')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Safe owner approvals' })).toBeTruthy();
    expect(screen.getByText('attempt-1')).toBeTruthy();
    expect(screen.getByText('COVERED')).toBeTruthy();
    expect(screen.getByText('CONSERVED')).toBeTruthy();
    expect(screen.getByText('NEW_SETTLEMENT_BATCH: OPEN')).toBeTruthy();
    expect(screen.queryByText(/FINAL · 14\/15/)).toBeNull();
  });

  it.each(['FAILED', 'REORGED'] as const)('shows %s as an explicit ineffective finality state', async (state) => {
    installSession('OPERATOR');
    vi.mocked(fetchAdminSettlementBatches).mockResolvedValue(batchList());
    vi.mocked(fetchAdminSettlementBatch).mockResolvedValue(batchDetail(state, 2));
    const user = userEvent.setup();
    renderAt('/clearing');
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: 'Safe 批次' }));
    await user.click(await screen.findByRole('button', { name: /USDT · nonce 12/ }));

    await waitFor(() => expect(within(screen.getByLabelText('链上最终性')).getByText(state)).toBeTruthy());
    expect(screen.queryByText(new RegExp(`FINAL .*${state}`))).toBeNull();
  });
});

function renderAt(path: string) { return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>); }

function installSession(role: 'ADMIN' | 'OPERATOR' | 'AUDITOR' | 'BUYER') {
  const wallet = address('1');
  window.ethereum = { request: vi.fn(async ({ method }) => method === 'eth_requestAccounts' ? [wallet] : method === 'personal_sign' ? '0xsigned' : Promise.reject(new Error(`Unexpected ${method}`))) };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected ${url}`, correlationId: 'clearing-page-test' } }, 400);
  }));
}

function requestList(): AdminSettlementRequestList {
  return { artifactVersion, requests: [requestDetail().request], nextCursor: null };
}

function requestDetail(): AdminSettlementRequestDetail {
  return {
    artifactVersion,
    request: { requestId: hash('5'), merchantId: 'merchant-1', walletAddress: address('1'), recipientAddress: address('2'), rail: 'MERCHANT_USDT', asset: 'USDT', safeAddress: address('4'), amount: '10', state: 'BATCHED', batchId: hash('7'), intentDigest: hash('8'), signatureHash: hash('9'), finalSafeTxHash: null, finalExecutionTxHash: null, itemCount: 1, requestedAt: '2026-07-15T00:00:00.000Z', batchedAt: '2026-07-15T00:01:00.000Z', settledAt: null },
    items: [{ itemIndex: 0, orderId: hash('2'), accountId: 'merchant-1:receivable', backingSafeAddress: address('4'), amount: '10', itemHash: hash('a'), policyVersion: '7', journals: { requested: 'journal-requested', batched: 'journal-batched', settled: null } }],
    transitions: [{ transitionId: 'transition-3', requestItemIndex: 0, batchId: hash('7'), sequence: 3, type: 'BATCH_REVERSED', journalId: 'journal-reversal', createdAt: '2026-07-15T00:02:00.000Z' }],
  };
}

function batchList(): AdminSettlementBatchList {
  return { artifactVersion, batches: [batchDetail('MINED', 14).batch], nextCursor: null };
}

function batchDetail(state: 'MINED' | 'FAILED' | 'REORGED', confirmations: number): AdminSettlementBatchDetail {
  return {
    artifactVersion,
    batch: { batchId: hash('7'), asset: 'USDT', safeAddress: address('4'), safeNonce: '12', itemCount: 1, totalAmount: '10', contentHash: hash('6'), safeTxHash: hash('b'), state: 'MINED', approvalThreshold: 2, approvalCount: 2, createdBy: address('3'), createdAt: '2026-07-15T00:02:00.000Z', approvedAt: '2026-07-15T00:03:00.000Z', submittedAt: '2026-07-15T00:04:00.000Z', settledAt: null, chainId: 56, assetAddress: address('5'), safeVersion: '1.4.1', safeSingletonAddress: address('6'), safeSingletonCodeHash: hash('c'), ownerSetHash: hash('d'), safeRuntimeEvidenceHash: hash('e'), safeRuntimeCheckedAt: '2026-07-15T00:01:00.000Z', multisendAddress: address('7'), multisendCodeHash: hash('f'), tokenCodeHash: hash('1'), tokenTransferConformanceEvidenceHash: hash('2'), itemsHash: hash('3'), multisendTransactions: '0x12', multisendCalldata: '0x34', safeTxData: '0x56', proposalReferenceHash: hash('4'), approvalEvidenceHash: hash('5') },
    items: [{ itemIndex: 0, requestId: hash('5'), requestItemIndex: 0, orderId: hash('2'), merchantId: 'merchant-1', accountId: 'merchant-1:receivable', recipientAddress: address('2'), tokenAddress: address('5'), amount: '10', transferCalldata: '0xa1', itemHash: hash('a') }],
    approvals: [{ ownerAddress: address('8'), safeTxHash: hash('b'), signatureHash: hash('8'), approvedAt: '2026-07-15T00:03:00.000Z' }],
    attempts: [{ attemptId: 'attempt-2', attemptNumber: 2, requestDigest: hash('9'), safeTxHash: hash('b'), executionTxHash: hash('a'), outerSender: address('9'), outerNonce: '4', replacementForAttemptId: 'attempt-1', state, createdAt: '2026-07-15T00:04:00.000Z', submittedAt: '2026-07-15T00:04:00.000Z', updatedAt: '2026-07-15T00:05:00.000Z' }],
    finality: { transactionId: 'transaction-1', expectedEventHash: hash('7'), executionTxHash: hash('a'), replacementForTxHash: hash('0'), receiptStatus: state === 'FAILED' ? 0 : 1, blockNumber: '123', blockHash: hash('4'), confirmations, requiredConfirmations: 15, state, evidence: { source: 'indexer' }, submittedAt: '2026-07-15T00:04:00.000Z', finalizedAt: null, updatedAt: '2026-07-15T00:05:00.000Z' },
    coverage: { snapshotId: 'coverage-1', blockNumber: '123', blockHash: hash('4'), evidenceHash: hash('5'), recordedAt: '2026-07-15T00:05:00.000Z', safeAddress: address('4'), asset: 'USDT', verifiedAssets: '100', unsettledLiabilities: '90', covered: true },
    breakers: [{ scope: 'NEW_SETTLEMENT_BATCH', paused: false, evidenceHash: hash('6'), policyVersion: '7', changedBy: 'SYSTEM', changedAt: '2026-07-15T00:05:00.000Z' }],
    reconciliation: { expectedItemCount: 1, actualItemCount: 1, expectedTotalAmount: '10', actualTotalAmount: '10', ledgerMovements: [{ eventType: 'SettlementBatchMined', asset: 'USDT', debits: '10', credits: '10', balanced: true }], conserved: true },
  };
}

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }

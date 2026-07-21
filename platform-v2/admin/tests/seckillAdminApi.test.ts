import { artifactVersion, type SeckillGovernanceActionProjection, type SeckillSessionPlanProjection, type SeckillSessionProjection } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSeckillGovernanceAction,
  createSeckillBreakerResume,
  createSeckillForceClose,
  createSeckillGovernanceChallenge,
  createSeckillPrizeInjection,
  createSeckillSessionDraft,
  fetchCurrentSeckillSession,
  fetchSeckillGovernanceAction,
  fetchSeckillGovernanceActions,
  fetchSeckillSessionEvents,
  fetchSeckillSessionHistory,
  parseRealtimeEvent,
  executeSeckillGovernanceAction,
  reviewSeckillWinner,
  seckillWebSocketUrl,
  submitSeckillGovernanceApproval,
  subscribeSeckillEvents,
} from '../src/seckillAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('seckill admin coordinated Core client', () => {
  it('uses only the published current, history and replay operations', async () => {
    const session = seckillSession();
    const event = realtimeEvent(session.sessionId);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/current')) return jsonResponse(session);
      if (url.includes('/history')) return jsonResponse({ items: [session], nextCursor: '20' });
      return jsonResponse({ items: [event], nextCursor: '8' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCurrentSeckillSession()).resolves.toMatchObject({ phase: 'LIVE' });
    await expect(fetchSeckillSessionHistory({ cursor: '10', limit: 20 })).resolves.toMatchObject({ nextCursor: '20' });
    await expect(fetchSeckillSessionEvents(session.sessionId, { cursor: '7', limit: 100 })).resolves.toMatchObject({ nextCursor: '8' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/v2/seckill/sessions/current',
      '/v2/seckill/sessions/history?cursor=10&limit=20',
      `/v2/seckill/sessions/${session.sessionId}/events?cursor=7&limit=100`,
    ]);
  });

  it('binds the production Core prefix, artifact, channel and resume cursor to the published protocol', () => {
    const sessionId = hash('a');
    const url = new URL(seckillWebSocketUrl(sessionId, '19', 'https://www.npleon.com', '/core'));

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/core/v2/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({ artifactVersion, channel: `seckill:${sessionId}`, cursor: '19' });
  });

  it('rejects mismatched artifacts and non-final realtime events', () => {
    const sessionId = hash('a');
    expect(() => parseRealtimeEvent({ ...realtimeEvent(sessionId), artifactVersion: 'stale' }, sessionId)).toThrow(/coordinated protocol/);
    expect(() => parseRealtimeEvent({ ...realtimeEvent(sessionId), finality: 'MINED' }, sessionId)).toThrow(/coordinated protocol/);
  });

  it('rejects mutable timer projections and a premature FINAL governance action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...seckillSession(), timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 31, relayCapSeconds: 60 },
    })));
    await expect(fetchCurrentSeckillSession()).rejects.toMatchObject({ code: 'InvalidResponse' });

    const prematureFinal = governanceAction({ state: 'FINAL', confirmations: 14, canonical: true, allowedActions: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([prematureFinal])));
    await expect(fetchSeckillGovernanceActions('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('deduplicates event IDs and closes on a non-increasing unseen cursor', () => {
    const sessionId = hash('a');
    const socket = new TestSocket();
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeSeckillEvents(sessionId, '7', { onOpen: vi.fn(), onEvent, onError, onClose: vi.fn() }, () => socket);
    const accepted = realtimeEvent(sessionId);

    socket.message(accepted);
    socket.message(accepted);
    socket.message({ ...accepted, eventId: 'event-2' });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'InvalidResponse' }));
    expect(socket.closedWith).toEqual([4403, 'Protocol violation']);
  });

  it('strictly reads governance action list and detail with bearer authorization', async () => {
    const action = governanceAction();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input).endsWith('/actions')
      ? jsonResponse([action]) : jsonResponse(action));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSeckillGovernanceActions('jwt')).resolves.toMatchObject([{ actionKind: 'OPEN_SESSION', state: 'DRAFT' }]);
    await expect(fetchSeckillGovernanceAction(action.actionId, 'jwt')).resolves.toMatchObject({ actionId: action.actionId });
    for (const [, init] of fetchMock.mock.calls) expect(init?.headers).toEqual({ authorization: 'Bearer jwt' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...action, unexpected: true })));
    await expect(fetchSeckillGovernanceAction(action.actionId, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('accepts nonce reconciliation evidence and rejects missing or extra projection fields', async () => {
    const action = governanceAction({
      state: 'RECONCILE_REQUIRED',
      executorNonce: '7',
      nonceReservedAt: '2026-07-16T00:01:00.000Z',
      nonceReservationEvidenceHash: hash('4'),
      executionArtifactVersion: artifactVersion,
      executionRequestDigest: hash('5'),
      allowedActions: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([action])));
    await expect(fetchSeckillGovernanceActions('jwt')).resolves.toEqual([action]);

    for (const field of [
      'nonceReservedAt', 'nonceReservationEvidenceHash', 'executionArtifactVersion',
      'executionRequestDigest', 'nonceReleasedAt', 'nonceReleaseEvidenceHash',
    ] as const) {
      const incomplete = { ...action } as Record<string, unknown>;
      delete incomplete[field];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([incomplete])));
      await expect(fetchSeckillGovernanceActions('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ ...action, unexpected: true }])));
    await expect(fetchSeckillGovernanceActions('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('creates every published seckill draft operation with exact bodies', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return jsonResponse(governanceAction(), 201);
      if (url.endsWith('/force-close')) return jsonResponse(governanceAction({ actionKind: 'FORCE_CLOSE', sessionPlan: null }), 201);
      if (url.endsWith('/prize-injections')) return jsonResponse(governanceAction({ actionKind: 'PRIZE_INJECTION', sessionPlan: null, prizeInjection: prizeInjection() }), 201);
      return jsonResponse(governanceAction({ actionKind: 'RESUME_PURCHASES', sessionPlan: null }), 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const sessionId = hash('b');

    await createSeckillSessionDraft({ policyVersion: '2', rulesContentHash: hash('2'), productId: 'product-1', skuId: 'sku-1', inventory: 4, seckillListPriceUsdt: '80', startsAt: '2026-07-18T01:00:00.000Z', idempotencyKey: 'seckill-session-1' }, 'jwt');
    await createSeckillForceClose(sessionId, { reasonCode: 'OPERATIONS_STOP', idempotencyKey: 'seckill-close-1' }, 'jwt');
    await createSeckillPrizeInjection(sessionId, { amountUsdt: '50', idempotencyKey: 'seckill-prize-1' }, 'jwt');
    await createSeckillBreakerResume({ sessionId, idempotencyKey: 'seckill-resume-1' }, 'jwt');

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/v2/admin/seckill/sessions',
      `/v2/admin/seckill/sessions/${sessionId}/force-close`,
      `/v2/admin/seckill/sessions/${sessionId}/prize-injections`,
      '/v2/admin/seckill/breaker/resume',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { policyVersion: '2', rulesContentHash: hash('2'), productId: 'product-1', skuId: 'sku-1', inventory: 4, seckillListPriceUsdt: '80', startsAt: '2026-07-18T01:00:00.000Z', idempotencyKey: 'seckill-session-1' },
      { reasonCode: 'OPERATIONS_STOP', idempotencyKey: 'seckill-close-1' },
      { amountUsdt: '50', idempotencyKey: 'seckill-prize-1' },
      { sessionId, idempotencyKey: 'seckill-resume-1' },
    ]);
  });

  it('submits only the frozen winner review decision and rejects candidate substitution', async () => {
    const session = seckillSession({ prizeSettlement: reviewPendingPrize() });
    const approved = {
      ...reviewPendingPrize(),
      state: 'APPROVED' as const,
      review: { decision: 'APPROVED' as const, reasonCode: 'ORDER_VALID', evidenceHash: hash('8'), reviewedBy: address('1'), reviewedAt: '2026-07-16T01:00:00.000Z' },
      awardJournalId: 'journal:prize:1',
      payout: { state: 'AVAILABLE' as const, requestId: null, transferIds: [], finalExecutionTxHashes: [] },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(approved));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviewSeckillWinner(session, {
      decision: 'APPROVE', reasonCode: 'ORDER_VALID', evidenceHash: hash('8'), idempotencyKey: 'winner-review-1',
    }, 'jwt')).resolves.toMatchObject({ state: 'APPROVED', candidate: { orderId: hash('4') } });
    expect(fetchMock).toHaveBeenCalledWith(`/v2/admin/seckill/sessions/${session.sessionId}/winner-review`, expect.objectContaining({
      method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      decision: 'APPROVE', reasonCode: 'ORDER_VALID', evidenceHash: hash('8'), idempotencyKey: 'winner-review-1',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...approved, candidate: { ...approved.candidate!, buyerWallet: address('9') },
    })));
    await expect(reviewSeckillWinner(session, {
      decision: 'APPROVE', reasonCode: 'ORDER_VALID', evidenceHash: hash('8'), idempotencyKey: 'winner-review-2',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('strictly rejects missing and extra prize-settlement fields', async () => {
    const settlement = reviewPendingPrize();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(seckillSession({ prizeSettlement: { ...settlement, unexpected: true } as never }))));
    await expect(fetchCurrentSeckillSession()).rejects.toMatchObject({ code: 'InvalidResponse' });

    const { poolSnapshotHash: _missing, ...incomplete } = settlement;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(seckillSession({ prizeSettlement: incomplete as never }))));
    await expect(fetchCurrentSeckillSession()).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('accepts the Core EOA prize payout lifecycle and rejects legacy Safe DTO fields', async () => {
    const session = seckillSession({
      prizeSettlement: {
        ...reviewPendingPrize(),
        state: 'APPROVED',
        review: { decision: 'APPROVED', reasonCode: 'ORDER_VALID', evidenceHash: hash('8'), reviewedBy: address('1'), reviewedAt: '2026-07-16T01:00:00.000Z' },
        awardJournalId: 'journal:prize:1',
        payout: { state: 'SUBMITTED', requestId: hash('9'), transferIds: [hash('a')], finalExecutionTxHashes: [hash('b')] },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(session)));

    await expect(fetchCurrentSeckillSession()).resolves.toMatchObject({
      prizeSettlement: {
        payout: { state: 'SUBMITTED', requestId: hash('9'), transferIds: [hash('a')], finalExecutionTxHashes: [hash('b')] },
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(seckillSession({
      prizeSettlement: {
        ...session.prizeSettlement!,
        payout: { state: 'BATCHED', requestId: hash('9'), batchId: hash('a'), finalSafeTxHash: hash('b'), finalExecutionTxHash: hash('c') },
      } as never,
    }))));
    await expect(fetchCurrentSeckillSession()).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('binds secondary-wallet EIP-712 approval, EOA execution and cancellation to one action', async () => {
    const action = governanceAction();
    const input = { nonce: '7', deadline: '1800000000' };
    const challenge = governanceChallenge(action, input.nonce, input.deadline);
    const signed = governanceAction({ state: 'SECONDARY_SIGNED', secondarySigner: challenge.signer, approvalNonce: input.nonce, approvalDeadline: new Date(Number(input.deadline) * 1_000).toISOString(), allowedActions: ['EXECUTE', 'CANCEL'] });
    const proposed = governanceAction({ ...signed, state: 'PENDING_EXECUTION', allowedActions: [] });
    const cancelled = governanceAction({ state: 'CANCELLED', allowedActions: [], sessionPlan: { ...sessionPlan(), inventoryLockState: 'RELEASED', releasedAt: '2026-07-16T01:00:00.000Z' } });
    const fetchMock = vi.fn(async (inputUrl: string | URL | Request) => {
      const url = String(inputUrl);
      if (url.endsWith('/approval-challenge')) return jsonResponse(challenge);
      if (url.endsWith('/secondary-signature')) return jsonResponse(signed);
      if (url.endsWith('/execute')) return jsonResponse(proposed, 202);
      return jsonResponse(cancelled);
    });
    vi.stubGlobal('fetch', fetchMock);

    const received = await createSeckillGovernanceChallenge(action, input, 'jwt');
    await expect(submitSeckillGovernanceApproval(action, received, { ...input, signature: '0x1234' }, 'jwt')).resolves.toMatchObject({ state: 'SECONDARY_SIGNED' });
    await expect(executeSeckillGovernanceAction(signed, 'jwt')).resolves.toMatchObject({ state: 'PENDING_EXECUTION' });
    await expect(cancelSeckillGovernanceAction(action, 'jwt')).resolves.toMatchObject({ state: 'CANCELLED' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `/v2/admin/seckill/actions/${action.actionId}/approval-challenge`,
      `/v2/admin/seckill/actions/${action.actionId}/secondary-signature`,
      `/v2/admin/seckill/actions/${action.actionId}/execute`,
      `/v2/admin/seckill/actions/${action.actionId}/cancel`,
    ]);
  });

  it('rejects an altered challenge and invalid draft values before a protected write', async () => {
    const action = governanceAction();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...governanceChallenge(action, '7', '1800000000'), sessionId: hash('f') }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSeckillGovernanceChallenge(action, { nonce: '7', deadline: '1800000000' }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(createSeckillPrizeInjection(hash('b'), { amountUsdt: '0', idempotencyKey: 'seckill-prize-1' }, 'jwt')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function seckillSession(overrides: Partial<SeckillSessionProjection> = {}): SeckillSessionProjection { return { artifactVersion, sessionId: hash('a'), policyVersion: '2', merchantId: 'merchant-1', product: { productId: 'product-1', skuId: 'sku-1', title: '24K session', metadata: {}, attributes: {}, seckillListPriceUsdt: '88' }, phase: 'LIVE', storedPhase: 'LIVE', serverTime: '2026-07-15T05:00:00.000Z', startsAt: '2026-07-15T05:00:00.000Z', mainDeadline: '2026-07-15T06:00:00.000Z', relayDeadline: '2026-07-15T05:01:00.000Z', settlementEarliestAt: '2026-07-15T05:06:00.000Z', settlementDeadline: '2026-07-15T05:11:00.000Z', timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 }, inventory: { total: '100', sold: '5', reserved: '2', available: '93' }, prizePoolUsdt: '9', lastBuyerWallet: null, winnerWallet: null, prizeSettlement: null, snapshot: {}, governanceActionId: hash('1'), rulesContentHash: hash('2'), publicationTxHash: hash('3'), allowedActions: [], ...overrides }; }
function realtimeEvent(sessionId: string) { return { artifactVersion, protocolVersion: 1, eventId: 'event-1', channel: `seckill:${sessionId}`, cursor: '8', eventType: 'SeckillRelayExtended', resourceType: 'SECKILL_SESSION', resourceId: sessionId, occurredAt: '2026-07-15T05:00:30.000Z', finality: 'FINAL', payload: {} }; }

function governanceAction(overrides: Partial<SeckillGovernanceActionProjection> = {}): SeckillGovernanceActionProjection {
  return {
    artifactVersion, actionId: hash('a'), sessionId: hash('b'), policyVersion: '2', actionKind: 'OPEN_SESSION', state: 'DRAFT',
    evidenceHash: hash('c'), executorWallet: address('4'), targetAddress: address('5'), calldataHash: hash('d'), executorNonce: null,
    nonceReservedAt: null, nonceReservationEvidenceHash: null, executionArtifactVersion: null, executionRequestDigest: null,
    nonceReleasedAt: null, nonceReleaseEvidenceHash: null, submittedTxHash: null, executionEvidenceHash: null, executionTxHash: null, blockNumber: null, blockHash: null, confirmations: 0,
    canonical: null, actorWallet: address('1'), secondarySigner: null, approvalNonce: null, approvalDeadline: null,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', sessionPlan: sessionPlan(),
    prizeInjection: null, allowedActions: ['APPROVE_SECONDARY', 'CANCEL'], ...overrides,
  };
}

function sessionPlan(): SeckillSessionPlanProjection {
  return {
    merchantId: 'merchant-1', productId: 'product-1', skuId: 'sku-1', productPolicyHash: hash('1'), rulesContentHash: hash('2'),
    startsAt: '2026-07-18T01:00:00.000Z', mainDeadline: '2026-07-18T02:00:00.000Z', relayDeadline: '2026-07-18T01:01:00.000Z',
    inventory: '4', seckillListPriceUsdt: '80', timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 },
    snapshot: {}, inventoryLockState: 'LOCKED', releasedAt: null,
  };
}

function prizeInjection() {
  return { injectionId: hash('a'), amountUsdt: '50', operationsWalletAddress: address('6'), settlementWalletAddress: address('7'), tokenAddress: address('8'), finalJournalId: null, reversalJournalId: null };
}

function reviewPendingPrize() {
  return {
    state: 'REVIEW_PENDING' as const,
    cutoffAt: '2026-07-16T01:00:00.000Z',
    candidate: { orderId: hash('4'), buyerWallet: address('5'), paymentEventKey: 'payment:1', blockNumber: '100', logIndex: '2', evidenceHash: hash('6') },
    poolAmountUsdt: '9', poolSnapshotHash: hash('7'), review: null, awardJournalId: null,
    rolloverTargetSessionId: null, rolloverJournalId: null, payout: null,
  };
}

function governanceChallenge(action: ReturnType<typeof governanceAction>, nonce: string, deadline: string) {
  return {
    artifactVersion, actionId: action.actionId, sessionId: action.sessionId, actionKind: action.actionKind,
    signer: address('2'), executorWallet: action.executorWallet,
    typedData: {
      domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: action.targetAddress },
      types: { SensitiveAction: [
        { name: 'action', type: 'string' }, { name: 'resourceType', type: 'string' }, { name: 'resourceId', type: 'string' },
        { name: 'policyVersion', type: 'uint64' }, { name: 'oldValueHash', type: 'bytes32' }, { name: 'newValueHash', type: 'bytes32' },
        { name: 'executorWallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
      ] },
      primaryType: 'SensitiveAction',
      message: { action: `SECKILL_${action.actionKind}`, resourceType: 'SECKILL_SESSION', resourceId: action.sessionId, policyVersion: action.policyVersion, oldValueHash: hash('e'), newValueHash: hash('f'), executorWallet: action.executorWallet, nonce, deadline },
    },
    digest: hash('9'),
  };
}

function address(digit: string) { return `0x${digit.repeat(40)}`; }

class TestSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedWith: [number | undefined, string | undefined] | null = null;

  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  close(code?: number, reason?: string) { this.closedWith = [code, reason]; }
}

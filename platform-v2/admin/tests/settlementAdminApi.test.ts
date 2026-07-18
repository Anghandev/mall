import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeMonitoringAlert,
  authorizeCoverageBreakerResume,
  createCmsVersion,
  createCoverageBreakerResumeChallenge,
  createNotificationCampaign,
  createPolicyDraft,
  createSystemConfigApprovalChallenge,
  createSystemConfigVersion,
  fetchAdminBusinessDashboard,
  fetchAuditEntries,
  fetchCoverageBreakerActions,
  fetchMerchantFinance,
  fetchMonitoringDashboard,
  fetchNotificationCampaigns,
  fetchNotifications,
  fetchPolicyDrafts,
  fetchSettlementLedger,
  publishSystemConfigVersion,
  publishNotificationCampaign,
  retryNotificationCampaignDeliveries,
} from '../src/settlementAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('settlement/admin coordinated Core client', () => {
  it('consumes the authenticated Admin business dashboard without filling nullable ratios', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(adminBusinessDashboard()));
    vi.stubGlobal('fetch', fetchMock);

    const dashboard = await fetchAdminBusinessDashboard('jwt');
    expect(dashboard).toMatchObject({
      artifactVersion,
      timezone: 'Asia/Shanghai',
      orders: { finalizedToday: '3', shipmentRate: { numerator: '0', denominator: '0', bps: null } },
      settlements: { failedTransactions: '2' },
      risk: { abnormalObservationsToday: '11', blacklistBlocksToday: '12', activeRestrictions: '13', pendingAppeals: '14' },
    });
    expect(dashboard.coverage[0]).toMatchObject({ covered: false });
    expect(dashboard.breakers[0]).toEqual({ scope: 'NEW_PAYMENT', paused: true });
    expect(dashboard.buyers).toEqual({ total: '10', newToday: '2' });
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/dashboard', {
      headers: { authorization: 'Bearer jwt' },
    });
  });

  it('rejects an Admin dashboard that omits an independent breaker scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...adminBusinessDashboard(),
      breakers: [{ scope: 'NEW_PAYMENT', paused: false }],
    })));

    await expect(fetchAdminBusinessDashboard('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('strictly binds coverage recovery challenge and action responses to the signed request', async () => {
    const nonce = '7';
    const deadline = '1800000000';
    const challenge = coverageResumeChallenge(nonce, deadline);
    const resumeAction = coverageAction({
      action: 'RESUME',
      targetPaused: false,
      snapshotId: challenge.snapshotId,
      evidenceHash: challenge.evidenceHash,
      policyVersion: challenge.policyVersion,
      governanceWalletAddress: challenge.executorWallet,
      routerAddress: challenge.routerAddress,
      actorWallet: address('1'),
      secondarySigner: challenge.signer,
      secondarySignatureHash: hash('8'),
      approvalNonce: nonce,
      approvalDeadline: new Date(Number(deadline) * 1_000).toISOString(),
      state: 'PENDING_EXECUTION',
      executorNonce: null,
      submittedTxHash: null,
      executionEvidenceHash: null,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/actions')) return jsonResponse([coverageAction()]);
      if (url.endsWith('/resume-challenge')) return jsonResponse(challenge);
      if (url.endsWith('/resume-actions')) return jsonResponse(resumeAction, 201);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCoverageBreakerActions('jwt')).resolves.toMatchObject([{ action: 'PAUSE', state: 'FINAL', executorNonce: '12' }]);
    const received = await createCoverageBreakerResumeChallenge({ nonce, deadline }, 'jwt');
    await expect(authorizeCoverageBreakerResume({
      snapshotId: received.snapshotId,
      nonce,
      deadline,
      signature: '0x1234',
    }, received, address('1'), 'jwt')).resolves.toMatchObject({ action: 'RESUME', state: 'PENDING_EXECUTION' });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v2/admin/coverage-breaker/resume-challenge', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ nonce, deadline }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/v2/admin/coverage-breaker/resume-actions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ snapshotId: challenge.snapshotId, nonce, deadline, signature: '0x1234' }),
    }));
  });

  it('rejects coverage responses with extra fields or mismatched signed intent fields', async () => {
    const nonce = '7';
    const deadline = '1800000000';
    const challenge = coverageResumeChallenge(nonce, deadline);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([{
      ...coverageAction(),
      uiAuthorized: true,
    }])).mockResolvedValueOnce(jsonResponse({
      ...challenge,
      typedData: {
        ...challenge.typedData,
        message: { ...challenge.typedData.message, nonce: '8' },
      },
    })));

    await expect(fetchCoverageBreakerActions('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(createCoverageBreakerResumeChallenge({ nonce, deadline }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('accepts the coordinated SUPERSEDED terminal state for a stale resume action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([coverageAction({
      action: 'RESUME',
      targetPaused: false,
      state: 'SUPERSEDED',
    })])));

    await expect(fetchCoverageBreakerActions('jwt')).resolves.toMatchObject([{
      action: 'RESUME',
      state: 'SUPERSEDED',
      targetPaused: false,
    }]);
  });

  it('rejects a non-canonical Safe nonce', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([coverageAction({ executorNonce: '01' })])));

    await expect(fetchCoverageBreakerActions('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('rejects a resume action that is not bound to the challenge signer and session actor', async () => {
    const nonce = '7';
    const deadline = '1800000000';
    const challenge = coverageResumeChallenge(nonce, deadline);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(coverageAction({
      action: 'RESUME',
      targetPaused: false,
      snapshotId: challenge.snapshotId,
      evidenceHash: challenge.evidenceHash,
      policyVersion: challenge.policyVersion,
      governanceWalletAddress: challenge.executorWallet,
      routerAddress: challenge.routerAddress,
      actorWallet: address('9'),
      secondarySigner: challenge.signer,
      secondarySignatureHash: hash('8'),
      approvalNonce: nonce,
      approvalDeadline: new Date(Number(deadline) * 1_000).toISOString(),
    }), 201)));

    await expect(authorizeCoverageBreakerResume({
      snapshotId: challenge.snapshotId,
      nonce,
      deadline,
      signature: '0x1234',
    }, challenge, address('1'), 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('keeps Core breaker and secondary-signature failures closed', async () => {
    const nonce = '7';
    const deadline = '1800000000';
    const challenge = coverageResumeChallenge(nonce, deadline);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'BreakerActive', message: 'Coverage remains below 100%', correlationId: 'coverage-blocked' } }, 409))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'InvalidSignature', message: 'Secondary signer mismatch', correlationId: 'coverage-signature' } }, 401)));

    await expect(createCoverageBreakerResumeChallenge({ nonce, deadline }, 'jwt')).rejects.toMatchObject({
      code: 'BreakerActive', status: 409,
    });
    await expect(authorizeCoverageBreakerResume({
      snapshotId: challenge.snapshotId,
      nonce,
      deadline,
      signature: '0xwrong',
    }, challenge, address('1'), 'jwt')).rejects.toMatchObject({
      code: 'InvalidResponse', status: 502,
    });
    await expect(authorizeCoverageBreakerResume({
      snapshotId: challenge.snapshotId,
      nonce,
      deadline,
      signature: '0x1234',
    }, challenge, address('1'), 'jwt')).rejects.toMatchObject({
      code: 'InvalidSignature', status: 401,
    });
  });

  it('rejects a settlement projection from a stale artifact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      artifactVersion: '2.0.0-stale', wallet: address('1'), balances: [], points: [], requests: [],
    })));

    await expect(fetchSettlementLedger('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('validates the wallet-scoped settlement state and final Safe TxHash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      artifactVersion,
      wallet: address('1'),
      balances: [
        { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'SUBMITTED', amount: '45' },
        { asset: 'NPL', purpose: 'REWARD', rewardSubtype: 'GENESIS', state: 'AVAILABLE', amount: '8' },
      ],
      points: [{ pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'AVAILABLE', amount: '100', transferable: false }],
      requests: [{ rail: 'MERCHANT_USDT', state: 'SETTLED', amount: '45', recipient_address: address('1'), final_execution_tx_hashes: [hash('2')] }],
    })));

    await expect(fetchSettlementLedger('jwt')).resolves.toMatchObject({
      artifactVersion,
      balances: [{ rewardSubtype: null }, { rewardSubtype: 'GENESIS' }],
      points: [{ pointsType: 'BNM', state: 'AVAILABLE', transferable: false }],
      requests: [{ state: 'SETTLED', final_execution_tx_hashes: [hash('2')] }],
    });
  });

  it('rejects a pre-.2 settlement projection without reward subtype and BNM points', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      artifactVersion,
      wallet: address('1'),
      balances: [{ asset: 'NPL', purpose: 'REWARD', state: 'AVAILABLE', amount: '8' }],
      requests: [],
    })));

    await expect(fetchSettlementLedger('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('binds policy, CMS and system-config writes to their published endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/policy-drafts')) return jsonResponse(policyDraft(), 201);
      if (url.endsWith('/cms/versions')) return jsonResponse(cmsVersion(), 201);
      if (url.endsWith('/system-config/versions')) return jsonResponse(systemConfig(), 201);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await createPolicyDraft({ payload: { policyVersion: '2' }, idempotencyKey: 'policy-create-1' }, 'jwt');
    await createCmsVersion({ slug: 'rules', contentType: 'SECKILL_RULES', placement: 'seckill', locale: 'zh-CN', contentFormat: 'STRUCTURED_RICH_TEXT', content: { blocks: [] }, audience: {}, idempotencyKey: 'cms-create-1' }, 'jwt');
    await createSystemConfigVersion({ configKey: 'RPC', payload: { primaryReference: 'secret://rpc-primary' }, effectiveFrom: '2026-07-16T00:00:00.000Z', idempotencyKey: 'config-create-1' }, 'jwt');

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/v2/admin/policy-drafts', '/v2/admin/cms/versions', '/v2/admin/system-config/versions',
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer jwt' } });
  });

  it('serializes audit filters server-side and preserves chain proof', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      entries: [{ entryId: 'audit-1', streamName: 'financial', evidenceProfile: 'CHAIN_FINAL', eventType: 'SettlementFinalized', resourceType: 'SETTLEMENT_BATCH', resourceId: 'batch-1', correlationId: 'corr-1', entryHash: hash('3'), createdAt: '2026-07-15T00:00:00.000Z' }],
      chainProof: { financial: { verified: true, entries: 1, headHash: hash('3') } }, nextCursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const filters = {
      streamName: 'financial',
      resourceId: 'batch-1',
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-15T23:59:59.000Z',
      limit: 25,
      stream: 'must-not-leak',
      dateFrom: 'must-not-leak',
      dateTo: 'must-not-leak',
    } as const;
    await expect(fetchAuditEntries(filters, 'jwt')).resolves.toMatchObject({ chainProof: { financial: { verified: true } } });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://admin.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      streamName: 'financial',
      resourceId: 'batch-1',
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-15T23:59:59.000Z',
      limit: '25',
    });
  });

  it('publishes system config only with the complete SensitiveApproval body', async () => {
    const challenge = systemConfigChallenge();
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/approval-challenge')
      ? jsonResponse(challenge)
      : jsonResponse({ ...systemConfig(), published: true }));
    vi.stubGlobal('fetch', fetchMock);
    const received = await createSystemConfigApprovalChallenge('config-1', { nonce: '9', deadline: '1800000000' }, 'jwt');
    const approval = { action: received.action, resourceType: received.resourceType, resourceId: received.resourceId, policyVersion: received.policyVersion, oldValueHash: received.oldValueHash, newValueHash: received.newValueHash, executorWallet: received.executorWallet, nonce: received.nonce, deadline: received.deadline, signature: '0xsecondary' };

    await expect(publishSystemConfigVersion('config-1', approval, 'jwt')).resolves.toMatchObject({ published: true });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v2/admin/system-config/versions/config-1/approval-challenge', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ nonce: '9', deadline: '1800000000' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v2/admin/system-config/versions/config-1/publish', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ approval }),
    }));
  });

  it('renders unavailable metrics as null and binds alert acknowledgement to the exact key', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/acknowledge')
      ? jsonResponse({ alertKey: 'rpc-height', state: 'ACKNOWLEDGED' })
      : jsonResponse({
        metrics: [{ snapshotId: 'snap-1', component: 'RPC_PRIMARY', metricName: 'heightLag', unit: 'BLOCK', value: null, status: 'CONFIGURATION_REQUIRED', windowStartedAt: '2026-07-15T00:00:00.000Z', windowEndedAt: '2026-07-15T00:01:00.000Z', evidence: {}, observedAt: '2026-07-15T00:01:00.000Z' }],
        alerts: [{ alertEventId: 'alert-1', alertKey: 'rpc-height', state: 'OPENED', severity: 'CRITICAL', snapshotId: 'snap-1', actorWallet: null, createdAt: '2026-07-15T00:01:00.000Z' }],
        coverage: [{ asset: 'USDT', wallet_address: address('4'), assets: '100', unsettled_liabilities: '101', covered: false, observed_at: '2026-07-15T00:01:00.000Z' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMonitoringDashboard('jwt')).resolves.toMatchObject({ metrics: [{ value: null, status: 'CONFIGURATION_REQUIRED' }], coverage: [{ covered: false }] });
    await expect(acknowledgeMonitoringAlert('rpc-height', 'jwt')).resolves.toEqual({ alertKey: 'rpc-height', state: 'ACKNOWLEDGED' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/v2/admin/monitoring/alerts/rpc-height/acknowledge');
  });

  it('consumes inbox and campaign projections, then publishes and retries only the exact campaign', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v2/notifications?')) return jsonResponse([{ messageId: 'message-1', sourceEventType: 'SettlementFinalized', topic: 'settlement', templateData: { state: 'SETTLED' }, deliveryState: 'DELIVERED', createdAt: '2026-07-15T00:00:00.000Z' }]);
      if (url.includes('/v2/admin/notification-campaigns?')) return jsonResponse([notificationCampaign()]);
      if (url.endsWith('/retry-failed')) return jsonResponse({ campaignId: 'campaign-1', state: 'RETRY_SCHEDULED', retriedDeliveries: 2 });
      if (url.endsWith('/publish')) return jsonResponse({ campaignId: 'campaign-1', state: 'PUBLISHED' });
      return jsonResponse({ campaignId: 'campaign-1', state: 'DRAFT', contentHash: hash('6') }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNotifications('jwt')).resolves.toMatchObject([{ deliveryState: 'DELIVERED' }]);
    await expect(fetchNotificationCampaigns('jwt')).resolves.toMatchObject([{ state: 'PUBLISHED', allowedActions: ['RETRY_FAILED'] }]);
    await expect(createNotificationCampaign({ topic: 'ANNOUNCEMENT', audience: { type: 'ALL' }, message: { titleKey: 'NOTICE_TITLE', bodyKey: 'NOTICE_BODY', variables: {} }, idempotencyKey: 'campaign-create-1' }, 'jwt')).resolves.toMatchObject({ state: 'DRAFT' });
    await expect(publishNotificationCampaign('campaign-1', hash('7'), 'jwt')).resolves.toEqual({ campaignId: 'campaign-1', state: 'PUBLISHED' });
    await expect(retryNotificationCampaignDeliveries('campaign-1', 'jwt')).resolves.toEqual({ campaignId: 'campaign-1', state: 'RETRY_SCHEDULED', retriedDeliveries: 2 });
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/notification-campaigns/campaign-1/retry-failed', expect.objectContaining({ method: 'POST', body: '{}' }));
  });

  it('rejects malformed campaign actions, counts and create requests before product use', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{
      ...notificationCampaign(),
      deliveryCounts: { ...notificationCampaign().deliveryCounts, DEAD_LETTER: -1 },
      allowedActions: ['PUBLISH'],
    }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNotificationCampaigns('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(createNotificationCampaign({
      topic: 'ACTIVITY',
      audience: { type: 'REGION', regionCodes: ['21020'] },
      message: { titleKey: 'TITLE', bodyKey: 'BODY', variables: {} },
      idempotencyKey: 'campaign-create-2',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed merchant guarantee and debt values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      merchant: { merchant_id: 'merchant-1', status: 'ACTIVE', guarantee_status: 'READY', settlement_wallet: address('1') },
      guarantee: { balance_usdt: '-1', minimum_usdt: '1000000000' }, guaranteeDeposits: [], debt: null, takeovers: [],
    })));
    await expect(fetchMerchantFinance('merchant-1', 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('requires every policy list item to match the coordinated state enum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ ...policyDraft(), state: 'PUBLISHED_BY_UI' }])));
    await expect(fetchPolicyDrafts('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });
});

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }
function notificationCampaign() {
  return {
    campaignId: 'campaign-1', topic: 'ANNOUNCEMENT', audience: { type: 'ALL' },
    message: { titleKey: 'NOTICE_TITLE', bodyKey: 'NOTICE_BODY', variables: { source: 'platform' } },
    contentHash: hash('6'), cmsVersionId: null, startsAt: null, endsAt: null,
    state: 'PUBLISHED', createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z',
    publishedAt: '2026-07-15T00:01:00.000Z',
    deliveryCounts: { PENDING: 0, PROCESSING: 0, DELIVERED: 7, RETRY: 1, CONFIGURATION_REQUIRED: 1, DEAD_LETTER: 0 },
    allowedActions: ['RETRY_FAILED'],
  };
}
function coverageResumeChallenge(nonce: string, deadline: string) {
  const snapshotId = hash('1');
  const executorWallet = address('4');
  const routerAddress = address('3');
  return {
    artifactVersion,
    snapshotId,
    evidenceHash: hash('2'),
    policyVersion: '2',
    signer: address('2'),
    executorWallet,
    routerAddress,
    typedData: {
      domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: routerAddress },
      types: { SensitiveAction: [
        { name: 'action', type: 'string' },
        { name: 'resourceType', type: 'string' },
        { name: 'resourceId', type: 'string' },
        { name: 'policyVersion', type: 'uint64' },
        { name: 'oldValueHash', type: 'bytes32' },
        { name: 'newValueHash', type: 'bytes32' },
        { name: 'executorWallet', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ] },
      primaryType: 'SensitiveAction',
      message: {
        action: 'RESUME_NEW_PAYMENTS', resourceType: 'COVERAGE_BREAKER', resourceId: snapshotId,
        policyVersion: '2', oldValueHash: hash('3'), newValueHash: hash('4'), executorWallet, nonce, deadline,
      },
    },
    digest: hash('5'),
  };
}
function coverageAction(overrides: Record<string, unknown> = {}) {
  return {
    artifactVersion,
    actionId: hash('6'),
    snapshotId: hash('1'),
    policyVersion: '2',
    action: 'PAUSE',
    targetPaused: true,
    evidenceHash: hash('2'),
    governanceWalletAddress: address('4'),
    routerAddress: address('3'),
    calldataHash: hash('7'),
    state: 'FINAL',
    executorNonce: '12',
    submittedTxHash: hash('8'),
    executionEvidenceHash: hash('9'),
    executionTxHash: hash('a'),
    confirmations: 15,
    actorWallet: null,
    secondarySigner: null,
    secondarySignatureHash: null,
    approvalNonce: null,
    approvalDeadline: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:05:00.000Z',
    ...overrides,
  };
}
function adminBusinessDashboard() {
  return {
    artifactVersion,
    timezone: 'Asia/Shanghai',
    window: {
      start: '2026-07-14T16:00:00.000Z',
      end: '2026-07-15T16:00:00.000Z',
      generatedAt: '2026-07-15T04:00:00.000Z',
    },
    orders: {
      finalizedToday: '3', listPriceUsdt: '300000000', buyerUsdtPaid: '210000000',
      pendingShipment: '4', shipped: '5', delivered: '6', fulfilled: '7',
      shipmentRate: { numerator: '0', denominator: '0', bps: null },
    },
    buyers: { total: '10', newToday: '2' },
    merchants: { total: '8', newToday: '1', pending: '2', approved: '5', suspended: '1' },
    products: { total: '9', pendingReview: '3', soldOut: '2' },
    seckill: { createdToday: '1', active: '1', settling: '0' },
    fulfillmentQueues: { exchange: '1', delay: '2', arbitration: '3', forcedReceipt: '4', takeover: '5' },
    settlements: { requestedCount: '6', requestedUsdt: '600000000', settledCount: '4', settledUsdt: '400000000', failedTransactions: '2' },
    risk: { abnormalObservationsToday: '11', blacklistBlocksToday: '12', activeRestrictions: '13', pendingAppeals: '14' },
    coverage: [{ snapshotId: 'coverage-1', blockNumber: '123', recordedAt: '2026-07-15T04:00:00.000Z', asset: 'USDT', walletAddress: address('4'), verifiedAssets: '100', unsettledLiabilities: '101', covered: false }],
    breakers: [
      { scope: 'NEW_PAYMENT', paused: true },
      { scope: 'SECKILL_PURCHASE', paused: false },
      { scope: 'NEW_SETTLEMENT_BATCH', paused: true },
    ],
    unavailable: [
      { metric: 'LOW_STOCK_PRODUCTS', reasonCode: 'DecisionBlocked', detail: 'Low-stock threshold is not frozen' },
    ],
  };
}
function policyDraft() { return { draftId: 'draft-1', nextPolicyVersion: '2', basePolicyVersion: '1', artifactVersion, payload: {}, validationErrors: [], state: 'DRAFT', policyHash: null, operationsHash: null, publicationDigest: null, publicationNonce: null, publicationDeadline: null, secondarySigner: null, secondarySignatureHash: null, governanceWallet: null, executionCalldataHash: null, executionTxHash: null, executionEvidenceHash: null, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }; }
function cmsVersion() { return { entryId: 'entry-1', versionId: 'version-1', version: 1, slug: 'rules', contentType: 'SECKILL_RULES', placement: 'seckill', locale: 'zh-CN', contentFormat: 'STRUCTURED_RICH_TEXT', content: {}, contentHash: hash('4'), audience: {}, startsAt: null, endsAt: null, frequencyCap: null, policyVersion: '2', published: false, publicationType: null, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z' }; }
function systemConfig() { return { configVersionId: 'config-1', configKey: 'RPC', version: 1, payload: {}, payloadHash: hash('5'), effectiveFrom: '2026-07-16T00:00:00.000Z', published: false, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z' }; }
function systemConfigChallenge() {
  const message = { action: 'PUBLISH_SYSTEM_CONFIG', resourceType: 'SYSTEM_CONFIG', resourceId: 'config-1', policyVersion: '2', oldValueHash: hash('1'), newValueHash: hash('2'), executorWallet: address('3'), nonce: '9', deadline: '1800000000' };
  return { configVersionId: 'config-1', signer: address('4'), ...message, typedData: { domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: address('5') }, types: { SensitiveAction: [] }, primaryType: 'SensitiveAction', message }, digest: hash('6') };
}

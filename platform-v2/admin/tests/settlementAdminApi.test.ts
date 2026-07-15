import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeMonitoringAlert,
  createCmsVersion,
  createNotificationCampaign,
  createPolicyDraft,
  createSystemConfigVersion,
  fetchAuditEntries,
  fetchMerchantFinance,
  fetchMonitoringDashboard,
  fetchNotifications,
  fetchPolicyDrafts,
  fetchSettlementLedger,
  publishSystemConfigVersion,
  publishNotificationCampaign,
} from '../src/settlementAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('settlement/admin coordinated Core client', () => {
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
        { asset: 'USDT', purpose: 'MERCHANT_RECEIVABLE', rewardSubtype: null, state: 'BATCHED', amount: '45' },
        { asset: 'NPL', purpose: 'REWARD', rewardSubtype: 'GENESIS', state: 'AVAILABLE', amount: '8' },
      ],
      points: [{ pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'AVAILABLE', amount: '100', transferable: false }],
      requests: [{ rail: 'MERCHANT_USDT', state: 'SETTLED', amount: '45', recipient_address: address('1'), final_safe_tx_hash: hash('2') }],
    })));

    await expect(fetchSettlementLedger('jwt')).resolves.toMatchObject({
      artifactVersion,
      balances: [{ rewardSubtype: null }, { rewardSubtype: 'GENESIS' }],
      points: [{ pointsType: 'BNM', state: 'AVAILABLE', transferable: false }],
      requests: [{ state: 'SETTLED', final_safe_tx_hash: hash('2') }],
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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...systemConfig(), published: true }));
    vi.stubGlobal('fetch', fetchMock);
    const approval = { action: 'PUBLISH_SYSTEM_CONFIG', resourceType: 'SYSTEM_CONFIG', resourceId: 'config-1', policyVersion: '2', oldValueHash: hash('1'), newValueHash: hash('2'), safeAddress: address('3'), nonce: '9', deadline: '1800000000', signature: '0xsecondary' };

    await expect(publishSystemConfigVersion('config-1', approval, 'jwt')).resolves.toMatchObject({ published: true });
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/system-config/versions/config-1/publish', expect.objectContaining({
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
        coverage: [{ asset: 'USDT', safe_address: address('4'), assets: '100', unsettled_liabilities: '101', covered: false, observed_at: '2026-07-15T00:01:00.000Z' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMonitoringDashboard('jwt')).resolves.toMatchObject({ metrics: [{ value: null, status: 'CONFIGURATION_REQUIRED' }], coverage: [{ covered: false }] });
    await expect(acknowledgeMonitoringAlert('rpc-height', 'jwt')).resolves.toEqual({ alertKey: 'rpc-height', state: 'ACKNOWLEDGED' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/v2/admin/monitoring/alerts/rpc-height/acknowledge');
  });

  it('consumes wallet inbox events and publishes a campaign with evidence', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v2/notifications?')) return jsonResponse([{ messageId: 'message-1', sourceEventType: 'SettlementFinalized', topic: 'settlement', templateData: { state: 'SETTLED' }, deliveryState: 'DELIVERED', createdAt: '2026-07-15T00:00:00.000Z' }]);
      if (url.endsWith('/publish')) return jsonResponse({ campaignId: 'campaign-1', state: 'PUBLISHED' });
      return jsonResponse({ campaignId: 'campaign-1', state: 'DRAFT', contentHash: hash('6') }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNotifications('jwt')).resolves.toMatchObject([{ deliveryState: 'DELIVERED' }]);
    await expect(createNotificationCampaign({ topic: 'ANNOUNCEMENT', audience: {}, message: { title: 'Notice' }, idempotencyKey: 'campaign-create-1' }, 'jwt')).resolves.toMatchObject({ state: 'DRAFT' });
    await expect(publishNotificationCampaign('campaign-1', hash('7'), 'jwt')).resolves.toEqual({ campaignId: 'campaign-1', state: 'PUBLISHED' });
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
function policyDraft() { return { draftId: 'draft-1', nextPolicyVersion: '2', basePolicyVersion: '1', artifactVersion, payload: {}, validationErrors: [], state: 'DRAFT', policyHash: null, operationsHash: null, publicationDigest: null, publicationNonce: null, publicationDeadline: null, secondarySigner: null, secondarySignatureHash: null, safeAddress: null, safeCalldataHash: null, safeTxHash: null, safeProposalHash: null, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }; }
function cmsVersion() { return { entryId: 'entry-1', versionId: 'version-1', version: 1, slug: 'rules', contentType: 'SECKILL_RULES', placement: 'seckill', locale: 'zh-CN', contentFormat: 'STRUCTURED_RICH_TEXT', content: {}, contentHash: hash('4'), audience: {}, startsAt: null, endsAt: null, frequencyCap: null, policyVersion: '2', published: false, publicationType: null, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z' }; }
function systemConfig() { return { configVersionId: 'config-1', configKey: 'RPC', version: 1, payload: {}, payloadHash: hash('5'), effectiveFrom: '2026-07-16T00:00:00.000Z', published: false, createdBy: address('1'), createdAt: '2026-07-15T00:00:00.000Z' }; }

import { artifactVersion, type MerchantLifecycleDetail } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMerchantApplication,
  createMerchantReviewChallenge,
  getMerchantLifecycle,
  listMerchantLifecycle,
  publishMerchantReview,
  updateMerchantApplication,
  uploadMerchantLicense,
} from '../src/merchantLifecycleApi';

afterEach(() => vi.unstubAllGlobals());

describe('merchant lifecycle admin API', () => {
  it('binds status/search list and detail reads to the coordinated artifact', async () => {
    const detail = merchantDetail();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v2/admin/merchants?')) return jsonResponse({ artifactVersion, merchants: [detail.merchant], nextCursor: null });
      if (url.endsWith('/v2/admin/merchants/merchant-1')) return jsonResponse(detail);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMerchantLifecycle({ status: 'PENDING', search: '24K', limit: 25 }, 'jwt')).resolves.toMatchObject({ merchants: [{ merchantId: 'merchant-1' }] });
    await expect(getMerchantLifecycle('merchant-1', 'jwt')).resolves.toMatchObject({
      merchant: { settlementWalletMutable: false },
      analytics: { fulfillment: { fastShip48h: { status: 'AVAILABLE', numerator: '3', denominator: '4', bps: 7500 } } },
    });

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://admin.example');
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({ status: 'PENDING', search: '24K', limit: '25' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer jwt' } });
  });

  it('creates a pending application and updates the exact expected application version', async () => {
    const created = merchantDetail();
    const updated = merchantDetail({
      merchant: { ...created.merchant, applicationVersion: 2, qualificationComplete: true },
      qualification: { ...fullQualification(), version: 2, licenseAssetId: hash('a') },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/admin/merchants')) return jsonResponse(created, 201);
      if (url.endsWith('/v2/admin/merchants/merchant-1/application')) return jsonResponse(updated);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await createMerchantApplication({ shopName: '阿步金店', legalName: '阿步黄金有限公司', legalId: 'LICENSE-001', contactPhone: '13800138000', settlementWallet: address('3'), idempotencyKey: 'merchant-create-1' }, 'jwt');
    await updateMerchantApplication('merchant-1', { shopName: '阿步金店', legalName: '阿步黄金有限公司', legalId: 'LICENSE-001', contactPhone: '13800138000', licenseAssetId: hash('a'), expectedVersion: 1, idempotencyKey: 'merchant-update-1' }, 'jwt');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ shopName: '阿步金店', legalName: '阿步黄金有限公司', legalId: 'LICENSE-001', contactPhone: '13800138000', settlementWallet: address('3'), idempotencyKey: 'merchant-create-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ expectedVersion: 1, licenseAssetId: hash('a') });
  });

  it('binds the secondary EIP-712 challenge and requires published EOA evidence', async () => {
    const current = merchantDetail({ merchant: { ...merchantDetail().merchant, qualificationComplete: true }, qualification: { ...fullQualification(), licenseAssetId: hash('a') } });
    const challenge = reviewChallenge();
    const published = merchantDetail({
      merchant: { ...current.merchant, status: 'APPROVED', reviewedAt: '2026-07-16T01:00:00.000Z', reviewedBy: address('1') },
      qualification: current.qualification,
      reviews: [{ actionId: challenge.actionId, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED', applicationVersion: 1, reasonCode: 'QUALIFICATION_APPROVED', state: 'PUBLISHED', secondarySigner: address('2'), actionDigest: challenge.digest, approvalSignatureHash: hash('f'), createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T01:00:00.000Z' }],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/review-challenges')) return jsonResponse(challenge, 201);
      if (url.endsWith(`/review-actions/${challenge.actionId}/publish`)) return jsonResponse(published);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const bound = await createMerchantReviewChallenge(current, { action: 'APPROVE', reasonCode: 'QUALIFICATION_APPROVED', idempotencyKey: 'review-approve-1' }, 'jwt');
    await expect(publishMerchantReview(bound, '0x1234', 'jwt')).resolves.toMatchObject({ merchant: { status: 'APPROVED' }, reviews: [{ approvalSignatureHash: hash('f') }] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ signature: '0x1234' });
  });

  it('rejects settlement wallet changes before any challenge or EOA publish request', async () => {
    const current = merchantDetail({ merchant: { ...merchantDetail().merchant, status: 'APPROVED' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createMerchantReviewChallenge(current, {
      action: 'CHANGE_SETTLEMENT_WALLET' as never, reasonCode: 'WALLET_ROTATION', idempotencyKey: 'wallet-change-1',
    }, 'jwt')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts zero-denominator unavailable 48H rate without inventing zero percent', async () => {
    const detail = merchantDetail();
    const unavailable = merchantDetail({
      analytics: {
        ...detail.analytics,
        fulfillment: { ...detail.analytics.fulfillment, fastShip48h: { status: 'UNAVAILABLE', numerator: '0', denominator: '0', bps: null, reason: 'NO_ELIGIBLE_DELIVERY_ORDERS' } },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(unavailable)));

    await expect(getMerchantLifecycle('merchant-1', 'jwt')).resolves.toMatchObject({
      analytics: { fulfillment: { fastShip48h: { status: 'UNAVAILABLE', denominator: '0', bps: null } } },
    });
  });

  it('accepts the frozen platform technical wallet as both admin actor and secondary signer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...reviewChallenge(), secondarySigner: address('1') }, 201)));
    await expect(createMerchantReviewChallenge(merchantDetail(), { action: 'APPROVE', reasonCode: 'QUALIFICATION_APPROVED', idempotencyKey: 'review-approve-1' }, 'jwt')).resolves.toMatchObject({ secondarySigner: address('1') });
  });

  it('uploads a purpose-bound license and completes provider-sealed media', async () => {
    const uploadUrl = 'https://storage.example/license';
    let intent: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/media/upload-intents')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        intent = {
          artifactVersion, uploadIntentId: hash('8'), ownerWallet: address('1'), purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT',
          resourceId: 'merchant-1', contentType: request.contentType, sizeBytes: String(request.sizeBytes), contentSha256: request.contentSha256,
          state: 'UPLOADED', expiresAt: '2099-01-01T00:00:00.000Z', method: 'PUT', uploadUrl, headers: { 'x-upload': 'sealed' }, providerReferenceHash: hash('9'), writeOnce: true,
        };
        return jsonResponse(intent, 201);
      }
      if (url === uploadUrl) return new Response('', { status: 200 });
      if (url.endsWith(`/v2/media/upload-intents/${hash('8')}/complete`)) {
        return jsonResponse({
          artifactVersion, assetId: hash('a'), uploadIntentId: hash('8'), ownerWallet: address('1'), purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT', resourceId: 'merchant-1',
          contentType: intent?.contentType, sizeBytes: intent?.sizeBytes, contentSha256: intent?.contentSha256, providerEvidenceHash: hash('b'), objectVersionHash: hash('c'), createdAt: '2026-07-16T00:00:00.000Z',
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const asset = await uploadMerchantLicense('merchant-1', new File(['verified license'], 'license.pdf', { type: 'application/pdf' }), 'license-upload-1', address('1'), 'jwt');
    expect(asset).toMatchObject({ assetId: hash('a'), purpose: 'MERCHANT_LICENSE', resourceId: 'merchant-1' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', body: expect.any(File) });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-upload')).toBe('sealed');
  });
});

function merchantDetail(overrides: Partial<MerchantLifecycleDetail> = {}): MerchantLifecycleDetail {
  const base: MerchantLifecycleDetail = {
    artifactVersion,
    merchant: { merchantId: 'merchant-1', shopName: '阿步金店', settlementWallet: address('3'), settlementWalletMutable: false, status: 'PENDING', guaranteeStatus: 'READY', applicationVersion: 1, qualificationComplete: false, reviewedAt: null, reviewedBy: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z' },
    qualification: fullQualification(),
    analytics: {
      orders: { totalFinalized: '3', ordinaryFinalized: '2', seckillFinalized: '1', cumulative: amounts('100', '70', '60', '55'), today: amounts('20', '14', '12', '11'), timezone: 'Asia/Shanghai', window: { start: '2026-07-15T16:00:00.000Z', end: '2026-07-16T16:00:00.000Z' } },
      fulfillment: { pendingShipment: '1', inTransit: '1', completed: '1', pickupCompleted: '0', fastShip48h: { status: 'AVAILABLE', numerator: '3', denominator: '4', bps: 7500, reason: null } },
      risk: { takeoverCases: '1', guaranteeUsedUsdt: '2', frozenReceivableUsedUsdt: '3', futureProceedsUsedUsdt: '4', platformAdvanceUsdt: '5', outstandingDebtUsdt: '6', abnormalOrderRateBps: null, unavailableReason: 'DecisionBlocked' },
      contributions: { finalizedNplBurnAmount: '7', fulfillmentAvailableBnmAmount: '8', ledgerReconciled: true },
    },
    balances: ['LOCKED', 'AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'].map((state, index) => ({ state: state as MerchantLifecycleDetail['balances'][number]['state'], amount: String(index + 1) })),
    settlements: [{ requestId: hash('d'), asset: 'USDT', amount: '5', state: 'SETTLED', requestedAt: '2026-07-16T00:00:00.000Z', finalExecutionTxHashes: [hash('e')], settledAt: '2026-07-16T01:00:00.000Z' }],
    reviews: [],
  };
  return { ...base, ...overrides };
}

function fullQualification() {
  return { access: 'FULL' as const, legalName: '阿步黄金有限公司', legalId: 'LICENSE-001', contactPhone: '13800138000', licenseAssetId: null, payloadHash: hash('1'), retentionPolicyVersion: 'pii-v1', version: 1, updatedAt: '2026-07-16T00:00:00.000Z' };
}

function reviewChallenge() {
  const expiresAt = '2099-01-01T00:00:00.000Z';
  return {
    artifactVersion, actionId: hash('7'), merchantId: 'merchant-1', action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED', applicationVersion: 1,
    reasonCode: 'QUALIFICATION_APPROVED', state: 'DRAFT', secondarySigner: address('2'), expiresAt,
    typedData: { domain: { name: 'Abu24KV2Core' }, types: { SensitiveAction: [] }, primaryType: 'SensitiveAction', message: { action: 'APPROVE_MERCHANT', resourceType: 'MERCHANT', resourceId: 'merchant-1', policyVersion: '2', oldValueHash: hash('2'), newValueHash: hash('3'), executorWallet: address('4'), nonce: '7', deadline: String(Math.floor(Date.parse(expiresAt) / 1_000)) } },
    digest: hash('6'),
  } as const;
}

function amounts(listPriceUsdt: string, buyerPaidUsdt: string, merchantBaseReceivableUsdt: string, merchantNetReceivableUsdt: string) { return { listPriceUsdt, buyerPaidUsdt, merchantBaseReceivableUsdt, merchantNetReceivableUsdt }; }
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

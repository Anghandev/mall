import { artifactVersion, type MerchantLifecycleDetail, type UserRole } from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => { vi.unstubAllGlobals(); delete window.ethereum; });

describe('merchant lifecycle page', () => {
  it('stays closed before SIWE and gives AUDITOR only the redacted drilldown', async () => {
    const wallet = address('1');
    const base = merchantDetail();
    const redacted = merchantDetail({
      qualification: { ...qualification(), access: 'REDACTED', legalName: '阿步***公司', legalId: 'LIC***001', contactPhone: '138****8000', licenseAssetId: hash('a') },
      analytics: { ...base.analytics, fulfillment: { ...base.analytics.fulfillment, fastShip48h: { status: 'UNAVAILABLE', numerator: '0', denominator: '0', bps: null, reason: 'NO_ELIGIBLE_DELIVERY_ORDERS' } } },
    });
    window.ethereum = walletProvider(wallet);
    const fetchMock = merchantFetch(wallet, 'AUDITOR', () => redacted);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderMerchantPage();
    expect(screen.getByText('连接平台钱包')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/admin/merchants'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('阿步***公司')).toBeTruthy();
    expect(screen.getByText('138****8000')).toBeTruthy();
    expect(screen.getByText(/AUDITOR 仅显示 Core 脱敏字段/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '新建商家资质' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '更新资质版本' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '商家审核发布' })).toBeNull();
    expect(screen.queryByRole('button', { name: '获取受控地址' })).toBeNull();
    expect(screen.getByText(/NO_ELIGIBLE_DELIVERY_ORDERS/)).toBeTruthy();
    expect(screen.getByText('不可用', { selector: 'dd' })).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('lets OPERATOR create qualification, upload a verified license and save a new version', async () => {
    const wallet = address('1');
    let current: MerchantLifecycleDetail | null = null;
    let uploadRequest: Record<string, unknown> | null = null;
    window.ethereum = walletProvider(wallet);
    const fetchMock = merchantFetch(wallet, 'OPERATOR', () => current, async (url, init) => {
      if (url.endsWith('/v2/admin/merchants') && init?.method === 'POST') {
        current = merchantDetail(); return jsonResponse(current, 201);
      }
      if (url.endsWith('/v2/media/upload-intents')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        uploadRequest = request;
        return jsonResponse(uploadIntent(request, wallet), 201);
      }
      if (url === 'https://storage.example/license') return new Response('', { status: 200 });
      if (url.endsWith(`/v2/media/upload-intents/${hash('8')}/complete`) && uploadRequest) return jsonResponse(mediaAsset(wallet, uploadRequest));
      if (url.endsWith('/v2/admin/merchants/merchant-1/application')) {
        current = merchantDetail({ merchant: { ...merchantDetail().merchant, applicationVersion: 2, qualificationComplete: true }, qualification: { ...qualification(), version: 2, licenseAssetId: hash('a') } });
        return jsonResponse(current);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderMerchantPage();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '创建申请' }));
    const createForm = screen.getByRole('heading', { name: '新建商家资质' }).closest('section')!;
    expect(within(createForm).queryByLabelText('商家等级')).toBeNull();
    await user.type(within(createForm).getByLabelText('店铺名称'), '阿步金店');
    await user.type(within(createForm).getByLabelText('主体名称'), '阿步黄金有限公司');
    await user.type(within(createForm).getByLabelText('证件编号'), 'LICENSE-001');
    await user.type(within(createForm).getByLabelText('联系电话'), '13800138000');
    await user.type(within(createForm).getByLabelText(/^结算钱包/), address('3'));
    await user.type(within(createForm).getByLabelText('Idempotency key'), 'merchant-create-1');
    await user.click(within(createForm).getByRole('button', { name: '创建 PENDING 申请' }));

    expect(await screen.findByText(/已创建 merchant-1 的加密资质申请/)).toBeTruthy();
    const updateForm = await screen.findByRole('heading', { name: '更新资质版本' }).then((heading) => heading.closest('form')!);
    expect(within(updateForm).queryByLabelText(/结算钱包/)).toBeNull();
    expect(within(updateForm).queryByLabelText('商家等级')).toBeNull();
    await user.upload(within(updateForm).getByLabelText('营业执照 / 资质文件'), new File(['license'], 'license.pdf', { type: 'application/pdf' }));
    await user.type(within(updateForm).getByLabelText('上传 Idempotency key'), 'license-upload-1');
    await user.click(within(updateForm).getByRole('button', { name: '上传并验证证照' }));
    expect(await within(updateForm).findByText(hash('a'))).toBeTruthy();
    await user.type(within(updateForm).getByLabelText('Idempotency key'), 'merchant-update-1');
    await user.click(within(updateForm).getByRole('button', { name: '保存新资质版本' }));

    expect(await screen.findByText('资质已更新至 v2')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === 'https://storage.example/license')).toBe(true);
    expect(screen.queryByRole('heading', { name: '商家审核发布' })).toBeNull();
  });

  it('lets ADMIN sign the exact challenge with an independent wallet and renders Safe evidence', async () => {
    const wallet = address('1');
    const secondarySigner = address('2');
    let current = merchantDetail({ merchant: { ...merchantDetail().merchant, qualificationComplete: true }, qualification: { ...qualification(), licenseAssetId: hash('a') } });
    const provider = walletProvider(wallet);
    window.ethereum = provider;
    const challenge = reviewChallenge(secondarySigner);
    const fetchMock = merchantFetch(wallet, 'ADMIN', () => current, async (url) => {
      if (url.endsWith('/review-challenges')) return jsonResponse(challenge, 201);
      if (url.endsWith(`/review-actions/${challenge.actionId}/publish`)) {
        current = publishedDetail(current, challenge); return jsonResponse(current);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderMerchantPage();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const review = await screen.findByRole('heading', { name: '商家审核发布' }).then((heading) => heading.closest('section')!);
    await user.type(within(review).getByLabelText('原因代码'), 'QUALIFICATION_APPROVED');
    await user.type(within(review).getByLabelText('Idempotency key'), 'merchant-review-1');
    await user.click(within(review).getByRole('button', { name: '二次签名并发布' }));

    await waitFor(() => expect(provider.request).toHaveBeenCalledWith({ method: 'eth_signTypedData_v4', params: [secondarySigner, JSON.stringify(challenge.typedData)] }));
    expect((await screen.findAllByText(/签名证据/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(hash('f')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('已通过').length).toBeGreaterThan(0);
    expect(screen.getByText('7', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('8', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('7500 bps', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('NPL Burn · FINAL')).toBeTruthy();
    expect(screen.getByText('BNM Available · 已履约')).toBeTruthy();
    expect(screen.getAllByText('DecisionBlocked')).toHaveLength(1);
  });

  it('never offers an approved settlement wallet change to ADMIN', async () => {
    const wallet = address('1');
    const current = merchantDetail({ merchant: { ...merchantDetail().merchant, status: 'APPROVED', qualificationComplete: true }, qualification: { ...qualification(), licenseAssetId: hash('a') } });
    const provider = walletProvider(wallet);
    window.ethereum = provider;
    const fetchMock = merchantFetch(wallet, 'ADMIN', () => current);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderMerchantPage();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const review = await screen.findByRole('heading', { name: '商家审核发布' }).then((heading) => heading.closest('section')!);
    expect(within(review).queryByLabelText('新结算钱包')).toBeNull();
    expect(within(review).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['BLACKLIST']);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/review-challenges'))).toBe(false);
  });

  it('does not ask the wallet to sign when the challenge signer is not independent', async () => {
    const wallet = address('1');
    const provider = walletProvider(wallet);
    window.ethereum = provider;
    const current = merchantDetail({ merchant: { ...merchantDetail().merchant, qualificationComplete: true }, qualification: { ...qualification(), licenseAssetId: hash('a') } });
    vi.stubGlobal('fetch', merchantFetch(wallet, 'ADMIN', () => current, async (url) => url.endsWith('/review-challenges') ? jsonResponse(reviewChallenge(wallet), 201) : undefined));
    const user = userEvent.setup();
    renderMerchantPage();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const review = await screen.findByRole('heading', { name: '商家审核发布' }).then((heading) => heading.closest('section')!);
    await user.type(within(review).getByLabelText('原因代码'), 'QUALIFICATION_APPROVED');
    await user.type(within(review).getByLabelText('Idempotency key'), 'merchant-review-1');
    await user.click(within(review).getByRole('button', { name: '二次签名并发布' }));
    expect(await screen.findByText('Merchant review requires an independent secondary wallet')).toBeTruthy();
    expect(provider.request.mock.calls.some(([input]) => input.method === 'eth_signTypedData_v4')).toBe(false);
  });
});

type ExtraHandler = (url: string, init?: RequestInit) => Promise<Response | undefined>;
function merchantFetch(wallet: string, role: UserRole, detail: () => MerchantLifecycleDetail | null, extra?: ExtraHandler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    const handled = await extra?.(url, init); if (handled) return handled;
    const current = detail();
    if (/\/v2\/admin\/merchants(?:\?|$)/.test(url) && !init?.method) return jsonResponse({ artifactVersion, merchants: current ? [current.merchant] : [], nextCursor: null });
    if (url.endsWith('/v2/admin/merchants/merchant-1')) return current ? jsonResponse(current) : jsonResponse({ error: { code: 'UnknownState', message: 'Merchant not found', correlationId: 'merchant-none' } }, 404);
    return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected merchant request ${url}`, correlationId: 'merchant-ui' } }, 400);
  });
}

function merchantDetail(overrides: Partial<MerchantLifecycleDetail> = {}): MerchantLifecycleDetail {
  const base: MerchantLifecycleDetail = {
    artifactVersion,
    merchant: { merchantId: 'merchant-1', shopName: '阿步金店', settlementWallet: address('3'), settlementWalletMutable: false, status: 'PENDING', level: 'V1', guaranteeStatus: 'READY', applicationVersion: 1, qualificationComplete: false, reviewedAt: null, reviewedBy: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z' },
    qualification: qualification(),
    levelPolicy: { status: 'Deprecated' },
    analytics: {
      orders: { totalFinalized: '3', ordinaryFinalized: '2', seckillFinalized: '1', cumulative: amounts('100', '70', '60', '55'), today: amounts('20', '14', '12', '11'), timezone: 'Asia/Shanghai', window: { start: '2026-07-15T16:00:00.000Z', end: '2026-07-16T16:00:00.000Z' } },
      fulfillment: { pendingShipment: '1', inTransit: '1', completed: '1', pickupCompleted: '0', fastShip48h: { status: 'AVAILABLE', numerator: '3', denominator: '4', bps: 7500, reason: null } },
      risk: { takeoverCases: '1', guaranteeUsedUsdt: '2', frozenReceivableUsedUsdt: '3', futureProceedsUsedUsdt: '4', platformAdvanceUsdt: '5', outstandingDebtUsdt: '6', abnormalOrderRateBps: null, unavailableReason: 'DecisionBlocked' },
      contributions: { finalizedNplBurnAmount: '7', fulfillmentAvailableBnmAmount: '8', ledgerReconciled: true },
    },
    balances: ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED'].map((state, index) => ({ state: state as MerchantLifecycleDetail['balances'][number]['state'], amount: String(index + 1) })),
    settlements: [{ requestId: hash('d'), asset: 'USDT', amount: '5', state: 'SETTLED', requestedAt: '2026-07-16T00:00:00.000Z', finalExecutionTxHashes: [hash('e')], settledAt: '2026-07-16T01:00:00.000Z' }],
    reviews: [],
  };
  return { ...base, ...overrides };
}
function qualification() { return { access: 'FULL' as const, legalName: '阿步黄金有限公司', legalId: 'LICENSE-001', contactPhone: '13800138000', licenseAssetId: null, payloadHash: hash('1'), retentionPolicyVersion: 'pii-v1', version: 1, updatedAt: '2026-07-16T00:00:00.000Z' }; }
function reviewChallenge(signer: string) { const expiresAt = '2099-01-01T00:00:00.000Z'; return { artifactVersion, actionId: hash('7'), merchantId: 'merchant-1', action: 'APPROVE' as const, fromStatus: 'PENDING' as const, toStatus: 'APPROVED' as const, applicationVersion: 1, reasonCode: 'QUALIFICATION_APPROVED', state: 'DRAFT' as const, secondarySigner: signer, expiresAt, typedData: { domain: { name: 'Abu24KV2Core' }, types: { SensitiveAction: [] }, primaryType: 'SensitiveAction', message: { action: 'APPROVE_MERCHANT', resourceType: 'MERCHANT', resourceId: 'merchant-1', policyVersion: '2', oldValueHash: hash('2'), newValueHash: hash('3'), safeAddress: address('4'), nonce: '7', deadline: String(Math.floor(Date.parse(expiresAt) / 1_000)) } }, digest: hash('6') }; }
function publishedDetail(current: MerchantLifecycleDetail, challenge: ReturnType<typeof reviewChallenge>): MerchantLifecycleDetail { return { ...current, merchant: { ...current.merchant, status: 'APPROVED', reviewedAt: '2026-07-16T01:00:00.000Z', reviewedBy: address('1') }, reviews: [{ actionId: challenge.actionId, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED', applicationVersion: 1, reasonCode: challenge.reasonCode, state: 'PUBLISHED', secondarySigner: challenge.secondarySigner, actionDigest: challenge.digest, approvalSignatureHash: hash('f'), createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T01:00:00.000Z' }] }; }
function uploadIntent(request: Record<string, unknown>, wallet: string) { return { artifactVersion, uploadIntentId: hash('8'), ownerWallet: wallet, purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT', resourceId: 'merchant-1', contentType: request.contentType, sizeBytes: String(request.sizeBytes), contentSha256: request.contentSha256, state: 'UPLOADED', expiresAt: '2099-01-01T00:00:00.000Z', method: 'PUT', uploadUrl: 'https://storage.example/license', headers: {}, providerReferenceHash: hash('9'), writeOnce: true }; }
function mediaAsset(wallet: string, request: Record<string, unknown>) { return { artifactVersion, assetId: hash('a'), uploadIntentId: hash('8'), ownerWallet: wallet, purpose: 'MERCHANT_LICENSE', resourceType: 'MERCHANT', resourceId: 'merchant-1', contentType: request.contentType, sizeBytes: String(request.sizeBytes), contentSha256: request.contentSha256, providerEvidenceHash: hash('b'), objectVersionHash: hash('c'), createdAt: '2026-07-16T00:00:00.000Z' }; }
function walletProvider(wallet: string) { return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : method === 'personal_sign' ? '0xsigned' : method === 'eth_signTypedData_v4' ? '0x1234' : Promise.reject(new Error(`Unexpected wallet method ${method}`))) }; }
function nonceResponse() { return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:05:00.000Z' }, 201); }
function amounts(listPriceUsdt: string, buyerPaidUsdt: string, merchantBaseReceivableUsdt: string, merchantNetReceivableUsdt: string) { return { listPriceUsdt, buyerPaidUsdt, merchantBaseReceivableUsdt, merchantNetReceivableUsdt }; }
function renderMerchantPage() { return render(<MemoryRouter initialEntries={['/merchants']}><App /></MemoryRouter>); }
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

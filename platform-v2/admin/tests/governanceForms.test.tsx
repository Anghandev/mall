import { artifactVersion } from '@abu24k/core-artifacts';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('governed Admin forms', () => {
  it('updates a selected policy draft through structured fields without manual JSON or signature timing inputs', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/policy-drafts') && !init?.method) return jsonResponse([policyDraft()]);
      if (url.endsWith('/v2/admin/policy-drafts/draft-1') && init?.method === 'PUT') {
        const request = JSON.parse(String(init.body)) as { payload: Record<string, unknown> };
        return jsonResponse(policyDraft({ payload: request.payload, updatedAt: '2026-07-17T00:01:00.000Z' }));
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/policy']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByRole('button', { name: 'draft-1' })).toBeTruthy();
    expect(screen.queryByLabelText(/JSON object/)).toBeNull();
    expect(screen.queryByLabelText('二次签名 nonce')).toBeNull();
    expect(screen.queryByLabelText(/Oracle version/)).toBeNull();
    expect(screen.queryByLabelText(/TWAP/)).toBeNull();
    fireEvent.change(screen.getByLabelText('商业决定证据哈希'), { target: { value: hash('7') } });
    await user.click(screen.getByRole('button', { name: '保存选中草稿' }));

    expect(await screen.findByText(/草稿 draft-1 已保存并重新校验/, undefined, { timeout: 3_000 })).toBeTruthy();
    const updateBody = requestBody(fetchMock, '/v2/admin/policy-drafts/draft-1');
    expect(updateBody).toMatchObject({ payload: { rulesContentHash: hash('9'), policy: {
      platformFeeBps: 100, usdtPaymentBps: 7000, nplPaymentBps: 3000,
      platformServiceFeeSafe: address('a'), decisionEvidenceHash: hash('7'),
      genesisNodeDestinations: [{ account: address('1'), weightBps: 10_000 }],
    } } });
    expect(updateBody.payload).not.toHaveProperty('oracleVersion');
    expect(updateBody.payload).not.toHaveProperty('policy.oracleWindowSeconds');
  });

  it('creates structured system config and publishes through the Core secondary signer challenge', async () => {
    const wallet = address('1');
    const secondarySigner = address('4');
    const providerRequest = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [wallet];
      if (method === 'personal_sign') return '0xsiwe';
      if (method === 'eth_signTypedData_v4') return '0xsecondary';
      throw new Error(`Unexpected wallet method ${method}`);
    });
    window.ethereum = { request: providerRequest };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/system-config/versions') && !init?.method) return jsonResponse([]);
      if (url.endsWith('/v2/admin/system-config/versions') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { configKey: string; payload: Record<string, unknown> };
        return jsonResponse(systemConfig('config-new', { configKey: request.configKey, payload: request.payload }), 201);
      }
      if (url.endsWith('/approval-challenge')) {
        const request = JSON.parse(String(init?.body)) as { nonce: string; deadline: string };
        const message = { action: 'PUBLISH_SYSTEM_CONFIG', resourceType: 'SYSTEM_CONFIG', resourceId: 'config-new', policyVersion: '2', oldValueHash: hash('0'), newValueHash: hash('5'), safeAddress: address('3'), ...request };
        return jsonResponse({ configVersionId: 'config-new', signer: secondarySigner, ...message, typedData: { domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: address('5') }, types: { SensitiveAction: [] }, primaryType: 'SensitiveAction', message }, digest: hash('6') });
      }
      if (url.endsWith('/publish')) return jsonResponse({ ...systemConfig('config-new', { configKey: 'NPL_QUOTE', payload: nplQuoteConfig() }), published: true });
      return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/system']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByLabelText('Config key')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'FREIGHT' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'ORACLE' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Config key'), 'NPL_QUOTE');
    expect(screen.getByLabelText('NPL / USDT Pair')).toBeTruthy();
    expect(screen.getByLabelText('报价有效秒数')).toBeTruthy();
    expect(screen.getByLabelText('最小 USDT 流动性 atomic')).toBeTruthy();
    expect(screen.queryByLabelText(/TWAP/)).toBeNull();
    fireEvent.change(screen.getByLabelText('未来生效时间'), { target: { value: '2026-07-20T09:00' } });
    await user.click(screen.getByRole('button', { name: '提交 Core 校验' }));
    expect(await screen.findByText(/Core 已创建 config-new/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '签名并发布未来版本' }));

    expect(await screen.findByText(/配置 config-new 已发布/)).toBeTruthy();
    const createBody = requestBody(fetchMock, '/v2/admin/system-config/versions');
    expect(createBody).toMatchObject({ configKey: 'NPL_QUOTE', payload: nplQuoteConfig() });
    expect(String(createBody.idempotencyKey)).toMatch(/^config-/);
    expect(providerRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_signTypedData_v4', params: [secondarySigner, expect.any(String)] }));
    const publishBody = requestBody(fetchMock, '/publish');
    expect(publishBody).toMatchObject({ approval: { resourceId: 'config-new', oldValueHash: hash('0'), newValueHash: hash('5'), signature: '0xsecondary' } });
  });

  it('creates structured CMS content and uses the Core content hash for publication evidence', async () => {
    const wallet = address('2');
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/cms/versions') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(cmsVersion(request), 201);
      }
      if (url.endsWith('/publish')) return jsonResponse({ ...cmsVersion({}), published: true, publicationType: 'PUBLISHED' });
      return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/cms']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.type(screen.getByLabelText('Slug'), 'summer-notice');
    await user.type(screen.getByLabelText('位置'), 'mall-home');
    await user.type(screen.getByLabelText('标题'), '夏日公告');
    await user.type(screen.getByLabelText('正文'), '第一段\n\n第二段');
    await user.type(screen.getByLabelText('图片 Asset ID'), 'asset:banner-2026');
    await user.type(screen.getByLabelText('图片替代文本'), '夏日公告图');
    await user.type(screen.getByLabelText('链接地址'), '/faq');
    await user.type(screen.getByLabelText('链接文字'), '查看 FAQ');
    await user.selectOptions(screen.getByLabelText('受众类型'), 'REGION');
    await user.type(screen.getByLabelText('六位区域代码（每行一个）'), '310101\n210202');
    fireEvent.change(screen.getByLabelText('开始时间（可选）'), { target: { value: '2026-07-20T09:00' } });
    fireEvent.change(screen.getByLabelText('结束时间（可选）'), { target: { value: '2026-07-20T18:00' } });
    await user.type(screen.getByLabelText('频次上限（可选）'), '3');
    await user.type(screen.getByLabelText('Policy version（秒杀规则必填）'), '2');
    await user.click(screen.getByRole('button', { name: '创建内容版本' }));

    expect(await screen.findByText(/Core 已创建 CMS version version-1/)).toBeTruthy();
    expect(screen.getByLabelText('内容预览').textContent).toContain('夏日公告图');
    const createBody = requestBody(fetchMock, '/v2/admin/cms/versions');
    expect(createBody).toMatchObject({
      slug: 'summer-notice', placement: 'mall-home', audience: { type: 'REGION', regionCodes: ['210202', '310101'] },
      frequencyCap: 3, policyVersion: '2',
      content: { type: 'doc', children: expect.arrayContaining([expect.objectContaining({ type: 'heading' }), expect.objectContaining({ type: 'image', assetId: 'asset:banner-2026' })]) },
    });
    expect(String(createBody.idempotencyKey)).toMatch(/^cms-/);
    await user.click(screen.getByRole('button', { name: '发布版本' }));
    expect(await screen.findByText(/CMS version version-1 已发布/)).toBeTruthy();
    expect(requestBody(fetchMock, '/publish')).toEqual({ evidenceHash: hash('7') });
  });
});

function requestBody(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith(suffix) && init?.method && init.method !== 'GET');
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}
function policyDraft(overrides: Record<string, unknown> = {}) { return { draftId: 'draft-1', nextPolicyVersion: '2', basePolicyVersion: '1', artifactVersion, payload: policyPayload(), validationErrors: [], state: 'DRAFT', policyHash: hash('1'), operationsHash: hash('2'), publicationDigest: null, publicationNonce: null, publicationDeadline: null, secondarySigner: null, secondarySignatureHash: null, safeAddress: null, safeCalldataHash: null, safeTxHash: null, safeProposalHash: null, createdBy: address('1'), createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z', ...overrides }; }
function policyPayload() { return { rulesContentHash: hash('9'), policy: {
  usdtPaymentBps: 7000, nplPaymentBps: 3000, nplBurnListPriceBps: 2000, nplRewardListPriceBps: 1000,
  platformFeeBps: 100, seckillPrizeBps: 0, genesisBps: 200, directReferralBps: 100, districtBps: 120,
  cityBps: 80, provinceBps: 60, regionBps: 40, operationsBps: 400, seckillMainDuration: 3600,
  relayInitial: 60, relayIncrement: 30, relayCap: 60, requiredConfirmations: 15,
  merchantGuaranteeMinimumUsdt: '1000000000000000000000', platformServiceFeeSafe: address('a'),
  usdtCustodySafe: address('b'), nplRewardSafe: address('c'), operationsTreasurySafe: address('d'), circulationPool: address('e'),
  concessionDestinationSetHash: hash('f'), decisionEvidenceHash: hash('6'),
  genesisNodeDestinations: [{ account: address('1'), weightBps: 10_000 }],
  operationsDestinations: ['2', '3', '4', '5'].map((value) => ({ account: address(value), weightBps: 2_500 })),
} }; }
function systemConfig(configVersionId: string, overrides: Record<string, unknown> = {}) { return { configVersionId, configKey: 'BUSINESS', version: 1, payload: { unpaidReservationTimeoutSeconds: 900, businessTimezone: 'Asia/Shanghai' }, payloadHash: hash('5'), effectiveFrom: '2026-07-20T01:00:00.000Z', published: false, createdBy: address('1'), createdAt: '2026-07-17T00:00:00.000Z', ...overrides }; }
function nplQuoteConfig() { return { pairAddress: '0x2955e33bb120714abf11ace2766e614e6e5955b2', quoteValiditySeconds: 300, minimumUsdtLiquidity: '50000000000000000000000' }; }
function cmsVersion(input: Record<string, unknown>) { return { entryId: 'entry-1', versionId: 'version-1', version: 1, slug: input.slug ?? 'summer-notice', contentType: input.contentType ?? 'BANNER', placement: input.placement ?? 'mall-home', locale: input.locale ?? 'zh-CN', contentFormat: input.contentFormat ?? 'STRUCTURED_RICH_TEXT', content: input.content ?? { type: 'doc', children: [] }, contentHash: hash('7'), audience: input.audience ?? { type: 'ALL' }, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, frequencyCap: input.frequencyCap ?? null, policyVersion: input.policyVersion ?? null, published: false, publicationType: null, createdBy: address('2'), createdAt: '2026-07-17T00:00:00.000Z' }; }
function nonceResponse() { return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201); }
function walletProvider(wallet: string) { return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : method === 'personal_sign' ? '0xsiwe' : Promise.reject(new Error(`Unexpected wallet method ${method}`))) }; }
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(character: string) { return `0x${character.repeat(64)}`; }
function address(character: string) { return `0x${character.repeat(40)}`; }

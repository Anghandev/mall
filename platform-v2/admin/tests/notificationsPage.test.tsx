import { type NotificationCampaignProjection, type UserRole } from '@abu24k/core-artifacts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('notification campaign operations', () => {
  it('creates a structured region campaign and consumes Core actions for publish and retry', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const campaigns = [
      campaign({ campaignId: 'campaign-draft', state: 'DRAFT', publishedAt: null, allowedActions: ['PUBLISH'] }),
      campaign({ campaignId: 'campaign-failed', allowedActions: ['RETRY_FAILED'] }),
    ];
    const fetchMock = notificationFetch(wallet, 'ADMIN', campaigns);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText('连接平台钱包')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('PaymentFinalized')).toBeTruthy();
    expect((await screen.findAllByText('缺少配置')).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText('受众类型'), 'REGION');
    await user.type(screen.getByLabelText(/\u516d\u4f4d\u533a\u57df\u4ee3\u7801/), '210202\n310101');
    await user.clear(screen.getByLabelText('标题 Key'));
    await user.type(screen.getByLabelText('标题 Key'), 'REGION_ALERT_TITLE');
    await user.clear(screen.getByLabelText('正文 Key'));
    await user.type(screen.getByLabelText('正文 Key'), 'REGION_ALERT_BODY');
    await user.click(screen.getByRole('button', { name: '添加变量' }));
    await user.type(screen.getByLabelText('变量 1 Key'), 'maintenanceWindow');
    await user.type(screen.getByLabelText('变量 1 Value'), '22:00-23:00');
    fireEvent.change(screen.getByLabelText('开始时间（可选）'), { target: { value: '2026-07-18T09:00' } });
    fireEvent.change(screen.getByLabelText('结束时间（可选）'), { target: { value: '2026-07-18T10:00' } });
    const createKey = (screen.getByLabelText('Idempotency key') as HTMLInputElement).value;
    await user.click(screen.getByRole('button', { name: '创建活动' }));

    expect(await screen.findByText(/Core 已创建活动 campaign-created/)).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/v2/admin/notification-campaigns') && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      topic: 'ANNOUNCEMENT',
      audience: { type: 'REGION', regionCodes: ['210202', '310101'] },
      message: { titleKey: 'REGION_ALERT_TITLE', bodyKey: 'REGION_ALERT_BODY', variables: { maintenanceWindow: '22:00-23:00' } },
      startsAt: new Date('2026-07-18T09:00').toISOString(),
      endsAt: new Date('2026-07-18T10:00').toISOString(),
      idempotencyKey: createKey,
    });

    await waitFor(() => expect(screen.getByLabelText('发布证据哈希（bytes32）').hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('button', { name: '发布活动' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('发布证据哈希（bytes32）'), hash('7'));
    await user.click(screen.getByRole('button', { name: '发布活动' }));
    expect(await screen.findByText('活动 campaign-draft 已发布')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('选择活动'), 'campaign-failed');
    expect(screen.getByRole('button', { name: '重试失败投递' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: '重试失败投递' }));
    expect(await screen.findByText('活动 campaign-failed 已重排 2 条失败投递')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/campaign-draft/publish') && init?.method === 'POST')).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/campaign-failed/retry-failed') && init?.method === 'POST')).toBe(true);
  });

  it('preserves the campaign idempotency key across a deterministic retry', async () => {
    const wallet = address('2');
    window.ethereum = walletProvider(wallet);
    const fetchMock = notificationFetch(wallet, 'OPERATOR', [], true);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const keyInput = await screen.findByLabelText('Idempotency key') as HTMLInputElement;
    const stableKey = keyInput.value;
    await user.click(screen.getByRole('button', { name: '创建活动' }));
    expect(await screen.findByText('Notification service unavailable')).toBeTruthy();
    expect(keyInput.value).toBe(stableKey);
    await user.click(screen.getByRole('button', { name: '创建活动' }));
    expect(await screen.findByText(/Core 已创建活动 campaign-created/)).toBeTruthy();

    const bodies = fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith('/v2/admin/notification-campaigns') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(bodies.map((body) => body.idempotencyKey)).toEqual([stableKey, stableKey]);
  });

  it('keeps AUDITOR read-only even if a projection advertises an action', async () => {
    const wallet = address('3');
    window.ethereum = walletProvider(wallet);
    const campaigns = [
      campaign({ campaignId: 'campaign-draft', state: 'DRAFT', publishedAt: null, allowedActions: ['PUBLISH'] }),
      campaign({ campaignId: 'campaign-failed', allowedActions: ['RETRY_FAILED'] }),
    ];
    const fetchMock = notificationFetch(wallet, 'AUDITOR', campaigns);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('AUDITOR 只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建活动' })).toBeNull();
    expect(screen.getByRole('button', { name: '发布活动' }).hasAttribute('disabled')).toBe(true);
    await user.selectOptions(screen.getByLabelText('选择活动'), 'campaign-failed');
    expect(screen.getByRole('button', { name: '重试失败投递' }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/v2/admin/notification-campaigns') && init?.method === 'POST')).toBe(false);
  });

  it('shows empty inbox and ConfigurationRequired without synthetic provider success', async () => {
    const wallet = address('4');
    window.ethereum = walletProvider(wallet);
    const fetchMock = notificationFetch(wallet, 'ADMIN', [], false, true);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('收件箱暂无消息')).toBeTruthy();
    expect(await screen.findByText('ConfigurationRequired')).toBeTruthy();
    expect(screen.getByText('SMS provider secret reference is missing')).toBeTruthy();
    expect(screen.getByText(/Core 保留 `CONFIGURATION_REQUIRED`/)).toBeTruthy();
    expect(screen.queryByText('供应商投递成功')).toBeNull();
  });
});

function renderPage() {
  return render(<MemoryRouter initialEntries={['/notifications']}><App /></MemoryRouter>);
}

function notificationFetch(
  wallet: string,
  role: UserRole,
  campaigns: readonly NotificationCampaignProjection[],
  failFirstCreate = false,
  configurationRequired = false,
) {
  let createAttempts = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    if (url.includes('/v2/notifications?')) return jsonResponse(configurationRequired ? [] : [inboxItem()]);
    if (url.includes('/v2/admin/notification-campaigns?')) {
      return configurationRequired
        ? jsonResponse({ error: { code: 'ConfigurationRequired', message: 'SMS provider secret reference is missing', correlationId: 'notification-config' } }, 503)
        : jsonResponse(campaigns);
    }
    if (url.endsWith('/v2/admin/notification-campaigns') && init?.method === 'POST') {
      createAttempts += 1;
      if (failFirstCreate && createAttempts === 1) return jsonResponse({ error: { code: 'ExternalBlocked', message: 'Notification service unavailable', correlationId: 'notification-retry' } }, 503);
      return jsonResponse({ campaignId: 'campaign-created', state: 'DRAFT', contentHash: hash('6') }, 201);
    }
    if (url.endsWith('/publish') && init?.method === 'POST') return jsonResponse({ campaignId: 'campaign-draft', state: 'PUBLISHED' });
    if (url.endsWith('/retry-failed') && init?.method === 'POST') return jsonResponse({ campaignId: 'campaign-failed', state: 'RETRY_SCHEDULED', retriedDeliveries: 2 });
    return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400);
  });
}

function campaign(overrides: Partial<NotificationCampaignProjection> = {}): NotificationCampaignProjection {
  return {
    campaignId: 'campaign-failed',
    topic: 'ANNOUNCEMENT',
    audience: { type: 'ALL' },
    message: { titleKey: 'NOTICE_TITLE', bodyKey: 'NOTICE_BODY', variables: { source: 'platform' } },
    contentHash: hash('5'),
    cmsVersionId: null,
    startsAt: null,
    endsAt: null,
    state: 'PUBLISHED',
    createdBy: address('1'),
    createdAt: '2026-07-16T01:00:00.000Z',
    publishedAt: '2026-07-16T01:01:00.000Z',
    deliveryCounts: { PENDING: 0, PROCESSING: 0, DELIVERED: 3, RETRY: 0, CONFIGURATION_REQUIRED: 1, DEAD_LETTER: 1 },
    allowedActions: ['RETRY_FAILED'],
    ...overrides,
  };
}

function inboxItem() {
  return { messageId: 'message-1', sourceEventType: 'PaymentFinalized', topic: 'PAYMENT_FINALIZED', templateData: { state: 'LOCKED' }, deliveryState: 'CONFIGURATION_REQUIRED', createdAt: '2026-07-16T01:00:00.000Z' };
}

function nonceResponse() {
  return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
}

function walletProvider(wallet: string) {
  return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : method === 'personal_sign' ? '0xsigned' : Promise.reject(new Error(`Unexpected wallet method ${method}`))) };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(character: string) { return `0x${character.repeat(64)}`; }
function address(character: string) { return `0x${character.repeat(40)}`; }

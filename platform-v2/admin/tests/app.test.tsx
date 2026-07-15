import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactVersion, executableOrderActionNames, type ManagedCatalogProduct, type UserRole } from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { coreState } from '../src/coreState';

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('platform admin fail-closed experience', () => {
  it('boots against the coordinated Core artifact version', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@abu24k/core-artifacts']).toBe(`workspace:${artifactVersion}`);
    expect(productBaseline.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactStatus).toBe('coordinated-settlement-admin-checkpoint');
    expect(coreState.connectionLabel).toContain(artifactVersion);
  });

  it('treats the static action catalog as capability metadata, not runtime authorization', () => {
    expect(executableOrderActionNames).toContain('OPEN_TAKEOVER');
    expect(coreState.executableOrderActionNames).toEqual(executableOrderActionNames);
    expect(productBaseline.adminCapabilities.orderAllowedActions).toBe(true);
    expect(productBaseline.adminCapabilities.fulfillmentCommands).toBe(true);
    expect(productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization).toBe(false);
    expect(coreState.canWriteWithoutRuntimeAuthorization).toBe(false);

    renderAt('/policy');
    expect(screen.getByRole('button', { name: '请求并提交二次签名' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the Dashboard fail-closed until SIWE and then renders the authoritative Core projection', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/dashboard')) return jsonResponse(adminDashboardResponse());
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected Dashboard request', correlationId: 'dashboard-ui-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAt('/');
    expect(screen.getByRole('heading', { name: '今日运营态势' })).toBeTruthy();
    const dashboardStatus = screen.getByRole('status', { name: 'Dashboard 数据状态' });
    expect(within(dashboardStatus).getByText(/未认证时数据不可用，不显示合成数据/)).toBeTruthy();
    expect(screen.queryByText('300000000')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('Asia/Shanghai', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('300000000')).toBeTruthy();
    expect(screen.getByText('0 / 0; bps=null')).toBeTruthy();
    expect(screen.getAllByText('Buyer UID identity is not frozen')).toHaveLength(2);
    expect(screen.getByText('0x4444444444444444444444444444444444444444')).toBeTruthy();
    expect(screen.getAllByText('paused = true')).toHaveLength(2);
    const failedTransactions = screen.getByText('链上失败交易').closest('div');
    expect(failedTransactions).not.toBeNull();
    expect(within(failedTransactions!).getByText('2')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/dashboard', expect.objectContaining({ headers: { authorization: 'Bearer jwt' } }));
  });

  it('keeps every Catalog read and write behind a Core SIWE session', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/catalog');
    expect(screen.getByRole('heading', { name: '商品主数据' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SIWE 连接' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '商品与库存' })).toBeNull();
    expect(screen.queryByRole('button', { name: /保存 Core 商品版本/ })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never renders a delete action for append-only audit records', () => {
    renderAt('/audit');
    expect(screen.getByRole('heading', { name: '日志中心' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(screen.getByText(/从不提供删除或修改操作/)).toBeTruthy();
  });

  it.each(['ADMIN', 'AUDITOR'] as const)('allows the %s role to query append-only audit evidence', async (role) => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
      if (url.includes('/v2/admin/audit/entries')) return jsonResponse({ entries: [], chainProof: {}, nextCursor: null });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'audit-role-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/audit');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const queryButton = await screen.findByRole('button', { name: '查询审计链' });
    await user.click(queryButton);

    expect(await screen.findByText(/Core 返回真实空结果/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/admin/audit/entries?limit=50'))).toBe(true);
  });

  it('denies the OPERATOR role before an audit query reaches Core', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      return jsonResponse({ error: { code: 'Forbidden', message: 'Unexpected request', correlationId: 'audit-role-test' } }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/audit');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText(/当前会话没有审计读取权限/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查询审计链' })).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/admin/audit/entries'))).toBe(false);
  });

  it('keeps takeover execution closed before an authenticated Core session exists', () => {
    renderAt('/takeover');
    expect(screen.getByRole('heading', { name: '商家接管履约中心' })).toBeTruthy();
    expect(screen.getByText('保证金 → 冻结应收 → 未来货款')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SIWE 连接' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开接管案件' })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('rejects a valid SIWE session that has no platform role before reading orders', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['BUYER'] });
      return jsonResponse({ error: { code: 'Forbidden', message: 'Unexpected request', correlationId: 'role-test' } }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText(/缺少 ADMIN、OPERATOR 或 AUDITOR/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/admin/orders'))).toBe(false);
    expect(screen.queryByRole('button', { name: '打开接管案件' })).toBeNull();
  });

  it('requires current Core allowedActions before an admin can open takeover', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder({ allowedActions: [{ action: 'OPEN_TAKEOVER', enabled: true }] });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/orders') && !init?.method) return jsonResponse(adminOrderPage([order]));
      if (url.endsWith(`/v2/orders/${order.orderId}/takeover`)) {
        return jsonResponse({ orderId: order.orderId, caseId: 'takeover-case-1', state: 'TAKEOVER', customerFundsRemainLocked: true }, 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'takeover-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('Core allowed')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '执行打开接管案件' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByLabelText('证据哈希 · bytes32'), hash('9'));
    await user.type(screen.getByLabelText('原因代码'), 'NO_SHIPMENT_AFTER_FINALITY');
    expect(submit.hasAttribute('disabled')).toBe(false);
    await user.click(submit);

    expect(await screen.findByText(/Core 已确认订单状态 TAKEOVER/)).toBeTruthy();
    const commandCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith(`/v2/orders/${order.orderId}/takeover`));
    expect(commandCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({
      evidenceHash: hash('9'),
      reasonCode: 'NO_SHIPMENT_AFTER_FINALITY',
    });
  });

  it('keeps takeover disabled when Core returns a denied order action', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder({ allowedActions: [{ action: 'OPEN_TAKEOVER', enabled: false, reasonCode: 'FinalityPending', deadline: '2026-07-21T00:00:00.000Z' }] });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/admin/orders') && !init?.method) return jsonResponse(adminOrderPage([order]));
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'denied-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('FinalityPending')).toBeTruthy();
    await user.type(screen.getByLabelText('证据哈希 · bytes32'), hash('9'));
    await user.type(screen.getByLabelText('原因代码'), 'NO_SHIPMENT_AFTER_FINALITY');
    expect(screen.getByRole('button', { name: '执行打开接管案件' }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/takeover'))).toBe(false);
  });

  it('records replacement shipment only after takeover order state and Core action agree', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder({ state: 'TAKEOVER', takeoverOpenedAt: '2026-07-09T00:00:00.000Z', allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/admin/orders') && !init?.method) return jsonResponse(adminOrderPage([order]));
      if (url.endsWith(`/v2/orders/${order.orderId}/shipments`)) {
        return jsonResponse({
          orderId: order.orderId,
          state: 'SHIPPED',
          shipmentId: 'shipment-1',
          carrierCode: 'SF',
          trackingNumberHash: hash('7'),
          recordedAt: '2026-07-14T10:00:00.000Z',
        }, 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'shipment-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByRole('button', { name: '执行记录发货' })).toBeTruthy();
    await user.type(screen.getByLabelText('证据哈希 · bytes32'), hash('6'));
    await user.type(screen.getByLabelText('承运商代码'), 'sf');
    await user.type(screen.getByLabelText('运单号哈希 · bytes32'), hash('7'));
    await user.click(screen.getByRole('button', { name: '执行记录发货' }));

    expect(await screen.findByText(/Core 已确认订单状态 SHIPPED/)).toBeTruthy();
    const commandCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith(`/v2/orders/${order.orderId}/shipments`));
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({
      carrierCode: 'SF',
      evidenceHash: hash('6'),
      trackingNumberHash: hash('7'),
    });
  });

  it('denies arbitration decisions to an operator even if a bad Core response enables the action', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder({ state: 'ARBITRATION', arbitrationOpenedAt: '2026-07-14T09:00:00.000Z', allowedActions: [{ action: 'DECIDE_ARBITRATION', enabled: true }] });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/admin/orders') && !init?.method) return jsonResponse(adminOrderPage([order]));
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'role-fence' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText(/DECIDE_ARBITRATION 不允许当前平台角色/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '执行裁决仲裁' }).hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/arbitration-decisions'))).toBe(false);
  });

  it('runs exact admin search and read-only batch preview from the coordinated .5 projections', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder({ allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/orders/batch-actions/preview') && init?.method === 'POST') return jsonResponse({
        rows: [{ orderId: order.orderId, allowedActions: order.allowedActions }],
        enabledActionIntersection: ['RECORD_SHIPMENT'],
      });
      if (url.includes('/v2/admin/orders?')) return jsonResponse(adminOrderPage([order], {
        pausedScopes: ['NEW_PAYMENT'],
        breaker: { scope: 'NEW_PAYMENT', active: true },
        pendingProductReview: true,
      }));
      if (url.endsWith('/v2/admin/orders')) return jsonResponse(adminOrderPage([order]));
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'admin-search-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/takeover');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText(order.productId)).toBeTruthy();
    await user.click(screen.getByText('高级组合检索'));
    await user.type(screen.getByLabelText('订单号'), order.orderId);
    await user.type(screen.getByLabelText('商品 ID'), order.productId);
    await user.type(screen.getByLabelText('TxHash'), order.paymentTxHash);
    await user.type(screen.getByLabelText('钱包地址'), wallet);
    await user.selectOptions(screen.getByLabelText('业务投影'), 'breaker');
    await user.selectOptions(screen.getByLabelText('Breaker scope'), 'NEW_PAYMENT');
    await user.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('PENDING')).toBeTruthy();
    const searchCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/v2/admin/orders?'));
    const searchUrl = new URL(String(searchCall?.[0]), 'https://admin.local');
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({
      orderId: order.orderId,
      productId: order.productId,
      txHash: order.paymentTxHash,
      wallet,
      breakerScope: 'NEW_PAYMENT',
    });

    await user.click(screen.getByRole('checkbox', { name: `选择订单 ${order.orderId}` }));
    await user.click(screen.getByRole('button', { name: '预览共同操作' }));
    expect(await screen.findByText('RECORD_SHIPMENT')).toBeTruthy();
    expect(screen.getByText(/仅发布只读预览/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/admin/orders/batch-actions/preview'))).toBe(true);
    expect(screen.getByRole('button', { name: '导出 CSV' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows every governance gate and requires an authenticated draft before signing', () => {
    renderAt('/policy');
    expect(screen.getByText('RBAC 授权')).toBeTruthy();
    expect(screen.getByText('二次钱包签名')).toBeTruthy();
    expect(screen.getByText('Safe 多签')).toBeTruthy();
    expect(screen.getByRole('button', { name: '请求并提交二次签名' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '提交 Safe 多签提案' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders the .2 seckill session, HTTP replay and realtime channel without inventing write actions', async () => {
    const sockets: TestWebSocket[] = [];
    vi.stubGlobal('WebSocket', class extends TestWebSocket {
      constructor(url: string) { super(url); sockets.push(this); }
    });
    const session = seckillSession();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(session);
      if (url.endsWith('/v2/seckill/sessions/history?limit=50')) return jsonResponse({ items: [{ ...session, phase: 'SETTLED', storedPhase: 'SETTLED', winnerWallet: session.lastBuyerWallet }], nextCursor: null });
      if (url.endsWith(`/v2/seckill/sessions/${session.sessionId}/events?cursor=0&limit=100`)) return jsonResponse({ items: [realtimeEvent(session.sessionId)], nextCursor: '1' });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'seckill-admin-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/seckill');

    expect((await screen.findAllByText('24K live session')).length).toBe(2);
    expect(screen.getByText('3600s / 60s / +30s / cap 60s')).toBeTruthy();
    expect(await screen.findByText('relay-event-1')).toBeTruthy();
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]?.url).toContain(`channel=seckill%3A${session.sessionId}`);
    expect(sockets[0]?.url).toContain(`artifactVersion=${encodeURIComponent(artifactVersion)}`);
    expect(screen.queryByText('等待 Core 投影')).toBeNull();
    expect(screen.queryByRole('button', { name: /强截止|注入大奖池|发布场次/ })).toBeNull();
  });

  it('uses the Core policy challenge for typed-data signing before a Safe proposal', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
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
      if (url.endsWith('/v2/admin/policy-drafts') && !init?.method) return jsonResponse([policyDraft()]);
      if (url.endsWith('/approval-challenge')) return jsonResponse({ draftId: 'draft-1', policyVersion: 2, signer: wallet, typedData: { domain: { name: 'Abu24KPolicyRegistry' }, types: { PolicyPublication: [] }, primaryType: 'PolicyPublication', message: { policyHash: hash('1') } }, digest: hash('2') });
      if (url.endsWith('/secondary-signature')) return jsonResponse(policyDraft({ state: 'SECONDARY_SIGNED', secondarySigner: wallet, secondarySignatureHash: hash('3') }));
      if (url.endsWith('/safe-proposal')) return jsonResponse(policyDraft({ state: 'SAFE_PROPOSED', secondarySigner: wallet, secondarySignatureHash: hash('3'), safeAddress: '0x2222222222222222222222222222222222222222', safeCalldataHash: hash('4'), safeTxHash: hash('5'), safeProposalHash: hash('6') }), 202);
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'policy-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/policy');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByRole('button', { name: 'draft-1' })).toBeTruthy();
    await user.type(screen.getByLabelText('二次签名 nonce'), '7');
    await user.type(screen.getByLabelText('签名 deadline · Unix 秒'), '1800000000');
    await user.click(screen.getByRole('button', { name: '请求并提交二次签名' }));

    expect(await screen.findByText(/二次签名已由 Core 验证/)).toBeTruthy();
    expect(providerRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_signTypedData_v4' }));
    const safeButton = screen.getByRole('button', { name: '提交 Safe 多签提案' });
    expect(safeButton.hasAttribute('disabled')).toBe(false);
    await user.click(safeButton);
    expect(await screen.findByText(/Safe 提案已创建/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/safe-proposal'))).toBe(true);
  });

  it('supports keyboard navigation between product modules', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const navigation = screen.getByRole('navigation', { name: '平台后台模块' });
    await user.click(within(navigation).getByRole('link', { name: /接管履约/ }));
    expect(screen.getByRole('heading', { name: '商家接管履约中心' })).toBeTruthy();
  });

  it('renders live payment readiness without turning blocked dependencies into zeroes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(bootstrapResponse())));
    renderAt('/core-status');

    expect((await screen.findAllByText('Fail closed')).length).toBeGreaterThan(0);
    expect(screen.getByText('FIXED_REMAINDER_ACCOUNTS')).toBeTruthy();
    expect(screen.getByText('PAYMENT_ROUTER_ADDRESS_MANIFEST')).toBeTruthy();
  });

  it('renders the authenticated Core-managed product, SKU, amount and stock values', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = catalogFetchMock('ADMIN', [managedProduct()]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/catalog');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: /24K 金章/ }));
    expect(screen.getByText('7200000000')).toBeTruthy();
    expect(screen.getByText('18 available')).toBeTruthy();
    expect(screen.getByText('weight: 10g')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/admin/catalog/products'))).toBe(true);
  });

  it('keeps AUDITOR Catalog access read-only even when projections contain data', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    vi.stubGlobal('fetch', catalogFetchMock('AUDITOR', [managedProduct({ allowedActions: [] })]));
    const user = userEvent.setup();
    renderAt('/catalog');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: /24K 金章/ }));

    expect(screen.getAllByText(/AUDITOR 只读/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: '门店代理建品' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'APPROVE' })).toBeNull();
    expect(screen.queryByRole('button', { name: /追加调整记录/ })).toBeNull();
  });

  it('renders only review decisions present in the current Core allowedActions', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    vi.stubGlobal('fetch', catalogFetchMock('ADMIN', [managedProduct({ lifecycleState: 'REVIEW', allowedActions: ['APPROVE', 'HIDE'] })]));
    const user = userEvent.setup();
    renderAt('/catalog');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: /24K 金章/ }));

    expect(screen.getByRole('button', { name: 'APPROVE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'HIDE' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'REJECT' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PUBLISH' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'DELIST' })).toBeNull();
  });

  it('shows the exact Core blockingResource when a category disable is denied', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/catalog/categories') && !init?.method) return jsonResponse({ categories: [{ categoryId: 'category-1', version: '1', parentCategoryId: null, level: 1, name: '黄金', iconAssetId: null, sortOrder: 1, status: 'ENABLED', serviceFee: { state: 'DecisionBlocked', valueBps: null } }] });
      if (url.endsWith('/v2/admin/catalog/tags') && !init?.method) return jsonResponse({ tags: [] });
      if (url.endsWith('/v2/admin/catalog/products') && !init?.method) return jsonResponse({ products: [] });
      if (url.endsWith('/v2/admin/catalog/categories/category-1') && init?.method === 'PUT') return jsonResponse({ error: { code: 'ProductWriteLocked', message: 'Category contains a live seckill product', correlationId: 'taxonomy-lock-1', details: { blockingResource: { type: 'SECKILL_SESSION', id: 'session-live-1', state: 'LIVE' } } } }, 409);
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'taxonomy-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/catalog');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: '类目与标签' }));
    await user.click(screen.getByRole('button', { name: /黄金/ }));
    await user.selectOptions(screen.getAllByLabelText('状态')[0]!, 'DISABLED');
    await user.type(screen.getAllByLabelText('Idempotency key')[0]!, 'disable-category-1');
    await user.click(screen.getByRole('button', { name: '保存类目版本' }));

    expect(await screen.findByText(/blockingResource: SECKILL_SESSION · session-live-1 · LIVE/)).toBeTruthy();
    expect(screen.getByText(/Correlation ID: taxonomy-lock-1/)).toBeTruthy();
    const write = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v2/admin/catalog/categories/category-1'));
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ status: 'DISABLED', idempotencyKey: 'disable-category-1' });
  });

  it('moves an existing child category to the root with an explicit null parent', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = walletProvider(wallet);
    const root = { categoryId: 'category-root', version: '1', parentCategoryId: null, level: 1, name: '黄金', iconAssetId: null, sortOrder: 1, status: 'ENABLED', serviceFee: { state: 'DecisionBlocked', valueBps: null } };
    const child = { ...root, categoryId: 'category-child', parentCategoryId: root.categoryId, level: 2, name: '纪念章', sortOrder: 2 };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/catalog/categories') && !init?.method) return jsonResponse({ categories: [root, child] });
      if (url.endsWith('/v2/admin/catalog/tags') && !init?.method) return jsonResponse({ tags: [] });
      if (url.endsWith('/v2/admin/catalog/products') && !init?.method) return jsonResponse({ products: [] });
      if (url.endsWith('/v2/admin/catalog/categories/category-child') && init?.method === 'PUT') return jsonResponse({ ...child, version: '2', parentCategoryId: null, level: 1 });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'taxonomy-root-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt('/catalog');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: '类目与标签' }));
    await user.click(screen.getByRole('button', { name: /纪念章/ }));
    await user.selectOptions(screen.getByLabelText('父类目'), '');
    await user.type(screen.getAllByLabelText('Idempotency key')[0]!, 'category-move-root-1');
    await user.click(screen.getByRole('button', { name: '保存类目版本' }));

    expect(await screen.findByText(/Core 已保存类目 category-child v2/)).toBeTruthy();
    const write = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v2/admin/catalog/categories/category-child'));
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ parentCategoryId: null, idempotencyKey: 'category-move-root-1' });
  });

  it('uses SIWE and renders the wallet-bound payment submission projection', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_requestAccounts') return [wallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['BUYER', 'ADMIN'] });
      if (url.includes('/v2/payments/')) return jsonResponse(paymentProjection());
      if (url.endsWith('/v2/settlements')) return jsonResponse({
        artifactVersion,
        wallet,
        balances: [{ asset: 'NPL', purpose: 'REWARD', rewardSubtype: 'GENESIS', state: 'AVAILABLE', amount: '2000000' }],
        points: [{ pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'LOCKED', amount: '100000000', transferable: false }],
        requests: [],
      });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'test' } }, 400);
    }));
    const user = userEvent.setup();
    renderAt('/clearing');

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await waitFor(() => expect(screen.getByText('BUYER / ADMIN')).toBeTruthy());
    await user.type(screen.getByLabelText('Order ID · bytes32'), hash('3'));
    await user.click(screen.getByRole('button', { name: '读取投影' }));

    expect(await screen.findByText('SUBMITTED')).toBeTruthy();
    expect(screen.getByText('70000000')).toBeTruthy();
    expect(screen.getByText('30000000')).toBeTruthy();
    expect(screen.getByText('12 / 15')).toBeTruthy();
    expect(screen.getByText('pay')).toBeTruthy();
    expect(await screen.findByText('GENESIS · AVAILABLE')).toBeTruthy();
    expect(screen.getByText('BNM backend points')).toBeTruthy();
    expect(screen.getByText('LOCKED · NON_TRANSFERABLE')).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function catalogFetchMock(role: UserRole, products: readonly ManagedCatalogProduct[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: '0x1111111111111111111111111111111111111111', roles: [role] });
    if (url.endsWith('/v2/admin/catalog/categories')) return jsonResponse({ categories: [{ categoryId: 'category-1', version: '1', parentCategoryId: null, level: 1, name: '黄金', iconAssetId: null, sortOrder: 1, status: 'ENABLED', serviceFee: { state: 'DecisionBlocked', valueBps: null } }] });
    if (url.endsWith('/v2/admin/catalog/tags')) return jsonResponse({ tags: [{ tagId: 'tag-1', version: '1', name: '新品', example: '新品上架', sortOrder: 1, status: 'ENABLED' }] });
    if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products });
    return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected Catalog request', correlationId: 'catalog-ui-test' } }, 400);
  });
}

function managedProduct(overrides: Partial<ManagedCatalogProduct> = {}): ManagedCatalogProduct {
  return {
    artifactVersion,
    productId: 'product-24k',
    chainProductId: hash('1'),
    merchantId: 'merchant-1',
    storeId: 'store-1',
    supersedesProductId: null,
    version: '1',
    title: '24K 金章',
    subtitle: '10g',
    lifecycleState: 'DRAFT',
    productPolicyHash: hash('2'),
    merchantConcessionBps: 2500,
    mainImageAssetIds: [],
    videoAssetId: null,
    richDetail: {},
    defaultFreightUsdt: '1000000',
    fulfillmentModes: ['DELIVERY'],
    categoryId: 'category-1',
    tagIds: ['tag-1'],
    skus: [{
      skuId: 'sku-10g', chainSkuId: hash('3'), version: '1', attributes: { weight: '10g' }, listPriceUsdt: '7200000000',
      merchantBaseReceivableUsdt: '7000000000', stockTotal: '20', stockAvailable: '18', stockReserved: '2', proposedSeckillInventory: '5', lifecycleState: 'DRAFT',
    }],
    allowedActions: ['SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW', 'ADJUST_INVENTORY', 'HIDE', 'DELIST'],
    writeLock: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function nonceResponse() {
  return jsonResponse({
    message: 'SIWE message',
    nonce: 'nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, 201);
}

function walletProvider(wallet: string) {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [wallet];
      if (method === 'personal_sign') return '0xsigned';
      throw new Error(`Unexpected wallet method ${method}`);
    }),
  };
}

function hash(digit: string) {
  return `0x${digit.repeat(64)}`;
}

function bootstrapResponse() {
  return {
    artifactVersion,
    status: 'CORE_API_READY',
    readiness: {
      chainId: 56,
      assets: {
        usdt: '0x55d398326f99059ff775485246999027b3197955',
        npl: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
        nplUsdtPair: '0x2955e33bb120714abf11ace2766e614e6e5955b2',
      },
      decisionBlocked: ['PLATFORM_SERVICE_FEE_BPS'],
      externalBlocked: ['PAYMENT_ROUTER_ADDRESS_MANIFEST'],
      paymentDecisionBlocked: ['FIXED_REMAINDER_ACCOUNTS'],
      paymentExternalBlocked: ['PAYMENT_ROUTER_ADDRESS_MANIFEST'],
      providers: { RPC_PRIMARY: 'CONFIGURATION_REQUIRED' },
      writesEnabled: false,
    },
  };
}

function adminDashboardResponse() {
  return {
    artifactVersion,
    timezone: 'Asia/Shanghai',
    window: { start: '2026-07-14T16:00:00.000Z', end: '2026-07-15T16:00:00.000Z', generatedAt: '2026-07-15T04:00:00.000Z' },
    orders: {
      finalizedToday: '3', listPriceUsdt: '300000000', buyerUsdtPaid: '210000000',
      pendingShipment: '4', shipped: '5', delivered: '6', fulfilled: '7',
      shipmentRate: { numerator: '0', denominator: '0', bps: null },
    },
    merchants: { total: '8', newToday: '1', pending: '2', approved: '5', suspended: '1' },
    products: { total: '9', pendingReview: '3', soldOut: '2' },
    seckill: { createdToday: '1', active: '1', settling: '0' },
    fulfillmentQueues: { exchange: '1', delay: '2', arbitration: '3', forcedReceipt: '4', takeover: '5' },
    settlements: { requestedCount: '6', requestedUsdt: '600000000', settledCount: '4', settledUsdt: '400000000', failedTransactions: '2' },
    coverage: [{ snapshotId: 'coverage-1', blockNumber: '123', recordedAt: '2026-07-15T04:00:00.000Z', asset: 'USDT', safeAddress: '0x4444444444444444444444444444444444444444', verifiedAssets: '100', unsettledLiabilities: '101', covered: false }],
    breakers: [
      { scope: 'NEW_PAYMENT', paused: true },
      { scope: 'SECKILL_PURCHASE', paused: false },
      { scope: 'NEW_SETTLEMENT_BATCH', paused: true },
    ],
    unavailable: [
      { metric: 'NEW_UID_USERS', reasonCode: 'DecisionBlocked', detail: 'Buyer UID identity is not frozen' },
      { metric: 'LOW_STOCK_PRODUCTS', reasonCode: 'DecisionBlocked', detail: 'Low-stock threshold is not frozen' },
      { metric: 'ABNORMAL_ORDERS', reasonCode: 'DecisionBlocked', detail: 'Abnormal-order rules are not frozen' },
      { metric: 'BLACKLIST_BLOCKS', reasonCode: 'DecisionBlocked', detail: 'Transaction risk rules are not frozen' },
    ],
  };
}

function paymentProjection() {
  return {
    artifactVersion,
    orderId: hash('3'),
    state: 'SUBMITTED',
    paymentRouterAddress: '0x2222222222222222222222222222222222222222',
    submittedTxHash: hash('4'),
    routerCall: { functionName: 'pay', intent: {}, quoteSignature: '0xquote' },
    intent: {
      orderId: hash('3'),
      policyVersion: 7,
      reservationId: hash('5'),
      reservationDeadline: 1_800_000_000,
      quantity: 1,
      listPriceUsdt: '100000000',
      usdtPaymentAmount: '70000000',
      nplPaymentAmount: '30000000',
      nplBurnAmount: '20000000',
      nplRewardAmount: '10000000',
      merchantNetReceivableUsdt: '65000000',
    },
    finality: {
      transactionHash: hash('4'),
      replacementForTxHash: null,
      blockNumber: 42,
      blockHash: hash('6'),
      confirmations: 12,
      requiredConfirmations: 15,
      receiptStatus: 1,
      state: 'MINED',
      canonicalBlock: true,
      classification: 'ORDINARY',
    },
  };
}

function fulfillmentOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: hash('8'),
    artifactVersion,
    buyerWallet: '0x1111111111111111111111111111111111111111',
    merchantId: 'merchant-1',
    merchantWallet: '0x2222222222222222222222222222222222222222',
    productId: 'product-24k',
    skuId: 'sku-10g',
    quantity: '1',
    createdAt: '2026-07-01T00:00:00.000Z',
    orderKind: 'ORDINARY',
    paymentTxHash: hash('4'),
    fulfillmentMode: 'DELIVERY',
    state: 'PAID',
    finalityStatus: 'FINAL',
    exactAmounts: {
      listPriceUsdt: '100000000',
      usdtPaymentAmount: '70000000',
      nplQuoteAmount: '30000000',
      nplPaymentAmount: '30000000',
      nplBurnAmount: '20000000',
      nplRewardAmount: '10000000',
      merchantBaseReceivableUsdt: '70000000',
      merchantConcessionAmount: '5000000',
      merchantNetReceivableUsdt: '65000000',
      bnmAmount: '100000000',
    },
    paidAt: '2026-07-01T00:00:00.000Z',
    paymentFinalizedAt: '2026-07-01T00:03:00.000Z',
    shippedAt: null,
    deliveredAt: null,
    fulfilledAt: null,
    takeoverOpenedAt: null,
    arbitrationOpenedAt: null,
    requests: [],
    shipments: [],
    logistics: [],
    balances: [{ asset: 'USDT', state: 'LOCKED', amount: '65000000' }],
    allowedActions: [],
    ...overrides,
  };
}

function adminOrderPage(orders: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    orders,
    nextCursor: null,
    pausedScopes: [],
    breaker: null,
    pendingProductReview: null,
    ...overrides,
  };
}

function policyDraft(overrides: Record<string, unknown> = {}) {
  return {
    draftId: 'draft-1',
    nextPolicyVersion: '2',
    basePolicyVersion: '1',
    artifactVersion,
    payload: {},
    validationErrors: [],
    state: 'DRAFT',
    policyHash: hash('1'),
    operationsHash: hash('2'),
    publicationDigest: null,
    publicationNonce: null,
    publicationDeadline: null,
    secondarySigner: null,
    secondarySignatureHash: null,
    safeAddress: null,
    safeCalldataHash: null,
    safeTxHash: null,
    safeProposalHash: null,
    createdBy: '0x1111111111111111111111111111111111111111',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function seckillSession() {
  return {
    artifactVersion,
    sessionId: hash('a'),
    policyVersion: '2',
    merchantId: 'merchant-1',
    product: { productId: 'product-1', skuId: 'sku-1', title: '24K live session', metadata: {}, attributes: {}, seckillListPriceUsdt: '88000000' },
    phase: 'LIVE',
    storedPhase: 'LIVE',
    serverTime: '2026-07-15T05:00:00.000Z',
    startsAt: '2026-07-15T05:00:00.000Z',
    mainDeadline: '2026-07-15T06:00:00.000Z',
    relayDeadline: '2026-07-15T05:01:00.000Z',
    settlementEarliestAt: '2026-07-15T05:06:00.000Z',
    settlementDeadline: '2026-07-15T05:11:00.000Z',
    timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 },
    inventory: { total: '100', sold: '5', reserved: '2', available: '93' },
    prizePoolUsdt: '9000000',
    lastBuyerWallet: '0x1111111111111111111111111111111111111111',
    winnerWallet: null,
    snapshot: {},
    allowedActions: [],
  };
}

function realtimeEvent(sessionId: string) {
  return { artifactVersion, protocolVersion: 1, eventId: 'relay-event-1', channel: `seckill:${sessionId}`, cursor: '1', eventType: 'SeckillRelayExtended', resourceType: 'SECKILL_SESSION', resourceId: sessionId, occurredAt: '2026-07-15T05:00:30.000Z', finality: 'FINAL', payload: {} };
}

class TestWebSocket {
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  close() {}
}

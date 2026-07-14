import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactVersion, executableOrderActionNames } from '@abu24k/core-artifacts';
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
    expect(coreState.artifactStatus).toBe('coordinated-fulfillment-checkpoint');
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
    expect(screen.getByRole('button', { name: '发布新 policyVersion' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders unavailable dashboard values instead of synthetic zeroes', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: '今日运营态势' })).toBeTruthy();
    expect(screen.getAllByText('不可用').length).toBeGreaterThan(4);
    expect(screen.getAllByText(coreState.connectionLabel).length).toBeGreaterThan(0);
  });

  it('keeps global query and every batch action disabled without Core contracts', () => {
    renderAt('/catalog');
    expect(screen.getByRole('heading', { name: '商品主数据' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查询' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /逻辑软删除/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/普通资源也必须由 Core/)).toBeTruthy();
  });

  it('never renders a delete action for append-only audit records', () => {
    renderAt('/audit');
    expect(screen.getByRole('heading', { name: '日志中心' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(screen.getByText(/不可删除资源/)).toBeTruthy();
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

    expect(await screen.findByText(/缺少 ADMIN 或 OPERATOR/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/orders'))).toBe(false);
    expect(screen.queryByRole('button', { name: '打开接管案件' })).toBeNull();
  });

  it('requires current Core allowedActions before an admin can open takeover', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const order = fulfillmentOrder();
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/orders') && !init?.method) return jsonResponse({ orders: [order] });
      if (url.endsWith('/v2/actions/order')) return jsonResponse({ allowedActions: [{ action: 'OPEN_TAKEOVER', enabled: true }] });
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
    const order = fulfillmentOrder();
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/orders') && !init?.method) return jsonResponse({ orders: [order] });
      if (url.endsWith('/v2/actions/order')) return jsonResponse({ allowedActions: [{ action: 'OPEN_TAKEOVER', enabled: false, reasonCode: 'FinalityPending', deadline: '2026-07-21T00:00:00.000Z' }] });
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
    const order = fulfillmentOrder({ state: 'TAKEOVER', takeoverOpenedAt: '2026-07-09T00:00:00.000Z' });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/orders') && !init?.method) return jsonResponse({ orders: [order] });
      if (url.endsWith('/v2/actions/order')) return jsonResponse({ allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] });
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
    const order = fulfillmentOrder({ state: 'ARBITRATION', arbitrationOpenedAt: '2026-07-14T09:00:00.000Z' });
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['OPERATOR'] });
      if (url.endsWith('/v2/orders') && !init?.method) return jsonResponse({ orders: [order] });
      if (url.endsWith('/v2/actions/order')) return jsonResponse({ allowedActions: [{ action: 'DECIDE_ARBITRATION', enabled: true }] });
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

  it('shows every governance gate and blocks publication', () => {
    renderAt('/policy');
    expect(screen.getByText('RBAC 授权')).toBeTruthy();
    expect(screen.getByText('二次钱包签名')).toBeTruthy();
    expect(screen.getByText('Safe 多签')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布新 policyVersion' }).hasAttribute('disabled')).toBe(true);
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

  it('renders Core-authoritative product, SKU, amount and stock values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      products: [{
        productId: 'product-24k',
        chainProductId: hash('1'),
        title: '24K 金章',
        metadata: {},
        skus: [{
          skuId: 'sku-10g',
          chainSkuId: hash('2'),
          attributes: { weight: '10g' },
          listPriceUsdt: '7200000000',
          stockAvailable: '18',
        }],
      }],
    })));
    renderAt('/catalog');

    expect(await screen.findByText('24K 金章')).toBeTruthy();
    expect(screen.getByText('7200000000')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('weight: 10g')).toBeTruthy();
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
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
    ...overrides,
  };
}

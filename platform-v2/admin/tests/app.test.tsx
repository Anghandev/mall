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
    expect(coreState.artifactStatus).toBe('coordinated-payment-checkpoint');
    expect(coreState.connectionLabel).toContain(artifactVersion);
  });

  it('keeps every write disabled when Core publishes no executable order action', () => {
    expect(executableOrderActionNames).toEqual([]);
    expect(coreState.executableOrderActionNames).toEqual(executableOrderActionNames);
    expect(productBaseline.adminCapabilities.writes).toBe(false);
    expect(coreState.canWrite).toBe(false);

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

  it('makes the takeover center visible while execution remains blocked', () => {
    renderAt('/takeover');
    expect(screen.getByRole('heading', { name: '商家接管履约中心' })).toBeTruthy();
    expect(screen.getByText('保证金 → 冻结应收 → 未来货款')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开履约证据' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
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

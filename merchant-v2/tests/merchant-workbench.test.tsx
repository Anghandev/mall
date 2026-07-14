import { readFileSync } from 'node:fs';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { artifactVersion, type CatalogProduct } from '@abu24k/core-artifacts';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import type { CoreApi, CoreBootstrap } from '../src/core-api';
import { coreBoundary, canExecuteOrderAction } from '../src/core-boundary';
import { CoreRuntimeProvider } from '../src/core-runtime';
import { AssetsPage } from '../src/pages/AssetsPage';
import { FulfillmentPage } from '../src/pages/FulfillmentPage';
import { HelpPage } from '../src/pages/HelpPage';
import { LoginPage } from '../src/pages/LoginPage';
import { ProductPage } from '../src/pages/ProductPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { StoresPage } from '../src/pages/StoresPage';

const styles = readFileSync('src/styles.css', 'utf8');
const walletAddress = '0x1111111111111111111111111111111111111111';
const chainProductId = `0x${'a'.repeat(64)}`;
const chainSkuId = `0x${'b'.repeat(64)}`;

const bootstrap: CoreBootstrap = {
  artifactVersion,
  status: 'CORE_API_READY',
  readiness: {
    chainId: 56,
    decisionBlocked: [],
    externalBlocked: [],
    paymentDecisionBlocked: [],
    paymentExternalBlocked: [],
    providers: {},
    writesEnabled: false,
  },
};

const catalogProduct: CatalogProduct = {
  productId: 'product-payment-read',
  chainProductId,
  title: '支付批次商品',
  metadata: {},
  skus: [{
    skuId: 'sku-gold',
    chainSkuId,
    attributes: { color: '金色' },
    listPriceUsdt: '24000000000000000000',
    stockAvailable: '19',
  }],
};

function createMockCoreApi(overrides: Partial<CoreApi> = {}): CoreApi {
  return {
    bootstrap: async () => bootstrap,
    createSiweChallenge: async () => ({
      message: 'merchant.test wants you to sign in',
      nonce: 'nonce',
      issuedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:05:00.000Z',
    }),
    verifySiwe: async () => ({ token: 'test-session', walletAddress, roles: ['MERCHANT'] }),
    listCatalog: async () => [catalogProduct],
    getOrderAllowedActions: async () => [{
      action: 'RECORD_SHIPMENT',
      enabled: false,
      reasonCode: 'ConfigurationRequired',
    }],
    ...overrides,
  };
}

function renderPage(page: React.ReactNode, client = createMockCoreApi()) {
  return render(
    <MemoryRouter>
      <CoreRuntimeProvider client={client}>{page}</CoreRuntimeProvider>
    </MemoryRouter>,
  );
}

function installWallet() {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_requestAccounts') return [walletAddress];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'personal_sign') return '0xsigned';
    throw new Error(`Unexpected wallet method: ${method}`);
  });
  window.ethereum = { request };
  return request;
}

describe('00 wallet gateway', () => {
  it('consumes payment.1 and keeps unpublished executable actions disabled', () => {
    expect(artifactVersion).toBe('2.0.0-payment.1');
    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(coreBoundary.artifactVersion).toBe(artifactVersion);
    expect(coreBoundary.artifactsAvailable).toBe(true);
    expect(coreBoundary.executableOrderActionNames).toEqual([]);
    expect(canExecuteOrderAction('RECORD_SHIPMENT')).toBe(false);
    expect(canExecuteOrderAction('REQUEST_MERCHANT_SETTLEMENT')).toBe(false);
  });

  it('performs the published BSC SIWE flow and enters only with a merchant role', async () => {
    const user = userEvent.setup();
    const walletRequest = installWallet();
    const createSiweChallenge = vi.fn(createMockCoreApi().createSiweChallenge);
    const verifySiwe = vi.fn(createMockCoreApi().verifySiwe);
    const client = createMockCoreApi({ createSiweChallenge, verifySiwe });

    render(<MemoryRouter><App client={client} /></MemoryRouter>);

    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect(await screen.findByRole('heading', { name: '运营大盘' })).toBeTruthy();
    expect(createSiweChallenge).toHaveBeenCalledWith(walletAddress);
    expect(verifySiwe).toHaveBeenCalledWith('merchant.test wants you to sign in', '0xsigned');
    expect(walletRequest.mock.calls.map(([request]) => request.method)).toEqual([
      'eth_requestAccounts',
      'eth_chainId',
      'personal_sign',
    ]);
  });

  it('can launch the detected OKX provider explicitly', async () => {
    const user = userEvent.setup();
    delete window.ethereum;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [walletAddress];
      if (method === 'eth_chainId') return '0x38';
      if (method === 'personal_sign') return '0xokx-signed';
      throw new Error(`Unexpected wallet method: ${method}`);
    });
    window.okxwallet = { request };
    render(<MemoryRouter><App client={createMockCoreApi()} /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /OKX Wallet/ }));
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect(await screen.findByRole('heading', { name: '运营大盘' })).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ method: 'personal_sign', params: [expect.any(String), walletAddress] });
  });

  it('has no password fallback and fails closed when no supported wallet is installed', async () => {
    delete window.ethereum;
    delete window.okxwallet;
    renderPage(<LoginPage />);

    expect(screen.getByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByLabelText(/密码/)).toBeNull();
    const connect = screen.getByRole('button', { name: '连接钱包' }) as HTMLButtonElement;
    await waitFor(() => expect(connect.disabled).toBe(true));
    expect(screen.getByText(/Nonce、时间戳、授权商家校验/)).toBeTruthy();
  });

  it('rejects an authenticated wallet that lacks the merchant role', async () => {
    const user = userEvent.setup();
    installWallet();
    const client = createMockCoreApi({
      verifySiwe: async () => ({ token: 'buyer-session', walletAddress, roles: ['BUYER'] }),
    });
    render(<MemoryRouter><App client={client} /></MemoryRouter>);

    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect((await screen.findByRole('alert')).textContent).toContain('没有商家工作台权限');
    expect(screen.getByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '运营大盘' })).toBeNull();
  });

  it('redirects protected routes while merchant authentication is unavailable', async () => {
    render(<MemoryRouter initialEntries={['/dashboard']}><App client={createMockCoreApi()} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '运营大盘' })).toBeNull();
  });
});

describe('02 one-product form', () => {
  it('reads official Catalog/SKU/stock values but does not invent merchant ownership or costs', async () => {
    renderPage(<ProductPage />);

    expect(screen.getByRole('heading', { name: '单品提报' })).toBeTruthy();
    expect(await screen.findByText('支付批次商品')).toBeTruthy();
    expect(screen.getByText('24000000000000000000')).toBeTruthy();
    expect(screen.getByText('19')).toBeTruthy();
    expect(screen.getByText(/color: 金色/)).toBeTruthy();
    expect(screen.getByText(/不将任何一条冒充为/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存提报' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('商家基础应收') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/前端不从售价反推/)).toBeTruthy();
  });
});

describe('03 fulfillment center', () => {
  it('keeps delivery and pickup streams distinct and never lets the merchant complete receipt', async () => {
    const user = userEvent.setup();
    renderPage(<FulfillmentPage />);

    expect(screen.getByRole('columnheader', { name: '详细地址' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /商家强制签收|直接完成订单/ })).toBeNull();
    expect((screen.getByRole('button', { name: '申请平台审核' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(screen.getByRole('columnheader', { name: '核销门店' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '核销时间' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '启动扫码' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/不能离线提交/)).toBeTruthy();
  });

  it('uses the real allowedActions consumer after SIWE without calling a buyer payment route', async () => {
    const user = userEvent.setup();
    installWallet();
    const getOrderAllowedActions = vi.fn(createMockCoreApi().getOrderAllowedActions);
    const client = createMockCoreApi({ getOrderAllowedActions });
    render(<MemoryRouter><App client={client} /></MemoryRouter>);

    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);
    const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
    await user.click(within(navigation).getByRole('link', { name: /履约交付/ }));
    await user.type(screen.getByLabelText('订单 ID'), 'order-payment-check');
    await user.click(screen.getByRole('button', { name: '核验可用操作' }));

    expect(await screen.findByText('ConfigurationRequired')).toBeTruthy();
    expect(getOrderAllowedActions).toHaveBeenCalledWith('order-payment-check', 'test-session');
  });

  it('contains wide tables inside their horizontal scroll region', () => {
    expect(styles).toMatch(/\.page-stack,\s*\.page-stack > \* \{\s*min-width: 0;/);
    expect(styles).toMatch(/\.table-wrap \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow-x: auto;/);
  });
});

describe('04 store controls', () => {
  it('forbids manual region entry and blocks device binding', () => {
    renderPage(<StoresPage />);

    const region = screen.getByLabelText('6 位行政区划代码') as HTMLInputElement;
    expect(region.disabled).toBe(true);
    expect(region.readOnly).toBe(true);
    expect(screen.getByText('禁止手工回填。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '绑定设备' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('05 asset rails', () => {
  it('uses the five settlement states and contains no contract-pull proceeds action', () => {
    renderPage(<AssetsPage />);

    expect(screen.getByRole('heading', { name: 'USDT 货款' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '门店奖励池' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '释放跟踪' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '签名结算申请' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Requested 已申请')).toBeTruthy();
    expect(screen.getByText('Batched 已组批')).toBeTruthy();
    expect(screen.getByText('Settled 已结算')).toBeTruthy();
  });
});

describe('06 audit and 07 rules', () => {
  it('keeps settlement wallet immutable and audit history unavailable', () => {
    renderPage(<SettingsPage />);

    expect(screen.getByText('普通编辑不可更换')).toBeTruthy();
    expect((screen.getByRole('button', { name: '申请治理迁移' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('审计日志不可用')).toBeTruthy();
  });

  it('shows frozen merchant boundaries while versioned policy content is unavailable', () => {
    renderPage(<HelpPage />);

    expect(screen.getByText('当前规则内容不可用')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '7 天未发货进入平台接管' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '商家不能直接确认签收' })).toBeTruthy();
    expect(screen.getByText(/具体责任和金额必须以已发布政策/)).toBeTruthy();
  });
});

describe('workspace accessibility', () => {
  it('provides labeled navigation, skip link and mobile drawer controls in review mode', async () => {
    window.history.replaceState({}, '', '/dashboard?__merchant_visual_review__=1');
    render(<MemoryRouter initialEntries={['/dashboard?__merchant_visual_review__=1']}><App client={createMockCoreApi()} /></MemoryRouter>);

    const navigation = screen.getByRole('navigation', { name: '商家工作台导航' });
    expect(within(navigation).getByRole('link', { name: /履约交付/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开导航' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText(artifactVersion)).toBeTruthy();
    expect(await screen.findByText('支付 Core 已连接')).toBeTruthy();
  });
});

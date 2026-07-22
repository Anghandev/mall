import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactVersion,
  rewardSubtypes,
  type CatalogProduct,
  type ManagedCatalogProduct,
  type MerchantManagedStore,
} from '@abu24k/core-artifacts';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { CoreApiError, type CoreApi, type CoreBootstrap } from '../src/core-api';
import { coreBoundary, canExecuteOrderAction } from '../src/core-boundary';
import { CoreRuntimeProvider } from '../src/core-runtime';
import { AssetsPage } from '../src/pages/AssetsPage';
import { FulfillmentPage } from '../src/pages/FulfillmentPage';
import { LoginPage } from '../src/pages/LoginPage';
import { ProductPage } from '../src/pages/ProductPage';
import { StoresPage } from '../src/pages/StoresPage';
import { merchantBusinessDashboard } from './business-dashboard-fixtures';
import {
  merchantAudit,
  merchantAuditExport,
  merchantProfile,
} from './account-fixtures';
import {
  deliveryOrder,
  deliveryOrderId,
  deliveryTarget,
  evidenceHash,
  merchantOrderExport,
  pickupOrder,
  pickupOrderId,
  pickupTarget,
  trackingNumberHash,
} from './fulfillment-fixtures';
import {
  cmsRules,
  guaranteeDepositResult,
  merchantFinance,
  merchantReceivableStatements,
  merchantReceivableStatementsNext,
  requestedSettlement,
  settlementIntent,
  settlementList,
} from './settlement-fixtures';
import {
  pickupPrintJob,
  printerBinding,
  printerChallenge,
  waybillBatchResult,
  waybillPrintJob,
} from './logistics-fixtures';
import {
  takeoverCaseDetail,
  takeoverCaseList,
  takeoverTrackingEvidence,
} from './takeover-fixtures';
import {
  catalogCategories,
  catalogTags,
  completedMediaAsset,
  concessionPreview,
  managedProduct,
  managedMerchantStore,
  mediaReadAccess,
  mediaUploadIntent,
  merchantStore,
  productSlot,
  storeId,
} from './catalog-fixtures';

const styles = readFileSync('src/styles.css', 'utf8');
const walletAddress = '0x1111111111111111111111111111111111111111';
const chainProductId = `0x${'a'.repeat(64)}`;
const chainSkuId = `0x${'b'.repeat(64)}`;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete (navigator as unknown as { mediaDevices?: MediaDevices }).mediaDevices;
});

const bootstrap: CoreBootstrap = {
  artifactVersion,
  status: 'CORE_API_READY',
  readiness: {
    chainId: 56,
    decisionBlocked: [],
    externalBlocked: [],
    paymentDecisionBlocked: [],
    paymentExternalBlocked: [],
    providers: {
      KUAIDI100: 'READY',
      CAINIAO: 'READY',
      FEIE: 'READY',
      YILIANYUN: 'READY',
    },
    writesEnabled: false,
  },
};

const catalogProduct: CatalogProduct = {
  productId: 'product-payment-read',
  chainProductId,
  title: '支付批次商品',
  subtitle: '公开商品副标题',
  metadata: {},
  mainImageAssetIds: [chainProductId],
  videoAssetId: null,
  richDetail: { blocks: [] },
  defaultFreightUsdt: '0',
  fulfillmentModes: ['DELIVERY', 'PICKUP'],
  categoryId: 'category-gold',
  tagIds: ['tag-24k'],
  skus: [{
    skuId: 'sku-gold',
    chainSkuId,
    attributes: { color: '金色' },
    listPriceUsdt: '24000000000000000000',
    stockAvailable: '19',
    seckill: null,
  }],
};

function createMockCoreApi(overrides: Partial<CoreApi> = {}): CoreApi {
  const reviewedProduct: ManagedCatalogProduct = {
    ...managedProduct,
    lifecycleState: 'REVIEW',
    allowedActions: [],
    writeLock: { type: 'PRODUCT_STATE', id: managedProduct.productId, state: 'REVIEW' },
  };
  return {
    bootstrap: async () => bootstrap,
    createSiweChallenge: async () => ({
      message: 'merchant.test wants you to sign in',
      nonce: 'nonce',
      issuedAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:05:00.000Z',
    }),
    verifySiwe: async () => ({ token: 'test-session', walletAddress, roles: ['MERCHANT'], merchantId: 'merchant-1' }),
    listCatalog: async () => [catalogProduct],
    listCatalogCategories: async () => catalogCategories,
    listCatalogTags: async () => catalogTags,
    listMerchantStores: async () => [merchantStore],
    listManagedMerchantStores: async () => [managedMerchantStore],
    createMerchantStore: async (input) => ({
      ...managedMerchantStore,
      name: input.name,
      phone: input.phone,
      businessHours: input.businessHours,
      longitude: input.longitude,
      latitude: input.latitude,
      status: 'DRAFT',
      imageAssetIds: [],
      allowedActions: [
        { action: 'UPDATE_PROFILE', enabled: true },
        { action: 'ACTIVATE', enabled: false, reasonCode: 'STORE_PROFILE_INCOMPLETE' },
        { action: 'CLOSE', enabled: true },
      ],
    }),
    updateMerchantStore: async (_storeId, input) => ({
      ...managedMerchantStore,
      name: input.name,
      phone: input.phone,
      businessHours: input.businessHours,
      imageAssetIds: input.imageAssetIds,
      version: input.expectedVersion + 1,
    }),
    activateMerchantStore: async () => managedMerchantStore,
    closeMerchantStore: async () => ({
      ...managedMerchantStore,
      status: 'CLOSED',
      version: managedMerchantStore.version + 1,
      allowedActions: [
        { action: 'UPDATE_PROFILE', enabled: false, reasonCode: 'STORE_CLOSED' },
        { action: 'ACTIVATE', enabled: false, reasonCode: 'STORE_CLOSED' },
        { action: 'CLOSE', enabled: false, reasonCode: 'STORE_CLOSED' },
      ],
    }),
    getMerchantPrinterBinding: async () => null,
    createMerchantPrinterBindingChallenge: async () => printerChallenge,
    applyMerchantPrinterBinding: async () => printerBinding,
    createMerchantWaybillBatch: async () => waybillBatchResult,
    listMerchantPrintJobs: async () => [],
    retryMerchantPrintJob: async () => ({ ...waybillPrintJob, state: 'QUEUED', attempts: 0, errorCode: null }),
    getMerchantProductSlot: async () => productSlot,
    saveMerchantProductSlot: async () => managedProduct,
    createMerchantConcessionPreview: async () => concessionPreview,
    submitMerchantProductReview: async () => reviewedProduct,
    delistMerchantProduct: async () => ({
      ...managedProduct,
      lifecycleState: 'DELISTED',
      allowedActions: [],
      writeLock: null,
    }),
    createMediaUploadIntent: async () => mediaUploadIntent,
    completeMediaUpload: async () => completedMediaAsset,
    getMediaReadAccess: async (assetId, _token, expected) => ({
      ...mediaReadAccess,
      assetId,
      purpose: expected?.purpose ?? mediaReadAccess.purpose,
      resourceType: expected?.resourceType ?? mediaReadAccess.resourceType,
      resourceId: expected?.resourceId ?? mediaReadAccess.resourceId,
    }),
    getMerchantProfile: async () => merchantProfile,
    updateMerchantProfile: async (input) => ({
      ...merchantProfile,
      shopName: input.shopName,
      logoAssetId: input.logoAssetId,
      version: input.expectedVersion + 1,
    }),
    listMerchantAuditEntries: async () => merchantAudit,
    exportMerchantAuditEntries: async () => merchantAuditExport,
    exportMerchantOrders: async (input) => ({
      ...merchantOrderExport,
      filters: {
        from: input.from ?? merchantOrderExport.filters.from,
        to: input.to ?? merchantOrderExport.filters.to,
        skuId: input.skuId ?? null,
        state: input.state ?? null,
        fulfillmentMode: input.fulfillmentMode ?? null,
        orderKind: input.orderKind ?? null,
        cursorCreatedAt: input.cursorCreatedAt ?? null,
        cursorOrderId: input.cursorOrderId ?? null,
        limit: input.limit ?? 1_000,
      },
    }),
    listFulfillmentOrders: async () => ({ orders: [], nextCursor: null }),
    listMerchantTakeoverCases: async () => takeoverCaseList,
    getMerchantTakeoverCase: async () => takeoverCaseDetail,
    getMerchantBusinessDashboard: async () => merchantBusinessDashboard,
    getOrderFulfillmentTarget: async () => deliveryTarget,
    getOrderAllowedActions: async () => [{
      action: 'RECORD_SHIPMENT',
      enabled: false,
      reasonCode: 'ConfigurationRequired',
    }],
    createOrderTrackingEvidence: async () => takeoverTrackingEvidence,
    createOrderActionEvidence: async (orderId, input) => ({
      artifactVersion,
      evidenceHash: `0x${'f'.repeat(64)}`,
      ownerWallet: walletAddress,
      actorRole: 'MERCHANT',
      purpose: 'FULFILLMENT_ACTION',
      resourceType: 'ORDER',
      resourceId: orderId,
      action: input.action,
      reasonCode: input.reasonCode,
      trackingNumberHash: null,
      mediaAssetIds: [],
      payload: {},
      createdAt: '2026-07-14T12:00:00.000Z',
    }),
    recordShipment: async (orderId, input) => ({
      orderId,
      state: 'SHIPPED',
      shipmentId: 'shipment-result',
      carrierCode: input.carrierCode,
      trackingNumberHash: input.trackingNumberHash,
      recordedAt: '2026-07-14T12:00:00.000Z',
    }),
    recordShipmentBatch: async (input) => ({
      batchId: `0x${'8'.repeat(64)}`,
      shipments: input.items.map((item) => ({
        orderId: item.orderId,
        state: 'SHIPPED',
        shipmentId: `shipment-${item.orderId.slice(2, 10)}`,
        carrierCode: item.carrierCode,
        trackingNumberHash: item.trackingNumberHash,
        recordedAt: '2026-07-14T12:00:00.000Z',
      })),
      createdAt: '2026-07-14T12:00:00.000Z',
    }),
    requestForcedReceipt: async (orderId) => ({
      orderId,
      requestId: 'forced-receipt-result',
      state: 'OPEN',
      platformReviewRequired: true,
      canFinalizeDirectly: false,
    }),
    verifyPickup: async (orderId) => ({
      orderId,
      state: 'FULFILLED',
      method: 'PICKUP_VERIFICATION',
      fulfilledAt: '2026-07-14T12:05:00.000Z',
    }),
    listSettlements: async () => settlementList,
    listMerchantReceivableStatements: async (_token, options) => (
      options?.cursor ? merchantReceivableStatementsNext : merchantReceivableStatements
    ),
    createSettlementIntent: async () => settlementIntent,
    submitSettlementRequest: async () => requestedSettlement,
    getMerchantFinance: async () => merchantFinance,
    submitGuaranteeDeposit: async () => guaranteeDepositResult,
    listPublicCms: async () => [cmsRules],
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
  const request = vi.fn(async ({ method }: { method: string; params?: readonly unknown[] }) => {
    if (method === 'eth_requestAccounts') return [walletAddress];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'personal_sign') return '0xsigned';
    if (method === 'eth_signTypedData_v4') return `0x${'12'.repeat(65)}`;
    throw new Error(`Unexpected wallet method: ${method}`);
  });
  window.ethereum = { request };
  return request;
}

async function enterFulfillment(client: CoreApi) {
  const user = userEvent.setup();
  installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /履约交付/ }));
  return user;
}

async function enterTakeovers(client: CoreApi) {
  const user = userEvent.setup();
  installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /接管履约/ }));
  return user;
}

async function enterStores(client: CoreApi) {
  const user = userEvent.setup();
  const walletRequest = installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /门店管理/ }));
  return { user, walletRequest };
}

async function enterAssets(client: CoreApi) {
  const user = userEvent.setup();
  const walletRequest = installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /资产清算/ }));
  return { user, walletRequest };
}

async function enterProduct(client: CoreApi) {
  const user = userEvent.setup();
  installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /单品提报/ }));
  return user;
}

async function enterSettings(client: CoreApi) {
  const user = userEvent.setup();
  installWallet();
  render(<MemoryRouter><App client={client} /></MemoryRouter>);
  const connect = screen.getByRole('button', { name: '连接钱包' });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  await user.click(connect);
  const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
  await user.click(within(navigation).getByRole('link', { name: /系统配置/ }));
  await screen.findByRole('heading', { name: '系统配置' });
  return user;
}

describe('00 wallet gateway', () => {
  it('consumes settlement-admin.16 without widening the merchant action boundary', () => {
    expect(artifactVersion).toBe('2.0.0-fulfillment-launch.23');
    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(coreBoundary.artifactVersion).toBe(artifactVersion);
    expect(coreBoundary.artifactsAvailable).toBe(true);
    expect(coreBoundary.executableOrderActionNames).toContain('RECORD_SHIPMENT');
    expect(canExecuteOrderAction('RECORD_SHIPMENT')).toBe(false);
    expect(canExecuteOrderAction('RECORD_SHIPMENT', [{ action: 'RECORD_SHIPMENT', enabled: true }])).toBe(true);
    expect(canExecuteOrderAction('RECORD_SHIPMENT', [{
      action: 'RECORD_SHIPMENT',
      enabled: false,
      reasonCode: 'FinalityPending',
    }])).toBe(false);
    expect(canExecuteOrderAction('REQUEST_MERCHANT_SETTLEMENT', [{
      action: 'REQUEST_MERCHANT_SETTLEMENT',
      enabled: true,
    }])).toBe(false);
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
    expect(screen.getByText('24K商城', { selector: '.brand-lockup strong' })).toBeTruthy();
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

    expect(screen.getByText('24K商城 · Merchant')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/阿步|Abu 24K|ABU 24K/);
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

  it('rejects a SIWE response with a different wallet or no merchant tenant identity', async () => {
    const user = userEvent.setup();
    installWallet();
    const wrongWallet = createMockCoreApi({
      verifySiwe: async () => ({
        token: 'wrong-wallet-session',
        walletAddress: '0x2222222222222222222222222222222222222222',
        roles: ['MERCHANT'],
        merchantId: 'merchant-1',
      }),
    });
    render(<MemoryRouter><App client={wrongWallet} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);
    expect((await screen.findByRole('alert')).textContent).toContain('实际签名钱包不一致');

    cleanup();
    installWallet();
    const missingTenant = createMockCoreApi({
      verifySiwe: async () => ({ token: 'unscoped-session', walletAddress, roles: ['MERCHANT'] }),
    });
    render(<MemoryRouter><App client={missingTenant} /></MemoryRouter>);
    const retry = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    await user.click(retry);
    expect((await screen.findByRole('alert')).textContent).toContain('缺少商家身份');
    expect(screen.queryByRole('heading', { name: '运营大盘' })).toBeNull();
  });

  it('redirects protected routes while merchant authentication is unavailable', async () => {
    render(<MemoryRouter initialEntries={['/dashboard']}><App client={createMockCoreApi()} /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '运营大盘' })).toBeNull();
  });
});

describe('01 authoritative dashboard', () => {
  it('renders Core day-window amounts, current fulfillment queues and generated product states', async () => {
    const getMerchantBusinessDashboard = vi.fn(async () => merchantBusinessDashboard);
    const user = userEvent.setup();
    installWallet();
    render(<MemoryRouter><App client={createMockCoreApi({ getMerchantBusinessDashboard })} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect(await screen.findByText('8000000000000000000000')).toBeTruthy();
    expect(screen.getByText('5600000000000000000000')).toBeTruthy();
    expect(screen.getByText('4800000000000000000000')).toBeTruthy();
    expect(screen.getByText('3600000000000000000000')).toBeTruthy();
    expect(screen.getByText('销售进行中')).toBeTruthy();
    expect(screen.getAllByText(/秒杀进行中/).length).toBeGreaterThan(0);
    expect(screen.getByText('Asia/Shanghai')).toBeTruthy();
    expect(screen.getByText('5000 bps')).toBeTruthy();
    expect(getMerchantBusinessDashboard).toHaveBeenCalledWith('test-session');
    expect(screen.getByRole('link', { name: /快递待发货订单3/ }).getAttribute('href')).toBe('/fulfillment');
  });

  it('renders the authoritative pickup count and drills into canonical pickup evidence', async () => {
    const dashboard = {
      ...merchantBusinessDashboard,
      orders: { ...merchantBusinessDashboard.orders, pickupVerifiedToday: '17' },
    };
    const listFulfillmentOrders = vi.fn(async () => ({ orders: [pickupOrder], nextCursor: null }));
    const getOrderFulfillmentTarget = vi.fn(async () => pickupTarget);
    const user = userEvent.setup();
    installWallet();
    render(<MemoryRouter><App client={createMockCoreApi({
      getMerchantBusinessDashboard: async () => dashboard,
      listFulfillmentOrders,
      getOrderFulfillmentTarget,
    })} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    const pickupLink = await screen.findByRole('link', { name: /今日门店核销17/ });
    expect(screen.getByLabelText('今日门店核销17').textContent).toBe('17');
    expect(pickupLink.getAttribute('href')).toBe('/fulfillment?mode=pickup');
    await user.click(pickupLink);

    expect(await screen.findByRole('heading', { name: '履约交付' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '到店自提' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(listFulfillmentOrders).toHaveBeenLastCalledWith(
      'test-session',
      expect.objectContaining({ fulfillmentMode: 'PICKUP', limit: 100 }),
    ));
    await user.click(await screen.findByRole('button', { name: `处理订单 ${pickupOrderId}` }));
    expect((await screen.findAllByText(pickupTarget.payload.name)).length).toBeGreaterThan(1);
    expect(getOrderFulfillmentTarget).toHaveBeenCalledWith(pickupOrderId, 'test-session');
  });

  it('keeps merchant analytics available when platform SAFE_COVERAGE is externally blocked', async () => {
    const getMerchantBusinessDashboard = vi.fn(async () => merchantBusinessDashboard);
    const user = userEvent.setup();
    installWallet();
    render(<MemoryRouter><App client={createMockCoreApi({
      bootstrap: async () => ({
        ...bootstrap,
        readiness: { ...bootstrap.readiness, externalBlocked: ['SAFE_COVERAGE'] },
      }),
      getMerchantBusinessDashboard,
    })} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect(await screen.findByText('8000000000000000000000')).toBeTruthy();
    expect(getMerchantBusinessDashboard).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('SAFE_COVERAGE')).toBeNull();
  });

  it('shows unavailable instead of zero when the dashboard request fails', async () => {
    const user = userEvent.setup();
    installWallet();
    render(<MemoryRouter><App client={createMockCoreApi({
      getMerchantBusinessDashboard: async () => {
        throw new CoreApiError('NetworkUnavailable', 'dashboard offline');
      },
    })} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);

    expect(await screen.findByText('运营聚合加载失败')).toBeTruthy();
    expect(screen.getAllByText(/dashboard offline/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('快递待发货订单不可用').textContent).toBe('--');
  });
});

describe('02 one-product form', () => {
  it('reads the merchant-bound unique slot with complete SKU, inventory, media and replacement history', async () => {
    const getMerchantProductSlot = vi.fn(async () => productSlot);
    const listMerchantStores = vi.fn(async () => [
      merchantStore,
      { ...merchantStore, storeId: 'store-other', merchantId: 'merchant-other', name: '其他商家门店' },
    ]);
    const client = createMockCoreApi({ getMerchantProductSlot, listMerchantStores });

    await enterProduct(client);

    expect(await screen.findByRole('heading', { name: '单品提报' })).toBeTruthy();
    expect((await screen.findByLabelText('商品标题') as HTMLInputElement).value).toBe('24K 足金金片');
    expect(screen.getAllByText('690').length).toBeGreaterThan(0);
    expect(screen.getByText('只读：Core 按 70% USDT 付款减 1% 服务费派生。')).toBeTruthy();
    expect((screen.getByLabelText('总库存') as HTMLInputElement).value).toBe('20');
    expect(screen.getByText(/product-history-1/)).toBeTruthy();
    expect(await screen.findByAltText('商品主图 1')).toBeTruthy();
    expect(screen.getByLabelText('商品视频')).toBeTruthy();
    expect(screen.queryByText('其他商家门店')).toBeNull();
    expect(getMerchantProductSlot).toHaveBeenCalledWith(storeId, 'test-session');
  });

  it('saves the exact product form, renders the signed concession allocation and submits its preview', async () => {
    const reviewedProduct: ManagedCatalogProduct = {
      ...managedProduct,
      lifecycleState: 'REVIEW',
      allowedActions: [],
      writeLock: { type: 'PRODUCT_STATE', id: managedProduct.productId, state: 'REVIEW' },
    };
    const reviewedSlot = {
      ...productSlot,
      product: reviewedProduct,
      allowedActions: [],
      writeLock: reviewedProduct.writeLock,
    };
    const getMerchantProductSlot = vi.fn()
      .mockResolvedValueOnce(productSlot)
      .mockResolvedValueOnce(productSlot)
      .mockResolvedValueOnce(reviewedSlot);
    const saveMerchantProductSlot = vi.fn(async () => managedProduct);
    const createMerchantConcessionPreview = vi.fn(async () => concessionPreview);
    const submitMerchantProductReview = vi.fn(async () => reviewedProduct);
    const client = createMockCoreApi({
      getMerchantProductSlot,
      saveMerchantProductSlot,
      createMerchantConcessionPreview,
      submitMerchantProductReview,
    });
    const user = await enterProduct(client);
    const title = await screen.findByLabelText('商品标题');

    await user.clear(title);
    await user.type(title, '24K 足金新标题');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(saveMerchantProductSlot).toHaveBeenCalledTimes(1));
    expect(saveMerchantProductSlot).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        title: '24K 足金新标题',
        merchantConcessionBps: 2500,
        mainImageAssetIds: managedProduct.mainImageAssetIds,
        fulfillmentModes: ['DELIVERY', 'PICKUP'],
        skus: [expect.objectContaining({
          skuId: managedProduct.skus[0]!.skuId,
          listPriceUsdt: '1000',
          stockTotal: 20,
          proposedSeckillInventory: 10,
        })],
        idempotencyKey: expect.stringMatching(/^save-product-store-1-/),
      }),
      'test-session',
    );

    await user.click(screen.getByRole('button', { name: '生成签名预览' }));
    expect(await screen.findByRole('heading', { name: '商家让利预览' })).toBeTruthy();
    expect(screen.getByText('秒杀奖池 45% / LOCKED')).toBeTruthy();
    expect(screen.getByText('节点奖励池 45% / LOCKED')).toBeTruthy();
    expect(screen.getByText('奖励预留池 10% / LOCKED')).toBeTruthy();
    expect(screen.getByRole('cell', { name: '518' })).toBeTruthy();
    expect(screen.getByText(/digest: 0x/)).toBeTruthy();
    expect(createMerchantConcessionPreview).toHaveBeenCalledWith(
      managedProduct.productId,
      expect.objectContaining({ merchantConcessionBps: 2500 }),
      'test-session',
    );

    await user.click(screen.getByRole('button', { name: '提交平台审核' }));
    await waitFor(() => expect(submitMerchantProductReview).toHaveBeenCalledWith(
      managedProduct.productId,
      expect.objectContaining({ previewId: concessionPreview.previewId }),
      'test-session',
    ));
    expect(await screen.findByText(/blockingResource: PRODUCT_STATE/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the exact Core blocking resource and never unlocks a review product locally', async () => {
    const lockedProduct: ManagedCatalogProduct = {
      ...managedProduct,
      lifecycleState: 'REVIEW',
      allowedActions: [],
      writeLock: { type: 'SECKILL_SESSION', id: 'session-24k-1', state: 'LIVE' },
    };
    const client = createMockCoreApi({
      getMerchantProductSlot: async () => ({
        ...productSlot,
        product: lockedProduct,
        allowedActions: [],
        writeLock: lockedProduct.writeLock,
      }),
    });

    await enterProduct(client);

    expect(await screen.findByText('blockingResource: SECKILL_SESSION / session-24k-1 / LIVE')).toBeTruthy();
    expect((screen.getByLabelText('商品标题') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uploads a product image through the issued target and keeps it unsaved until the draft command', async () => {
    const createMediaUploadIntent = vi.fn(async () => mediaUploadIntent);
    const completeMediaUpload = vi.fn(async () => completedMediaAsset);
    const client = createMockCoreApi({ createMediaUploadIntent, completeMediaUpload });
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const user = await enterProduct(client);
    await screen.findByLabelText('商品标题');
    const input = document.querySelector<HTMLInputElement>('input[accept="image/jpeg,image/png,image/webp"]');
    expect(input).toBeTruthy();
    const file = new File([new Uint8Array(512)], 'new-product.webp', { type: 'image/webp' });

    await user.upload(input!, file);

    await waitFor(() => expect(completeMediaUpload).toHaveBeenCalledWith(mediaUploadIntent, 'test-session'));
    expect(createMediaUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'PRODUCT_IMAGE',
        resourceType: 'PRODUCT',
        resourceId: managedProduct.productId,
        contentType: 'image/webp',
        sizeBytes: 512,
      }),
      'test-session',
      walletAddress,
    );
    expect(providerFetch).toHaveBeenCalledWith(mediaUploadIntent.uploadUrl, expect.objectContaining({ method: 'PUT' }));
    expect(await screen.findByText(/请保存草稿以绑定到商品/)).toBeTruthy();
  });
});

describe('03 fulfillment center', () => {
  it('keeps delivery and pickup streams distinct and never lets the merchant complete receipt', async () => {
    const user = userEvent.setup();
    renderPage(<FulfillmentPage />);

    expect(screen.getByRole('columnheader', { name: '运单号' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /商家强制签收|直接完成订单/ })).toBeNull();
    expect(screen.getAllByText('商家会话不可用').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(screen.getByRole('columnheader', { name: '核销门店' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '完成时间' })).toBeTruthy();
  });

  it('reads merchant-scoped orders, target PII and finality-gated actions from Core', async () => {
    const blockedDeliveryOrder = {
      ...deliveryOrder,
      allowedActions: [{ action: 'RECORD_SHIPMENT' as const, enabled: false, reasonCode: 'FinalityPending' as const }],
    };
    const getOrderFulfillmentTarget = vi.fn(async () => deliveryTarget);
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [blockedDeliveryOrder, pickupOrder], nextCursor: null }),
      getOrderFulfillmentTarget,
    });
    const user = await enterFulfillment(client);

    await user.click(await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` }));

    expect(await screen.findByText('陈先生')).toBeTruthy();
    expect(screen.getByText('北京市东城区仓储路 24 号')).toBeTruthy();
    expect(screen.getAllByText('BNM_POINTS').length).toBeGreaterThan(0);
    expect(screen.getByText('FinalityPending')).toBeTruthy();
    expect(getOrderFulfillmentTarget).toHaveBeenCalledWith(deliveryOrderId, 'test-session');
    expect(screen.getAllByText('SECKILL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    expect(screen.getAllByText(deliveryOrder.paymentTxHash!).length).toBeGreaterThan(0);
  });

  it('serializes Core order filters and advances with the complete stable cursor', async () => {
    const nextCursor = { createdAt: deliveryOrder.createdAt, orderId: deliveryOrder.orderId };
    const listFulfillmentOrders = vi.fn(async () => ({ orders: [deliveryOrder], nextCursor }));
    const user = await enterFulfillment(createMockCoreApi({ listFulfillmentOrders }));
    await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` });

    expect(listFulfillmentOrders).toHaveBeenLastCalledWith('test-session', expect.objectContaining({
      limit: 100,
      fulfillmentMode: 'DELIVERY',
    }));
    await user.type(screen.getByLabelText('SKU 筛选'), 'sku-delivery');
    await user.selectOptions(screen.getByLabelText('订单状态'), 'DELIVERED');
    await user.selectOptions(screen.getByLabelText('订单类型'), 'SECKILL');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => expect(listFulfillmentOrders).toHaveBeenLastCalledWith('test-session', expect.objectContaining({
      skuId: 'sku-delivery',
      state: 'DELIVERED',
      orderKind: 'SECKILL',
      fulfillmentMode: 'DELIVERY',
    })));

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listFulfillmentOrders).toHaveBeenLastCalledWith('test-session', expect.objectContaining({
      cursor: nextCursor,
    })));
    expect(screen.getByText(/第 2 页/)).toBeTruthy();
  });

  it('downloads the Core Excel for the applied filters and current stable cursor', async () => {
    const nextCursor = { createdAt: deliveryOrder.createdAt, orderId: deliveryOrder.orderId };
    const listFulfillmentOrders = vi.fn(async () => ({ orders: [deliveryOrder], nextCursor }));
    const exportMerchantOrders = vi.fn(async (input: Parameters<CoreApi['exportMerchantOrders']>[0]) => ({
      ...merchantOrderExport,
      filters: {
        from: input.from!,
        to: input.to!,
        skuId: input.skuId ?? null,
        state: input.state ?? null,
        fulfillmentMode: input.fulfillmentMode ?? null,
        orderKind: input.orderKind ?? null,
        cursorCreatedAt: input.cursorCreatedAt ?? null,
        cursorOrderId: input.cursorOrderId ?? null,
        limit: input.limit ?? 1_000,
      },
    }));
    const createObjectUrl = vi.fn(() => 'blob:merchant-orders');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = await enterFulfillment(createMockCoreApi({ listFulfillmentOrders, exportMerchantOrders }));
    await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` });

    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-07-01T00:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-15T00:00' } });
    await user.type(screen.getByLabelText('SKU 筛选'), 'sku-delivery');
    await user.selectOptions(screen.getByLabelText('订单状态'), 'DELIVERED');
    await user.selectOptions(screen.getByLabelText('订单类型'), 'SECKILL');
    await user.click(screen.getByRole('button', { name: '应用筛选' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listFulfillmentOrders).toHaveBeenLastCalledWith(
      'test-session',
      expect.objectContaining({ cursor: nextCursor }),
    ));
    await user.click(screen.getByRole('button', { name: '导出 Excel' }));

    await waitFor(() => expect(exportMerchantOrders).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.any(String),
      to: expect.any(String),
      skuId: 'sku-delivery',
      state: 'DELIVERED',
      fulfillmentMode: 'DELIVERY',
      orderKind: 'SECKILL',
      cursorCreatedAt: nextCursor.createdAt,
      cursorOrderId: nextCursor.orderId,
      limit: 1_000,
      idempotencyKey: expect.stringMatching(/^merchant-order-export-/),
    }), 'test-session'));
    await screen.findByText('已下载 1 笔 Core 授权订单。');
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:merchant-orders');
  });

  it('shows export loading and empty states without creating a local file', async () => {
    let resolveExport!: (value: typeof merchantOrderExport) => void;
    const exportMerchantOrders = vi.fn(() => new Promise<typeof merchantOrderExport>((resolve) => {
      resolveExport = resolve;
    }));
    const createObjectUrl = vi.fn(() => 'blob:should-not-exist');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const user = await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [], nextCursor: null }),
      exportMerchantOrders,
    }));
    await screen.findByRole('button', { name: '导出 Excel' });

    await user.click(screen.getByRole('button', { name: '导出 Excel' }));
    expect((screen.getByRole('button', { name: '正在导出' }) as HTMLButtonElement).disabled).toBe(true);
    resolveExport({
      ...merchantOrderExport,
      rowCount: 0,
      filters: {
        ...merchantOrderExport.filters,
        skuId: null,
        state: null,
        fulfillmentMode: 'DELIVERY',
        orderKind: null,
      },
    });

    expect(await screen.findByText('当前筛选与页游标下没有可导出的订单。')).toBeTruthy();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('refuses an order export outside the authenticated merchant scope', async () => {
    const createObjectUrl = vi.fn(() => 'blob:should-not-exist');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const user = await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [deliveryOrder], nextCursor: null }),
      exportMerchantOrders: async () => ({
        ...merchantOrderExport,
        merchantId: 'merchant-other',
        filters: {
          ...merchantOrderExport.filters,
          skuId: null,
          state: null,
          fulfillmentMode: 'DELIVERY',
          orderKind: null,
        },
      }),
    }));
    await screen.findByRole('button', { name: '导出 Excel' });
    await user.click(screen.getByRole('button', { name: '导出 Excel' }));

    expect((await screen.findByRole('alert')).textContent).toContain('订单导出与当前商家会话不一致');
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('keeps export retries bound and surfaces explicit 403 and 409 failures', async () => {
    const exportMerchantOrders = vi.fn()
      .mockRejectedValueOnce(new CoreApiError('Forbidden', 'merchant export denied', undefined, undefined, 403))
      .mockRejectedValueOnce(new CoreApiError('UnknownState', 'order changed during export', undefined, undefined, 409));
    const user = await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [deliveryOrder], nextCursor: null }),
      exportMerchantOrders,
    }));
    await screen.findByRole('button', { name: '导出 Excel' });

    await user.click(screen.getByRole('button', { name: '导出 Excel' }));
    expect((await screen.findByRole('alert')).textContent).toContain('导出权限被拒绝（403）');
    await user.click(screen.getByRole('button', { name: '导出 Excel' }));
    expect((await screen.findByRole('alert')).textContent).toContain('导出状态已变化（409）');
    expect(exportMerchantOrders).toHaveBeenCalledTimes(2);
    expect(exportMerchantOrders.mock.calls[0]?.[0].idempotencyKey)
      .toBe(exportMerchantOrders.mock.calls[1]?.[0].idempotencyKey);
  });

  it('keeps batch shipment, electronic waybill and printer controls out of the launch UI', async () => {
    await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [deliveryOrder], nextCursor: null }),
    }));
    await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` });

    expect(screen.queryByText(/批量发货|电子面单|打印队列|打印机/)).toBeNull();
    expect(screen.queryByRole('button', { name: /批量|面单|打印/ })).toBeNull();
  });

  it('submits a platform-review request but never exposes direct merchant receipt completion', async () => {
    const requestForcedReceipt = vi.fn(createMockCoreApi().requestForcedReceipt);
    const createOrderActionEvidence = vi.fn(createMockCoreApi().createOrderActionEvidence);
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [deliveryOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => deliveryTarget,
      createOrderActionEvidence,
      requestForcedReceipt,
    });
    const user = await enterFulfillment(client);
    await user.click(await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` }));
    await screen.findByText('陈先生');

    await user.type(screen.getByLabelText('申请原因代码'), 'delivered_review');
    await user.click(screen.getByRole('button', { name: '申请平台审核' }));

    expect(await screen.findByText(/forced-receipt-result/)).toBeTruthy();
    expect(requestForcedReceipt).toHaveBeenCalledWith(
      deliveryOrderId,
      expect.objectContaining({
        evidenceHash: `0x${'f'.repeat(64)}`,
        reasonCode: 'DELIVERED_REVIEW',
        idempotencyKey: expect.stringMatching(/^merchant-forced-receipt-/),
      }),
      'test-session',
    );
    expect(createOrderActionEvidence).toHaveBeenCalledWith(deliveryOrderId, expect.objectContaining({
      action: 'REQUEST_FORCED_RECEIPT',
      reasonCode: 'DELIVERED_REVIEW',
      idempotencyKey: expect.stringMatching(/^merchant-forced-receipt-.+-evidence$/),
    }), 'test-session');
    expect(screen.queryByRole('button', { name: /商家强制签收|直接完成订单/ })).toBeNull();
  });

  it('reuses the shipment idempotency key after a typed Core failure and confirms only real success', async () => {
    const shippableOrder = {
      ...deliveryOrder,
      state: 'PAID' as const,
      shippedAt: null,
      deliveredAt: null,
      shipments: [],
      logistics: [],
      allowedActions: [{ action: 'RECORD_SHIPMENT' as const, enabled: true }],
    };
    const recordShipment = vi.fn()
      .mockRejectedValueOnce(new CoreApiError('NetworkUnavailable', '网络中断'))
      .mockResolvedValueOnce({
        orderId: deliveryOrderId,
        state: 'SHIPPED',
        shipmentId: 'shipment-retry-ok',
        carrierCode: 'SF',
        trackingNumberHash,
        recordedAt: '2026-07-14T12:00:00.000Z',
      });
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [shippableOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => deliveryTarget,
      createOrderTrackingEvidence: vi.fn(async () => takeoverTrackingEvidence),
      recordShipment,
    });
    const user = await enterFulfillment(client);
    await user.click(await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` }));
    await screen.findByText('陈先生');
    await user.selectOptions(screen.getByLabelText('快递公司'), 'SF');
    await user.type(screen.getByLabelText('运单号'), 'SF1234567890');

    await user.click(screen.getByRole('button', { name: '提交发货证据' }));
    expect((await screen.findByRole('alert')).textContent).toContain('网络中断');
    await user.click(screen.getByRole('button', { name: '提交发货证据' }));

    expect(await screen.findByText(/shipment-retry-ok/)).toBeTruthy();
    expect(recordShipment).toHaveBeenCalledTimes(2);
    expect(recordShipment.mock.calls[0]?.[1].idempotencyKey).toBe(recordShipment.mock.calls[1]?.[1].idempotencyKey);
  });

  it('binds pickup verification to the immutable store and reports the authoritative completion', async () => {
    const verifyPickup = vi.fn(createMockCoreApi().verifyPickup);
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [pickupOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => pickupTarget,
      verifyPickup,
    });
    const user = await enterFulfillment(client);
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    await user.click(await screen.findByRole('button', { name: `处理订单 ${pickupOrderId}` }));
    expect((await screen.findByDisplayValue(pickupTarget.storeId) as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: '启动相机扫码' }));
    expect((await screen.findByRole('alert')).textContent).toContain('请手工输入六位核销码');
    await user.type(screen.getByLabelText('六位核销码'), '123456');
    await user.type(screen.getByLabelText('门店核销证据哈希'), evidenceHash);
    await user.click(screen.getByRole('button', { name: '确认门店核销' }));

    expect(await screen.findByText(/2026-07-14T12:05:00.000Z/)).toBeTruthy();
    expect(verifyPickup).toHaveBeenCalledWith(
      pickupOrderId,
      expect.objectContaining({ code: '123456', evidenceHash, storeId: pickupTarget.storeId }),
      'test-session',
    );
  });

  it('reports denied camera permission while keeping the manual pickup path enabled', async () => {
    vi.stubGlobal('BarcodeDetector', class {
      async detect() { return []; }
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('permission denied', 'NotAllowedError');
        }),
      },
    });
    const user = await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [pickupOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => pickupTarget,
    }));
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    await user.click(await screen.findByRole('button', { name: `处理订单 ${pickupOrderId}` }));
    await user.click(screen.getByRole('button', { name: '启动相机扫码' }));

    expect((await screen.findByRole('alert')).textContent).toContain('相机权限被拒绝');
    expect((screen.getByLabelText('六位核销码') as HTMLInputElement).disabled).toBe(false);
  });

  it('fills an exact scanned six-digit code and submits it through the existing pickup contract', async () => {
    const stop = vi.fn();
    vi.stubGlobal('BarcodeDetector', class {
      async detect() { return [{ rawValue: '654321' }]; }
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const verifyPickup = vi.fn(createMockCoreApi().verifyPickup);
    const user = await enterFulfillment(createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [pickupOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => pickupTarget,
      verifyPickup,
    }));
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    await user.click(await screen.findByRole('button', { name: `处理订单 ${pickupOrderId}` }));
    await user.click(screen.getByRole('button', { name: '启动相机扫码' }));

    await waitFor(() => expect((screen.getByLabelText('六位核销码') as HTMLInputElement).value).toBe('654321'));
    expect(stop).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('门店核销证据哈希'), evidenceHash);
    await user.click(screen.getByRole('button', { name: '确认门店核销' }));
    await waitFor(() => expect(verifyPickup).toHaveBeenCalledWith(
      pickupOrderId,
      expect.objectContaining({ code: '654321', evidenceHash, storeId: pickupTarget.storeId }),
      'test-session',
    ));
  });

  it('keeps pickup inputs disabled when Core reports FinalityPending', async () => {
    const blockedPickupOrder = {
      ...pickupOrder,
      allowedActions: [{ action: 'VERIFY_PICKUP' as const, enabled: false, reasonCode: 'FinalityPending' as const }],
    };
    const verifyPickup = vi.fn(createMockCoreApi().verifyPickup);
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [blockedPickupOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => pickupTarget,
      verifyPickup,
    });
    const user = await enterFulfillment(client);
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    await user.click(await screen.findByRole('button', { name: `处理订单 ${pickupOrderId}` }));
    await screen.findByDisplayValue(pickupTarget.storeId);

    expect((screen.getByLabelText('六位核销码') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '确认门店核销' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('FinalityPending').length).toBeGreaterThan(0);
    expect(verifyPickup).not.toHaveBeenCalled();
  });

  it('contains wide tables inside their horizontal scroll region', () => {
    expect(styles).toMatch(/\.page-stack,\s*\.page-stack > \* \{\s*min-width: 0;/);
    expect(styles).toMatch(/\.table-wrap \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow-x: auto;/);
  });
});

describe('03b assigned takeover fulfillment', () => {
  it('reads the current assignment and encrypted target, then creates tracking evidence before shipment', async () => {
    const listMerchantTakeoverCases = vi.fn(async () => takeoverCaseList);
    const getMerchantTakeoverCase = vi.fn(async () => takeoverCaseDetail);
    const getOrderFulfillmentTarget = vi.fn(async () => deliveryTarget);
    const createOrderTrackingEvidence = vi.fn(async () => takeoverTrackingEvidence);
    const recordShipment = vi.fn(async () => ({
      orderId: deliveryOrderId,
      state: 'SHIPPED' as const,
      shipmentId: 'replacement-shipment-result',
      carrierCode: 'SF',
      trackingNumberHash,
      recordedAt: '2026-07-16T02:06:00.000Z',
    }));
    const user = await enterTakeovers(createMockCoreApi({
      listMerchantTakeoverCases,
      getMerchantTakeoverCase,
      getOrderFulfillmentTarget,
      createOrderTrackingEvidence,
      recordShipment,
    }));

    await user.click(await screen.findByRole('button', { name: '处理案件' }));
    expect(await screen.findByText(deliveryTarget.payload.address)).toBeTruthy();
    expect(screen.getByText(takeoverCaseDetail.case.currentAssignment!.evidenceHash)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认发货' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await user.type(screen.getByLabelText('物流单号'), 'SF-REPLACEMENT-001');
    await user.click(screen.getByRole('button', { name: '创建物流证据' }));
    expect(await screen.findByText('Core 已封存物流证据')).toBeTruthy();
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);

    expect(await screen.findByText('已发货：replacement-shipment-result')).toBeTruthy();
    expect(createOrderTrackingEvidence).toHaveBeenCalledWith(deliveryOrderId, expect.objectContaining({
      carrierCode: 'SF',
      trackingNumber: 'SF-REPLACEMENT-001',
      idempotencyKey: expect.stringMatching(/^merchant-takeover-tracking-/),
    }), 'test-session');
    expect(recordShipment).toHaveBeenCalledWith(deliveryOrderId, expect.objectContaining({
      carrierCode: 'SF',
      trackingNumberHash,
      evidenceHash: takeoverTrackingEvidence.evidenceHash,
      idempotencyKey: expect.stringMatching(/^merchant-takeover-shipment-/),
    }), 'test-session');
    expect(getOrderFulfillmentTarget).toHaveBeenCalledWith(deliveryOrderId, 'test-session');
    expect(listMerchantTakeoverCases).toHaveBeenCalledWith('test-session', expect.objectContaining({
      state: 'FUNDED',
      limit: 25,
    }));
  });

  it('fails closed for an unfunded case even when a malformed projection enables shipment', async () => {
    const unfundedDetail = {
      ...takeoverCaseDetail,
      case: { ...takeoverCaseDetail.case, state: 'OPEN' as const },
    };
    const createOrderTrackingEvidence = vi.fn(async () => takeoverTrackingEvidence);
    const user = await enterTakeovers(createMockCoreApi({
      listMerchantTakeoverCases: async () => ({
        ...takeoverCaseList,
        cases: [{ ...takeoverCaseList.cases[0]!, state: 'OPEN' }],
      }),
      getMerchantTakeoverCase: async () => unfundedDetail,
      getOrderFulfillmentTarget: async () => deliveryTarget,
      createOrderTrackingEvidence,
    }));

    await user.click(await screen.findByRole('button', { name: '处理案件' }));
    await screen.findByText(deliveryTarget.payload.address);
    expect((screen.getByLabelText('物流单号') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '创建物流证据' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/仅 `FUNDED`/)).toBeTruthy();
    expect(createOrderTrackingEvidence).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant queues and a case whose assignment was revoked before detail read', async () => {
    const getMerchantTakeoverCase = vi.fn(async () => takeoverCaseDetail);
    await enterTakeovers(createMockCoreApi({
      listMerchantTakeoverCases: async () => ({
        ...takeoverCaseList,
        cases: [{
          ...takeoverCaseList.cases[0]!,
          currentAssignment: {
            ...takeoverCaseList.cases[0]!.currentAssignment!,
            replacementMerchantId: 'merchant-other',
          },
        }],
      }),
      getMerchantTakeoverCase,
    }));

    expect((await screen.findByRole('alert')).textContent).toContain('接管案件与当前商家会话不一致');
    expect(screen.queryByRole('button', { name: '处理案件' })).toBeNull();
    expect(getMerchantTakeoverCase).not.toHaveBeenCalled();

    cleanup();
    const getOrderFulfillmentTarget = vi.fn(async () => deliveryTarget);
    const user = await enterTakeovers(createMockCoreApi({
      getMerchantTakeoverCase: async () => {
        throw new CoreApiError('Forbidden', 'Takeover case is outside the replacement merchant scope', undefined, undefined, 403);
      },
      getOrderFulfillmentTarget,
    }));
    await user.click(await screen.findByRole('button', { name: '处理案件' }));

    expect(await screen.findByText('案件读取被拒绝')).toBeTruthy();
    expect(screen.getByText(/outside the replacement merchant scope/)).toBeTruthy();
    expect(getOrderFulfillmentTarget).not.toHaveBeenCalled();
  });

  it('does not expose the address or shipment actions when target decryption is not configured', async () => {
    const createOrderTrackingEvidence = vi.fn(async () => takeoverTrackingEvidence);
    const user = await enterTakeovers(createMockCoreApi({
      getOrderFulfillmentTarget: async () => {
        throw new CoreApiError('ConfigurationRequired', 'Fulfillment target encryption key is unavailable');
      },
      createOrderTrackingEvidence,
    }));
    await user.click(await screen.findByRole('button', { name: '处理案件' }));

    expect(await screen.findByText('案件读取被拒绝')).toBeTruthy();
    expect(screen.queryByText(deliveryTarget.payload.address)).toBeNull();
    expect(screen.queryByRole('button', { name: '创建物流证据' })).toBeNull();
    expect(createOrderTrackingEvidence).not.toHaveBeenCalled();
  });
});

describe('04 store controls', () => {
  it('creates a manually located draft, binds a verified image, saves, activates and closes it by Core version', async () => {
    const storeImageUploadIntent: typeof mediaUploadIntent = {
      ...mediaUploadIntent,
      uploadIntentId: `0x${'3'.repeat(64)}`,
      purpose: 'STORE_IMAGE',
      resourceType: 'STORE',
      resourceId: 'store-created-1',
      uploadUrl: 'https://media.example.test/upload/store-image',
    };
    const storeImageAsset: typeof completedMediaAsset = {
      ...completedMediaAsset,
      assetId: `0x${'4'.repeat(64)}`,
      uploadIntentId: storeImageUploadIntent.uploadIntentId,
      purpose: 'STORE_IMAGE',
      resourceType: 'STORE',
      resourceId: 'store-created-1',
    };
    const storeImageReadAccess: typeof mediaReadAccess = {
      ...mediaReadAccess,
      assetId: storeImageAsset.assetId,
      purpose: 'STORE_IMAGE',
      resourceType: 'STORE',
      resourceId: 'store-created-1',
      accessScope: 'AUTHENTICATED',
      readUrl: 'https://media.example.test/read/store-image',
    };
    let stores: MerchantManagedStore[] = [managedMerchantStore];
    const listManagedMerchantStores = vi.fn(async () => stores);
    const createMerchantStore = vi.fn(async (input: Parameters<CoreApi['createMerchantStore']>[0]) => {
      const created: MerchantManagedStore = {
        ...managedMerchantStore,
        storeId: 'store-created-1',
        name: input.name,
        phone: input.phone,
        businessHours: input.businessHours,
        longitude: input.longitude,
        latitude: input.latitude,
        address: input.address!,
        regionCode: input.regionCode!,
        imageAssetIds: [],
        status: 'DRAFT',
        version: 1,
        allowedActions: [
          { action: 'UPDATE_PROFILE', enabled: true },
          { action: 'ACTIVATE', enabled: false, reasonCode: 'STORE_PROFILE_INCOMPLETE' },
          { action: 'CLOSE', enabled: true },
        ],
      };
      stores = [...stores, created];
      return created;
    });
    const updateMerchantStore = vi.fn(async (
      storeIdInput: string,
      input: Parameters<CoreApi['updateMerchantStore']>[1],
    ) => {
      const current = stores.find((store) => store.storeId === storeIdInput)!;
      const updated: MerchantManagedStore = {
        ...current,
        name: input.name,
        phone: input.phone,
        businessHours: input.businessHours,
        imageAssetIds: input.imageAssetIds,
        version: input.expectedVersion + 1,
        allowedActions: [
          { action: 'UPDATE_PROFILE', enabled: true },
          { action: 'ACTIVATE', enabled: true },
          { action: 'CLOSE', enabled: true },
        ],
      };
      stores = stores.map((store) => store.storeId === storeIdInput ? updated : store);
      return updated;
    });
    const activateMerchantStore = vi.fn(async (storeIdInput: string, input: Parameters<CoreApi['activateMerchantStore']>[1]) => {
      const current = stores.find((store) => store.storeId === storeIdInput)!;
      const activated: MerchantManagedStore = {
        ...current,
        status: 'ACTIVE',
        version: input.expectedVersion + 1,
        allowedActions: managedMerchantStore.allowedActions,
      };
      stores = stores.map((store) => store.storeId === storeIdInput ? activated : store);
      return activated;
    });
    const closeMerchantStore = vi.fn(async (storeIdInput: string, input: Parameters<CoreApi['closeMerchantStore']>[1]) => {
      const current = stores.find((store) => store.storeId === storeIdInput)!;
      const closed: MerchantManagedStore = {
        ...current,
        status: 'CLOSED',
        version: input.expectedVersion + 1,
        allowedActions: [
          { action: 'UPDATE_PROFILE', enabled: false, reasonCode: 'STORE_CLOSED' },
          { action: 'ACTIVATE', enabled: false, reasonCode: 'STORE_CLOSED' },
          { action: 'CLOSE', enabled: false, reasonCode: 'STORE_CLOSED' },
        ],
      };
      stores = stores.map((store) => store.storeId === storeIdInput ? closed : store);
      return closed;
    });
    const createMediaUploadIntent = vi.fn(async () => storeImageUploadIntent);
    const completeMediaUpload = vi.fn(async () => storeImageAsset);
    const getMediaReadAccess = vi.fn(async (
      assetId: string,
      _token: string,
      expected?: Parameters<CoreApi['getMediaReadAccess']>[2],
    ) => ({
      ...storeImageReadAccess,
      assetId,
      purpose: expected?.purpose ?? storeImageReadAccess.purpose,
      resourceType: expected?.resourceType ?? storeImageReadAccess.resourceType,
      resourceId: expected?.resourceId ?? storeImageReadAccess.resourceId,
    }));
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const { user } = await enterStores(createMockCoreApi({
      listManagedMerchantStores,
      createMerchantStore,
      updateMerchantStore,
      activateMerchantStore,
      closeMerchantStore,
      createMediaUploadIntent,
      completeMediaUpload,
      getMediaReadAccess,
    }));

    await user.click(await screen.findByRole('button', { name: '新增门店' }));
    const createForm = screen.getByRole('heading', { name: '新建门店草稿' }).closest('form')!;
    await user.type(within(createForm).getByLabelText('门店名称'), '浦东黄金店');
    await user.type(within(createForm).getByLabelText('服务电话'), '021-87654321');
    await user.type(within(createForm).getByLabelText('营业时间'), '10:00-20:00');
    await user.type(within(createForm).getByLabelText('省'), '上海市');
    await user.type(within(createForm).getByLabelText('市'), '上海市');
    await user.type(within(createForm).getByLabelText('区县'), '浦东新区');
    await user.type(within(createForm).getByLabelText('6 位行政区代码'), '310115');
    await user.type(within(createForm).getByLabelText('经度'), '121.506');
    await user.type(within(createForm).getByLabelText('纬度'), '31.245');
    await user.type(within(createForm).getByLabelText('详细地址'), '上海市浦东新区世纪大道 24 号');
    await user.click(within(createForm).getByRole('button', { name: '创建草稿' }));

    expect(await screen.findByDisplayValue('上海市浦东新区世纪大道 24 号')).toBeTruthy();
    expect(await screen.findByText(/门店草稿已创建/)).toBeTruthy();
    expect(createMerchantStore).toHaveBeenCalledWith(expect.objectContaining({
      name: '浦东黄金店',
      address: '上海市浦东新区世纪大道 24 号',
      province: '上海市',
      city: '上海市',
      district: '浦东新区',
      regionCode: '310115',
      longitude: 121.506,
      latitude: 31.245,
      idempotencyKey: expect.stringMatching(/^merchant-create-store-/),
    }), 'test-session');
    expect(screen.getByText(/门店位置已锁定/)).toBeTruthy();

    const imageInput = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    expect(imageInput).toBeTruthy();
    await user.upload(imageInput!, new File([new Uint8Array(512)], 'store.webp', { type: 'image/webp' }));
    await waitFor(() => expect(completeMediaUpload).toHaveBeenCalledWith(storeImageUploadIntent, 'test-session'));
    expect(createMediaUploadIntent).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'STORE_IMAGE',
      resourceType: 'STORE',
      resourceId: 'store-created-1',
      contentType: 'image/webp',
      sizeBytes: 512,
    }), 'test-session', walletAddress);
    expect(providerFetch).toHaveBeenCalledWith(storeImageUploadIntent.uploadUrl, expect.objectContaining({ method: 'PUT' }));

    await user.click(screen.getByRole('button', { name: '保存资料' }));
    expect(await screen.findByText(/门店资料已保存为版本 2/)).toBeTruthy();
    expect(updateMerchantStore).toHaveBeenCalledWith('store-created-1', expect.objectContaining({
      imageAssetIds: [storeImageAsset.assetId],
      expectedVersion: 1,
      idempotencyKey: expect.stringMatching(/^merchant-save-store-store-created-1-/),
    }), 'test-session');

    await user.click(screen.getByRole('button', { name: '激活门店' }));
    expect(await screen.findByText('营业中 · v3')).toBeTruthy();
    expect(activateMerchantStore).toHaveBeenCalledWith('store-created-1', expect.objectContaining({
      expectedVersion: 2,
      idempotencyKey: expect.stringMatching(/^merchant-activate-store-store-created-1-/),
    }), 'test-session');

    await user.click(screen.getByRole('button', { name: '关闭门店' }));
    await user.click(screen.getByRole('button', { name: '确认关闭' }));
    expect(await screen.findByText('已关闭 · v4')).toBeTruthy();
    expect(closeMerchantStore).toHaveBeenCalledWith('store-created-1', expect.objectContaining({
      expectedVersion: 3,
      idempotencyKey: expect.stringMatching(/^merchant-close-store-store-created-1-/),
    }), 'test-session');
  });

  it('requires the full manual location and stays fail closed when Core rejects creation', async () => {
    const createMerchantStore = vi.fn(async () => {
      throw new CoreApiError('ConfigurationRequired', '门店位置配置不可用');
    });
    const { user } = await enterStores(createMockCoreApi({ createMerchantStore }));

    await user.click(await screen.findByRole('button', { name: '新增门店' }));
    const createForm = screen.getByRole('heading', { name: '新建门店草稿' }).closest('form')!;
    const createButton = within(createForm).getByRole('button', { name: '创建草稿' }) as HTMLButtonElement;
    await user.type(within(createForm).getByLabelText('门店名称'), '浦东黄金店');
    await user.type(within(createForm).getByLabelText('服务电话'), '021-87654321');
    await user.type(within(createForm).getByLabelText('营业时间'), '10:00-20:00');
    await user.type(within(createForm).getByLabelText('省'), '上海市');
    await user.type(within(createForm).getByLabelText('市'), '上海市');
    await user.type(within(createForm).getByLabelText('区县'), '浦东新区');
    await user.type(within(createForm).getByLabelText('经度'), '121.506');
    await user.type(within(createForm).getByLabelText('纬度'), '31.245');
    await user.type(within(createForm).getByLabelText('详细地址'), '上海市浦东新区世纪大道 24 号');

    expect(createButton.disabled).toBe(true);
    await user.type(within(createForm).getByLabelText('6 位行政区代码'), '310115');
    expect(createButton.disabled).toBe(false);
    await user.click(createButton);

    expect((await within(createForm).findByRole('alert')).textContent).toMatch(/ConfigurationRequired/);
    expect(within(createForm).getByDisplayValue('上海市浦东新区世纪大道 24 号')).toBeTruthy();
    expect(screen.queryByText(/门店草稿已创建/)).toBeNull();
    expect(createMerchantStore).toHaveBeenCalledTimes(1);
  });

  it('refreshes after a version conflict and exposes permission failures without local success', async () => {
    const refreshedStore = { ...managedMerchantStore, version: 8 };
    const listManagedMerchantStores = vi.fn()
      .mockResolvedValueOnce([managedMerchantStore])
      .mockResolvedValue([refreshedStore]);
    const updateMerchantStore = vi.fn(async () => {
      throw new CoreApiError('UnknownState', '门店版本已变更', undefined, undefined, 409);
    });
    const { user } = await enterStores(createMockCoreApi({ listManagedMerchantStores, updateMerchantStore }));
    await user.click(await screen.findByRole('button', { name: '保存资料' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/409 状态或版本冲突/);
    expect(screen.getByText('营业中 · v8')).toBeTruthy();
    expect(listManagedMerchantStores).toHaveBeenCalledTimes(2);

    cleanup();
    const forbiddenUpdate = vi.fn(async () => {
      throw new CoreApiError('Forbidden', '无权修改该门店', undefined, undefined, 403);
    });
    const forbidden = await enterStores(createMockCoreApi({ updateMerchantStore: forbiddenUpdate }));
    await forbidden.user.click(await screen.findByRole('button', { name: '保存资料' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/403 无权执行/);
    expect(screen.queryByText(/门店资料已保存/)).toBeNull();
  });

  it('keeps the Phase 2 printer binding workflow out of the launch store page', async () => {
    const getMerchantPrinterBinding = vi.fn();
    const createMerchantPrinterBindingChallenge = vi.fn();
    const applyMerchantPrinterBinding = vi.fn();
    await enterStores(createMockCoreApi({
      getMerchantPrinterBinding,
      createMerchantPrinterBindingChallenge,
      applyMerchantPrinterBinding,
    }));
    expect(await screen.findByText(merchantStore.address)).toBeTruthy();
    const region = screen.getByLabelText('6 位行政区划代码') as HTMLInputElement;
    expect(region.disabled).toBe(true);
    expect(region.readOnly).toBe(true);
    expect(screen.queryByText(/核销云打印机|打印服务|Device ID/)).toBeNull();
    expect(screen.queryByRole('button', { name: '绑定设备' })).toBeNull();
    expect(getMerchantPrinterBinding).not.toHaveBeenCalled();
    expect(createMerchantPrinterBindingChallenge).not.toHaveBeenCalled();
    expect(applyMerchantPrinterBinding).not.toHaveBeenCalled();
  });
});

describe('05 asset rails', () => {
  it('renders Core five-state balances, EOA transfer finality, guarantee reorg and takeover debt without local netting', async () => {
    await enterAssets(createMockCoreApi());

    expect(await screen.findByRole('heading', { name: 'USDT 商家货款' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'NPL 收益子类' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 积分总额' })).toBeTruthy();
    expect(await screen.findByText('8000000000000000000000')).toBeTruthy();
    expect(screen.getByText(/2026-07-14T16:00:00.000Z 至 2026-07-15T16:00:00.000Z/)).toBeTruthy();
    expect(screen.getByLabelText('USDT 商家货款五状态余额')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '逐单应收账单' })).toBeTruthy();
    expect(screen.queryByText(/秒杀额外分成|DecisionBlocked/)).toBeNull();
    const nplRewards = screen.getByLabelText('NPL 奖励收益子类');
    for (const subtype of rewardSubtypes) expect(within(nplRewards).getByText(subtype)).toBeTruthy();
    expect(within(nplRewards).getByText('2108')).toBeTruthy();
    const bnmPoints = screen.getByLabelText('BNM Locked/Available 聚合');
    expect(within(bnmPoints).getByText('8800')).toBeTruthy();
    expect(within(bnmPoints).getByText('3600')).toBeTruthy();
    expect(screen.getByText(/BNM 是不可转移的后台积分/)).toBeTruthy();
    expect(within(bnmPoints).queryByRole('button')).toBeNull();
    expect(screen.getByText('45000000000000000000')).toBeTruthy();
    expect(screen.getAllByText(`0x${'7'.repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: new RegExp(`0x${'9'.repeat(64)}`) }).getAttribute('href'))
      .toBe(`https://bscscan.com/tx/0x${'9'.repeat(64)}`);
    expect(screen.getByText('REORGED')).toBeTruthy();
    expect(screen.getByText('15 / 15')).toBeTruthy();
    expect(screen.getByText('takeover-1')).toBeTruthy();
    expect(screen.getAllByText('200000000000000000000').length).toBeGreaterThan(0);
    expect(screen.queryByText(/CLAIM_MERCHANT_USDT|ClaimVault|PaymentEscrow/)).toBeNull();
  });

  it('renders authoritative per-order journals and loads the next stable cursor page', async () => {
    const listMerchantReceivableStatements = vi.fn(createMockCoreApi().listMerchantReceivableStatements);
    const { user } = await enterAssets(createMockCoreApi({ listMerchantReceivableStatements }));

    const firstOrderIds = await screen.findAllByText(merchantReceivableStatements.statements[0]!.orderId);
    expect(firstOrderIds.length).toBeGreaterThan(0);
    expect(screen.getByText('SECKILL')).toBeTruthy();
    expect(screen.getByText('ORDINARY')).toBeTruthy();
    const firstStatement = firstOrderIds[0]!.closest('details')!;
    await user.click(firstOrderIds[0]!);
    expect(within(firstStatement).getByText('冻结金额快照')).toBeTruthy();
    expect(within(firstStatement).getByText('平台技术服务费').parentElement?.textContent).toBe('平台技术服务费120');
    expect(within(firstStatement).getByText('Custody 商品 USDT').parentElement?.textContent).toBe('Custody 商品 USDT8280');
    expect(within(firstStatement).getAllByText('journal:a:lifecycle')).toHaveLength(2);
    expect(within(firstStatement).getByText('journal:a:requested')).toBeTruthy();
    expect(within(firstStatement).getByRole('link', { name: new RegExp(`0x${'b'.repeat(64)}`) }).getAttribute('href'))
      .toBe(`https://bscscan.com/tx/0x${'b'.repeat(64)}`);

    await user.click(screen.getByRole('button', { name: '加载下一页' }));
    expect((await screen.findAllByText(merchantReceivableStatementsNext.statements[0]!.orderId)).length)
      .toBeGreaterThan(0);
    expect(screen.getByText('FALLBACK_RETAIL')).toBeTruthy();
    expect(listMerchantReceivableStatements).toHaveBeenNthCalledWith(1, 'test-session', { limit: 20 });
    expect(listMerchantReceivableStatements).toHaveBeenNthCalledWith(2, 'test-session', {
      cursor: merchantReceivableStatements.nextCursor,
      limit: 20,
    });
    expect((screen.getByRole('button', { name: '加载下一页' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('fails closed on receivable authorization and tenant identity mismatch', async () => {
    await enterAssets(createMockCoreApi({
      listMerchantReceivableStatements: async () => {
        throw new CoreApiError('Unauthorized', '商家会话已失效。', 'corr-receivable-auth');
      },
    }));
    expect(await screen.findByText(/Unauthorized：商家会话已失效.*corr-receivable-auth/)).toBeTruthy();

    cleanup();
    await enterAssets(createMockCoreApi({
      listMerchantReceivableStatements: async () => ({
        ...merchantReceivableStatements,
        merchantId: 'merchant-other',
      }),
    }));
    expect(await screen.findByText('逐单应收投影与当前商家不一致。')).toBeTruthy();
    expect(screen.queryByText(merchantReceivableStatements.statements[0]!.orderId)).toBeNull();
  });

  it('creates the exact merchant settlement intent, signs Core EIP-712 data and submits the signed request', async () => {
    const createSettlementIntent = vi.fn(createMockCoreApi().createSettlementIntent);
    const submitSettlementRequest = vi.fn(createMockCoreApi().submitSettlementRequest);
    const { user, walletRequest } = await enterAssets(createMockCoreApi({
      createSettlementIntent,
      submitSettlementRequest,
    }));
    await screen.findByText('45000000000000000000');

    await user.type(screen.getByLabelText('申请金额（USDT 最小单位）'), '45000000000000000000');
    const submit = screen.getByRole('button', { name: '签名并提交结算申请' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);

    expect(await screen.findByText(/settlement-request-requested/)).toBeTruthy();
    expect(createSettlementIntent).toHaveBeenCalledWith({
      rail: 'MERCHANT_USDT',
      amount: '45000000000000000000',
      idempotencyKey: expect.stringMatching(/^merchant-settlement-intent-/),
    }, 'test-session');
    const typedDataCall = walletRequest.mock.calls.find(([request]) => request.method === 'eth_signTypedData_v4');
    expect(typedDataCall?.[0].params?.[0]).toBe(walletAddress);
    expect(JSON.parse(String(typedDataCall?.[0].params?.[1]))).toEqual(settlementIntent.typedData);
    expect(submitSettlementRequest).toHaveBeenCalledWith({
      intentId: settlementIntent.intent.intentId,
      signature: `0x${'12'.repeat(65)}`,
    }, 'test-session');
  });

  it('submits only the published guarantee evidence fields and keeps a frozen merchant fail closed', async () => {
    const submitGuaranteeDeposit = vi.fn(createMockCoreApi().submitGuaranteeDeposit);
    const { user } = await enterAssets(createMockCoreApi({ submitGuaranteeDeposit }));
    expect((await screen.findAllByText('1200000000000000000000')).length).toBeGreaterThan(0);
    const transactionHash = `0x${'0'.repeat(64)}`;

    await user.type(screen.getByLabelText('Policy version'), '9');
    await user.type(screen.getByLabelText('预期金额（USDT 最小单位）'), '1000000000000000000000');
    await user.type(screen.getByLabelText('BSC Transfer TxHash'), transactionHash);
    await user.click(screen.getByRole('button', { name: '提交保证金交易证据' }));

    expect(await screen.findByText(/guarantee-submitted/)).toBeTruthy();
    expect(submitGuaranteeDeposit).toHaveBeenCalledWith({
      policyVersion: '9',
      expectedAmountUsdt: '1000000000000000000000',
      transactionHash,
      idempotencyKey: expect.stringMatching(/^merchant-guarantee-deposit-/),
    }, 'test-session');

    cleanup();
    const frozenFinance = {
      ...merchantFinance,
      merchant: { ...merchantFinance.merchant, guarantee_status: 'FROZEN' as const },
      allowedActions: [],
      settlementEligibility: { mode: 'BLOCKED' as const, expiresAt: null },
    };
    const frozen = await enterAssets(createMockCoreApi({ getMerchantFinance: async () => frozenFinance }));
    expect((await screen.findAllByText(/APPROVED \/ FROZEN/)).length).toBeGreaterThan(0);
    await frozen.user.type(screen.getByLabelText('申请金额（USDT 最小单位）'), '1');
    expect((screen.getByRole('button', { name: '签名并提交结算申请' }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    const microtestFinance = {
      ...merchantFinance,
      merchant: { ...merchantFinance.merchant, guarantee_status: 'BELOW_MINIMUM' as const },
      allowedActions: ['REQUEST_MERCHANT_USDT' as const],
      settlementEligibility: {
        mode: 'MAINNET_MICROTEST' as const,
        expiresAt: '2026-07-20T12:00:00.000Z',
      },
    };
    const microtest = await enterAssets(createMockCoreApi({ getMerchantFinance: async () => microtestFinance }));
    expect(await screen.findByText('仅授权受控主网微测')).toBeTruthy();
    expect(screen.getAllByText(/BELOW_MINIMUM/).length).toBeGreaterThan(0);
    await microtest.user.type(screen.getByLabelText('申请金额（USDT 最小单位）'), '1');
    expect((screen.getByRole('button', { name: '签名并提交结算申请' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('06 audit and 07 rules', () => {
  it('loads tenant profile and audit, saves only editable fields and keeps settlement wallet read-only', async () => {
    const updateMerchantProfile = vi.fn(createMockCoreApi().updateMerchantProfile);
    const listMerchantAuditEntries = vi.fn(createMockCoreApi().listMerchantAuditEntries);
    const user = await enterSettings(createMockCoreApi({ updateMerchantProfile, listMerchantAuditEntries }));

    const name = await screen.findByLabelText('店铺名称') as HTMLInputElement;
    expect(name.value).toBe('阿步金店');
    expect(screen.getByText(merchantProfile.settlementWallet)).toBeTruthy();
    expect(screen.getByText('普通编辑不可更换')).toBeTruthy();
    expect(await screen.findByText('SettlementRequestAuthorized')).toBeTruthy();
    expect(screen.getByText(/PARTIAL_PRE_MERCHANT_SCOPE/)).toBeTruthy();
    expect(screen.getByText(/不代表全局链证明/)).toBeTruthy();
    expect(screen.getByText(/ExternalBlocked/)).toBeTruthy();

    await user.clear(name);
    await user.type(name, '阿步新金店');
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    await waitFor(() => expect(updateMerchantProfile).toHaveBeenCalledWith({
      shopName: '阿步新金店',
      logoAssetId: merchantProfile.logoAssetId,
      expectedVersion: 3,
      idempotencyKey: expect.stringMatching(/^merchant-profile-/),
    }, 'test-session'));
    expect(updateMerchantProfile.mock.calls[0]?.[0]).not.toHaveProperty('settlementWallet');
    expect(await screen.findByText(/已保存为版本 4/)).toBeTruthy();
    expect(listMerchantAuditEntries).toHaveBeenCalledWith('test-session', { limit: 50 });
  });

  it('surfaces a concurrent 409 and requires an explicit refresh before another versioned save', async () => {
    const updateMerchantProfile = vi.fn(async () => {
      throw new CoreApiError('UnknownState', 'Merchant profile version changed', undefined, undefined, 409);
    });
    const getMerchantProfile = vi.fn(async () => merchantProfile);
    const user = await enterSettings(createMockCoreApi({ getMerchantProfile, updateMerchantProfile }));
    const name = await screen.findByLabelText('店铺名称');
    await user.clear(name);
    await user.type(name, '并发版本店铺');
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    expect((await screen.findByRole('alert')).textContent).toContain('资料已被其他会话更新');
    expect(getMerchantProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '刷新店铺资料' })).toBeTruthy();
  });

  it('rejects a profile response or audit projection that crosses the current merchant scope', async () => {
    const user = await enterSettings(createMockCoreApi({
      updateMerchantProfile: async (input) => ({
        ...merchantProfile,
        shopName: input.shopName,
        logoAssetId: input.logoAssetId,
        settlementWallet: '0x2222222222222222222222222222222222222222',
        version: 4,
      }),
      listMerchantAuditEntries: async () => ({
        ...merchantAudit,
        chainProof: { merchantId: 'merchant-other', entries: 2 },
      }),
    }));

    expect(await screen.findByText('审计日志加载失败')).toBeTruthy();
    expect(screen.getByText(/审计日志与当前商家会话不一致/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('起始时间'), { target: { value: '2026-07-01T00:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-02T00:00' } });
    expect((screen.getByRole('button', { name: '导出 CSV' }) as HTMLButtonElement).disabled).toBe(true);

    const name = screen.getByLabelText('店铺名称');
    await user.clear(name);
    await user.type(name, '范围校验店铺');
    await user.click(screen.getByRole('button', { name: '保存资料' }));
    expect((await screen.findByRole('alert')).textContent).toContain('保存结果与当前商家资料快照不一致');
  });

  it('rejects the initial profile when it does not belong to the SIWE merchant tenant', async () => {
    await enterSettings(createMockCoreApi({
      getMerchantProfile: async () => ({ ...merchantProfile, merchantId: 'merchant-other' }),
    }));

    expect(await screen.findByText('店铺资料不可用')).toBeTruthy();
    expect(screen.getAllByText(/店铺资料与当前商家会话不一致/)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '保存资料' })).toBeNull();
  });

  it('uploads a provider-sealed merchant logo and binds its verified asset on profile save', async () => {
    const {
      merchantLogoAsset,
      merchantLogoReadAccess,
      merchantLogoUploadIntent,
    } = await import('./account-fixtures');
    const createMediaUploadIntent = vi.fn(async () => merchantLogoUploadIntent);
    const completeMediaUpload = vi.fn(async () => merchantLogoAsset);
    const getMediaReadAccess = vi.fn(async () => merchantLogoReadAccess);
    const updateMerchantProfile = vi.fn(createMockCoreApi().updateMerchantProfile);
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const user = await enterSettings(createMockCoreApi({
      createMediaUploadIntent,
      completeMediaUpload,
      getMediaReadAccess,
      updateMerchantProfile,
    }));

    await user.upload(
      screen.getByLabelText('上传 Logo'),
      new File([new Uint8Array([1, 2, 3, 4])], 'logo.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(completeMediaUpload).toHaveBeenCalledWith(merchantLogoUploadIntent, 'test-session'));
    expect(createMediaUploadIntent).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'MERCHANT_LOGO',
      resourceType: 'MERCHANT',
      resourceId: merchantProfile.merchantId,
      contentType: 'image/png',
    }), 'test-session', walletAddress);
    expect(providerFetch).toHaveBeenCalledWith(merchantLogoUploadIntent.uploadUrl, expect.objectContaining({ method: 'PUT' }));
    expect(await screen.findByText(/已完成存储封存/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '保存资料' }));
    await waitFor(() => expect(updateMerchantProfile).toHaveBeenCalledWith(expect.objectContaining({
      logoAssetId: merchantLogoAsset.assetId,
    }), 'test-session'));
  });

  it('fails closed when the merchant logo provider is not configured', async () => {
    const user = await enterSettings(createMockCoreApi({
      createMediaUploadIntent: async () => {
        throw new CoreApiError('ConfigurationRequired', 'media provider is not configured');
      },
    }));
    await user.upload(
      screen.getByLabelText('上传 Logo'),
      new File([new Uint8Array([1, 2, 3, 4])], 'logo.png', { type: 'image/png' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('ConfigurationRequired');
  });

  it('downloads the exact bounded CSV returned by Core with the active filters', async () => {
    const exportMerchantAuditEntries = vi.fn(async () => merchantAuditExport);
    const createObjectUrl = vi.fn(() => 'blob:merchant-audit');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = await enterSettings(createMockCoreApi({ exportMerchantAuditEntries }));

    fireEvent.change(screen.getByLabelText('起始时间'), { target: { value: '2026-07-01T00:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-15T00:00' } });
    await user.selectOptions(screen.getByLabelText('日志流'), 'financial');
    await user.type(screen.getByLabelText('操作类型'), 'SettlementRequestAuthorized');
    await user.type(screen.getByLabelText('影响模块'), 'SETTLEMENT_REQUEST');
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() => expect(exportMerchantAuditEntries).toHaveBeenCalledWith(expect.objectContaining({
      from: expect.any(String),
      to: expect.any(String),
      streamName: 'financial',
      eventType: 'SettlementRequestAuthorized',
      resourceType: 'SETTLEMENT_REQUEST',
      idempotencyKey: expect.stringMatching(/^merchant-audit-export-/),
    }), 'test-session'));
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:merchant-audit');
    expect(await screen.findByText(/已下载 2 条/)).toBeTruthy();
  });

  it('refuses an audit export response from a different merchant tenant', async () => {
    const createObjectUrl = vi.fn(() => 'blob:merchant-audit');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const user = await enterSettings(createMockCoreApi({
      exportMerchantAuditEntries: async () => ({ ...merchantAuditExport, merchantId: 'merchant-other' }),
    }));
    fireEvent.change(screen.getByLabelText('起始时间'), { target: { value: '2026-07-01T00:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-02T00:00' } });
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));

    expect((await screen.findByRole('alert')).textContent).toContain('审计导出与当前商家会话不一致');
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('handles empty exports and audit permission failures without simulating content', async () => {
    const user = await enterSettings(createMockCoreApi({
      exportMerchantAuditEntries: async () => ({ ...merchantAuditExport, entryCount: 0, csv: 'operationTime,operationType\n' }),
    }));
    fireEvent.change(screen.getByLabelText('起始时间'), { target: { value: '2026-07-01T00:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-02T00:00' } });
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByText(/没有可导出/)).toBeTruthy();

    cleanup();
    await enterSettings(createMockCoreApi({
      listMerchantAuditEntries: async () => {
        throw new CoreApiError('Forbidden', 'merchant audit scope denied');
      },
    }));
    expect(await screen.findByText('审计日志加载失败')).toBeTruthy();
    expect(screen.getByText(/merchant audit scope denied/)).toBeTruthy();
  });

  it('shows published versioned policy content and the frozen merchant boundaries', async () => {
    const listPublicCms = vi.fn(async () => [cmsRules]);
    const user = userEvent.setup();
    installWallet();
    render(<MemoryRouter><App client={createMockCoreApi({ listPublicCms })} /></MemoryRouter>);
    const connect = screen.getByRole('button', { name: '连接钱包' });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    await user.click(connect);
    const navigation = await screen.findByRole('navigation', { name: '商家工作台导航' });
    await user.click(within(navigation).getByRole('link', { name: /帮助中心/ }));

    expect(await screen.findByRole('heading', { name: '秒杀履约与结算' })).toBeTruthy();
    expect(listPublicCms).toHaveBeenCalledWith('test-session');
    expect(screen.getByText('Policy 8')).toBeTruthy();
    expect(screen.getByText(/Locked 进入 Available/)).toBeTruthy();
    expect(screen.getByText(/1% USDT 进入技术服务费钱包/)).toBeTruthy();
    expect(screen.getByText(/商家不获得额外秒杀收益/)).toBeTruthy();
    expect(screen.getByText(/创世节点 2% NPL 不使用 NFT/)).toBeTruthy();
    expect(screen.getByText(/人工只审核有效性且不得更换获奖人/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '7 天未发货进入平台接管' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '商家不能直接确认签收' })).toBeTruthy();
    expect(screen.getByText(/保证金 → 冻结应收 → 未来货款/)).toBeTruthy();
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
    expect(await screen.findByText('三批 Core 能力已连接')).toBeTruthy();
  });
});

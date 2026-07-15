import { readFileSync } from 'node:fs';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactVersion, rewardSubtypes, type CatalogProduct, type ManagedCatalogProduct } from '@abu24k/core-artifacts';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { CoreApiError, type CoreApi, type CoreBootstrap } from '../src/core-api';
import { coreBoundary, canExecuteOrderAction } from '../src/core-boundary';
import { CoreRuntimeProvider } from '../src/core-runtime';
import { AssetsPage } from '../src/pages/AssetsPage';
import { FulfillmentPage } from '../src/pages/FulfillmentPage';
import { HelpPage } from '../src/pages/HelpPage';
import { LoginPage } from '../src/pages/LoginPage';
import { ProductPage } from '../src/pages/ProductPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { StoresPage } from '../src/pages/StoresPage';
import { merchantBusinessDashboard } from './business-dashboard-fixtures';
import {
  deliveryOrder,
  deliveryOrderId,
  deliveryTarget,
  evidenceHash,
  pickupOrder,
  pickupOrderId,
  pickupTarget,
  trackingNumberHash,
} from './fulfillment-fixtures';
import {
  cmsRules,
  guaranteeDepositResult,
  merchantFinance,
  requestedSettlement,
  settlementIntent,
  settlementList,
} from './settlement-fixtures';
import {
  catalogCategories,
  catalogTags,
  completedMediaAsset,
  concessionPreview,
  managedProduct,
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

afterEach(() => {
  vi.restoreAllMocks();
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
    providers: {},
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
    verifySiwe: async () => ({ token: 'test-session', walletAddress, roles: ['MERCHANT'] }),
    listCatalog: async () => [catalogProduct],
    listCatalogCategories: async () => catalogCategories,
    listCatalogTags: async () => catalogTags,
    listMerchantStores: async () => [merchantStore],
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
    listFulfillmentOrders: async () => ({ orders: [], nextCursor: null }),
    getMerchantBusinessDashboard: async () => merchantBusinessDashboard,
    getOrderFulfillmentTarget: async () => deliveryTarget,
    getOrderAllowedActions: async () => [{
      action: 'RECORD_SHIPMENT',
      enabled: false,
      reasonCode: 'ConfigurationRequired',
    }],
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

describe('00 wallet gateway', () => {
  it('consumes settlement-admin.6 and requires a server-authoritative order-action grant', () => {
    expect(artifactVersion).toBe('2.0.0-settlement-admin.6');
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
    expect((screen.getByLabelText('商家基础应收（USDT 原子值）') as HTMLInputElement).value).toBe('600');
    expect((screen.getByLabelText('总库存') as HTMLInputElement).value).toBe('20');
    expect(screen.getByText(/product-history-1/)).toBeTruthy();
    expect(screen.getByAltText('商品主图 1')).toBeTruthy();
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
          merchantBaseReceivableUsdt: '600',
          stockTotal: 20,
          proposedSeckillInventory: 10,
        })],
        idempotencyKey: expect.stringMatching(/^save-product-store-1-/),
      }),
      'test-session',
    );

    await user.click(screen.getByRole('button', { name: '生成签名预览' }));
    expect(await screen.findByRole('heading', { name: '商家让利预览' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '450' })).toBeTruthy();
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

    expect(screen.getByRole('columnheader', { name: '物流单号哈希' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /商家强制签收|直接完成订单/ })).toBeNull();
    expect(screen.getByText('商家会话不可用')).toBeTruthy();

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

  it('submits authorized rows as one atomic shipment batch and keeps every idempotency key on retry', async () => {
    const secondOrderId = `0x${'a'.repeat(64)}`;
    const shippableOrders = [deliveryOrder, { ...deliveryOrder, orderId: secondOrderId, skuId: 'sku-second' }]
      .map((order) => ({
        ...order,
        state: 'PAID' as const,
        shippedAt: null,
        deliveredAt: null,
        shipments: [],
        logistics: [],
        allowedActions: [{ action: 'RECORD_SHIPMENT' as const, enabled: true }],
      }));
    const recordShipmentBatch = vi.fn()
      .mockRejectedValueOnce(new CoreApiError('NetworkUnavailable', '批量网络中断'))
      .mockResolvedValueOnce({
        batchId: `0x${'8'.repeat(64)}`,
        shipments: shippableOrders.map((order) => ({
          orderId: order.orderId,
          state: 'SHIPPED' as const,
          shipmentId: `shipment-${order.skuId}`,
          carrierCode: 'SF',
          trackingNumberHash,
          recordedAt: '2026-07-14T12:00:00.000Z',
        })),
        createdAt: '2026-07-14T12:00:00.000Z',
      });
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: shippableOrders, nextCursor: null }),
      recordShipmentBatch,
    });
    const user = await enterFulfillment(client);

    for (const order of shippableOrders) {
      await user.click(await screen.findByLabelText(`选择批量发货 ${order.orderId}`));
      await user.type(screen.getByLabelText(`批量物流单号哈希 ${order.orderId}`), trackingNumberHash);
      await user.type(screen.getByLabelText(`批量发货证据哈希 ${order.orderId}`), evidenceHash);
    }
    await user.selectOptions(screen.getByLabelText(`批量承运商 ${secondOrderId}`), 'JD');
    await user.click(screen.getByRole('button', { name: '原子提交批量发货' }));
    expect((await screen.findByRole('alert')).textContent).toContain('批量网络中断');
    await user.click(screen.getByRole('button', { name: '原子提交批量发货' }));

    expect(await screen.findByText(/批量发货已原子确认/)).toBeTruthy();
    expect(recordShipmentBatch).toHaveBeenCalledTimes(2);
    expect(recordShipmentBatch.mock.calls[0]?.[0]).toEqual(recordShipmentBatch.mock.calls[1]?.[0]);
    expect(recordShipmentBatch.mock.calls[1]?.[0].items.map((item: { carrierCode: string }) => item.carrierCode))
      .toEqual(['SF', 'JD']);
  });

  it('submits a platform-review request but never exposes direct merchant receipt completion', async () => {
    const requestForcedReceipt = vi.fn(createMockCoreApi().requestForcedReceipt);
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [deliveryOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => deliveryTarget,
      requestForcedReceipt,
    });
    const user = await enterFulfillment(client);
    await user.click(await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` }));
    await screen.findByText('陈先生');

    await user.type(screen.getByLabelText('申请原因代码'), 'delivered_review');
    await user.type(screen.getByLabelText('签收证据哈希'), evidenceHash);
    await user.click(screen.getByRole('button', { name: '申请平台审核' }));

    expect(await screen.findByText(/forced-receipt-result/)).toBeTruthy();
    expect(requestForcedReceipt).toHaveBeenCalledWith(
      deliveryOrderId,
      expect.objectContaining({
        evidenceHash,
        reasonCode: 'DELIVERED_REVIEW',
        idempotencyKey: expect.stringMatching(/^merchant-forced-receipt-/),
      }),
      'test-session',
    );
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
        carrierCode: 'SF_EXPRESS',
        trackingNumberHash,
        recordedAt: '2026-07-14T12:00:00.000Z',
      });
    const client = createMockCoreApi({
      listFulfillmentOrders: async () => ({ orders: [shippableOrder], nextCursor: null }),
      getOrderFulfillmentTarget: async () => deliveryTarget,
      recordShipment,
    });
    const user = await enterFulfillment(client);
    await user.click(await screen.findByRole('button', { name: `处理订单 ${deliveryOrderId}` }));
    await screen.findByText('陈先生');
    await user.type(screen.getByLabelText('承运商代码'), 'sf_express');
    await user.type(screen.getByLabelText('物流单号哈希'), trackingNumberHash);
    await user.type(screen.getByLabelText('发货证据哈希'), evidenceHash);

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
  it('renders Core five-state balances, Safe finality, guarantee reorg and takeover debt without local netting', async () => {
    await enterAssets(createMockCoreApi());

    expect(await screen.findByRole('heading', { name: 'USDT 商家货款' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'NPL 收益子类' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 积分总额' })).toBeTruthy();
    expect(await screen.findByText('8000000000000000000000')).toBeTruthy();
    expect(screen.getByText(/2026-07-14T16:00:00.000Z 至 2026-07-15T16:00:00.000Z/)).toBeTruthy();
    expect(screen.getByLabelText('USDT 商家货款五状态余额')).toBeTruthy();
    const nplRewards = screen.getByLabelText('NPL 奖励收益子类');
    for (const subtype of rewardSubtypes) expect(within(nplRewards).getByText(subtype)).toBeTruthy();
    expect(within(nplRewards).getByText('2108')).toBeTruthy();
    const bnmPoints = screen.getByLabelText('BNM Locked/Available 聚合');
    expect(within(bnmPoints).getByText('8800')).toBeTruthy();
    expect(within(bnmPoints).getByText('3600')).toBeTruthy();
    expect(screen.getByText(/BNM 是不可转移的后台积分/)).toBeTruthy();
    expect(within(bnmPoints).queryByRole('button')).toBeNull();
    expect(screen.getByText('45000000000000000000')).toBeTruthy();
    expect(screen.getByText('safe-batch-7')).toBeTruthy();
    expect(screen.getByRole('link', { name: new RegExp(`0x${'9'.repeat(64)}`) }).getAttribute('href'))
      .toBe(`https://bscscan.com/tx/0x${'9'.repeat(64)}`);
    expect(screen.getByText('REORGED')).toBeTruthy();
    expect(screen.getByText('15 / 15')).toBeTruthy();
    expect(screen.getByText('takeover-1')).toBeTruthy();
    expect(screen.getAllByText('200000000000000000000').length).toBeGreaterThan(0);
    expect(screen.queryByText(/CLAIM_MERCHANT_USDT|ClaimVault|PaymentEscrow/)).toBeNull();
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
    };
    const frozen = await enterAssets(createMockCoreApi({ getMerchantFinance: async () => frozenFinance }));
    expect((await screen.findAllByText(/APPROVED \/ FROZEN/)).length).toBeGreaterThan(0);
    await frozen.user.type(screen.getByLabelText('申请金额（USDT 最小单位）'), '1');
    expect((screen.getByRole('button', { name: '签名并提交结算申请' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('06 audit and 07 rules', () => {
  it('keeps settlement wallet immutable and audit history unavailable', () => {
    renderPage(<SettingsPage />);

    expect(screen.getByText('普通编辑不可更换')).toBeTruthy();
    expect((screen.getByRole('button', { name: '申请治理迁移' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('审计日志不可用')).toBeTruthy();
  });

  it('shows published versioned policy content and the frozen merchant boundaries', async () => {
    renderPage(<HelpPage />);

    expect(await screen.findByRole('heading', { name: '秒杀履约与结算' })).toBeTruthy();
    expect(screen.getByText('Policy 8')).toBeTruthy();
    expect(screen.getByText(/Locked 进入 Available/)).toBeTruthy();
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

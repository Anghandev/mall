import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  allowedActionNames,
  artifactVersion,
  chainIdentity,
  executableOrderActionNames,
  type NotificationInboxItem,
  type PaymentQuoteResponse,
} from '@abu24k/core-artifacts';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { MallApp, mallRuntimeBoundary } from '../src/App';
import { isCoreOrderActionExecutable, productBaseline } from '../src/bootstrap';
import { CoreClientError, type CoreClient, type CorePaymentAvailability } from '../src/core-client';
import { MallRuntimeProvider, useMallRuntime, validateSupportUrl, type MallServices, type PendingSubmission } from '../src/mall-runtime';
import type { WalletGateway } from '../src/wallet';
import { catalogCategories, catalogTags, publicMediaAccess } from './catalog-fixtures';
import {
  authenticatedAvatarAccess,
  avatarAssetId,
  avatarContentHash,
  avatarUploadIntent,
  buyerOverview,
  buyerProfile,
  buyerSavedAddress,
  buyerTakeoverTimeline,
  parsedBuyerAddress,
  verifiedAvatarAsset,
} from './account-fixtures';
import {
  buyerActionResult,
  evidenceAssetId,
  evidenceFileHash,
  mediaUploadIntent,
  orderActionEvidence,
  orderEvidenceHash,
  verifiedEvidenceAsset,
} from './evidence-fixtures';
import {
  deliveryActions,
  deliveryOrder,
  deliveryOrderTarget,
  deliveryTarget,
  pickupTarget,
  store,
  storeImageAssetIds,
} from './fulfillment-fixtures';
import { paymentQuote, product, seckillQuote } from './payment-fixtures';
import {
  approvedPrizeSettlement,
  relayEvent,
  reviewPendingPrizeSettlement,
  rolledOverPrizeSettlement,
  seckillCandidateOrderId,
  seckillGovernanceActionId,
  seckillPrizeExecutionTxHash,
  seckillPublicationTxHash,
  seckillRulesContentHash,
  seckillSession,
  seckillSessionId,
} from './seckill-fixtures';
import {
  finalExecutionTxHash,
  notificationItem,
  prizeSettlementIntent,
  publicCmsItem,
  requestedSettlement,
  settlementIntent,
  settlementProjection,
  settlementTransferId,
} from './settlement-fixtures';
import {
  firstShoppingStatementPage,
  fallbackShoppingStatement,
  ordinaryShoppingStatement,
  secondShoppingStatementPage,
} from './shopping-statement-fixtures';

function renderAt(path = '/seckill', services = offlineServices()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MallApp services={services} />
    </MemoryRouter>,
  );
}

function NotificationConnectionProbe() {
  const runtime = useMallRuntime();
  return (
    <div>
      <button type="button" onClick={() => void runtime.connectWallet()}>连接测试钱包</button>
      <button type="button" onClick={() => void runtime.reloadNotifications()}>刷新测试通知</button>
      <span data-testid="notification-state">{runtime.notificationsState}</span>
      {runtime.notifications.map((item) => <span key={item.messageId}>{item.messageId}</span>)}
    </div>
  );
}

describe('Mall V2 payment consumer', () => {
  it('consumes the current coordinated Core checkpoint and keeps payment writes fail closed', async () => {
    renderAt('/mall');

    expect(screen.getByRole('link', { name: '24K商城首页' })).toBeTruthy();
    expect(screen.getByText('24K商城', { selector: '.brand strong' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/阿步|Abu 24K|ABU 24K/);
    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-fulfillment-launch.28');
    expect(productBaseline.manifestsAligned).toBe(true);
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toContain('CONFIRM_RECEIPT');
    expect(executableOrderActionNames).toContain('PAY_ORDER');
    expect(isCoreOrderActionExecutable('CONFIRM_RECEIPT')).toBe(true);
    expect(isCoreOrderActionExecutable('PAY_ORDER')).toBe(true);
    expect(mallRuntimeBoundary).toMatchObject({
      artifactStatus: '2.0.0-fulfillment-launch.28',
      executableOrderActions: executableOrderActionNames,
      deploymentAuthorized: false,
      settlementAdminCapabilities: {
        settlements: true,
        cms: true,
        notifications: true,
        seckillSessions: true,
        websocket: true,
      },
      sharedInterface: '@abu24k/core-artifacts',
    });
    await waitFor(() => expect(screen.getByText('暂无可售商品')).toBeTruthy());
  });

  it('renders public taxonomy and short-lived Core media without constructing provider URLs', async () => {
    const user = userEvent.setup();
    const createPublicMediaReadAccess = vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId)));
    const services = readyServices({ createPublicMediaReadAccess });
    renderAt('/mall', services);

    expect(await screen.findByRole('heading', { name: product.title })).toBeTruthy();
    expect(screen.getByText('鞋履')).toBeTruthy();
    expect(screen.getByText('运动鞋')).toBeTruthy();
    expect(screen.getByText('黑金', { selector: '.taxonomy-strip span' })).toBeTruthy();
    expect(screen.getByText(product.subtitle)).toBeTruthy();
    expect(screen.getByText(/USDT 原子单位/)).toBeTruthy();
    expect(screen.getByText(/秒杀进行中/)).toBeTruthy();
    const productImage = await screen.findByRole('img', { name: product.title });
    expect(productImage.getAttribute('src')).toBe(publicMediaAccess(product.mainImageAssetIds[0]!).readUrl);
    expect(createPublicMediaReadAccess).toHaveBeenCalledWith(product.mainImageAssetIds[0]!.toLowerCase());
    expect(document.body.textContent).not.toMatch(/CDN|OSS|分类稍后批次发布/);

    await user.click(screen.getByRole('link', { name: `查看 ${product.title} 商品详情` }));
    expect(screen.getByRole('heading', { name: '商品详情' })).toBeTruthy();
    expect(screen.getByText('黑金鞋面，轻量缓震结构。')).toBeTruthy();
    expect(screen.getByText(/41码 \/ 秒杀黑金/)).toBeTruthy();
    expect(screen.getByText(/普通结算禁用/)).toBeTruthy();
    const productVideo = await screen.findByLabelText(`${product.title} 商品视频`);
    expect(productVideo.tagName).toBe('VIDEO');
    expect(productVideo.getAttribute('src')).toBe(publicMediaAccess(product.videoAssetId!).readUrl);
    expect(createPublicMediaReadAccess).toHaveBeenCalledWith(product.videoAssetId!.toLowerCase());
  });

  it('filters products only by the published category and tag associations', async () => {
    const user = userEvent.setup();
    const uncategorized = {
      ...product,
      productId: 'product-uncategorized',
      chainProductId: `0x${'d'.repeat(64)}`,
      title: '未分类商品',
      subtitle: '',
      mainImageAssetIds: [],
      videoAssetId: null,
      categoryId: null,
      tagIds: [],
      skus: [{ ...product.skus[0]!, skuId: 'sku-uncategorized', chainSkuId: `0x${'7'.repeat(64)}` }],
    };
    renderAt('/mall', readyServices({ listCatalog: vi.fn().mockResolvedValue([product, uncategorized]) }));

    expect(await screen.findByRole('heading', { name: '未分类商品' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '运动鞋' }));
    expect(screen.getByRole('heading', { name: product.title })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '未分类商品' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '黑金' }));
    expect(screen.getByRole('heading', { name: product.title })).toBeTruthy();
  });

  it('fails media closed when the signed read target is bound to another product', async () => {
    const mismatched = {
      ...publicMediaAccess(product.mainImageAssetIds[0]!),
      resourceId: 'another-product',
    };
    renderAt('/mall', readyServices({
      createPublicMediaReadAccess: vi.fn((assetId: string) => Promise.resolve(
        assetId === product.mainImageAssetIds[0] ? mismatched : publicMediaAccess(assetId),
      )),
    }));

    expect(await screen.findByRole('button', { name: '重新加载图片' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: product.title })).toBeNull();
  });

  it('rejects a product video read target with an image purpose and content type', async () => {
    const user = userEvent.setup();
    renderAt('/mall', readyServices({
      createPublicMediaReadAccess: vi.fn((assetId: string) => {
        const access = publicMediaAccess(assetId);
        return Promise.resolve(assetId === product.videoAssetId
          ? { ...access, purpose: 'PRODUCT_IMAGE' as const, contentType: 'image/webp' as const }
          : access);
      }),
    }));

    await user.click(await screen.findByRole('link', { name: `查看 ${product.title} 商品详情` }));
    expect(await screen.findByRole('button', { name: '重新加载视频' })).toBeTruthy();
    expect(screen.queryByLabelText(`${product.title} 商品视频`)).toBeNull();
  });

  it('keeps all four primary tabs reachable and preserves the existing shell', async () => {
    const user = userEvent.setup();
    renderAt();

    const navigation = screen.getByRole('navigation', { name: '主要导航' });
    for (const label of ['秒杀', '商城', '门店', '资产']) {
      expect(within(navigation).getByRole('link', { name: label })).toBeTruthy();
    }
    await user.click(within(navigation).getByRole('link', { name: '商城' }));
    expect(screen.getByRole('heading', { name: '常规商城' })).toBeTruthy();
  });

  it('renders the real buyer profile, UID and canonical overview counts', async () => {
    const user = userEvent.setup();
    renderAt('/assets', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByRole('heading', { name: buyerProfile.nickname! })).toBeTruthy();
    expect(screen.getByText('买家 UID：10001')).toBeTruthy();
    expect(screen.getByText('DecisionBlocked', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('2', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('3', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('1', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(deliveryOrder.buyerWallet);
  });

  it('labels seckill and shopping counts as loaded-page statistics without placeholders', async () => {
    const user = userEvent.setup();
    const seckillOrder = { ...deliveryOrder, orderId: `0x${'e'.repeat(64)}`, orderKind: 'SECKILL' as const };
    renderAt('/assets', readyServices({
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder, seckillOrder], nextCursor: null }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const tracking = (await screen.findByRole('heading', { name: '行为追踪' })).closest('section')!;
    expect(within(tracking).queryByText('--')).toBeNull();
    expect(within(tracking).getAllByText('1')).toHaveLength(2);
    expect(within(tracking).getAllByText('已加载')).toHaveLength(2);
  });

  it.each(['DecisionBlocked', 'ExternalBlocked', 'ConfigurationRequired'] as const)(
    'renders only the Core %s payment readiness reason',
    async (blockCode) => {
      const user = userEvent.setup();
      renderAt('/mall', readyServices({
        getBootstrap: vi.fn().mockResolvedValue({
          artifactVersion,
          writesEnabled: false,
          runtimeBlockers: ['SIGNER_UNAVAILABLE'],
          blockCode,
        }),
      }));

      await screen.findByRole('heading', { name: product.title });
      await openProductCheckout(user);
      expect(screen.getByText(`${blockCode}：Core 当前阻止新支付，不创建新报价。`)).toBeTruthy();
      expect(screen.queryByText('SIGNER_UNAVAILABLE')).toBeNull();
    },
  );

  it('updates nickname only after a provider-sealed BUYER_AVATAR upload', async () => {
    const user = userEvent.setup();
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'avatar.png', { type: 'image/png' });
    const intent = avatarUploadIntent();
    const asset = verifiedAvatarAsset();
    const updated = { ...buyerProfile, nickname: '新昵称', avatarAssetId, version: 3 };
    const createMediaUploadIntent = vi.fn<CoreClient['createMediaUploadIntent']>().mockResolvedValue(intent);
    const uploadMediaFile = vi.fn<CoreClient['uploadMediaFile']>().mockResolvedValue(undefined);
    const completeMediaUpload = vi.fn<CoreClient['completeMediaUpload']>().mockResolvedValue(asset);
    const updateBuyerProfile = vi.fn<CoreClient['updateBuyerProfile']>().mockResolvedValue(updated);
    const services = readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      createMediaUploadIntent,
      uploadMediaFile,
      completeMediaUpload,
      updateBuyerProfile,
      createAuthenticatedMediaReadAccess: vi.fn().mockResolvedValue(authenticatedAvatarAccess()),
    });
    services.hashEvidenceFile = vi.fn().mockResolvedValue(avatarContentHash);
    renderAt('/assets', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '编辑买家资料' }));
    await user.clear(screen.getByLabelText('昵称'));
    await user.type(screen.getByLabelText('昵称'), '新昵称');
    await user.upload(screen.getByLabelText(/^头像文件/), file);
    await user.click(screen.getByRole('button', { name: /保存资料/ }));

    expect(await screen.findByRole('heading', { name: '新昵称' })).toBeTruthy();
    expect(createMediaUploadIntent).toHaveBeenCalledWith('buyer-session', expect.objectContaining({
      purpose: 'BUYER_AVATAR',
      resourceType: 'BUYER',
      resourceId: BUYER,
      contentType: 'image/png',
      sizeBytes: 4,
      contentSha256: avatarContentHash,
    }));
    expect(uploadMediaFile).toHaveBeenCalledWith(intent, file);
    expect(completeMediaUpload).toHaveBeenCalledWith('buyer-session', intent.uploadIntentId);
    expect(updateBuyerProfile).toHaveBeenCalledWith('buyer-session', {
      nickname: '新昵称',
      avatarAssetId,
      expectedVersion: buyerProfile.version,
      idempotencyKey: 'mall-test-idempotency',
    });
    expect((await screen.findByRole('img', { name: '买家头像' })).getAttribute('src')).toBe(authenticatedAvatarAccess().readUrl);
  });

  it('creates and edits a manual address without map services, then binds the saved target', async () => {
    const user = userEvent.setup();
    let addresses = [{ ...buyerSavedAddress, isDefault: false }];
    const createBuyerAddress = vi.fn<CoreClient['createBuyerAddress']>().mockImplementation(async (_token, request) => {
      const created = { ...buyerSavedAddress, label: request.label, isDefault: request.isDefault };
      addresses = [created];
      return created;
    });
    const updateBuyerAddress = vi.fn<CoreClient['updateBuyerAddress']>().mockImplementation(async (_token, _id, request) => {
      addresses = [{ ...addresses[0]!, ...request, version: 4 }];
      return addresses[0]!;
    });
    const setDefaultBuyerAddress = vi.fn<CoreClient['setDefaultBuyerAddress']>().mockImplementation(async () => {
      addresses = [{ ...addresses[0]!, isDefault: true, version: 5 }];
      return addresses[0]!;
    });
    const deleteBuyerAddress = vi.fn<CoreClient['deleteBuyerAddress']>().mockImplementation(async () => { addresses = []; });
    const createBuyerAddressTarget = vi.fn<CoreClient['createBuyerAddressTarget']>().mockResolvedValue(deliveryTarget);
    const services = readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listBuyerAddresses: vi.fn().mockImplementation(async () => addresses),
      createBuyerAddress,
      updateBuyerAddress,
      setDefaultBuyerAddress,
      deleteBuyerAddress,
      createBuyerAddressTarget,
    });
    renderAt('/assets/addresses', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const form = screen.getByRole('form', { name: '新增收货地址' });
    await user.type(within(form).getByLabelText('收货人'), '张三');
    await user.type(within(form).getByLabelText('手机号'), '13800138000');
    await user.type(within(form).getByLabelText('省份'), '辽宁省');
    await user.type(within(form).getByLabelText('城市'), '大连市');
    await user.type(within(form).getByLabelText('区县'), '中山区');
    await user.type(within(form).getByLabelText('六位行政区代码'), '210202');
    await user.type(within(form).getByLabelText('详细地址'), '示例路 24 号');
    await user.click(within(form).getByRole('button', { name: /保存地址/ }));
    await waitFor(() => expect(createBuyerAddress).toHaveBeenCalledTimes(1));
    expect(createBuyerAddress).toHaveBeenCalledWith('buyer-session', expect.objectContaining({
      recipientName: '张三',
      phone: '13800138000',
      province: '辽宁省',
      city: '大连市',
      district: '中山区',
      regionCode: '210202',
      detailAddress: '示例路 24 号',
      longitude: null,
      latitude: null,
    }));

    await user.click(screen.getByRole('button', { name: '用于下单' }));
    expect(createBuyerAddressTarget).toHaveBeenCalledWith('buyer-session', buyerSavedAddress.addressId, 'mall-test-idempotency');
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('标签'));
    await user.type(screen.getByLabelText('标签'), '公司');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateBuyerAddress).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: '将公司设为默认地址' }));
    await waitFor(() => expect(setDefaultBuyerAddress).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '删除公司地址' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteBuyerAddress).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: '暂无已保存地址' })).toBeTruthy();
  });

  it('keeps manual address version conflicts visibly fail closed', async () => {
    const user = userEvent.setup();
    const updateBuyerAddress = vi.fn<CoreClient['updateBuyerAddress']>()
      .mockRejectedValue(new CoreClientError('UnknownState', 'Buyer address version changed'));
    renderAt('/assets/addresses', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listBuyerAddresses: vi.fn().mockResolvedValue([buyerSavedAddress]),
      updateBuyerAddress,
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Buyer address version changed'));
    expect(screen.getByRole('heading', { name: '地址同步失败' })).toBeTruthy();
  });

  it('loads Core products, authenticates the buyer and requests an exact signed reservation', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const createOrdinaryQuote = vi.fn<CoreClient['createOrdinaryQuote']>().mockResolvedValue(quote);
    const services = readyServices({ createOrdinaryQuote });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('button', { name: /0x1111/ });
    await openProductCheckout(user);
    expect(screen.getByRole('heading', { name: '订单配置' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '创建签名报价' }));

    await screen.findByRole('heading', { name: '库存已预留' });
    expect(createOrdinaryQuote).toHaveBeenCalledWith('buyer-session', {
      idempotencyKey: 'mall-test-idempotency',
      productId: product.productId,
      skuId: product.skus[0]?.skuId,
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: deliveryTarget.targetHash,
      regionCodeHash: deliveryTarget.regionCodeHash,
      label: '张三 · 辽宁省大连市中山区示例路 24 号',
    });
    expect(screen.getByText(`${quote.intent.listPriceUsdt} USDT 原子单位`)).toBeTruthy();

    await user.click(screen.getByRole('link', { name: /核对报价/ }));
    expect(screen.getByText(quote.intent.productUsdtPaymentAmount)).toBeTruthy();
    expect(screen.getByText(quote.intent.platformServiceFeeUsdt)).toBeTruthy();
    expect(screen.getByText(quote.intent.custodyProductUsdt)).toBeTruthy();
    expect(screen.getByText(quote.intent.freightUsdt)).toBeTruthy();
    expect(screen.getByText(quote.intent.usdtPaymentAmount)).toBeTruthy();
    expect(screen.getByText(quote.intent.nplPaymentAmount)).toBeTruthy();
    expect(screen.getByText(/pay · BSC 56/)).toBeTruthy();
    expect(screen.getByText(/canonical 原子单位/)).toBeTruthy();
    expect(screen.getByText('当前 0')).toBeTruthy();
    expect(screen.getByText('需要授权')).toBeTruthy();
    expect(screen.getByText('额度足够')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '完整收货信息' })).toBeTruthy();
    expect(screen.getByText(buyerSavedAddress.phone)).toBeTruthy();
    expect(screen.getByText(`${buyerSavedAddress.province} / ${buyerSavedAddress.city} / ${buyerSavedAddress.district}`)).toBeTruthy();
    expect(screen.getByText(/行政区 210202 将写入订单快照/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /支付并广播/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/manifest 尚未授权部署/)).toBeTruthy();
  });

  it('renders exact Core finality and never promotes a submitted hash to final', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      getPayment: vi.fn().mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null }),
    });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '创建签名报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('button', { name: '刷新 Core 投影' }));

    await waitFor(() => expect(screen.getByText(HASH_3)).toBeTruthy());
    expect(screen.getAllByText('待 Indexer')).toHaveLength(2);
    expect(screen.getByText('--/15')).toBeTruthy();
  });

  it('refuses to invent fulfillment hashes until a Core target exists', async () => {
    const user = userEvent.setup();
    const createOrdinaryQuote = vi.fn<CoreClient['createOrdinaryQuote']>();
    const services = readyServices({ createOrdinaryQuote });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    expect(screen.getByRole('button', { name: '创建签名报价' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('请先选择 Core 已保存的收货地址')).toBeTruthy();
    expect(createOrdinaryQuote).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '库存已预留' })).toBeNull();
  });

  it('latches a broadcast hash and retries only Core submission after a network failure', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const submitPayment = vi.fn<CoreClient['submitPayment']>()
      .mockRejectedValueOnce(new Error('submission network unavailable'))
      .mockResolvedValue({ orderId: quote.orderId, txHash: HASH_3, state: 'SUBMITTED' });
    const getPayment = vi.fn<CoreClient['getPayment']>().mockResolvedValue({
      ...quote,
      state: 'SUBMITTED',
      submittedTxHash: HASH_3,
      finality: null,
    });
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      submitPayment,
      getPayment,
    });
    services.walletWritesAuthorized = true;
    const saveSubmission = vi.spyOn(services.submissionStore, 'save');
    const clearSubmission = vi.spyOn(services.submissionStore, 'clear');
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '创建签名报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('checkbox', { name: /无限额度授权风险/ }));
    await user.click(screen.getByRole('button', { name: /支付并广播/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('submission network unavailable'));
    expect(screen.getByText('链上交易待恢复跟踪')).toBeTruthy();
    expect(screen.getByRole('button', { name: /支付并广播/ }).hasAttribute('disabled')).toBe(true);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
    expect(saveSubmission).toHaveBeenCalledWith(pendingRecord(quote.orderId, HASH_3));

    await user.click(screen.getByRole('button', { name: '重试提交 TxHash' }));
    await waitFor(() => expect(screen.queryByText('链上交易待恢复跟踪')).toBeNull());
    expect(submitPayment).toHaveBeenCalledTimes(2);
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
    expect(clearSubmission).toHaveBeenCalledTimes(1);
  });

  it('rehydrates a persisted pending hash and resumes without rebroadcasting', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const pending = pendingRecord(quote.orderId, HASH_3);
    const submitPayment = vi.fn<CoreClient['submitPayment']>().mockResolvedValue({ ...pending, state: 'SUBMITTED' });
    const services = readyServices({
      submitPayment,
      getPayment: vi.fn().mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null }),
    });
    services.submissionStore.load = () => pending;
    renderAt('/checkout/review', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByText('链上交易待恢复跟踪');
    await user.click(screen.getByRole('button', { name: '重试提交' }));

    await waitFor(() => expect(screen.queryByText('链上交易待恢复跟踪')).toBeNull());
    expect(submitPayment).toHaveBeenCalledWith('buyer-session', { orderId: quote.orderId, txHash: HASH_3 });
    expect(services.wallet.broadcastPayment).not.toHaveBeenCalled();
    expect(screen.getByText(HASH_3)).toBeTruthy();
  });

  it('keeps a submitted hash until the Core projection is recoverable', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote();
    const submitPayment = vi.fn<CoreClient['submitPayment']>()
      .mockResolvedValue({ orderId: quote.orderId, txHash: HASH_3, state: 'SUBMITTED' });
    const getPayment = vi.fn<CoreClient['getPayment']>()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValue({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_3, finality: null });
    const services = readyServices({
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
      submitPayment,
      getPayment,
    });
    services.walletWritesAuthorized = true;
    const saveSubmission = vi.spyOn(services.submissionStore, 'save');
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '创建签名报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    await user.click(screen.getByRole('checkbox', { name: /无限额度授权风险/ }));
    await user.click(screen.getByRole('button', { name: /支付并广播/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('projection unavailable'));
    expect(screen.getByText('链上交易待恢复跟踪')).toBeTruthy();
    expect(saveSubmission).toHaveBeenLastCalledWith(pendingRecord(quote.orderId, HASH_3, 'AWAITING_PROJECTION'));
    expect(submitPayment).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '刷新投影' }));
    await waitFor(() => expect(screen.queryByText('链上交易待恢复跟踪')).toBeNull());
    expect(submitPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledTimes(2);
    expect(services.wallet.broadcastPayment).toHaveBeenCalledTimes(1);
  });

  it('shows frozen rules and stays fail closed when Core has no published session', async () => {
    const user = userEvent.setup();
    renderAt('/seckill');

    await user.click(screen.getByText('规则说明'));
    expect(screen.getByRole('dialog', { name: '秒杀规则' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText(/主场固定 60 分钟/)).toBeTruthy();
    expect(screen.getByText(/增加 30 秒/)).toBeTruthy();
    expect(screen.getByText(/区块时间决定订单归类/)).toBeTruthy();
    expect(screen.getByText(/70% USDT \+ 30% 等值 NPL/)).toBeTruthy();
    expect(screen.getByText(/Core 签名的五分钟精确报价/)).toBeTruthy();
    expect(screen.getByText(/USDT 标价 1:1.*后台积分/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '规则说明' }));
    expect(await screen.findByText('暂无已发布场次')).toBeTruthy();
    expect(screen.getByRole('button', { name: '配置秒杀订单' }).hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['PREHEAT', '预热中'],
    ['LIVE', '主场和接力均以 Core 时间锚'],
    ['SETTLING', '大奖结算窗口'],
    ['SETTLED', '本场赢家'],
  ] as const)('renders authoritative %s seckill state without deriving phase locally', async (phase, expected) => {
    const current = seckillSession({
      phase,
      storedPhase: phase,
      ...(phase === 'PREHEAT' ? { startsAt: '2033-05-18T05:10:00.000Z' } : {}),
      ...(phase === 'SETTLED' ? { winnerWallet: BUYER, prizeSettlement: approvedPrizeSettlement() } : {}),
    });
    renderAt('/seckill', readyServices({ getCurrentSeckillSession: vi.fn().mockResolvedValue(current) }));

    expect(await screen.findByText(new RegExp(expected))).toBeTruthy();
    expect(screen.getAllByText(current.product.seckillListPriceUsdt, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(current.prizePoolUsdt, { exact: false }).length).toBeGreaterThan(0);
    if (phase === 'LIVE') {
      expect(screen.getByText('00:59:00')).toBeTruthy();
      expect(screen.getByText('00:01:00')).toBeTruthy();
      expect(screen.getByText(seckillGovernanceActionId)).toBeTruthy();
      expect(screen.getByText(seckillRulesContentHash)).toBeTruthy();
      expect(screen.getByText(seckillPublicationTxHash)).toBeTruthy();
    }
  });

  it('shows only the published rules content bound to the current final session', async () => {
    const current = seckillSession();
    const content = (text: string) => ({
      type: 'doc',
      children: [{ type: 'paragraph', children: [{ type: 'text', text }] }],
    });
    const matchingRules = {
      ...publicCmsItem,
      versionId: 'seckill-rules-current',
      slug: 'seckill-rules-current',
      contentType: 'SECKILL_RULES' as const,
      contentHash: current.rulesContentHash,
      content: content('当前场次规则'),
    };
    const staleRules = {
      ...matchingRules,
      versionId: 'seckill-rules-stale',
      slug: 'seckill-rules-stale',
      contentHash: `0x${'d'.repeat(64)}`,
      content: content('旧场次规则'),
    };
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      listPublicCms: vi.fn().mockResolvedValue([staleRules, matchingRules]),
    }));

    expect(await screen.findByRole('heading', { name: '当前场次规则' })).toBeTruthy();
    expect(screen.queryByText('旧场次规则')).toBeNull();
  });

  it('renders history and final-only relay wall from the coordinated realtime consumer', async () => {
    const current = seckillSession();
    const history = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement('SETTLED'),
    });
    const event = relayEvent();
    const services = readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      getSeckillSession: vi.fn().mockResolvedValue({ ...current, relayDeadline: String(event.payload.relayDeadline) }),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [history], nextCursor: null }),
    });
    services.realtime = {
      subscribe: (_sessionId, handlers) => {
        queueMicrotask(() => {
          handlers.onState('LIVE');
          handlers.onEvent(event);
        });
        return { close() {} };
      },
    };
    const user = userEvent.setup();
    renderAt('/seckill', services);

    expect(await screen.findByText(/链上最终购买，接力时间增加 30 秒/)).toBeTruthy();
    expect(screen.getByText('实时')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '历史战报' }));
    expect(screen.getByText(`赢家 0x1111…1111`)).toBeTruthy();
    expect(screen.getByText(seckillPrizeExecutionTxHash)).toBeTruthy();
  });

  it('renders candidate review, rollover, quarantine and every prize payout state from Core', async () => {
    const pending = seckillSession({
      phase: 'SETTLING',
      storedPhase: 'SETTLING',
      prizeSettlement: reviewPendingPrizeSettlement(),
    });
    const payoutStates = ['AVAILABLE', 'REQUESTED', 'SUBMITTED', 'SETTLED'] as const;
    const history = payoutStates.map((state, index) => seckillSession({
      sessionId: `0x${String(index + 1).repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement(state),
    }));
    history.push(seckillSession({
      sessionId: `0x${'5'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizePoolUsdt: '0',
      prizeSettlement: rolledOverPrizeSettlement(),
    }));
    const quarantined = reviewPendingPrizeSettlement();
    quarantined.state = 'QUARANTINED';
    quarantined.review = {
      decision: 'REJECTED',
      reasonCode: 'ORDER_INVALID',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reviewedBy: `0x${'a'.repeat(40)}`,
      reviewedAt: '2033-05-18T05:08:00.000Z',
    };
    history.push(seckillSession({
      sessionId: `0x${'6'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizeSettlement: quarantined,
    }));
    const user = userEvent.setup();
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(pending),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: history, nextCursor: null }),
    }));

    expect(await screen.findByText('候选审核中')).toBeTruthy();
    expect(screen.getByText(seckillCandidateOrderId)).toBeTruthy();
    expect(screen.getByText('区块 32000000 · Log 4')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '历史战报' }));
    for (const label of ['Available', 'Requested', 'Submitted', 'Settled', '已滚入下一场', '已隔离']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(seckillPrizeExecutionTxHash)).toBeTruthy();
  });

  it('binds the current Core session to the existing dual-quote checkout', async () => {
    const current = seckillSession();
    const quote = seckillQuote();
    const createSeckillQuote = vi.fn<CoreClient['createSeckillQuote']>().mockResolvedValue(quote);
    const services = readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(current),
      createSeckillQuote,
    });
    const user = userEvent.setup();
    renderAt('/seckill', services);

    const configure = await screen.findByRole('button', { name: '配置秒杀订单' });
    await user.click(configure);
    expect(screen.queryByRole('heading', { name: '秒杀订单配置' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '进入配置前确认规则' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我已阅读并确认规则' }));
    expect(screen.getByRole('heading', { name: '秒杀订单配置' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await prepareDeliveryTarget(user);
    await user.click(screen.getByRole('button', { name: '创建双腿秒杀报价' }));

    await screen.findByRole('heading', { name: '库存已预留' });
    expect(createSeckillQuote).toHaveBeenCalledWith('buyer-session', seckillSessionId, expect.objectContaining({
      productId: product.productId,
      skuId: product.skus[1]!.skuId,
    }));
  });

  it('keeps checkout closed when the confirmed LIVE session mismatches the catalog overlay', async () => {
    const user = userEvent.setup();
    const mismatchedProduct = {
      ...product,
      skus: product.skus.map((sku) => sku.seckill ? {
        ...sku,
        seckill: { ...sku.seckill, sessionId: `0x${'d'.repeat(64)}` },
      } : sku),
    };
    renderAt('/seckill', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(seckillSession()),
      listCatalog: vi.fn().mockResolvedValue([mismatchedProduct]),
    }));

    await user.click(await screen.findByRole('button', { name: '配置秒杀订单' }));
    await user.click(screen.getByRole('button', { name: '我已阅读并确认规则' }));

    expect((await screen.findByRole('alert')).textContent).toContain('overlay 不一致');
    expect(screen.queryByRole('heading', { name: '秒杀订单配置' })).toBeNull();
  });

  it('filters Core stores by administrative codes without map or location controls', async () => {
    const user = userEvent.setup();
    const createPublicMediaReadAccess = vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId)));
    const fartherStore = {
      ...store,
      storeId: 'store-dalian-002',
      name: '大连远程自提店',
      regionCode: '210203',
      latitude: store.latitude + 0.4,
      imageAssetIds: [],
    };
    const otherCityStore = {
      ...store,
      storeId: 'store-beijing-001',
      name: '北京自提店',
      regionCode: '110101',
      longitude: 116.4074,
      latitude: 39.9042,
      imageAssetIds: [],
    };
    const services = readyServices({
      createPublicMediaReadAccess,
      listStores: vi.fn().mockResolvedValue([fartherStore, otherCityStore, store]),
    });
    renderAt('/stores', services);

    const storeHeading = await screen.findByRole('heading', { name: store.name });
    const storeArticle = storeHeading.closest('article')!;
    expect(screen.getByLabelText('国家')).toHaveProperty('value', 'CN');
    await user.selectOptions(screen.getByLabelText('城市'), '210200');
    expect(screen.queryByRole('heading', { name: otherCityStore.name })).toBeNull();
    expect(within(screen.getByLabelText('区县')).getByRole('option', { name: '区县代码 210202' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('区县'), store.regionCode);
    expect(screen.queryByRole('heading', { name: fartherStore.name })).toBeNull();
    await user.selectOptions(screen.getByLabelText('区县'), '');
    expect(screen.getAllByText(store.businessHours).length).toBeGreaterThan(0);
    const storeImages = await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) });
    expect(storeImages).toHaveLength(storeImageAssetIds.length);
    for (const [index, assetId] of storeImageAssetIds.entries()) {
      expect(storeImages[index]?.getAttribute('src')).toBe(publicMediaAccess(assetId).readUrl);
      expect(createPublicMediaReadAccess).toHaveBeenCalledWith(assetId.toLowerCase());
    }
    expect(screen.getByRole('link', { name: `拨打 ${store.name} 电话` }).getAttribute('href')).toBe(`tel:${store.phone}`);
    expect(within(storeArticle).queryByRole('button', { name: /导航|距离/ })).toBeNull();
    expect(screen.queryByText(/km|最近/)).toBeNull();
  });

  it('clears stale public stores when a reload fails', async () => {
    const user = userEvent.setup();
    const listStores = vi.fn<CoreClient['listStores']>()
      .mockResolvedValueOnce([store])
      .mockRejectedValueOnce(new CoreClientError('ExternalBlocked', '门店投影暂不可用'));
    renderAt('/stores', readyServices({ listStores }));

    await screen.findByRole('heading', { name: store.name });
    await user.click(screen.getByRole('button', { name: '重新同步门店' }));

    expect(await screen.findByText('门店同步失败')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: store.name })).toBeNull();
    expect(screen.queryByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toBeNull();
  });

  it('binds a pickup target only through a published Core store snapshot', async () => {
    const user = userEvent.setup();
    const quote = paymentQuote('PICKUP');
    const createPickupTarget = vi.fn<CoreClient['createPickupTarget']>().mockResolvedValue(pickupTarget);
    const services = readyServices({
      createPickupTarget,
      createOrdinaryQuote: vi.fn().mockResolvedValue(quote),
    });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(await screen.findByText(`营业时间：${store.businessHours}`)).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toHaveLength(storeImageAssetIds.length);
    const nearestSelection = await screen.findByRole('button', { name: `选择 ${store.name}` });
    expect(createPickupTarget).not.toHaveBeenCalled();
    await user.click(nearestSelection);

    expect(createPickupTarget).toHaveBeenCalledWith('buyer-session', {
      idempotencyKey: 'mall-test-idempotency',
      storeId: store.storeId,
    });
    expect(screen.getByText(`${store.name} · ${store.address}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建签名报价' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: '创建签名报价' }));
    await user.click(await screen.findByRole('link', { name: /核对报价/ }));
    expect(screen.getByRole('heading', { name: '完整自提信息' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '完整自提信息' })).getByText(store.businessHours)).toBeTruthy();
    expect(screen.getByText(/营业时间内到店/)).toBeTruthy();
    expect(screen.getByText(/行政区 210202 将写入订单快照/)).toBeTruthy();
  });

  it('fails closed when Core cannot bind the buyer saved address', async () => {
    const user = userEvent.setup();
    const createBuyerAddressTarget = vi.fn<CoreClient['createBuyerAddressTarget']>()
      .mockRejectedValue(new CoreClientError('ExternalBlocked', '地址目标服务暂不可用'));
    const services = readyServices({ createBuyerAddressTarget });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await openProductCheckout(user);
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.click(await screen.findByRole('button', { name: '使用默认地址' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('地址目标服务暂不可用'));
    expect(createBuyerAddressTarget).toHaveBeenCalledWith('buyer-session', buyerSavedAddress.addressId, 'mall-test-idempotency');
    expect(screen.queryByLabelText('详细地址')).toBeNull();
    expect(screen.getByRole('button', { name: '创建签名报价' }).hasAttribute('disabled')).toBe(true);
  });

  it('uploads and submits evidence for an enabled buyer exchange action', async () => {
    const user = userEvent.setup();
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'damage.png', { type: 'image/png' });
    const intent = mediaUploadIntent();
    const asset = verifiedEvidenceAsset();
    const evidence = orderActionEvidence('REQUEST_EXCHANGE', 'PACKAGE_DAMAGED', [evidenceAssetId]);
    const createMediaUploadIntent = vi.fn<CoreClient['createMediaUploadIntent']>().mockResolvedValue(intent);
    const uploadMediaFile = vi.fn<CoreClient['uploadMediaFile']>().mockResolvedValue(undefined);
    const completeMediaUpload = vi.fn<CoreClient['completeMediaUpload']>().mockResolvedValue(asset);
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const requestExchange = vi.fn<CoreClient['requestExchange']>().mockResolvedValue(buyerActionResult('REQUEST_EXCHANGE'));
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder], nextCursor: null }),
      getOrderAllowedActions: vi.fn().mockResolvedValue(deliveryActions),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      getBuyerTakeoverTimeline: vi.fn().mockResolvedValue(buyerTakeoverTimeline),
      createMediaUploadIntent,
      uploadMediaFile,
      completeMediaUpload,
      createOrderActionEvidence,
      requestExchange,
    });
    services.hashEvidenceFile = vi.fn().mockResolvedValue(evidenceFileHash);
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByText('BNM 后台积分');
    expect(screen.getByText('顺丰')).toBeTruthy();
    expect(screen.getByText('SF1234567890')).toBeTruthy();
    expect(screen.getByText('易碎品，请当面签收')).toBeTruthy();
    expect(screen.getByText('运输中 · 05/18 13:00')).toBeTruthy();
    expect(screen.getByText(deliveryOrder.exactAmounts.bnmAmount)).toBeTruthy();
    expect(screen.getByText(/13800138000/)).toBeTruthy();
    expect(screen.getByText('PARTIAL_LEGACY')).toBeTruthy();
    expect(screen.getByText(/OPEN →/)).toBeTruthy();
    expect(screen.getByText(/PLATFORM_FUNDING_CONFIRMED/)).toBeTruthy();
    const exchange = screen.getByRole('button', { name: '申请换货' });
    expect(exchange.hasAttribute('disabled')).toBe(false);
    await user.click(exchange);
    await user.type(screen.getByLabelText('原因代码'), 'package_damaged');
    await user.upload(screen.getByLabelText(/证据文件（可选）/), file);
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));

    expect(await screen.findByText('操作已由 Core 接收，订单状态已重新同步。')).toBeTruthy();
    expect(createMediaUploadIntent).toHaveBeenCalledWith('buyer-session', {
      purpose: 'FULFILLMENT_EVIDENCE',
      resourceType: 'ORDER',
      resourceId: deliveryOrder.orderId,
      contentType: 'image/png',
      sizeBytes: 4,
      contentSha256: evidenceFileHash,
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(uploadMediaFile).toHaveBeenCalledWith(intent, file);
    expect(completeMediaUpload).toHaveBeenCalledWith('buyer-session', intent.uploadIntentId);
    expect(createOrderActionEvidence).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      action: 'REQUEST_EXCHANGE',
      reasonCode: 'PACKAGE_DAMAGED',
      mediaAssetIds: [evidenceAssetId],
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(requestExchange).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      idempotencyKey: 'mall-test-idempotency',
      evidenceHash: orderEvidenceHash,
      reasonCode: 'PACKAGE_DAMAGED',
    });
    expect(screen.getAllByText('UnknownState')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
    expect(document.body.textContent).not.toContain(orderEvidenceHash);
  });

  it('appends stable order pages and consumes complete row allowedActions without a second action lookup', async () => {
    const user = userEvent.setup();
    const cursor = { createdAt: deliveryOrder.createdAt, orderId: deliveryOrder.orderId };
    const secondOrder = {
      ...deliveryOrder,
      orderId: `0x${'e'.repeat(64)}`,
      createdAt: '2033-05-17T03:00:00.000Z',
      orderKind: 'SECKILL' as const,
      allowedActions: [],
    };
    const listOrders = vi.fn<CoreClient['listOrders']>().mockImplementation((_token, nextCursor) => Promise.resolve(
      nextCursor ? { orders: [secondOrder], nextCursor: null } : { orders: [deliveryOrder], nextCursor: cursor },
    ));
    const services = readyServices({
      listOrders,
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText(deliveryOrder.paymentTxHash!)).toBeTruthy();
    expect(screen.getByText('数量').nextElementSibling?.textContent).toBe(deliveryOrder.quantity);
    await user.click(screen.getByRole('button', { name: '加载更多订单' }));
    await screen.findByText('秒杀 · 快递订单');
    expect(screen.getByText('秒杀', { selector: '.order-kind-badge' })).toBeTruthy();
    expect(listOrders).toHaveBeenLastCalledWith('buyer-session', cursor);
    expect(services.core.getOrderAllowedActions).not.toHaveBeenCalled();
  });

  it('uses only a validated Mall support URL and fails closed when it is missing', async () => {
    const user = userEvent.setup();
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({ orders: [deliveryOrder], nextCursor: null }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    services.supportUrl = 'https://support.mall.test/help';
    const view = renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    const support = await screen.findByRole('link', { name: '联系客服' });
    expect(support.getAttribute('href')).toBe('https://support.mall.test/help');
    expect(support.getAttribute('rel')).toBe('noopener noreferrer');
    expect(support.getAttribute('href')).not.toContain(deliveryOrder.orderId);
    expect(validateSupportUrl('javascript:alert(1)').url).toBeNull();

    view.unmount();
    renderAt('/assets/orders', readyServices());
    expect(screen.getByText('ConfigurationRequired：客服入口未配置')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '联系客服' })).toBeNull();
  });

  it.each([
    ['REQUEST_DELAY', '申请延期'],
    ['OPEN_ARBITRATION', '发起仲裁'],
    ['CONFIRM_RECEIPT', '确认收货'],
  ] as const)('submits %s without requiring a pasted hash or media file', async (action, label) => {
    const user = userEvent.setup();
    const evidence = orderActionEvidence(action, 'BUYER_CONFIRMED');
    const requestDelay = vi.fn<CoreClient['requestDelay']>().mockResolvedValue(buyerActionResult('REQUEST_DELAY'));
    const openArbitration = vi.fn<CoreClient['openArbitration']>().mockResolvedValue(buyerActionResult('OPEN_ARBITRATION'));
    const confirmReceipt = vi.fn<CoreClient['confirmReceipt']>().mockResolvedValue(buyerActionResult('CONFIRM_RECEIPT'));
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{ ...deliveryOrder, allowedActions: [{ action, enabled: true }] }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      createOrderActionEvidence,
      requestDelay,
      openArbitration,
      confirmReceipt,
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: label }));
    await user.type(screen.getByLabelText('原因代码'), 'buyer_confirmed');
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    expect(await screen.findByText('操作已由 Core 接收，订单状态已重新同步。')).toBeTruthy();
    expect(createOrderActionEvidence).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, {
      action,
      reasonCode: 'BUYER_CONFIRMED',
      idempotencyKey: 'mall-test-idempotency',
    });
    expect(services.core.createMediaUploadIntent).not.toHaveBeenCalled();
    const command = { idempotencyKey: 'mall-test-idempotency', evidenceHash: orderEvidenceHash };
    if (action === 'REQUEST_DELAY') expect(requestDelay).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, { ...command, reasonCode: 'BUYER_CONFIRMED' });
    if (action === 'OPEN_ARBITRATION') expect(openArbitration).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, { ...command, reasonCode: 'BUYER_CONFIRMED' });
    if (action === 'CONFIRM_RECEIPT') expect(confirmReceipt).toHaveBeenCalledWith('buyer-session', deliveryOrder.orderId, command);
  });

  it('reuses the same evidence and command idempotency keys when command submission is retried', async () => {
    const user = userEvent.setup();
    const evidence = orderActionEvidence('REQUEST_EXCHANGE', 'PACKAGE_DAMAGED');
    const createOrderActionEvidence = vi.fn<CoreClient['createOrderActionEvidence']>().mockResolvedValue(evidence);
    const requestExchange = vi.fn<CoreClient['requestExchange']>()
      .mockRejectedValueOnce(new CoreClientError('NetworkUnavailable', '命令提交中断'))
      .mockResolvedValue(buyerActionResult('REQUEST_EXCHANGE'));
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{ ...deliveryOrder, allowedActions: [{ action: 'REQUEST_EXCHANGE', enabled: true }] }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
      createOrderActionEvidence,
      requestExchange,
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '申请换货' }));
    await user.type(screen.getByLabelText('原因代码'), 'package_damaged');
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('命令提交中断'));
    await user.click(screen.getByRole('button', { name: /封装证据并提交/ }));
    expect(await screen.findByText('操作已由 Core 接收，订单状态已重新同步。')).toBeTruthy();
    expect(createOrderActionEvidence).toHaveBeenCalledTimes(1);
    expect(requestExchange).toHaveBeenCalledTimes(2);
    expect(requestExchange.mock.calls[0]).toEqual(requestExchange.mock.calls[1]);
  });

  it('keeps takeover and pickup verification fail closed when buyer evidence authority is absent', async () => {
    const user = userEvent.setup();
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue({
        orders: [{
          ...deliveryOrder,
          allowedActions: [
            { action: 'OPEN_TAKEOVER', enabled: true },
            { action: 'VERIFY_PICKUP', enabled: true },
          ],
        }],
        nextCursor: null,
      }),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect((await screen.findByRole('button', { name: '平台接管' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '自提核销' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/尚未发布 OPEN_TAKEOVER/)).toBeTruthy();
    expect(screen.getByText(/仅授权门店或平台角色/)).toBeTruthy();
    expect(screen.queryByLabelText(/证据$/)).toBeNull();
  });

  it('keeps empty seckill activity truthful and shopping records buyer-authenticated', async () => {
    const user = userEvent.setup();
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>();
    renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));

    expect(await screen.findByRole('heading', { name: '暂无奖项结算记录' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/中奖金额|提取奖金|第\s*\d+\s*期/);
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    expect(screen.getByRole('heading', { name: '连接买家钱包后查看' })).toBeTruthy();
    expect(listBuyerShoppingStatements).not.toHaveBeenCalled();
  });

  it('renders exact Core shopping amounts and appends the paired cursor page', async () => {
    const user = userEvent.setup();
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>()
      .mockImplementation((_token, cursor) => Promise.resolve(cursor ? secondShoppingStatementPage : firstShoppingStatementPage));
    renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));

    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText(ordinaryShoppingStatement.paymentTxHash)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.productUsdtPaymentAmount} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.platformServiceFeeUsdt} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.custodyProductUsdt} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.freightUsdt} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.usdtPaymentAmount} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.paymentAmounts.nplPaymentAmount} 原子单位`)).toBeTruthy();
    expect(screen.getByText(`${ordinaryShoppingStatement.bnm.amount} 原子单位`)).toBeTruthy();
    expect(screen.getByText('可用')).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.createdAt)).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.paymentFinalizedAt)).toBeTruthy();
    expect(screen.getByText(ordinaryShoppingStatement.fulfilledAt!)).toBeTruthy();
    for (const journalId of ordinaryShoppingStatement.bnm.journalIds) expect(screen.getByText(journalId)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '加载下一页' }));
    expect(await screen.findByText(fallbackShoppingStatement.paymentTxHash)).toBeTruthy();
    expect(screen.getByText('边界转普通订单')).toBeTruthy();
    expect(screen.getByText('已锁定')).toBeTruthy();
    expect(screen.getByText('尚未最终履约')).toBeTruthy();
    expect(listBuyerShoppingStatements).toHaveBeenLastCalledWith('buyer-session', firstShoppingStatementPage.nextCursor);
    expect(screen.queryByRole('button', { name: '加载下一页' })).toBeNull();
  });

  it('shows shopping loading, empty and authorization failure states', async () => {
    const user = userEvent.setup();
    type ShoppingPage = Awaited<ReturnType<CoreClient['listBuyerShoppingStatements']>>;
    let resolvePage!: (page: ShoppingPage) => void;
    const pendingPage = new Promise<ShoppingPage>((resolve) => { resolvePage = resolve; });
    const listBuyerShoppingStatements = vi.fn<CoreClient['listBuyerShoppingStatements']>().mockReturnValue(pendingPage);
    const view = renderAt('/assets/activity', readyServices({ listBuyerShoppingStatements }));
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByLabelText('正在加载购物记录')).toBeTruthy();
    resolvePage({ ...secondShoppingStatementPage, statements: [] });
    expect(await screen.findByRole('heading', { name: '暂无购物记录' })).toBeTruthy();

    view.unmount();
    const forbidden = new CoreClientError('Forbidden', '当前会话无权读取该买家购物记录');
    renderAt('/assets/activity', readyServices({
      listBuyerShoppingStatements: vi.fn<CoreClient['listBuyerShoppingStatements']>().mockRejectedValue(forbidden),
    }));
    await user.click(screen.getByRole('tab', { name: '消费购物' }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText(forbidden.message, { selector: '.activity-error p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新同步' })).toBeTruthy();
  });

  it('tracks the Core winner candidate and rollover result instead of a blocked placeholder', async () => {
    const pending = seckillSession({
      phase: 'SETTLING',
      storedPhase: 'SETTLING',
      prizeSettlement: reviewPendingPrizeSettlement(),
    });
    const rolled = seckillSession({
      sessionId: `0x${'4'.repeat(64)}`,
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      prizePoolUsdt: '0',
      prizeSettlement: rolledOverPrizeSettlement(),
    });
    const user = userEvent.setup();
    renderAt('/assets/activity', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(pending),
      listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [rolled], nextCursor: null }),
    }));

    const records = await screen.findByLabelText('秒杀奖项记录');
    expect(within(records).getByText('候选审核中')).toBeTruthy();
    expect(within(records).getByText(seckillCandidateOrderId)).toBeTruthy();
    expect(within(records).getByText('已滚入下一场')).toBeTruthy();
    expect(within(records).queryByText(/DecisionBlocked：秒杀奖项记录未发布/)).toBeNull();
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await waitFor(() => expect(within(records).getByText(/当前钱包是唯一冻结候选人/)).toBeTruthy());
  });

  it('loads anonymous CMS without identity input and reloads authenticated CMS with the session token', async () => {
    const user = userEvent.setup();
    const listPublicCms = vi.fn<CoreClient['listPublicCms']>().mockResolvedValue([publicCmsItem]);
    renderAt('/mall', readyServices({ listPublicCms }));
    await screen.findByRole('heading', { name: '结算中心已开放' });
    expect(screen.getByText('RELEASE_ANNOUNCEMENT · V2')).toBeTruthy();
    expect(listPublicCms).toHaveBeenCalledWith();

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await waitFor(() => expect(listPublicCms).toHaveBeenCalledWith('buyer-session'));
  });

  it('renders every transferable lifecycle state and submits a wallet-signed settlement request', async () => {
    const user = userEvent.setup();
    const createSettlementIntent = vi.fn<CoreClient['createSettlementIntent']>().mockResolvedValue(settlementIntent);
    const submitSettlementRequest = vi.fn<CoreClient['submitSettlementRequest']>().mockResolvedValue(requestedSettlement);
    const services = readyServices({
      listSettlements: vi.fn().mockResolvedValue(settlementProjection),
      createSettlementIntent,
      submitSettlementRequest,
    });
    renderAt('/assets/rewards', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    for (const label of ['Locked', 'Available', 'Requested', 'Submitted', 'Settled']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(new RegExp(`${settlementTransferId.slice(0, 10)}…${settlementTransferId.slice(-8)}`))).toBeTruthy();
    expect(screen.getByText(finalExecutionTxHash)).toBeTruthy();
    for (const label of ['创世', '直推', '区县', '城市', '省', '大区', '运维', '取整余数']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByLabelText('BNM 账户总额').textContent).toContain('700');
    expect(screen.getByLabelText('BNM 账户总额').textContent).toContain('300');
    await user.click(screen.getByRole('button', { name: '签名申请结算 200' }));

    await waitFor(() => expect(createSettlementIntent).toHaveBeenCalledWith('buyer-session', {
      rail: 'REWARD_NPL',
      amount: '200',
      idempotencyKey: 'mall-test-idempotency',
    }));
    expect(services.wallet.signSettlementIntent).toHaveBeenCalledWith(settlementIntent);
    expect(submitSettlementRequest).toHaveBeenCalledWith('buyer-session', {
      intentId: settlementIntent.intent.intentId,
      signature: '0xsettlement-signature',
    });
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
  });

  it('uses the existing PRIZE_USDT signed request for the published winner and exposes no action to a non-winner', async () => {
    const prizeProjection = {
      ...settlementProjection,
      balances: settlementProjection.balances.filter((balance) => balance.asset === 'USDT'),
      points: [],
      requests: [],
    };
    const createSettlementIntent = vi.fn<CoreClient['createSettlementIntent']>().mockResolvedValue(prizeSettlementIntent);
    const submitSettlementRequest = vi.fn<CoreClient['submitSettlementRequest']>().mockResolvedValue({
      ...requestedSettlement,
      rail: 'PRIZE_USDT',
      asset: 'USDT',
      asset_address: chainIdentity.usdtAddress,
      amount: '60',
    });
    const winnerSession = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: BUYER,
      prizeSettlement: approvedPrizeSettlement(),
    });
    const user = userEvent.setup();
    const winnerView = renderAt('/assets/rewards', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(winnerSession),
      listSettlements: vi.fn().mockResolvedValue(prizeProjection),
      createSettlementIntent,
      submitSettlementRequest,
    }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(await screen.findByRole('button', { name: '签名申请结算 60' }));
    await waitFor(() => expect(createSettlementIntent).toHaveBeenCalledWith('buyer-session', {
      rail: 'PRIZE_USDT',
      amount: '60',
      idempotencyKey: 'mall-test-idempotency',
    }));

    winnerView.unmount();
    const otherWinner = '0x2222222222222222222222222222222222222222';
    const nonWinnerSession = seckillSession({
      phase: 'SETTLED',
      storedPhase: 'SETTLED',
      winnerWallet: otherWinner,
      prizeSettlement: {
        ...approvedPrizeSettlement(),
        candidate: { ...approvedPrizeSettlement().candidate!, buyerWallet: otherWinner },
      },
    });
    renderAt('/assets/rewards', readyServices({
      getCurrentSeckillSession: vi.fn().mockResolvedValue(nonWinnerSession),
      listSettlements: vi.fn().mockResolvedValue({
        ...settlementProjection,
        balances: settlementProjection.balances.filter((balance) => balance.asset !== 'USDT'),
        requests: settlementProjection.requests.filter((request) => request.rail !== 'PRIZE_USDT'),
      }),
    }));
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    expect(screen.queryByRole('heading', { name: '秒杀 USDT 奖金' })).toBeNull();
    expect(screen.queryByRole('button', { name: /签名申请结算 60/ })).toBeNull();
  });

  it('hides genesis attribution when Core does not project genesis eligibility', async () => {
    const withoutGenesis = {
      ...settlementProjection,
      balances: settlementProjection.balances.filter((balance) => balance.rewardSubtype !== 'GENESIS'),
    };
    const services = readyServices({ listSettlements: vi.fn().mockResolvedValue(withoutGenesis) });
    const user = userEvent.setup();
    renderAt('/assets/rewards', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'NPL 收益' });
    expect(screen.queryByText('创世')).toBeNull();
    expect(screen.getByText('直推')).toBeTruthy();
  });

  it('loads the real notification inbox and registers the wallet-bound in-app endpoint', async () => {
    const user = userEvent.setup();
    const registerNotificationEndpoint = vi.fn<CoreClient['registerNotificationEndpoint']>().mockResolvedValue({
      endpointId: 'notification-endpoint-1',
      channel: 'IN_APP',
      provider: 'CORE',
      topics: ['*'],
      state: 'ACTIVE',
    });
    const notifications: readonly NotificationInboxItem[] = [
      notificationItem,
      { ...notificationItem },
      notification('settlement-submitted-message', 'SettlementTransferSubmitted', 'SETTLEMENT_SUBMITTED', {
        requestId: 'settlement-request-submitted', executionTxHash: `0x${'d'.repeat(64)}`,
      }),
      notification('payment-message', 'PaymentFinalized', 'PAYMENT_FINALIZED', { orderId: 'order-payment', state: 'LOCKED' }),
      notification('shipment-message', 'LogisticsUpdated', 'SHIPMENT_UPDATED', {
        orderId: 'order-shipment', provider: 'KUAIDI100', carrierCode: 'SF', trackingNumberHash: `0x${'5'.repeat(64)}`, status: 'IN_TRANSIT',
      }),
      notification('pickup-message', 'FulfillmentFinalized', 'FULFILLMENT_FINALIZED', {
        orderId: 'order-pickup', method: 'PICKUP_VERIFICATION', availableNplAmount: '20',
      }),
      notification('bnm-locked-message', 'BnmStateFinalized', 'BNM_LOCKED', { state: 'LOCKED', amount: '100', stateVersion: '1' }),
      notification('bnm-available-message', 'BnmStateFinalized', 'BNM_AVAILABLE', { state: 'AVAILABLE', amount: '100', stateVersion: '2' }),
      notification('activity-message', 'NotificationCampaignPublished', 'ACTIVITY', {
        titleKey: 'SECKILL_ACTIVITY', bodyKey: 'SECKILL_ACTIVITY_BODY', campaignId: 'campaign-24k', variables: { version: '2' },
      }),
    ];
    const services = readyServices({
      listNotifications: vi.fn().mockResolvedValue(notifications),
      registerNotificationEndpoint,
    });
    renderAt('/assets/notifications', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: '结算已完成' });
    expect(screen.getAllByRole('heading', { name: '结算已完成' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '结算交易已提交' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '支付已确认' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '发货与物流已更新' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '自提履约已完成' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 已锁定' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'BNM 已可用' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '活动通知' })).toBeTruthy();
    expect(screen.getByText('物流单号哈希')).toBeTruthy();
    expect(screen.getByText('自提核销')).toBeTruthy();
    expect(screen.getAllByText('Locked（锁定）')).toHaveLength(2);
    expect(screen.getAllByText('Available（可用）')).toHaveLength(1);
    expect(screen.getByText('活动参数 · 版本')).toBeTruthy();
    expect(screen.getByText(finalExecutionTxHash)).toBeTruthy();
    expect(screen.getByRole('button', { name: `重新验证或切换钱包，当前 ${BUYER}` })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '启用站内通知' }));
    await waitFor(() => expect(registerNotificationEndpoint).toHaveBeenCalledWith('buyer-session', {
      channel: 'IN_APP',
      provider: 'CORE',
      endpointReference: `recipient://wallet/${BUYER}`,
      topics: ['*'],
    }));
    expect(await screen.findByText('CORE · ACTIVE')).toBeTruthy();
  });

  it('clears the prior wallet inbox immediately and ignores its late refresh response', async () => {
    const secondBuyer = '0x2222222222222222222222222222222222222222';
    const oldRefresh = deferred<readonly NotificationInboxItem[]>();
    const newInbox = deferred<readonly NotificationInboxItem[]>();
    const oldItem = notification('old-wallet-message', 'PaymentFinalized', 'PAYMENT_FINALIZED', { orderId: 'old-order' });
    const newItem = notification('new-wallet-message', 'ShipmentRecorded', 'SHIPMENT_UPDATED', { orderId: 'new-order' });
    let notificationCall = 0;
    const listNotifications = vi.fn<CoreClient['listNotifications']>().mockImplementation(() => {
      notificationCall += 1;
      if (notificationCall === 1) return Promise.resolve([oldItem]);
      if (notificationCall === 2) return oldRefresh.promise;
      return newInbox.promise;
    });
    const walletForToken = (token: string) => token === 'buyer-session-2' ? secondBuyer : BUYER;
    const services = readyServices({
      authenticate: vi.fn().mockImplementation((walletAddress: string) => Promise.resolve({
        token: walletAddress === secondBuyer ? 'buyer-session-2' : 'buyer-session',
        walletAddress,
        roles: ['BUYER'],
      })),
      getBuyerProfile: vi.fn().mockImplementation((token: string) => Promise.resolve({ ...buyerProfile, wallet: walletForToken(token) })),
      getBuyerOverview: vi.fn().mockImplementation((token: string) => Promise.resolve({ ...buyerOverview, wallet: walletForToken(token) })),
      listBuyerShoppingStatements: vi.fn().mockImplementation((token: string) => Promise.resolve({
        artifactVersion, buyerWallet: walletForToken(token), statements: [], nextCursor: null,
      })),
      listSettlements: vi.fn().mockImplementation((token: string) => Promise.resolve({
        artifactVersion, wallet: walletForToken(token), balances: [], points: [], requests: [],
      })),
      listNotifications,
    });
    services.wallet.connect = vi.fn()
      .mockResolvedValueOnce(BUYER)
      .mockResolvedValueOnce(secondBuyer);
    const user = userEvent.setup();
    render(<MallRuntimeProvider services={services}><NotificationConnectionProbe /></MallRuntimeProvider>);

    await user.click(screen.getByRole('button', { name: '连接测试钱包' }));
    expect(await screen.findByText('old-wallet-message')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '刷新测试通知' }));
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '连接测试钱包' }));
    expect(screen.queryByText('old-wallet-message')).toBeNull();
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(3));

    oldRefresh.resolve([oldItem]);
    await waitFor(() => expect(screen.queryByText('old-wallet-message')).toBeNull());
    newInbox.resolve([newItem, { ...newItem }]);
    expect(await screen.findByText('new-wallet-message')).toBeTruthy();
    expect(screen.getAllByText('new-wallet-message')).toHaveLength(1);
  });

  it('fails closed without test notification fixtures when the Core inbox errors', async () => {
    const user = userEvent.setup();
    renderAt('/assets/notifications', readyServices({
      listNotifications: vi.fn().mockRejectedValue(new CoreClientError('ExternalBlocked', 'Notification inbox unavailable')),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByRole('heading', { name: '通知同步失败' })).toBeTruthy();
    expect(screen.queryByText(finalExecutionTxHash)).toBeNull();
    expect(screen.queryByRole('heading', { name: '结算已完成' })).toBeNull();
  });

  it('provides accessible names for every icon-only control', () => {
    renderAt('/assets');
    const iconOnlyControls = Array.from(document.querySelectorAll('button, a')).filter(
      (element) => !element.textContent?.trim(),
    );
    for (const element of iconOnlyControls) expect(element.getAttribute('aria-label')).toBeTruthy();
  });
});

const HASH_3 = `0x${'3'.repeat(64)}`;

function offlineServices(): MallServices {
  return servicesWith({
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(false)),
    listCatalog: vi.fn().mockResolvedValue([]),
  });
}

function readyServices(overrides: Partial<CoreClient> = {}): MallServices {
  return servicesWith({
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(true)),
    listCatalog: vi.fn().mockResolvedValue([product]),
    listCatalogCategories: vi.fn().mockResolvedValue(catalogCategories),
    listCatalogTags: vi.fn().mockResolvedValue(catalogTags),
    createPublicMediaReadAccess: vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId))),
    listStores: vi.fn().mockResolvedValue([store]),
    listBuyerAddresses: vi.fn().mockResolvedValue([buyerSavedAddress]),
    createBuyerAddressTarget: vi.fn().mockResolvedValue(deliveryTarget),
    ...overrides,
  });
}

function servicesWith(overrides: Partial<CoreClient>): MallServices {
  let pendingSubmission: PendingSubmission | null = null;
  const core: CoreClient = {
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(false)),
    listCatalog: vi.fn().mockResolvedValue([]),
    listCatalogCategories: vi.fn().mockResolvedValue([]),
    listCatalogTags: vi.fn().mockResolvedValue([]),
    createPublicMediaReadAccess: vi.fn().mockRejectedValue(new Error('not configured')),
    createAuthenticatedMediaReadAccess: vi.fn().mockRejectedValue(new Error('not configured')),
    createMediaUploadIntent: vi.fn().mockRejectedValue(new Error('not configured')),
    uploadMediaFile: vi.fn().mockRejectedValue(new Error('not configured')),
    completeMediaUpload: vi.fn().mockRejectedValue(new Error('not configured')),
    authenticate: vi.fn().mockResolvedValue({ token: 'buyer-session', walletAddress: BUYER, roles: ['BUYER'] }),
    getBuyerProfile: vi.fn().mockResolvedValue({
      artifactVersion, wallet: BUYER, accountId: '10001',
      nickname: null, avatarAssetId: null, version: 0, updatedAt: null,
    }),
    updateBuyerProfile: vi.fn().mockRejectedValue(new Error('not configured')),
    parseBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    listBuyerAddresses: vi.fn().mockResolvedValue([]),
    createBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    updateBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    deleteBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    setDefaultBuyerAddress: vi.fn().mockRejectedValue(new Error('not configured')),
    createBuyerAddressTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getBuyerOverview: vi.fn().mockResolvedValue({
      artifactVersion,
      wallet: BUYER,
      orderCounts: {
        pendingPayment: { status: 'DecisionBlocked', count: null, blocker: 'BUYER_PENDING_PAYMENT_PROJECTION' },
        pendingShipment: { status: 'AVAILABLE', count: '0' },
        pendingReceipt: { status: 'AVAILABLE', count: '0' },
        afterSale: { status: 'AVAILABLE', count: '0' },
        total: { status: 'AVAILABLE', count: '0' },
      },
    }),
    getBuyerTakeoverTimeline: vi.fn().mockImplementation((_token: string, orderId: string) => Promise.resolve({
      artifactVersion, orderId, historyStatus: 'COMPLETE', transitions: [],
    })),
    listBuyerShoppingStatements: vi.fn().mockResolvedValue({
      artifactVersion,
      buyerWallet: BUYER,
      statements: [],
      nextCursor: null,
    }),
    createOrdinaryQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    createSeckillQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    submitPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    getPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    getCurrentSeckillSession: vi.fn().mockRejectedValue(new CoreClientError('UnknownState', 'no session')),
    listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSeckillSession: vi.fn().mockRejectedValue(new Error('not configured')),
    listSeckillSessionEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: '0' }),
    listStores: vi.fn().mockResolvedValue([]),
    createDeliveryTarget: vi.fn().mockResolvedValue(deliveryTarget),
    createPickupTarget: vi.fn().mockResolvedValue(pickupTarget),
    listOrders: vi.fn().mockResolvedValue({ orders: [], nextCursor: null }),
    getOrder: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderAllowedActions: vi.fn().mockResolvedValue([]),
    createOrderActionEvidence: vi.fn().mockRejectedValue(new Error('not configured')),
    requestExchange: vi.fn().mockRejectedValue(new Error('not configured')),
    requestDelay: vi.fn().mockRejectedValue(new Error('not configured')),
    confirmReceipt: vi.fn().mockRejectedValue(new Error('not configured')),
    openArbitration: vi.fn().mockRejectedValue(new Error('not configured')),
    listSettlements: vi.fn().mockResolvedValue({ artifactVersion, wallet: BUYER, balances: [], points: [], requests: [] }),
    createSettlementIntent: vi.fn().mockRejectedValue(new Error('not configured')),
    submitSettlementRequest: vi.fn().mockRejectedValue(new Error('not configured')),
    listPublicCms: vi.fn().mockResolvedValue([]),
    listNotifications: vi.fn().mockResolvedValue([]),
    registerNotificationEndpoint: vi.fn().mockRejectedValue(new Error('not configured')),
    ...overrides,
  };
  const wallet: WalletGateway = {
    connect: vi.fn().mockResolvedValue(BUYER),
    signMessage: vi.fn().mockResolvedValue('0xsigned'),
    signSettlementIntent: vi.fn().mockResolvedValue('0xsettlement-signature'),
    inspectApprovals: vi.fn().mockResolvedValue([
      { currentAllowance: '0', sufficient: false },
      { currentAllowance: '999999999999999999999', sufficient: true },
    ]),
    broadcastPayment: vi.fn().mockResolvedValue(HASH_3),
    revokeApproval: vi.fn().mockResolvedValue(HASH_3),
  };
  return {
    core,
    wallet,
    createIdempotencyKey: () => 'mall-test-idempotency',
    hashEvidenceFile: vi.fn().mockResolvedValue(HASH_3),
    submissionStore: {
      load: (walletAddress) => pendingSubmission?.walletAddress === walletAddress.toLowerCase() ? pendingSubmission : null,
      save: (submission) => { pendingSubmission = submission; },
      clear: () => { pendingSubmission = null; },
    },
    realtime: {
      subscribe: () => ({ close() {} }),
    },
    walletWritesAuthorized: false,
  };
}

async function prepareDeliveryTarget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '使用默认地址' }));
  await screen.findByText('Core 目标已验证');
}

async function openProductCheckout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('link', { name: `查看 ${product.title} 商品详情` }));
  expect(screen.getByRole('heading', { name: '商品详情' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '购买' }));
}

function pendingRecord(orderId: string, txHash: string, phase: PendingSubmission['phase'] = 'PENDING_CORE_SUBMISSION'): PendingSubmission {
  return {
    artifactVersion,
    chainId: 56,
    walletAddress: BUYER,
    phase,
    orderId,
    txHash,
  };
}

function bootstrap(writesEnabled: boolean): CorePaymentAvailability {
  return {
    artifactVersion,
    writesEnabled,
    runtimeBlockers: writesEnabled ? [] : ['SIGNER_UNAVAILABLE'],
    blockCode: writesEnabled ? null : 'ExternalBlocked',
  };
}

function notification(
  messageId: string,
  sourceEventType: string,
  topic: string,
  templateData: NotificationInboxItem['templateData'],
): NotificationInboxItem {
  return {
    messageId,
    sourceEventType,
    topic,
    templateData,
    deliveryState: 'DELIVERED',
    createdAt: '2033-05-18T05:10:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const BUYER = '0x1111111111111111111111111111111111111111';

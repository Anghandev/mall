import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  allowedActionNames,
  artifactVersion,
  executableOrderActionNames,
  type PaymentQuoteResponse,
} from '@abu24k/core-artifacts';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { MallApp, mallRuntimeBoundary } from '../src/App';
import { isCoreOrderActionExecutable, productBaseline } from '../src/bootstrap';
import { CoreClientError, type CoreClient, type CorePaymentAvailability } from '../src/core-client';
import type { MallServices, PendingSubmission } from '../src/mall-runtime';
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
  relayEvent,
  seckillGovernanceActionId,
  seckillPublicationTxHash,
  seckillRulesContentHash,
  seckillSession,
  seckillSessionId,
} from './seckill-fixtures';
import {
  finalSafeTxHash,
  notificationItem,
  publicCmsItem,
  requestedSettlement,
  settlementIntent,
  settlementProjection,
} from './settlement-fixtures';

function renderAt(path = '/seckill', services = offlineServices()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MallApp services={services} />
    </MemoryRouter>,
  );
}

describe('Mall V2 payment consumer', () => {
  it('consumes the current coordinated Core checkpoint and keeps payment writes fail closed', async () => {
    renderAt('/mall');

    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-settlement-admin.10');
    expect(productBaseline.manifestsAligned).toBe(true);
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toContain('CONFIRM_RECEIPT');
    expect(executableOrderActionNames).not.toContain('PAY_ORDER');
    expect(isCoreOrderActionExecutable('CONFIRM_RECEIPT')).toBe(true);
    expect(isCoreOrderActionExecutable('PAY_ORDER')).toBe(false);
    expect(mallRuntimeBoundary).toMatchObject({
      artifactStatus: '2.0.0-settlement-admin.10',
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

    await user.click(screen.getByRole('button', { name: /选择商品/ }));
    expect(screen.getByText('黑金鞋面，轻量缓震结构。')).toBeTruthy();
    expect(screen.getByRole('button', { name: /41码 \/ 秒杀黑金/ }).hasAttribute('disabled')).toBe(true);
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

    await user.click(await screen.findByRole('button', { name: /选择商品/ }));
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

  it('renders the real buyer profile, DecisionBlocked UID and canonical overview counts', async () => {
    const user = userEvent.setup();
    renderAt('/assets', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByRole('heading', { name: buyerProfile.nickname! })).toBeTruthy();
    expect(screen.getByText('买家 UID：DecisionBlocked')).toBeTruthy();
    expect(screen.getByText('DecisionBlocked', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('2', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('3', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(screen.getByText('1', { selector: '.order-status-item strong' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(deliveryOrder.buyerWallet);
  });

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

  it('forces parse review before address CRUD and creates checkout target from the saved address', async () => {
    const user = userEvent.setup();
    let addresses = [{ ...buyerSavedAddress, isDefault: false }];
    const parseBuyerAddress = vi.fn<CoreClient['parseBuyerAddress']>().mockResolvedValue(parsedBuyerAddress);
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
      parseBuyerAddress,
      createBuyerAddress,
      updateBuyerAddress,
      setDefaultBuyerAddress,
      deleteBuyerAddress,
      createBuyerAddressTarget,
    });
    renderAt('/assets/addresses', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.type(screen.getByLabelText('地址文本'), '张三 13800138000 辽宁省大连市中山区示例路 24 号');
    expect(screen.queryByRole('button', { name: /确认并保存/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '解析并复核' }));
    expect(await screen.findByRole('heading', { name: '复核识别结果' })).toBeTruthy();
    expect(screen.getAllByText(parsedBuyerAddress.regionCode!).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(parsedBuyerAddress.sourceReferenceHash!);
    await user.click(screen.getByRole('button', { name: /确认并保存/ }));
    await waitFor(() => expect(createBuyerAddress).toHaveBeenCalledTimes(1));
    expect(createBuyerAddress).toHaveBeenCalledWith('buyer-session', expect.objectContaining({
      recipientName: parsedBuyerAddress.recipientName,
      phone: parsedBuyerAddress.phone,
      detailAddress: parsedBuyerAddress.detailAddress,
      longitude: parsedBuyerAddress.longitude,
      latitude: parsedBuyerAddress.latitude,
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

  it('keeps address parsing and version conflicts visibly fail closed', async () => {
    const user = userEvent.setup();
    const parseBuyerAddress = vi.fn<CoreClient['parseBuyerAddress']>()
      .mockRejectedValue(new CoreClientError('ConfigurationRequired', 'AMAP is not configured'));
    const updateBuyerAddress = vi.fn<CoreClient['updateBuyerAddress']>()
      .mockRejectedValue(new CoreClientError('UnknownState', 'Buyer address version changed'));
    renderAt('/assets/addresses', readyServices({
      getBuyerProfile: vi.fn().mockResolvedValue(buyerProfile),
      getBuyerOverview: vi.fn().mockResolvedValue(buyerOverview),
      listBuyerAddresses: vi.fn().mockResolvedValue([buyerSavedAddress]),
      parseBuyerAddress,
      updateBuyerAddress,
    }));

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.type(screen.getByLabelText('地址文本'), '张三 13800138000 辽宁省大连市中山区');
    await user.click(screen.getByRole('button', { name: '解析并复核' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('AMAP is not configured'));
    expect(screen.queryByRole('heading', { name: '复核识别结果' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '关闭' }));

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
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
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
    expect(screen.getByText(quote.intent.usdtPaymentAmount)).toBeTruthy();
    expect(screen.getByText(quote.intent.nplPaymentAmount)).toBeTruthy();
    expect(screen.getByText(/pay · BSC 56/)).toBeTruthy();
    expect(screen.getByText(/canonical 原子单位/)).toBeTruthy();
    expect(screen.getByText('当前 0')).toBeTruthy();
    expect(screen.getByText('需要授权')).toBeTruthy();
    expect(screen.getByText('额度足够')).toBeTruthy();
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
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
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
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    expect(screen.getByRole('button', { name: '创建签名报价' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('请先验证快递目标')).toBeTruthy();
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
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
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
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
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
    expect(screen.getByText(/主场固定 60 分钟/)).toBeTruthy();
    expect(screen.getByText(/增加 30 秒/)).toBeTruthy();
    expect(screen.getByText(/区块时间决定订单归类/)).toBeTruthy();
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
      ...(phase === 'SETTLED' ? { winnerWallet: BUYER } : {}),
    });
    renderAt('/seckill', readyServices({ getCurrentSeckillSession: vi.fn().mockResolvedValue(current) }));

    expect(await screen.findByText(new RegExp(expected))).toBeTruthy();
    expect(screen.getAllByText(current.product.seckillListPriceUsdt, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(current.prizePoolUsdt, { exact: false })).toBeTruthy();
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
    const history = seckillSession({ phase: 'SETTLED', storedPhase: 'SETTLED', winnerWallet: BUYER });
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

    await user.click(await screen.findByRole('button', { name: '配置秒杀订单' }));
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

  it('renders Core stores, browser distance and keeps native navigation ExternalBlocked', async () => {
    const user = userEvent.setup();
    const createPublicMediaReadAccess = vi.fn((assetId: string) => Promise.resolve(publicMediaAccess(assetId)));
    const services = readyServices({ createPublicMediaReadAccess });
    renderAt('/stores', services);

    await screen.findByRole('heading', { name: store.name });
    expect(screen.getByText(store.businessHours)).toBeTruthy();
    const storeImages = await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) });
    expect(storeImages).toHaveLength(storeImageAssetIds.length);
    for (const [index, assetId] of storeImageAssetIds.entries()) {
      expect(storeImages[index]?.getAttribute('src')).toBe(publicMediaAccess(assetId).readUrl);
      expect(createPublicMediaReadAccess).toHaveBeenCalledWith(assetId.toLowerCase());
    }
    expect(screen.getByText('定位后显示')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '获取距离' }));
    await screen.findByText('0.0 km');
    expect(screen.getByRole('link', { name: `拨打 ${store.name} 电话` }).getAttribute('href')).toBe(`tel:${store.phone}`);
    expect(screen.getByRole('button', { name: '导航' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/原生地图桥接.*ExternalBlocked/)).toBeTruthy();
  });

  it('clears stale public stores when a filtered reload fails', async () => {
    const user = userEvent.setup();
    const listStores = vi.fn<CoreClient['listStores']>()
      .mockResolvedValueOnce([store])
      .mockRejectedValueOnce(new CoreClientError('ExternalBlocked', '门店投影暂不可用'));
    renderAt('/stores', readyServices({ listStores }));

    await screen.findByRole('heading', { name: store.name });
    await user.type(screen.getByLabelText('六位行政区代码'), store.regionCode);
    await user.click(screen.getByRole('button', { name: '筛选门店' }));

    expect(await screen.findByText('门店同步失败')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: store.name })).toBeNull();
    expect(screen.queryByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toBeNull();
  });

  it('binds a pickup target only through a published Core store snapshot', async () => {
    const user = userEvent.setup();
    const createPickupTarget = vi.fn<CoreClient['createPickupTarget']>().mockResolvedValue(pickupTarget);
    const services = readyServices({ createPickupTarget });
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(await screen.findByText(`营业时间：${store.businessHours}`)).toBeTruthy();
    expect(await screen.findAllByRole('img', { name: new RegExp(`${store.name} 门店图片`) })).toHaveLength(storeImageAssetIds.length);
    await user.click(await screen.findByRole('button', { name: new RegExp(store.name) }));

    expect(createPickupTarget).toHaveBeenCalledWith('buyer-session', {
      idempotencyKey: 'mall-test-idempotency',
      storeId: store.storeId,
    });
    expect(screen.getByText(`${store.name} · ${store.address}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建签名报价' }).hasAttribute('disabled')).toBe(false);
  });

  it('fails closed before target creation when browser location is denied', async () => {
    const user = userEvent.setup();
    const createDeliveryTarget = vi.fn<CoreClient['createDeliveryTarget']>();
    const services = readyServices({ createDeliveryTarget });
    services.getCurrentPosition = vi.fn().mockRejectedValue(new CoreClientError('ExternalBlocked', '未取得设备定位授权'));
    renderAt('/mall', services);

    await screen.findByRole('heading', { name: product.title });
    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await user.click(screen.getByRole('button', { name: /选择商品/ }));
    await user.click(screen.getByRole('button', { name: /42码 \/ 黑金/ }));
    await user.type(screen.getByLabelText('收货人'), '张三');
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.type(screen.getByLabelText('详细地址'), '辽宁省大连市中山区示例路 24 号');
    await user.click(screen.getByRole('button', { name: '验证快递目标' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('未取得设备定位授权'));
    expect(createDeliveryTarget).not.toHaveBeenCalled();
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
    expect(screen.getByText('KUAIDI100 · 运输中 · 05/18 13:00')).toBeTruthy();
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
    expect(listOrders).toHaveBeenLastCalledWith('buyer-session', cursor);
    expect(services.core.getOrderAllowedActions).not.toHaveBeenCalled();
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
    for (const label of ['Locked', 'Available', 'Requested', 'Batched', 'Settled']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(finalSafeTxHash)).toBeTruthy();
    for (const label of ['创世', '直推', '区县', '城市', '省', '大区', '运维', '取整余数']) {
      expect(screen.getByText(label)).toBeTruthy();
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
    const services = readyServices({
      listNotifications: vi.fn().mockResolvedValue([notificationItem]),
      registerNotificationEndpoint,
    });
    renderAt('/assets/notifications', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'SettlementFinalized' });
    expect(screen.getByText(finalSafeTxHash)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '启用站内通知' }));
    await waitFor(() => expect(registerNotificationEndpoint).toHaveBeenCalledWith('buyer-session', {
      channel: 'IN_APP',
      provider: 'CORE',
      endpointReference: `recipient://wallet/${BUYER}`,
      topics: ['*'],
    }));
    expect(await screen.findByText('CORE · ACTIVE')).toBeTruthy();
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
      artifactVersion, wallet: BUYER, accountId: null, accountIdStatus: 'DecisionBlocked',
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
    getCurrentPosition: vi.fn().mockResolvedValue({ latitude: store.latitude, longitude: store.longitude }),
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
  await user.type(screen.getByLabelText('收货人'), '张三');
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.type(screen.getByLabelText('详细地址'), '辽宁省大连市中山区示例路 24 号');
  await user.click(screen.getByRole('button', { name: '验证快递目标' }));
  await screen.findByText('Core 目标已验证');
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
    blockCode: writesEnabled ? null : 'ExternalBlocked',
  };
}

const BUYER = '0x1111111111111111111111111111111111111111';

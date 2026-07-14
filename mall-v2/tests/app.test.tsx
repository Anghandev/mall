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
import {
  deliveryActions,
  deliveryOrder,
  deliveryOrderTarget,
  deliveryTarget,
  pickupTarget,
  store,
} from './fulfillment-fixtures';
import { paymentQuote, product } from './payment-fixtures';

function renderAt(path = '/seckill', services = offlineServices()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MallApp services={services} />
    </MemoryRouter>,
  );
}

describe('Mall V2 payment consumer', () => {
  it('consumes the coordinated fulfillment checkpoint and keeps payment writes fail closed', async () => {
    renderAt('/mall');

    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-fulfillment.1');
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toContain('CONFIRM_RECEIPT');
    expect(executableOrderActionNames).not.toContain('PAY_ORDER');
    expect(isCoreOrderActionExecutable('CONFIRM_RECEIPT')).toBe(true);
    expect(isCoreOrderActionExecutable('PAY_ORDER')).toBe(false);
    expect(mallRuntimeBoundary).toMatchObject({
      artifactStatus: '2.0.0-fulfillment.1',
      executableOrderActions: executableOrderActionNames,
      deploymentAuthorized: false,
      sharedInterface: '@abu24k/core-artifacts',
    });
    await waitFor(() => expect(screen.getByText('暂无可售商品')).toBeTruthy());
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

  it('shows only frozen seckill rules and does not invent an unpublished session', async () => {
    const user = userEvent.setup();
    renderAt('/seckill');

    await user.click(screen.getByText('规则说明'));
    expect(screen.getByText(/主场固定 60 分钟/)).toBeTruthy();
    expect(screen.getByText(/增加 30 秒/)).toBeTruthy();
    expect(screen.getByText(/区块时间决定订单归类/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '支付并广播' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders Core stores, browser distance and keeps native navigation ExternalBlocked', async () => {
    const user = userEvent.setup();
    const services = readyServices();
    renderAt('/stores', services);

    await screen.findByRole('heading', { name: store.name });
    expect(screen.getByText('定位后显示')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '获取距离' }));
    await screen.findByText('0.0 km');
    expect(screen.getByRole('link', { name: `拨打 ${store.name} 电话` }).getAttribute('href')).toBe(`tel:${store.phone}`);
    expect(screen.getByRole('button', { name: '导航' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/原生地图桥接.*ExternalBlocked/)).toBeTruthy();
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

  it('renders wallet-scoped orders, logistics, BNM and server allowedActions fail closed', async () => {
    const user = userEvent.setup();
    const services = readyServices({
      listOrders: vi.fn().mockResolvedValue([deliveryOrder]),
      getOrderAllowedActions: vi.fn().mockResolvedValue(deliveryActions),
      getOrderTarget: vi.fn().mockResolvedValue(deliveryOrderTarget),
    });
    renderAt('/assets/orders', services);

    await user.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByText('BNM 后台积分');
    expect(screen.getByText('KUAIDI100 · 运输中 · 05/18 13:00')).toBeTruthy();
    expect(screen.getByText(deliveryOrder.exactAmounts.bnmAmount)).toBeTruthy();
    expect(screen.getByText(/13800138000/)).toBeTruthy();
    const exchange = screen.getByRole('button', { name: '申请换货' });
    expect(exchange.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/canonical evidence 生成\/上传契约尚未发布/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('UnknownState')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
  });

  it('keeps unpublished fulfillment, reward and device capabilities fail closed', () => {
    renderAt('/assets/rewards');
    expect(screen.getByRole('heading', { name: '消费产出池' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /创世/ })).toBeNull();
    expect(screen.getByRole('button', { name: '自主提取 BNM' }).hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
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
    listStores: vi.fn().mockResolvedValue([store]),
    ...overrides,
  });
}

function servicesWith(overrides: Partial<CoreClient>): MallServices {
  let pendingSubmission: PendingSubmission | null = null;
  const core: CoreClient = {
    getBootstrap: vi.fn().mockResolvedValue(bootstrap(false)),
    listCatalog: vi.fn().mockResolvedValue([]),
    authenticate: vi.fn().mockResolvedValue({ token: 'buyer-session', walletAddress: BUYER, roles: ['BUYER'] }),
    createOrdinaryQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    createSeckillQuote: vi.fn().mockRejectedValue(new Error('not configured')),
    submitPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    getPayment: vi.fn().mockRejectedValue(new Error('not configured')),
    listStores: vi.fn().mockResolvedValue([]),
    createDeliveryTarget: vi.fn().mockResolvedValue(deliveryTarget),
    createPickupTarget: vi.fn().mockResolvedValue(pickupTarget),
    listOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderAllowedActions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const wallet: WalletGateway = {
    connect: vi.fn().mockResolvedValue(BUYER),
    signMessage: vi.fn().mockResolvedValue('0xsigned'),
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
    submissionStore: {
      load: (walletAddress) => pendingSubmission?.walletAddress === walletAddress.toLowerCase() ? pendingSubmission : null,
      save: (submission) => { pendingSubmission = submission; },
      clear: () => { pendingSubmission = null; },
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

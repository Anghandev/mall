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
import { paymentQuote, product, seckillQuote } from './payment-fixtures';
import { relayEvent, seckillSession, seckillSessionId } from './seckill-fixtures';
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
  it('consumes the coordinated fulfillment checkpoint and keeps payment writes fail closed', async () => {
    renderAt('/mall');

    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-settlement-admin.2');
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toContain('CONFIRM_RECEIPT');
    expect(executableOrderActionNames).not.toContain('PAY_ORDER');
    expect(isCoreOrderActionExecutable('CONFIRM_RECEIPT')).toBe(true);
    expect(isCoreOrderActionExecutable('PAY_ORDER')).toBe(false);
    expect(mallRuntimeBoundary).toMatchObject({
      artifactStatus: '2.0.0-settlement-admin.2',
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
    expect(screen.getByText(current.product.seckillListPriceUsdt, { exact: false })).toBeTruthy();
    expect(screen.getByText(current.prizePoolUsdt, { exact: false })).toBeTruthy();
    if (phase === 'LIVE') {
      expect(screen.getByText('00:59:00')).toBeTruthy();
      expect(screen.getByText('00:01:00')).toBeTruthy();
    }
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
      skuId: product.skus[0]!.skuId,
    }));
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

  it('renders public CMS content without inventing a local content response', async () => {
    renderAt('/mall', readyServices({ listPublicCms: vi.fn().mockResolvedValue([publicCmsItem]) }));
    await screen.findByRole('heading', { name: '结算中心已开放' });
    expect(screen.getByText('RELEASE_ANNOUNCEMENT · V2')).toBeTruthy();
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
    getCurrentSeckillSession: vi.fn().mockRejectedValue(new CoreClientError('UnknownState', 'no session')),
    listSeckillSessionHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSeckillSession: vi.fn().mockRejectedValue(new Error('not configured')),
    listSeckillSessionEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: '0' }),
    listStores: vi.fn().mockResolvedValue([]),
    createDeliveryTarget: vi.fn().mockResolvedValue(deliveryTarget),
    createPickupTarget: vi.fn().mockResolvedValue(pickupTarget),
    listOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderTarget: vi.fn().mockRejectedValue(new Error('not configured')),
    getOrderAllowedActions: vi.fn().mockResolvedValue([]),
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

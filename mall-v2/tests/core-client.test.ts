import { artifactVersion } from '@abu24k/core-artifacts';
import { TypedDataEncoder } from 'ethers';
import { vi } from 'vitest';

import {
  coordinatedFulfillmentOperations,
  coordinatedPaymentOperations,
  coordinatedSettlementAdminOperations,
  createCoreClient,
  type QuoteSelection,
} from '../src/core-client';
import { paymentAuthorizationTypes } from '../src/payment-integrity';
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
  publicCmsItem,
  requestedSettlement,
  settlementIntent,
  settlementProjection,
} from './settlement-fixtures';

const HASH = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;

describe('coordinated Core HTTP client', () => {
  it('derives every payment path from coordinated OpenAPI', () => {
    expect(coordinatedPaymentOperations).toEqual({
      bootstrap: '/v2/bootstrap',
      nonce: '/v2/auth/nonce',
      verify: '/v2/auth/verify',
      catalog: '/v2/catalog/products',
      ordinaryQuote: '/v2/payments/quotes',
      seckillQuote: '/v2/seckill/quotes',
      submission: '/v2/payments/submissions',
      payment: '/v2/payments/{orderId}',
    });
  });

  it('derives every Mall fulfillment path from coordinated OpenAPI', () => {
    expect(coordinatedFulfillmentOperations).toEqual({
      allowedActions: '/v2/actions/order',
      stores: '/v2/stores',
      deliveryTarget: '/v2/fulfillment-targets/delivery',
      pickupTarget: '/v2/fulfillment-targets/pickup',
      orders: '/v2/orders',
      order: '/v2/orders/{orderId}',
      orderTarget: '/v2/orders/{orderId}/fulfillment-target',
    });
  });

  it('derives settlement, CMS and notification paths from coordinated OpenAPI', () => {
    expect(coordinatedSettlementAdminOperations).toEqual({
      settlements: '/v2/settlements',
      settlementIntent: '/v2/settlement-intents',
      settlementRequest: '/v2/settlement-requests',
      publicCms: '/v2/cms/public',
      notifications: '/v2/notifications',
      notificationEndpoint: '/v2/notification-endpoints',
    });
  });

  it('consumes settlement, public CMS and notification DTOs without a parallel schema', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/v2/settlements')) return json(settlementProjection);
      if (url.endsWith('/v2/settlement-intents')) return json(settlementIntent, 201);
      if (url.endsWith('/v2/settlement-requests')) return json(requestedSettlement, 201);
      if (url.endsWith(`/v2/cms/public?walletAddress=${settlementProjection.wallet}`)) return json([publicCmsItem]);
      if (url.endsWith('/v2/notifications?limit=25')) return json([]);
      if (url.endsWith('/v2/notification-endpoints')) return json({
        endpointId: 'notification-endpoint-1', channel: 'IN_APP', provider: 'CORE', topics: ['*'], state: 'ACTIVE',
      }, 201);
      throw new Error(`unexpected URL ${url}`);
    });
    const client = createCoreClient({ baseUrl: 'https://core.mall.test', fetch: fetcher });
    const endpoint = { channel: 'IN_APP' as const, provider: 'CORE' as const, endpointReference: `recipient://wallet/${settlementProjection.wallet}`, topics: ['*'] };

    expect(await client.listSettlements('session')).toEqual(settlementProjection);
    expect(await client.createSettlementIntent('session', { rail: 'REWARD_NPL', amount: '200', idempotencyKey: 'mall-settlement-1' })).toEqual(settlementIntent);
    expect(await client.submitSettlementRequest('session', { intentId: settlementIntent.intent.intentId, signature: '0xsigned' })).toEqual(requestedSettlement);
    expect(await client.listPublicCms(settlementProjection.wallet)).toEqual([publicCmsItem]);
    expect(await client.listNotifications('session', 25)).toEqual([]);
    expect((await client.registerNotificationEndpoint('session', endpoint)).state).toBe('ACTIVE');

    for (const call of calls.filter((entry) => !entry.url.includes('/v2/cms/public'))) {
      expect((call.init?.headers as Record<string, string>)?.authorization).toBe('Bearer session');
    }
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/v2/settlement-intents'))?.init?.body))).toEqual({
      rail: 'REWARD_NPL', amount: '200', idempotencyKey: 'mall-settlement-1',
    });
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/v2/notification-endpoints'))?.init?.body))).toEqual(endpoint);
  });

  it('rejects malformed settlement, CMS and notification projections', async () => {
    const malformedSettlement = structuredClone(settlementProjection);
    (malformedSettlement.balances[0] as { state: string }).state = 'CLAIMABLE';
    await expect(createCoreClient({ fetch: vi.fn().mockResolvedValue(json(malformedSettlement)) }).listSettlements('session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    await expect(createCoreClient({ fetch: vi.fn().mockResolvedValue(json([{ ...publicCmsItem, content: [] }])) }).listPublicCms())
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    await expect(createCoreClient({ fetch: vi.fn().mockResolvedValue(json([{ deliveryState: 'UNKNOWN' }])) }).listNotifications('session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('consumes stores, checkout targets, wallet orders and allowedActions without parallel schemas', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/v2/stores?regionCode=210202')) return json({ stores: [store] });
      if (url.endsWith('/v2/fulfillment-targets/delivery')) return json(deliveryTarget, 201);
      if (url.endsWith('/v2/fulfillment-targets/pickup')) return json(pickupTarget, 201);
      if (url.endsWith('/v2/orders')) return json({ orders: [deliveryOrder] });
      if (url.endsWith(`/v2/orders/${deliveryOrder.orderId}/fulfillment-target`)) return json({ target: deliveryOrderTarget });
      if (url.endsWith(`/v2/orders/${deliveryOrder.orderId}`)) return json({ order: deliveryOrder });
      if (url.endsWith('/v2/actions/order')) return json({ allowedActions: deliveryActions });
      throw new Error(`unexpected URL ${url}`);
    });
    const client = createCoreClient({ baseUrl: 'https://core.mall.test', fetch: fetcher });
    const targetDraft = {
      idempotencyKey: 'mall-target-1234',
      recipientName: '张三',
      phone: '13800138000',
      address: '辽宁省大连市中山区示例路 24 号',
      longitude: 121.6389,
      latitude: 38.914,
    };

    expect(await client.listStores('210202')).toEqual([store]);
    expect(await client.createDeliveryTarget('session', targetDraft)).toEqual(deliveryTarget);
    expect(await client.createPickupTarget('session', { idempotencyKey: 'mall-pickup-1234', storeId: store.storeId })).toEqual(pickupTarget);
    expect(await client.listOrders('session')).toEqual([deliveryOrder]);
    expect(await client.getOrder('session', deliveryOrder.orderId)).toEqual(deliveryOrder);
    expect(await client.getOrderTarget('session', deliveryOrder.orderId)).toEqual(deliveryOrderTarget);
    expect(await client.getOrderAllowedActions('session', deliveryOrder.orderId)).toEqual(deliveryActions);

    const protectedCalls = calls.filter((call) => !call.url.includes('/v2/stores'));
    expect(protectedCalls.every((call) => (call.init?.headers as Record<string, string>)?.authorization === 'Bearer session')).toBe(true);
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/v2/fulfillment-targets/delivery'))?.init?.body))).toEqual(targetDraft);
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/v2/actions/order'))?.init?.body))).toEqual({ orderId: deliveryOrder.orderId });
  });

  it('uses generated responses and passes exact quote/routerCall fields through unchanged', async () => {
    const quote = paymentQuote();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/v2/bootstrap')) return json(bootstrap());
      if (url.endsWith('/v2/catalog/products')) return json({ products: [product] });
      if (url.endsWith('/v2/auth/nonce')) return json({ message: 'Sign in to Abu 24K V2' }, 201);
      if (url.endsWith('/v2/auth/verify')) return json({ token: 'session', walletAddress: quote.intent.buyer, roles: ['BUYER'] });
      if (url.endsWith('/v2/payments/quotes')) return json(quote, 201);
      if (url.endsWith('/v2/payments/submissions')) return json({ orderId: quote.orderId, txHash: HASH_2, state: 'SUBMITTED' }, 202);
      if (url.includes('/v2/payments/')) return json({ ...quote, state: 'SUBMITTED', submittedTxHash: HASH_2, finality: null });
      throw new Error(`unexpected URL ${url}`);
    });
    const client = createCoreClient({ baseUrl: 'https://core.mall.test/', fetch: fetcher });

    expect((await client.getBootstrap()).artifactVersion).toBe(artifactVersion);
    expect(await client.listCatalog()).toEqual([product]);
    const signMessage = vi.fn().mockResolvedValue('0xsignature');
    const session = await client.authenticate(quote.intent.buyer, signMessage);
    expect(signMessage).toHaveBeenCalledWith('Sign in to Abu 24K V2');
    const response = await client.createOrdinaryQuote(session.token, selection());
    expect(response.intent).toStrictEqual(quote.intent);
    expect(response.approvalRequirements).toStrictEqual(quote.approvalRequirements);
    expect(response.routerCall).toStrictEqual(quote.routerCall);
    await client.submitPayment(session.token, { orderId: quote.orderId, txHash: HASH_2 });
    const projection = await client.getPayment(session.token, quote.orderId);
    expect(projection.state).toBe('SUBMITTED');
    expect(projection.finality).toBeNull();

    const quoteCall = calls.find((call) => call.url.endsWith('/v2/payments/quotes'));
    expect(quoteCall?.init?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer session' });
    expect(JSON.parse(String(quoteCall?.init?.body))).toEqual({
      idempotencyKey: 'mall-checkout-1',
      productId: product.productId,
      skuId: product.skus[0]?.skuId,
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH_2,
    });
  });

  it('uses the published seckill endpoint and keeps both signed legs opaque', async () => {
    const seckill = seckillQuote();
    const sessionId = seckill.dual.sessionId;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ sessionId, productId: product.productId });
      return json(seckill, 201);
    });
    const response = await createCoreClient({ fetch: fetcher }).createSeckillQuote('session', sessionId, selection());
    expect(response.dual.classificationAuthority).toBe('PAYMENT_ROUTER_BLOCK_TIMESTAMP');
    expect(response.routerCall).toStrictEqual(seckill.routerCall);
  });

  it('consumes authoritative seckill current/history/session/events operations', async () => {
    const live = seckillSession();
    const settled = seckillSession({ phase: 'SETTLED', storedPhase: 'SETTLED', winnerWallet: live.lastBuyerWallet });
    const event = relayEvent();
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/v2/seckill/sessions/current')) return json(live);
      if (url.endsWith('/v2/seckill/sessions/history?limit=20')) return json({ items: [settled], nextCursor: null });
      if (url.endsWith(`/v2/seckill/sessions/${seckillSessionId}`)) return json(live);
      if (url.endsWith(`/v2/seckill/sessions/${seckillSessionId}/events?cursor=0&limit=100`)) {
        return json({ items: [event], nextCursor: '1' });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const client = createCoreClient({ baseUrl: 'https://core.mall.test', fetch: fetcher });

    expect((await client.getCurrentSeckillSession()).phase).toBe('LIVE');
    expect((await client.listSeckillSessionHistory()).items[0]?.winnerWallet).toBe(live.lastBuyerWallet);
    expect((await client.getSeckillSession(seckillSessionId)).timers.relayIncrementSeconds).toBe(30);
    expect((await client.listSeckillSessionEvents(seckillSessionId)).items).toEqual([event]);
    expect(calls).toHaveLength(4);
  });

  it('rejects non-final realtime events and malformed reward/BNM projections', async () => {
    const nonFinal = { ...relayEvent(), finality: 'PENDING' };
    await expect(createCoreClient({
      fetch: vi.fn().mockResolvedValue(json({ items: [nonFinal], nextCursor: '1' })),
    }).listSeckillSessionEvents(seckillSessionId)).rejects.toMatchObject({ code: 'InvalidResponse' });

    const malformedReward = structuredClone(settlementProjection);
    (malformedReward.balances[0] as { rewardSubtype: string | null }).rewardSubtype = 'UNKNOWN';
    await expect(createCoreClient({ fetch: vi.fn().mockResolvedValue(json(malformedReward)) }).listSettlements('session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    const transferableBnm = structuredClone(settlementProjection);
    (transferableBnm.points[0] as { transferable: boolean }).transferable = true;
    await expect(createCoreClient({ fetch: vi.fn().mockResolvedValue(json(transferableBnm)) }).listSettlements('session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('surfaces typed Core blocks without inventing a successful fallback', async () => {
    const client = createCoreClient({
      fetch: vi.fn().mockResolvedValue(json({
        error: { code: 'ExternalBlocked', message: 'Payment infrastructure unavailable', correlationId: 'corr-1' },
      }, 503)),
    });
    await expect(client.createOrdinaryQuote('session', selection())).rejects.toMatchObject({
      code: 'ExternalBlocked',
      message: 'Payment infrastructure unavailable',
      correlationId: 'corr-1',
    });
  });

  it('rejects a response whose canonical display or validity differs from routerCall', async () => {
    const mismatched = structuredClone(paymentQuote());
    (mismatched.intent as { nplPaymentAmount: string }).nplPaymentAmount = '1';
    const mismatchedClient = createCoreClient({ fetch: vi.fn().mockResolvedValue(json(mismatched, 201)) });
    await expect(mismatchedClient.createOrdinaryQuote('session', selection())).rejects.toMatchObject({
      code: 'InvalidQuote',
    });

    const longLived = structuredClone(paymentQuote());
    (longLived.intent as { deadline: number }).deadline += 1;
    (longLived.routerCall.intent as { deadline: number }).deadline += 1;
    (longLived.buyerAuthorization.message as { deadline: number }).deadline += 1;
    const digest = TypedDataEncoder.hash(
      longLived.buyerAuthorization.domain,
      { PaymentAuthorization: paymentAuthorizationTypes.PaymentAuthorization.map((field) => ({ ...field })) },
      longLived.buyerAuthorization.message,
    );
    longLived.authorizationDigest = digest;
    longLived.buyerAuthorization.digest = digest;
    const longLivedClient = createCoreClient({ fetch: vi.fn().mockResolvedValue(json(longLived, 201)) });
    await expect(longLivedClient.createOrdinaryQuote('session', selection())).rejects.toThrow(/五分钟/);
  });
});

function selection(): QuoteSelection {
  return {
    idempotencyKey: 'mall-checkout-1',
    productId: product.productId,
    skuId: product.skus[0]!.skuId,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH,
    regionCodeHash: HASH_2,
    label: '已验证收货地址',
  };
}

function bootstrap() {
  return {
    artifactVersion,
    status: 'CORE_API_READY',
    readiness: {
      chainId: 56,
      assets: { usdt: '0x55d398326f99059ff775485246999027b3197955', npl: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2' },
      decisionBlocked: [],
      externalBlocked: [],
      paymentDecisionBlocked: [],
      paymentExternalBlocked: [],
      providers: {},
      writesEnabled: true,
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
  });
}

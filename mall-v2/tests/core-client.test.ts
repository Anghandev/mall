import { artifactVersion } from '@abu24k/core-artifacts';
import { TypedDataEncoder } from 'ethers';
import { vi } from 'vitest';

import {
  coordinatedPaymentOperations,
  createCoreClient,
  type QuoteSelection,
} from '../src/core-client';
import { paymentAuthorizationTypes } from '../src/payment-integrity';
import { paymentQuote, product, seckillQuote } from './payment-fixtures';

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

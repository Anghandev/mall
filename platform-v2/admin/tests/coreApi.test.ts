import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideArbitration,
  decideForcedReceipt,
  decideFulfillmentRequest,
  createWalletSession,
  fetchCatalogProducts,
  fetchCoreBootstrap,
  openArbitration,
  previewAdminOrderBatchActions,
  recordDelivery,
  recordShipment,
  searchAdminOrders,
} from '../src/coreApi';

afterEach(() => vi.unstubAllGlobals());

describe('coordinated fulfillment Core client', () => {
  it('rejects a bootstrap from a different artifact version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      artifactVersion: '2.0.0-stale',
      status: 'CORE_API_READY',
      readiness: {},
    })));

    await expect(fetchCoreBootstrap()).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('preserves a typed Core error and correlation ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: 'ExternalBlocked',
        message: 'DATABASE_URL is unavailable',
        correlationId: 'corr-payment-read',
      },
    }, 503)));

    await expect(fetchCatalogProducts()).rejects.toMatchObject({
      code: 'ExternalBlocked',
      correlationId: 'corr-payment-read',
      status: 503,
    });
  });

  it('accepts only the coordinated bootstrap shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      artifactVersion,
      status: 'CORE_API_READY',
      readiness: {
        chainId: 56,
        assets: {
          usdt: '0x55d398326f99059ff775485246999027b3197955',
          npl: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
        },
        decisionBlocked: [],
        externalBlocked: [],
        paymentDecisionBlocked: [],
        paymentExternalBlocked: [],
        providers: {},
        writesEnabled: true,
      },
    })));

    await expect(fetchCoreBootstrap()).resolves.toMatchObject({
      artifactVersion,
      readiness: { chainId: 56, writesEnabled: true },
    });
  });

  it('binds the Core session response to the wallet that signed the SIWE challenge', async () => {
    const signingWallet = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) {
        return jsonResponse({
          message: 'SIWE message',
          nonce: 'nonce-1',
          issuedAt: '2026-07-16T00:00:00.000Z',
          expiresAt: '2026-07-16T00:05:00.000Z',
        }, 201);
      }
      return jsonResponse({
        token: 'jwt',
        walletAddress: signingWallet.toLowerCase(),
        roles: ['ADMIN'],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => (
        method === 'eth_requestAccounts' ? [signingWallet] : '0xsignature'
      )),
    };

    await expect(createWalletSession(provider)).resolves.toMatchObject({
      walletAddress: signingWallet.toLowerCase(),
    });

    expect(provider.request).toHaveBeenNthCalledWith(2, {
      method: 'personal_sign',
      params: ['SIWE message', signingWallet],
    });
  });

  it('fails closed when Core verifies a SIWE session for a different wallet', async () => {
    const signingWallet = '0x1111111111111111111111111111111111111111';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/v2/auth/nonce')) {
        return jsonResponse({
          message: 'SIWE message',
          nonce: 'nonce-1',
          issuedAt: '2026-07-16T00:00:00.000Z',
          expiresAt: '2026-07-16T00:05:00.000Z',
        }, 201);
      }
      return jsonResponse({
        token: 'jwt',
        walletAddress: '0x2222222222222222222222222222222222222222',
        roles: ['ADMIN'],
      });
    }));
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => (
        method === 'eth_requestAccounts' ? [signingWallet] : '0xsignature'
      )),
    };

    await expect(createWalletSession(provider)).rejects.toMatchObject({
      code: 'InvalidResponse',
      status: 502,
    });
  });

  it('binds every published platform fulfillment command to its typed endpoint and order result', async () => {
    const orderId = hash('1');
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/shipments')) return jsonResponse({ orderId, state: 'SHIPPED', shipmentId: 'shipment-1', carrierCode: 'SF', trackingNumberHash: hash('3'), recordedAt: '2026-07-14T10:00:00.000Z' }, 201);
      if (url.endsWith('/delivery')) return jsonResponse({ orderId, state: 'DELIVERED', deliveredAt: '2026-07-14T11:00:00.000Z' });
      if (url.endsWith('/request-decisions')) return jsonResponse({ orderId, requestId: 'request-1', requestType: 'EXCHANGE', state: 'APPROVED', decidedAt: '2026-07-14T12:00:00.000Z' });
      if (url.endsWith('/arbitrations')) return jsonResponse({ orderId, requestId: 'arbitration-1', state: 'ARBITRATION', openedAt: '2026-07-14T13:00:00.000Z' }, 201);
      if (url.endsWith('/arbitration-decisions')) return jsonResponse({ orderId, state: 'FULFILLED', method: 'ARBITRATION', fulfilledAt: '2026-07-14T14:00:00.000Z' });
      if (url.endsWith('/forced-receipt-decisions')) return jsonResponse({ orderId, state: 'DELIVERED', approved: false, decidedAt: '2026-07-14T15:00:00.000Z' });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request', correlationId: 'command-test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const base = { idempotencyKey: 'admin-command-1', evidenceHash: hash('2') };

    await expect(recordShipment(orderId, { ...base, carrierCode: 'SF', trackingNumberHash: hash('3') }, 'jwt')).resolves.toMatchObject({ state: 'SHIPPED' });
    await expect(recordDelivery(orderId, base, 'jwt')).resolves.toMatchObject({ state: 'DELIVERED' });
    await expect(decideFulfillmentRequest(orderId, { ...base, requestId: 'request-1', approved: true, noteCode: 'EVIDENCE_VERIFIED' }, 'jwt')).resolves.toMatchObject({ state: 'APPROVED' });
    await expect(openArbitration(orderId, { ...base, reasonCode: 'ARBITRATION_REQUIRED' }, 'jwt')).resolves.toMatchObject({ state: 'ARBITRATION' });
    await expect(decideArbitration(orderId, { ...base, outcome: 'FULFILL', noteCode: 'FULFILLMENT_PROVEN' }, 'jwt')).resolves.toMatchObject({ state: 'FULFILLED', method: 'ARBITRATION' });
    await expect(decideForcedReceipt(orderId, { ...base, approved: false, noteCode: 'EVIDENCE_INCOMPLETE' }, 'jwt')).resolves.toMatchObject({ state: 'DELIVERED', approved: false });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/v2/orders/${orderId}/shipments`,
      `/v2/orders/${orderId}/delivery`,
      `/v2/orders/${orderId}/request-decisions`,
      `/v2/orders/${orderId}/arbitrations`,
      `/v2/orders/${orderId}/arbitration-decisions`,
      `/v2/orders/${orderId}/forced-receipt-decisions`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer jwt' } });
    }
  });

  it('rejects a fulfillment command result bound to a different order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      orderId: hash('2'),
      state: 'DELIVERED',
      deliveredAt: '2026-07-14T11:00:00.000Z',
    })));

    await expect(recordDelivery(hash('1'), {
      idempotencyKey: 'admin-command-1',
      evidenceHash: hash('3'),
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('serializes exact admin order filters and consumes full rows plus review and breaker projections', async () => {
    const order = fulfillmentOrder({ allowedActions: [{ action: 'OPEN_TAKEOVER', enabled: true }] });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      orders: [order],
      nextCursor: { createdAt: order.createdAt, orderId: order.orderId },
      pausedScopes: ['NEW_PAYMENT'],
      breaker: { scope: 'NEW_PAYMENT', active: true },
      pendingProductReview: true,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchAdminOrders('jwt', {
      orderId: order.orderId,
      productId: order.productId,
      txHash: order.paymentTxHash!,
      wallet: order.buyerWallet,
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
      pendingReview: true,
      breakerScope: 'NEW_PAYMENT',
      limit: 25,
    })).resolves.toMatchObject({
      orders: [{ quantity: '2', orderKind: 'ORDINARY', paymentTxHash: hash('4') }],
      breaker: { scope: 'NEW_PAYMENT', active: true },
      pendingProductReview: true,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://admin.local');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '25',
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
      orderId: order.orderId,
      productId: order.productId,
      txHash: order.paymentTxHash,
      wallet: order.buyerWallet,
      pendingReview: 'true',
      breakerScope: 'NEW_PAYMENT',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ authorization: 'Bearer jwt' });
  });

  it('fails closed on fuzzy wallet input before calling Core', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchAdminOrders('jwt', { wallet: '0x1234' })).rejects.toMatchObject({ code: 'InvalidResponse', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('consumes the read-only batch action preview without inventing an execution request', async () => {
    const orderIds = [hash('1'), hash('2')];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      rows: orderIds.map((orderId) => ({ orderId, allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] })),
      enabledActionIntersection: ['RECORD_SHIPMENT'],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewAdminOrderBatchActions(orderIds, 'jwt')).resolves.toMatchObject({
      enabledActionIntersection: ['RECORD_SHIPMENT'],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ orderIds });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(digit: string) {
  return `0x${digit.repeat(64)}`;
}

function fulfillmentOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: hash('1'),
    artifactVersion,
    buyerWallet: '0x1111111111111111111111111111111111111111',
    merchantId: 'merchant-1',
    merchantWallet: '0x2222222222222222222222222222222222222222',
    productId: 'product-1',
    skuId: 'sku-1',
    quantity: '2',
    createdAt: '2026-07-14T12:00:00.000Z',
    orderKind: 'ORDINARY',
    paymentTxHash: hash('4'),
    fulfillmentMode: 'DELIVERY',
    state: 'PAID',
    finalityStatus: 'FINAL',
    exactAmounts: {
      listPriceUsdt: '100', usdtPaymentAmount: '70', nplQuoteAmount: '30', nplPaymentAmount: '30', nplBurnAmount: '20',
      nplRewardAmount: '10', merchantBaseReceivableUsdt: '70', merchantConcessionAmount: '5', merchantNetReceivableUsdt: '65', bnmAmount: '100',
    },
    paidAt: '2026-07-14T12:00:00.000Z', paymentFinalizedAt: '2026-07-14T12:03:00.000Z', shippedAt: null,
    deliveredAt: null, fulfilledAt: null, takeoverOpenedAt: null, arbitrationOpenedAt: null,
    requests: [], shipments: [], logistics: [], balances: [], allowedActions: [],
    ...overrides,
  };
}

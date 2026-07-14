import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreApi } from '../src/core-api';
import {
  deliveryOrder,
  deliveryOrderId,
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

const originalFetch = globalThis.fetch;
const productHash = `0x${'a'.repeat(64)}`;
const skuHash = `0x${'b'.repeat(64)}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('settlement-admin.1 Core HTTP consumer', () => {
  it('uses the published SIWE nonce and verify request bodies without a password fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: 'merchant.test wants you to sign in',
        nonce: 'one-use-nonce',
        issuedAt: '2026-07-14T12:00:00.000Z',
        expiresAt: '2026-07-14T12:05:00.000Z',
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        token: 'merchant-session',
        walletAddress: '0x1111111111111111111111111111111111111111',
        roles: ['MERCHANT'],
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi();

    const challenge = await api.createSiweChallenge('0x1111111111111111111111111111111111111111');
    const session = await api.verifySiwe(challenge.message, '0xsigned');

    expect(session.roles).toEqual(['MERCHANT']);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v2/auth/nonce', expect.objectContaining({
      body: JSON.stringify({ walletAddress: '0x1111111111111111111111111111111111111111' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v2/auth/verify', expect.objectContaining({
      body: JSON.stringify({ message: challenge.message, signature: '0xsigned' }),
    }));
  });

  it('calls the official Catalog endpoint and validates generated product fields', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      products: [{
        productId: 'product-consumer',
        chainProductId: productHash,
        title: '核验商品',
        metadata: {},
        skus: [{
          skuId: 'sku-consumer',
          chainSkuId: skuHash,
          attributes: { size: 'standard' },
          listPriceUsdt: '1000000000000000000',
          stockAvailable: '7',
        }],
      }],
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const products = await createCoreApi('https://core.example.test/').listCatalog();

    expect(products[0]?.skus[0]?.stockAvailable).toBe('7');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example.test/v2/catalog/products',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-abu-artifact-version': '2.0.0-settlement-admin.1' }),
      }),
    );
  });

  it('sends the bearer session only to the published order-action endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: false, reasonCode: 'ConfigurationRequired' }],
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const actions = await createCoreApi().getOrderAllowedActions('order-1', 'session-token');

    expect(actions).toEqual([{ action: 'RECORD_SHIPMENT', enabled: false, reasonCode: 'ConfigurationRequired' }]);
    expect(fetchMock).toHaveBeenCalledWith('/v2/actions/order', expect.objectContaining({
      body: JSON.stringify({ orderId: 'order-1' }),
      headers: expect.objectContaining({ authorization: 'Bearer session-token' }),
    }));
  });

  it('reads wallet-scoped fulfillment orders and their immutable target snapshots', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ orders: [deliveryOrder, pickupOrder] }))
      .mockResolvedValueOnce(jsonResponse({ target: pickupTarget }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');

    const orders = await api.listFulfillmentOrders('merchant-session');
    const target = await api.getOrderFulfillmentTarget(pickupOrderId, 'merchant-session');

    expect(orders.map((order) => [order.orderId, order.fulfillmentMode])).toEqual([
      [deliveryOrderId, 'DELIVERY'],
      [pickupOrderId, 'PICKUP'],
    ]);
    expect(target).toEqual(pickupTarget);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://core.example.test/v2/orders', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://core.example.test/v2/orders/${pickupOrderId}/fulfillment-target`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }) }),
    );
  });

  it('submits the three published merchant fulfillment commands with exact generated bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        orderId: deliveryOrderId,
        state: 'SHIPPED',
        shipmentId: 'shipment-command-1',
        carrierCode: 'SF_EXPRESS',
        trackingNumberHash,
        recordedAt: '2026-07-14T12:00:00.000Z',
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        orderId: deliveryOrderId,
        requestId: 'forced-request-1',
        state: 'OPEN',
        platformReviewRequired: true,
        canFinalizeDirectly: false,
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        orderId: pickupOrderId,
        state: 'FULFILLED',
        method: 'PICKUP_VERIFICATION',
        fulfilledAt: '2026-07-14T12:05:00.000Z',
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi();
    const shipment = {
      idempotencyKey: 'shipment-command-key',
      evidenceHash,
      carrierCode: 'SF_EXPRESS',
      trackingNumberHash,
    };
    const receipt = {
      idempotencyKey: 'receipt-command-key',
      evidenceHash,
      reasonCode: 'DELIVERED_REVIEW',
    };
    const pickup = {
      idempotencyKey: 'pickup-command-key',
      evidenceHash,
      code: '123456',
      storeId: pickupTarget.storeId,
    };

    expect(await api.recordShipment(deliveryOrderId, shipment, 'merchant-session')).toMatchObject({ state: 'SHIPPED' });
    expect(await api.requestForcedReceipt(deliveryOrderId, receipt, 'merchant-session')).toMatchObject({
      platformReviewRequired: true,
      canFinalizeDirectly: false,
    });
    expect(await api.verifyPickup(pickupOrderId, pickup, 'merchant-session')).toMatchObject({
      state: 'FULFILLED',
      method: 'PICKUP_VERIFICATION',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/v2/orders/${deliveryOrderId}/shipments`, expect.objectContaining({
      body: JSON.stringify(shipment),
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/v2/orders/${deliveryOrderId}/forced-receipt-requests`, expect.objectContaining({
      body: JSON.stringify(receipt),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/v2/orders/${pickupOrderId}/pickup-verification`, expect.objectContaining({
      body: JSON.stringify(pickup),
    }));
  });

  it('rejects an unknown order state instead of trusting an uncoordinated projection', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      orders: [{ ...deliveryOrder, state: 'REFUNDED' }],
    })) as typeof fetch;

    await expect(createCoreApi().listFulfillmentOrders('merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('preserves each order artifact snapshot instead of rewriting it to the consumer version', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      orders: [{ ...deliveryOrder, artifactVersion: 'order-snapshot-version' }],
    })) as typeof fetch;

    const orders = await createCoreApi().listFulfillmentOrders('merchant-session');

    expect(orders[0]?.artifactVersion).toBe('order-snapshot-version');
  });

  it('rejects an artifact mismatch before the workspace trusts readiness', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      artifactVersion: '2.0.0-stale',
      status: 'CORE_API_READY',
      readiness: {},
    })) as typeof fetch;

    await expect(createCoreApi().bootstrap()).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('consumes the published merchant finance, guarantee and signed settlement routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(merchantFinance))
      .mockResolvedValueOnce(jsonResponse(settlementList))
      .mockResolvedValueOnce(jsonResponse(settlementIntent, 201))
      .mockResolvedValueOnce(jsonResponse(requestedSettlement, 201))
      .mockResolvedValueOnce(jsonResponse(guaranteeDepositResult, 201));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const settlementInput = {
      rail: 'MERCHANT_USDT' as const,
      amount: '45000000000000000000',
      idempotencyKey: 'merchant-settlement-consumer-1',
    };
    const requestInput = { intentId: settlementIntent.intent.intentId, signature: `0x${'12'.repeat(65)}` };
    const depositInput = {
      policyVersion: '9',
      expectedAmountUsdt: '1000000000000000000000',
      transactionHash: guaranteeDepositResult.transactionHash,
      idempotencyKey: 'merchant-guarantee-consumer-1',
    };

    expect((await api.getMerchantFinance('merchant-session')).merchant.guarantee_status).toBe('READY');
    expect((await api.listSettlements('merchant-session')).requests[2]?.final_safe_tx_hash)
      .toBe(settlementList.requests[2]?.final_safe_tx_hash);
    expect((await api.createSettlementIntent(settlementInput, 'merchant-session')).typedData)
      .toEqual(settlementIntent.typedData);
    expect((await api.submitSettlementRequest(requestInput, 'merchant-session')).state).toBe('REQUESTED');
    expect((await api.submitGuaranteeDeposit(depositInput, 'merchant-session')).state).toBe('SUBMITTED');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://core.example.test/v2/finance/merchant', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://core.example.test/v2/settlements', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://core.example.test/v2/settlement-intents', expect.objectContaining({
      body: JSON.stringify(settlementInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://core.example.test/v2/settlement-requests', expect.objectContaining({
      body: JSON.stringify(requestInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://core.example.test/v2/finance/merchant/guarantee-deposits',
      expect.objectContaining({ body: JSON.stringify(depositInput) }),
    );
  });

  it('refuses to sign a settlement typed-data message that differs from the immutable intent', async () => {
    const malformed = structuredClone(settlementIntent);
    (malformed.typedData.message as Record<string, unknown>).amount = '1';
    globalThis.fetch = vi.fn(async () => jsonResponse(malformed, 201)) as typeof fetch;

    await expect(createCoreApi().createSettlementIntent({
      rail: 'MERCHANT_USDT',
      amount: settlementIntent.intent.amount,
      idempotencyKey: 'merchant-settlement-malformed-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('rejects unknown guarantee finality states instead of presenting a false success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...guaranteeDepositResult,
      state: 'CONFIRMED_ENOUGH',
    }, 201)) as typeof fetch;

    await expect(createCoreApi().submitGuaranteeDeposit({
      policyVersion: '9',
      expectedAmountUsdt: '1',
      transactionHash: guaranteeDepositResult.transactionHash,
      idempotencyKey: 'merchant-guarantee-invalid-state-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('reads wallet-targeted published CMS rules from the coordinated public route', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([cmsRules]));
    globalThis.fetch = fetchMock as typeof fetch;

    const items = await createCoreApi('https://core.example.test').listPublicCms(
      '0x1111111111111111111111111111111111111111',
    );

    expect(items).toEqual([cmsRules]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example.test/v2/cms/public?walletAddress=0x1111111111111111111111111111111111111111',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('preserves a typed Core error and correlation ID', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      error: {
        code: 'Forbidden',
        message: 'Wallet is not authorized',
        correlationId: 'body-correlation',
      },
    }, 403, { 'x-correlation-id': 'header-correlation' })) as typeof fetch;

    await expect(createCoreApi().createSiweChallenge('0x1111111111111111111111111111111111111111'))
      .rejects.toMatchObject({
        code: 'Forbidden',
        correlationId: 'header-correlation',
      });
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideArbitration,
  decideForcedReceipt,
  decideFulfillmentRequest,
  fetchCatalogProducts,
  fetchCoreBootstrap,
  openArbitration,
  recordDelivery,
  recordShipment,
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
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(digit: string) {
  return `0x${digit.repeat(64)}`;
}

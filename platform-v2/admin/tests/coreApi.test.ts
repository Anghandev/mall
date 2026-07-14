import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCatalogProducts, fetchCoreBootstrap } from '../src/coreApi';

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
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

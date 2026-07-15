import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRiskRestriction,
  decideRiskAppeal,
  fetchRiskOverview,
  overrideRiskRestriction,
  submitRiskAppeal,
} from '../src/riskAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('risk/admin coordinated Core client', () => {
  it('strictly reads the generated overview with bearer authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(overview()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRiskOverview('jwt')).resolves.toMatchObject({
      artifactVersion,
      restrictions: [{ state: 'ACTIVE' }],
      appeals: [{ state: 'PENDING' }],
    });
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/risk/overview', {
      headers: { authorization: 'Bearer jwt' },
    });
  });

  it('rejects stale, additional and invalid generated DTO fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...overview(), artifactVersion: 'stale' }))
      .mockResolvedValueOnce(jsonResponse({ ...overview(), unexpected: true }))
      .mockResolvedValueOnce(jsonResponse({ ...overview(), restrictions: [restriction({ state: 'PAUSED' })] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRiskOverview('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(fetchRiskOverview('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(fetchRiskOverview('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('binds manual restriction, override, appeal and decision to the published endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/admin/risk/restrictions')) return jsonResponse(restriction(), 201);
      if (url.endsWith(`/v2/admin/risk/restrictions/${hash('1')}/override`)) return jsonResponse(restriction({ state: 'OVERRIDDEN', overrideBy: address('2'), overrideReasonCode: 'REVIEW_CLEARED', overrideEvidenceHash: hash('4'), overrideAt: '2026-07-16T01:00:00.000Z' }));
      if (url.endsWith('/v2/admin/risk/appeals')) return jsonResponse(appeal(), 201);
      if (url.endsWith(`/v2/admin/risk/appeals/${hash('6')}/decision`)) return jsonResponse(appeal({ state: 'APPROVED', decidedBy: address('2'), decisionReasonCode: 'APPEAL_ACCEPTED', decisionEvidenceHash: hash('8'), decidedAt: '2026-07-16T01:00:00.000Z' }));
      return jsonResponse({}, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await createRiskRestriction({
      subjectType: 'WALLET', subjectValue: address('1'), restrictionKind: 'NEW_PAYMENT',
      reasonCode: 'MANUAL_REVIEW', evidenceHash: hash('2'), idempotencyKey: 'risk-manual-1',
    }, 'jwt');
    await overrideRiskRestriction(hash('1'), { reasonCode: 'REVIEW_CLEARED', evidenceHash: hash('4') }, 'jwt');
    await submitRiskAppeal({ restrictionId: hash('1'), statementHash: hash('7'), evidenceHash: hash('8'), idempotencyKey: 'risk-appeal-1' }, 'jwt');
    await decideRiskAppeal(hash('6'), { decision: 'APPROVE', reasonCode: 'APPEAL_ACCEPTED', evidenceHash: hash('8') }, 'jwt');

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/v2/admin/risk/restrictions',
      `/v2/admin/risk/restrictions/${hash('1')}/override`,
      '/v2/admin/risk/appeals',
      `/v2/admin/risk/appeals/${hash('6')}/decision`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { subjectType: 'WALLET', subjectValue: address('1'), restrictionKind: 'NEW_PAYMENT', reasonCode: 'MANUAL_REVIEW', evidenceHash: hash('2'), idempotencyKey: 'risk-manual-1' },
      { reasonCode: 'REVIEW_CLEARED', evidenceHash: hash('4') },
      { restrictionId: hash('1'), statementHash: hash('7'), evidenceHash: hash('8'), idempotencyKey: 'risk-appeal-1' },
      { decision: 'APPROVE', reasonCode: 'APPEAL_ACCEPTED', evidenceHash: hash('8') },
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' } });
  });

  it('validates subject-bound hashes and commands before reaching Core', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRiskRestriction({
      subjectType: 'IP', subjectValue: address('1'), restrictionKind: 'BLACKLIST',
      reasonCode: 'MANUAL_REVIEW', evidenceHash: hash('2'), idempotencyKey: 'risk-manual-1',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse', status: 400 });
    await expect(overrideRiskRestriction('bad-id', { reasonCode: 'REVIEW_CLEARED', evidenceHash: hash('4') }, 'jwt')).rejects.toMatchObject({ status: 400 });
    await expect(submitRiskAppeal({ restrictionId: hash('1'), statementHash: 'bad', evidenceHash: hash('8'), idempotencyKey: 'short' }, 'jwt')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves Core permission errors for UI fail-closed rendering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'Forbidden', message: 'Session cannot manage risk', correlationId: 'risk-forbidden' },
    }, 403)));

    await expect(createRiskRestriction({
      subjectType: 'WALLET', subjectValue: address('1'), restrictionKind: 'NEW_PAYMENT',
      reasonCode: 'MANUAL_REVIEW', evidenceHash: hash('2'), idempotencyKey: 'risk-manual-1',
    }, 'jwt')).rejects.toMatchObject({ code: 'Forbidden', status: 403, correlationId: 'risk-forbidden' });
  });
});

function overview() {
  return {
    artifactVersion,
    generatedAt: '2026-07-16T00:00:00.000Z',
    observations: [observation()],
    restrictions: [restriction()],
    appeals: [appeal()],
    decisionBlocked: [{ capability: 'LOW_HISTORY_WALLET_CLUSTERING', reasonCode: 'DecisionBlocked' }],
  };
}

function observation() {
  return {
    observationId: hash('a'), signalType: 'HIGH_GAS', sourceType: 'CHAIN_MONITOR', walletAddress: address('1'),
    ipHash: hash('b'), deviceHash: null, resourceId: 'order-1', txHash: hash('c'), gasPriceWei: '101',
    evidenceHash: hash('d'), observedAt: '2026-07-16T00:00:00.000Z', recordedAt: '2026-07-16T00:00:01.000Z',
  };
}

function restriction(overrides: Record<string, unknown> = {}) {
  return {
    restrictionId: hash('1'), subjectType: 'WALLET', subjectValue: address('1'), restrictionKind: 'NEW_PAYMENT',
    triggerType: 'HIGH_GAS', reasonCode: 'HIGH_GAS_THRESHOLD', evidenceHash: hash('2'), sourceObservationId: hash('a'),
    state: 'ACTIVE', startsAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-17T00:00:00.000Z', createdBy: null,
    overrideBy: null, overrideReasonCode: null, overrideEvidenceHash: null, overrideAt: null,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', ...overrides,
  };
}

function appeal(overrides: Record<string, unknown> = {}) {
  return {
    appealId: hash('6'), restrictionId: hash('1'), submittedBy: address('2'), statementHash: hash('7'), evidenceHash: hash('8'),
    state: 'PENDING', decidedBy: null, decisionReasonCode: null, decisionEvidenceHash: null, decidedAt: null,
    createdAt: '2026-07-16T00:30:00.000Z', updatedAt: '2026-07-16T00:30:00.000Z', ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

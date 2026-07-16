import {
  artifactVersion,
  type TakeoverAssignment,
  type TakeoverCandidateList,
  type TakeoverCase,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
} from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignTakeoverReplacementMerchant,
  getAdminTakeoverCase,
  listAdminTakeoverCases,
  listTakeoverCandidates,
} from '../src/takeoverCaseApi';
import { CoreApiError } from '../src/coreApi';

afterEach(() => vi.unstubAllGlobals());

describe('Admin takeover case API consumer', () => {
  it('serializes exact queue filters and the stable cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(caseList()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAdminTakeoverCases({
      state: 'FUNDED',
      originalMerchantId: 'merchant-1',
      replacementMerchantId: 'replacement-1',
      cursorOpenedAt: '2026-07-15T00:00:00.000Z',
      cursorCaseId: 'takeover-0',
      limit: 50,
    }, 'jwt')).resolves.toMatchObject({ artifactVersion, cases: [{ caseId: 'takeover-1' }] });

    expect(fetchMock).toHaveBeenCalledWith(
      '/v2/admin/takeover-cases?state=FUNDED&originalMerchantId=merchant-1&replacementMerchantId=replacement-1&cursorOpenedAt=2026-07-15T00%3A00%3A00.000Z&cursorCaseId=takeover-0&limit=50',
      expect.objectContaining({ headers: { authorization: 'Bearer jwt' } }),
    );
  });

  it('consumes generated detail and candidate DTOs from their published endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/admin/takeover-cases/takeover-1')) return jsonResponse(caseDetail());
      if (url.endsWith('/v2/admin/takeover-cases/takeover-1/candidates')) return jsonResponse(candidateList());
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAdminTakeoverCase('takeover-1', 'jwt')).resolves.toMatchObject({
      case: { caseId: 'takeover-1', currentAssignment: { replacementMerchantId: 'replacement-1' } },
      assignments: [{ version: 1 }],
    });
    await expect(listTakeoverCandidates('takeover-1', 'jwt')).resolves.toMatchObject({
      caseId: 'takeover-1',
      candidates: [{ merchantId: 'replacement-1' }, { merchantId: 'replacement-2' }],
    });
  });

  it('posts only the generated assignment request and binds the returned case and merchant', async () => {
    const result = { artifactVersion, assignment: assignment({
      assignmentId: hash('4'), version: 2, replacementMerchantId: 'replacement-2',
      replacementWallet: address('4'), supersedesAssignmentId: hash('1'),
    }) };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(assignTakeoverReplacementMerchant('takeover-1', {
      replacementMerchantId: 'replacement-2',
      reasonCode: 'WAREHOUSE_MATCH',
      evidenceHash: hash('e'),
      idempotencyKey: 'takeover-reassign-1',
    }, 'jwt')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/takeover-cases/takeover-1/assignments', {
      body: JSON.stringify({
        replacementMerchantId: 'replacement-2',
        reasonCode: 'WAREHOUSE_MATCH',
        evidenceHash: hash('e'),
        idempotencyKey: 'takeover-reassign-1',
      }),
      headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
      method: 'POST',
    });
  });

  it('rejects incomplete cursors, invalid evidence and artifact/response drift before use', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(listAdminTakeoverCases({ cursorCaseId: 'takeover-1' }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });
    await expect(assignTakeoverReplacementMerchant('takeover-1', {
      replacementMerchantId: 'replacement-2', reasonCode: 'WAREHOUSE_MATCH', evidenceHash: '0x1234', idempotencyKey: 'takeover-reassign-2',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...caseList(), artifactVersion: 'stale' })));
    await expect(listAdminTakeoverCases({}, 'jwt')).rejects.toBeInstanceOf(CoreApiError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...candidateList(), candidates: [{ ...candidateList().candidates[0], guaranteeReady: false }] })));
    await expect(listTakeoverCandidates('takeover-1', 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });
});

export function caseList(overrides: Partial<TakeoverCaseList> = {}): TakeoverCaseList {
  return { artifactVersion, cases: [takeoverCase()], nextCursor: null, ...overrides };
}

export function caseDetail(overrides: Partial<TakeoverCaseDetail> = {}): TakeoverCaseDetail {
  const current = assignment();
  return {
    artifactVersion,
    case: {
      ...takeoverCase({ currentAssignment: current }),
      allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }],
    },
    assignments: [current],
    transitions: [{
      transitionId: 'transition-1', fromState: 'OPEN', toState: 'FUNDED', evidenceType: 'TAKEOVER_FUNDED',
      evidenceHash: hash('b'), occurredAt: '2026-07-15T01:00:00.000Z',
    }],
    ...overrides,
  };
}

export function candidateList(): TakeoverCandidateList {
  return {
    artifactVersion,
    caseId: 'takeover-1',
    candidates: [
      { merchantId: 'replacement-1', settlementWallet: address('3'), shopName: '北区仓', level: 'V3', applicationVersion: 4, qualificationComplete: true, guaranteeReady: true },
      { merchantId: 'replacement-2', settlementWallet: address('4'), shopName: '南区仓', level: 'V4', applicationVersion: 7, qualificationComplete: true, guaranteeReady: true },
    ],
  };
}

export function takeoverCase(overrides: Partial<TakeoverCase> = {}): TakeoverCase {
  return {
    caseId: 'takeover-1',
    orderId: 'order-1',
    originalMerchantId: 'merchant-1',
    policyVersion: '11',
    state: 'FUNDED',
    requiredUsdt: '100',
    funding: {
      guaranteeUsedUsdt: '40', frozenReceivablesUsedUsdt: '30', futureProceedsUsedUsdt: '20',
      platformAdvanceUsdt: '10', disbursedUsdt: '100', merchantDebtUsdt: '10',
    },
    evidenceHash: hash('a'),
    openedAt: '2026-07-15T00:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-07-15T01:00:00.000Z',
    order: {
      productId: 'product-1', skuId: 'sku-1', quantity: '2', fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: hash('f'), state: 'TAKEOVER', paymentFinal: true,
    },
    currentAssignment: assignment(),
    ...overrides,
  };
}

export function assignment(overrides: Partial<TakeoverAssignment> = {}): TakeoverAssignment {
  return {
    assignmentId: hash('1'), caseId: 'takeover-1', orderId: 'order-1', version: 1,
    originalMerchantId: 'merchant-1', replacementMerchantId: 'replacement-1', replacementWallet: address('3'),
    replacementApplicationVersion: 4, replacementLevel: 'V3', replacementLicenseAssetId: hash('2'),
    supersedesAssignmentId: null, reasonCode: 'REGION_MATCH', evidenceHash: hash('3'),
    assignedBy: address('1'), correlationId: 'takeover-assignment-test', assignedAt: '2026-07-15T00:30:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function hash(character: string) { return `0x${character.repeat(64)}`; }
export function address(character: string) { return `0x${character.repeat(40)}`; }

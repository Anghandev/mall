import {
  artifactVersion,
  type TakeoverAssignment,
  type TakeoverCandidateList,
  type TakeoverCase,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
  type UserRole,
} from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TakeoverCaseWorkspace } from '../src/components/TakeoverCaseWorkspace';

afterEach(() => vi.unstubAllGlobals());

describe('Admin takeover case workspace', () => {
  it('filters the real queue, renders immutable evidence and reassigns an eligible merchant', async () => {
    let reassigned = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v2/admin/takeover-cases?')) {
        return jsonResponse(caseList(reassigned ? takeoverCase({ currentAssignment: assignmentV2() }) : takeoverCase()));
      }
      if (url.endsWith('/v2/admin/takeover-cases/takeover-1/candidates')) return jsonResponse(candidateList());
      if (url.endsWith('/v2/admin/takeover-cases/takeover-1/assignments') && init?.method === 'POST') {
        reassigned = true;
        return jsonResponse({ artifactVersion, assignment: assignmentV2() }, 201);
      }
      if (url.endsWith('/v2/admin/takeover-cases/takeover-1')) {
        return jsonResponse(reassigned
          ? caseDetail({ case: { ...takeoverCase({ currentAssignment: assignmentV2() }), allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] }, assignments: [assignment(), assignmentV2()] })
          : caseDetail());
      }
      return unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<TakeoverCaseWorkspace connecting={false} session={session('ADMIN')} />);

    expect(screen.getByLabelText('正在读取接管案件')).toBeTruthy();
    expect(await screen.findByText('v1 · replacement-1')).toBeTruthy();
    expect(screen.getByText('OPEN → FUNDED')).toBeTruthy();
    expect(screen.getByText(/保证金 READY/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('案件状态'), 'FUNDED');
    await user.type(screen.getByLabelText('原商家 ID'), 'merchant-1');
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('state=FUNDED&originalMerchantId=merchant-1&limit=25'))).toBe(true));

    const assignmentForm = screen.getByRole('heading', { name: '发货前改派' }).closest('form')!;
    await user.selectOptions(within(assignmentForm).getByLabelText('替代商家'), 'replacement-2');
    await user.type(within(assignmentForm).getByLabelText('原因代码'), 'warehouse_match');
    await user.type(within(assignmentForm).getByLabelText('审计证据哈希'), hash('e'));
    await user.type(within(assignmentForm).getByLabelText('Idempotency key'), 'takeover-reassign-ui-1');
    await user.click(within(assignmentForm).getByRole('button', { name: '确认改派' }));

    expect(await screen.findByText('改派已由 Core 确认·v2·replacement-2')).toBeTruthy();
    expect(await screen.findByText('v2 · replacement-2')).toBeTruthy();
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/assignments') && init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      replacementMerchantId: 'replacement-2', reasonCode: 'WAREHOUSE_MATCH', evidenceHash: hash('e'), idempotencyKey: 'takeover-reassign-ui-1',
    });
  });

  it('keeps AUDITOR case and candidate evidence readable while every assignment write is unavailable', async () => {
    const fetchMock = takeoverFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<TakeoverCaseWorkspace connecting={false} session={session('AUDITOR')} />);

    expect(await screen.findByText('AUDITOR 只读')).toBeTruthy();
    expect(screen.getByText('v1 · replacement-1')).toBeTruthy();
    expect(screen.getByText('南区仓')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /确认分配|确认改派/ })).toBeNull();
    expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('renders true empty and ConfigurationRequired states without a production fixture fallback', async () => {
    const emptyFetch = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/admin/takeover-cases?')
      ? jsonResponse({ artifactVersion, cases: [], nextCursor: null })
      : unexpected(String(input)));
    vi.stubGlobal('fetch', emptyFetch);
    const view = render(<TakeoverCaseWorkspace connecting={false} session={session('OPERATOR')} />);
    expect(await screen.findByRole('heading', { name: '没有匹配案件' })).toBeTruthy();
    expect(screen.queryByText('北区仓')).toBeNull();

    view.unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'ConfigurationRequired', message: 'Takeover projection database is not configured', correlationId: 'takeover-config' },
    }, 503)));
    render(<TakeoverCaseWorkspace connecting={false} session={session('ADMIN')} />);
    expect(await screen.findByText('ConfigurationRequired')).toBeTruthy();
    expect(screen.getByText(/缺少生产配置，当前操作保持关闭/)).toBeTruthy();
    expect(screen.getByText('Takeover projection database is not configured')).toBeTruthy();
  });
});

function takeoverFetch() {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v2/admin/takeover-cases?')) return jsonResponse(caseList(takeoverCase()));
    if (url.endsWith('/v2/admin/takeover-cases/takeover-1/candidates')) return jsonResponse(candidateList());
    if (url.endsWith('/v2/admin/takeover-cases/takeover-1')) return jsonResponse(caseDetail());
    return unexpected(url);
  });
}

function caseList(item: TakeoverCase): TakeoverCaseList {
  return { artifactVersion, cases: [item], nextCursor: null };
}

function caseDetail(overrides: Partial<TakeoverCaseDetail> = {}): TakeoverCaseDetail {
  return {
    artifactVersion,
    case: { ...takeoverCase(), allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: true }] },
    assignments: [assignment()],
    transitions: [{ transitionId: 'transition-1', fromState: 'OPEN', toState: 'FUNDED', evidenceType: 'TAKEOVER_FUNDED', evidenceHash: hash('b'), occurredAt: '2026-07-15T01:00:00.000Z' }],
    ...overrides,
  };
}

function candidateList(): TakeoverCandidateList {
  return {
    artifactVersion,
    caseId: 'takeover-1',
    candidates: [
      { merchantId: 'replacement-1', settlementWallet: address('3'), shopName: '北区仓', applicationVersion: 4, qualificationComplete: true, guaranteeReady: true },
      { merchantId: 'replacement-2', settlementWallet: address('4'), shopName: '南区仓', applicationVersion: 7, qualificationComplete: true, guaranteeReady: true },
    ],
  };
}

function takeoverCase(overrides: Partial<TakeoverCase> = {}): TakeoverCase {
  return {
    caseId: 'takeover-1', orderId: 'order-1', originalMerchantId: 'merchant-1', policyVersion: '11', state: 'FUNDED', requiredUsdt: '100',
    funding: { guaranteeUsedUsdt: '40', frozenReceivablesUsedUsdt: '30', futureProceedsUsedUsdt: '20', platformAdvanceUsdt: '10', disbursedUsdt: '100', merchantDebtUsdt: '10' },
    evidenceHash: hash('a'), openedAt: '2026-07-15T00:00:00.000Z', closedAt: null, updatedAt: '2026-07-15T01:00:00.000Z',
    order: { productId: 'product-1', skuId: 'sku-1', quantity: '2', fulfillmentMode: 'DELIVERY', fulfillmentTargetHash: hash('f'), state: 'TAKEOVER', paymentFinal: true },
    currentAssignment: assignment(),
    ...overrides,
  };
}

function assignment(overrides: Partial<TakeoverAssignment> = {}): TakeoverAssignment {
  return {
    assignmentId: hash('1'), caseId: 'takeover-1', orderId: 'order-1', version: 1, originalMerchantId: 'merchant-1',
    replacementMerchantId: 'replacement-1', replacementWallet: address('3'), replacementApplicationVersion: 4, replacementLicenseAssetId: hash('2'),
    supersedesAssignmentId: null, reasonCode: 'REGION_MATCH', evidenceHash: hash('3'), assignedBy: address('1'), correlationId: 'takeover-assignment-ui', assignedAt: '2026-07-15T00:30:00.000Z',
    ...overrides,
  };
}

function assignmentV2() {
  return assignment({ assignmentId: hash('4'), version: 2, replacementMerchantId: 'replacement-2', replacementWallet: address('4'), replacementApplicationVersion: 7, replacementLicenseAssetId: hash('5'), supersedesAssignmentId: hash('1'), reasonCode: 'WAREHOUSE_MATCH', evidenceHash: hash('e'), assignedAt: '2026-07-15T02:00:00.000Z' });
}

function session(role: UserRole) {
  return { token: 'jwt', walletAddress: address('1'), roles: [role] as UserRole[] };
}

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function unexpected(url: string) { return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400); }
function hash(character: string) { return `0x${character.repeat(64)}`; }
function address(character: string) { return `0x${character.repeat(40)}`; }

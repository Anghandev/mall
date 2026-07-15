import { artifactVersion, type UserRole } from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

function renderRisk() {
  return render(<MemoryRouter initialEntries={['/risk']}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('platform risk workspace', () => {
  it('stays fail-closed before SIWE and renders a Core 403 without operational controls', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/risk/overview')) return jsonResponse({ error: { code: 'Forbidden', message: 'Risk scope revoked', correlationId: 'risk-403' } }, 403);
      return jsonResponse({}, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderRisk();
    expect(screen.getByRole('status', { name: '风控数据状态' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建人工限制' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('Risk scope revoked')).toBeTruthy();
    expect(screen.getByText('Forbidden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建人工限制' })).toBeNull();
  });

  it('keeps AUDITOR read-only and renders real empty states', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    vi.stubGlobal('fetch', roleFetch(wallet, 'AUDITOR', emptyOverview()));
    const user = userEvent.setup();
    renderRisk();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('AUDITOR 只读')).toBeTruthy();
    expect(screen.getByText('没有限制记录')).toBeTruthy();
    expect(screen.getByText('没有申诉记录')).toBeTruthy();
    expect(screen.getByText('没有异常观察')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '提交申诉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '创建人工限制' })).toBeNull();
  });

  it('allows OPERATOR to submit an appeal but exposes no admin action', async () => {
    const wallet = address('2');
    window.ethereum = walletProvider(wallet);
    const fetchMock = roleFetch(wallet, 'OPERATOR', overview());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderRisk();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('OPERATOR 只可提交申诉')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建人工限制' })).toBeNull();
    expect(screen.queryByRole('button', { name: '解除生效限制' })).toBeNull();
    expect(screen.queryByRole('button', { name: '提交裁决' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '选择申诉' }));
    const form = screen.getByRole('heading', { name: '提交申诉' }).closest('form')!;
    await user.type(within(form).getByLabelText('陈述哈希'), hash('7'));
    await user.type(within(form).getByLabelText('证据哈希'), hash('8'));
    await user.type(within(form).getByLabelText('幂等键'), 'risk-appeal-operator-1');
    await user.click(within(form).getByRole('button', { name: '提交申诉' }));

    expect(await screen.findByText('申诉已提交，等待 ADMIN 裁决。')).toBeTruthy();
    const appealCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v2/admin/risk/appeals'));
    expect(JSON.parse(String(appealCall?.[1]?.body))).toEqual({ restrictionId: hash('1'), statementHash: hash('7'), evidenceHash: hash('8'), idempotencyKey: 'risk-appeal-operator-1' });
  });

  it('renders every restriction state and binds all ADMIN commands to Core', async () => {
    const wallet = address('3');
    window.ethereum = walletProvider(wallet);
    const fetchMock = roleFetch(wallet, 'ADMIN', overview());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderRisk();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('ADMIN 可人工限制、解除、申诉和裁决')).toBeTruthy();
    expect(screen.getAllByText('ACTIVE').length).toBeGreaterThan(0);
    expect(screen.getByText('EXPIRED')).toBeTruthy();
    expect(screen.getByText('OVERRIDDEN')).toBeTruthy();
    expect(screen.getByText('LOW_HISTORY_WALLET_CLUSTERING')).toBeTruthy();

    const restrictionForm = screen.getByRole('heading', { name: '人工限制' }).closest('form')!;
    await user.type(within(restrictionForm).getByLabelText(/^主体值/), address('9'));
    await user.type(within(restrictionForm).getByLabelText('原因代码'), 'manual_review');
    await user.type(within(restrictionForm).getByLabelText('证据哈希'), hash('2'));
    await user.type(within(restrictionForm).getByLabelText('幂等键'), 'risk-admin-manual-1');
    await user.click(within(restrictionForm).getByRole('button', { name: '创建人工限制' }));
    expect(await screen.findByText('人工限制已由 Core 记录，正在刷新证据。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '选择解除' }));
    const overrideForm = screen.getByRole('heading', { name: '人工解除' }).closest('form')!;
    await user.type(within(overrideForm).getByLabelText('解除原因'), 'review_cleared');
    await user.type(within(overrideForm).getByLabelText('解除证据哈希'), hash('4'));
    await user.click(within(overrideForm).getByRole('button', { name: '解除生效限制' }));
    expect(await screen.findByText('限制已由 Core 标记为 OVERRIDDEN。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '选择裁决' }));
    const decisionForm = screen.getByRole('heading', { name: '申诉裁决' }).closest('form')!;
    await user.type(within(decisionForm).getByLabelText('裁决原因'), 'appeal_accepted');
    await user.type(within(decisionForm).getByLabelText('裁决证据哈希'), hash('8'));
    await user.click(within(decisionForm).getByRole('button', { name: '提交裁决' }));
    expect(await screen.findByText('申诉已批准，正在刷新证据。')).toBeTruthy();

    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('evidenceHash'));
    expect(writes.map(([input]) => String(input))).toEqual([
      '/v2/admin/risk/restrictions',
      `/v2/admin/risk/restrictions/${hash('1')}/override`,
      `/v2/admin/risk/appeals/${hash('6')}/decision`,
    ]);
  });
});

function roleFetch(wallet: string, role: UserRole, projection: ReturnType<typeof overview>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    if (url.endsWith('/v2/admin/risk/overview')) return jsonResponse(projection);
    if (url.endsWith('/v2/admin/risk/restrictions')) return jsonResponse(restriction(), 201);
    if (url.endsWith(`/v2/admin/risk/restrictions/${hash('1')}/override`)) return jsonResponse(restriction({ state: 'OVERRIDDEN', overrideBy: wallet, overrideReasonCode: 'REVIEW_CLEARED', overrideEvidenceHash: hash('4'), overrideAt: '2026-07-16T02:00:00.000Z' }));
    if (url.endsWith('/v2/admin/risk/appeals')) return jsonResponse(appeal(), 201);
    if (url.endsWith(`/v2/admin/risk/appeals/${hash('6')}/decision`)) return jsonResponse(appeal({ state: 'APPROVED', decidedBy: wallet, decisionReasonCode: 'APPEAL_ACCEPTED', decisionEvidenceHash: hash('8'), decidedAt: '2026-07-16T02:00:00.000Z' }));
    return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected risk request', correlationId: 'risk-ui' } }, 400);
  });
}

function overview() {
  return {
    artifactVersion,
    generatedAt: '2026-07-16T00:00:00.000Z',
    observations: [observation()],
    restrictions: [
      restriction(),
      restriction({ restrictionId: hash('3'), state: 'EXPIRED', expiresAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }),
      restriction({ restrictionId: hash('4'), state: 'OVERRIDDEN', overrideBy: address('4'), overrideReasonCode: 'REVIEW_CLEARED', overrideEvidenceHash: hash('5'), overrideAt: '2026-07-16T01:00:00.000Z' }),
    ],
    appeals: [appeal()],
    decisionBlocked: [{ capability: 'LOW_HISTORY_WALLET_CLUSTERING', reasonCode: 'DecisionBlocked' }],
  };
}

function emptyOverview() {
  return { ...overview(), observations: [], restrictions: [], appeals: [], decisionBlocked: [] };
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
    restrictionId: hash('1'), subjectType: 'WALLET', subjectValue: address('1'), restrictionKind: 'NEW_PAYMENT', triggerType: 'HIGH_GAS',
    reasonCode: 'HIGH_GAS_THRESHOLD', evidenceHash: hash('2'), sourceObservationId: hash('a'), state: 'ACTIVE',
    startsAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-17T00:00:00.000Z', createdBy: null, overrideBy: null,
    overrideReasonCode: null, overrideEvidenceHash: null, overrideAt: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', ...overrides,
  };
}

function appeal(overrides: Record<string, unknown> = {}) {
  return {
    appealId: hash('6'), restrictionId: hash('1'), submittedBy: address('2'), statementHash: hash('7'), evidenceHash: hash('8'), state: 'PENDING',
    decidedBy: null, decisionReasonCode: null, decisionEvidenceHash: null, decidedAt: null, createdAt: '2026-07-16T00:30:00.000Z', updatedAt: '2026-07-16T00:30:00.000Z', ...overrides,
  };
}

function walletProvider(wallet: string) {
  return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : '0xsigned') };
}

function nonceResponse() {
  return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:05:00.000Z' }, 201);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

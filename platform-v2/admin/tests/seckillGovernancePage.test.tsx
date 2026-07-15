import { artifactVersion, type SeckillGovernanceActionProjection, type SeckillSessionPlanProjection, type UserRole } from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

function renderSeckill() {
  return render(<MemoryRouter initialEntries={['/seckill']}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('seckill governance workspace', () => {
  it('keeps governance closed before SIWE and AUDITOR read-only after authentication', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const action = governanceAction();
    const fetchMock = governanceFetch(wallet, 'AUDITOR', [action]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderSeckill();
    expect(screen.getByText('连接平台钱包')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v2/admin/seckill/actions'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('AUDITOR · 只读')).toBeTruthy();
    expect(screen.getByText(action.actionId)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '创建场次草稿' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '强制截止' })).toBeNull();
    expect(screen.getByRole('button', { name: '请求二次钱包签名' }).hasAttribute('disabled')).toBe(true);
  });

  it('allows OPERATOR to create and cancel an unproposed opening action with fixed timers read-only', async () => {
    const wallet = address('2');
    window.ethereum = walletProvider(wallet);
    let currentActions: SeckillGovernanceActionProjection[] = [];
    const fetchMock = governanceFetch(wallet, 'OPERATOR', currentActions, async (url, init) => {
      if (url.endsWith('/v2/admin/seckill/sessions')) {
        const created = governanceAction({ actorWallet: wallet }); currentActions = [created];
        return jsonResponse(created, 201);
      }
      if (url.endsWith('/cancel')) {
        const cancelled = governanceAction({ actorWallet: wallet, state: 'CANCELLED', allowedActions: [], sessionPlan: { ...sessionPlan(), inventoryLockState: 'RELEASED', releasedAt: '2026-07-16T01:00:00.000Z' } });
        currentActions = [cancelled]; return jsonResponse(cancelled);
      }
      if (url.includes('/v2/admin/seckill/actions/')) return jsonResponse(currentActions[0]);
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderSeckill();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    expect(await screen.findByText('OPERATOR · 建场/取消开场草稿')).toBeTruthy();
    const timers = screen.getByLabelText('固定秒杀计时参数');
    expect(within(timers).getByText('3600s')).toBeTruthy();
    expect(within(timers).getAllByText('60s')).toHaveLength(2);
    expect(within(timers).queryByRole('textbox')).toBeNull();

    const form = screen.getByRole('heading', { name: '创建场次草稿' }).closest('form')!;
    await user.type(within(form).getByLabelText('Policy version'), '2');
    await user.type(within(form).getByLabelText('Rules content hash'), hash('2'));
    await user.type(within(form).getByLabelText('Product ID'), 'product-1');
    await user.type(within(form).getByLabelText('SKU ID'), 'sku-1');
    await user.clear(within(form).getByLabelText('活动库存')); await user.type(within(form).getByLabelText('活动库存'), '4');
    await user.type(within(form).getByLabelText('秒杀价 · USDT atomic'), '80');
    await user.type(within(form).getByLabelText('开始时间 · ISO 8601'), '2026-07-18T01:00:00.000Z');
    await user.type(within(form).getByLabelText('Idempotency key'), 'seckill-session-1');
    await user.click(within(form).getByRole('button', { name: '创建并锁定活动库存' }));

    expect(await screen.findByText(/场次草稿已创建/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消未提案动作' }));
    expect(await screen.findByText(/动作已取消/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/cancel'))).toBe(true);
  });

  it('uses the independent challenge signer and waits for Safe finality after proposal', async () => {
    const wallet = address('1');
    const signer = address('2');
    const action = governanceAction();
    let detail = action;
    const challenge = governanceChallenge(action, signer, '7', '1800000000');
    const provider = walletProvider(wallet, challenge);
    window.ethereum = provider;
    const fetchMock = governanceFetch(wallet, 'ADMIN', [action], async (url) => {
      if (url.endsWith('/approval-challenge')) return jsonResponse(challenge);
      if (url.endsWith('/secondary-signature')) {
        detail = governanceAction({ state: 'SECONDARY_SIGNED', secondarySigner: signer, approvalNonce: '7', approvalDeadline: new Date(1_800_000_000 * 1_000).toISOString(), allowedActions: ['PROPOSE_SAFE', 'CANCEL'] });
        return jsonResponse(detail);
      }
      if (url.endsWith('/safe-proposal')) {
        detail = governanceAction({ ...detail, state: 'PENDING_PROPOSAL', allowedActions: [] });
        return jsonResponse(detail, 202);
      }
      if (url.includes('/v2/admin/seckill/actions/')) return jsonResponse(detail);
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderSeckill();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.type(await screen.findByLabelText('Approval nonce'), '7');
    await user.type(screen.getByLabelText('Deadline · Unix seconds'), '1800000000');
    await user.click(screen.getByRole('button', { name: '请求二次钱包签名' }));

    await waitFor(() => expect(provider.request).toHaveBeenCalledWith({
      method: 'eth_signTypedData_v4', params: [signer, JSON.stringify(challenge.typedData)],
    }));
    expect(await screen.findByText(/尚未提交 Safe/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '提交 Safe 提案' }));
    expect(await screen.findByText(/Safe 提案请求已提交/)).toBeTruthy();
    expect(screen.getAllByText('PENDING_PROPOSAL').length).toBeGreaterThan(0);
    expect(screen.queryByText(/FINAL · 已终局/)).toBeNull();
  });

  it('binds ADMIN force-close, prize injection and breaker resume forms to Core', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const sessionId = hash('b');
    const fetchMock = governanceFetch(wallet, 'ADMIN', [], async (url) => {
      if (url.endsWith('/force-close')) return jsonResponse(governanceAction({ actionKind: 'FORCE_CLOSE', sessionPlan: null }), 201);
      if (url.endsWith('/prize-injections')) return jsonResponse(governanceAction({ actionKind: 'PRIZE_INJECTION', sessionPlan: null, prizeInjection: prizeInjection() }), 201);
      if (url.endsWith('/breaker/resume')) return jsonResponse(governanceAction({ actionKind: 'RESUME_PURCHASES', sessionPlan: null }), 201);
      if (url.includes('/v2/admin/seckill/actions/')) return jsonResponse(governanceAction());
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderSeckill();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    const target = await screen.findByLabelText('Session ID');
    await user.type(target, sessionId);

    const closeForm = screen.getByRole('heading', { name: '强制截止' }).closest('form')!;
    await user.type(within(closeForm).getByLabelText('原因代码'), 'operations_stop');
    await user.type(within(closeForm).getByLabelText('Idempotency key'), 'seckill-close-1');
    await user.click(within(closeForm).getByRole('button', { name: '创建强制截止动作' }));
    expect(await screen.findByText(/强制截止治理动作已创建/)).toBeTruthy();

    const prizeForm = screen.getByRole('heading', { name: '奖池注入' }).closest('form')!;
    await user.type(within(prizeForm).getByLabelText('金额 · USDT atomic'), '50');
    await user.type(within(prizeForm).getByLabelText('Idempotency key'), 'seckill-prize-1');
    await user.click(within(prizeForm).getByRole('button', { name: '创建奖池注入动作' }));
    expect(await screen.findByText(/奖池注入动作已创建/)).toBeTruthy();

    const resumeForm = screen.getByRole('heading', { name: '恢复购买' }).closest('form')!;
    await user.type(within(resumeForm).getByLabelText('Idempotency key'), 'seckill-resume-1');
    await user.click(within(resumeForm).getByRole('button', { name: '创建 breaker 恢复动作' }));
    expect(await screen.findByText(/秒杀购买恢复动作已创建/)).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/v2/admin/seckill/')).some((url) => url.endsWith('/prize-injections'))).toBe(true);
  });

  it('renders ConfigurationRequired, REORGED and FAILED without claiming finality', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const reorged = governanceAction({ state: 'REORGED', allowedActions: [], safeNonce: '3', safeTxHash: hash('3'), proposalHash: hash('4'), executionTxHash: hash('5'), blockNumber: '100', blockHash: hash('6'), canonical: false });
    const failed = governanceAction({ actionId: hash('f'), state: 'FAILED', allowedActions: [] });
    vi.stubGlobal('fetch', governanceFetch(wallet, 'ADMIN', [reorged, failed]));
    const user = userEvent.setup();
    renderSeckill();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect((await screen.findAllByText('REORGED · 已回滚')).length).toBeGreaterThan(0);
    expect(screen.getByText('FAILED · 未生效')).toBeTruthy();
    expect(screen.queryByText('FINAL · 已终局')).toBeNull();

    vi.unstubAllGlobals(); delete window.ethereum;
    window.ethereum = walletProvider(wallet);
    vi.stubGlobal('fetch', governanceFetch(wallet, 'ADMIN', [], async (url) => url.endsWith('/actions')
      ? jsonResponse({ error: { code: 'ConfigurationRequired', message: 'Safe service is not configured', correlationId: 'seckill-config' } }, 503)
      : undefined));
    renderSeckill();
    await user.click(screen.getAllByRole('button', { name: 'SIWE 连接' }).at(-1)!);
    expect(await screen.findByText('Safe service is not configured')).toBeTruthy();
    expect(screen.getByText('ConfigurationRequired')).toBeTruthy();
  });
});

type ExtraHandler = (url: string, init?: RequestInit) => Promise<Response | undefined>;

function governanceFetch(wallet: string, role: UserRole, initialActions: readonly SeckillGovernanceActionProjection[], extra?: ExtraHandler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    const handled = await extra?.(url, init); if (handled) return handled;
    if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse({ error: { code: 'UnknownState', message: 'No current seckill session', correlationId: 'seckill-none' } }, 404);
    if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
    if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse(initialActions);
    const actionId = url.match(/\/v2\/admin\/seckill\/actions\/(0x[0-9a-f]{64})$/i)?.[1];
    if (actionId) return jsonResponse(initialActions.find((item) => item.actionId === actionId) ?? initialActions[0]);
    return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}`, correlationId: 'seckill-ui' } }, 400);
  });
}

function governanceAction(overrides: Partial<SeckillGovernanceActionProjection> = {}): SeckillGovernanceActionProjection {
  return {
    artifactVersion, actionId: hash('a'), sessionId: hash('b'), policyVersion: '2', actionKind: 'OPEN_SESSION', state: 'DRAFT', evidenceHash: hash('c'),
    safeAddress: address('4'), targetAddress: address('5'), calldataHash: hash('d'), safeNonce: null, safeTxHash: null, proposalHash: null,
    executionTxHash: null, blockNumber: null, blockHash: null, confirmations: 0, canonical: null, actorWallet: address('1'), secondarySigner: null,
    approvalNonce: null, approvalDeadline: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
    sessionPlan: sessionPlan(), prizeInjection: null, allowedActions: ['APPROVE_SECONDARY', 'CANCEL'], ...overrides,
  };
}

function sessionPlan(): SeckillSessionPlanProjection {
  return { merchantId: 'merchant-1', productId: 'product-1', skuId: 'sku-1', productPolicyHash: hash('1'), rulesContentHash: hash('2'), startsAt: '2026-07-18T01:00:00.000Z', mainDeadline: '2026-07-18T02:00:00.000Z', relayDeadline: '2026-07-18T01:01:00.000Z', inventory: '4', seckillListPriceUsdt: '80', timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 }, snapshot: {}, inventoryLockState: 'LOCKED', releasedAt: null };
}

function prizeInjection() {
  return { injectionId: hash('a'), amountUsdt: '50', operationsSafeAddress: address('6'), custodySafeAddress: address('7'), tokenAddress: address('8'), finalJournalId: null, reversalJournalId: null };
}

function governanceChallenge(action: SeckillGovernanceActionProjection, signer: string, nonce: string, deadline: string) {
  return { artifactVersion, actionId: action.actionId, sessionId: action.sessionId, actionKind: action.actionKind, signer, safeAddress: action.safeAddress, typedData: { domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: action.targetAddress }, types: { SensitiveAction: [{ name: 'action', type: 'string' }, { name: 'resourceType', type: 'string' }, { name: 'resourceId', type: 'string' }, { name: 'policyVersion', type: 'uint64' }, { name: 'oldValueHash', type: 'bytes32' }, { name: 'newValueHash', type: 'bytes32' }, { name: 'safeAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] }, primaryType: 'SensitiveAction', message: { action: `SECKILL_${action.actionKind}`, resourceType: 'SECKILL_SESSION', resourceId: action.sessionId, policyVersion: action.policyVersion, oldValueHash: hash('e'), newValueHash: hash('f'), safeAddress: action.safeAddress, nonce, deadline } }, digest: hash('9') };
}

function walletProvider(wallet: string, _challenge?: unknown) {
  return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : method === 'eth_signTypedData_v4' ? '0x1234' : '0xsigned') };
}

function nonceResponse() { return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:05:00.000Z' }, 201); }
function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

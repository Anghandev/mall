import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { artifactVersion, chainIdentity, type ManagedCatalogProduct, type SeckillGovernanceActionProjection, type SeckillSessionPlanProjection, type SeckillSessionProjection } from '@abu24k/core-artifacts';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const blockedGuaranteeCopy = /一键缴纳保证金|待缴纳保证金|保证金收款钱包|手动补录|1,000\.00 USDT|1000 USDT|保证金不足|保证金充值暂未开放|Merchant is not eligible for publication/;

function renderAt(path: string, fetchImpl = vi.fn()) {
  vi.stubGlobal('fetch', fetchImpl);
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  delete window.ethereum;
});

describe('seckill governance workspace', () => {
  it('renders seckill read pages and keeps admin actions wallet-guarded', async () => {
    renderAt('/seckill');
    expect(await screen.findByRole('heading', { name: '秒杀活动管理' })).toBeTruthy();
    expect(screen.getByText(/页面只展示系统确认结果/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('asks to switch to the secondary wallet before signing seckill governance', async () => {
    const adminWallet = address('1');
    const action = governanceAction();
    const walletRequest = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [adminWallet];
      if (method === 'eth_requestAccounts') return [adminWallet];
      if (method === 'personal_sign') return '0xsigned';
      if (method === 'eth_signTypedData_v4') return `0x${'12'.repeat(65)}`;
      throw new Error(`Unexpected wallet method ${method}`);
    });
    window.ethereum = { request: walletRequest };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([]);
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([action]);
      if (url.endsWith(`/v2/admin/seckill/actions/${action.actionId}`)) return jsonResponse(action);
      if (url.endsWith('/approval-challenge')) {
        const body = JSON.parse(String(init?.body)) as { nonce: string; deadline: string };
        return jsonResponse(governanceChallenge(action, body.nonce, body.deadline));
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));
    const approvalButton = await screen.findByRole('button', { name: '请求二次确认' });
    walletRequest.mockClear();
    await user.click(approvalButton);

    expect(await screen.findByText(/当前钱包不是二次确认钱包 0x2222…2222/)).toBeTruthy();
    expect(walletRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_requestAccounts',
    }));
    await waitFor(() => expect(walletRequest).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_signTypedData_v4',
    })));
  });

  it('allows the logged-in admin wallet to do seckill secondary confirmation when Core asks for it', async () => {
    const adminWallet = address('1');
    const action = governanceAction();
    const walletRequest = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [adminWallet];
      if (method === 'eth_requestAccounts') return [adminWallet];
      if (method === 'personal_sign') return '0xsigned';
      if (method === 'eth_signTypedData_v4') return `0x${'12'.repeat(65)}`;
      throw new Error(`Unexpected wallet method ${method}`);
    });
    window.ethereum = { request: walletRequest };
    const signedAction = { ...action, state: 'SECONDARY_SIGNED' as const, secondarySigner: adminWallet, approvalNonce: '1', approvalDeadline: '9999999999', allowedActions: ['EXECUTE'] as const };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([]);
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([action]);
      if (url.endsWith(`/v2/admin/seckill/actions/${action.actionId}`)) return jsonResponse(action);
      if (url.endsWith('/approval-challenge')) {
        const body = JSON.parse(String(init?.body)) as { nonce: string; deadline: string };
        return jsonResponse(governanceChallenge(action, body.nonce, body.deadline, adminWallet));
      }
      if (url.endsWith('/secondary-signature')) return jsonResponse(signedAction);
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));
    await user.click(await screen.findByRole('button', { name: '请求二次确认' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/secondary-signature'), expect.anything()));
    expect(walletRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_signTypedData_v4' }));
    expect(screen.queryByText(/系统未配置独立的秒杀二次签名钱包/)).toBeNull();
  });

  it('auto-loads the latest published seckill rules before creating a session', async () => {
    const adminWallet = address('1');
    const captured: { createBody?: Record<string, unknown> } = {};
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const createdAction = governanceAction({ actionId: hash('7') });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([]);
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [
        catalogProduct(),
        catalogProduct({ productId: 'product-locked', title: 'test', writeLock: { type: 'ORDER', id: hash('b'), state: 'LOCKED' } }),
      ] });
      if (url.endsWith('/v2/admin/seckill/sessions')) {
        captured.createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(createdAction, 201);
      }
      if (url.endsWith('/v2/cms/public')) return jsonResponse([
        { ...cmsPublicRules(), versionId: 'cms-version-stale-policy', version: 99, policyVersion: '7', contentHash: hash('7') },
        cmsPublicRules(),
      ]);
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    expect(await screen.findByText(/已自动选择已发布秒杀规则/)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/cms/public'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer jwt' }) }),
    ));
    expect(await screen.findByText(/test：已有订单、奖池或结算记录未完成/)).toBeTruthy();
    await user.selectOptions(await screen.findByRole('combobox', { name: '选择商品' }), 'product-1');
    expect(screen.getByRole('combobox', { name: '选择规格' })).toHaveProperty('value', 'sku-1');
    expect(screen.getByLabelText(/活动库存/)).toHaveProperty('value', '3');
    expect(screen.getByLabelText(/秒杀价/)).toHaveProperty('value', '2.00');
    await user.click(screen.getByRole('button', { name: '1 小时后' }));
    await user.click(screen.getByRole('button', { name: '创建并锁定活动库存' }));

    await waitFor(() => expect(captured.createBody).toBeTruthy());
    const body = captured.createBody!;
    expect(body).toMatchObject({
      policyVersion: '8',
      rulesContentHash: hash('8'),
      productId: 'product-1',
      skuId: 'sku-1',
      inventory: 3,
      seckillListPriceUsdt: '2000000000000000000',
    });
    expect(new Date(String(body.startsAt)).getTime()).toBeGreaterThan(Date.now());
    expect(body).not.toHaveProperty('cmsVersionId');
    expect(body).not.toHaveProperty('timers');
    expect(body).not.toHaveProperty('calldata');
  });

  it('still submits seckill creation to Core when the general payment switch is closed', async () => {
    const adminWallet = address('1');
    const captured: { submitted: boolean } = { submitted: false };
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap(false, ['PAYMENT_RECEIPT_WORKER_UNHEALTHY']));
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([]);
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [catalogProduct()] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([cmsPublicRules()]);
      if (url.endsWith('/v2/admin/seckill/sessions')) {
        captured.submitted = true;
        return jsonResponse(governanceAction(), 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    expect(await screen.findByText(/系统开关当前未完全放开/)).toBeTruthy();
    expect(screen.getByText(/付款回执确认服务异常/)).toBeTruthy();
    await user.selectOptions(await screen.findByRole('combobox', { name: '选择商品' }), 'product-1');
    await user.click(screen.getByRole('button', { name: '1 小时后' }));
    const createButton = await screen.findByRole('button', { name: '创建并锁定活动库存' });
    expect((createButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(createButton);
    await waitFor(() => expect(captured.submitted).toBe(true));
  });

  it('auto-targets the latest force-closed session before restoring seckill purchases', async () => {
    const adminWallet = address('1');
    const current = seckillSession({ sessionId: hash('1'), phase: 'SETTLED', storedPhase: 'SETTLED' });
    const forceClosedSessionId = hash('9');
    const forceClose = governanceAction({
      actionId: hash('f'),
      sessionId: forceClosedSessionId,
      actionKind: 'FORCE_CLOSE',
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      sessionPlan: null,
      allowedActions: [],
      createdAt: '2026-08-01T05:06:04.000Z',
      updatedAt: '2026-08-01T05:17:51.000Z',
    });
    const currentOpen = governanceAction({
      actionId: hash('e'),
      sessionId: current.sessionId,
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      allowedActions: [],
      createdAt: '2026-08-01T04:00:00.000Z',
      updatedAt: '2026-08-01T04:30:00.000Z',
    });
    const captured: { resumeBody?: Record<string, unknown> } = {};
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(current);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [seckillSession({ sessionId: forceClosedSessionId, phase: 'FORCE_CLOSED', storedPhase: 'FORCE_CLOSED' })], nextCursor: null });
      if (url.includes(`/v2/seckill/sessions/${current.sessionId}/events`)) return jsonResponse({ items: [], nextCursor: '0' });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [catalogProduct()] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([cmsPublicRules()]);
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([forceClose, currentOpen]);
      if (url.endsWith(`/v2/admin/seckill/actions/${forceClose.actionId}`)) return jsonResponse(forceClose);
      if (url.endsWith('/v2/admin/seckill/breaker/resume')) {
        captured.resumeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(governanceAction({
          actionId: hash('7'),
          sessionId: forceClosedSessionId,
          actionKind: 'RESUME_PURCHASES',
          sessionPlan: null,
        }), 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    expect((await screen.findAllByText(/秒杀购买开关暂停/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/不要选当前已结算场次/)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(/场次编号/)).toHaveProperty('value', forceClosedSessionId));
    expect(screen.getByRole('button', { name: '先恢复秒杀购买开关' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: '创建恢复购买动作' }));

    await waitFor(() => expect(captured.resumeBody).toMatchObject({ sessionId: forceClosedSessionId }));
    expect(captured.resumeBody?.sessionId).not.toBe(current.sessionId);
  });

  it('keeps restore disabled until seckill action records finish loading', async () => {
    const adminWallet = address('1');
    const current = seckillSession({ sessionId: hash('1'), phase: 'SETTLED', storedPhase: 'SETTLED' });
    const forceClosedSessionId = hash('9');
    const forceClose = governanceAction({
      actionId: hash('f'),
      sessionId: forceClosedSessionId,
      actionKind: 'FORCE_CLOSE',
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      sessionPlan: null,
      allowedActions: [],
      createdAt: '2026-08-01T05:06:04.000Z',
      updatedAt: '2026-08-01T05:17:51.000Z',
    });
    const actionsResponse = deferred<Response>();
    const captured: { resumeBody?: Record<string, unknown> } = {};
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(current);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [seckillSession({ sessionId: forceClosedSessionId, phase: 'FORCE_CLOSED', storedPhase: 'FORCE_CLOSED' })], nextCursor: null });
      if (url.includes(`/v2/seckill/sessions/${current.sessionId}/events`)) return jsonResponse({ items: [], nextCursor: '0' });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [catalogProduct()] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([cmsPublicRules()]);
      if (url.endsWith('/v2/admin/seckill/actions')) return actionsResponse.promise;
      if (url.endsWith(`/v2/admin/seckill/actions/${forceClose.actionId}`)) return jsonResponse(forceClose);
      if (url.endsWith('/v2/admin/seckill/breaker/resume')) {
        captured.resumeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(governanceAction({ actionId: hash('7'), sessionId: forceClosedSessionId, actionKind: 'RESUME_PURCHASES', sessionPlan: null }), 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    const loadingResume = await screen.findByRole('button', { name: '正在读取操作记录' });
    expect(loadingResume).toHaveProperty('disabled', true);
    await user.click(loadingResume);
    expect(captured.resumeBody).toBeUndefined();

    actionsResponse.resolve(jsonResponse([forceClose]));
    await waitFor(() => expect(screen.getByLabelText(/场次编号/)).toHaveProperty('value', forceClosedSessionId));
    expect(screen.getByRole('button', { name: '创建恢复购买动作' })).toHaveProperty('disabled', false);
  });

  it('does not block new sessions because of older already-superseded force closes', async () => {
    const adminWallet = address('1');
    const recoveredSessionId = hash('8');
    const olderForceClosedSessionId = hash('6');
    const recoveredForceClose = governanceAction({
      actionId: hash('8'),
      sessionId: recoveredSessionId,
      actionKind: 'FORCE_CLOSE',
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      sessionPlan: null,
      allowedActions: [],
      createdAt: '2026-08-01T04:00:00.000Z',
      updatedAt: '2026-08-01T04:30:00.000Z',
    });
    const recoveredResume = governanceAction({
      actionId: hash('9'),
      sessionId: recoveredSessionId,
      actionKind: 'RESUME_PURCHASES',
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      sessionPlan: null,
      allowedActions: [],
      createdAt: '2026-08-01T05:00:00.000Z',
      updatedAt: '2026-08-01T05:30:00.000Z',
    });
    const olderForceClose = governanceAction({
      actionId: hash('6'),
      sessionId: olderForceClosedSessionId,
      actionKind: 'FORCE_CLOSE',
      state: 'FINAL',
      confirmations: 15,
      canonical: true,
      sessionPlan: null,
      allowedActions: [],
      createdAt: '2026-07-31T04:00:00.000Z',
      updatedAt: '2026-07-31T04:30:00.000Z',
    });
    const captured: { createBody?: Record<string, unknown> } = {};
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [catalogProduct()] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([cmsPublicRules()]);
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([recoveredResume, recoveredForceClose, olderForceClose]);
      if (url.endsWith(`/v2/admin/seckill/actions/${recoveredResume.actionId}`)) return jsonResponse(recoveredResume);
      if (url.endsWith('/v2/admin/seckill/sessions')) {
        captured.createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(governanceAction({ actionId: hash('5') }), 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    expect(screen.queryByText(/秒杀购买开关暂停/)).toBeNull();
    await user.selectOptions(await screen.findByRole('combobox', { name: '选择商品' }), 'product-1');
    await user.click(screen.getByRole('button', { name: '1 小时后' }));
    await user.click(screen.getByRole('button', { name: '创建并锁定活动库存' }));

    await waitFor(() => expect(captured.createBody).toMatchObject({ productId: 'product-1', skuId: 'sku-1' }));
  });

  it('does not offer execution for an expired secondary-signed seckill action', async () => {
    const adminWallet = address('1');
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [adminWallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const expiredAction = governanceAction({
      state: 'SECONDARY_SIGNED',
      secondarySigner: adminWallet,
      approvalNonce: '1',
      approvalDeadline: '2026-07-30T11:41:20.000Z',
      allowedActions: ['EXECUTE', 'CANCEL'],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/seckill/sessions/current')) return jsonResponse(null);
      if (url.includes('/v2/seckill/sessions/history')) return jsonResponse({ items: [], nextCursor: null });
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: adminWallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/bootstrap')) return jsonResponse(coreBootstrap());
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [] });
      if (url.endsWith('/v2/cms/public')) return jsonResponse([]);
      if (url.endsWith('/v2/admin/seckill/actions')) return jsonResponse([expiredAction]);
      if (url.endsWith(`/v2/admin/seckill/actions/${expiredAction.actionId}`)) return jsonResponse(expiredAction);
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();

    renderAt('/seckill', fetchMock);
    await user.click(await screen.findByRole('button', { name: /连接钱包/ }));

    expect(await screen.findByText(/这条确认已过期/)).toBeTruthy();
    const executeButton = await screen.findByRole('button', { name: '确认已过期' });
    expect((executeButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/请取消旧动作后重新创建/)).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function coreBootstrap(writesEnabled = true, runtimeBlockers: readonly string[] = []) {
  return {
    artifactVersion,
    status: 'CORE_API_READY',
    readiness: {
      chainId: 56,
      assets: {
        usdt: chainIdentity.usdtAddress,
        npl: chainIdentity.nplAddress,
      },
      decisionBlocked: [],
      externalBlocked: [],
      paymentDecisionBlocked: [],
      paymentExternalBlocked: [],
      runtimeBlockers,
      providers: {},
      writesEnabled,
    },
  };
}

function seckillSession(overrides: Partial<SeckillSessionProjection> = {}): SeckillSessionProjection {
  return {
    artifactVersion,
    sessionId: hash('a'),
    policyVersion: '2',
    merchantId: 'merchant-1',
    product: {
      productId: 'product-1',
      skuId: 'sku-1',
      title: 'car',
      metadata: {},
      attributes: {},
      seckillListPriceUsdt: '2000000000000000000',
    },
    phase: 'LIVE',
    storedPhase: 'LIVE',
    serverTime: '2026-08-01T05:20:00.000Z',
    startsAt: '2026-08-01T04:39:19.099Z',
    mainDeadline: '2026-08-01T05:39:19.099Z',
    relayDeadline: '2026-08-01T04:40:19.099Z',
    settlementEarliestAt: '2026-08-01T05:45:19.099Z',
    settlementDeadline: '2026-08-01T05:50:19.099Z',
    timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 },
    inventory: { total: '10', sold: '0', reserved: '0', available: '10' },
    prizePoolUsdt: '0',
    lastBuyerWallet: null,
    winnerWallet: null,
    prizeSettlement: null,
    snapshot: {},
    governanceActionId: hash('1'),
    rulesContentHash: hash('2'),
    publicationTxHash: hash('3'),
    allowedActions: [],
    ...overrides,
  };
}

function governanceAction(overrides: Partial<SeckillGovernanceActionProjection> = {}): SeckillGovernanceActionProjection {
  return {
    artifactVersion, actionId: hash('a'), sessionId: hash('b'), policyVersion: '2', actionKind: 'OPEN_SESSION', state: 'DRAFT',
    evidenceHash: hash('c'), executorWallet: address('4'), targetAddress: address('5'), calldataHash: hash('d'), executorNonce: null,
    nonceReservedAt: null, nonceReservationEvidenceHash: null, executionArtifactVersion: null, executionRequestDigest: null,
    nonceReleasedAt: null, nonceReleaseEvidenceHash: null, submittedTxHash: null, executionEvidenceHash: null, executionTxHash: null, blockNumber: null, blockHash: null, confirmations: 0,
    canonical: null, actorWallet: address('1'), secondarySigner: null, approvalNonce: null, approvalDeadline: null,
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', sessionPlan: sessionPlan(),
    prizeInjection: null, allowedActions: ['APPROVE_SECONDARY', 'CANCEL'], ...overrides,
  };
}

function sessionPlan(): SeckillSessionPlanProjection {
  return {
    merchantId: 'merchant-1', productId: 'product-1', skuId: 'sku-1', productPolicyHash: hash('1'), rulesContentHash: hash('2'),
    startsAt: '2026-07-18T01:00:00.000Z', mainDeadline: '2026-07-18T02:00:00.000Z', relayDeadline: '2026-07-18T01:01:00.000Z',
    inventory: '4', seckillListPriceUsdt: '80', timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 },
    snapshot: {}, inventoryLockState: 'LOCKED', releasedAt: null,
  };
}

function cmsPublicRules() {
  return {
    entryId: 'cms-entry-seckill',
    versionId: 'cms-version-seckill-latest',
    version: 3,
    slug: 'seckill-rules-main',
    contentType: 'SECKILL_RULES',
    placement: 'mall.seckill.rules',
    locale: 'zh-CN',
    content: { type: 'doc', children: [] },
    contentHash: hash('8'),
    audience: { type: 'ALL' },
    startsAt: null,
    endsAt: null,
    frequencyCap: null,
    policyVersion: '8',
  };
}

function catalogProduct(overrides: Partial<ManagedCatalogProduct> = {}): ManagedCatalogProduct {
  return {
    artifactVersion,
    productId: 'product-1',
    chainProductId: hash('1'),
    merchantId: 'merchant-1',
    storeId: 'store-1',
    supersedesProductId: null,
    version: '1',
    title: '测试商品',
    subtitle: '秒杀用',
    lifecycleState: 'ACTIVE',
    productPolicyHash: hash('2'),
    merchantConcessionBps: 0,
    mainImageAssetIds: [hash('3')],
    videoAssetId: null,
    richDetail: {},
    defaultFreightUsdt: '0',
    fulfillmentModes: ['PICKUP'],
    categoryId: null,
    tagIds: [],
    skus: [{
      skuId: 'sku-1',
      chainSkuId: hash('4'),
      version: '1',
      attributes: { spec: '默认规格' },
      listPriceUsdt: '2000000000000000000',
      merchantBaseReceivableUsdt: '1380000000000000000',
      stockTotal: '10',
      stockAvailable: '10',
      stockReserved: '0',
      stockSeckillLocked: '0',
      proposedSeckillInventory: '3',
      lifecycleState: 'ACTIVE',
    }],
    allowedActions: [],
    writeLock: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function governanceChallenge(action: ReturnType<typeof governanceAction>, nonce: string, deadline: string, signer = address('2')) {
  return {
    artifactVersion, actionId: action.actionId, sessionId: action.sessionId, actionKind: action.actionKind,
    signer, executorWallet: action.executorWallet,
    typedData: {
      domain: { name: 'Abu24KV2Core', version: '2', chainId: 56, verifyingContract: action.targetAddress },
      types: { SensitiveAction: [
        { name: 'action', type: 'string' }, { name: 'resourceType', type: 'string' }, { name: 'resourceId', type: 'string' },
        { name: 'policyVersion', type: 'uint64' }, { name: 'oldValueHash', type: 'bytes32' }, { name: 'newValueHash', type: 'bytes32' },
        { name: 'executorWallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
      ] },
      primaryType: 'SensitiveAction',
      message: { action: `SECKILL_${action.actionKind}`, resourceType: 'SECKILL_SESSION', resourceId: action.sessionId, policyVersion: action.policyVersion, oldValueHash: hash('e'), newValueHash: hash('f'), executorWallet: action.executorWallet, nonce, deadline },
    },
    digest: hash('9'),
  };
}

function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactVersion, chainIdentity } from '@abu24k/core-artifacts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { CoreApiError } from '../src/coreApi';
import { coreState } from '../src/coreState';
import { humanizeError } from '../src/display';

const blockedGuaranteeCopy = /一键缴纳保证金|待缴纳保证金|保证金收款钱包|手动补录|1,000\.00 USDT|1000 USDT|保证金不足|保证金充值暂未开放|Merchant is not eligible for publication/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('platform admin simplified zero-guarantee experience', () => {
  it('boots against the coordinated Core artifact without exposing the version in the main status line', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

    expect(packageJson.dependencies['@abu24k/core-artifacts']).toBe(`workspace:${artifactVersion}`);
    expect(productBaseline.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactStatus).toBe('coordinated-merchant-governance-checkpoint');
    expect(coreState.connectionLabel).toBe('系统已连接');

    renderAt('/');
    expect(screen.getByRole('img', { name: '24K商城' })).toBeTruthy();
    expect(screen.getByText('版本信息')).toBeTruthy();
    expect(screen.getByText(artifactVersion)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/阿步|Abu 24K|ABU 24K/);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('keeps the dashboard fail-closed before wallet login and avoids fake operating numbers', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/');
    expect(screen.getByRole('heading', { name: '今日运营态势' })).toBeTruthy();
    expect(screen.getByText(/只有平台授权钱包可以查看业务数据/)).toBeTruthy();
    expect(screen.queryByText('300000000')).toBeNull();
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('uses SIWE for platform wallet login and never calls protected APIs before login', async () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [wallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/dashboard')) return jsonResponse({ error: { code: 'ConfigurationRequired', message: 'dashboard is not configured', correlationId: 'dashboard-config' } }, 503);
      if (url.endsWith('/v2/admin/coverage-breaker/actions')) return jsonResponse([]);
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'unexpected', correlationId: 'admin-smoke' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderAt('/');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: /连接管理钱包|连接钱包|钱包登录/ })[0]!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/v2/admin/dashboard', expect.objectContaining({ headers: { authorization: 'Bearer jwt' } })));
  });

  it('translates product publication failures without blaming merchant guarantee', () => {
    const copy = humanizeError(new CoreApiError({
      code: 'Forbidden',
      message: 'Merchant is not eligible for publication',
      status: 409,
      correlationId: 'publish-denied',
    }));

    expect(copy).toContain('商家还不能上架');
    expect(copy).toContain('商家已通过审核、门店已激活');
    expect(copy).not.toContain('publish-denied');
    expect(copy).not.toMatch(/保证金|1000|1,000|deposit/i);
  });


  it('shows Core readiness blockers in plain Chinese instead of raw system codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      artifactVersion,
      status: 'CORE_API_READY',
      readiness: {
        chainId: 56,
        assets: {
          usdt: chainIdentity.usdtAddress,
          npl: chainIdentity.nplAddress,
          nplUsdtPair: '0x2955e33bb120714abf11ace2766e614e6e5955b2',
        },
        decisionBlocked: [],
        externalBlocked: ['AMAP_WEB_SERVICE_KEY', 'SECRET_RESOLVER_URL', 'SECRET_RESOLVER_TOKEN'],
        paymentDecisionBlocked: [],
        paymentExternalBlocked: ['RELEASE_AUTHORIZATION_INVALID', 'COORDINATED_DEPLOYMENT_AUTHORIZATION'],
        runtimeBlockers: ['PAYMENT_CONFIGURATION_REQUIRED'],
        providers: { AMAP: 'CONFIGURATION_REQUIRED', BNM: 'READY' },
        writesEnabled: false,
      },
    })));

    renderAt('/core-status');

    expect(await screen.findByText('发布授权和当前版本不匹配')).toBeTruthy();
    expect(screen.getByText('等待正式发布授权')).toBeTruthy();
    expect(screen.getByText('新支付配置未完成')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/RELEASE_AUTHORIZATION_INVALID|COORDINATED_DEPLOYMENT_AUTHORIZATION|PAYMENT_CONFIGURATION_REQUIRED|AMAP_WEB_SERVICE_KEY|SECRET_RESOLVER_TOKEN/);
  });

  it('opens catalog, merchant, policy, seckill, clearing and core-status routes with simplified copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      artifactVersion,
      status: 'CORE_API_READY',
      readiness: { decisionBlocked: [], externalBlocked: [], paymentDecisionBlocked: [], paymentExternalBlocked: [], capabilities: {} },
      capabilities: {},
    })));

    const routes = [
      ['/catalog', '商品主数据'],
      ['/merchants', '商家准入与经营穿透'],
      ['/policy', '规则治理工作台'],
      ['/seckill', '秒杀活动管理'],
      ['/clearing', '全局清算审计'],
      ['/core-status', '系统状态'],
    ] as const;

    for (const [path, heading] of routes) {
      const view = renderAt(path);
      expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
      view.unmount();
    }
  });
});

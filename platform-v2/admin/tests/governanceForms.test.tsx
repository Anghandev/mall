import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { artifactVersion, type PolicyDraftProjection } from '@abu24k/core-artifacts';
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

describe('governed Admin forms', () => {
  it('keeps policy, system config and CMS forms behind wallet login with simple copy', () => {
    renderAt('/policy');
    expect(screen.getByRole('heading', { name: '规则治理工作台' })).toBeTruthy();
    expect(screen.getAllByText(/不需要手填编号|连接平台治理钱包/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('shows locked policy fields as read-only fixed rules', async () => {
    const wallet = address('1');
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [wallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/policy-drafts')) return jsonResponse([policyDraft()]);
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();
    renderAt('/policy', fetchMock);

    await user.click(screen.getByRole('button', { name: /连接钱包/ }));
    const fieldLabel = await screen.findByText('秒杀额外商家收益：固定 0，不可修改。');
    const field = fieldLabel.closest('label');
    expect(field).toBeTruthy();
    const input = within(field!).getByDisplayValue('0') as HTMLInputElement;

    expect(input.disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(within(field!).getByText('固定规则，不可修改。')).toBeTruthy();
  });

  it('renders system config as a guarded production configuration surface', () => {
    renderAt('/system');
    expect(screen.getByRole('heading', { name: '系统配置' })).toBeTruthy();
    expect(screen.getAllByText(/密钥只填引用名|连接平台钱包/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('renders CMS as wallet-guarded content operations', () => {
    renderAt('/cms');
    expect(screen.getByRole('heading', { name: '内容中心' })).toBeTruthy();
    expect(screen.getAllByText(/审核员只读|管理员和运营可创建/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('creates seckill-rule CMS drafts with real Core enums and hidden technical defaults', async () => {
    const wallet = address('1');
    let createBody: Record<string, unknown> | null = null;
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [wallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/cms/versions')) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(cmsVersion(), 201);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();
    renderAt('/cms', fetchMock);

    await user.click(screen.getByRole('button', { name: /钱包登录/ }));
    expect(await screen.findByText('第 1 步：选择用途')).toBeTruthy();
    expect(screen.getByDisplayValue('seckill-rules-main')).toBeTruthy();
    await user.click(screen.getByText(/高级信息/));
    await user.type(screen.getByLabelText(/资金规则版本号/), '8');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(createBody).toBeTruthy());
    expect(createBody).toMatchObject({
      slug: 'seckill-rules-main',
      placement: 'mall.seckill.rules',
      contentType: 'SECKILL_RULES',
      contentFormat: 'STRUCTURED_RICH_TEXT',
      locale: 'zh-CN',
      audience: { type: 'ALL' },
      policyVersion: '8',
    });
    expect(createBody).not.toHaveProperty('contentHash');
    });
  });

  it('does not offer rollback for the currently published CMS version', async () => {
    const wallet = address('1');
    const rollbackRequest = vi.fn();
    window.ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [wallet];
        if (method === 'personal_sign') return '0xsigned';
        throw new Error(`Unexpected wallet method ${method}`);
      }),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:05:00.000Z' });
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/cms/versions/cms-version-seckill')) {
        return jsonResponse({ ...cmsVersion(), published: true, publicationType: 'PUBLISHED' });
      }
      if (url.endsWith('/rollback')) {
        rollbackRequest();
        return jsonResponse({ error: { code: 'InvalidRequest', message: 'unexpected rollback' } }, 400);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: `unexpected ${url}` } }, 400);
    });
    const user = userEvent.setup();
    renderAt('/cms', fetchMock);

    await user.click(screen.getByRole('button', { name: /钱包登录/ }));
    await user.type(await screen.findByLabelText(/读取历史内容版本/), 'cms-version-seckill');
    await user.click(screen.getByRole('button', { name: '读取' }));

    expect(await screen.findByText('已发布')).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复到这个历史版本' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/当前已经是正在展示的版本/)).toBeTruthy();
    expect(rollbackRequest).not.toHaveBeenCalled();
  });

function cmsVersion() {
  return {
    entryId: 'cms-entry-seckill',
    versionId: 'cms-version-seckill',
    version: 1,
    slug: 'seckill-rules-main',
    contentType: 'SECKILL_RULES',
    placement: 'mall.seckill.rules',
    locale: 'zh-CN',
    contentFormat: 'STRUCTURED_RICH_TEXT',
    content: { type: 'doc', children: [] },
    contentHash: hash('8'),
    audience: { type: 'ALL' },
    startsAt: null,
    endsAt: null,
    frequencyCap: null,
    policyVersion: '8',
    published: false,
    publicationType: null,
    createdBy: address('1'),
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function policyDraft(): PolicyDraftProjection {
  return {
    draftId: 'draft-1',
    nextPolicyVersion: '2',
    basePolicyVersion: '1',
    artifactVersion,
    payload: {
      rulesContentHash: hash('1'),
      policy: {
        usdtPaymentBps: 7000,
        nplPaymentBps: 3000,
        nplBurnListPriceBps: 2000,
        nplRewardListPriceBps: 1000,
        platformFeeBps: 100,
        seckillPrizeBps: 0,
      },
    },
    validationErrors: [],
    state: 'DRAFT',
    policyHash: null,
    operationsHash: null,
    publicationDigest: null,
    publicationNonce: null,
    publicationDeadline: null,
    secondarySigner: null,
    secondarySignatureHash: null,
    governanceWallet: null,
    executionCalldataHash: null,
    executionTxHash: null,
    executionEvidenceHash: null,
    createdBy: address('1'),
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function address(digit: string) { return `0x${digit.repeat(40)}`; }

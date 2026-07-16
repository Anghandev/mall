import {
  artifactVersion,
  type AdminGlobalSearchResponse,
  type AdminProductBatchTagResult,
  type AdminProductLifecycleBatchResult,
  type AdminResourceExport,
  type UserRole,
} from '@abu24k/core-artifacts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('Admin global operations page', () => {
  it('searches, selects, downloads CSV and writes tags only with row authorization', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const fetchMock = globalOperationsFetch(wallet, 'ADMIN', globalSearchResponse({ truncated: true }));
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValue('blob:global-export') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: '全局资源操作' })).toBeTruthy();
    expect(screen.getByText('Unavailable / DecisionBlocked')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: 'OR' }));
    await user.click(screen.getByRole('button', { name: '模糊' }));
    await user.type(await screen.findByLabelText('商家 ID'), 'merchant-1');
    await user.type(screen.getByLabelText('钱包地址'), 'A1b2C3');
    await user.selectOptions(screen.getByLabelText('审核投影'), 'true');
    await user.click(screen.getByRole('button', { name: '查询' }));

    expect(await screen.findByText('结果已截断')).toBeTruthy();
    expect(screen.getByText('24K 金章')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: '选择 PRODUCT product-1' }));
    expect(screen.getByRole('button', { name: '导出 CSV' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByText(/abu24k-admin-resources.csv 已下载/)).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: /新品/ }));
    await user.click(screen.getByRole('button', { name: '批量加标签' }));

    expect(await screen.findByText('标签版本证据')).toBeTruthy();
    expect(screen.getByText(/1 个商品写入新版本/)).toBeTruthy();
    await user.click(await screen.findByRole('checkbox', { name: '选择 PRODUCT product-1' }));
    expect(screen.getByRole('button', { name: '审核通过' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: '隐藏商品' }));
    expect(screen.getByRole('button', { name: '确认隐藏商品' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('原因代码'), 'operations_hide');
    await user.click(screen.getByRole('button', { name: '确认隐藏商品' }));

    expect(await screen.findByText('生命周期操作证据')).toBeTruthy();
    expect(screen.getByText(/1 个商品已原子更新/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/v2/admin/global/resources?') && !init?.method)).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('relation=OR') && String(input).includes('wallet=a1b2c3') && String(input).includes('walletMatch=FUZZY'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/v2/admin/global/exports') && init?.method === 'POST')).toBe(true);
    const batchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v2/admin/catalog/products/batch-tags'));
    expect(JSON.parse(String(batchCall?.[1]?.body))).toMatchObject({ productIds: ['product-1'], tagIds: ['tag-1'] });
    const lifecycleCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v2/admin/catalog/products/batch-lifecycle'));
    expect(JSON.parse(String(lifecycleCall?.[1]?.body))).toMatchObject({ action: 'HIDE', productIds: ['product-1'], reasonCode: 'OPERATIONS_HIDE' });
  });

  it('keeps AUDITOR batch tagging forbidden while preserving export', async () => {
    const wallet = address('2');
    window.ethereum = walletProvider(wallet);
    const response = globalSearchResponse({
      resources: [productResource([{ action: 'EXPORT_CSV', enabled: true }, { action: 'EXPORT_EXCEL', enabled: true }, { action: 'ADD_PRODUCT_TAGS', enabled: false, reasonCode: 'Forbidden' }])],
    });
    const fetchMock = globalOperationsFetch(wallet, 'AUDITOR', response);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '查询' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 PRODUCT product-1' }));

    expect(screen.getAllByText('AUDITOR 只读：Forbidden')).toHaveLength(3);
    expect(screen.getByRole('button', { name: '进入面单与打印' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '批量加标签' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '隐藏商品' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '导出 CSV' }).hasAttribute('disabled')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/admin/catalog/tags'))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/admin/catalog/products/batch-tags'))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/v2/admin/catalog/products/batch-lifecycle'))).toBe(false);
  });

  it('opens logistics operations with same-merchant order IDs prefilled', async () => {
    const wallet = address('5');
    window.ethereum = walletProvider(wallet);
    const response = globalSearchResponse({
      resources: [orderResource('order-1', 'merchant-1'), orderResource('order-2', 'merchant-1')],
    });
    vi.stubGlobal('fetch', globalOperationsFetch(wallet, 'ADMIN', response));
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '查询' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 ORDER order-1' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 ORDER order-2' }));

    const command = screen.getByRole('button', { name: '进入面单与打印' });
    expect(command.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('2 个同商家订单可进入面单与打印')).toBeTruthy();
    await user.click(command);

    expect((await screen.findByRole('tab', { name: '面单与打印' })).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findByLabelText('商家 ID') as HTMLInputElement).value).toBe('merchant-1');
    expect((screen.getByLabelText('订单 ID · 每行或逗号分隔') as HTMLTextAreaElement).value).toBe('order-1\norder-2');
  });

  it('blocks cross-merchant order selections from the logistics command', async () => {
    const wallet = address('6');
    window.ethereum = walletProvider(wallet);
    const response = globalSearchResponse({
      resources: [orderResource('order-1', 'merchant-1'), orderResource('order-2', 'merchant-2')],
    });
    vi.stubGlobal('fetch', globalOperationsFetch(wallet, 'ADMIN', response));
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '查询' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 ORDER order-1' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 ORDER order-2' }));

    expect(screen.getByText('所选订单必须属于同一商家')).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入面单与打印' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the lifecycle idempotency key after failure and retries the same atomic request', async () => {
    const wallet = address('4');
    window.ethereum = walletProvider(wallet);
    const fetchMock = globalOperationsFetch(wallet, 'ADMIN', globalSearchResponse(), true);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '查询' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 PRODUCT product-1' }));
    await user.click(screen.getByRole('button', { name: '隐藏商品' }));
    await user.type(screen.getByLabelText('原因代码'), 'OPERATIONS_HIDE');
    const key = (screen.getByLabelText('Lifecycle idempotency key') as HTMLInputElement).value;
    await user.click(screen.getByRole('button', { name: '确认隐藏商品' }));

    expect(await screen.findByText(/当前幂等键已保留/)).toBeTruthy();
    expect((screen.getByLabelText('Lifecycle idempotency key') as HTMLInputElement).value).toBe(key);
    expect(screen.getByLabelText('Lifecycle idempotency key').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('原因代码').hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: '确认隐藏商品' }));
    expect(await screen.findByText('生命周期操作证据')).toBeTruthy();
    const lifecycleBodies = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/v2/admin/catalog/products/batch-lifecycle'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(lifecycleBodies.map((body) => body.idempotencyKey)).toEqual([key, key]);
  });

  it('renders empty and Core failure states without synthetic resources', async () => {
    const wallet = address('3');
    window.ethereum = walletProvider(wallet);
    let searches = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['AUDITOR'] });
      if (url.includes('/v2/admin/global/resources?')) {
        searches += 1;
        return searches === 1
          ? jsonResponse(globalSearchResponse({ resources: [] }))
          : jsonResponse({ error: { code: 'ExternalBlocked', message: 'Admin projection unavailable', correlationId: 'global-down' } }, 503);
      }
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected request' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/global-operations']}><App /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('button', { name: '查询' }));
    expect(await screen.findByRole('heading', { name: '没有匹配资源' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '查询' }));
    expect(await screen.findByText('Admin projection unavailable')).toBeTruthy();
    expect(screen.queryByText('24K 金章')).toBeNull();
  });
});

function globalOperationsFetch(wallet: string, role: UserRole, response: AdminGlobalSearchResponse, failFirstLifecycle = false) {
  let lifecycleAttempts = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
    if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
    if (url.endsWith('/v2/admin/catalog/tags')) return jsonResponse({ tags: [{ tagId: 'tag-1', version: '1', name: '新品', example: '新品上架', sortOrder: 1, status: 'ENABLED' }] });
    if (url.includes('/v2/admin/global/resources?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      return jsonResponse({ ...response, relation: query.get('relation') ?? 'AND', walletMatch: query.get('walletMatch') ?? 'EXACT' });
    }
    if (url.endsWith('/v2/admin/global/exports')) return jsonResponse(resourceExport(), 201);
    if (url.endsWith('/v2/admin/catalog/products/batch-tags') && init?.method === 'POST') return jsonResponse(batchTagResult());
    if (url.endsWith('/v2/admin/catalog/products/batch-lifecycle') && init?.method === 'POST') {
      lifecycleAttempts += 1;
      if (failFirstLifecycle && lifecycleAttempts === 1) return jsonResponse({ error: { code: 'ExternalBlocked', message: 'Lifecycle service unavailable', correlationId: 'lifecycle-retry' } }, 503);
      return jsonResponse(lifecycleResult());
    }
    if (url.endsWith('/v2/admin/logistics/carriers') && !init?.method) return jsonResponse({ artifactVersion, configVersionId: hash('1'), version: 1, defaultCarrierCode: 'SF', readiness: 'READY', carriers: ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'].map((carrierCode) => ({ carrierCode, enabled: true })), createdBy: wallet, createdAt: '2026-07-15T00:00:00.000Z' });
    if (url.endsWith('/v2/admin/logistics/providers') && !init?.method) return jsonResponse({ artifactVersion, providers: [] });
    if (url.endsWith('/v2/admin/logistics/warehouses') && !init?.method) return jsonResponse({ artifactVersion, warehouses: [] });
    if (url.includes('/v2/admin/logistics/waybills?') && !init?.method) return jsonResponse({ artifactVersion, waybills: [] });
    if (url.includes('/v2/admin/logistics/print-jobs?') && !init?.method) return jsonResponse({ artifactVersion, printJobs: [] });
    return jsonResponse({ error: { code: 'InvalidRequest', message: `Unexpected request ${url}` } }, 400);
  });
}

function globalSearchResponse(overrides: Partial<AdminGlobalSearchResponse> = {}): AdminGlobalSearchResponse {
  return {
    artifactVersion,
    relation: 'AND',
    walletMatch: 'EXACT',
    resources: [productResource()],
    truncated: false,
    unavailableFilters: ['UID', 'PHONE', 'YELLOW_QUEUE'],
    ...overrides,
  };
}

function productResource(allowedBatchActions: AdminGlobalSearchResponse['resources'][number]['allowedBatchActions'] = [
  { action: 'EXPORT_CSV', enabled: true },
  { action: 'EXPORT_EXCEL', enabled: true },
  { action: 'ADD_PRODUCT_TAGS', enabled: true },
  { action: 'APPROVE_PRODUCTS', enabled: false, reasonCode: 'UnknownState' },
  { action: 'REJECT_PRODUCTS', enabled: false, reasonCode: 'UnknownState' },
  { action: 'PUBLISH_PRODUCTS', enabled: false, reasonCode: 'UnknownState' },
  { action: 'HIDE_PRODUCTS', enabled: true },
  { action: 'DELIST_PRODUCTS', enabled: true },
]) {
  return {
    resourceType: 'PRODUCT' as const,
    resourceId: 'product-1',
    title: '24K 金章',
    status: 'PUBLISHED',
    merchantId: 'merchant-1',
    productId: 'product-1',
    tagIds: [],
    allowedBatchActions,
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function orderResource(resourceId: string, merchantId: string | null) {
  return {
    resourceType: 'ORDER' as const,
    resourceId,
    title: `订单 ${resourceId}`,
    status: 'PAID',
    merchantId,
    productId: 'product-1',
    tagIds: [],
    allowedBatchActions: [
      { action: 'EXPORT_CSV' as const, enabled: true },
      { action: 'EXPORT_EXCEL' as const, enabled: true },
    ],
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function resourceExport(): AdminResourceExport {
  const content = '\uFEFFresourceType,resourceId\r\n"PRODUCT","product-1"\r\n';
  return { artifactVersion, exportId: hash('e'), format: 'CSV', filename: 'abu24k-admin-resources.csv', mediaType: 'text/csv; charset=utf-8', rowCount: 1, byteLength: Buffer.byteLength(content), contentHash: hash('c'), contentBase64: Buffer.from(content).toString('base64'), createdAt: '2026-07-15T00:00:00.000Z' };
}

function batchTagResult(): AdminProductBatchTagResult {
  return { artifactVersion, operationId: hash('d'), action: 'ADD_PRODUCT_TAGS', tagIds: ['tag-1'], changedCount: 1, products: [{ productId: 'product-1', previousVersion: '1', version: '2', addedTagIds: ['tag-1'] }], createdAt: '2026-07-15T00:00:00.000Z' };
}

function lifecycleResult(): AdminProductLifecycleBatchResult {
  return { artifactVersion, operationId: hash('f'), action: 'HIDE', changedCount: 1, products: [{ productId: 'product-1', previousState: 'ACTIVE', state: 'HIDDEN' }], createdAt: '2026-07-15T00:00:00.000Z' };
}

function nonceResponse() {
  return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 201);
}

function walletProvider(wallet: string) {
  return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : method === 'personal_sign' ? '0xsigned' : Promise.reject(new Error(`Unexpected wallet method ${method}`))) };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(character: string) { return `0x${character.repeat(64)}`; }
function address(character: string) { return `0x${character.repeat(40)}`; }

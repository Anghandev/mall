import { artifactVersion, type UserRole } from '@abu24k/core-artifacts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

function renderLogistics() {
  return render(<MemoryRouter initialEntries={['/logistics']}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('Admin logistics operations', () => {
  it('submits all six carriers and clears a complete Cainiao secret-reference version', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    let carriers = carrierConfig();
    let providers = [providerConfig('KUAIDI100')];
    const carrierBodies: unknown[] = [];
    const providerBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const base = readResponse(url, init, wallet, 'ADMIN', { carriers, providers });
      if (base) return base;
      if (url.endsWith('/carrier-versions')) {
        carrierBodies.push(body(init));
        carriers = carrierConfig({ version: 2, carriers: (body(init) as { carriers: unknown[] }).carriers });
        return jsonResponse(carriers, 201);
      }
      if (url.endsWith('/provider-versions')) {
        const request = body(init) as { provider: 'KUAIDI100' | 'CAINIAO' };
        providerBodies.push(request);
        const next = providerConfig(request.provider, { version: 2, readiness: 'CONFIGURATION_REQUIRED' });
        providers = [...providers.filter((item) => item.provider !== request.provider), next];
        return jsonResponse(next, 201);
      }
      return unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));

    const carrierForm = formForHeading(await screen.findByRole('heading', { name: '承运商策略' }));
    await user.click(within(carrierForm).getByLabelText('JD'));
    await user.type(within(carrierForm).getByLabelText('Idempotency key'), 'carrier-version-2');
    await user.click(within(carrierForm).getByRole('button', { name: '保存新版本' }));
    expect(await screen.findByText(/承运商配置已激活为 v2/)).toBeTruthy();
    expect(carrierBodies).toEqual([{
      carriers: [
        { carrierCode: 'SF', enabled: true }, { carrierCode: 'JD', enabled: false },
        { carrierCode: 'YTO', enabled: true }, { carrierCode: 'ZTO', enabled: true },
        { carrierCode: 'STO', enabled: true }, { carrierCode: 'EMS', enabled: true },
      ],
      defaultCarrierCode: 'SF', idempotencyKey: 'carrier-version-2',
    }]);

    const providerForm = screen.getByRole('heading', { name: '提交密钥引用版本' }).closest('form')!;
    await user.selectOptions(within(providerForm).getByLabelText('Provider'), 'CAINIAO');
    await user.type(within(providerForm).getByLabelText('Partner ID secret ref'), 'secret://cainiao-partner');
    await user.type(within(providerForm).getByLabelText('Credential secret ref'), 'secret://cainiao-credential');
    await user.type(within(providerForm).getByLabelText('Monthly account secret ref'), 'secret://cainiao-monthly');
    await user.type(within(providerForm).getByLabelText('Callback secret ref'), 'secret://cainiao-callback');
    await user.type(within(providerForm).getByLabelText('Idempotency key'), 'cainiao-provider-v2');
    await user.click(within(providerForm).getByRole('button', { name: '提交引用版本' }));

    expect(await screen.findByText(/CAINIAO 密钥引用版本 v2 已提交；输入已清除/)).toBeTruthy();
    expect(providerBodies).toEqual([{
      provider: 'CAINIAO', enabled: true,
      partnerIdSecretRef: 'secret://cainiao-partner', credentialSecretRef: 'secret://cainiao-credential',
      monthlyAccountSecretRef: 'secret://cainiao-monthly', callbackSecretRef: 'secret://cainiao-callback',
      idempotencyKey: 'cainiao-provider-v2',
    }]);
    for (const label of ['Partner ID secret ref', 'Credential secret ref', 'Monthly account secret ref', 'Callback secret ref', 'Idempotency key']) {
      expect((within(providerForm).getByLabelText(label) as HTMLInputElement).value).toBe('');
    }
    expect(screen.queryByDisplayValue('secret://cainiao-credential')).toBeNull();
    expect(screen.getAllByText('CONFIGURATION_REQUIRED').length).toBeGreaterThan(0);
  });

  it('creates, updates and deactivates encrypted warehouses and surfaces a version conflict', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const original = warehouse();
    const created = warehouse({ warehouseId: 'warehouse-partner-2', warehouseVersionId: hash('3'), warehouseKind: 'PARTNER', name: '合作仓', partnerName: '合作方', regionCode: '210202' });
    let warehouses = [original];
    let updateCount = 0;
    const writes: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const base = readResponse(url, init, wallet, 'ADMIN', { warehouses });
      if (base) return base;
      if (url.endsWith('/v2/admin/logistics/warehouses') && init?.method === 'POST') {
        writes.push({ url, body: body(init) }); warehouses = [...warehouses, created]; return jsonResponse(created, 201);
      }
      if (url.endsWith(`/${original.warehouseId}`) && init?.method === 'PUT') {
        writes.push({ url, body: body(init) }); updateCount += 1;
        if (updateCount === 2) return coreError('UnknownState', 'Warehouse version conflict', 409);
        const updated = warehouse({ ...original, warehouseVersionId: hash('4'), version: 2, name: '平台一仓新版' });
        warehouses = warehouses.map((item) => item.warehouseId === original.warehouseId ? updated : item);
        return jsonResponse(updated);
      }
      if (url.endsWith(`/${original.warehouseId}/deactivate`)) {
        writes.push({ url, body: body(init) });
        const disabled = warehouse({ ...original, warehouseVersionId: hash('5'), version: 3, name: '平台一仓新版', enabled: false });
        warehouses = warehouses.map((item) => item.warehouseId === original.warehouseId ? disabled : item);
        return jsonResponse(disabled);
      }
      return unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: '仓库' }));

    await user.click(screen.getByRole('button', { name: '新建仓库' }));
    let form = formForHeading(screen.getByRole('heading', { name: '创建仓库' }));
    await user.selectOptions(within(form).getByLabelText('仓库类型'), 'PARTNER');
    await fillWarehouse(user, form, { name: '合作仓', partnerName: '合作方', idempotencyKey: 'warehouse-create-2' });
    await user.click(within(form).getByRole('button', { name: '创建仓库' }));
    expect(await screen.findByText(/warehouse-partner-2 已创建/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /平台一仓/ }));
    form = formForHeading(screen.getByRole('heading', { name: '仓库详情与版本' }));
    await user.clear(within(form).getByLabelText('名称'));
    await user.type(within(form).getByLabelText('名称'), '平台一仓新版');
    await user.type(within(form).getByLabelText('Idempotency key'), 'warehouse-update-2');
    await user.click(within(form).getByRole('button', { name: '保存新版本' }));
    expect(await screen.findByText(/已更新为 v2/)).toBeTruthy();

    form = formForHeading(screen.getByRole('heading', { name: '仓库详情与版本' }));
    await user.type(within(form).getByLabelText('Idempotency key'), 'warehouse-conflict');
    await user.click(within(form).getByRole('button', { name: '保存新版本' }));
    expect(await screen.findByText('Warehouse version conflict')).toBeTruthy();
    expect(screen.getByText('UnknownState')).toBeTruthy();

    const idempotency = within(form).getByLabelText('Idempotency key');
    await user.clear(idempotency); await user.type(idempotency, 'warehouse-deactivate');
    await user.click(within(form).getByRole('button', { name: '停用仓库' }));
    expect(await screen.findByText(/已停用/)).toBeTruthy();

    expect(writes[0]?.body).toEqual({ warehouseKind: 'PARTNER', name: '合作仓', partnerName: '合作方', contactName: '负责人', phone: '13800000000', regionCode: '210202', addressLine: '大连市中山路 1 号', enabled: true, idempotencyKey: 'warehouse-create-2' });
    expect(writes[1]?.body).toMatchObject({ expectedVersion: 1, name: '平台一仓新版', idempotencyKey: 'warehouse-update-2' });
    expect(writes[2]?.body).toMatchObject({ expectedVersion: 2, idempotencyKey: 'warehouse-conflict' });
    expect(writes[3]?.body).toEqual({ expectedVersion: 2, idempotencyKey: 'warehouse-deactivate' });
  });

  it('filters cross-merchant operations and preserves exact waybill and print-retry idempotency bodies', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const job = printJob();
    const listUrls: string[] = [];
    const waybillBodies: unknown[] = [];
    const retryBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v2/admin/logistics/waybills?') || url.includes('/v2/admin/logistics/print-jobs?')) listUrls.push(url);
      const base = readResponse(url, init, wallet, 'ADMIN', { waybills: [waybill()], printJobs: [job] });
      if (base) return base;
      if (url.endsWith('/waybills/batches')) {
        waybillBodies.push(body(init));
        return jsonResponse({ artifactVersion, batchId: hash('8'), items: [waybill()] }, 201);
      }
      if (url.endsWith(`/print-jobs/${job.printJobId}/retry`)) {
        retryBodies.push(body(init));
        return jsonResponse(printJob({ state: 'QUEUED', attempts: 2 }));
      }
      return unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    await user.click(await screen.findByRole('tab', { name: '面单与打印' }));

    const filter = screen.getByRole('search');
    await user.type(within(filter).getByLabelText('商家筛选'), 'merchant-2');
    await user.click(within(filter).getByRole('button', { name: '读取列表' }));
    await waitFor(() => {
      expect(listUrls).toContain('/v2/admin/logistics/waybills?limit=50&merchantId=merchant-2');
      expect(listUrls).toContain('/v2/admin/logistics/print-jobs?limit=50&merchantId=merchant-2');
    });

    const waybillForm = formForHeading(screen.getByRole('heading', { name: '跨商家面单' }));
    await user.type(within(waybillForm).getByLabelText('商家 ID'), 'merchant-2');
    await user.type(within(waybillForm).getByLabelText('门店 ID'), 'store-2');
    await user.selectOptions(within(waybillForm).getByLabelText('Provider'), 'CAINIAO');
    await user.selectOptions(within(waybillForm).getByLabelText('承运商'), 'JD');
    await user.type(within(waybillForm).getByLabelText('Idempotency key'), 'waybill-batch-2');
    await user.type(within(waybillForm).getByLabelText('订单 ID · 每行或逗号分隔'), 'order-1\norder-2, order-3');
    await user.click(within(waybillForm).getByRole('button', { name: '创建面单批次' }));
    expect(await screen.findByText(/面单批次 .* 已创建/)).toBeTruthy();
    expect(waybillBodies).toEqual([{
      merchantId: 'merchant-2', provider: 'CAINIAO', carrierCode: 'JD', storeId: 'store-2',
      orderIds: ['order-1', 'order-2', 'order-3'], idempotencyKey: 'waybill-batch-2',
    }]);

    let retryForm = formForHeading(screen.getByRole('heading', { name: '打印重试' }));
    await user.type(within(retryForm).getByLabelText('Idempotency key'), 'print-retry-stable');
    await user.click(within(retryForm).getByRole('button', { name: '重试打印作业' }));
    expect(await screen.findByText(/已进入 QUEUED/)).toBeTruthy();
    retryForm = formForHeading(screen.getByRole('heading', { name: '打印重试' }));
    await user.type(within(retryForm).getByLabelText('Idempotency key'), 'print-retry-stable');
    await user.click(within(retryForm).getByRole('button', { name: '重试打印作业' }));
    await waitFor(() => expect(retryBodies).toHaveLength(2));
    expect(retryBodies).toEqual([{ idempotencyKey: 'print-retry-stable' }, { idempotencyKey: 'print-retry-stable' }]);
    expect(screen.queryByRole('button', { name: /退款|退货仓|refund|return warehouse/i })).toBeNull();
  });

  it('allows OPERATOR logistics writes while AUDITOR behavior stays independently tested', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return readResponse(url, init, wallet, 'OPERATOR', { warehouses: [warehouse()], printJobs: [printJob()] }) ?? unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByRole('button', { name: '保存新版本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交引用版本' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: '仓库' }));
    expect(screen.getByRole('button', { name: '新建仓库' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: '面单与打印' }));
    expect(screen.getByRole('button', { name: '创建面单批次' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试打印作业' })).toBeTruthy();
  });

  it('keeps AUDITOR warehouse PII redacted and removes every logistics write control', async () => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const redacted = warehouse({ access: 'REDACTED', contactName: null, phone: null, addressLine: null });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      return readResponse(url, init, wallet, 'AUDITOR', { warehouses: [redacted], printJobs: [printJob()] }) ?? unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText('AUDITOR 只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存新版本' })).toBeNull();
    expect(screen.queryByRole('button', { name: '提交引用版本' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: '仓库' }));
    expect(screen.getByText('Core 脱敏投影')).toBeTruthy();
    expect(screen.getAllByText('已脱敏')).toHaveLength(3);
    expect(screen.queryByText('13800000000')).toBeNull();
    expect(screen.queryByText('大连市中山路 1 号')).toBeNull();
    expect(screen.queryByRole('button', { name: '新建仓库' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: '面单与打印' }));
    expect(screen.queryByRole('button', { name: '创建面单批次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试打印作业' })).toBeNull();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/v2/admin/logistics/') && Boolean(init?.method))).toBe(false);
  });

  it.each([
    { code: 'ConfigurationRequired', message: 'Kuaidi100 production account is not configured', status: 503 },
    { code: 'Forbidden', message: 'Current wallet cannot read logistics configuration', status: 403 },
  ])('surfaces Core $code without rendering a local fallback', async ({ code, message, status }) => {
    const wallet = address('1');
    window.ethereum = walletProvider(wallet);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
      if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: ['ADMIN'] });
      if (url.endsWith('/v2/admin/logistics/carriers')) return coreError(code, message, status);
      return readResponse(url, init, wallet, 'ADMIN', {}) ?? unexpected(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderLogistics();
    await user.click(screen.getByRole('button', { name: 'SIWE 连接' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText(code)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '承运商策略' })).toBeNull();
  });
});

async function fillWarehouse(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, input: { name: string; partnerName?: string; idempotencyKey: string }) {
  await user.type(within(form).getByLabelText('名称'), input.name);
  if (input.partnerName) await user.type(within(form).getByLabelText('合作方名称'), input.partnerName);
  await user.type(within(form).getByLabelText('联系人'), '负责人');
  await user.type(within(form).getByLabelText('电话'), '13800000000');
  await user.type(within(form).getByLabelText('地区代码'), '210202');
  await user.type(within(form).getByLabelText('地址'), '大连市中山路 1 号');
  await user.type(within(form).getByLabelText('Idempotency key'), input.idempotencyKey);
}

function formForHeading(heading: HTMLElement) {
  const form = heading.closest('article')?.querySelector('form');
  if (!form) throw new Error(`Missing form for ${heading.textContent ?? 'logistics heading'}`);
  return form;
}

type ReadState = Readonly<{
  carriers?: ReturnType<typeof carrierConfig>;
  providers?: ReturnType<typeof providerConfig>[];
  warehouses?: ReturnType<typeof warehouse>[];
  waybills?: ReturnType<typeof waybill>[];
  printJobs?: ReturnType<typeof printJob>[];
}>;

function readResponse(url: string, init: RequestInit | undefined, wallet: string, role: UserRole, state: ReadState): Response | undefined {
  if (url.endsWith('/v2/auth/nonce')) return nonceResponse();
  if (url.endsWith('/v2/auth/verify')) return jsonResponse({ token: 'jwt', walletAddress: wallet, roles: [role] });
  if (url.endsWith('/v2/admin/logistics/carriers') && !init?.method) return jsonResponse(state.carriers ?? carrierConfig());
  if (url.endsWith('/v2/admin/logistics/providers') && !init?.method) return jsonResponse({ artifactVersion, providers: state.providers ?? [providerConfig('KUAIDI100')] });
  if (url.endsWith('/v2/admin/logistics/warehouses') && !init?.method) return jsonResponse({ artifactVersion, warehouses: state.warehouses ?? [] });
  if (url.includes('/v2/admin/logistics/waybills?') && !init?.method) return jsonResponse({ artifactVersion, waybills: state.waybills ?? [] });
  if (url.includes('/v2/admin/logistics/print-jobs?') && !init?.method) return jsonResponse({ artifactVersion, printJobs: state.printJobs ?? [] });
  return undefined;
}

function carrierConfig(overrides: Record<string, unknown> = {}) {
  return { artifactVersion, configVersionId: hash('1'), version: 1, defaultCarrierCode: 'SF', readiness: 'READY', carriers: ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'].map((carrierCode) => ({ carrierCode, enabled: true })), createdBy: address('1'), createdAt: '2026-07-16T00:00:00.000Z', ...overrides };
}

function providerConfig(provider: 'KUAIDI100' | 'CAINIAO', overrides: Record<string, unknown> = {}) {
  return { provider, providerConfigVersionId: hash(provider === 'KUAIDI100' ? '2' : '3'), version: 1, enabled: true, configured: true, configuredFields: { partnerId: true, credential: true, monthlyAccount: true, callbackSecret: true }, configHash: hash('4'), readiness: 'READY', createdBy: address('1'), createdAt: '2026-07-16T00:00:00.000Z', ...overrides };
}

function warehouse(overrides: Record<string, unknown> = {}) {
  return { artifactVersion, warehouseId: 'warehouse-platform-1', warehouseVersionId: hash('2'), version: 1, warehouseKind: 'PLATFORM', name: '平台一仓', partnerName: null, regionCode: '210202', enabled: true, access: 'FULL', contactName: '负责人', phone: '13800000000', addressLine: '大连市中山路 1 号', payloadHash: hash('6'), createdBy: address('1'), createdAt: '2026-07-16T00:00:00.000Z', ...overrides };
}

function waybill(overrides: Record<string, unknown> = {}) {
  return { artifactVersion, requestId: hash('7'), batchId: hash('8'), merchantId: 'merchant-2', orderId: 'order-1', storeId: 'store-2', provider: 'KUAIDI100', carrierCode: 'SF', state: 'PENDING_PROVIDER', providerReference: null, trackingNumber: null, trackingNumberHash: null, shipmentEvidenceHash: null, printJobId: null, errorCode: null, updatedAt: '2026-07-16T00:00:00.000Z', ...overrides };
}

function printJob(overrides: Record<string, unknown> = {}) {
  return { artifactVersion, printJobId: hash('9'), merchantId: 'merchant-2', orderId: 'order-1', storeId: 'store-2', jobKind: 'WAYBILL', provider: 'FEIE', deviceId: 'printer-1', copyCount: 1, contentHash: hash('a'), state: 'RETRYABLE', attempts: 1, providerReference: null, errorCode: 'TIMEOUT', nextAttemptAt: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:01:00.000Z', ...overrides };
}

function walletProvider(wallet: string) {
  return { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [wallet] : '0xsigned') };
}

function body(init?: RequestInit) { return JSON.parse(String(init?.body)) as unknown; }
function nonceResponse() { return jsonResponse({ message: 'SIWE message', nonce: 'nonce', issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2026-07-16T00:05:00.000Z' }, 201); }
function coreError(code: string, message: string, status: number) { return jsonResponse({ error: { code, message, correlationId: `logistics-${status}` } }, status); }
function unexpected(url: string) { return coreError('InvalidRequest', `Unexpected logistics request ${url}`, 400); }
function jsonResponse(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

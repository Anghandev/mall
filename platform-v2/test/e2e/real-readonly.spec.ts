import { expect, test, type Page } from '@playwright/test';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const method = route.request().method().toUpperCase();
    if (WRITE_METHODS.has(method)) return route.abort('blockedbyclient');
    return route.continue();
  });
});

test('Mall reads bootstrap, catalog and seckill through the real /core proxy', async ({ page }, testInfo) => {
  const evidence = collectEvidence(page);
  await page.goto('http://127.0.0.1:4311/mall/seckill', { waitUntil: 'networkidle' });
  await expect(page.locator('main').first()).toBeVisible();

  const bootstrap = await readonlyJson(page, '/core/v2/bootstrap');
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.body.status).toBe('CORE_API_READY');

  const catalog = await readonlyJson(page, '/core/v2/catalog/products');
  expect(catalog.status).toBeLessThan(500);

  const seckill = await readonlyJson(page, '/core/v2/seckill/sessions/current');
  expect(seckill.status).toBeLessThan(500);

  await page.screenshot({ path: testInfo.outputPath('mall-real-readonly.png'), fullPage: true });
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.writeRequests).toEqual([]);
  expect(evidence.appCoreReads.some((url) => url.includes('/core/v2/bootstrap'))).toBe(true);
  expect(evidence.appCoreReads.some((url) => url.includes('/core/v2/catalog/products'))).toBe(true);
  expect(evidence.appCoreReads.some((url) => url.includes('/core/v2/seckill/sessions/current'))).toBe(true);
});

test('Merchant stays guarded while reading Core bootstrap through /core', async ({ page }, testInfo) => {
  const evidence = collectEvidence(page);
  await page.goto('http://127.0.0.1:4312/merchant/', { waitUntil: 'networkidle' });
  await expect(page.locator('main').first()).toBeVisible();

  const bootstrap = await readonlyJson(page, '/core/v2/bootstrap');
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.body.status).toBe('CORE_API_READY');
  await expect(page.getByText(/连接商家钱包|商家入驻|系统连接失败|系统已连接/).first()).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('merchant-real-readonly.png'), fullPage: true });
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.writeRequests).toEqual([]);
  expect(evidence.appCoreReads.some((url) => url.includes('/core/v2/bootstrap'))).toBe(true);
});

test('Admin CoreStatus reflects the real bootstrap without write requests', async ({ page }, testInfo) => {
  const evidence = collectEvidence(page);
  await page.goto('http://127.0.0.1:4313/platform/core-status', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible();

  const bootstrap = await readonlyJson(page, '/core/v2/bootstrap');
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.body.status).toBe('CORE_API_READY');
  await expect(page.getByText(/系统已连接|安全关闭|后台服务不可用/).first()).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('admin-real-readonly.png'), fullPage: true });
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.writeRequests).toEqual([]);
  expect(evidence.appCoreReads.some((url) => url.includes('/core/v2/bootstrap'))).toBe(true);
});

function collectEvidence(page: Page) {
  const evidence = {
    appCoreReads: [] as string[],
    helperCoreReads: [] as string[],
    writeRequests: [] as string[],
    pageErrors: [] as string[],
  };
  page.on('request', (request) => {
    const url = request.url();
    const method = request.method().toUpperCase();
    if (WRITE_METHODS.has(method)) evidence.writeRequests.push(`${method} ${url}`);
    if (!WRITE_METHODS.has(method) && url.includes('/core/')) {
      const target = request.headers()['x-abu24k-smoke-helper'] === '1' ? evidence.helperCoreReads : evidence.appCoreReads;
      target.push(`${method} ${url}`);
    }
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  return evidence;
}

async function readonlyJson(page: Page, path: string) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json', 'x-abu24k-smoke-helper': '1' } });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body: body as { status?: string } };
  }, path);
}

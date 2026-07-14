import { expect, test } from '@playwright/test';

const screenshotRoutes = [
  { path: '/seckill', name: 'seckill' },
  { path: '/mall', name: 'mall' },
  { path: '/stores', name: 'stores' },
  { path: '/assets', name: 'assets' },
] as const;

test('primary mobile shell is usable and does not overflow', async ({ page }, testInfo) => {
  for (const route of screenshotRoutes) {
    await page.goto(route.path);
    await expect(page.getByRole('navigation', { name: '主要导航' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectHealthyDocument(page);

    if (route.path === '/seckill' || testInfo.project.name === 'mobile-393') {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.project.name}-${route.name}.png`,
        fullPage: true,
      });
    }
  }

  const viewport = page.viewportSize();
  if (viewport && viewport.width > 430) {
    const frame = await page.locator('.app-frame').boundingBox();
    expect(frame?.width).toBe(430);
    expect(frame?.x).toBe((viewport.width - 430) / 2);
  }
});

test('detail routes stay inside the mobile frame', async ({ page }) => {
  for (const path of ['/assets/addresses', '/assets/orders', '/assets/activity', '/assets/rewards', '/checkout', '/checkout/review']) {
    await page.goto(path);
    await expect(page.locator('.app-frame')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectHealthyDocument(page);
  }
});

test('production surface exposes no business-refund action', async ({ page }) => {
  await page.goto('/assets/orders');
  await expect(page.getByRole('button', { name: /退款/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /退款/ })).toHaveCount(0);
});

async function expectHealthyDocument(page: import('@playwright/test').Page) {
  const health = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const brokenImages = Array.from(document.images)
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.getAttribute('src'));

    window.scrollTo(0, document.documentElement.scrollHeight);
    const navTop = document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? 0;
    const mainBottom = Math.max(
      ...Array.from(document.querySelectorAll<HTMLElement>('main *'))
        .filter((element) => element.offsetParent !== null)
        .map((element) => element.getBoundingClientRect().bottom),
    );

    return { duplicates, brokenImages, contentClearsNav: mainBottom <= navTop };
  });

  expect(health.duplicates).toEqual([]);
  expect(health.brokenImages).toEqual([]);
  expect(health.contentClearsNav).toBe(true);
}

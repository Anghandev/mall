import { expect, test } from '@playwright/test';

const surfaces = [
  { name: 'Mall', url: 'http://127.0.0.1:4311/seckill' },
  { name: 'Merchant', url: 'http://127.0.0.1:4312/' },
  { name: 'Admin', url: 'http://127.0.0.1:4313/' },
] as const;

for (const surface of surfaces) {
  test(`${surface.name} renders a bounded fail-closed surface`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(surface.url, { waitUntil: 'networkidle' });

    await expect(page.locator('main').first()).toBeVisible();
    expect(await page.locator('button:disabled').count()).toBeGreaterThan(0);
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(50);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `${surface.name} horizontal overflow`,
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });
}

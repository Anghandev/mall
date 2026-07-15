import { expect, test } from '@playwright/test';
import { artifactVersion } from '@abu24k/core-artifacts';

import { product } from '../payment-fixtures';
import { relayEvent, seckillSession, seckillSessionId } from '../seckill-fixtures';

const screenshotRoutes = [
  { path: '/seckill', name: 'seckill' },
  { path: '/mall', name: 'mall' },
  { path: '/stores', name: 'stores' },
  { path: '/assets', name: 'assets' },
] as const;

test('primary mobile shell is usable and does not overflow', async ({ page }, testInfo) => {
  await mockPublicCore(page);
  for (const route of screenshotRoutes) {
    await page.goto(route.path);
    await expect(page.getByRole('navigation', { name: '主要导航' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectHealthyDocument(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    if (route.path === '/seckill') {
      await expect(page.getByRole('heading', { name: product.title })).toBeVisible();
      await expect(page.getByText(/链上最终购买，接力时间增加 30 秒/)).toBeVisible();
      await expect(page.getByText(/00:5[89]:[0-5][0-9]/)).toBeVisible();
      await expect(page.getByText(/00:00:[0-5][0-9]/)).toBeVisible();
    }

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

test('detail routes stay inside the mobile frame', async ({ page }, testInfo) => {
  await mockPublicCore(page);
  for (const path of ['/assets/addresses', '/assets/orders', '/assets/activity', '/assets/rewards', '/assets/notifications', '/checkout', '/checkout/review']) {
    await page.goto(path);
    await expect(page.locator('.app-frame')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectHealthyDocument(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (testInfo.project.name === 'mobile-393' && ['/assets/rewards', '/assets/notifications'].includes(path)) {
      await page.screenshot({
        path: `test-results/screenshots/${testInfo.project.name}-${path.split('/').at(-1)}.png`,
        fullPage: true,
      });
    }
  }
});

test('production surface exposes no business-refund action', async ({ page }) => {
  await mockPublicCore(page);
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

async function mockPublicCore(page: import('@playwright/test').Page) {
  const session = seckillSession();
  const event = relayEvent();
  await page.route('**/v2/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (() => {
      if (url.pathname === '/v2/bootstrap') return {
        artifactVersion,
        status: 'CORE_API_READY',
        readiness: {
          chainId: 56,
          assets: {},
          decisionBlocked: [],
          externalBlocked: [],
          paymentDecisionBlocked: [],
          paymentExternalBlocked: [],
          providers: {},
          writesEnabled: true,
        },
      };
      if (url.pathname === '/v2/catalog/products') return { products: [product] };
      if (url.pathname === '/v2/seckill/sessions/current') return session;
      if (url.pathname === '/v2/seckill/sessions/history') return {
        items: [{ ...session, phase: 'SETTLED', storedPhase: 'SETTLED', winnerWallet: session.lastBuyerWallet }],
        nextCursor: null,
      };
      if (url.pathname === `/v2/seckill/sessions/${seckillSessionId}/events`) return { items: [event], nextCursor: '1' };
      if (url.pathname === `/v2/seckill/sessions/${seckillSessionId}`) return session;
      if (url.pathname === '/v2/cms/public') return [];
      if (url.pathname === '/v2/stores') return { stores: [] };
      return { error: { code: 'UnknownState', message: 'E2E route not configured' } };
    })();
    const status = 'error' in json ? 404 : 200;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });
}

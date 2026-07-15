import { expect, test } from '@playwright/test';
import { artifactVersion } from '@abu24k/core-artifacts';

import { catalogCategories, catalogTags, publicMediaAccess } from '../catalog-fixtures';
import {
  buyerOverview,
  buyerProfile,
  buyerSavedAddress,
  buyerTakeoverTimeline,
  parsedBuyerAddress,
} from '../account-fixtures';
import { buyerActionResult, orderActionEvidence } from '../evidence-fixtures';
import { deliveryOrder, deliveryOrderTarget } from '../fulfillment-fixtures';
import { product, productVideoAssetId } from '../payment-fixtures';
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

test('buyer evidence form is keyboard-addressable and fits the mobile frame', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-393', 'Focused mobile evidence acceptance');
  await mockWallet(page);
  await mockPublicCore(page);
  await page.goto('/assets/orders');
  await page.getByRole('button', { name: '连接钱包' }).click();
  const exchange = page.getByRole('button', { name: '申请换货' });
  await exchange.focus();
  await page.keyboard.press('Enter');
  const reasonCode = page.getByLabel('原因代码');
  await expect(reasonCode).toBeVisible();
  for (let index = 0; index < 12 && !await reasonCode.evaluate((element) => element === document.activeElement); index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(reasonCode).toBeFocused();
  await reasonCode.fill('PACKAGE_DAMAGED');
  await expect(page.getByLabel(/证据文件（可选）/)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,application/pdf');
  await page.getByRole('button', { name: /封装证据并提交/ }).click();
  await expect(page.getByRole('status')).toContainText('操作已由 Core 接收');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('skip-link'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expectHealthyDocument(page);
  await page.screenshot({ path: 'test-results/screenshots/mobile-393-order-evidence.png', fullPage: true });
});

test('buyer account and address review fit the mobile frame and remain keyboard operable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-393', 'Focused account acceptance');
  await mockWallet(page);
  await mockPublicCore(page);
  await page.goto('/assets');
  await page.getByRole('button', { name: '连接钱包' }).click();
  await expect(page.getByRole('heading', { name: buyerProfile.nickname! })).toBeVisible();
  await expect(page.getByText('买家 UID：DecisionBlocked')).toBeVisible();
  await page.getByRole('link', { name: '打开我的收货地址' }).click();
  const rawText = page.getByLabel('地址文本');
  await rawText.fill('张三 13800138000 辽宁省大连市中山区示例路 24 号');
  await page.getByRole('button', { name: '解析并复核' }).focus();
  await page.keyboard.press('Enter');
  const reviewHeading = page.getByRole('heading', { name: '复核识别结果' });
  await expect(reviewHeading).toBeVisible();
  await expect(reviewHeading).toBeFocused();
  await expect(page.getByRole('button', { name: /确认并保存/ })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expectHealthyDocument(page);
  await page.screenshot({ path: 'test-results/screenshots/mobile-393-buyer-account.png', fullPage: true });
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
      if (url.pathname === '/v2/catalog/categories') return { categories: catalogCategories };
      if (url.pathname === '/v2/catalog/tags') return { tags: catalogTags };
      const mediaAssetId = /^\/v2\/media\/assets\/(0x[0-9a-f]{64})\/access$/.exec(url.pathname)?.[1];
      if (mediaAssetId) {
        const access = publicMediaAccess(mediaAssetId);
        return {
          ...access,
          ...(mediaAssetId === productVideoAssetId ? {} : { contentType: 'image/png' }),
          readUrl: 'http://127.0.0.1:4311/brand/store-front.png',
        };
      }
      if (url.pathname === '/v2/seckill/sessions/current') return session;
      if (url.pathname === '/v2/seckill/sessions/history') return {
        items: [{ ...session, phase: 'SETTLED', storedPhase: 'SETTLED', winnerWallet: session.lastBuyerWallet }],
        nextCursor: null,
      };
      if (url.pathname === `/v2/seckill/sessions/${seckillSessionId}/events`) return { items: [event], nextCursor: '1' };
      if (url.pathname === `/v2/seckill/sessions/${seckillSessionId}`) return session;
      if (url.pathname === '/v2/cms/public') return [];
      if (url.pathname === '/v2/stores') return { stores: [] };
      if (url.pathname === '/v2/auth/nonce') return { message: 'Sign in to Abu 24K V2' };
      if (url.pathname === '/v2/auth/verify') return {
        token: 'e2e-buyer-session',
        walletAddress: deliveryOrder.buyerWallet,
        roles: ['BUYER'],
      };
      if (url.pathname === '/v2/orders') return { orders: [deliveryOrder], nextCursor: null };
      if (url.pathname === '/v2/buyer/profile') return buyerProfile;
      if (url.pathname === '/v2/buyer/overview') return buyerOverview;
      if (url.pathname === '/v2/buyer/addresses/parse') return parsedBuyerAddress;
      if (url.pathname === '/v2/buyer/addresses' && route.request().method() === 'POST') return buyerSavedAddress;
      if (url.pathname === '/v2/buyer/addresses') return { artifactVersion, addresses: [buyerSavedAddress] };
      if (url.pathname === `/v2/orders/${deliveryOrder.orderId}/takeover-timeline`) return buyerTakeoverTimeline;
      if (url.pathname === '/v2/actions/order') return { allowedActions: [{ action: 'REQUEST_EXCHANGE', enabled: true }] };
      if (url.pathname === `/v2/orders/${deliveryOrder.orderId}/fulfillment-target`) return { target: deliveryOrderTarget };
      if (url.pathname === '/v2/settlements') return {
        artifactVersion,
        wallet: deliveryOrder.buyerWallet,
        balances: [],
        points: [],
        requests: [],
      };
      if (url.pathname === '/v2/notifications') return [];
      if (url.pathname === `/v2/orders/${deliveryOrder.orderId}/evidence`) {
        return orderActionEvidence('REQUEST_EXCHANGE', 'PACKAGE_DAMAGED');
      }
      if (url.pathname === `/v2/orders/${deliveryOrder.orderId}/exchange-requests`) {
        return buyerActionResult('REQUEST_EXCHANGE');
      }
      return { error: { code: 'UnknownState', message: 'E2E route not configured' } };
    })();
    const status = 'error' in json ? 404 : 200;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });
}

async function mockWallet(page: import('@playwright/test').Page) {
  await page.addInitScript(({ buyer }) => {
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [buyer];
          if (method === 'eth_chainId') return '0x38';
          if (method === 'personal_sign') return `0x${'11'.repeat(65)}`;
          throw new Error(`Unsupported wallet method ${method}`);
        },
      },
    });
  }, { buyer: deliveryOrder.buyerWallet });
}

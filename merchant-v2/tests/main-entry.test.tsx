import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { merchantDeployment } from '../src/bootstrap';

describe('merchant production path entry', () => {
  it('mounts the real BrowserRouter entry on a /merchant/ deep link', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState({}, '', '/merchant/dashboard?__merchant_visual_review__=1');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Core is intentionally offline in the router smoke test');
    });

    await import('../src/main');

    expect(await screen.findByRole('heading', { name: '运营大盘' })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: '商家工作台导航' });
    expect(within(navigation).getByRole('link', { name: /履约交付/ }).getAttribute('href'))
      .toBe('/merchant/fulfillment');
    expect(merchantDeployment).toEqual({
      publicBasePath: '/merchant/',
      routerBasename: '/merchant',
      coreApiBaseUrl: '/core',
    });
  });
});

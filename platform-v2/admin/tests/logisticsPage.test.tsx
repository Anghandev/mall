import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const blockedGuaranteeCopy = /一键缴纳保证金|待缴纳保证金|保证金收款钱包|手动补录|1,000\.00 USDT|1000 USDT|保证金不足|保证金充值暂未开放|Merchant is not eligible for publication/;

function renderAt(path: string) {
  vi.stubGlobal('fetch', vi.fn());
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.ethereum;
});

describe('Admin logistics operations', () => {
  it('keeps the retired logistics route out of navigation and redirects to the dashboard', async () => {
    renderAt('/logistics');
    expect(await screen.findByRole('heading', { name: '今日运营态势' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /物流配置/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });
});

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

describe('Admin global operations page', () => {
  it('opens the simplified global resource page fail-closed before wallet login', async () => {
    renderAt('/global-operations');
    expect(await screen.findByRole('heading', { name: '全局资源操作' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /连接管理钱包|连接钱包|钱包登录/ }).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });
});

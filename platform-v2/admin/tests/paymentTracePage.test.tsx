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

describe('global clearing workspace', () => {
  it('renders clearing audit read-only and does not expose money movement commands', () => {
    renderAt('/clearing');
    expect(screen.getByRole('heading', { name: '全局清算审计' })).toBeTruthy();
    expect(screen.getByText(/这里只能查看，不提供转账或执行按钮/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发起转账|执行转账/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });
});

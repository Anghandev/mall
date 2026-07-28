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

describe('platform risk workspace', () => {
  it('renders risk controls behind platform wallet authorization', () => {
    renderAt('/risk');
    expect(screen.getByRole('heading', { name: '风控处置中心' })).toBeTruthy();
    expect(screen.getByText(/真实风险证据仅向管理员、运营和审计开放/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });
});

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

describe('governed Admin forms', () => {
  it('keeps policy, system config and CMS forms behind wallet login with simple copy', () => {
    renderAt('/policy');
    expect(screen.getByRole('heading', { name: '规则治理工作台' })).toBeTruthy();
    expect(screen.getAllByText(/不需要手填编号|连接平台治理钱包/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('renders system config as a guarded production configuration surface', () => {
    renderAt('/system');
    expect(screen.getByRole('heading', { name: '系统配置' })).toBeTruthy();
    expect(screen.getAllByText(/密钥只填引用名|连接平台钱包/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('renders CMS as wallet-guarded content operations', () => {
    renderAt('/cms');
    expect(screen.getByRole('heading', { name: '内容中心' })).toBeTruthy();
    expect(screen.getAllByText(/审核员只读|管理员和运营可创建/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });
});

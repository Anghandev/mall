import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { CopyableWallet } from '../src/components/CopyableWallet';

const blockedGuaranteeCopy = /一键缴纳保证金|待缴纳保证金|保证金收款钱包|手动补录|1,000\.00 USDT|1000 USDT|保证金不足|保证金充值暂未开放|Merchant is not eligible for publication/;
const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function renderAt(path: string) {
  vi.stubGlobal('fetch', vi.fn());
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand });
  delete window.ethereum;
});

describe('Admin global operations page', () => {
  it('opens the simplified global resource page fail-closed before wallet login', async () => {
    renderAt('/global-operations');
    expect(await screen.findByRole('heading', { name: '全局资源操作' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /连接管理钱包|连接钱包|钱包登录/ }).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(blockedGuaranteeCopy);
  });

  it('renders the complete buyer wallet with a copy affordance', () => {
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    render(<CopyableWallet label="买家钱包" value={wallet} />);
    expect(screen.getByText(wallet)).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制买家钱包' })).toBeTruthy();
  });

  it('uses the legacy copy fallback before showing copied', async () => {
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    render(<CopyableWallet label="买家钱包" value={wallet} />);
    fireEvent.click(screen.getByRole('button', { name: '复制买家钱包' }));

    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('does not report copied when the browser exposes no copy method', () => {
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });

    render(<CopyableWallet label="买家钱包" value={wallet} />);
    fireEvent.click(screen.getByRole('button', { name: '复制买家钱包' }));

    expect(screen.queryByText('已复制')).toBeNull();
  });
});

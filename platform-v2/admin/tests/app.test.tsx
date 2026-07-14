import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactVersion, executableOrderActionNames } from '@abu24k/core-artifacts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { coreState } from '../src/coreState';

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe('platform admin fail-closed experience', () => {
  it('boots against the coordinated Core artifact version', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@abu24k/core-artifacts']).toBe(`workspace:${artifactVersion}`);
    expect(productBaseline.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactVersion).toBe(artifactVersion);
    expect(coreState.artifactStatus).toBe('coordinated-rc');
    expect(coreState.connectionLabel).toContain(artifactVersion);
  });

  it('keeps every write disabled when Core publishes no executable order action', () => {
    expect(executableOrderActionNames).toEqual([]);
    expect(coreState.executableOrderActionNames).toEqual(executableOrderActionNames);
    expect(productBaseline.adminCapabilities.writes).toBe(false);
    expect(coreState.canWrite).toBe(false);

    renderAt('/policy');
    expect(screen.getByRole('button', { name: '发布新 policyVersion' }).hasAttribute('disabled')).toBe(true);
  });

  it('renders unavailable dashboard values instead of synthetic zeroes', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: '今日运营态势' })).toBeTruthy();
    expect(screen.getAllByText('不可用').length).toBeGreaterThan(4);
    expect(screen.getAllByText(coreState.connectionLabel).length).toBeGreaterThan(0);
  });

  it('keeps global query and every batch action disabled without Core contracts', () => {
    renderAt('/catalog');
    expect(screen.getByRole('heading', { name: '商品主数据' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查询' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /逻辑软删除/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/普通资源也必须由 Core/)).toBeTruthy();
  });

  it('never renders a delete action for append-only audit records', () => {
    renderAt('/audit');
    expect(screen.getByRole('heading', { name: '日志中心' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(screen.getByText(/不可删除资源/)).toBeTruthy();
  });

  it('makes the takeover center visible while execution remains blocked', () => {
    renderAt('/takeover');
    expect(screen.getByRole('heading', { name: '商家接管履约中心' })).toBeTruthy();
    expect(screen.getByText('保证金 → 未占用资产 → 平台风险准备金')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开履约证据' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('shows every governance gate and blocks publication', () => {
    renderAt('/policy');
    expect(screen.getByText('RBAC 授权')).toBeTruthy();
    expect(screen.getByText('二次钱包签名')).toBeTruthy();
    expect(screen.getByText('Safe 多签')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发布新 policyVersion' }).hasAttribute('disabled')).toBe(true);
  });

  it('supports keyboard navigation between product modules', async () => {
    const user = userEvent.setup();
    renderAt('/');
    const navigation = screen.getByRole('navigation', { name: '平台后台模块' });
    await user.click(within(navigation).getByRole('link', { name: /接管履约/ }));
    expect(screen.getByRole('heading', { name: '商家接管履约中心' })).toBeTruthy();
  });
});

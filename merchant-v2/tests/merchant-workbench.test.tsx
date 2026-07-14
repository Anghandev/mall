import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { artifactVersion } from '@abu24k/core-artifacts';
import { App } from '../src/App';
import { productBaseline } from '../src/bootstrap';
import { canExecuteOrderAction, coreBoundary } from '../src/core-boundary';
import { AssetsPage } from '../src/pages/AssetsPage';
import { FulfillmentPage } from '../src/pages/FulfillmentPage';
import { HelpPage } from '../src/pages/HelpPage';
import { LoginPage } from '../src/pages/LoginPage';
import { ProductPage } from '../src/pages/ProductPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { StoresPage } from '../src/pages/StoresPage';

function renderPage(page: React.ReactNode) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

describe('00 wallet gateway', () => {
  it('consumes the coordinated artifact version and keeps unpublished actions disabled', () => {
    expect(artifactVersion).toBe('2.0.0-rc.1');
    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(coreBoundary.artifactVersion).toBe(artifactVersion);
    expect(coreBoundary.artifactsAvailable).toBe(true);
    expect(coreBoundary.executableOrderActionNames).toEqual([]);
    expect(coreBoundary.runtimeAvailable).toBe(false);
    expect(canExecuteOrderAction('RECORD_SHIPMENT')).toBe(false);
    expect(canExecuteOrderAction('CLAIM_MERCHANT_USDT')).toBe(false);
  });

  it('fails closed without a password fallback or enabled wallet action', () => {
    renderPage(<LoginPage />);

    expect(screen.getByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByLabelText(/密码/)).toBeNull();
    expect((screen.getByRole('button', { name: '连接钱包' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Nonce、时间戳、授权商家校验/)).toBeTruthy();
  });

  it('redirects protected routes while merchant runtime authentication is unavailable', async () => {
    window.history.replaceState({}, '', '/dashboard');
    render(<MemoryRouter initialEntries={['/dashboard']}><App /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: '连接授权商家钱包' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '运营大盘' })).toBeNull();
  });
});

describe('02 one-product form', () => {
  it('renders the complete slot and locks every Core-owned write', () => {
    renderPage(<ProductPage />);

    expect(screen.getByRole('heading', { name: '单品提报' })).toBeTruthy();
    expect(screen.getByText(/该单品已被平台秒杀锁定，在场次截止前无权篡改数据/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存提报' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('结算价') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('秒杀专属库存') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('03 fulfillment center', () => {
  it('keeps delivery and pickup streams distinct and never lets the merchant complete receipt', async () => {
    const user = userEvent.setup();
    renderPage(<FulfillmentPage />);

    expect(screen.getByRole('columnheader', { name: '详细地址' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /商家强制签收|直接完成订单/ })).toBeNull();
    expect((screen.getByRole('button', { name: '申请平台审核' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: '到店自提' }));
    expect(screen.getByRole('columnheader', { name: '核销门店' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '核销时间' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '启动扫码' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/不能离线提交/)).toBeTruthy();
  });
});

describe('04 store controls', () => {
  it('forbids manual region entry and blocks device binding', () => {
    renderPage(<StoresPage />);

    const region = screen.getByLabelText('6 位行政区划代码') as HTMLInputElement;
    expect(region.disabled).toBe(true);
    expect(region.readOnly).toBe(true);
    expect(screen.getByText('禁止手工回填。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '绑定设备' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('05 asset rails', () => {
  it('separates USDT proceeds from NPL and BNM projections', () => {
    renderPage(<AssetsPage />);

    expect(screen.getByRole('heading', { name: 'USDT 货款' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '门店奖励池' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '释放跟踪' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /签名提取货款/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('--').length).toBeGreaterThan(5);
  });
});

describe('06 audit and 07 rules', () => {
  it('keeps settlement wallet immutable and audit history unavailable', () => {
    renderPage(<SettingsPage />);

    expect(screen.getByText('普通编辑不可更换')).toBeTruthy();
    expect((screen.getByRole('button', { name: '申请治理迁移' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('审计日志不可用')).toBeTruthy();
  });

  it('shows frozen merchant boundaries while versioned policy content is unavailable', () => {
    renderPage(<HelpPage />);

    expect(screen.getByText('当前规则内容不可用')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '7 天未发货进入平台接管' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '商家不能直接确认签收' })).toBeTruthy();
    expect(screen.getByText(/具体责任和金额必须以已发布政策/)).toBeTruthy();
  });
});

describe('workspace accessibility', () => {
  it('provides labeled navigation, skip link and mobile drawer controls in review mode', () => {
    window.history.replaceState({}, '', '/dashboard?__merchant_visual_review__=1');
    render(<MemoryRouter initialEntries={['/dashboard?__merchant_visual_review__=1']}><App /></MemoryRouter>);

    const navigation = screen.getByRole('navigation', { name: '商家工作台导航' });
    expect(within(navigation).getByRole('link', { name: /履约交付/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开导航' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });
});

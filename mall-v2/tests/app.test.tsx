import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  allowedActionNames,
  artifactVersion,
  executableOrderActionNames,
} from '@abu24k/core-artifacts';
import { MemoryRouter } from 'react-router-dom';

import { MallApp, mallRuntimeBoundary } from '../src/App';
import { isCoreOrderActionExecutable, productBaseline } from '../src/bootstrap';

function renderAt(path = '/seckill') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MallApp />
    </MemoryRouter>,
  );
}

describe('Mall V2 fail-closed application', () => {
  it('keeps all four primary tabs reachable without enabling writes', async () => {
    const user = userEvent.setup();
    renderAt();

    const navigation = screen.getByRole('navigation', { name: '主要导航' });
    for (const label of ['秒杀', '商城', '门店', '资产']) {
      expect(within(navigation).getByRole('link', { name: label })).toBeTruthy();
    }

    await user.click(within(navigation).getByRole('link', { name: '商城' }));
    expect(screen.getByRole('heading', { name: '常规商城' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即购买' }).hasAttribute('disabled')).toBe(true);
    expect(mallRuntimeBoundary).toEqual({
      artifactStatus: '2.0.0-rc.2',
      executableOrderActions: [],
      writesEnabled: false,
      sharedInterface: '@abu24k/core-artifacts',
    });
  });

  it('consumes the coordinated artifact version and fails closed with no executable actions', () => {
    renderAt('/mall');

    expect(productBaseline.coreArtifacts).toBe(artifactVersion);
    expect(artifactVersion).toBe('2.0.0-rc.2');
    expect(productBaseline.knownOrderActions).toBe(allowedActionNames);
    expect(productBaseline.executableOrderActions).toBe(executableOrderActionNames);
    expect(executableOrderActionNames).toHaveLength(0);
    expect(allowedActionNames.every((action) => !isCoreOrderActionExecutable(action))).toBe(true);
    expect(mallRuntimeBoundary.writesEnabled).toBe(false);
    expect(screen.getByRole('button', { name: '立即购买' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows only frozen seckill rules and never classifies locally', async () => {
    const user = userEvent.setup();
    renderAt('/seckill');

    await user.click(screen.getByText('规则说明'));
    expect(screen.getByText(/主场固定 60 分钟/)).toBeTruthy();
    expect(screen.getByText(/增加 30 秒/)).toBeTruthy();
    expect(screen.getByText(/区块时间决定订单归类/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '支付并广播' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps location and native actions disabled without device evidence', () => {
    renderAt('/stores');

    expect((screen.getByRole('combobox', { name: '国家' }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '拨号' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '导航' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/不显示虚构距离/)).toBeTruthy();
  });

  it('labels address fields, validates phone input and never saves locally', async () => {
    const user = userEvent.setup();
    renderAt('/assets/addresses');

    const parser = screen.getByRole('textbox', { name: '地址文本' });
    expect(parser.hasAttribute('disabled')).toBe(true);
    const phone = screen.getByRole('textbox', { name: /^手机号/ });
    await user.type(phone, '123');
    await user.tab();
    expect(screen.getByRole('alert').textContent).toContain('手机号须为 11 位数字');
    expect(screen.getByRole('button', { name: '保存地址' }).hasAttribute('disabled')).toBe(true);
  });

  it('hides entitlement-gated reward modules until eligibility is authoritative', () => {
    renderAt('/assets/rewards');

    expect(screen.getByRole('heading', { name: '消费产出池' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /创世/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /节点/ })).toBeNull();
    expect(screen.getByRole('button', { name: '自主提取 BNM' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps checkout review and wallet broadcast disabled without signed artifacts', () => {
    renderAt('/checkout/review');

    expect(screen.getByText('商品与最终规格')).toBeTruthy();
    expect(screen.getByText('地址或门店')).toBeTruthy();
    expect(screen.getByRole('button', { name: '支付并广播' }).hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).not.toMatch(/申请退款|强制退款|无理由退款/i);
  });

  it('provides accessible names for every icon-only control', () => {
    renderAt('/assets');

    const iconOnlyControls = Array.from(document.querySelectorAll('button, a')).filter(
      (element) => !element.textContent?.trim(),
    );
    for (const element of iconOnlyControls) {
      expect(element.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

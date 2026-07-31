import { describe, expect, it } from 'vitest';
import { formatSignedTokenAmount, translateErrorMessage } from '../src/display';

describe('merchant display error copy', () => {
  it('turns unknown English technical errors into plain Chinese', () => {
    const copy = translateErrorMessage('Order not found');

    expect(copy).toBe('系统返回异常，请刷新或联系平台处理。');
    expect(copy).not.toMatch(/Order not found/i);
  });

  it('explains settlement amount insufficiency in plain Chinese', () => {
    expect(translateErrorMessage('Available settlement balance is insufficient'))
      .toBe('可结算金额不足，请点“可结算金额”按钮自动填入真实金额后再提交。');
  });

  it('explains frozen settlement and RPC blockers in plain Chinese', () => {
    expect(translateErrorMessage('Merchant settlement is frozen')).toContain('商家结算已被系统冻结');
    expect(translateErrorMessage('Fresh wallet coverage evidence is unavailable')).toContain('资金覆盖检查');
    expect(translateErrorMessage('BSC RPC contract request timed out')).toContain('链上节点响应超时');
  });

  it('explains expired and mismatched settlement signatures in plain Chinese', () => {
    expect(translateErrorMessage('Settlement request intent expired'))
      .toBe('签名时间过期了，请重新点击“签名并提交结算申请”，系统会自动生成新的申请。');
    expect(translateErrorMessage('Settlement request signer does not match the bound wallet'))
      .toBe('当前登录钱包和商家结算钱包一致，但系统没有接受这次签名。请重新点击“签名并提交结算申请”，页面会重新生成签名内容。');
    expect(translateErrorMessage('钱包插件当前账户不是商家结算钱包，请切换到 0x1111…1111 后重试。'))
      .toBe('钱包插件当前账户不是商家结算钱包，请切换到 0x1111…1111 后重试。');
  });

  it('formats signed fulfillment token amounts', () => {
    expect(formatSignedTokenAmount('-2000000000000000000', 'USDT')).toBe('-2.00 USDT');
    expect(formatSignedTokenAmount('2000000000000000000', 'USDT')).toBe('2.00 USDT');
    expect(formatSignedTokenAmount(null, 'USDT')).toBe('--');
  });
});

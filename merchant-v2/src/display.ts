import { CoreApiError } from './core-api';

const TOKEN_DECIMALS = 18;
const displayFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const errorCodeLabels: Record<string, string> = {
  InvalidRequest: '填写内容有问题',
  InvalidResponse: '系统返回异常',
  Forbidden: '当前钱包没有权限',
  Unauthorized: '请先连接正确钱包',
  ExternalBlocked: '系统服务暂时异常',
  ConfigurationRequired: '系统配置未完成',
  DecisionBlocked: '暂时不能操作',
  IdempotencyConflict: '操作状态已变化',
  NetworkUnavailable: '网络连接失败',
};

export function formatUsdt(amount: string | null | undefined) {
  return formatTokenAmount(amount, 'USDT');
}

export function formatNpl(amount: string | null | undefined) {
  return formatTokenAmount(amount, 'NPL');
}

export function formatBnm(amount: string | null | undefined) {
  return formatTokenAmount(amount, 'BNM');
}

export function formatTokenAmount(amount: string | null | undefined, symbol: string, decimals = TOKEN_DECIMALS) {
  const value = formatTokenNumber(amount, decimals);
  return value === '--' ? value : `${value} ${symbol}`;
}

export function formatTokenNumber(amount: string | null | undefined, decimals = TOKEN_DECIMALS) {
  if (amount === undefined || amount === null || amount === '') return '--';
  if (!/^[0-9]+$/.test(amount)) return amount;
  const atomic = BigInt(amount);
  if (decimals === 0) return displayFormatter.format(Number(atomic));
  const base = 10n ** BigInt(decimals);
  const cents = (atomic * 100n + base / 2n) / base;
  if (atomic > 0n && cents === 0n) return '<0.01';
  return formatCents(cents);
}

export function parseUsdtInput(value: string, label: string, positive = false) {
  return parseTokenInput(value, label, positive);
}

export function formatUsdtInput(amount: string | null | undefined) {
  return formatTokenInput(amount);
}

export function formatTokenInput(amount: string | null | undefined, decimals = TOKEN_DECIMALS) {
  if (amount === undefined || amount === null || amount === '') return '';
  if (!/^[0-9]+$/.test(amount)) return amount;
  const atomic = BigInt(amount);
  if (decimals === 0) return atomic.toString();
  const base = 10n ** BigInt(decimals);
  const cents = (atomic * 100n + base / 2n) / base;
  return formatCentsPlain(cents);
}

export function parseTokenInput(value: string, label: string, positive = false, decimals = TOKEN_DECIMALS) {
  const text = value.trim().replace(/,/g, '');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) {
    throw new Error(`${label}请填写数字，最多 18 位小数。`);
  }
  const parts = text.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (positive && atomic <= 0n) throw new Error(`${label}必须大于 0。`);
  return atomic.toString();
}

export function formatBpsAsPercent(value: number) {
  return `${(value / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

export function formatConcessionAmount(baseAmount: string | null | undefined, bps: number) {
  if (!baseAmount || !/^[0-9]+$/.test(baseAmount)) return '--';
  return formatUsdt(((BigInt(baseAmount) * BigInt(bps)) / 10_000n).toString());
}

export function concessionAmountToBps(concessionAmount: string, baseAmount: string) {
  const amount = BigInt(concessionAmount);
  const base = BigInt(baseAmount);
  if (base <= 0n) throw new Error('请先填写商品售价，系统才能计算让利。');
  if (amount > base) throw new Error('让利金额不能大于商家基础应收。');
  return Number((amount * 10_000n + base / 2n) / base);
}

export function humanizeError(error: unknown) {
  const code = error instanceof CoreApiError ? error.code : undefined;
  const raw = error instanceof CoreApiError || error instanceof Error ? error.message : '操作失败，请重试。';
  const message = translateErrorMessage(raw);
  const label = code ? errorCodeLabels[code] ?? '操作失败' : '操作失败';
  return `${label}：${message}`;
}

export function translateErrorMessage(message: string) {
  const cleaned = message
    .replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '')
    .replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '')
    .trim();
  if (!cleaned) return '请检查填写内容后重试。';
  if (/Product requires 1-5 verified main images/i.test(cleaned)) return '请先上传 1 到 5 张商品主图，保存草稿后再提交平台审核。';
  if (/Settlement wallet is already merchant-bound/i.test(cleaned)) return '这个钱包已经提交过申请，或已经是商家。请等待审核，或返回登录。';
  if (/Register this wallet in the existing BNM system before checkout|registrationRequired/i.test(cleaned)) return '当前钱包还没有商家后台权限。请先提交入驻申请，或等待平台审核通过后再登录。';
  if (/Wallet is not authorized/i.test(cleaned)) return '当前钱包还没有商家后台权限。请先提交入驻申请，或等待平台审核通过后再登录。';
  if (/Current store state does not allow this operation|store state does not allow/i.test(cleaned)) return '当前门店状态已经不需要或不能执行这个操作，请刷新门店列表后再看可用按钮。';
  if (/Current product state does not allow this operation|product state does not allow/i.test(cleaned)) return '当前商品状态暂不允许这个操作，请刷新商品页后按页面显示的按钮处理。';
  if (/Invalid idempotency key|idempotencyKey|idempotency key|Idempotency key/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/must be an integer from 1 to 100/i.test(cleaned)) return '数量请填写 1 到 100 之间的整数。';
  if (/must be a canonical atomic amount/i.test(cleaned)) return '金额格式不正确，请填写普通数字金额，例如 2 或 2.00。';
  if (/does not match (the )?(coordinated|generated)|generated type|Core returned|Core response|Core API|non-JSON|unreachable|request failed/i.test(cleaned)) return '系统服务暂时无法连接，请刷新或稍后重试。';
  if (/bytes32|TxHash|transaction hash/i.test(cleaned)) return '钱包交易编号格式不正确，请复制钱包里的 0x 开头交易编号。';
  if (/must be an integer between 0 and 10000|bps/i.test(cleaned)) return '让利比例请填写 0 到 100 之间的数字。';
  if (/must contain 8-128 characters/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/Secondary signer mismatch/i.test(cleaned)) return '签名钱包不匹配，请切换到页面要求的钱包后重试。';
  if (/Merchant license storage is unreachable/i.test(cleaned)) return '证照上传服务暂时无法连接，请稍后重试。';
  if (/Merchant license storage rejected the upload/i.test(cleaned)) return '证照上传被存储服务拒绝，请更换文件后重试。';
  if (/Published guarantee policy version was not found/i.test(cleaned)) return '资金规则版本不正确，请刷新页面或联系平台确认当前规则版本。';
  if (/Policy and runtime operations wallets do not match/i.test(cleaned)) return '运营钱包和平台规则不一致，请联系平台确认。';
  if (/Guarantee amount is invalid/i.test(cleaned)) return '金额格式不正确，请填写普通数字金额，例如 2.00。';
  if (/Guarantee transaction hash is invalid/i.test(cleaned)) return '钱包转账编号格式不正确，请复制钱包里的 0x 交易编号。';
  if (/Guarantee idempotency key is invalid|Guarantee deposit idempotency conflict/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/Current merchant role cannot submit this guarantee deposit|Merchant guarantee is outside the wallet scope/i.test(cleaned)) return '当前钱包不是这个商家的结算钱包，不能提交这笔历史资金记录。';
  if (/Core resource unavailable|Core .* unavailable/i.test(cleaned)) return '系统服务暂时无法连接，请稍后重试。';
  if (/Forbidden/i.test(cleaned)) return '当前钱包没有权限执行这个操作。';
  return cleaned;
}

function formatCents(cents: bigint) {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole.toLocaleString('en-US')}.${fraction.toString().padStart(2, '0')}`;
}

function formatCentsPlain(cents: bigint) {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

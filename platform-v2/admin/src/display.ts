import { CoreApiError } from './coreApi';

const TOKEN_DECIMALS = 18;
const displayFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const errorCodeLabels: Record<string, string> = {
  InvalidRequest: '填写内容有问题',
  InvalidResponse: '系统返回异常',
  Forbidden: '当前钱包没有权限',
  Unauthorized: '请先连接正确钱包',
  ExternalBlocked: '系统服务暂时异常',
  ConfigurationRequired: '系统配置未完成',
  DecisionBlocked: '暂时不能操作',
  IdempotencyConflict: '操作状态已变化',
  InvalidSignature: '签名钱包不匹配',
};

export function formatUsdt(amount: string | null | undefined) { return formatTokenAmount(amount, 'USDT'); }
export function formatNpl(amount: string | null | undefined) { return formatTokenAmount(amount, 'NPL'); }
export function formatBnm(amount: string | null | undefined) { return formatTokenAmount(amount, 'BNM'); }
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
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export function formatUsdtInput(amount: string | null | undefined) { return formatTokenInput(amount); }
export function formatTokenInput(amount: string | null | undefined, decimals = TOKEN_DECIMALS) {
  if (amount === undefined || amount === null || amount === '') return '';
  if (!/^[0-9]+$/.test(amount)) return amount;
  const atomic = BigInt(amount);
  if (decimals === 0) return atomic.toString();
  const base = 10n ** BigInt(decimals);
  const cents = (atomic * 100n + base / 2n) / base;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export function parseUsdtInput(value: string, label: string, positive = false) {
  const text = value.trim().replace(/,/g, '');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) throw new Error(`${label}请填写数字，最多 18 位小数。`);
  const parts = text.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const atomic = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (positive && atomic <= 0n) throw new Error(`${label}必须大于 0。`);
  return atomic.toString();
}
export function formatBpsAsPercent(value: number) { return `${(value / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`; }
export function formatConcessionAmount(baseAmount: string | null | undefined, bps: number) {
  if (!baseAmount || !/^[0-9]+$/.test(baseAmount)) return '--';
  return formatUsdt(((BigInt(baseAmount) * BigInt(bps)) / 10_000n).toString());
}
export function shortId(value: string | null | undefined, head = 8, tail = 6) {
  if (!value) return '—';
  return value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}
export function shortAddress(value: string | null | undefined) {
  return shortId(value, 6, 4);
}
export function commonStateLabel(value: string | null | undefined) {
  if (!value) return '—';
  return ({
    ACTIVE: '已启用',
    APPROVED: '已通过',
    AVAILABLE: '可用',
    CANCELLED: '已取消',
    CLOSED: '已关闭',
    DECISION_BLOCKED: '暂不可操作',
    DRAFT: '草稿',
    EXECUTED: '已执行',
    FAILED: '失败',
    FINAL: '已完成',
    FUNDED: '资金已处理',
    INACTIVE: '未启用',
    LOCKED: '锁定中',
    MINED: '确认中',
    NOT_PENDING: '非待审',
    OPEN: '处理中',
    PAID: '已支付',
    PENDING: '待处理',
    PENDING_REVIEW: '待审核',
    PUBLISHED: '已发布',
    READY: '正常',
    REQUESTED: '已申请',
    REVIEW_PENDING: '等待审核',
    SCHEDULED: '待开始',
    SECONDARY_SIGNED: '二次确认已通过',
    SETTLED: '已结算',
    SUBMITTED: '已提交',
  } as Record<string, string>)[value] ?? value;
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
  const specificLabel = specificErrorLabel(raw);
  const message = translateErrorMessage(raw);
  const label = specificLabel ?? (code ? errorCodeLabels[code] ?? '操作失败' : '操作失败');
  return `${label}：${message}`;
}
function specificErrorLabel(message: string) {
  if (/Merchant is not eligible for publication/i.test(message)) return '商家还不能上架';
  return null;
}
export function translateErrorMessage(message: string) {
  const cleaned = message.replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '').replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '').trim();
  if (!cleaned) return '请检查填写内容后重试。';
  if (/Merchant is not eligible for publication/i.test(cleaned)) return '该商家当前不满足商品发布条件。请先到商家中心确认：商家已通过审核、门店已激活，然后再上架。';
  if (/Merchant license evidence is incomplete/i.test(cleaned)) return '该商家还没有上传证照。如果已经线下确认资料，请刷新后重新审核。';
  if (/Current store state does not allow this operation|store state does not allow/i.test(cleaned)) return '当前门店状态已经不需要或不能执行这个操作，请刷新门店列表后再看可用按钮。';
  if (/Current product state does not allow this operation|product state does not allow/i.test(cleaned)) return '当前商品状态暂不允许这个操作，请刷新商品列表后按页面显示的按钮处理。';
  if (/Current merchant role cannot submit this guarantee deposit|Merchant guarantee is outside the wallet scope/i.test(cleaned)) return '当前钱包不是这个商家的结算钱包，不能提交这笔历史资金记录。';
  if (/Core resource unavailable|Core .* unavailable/i.test(cleaned)) return '系统服务暂时无法连接，请稍后重试。';
  if (/Published guarantee policy version was not found/i.test(cleaned)) return '资金规则版本不正确，请刷新页面或确认当前规则版本。';
  if (/Policy and runtime operations wallets do not match/i.test(cleaned)) return '运营钱包和平台规则不一致，请先核对系统配置。';
  if (/Core challenge missing governed approval fields|Governed settlement approval is invalid/i.test(cleaned)) return '系统返回的签名信息不完整，请刷新后重试。';
  if (/Product requires 1-5 verified main images/i.test(cleaned)) return '请先上传 1 到 5 张商品主图，保存草稿后再提交平台审核。';
  if (/Invalid idempotency key|idempotencyKey|idempotency key|Idempotency key/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/must be a canonical atomic amount/i.test(cleaned)) return '金额格式不正确，请填写普通数字金额，例如 2 或 2.00。';
  if (/TxHash must be bytes32|transaction hash|bytes32/i.test(cleaned)) return '交易编号格式不正确，请复制钱包里的 0x 开头交易编号。';
  if (/Buyer UID must be a positive bigint/i.test(cleaned)) return '用户编号请输入正整数。';
  if (/Buyer UID requires exact AND search/i.test(cleaned)) return '按用户编号查询时，请使用“同时满足”和“精确钱包”模式。';
  if (/Wallet must be an exact EVM address/i.test(cleaned)) return '钱包地址格式不正确，请填写完整 0x 地址。';
  if (/Fuzzy wallet must contain/i.test(cleaned)) return '模糊钱包查询请输入 6 到 40 位十六进制字符。';
  if (/Search limit must be 1-100|limit must be an integer between 1 and 100/i.test(cleaned)) return '查询数量请填写 1 到 100。';
  if (/Search start must be before end|must be an ISO date-time/i.test(cleaned)) return '时间范围不正确，请重新选择开始和结束时间。';
  if (/must be a generated enum value|generated enum|cursor requires both fields/i.test(cleaned)) return '筛选条件不完整，请清空后重新选择。';
  if (/does not match (the )?(coordinated|generated)|generated type|Core returned|Core response|Core API|non-JSON|unreachable|request failed|gateway is unavailable/i.test(cleaned)) return '系统服务暂时无法连接，请刷新或稍后重试。';
  if (/must be an integer between 0 and 10000|bps/i.test(cleaned)) return '比例请填写 0 到 100 之间的数字。';
  if (/must contain 8-128 characters/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/Secondary signer mismatch/i.test(cleaned)) return '签名钱包不匹配，请切换到页面要求的钱包后重试。';
  if (/unavailable|unreachable|connection failed/i.test(cleaned)) return '系统服务暂时无法连接，请稍后重试。';
  if (/Forbidden/i.test(cleaned)) return '当前钱包没有权限执行这个操作。';
  return cleaned;
}

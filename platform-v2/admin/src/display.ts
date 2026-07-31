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
  InvalidSignature: '签名没有通过',
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
  if (/Expired or invalid session token|invalid session token|session token/i.test(message)) return '登录已过期';
  if (/SIWE challenge rate limit exceeded|SIWE[^。]*rate limit/i.test(message)) return '钱包登录太频繁';
  return null;
}
export function translateErrorMessage(message: string) {
  const cleaned = message.replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '').replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '').trim();
  if (!cleaned) return '请检查填写内容后重试。';
  if (/SIWE challenge rate limit exceeded|SIWE[^。]*rate limit/i.test(cleaned)) return '钱包登录请求太频繁，请等一会儿再试。不要反复刷新或重复点连接钱包。';
  if (/Expired or invalid session token|invalid session token|session token/i.test(cleaned)) return '登录已过期，请重新连接钱包。';
  if (/PAYMENT_RECEIPT_WORKER_UNHEALTHY/i.test(cleaned)) return '付款回执确认服务异常，系统暂时不允许创建新付款或新秒杀。';
  if (/RUNTIME_SNAPSHOT_EXPIRED|fresh verified runtime readiness snapshot/i.test(cleaned)) return '系统运行检查过期，付款确认服务恢复前不能创建新付款或新秒杀。';
  if (/RPC_DIVERGENCE/i.test(cleaned)) return '链上 RPC 返回不一致，系统暂时不允许创建新付款或新秒杀。';
  if (/PAYMENT_CONFIGURATION_REQUIRED/i.test(cleaned)) return '支付运行配置未完成，系统暂时不允许创建新付款或新秒杀。';
  if (/New payment quotes are blocked by unresolved payment policy/i.test(cleaned)) return '付款资金规则还没发布完整，系统暂时不允许创建新付款或新秒杀。';
  if (/New payment quotes are blocked by unavailable payment infrastructure/i.test(cleaned)) return '付款链路的外部服务还没准备好，系统暂时不允许创建新付款或新秒杀。';
  if (/New payment quote is paused/i.test(cleaned)) return '支付开关处于暂停状态，先恢复支付开关后才能创建新秒杀。';
  if (/Merchant is not eligible for publication/i.test(cleaned)) return '商家暂不满足上架条件，请先完成入驻审核或经营条件。';
  if (/Merchant settlement is frozen/i.test(cleaned)) return '商家结算已被系统冻结；如果商家已入驻且未被冻结，请刷新后重试，仍不行让平台检查服务端经营门槛。';
  if (/Product, merchant or inventory is unavailable/i.test(cleaned)) return '商品、商家或库存当前不可用。请刷新商品和库存状态后重试。';
  if (/Seckill product or merchant is unavailable|Merchant is not eligible for a seckill session/i.test(cleaned)) return '当前商品或商家暂时不能开秒杀。请确认商品已上架、商家已通过且没有被冻结。';
  if (/Activity inventory cannot be locked|Activity inventory exceeds|Active ordinary quote prevents activity inventory lock/i.test(cleaned)) return '活动库存锁定失败。请刷新商品库存，确认可售库存和秒杀提报库存足够后重试。';
  if (/Seckill rules require a policyVersion/i.test(cleaned)) return '秒杀规则还没绑定资金规则版本。去“规则治理”页读取当前资金规则版本，不要自己编。';
  if (/Seckill rules hash does not match policyVersion/i.test(cleaned)) return '秒杀规则正文和资金规则版本对不上。请先在“规则治理”发布匹配的资金规则，再回内容中心重新保存并发布。';
  if (/Session requires the latest published policyVersion/i.test(cleaned)) return '创建秒杀只能用最新版已发布资金规则。请重新读取最新版规则后再创建。';
  if (/Session rules hash does not match its policyVersion/i.test(cleaned)) return '秒杀规则内容和当前资金规则版本对不上。请回内容中心重新保存并发布秒杀规则。';
  if (/Published seckill rules are unavailable for this policy/i.test(cleaned)) return '这版资金规则没有可用的已发布秒杀规则。请先发布秒杀规则，再创建活动。';
  if (/Published policy does not contain the frozen seckill timers/i.test(cleaned)) return '当前资金规则里的秒杀计时参数不符合固定规则，不能创建活动。';
  if (/Seckill approval expired before EOA execution/i.test(cleaned)) return '这条秒杀二次确认已经过期，请取消旧动作后重新创建或重新确认。';
  if (/Session product and SKU must be active/i.test(cleaned)) return '商品或规格还没有上架，先把商品审核通过并上架后再开秒杀。';
  if (/Session start must be a future ISO timestamp/i.test(cleaned)) return '开始时间必须选未来时间，请点快捷时间或重新选择。';
  if (/Fresh wallet coverage evidence is unavailable|Canonical coverage evidence is unavailable/i.test(cleaned)) return '资金覆盖检查还没拿到最新结果，系统暂时不能继续打款或开高风险动作；请稍等后刷新。';
  if (/BSC RPC contract request timed out|Payment receipt RPC operation timed out/i.test(cleaned)) return '链上节点响应超时，系统正在保护资金状态。请稍等后重试，不要连续重复提交。';
  if (/canonical integer string|canonical atomic amount|balance\.amount|amount must/i.test(cleaned)) return '系统返回的金额格式异常，请刷新或联系平台处理。';
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
  if (/Secondary signer mismatch/i.test(cleaned)) return '这次钱包签名没有通过系统校验，请重新点一次签名。';
  if (/unavailable|unreachable|connection failed/i.test(cleaned)) return '系统服务暂时无法连接，请稍后重试。';
  if (/Forbidden/i.test(cleaned)) return '当前钱包没有权限执行这个操作。';
  if (looksLikeTechnicalEnglish(cleaned)) return '系统返回异常，请刷新或联系平台处理。';
  return cleaned;
}

function looksLikeTechnicalEnglish(message: string) {
  return /\b(Order|Wallet|Unexpected|Invalid|Forbidden|Unauthorized|Expired|SIWE|Core|must|not|found|failed|unavailable|canonical|amount|token|session|request|response|error)\b/i.test(message)
    || (!/[\u4e00-\u9fff]/.test(message) && /[A-Za-z]{3,}/.test(message));
}

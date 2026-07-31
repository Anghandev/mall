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

export function formatSignedTokenAmount(amount: string | null | undefined, symbol: string, decimals = TOKEN_DECIMALS) {
  const value = formatSignedTokenNumber(amount, decimals);
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

export function formatSignedTokenNumber(amount: string | null | undefined, decimals = TOKEN_DECIMALS) {
  if (amount === undefined || amount === null || amount === '') return '--';
  if (!/^(0|-?[1-9][0-9]*)$/.test(amount)) return amount;
  if (!amount.startsWith('-')) return formatTokenNumber(amount, decimals);
  const formatted = formatTokenNumber(amount.slice(1), decimals);
  return formatted === '--' ? formatted : `-${formatted}`;
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
  const correlation = error instanceof CoreApiError && error.correlationId
    ? `（系统编号：${shortProblemId(error.correlationId)}）`
    : '';
  return `${label}：${message}${correlation}`;
}

export function translateErrorMessage(message: string) {
  const cleaned = message
    .replace(/^\s*(InvalidRequest|InvalidResponse|Forbidden|ExternalBlocked|ConfigurationRequired|DecisionBlocked)\s*[:：]?\s*/i, '')
    .replace(/\s*[（(][0-9a-f]{8}-[0-9a-f-]{27,}[）)]$/i, '')
    .trim();
  if (!cleaned) return '请检查填写内容后重试。';
  if (/SIWE challenge rate limit exceeded|SIWE[^。]*rate limit/i.test(cleaned)) return '钱包登录请求太频繁，请等一会儿再试。不要反复刷新或重复点连接钱包。';
  if (/Expired or invalid session token|invalid session token|session token/i.test(cleaned)) return '登录已过期，请重新连接钱包。';
  if (/Merchant is not eligible for publication/i.test(cleaned)) return '商家暂不满足上架条件，请先完成入驻审核或经营条件。';
  if (/Merchant settlement is frozen/i.test(cleaned)) return '商家结算已被系统冻结；如果商家已入驻且未被冻结，请刷新后重试，仍不行让平台检查服务端经营门槛。';
  if (/Product, merchant or inventory is unavailable/i.test(cleaned)) return '商品、商家或库存当前不可用。请刷新商品和库存状态后重试。';
  if (/Seckill product or merchant is unavailable|Merchant is not eligible for a seckill session/i.test(cleaned)) return '当前商品或商家暂时不能开秒杀。请确认商品已上架、商家已通过且没有被冻结。';
  if (/Activity inventory cannot be locked|Activity inventory exceeds|Active ordinary quote prevents activity inventory lock/i.test(cleaned)) return '活动库存锁定失败。请刷新商品库存，确认可售库存和秒杀提报库存足够后重试。';
  if (/Fresh wallet coverage evidence is unavailable|Canonical coverage evidence is unavailable/i.test(cleaned)) return '资金覆盖检查还没拿到最新结果，系统暂时不能继续打款或开高风险动作；请稍等后刷新。';
  if (/BSC RPC contract request timed out|Payment receipt RPC operation timed out/i.test(cleaned)) return '链上节点响应超时，系统正在保护资金状态。请稍等后重试，不要连续重复提交。';
  if (/canonical integer string|canonical atomic amount|balance\.amount|amount must/i.test(cleaned)) return '系统返回的金额格式异常，请刷新或联系平台处理。';
  if (/Product requires 1-5 verified main images/i.test(cleaned)) return '请先上传 1 到 5 张商品主图，保存草稿后再提交平台审核。';
  if (/Settlement wallet is already merchant-bound/i.test(cleaned)) return '这个钱包已经提交过申请，或已经是商家。请等待审核，或返回登录。';
  if (/Register this wallet in the existing BNM system before checkout|registrationRequired/i.test(cleaned)) return '当前钱包还没有商家后台权限。请先提交入驻申请，或等待平台审核通过后再登录。';
  if (/Wallet is not authorized/i.test(cleaned)) return '当前钱包还没有商家后台权限。请先提交入驻申请，或等待平台审核通过后再登录。';
  if (/Current store state does not allow this operation|store state does not allow/i.test(cleaned)) return '当前门店状态已经不需要或不能执行这个操作，请刷新门店列表后再看可用按钮。';
  if (/Current product state does not allow this operation|product state does not allow/i.test(cleaned)) return '当前商品状态暂不允许这个操作，请刷新商品页后按页面显示的按钮处理。';
  if (/Invalid idempotency key|idempotencyKey|idempotency key|Idempotency key/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/must be an integer from 1 to 100/i.test(cleaned)) return '数量请填写 1 到 100 之间的整数。';
  if (/Available settlement balance is insufficient|Settlement source is no longer Available|No eligible requested settlement items are available/i.test(cleaned)) return '可结算金额不足，请点“可结算金额”按钮自动填入真实金额后再提交。';
  if (/Settlement request intent expired|NonceExpired|intent expired/i.test(cleaned)) return '签名时间过期了，请重新点击“签名并提交结算申请”，系统会自动生成新的申请。';
  if (/Settlement intent digest does not match|Settlement intent is not active|Settlement intent is bound to another wallet/i.test(cleaned)) return '结算申请已变化或过期，请刷新资产页后重新点“签名并提交结算申请”。不要重复使用旧钱包弹窗。';
  if (/Settlement wallet mismatch|Merchant settlement wallet must sign|Merchant settlement scope does not match/i.test(cleaned)) return '当前商家登录状态和结算钱包校验不一致，请退出后重新连接这个商家的结算钱包。';
  if (/钱包插件当前账户不是商家结算钱包/i.test(cleaned)) return cleaned;
  if (/Settlement request signer does not match|signer does not match|InvalidSignature/i.test(cleaned)) return '当前登录钱包和商家结算钱包一致，但系统没有接受这次签名。请重新点击“签名并提交结算申请”，页面会重新生成签名内容。';
  if (/must be a canonical atomic amount/i.test(cleaned)) return '金额格式不正确，请填写普通数字金额，例如 2 或 2.00。';
  if (/does not match (the )?(coordinated|generated)|generated type|Core returned|Core response|Core API|non-JSON|unreachable|request failed/i.test(cleaned)) return '系统服务暂时无法连接，请刷新或稍后重试。';
  if (/bytes32|TxHash|transaction hash/i.test(cleaned)) return '钱包交易编号格式不正确，请复制钱包里的 0x 开头交易编号。';
  if (/must be an integer between 0 and 10000|bps/i.test(cleaned)) return '让利比例请填写 0 到 100 之间的数字。';
  if (/must contain 8-128 characters/i.test(cleaned)) return '系统提交编号异常，请刷新页面后重试。';
  if (/Secondary signer mismatch/i.test(cleaned)) return '这次钱包签名没有通过系统校验，请重新点一次签名。';
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
  if (looksLikeTechnicalEnglish(cleaned)) return '系统返回异常，请刷新或联系平台处理。';
  return cleaned;
}

function looksLikeTechnicalEnglish(message: string) {
  return /\b(Order|Wallet|Unexpected|Invalid|Forbidden|Unauthorized|Expired|SIWE|Core|must|not|found|failed|unavailable|canonical|amount|token|session|request|response|error)\b/i.test(message)
    || (!/[\u4e00-\u9fff]/.test(message) && /[A-Za-z]{3,}/.test(message));
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


function shortProblemId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

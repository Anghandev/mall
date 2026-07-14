import { CoreError } from './errors.ts';

const BPS = 10_000n;
const QUOTE_VALIDITY_SECONDS = 5 * 60;
const REQUIRED_CONFIRMATIONS = 15;
const SNAPSHOT_REWARD_ROLES = [
  ['genesis', 'genesisBps'],
  ['directReferral', 'directReferralBps'],
  ['district', 'districtBps'],
  ['city', 'cityBps'],
  ['province', 'provinceBps'],
  ['region', 'regionBps'],
] as const;

export interface WeightedDestination {
  account: string;
  weightBps: number;
}

export interface ExactUsdtAllocation {
  account: string;
  amount: bigint;
  purpose: string;
}

export interface FrozenPaymentPolicy {
  policyVersion: number;
  oracleVersion: string;
  usdtPaymentBps: number;
  nplPaymentBps: number;
  nplBurnListPriceBps: number;
  nplRewardListPriceBps: number;
  genesisBps: number;
  directReferralBps: number;
  districtBps: number;
  cityBps: number;
  provinceBps: number;
  regionBps: number;
  operationsBps: number;
  oracleWindowSeconds: number;
  oracleMaxDeviationBps: number;
  oracleMaxAgeSeconds: number;
  oracleMinimumUsdtLiquidity: bigint;
  requiredConfirmations: number;
  merchantGuaranteeMinimumUsdt: bigint;
  usdtCustodySafe?: string;
  nplRewardSafe?: string;
  operationsTreasurySafe?: string;
  circulationPool?: string;
  concessionDestinationSetHash?: string;
  concessionDestinations?: readonly WeightedDestination[];
  operationsDestinations?: readonly WeightedDestination[];
}

export interface PaymentQuoteRequest {
  orderId: string;
  latestPolicyVersion: number;
  buyer: string;
  merchant: string;
  productId: string;
  skuId: string;
  quantity: number;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  fulfillmentTargetHash: string;
  regionCodeHash: string;
  productPolicyHash: string;
  reservationId: string;
  reservationHash: string;
  reservationDeadline: number;
  issuedAt: number;
  deadline: number;
  nonce: bigint;
  listPriceUsdt: bigint;
  nplQuoteAmount: bigint;
  merchantBaseReceivableUsdt: bigint;
  merchantConcessionBps: number;
  otherUsdtAllocations: readonly ExactUsdtAllocation[];
  sessionId?: string;
  beneficiaries: Readonly<Record<string, string>>;
}

export interface CanonicalPaymentIntent {
  orderId: string;
  policyVersion: number;
  oracleVersion: string;
  buyer: string;
  merchant: string;
  productId: string;
  skuId: string;
  quantity: number;
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  fulfillmentTargetHash: string;
  regionCodeHash: string;
  productPolicyHash: string;
  reservationId: string;
  reservationHash: string;
  reservationDeadline: number;
  issuedAt: number;
  deadline: number;
  nonce: string;
  listPriceUsdt: string;
  usdtPaymentAmount: string;
  nplQuoteAmount: string;
  nplPaymentAmount: string;
  nplBurnAmount: string;
  nplRewardAmount: string;
  merchantBaseReceivableUsdt: string;
  merchantConcessionBps: number;
  merchantConcessionAmount: string;
  merchantNetReceivableUsdt: string;
  concessionAllocationHash: string;
  bnmAmount: string;
  seckill: boolean;
  sessionId: string;
  beneficiaries: Readonly<Record<string, string>>;
  merchantConcessionAllocations: readonly { account: string; amount: string }[];
  otherUsdtAllocations: readonly { account: string; amount: string; purpose: string }[];
  nplRewardAllocations: readonly { role: string; account: string; amount: string }[];
  requiredConfirmations: 15;
}

export function buildPaymentIntent(
  request: PaymentQuoteRequest,
  policy: FrozenPaymentPolicy,
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL',
  now = Math.floor(Date.now() / 1000),
): CanonicalPaymentIntent {
  assertPolicyReady(policy);
  if (policy.policyVersion !== request.latestPolicyVersion) {
    throw new CoreError('ArtifactVersionMismatch', 'New payment quote must use the latest policy version', 409);
  }
  validateRequest(request, now);

  const usdtPayment = mulBps(request.listPriceUsdt, policy.usdtPaymentBps);
  const nplPayment = mulBps(request.nplQuoteAmount, policy.nplPaymentBps);
  const nplBurn = mulBps(request.nplQuoteAmount, policy.nplBurnListPriceBps);
  const nplReward = nplPayment - nplBurn;
  if (
    usdtPayment === 0n || nplPayment === 0n
      || (policy.nplBurnListPriceBps > 0 && nplBurn === 0n)
      || (policy.nplRewardListPriceBps > 0 && nplReward === 0n)
  ) {
    throw new CoreError('InvalidRequest', 'Payment amounts are below the minimum atomic unit');
  }
  if (nplReward !== mulBps(request.nplQuoteAmount, policy.nplRewardListPriceBps) && request.nplQuoteAmount % BPS === 0n) {
    throw new CoreError('InvalidRequest', 'NPL reward allocation is inconsistent');
  }
  if (request.merchantBaseReceivableUsdt > usdtPayment) {
    throw new CoreError('InvalidRequest', 'Merchant base receivable exceeds buyer USDT payment');
  }
  const concessionAmount = mulBps(request.merchantBaseReceivableUsdt, request.merchantConcessionBps);
  const merchantNet = request.merchantBaseReceivableUsdt - concessionAmount;
  const concessionAllocations = allocateWeighted(concessionAmount, policy.concessionDestinations!);
  const otherAllocations = canonicalExactAllocations(request.otherUsdtAllocations);
  const otherTotal = otherAllocations.reduce((sum, item) => sum + item.amount, 0n);
  if (merchantNet + concessionAmount + otherTotal !== usdtPayment) {
    throw new CoreError('DecisionBlocked', 'USDT custody liabilities do not equal the signed buyer payment', 409);
  }
  const nplAllocations = allocateNplRewards(
    nplReward,
    request.beneficiaries,
    policy.operationsDestinations!,
    policy.circulationPool!,
    policy,
  );

  return Object.freeze({
    orderId: request.orderId,
    policyVersion: policy.policyVersion,
    oracleVersion: policy.oracleVersion,
    buyer: request.buyer.toLowerCase(),
    merchant: request.merchant.toLowerCase(),
    productId: request.productId,
    skuId: request.skuId,
    quantity: request.quantity,
    fulfillmentMode: request.fulfillmentMode,
    fulfillmentTargetHash: request.fulfillmentTargetHash,
    regionCodeHash: request.regionCodeHash,
    productPolicyHash: request.productPolicyHash,
    reservationId: request.reservationId,
    reservationHash: request.reservationHash,
    reservationDeadline: request.reservationDeadline,
    issuedAt: request.issuedAt,
    deadline: request.deadline,
    nonce: request.nonce.toString(),
    listPriceUsdt: request.listPriceUsdt.toString(),
    usdtPaymentAmount: usdtPayment.toString(),
    nplQuoteAmount: request.nplQuoteAmount.toString(),
    nplPaymentAmount: nplPayment.toString(),
    nplBurnAmount: nplBurn.toString(),
    nplRewardAmount: nplReward.toString(),
    merchantBaseReceivableUsdt: request.merchantBaseReceivableUsdt.toString(),
    merchantConcessionBps: request.merchantConcessionBps,
    merchantConcessionAmount: concessionAmount.toString(),
    merchantNetReceivableUsdt: merchantNet.toString(),
    concessionAllocationHash: policy.concessionDestinationSetHash!,
    bnmAmount: request.listPriceUsdt.toString(),
    seckill: classification === 'SECKILL',
    sessionId: classification === 'SECKILL' ? (request.sessionId ?? '') : `0x${'0'.repeat(64)}`,
    beneficiaries: Object.freeze(normalizeBeneficiaries(request.beneficiaries)),
    merchantConcessionAllocations: Object.freeze(
      concessionAllocations.map((item) => Object.freeze({ account: item.account, amount: item.amount.toString() })),
    ),
    otherUsdtAllocations: Object.freeze(
      otherAllocations.map((item) => Object.freeze({ ...item, amount: item.amount.toString() })),
    ),
    nplRewardAllocations: Object.freeze(
      nplAllocations.map((item) => Object.freeze({ ...item, amount: item.amount.toString() })),
    ),
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
  });
}

export function buildDualPaymentQuote(
  seckillRequest: PaymentQuoteRequest,
  fallbackRequest: PaymentQuoteRequest,
  policy: FrozenPaymentPolicy,
  now = Math.floor(Date.now() / 1000),
) {
  if (!seckillRequest.sessionId || fallbackRequest.sessionId) {
    throw new CoreError('InvalidRequest', 'Seckill session and independent fallback reservation are required');
  }
  validateDualRequests(seckillRequest, fallbackRequest);
  const seckill = buildPaymentIntent(seckillRequest, policy, 'SECKILL', now);
  const fallback = buildPaymentIntent(fallbackRequest, policy, 'FALLBACK_RETAIL', now);
  return Object.freeze({
    sessionId: seckillRequest.sessionId,
    seckill,
    fallback,
    classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP' as const,
  });
}

function validateDualRequests(seckill: PaymentQuoteRequest, fallback: PaymentQuoteRequest) {
  const fields = [
    'orderId',
    'latestPolicyVersion',
    'buyer',
    'merchant',
    'productId',
    'skuId',
    'quantity',
    'fulfillmentMode',
    'fulfillmentTargetHash',
    'regionCodeHash',
    'productPolicyHash',
    'reservationDeadline',
    'issuedAt',
    'deadline',
    'nonce',
    'merchantBaseReceivableUsdt',
    'merchantConcessionBps',
  ] as const;
  if (
    fields.some((field) => seckill[field] !== fallback[field])
      || seckill.reservationId === fallback.reservationId
      || stableJson(seckill.beneficiaries) !== stableJson(fallback.beneficiaries)
  ) throw new CoreError('InvalidRequest', 'Seckill and fallback quote identities do not match');
}

export function assertPolicyReady(policy: FrozenPaymentPolicy) {
  const missing = [
    ['usdtCustodySafe', policy.usdtCustodySafe],
    ['nplRewardSafe', policy.nplRewardSafe],
    ['operationsTreasurySafe', policy.operationsTreasurySafe],
    ['circulationPool', policy.circulationPool],
    ['concessionDestinationSetHash', policy.concessionDestinationSetHash],
    ['concessionDestinations', policy.concessionDestinations],
    ['operationsDestinations', policy.operationsDestinations],
  ].filter(([, value]) => value === undefined);
  if (missing.length > 0) {
    throw new CoreError('ExternalBlocked', 'Payment policy is missing Safe or destination inputs', 409, {
      missing: missing.map(([name]) => name),
    });
  }
  if (
    policy.usdtPaymentBps !== 7_000 ||
    policy.nplPaymentBps !== 3_000 ||
    policy.nplBurnListPriceBps + policy.nplRewardListPriceBps !== policy.nplPaymentBps ||
    policy.oracleWindowSeconds !== 30 * 60 ||
    policy.oracleMaxDeviationBps !== 500 ||
    policy.oracleMaxAgeSeconds !== 10 * 60 ||
    policy.oracleMinimumUsdtLiquidity !== 50_000n * 10n ** 18n ||
    policy.requiredConfirmations !== REQUIRED_CONFIRMATIONS ||
    policy.merchantGuaranteeMinimumUsdt < 1_000n * 10n ** 18n
  ) {
    throw new CoreError('InvalidRequest', 'Frozen launch payment or safety policy is invalid');
  }
  const rewardBps = policy.genesisBps + policy.directReferralBps + policy.districtBps
    + policy.cityBps + policy.provinceBps + policy.regionBps + policy.operationsBps;
  if (rewardBps !== policy.nplRewardListPriceBps) {
    throw new CoreError('InvalidRequest', 'Reward allocation must equal the versioned Reward Safe share');
  }
  if (
    policy.policyVersion === 1
      && (
        policy.nplBurnListPriceBps !== 2_000 || policy.nplRewardListPriceBps !== 1_000
        || policy.genesisBps !== 200 || policy.directReferralBps !== 100 || policy.districtBps !== 120
        || policy.cityBps !== 80 || policy.provinceBps !== 60 || policy.regionBps !== 40
        || policy.operationsBps !== 400
      )
  ) throw new CoreError('InvalidRequest', 'Launch reward policy is invalid');
  for (const address of [
    policy.usdtCustodySafe!,
    policy.nplRewardSafe!,
    policy.operationsTreasurySafe!,
    policy.circulationPool!,
  ]) {
    if (!isAddress(address)) throw new CoreError('InvalidRequest', 'Policy contains an invalid address');
  }
  validateDestinations(policy.concessionDestinations!);
  validateDestinations(policy.operationsDestinations!);
  if (!isBytes32(policy.concessionDestinationSetHash!)) {
    throw new CoreError('InvalidRequest', 'Concession destination hash must be bytes32');
  }
}

function validateRequest(request: PaymentQuoteRequest, now: number) {
  if (request.quantity <= 0 || request.listPriceUsdt <= 0n || request.nplQuoteAmount <= 0n) {
    throw new CoreError('InvalidRequest', 'Invalid payment quantity or amount');
  }
  if (!Number.isInteger(request.merchantConcessionBps) || request.merchantConcessionBps < 0 || request.merchantConcessionBps > 10_000) {
    throw new CoreError('InvalidRequest', 'Merchant concession must be between 0% and 100%');
  }
  for (const [name, value] of Object.entries({
    orderId: request.orderId,
    productId: request.productId,
    skuId: request.skuId,
    fulfillmentTargetHash: request.fulfillmentTargetHash,
    regionCodeHash: request.regionCodeHash,
    productPolicyHash: request.productPolicyHash,
    reservationId: request.reservationId,
    reservationHash: request.reservationHash,
  })) {
    if (!isBytes32(value)) throw new CoreError('InvalidRequest', `${name} must be bytes32`);
  }
  if (!isAddress(request.buyer) || !isAddress(request.merchant) || request.buyer.toLowerCase() === request.merchant.toLowerCase()) {
    throw new CoreError('InvalidRequest', 'Invalid buyer or merchant address');
  }
  if (
    request.issuedAt > now ||
    request.deadline <= now ||
    request.deadline - request.issuedAt > QUOTE_VALIDITY_SECONDS ||
    request.reservationDeadline < request.deadline
  ) {
    throw new CoreError('QuoteExpired', 'Quote or reservation deadline is invalid', 409);
  }
}

function allocateWeighted(amount: bigint, destinations: readonly WeightedDestination[]) {
  validateDestinations(destinations);
  let allocated = 0n;
  return destinations.map((destination, index) => {
    const share = index + 1 === destinations.length ? amount - allocated : mulBps(amount, destination.weightBps);
    allocated += share;
    return { account: destination.account.toLowerCase(), amount: share };
  });
}

function validateDestinations(destinations: readonly WeightedDestination[]) {
  if (destinations.length === 0) throw new CoreError('DecisionBlocked', 'Concession destinations are not configured', 409);
  let total = 0;
  let previous = '';
  for (const destination of destinations) {
    const account = destination.account.toLowerCase();
    if (!isAddress(account) || account <= previous || !Number.isInteger(destination.weightBps) || destination.weightBps <= 0) {
      throw new CoreError('InvalidRequest', 'Concession destinations must be unique, sorted and positive');
    }
    total += destination.weightBps;
    previous = account;
  }
  if (total !== 10_000) throw new CoreError('InvalidRequest', 'Concession destination weights must sum to 100%');
}

function canonicalExactAllocations(allocations: readonly ExactUsdtAllocation[]) {
  let previous = '';
  return allocations.map((allocation) => {
    const account = allocation.account.toLowerCase();
    if (!isAddress(account) || account <= previous || allocation.amount < 0n || allocation.purpose.length === 0) {
      throw new CoreError('InvalidRequest', 'USDT allocations must be unique, sorted and non-negative');
    }
    previous = account;
    return { account, amount: allocation.amount, purpose: allocation.purpose };
  });
}

function allocateNplRewards(
  rewardAmount: bigint,
  beneficiaries: Readonly<Record<string, string>>,
  operationsDestinations: readonly WeightedDestination[],
  circulationPool: string,
  policy: FrozenPaymentPolicy,
) {
  if (rewardAmount === 0n && policy.nplRewardListPriceBps === 0) return [];
  const normalized = normalizeBeneficiaries(beneficiaries);
  let allocated = 0n;
  const entries: { role: string; account: string; amount: bigint }[] = [];
  for (const [role, policyField] of SNAPSHOT_REWARD_ROLES) {
    const amount = proportionalAmount(rewardAmount, policy[policyField], policy.nplRewardListPriceBps);
    allocated += amount;
    const configured = normalized[role];
    entries.push({ role, account: configured && configured !== zeroAddress() ? configured : circulationPool.toLowerCase(), amount });
  }
  const operationsAmount = proportionalAmount(
    rewardAmount,
    policy.operationsBps,
    policy.nplRewardListPriceBps,
  );
  for (const allocation of allocateWeighted(operationsAmount, operationsDestinations)) {
    entries.push({ role: 'operations', account: allocation.account, amount: allocation.amount });
  }
  allocated += operationsAmount;
  if (allocated < rewardAmount) {
    entries.push({ role: 'roundingRemainder', account: circulationPool.toLowerCase(), amount: rewardAmount - allocated });
  }
  return entries;
}

function normalizeBeneficiaries(beneficiaries: Readonly<Record<string, string>>) {
  const normalized: Record<string, string> = {};
  for (const [role] of SNAPSHOT_REWARD_ROLES) {
    const value = beneficiaries[role] ?? zeroAddress();
    if (!isAddress(value)) throw new CoreError('InvalidRequest', `Invalid ${role} beneficiary`);
    normalized[role] = value.toLowerCase();
  }
  return normalized;
}

function proportionalAmount(amount: bigint, shareBps: number, totalBps: number) {
  if (!Number.isInteger(shareBps) || shareBps < 0 || !Number.isInteger(totalBps) || totalBps <= 0) {
    throw new CoreError('InvalidRequest', 'Invalid reward allocation BPS');
  }
  return (amount * BigInt(shareBps)) / BigInt(totalBps);
}

function mulBps(amount: bigint, bps: number | bigint) {
  const value = typeof bps === 'bigint' ? bps : BigInt(bps);
  if (value < 0n || value > BPS) throw new CoreError('InvalidRequest', 'Invalid BPS');
  return (amount * value) / BPS;
}

function isBytes32(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function zeroAddress() {
  return `0x${'0'.repeat(40)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

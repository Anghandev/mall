import { CoreError } from './errors.ts';

const BPS = 10_000n;

export interface FrozenPolicyTerms {
  policyVersion: number;
  oracleVersion: string;
  usdtPaymentBps: number;
  nplPaymentBps: number;
  burnBps: number;
  routeBps: number;
  platformFeeBps?: number;
  seckillPrizeBps?: number;
  merchantStoreBps?: number;
  oracleMaxAgeSeconds?: number;
  oracleMinimumLiquidity?: bigint;
  merchantGuaranteeMinimumUsdt?: bigint;
  platformRiskReserveMinimumUsdt?: bigint;
}

export interface QuoteRequest {
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
  fallbackReservationId?: string;
  fallbackReservationHash?: string;
  reservationDeadline: number;
  nonce: bigint;
  deadline: number;
  listPriceUsdt: bigint;
  rewardBaseNpl: bigint;
  merchantSettlementUsdt?: bigint;
  sessionId?: string;
  beneficiaries: Readonly<Record<string, string>>;
}

export interface CanonicalOrderIntent {
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
  nonce: string;
  deadline: number;
  listPriceUsdt: string;
  usdtPaymentAmount: string;
  nplPaymentAmount: string;
  rewardBaseNpl: string;
  merchantUsdtAmount: string;
  platformUsdtAmount: string;
  prizeUsdtAmount: string;
  usdtRemainderAmount: string;
  burnedNplAmount: string;
  routedNplAmount: string;
  bnmAmount: string;
  seckill: boolean;
  sessionId: string;
  beneficiaries: Readonly<Record<string, string>>;
}

export function buildOrderIntent(
  request: QuoteRequest,
  policy: FrozenPolicyTerms,
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL',
): CanonicalOrderIntent {
  assertPolicyReady(policy);
  if (policy.policyVersion !== request.latestPolicyVersion && classification === 'ORDINARY') {
    throw new CoreError('ArtifactVersionMismatch', 'New quote must use the latest policy version', 409);
  }
  if (request.quantity <= 0 || request.listPriceUsdt <= 0n || request.rewardBaseNpl < 0n) {
    throw new CoreError('InvalidRequest', 'Invalid quote quantity or amount');
  }
  const bytes32Fields: Array<readonly [string, string]> = [
    ['orderId', request.orderId],
    ['oracleVersion', policy.oracleVersion],
    ['productId', request.productId],
    ['skuId', request.skuId],
    ['fulfillmentTargetHash', request.fulfillmentTargetHash],
    ['regionCodeHash', request.regionCodeHash],
    ['productPolicyHash', request.productPolicyHash],
    ['reservationId', request.reservationId],
    ['reservationHash', request.reservationHash],
  ];
  for (const [name, value] of bytes32Fields) {
    if (!isBytes32(value)) throw new CoreError('InvalidRequest', `${name} must be bytes32`);
  }
  if (!isAddress(request.buyer) || !isAddress(request.merchant)) {
    throw new CoreError('InvalidRequest', 'Invalid buyer or merchant address');
  }
  const now = Math.floor(Date.now() / 1000);
  if (request.reservationDeadline <= now || request.deadline < request.reservationDeadline) {
    throw new CoreError('QuoteExpired', 'Quote or reservation deadline is invalid', 409);
  }
  const usdtPayment = mulBps(request.listPriceUsdt, policy.usdtPaymentBps);
  const nplPayment = mulBps(request.rewardBaseNpl, policy.nplPaymentBps);
  const platformAmount = mulBps(request.listPriceUsdt, policy.platformFeeBps!);
  const prizeAmount = classification === 'SECKILL' ? mulBps(request.listPriceUsdt, policy.seckillPrizeBps!) : 0n;
  const merchantAmount = request.merchantSettlementUsdt;
  if (merchantAmount === undefined) throw new CoreError('DecisionBlocked', 'Merchant settlement cost is not frozen', 409);
  const remainder = usdtPayment - merchantAmount - platformAmount - prizeAmount;
  if (remainder < 0n) throw new CoreError('InvalidRequest', 'USDT allocation exceeds signed payment');
  if ((nplPayment * BigInt(policy.burnBps)) % BPS !== 0n) {
    throw new CoreError('InvalidRequest', 'NPL Burn amount is not exactly representable');
  }
  const burnedNpl = mulBps(nplPayment, policy.burnBps);
  const routedNpl = nplPayment - burnedNpl;
  if (burnedNpl + routedNpl !== nplPayment || policy.burnBps + policy.routeBps !== Number(BPS)) {
    throw new CoreError('InvalidRequest', 'NPL Burn/Route conservation failed');
  }
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
    nonce: request.nonce.toString(),
    deadline: request.deadline,
    listPriceUsdt: request.listPriceUsdt.toString(),
    usdtPaymentAmount: usdtPayment.toString(),
    nplPaymentAmount: nplPayment.toString(),
    rewardBaseNpl: request.rewardBaseNpl.toString(),
    merchantUsdtAmount: merchantAmount.toString(),
    platformUsdtAmount: platformAmount.toString(),
    prizeUsdtAmount: prizeAmount.toString(),
    usdtRemainderAmount: remainder.toString(),
    burnedNplAmount: burnedNpl.toString(),
    routedNplAmount: routedNpl.toString(),
    bnmAmount: request.listPriceUsdt.toString(),
    seckill: classification === 'SECKILL',
    sessionId: classification === 'SECKILL' ? (request.sessionId ?? '') : '',
    beneficiaries: Object.freeze({ ...request.beneficiaries }),
  });
}

export function buildDualQuote(request: QuoteRequest, policy: FrozenPolicyTerms) {
  if (!request.sessionId || !request.fallbackReservationId || !request.fallbackReservationHash) {
    throw new CoreError('InvalidRequest', 'Seckill session and independent fallback reservation are required');
  }
  const seckill = buildOrderIntent(request, policy, 'SECKILL');
  const fallbackRequest: QuoteRequest = {
    ...request,
    reservationId: request.fallbackReservationId,
    reservationHash: request.fallbackReservationHash,
  };
  delete fallbackRequest.sessionId;
  delete fallbackRequest.fallbackReservationId;
  delete fallbackRequest.fallbackReservationHash;
  const fallback = buildOrderIntent(fallbackRequest, policy, 'FALLBACK_RETAIL');
  return Object.freeze({ sessionId: request.sessionId, seckill, fallback, classificationAuthority: 'CHAIN_TIMESTAMP' });
}

export function assertPolicyReady(policy: FrozenPolicyTerms) {
  const missing = [
    ['platformFeeBps', policy.platformFeeBps],
    ['seckillPrizeBps', policy.seckillPrizeBps],
    ['merchantStoreBps', policy.merchantStoreBps],
    ['oracleMaxAgeSeconds', policy.oracleMaxAgeSeconds],
    ['oracleMinimumLiquidity', policy.oracleMinimumLiquidity],
    ['merchantGuaranteeMinimumUsdt', policy.merchantGuaranteeMinimumUsdt],
    ['platformRiskReserveMinimumUsdt', policy.platformRiskReserveMinimumUsdt],
  ].filter(([, value]) => value === undefined);
  if (missing.length > 0) {
    throw new CoreError('DecisionBlocked', 'Policy has unresolved production values', 409, {
      missing: missing.map(([name]) => name),
    });
  }
  if (
    policy.usdtPaymentBps + policy.nplPaymentBps !== Number(BPS) ||
    policy.burnBps + policy.routeBps !== Number(BPS)
  ) {
    throw new CoreError('InvalidRequest', 'Policy conservation is invalid');
  }
}

function mulBps(amount: bigint, bps: number) {
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS)) throw new CoreError('InvalidRequest', 'Invalid BPS');
  return (amount * BigInt(bps)) / BPS;
}

function isBytes32(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

import { AbiCoder, TypedDataEncoder, getAddress, keccak256, type TypedDataDomain } from 'ethers';
import type { CanonicalPaymentIntent } from './checkout.ts';
import { BSC_CHAIN_ID } from './enums.ts';
import { CoreError } from './errors.ts';

const PAYMENT_INTENT_ABI =
  'tuple(bytes32 orderId,uint64 policyVersion,address buyer,address merchant,bytes32 productId,bytes32 skuId,uint32 quantity,uint8 fulfillmentMode,bytes32 fulfillmentTargetHash,bytes32 regionCodeHash,bytes32 productPolicyHash,bytes32 reservationId,bytes32 reservationHash,uint64 reservationDeadline,uint64 issuedAt,uint64 deadline,uint256 nonce,uint256 listPriceUsdt,uint256 productUsdtPaymentAmount,uint256 platformServiceFeeUsdt,uint256 custodyProductUsdt,uint256 freightUsdt,uint256 usdtPaymentAmount,uint256 nplQuoteAmount,uint256 nplPaymentAmount,uint256 nplBurnAmount,uint256 nplRewardAmount,uint256 merchantBaseReceivableUsdt,uint16 merchantConcessionBps,uint256 merchantConcessionAmount,uint256 merchantNetReceivableUsdt,bytes32 concessionAllocationHash,uint256 bnmAmount,bool seckill,bytes32 sessionId,tuple(address genesis,address directReferral,address district,address city,address province,address region) beneficiaries)';
const SECKILL_INTENT_ABI =
  `tuple(bytes32 sessionId,${PAYMENT_INTENT_ABI} seckillPayment,${PAYMENT_INTENT_ABI} fallbackPayment)`;

export const paymentAuthorizationTypes = {
  PaymentAuthorization: [
    { name: 'paymentHash', type: 'bytes32' },
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'skuId', type: 'bytes32' },
    { name: 'quantity', type: 'uint32' },
    { name: 'fulfillmentMode', type: 'uint8' },
    { name: 'listPriceUsdt', type: 'uint256' },
    { name: 'usdtPaymentAmount', type: 'uint256' },
    { name: 'nplPaymentAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};
export const seckillAuthorizationTypes = {
  SeckillAuthorization: [
    { name: 'seckillHash', type: 'bytes32' },
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'skuId', type: 'bytes32' },
    { name: 'quantity', type: 'uint32' },
    { name: 'fulfillmentMode', type: 'uint8' },
    { name: 'seckillListPriceUsdt', type: 'uint256' },
    { name: 'seckillUsdtPaymentAmount', type: 'uint256' },
    { name: 'seckillNplPaymentAmount', type: 'uint256' },
    { name: 'fallbackListPriceUsdt', type: 'uint256' },
    { name: 'fallbackUsdtPaymentAmount', type: 'uint256' },
    { name: 'fallbackNplPaymentAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

export interface CanonicalSeckillIntent {
  sessionId: string;
  seckill: CanonicalPaymentIntent;
  fallback: CanonicalPaymentIntent;
}

export function paymentIntentHash(intent: CanonicalPaymentIntent) {
  try {
    return keccak256(AbiCoder.defaultAbiCoder().encode([PAYMENT_INTENT_ABI], [toRouterPaymentIntent(intent)]));
  } catch {
    throw new CoreError('InvalidRequest', 'Payment intent cannot be encoded for the Router');
  }
}

export function paymentAuthorizationDigest(
  intent: CanonicalPaymentIntent,
  paymentRouterAddress: string,
) {
  return paymentWalletAuthorization(intent, paymentRouterAddress).digest;
}

export function seckillIntentHash(intent: CanonicalSeckillIntent) {
  try {
    return keccak256(AbiCoder.defaultAbiCoder().encode([SECKILL_INTENT_ABI], [{
      sessionId: intent.sessionId,
      seckillPayment: toRouterPaymentIntent(intent.seckill),
      fallbackPayment: toRouterPaymentIntent(intent.fallback),
    }]));
  } catch {
    throw new CoreError('InvalidRequest', 'Seckill intent cannot be encoded for the Router');
  }
}

export function seckillAuthorizationDigest(
  intent: CanonicalSeckillIntent,
  paymentRouterAddress: string,
) {
  return seckillWalletAuthorization(intent, paymentRouterAddress).digest;
}

export function paymentWalletAuthorization(intent: CanonicalPaymentIntent, paymentRouterAddress: string) {
  const domain = paymentRouterDomain(paymentRouterAddress);
  const message = {
    paymentHash: paymentIntentHash(intent),
    orderId: intent.orderId,
    buyer: intent.buyer,
    merchant: intent.merchant,
    productId: intent.productId,
    skuId: intent.skuId,
    quantity: intent.quantity,
    fulfillmentMode: intent.fulfillmentMode === 'DELIVERY' ? 0 : 1,
    listPriceUsdt: intent.listPriceUsdt,
    usdtPaymentAmount: intent.usdtPaymentAmount,
    nplPaymentAmount: intent.nplPaymentAmount,
    deadline: intent.deadline,
  };
  return Object.freeze({
    domain: Object.freeze(domain),
    types: Object.freeze(paymentAuthorizationTypes),
    primaryType: 'PaymentAuthorization' as const,
    message: Object.freeze(message),
    digest: TypedDataEncoder.hash(domain, paymentAuthorizationTypes, message),
  });
}

export function seckillWalletAuthorization(intent: CanonicalSeckillIntent, paymentRouterAddress: string) {
  const domain = paymentRouterDomain(paymentRouterAddress);
  const seckill = intent.seckill;
  const fallback = intent.fallback;
  const message = {
    seckillHash: seckillIntentHash(intent),
    orderId: seckill.orderId,
    buyer: seckill.buyer,
    merchant: seckill.merchant,
    productId: seckill.productId,
    skuId: seckill.skuId,
    quantity: seckill.quantity,
    fulfillmentMode: seckill.fulfillmentMode === 'DELIVERY' ? 0 : 1,
    seckillListPriceUsdt: seckill.listPriceUsdt,
    seckillUsdtPaymentAmount: seckill.usdtPaymentAmount,
    seckillNplPaymentAmount: seckill.nplPaymentAmount,
    fallbackListPriceUsdt: fallback.listPriceUsdt,
    fallbackUsdtPaymentAmount: fallback.usdtPaymentAmount,
    fallbackNplPaymentAmount: fallback.nplPaymentAmount,
    deadline: seckill.deadline,
  };
  return Object.freeze({
    domain: Object.freeze(domain),
    types: Object.freeze(seckillAuthorizationTypes),
    primaryType: 'SeckillAuthorization' as const,
    message: Object.freeze(message),
    digest: TypedDataEncoder.hash(domain, seckillAuthorizationTypes, message),
  });
}

export function paymentRouterDomain(paymentRouterAddress: string): TypedDataDomain {
  let verifyingContract: string;
  try {
    verifyingContract = getAddress(paymentRouterAddress);
  } catch {
    throw new CoreError('ExternalBlocked', 'PaymentRouter address is unavailable', 503);
  }
  return {
    name: 'Abu24KPaymentRouter',
    version: '2',
    chainId: BSC_CHAIN_ID,
    verifyingContract,
  };
}

export function toRouterPaymentIntent(intent: CanonicalPaymentIntent) {
  const fulfillmentMode = intent.fulfillmentMode === 'DELIVERY' ? 0 : 1;
  return {
    orderId: intent.orderId,
    policyVersion: intent.policyVersion,
    buyer: intent.buyer,
    merchant: intent.merchant,
    productId: intent.productId,
    skuId: intent.skuId,
    quantity: intent.quantity,
    fulfillmentMode,
    fulfillmentTargetHash: intent.fulfillmentTargetHash,
    regionCodeHash: intent.regionCodeHash,
    productPolicyHash: intent.productPolicyHash,
    reservationId: intent.reservationId,
    reservationHash: intent.reservationHash,
    reservationDeadline: intent.reservationDeadline,
    issuedAt: intent.issuedAt,
    deadline: intent.deadline,
    nonce: intent.nonce,
    listPriceUsdt: intent.listPriceUsdt,
    productUsdtPaymentAmount: intent.productUsdtPaymentAmount,
    platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
    custodyProductUsdt: intent.custodyProductUsdt,
    freightUsdt: intent.freightUsdt,
    usdtPaymentAmount: intent.usdtPaymentAmount,
    nplQuoteAmount: intent.nplQuoteAmount,
    nplPaymentAmount: intent.nplPaymentAmount,
    nplBurnAmount: intent.nplBurnAmount,
    nplRewardAmount: intent.nplRewardAmount,
    merchantBaseReceivableUsdt: intent.merchantBaseReceivableUsdt,
    merchantConcessionBps: intent.merchantConcessionBps,
    merchantConcessionAmount: intent.merchantConcessionAmount,
    merchantNetReceivableUsdt: intent.merchantNetReceivableUsdt,
    concessionAllocationHash: intent.concessionAllocationHash,
    bnmAmount: intent.bnmAmount,
    seckill: intent.seckill,
    sessionId: intent.sessionId,
    beneficiaries: {
      genesis: intent.beneficiaries.genesis,
      directReferral: intent.beneficiaries.directReferral,
      district: intent.beneficiaries.district,
      city: intent.beneficiaries.city,
      province: intent.beneficiaries.province,
      region: intent.beneficiaries.region,
    },
  };
}

export function toRouterSeckillIntent(intent: CanonicalSeckillIntent) {
  return {
    sessionId: intent.sessionId,
    seckillPayment: toRouterPaymentIntent(intent.seckill),
    fallbackPayment: toRouterPaymentIntent(intent.fallback),
  };
}

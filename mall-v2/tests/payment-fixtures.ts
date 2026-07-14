import {
  artifactVersion,
  chainIdentity,
  type CatalogProduct,
  type PaymentQuoteResponse,
  type SeckillQuoteResponse,
} from '@abu24k/core-artifacts';
import { TypedDataEncoder } from 'ethers';

import { paymentAuthorizationTypes, seckillAuthorizationTypes } from '../src/payment-integrity';

const hash = (value: string) => `0x${value.repeat(64)}`;
const address = (value: string) => `0x${value.repeat(40)}`;

export const product: CatalogProduct = {
  productId: 'product-24k-shoe',
  chainProductId: hash('a'),
  title: '阿步 24K 黑金运动鞋',
  metadata: {},
  skus: [{
    skuId: 'sku-42-black-gold',
    chainSkuId: hash('b'),
    attributes: { size: '42码', color: '黑金' },
    listPriceUsdt: '120000000000000000000',
    stockAvailable: '8',
  }],
};

export function paymentQuote(): PaymentQuoteResponse {
  const buyer = address('1');
  const router = address('9');
  const intent = {
    orderId: hash('c'),
    policyVersion: 1,
    oracleVersion: hash('d'),
    buyer,
    merchant: address('2'),
    productId: product.chainProductId,
    skuId: product.skus[0]!.chainSkuId,
    quantity: 1,
    fulfillmentMode: 'DELIVERY' as const,
    fulfillmentTargetHash: hash('1'),
    regionCodeHash: hash('2'),
    productPolicyHash: hash('3'),
    reservationId: hash('4'),
    reservationHash: hash('5'),
    reservationDeadline: 2_000_000_600,
    issuedAt: 2_000_000_000,
    deadline: 2_000_000_300,
    nonce: '1',
    listPriceUsdt: '120000000000000000000',
    usdtPaymentAmount: '84000000000000000000',
    nplQuoteAmount: '240000000000000000000',
    nplPaymentAmount: '72000000000000000000',
    nplBurnAmount: '48000000000000000000',
    nplRewardAmount: '24000000000000000000',
    merchantBaseReceivableUsdt: '70000000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '17500000000000000000',
    merchantNetReceivableUsdt: '52500000000000000000',
    concessionAllocationHash: hash('6'),
    bnmAmount: '120000000000000000000',
    seckill: false,
    sessionId: hash('0'),
    beneficiaries: {
      genesis: address('3'),
      directReferral: address('4'),
      district: address('5'),
      city: address('6'),
      province: address('7'),
      region: address('8'),
    },
    merchantConcessionAllocations: [],
    otherUsdtAllocations: [],
    nplRewardAllocations: [],
    requiredConfirmations: 15 as const,
  };
  const routerIntent = { ...intent, fulfillmentMode: 0 as const };
  const approvalRequirements = [
    approval(chainIdentity.usdtAddress, router, intent.usdtPaymentAmount),
    approval(chainIdentity.nplAddress, router, intent.nplPaymentAmount),
  ] as const;
  const domain = { name: 'Abu24KPaymentRouter' as const, version: '2' as const, chainId: 56 as const, verifyingContract: router };
  const authorizationMessage = {
    paymentHash: hash('8'),
    orderId: intent.orderId,
    buyer,
    merchant: intent.merchant,
    productId: intent.productId,
    skuId: intent.skuId,
    quantity: 1,
    fulfillmentMode: 0 as const,
    listPriceUsdt: intent.listPriceUsdt,
    usdtPaymentAmount: intent.usdtPaymentAmount,
    nplPaymentAmount: intent.nplPaymentAmount,
    deadline: intent.deadline,
  };
  const authorizationDigest = TypedDataEncoder.hash(domain, {
    PaymentAuthorization: paymentAuthorizationTypes.PaymentAuthorization.map((field) => ({ ...field })),
  }, authorizationMessage);
  return {
    artifactVersion,
    orderId: intent.orderId,
    state: 'QUOTED',
    paymentRouterAddress: router,
    intent,
    snapshotHash: hash('8'),
    authorizationDigest,
    buyerAuthorization: {
      domain,
      types: paymentAuthorizationTypes,
      primaryType: 'PaymentAuthorization',
      message: authorizationMessage,
      digest: authorizationDigest,
    },
    quoteSignature: `0x${'11'.repeat(65)}`,
    submittedTxHash: null,
    approvalRequirements,
    routerCall: { functionName: 'pay', intent: routerIntent, quoteSignature: `0x${'11'.repeat(65)}` },
  };
}

export function seckillQuote(): SeckillQuoteResponse {
  const ordinary = paymentQuote();
  const sessionId = hash('9');
  const seckill = {
    ...ordinary.intent,
    seckill: true,
    sessionId,
  };
  const fallback = {
    ...ordinary.intent,
    reservationId: hash('a'),
    reservationHash: hash('b'),
  };
  const seckillPayment = { ...seckill, fulfillmentMode: 0 as const };
  const fallbackPayment = { ...fallback, fulfillmentMode: 0 as const };
  const seckillHash = hash('c');
  const authorizationMessage = {
    seckillHash,
    orderId: ordinary.orderId,
    buyer: seckill.buyer,
    merchant: seckill.merchant,
    productId: seckill.productId,
    skuId: seckill.skuId,
    quantity: seckill.quantity,
    fulfillmentMode: 0 as const,
    seckillListPriceUsdt: seckill.listPriceUsdt,
    seckillUsdtPaymentAmount: seckill.usdtPaymentAmount,
    seckillNplPaymentAmount: seckill.nplPaymentAmount,
    fallbackListPriceUsdt: fallback.listPriceUsdt,
    fallbackUsdtPaymentAmount: fallback.usdtPaymentAmount,
    fallbackNplPaymentAmount: fallback.nplPaymentAmount,
    deadline: seckill.deadline,
  };
  const authorizationDigest = TypedDataEncoder.hash(
    ordinary.buyerAuthorization.domain,
    { SeckillAuthorization: seckillAuthorizationTypes.SeckillAuthorization.map((field) => ({ ...field })) },
    authorizationMessage,
  );
  return {
    artifactVersion,
    orderId: ordinary.orderId,
    state: 'QUOTED',
    paymentRouterAddress: ordinary.paymentRouterAddress,
    dual: {
      sessionId,
      seckill,
      fallback,
      classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP',
    },
    seckillHash,
    snapshotHashes: { seckill: hash('e'), fallback: hash('f') },
    authorizationDigest,
    buyerAuthorization: {
      domain: ordinary.buyerAuthorization.domain,
      types: seckillAuthorizationTypes,
      primaryType: 'SeckillAuthorization',
      message: authorizationMessage,
      digest: authorizationDigest,
    },
    quoteSignature: ordinary.quoteSignature,
    submittedTxHash: null,
    approvalRequirements: ordinary.approvalRequirements,
    routerCall: {
      functionName: 'paySeckill',
      intent: { sessionId, seckillPayment, fallbackPayment },
      quoteSignature: ordinary.quoteSignature,
    },
  };
}

function approval(token: string, spender: string, requiredAmount: string) {
  return {
    token,
    spender,
    requiredAmount,
    requestedAllowance: (2n ** 256n - 1n).toString(),
    approvalMode: 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED' as const,
    risk: 'UNLIMITED_TOKEN_ALLOWANCE' as const,
    revocation: { method: 'ERC20_APPROVE_ZERO' as const, token, spender },
  };
}

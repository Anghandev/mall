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

export const productImageAssetId = hash('e');
export const productVideoAssetId = hash('f');

export const product: CatalogProduct = {
  productId: 'product-24k-shoe',
  chainProductId: hash('a'),
  title: '阿步 24K 黑金运动鞋',
  subtitle: '城市通勤与门店自提可选',
  metadata: { merchantId: 'merchant:685108d6-c0dc-457b-8272-ae8bf9886501' },
  mainImageAssetIds: [productImageAssetId],
  videoAssetId: productVideoAssetId,
  richDetail: { summary: '黑金鞋面，轻量缓震结构。' },
  defaultFreightUsdt: '10000000000000000000',
  fulfillmentModes: ['DELIVERY', 'PICKUP'],
  categoryId: 'sports-shoes',
  tagIds: ['black-gold'],
  skus: [{
    skuId: 'sku-42-black-gold',
    chainSkuId: hash('b'),
    attributes: { size: '42码', color: '黑金' },
    listPriceUsdt: '120000000000000000000',
    stockAvailable: '8',
    seckill: null,
  }, {
    skuId: 'sku-41-seckill',
    chainSkuId: hash('c'),
    attributes: { size: '41码', color: '秒杀黑金' },
    listPriceUsdt: '120000000000000000000',
    stockAvailable: '67',
    seckill: {
      sessionId: hash('9'),
      policyVersion: '12',
      phase: 'LIVE',
      startsAt: '2033-05-18T04:59:00.000Z',
      mainDeadline: '2033-05-18T05:59:00.000Z',
      relayDeadline: '2033-05-18T05:01:00.000Z',
      seckillListPriceUsdt: '80000000000000000000',
      inventory: { total: '100', sold: '31', reserved: '2', available: '67' },
      ordinaryCheckoutAllowed: false,
    },
  }],
};

export function paymentQuote(fulfillmentMode: 'DELIVERY' | 'PICKUP' = 'DELIVERY'): PaymentQuoteResponse {
  const buyer = address('1');
  const router = address('9');
  const freightUsdt = fulfillmentMode === 'DELIVERY' ? product.defaultFreightUsdt : '0';
  const fulfillmentTargetHash = fulfillmentMode === 'DELIVERY' ? hash('4') : hash('6');
  const regionCodeHash = fulfillmentMode === 'DELIVERY' ? hash('5') : hash('7');
  const intent = {
    orderId: hash('c'),
    policyVersion: 1,
    buyer,
    merchant: address('2'),
    productId: product.chainProductId,
    skuId: product.skus[0]!.chainSkuId,
    quantity: 1,
    fulfillmentMode,
    fulfillmentTargetHash,
    regionCodeHash,
    productPolicyHash: hash('3'),
    reservationId: hash('4'),
    reservationHash: hash('5'),
    reservationDeadline: 2_000_000_600,
    issuedAt: 2_000_000_000,
    deadline: 2_000_000_300,
    nonce: '1',
    listPriceUsdt: '120000000000000000000',
    productUsdtPaymentAmount: '84000000000000000000',
    platformServiceFeeUsdt: '1200000000000000000',
    custodyProductUsdt: '82800000000000000000',
    freightUsdt,
    usdtPaymentAmount: (84_000_000_000_000_000_000n + BigInt(freightUsdt)).toString(),
    nplQuoteAmount: '240000000000000000000',
    nplPaymentAmount: '72000000000000000000',
    nplBurnAmount: '48000000000000000000',
    nplRewardAmount: '24000000000000000000',
    merchantBaseReceivableUsdt: '82800000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '20700000000000000000',
    merchantNetReceivableUsdt: '62100000000000000000',
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
  const fulfillmentModeCode = fulfillmentMode === 'DELIVERY' ? 0 as const : 1 as const;
  const routerIntent = { ...intent, fulfillmentMode: fulfillmentModeCode };
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
    fulfillmentMode: fulfillmentModeCode,
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
  const seckillSku = product.skus[1]!;
  const seckill = {
    ...ordinary.intent,
    skuId: seckillSku.chainSkuId,
    seckill: true,
    sessionId,
  };
  const fallback = {
    ...ordinary.intent,
    skuId: seckillSku.chainSkuId,
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

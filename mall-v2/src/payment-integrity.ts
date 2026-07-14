import type {
  CanonicalPaymentIntent,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentRouterIntent,
  SeckillQuoteResponse,
} from '@abu24k/core-artifacts';
import type { TypedDataField } from 'ethers';

export type SignedPaymentQuote = PaymentQuoteResponse | SeckillQuoteResponse;

export const paymentAuthorizationTypes = Object.freeze({
  PaymentAuthorization: Object.freeze([
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
  ]),
});

export const seckillAuthorizationTypes = Object.freeze({
  SeckillAuthorization: Object.freeze([
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
  ]),
});

export async function assertPaymentQuoteIntegrity(quote: SignedPaymentQuote | PaymentProjection) {
  if (quote.quoteSignature.toLowerCase() !== quote.routerCall.quoteSignature.toLowerCase()) {
    throw new PaymentIntegrityError('Router 调用签名与签名报价不一致');
  }

  if ('intent' in quote) {
    await assertAuthorizationIntegrity(
      quote.buyerAuthorization,
      'PaymentAuthorization',
      paymentAuthorizationTypes.PaymentAuthorization,
      quote.authorizationDigest,
    );
    assertCanonicalMatchesRouter(quote.intent, quote.routerCall.intent);
    if (
      quote.orderId.toLowerCase() !== quote.routerCall.intent.orderId.toLowerCase()
        || quote.snapshotHash.toLowerCase() !== quote.buyerAuthorization.message.paymentHash.toLowerCase()
    ) throw new PaymentIntegrityError('订单或支付快照与 Router 调用不一致');
    assertFiveMinuteQuote(quote.intent);
    return;
  }

  await assertAuthorizationIntegrity(
    quote.buyerAuthorization,
    'SeckillAuthorization',
    seckillAuthorizationTypes.SeckillAuthorization,
    quote.authorizationDigest,
  );
  const routerCall = quote.routerCall.intent;
  assertCanonicalMatchesRouter(quote.dual.seckill, routerCall.seckillPayment);
  assertCanonicalMatchesRouter(quote.dual.fallback, routerCall.fallbackPayment);
  if (
    quote.orderId.toLowerCase() !== routerCall.seckillPayment.orderId.toLowerCase()
      || quote.orderId.toLowerCase() !== routerCall.fallbackPayment.orderId.toLowerCase()
      || quote.dual.sessionId.toLowerCase() !== routerCall.sessionId.toLowerCase()
      || quote.dual.sessionId.toLowerCase() !== routerCall.seckillPayment.sessionId.toLowerCase()
      || quote.seckillHash.toLowerCase() !== quote.buyerAuthorization.message.seckillHash.toLowerCase()
  ) throw new PaymentIntegrityError('秒杀订单、场次或快照与 Router 调用不一致');
  assertFiveMinuteQuote(quote.dual.seckill);
  assertFiveMinuteQuote(quote.dual.fallback);
}

export function authorizationTypesForQuote(quote: SignedPaymentQuote) {
  return 'intent' in quote ? paymentAuthorizationTypes : seckillAuthorizationTypes;
}

export class PaymentIntegrityError extends Error {
  readonly code = 'InvalidQuote';

  constructor(message: string) {
    super(message);
    this.name = 'PaymentIntegrityError';
  }
}

function assertCanonicalMatchesRouter(canonical: CanonicalPaymentIntent, router: PaymentRouterIntent) {
  const comparable = {
    ...canonical,
    fulfillmentMode: canonical.fulfillmentMode === 'DELIVERY' ? 0 : 1,
  } as Record<string, unknown>;
  for (const [field, value] of Object.entries(router)) {
    if (!sameValue(comparable[field], value)) {
      throw new PaymentIntegrityError(`Core 报价字段 ${field} 与 Router 调用不一致`);
    }
  }
}

function assertFiveMinuteQuote(intent: CanonicalPaymentIntent) {
  if (intent.deadline - intent.issuedAt !== 5 * 60) {
    throw new PaymentIntegrityError('Core 签名报价不是固定五分钟有效期');
  }
}

async function assertAuthorizationIntegrity(
  authorization: Readonly<{
    domain: Readonly<{ name: string; version: string; chainId: number; verifyingContract: string }>;
    types: Readonly<Record<string, readonly Readonly<TypedDataField>[]>>;
    primaryType: string;
    message: Readonly<Record<string, unknown>>;
    digest: string;
  }>,
  primaryType: 'PaymentAuthorization' | 'SeckillAuthorization',
  expectedFields: readonly Readonly<TypedDataField>[],
  publishedDigest: string,
) {
  if (
    authorization.domain.name !== 'Abu24KPaymentRouter'
      || authorization.domain.version !== '2'
      || authorization.primaryType !== primaryType
      || Object.keys(authorization.types).length !== 1
      || !sameValue(authorization.types[primaryType], expectedFields)
  ) throw new PaymentIntegrityError('钱包授权的 EIP-712 domain 或字段结构无效');

  let digest: string;
  try {
    const { TypedDataEncoder } = await import('ethers');
    digest = TypedDataEncoder.hash(
      authorization.domain,
      { [primaryType]: expectedFields.map((field) => ({ ...field })) },
      authorization.message,
    );
  } catch {
    throw new PaymentIntegrityError('钱包授权消息无法按已发布 EIP-712 结构编码');
  }
  if (
    digest.toLowerCase() !== authorization.digest.toLowerCase()
      || digest.toLowerCase() !== publishedDigest.toLowerCase()
  ) throw new PaymentIntegrityError('钱包授权摘要与已发布 EIP-712 消息不一致');
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.startsWith('0x') && right.startsWith('0x')
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(rightRecord);
    return keys.every((key) => sameValue(leftRecord[key], rightRecord[key]));
  }
  return left === right;
}

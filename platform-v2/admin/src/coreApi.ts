import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  balanceStates,
  chainIdentity,
  coreErrorCodes,
  fulfillmentAssets,
  fulfillmentModes,
  fulfillmentRequestStates,
  fulfillmentRequestTypes,
  logisticsProviders,
  logisticsStatuses,
  orderFinalityStatuses,
  orderProjectionStates,
  userRoles,
  type AllowedAction,
  type CatalogProduct,
  type CoreErrorCode,
  type FulfillmentOrder,
  type FulfillmentReasonRequest,
  type PaymentProjection,
  type TakeoverOpenedResult,
  type UserRole,
} from '@abu24k/core-artifacts';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const atomicAmountPattern = /^(0|[1-9][0-9]*)$/;
const coreOrigin = (import.meta.env.VITE_CORE_API_ORIGIN ?? '').trim().replace(/\/$/, '');

export type CoreBootstrap = ReturnType<typeof parseBootstrap>;
export type CoreSession = ReturnType<typeof parseSession>;

export type WalletProvider = {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
  removeListener?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
};

export class CoreApiError extends Error {
  readonly code: CoreErrorCode | 'InvalidResponse';
  readonly correlationId?: string;
  readonly status: number;

  constructor(input: {
    code: CoreErrorCode | 'InvalidResponse';
    message: string;
    status: number;
    correlationId?: string;
  }) {
    super(input.message);
    this.name = 'CoreApiError';
    this.code = input.code;
    this.status = input.status;
    if (input.correlationId) this.correlationId = input.correlationId;
  }
}

export async function fetchCoreBootstrap(signal?: AbortSignal) {
  const body = await requestJson('/v2/bootstrap', signal ? { signal } : {});
  return parseBootstrap(body);
}

export async function fetchCatalogProducts(signal?: AbortSignal): Promise<readonly CatalogProduct[]> {
  const body = record(await requestJson('/v2/catalog/products', signal ? { signal } : {}));
  if (!Array.isArray(body.products) || !body.products.every(isCatalogProduct)) {
    throw invalidResponse('Catalog response does not match the coordinated generated type');
  }
  return body.products;
}

export async function fetchPaymentProjection(
  orderId: string,
  token: string,
  signal?: AbortSignal,
): Promise<PaymentProjection> {
  if (!bytes32Pattern.test(orderId)) throw invalidResponse('Order ID must be a bytes32 value');
  const body = await requestJson(`/v2/payments/${encodeURIComponent(orderId)}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!isPaymentProjection(body)) {
    throw invalidResponse('Payment projection does not match the coordinated generated type');
  }
  return body;
}

export async function fetchFulfillmentOrders(
  token: string,
  signal?: AbortSignal,
): Promise<readonly FulfillmentOrder[]> {
  const body = record(await requestJson('/v2/orders', {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  }));
  if (!Array.isArray(body.orders) || !body.orders.every(isFulfillmentOrder)) {
    throw invalidResponse('Fulfillment order list does not match the coordinated generated type');
  }
  return Object.freeze([...body.orders]);
}

export async function fetchOrderAllowedActions(
  orderId: string,
  token: string,
  signal?: AbortSignal,
): Promise<readonly AllowedAction[]> {
  if (!bytes32Pattern.test(orderId)) throw invalidResponse('Order ID must be a bytes32 value');
  const body = record(await requestJson('/v2/actions/order', {
    body: JSON.stringify({ orderId }),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    ...(signal ? { signal } : {}),
  }));
  if (!Array.isArray(body.allowedActions) || !body.allowedActions.every(isAllowedAction)) {
    throw invalidResponse('Order allowedActions do not match the coordinated generated type');
  }
  return Object.freeze([...body.allowedActions]);
}

export async function openTakeover(
  orderId: string,
  input: FulfillmentReasonRequest,
  token: string,
): Promise<TakeoverOpenedResult> {
  if (!bytes32Pattern.test(orderId)) throw invalidResponse('Order ID must be a bytes32 value');
  if (
    input.idempotencyKey.length < 8
      || input.idempotencyKey.length > 128
      || !bytes32Pattern.test(input.evidenceHash)
      || !/^[A-Z0-9_:-]{2,64}$/.test(input.reasonCode)
  ) throw invalidResponse('Takeover command input does not match the coordinated generated type');
  const body = await requestJson(`/v2/orders/${encodeURIComponent(orderId)}/takeover`, {
    body: JSON.stringify(input),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  if (!isTakeoverOpenedResult(body) || body.orderId.toLowerCase() !== orderId.toLowerCase()) {
    throw invalidResponse('Takeover result does not match the coordinated generated type');
  }
  return body;
}

export async function createWalletSession(provider: WalletProvider): Promise<CoreSession> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const walletAddress = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
  if (!addressPattern.test(walletAddress)) throw invalidResponse('Wallet did not return a valid BSC address');

  const challengeBody = await requestJson('/v2/auth/nonce', {
    body: JSON.stringify({ walletAddress }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const challenge = parseChallenge(challengeBody);
  const signature = await provider.request({
    method: 'personal_sign',
    params: [challenge.message, walletAddress],
  });
  if (typeof signature !== 'string' || signature.length === 0) {
    throw invalidResponse('Wallet did not return a signature');
  }

  return parseSession(await requestJson('/v2/auth/verify', {
    body: JSON.stringify({ message: challenge.message, signature }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }));
}

async function requestJson(path: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${coreOrigin}${path}`, init);
  } catch {
    throw new CoreApiError({
      code: 'ExternalBlocked',
      message: 'Core API is unreachable',
      status: 503,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok && response.status >= 500) {
      throw new CoreApiError({
        code: 'ExternalBlocked',
        message: `Core API gateway is unavailable (${response.status})`,
        status: response.status,
      });
    }
    throw invalidResponse(`Core returned a non-JSON response (${response.status})`, response.status);
  }
  if (response.ok) return body;

  const error = readCoreError(body);
  throw new CoreApiError({
    code: error?.code ?? 'InvalidResponse',
    message: error?.message ?? `Core request failed (${response.status})`,
    status: response.status,
    ...(error?.correlationId ? { correlationId: error.correlationId } : {}),
  });
}

function parseBootstrap(value: unknown) {
  const body = record(value);
  const readiness = record(body.readiness);
  const assets = record(readiness.assets);
  const providers = record(readiness.providers);
  if (
    body.artifactVersion !== artifactVersion
      || body.status !== 'CORE_API_READY'
      || readiness.chainId !== 56
      || assets.usdt !== chainIdentity.usdtAddress
      || assets.npl !== chainIdentity.nplAddress
      || typeof readiness.writesEnabled !== 'boolean'
  ) throw invalidResponse('Core bootstrap is incompatible with this fulfillment checkpoint');

  return Object.freeze({
    artifactVersion,
    status: 'CORE_API_READY' as const,
    readiness: Object.freeze({
      chainId: 56 as const,
      assets: Object.freeze({
        usdt: assets.usdt,
        npl: assets.npl,
        nplUsdtPair: typeof assets.nplUsdtPair === 'string' ? assets.nplUsdtPair : undefined,
      }),
      decisionBlocked: stringArray(readiness.decisionBlocked, 'decisionBlocked'),
      externalBlocked: stringArray(readiness.externalBlocked, 'externalBlocked'),
      paymentDecisionBlocked: stringArray(readiness.paymentDecisionBlocked, 'paymentDecisionBlocked'),
      paymentExternalBlocked: stringArray(readiness.paymentExternalBlocked, 'paymentExternalBlocked'),
      providers: Object.freeze(Object.fromEntries(Object.entries(providers).map(([name, state]) => {
        if (state !== 'READY' && state !== 'CONFIGURATION_REQUIRED') {
          throw invalidResponse(`Unknown provider readiness for ${name}`);
        }
        return [name, state];
      }))),
      writesEnabled: readiness.writesEnabled,
    }),
  });
}

function parseChallenge(value: unknown) {
  const body = record(value);
  if (
    typeof body.message !== 'string'
      || typeof body.nonce !== 'string'
      || typeof body.issuedAt !== 'string'
      || typeof body.expiresAt !== 'string'
  ) throw invalidResponse('SIWE challenge is invalid');
  return body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
}

function parseSession(value: unknown) {
  const body = record(value);
  if (
    typeof body.token !== 'string'
      || !addressPattern.test(String(body.walletAddress))
      || !Array.isArray(body.roles)
      || !body.roles.every((role) => userRoles.includes(role as UserRole))
  ) throw invalidResponse('Core session response is invalid');
  return Object.freeze({
    token: body.token,
    walletAddress: String(body.walletAddress),
    roles: Object.freeze(body.roles as UserRole[]),
  });
}

function isCatalogProduct(value: unknown): value is CatalogProduct {
  if (!isRecord(value) || typeof value.productId !== 'string' || !bytes32Pattern.test(String(value.chainProductId))) {
    return false;
  }
  return typeof value.title === 'string'
    && isRecord(value.metadata)
    && Array.isArray(value.skus)
    && value.skus.every((sku) => isRecord(sku)
      && typeof sku.skuId === 'string'
      && bytes32Pattern.test(String(sku.chainSkuId))
      && isRecord(sku.attributes)
      && atomicAmountPattern.test(String(sku.listPriceUsdt))
      && atomicAmountPattern.test(String(sku.stockAvailable)));
}

function isPaymentProjection(value: unknown): value is PaymentProjection {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !bytes32Pattern.test(String(value.orderId))) {
    return false;
  }
  if (!['QUOTED', 'SUBMITTED', 'PAID', 'REORGED', 'EXPIRED'].includes(String(value.state))) return false;
  if (!addressPattern.test(String(value.paymentRouterAddress))) return false;
  if (value.submittedTxHash !== null && !bytes32Pattern.test(String(value.submittedTxHash))) return false;
  if (!isRecord(value.routerCall) || !['pay', 'paySeckill'].includes(String(value.routerCall.functionName))) return false;
  if (value.finality !== null) {
    if (!isRecord(value.finality) || !bytes32Pattern.test(String(value.finality.transactionHash))) return false;
    if (!['MINED', 'REORGED', 'FINAL'].includes(String(value.finality.state))) return false;
    if (
      !Number.isSafeInteger(value.finality.blockNumber)
        || !Number.isSafeInteger(value.finality.confirmations)
        || value.finality.requiredConfirmations !== 15
        || typeof value.finality.canonicalBlock !== 'boolean'
        || !bytes32Pattern.test(String(value.finality.blockHash))
        || !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(String(value.finality.classification))
    ) return false;
  }
  return ('intent' in value && isCanonicalIntent(value.intent))
    || ('dual' in value && isRecord(value.dual)
      && isCanonicalIntent(value.dual.seckill)
      && isCanonicalIntent(value.dual.fallback));
}

function isCanonicalIntent(value: unknown) {
  return isRecord(value)
    && bytes32Pattern.test(String(value.reservationId))
    && Number.isSafeInteger(value.policyVersion)
    && Number.isSafeInteger(value.reservationDeadline)
    && Number.isSafeInteger(value.quantity)
    && atomicAmountPattern.test(String(value.listPriceUsdt))
    && atomicAmountPattern.test(String(value.usdtPaymentAmount))
    && atomicAmountPattern.test(String(value.nplPaymentAmount))
    && atomicAmountPattern.test(String(value.nplBurnAmount))
    && atomicAmountPattern.test(String(value.nplRewardAmount))
    && atomicAmountPattern.test(String(value.merchantNetReceivableUsdt));
}

function isFulfillmentOrder(value: unknown): value is FulfillmentOrder {
  if (
    !isRecord(value)
      || value.artifactVersion !== artifactVersion
      || !bytes32Pattern.test(String(value.orderId))
      || !addressPattern.test(String(value.buyerWallet))
      || !addressPattern.test(String(value.merchantWallet))
      || !nonEmptyStrings(value, ['merchantId', 'productId', 'skuId'])
      || !fulfillmentModes.includes(value.fulfillmentMode as never)
      || !orderProjectionStates.includes(value.state as never)
      || !orderFinalityStatuses.includes(value.finalityStatus as never)
      || !nullableDates(value, [
        'paidAt',
        'paymentFinalizedAt',
        'shippedAt',
        'deliveredAt',
        'fulfilledAt',
        'takeoverOpenedAt',
        'arbitrationOpenedAt',
      ])
      || !isFulfillmentExactAmounts(value.exactAmounts)
  ) return false;
  return Array.isArray(value.requests)
    && value.requests.every((item) => isRecord(item)
      && nonEmptyStrings(item, ['requestId'])
      && fulfillmentRequestTypes.includes(item.requestType as never)
      && fulfillmentRequestStates.includes(item.state as never)
      && isDateTime(item.requestedAt)
      && isNullableDateTime(item.resolvedAt))
    && Array.isArray(value.shipments)
    && value.shipments.every((item) => isRecord(item)
      && nonEmptyStrings(item, ['shipmentId', 'carrierCode'])
      && bytes32Pattern.test(String(item.trackingNumberHash))
      && (item.providerReferenceHash === null || bytes32Pattern.test(String(item.providerReferenceHash)))
      && isDateTime(item.createdAt))
    && Array.isArray(value.logistics)
    && value.logistics.every((item) => isRecord(item)
      && nonEmptyStrings(item, ['logisticsEventId'])
      && logisticsProviders.includes(item.provider as never)
      && logisticsStatuses.includes(item.status as never)
      && (item.locationHash === null || bytes32Pattern.test(String(item.locationHash)))
      && isDateTime(item.occurredAt))
    && Array.isArray(value.balances)
    && value.balances.every((item) => isRecord(item)
      && fulfillmentAssets.includes(item.asset as never)
      && balanceStates.includes(item.state as never)
      && atomicAmountPattern.test(String(item.amount)));
}

function isFulfillmentExactAmounts(value: unknown) {
  if (!isRecord(value)) return false;
  return [
    'listPriceUsdt',
    'usdtPaymentAmount',
    'nplQuoteAmount',
    'nplPaymentAmount',
    'nplBurnAmount',
    'nplRewardAmount',
    'merchantBaseReceivableUsdt',
    'merchantConcessionAmount',
    'merchantNetReceivableUsdt',
    'bnmAmount',
  ].every((field) => atomicAmountPattern.test(String(value[field])));
}

function isAllowedAction(value: unknown): value is AllowedAction {
  return isRecord(value)
    && allowedActionNames.includes(value.action as never)
    && typeof value.enabled === 'boolean'
    && (value.reasonCode === undefined || allowedActionReasonCodes.includes(value.reasonCode as never))
    && (value.deadline === undefined || isDateTime(value.deadline));
}

function isTakeoverOpenedResult(value: unknown): value is TakeoverOpenedResult {
  return isRecord(value)
    && bytes32Pattern.test(String(value.orderId))
    && typeof value.caseId === 'string'
    && value.caseId.length > 0
    && value.state === 'TAKEOVER'
    && value.customerFundsRemainLocked === true;
}

function nonEmptyStrings(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => typeof value[field] === 'string' && String(value[field]).length > 0);
}

function nullableDates(value: Record<string, unknown>, fields: readonly string[]) {
  return fields.every((field) => isNullableDateTime(value[field]));
}

function isNullableDateTime(value: unknown) {
  return value === null || isDateTime(value);
}

function isDateTime(value: unknown) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function readCoreError(value: unknown) {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const { code, message, correlationId } = value.error;
  if (
    typeof code !== 'string'
      || !coreErrorCodes.includes(code as CoreErrorCode)
      || typeof message !== 'string'
  ) return undefined;
  return {
    code: code as CoreErrorCode,
    message,
    correlationId: typeof correlationId === 'string' ? correlationId : undefined,
  };
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw invalidResponse(`Core bootstrap field ${field} is invalid`);
  }
  return Object.freeze([...value]);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse('Core response must be an object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string, status = 502) {
  return new CoreApiError({ code: 'InvalidResponse', message, status });
}

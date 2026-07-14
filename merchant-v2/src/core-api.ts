import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  balanceStates,
  coreErrorCodes,
  fulfillmentAssets,
  fulfillmentMethods,
  fulfillmentModes,
  fulfillmentRequestStates,
  fulfillmentRequestTypes,
  logisticsProviders,
  logisticsStatuses,
  orderFinalityStatuses,
  orderProjectionStates,
  storeStatuses,
  userRoles,
  type AllowedAction,
  type AllowedActionName,
  type AllowedActionReasonCode,
  type CatalogProduct,
  type CatalogSku,
  type CoreErrorCode,
  type ForcedReceiptRequestResult,
  type FulfillmentBalance,
  type FulfillmentCompletedResult,
  type FulfillmentExactAmounts,
  type FulfillmentOrder,
  type FulfillmentReasonRequest,
  type FulfillmentRequestProjection,
  type FulfillmentTarget,
  type LogisticsProjection,
  type MerchantStore,
  type PickupVerificationRequest,
  type ShipmentProjection,
  type ShipmentRequest,
  type ShipmentResult,
  type UserRole,
} from '@abu24k/core-artifacts';

const allowedActionSet = new Set<string>(allowedActionNames);
const allowedActionReasonSet = new Set<string>(allowedActionReasonCodes);
const coreErrorCodeSet = new Set<string>(coreErrorCodes);
const userRoleSet = new Set<string>(userRoles);
const orderStateSet = new Set<string>(orderProjectionStates);
const finalityStatusSet = new Set<string>(orderFinalityStatuses);
const fulfillmentModeSet = new Set<string>(fulfillmentModes);
const requestTypeSet = new Set<string>(fulfillmentRequestTypes);
const requestStateSet = new Set<string>(fulfillmentRequestStates);
const logisticsProviderSet = new Set<string>(logisticsProviders);
const logisticsStatusSet = new Set<string>(logisticsStatuses);
const fulfillmentAssetSet = new Set<string>(fulfillmentAssets);
const balanceStateSet = new Set<string>(balanceStates);
const storeStatusSet = new Set<string>(storeStatuses);
const fulfillmentMethodSet = new Set<string>(fulfillmentMethods);

export interface CoreReadiness {
  chainId: 56;
  decisionBlocked: readonly string[];
  externalBlocked: readonly string[];
  paymentDecisionBlocked: readonly string[];
  paymentExternalBlocked: readonly string[];
  providers: Readonly<Record<string, 'READY' | 'CONFIGURATION_REQUIRED'>>;
  writesEnabled: boolean;
}

export interface CoreBootstrap {
  artifactVersion: typeof artifactVersion;
  status: 'CORE_API_READY';
  readiness: CoreReadiness;
}

export interface SiweChallenge {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MerchantSession {
  token: string;
  walletAddress: string;
  roles: readonly UserRole[];
}

export interface CoreApi {
  bootstrap(): Promise<CoreBootstrap>;
  createSiweChallenge(walletAddress: string): Promise<SiweChallenge>;
  verifySiwe(message: string, signature: string): Promise<MerchantSession>;
  listCatalog(): Promise<readonly CatalogProduct[]>;
  listFulfillmentOrders(token: string): Promise<readonly FulfillmentOrder[]>;
  getOrderFulfillmentTarget(orderId: string, token: string): Promise<FulfillmentTarget>;
  getOrderAllowedActions(orderId: string, token: string): Promise<readonly AllowedAction[]>;
  recordShipment(orderId: string, input: ShipmentRequest, token: string): Promise<ShipmentResult>;
  requestForcedReceipt(
    orderId: string,
    input: FulfillmentReasonRequest,
    token: string,
  ): Promise<ForcedReceiptRequestResult>;
  verifyPickup(
    orderId: string,
    input: PickupVerificationRequest,
    token: string,
  ): Promise<FulfillmentCompletedResult>;
}

export class CoreApiError extends Error {
  readonly code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable';
  readonly correlationId: string | undefined;

  constructor(
    code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable',
    message: string,
    correlationId?: string,
  ) {
    super(message);
    this.name = 'CoreApiError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

export function createCoreApi(baseUrl = import.meta.env.VITE_CORE_API_BASE_URL ?? ''): CoreApi {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');

  return {
    async bootstrap() {
      const body = await request(normalizedBaseUrl, '/v2/bootstrap');
      const value = record(body, 'bootstrap response');
      exact(value.artifactVersion, artifactVersion, 'artifactVersion');
      exact(value.status, 'CORE_API_READY', 'status');
      return {
        artifactVersion,
        status: 'CORE_API_READY',
        readiness: parseReadiness(value.readiness),
      };
    },

    async createSiweChallenge(walletAddress) {
      const body = await request(normalizedBaseUrl, '/v2/auth/nonce', {
        method: 'POST',
        body: JSON.stringify({ walletAddress }),
      });
      const value = record(body, 'SIWE challenge');
      return {
        message: string(value.message, 'message'),
        nonce: string(value.nonce, 'nonce'),
        issuedAt: dateTime(value.issuedAt, 'issuedAt'),
        expiresAt: dateTime(value.expiresAt, 'expiresAt'),
      };
    },

    async verifySiwe(message, signature) {
      const body = await request(normalizedBaseUrl, '/v2/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ message, signature }),
      });
      const value = record(body, 'SIWE session');
      const roles = array(value.roles, 'roles').map((role) => {
        const parsed = string(role, 'role');
        if (!userRoleSet.has(parsed)) invalid('Unknown session role');
        return parsed as UserRole;
      });
      return {
        token: string(value.token, 'token'),
        walletAddress: address(value.walletAddress, 'walletAddress'),
        roles,
      };
    },

    async listCatalog() {
      const body = await request(normalizedBaseUrl, '/v2/catalog/products');
      const value = record(body, 'catalog response');
      return array(value.products, 'products').map(parseCatalogProduct);
    },

    async listFulfillmentOrders(token) {
      const body = await request(normalizedBaseUrl, '/v2/orders', { token });
      const value = record(body, 'fulfillment orders response');
      return array(value.orders, 'orders').map(parseFulfillmentOrder);
    },

    async getOrderFulfillmentTarget(orderId, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/orders/${encodeURIComponent(orderId)}/fulfillment-target`,
        { token },
      );
      return parseFulfillmentTarget(record(body, 'fulfillment target response').target);
    },

    async getOrderAllowedActions(orderId, token) {
      const body = await request(normalizedBaseUrl, '/v2/actions/order', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
        token,
      });
      const value = record(body, 'allowed-actions response');
      return array(value.allowedActions, 'allowedActions').map(parseAllowedAction);
    },

    async recordShipment(orderId, input, token) {
      const body = await request(normalizedBaseUrl, `/v2/orders/${encodeURIComponent(orderId)}/shipments`, {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      });
      return parseShipmentResult(body, orderId);
    },

    async requestForcedReceipt(orderId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/orders/${encodeURIComponent(orderId)}/forced-receipt-requests`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      return parseForcedReceiptRequestResult(body, orderId);
    },

    async verifyPickup(orderId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/orders/${encodeURIComponent(orderId)}/pickup-verification`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      return parseFulfillmentCompletedResult(body, orderId, 'PICKUP_VERIFICATION');
    },
  };
}

async function request(baseUrl: string, path: string, options: { method?: string; body?: string; token?: string } = {}) {
  let response: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        'x-abu-artifact-version': artifactVersion,
      },
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new CoreApiError(
      'NetworkUnavailable',
      controller.signal.aborted
        ? 'Core API 请求超时，请检查网络后重试。'
        : '无法连接 Core API，请检查网络或服务配置。',
    );
  } finally {
    window.clearTimeout(timeout);
  }

  const correlationId = response.headers.get('x-correlation-id') ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoreApiError('InvalidResponse', 'Core 返回了无法识别的响应。', correlationId);
  }
  if (response.ok) return body;

  const value = recordOrUndefined(body);
  const error = recordOrUndefined(value?.error);
  const rawCode = typeof error?.code === 'string' ? error.code : 'UnknownState';
  const code = coreErrorCodeSet.has(rawCode) ? rawCode as CoreErrorCode : 'UnknownState';
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Core 请求失败。';
  throw new CoreApiError(code, message, correlationId);
}

function parseReadiness(input: unknown): CoreReadiness {
  const value = record(input, 'readiness');
  exact(value.chainId, 56, 'chainId');
  const assets = record(value.assets, 'assets');
  exact(
    string(assets.usdt, 'assets.usdt').toLowerCase(),
    '0x55d398326f99059ff775485246999027b3197955',
    'assets.usdt',
  );
  exact(
    string(assets.npl, 'assets.npl').toLowerCase(),
    '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    'assets.npl',
  );
  const providers = record(value.providers, 'providers');
  const parsedProviders: Record<string, 'READY' | 'CONFIGURATION_REQUIRED'> = {};
  for (const [name, state] of Object.entries(providers)) {
    if (state !== 'READY' && state !== 'CONFIGURATION_REQUIRED') invalid(`Invalid provider state: ${name}`);
    parsedProviders[name] = state;
  }
  return {
    chainId: 56,
    decisionBlocked: stringArray(value.decisionBlocked, 'decisionBlocked'),
    externalBlocked: stringArray(value.externalBlocked, 'externalBlocked'),
    paymentDecisionBlocked: stringArray(value.paymentDecisionBlocked, 'paymentDecisionBlocked'),
    paymentExternalBlocked: stringArray(value.paymentExternalBlocked, 'paymentExternalBlocked'),
    providers: parsedProviders,
    writesEnabled: boolean(value.writesEnabled, 'writesEnabled'),
  };
}

function parseCatalogProduct(input: unknown): CatalogProduct {
  const value = record(input, 'catalog product');
  const metadata = record(value.metadata, 'product.metadata');
  return {
    productId: string(value.productId, 'productId'),
    chainProductId: bytes32(value.chainProductId, 'chainProductId'),
    title: string(value.title, 'title'),
    metadata,
    skus: array(value.skus, 'skus').map(parseCatalogSku),
  };
}

function parseCatalogSku(input: unknown): CatalogSku {
  const value = record(input, 'catalog SKU');
  return {
    skuId: string(value.skuId, 'skuId'),
    chainSkuId: bytes32(value.chainSkuId, 'chainSkuId'),
    attributes: record(value.attributes, 'sku.attributes'),
    listPriceUsdt: atomicAmount(value.listPriceUsdt, 'listPriceUsdt'),
    stockAvailable: atomicAmount(value.stockAvailable, 'stockAvailable'),
  };
}

function parseAllowedAction(input: unknown): AllowedAction {
  const value = record(input, 'allowed action');
  const action = string(value.action, 'action');
  if (!allowedActionSet.has(action)) invalid('Unknown allowed action');
  const reasonCode = value.reasonCode === undefined ? undefined : string(value.reasonCode, 'reasonCode');
  if (reasonCode !== undefined && !allowedActionReasonSet.has(reasonCode)) invalid('Unknown action reason');
  const deadline = value.deadline === undefined ? undefined : dateTime(value.deadline, 'deadline');
  return {
    action: action as AllowedActionName,
    enabled: boolean(value.enabled, 'enabled'),
    ...(reasonCode ? { reasonCode: reasonCode as AllowedActionReasonCode } : {}),
    ...(deadline ? { deadline } : {}),
  };
}

function parseFulfillmentOrder(input: unknown): FulfillmentOrder {
  const value = record(input, 'fulfillment order');
  return {
    orderId: bytes32(value.orderId, 'order.orderId'),
    artifactVersion: string(value.artifactVersion, 'order.artifactVersion'),
    buyerWallet: address(value.buyerWallet, 'order.buyerWallet'),
    merchantId: string(value.merchantId, 'order.merchantId'),
    merchantWallet: address(value.merchantWallet, 'order.merchantWallet'),
    productId: string(value.productId, 'order.productId'),
    skuId: string(value.skuId, 'order.skuId'),
    fulfillmentMode: enumValue(value.fulfillmentMode, fulfillmentModeSet, 'order.fulfillmentMode'),
    state: enumValue(value.state, orderStateSet, 'order.state'),
    finalityStatus: enumValue(value.finalityStatus, finalityStatusSet, 'order.finalityStatus'),
    exactAmounts: parseFulfillmentExactAmounts(value.exactAmounts),
    paidAt: nullableDateTime(value.paidAt, 'order.paidAt'),
    paymentFinalizedAt: nullableDateTime(value.paymentFinalizedAt, 'order.paymentFinalizedAt'),
    shippedAt: nullableDateTime(value.shippedAt, 'order.shippedAt'),
    deliveredAt: nullableDateTime(value.deliveredAt, 'order.deliveredAt'),
    fulfilledAt: nullableDateTime(value.fulfilledAt, 'order.fulfilledAt'),
    takeoverOpenedAt: nullableDateTime(value.takeoverOpenedAt, 'order.takeoverOpenedAt'),
    arbitrationOpenedAt: nullableDateTime(value.arbitrationOpenedAt, 'order.arbitrationOpenedAt'),
    requests: array(value.requests, 'order.requests').map(parseFulfillmentRequest),
    shipments: array(value.shipments, 'order.shipments').map(parseShipmentProjection),
    logistics: array(value.logistics, 'order.logistics').map(parseLogisticsProjection),
    balances: array(value.balances, 'order.balances').map(parseFulfillmentBalance),
  };
}

function parseFulfillmentExactAmounts(input: unknown): FulfillmentExactAmounts {
  const value = record(input, 'order.exactAmounts');
  return {
    listPriceUsdt: atomicAmount(value.listPriceUsdt, 'exactAmounts.listPriceUsdt'),
    usdtPaymentAmount: atomicAmount(value.usdtPaymentAmount, 'exactAmounts.usdtPaymentAmount'),
    nplQuoteAmount: atomicAmount(value.nplQuoteAmount, 'exactAmounts.nplQuoteAmount'),
    nplPaymentAmount: atomicAmount(value.nplPaymentAmount, 'exactAmounts.nplPaymentAmount'),
    nplBurnAmount: atomicAmount(value.nplBurnAmount, 'exactAmounts.nplBurnAmount'),
    nplRewardAmount: atomicAmount(value.nplRewardAmount, 'exactAmounts.nplRewardAmount'),
    merchantBaseReceivableUsdt: atomicAmount(
      value.merchantBaseReceivableUsdt,
      'exactAmounts.merchantBaseReceivableUsdt',
    ),
    merchantConcessionAmount: atomicAmount(
      value.merchantConcessionAmount,
      'exactAmounts.merchantConcessionAmount',
    ),
    merchantNetReceivableUsdt: atomicAmount(
      value.merchantNetReceivableUsdt,
      'exactAmounts.merchantNetReceivableUsdt',
    ),
    bnmAmount: atomicAmount(value.bnmAmount, 'exactAmounts.bnmAmount'),
  };
}

function parseFulfillmentRequest(input: unknown): FulfillmentRequestProjection {
  const value = record(input, 'fulfillment request');
  return {
    requestId: string(value.requestId, 'request.requestId'),
    requestType: enumValue(value.requestType, requestTypeSet, 'request.requestType'),
    state: enumValue(value.state, requestStateSet, 'request.state'),
    requestedAt: dateTime(value.requestedAt, 'request.requestedAt'),
    resolvedAt: nullableDateTime(value.resolvedAt, 'request.resolvedAt'),
  };
}

function parseShipmentProjection(input: unknown): ShipmentProjection {
  const value = record(input, 'shipment');
  return {
    shipmentId: string(value.shipmentId, 'shipment.shipmentId'),
    carrierCode: string(value.carrierCode, 'shipment.carrierCode'),
    trackingNumberHash: bytes32(value.trackingNumberHash, 'shipment.trackingNumberHash'),
    providerReferenceHash: nullableBytes32(value.providerReferenceHash, 'shipment.providerReferenceHash'),
    createdAt: dateTime(value.createdAt, 'shipment.createdAt'),
  };
}

function parseLogisticsProjection(input: unknown): LogisticsProjection {
  const value = record(input, 'logistics event');
  return {
    logisticsEventId: string(value.logisticsEventId, 'logistics.logisticsEventId'),
    provider: enumValue(value.provider, logisticsProviderSet, 'logistics.provider'),
    status: enumValue(value.status, logisticsStatusSet, 'logistics.status'),
    locationHash: nullableBytes32(value.locationHash, 'logistics.locationHash'),
    occurredAt: dateTime(value.occurredAt, 'logistics.occurredAt'),
  };
}

function parseFulfillmentBalance(input: unknown): FulfillmentBalance {
  const value = record(input, 'fulfillment balance');
  return {
    asset: enumValue(value.asset, fulfillmentAssetSet, 'balance.asset'),
    state: enumValue(value.state, balanceStateSet, 'balance.state'),
    amount: atomicAmount(value.amount, 'balance.amount'),
  };
}

function parseFulfillmentTarget(input: unknown): FulfillmentTarget {
  const value = record(input, 'fulfillment target');
  const fulfillmentMode = enumValue<'DELIVERY' | 'PICKUP'>(
    value.fulfillmentMode,
    fulfillmentModeSet,
    'target.fulfillmentMode',
  );
  const common = {
    targetId: string(value.targetId, 'target.targetId'),
    targetHash: bytes32(value.targetHash, 'target.targetHash'),
    regionCode: regionCode(value.regionCode, 'target.regionCode'),
    regionCodeHash: bytes32(value.regionCodeHash, 'target.regionCodeHash'),
    expiresAt: dateTime(value.expiresAt, 'target.expiresAt'),
  };
  const payload = record(value.payload, 'target.payload');
  if (fulfillmentMode === 'DELIVERY') {
    return {
      ...common,
      fulfillmentMode,
      payload: {
        recipientName: string(payload.recipientName, 'target.payload.recipientName'),
        phone: string(payload.phone, 'target.payload.phone'),
        address: string(payload.address, 'target.payload.address'),
        longitude: finiteNumber(payload.longitude, 'target.payload.longitude'),
        latitude: finiteNumber(payload.latitude, 'target.payload.latitude'),
        regionCode: regionCode(payload.regionCode, 'target.payload.regionCode'),
      },
    };
  }
  const storeId = string(value.storeId, 'target.storeId');
  const store = parseMerchantStore(payload);
  exact(store.storeId, storeId, 'target storeId');
  return { ...common, fulfillmentMode, storeId, payload: store };
}

function parseMerchantStore(input: unknown): MerchantStore {
  const value = record(input, 'merchant store');
  return {
    storeId: string(value.storeId, 'store.storeId'),
    merchantId: string(value.merchantId, 'store.merchantId'),
    name: string(value.name, 'store.name'),
    regionCode: regionCode(value.regionCode, 'store.regionCode'),
    longitude: finiteNumber(value.longitude, 'store.longitude'),
    latitude: finiteNumber(value.latitude, 'store.latitude'),
    address: string(value.address, 'store.address'),
    phone: string(value.phone, 'store.phone'),
    status: enumValue(value.status, storeStatusSet, 'store.status'),
    version: positiveInteger(value.version, 'store.version'),
  };
}

function parseShipmentResult(input: unknown, expectedOrderId: string): ShipmentResult {
  const value = record(input, 'shipment result');
  const orderId = bytes32(value.orderId, 'shipment result orderId');
  exact(orderId, expectedOrderId, 'shipment result orderId');
  exact(value.state, 'SHIPPED', 'shipment result state');
  return {
    orderId,
    state: 'SHIPPED',
    shipmentId: string(value.shipmentId, 'shipment result shipmentId'),
    carrierCode: string(value.carrierCode, 'shipment result carrierCode'),
    trackingNumberHash: bytes32(value.trackingNumberHash, 'shipment result trackingNumberHash'),
    recordedAt: dateTime(value.recordedAt, 'shipment result recordedAt'),
  };
}

function parseForcedReceiptRequestResult(input: unknown, expectedOrderId: string): ForcedReceiptRequestResult {
  const value = record(input, 'forced receipt request result');
  const orderId = bytes32(value.orderId, 'forced receipt request orderId');
  exact(orderId, expectedOrderId, 'forced receipt request orderId');
  exact(value.state, 'OPEN', 'forced receipt request state');
  exact(value.platformReviewRequired, true, 'platformReviewRequired');
  exact(value.canFinalizeDirectly, false, 'canFinalizeDirectly');
  return {
    orderId,
    requestId: string(value.requestId, 'forced receipt requestId'),
    state: 'OPEN',
    platformReviewRequired: true,
    canFinalizeDirectly: false,
  };
}

function parseFulfillmentCompletedResult(
  input: unknown,
  expectedOrderId: string,
  expectedMethod: 'PICKUP_VERIFICATION',
): FulfillmentCompletedResult {
  const value = record(input, 'fulfillment result');
  const orderId = bytes32(value.orderId, 'fulfillment result orderId');
  exact(orderId, expectedOrderId, 'fulfillment result orderId');
  exact(value.state, 'FULFILLED', 'fulfillment result state');
  const method = enumValue(value.method, fulfillmentMethodSet, 'fulfillment result method');
  exact(method, expectedMethod, 'fulfillment result method');
  return {
    orderId,
    state: 'FULFILLED',
    method,
    fulfilledAt: dateTime(value.fulfilledAt, 'fulfillment result fulfilledAt'),
  };
}

function record(input: unknown, name: string) {
  const value = recordOrUndefined(input);
  if (!value) invalid(`${name} must be an object`);
  return value;
}

function recordOrUndefined(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function array(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) invalid(`${name} must be an array`);
  return input;
}

function string(input: unknown, name: string) {
  if (typeof input !== 'string' || input.length === 0) invalid(`${name} must be a non-empty string`);
  return input;
}

function stringArray(input: unknown, name: string) {
  return array(input, name).map((value) => string(value, name));
}

function boolean(input: unknown, name: string) {
  if (typeof input !== 'boolean') invalid(`${name} must be a boolean`);
  return input;
}

function enumValue<T extends string>(input: unknown, allowed: ReadonlySet<string>, name: string): T {
  const value = string(input, name);
  if (!allowed.has(value)) invalid(`${name} contains an unknown enum value`);
  return value as T;
}

function exact<T>(input: unknown, expected: T, name: string): asserts input is T {
  if (input !== expected) invalid(`${name} does not match the coordinated artifact`);
}

function address(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(`${name} must be an address`);
  return value;
}

function bytes32(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(`${name} must be bytes32`);
  return value;
}

function nullableBytes32(input: unknown, name: string) {
  return input === null ? null : bytes32(input, name);
}

function atomicAmount(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(`${name} must be a canonical integer string`);
  return value;
}

function dateTime(input: unknown, name: string) {
  const value = string(input, name);
  if (!Number.isFinite(Date.parse(value))) invalid(`${name} must be a date-time`);
  return value;
}

function nullableDateTime(input: unknown, name: string) {
  return input === null ? null : dateTime(input, name);
}

function regionCode(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^[0-9]{6}$/.test(value)) invalid(`${name} must be a six-digit region code`);
  return value;
}

function finiteNumber(input: unknown, name: string) {
  if (typeof input !== 'number' || !Number.isFinite(input)) invalid(`${name} must be a finite number`);
  return input;
}

function positiveInteger(input: unknown, name: string) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    invalid(`${name} must be a positive integer`);
  }
  return input;
}

function invalid(message: string): never {
  throw new CoreApiError('InvalidResponse', message);
}

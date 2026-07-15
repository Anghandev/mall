import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  balanceStates,
  cmsContentTypes,
  coreErrorCodes,
  fulfillmentAssets,
  fulfillmentMethods,
  fulfillmentModes,
  fulfillmentRequestStates,
  fulfillmentRequestTypes,
  guaranteeStatuses,
  logisticsProviders,
  logisticsStatuses,
  merchantGuaranteeDepositStates,
  orderFinalityStatuses,
  orderProjectionStates,
  rewardSubtypes,
  settlementRails,
  settlementRequestStates,
  storeStatuses,
  takeoverStates,
  userRoles,
  type AllowedAction,
  type AllowedActionName,
  type AllowedActionReasonCode,
  type CatalogProduct,
  type CatalogSku,
  type CmsPublicItem,
  type CoreErrorCode,
  type ForcedReceiptRequestResult,
  type FulfillmentBalance,
  type FulfillmentCompletedResult,
  type FulfillmentExactAmounts,
  type FulfillmentOrder,
  type FulfillmentReasonRequest,
  type FulfillmentRequestProjection,
  type FulfillmentTarget,
  type GuaranteeDepositProjection,
  type GuaranteeDepositRequest,
  type LogisticsProjection,
  type MerchantFinanceProjection,
  type MerchantStore,
  type PickupVerificationRequest,
  type RewardSubtype,
  type ShipmentProjection,
  type ShipmentRequest,
  type ShipmentResult,
  type SettlementIntentProjection,
  type SettlementIntentRequest,
  type SettlementListProjection,
  type SettlementRequestProjection,
  type SettlementRequestSubmission,
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
const guaranteeStatusSet = new Set<string>(guaranteeStatuses);
const guaranteeDepositStateSet = new Set<string>(merchantGuaranteeDepositStates);
const settlementRailSet = new Set<string>(settlementRails);
const settlementRequestStateSet = new Set<string>(settlementRequestStates);
const takeoverStateSet = new Set<string>(takeoverStates);
const cmsContentTypeSet = new Set<string>(cmsContentTypes);
const settlementAssetSet = new Set<string>(['USDT', 'NPL']);
const rewardSubtypeSet = new Set<string>(rewardSubtypes);
const bnmPointStateSet = new Set<string>(['LOCKED', 'AVAILABLE']);

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
  listSettlements(token: string): Promise<SettlementListProjection>;
  createSettlementIntent(input: SettlementIntentRequest, token: string): Promise<SettlementIntentProjection>;
  submitSettlementRequest(
    input: SettlementRequestSubmission,
    token: string,
  ): Promise<SettlementRequestProjection>;
  getMerchantFinance(token: string): Promise<MerchantFinanceProjection>;
  submitGuaranteeDeposit(
    input: GuaranteeDepositRequest,
    token: string,
  ): Promise<GuaranteeDepositProjection>;
  listPublicCms(walletAddress?: string): Promise<readonly CmsPublicItem[]>;
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

    async listSettlements(token) {
      return parseSettlementList(await request(normalizedBaseUrl, '/v2/settlements', { token }));
    },

    async createSettlementIntent(input, token) {
      return parseSettlementIntent(await request(normalizedBaseUrl, '/v2/settlement-intents', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async submitSettlementRequest(input, token) {
      return parseSettlementRequest(await request(normalizedBaseUrl, '/v2/settlement-requests', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async getMerchantFinance(token) {
      return parseMerchantFinance(await request(normalizedBaseUrl, '/v2/finance/merchant', { token }));
    },

    async submitGuaranteeDeposit(input, token) {
      return parseGuaranteeDeposit(await request(normalizedBaseUrl, '/v2/finance/merchant/guarantee-deposits', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async listPublicCms(walletAddress) {
      const query = walletAddress ? `?walletAddress=${encodeURIComponent(walletAddress)}` : '';
      return array(
        await request(normalizedBaseUrl, `/v2/cms/public${query}`),
        'public CMS response',
      ).map(parseCmsPublicItem);
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

function parseSettlementIntent(input: unknown): SettlementIntentProjection {
  const value = record(input, 'settlement intent');
  const intent = parseSettlementIntentRecord(value.intent);
  const typedData = record(value.typedData, 'settlement intent typedData');
  const domain = record(typedData.domain, 'settlement typedData.domain');
  const types = record(typedData.types, 'settlement typedData.types');
  const message = record(typedData.message, 'settlement typedData.message');
  const primaryType = string(typedData.primaryType, 'settlement typedData.primaryType');

  exactObjectKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'], 'settlement typedData.domain');
  exact(domain.name, 'Abu24KV2Settlement', 'settlement typedData.domain.name');
  exact(domain.version, '2', 'settlement typedData.domain.version');
  exact(domain.chainId, 56, 'settlement typedData.domain.chainId');
  exact(
    address(domain.verifyingContract, 'settlement typedData.domain.verifyingContract').toLowerCase(),
    intent.safeAddress.toLowerCase(),
    'settlement typedData.domain.verifyingContract',
  );
  exact(primaryType, 'SettlementRequest', 'settlement typedData.primaryType');
  exactObjectKeys(types, ['SettlementRequest'], 'settlement typedData.types');
  const fields = array(types.SettlementRequest, 'settlement typedData.types.SettlementRequest');
  const expectedFields = [
    ['intentId', 'bytes32'],
    ['artifactVersion', 'string'],
    ['wallet', 'address'],
    ['recipient', 'address'],
    ['rail', 'string'],
    ['asset', 'address'],
    ['safeAddress', 'address'],
    ['amount', 'uint256'],
    ['itemsHash', 'bytes32'],
    ['nonce', 'uint256'],
    ['deadline', 'uint64'],
  ] as const;
  if (fields.length !== expectedFields.length) invalid('settlement typedData type fields do not match');
  fields.forEach((field, index) => {
    const parsed = record(field, `settlement typedData field ${index}`);
    exactObjectKeys(parsed, ['name', 'type'], `settlement typedData field ${index}`);
    exact(parsed.name, expectedFields[index]![0], `settlement typedData field ${index} name`);
    exact(parsed.type, expectedFields[index]![1], `settlement typedData field ${index} type`);
  });
  exactObjectKeys(message, Object.keys(intent), 'settlement typedData.message');
  for (const [name, intentValue] of Object.entries(intent)) {
    const messageValue = message[name];
    if (typeof intentValue === 'string' && /^0x[0-9a-fA-F]{40}$/.test(intentValue)) {
      exact(address(messageValue, `settlement typedData.message.${name}`).toLowerCase(), intentValue.toLowerCase(), name);
    } else {
      exact(messageValue, intentValue, `settlement typedData.message.${name}`);
    }
  }

  return {
    intent,
    digest: bytes32(value.digest, 'settlement intent digest'),
    typedData: { domain, types, primaryType, message },
    items: array(value.items, 'settlement intent items').map((inputItem) => {
      const item = record(inputItem, 'settlement intent item');
      return {
        itemIndex: nonNegativeInteger(item.itemIndex, 'settlement intent item.itemIndex'),
        orderId: string(item.orderId, 'settlement intent item.orderId'),
        accountId: string(item.accountId, 'settlement intent item.accountId'),
        backingSafeAddress: address(item.backingSafeAddress, 'settlement intent item.backingSafeAddress'),
        amount: atomicAmount(item.amount, 'settlement intent item.amount'),
        itemHash: bytes32(item.itemHash, 'settlement intent item.itemHash'),
      };
    }),
    createdAt: dateTime(value.createdAt, 'settlement intent createdAt'),
  };
}

function parseSettlementIntentRecord(input: unknown): SettlementIntentProjection['intent'] {
  const value = record(input, 'settlement request intent');
  exact(value.artifactVersion, artifactVersion, 'settlement intent artifactVersion');
  return {
    intentId: bytes32(value.intentId, 'settlement intent.intentId'),
    artifactVersion,
    wallet: address(value.wallet, 'settlement intent.wallet'),
    recipient: address(value.recipient, 'settlement intent.recipient'),
    rail: enumValue(value.rail, settlementRailSet, 'settlement intent.rail'),
    asset: address(value.asset, 'settlement intent.asset'),
    safeAddress: address(value.safeAddress, 'settlement intent.safeAddress'),
    amount: positiveAtomicAmount(value.amount, 'settlement intent.amount'),
    itemsHash: bytes32(value.itemsHash, 'settlement intent.itemsHash'),
    nonce: atomicAmount(value.nonce, 'settlement intent.nonce'),
    deadline: positiveInteger(value.deadline, 'settlement intent.deadline'),
  };
}

function parseSettlementList(input: unknown): SettlementListProjection {
  const value = record(input, 'settlement list');
  exact(value.artifactVersion, artifactVersion, 'settlement list artifactVersion');
  return {
    artifactVersion,
    wallet: address(value.wallet, 'settlement list wallet'),
    balances: array(value.balances, 'settlement balances').map((inputBalance) => {
      const balance = record(inputBalance, 'settlement balance');
      return {
        asset: enumValue(balance.asset, settlementAssetSet, 'settlement balance.asset'),
        purpose: string(balance.purpose, 'settlement balance.purpose'),
        rewardSubtype: balance.rewardSubtype === null
          ? null
          : enumValue<RewardSubtype>(
              balance.rewardSubtype,
              rewardSubtypeSet,
              'settlement balance.rewardSubtype',
            ),
        state: enumValue(balance.state, balanceStateSet, 'settlement balance.state'),
        amount: atomicAmount(balance.amount, 'settlement balance.amount'),
      };
    }),
    points: array(value.points, 'settlement points').map((inputPoints) => {
      const points = record(inputPoints, 'settlement points balance');
      exact(points.pointsType, 'BNM', 'settlement points.pointsType');
      exact(points.purpose, 'BNM_LIABILITY', 'settlement points.purpose');
      exact(points.transferable, false, 'settlement points.transferable');
      return {
        pointsType: 'BNM',
        purpose: 'BNM_LIABILITY',
        state: enumValue<'LOCKED' | 'AVAILABLE'>(
          points.state,
          bnmPointStateSet,
          'settlement points.state',
        ),
        amount: atomicAmount(points.amount, 'settlement points.amount'),
        transferable: false,
      };
    }),
    requests: array(value.requests, 'settlement requests').map(parseSettlementRequest),
  };
}

function parseSettlementRequest(input: unknown): SettlementRequestProjection {
  const value = record(input, 'settlement request');
  exact(value.artifact_version, artifactVersion, 'settlement request artifact_version');
  return {
    request_id: string(value.request_id, 'settlement request.request_id'),
    intent_id: bytes32(value.intent_id, 'settlement request.intent_id'),
    artifact_version: artifactVersion,
    wallet_address: address(value.wallet_address, 'settlement request.wallet_address'),
    recipient_address: address(value.recipient_address, 'settlement request.recipient_address'),
    rail: enumValue(value.rail, settlementRailSet, 'settlement request.rail'),
    asset: enumValue(value.asset, settlementAssetSet, 'settlement request.asset'),
    asset_address: address(value.asset_address, 'settlement request.asset_address'),
    safe_address: address(value.safe_address, 'settlement request.safe_address'),
    amount: positiveAtomicAmount(value.amount, 'settlement request.amount'),
    items_hash: bytes32(value.items_hash, 'settlement request.items_hash'),
    intent_digest: bytes32(value.intent_digest, 'settlement request.intent_digest'),
    signature_hash: bytes32(value.signature_hash, 'settlement request.signature_hash'),
    state: enumValue(value.state, settlementRequestStateSet, 'settlement request.state'),
    batch_id: nullableString(value.batch_id, 'settlement request.batch_id'),
    final_safe_tx_hash: nullableBytes32(value.final_safe_tx_hash, 'settlement request.final_safe_tx_hash'),
    final_execution_tx_hash: nullableBytes32(
      value.final_execution_tx_hash,
      'settlement request.final_execution_tx_hash',
    ),
    requested_at: dateTime(value.requested_at, 'settlement request.requested_at'),
    batched_at: nullableDateTime(value.batched_at, 'settlement request.batched_at'),
    settled_at: nullableDateTime(value.settled_at, 'settlement request.settled_at'),
    items: array(value.items, 'settlement request.items').map((inputItem) => {
      const item = record(inputItem, 'settlement request item');
      return {
        item_index: nonNegativeInteger(item.item_index, 'settlement request item.item_index'),
        order_id: string(item.order_id, 'settlement request item.order_id'),
        account_id: string(item.account_id, 'settlement request item.account_id'),
        backing_safe_address: address(
          item.backing_safe_address,
          'settlement request item.backing_safe_address',
        ),
        amount: atomicAmount(item.amount, 'settlement request item.amount'),
        requested_journal_id: string(item.requested_journal_id, 'settlement request item.requested_journal_id'),
        batched_journal_id: nullableString(
          item.batched_journal_id,
          'settlement request item.batched_journal_id',
        ),
        settled_journal_id: nullableString(
          item.settled_journal_id,
          'settlement request item.settled_journal_id',
        ),
      };
    }),
    transitions: array(value.transitions, 'settlement request.transitions').map((inputTransition) => {
      const transition = record(inputTransition, 'settlement request transition');
      return {
        transition_id: string(transition.transition_id, 'settlement transition.transition_id'),
        request_item_index: nonNegativeInteger(
          transition.request_item_index,
          'settlement transition.request_item_index',
        ),
        batch_id: nullableString(transition.batch_id, 'settlement transition.batch_id'),
        transition_sequence: atomicAmount(
          transition.transition_sequence,
          'settlement transition.transition_sequence',
        ),
        transition_type: string(transition.transition_type, 'settlement transition.transition_type'),
        journal_id: string(transition.journal_id, 'settlement transition.journal_id'),
        created_at: dateTime(transition.created_at, 'settlement transition.created_at'),
      };
    }),
  };
}

function parseGuaranteeDeposit(input: unknown): GuaranteeDepositProjection {
  const value = record(input, 'guarantee deposit');
  return {
    depositId: string(value.depositId, 'guarantee deposit.depositId'),
    merchantId: string(value.merchantId, 'guarantee deposit.merchantId'),
    policyVersion: positiveInteger(value.policyVersion, 'guarantee deposit.policyVersion'),
    transactionHash: bytes32(value.transactionHash, 'guarantee deposit.transactionHash'),
    expectedAmountUsdt: positiveAtomicAmount(
      value.expectedAmountUsdt,
      'guarantee deposit.expectedAmountUsdt',
    ),
    operationsSafeAddress: address(value.operationsSafeAddress, 'guarantee deposit.operationsSafeAddress'),
    state: enumValue(value.state, guaranteeDepositStateSet, 'guarantee deposit.state'),
    confirmations: nonNegativeInteger(value.confirmations, 'guarantee deposit.confirmations'),
    ...(value.blockNumber === undefined
      ? {}
      : { blockNumber: nonNegativeInteger(value.blockNumber, 'guarantee deposit.blockNumber') }),
    ...(value.blockHash === undefined
      ? {}
      : { blockHash: bytes32(value.blockHash, 'guarantee deposit.blockHash') }),
    ...(value.logIndex === undefined
      ? {}
      : { logIndex: nonNegativeInteger(value.logIndex, 'guarantee deposit.logIndex') }),
  };
}

function parseMerchantFinance(input: unknown): MerchantFinanceProjection {
  const value = record(input, 'merchant finance');
  const merchant = record(value.merchant, 'merchant finance.merchant');
  const guarantee = value.guarantee === null ? null : record(value.guarantee, 'merchant finance.guarantee');
  const debt = value.debt === null ? null : record(value.debt, 'merchant finance.debt');
  return {
    merchant: {
      merchant_id: string(merchant.merchant_id, 'merchant finance.merchant_id'),
      status: string(merchant.status, 'merchant finance.status'),
      guarantee_status: enumValue(
        merchant.guarantee_status,
        guaranteeStatusSet,
        'merchant finance.guarantee_status',
      ),
      settlement_wallet: address(merchant.settlement_wallet, 'merchant finance.settlement_wallet'),
    },
    guarantee: guarantee ? {
      backing_safe_address: address(guarantee.backing_safe_address, 'merchant guarantee.backing_safe_address'),
      balance_usdt: atomicAmount(guarantee.balance_usdt, 'merchant guarantee.balance_usdt'),
      minimum_usdt: atomicAmount(guarantee.minimum_usdt, 'merchant guarantee.minimum_usdt'),
      source_evidence_hash: bytes32(guarantee.source_evidence_hash, 'merchant guarantee.source_evidence_hash'),
      updated_at: dateTime(guarantee.updated_at, 'merchant guarantee.updated_at'),
    } : null,
    guaranteeDeposits: array(value.guaranteeDeposits, 'merchant guarantee deposits').map((inputDeposit) => {
      const deposit = record(inputDeposit, 'merchant guarantee deposit history');
      return {
        deposit_id: string(deposit.deposit_id, 'merchant guarantee deposit.deposit_id'),
        policy_version: atomicAmount(deposit.policy_version, 'merchant guarantee deposit.policy_version'),
        token_address: address(deposit.token_address, 'merchant guarantee deposit.token_address'),
        operations_safe_address: address(
          deposit.operations_safe_address,
          'merchant guarantee deposit.operations_safe_address',
        ),
        expected_amount_usdt: atomicAmount(
          deposit.expected_amount_usdt,
          'merchant guarantee deposit.expected_amount_usdt',
        ),
        transaction_hash: bytes32(deposit.transaction_hash, 'merchant guarantee deposit.transaction_hash'),
        state: enumValue(deposit.state, guaranteeDepositStateSet, 'merchant guarantee deposit.state'),
        observed_block_number: nullableAtomicAmount(
          deposit.observed_block_number,
          'merchant guarantee deposit.observed_block_number',
        ),
        observed_block_hash: nullableBytes32(
          deposit.observed_block_hash,
          'merchant guarantee deposit.observed_block_hash',
        ),
        observed_log_index: nullableNonNegativeInteger(
          deposit.observed_log_index,
          'merchant guarantee deposit.observed_log_index',
        ),
        confirmations: nonNegativeInteger(deposit.confirmations, 'merchant guarantee deposit.confirmations'),
        transfer_evidence_hash: nullableBytes32(
          deposit.transfer_evidence_hash,
          'merchant guarantee deposit.transfer_evidence_hash',
        ),
        created_at: dateTime(deposit.created_at, 'merchant guarantee deposit.created_at'),
        updated_at: dateTime(deposit.updated_at, 'merchant guarantee deposit.updated_at'),
        finalized_at: nullableDateTime(deposit.finalized_at, 'merchant guarantee deposit.finalized_at'),
      };
    }),
    debt: debt ? {
      incurred_usdt: atomicAmount(debt.incurred_usdt, 'merchant debt.incurred_usdt'),
      recovered_usdt: atomicAmount(debt.recovered_usdt, 'merchant debt.recovered_usdt'),
      outstanding_usdt: atomicAmount(debt.outstanding_usdt, 'merchant debt.outstanding_usdt'),
      latest_evidence_hash: bytes32(debt.latest_evidence_hash, 'merchant debt.latest_evidence_hash'),
      updated_at: dateTime(debt.updated_at, 'merchant debt.updated_at'),
    } : null,
    takeovers: array(value.takeovers, 'merchant takeovers').map((inputTakeover) => {
      const takeover = record(inputTakeover, 'merchant takeover');
      return {
        case_id: string(takeover.case_id, 'merchant takeover.case_id'),
        order_id: string(takeover.order_id, 'merchant takeover.order_id'),
        state: enumValue(takeover.state, takeoverStateSet, 'merchant takeover.state'),
        required_usdt: nullableAtomicAmount(takeover.required_usdt, 'merchant takeover.required_usdt'),
        guarantee_used_usdt: nullableAtomicAmount(
          takeover.guarantee_used_usdt,
          'merchant takeover.guarantee_used_usdt',
        ),
        merchant_available_used_usdt: nullableAtomicAmount(
          takeover.merchant_available_used_usdt,
          'merchant takeover.merchant_available_used_usdt',
        ),
        future_proceeds_used_usdt: nullableAtomicAmount(
          takeover.future_proceeds_used_usdt,
          'merchant takeover.future_proceeds_used_usdt',
        ),
        platform_advance_usdt: nullableAtomicAmount(
          takeover.platform_advance_usdt,
          'merchant takeover.platform_advance_usdt',
        ),
        disbursed_usdt: nullableAtomicAmount(takeover.disbursed_usdt, 'merchant takeover.disbursed_usdt'),
        merchant_debt_usdt: nullableAtomicAmount(
          takeover.merchant_debt_usdt,
          'merchant takeover.merchant_debt_usdt',
        ),
        evidence_hash: bytes32(takeover.evidence_hash, 'merchant takeover.evidence_hash'),
        opened_at: dateTime(takeover.opened_at, 'merchant takeover.opened_at'),
        closed_at: nullableDateTime(takeover.closed_at, 'merchant takeover.closed_at'),
        updated_at: dateTime(takeover.updated_at, 'merchant takeover.updated_at'),
      };
    }),
  };
}

function parseCmsPublicItem(input: unknown): CmsPublicItem {
  const value = record(input, 'public CMS item');
  return {
    entryId: string(value.entryId, 'public CMS entryId'),
    versionId: string(value.versionId, 'public CMS versionId'),
    version: positiveInteger(value.version, 'public CMS version'),
    slug: string(value.slug, 'public CMS slug'),
    contentType: enumValue(value.contentType, cmsContentTypeSet, 'public CMS contentType'),
    placement: string(value.placement, 'public CMS placement'),
    locale: string(value.locale, 'public CMS locale'),
    content: record(value.content, 'public CMS content'),
    contentHash: bytes32(value.contentHash, 'public CMS contentHash'),
    audience: record(value.audience, 'public CMS audience'),
    startsAt: nullableDateTime(value.startsAt, 'public CMS startsAt'),
    endsAt: nullableDateTime(value.endsAt, 'public CMS endsAt'),
    frequencyCap: value.frequencyCap === null
      ? null
      : positiveInteger(value.frequencyCap, 'public CMS frequencyCap'),
    policyVersion: nullableAtomicAmount(value.policyVersion, 'public CMS policyVersion'),
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

function positiveAtomicAmount(input: unknown, name: string) {
  const value = atomicAmount(input, name);
  if (value === '0') invalid(`${name} must be greater than zero`);
  return value;
}

function nullableAtomicAmount(input: unknown, name: string) {
  return input === null ? null : atomicAmount(input, name);
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

function nonNegativeInteger(input: unknown, name: string) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    invalid(`${name} must be a non-negative integer`);
  }
  return input;
}

function nullableNonNegativeInteger(input: unknown, name: string) {
  return input === null ? null : nonNegativeInteger(input, name);
}

function nullableString(input: unknown, name: string) {
  return input === null ? null : string(input, name);
}

function exactObjectKeys(input: Record<string, unknown>, expected: readonly string[], name: string) {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${name} contains unexpected fields`);
  }
}

function invalid(message: string): never {
  throw new CoreApiError('InvalidResponse', message);
}

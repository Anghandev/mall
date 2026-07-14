import type {
  AllowedAction,
  CatalogProduct,
  CreateDeliveryTargetRequest,
  CreatePickupTargetRequest,
  DeliveryTarget,
  FulfillmentOrder,
  FulfillmentTarget,
  MerchantStore,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentSubmissionRequest,
  PaymentSubmissionResponse,
  PickupTarget,
  SeckillQuoteResponse,
  UserRole,
} from '@abu24k/core-artifacts';
import { artifactVersion, userRoles } from '@abu24k/core-artifacts';
import openApi from '@abu24k/core-artifacts/openapi';

import { assertPaymentQuoteIntegrity } from './payment-integrity';

export interface CorePaymentAvailability {
  artifactVersion: typeof artifactVersion;
  writesEnabled: boolean;
  blockCode: 'DecisionBlocked' | 'ExternalBlocked' | 'ConfigurationRequired' | null;
}

export interface WalletSession {
  token: string;
  walletAddress: string;
  roles: readonly UserRole[];
}

export interface CheckoutTarget {
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  fulfillmentTargetHash: string;
  regionCodeHash: string;
  label: string;
}

export interface QuoteSelection extends CheckoutTarget {
  idempotencyKey: string;
  productId: string;
  skuId: string;
  quantity: number;
}

export interface CoreClient {
  getBootstrap(): Promise<CorePaymentAvailability>;
  listCatalog(): Promise<readonly CatalogProduct[]>;
  authenticate(walletAddress: string, signMessage: (message: string) => Promise<string>): Promise<WalletSession>;
  createOrdinaryQuote(token: string, selection: QuoteSelection): Promise<PaymentQuoteResponse>;
  createSeckillQuote(token: string, sessionId: string, selection: QuoteSelection): Promise<SeckillQuoteResponse>;
  submitPayment(token: string, request: PaymentSubmissionRequest): Promise<PaymentSubmissionResponse>;
  getPayment(token: string, orderId: string): Promise<PaymentProjection>;
  listStores(regionCode?: string): Promise<readonly MerchantStore[]>;
  createDeliveryTarget(token: string, request: CreateDeliveryTargetRequest): Promise<DeliveryTarget>;
  createPickupTarget(token: string, request: CreatePickupTargetRequest): Promise<PickupTarget>;
  listOrders(token: string): Promise<readonly FulfillmentOrder[]>;
  getOrder(token: string, orderId: string): Promise<FulfillmentOrder>;
  getOrderTarget(token: string, orderId: string): Promise<FulfillmentTarget>;
  getOrderAllowedActions(token: string, orderId: string): Promise<readonly AllowedAction[]>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type HttpMethod = 'get' | 'post';

const paymentOperations = Object.freeze({
  bootstrap: operationPath('getBootstrap', 'get'),
  nonce: operationPath('createSiweNonce', 'post'),
  verify: operationPath('verifySiwe', 'post'),
  catalog: operationPath('listCatalogProducts', 'get'),
  ordinaryQuote: operationPath('createOrdinaryPaymentQuote', 'post'),
  seckillQuote: operationPath('createSeckillPaymentQuote', 'post'),
  submission: operationPath('submitPaymentTransaction', 'post'),
  payment: operationPath('getPaymentProjection', 'get'),
});

const fulfillmentOperations = Object.freeze({
  allowedActions: operationPath('getOrderAllowedActions', 'post'),
  stores: operationPath('listMerchantStores', 'get'),
  deliveryTarget: operationPath('createDeliveryTarget', 'post'),
  pickupTarget: operationPath('createPickupTarget', 'post'),
  orders: operationPath('listFulfillmentOrders', 'get'),
  order: operationPath('getFulfillmentOrder', 'get'),
  orderTarget: operationPath('getOrderFulfillmentTarget', 'get'),
});

const operations = Object.freeze({ ...paymentOperations, ...fulfillmentOperations });

export function createCoreClient(input: { baseUrl?: string; fetch?: FetchLike } = {}): CoreClient {
  const baseUrl = input.baseUrl?.replace(/\/$/, '') ?? '';
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async getBootstrap() {
      return parseBootstrap(await requestJson<unknown>(fetcher, `${baseUrl}${operations.bootstrap}`));
    },

    async listCatalog() {
      const value = await requestJson<{ products: readonly CatalogProduct[] }>(
        fetcher,
        `${baseUrl}${operations.catalog}`,
      );
      if (!Array.isArray(value.products)) throw new CoreClientError('InvalidResponse', '商品目录响应无效');
      return value.products;
    },

    async authenticate(walletAddress, signMessage) {
      const challenge = await requestJson<{ message: string }>(fetcher, `${baseUrl}${operations.nonce}`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ walletAddress }),
      });
      if (typeof challenge.message !== 'string' || challenge.message.length === 0) {
        throw new CoreClientError('InvalidResponse', '钱包登录挑战无效');
      }
      const signature = await signMessage(challenge.message);
      const verified = await requestJson<unknown>(fetcher, `${baseUrl}${operations.verify}`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ message: challenge.message, signature }),
      });
      return parseWalletSession(verified);
    },

    async createOrdinaryQuote(token, selection) {
      const quote = await requestJson<PaymentQuoteResponse>(fetcher, `${baseUrl}${operations.ordinaryQuote}`, {
        method: 'POST',
        headers: authorizedHeaders(token),
        body: JSON.stringify(quotePayload(selection)),
      });
      assertArtifactVersion(quote.artifactVersion);
      await assertPaymentQuoteIntegrity(quote);
      return quote;
    },

    async createSeckillQuote(token, sessionId, selection) {
      const quote = await requestJson<SeckillQuoteResponse>(fetcher, `${baseUrl}${operations.seckillQuote}`, {
        method: 'POST',
        headers: authorizedHeaders(token),
        body: JSON.stringify({ sessionId, ...quotePayload(selection) }),
      });
      assertArtifactVersion(quote.artifactVersion);
      await assertPaymentQuoteIntegrity(quote);
      if (quote.dual.sessionId.toLowerCase() !== sessionId.toLowerCase()) {
        throw new CoreClientError('InvalidResponse', '秒杀报价场次与请求不一致');
      }
      return quote;
    },

    submitPayment(token, request) {
      return requestJson<PaymentSubmissionResponse>(fetcher, `${baseUrl}${operations.submission}`, {
        method: 'POST',
        headers: authorizedHeaders(token),
        body: JSON.stringify(request),
      });
    },

    async getPayment(token, orderId) {
      const projection = await requestJson<PaymentProjection>(
        fetcher,
        `${baseUrl}${operations.payment.replace('{orderId}', encodeURIComponent(orderId))}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assertArtifactVersion(projection.artifactVersion);
      await assertPaymentQuoteIntegrity(projection);
      return projection;
    },

    async listStores(regionCode) {
      const query = regionCode ? `?regionCode=${encodeURIComponent(regionCode)}` : '';
      const value = await requestJson<{ stores: readonly MerchantStore[] }>(
        fetcher,
        `${baseUrl}${operations.stores}${query}`,
      );
      if (!Array.isArray(value.stores)) throw new CoreClientError('InvalidResponse', '门店列表响应无效');
      return value.stores;
    },

    createDeliveryTarget(token, request) {
      return postAuthorized<DeliveryTarget>(fetcher, `${baseUrl}${operations.deliveryTarget}`, token, request);
    },

    createPickupTarget(token, request) {
      return postAuthorized<PickupTarget>(fetcher, `${baseUrl}${operations.pickupTarget}`, token, request);
    },

    async listOrders(token) {
      const value = await requestJson<{ orders: readonly FulfillmentOrder[] }>(
        fetcher,
        `${baseUrl}${operations.orders}`,
        { headers: authorizedHeaders(token) },
      );
      if (!Array.isArray(value.orders)) throw new CoreClientError('InvalidResponse', '订单列表响应无效');
      value.orders.forEach(assertFulfillmentOrderVersion);
      return value.orders;
    },

    async getOrder(token, orderId) {
      const value = await requestJson<{ order: FulfillmentOrder }>(
        fetcher,
        `${baseUrl}${orderPath(operations.order, orderId)}`,
        { headers: authorizedHeaders(token) },
      );
      assertFulfillmentOrderVersion(value.order);
      return value.order;
    },

    async getOrderTarget(token, orderId) {
      const value = await requestJson<{ target: FulfillmentTarget }>(
        fetcher,
        `${baseUrl}${orderPath(operations.orderTarget, orderId)}`,
        { headers: authorizedHeaders(token) },
      );
      return value.target;
    },

    async getOrderAllowedActions(token, orderId) {
      const value = await postAuthorized<{ allowedActions: readonly AllowedAction[] }>(
        fetcher,
        `${baseUrl}${operations.allowedActions}`,
        token,
        { orderId },
      );
      if (!Array.isArray(value.allowedActions)) {
        throw new CoreClientError('InvalidResponse', '订单允许操作响应无效');
      }
      return value.allowedActions;
    },

  };
}

export class CoreClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'CoreClientError';
  }
}

function quotePayload(selection: QuoteSelection) {
  return {
    idempotencyKey: selection.idempotencyKey,
    productId: selection.productId,
    skuId: selection.skuId,
    quantity: selection.quantity,
    fulfillmentMode: selection.fulfillmentMode,
    fulfillmentTargetHash: selection.fulfillmentTargetHash,
    regionCodeHash: selection.regionCodeHash,
  };
}

async function requestJson<T>(fetcher: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new CoreClientError('NetworkUnavailable', '无法连接商城安全服务');
  }

  const body = await response.json().catch(() => undefined) as
    | { error?: { code?: string; message?: string; correlationId?: string } }
    | T
    | undefined;
  if (!response.ok) {
    const failure = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new CoreClientError(
      failure?.code ?? 'RequestFailed',
      failure?.message ?? '商城安全服务拒绝了请求',
      failure?.correlationId ?? response.headers.get('x-correlation-id') ?? undefined,
    );
  }
  if (!body) throw new CoreClientError('InvalidResponse', '商城安全服务返回了空响应');
  return body as T;
}

function assertArtifactVersion(value: string) {
  if (value !== artifactVersion) {
    throw new CoreClientError('ArtifactVersionMismatch', '商城与 Core 安全接口版本不一致');
  }
}

function parseBootstrap(value: unknown): CorePaymentAvailability {
  const response = objectValue(value);
  assertArtifactVersion(stringValue(response.artifactVersion));
  if (response.status !== 'CORE_API_READY') {
    throw new CoreClientError('InvalidResponse', 'Core 安全状态响应无效');
  }
  const readiness = objectValue(response.readiness);
  const paymentDecisionBlocked = stringArray(readiness.paymentDecisionBlocked);
  const paymentExternalBlocked = stringArray(readiness.paymentExternalBlocked);
  const writesEnabled = booleanValue(readiness.writesEnabled);
  return {
    artifactVersion,
    writesEnabled,
    blockCode: writesEnabled
      ? null
      : paymentDecisionBlocked.length > 0
        ? 'DecisionBlocked'
        : paymentExternalBlocked.length > 0
          ? 'ExternalBlocked'
          : 'ConfigurationRequired',
  };
}

function parseWalletSession(value: unknown): WalletSession {
  const response = objectValue(value);
  const roles = stringArray(response.roles);
  if (!roles.every((role): role is UserRole => userRoles.includes(role as UserRole))) {
    throw new CoreClientError('InvalidResponse', 'Core 返回了未知钱包角色');
  }
  return {
    token: stringValue(response.token),
    walletAddress: stringValue(response.walletAddress),
    roles,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreClientError('InvalidResponse', 'Core 响应格式无效');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoreClientError('InvalidResponse', 'Core 响应字段无效');
  }
  return value;
}

function booleanValue(value: unknown) {
  if (typeof value !== 'boolean') throw new CoreClientError('InvalidResponse', 'Core 响应布尔字段无效');
  return value;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new CoreClientError('InvalidResponse', 'Core 响应列表字段无效');
  }
  return value;
}

function jsonHeaders() {
  return { 'content-type': 'application/json' };
}

function authorizedHeaders(token: string) {
  return { ...jsonHeaders(), authorization: `Bearer ${token}` };
}

function postAuthorized<T>(fetcher: FetchLike, url: string, token: string, body: unknown) {
  return requestJson<T>(fetcher, url, {
    method: 'POST',
    headers: authorizedHeaders(token),
    body: JSON.stringify(body),
  });
}

function orderPath(path: string, orderId: string) {
  return path.replace('{orderId}', encodeURIComponent(orderId));
}

function assertFulfillmentOrderVersion(order: FulfillmentOrder) {
  assertArtifactVersion(order.artifactVersion);
}

function operationPath(operationId: string, method: HttpMethod) {
  for (const [path, entry] of Object.entries(openApi.paths)) {
    const operation = (entry as Partial<Record<HttpMethod, { operationId?: string }>>)[method];
    if (operation?.operationId === operationId) return path;
  }
  throw new Error(`Coordinated OpenAPI operation is missing: ${operationId}`);
}

export const coordinatedPaymentOperations = paymentOperations;
export const coordinatedFulfillmentOperations = fulfillmentOperations;

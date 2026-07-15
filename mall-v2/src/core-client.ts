import type {
  AllowedAction,
  CatalogProduct,
  CreateDeliveryTargetRequest,
  CreatePickupTargetRequest,
  CmsPublicItem,
  DeliveryTarget,
  FulfillmentOrder,
  FulfillmentTarget,
  MerchantStore,
  NotificationEndpointProjection,
  NotificationEndpointRequest,
  NotificationInboxItem,
  PaymentProjection,
  PaymentQuoteResponse,
  PaymentSubmissionRequest,
  PaymentSubmissionResponse,
  PickupTarget,
  RealtimeEventEnvelope,
  RealtimeEventPage,
  SeckillQuoteResponse,
  SeckillSessionHistoryPage,
  SeckillSessionProjection,
  SettlementIntentProjection,
  SettlementIntentRequest,
  SettlementListProjection,
  SettlementRequestProjection,
  SettlementRequestSubmission,
  UserRole,
} from '@abu24k/core-artifacts';
import {
  artifactVersion,
  balanceStates,
  cmsContentTypes,
  notificationDeliveryStates,
  notificationEndpointStates,
  rewardSubtypes,
  seckillStates,
  settlementRequestStates,
  userRoles,
} from '@abu24k/core-artifacts';
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
  getCurrentSeckillSession(): Promise<SeckillSessionProjection>;
  listSeckillSessionHistory(cursor?: string, limit?: number): Promise<SeckillSessionHistoryPage>;
  getSeckillSession(sessionId: string): Promise<SeckillSessionProjection>;
  listSeckillSessionEvents(sessionId: string, cursor?: string, limit?: number): Promise<RealtimeEventPage>;
  listStores(regionCode?: string): Promise<readonly MerchantStore[]>;
  createDeliveryTarget(token: string, request: CreateDeliveryTargetRequest): Promise<DeliveryTarget>;
  createPickupTarget(token: string, request: CreatePickupTargetRequest): Promise<PickupTarget>;
  listOrders(token: string): Promise<readonly FulfillmentOrder[]>;
  getOrder(token: string, orderId: string): Promise<FulfillmentOrder>;
  getOrderTarget(token: string, orderId: string): Promise<FulfillmentTarget>;
  getOrderAllowedActions(token: string, orderId: string): Promise<readonly AllowedAction[]>;
  listSettlements(token: string): Promise<SettlementListProjection>;
  createSettlementIntent(token: string, request: SettlementIntentRequest): Promise<SettlementIntentProjection>;
  submitSettlementRequest(token: string, request: SettlementRequestSubmission): Promise<SettlementRequestProjection>;
  listPublicCms(walletAddress?: string): Promise<readonly CmsPublicItem[]>;
  listNotifications(token: string, limit?: number): Promise<readonly NotificationInboxItem[]>;
  registerNotificationEndpoint(token: string, request: NotificationEndpointRequest): Promise<NotificationEndpointProjection>;
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

const settlementAdminOperations = Object.freeze({
  settlements: operationPath('listSettlements', 'get'),
  settlementIntent: operationPath('createSettlementIntent', 'post'),
  settlementRequest: operationPath('submitSettlementRequest', 'post'),
  publicCms: operationPath('listPublicCms', 'get'),
  notifications: operationPath('listNotifications', 'get'),
  notificationEndpoint: operationPath('registerNotificationEndpoint', 'post'),
});

const realtimeOperations = Object.freeze({
  seckillCurrent: operationPath('getCurrentSeckillSession', 'get'),
  seckillHistory: operationPath('listSeckillSessionHistory', 'get'),
  seckillSession: operationPath('getSeckillSession', 'get'),
  seckillEvents: operationPath('listSeckillSessionEvents', 'get'),
});

const operations = Object.freeze({
  ...paymentOperations,
  ...fulfillmentOperations,
  ...settlementAdminOperations,
  ...realtimeOperations,
});

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

    async getCurrentSeckillSession() {
      return parseSeckillSession(await requestJson<unknown>(fetcher, `${baseUrl}${operations.seckillCurrent}`));
    },

    async listSeckillSessionHistory(cursor, limit = 20) {
      const query = queryString({ cursor, limit: String(limit) });
      return parseSeckillHistory(await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.seckillHistory}${query}`,
      ));
    },

    async getSeckillSession(sessionId) {
      return parseSeckillSession(await requestJson<unknown>(
        fetcher,
        `${baseUrl}${sessionPath(operations.seckillSession, sessionId)}`,
      ));
    },

    async listSeckillSessionEvents(sessionId, cursor = '0', limit = 100) {
      const query = queryString({ cursor, limit: String(limit) });
      return parseRealtimeEventPage(await requestJson<unknown>(
        fetcher,
        `${baseUrl}${sessionPath(operations.seckillEvents, sessionId)}${query}`,
      ), sessionId);
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

    async listSettlements(token) {
      const value = await requestJson<unknown>(fetcher, `${baseUrl}${operations.settlements}`, {
        headers: authorizedHeaders(token),
      });
      return parseSettlementList(value);
    },

    async createSettlementIntent(token, request) {
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.settlementIntent}`,
        token,
        request,
      );
      return parseSettlementIntent(value);
    },

    async submitSettlementRequest(token, request) {
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.settlementRequest}`,
        token,
        request,
      );
      return parseSettlementRequest(value);
    },

    async listPublicCms(walletAddress) {
      const query = walletAddress ? `?walletAddress=${encodeURIComponent(walletAddress)}` : '';
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.publicCms}${query}`,
      );
      return parseCmsItems(value);
    },

    async listNotifications(token, limit = 50) {
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.notifications}?limit=${encodeURIComponent(String(limit))}`,
        { headers: authorizedHeaders(token) },
      );
      return parseNotifications(value);
    },

    registerNotificationEndpoint(token, request) {
      return postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.notificationEndpoint}`,
        token,
        request,
      ).then(parseNotificationEndpoint);
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

function parseSettlementList(value: unknown): SettlementListProjection {
  const response = objectValue(value);
  assertArtifactVersion(stringValue(response.artifactVersion));
  addressValue(response.wallet);
  const balances = arrayValue(response.balances);
  for (const item of balances) {
    const balance = objectValue(item);
    enumValue(balance.asset, ['USDT', 'NPL'] as const);
    stringValue(balance.purpose);
    if (balance.rewardSubtype !== null) enumValue(balance.rewardSubtype, rewardSubtypes);
    enumValue(balance.state, balanceStates);
    atomicValue(balance.amount);
  }
  const points = arrayValue(response.points);
  for (const item of points) {
    const balance = objectValue(item);
    if (balance.pointsType !== 'BNM' || balance.purpose !== 'BNM_LIABILITY' || balance.transferable !== false) {
      throw new CoreClientError('InvalidResponse', 'BNM 积分投影无效');
    }
    enumValue(balance.state, ['LOCKED', 'AVAILABLE'] as const);
    atomicValue(balance.amount);
  }
  const requests = arrayValue(response.requests);
  requests.forEach(parseSettlementRequest);
  return value as SettlementListProjection;
}

function parseSeckillHistory(value: unknown): SeckillSessionHistoryPage {
  const response = objectValue(value);
  const items = arrayValue(response.items).map(parseSeckillSession);
  if (response.nextCursor !== null) atomicValue(response.nextCursor);
  return { items, nextCursor: response.nextCursor as string | null };
}

function parseSeckillSession(value: unknown): SeckillSessionProjection {
  const response = objectValue(value);
  assertArtifactVersion(stringValue(response.artifactVersion));
  bytes32Value(response.sessionId);
  atomicValue(response.policyVersion);
  stringValue(response.merchantId);
  const product = objectValue(response.product);
  stringValue(product.productId);
  stringValue(product.skuId);
  stringValue(product.title);
  objectValue(product.metadata);
  objectValue(product.attributes);
  atomicValue(product.seckillListPriceUsdt);
  enumValue(response.phase, seckillStates);
  enumValue(response.storedPhase, seckillStates);
  for (const field of ['serverTime', 'startsAt', 'mainDeadline', 'relayDeadline', 'settlementEarliestAt', 'settlementDeadline'] as const) {
    isoValue(response[field]);
  }
  if (Date.parse(String(response.mainDeadline)) < Date.parse(String(response.startsAt))
    || Date.parse(String(response.relayDeadline)) > Date.parse(String(response.mainDeadline))
    || Date.parse(String(response.settlementDeadline)) < Date.parse(String(response.settlementEarliestAt))) {
    throw new CoreClientError('InvalidResponse', '秒杀时间边界无效');
  }
  const timers = objectValue(response.timers);
  for (const field of ['mainDurationSeconds', 'relayInitialSeconds', 'relayIncrementSeconds', 'relayCapSeconds'] as const) {
    positiveIntegerValue(timers[field]);
  }
  const inventory = objectValue(response.inventory);
  for (const field of ['total', 'sold', 'reserved', 'available'] as const) atomicValue(inventory[field]);
  atomicValue(response.prizePoolUsdt);
  if (response.lastBuyerWallet !== null) addressValue(response.lastBuyerWallet);
  if (response.winnerWallet !== null) addressValue(response.winnerWallet);
  objectValue(response.snapshot);
  stringArray(response.allowedActions);
  return value as SeckillSessionProjection;
}

function parseRealtimeEventPage(value: unknown, sessionId: string): RealtimeEventPage {
  const response = objectValue(value);
  const items = arrayValue(response.items).map((item) => parseRealtimeEvent(item, sessionId));
  const nextCursor = atomicValue(response.nextCursor);
  for (let index = 1; index < items.length; index += 1) {
    if (BigInt(items[index]!.cursor) <= BigInt(items[index - 1]!.cursor)) {
      throw new CoreClientError('InvalidResponse', '秒杀事件页顺序无效');
    }
  }
  const last = items.at(-1);
  if (last && nextCursor !== last.cursor) {
    throw new CoreClientError('InvalidResponse', '秒杀事件页游标与末条事件不一致');
  }
  return { items, nextCursor };
}

export function parseRealtimeEvent(value: unknown, sessionId: string): RealtimeEventEnvelope {
  const event = objectValue(value);
  assertArtifactVersion(stringValue(event.artifactVersion));
  if (event.protocolVersion !== 1
    || event.eventType !== 'SeckillRelayExtended'
    || event.resourceType !== 'SECKILL_SESSION'
    || event.finality !== 'FINAL') {
    throw new CoreClientError('InvalidResponse', '实时事件协议或最终性无效');
  }
  stringValue(event.eventId);
  const normalizedSessionId = bytes32Value(sessionId).toLowerCase();
  if (stringValue(event.channel).toLowerCase() !== `seckill:${normalizedSessionId}`
    || bytes32Value(event.resourceId).toLowerCase() !== normalizedSessionId) {
    throw new CoreClientError('InvalidResponse', '实时事件场次绑定无效');
  }
  atomicValue(event.cursor);
  isoValue(event.occurredAt);
  const payload = objectValue(event.payload);
  bytes32Value(payload.orderId);
  addressValue(payload.buyerWallet);
  bytes32Value(payload.transactionHash);
  atomicValue(payload.blockNumber);
  bytes32Value(payload.blockHash);
  stringValue(payload.paymentEventKey);
  isoValue(payload.previousRelayDeadline);
  isoValue(payload.relayDeadline);
  nonNegativeIntegerValue(payload.extensionSeconds);
  return value as RealtimeEventEnvelope;
}

function parseSettlementIntent(value: unknown): SettlementIntentProjection {
  const response = objectValue(value);
  const intent = objectValue(response.intent);
  assertArtifactVersion(stringValue(intent.artifactVersion));
  bytes32Value(intent.intentId);
  addressValue(intent.wallet);
  addressValue(intent.recipient);
  enumValue(intent.rail, ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT', 'TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT'] as const);
  addressValue(intent.asset);
  addressValue(intent.safeAddress);
  atomicValue(intent.amount);
  bytes32Value(intent.itemsHash);
  atomicValue(intent.nonce);
  if (!Number.isSafeInteger(intent.deadline) || Number(intent.deadline) <= 0) {
    throw new CoreClientError('InvalidResponse', '结算意图有效期无效');
  }
  bytes32Value(response.digest);
  const typedData = objectValue(response.typedData);
  objectValue(typedData.domain);
  objectValue(typedData.types);
  objectValue(typedData.message);
  stringValue(typedData.primaryType);
  arrayValue(response.items);
  stringValue(response.createdAt);
  return value as SettlementIntentProjection;
}

function parseSettlementRequest(value: unknown): SettlementRequestProjection {
  const response = objectValue(value);
  assertArtifactVersion(stringValue(response.artifact_version));
  stringValue(response.request_id);
  bytes32Value(response.intent_id);
  addressValue(response.wallet_address);
  addressValue(response.recipient_address);
  enumValue(response.rail, ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT', 'TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT'] as const);
  enumValue(response.asset, ['USDT', 'NPL'] as const);
  atomicValue(response.amount);
  enumValue(response.state, settlementRequestStates);
  optionalBytes32Value(response.final_safe_tx_hash);
  optionalBytes32Value(response.final_execution_tx_hash);
  arrayValue(response.items);
  arrayValue(response.transitions);
  return value as unknown as SettlementRequestProjection;
}

function parseCmsItems(value: unknown): readonly CmsPublicItem[] {
  return arrayValue(value).map((item) => {
    const entry = objectValue(item);
    stringValue(entry.entryId);
    stringValue(entry.versionId);
    if (!Number.isSafeInteger(entry.version) || Number(entry.version) < 1) {
      throw new CoreClientError('InvalidResponse', 'CMS 版本无效');
    }
    enumValue(entry.contentType, cmsContentTypes);
    stringValue(entry.slug);
    stringValue(entry.placement);
    stringValue(entry.locale);
    objectValue(entry.content);
    bytes32Value(entry.contentHash);
    objectValue(entry.audience);
    return item as CmsPublicItem;
  });
}

function parseNotifications(value: unknown): readonly NotificationInboxItem[] {
  return arrayValue(value).map((item) => {
    const entry = objectValue(item);
    stringValue(entry.messageId);
    stringValue(entry.sourceEventType);
    stringValue(entry.topic);
    objectValue(entry.templateData);
    enumValue(entry.deliveryState, notificationDeliveryStates);
    stringValue(entry.createdAt);
    return item as NotificationInboxItem;
  });
}

function parseNotificationEndpoint(value: unknown): NotificationEndpointProjection {
  const entry = objectValue(value);
  stringValue(entry.endpointId);
  enumValue(entry.channel, ['IN_APP', 'SMS', 'EMAIL', 'PUSH'] as const);
  enumValue(entry.provider, ['CORE', 'ALIYUN_SMS', 'TENCENT_SMS', 'SMTP', 'FIREBASE', 'JPUSH'] as const);
  stringArray(entry.topics);
  enumValue(entry.state, notificationEndpointStates);
  return value as NotificationEndpointProjection;
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

function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new CoreClientError('InvalidResponse', 'Core 响应列表字段无效');
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new CoreClientError('InvalidResponse', 'Core 响应枚举字段无效');
  }
  return value as T;
}

function addressValue(value: unknown) {
  const address = stringValue(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new CoreClientError('InvalidResponse', 'Core 响应地址无效');
  return address;
}

function bytes32Value(value: unknown) {
  const hash = stringValue(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new CoreClientError('InvalidResponse', 'Core 响应哈希无效');
  return hash;
}

function optionalBytes32Value(value: unknown) {
  if (value !== null) bytes32Value(value);
}

function atomicValue(value: unknown) {
  const amount = stringValue(value);
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new CoreClientError('InvalidResponse', 'Core 响应金额无效');
  return amount;
}

function isoValue(value: unknown) {
  const timestamp = stringValue(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new CoreClientError('InvalidResponse', 'Core 响应时间无效');
  return timestamp;
}

function positiveIntegerValue(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new CoreClientError('InvalidResponse', 'Core 响应正整数无效');
  }
  return Number(value);
}

function nonNegativeIntegerValue(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CoreClientError('InvalidResponse', 'Core 响应非负整数无效');
  }
  return Number(value);
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

function sessionPath(path: string, sessionId: string) {
  bytes32Value(sessionId);
  return path.replace('{sessionId}', encodeURIComponent(sessionId.toLowerCase()));
}

function queryString(values: Readonly<Record<string, string | undefined>>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
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
export const coordinatedSettlementAdminOperations = settlementAdminOperations;
export const coordinatedRealtimeOperations = realtimeOperations;

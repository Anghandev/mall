import type {
  AllowedAction,
  AllowedActionName,
  ArbitrationOpenedResult,
  BuyerOverview,
  BuyerProfile,
  BuyerSavedAddress,
  BuyerShoppingStatement,
  BuyerShoppingStatementPage,
  BuyerTakeoverTimeline,
  CatalogCategory,
  CatalogProduct,
  CatalogTag,
  CreateDeliveryTargetRequest,
  CreatePickupTargetRequest,
  CmsPublicItem,
  DeliveryTarget,
  EvidenceEnvelopeProjection,
  FulfillmentCommandInput,
  FulfillmentCommandResult,
  FulfillmentCompletedResult,
  FulfillmentOrder,
  FulfillmentOrderCursor,
  FulfillmentOrderPage,
  FulfillmentReasonRequest,
  FulfillmentRequestResult,
  FulfillmentTarget,
  MerchantStore,
  MediaAssetProjection,
  MediaContentType,
  MediaReadAccessProjection,
  MediaUploadIntentProjection,
  NotificationEndpointProjection,
  NotificationEndpointRequest,
  NotificationInboxItem,
  OrderStatementCursor,
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
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  balanceStates,
  catalogTaxonomyStatuses,
  cmsContentTypes,
  fulfillmentModes,
  mediaContentTypes,
  mediaPurposes,
  mediaResourceTypes,
  notificationDeliveryStates,
  notificationEndpointStates,
  rewardSubtypes,
  seckillStates,
  settlementRequestStates,
  storeStatuses,
  userRoles,
} from '@abu24k/core-artifacts';
import openApi from '@abu24k/core-artifacts/openapi';

import { assertPaymentQuoteIntegrity } from './payment-integrity';

export interface CorePaymentAvailability {
  artifactVersion: typeof artifactVersion;
  writesEnabled: boolean;
  blockCode: 'DecisionBlocked' | 'ExternalBlocked' | 'ConfigurationRequired' | null;
}

export type PublishedSeckillSessionProjection = Omit<
  SeckillSessionProjection,
  'governanceActionId' | 'rulesContentHash' | 'publicationTxHash'
> & Readonly<{
  governanceActionId: NonNullable<SeckillSessionProjection['governanceActionId']>;
  rulesContentHash: NonNullable<SeckillSessionProjection['rulesContentHash']>;
  publicationTxHash: NonNullable<SeckillSessionProjection['publicationTxHash']>;
}>;

export type PublishedSeckillSessionHistoryPage = Omit<SeckillSessionHistoryPage, 'items'> & Readonly<{
  items: readonly PublishedSeckillSessionProjection[];
}>;

export interface WalletSession {
  token: string;
  walletAddress: string;
  roles: readonly UserRole[];
}

interface CheckoutTargetBinding {
  fulfillmentMode: 'DELIVERY' | 'PICKUP';
  fulfillmentTargetHash: string;
  regionCodeHash: string;
  label: string;
}

export interface CheckoutTarget extends CheckoutTargetBinding {
  review: Readonly<
    | { kind: 'DELIVERY'; address: BuyerSavedAddress }
    | { kind: 'PICKUP'; store: MerchantStore }
  >;
}

export interface QuoteSelection extends CheckoutTargetBinding {
  idempotencyKey: string;
  productId: string;
  skuId: string;
  quantity: number;
}

export type BuyerEvidenceAction = Extract<AllowedActionName,
  'REQUEST_EXCHANGE' | 'REQUEST_DELAY' | 'CONFIRM_RECEIPT' | 'OPEN_ARBITRATION'>;

export type FulfillmentEvidenceContentType = Extract<MediaContentType,
  'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'>;

export interface FulfillmentMediaUploadRequest {
  purpose: 'FULFILLMENT_EVIDENCE';
  resourceType: 'ORDER';
  resourceId: string;
  contentType: FulfillmentEvidenceContentType;
  sizeBytes: number;
  contentSha256: string;
  idempotencyKey: string;
}

export interface BuyerAvatarUploadRequest {
  purpose: 'BUYER_AVATAR';
  resourceType: 'BUYER';
  resourceId: string;
  contentType: Extract<MediaContentType, 'image/jpeg' | 'image/png' | 'image/webp'>;
  sizeBytes: number;
  contentSha256: string;
  idempotencyKey: string;
}

export type MallMediaUploadRequest = FulfillmentMediaUploadRequest | BuyerAvatarUploadRequest;

export interface BuyerProfileUpdateRequest {
  nickname: string | null;
  avatarAssetId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ParsedBuyerAddress {
  recipientName: string | null;
  phone: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  detailAddress: string | null;
  regionCode: string | null;
  longitude: number | null;
  latitude: number | null;
  sourceReferenceHash: string | null;
  canSave: boolean;
  missingFields: readonly string[];
}

export interface BuyerAddressWriteRequest {
  label: string;
  recipientName: string;
  phone: string;
  detailAddress: string;
  longitude: number;
  latitude: number;
  isDefault: boolean;
  expectedVersion?: number;
  idempotencyKey: string;
}

export interface OrderActionEvidenceRequest {
  action: BuyerEvidenceAction;
  reasonCode: string;
  mediaAssetIds?: readonly string[];
  idempotencyKey: string;
}

export interface CoreClient {
  getBootstrap(): Promise<CorePaymentAvailability>;
  listCatalog(): Promise<readonly CatalogProduct[]>;
  listCatalogCategories(): Promise<readonly CatalogCategory[]>;
  listCatalogTags(): Promise<readonly CatalogTag[]>;
  createPublicMediaReadAccess(assetId: string): Promise<MediaReadAccessProjection>;
  createAuthenticatedMediaReadAccess(token: string, assetId: string): Promise<MediaReadAccessProjection>;
  createMediaUploadIntent(token: string, request: MallMediaUploadRequest): Promise<MediaUploadIntentProjection>;
  uploadMediaFile(intent: MediaUploadIntentProjection, file: Blob): Promise<void>;
  completeMediaUpload(token: string, uploadIntentId: string): Promise<MediaAssetProjection>;
  authenticate(walletAddress: string, signMessage: (message: string) => Promise<string>): Promise<WalletSession>;
  getBuyerProfile(token: string): Promise<BuyerProfile>;
  updateBuyerProfile(token: string, request: BuyerProfileUpdateRequest): Promise<BuyerProfile>;
  parseBuyerAddress(token: string, rawText: string): Promise<ParsedBuyerAddress>;
  listBuyerAddresses(token: string): Promise<readonly BuyerSavedAddress[]>;
  createBuyerAddress(token: string, request: BuyerAddressWriteRequest): Promise<BuyerSavedAddress>;
  updateBuyerAddress(token: string, addressId: string, request: BuyerAddressWriteRequest): Promise<BuyerSavedAddress>;
  deleteBuyerAddress(token: string, addressId: string, expectedVersion: number, idempotencyKey: string): Promise<void>;
  setDefaultBuyerAddress(token: string, addressId: string, expectedVersion: number, idempotencyKey: string): Promise<BuyerSavedAddress>;
  createBuyerAddressTarget(token: string, addressId: string, idempotencyKey: string): Promise<DeliveryTarget>;
  getBuyerOverview(token: string): Promise<BuyerOverview>;
  getBuyerTakeoverTimeline(token: string, orderId: string): Promise<BuyerTakeoverTimeline>;
  listBuyerShoppingStatements(token: string, cursor?: OrderStatementCursor, limit?: number): Promise<BuyerShoppingStatementPage>;
  createOrdinaryQuote(token: string, selection: QuoteSelection): Promise<PaymentQuoteResponse>;
  createSeckillQuote(token: string, sessionId: string, selection: QuoteSelection): Promise<SeckillQuoteResponse>;
  submitPayment(token: string, request: PaymentSubmissionRequest): Promise<PaymentSubmissionResponse>;
  getPayment(token: string, orderId: string): Promise<PaymentProjection>;
  getCurrentSeckillSession(): Promise<PublishedSeckillSessionProjection>;
  listSeckillSessionHistory(cursor?: string, limit?: number): Promise<PublishedSeckillSessionHistoryPage>;
  getSeckillSession(sessionId: string): Promise<PublishedSeckillSessionProjection>;
  listSeckillSessionEvents(sessionId: string, cursor?: string, limit?: number): Promise<RealtimeEventPage>;
  listStores(regionCode?: string): Promise<readonly MerchantStore[]>;
  createDeliveryTarget(token: string, request: CreateDeliveryTargetRequest): Promise<DeliveryTarget>;
  createPickupTarget(token: string, request: CreatePickupTargetRequest): Promise<PickupTarget>;
  listOrders(token: string, cursor?: FulfillmentOrderCursor, limit?: number): Promise<FulfillmentOrderPage>;
  getOrder(token: string, orderId: string): Promise<FulfillmentOrder>;
  getOrderTarget(token: string, orderId: string): Promise<FulfillmentTarget>;
  getOrderAllowedActions(token: string, orderId: string): Promise<readonly AllowedAction[]>;
  createOrderActionEvidence(token: string, orderId: string, request: OrderActionEvidenceRequest): Promise<EvidenceEnvelopeProjection>;
  requestExchange(token: string, orderId: string, request: FulfillmentReasonRequest): Promise<FulfillmentRequestResult>;
  requestDelay(token: string, orderId: string, request: FulfillmentReasonRequest): Promise<FulfillmentRequestResult>;
  confirmReceipt(token: string, orderId: string, request: FulfillmentCommandInput): Promise<FulfillmentCompletedResult>;
  openArbitration(token: string, orderId: string, request: FulfillmentReasonRequest): Promise<ArbitrationOpenedResult>;
  listSettlements(token: string): Promise<SettlementListProjection>;
  createSettlementIntent(token: string, request: SettlementIntentRequest): Promise<SettlementIntentProjection>;
  submitSettlementRequest(token: string, request: SettlementRequestSubmission): Promise<SettlementRequestProjection>;
  listPublicCms(token?: string): Promise<readonly CmsPublicItem[]>;
  listNotifications(token: string, limit?: number): Promise<readonly NotificationInboxItem[]>;
  registerNotificationEndpoint(token: string, request: NotificationEndpointRequest): Promise<NotificationEndpointProjection>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type HttpMethod = 'get' | 'post' | 'put' | 'delete';

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

const catalogMediaOperations = Object.freeze({
  categories: operationPath('listCatalogCategories', 'get'),
  tags: operationPath('listCatalogTags', 'get'),
  mediaReadAccess: operationPath('createMediaReadAccess', 'get'),
  mediaUploadIntent: operationPath('createMediaUploadIntent', 'post'),
  mediaUploadComplete: operationPath('completeMediaUpload', 'post'),
});

const buyerAccountOperations = Object.freeze({
  profile: operationPath('getBuyerProfile', 'get'),
  profileUpdate: operationPath('updateBuyerProfile', 'put'),
  addressParse: operationPath('parseBuyerAddress', 'post'),
  addresses: operationPath('listBuyerAddresses', 'get'),
  addressCreate: operationPath('createBuyerAddress', 'post'),
  addressUpdate: operationPath('updateBuyerAddress', 'put'),
  addressDelete: operationPath('deleteBuyerAddress', 'delete'),
  addressDefault: operationPath('setDefaultBuyerAddress', 'post'),
  addressTarget: operationPath('createSavedAddressFulfillmentTarget', 'post'),
  overview: operationPath('getBuyerOverview', 'get'),
  takeoverTimeline: operationPath('getBuyerTakeoverTimeline', 'get'),
  shoppingStatements: operationPath('listBuyerShoppingStatements', 'get'),
});

const fulfillmentOperations = Object.freeze({
  allowedActions: operationPath('getOrderAllowedActions', 'post'),
  stores: operationPath('listMerchantStores', 'get'),
  deliveryTarget: operationPath('createDeliveryTarget', 'post'),
  pickupTarget: operationPath('createPickupTarget', 'post'),
  orders: operationPath('listFulfillmentOrders', 'get'),
  order: operationPath('getFulfillmentOrder', 'get'),
  orderTarget: operationPath('getOrderFulfillmentTarget', 'get'),
  orderEvidence: operationPath('createOrderActionEvidence', 'post'),
  requestExchange: operationPath('requestExchange', 'post'),
  requestDelay: operationPath('requestDelay', 'post'),
  confirmReceipt: operationPath('confirmReceipt', 'post'),
  openArbitration: operationPath('openArbitration', 'post'),
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
  ...catalogMediaOperations,
  ...buyerAccountOperations,
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
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.catalog}`,
      );
      return parseCatalogProducts(objectValue(value).products);
    },

    async listCatalogCategories() {
      const value = await requestJson<unknown>(fetcher, `${baseUrl}${operations.categories}`);
      return parseCatalogCategories(objectValue(value).categories);
    },

    async listCatalogTags() {
      const value = await requestJson<unknown>(fetcher, `${baseUrl}${operations.tags}`);
      return parseCatalogTags(objectValue(value).tags);
    },

    async createPublicMediaReadAccess(assetId) {
      const normalizedAssetId = bytes32Value(assetId).toLowerCase();
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${mediaAssetPath(operations.mediaReadAccess, normalizedAssetId)}`,
      );
      return parsePublicMediaReadAccess(value, normalizedAssetId);
    },

    async createAuthenticatedMediaReadAccess(token, assetId) {
      const normalizedAssetId = bytes32Value(assetId).toLowerCase();
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${mediaAssetPath(operations.mediaReadAccess, normalizedAssetId)}`,
        { headers: authorizedHeaders(token) },
      );
      return parseAuthenticatedMediaReadAccess(value, normalizedAssetId);
    },

    async createMediaUploadIntent(token, request) {
      validateMediaUploadRequest(request);
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.mediaUploadIntent}`,
        token,
        request,
      );
      return parseMediaUploadIntent(value, request);
    },

    async uploadMediaFile(intent, file) {
      assertUploadFileMatchesIntent(intent, file);
      let response: Response;
      try {
        response = await fetcher(intent.uploadUrl, {
          method: 'PUT',
          headers: { ...intent.headers },
          body: file,
        });
      } catch {
        throw new CoreClientError('ExternalBlocked', '证据文件上传服务不可用');
      }
      if (!response.ok) throw new CoreClientError('ExternalBlocked', '证据文件上传失败');
    },

    async completeMediaUpload(token, uploadIntentId) {
      const normalizedIntentId = bytes32Value(uploadIntentId).toLowerCase();
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${uploadIntentPath(operations.mediaUploadComplete, normalizedIntentId)}`,
        token,
        {},
      );
      return parseMediaAsset(value, normalizedIntentId);
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

    async getBuyerProfile(token) {
      const value = await requestJson<unknown>(fetcher, `${baseUrl}${operations.profile}`, {
        headers: authorizedHeaders(token),
      });
      return parseBuyerProfile(value);
    },

    async updateBuyerProfile(token, request) {
      validateBuyerProfileUpdate(request);
      const value = await putAuthorized<unknown>(fetcher, `${baseUrl}${operations.profileUpdate}`, token, request);
      return parseBuyerProfile(value);
    },

    async parseBuyerAddress(token, rawText) {
      const normalized = rawText.trim();
      if (normalized.length < 5 || normalized.length > 1_000) {
        throw new CoreClientError('InvalidRequest', '地址文本需为 5-1000 个字符');
      }
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.addressParse}`,
        token,
        { rawText: normalized },
      );
      return parseBuyerAddressProjection(value);
    },

    async listBuyerAddresses(token) {
      const value = objectValue(await requestJson<unknown>(fetcher, `${baseUrl}${operations.addresses}`, {
        headers: authorizedHeaders(token),
      }));
      assertArtifactVersion(stringValue(value.artifactVersion));
      return arrayValue(value.addresses).map(parseBuyerSavedAddress);
    },

    async createBuyerAddress(token, request) {
      validateBuyerAddressWrite(request, false);
      return parseBuyerSavedAddress(await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.addressCreate}`,
        token,
        request,
      ));
    },

    async updateBuyerAddress(token, addressId, request) {
      validateBuyerAddressWrite(request, true);
      return parseBuyerSavedAddress(await putAuthorized<unknown>(
        fetcher,
        `${baseUrl}${accountResourcePath(operations.addressUpdate, addressId)}`,
        token,
        request,
      ));
    },

    async deleteBuyerAddress(token, addressId, expectedVersion, idempotencyKey) {
      validateVersionedAccountCommand(expectedVersion, idempotencyKey);
      const value = objectValue(await requestJson<unknown>(
        fetcher,
        `${baseUrl}${accountResourcePath(operations.addressDelete, addressId)}`,
        {
          method: 'DELETE',
          headers: authorizedHeaders(token),
          body: JSON.stringify({ expectedVersion, idempotencyKey }),
        },
      ));
      if (value.addressId !== addressId || value.status !== 'DELETED') {
        throw new CoreClientError('InvalidResponse', '地址删除响应与请求不一致');
      }
    },

    async setDefaultBuyerAddress(token, addressId, expectedVersion, idempotencyKey) {
      validateVersionedAccountCommand(expectedVersion, idempotencyKey);
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${accountResourcePath(operations.addressDefault, addressId)}`,
        token,
        { expectedVersion, idempotencyKey },
      );
      const address = parseBuyerSavedAddress(value);
      if (address.addressId !== addressId || !address.isDefault) {
        throw new CoreClientError('InvalidResponse', '默认地址响应与请求不一致');
      }
      return address;
    },

    async createBuyerAddressTarget(token, addressId, idempotencyKey) {
      idempotencyValue(idempotencyKey);
      const value = await postAuthorized<DeliveryTarget>(
        fetcher,
        `${baseUrl}${accountResourcePath(operations.addressTarget, addressId)}`,
        token,
        { idempotencyKey },
      );
      return parseSavedAddressTarget(value);
    },

    async getBuyerOverview(token) {
      const value = await requestJson<unknown>(fetcher, `${baseUrl}${operations.overview}`, {
        headers: authorizedHeaders(token),
      });
      return parseBuyerOverview(value);
    },

    async getBuyerTakeoverTimeline(token, orderId) {
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${orderPath(operations.takeoverTimeline, orderId)}`,
        { headers: authorizedHeaders(token) },
      );
      return parseBuyerTakeoverTimeline(value, orderId);
    },

    async listBuyerShoppingStatements(token, cursor, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CoreClientError('InvalidRequest', '购物记录分页数量无效');
      }
      if (cursor) validateOrderStatementCursor(cursor);
      const query = queryString({
        cursorCreatedAt: cursor?.createdAt,
        cursorOrderId: cursor?.orderId,
        limit: String(limit),
      });
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.shoppingStatements}${query}`,
        { headers: authorizedHeaders(token) },
      );
      return parseBuyerShoppingStatementPage(value);
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
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.stores}${query}`,
      );
      return parsePublicMerchantStores(value);
    },

    createDeliveryTarget(token, request) {
      return postAuthorized<DeliveryTarget>(fetcher, `${baseUrl}${operations.deliveryTarget}`, token, request);
    },

    createPickupTarget(token, request) {
      return postAuthorized<PickupTarget>(fetcher, `${baseUrl}${operations.pickupTarget}`, token, request);
    },

    async listOrders(token, cursor, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CoreClientError('InvalidRequest', '订单分页数量无效');
      }
      const query = queryString({
        cursorCreatedAt: cursor?.createdAt,
        cursorOrderId: cursor?.orderId,
        limit: String(limit),
      });
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.orders}${query}`,
        { headers: authorizedHeaders(token) },
      );
      return parseFulfillmentOrderPage(value);
    },

    async getOrder(token, orderId) {
      const value = await requestJson<{ order: FulfillmentOrder }>(
        fetcher,
        `${baseUrl}${orderPath(operations.order, orderId)}`,
        { headers: authorizedHeaders(token) },
      );
      return parseFulfillmentOrder(value.order);
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
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${operations.allowedActions}`,
        token,
        { orderId },
      );
      return parseAllowedActions(objectValue(value).allowedActions);
    },

    async createOrderActionEvidence(token, orderId, request) {
      validateOrderActionEvidenceRequest(request);
      const value = await postAuthorized<unknown>(
        fetcher,
        `${baseUrl}${orderPath(operations.orderEvidence, orderId)}`,
        token,
        request,
      );
      return parseOrderActionEvidence(value, orderId, request);
    },

    requestExchange(token, orderId, request) {
      return submitOrderCommand<FulfillmentRequestResult>(fetcher, baseUrl, operations.requestExchange, token, orderId, request, 'REQUEST_EXCHANGE');
    },

    requestDelay(token, orderId, request) {
      return submitOrderCommand<FulfillmentRequestResult>(fetcher, baseUrl, operations.requestDelay, token, orderId, request, 'REQUEST_DELAY');
    },

    confirmReceipt(token, orderId, request) {
      return submitOrderCommand<FulfillmentCompletedResult>(fetcher, baseUrl, operations.confirmReceipt, token, orderId, request, 'CONFIRM_RECEIPT');
    },

    openArbitration(token, orderId, request) {
      return submitOrderCommand<ArbitrationOpenedResult>(fetcher, baseUrl, operations.openArbitration, token, orderId, request, 'OPEN_ARBITRATION');
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

    async listPublicCms(token) {
      const value = await requestJson<unknown>(
        fetcher,
        `${baseUrl}${operations.publicCms}`,
        token ? { headers: authorizedHeaders(token) } : undefined,
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

function parseBuyerProfile(value: unknown): BuyerProfile {
  const profile = objectValue(value);
  assertArtifactVersion(stringValue(profile.artifactVersion));
  addressValue(profile.wallet);
  if (atomicValue(profile.accountId) === '0') throw new CoreClientError('InvalidResponse', '买家 UID 无效');
  if (profile.nickname !== null) boundedNonEmptyStringValue(profile.nickname, 40);
  optionalBytes32Value(profile.avatarAssetId);
  nonNegativeIntegerValue(profile.version);
  optionalIsoValue(profile.updatedAt);
  return value as BuyerProfile;
}

function parseBuyerAddressProjection(value: unknown): ParsedBuyerAddress {
  const address = objectValue(value);
  for (const field of ['recipientName', 'province', 'city', 'district', 'detailAddress'] as const) {
    if (address[field] !== null) stringValue(address[field]);
  }
  if (address.phone !== null && !/^1[3-9][0-9]{9}$/.test(stringValue(address.phone))) {
    throw new CoreClientError('InvalidResponse', '地址解析手机号无效');
  }
  if (address.regionCode !== null && !/^[0-9]{6}$/.test(stringValue(address.regionCode))) {
    throw new CoreClientError('InvalidResponse', '地址解析行政区无效');
  }
  if (address.longitude !== null) boundedNumberValue(address.longitude, -180, 180);
  if (address.latitude !== null) boundedNumberValue(address.latitude, -90, 90);
  optionalBytes32Value(address.sourceReferenceHash);
  const canSave = booleanValue(address.canSave);
  const missingFields = stringArray(address.missingFields);
  if (canSave !== (missingFields.length === 0)) {
    throw new CoreClientError('InvalidResponse', '地址解析完整性状态矛盾');
  }
  return value as ParsedBuyerAddress;
}

function parseBuyerSavedAddress(value: unknown): BuyerSavedAddress {
  const address = objectValue(value);
  stringValue(address.addressId);
  boundedNonEmptyStringValue(address.label, 32);
  boundedNonEmptyStringValue(address.recipientName, 64);
  if (!/^1[3-9][0-9]{9}$/.test(stringValue(address.phone))) {
    throw new CoreClientError('InvalidResponse', '收货地址手机号无效');
  }
  boundedNonEmptyStringValue(address.detailAddress, 300);
  boundedNumberValue(address.longitude, -180, 180);
  boundedNumberValue(address.latitude, -90, 90);
  for (const field of ['province', 'city', 'district', 'formattedAddress'] as const) stringValue(address[field]);
  if (!/^[0-9]{6}$/.test(stringValue(address.regionCode))) {
    throw new CoreClientError('InvalidResponse', '收货地址行政区无效');
  }
  booleanValue(address.isDefault);
  positiveIntegerValue(address.version);
  isoValue(address.updatedAt);
  return value as BuyerSavedAddress;
}

function parseBuyerOverview(value: unknown): BuyerOverview {
  const overview = objectValue(value);
  assertArtifactVersion(stringValue(overview.artifactVersion));
  addressValue(overview.wallet);
  const counts = objectValue(overview.orderCounts);
  const pending = objectValue(counts.pendingPayment);
  if (
    pending.status !== 'DecisionBlocked'
    || pending.count !== null
    || pending.blocker !== 'BUYER_PENDING_PAYMENT_PROJECTION'
  ) throw new CoreClientError('InvalidResponse', '待付款统计未按决策阻塞状态返回');
  for (const field of ['pendingShipment', 'pendingReceipt', 'afterSale', 'total'] as const) {
    const metric = objectValue(counts[field]);
    if (metric.status !== 'AVAILABLE') throw new CoreClientError('InvalidResponse', '买家订单统计状态无效');
    atomicValue(metric.count);
  }
  return value as BuyerOverview;
}

function parseBuyerTakeoverTimeline(value: unknown, expectedOrderId: string): BuyerTakeoverTimeline {
  const timeline = objectValue(value);
  assertArtifactVersion(stringValue(timeline.artifactVersion));
  if (timeline.orderId !== expectedOrderId) {
    throw new CoreClientError('InvalidResponse', '接管时间线与请求订单不一致');
  }
  enumValue(timeline.historyStatus, ['COMPLETE', 'PARTIAL_LEGACY'] as const);
  arrayValue(timeline.transitions).forEach((value) => {
    const transition = objectValue(value);
    stringValue(transition.transitionId);
    if (transition.fromState !== null) enumValue(transition.fromState, TAKEOVER_STATES);
    enumValue(transition.toState, TAKEOVER_STATES);
    stringValue(transition.evidenceType);
    isoValue(transition.occurredAt);
    if ('evidenceHash' in transition || 'publicEvidenceHash' in transition) {
      throw new CoreClientError('InvalidResponse', '买家时间线不应包含内部证据哈希');
    }
  });
  return value as BuyerTakeoverTimeline;
}

function validateOrderStatementCursor(cursor: OrderStatementCursor) {
  if (!Number.isFinite(Date.parse(cursor.createdAt)) || !/^0x[0-9a-fA-F]{64}$/.test(cursor.orderId)) {
    throw new CoreClientError('InvalidRequest', '购物记录游标无效');
  }
}

function parseBuyerShoppingStatementPage(value: unknown): BuyerShoppingStatementPage {
  const page = objectValue(value);
  assertOnlyKeys(page, ['artifactVersion', 'buyerWallet', 'statements', 'nextCursor'], '购物记录页包含未发布字段');
  assertArtifactVersion(stringValue(page.artifactVersion));
  const buyerWallet = addressValue(page.buyerWallet);
  const statements = arrayValue(page.statements).map(parseBuyerShoppingStatement);
  if (new Set(statements.map((statement) => statement.orderId.toLowerCase())).size !== statements.length) {
    throw new CoreClientError('InvalidResponse', '购物记录页包含重复订单');
  }
  for (let index = 1; index < statements.length; index += 1) {
    const previous = statements[index - 1]!;
    const current = statements[index]!;
    const previousTime = Date.parse(previous.createdAt);
    const currentTime = Date.parse(current.createdAt);
    if (currentTime > previousTime || (
      currentTime === previousTime
      && current.orderId.toLowerCase().localeCompare(previous.orderId.toLowerCase()) >= 0
    )) throw new CoreClientError('InvalidResponse', '购物记录顺序与稳定游标不一致');
  }

  let nextCursor: OrderStatementCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = objectValue(page.nextCursor);
    assertOnlyKeys(cursor, ['createdAt', 'orderId'], '购物记录游标包含未发布字段');
    nextCursor = {
      createdAt: isoValue(cursor.createdAt),
      orderId: bytes32Value(cursor.orderId) as OrderStatementCursor['orderId'],
    };
    const last = statements.at(-1);
    if (!last || last.createdAt !== nextCursor.createdAt || last.orderId.toLowerCase() !== nextCursor.orderId.toLowerCase()) {
      throw new CoreClientError('InvalidResponse', '购物记录游标未绑定本页最后一笔订单');
    }
  }
  return { artifactVersion, buyerWallet, statements, nextCursor };
}

function parseBuyerShoppingStatement(value: unknown): BuyerShoppingStatement {
  const statement = objectValue(value);
  assertOnlyKeys(statement, [
    'orderId', 'productId', 'skuId', 'quantity', 'orderState', 'paymentTxHash',
    'paymentFinalizedAt', 'fulfilledAt', 'createdAt', 'orderKind', 'paymentAmounts', 'bnm',
  ], '购物记录包含未发布字段');
  bytes32Value(statement.orderId);
  stringValue(statement.productId);
  stringValue(statement.skuId);
  atomicValue(statement.quantity);
  enumValue(statement.orderState, [
    'QUOTED', 'SUBMITTED', 'PAID', 'SHIPPED', 'DELIVERED', 'ARBITRATION',
    'TAKEOVER', 'FULFILLMENT_PENDING', 'FULFILLED', 'REORG_PENDING',
  ] as const);
  bytes32Value(statement.paymentTxHash);
  isoValue(statement.paymentFinalizedAt);
  optionalIsoValue(statement.fulfilledAt);
  isoValue(statement.createdAt);
  enumValue(statement.orderKind, ['ORDINARY', 'FALLBACK_RETAIL'] as const);

  const paymentAmounts = objectValue(statement.paymentAmounts);
  assertOnlyKeys(paymentAmounts, ['usdtPaymentAmount', 'nplPaymentAmount'], '购物记录付款金额包含未发布字段');
  atomicValue(paymentAmounts.usdtPaymentAmount);
  atomicValue(paymentAmounts.nplPaymentAmount);

  const bnm = objectValue(statement.bnm);
  assertOnlyKeys(bnm, ['amount', 'state', 'transferable', 'journalIds'], 'BNM 记录包含未发布字段');
  atomicValue(bnm.amount);
  enumValue(bnm.state, ['LOCKED', 'AVAILABLE'] as const);
  if (bnm.transferable !== false) throw new CoreClientError('InvalidResponse', 'BNM 不得投影为可转移资产');
  const journalIds = arrayValue(bnm.journalIds).map(stringValue);
  if (journalIds.length === 0 || new Set(journalIds).size !== journalIds.length) {
    throw new CoreClientError('InvalidResponse', 'BNM 账本来源证据无效');
  }
  return value as BuyerShoppingStatement;
}

function parseSavedAddressTarget(value: unknown): DeliveryTarget {
  const target = objectValue(value);
  stringValue(target.targetId);
  bytes32Value(target.targetHash);
  if (target.fulfillmentMode !== 'DELIVERY') {
    throw new CoreClientError('InvalidResponse', '保存地址未生成快递履约目标');
  }
  if (!/^[0-9]{6}$/.test(stringValue(target.regionCode))) {
    throw new CoreClientError('InvalidResponse', '履约目标行政区无效');
  }
  bytes32Value(target.regionCodeHash);
  isoValue(target.expiresAt);
  return value as unknown as DeliveryTarget;
}

function validateBuyerProfileUpdate(request: BuyerProfileUpdateRequest) {
  if (request.nickname !== null) boundedNonEmptyStringValue(request.nickname.trim(), 40);
  optionalBytes32Value(request.avatarAssetId);
  nonNegativeIntegerValue(request.expectedVersion);
  idempotencyValue(request.idempotencyKey);
}

function validateBuyerAddressWrite(request: BuyerAddressWriteRequest, updating: boolean) {
  boundedNonEmptyStringValue(request.label.trim(), 32);
  boundedNonEmptyStringValue(request.recipientName.trim(), 64);
  if (!/^1[3-9][0-9]{9}$/.test(request.phone)) throw new CoreClientError('InvalidRequest', '请输入有效的 11 位手机号');
  const detail = request.detailAddress.trim();
  if (detail.length < 5 || detail.length > 300) throw new CoreClientError('InvalidRequest', '详细地址需为 5-300 个字符');
  boundedNumberValue(request.longitude, -180, 180);
  boundedNumberValue(request.latitude, -90, 90);
  if (typeof request.isDefault !== 'boolean') throw new CoreClientError('InvalidRequest', '默认地址状态无效');
  if (updating) validateVersionedAccountCommand(request.expectedVersion, request.idempotencyKey);
  else if (request.expectedVersion !== undefined) throw new CoreClientError('InvalidRequest', '新建地址不应携带历史版本');
  idempotencyValue(request.idempotencyKey);
}

function validateVersionedAccountCommand(expectedVersion: unknown, idempotencyKey: string) {
  positiveIntegerValue(expectedVersion);
  idempotencyValue(idempotencyKey);
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

function parseSeckillHistory(value: unknown): PublishedSeckillSessionHistoryPage {
  const response = objectValue(value);
  const items = arrayValue(response.items).map(parseSeckillSession);
  if (response.nextCursor !== null) atomicValue(response.nextCursor);
  return { items, nextCursor: response.nextCursor as string | null };
}

function parseSeckillSession(value: unknown): PublishedSeckillSessionProjection {
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
  const snapshot = objectValue(response.snapshot);
  bytes32Value(response.governanceActionId);
  const rulesContentHash = bytes32Value(response.rulesContentHash);
  bytes32Value(response.publicationTxHash);
  if (bytes32Value(snapshot.rulesContentHash).toLowerCase() !== rulesContentHash.toLowerCase()) {
    throw new CoreClientError('InvalidResponse', '秒杀场次缺少可验证的最终发布证据');
  }
  stringArray(response.allowedActions);
  return value as PublishedSeckillSessionProjection;
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
    const audience = objectValue(entry.audience);
    enumValue(audience.type, ['ALL', 'REGION', 'MERCHANT', 'WALLET'] as const);
    if (Object.keys(audience).some((key) => key !== 'type')) {
      throw new CoreClientError('InvalidResponse', 'CMS audience 响应未脱敏');
    }
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

function parseAllowedActions(value: unknown): readonly AllowedAction[] {
  const actions = arrayValue(value).map((item) => {
    const action = objectValue(item);
    enumValue(action.action, allowedActionNames);
    booleanValue(action.enabled);
    if (action.reasonCode !== undefined) enumValue(action.reasonCode, allowedActionReasonCodes);
    if (action.deadline !== undefined) isoValue(action.deadline);
    return item as AllowedAction;
  });
  if (new Set(actions.map((action) => action.action)).size !== actions.length) {
    throw new CoreClientError('InvalidResponse', '订单允许操作包含重复动作');
  }
  return actions;
}

function parseCatalogProducts(value: unknown): readonly CatalogProduct[] {
  return arrayValue(value).map((item) => {
    const product = objectValue(item);
    stringValue(product.productId);
    bytes32Value(product.chainProductId);
    stringValue(product.title);
    boundedStringValue(product.subtitle, 120);
    objectValue(product.metadata);
    const images = arrayValue(product.mainImageAssetIds);
    if (images.length > 5) throw new CoreClientError('InvalidResponse', '商品主图数量无效');
    images.forEach(bytes32Value);
    optionalBytes32Value(product.videoAssetId);
    objectValue(product.richDetail);
    atomicValue(product.defaultFreightUsdt);
    const modes = arrayValue(product.fulfillmentModes).map((mode) => enumValue(mode, fulfillmentModes));
    if (modes.length < 1 || modes.length > 2 || new Set(modes).size !== modes.length) {
      throw new CoreClientError('InvalidResponse', '商品履约方式无效');
    }
    if (product.categoryId !== null) stringValue(product.categoryId);
    const tagIds = arrayValue(product.tagIds).map(stringValue);
    if (tagIds.length > 20 || new Set(tagIds).size !== tagIds.length) {
      throw new CoreClientError('InvalidResponse', '商品标签关联无效');
    }
    const skus = arrayValue(product.skus);
    if (skus.length === 0) throw new CoreClientError('InvalidResponse', '商品缺少可售 SKU');
    skus.forEach((skuValue) => {
      const sku = objectValue(skuValue);
      stringValue(sku.skuId);
      bytes32Value(sku.chainSkuId);
      objectValue(sku.attributes);
      atomicValue(sku.listPriceUsdt);
      atomicValue(sku.stockAvailable);
      if (sku.seckill !== null) parseCatalogSeckillOverlay(sku.seckill);
    });
    return item as CatalogProduct;
  });
}

function parsePublicMerchantStores(value: unknown): readonly MerchantStore[] {
  const response = objectValue(value);
  assertOnlyKeys(response, ['stores'], '门店列表响应包含未发布字段');
  return arrayValue(response.stores).map((item) => {
    const store = objectValue(item);
    assertOnlyKeys(store, [
      'storeId',
      'merchantId',
      'name',
      'regionCode',
      'longitude',
      'latitude',
      'address',
      'phone',
      'businessHours',
      'imageAssetIds',
      'status',
      'version',
    ], '公开门店响应包含未发布字段');
    stringValue(store.storeId);
    stringValue(store.merchantId);
    boundedNonEmptyStringValue(store.name, 100);
    if (!/^[0-9]{6}$/.test(stringValue(store.regionCode))) {
      throw new CoreClientError('InvalidResponse', '公开门店行政区无效');
    }
    boundedNumberValue(store.longitude, -180, 180);
    boundedNumberValue(store.latitude, -90, 90);
    stringValue(store.address);
    if (!/^[+]?[0-9-]{7,20}$/.test(stringValue(store.phone))) {
      throw new CoreClientError('InvalidResponse', '公开门店电话无效');
    }
    boundedNonEmptyStringValue(store.businessHours, 240);
    const imageAssetIds = arrayValue(store.imageAssetIds).map(bytes32Value);
    if (
      imageAssetIds.length < 1
      || imageAssetIds.length > 5
      || new Set(imageAssetIds.map((assetId) => assetId.toLowerCase())).size !== imageAssetIds.length
    ) {
      throw new CoreClientError('InvalidResponse', '公开门店图片投影无效');
    }
    const status = enumValue(store.status, storeStatuses);
    if (status !== 'ACTIVE') {
      throw new CoreClientError('InvalidResponse', '公开门店列表包含非营业门店');
    }
    positiveIntegerValue(store.version);
    return item as MerchantStore;
  });
}

function parseCatalogSeckillOverlay(value: unknown) {
  const overlay = objectValue(value);
  bytes32Value(overlay.sessionId);
  atomicValue(overlay.policyVersion);
  enumValue(overlay.phase, ['PREHEAT', 'LIVE', 'SETTLING'] as const);
  const startsAt = Date.parse(isoValue(overlay.startsAt));
  const mainDeadline = Date.parse(isoValue(overlay.mainDeadline));
  const relayDeadline = Date.parse(isoValue(overlay.relayDeadline));
  if (startsAt >= mainDeadline || relayDeadline > mainDeadline) {
    throw new CoreClientError('InvalidResponse', '秒杀时间边界无效');
  }
  atomicValue(overlay.seckillListPriceUsdt);
  const inventory = objectValue(overlay.inventory);
  for (const field of ['total', 'sold', 'reserved', 'available'] as const) atomicValue(inventory[field]);
  if (overlay.ordinaryCheckoutAllowed !== false) {
    throw new CoreClientError('InvalidResponse', '活动 SKU 必须禁止普通结算');
  }
}

function parseCatalogCategories(value: unknown): readonly CatalogCategory[] {
  return arrayValue(value).map((item) => {
    const category = objectValue(item);
    stringValue(category.categoryId);
    atomicValue(category.version);
    if (category.parentCategoryId !== null) stringValue(category.parentCategoryId);
    const level = positiveIntegerValue(category.level);
    if (level > 3 || (level === 1) !== (category.parentCategoryId === null)) {
      throw new CoreClientError('InvalidResponse', '商品类目层级无效');
    }
    stringValue(category.name);
    optionalBytes32Value(category.iconAssetId);
    nonNegativeIntegerValue(category.sortOrder);
    if (enumValue(category.status, catalogTaxonomyStatuses) !== 'ENABLED') {
      throw new CoreClientError('InvalidResponse', '公开类目包含未启用版本');
    }
    const serviceFee = objectValue(category.serviceFee);
    enumValue(serviceFee.state, ['Frozen', 'DecisionBlocked'] as const);
    if (serviceFee.valueBps !== null) {
      const valueBps = nonNegativeIntegerValue(serviceFee.valueBps);
      if (valueBps > 10_000) throw new CoreClientError('InvalidResponse', '类目服务费投影无效');
    }
    return item as CatalogCategory;
  });
}

function parseCatalogTags(value: unknown): readonly CatalogTag[] {
  return arrayValue(value).map((item) => {
    const tag = objectValue(item);
    stringValue(tag.tagId);
    atomicValue(tag.version);
    stringValue(tag.name);
    if (typeof tag.example !== 'string') throw new CoreClientError('InvalidResponse', '商品标签示例无效');
    nonNegativeIntegerValue(tag.sortOrder);
    if (enumValue(tag.status, catalogTaxonomyStatuses) !== 'ENABLED') {
      throw new CoreClientError('InvalidResponse', '公开标签包含未启用版本');
    }
    return item as CatalogTag;
  });
}

function parsePublicMediaReadAccess(value: unknown, requestedAssetId: string): MediaReadAccessProjection {
  const media = parseMediaReadAccess(value, requestedAssetId);
  if (media.accessScope !== 'PUBLIC') {
    throw new CoreClientError('Forbidden', '商品媒体未发布公共只读授权');
  }
  return media;
}

function parseAuthenticatedMediaReadAccess(value: unknown, requestedAssetId: string): MediaReadAccessProjection {
  const media = parseMediaReadAccess(value, requestedAssetId);
  if (media.accessScope !== 'AUTHENTICATED') {
    throw new CoreClientError('Forbidden', '账户媒体未绑定当前会话');
  }
  return media;
}

function parseMediaReadAccess(value: unknown, requestedAssetId: string): MediaReadAccessProjection {
  const media = objectValue(value);
  assertArtifactVersion(stringValue(media.artifactVersion));
  if (bytes32Value(media.assetId).toLowerCase() !== requestedAssetId) {
    throw new CoreClientError('InvalidResponse', '媒体读取授权与请求资产不一致');
  }
  enumValue(media.purpose, mediaPurposes);
  enumValue(media.resourceType, mediaResourceTypes);
  stringValue(media.resourceId);
  enumValue(media.contentType, mediaContentTypes);
  atomicValue(media.sizeBytes);
  bytes32Value(media.contentSha256);
  bytes32Value(media.objectVersionHash);
  enumValue(media.accessScope, ['PUBLIC', 'AUTHENTICATED'] as const);
  if (media.method !== 'GET') throw new CoreClientError('InvalidResponse', '媒体读取方式无效');
  secureTargetUrl(media.readUrl, '媒体读取地址无效');
  if (Date.parse(isoValue(media.expiresAt)) <= Date.now()) {
    throw new CoreClientError('InvalidResponse', '媒体读取授权已过期');
  }
  bytes32Value(media.providerReferenceHash);
  return value as MediaReadAccessProjection;
}

function validateMediaUploadRequest(request: MallMediaUploadRequest) {
  const isEvidence = request.purpose === 'FULFILLMENT_EVIDENCE' && request.resourceType === 'ORDER';
  const isAvatar = request.purpose === 'BUYER_AVATAR' && request.resourceType === 'BUYER';
  if (!isEvidence && !isAvatar) throw new CoreClientError('InvalidRequest', '媒体用途或资源类型无效');
  stringValue(request.resourceId);
  const contentTypes = isEvidence ? FULFILLMENT_EVIDENCE_CONTENT_TYPES : BUYER_AVATAR_CONTENT_TYPES;
  if (!(contentTypes as readonly string[]).includes(request.contentType)) {
    throw new CoreClientError('InvalidRequest', '媒体文件类型无效');
  }
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 1 || request.sizeBytes > 10_485_760) {
    throw new CoreClientError('InvalidRequest', '媒体文件大小无效');
  }
  bytes32Value(request.contentSha256);
  idempotencyValue(request.idempotencyKey);
}

function parseMediaUploadIntent(
  value: unknown,
  request: MallMediaUploadRequest,
): MediaUploadIntentProjection {
  const intent = objectValue(value);
  assertArtifactVersion(stringValue(intent.artifactVersion));
  bytes32Value(intent.uploadIntentId);
  addressValue(intent.ownerWallet);
  if (
    intent.purpose !== request.purpose
    || intent.resourceType !== request.resourceType
    || intent.resourceId !== request.resourceId
    || intent.contentType !== request.contentType
    || atomicValue(intent.sizeBytes) !== String(request.sizeBytes)
    || bytes32Value(intent.contentSha256).toLowerCase() !== request.contentSha256.toLowerCase()
    || intent.state !== 'UPLOADED'
    || intent.method !== 'PUT'
    || intent.writeOnce !== true
  ) throw new CoreClientError('InvalidResponse', '媒体上传授权与文件不一致');
  if (Date.parse(isoValue(intent.expiresAt)) <= Date.now()) {
    throw new CoreClientError('InvalidResponse', '媒体上传授权已过期');
  }
  secureTargetUrl(intent.uploadUrl, '媒体上传地址无效');
  const headers = objectValue(intent.headers);
  if (!Object.values(headers).every((header) => typeof header === 'string')) {
    throw new CoreClientError('InvalidResponse', '媒体上传请求头无效');
  }
  if (headerValue(headers, 'if-none-match') !== '*') {
    throw new CoreClientError('InvalidResponse', '媒体上传缺少只写一次约束');
  }
  bytes32Value(intent.providerReferenceHash);
  return value as MediaUploadIntentProjection;
}

function assertUploadFileMatchesIntent(intent: MediaUploadIntentProjection, file: Blob) {
  if (
    intent.state !== 'UPLOADED'
    || intent.method !== 'PUT'
    || intent.writeOnce !== true
    || String(file.size) !== intent.sizeBytes
    || file.type !== intent.contentType
    || Date.parse(intent.expiresAt) <= Date.now()
  ) throw new CoreClientError('InvalidRequest', '媒体文件与上传授权不一致');
}

function parseMediaAsset(value: unknown, expectedUploadIntentId: string): MediaAssetProjection {
  const asset = objectValue(value);
  assertArtifactVersion(stringValue(asset.artifactVersion));
  bytes32Value(asset.assetId);
  if (bytes32Value(asset.uploadIntentId).toLowerCase() !== expectedUploadIntentId) {
    throw new CoreClientError('InvalidResponse', '已验证媒体与上传授权不一致');
  }
  addressValue(asset.ownerWallet);
  const evidenceAsset = asset.purpose === 'FULFILLMENT_EVIDENCE' && asset.resourceType === 'ORDER';
  const avatarAsset = asset.purpose === 'BUYER_AVATAR' && asset.resourceType === 'BUYER';
  if (!evidenceAsset && !avatarAsset) {
    throw new CoreClientError('InvalidResponse', '已验证媒体用途无效');
  }
  stringValue(asset.resourceId);
  const contentType = enumValue(asset.contentType, mediaContentTypes);
  const allowedContentTypes = evidenceAsset ? FULFILLMENT_EVIDENCE_CONTENT_TYPES : BUYER_AVATAR_CONTENT_TYPES;
  if (!(allowedContentTypes as readonly string[]).includes(contentType)) {
    throw new CoreClientError('InvalidResponse', '已验证媒体类型无效');
  }
  atomicValue(asset.sizeBytes);
  bytes32Value(asset.contentSha256);
  bytes32Value(asset.providerEvidenceHash);
  bytes32Value(asset.objectVersionHash);
  isoValue(asset.createdAt);
  return value as MediaAssetProjection;
}

function validateOrderActionEvidenceRequest(request: OrderActionEvidenceRequest) {
  if (!BUYER_EVIDENCE_ACTIONS.includes(request.action)) {
    throw new CoreClientError('InvalidRequest', '买家证据动作无效');
  }
  reasonCodeValue(request.reasonCode);
  const mediaAssetIds = request.mediaAssetIds ?? [];
  if (mediaAssetIds.length > 8 || new Set(mediaAssetIds.map((assetId) => assetId.toLowerCase())).size !== mediaAssetIds.length) {
    throw new CoreClientError('InvalidRequest', '订单证据媒体列表无效');
  }
  mediaAssetIds.forEach(bytes32Value);
  idempotencyValue(request.idempotencyKey);
}

function parseOrderActionEvidence(
  value: unknown,
  orderId: string,
  request: OrderActionEvidenceRequest,
): EvidenceEnvelopeProjection {
  const evidence = objectValue(value);
  assertArtifactVersion(stringValue(evidence.artifactVersion));
  bytes32Value(evidence.evidenceHash);
  addressValue(evidence.ownerWallet);
  if (
    evidence.actorRole !== 'BUYER'
    || evidence.purpose !== 'FULFILLMENT_ACTION'
    || evidence.resourceType !== 'ORDER'
    || evidence.resourceId !== orderId
    || evidence.action !== request.action
    || evidence.reasonCode !== request.reasonCode
    || evidence.trackingNumberHash !== null
  ) throw new CoreClientError('InvalidResponse', '订单证据封装与买家动作不一致');
  const mediaAssetIds = arrayValue(evidence.mediaAssetIds).map(bytes32Value);
  const requestedIds = request.mediaAssetIds ?? [];
  if (
    mediaAssetIds.length !== requestedIds.length
    || mediaAssetIds.some((assetId, index) => assetId.toLowerCase() !== requestedIds[index]?.toLowerCase())
  ) throw new CoreClientError('InvalidResponse', '订单证据媒体绑定不一致');
  objectValue(evidence.payload);
  isoValue(evidence.createdAt);
  return value as EvidenceEnvelopeProjection;
}

async function submitOrderCommand<T extends FulfillmentCommandResult>(
  fetcher: FetchLike,
  baseUrl: string,
  path: string,
  token: string,
  orderId: string,
  request: FulfillmentCommandInput | FulfillmentReasonRequest,
  action: BuyerEvidenceAction,
) {
  const normalizedOrderId = bytes32Value(orderId).toLowerCase();
  idempotencyValue(request.idempotencyKey);
  bytes32Value(request.evidenceHash);
  if (action === 'CONFIRM_RECEIPT') {
    if ('reasonCode' in request) throw new CoreClientError('InvalidRequest', '确认收货命令不接受原因代码');
  } else {
    if (!('reasonCode' in request)) throw new CoreClientError('InvalidRequest', '买家履约命令缺少原因代码');
    reasonCodeValue(request.reasonCode);
  }
  const value = await postAuthorized<unknown>(
    fetcher,
    `${baseUrl}${orderPath(path, normalizedOrderId)}`,
    token,
    request,
  );
  return parseBuyerCommandResult(value, normalizedOrderId, action) as T;
}

function parseBuyerCommandResult(
  value: unknown,
  orderId: string,
  action: BuyerEvidenceAction,
): FulfillmentCommandResult {
  const result = objectValue(value);
  if (bytes32Value(result.orderId).toLowerCase() !== orderId) {
    throw new CoreClientError('InvalidResponse', '买家履约结果与订单不一致');
  }
  if (action === 'REQUEST_EXCHANGE' || action === 'REQUEST_DELAY') {
    stringValue(result.requestId);
    if (result.requestType !== (action === 'REQUEST_EXCHANGE' ? 'EXCHANGE' : 'DELAY') || result.state !== 'OPEN') {
      throw new CoreClientError('InvalidResponse', '买家履约申请结果无效');
    }
    isoValue(result.requestedAt);
  } else if (action === 'OPEN_ARBITRATION') {
    stringValue(result.requestId);
    if (result.state !== 'ARBITRATION') throw new CoreClientError('InvalidResponse', '仲裁开启结果无效');
    isoValue(result.openedAt);
  } else {
    if (result.state !== 'FULFILLED' || result.method !== 'CUSTOMER_RECEIPT') {
      throw new CoreClientError('InvalidResponse', '确认收货结果无效');
    }
    isoValue(result.fulfilledAt);
  }
  return value as FulfillmentCommandResult;
}

const BUYER_EVIDENCE_ACTIONS = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'CONFIRM_RECEIPT',
  'OPEN_ARBITRATION',
] as const satisfies readonly BuyerEvidenceAction[];

const FULFILLMENT_EVIDENCE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const satisfies readonly FulfillmentEvidenceContentType[];

const BUYER_AVATAR_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

const TAKEOVER_STATES = [
  'OPEN',
  'FUNDED',
  'FULFILLING',
  'FULFILLMENT_PENDING',
  'CLOSED',
  'DECISION_BLOCKED',
] as const;

function reasonCodeValue(value: unknown) {
  const code = stringValue(value);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new CoreClientError('InvalidRequest', '证据原因代码格式无效');
  }
  return code;
}

function idempotencyValue(value: unknown) {
  const key = stringValue(value);
  if (key.length < 8 || key.length > 128) throw new CoreClientError('InvalidRequest', '幂等键格式无效');
  return key;
}

function secureTargetUrl(value: unknown, message: string) {
  const target = stringValue(value);
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      throw new Error('insecure target');
    }
  } catch {
    throw new CoreClientError('InvalidResponse', message);
  }
  return target;
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
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

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], message: string) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CoreClientError('InvalidResponse', message);
  }
}

function stringValue(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoreClientError('InvalidResponse', 'Core 响应字段无效');
  }
  return value;
}

function boundedStringValue(value: unknown, maxLength: number) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new CoreClientError('InvalidResponse', 'Core 响应文本字段无效');
  }
  return value;
}

function boundedNonEmptyStringValue(value: unknown, maxLength: number) {
  const text = stringValue(value);
  if (text.length > maxLength) throw new CoreClientError('InvalidResponse', 'Core 响应文本字段过长');
  return text;
}

function boundedNumberValue(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CoreClientError('InvalidResponse', 'Core 响应数值字段无效');
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

function optionalIsoValue(value: unknown) {
  if (value !== null) isoValue(value);
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

function putAuthorized<T>(fetcher: FetchLike, url: string, token: string, body: unknown) {
  return requestJson<T>(fetcher, url, {
    method: 'PUT',
    headers: authorizedHeaders(token),
    body: JSON.stringify(body),
  });
}

function orderPath(path: string, orderId: string) {
  return path.replace('{orderId}', encodeURIComponent(orderId));
}

function accountResourcePath(path: string, resourceId: string) {
  const normalized = resourceId.trim();
  if (!normalized || normalized.length > 256) throw new CoreClientError('InvalidRequest', '账户资源标识无效');
  return path.replace('{addressId}', encodeURIComponent(normalized));
}

function sessionPath(path: string, sessionId: string) {
  bytes32Value(sessionId);
  return path.replace('{sessionId}', encodeURIComponent(sessionId.toLowerCase()));
}

function mediaAssetPath(path: string, assetId: string) {
  return path.replace('{assetId}', encodeURIComponent(assetId));
}

function uploadIntentPath(path: string, uploadIntentId: string) {
  return path.replace('{uploadIntentId}', encodeURIComponent(uploadIntentId));
}

function queryString(values: Readonly<Record<string, string | undefined>>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

function parseFulfillmentOrderPage(value: unknown): FulfillmentOrderPage {
  const page = objectValue(value);
  const orders = arrayValue(page.orders).map(parseFulfillmentOrder);
  let nextCursor: FulfillmentOrderCursor | null = null;
  if (page.nextCursor !== null) {
    const cursor = objectValue(page.nextCursor);
    nextCursor = {
      createdAt: isoValue(cursor.createdAt),
      orderId: stringValue(cursor.orderId),
    };
  }
  return { orders, nextCursor };
}

function parseFulfillmentOrder(value: unknown): FulfillmentOrder {
  const order = objectValue(value);
  bytes32Value(order.orderId);
  assertArtifactVersion(stringValue(order.artifactVersion));
  addressValue(order.buyerWallet);
  stringValue(order.merchantId);
  addressValue(order.merchantWallet);
  stringValue(order.productId);
  stringValue(order.skuId);
  atomicValue(order.quantity);
  isoValue(order.createdAt);
  enumValue(order.orderKind, ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] as const);
  optionalBytes32Value(order.paymentTxHash);
  enumValue(order.fulfillmentMode, fulfillmentModes);
  enumValue(order.state, [
    'QUOTED', 'SUBMITTED', 'PAID', 'SHIPPED', 'DELIVERED', 'ARBITRATION',
    'TAKEOVER', 'FULFILLMENT_PENDING', 'FULFILLED', 'REORG_PENDING',
  ] as const);
  enumValue(order.finalityStatus, ['NOT_SUBMITTED', 'PENDING', 'CONFIRMED', 'REPLACED', 'REORGED', 'FINAL'] as const);
  const amounts = objectValue(order.exactAmounts);
  for (const field of [
    'listPriceUsdt', 'usdtPaymentAmount', 'nplQuoteAmount', 'nplPaymentAmount',
    'nplBurnAmount', 'nplRewardAmount', 'merchantBaseReceivableUsdt',
    'merchantConcessionAmount', 'merchantNetReceivableUsdt', 'bnmAmount',
  ] as const) atomicValue(amounts[field]);
  for (const field of [
    'paidAt', 'paymentFinalizedAt', 'shippedAt', 'deliveredAt', 'fulfilledAt',
    'takeoverOpenedAt', 'arbitrationOpenedAt',
  ] as const) optionalIsoValue(order[field]);
  arrayValue(order.requests).forEach((requestValue) => {
    const request = objectValue(requestValue);
    stringValue(request.requestId);
    enumValue(request.requestType, ['EXCHANGE', 'DELAY', 'ARBITRATION', 'FORCED_RECEIPT'] as const);
    enumValue(request.state, ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED'] as const);
    isoValue(request.requestedAt);
    optionalIsoValue(request.resolvedAt);
  });
  arrayValue(order.shipments).forEach((shipmentValue) => {
    const shipment = objectValue(shipmentValue);
    stringValue(shipment.shipmentId);
    stringValue(shipment.carrierCode);
    bytes32Value(shipment.trackingNumberHash);
    optionalBytes32Value(shipment.providerReferenceHash);
    isoValue(shipment.createdAt);
  });
  arrayValue(order.logistics).forEach((logisticsValue) => {
    const logistics = objectValue(logisticsValue);
    stringValue(logistics.logisticsEventId);
    enumValue(logistics.provider, ['KUAIDI100', 'CAINIAO'] as const);
    enumValue(logistics.status, ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] as const);
    optionalBytes32Value(logistics.locationHash);
    isoValue(logistics.occurredAt);
  });
  arrayValue(order.balances).forEach((balanceValue) => {
    const balance = objectValue(balanceValue);
    enumValue(balance.asset, ['USDT', 'NPL', 'BNM_POINTS'] as const);
    enumValue(balance.state, balanceStates);
    atomicValue(balance.amount);
  });
  parseAllowedActions(order.allowedActions);
  return value as FulfillmentOrder;
}

function operationPath(operationId: string, method: HttpMethod) {
  for (const [path, entry] of Object.entries(openApi.paths)) {
    const operation = (entry as Partial<Record<HttpMethod, { operationId?: string }>>)[method];
    if (operation?.operationId === operationId) return path;
  }
  throw new Error(`Coordinated OpenAPI operation is missing: ${operationId}`);
}

export const coordinatedPaymentOperations = paymentOperations;
export const coordinatedCatalogMediaOperations = catalogMediaOperations;
export const coordinatedBuyerAccountOperations = buyerAccountOperations;
export const coordinatedFulfillmentOperations = fulfillmentOperations;
export const coordinatedSettlementAdminOperations = settlementAdminOperations;
export const coordinatedRealtimeOperations = realtimeOperations;

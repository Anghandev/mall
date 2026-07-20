import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  balanceStates,
  catalogProductActions,
  catalogProductLifecycleStates,
  catalogTaxonomyStatuses,
  cmsContentTypes,
  coreErrorCodes,
  fulfillmentAssets,
  fulfillmentMethods,
  fulfillmentModes,
  fulfillmentRequestStates,
  fulfillmentRequestTypes,
  guaranteeStatuses,
  logisticsCarrierCodes,
  logisticsProviders,
  logisticsStatuses,
  merchantGuaranteeDepositStates,
  mediaContentTypes,
  mediaPurposes,
  mediaResourceTypes,
  orderFinalityStatuses,
  orderProjectionStates,
  printJobStates,
  printProviders,
  rewardSubtypes,
  seckillStates,
  settlementRails,
  settlementRequestStates,
  storeStatuses,
  takeoverStates,
  userRoles,
  waybillProviders,
  waybillRequestStates,
  type ApplyPrinterBindingRequest,
  type AllowedAction,
  type AllowedActionName,
  type AllowedActionReasonCode,
  type AuditStreamName,
  type CatalogCategory,
  type CatalogProduct,
  type CatalogProductAction,
  type CatalogProductLifecycleState,
  type CatalogSeckillOverlay,
  type CatalogSku,
  type CatalogTag,
  type CatalogWriteLock,
  type CmsPublicItem,
  type CoreErrorCode,
  type EvidenceEnvelopeProjection,
  type ForcedReceiptRequestResult,
  type FulfillmentBalance,
  type FulfillmentCompletedResult,
  type FulfillmentExactAmounts,
  type FulfillmentMode,
  type FulfillmentOrder,
  type FulfillmentOrderCursor,
  type FulfillmentOrderPage,
  type FulfillmentReasonRequest,
  type FulfillmentRequestProjection,
  type FulfillmentTarget,
  type GuaranteeDepositProjection,
  type GuaranteeDepositRequest,
  type LogisticsProjection,
  type LogisticsCarrierCode,
  type JsonObject,
  type ManagedCatalogProduct,
  type ManagedCatalogSku,
  type MediaAssetProjection,
  type MediaContentType,
  type MediaPurpose,
  type MediaReadAccessProjection,
  type MediaResourceType,
  type MediaUploadIntentProjection,
  type MerchantConcessionPreview,
  type MerchantConcessionAllocation,
  type MerchantFinanceProjection,
  type MerchantBusinessDashboard,
  type MerchantAuditExport,
  type MerchantAuditList,
  type MerchantOrderExport,
  type MerchantOrderExportRequest,
  type CreateMerchantStoreRequest,
  type MerchantManagedStore,
  type MerchantStore,
  type MerchantStoreAction,
  type MerchantStoreActionReason,
  type MerchantStoreVersionRequest,
  type MerchantProfile,
  type MerchantReceivableStatement,
  type MerchantReceivableStatementPage,
  type OrderStatementCursor,
  type PickupVerificationRequest,
  type OrderKind,
  type OrderProjectionState,
  type PrintJob,
  type PrinterBinding,
  type PrinterBindingChallenge,
  type PrinterBindingChallengeRequest,
  type RewardSubtype,
  type ShipmentBatchRequest,
  type ShipmentBatchResult,
  type ShipmentProjection,
  type ShipmentRequest,
  type ShipmentResult,
  type SettlementIntentProjection,
  type SettlementIntentRequest,
  type SettlementListProjection,
  type SettlementRequestProjection,
  type SettlementRequestSubmission,
  type TakeoverAssignment,
  type TakeoverCase,
  type TakeoverCaseCursor,
  type TakeoverCaseDetail,
  type TakeoverCaseList,
  type TakeoverCaseTransition,
  type TakeoverState,
  type UpdateMerchantStoreRequest,
  type ProductSlotInput,
  type ProductSlotProjection,
  type UserRole,
  type WaybillBatchRequest,
  type WaybillBatchResult,
  type WaybillResult,
} from '@abu24k/core-artifacts';
import merchantStoreOperations from 'virtual:merchant-store-operations';

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
const merchantFinanceActionSet = new Set<string>(['REQUEST_MERCHANT_USDT']);
const merchantSettlementEligibilityModeSet = new Set<string>(['FORMAL', 'MAINNET_MICROTEST', 'BLOCKED']);
const settlementRailSet = new Set<string>(settlementRails);
const settlementRequestStateSet = new Set<string>(settlementRequestStates);
const takeoverStateSet = new Set<string>(takeoverStates);
const cmsContentTypeSet = new Set<string>(cmsContentTypes);
const settlementAssetSet = new Set<string>(['USDT', 'NPL']);
const rewardSubtypeSet = new Set<string>(rewardSubtypes);
const seckillStateSet = new Set<string>(seckillStates);
const bnmPointStateSet = new Set<string>(['LOCKED', 'AVAILABLE']);
const catalogProductActionSet = new Set<string>(catalogProductActions);
const catalogProductLifecycleSet = new Set<string>(catalogProductLifecycleStates);
const catalogTaxonomyStatusSet = new Set<string>(catalogTaxonomyStatuses);
const mediaContentTypeSet = new Set<string>(mediaContentTypes);
const mediaPurposeSet = new Set<string>(mediaPurposes);
const mediaResourceTypeSet = new Set<string>(mediaResourceTypes);
const printJobStateSet = new Set<string>(printJobStates);
const printProviderSet = new Set<string>(printProviders);
const waybillProviderSet = new Set<string>(waybillProviders);
const waybillRequestStateSet = new Set<string>(waybillRequestStates);
const waybillCarrierSet = new Set<string>(logisticsCarrierCodes);
const merchantConcessionPoolSet = new Set<string>(['SECKILL_PRIZE', 'NODE_REWARD', 'REWARD_RESERVE']);
const orderKindSet = new Set<string>(['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] satisfies readonly OrderKind[]);
const merchantStoreActionSet = new Set<string>(['UPDATE_PROFILE', 'ACTIVATE', 'CLOSE'] satisfies readonly MerchantStoreAction[]);
const merchantStoreActionReasonSet = new Set<string>([
  'STORE_PROFILE_INCOMPLETE',
  'STORE_SUSPENDED',
  'STORE_CLOSED',
  'STORE_STATE_MISMATCH',
] satisfies readonly MerchantStoreActionReason[]);

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

export interface FulfillmentOrderListOptions {
  cursor?: FulfillmentOrderCursor;
  limit?: number;
  from?: string;
  to?: string;
  skuId?: string;
  state?: OrderProjectionState;
  fulfillmentMode?: FulfillmentMode;
  orderKind?: OrderKind;
}

export interface MerchantTakeoverCaseListOptions {
  state?: TakeoverState;
  cursor?: TakeoverCaseCursor;
  limit?: number;
}

export interface MerchantReceivableStatementListOptions {
  kind?: OrderKind;
  cursor?: OrderStatementCursor;
  limit?: number;
}

export interface TrackingEvidenceRequest {
  carrierCode: LogisticsCarrierCode;
  trackingNumber: string;
  note?: string | null;
  mediaAssetIds?: readonly string[];
  idempotencyKey: string;
}

export interface SiweChallenge {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SiweSession {
  token: string;
  walletAddress: string;
  roles: readonly UserRole[];
  merchantId?: string;
}

export interface MerchantSession extends SiweSession {
  merchantId: string;
}

export interface ConcessionPreviewRequest {
  merchantConcessionBps: number;
  idempotencyKey: string;
}

export interface ProductReviewSubmissionRequest {
  previewId: string;
  idempotencyKey: string;
}

export interface CatalogReasonRequest {
  reasonCode: string;
  idempotencyKey: string;
}

export interface MediaUploadIntentRequest {
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: number;
  contentSha256: string;
  idempotencyKey: string;
}

export interface UpdateMerchantProfileRequest {
  shopName: string;
  logoAssetId: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface MerchantAuditListOptions {
  streamName?: AuditStreamName;
  eventType?: string;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string;
  cursor?: MerchantAuditList['nextCursor'];
  from?: string;
  to?: string;
  limit?: number;
}

export interface MerchantAuditExportRequest {
  from: string;
  to: string;
  streamName?: AuditStreamName;
  eventType?: string;
  resourceType?: string;
  idempotencyKey: string;
}

export interface CoreApi {
  bootstrap(): Promise<CoreBootstrap>;
  createSiweChallenge(walletAddress: string): Promise<SiweChallenge>;
  verifySiwe(message: string, signature: string): Promise<SiweSession>;
  listCatalog(): Promise<readonly CatalogProduct[]>;
  listCatalogCategories(): Promise<readonly CatalogCategory[]>;
  listCatalogTags(): Promise<readonly CatalogTag[]>;
  listMerchantStores(): Promise<readonly MerchantStore[]>;
  listManagedMerchantStores(token: string): Promise<readonly MerchantManagedStore[]>;
  createMerchantStore(input: CreateMerchantStoreRequest, token: string): Promise<MerchantManagedStore>;
  updateMerchantStore(
    storeId: string,
    input: UpdateMerchantStoreRequest,
    token: string,
  ): Promise<MerchantManagedStore>;
  activateMerchantStore(
    storeId: string,
    input: MerchantStoreVersionRequest,
    token: string,
  ): Promise<MerchantManagedStore>;
  closeMerchantStore(
    storeId: string,
    input: MerchantStoreVersionRequest,
    token: string,
  ): Promise<MerchantManagedStore>;
  getMerchantPrinterBinding(storeId: string, token: string): Promise<PrinterBinding | null>;
  createMerchantPrinterBindingChallenge(
    storeId: string,
    input: PrinterBindingChallengeRequest,
    token: string,
  ): Promise<PrinterBindingChallenge>;
  applyMerchantPrinterBinding(
    storeId: string,
    input: ApplyPrinterBindingRequest,
    token: string,
  ): Promise<PrinterBinding>;
  createMerchantWaybillBatch(input: WaybillBatchRequest, token: string): Promise<WaybillBatchResult>;
  listMerchantPrintJobs(token: string, limit?: number): Promise<readonly PrintJob[]>;
  retryMerchantPrintJob(printJobId: string, idempotencyKey: string, token: string): Promise<PrintJob>;
  getMerchantProductSlot(storeId: string, token: string): Promise<ProductSlotProjection>;
  saveMerchantProductSlot(
    storeId: string,
    input: ProductSlotInput,
    token: string,
  ): Promise<ManagedCatalogProduct>;
  createMerchantConcessionPreview(
    productId: string,
    input: ConcessionPreviewRequest,
    token: string,
  ): Promise<MerchantConcessionPreview>;
  submitMerchantProductReview(
    productId: string,
    input: ProductReviewSubmissionRequest,
    token: string,
  ): Promise<ManagedCatalogProduct>;
  delistMerchantProduct(
    productId: string,
    input: CatalogReasonRequest,
    token: string,
  ): Promise<ManagedCatalogProduct>;
  createMediaUploadIntent(
    input: MediaUploadIntentRequest,
    token: string,
    ownerWallet: string,
  ): Promise<MediaUploadIntentProjection>;
  completeMediaUpload(
    uploadIntent: MediaUploadIntentProjection,
    token: string,
  ): Promise<MediaAssetProjection>;
  getMediaReadAccess(
    assetId: string,
    token: string,
    expected?: { resourceType: MediaResourceType; resourceId: string; purpose: MediaPurpose },
  ): Promise<MediaReadAccessProjection>;
  getMerchantProfile(token: string): Promise<MerchantProfile>;
  updateMerchantProfile(input: UpdateMerchantProfileRequest, token: string): Promise<MerchantProfile>;
  listMerchantAuditEntries(token: string, options?: MerchantAuditListOptions): Promise<MerchantAuditList>;
  exportMerchantAuditEntries(input: MerchantAuditExportRequest, token: string): Promise<MerchantAuditExport>;
  exportMerchantOrders(input: MerchantOrderExportRequest, token: string): Promise<MerchantOrderExport>;
  listFulfillmentOrders(token: string, options?: FulfillmentOrderListOptions): Promise<FulfillmentOrderPage>;
  listMerchantTakeoverCases(
    token: string,
    options?: MerchantTakeoverCaseListOptions,
  ): Promise<TakeoverCaseList>;
  getMerchantTakeoverCase(caseId: string, token: string): Promise<TakeoverCaseDetail>;
  getMerchantBusinessDashboard(token: string): Promise<MerchantBusinessDashboard>;
  getOrderFulfillmentTarget(orderId: string, token: string): Promise<FulfillmentTarget>;
  getOrderAllowedActions(orderId: string, token: string): Promise<readonly AllowedAction[]>;
  createOrderTrackingEvidence(
    orderId: string,
    input: TrackingEvidenceRequest,
    token: string,
  ): Promise<EvidenceEnvelopeProjection>;
  createOrderActionEvidence(
    orderId: string,
    input: { action: 'REQUEST_FORCED_RECEIPT'; reasonCode: string; idempotencyKey: string },
    token: string,
  ): Promise<EvidenceEnvelopeProjection>;
  recordShipment(orderId: string, input: ShipmentRequest, token: string): Promise<ShipmentResult>;
  recordShipmentBatch(input: ShipmentBatchRequest, token: string): Promise<ShipmentBatchResult>;
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
  listMerchantReceivableStatements(
    token: string,
    options?: MerchantReceivableStatementListOptions,
  ): Promise<MerchantReceivableStatementPage>;
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
  listPublicCms(token?: string): Promise<readonly CmsPublicItem[]>;
}

export class CoreApiError extends Error {
  readonly code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable';
  readonly correlationId: string | undefined;
  readonly blockingResource: CatalogWriteLock | undefined;
  readonly status: number | undefined;

  constructor(
    code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable',
    message: string,
    correlationId?: string,
    blockingResource?: CatalogWriteLock,
    status?: number,
  ) {
    super(message);
    this.name = 'CoreApiError';
    this.code = code;
    this.correlationId = correlationId;
    this.blockingResource = blockingResource;
    this.status = status;
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
        ...(value.merchantId === undefined
          ? {}
          : { merchantId: string(value.merchantId, 'merchantId') }),
      };
    },

    async listCatalog() {
      const body = await request(normalizedBaseUrl, '/v2/catalog/products');
      const value = record(body, 'catalog response');
      return array(value.products, 'products').map(parseCatalogProduct);
    },

    async listCatalogCategories() {
      const body = await request(normalizedBaseUrl, '/v2/catalog/categories');
      return array(record(body, 'catalog categories response').categories, 'categories')
        .map(parseCatalogCategory);
    },

    async listCatalogTags() {
      const body = await request(normalizedBaseUrl, '/v2/catalog/tags');
      return array(record(body, 'catalog tags response').tags, 'tags').map(parseCatalogTag);
    },

    async listMerchantStores() {
      const body = await request(normalizedBaseUrl, '/v2/stores');
      return array(record(body, 'merchant stores response').stores, 'stores').map(parseMerchantStore);
    },

    async listManagedMerchantStores(token) {
      const body = await request(normalizedBaseUrl, merchantStoreOperations.list, { token });
      return array(record(body, 'managed merchant stores response').stores, 'stores')
        .map(parseMerchantManagedStore);
    },

    async createMerchantStore(input, token) {
      return parseMerchantManagedStore(await request(normalizedBaseUrl, merchantStoreOperations.create, {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async updateMerchantStore(storeId, input, token) {
      const store = parseMerchantManagedStore(await request(
        normalizedBaseUrl,
        operationResourcePath(merchantStoreOperations.update, 'storeId', storeId),
        { method: 'PUT', body: JSON.stringify(input), token },
      ));
      exact(store.storeId, storeId, 'updated storeId');
      return store;
    },

    async activateMerchantStore(storeId, input, token) {
      const store = parseMerchantManagedStore(await request(
        normalizedBaseUrl,
        operationResourcePath(merchantStoreOperations.activate, 'storeId', storeId),
        { method: 'POST', body: JSON.stringify(input), token },
      ));
      exact(store.storeId, storeId, 'activated storeId');
      exact(store.status, 'ACTIVE', 'activated store status');
      return store;
    },

    async closeMerchantStore(storeId, input, token) {
      const store = parseMerchantManagedStore(await request(
        normalizedBaseUrl,
        operationResourcePath(merchantStoreOperations.close, 'storeId', storeId),
        { method: 'POST', body: JSON.stringify(input), token },
      ));
      exact(store.storeId, storeId, 'closed storeId');
      exact(store.status, 'CLOSED', 'closed store status');
      return store;
    },

    async getMerchantPrinterBinding(storeId, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/stores/${encodeURIComponent(storeId)}/printer-binding`,
        { token },
      );
      return body === null ? null : parsePrinterBinding(body, storeId);
    },

    async createMerchantPrinterBindingChallenge(storeId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/stores/${encodeURIComponent(storeId)}/printer-binding/challenge`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      return parsePrinterBindingChallenge(body, storeId, input.provider);
    },

    async applyMerchantPrinterBinding(storeId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/stores/${encodeURIComponent(storeId)}/printer-binding`,
        { method: 'PUT', body: JSON.stringify(input), token },
      );
      return parsePrinterBinding(body, storeId);
    },

    async createMerchantWaybillBatch(input, token) {
      const body = await request(normalizedBaseUrl, '/v2/merchant/waybills/batches', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      });
      return parseWaybillBatchResult(body, input);
    },

    async listMerchantPrintJobs(token, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CoreApiError('InvalidResponse', 'Print job limit must be an integer from 1 to 100.');
      }
      const body = await request(normalizedBaseUrl, `/v2/merchant/print-jobs?limit=${limit}`, { token });
      return array(body, 'print jobs response').map(parsePrintJob);
    },

    async retryMerchantPrintJob(printJobId, idempotencyKey, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/print-jobs/${encodeURIComponent(printJobId)}/retry`,
        { method: 'POST', body: JSON.stringify({ idempotencyKey }), token },
      );
      const job = parsePrintJob(body);
      exact(job.printJobId, printJobId, 'retried print job ID');
      return job;
    },

    async getMerchantProductSlot(storeId, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/stores/${encodeURIComponent(storeId)}/product-slot`,
        { token },
      );
      return parseProductSlot(body, storeId);
    },

    async saveMerchantProductSlot(storeId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/stores/${encodeURIComponent(storeId)}/product-slot`,
        { method: 'PUT', body: JSON.stringify(input), token },
      );
      const product = parseManagedCatalogProduct(body);
      exact(product.storeId, storeId, 'saved product storeId');
      return product;
    },

    async createMerchantConcessionPreview(productId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/products/${encodeURIComponent(productId)}/concession-previews`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      return parseMerchantConcessionPreview(body, productId, input.merchantConcessionBps);
    },

    async submitMerchantProductReview(productId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/products/${encodeURIComponent(productId)}/review-submissions`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      const product = parseManagedCatalogProduct(body);
      exact(product.productId, productId, 'submitted productId');
      exact(product.lifecycleState, 'REVIEW', 'submitted product lifecycleState');
      return product;
    },

    async delistMerchantProduct(productId, input, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/merchant/products/${encodeURIComponent(productId)}/delist`,
        { method: 'POST', body: JSON.stringify(input), token },
      );
      const product = parseManagedCatalogProduct(body);
      exact(product.productId, productId, 'delisted productId');
      exact(product.lifecycleState, 'DELISTED', 'delisted product lifecycleState');
      return product;
    },

    async createMediaUploadIntent(input, token, ownerWallet) {
      const body = await request(normalizedBaseUrl, '/v2/media/upload-intents', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      });
      return parseMediaUploadIntent(body, input, ownerWallet);
    },

    async completeMediaUpload(uploadIntent, token) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/media/upload-intents/${encodeURIComponent(uploadIntent.uploadIntentId)}/complete`,
        { method: 'POST', body: '{}', token },
      );
      return parseMediaAsset(body, uploadIntent);
    },

    async getMediaReadAccess(assetId, token, expected) {
      const body = await request(
        normalizedBaseUrl,
        `/v2/media/assets/${encodeURIComponent(assetId)}/access`,
        { token },
      );
      return parseMediaReadAccess(body, assetId, expected);
    },

    async getMerchantProfile(token) {
      return parseMerchantProfile(await request(normalizedBaseUrl, '/v2/merchant/profile', { token }));
    },

    async updateMerchantProfile(input, token) {
      return parseMerchantProfile(await request(normalizedBaseUrl, '/v2/merchant/profile', {
        method: 'PUT',
        body: JSON.stringify(input),
        token,
      }));
    },

    async listMerchantAuditEntries(token, options = {}) {
      return parseMerchantAuditList(await request(
        normalizedBaseUrl,
        merchantAuditEntriesPath(options),
        { token },
      ));
    },

    async exportMerchantAuditEntries(input, token) {
      return parseMerchantAuditExport(await request(normalizedBaseUrl, '/v2/merchant/audit/exports', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async exportMerchantOrders(input, token) {
      return parseMerchantOrderExport(await request(normalizedBaseUrl, merchantStoreOperations.exportOrders, {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      }));
    },

    async listFulfillmentOrders(token, options = {}) {
      const body = await request(normalizedBaseUrl, fulfillmentOrdersPath(options), { token });
      const value = record(body, 'fulfillment orders response');
      return {
        orders: array(value.orders, 'orders').map(parseFulfillmentOrder),
        nextCursor: value.nextCursor === null ? null : parseFulfillmentOrderCursor(value.nextCursor),
      };
    },

    async listMerchantTakeoverCases(token, options = {}) {
      return parseTakeoverCaseList(await request(
        normalizedBaseUrl,
        merchantTakeoverCasesPath(options),
        { token },
      ));
    },

    async getMerchantTakeoverCase(caseId, token) {
      return parseTakeoverCaseDetail(await request(
        normalizedBaseUrl,
        `/v2/merchant/takeover-cases/${encodeURIComponent(caseId)}`,
        { token },
      ));
    },

    async getMerchantBusinessDashboard(token) {
      return parseMerchantBusinessDashboard(
        await request(normalizedBaseUrl, '/v2/merchant/dashboard', { token }),
      );
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

    async createOrderTrackingEvidence(orderId, input, token) {
      return parseEvidenceEnvelope(await request(
        normalizedBaseUrl,
        `/v2/orders/${encodeURIComponent(orderId)}/tracking-evidence`,
        { method: 'POST', body: JSON.stringify(input), token },
      ), orderId, input.carrierCode);
    },

    async createOrderActionEvidence(orderId, input, token) {
      return parseActionEvidenceEnvelope(await request(
        normalizedBaseUrl,
        `/v2/orders/${encodeURIComponent(orderId)}/evidence`,
        { method: 'POST', body: JSON.stringify(input), token },
      ), orderId, input.action, input.reasonCode);
    },

    async recordShipment(orderId, input, token) {
      const body = await request(normalizedBaseUrl, `/v2/orders/${encodeURIComponent(orderId)}/shipments`, {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      });
      return parseShipmentResult(body, orderId);
    },

    async recordShipmentBatch(input, token) {
      const body = await request(normalizedBaseUrl, '/v2/shipments/batches', {
        method: 'POST',
        body: JSON.stringify(input),
        token,
      });
      return parseShipmentBatchResult(body, input.items.map((item) => item.orderId));
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

    async listMerchantReceivableStatements(token, options = {}) {
      return parseMerchantReceivableStatementPage(await request(
        normalizedBaseUrl,
        merchantReceivableStatementsPath(options),
        { token },
      ));
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

    async listPublicCms(token) {
      return array(
        await request(normalizedBaseUrl, '/v2/cms/public', { ...(token ? { token } : {}) }),
        'public CMS response',
      ).map(parseCmsPublicItem);
    },
  };
}

export async function sha256File(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function putMediaFile(uploadIntent: MediaUploadIntentProjection, file: File) {
  exact(uploadIntent.method, 'PUT', 'media upload method');
  exact(String(file.size), uploadIntent.sizeBytes, 'media upload size');
  exact(file.type, uploadIntent.contentType, 'media upload content type');
  const headers = new Headers(uploadIntent.headers);
  if (!headers.has('content-type')) headers.set('content-type', uploadIntent.contentType);
  let response: Response;
  try {
    response = await fetch(uploadIntent.uploadUrl, {
      method: 'PUT',
      headers,
      body: file,
    });
  } catch {
    throw new CoreApiError('NetworkUnavailable', '媒体文件上传失败，请检查网络后重试。');
  }
  if (!response.ok) {
    throw new CoreApiError('ExternalBlocked', '媒体存储服务拒绝了文件上传。');
  }
}

function operationResourcePath(path: string, parameter: string, value: string) {
  const token = `{${parameter}}`;
  if (!path.includes(token)) throw new Error(`Coordinated OpenAPI path is missing ${token}`);
  return path.replace(token, encodeURIComponent(value));
}

function fulfillmentOrdersPath(options: FulfillmentOrderListOptions) {
  const query = new URLSearchParams();
  if (options.cursor) {
    query.set('cursorCreatedAt', options.cursor.createdAt);
    query.set('cursorOrderId', options.cursor.orderId);
  }
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  if (options.skuId) query.set('skuId', options.skuId);
  if (options.state) query.set('state', options.state);
  if (options.fulfillmentMode) query.set('fulfillmentMode', options.fulfillmentMode);
  if (options.orderKind) query.set('orderKind', options.orderKind);
  const serialized = query.toString();
  return `/v2/orders${serialized ? `?${serialized}` : ''}`;
}

function merchantTakeoverCasesPath(options: MerchantTakeoverCaseListOptions) {
  const query = new URLSearchParams();
  if (options.state) query.set('state', options.state);
  if (options.cursor) {
    query.set('cursorOpenedAt', options.cursor.openedAt);
    query.set('cursorCaseId', options.cursor.caseId);
  }
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const serialized = query.toString();
  return `/v2/merchant/takeover-cases${serialized ? `?${serialized}` : ''}`;
}

function merchantAuditEntriesPath(options: MerchantAuditListOptions) {
  const query = new URLSearchParams();
  if (options.streamName) query.set('streamName', options.streamName);
  if (options.eventType) query.set('eventType', options.eventType);
  if (options.resourceType) query.set('resourceType', options.resourceType);
  if (options.resourceId) query.set('resourceId', options.resourceId);
  if (options.correlationId) query.set('correlationId', options.correlationId);
  if (options.cursor) {
    query.set('cursorCreatedAt', options.cursor.createdAt);
    query.set('cursorEntryId', options.cursor.entryId);
  }
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const serialized = query.toString();
  return `/v2/merchant/audit/entries${serialized ? `?${serialized}` : ''}`;
}

function merchantReceivableStatementsPath(options: MerchantReceivableStatementListOptions) {
  const query = new URLSearchParams();
  if (options.kind) query.set('kind', enumValue(options.kind, orderKindSet, 'receivable statement kind'));
  if (options.cursor) {
    query.set('cursorCreatedAt', dateTime(options.cursor.createdAt, 'receivable statement cursor.createdAt'));
    query.set('cursorOrderId', bytes32(options.cursor.orderId, 'receivable statement cursor.orderId'));
  }
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new CoreApiError('InvalidResponse', 'Receivable statement limit must be an integer from 1 to 100.');
    }
    query.set('limit', String(options.limit));
  }
  const serialized = query.toString();
  return `/v2/merchant/receivable-statements${serialized ? `?${serialized}` : ''}`;
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
  const details = recordOrUndefined(error?.details);
  const blockingResource = details?.blockingResource === undefined
    ? undefined
    : parseCatalogWriteLock(details.blockingResource);
  throw new CoreApiError(code, message, correlationId, blockingResource, response.status);
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
    subtitle: optionalString(value.subtitle, 'subtitle'),
    metadata,
    mainImageAssetIds: array(value.mainImageAssetIds, 'product.mainImageAssetIds')
      .map((assetId) => bytes32(assetId, 'product.mainImageAssetId')),
    videoAssetId: nullableBytes32(value.videoAssetId, 'product.videoAssetId'),
    richDetail: record(value.richDetail, 'product.richDetail'),
    defaultFreightUsdt: atomicAmount(value.defaultFreightUsdt, 'product.defaultFreightUsdt'),
    fulfillmentModes: array(value.fulfillmentModes, 'product.fulfillmentModes')
      .map((mode) => enumValue(mode, fulfillmentModeSet, 'product.fulfillmentMode')),
    categoryId: nullableString(value.categoryId, 'product.categoryId'),
    tagIds: stringArray(value.tagIds, 'product.tagIds'),
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
    seckill: value.seckill === null ? null : parseCatalogSeckillOverlay(value.seckill),
  };
}

function parseCatalogSeckillOverlay(input: unknown): CatalogSeckillOverlay {
  const value = record(input, 'catalog SKU seckill overlay');
  const inventory = record(value.inventory, 'catalog SKU seckill inventory');
  exact(value.ordinaryCheckoutAllowed, false, 'catalog SKU ordinaryCheckoutAllowed');
  return {
    sessionId: bytes32(value.sessionId, 'catalog SKU seckill sessionId'),
    policyVersion: atomicAmount(value.policyVersion, 'catalog SKU seckill policyVersion'),
    phase: enumValue(value.phase, new Set(['PREHEAT', 'LIVE', 'SETTLING']), 'catalog SKU seckill phase'),
    startsAt: dateTime(value.startsAt, 'catalog SKU seckill startsAt'),
    mainDeadline: dateTime(value.mainDeadline, 'catalog SKU seckill mainDeadline'),
    relayDeadline: dateTime(value.relayDeadline, 'catalog SKU seckill relayDeadline'),
    seckillListPriceUsdt: atomicAmount(value.seckillListPriceUsdt, 'catalog SKU seckill price'),
    inventory: {
      total: atomicAmount(inventory.total, 'catalog SKU seckill inventory.total'),
      sold: atomicAmount(inventory.sold, 'catalog SKU seckill inventory.sold'),
      reserved: atomicAmount(inventory.reserved, 'catalog SKU seckill inventory.reserved'),
      available: atomicAmount(inventory.available, 'catalog SKU seckill inventory.available'),
    },
    ordinaryCheckoutAllowed: false,
  };
}

function parseCatalogCategory(input: unknown): CatalogCategory {
  const value = record(input, 'catalog category');
  const serviceFee = record(value.serviceFee, 'category.serviceFee');
  const state = enumValue<'Frozen' | 'DecisionBlocked'>(
    serviceFee.state,
    new Set(['Frozen', 'DecisionBlocked']),
    'category.serviceFee.state',
  );
  const valueBps = serviceFee.valueBps === null ? null : bps(serviceFee.valueBps, 'category.serviceFee.valueBps');
  if ((state === 'Frozen') !== (valueBps !== null)) invalid('category service-fee state and value do not match');
  return {
    categoryId: string(value.categoryId, 'category.categoryId'),
    version: atomicAmount(value.version, 'category.version'),
    parentCategoryId: nullableString(value.parentCategoryId, 'category.parentCategoryId'),
    level: enumNumber<1 | 2 | 3>(value.level, new Set([1, 2, 3]), 'category.level'),
    name: string(value.name, 'category.name'),
    iconAssetId: nullableBytes32(value.iconAssetId, 'category.iconAssetId'),
    sortOrder: nonNegativeInteger(value.sortOrder, 'category.sortOrder'),
    status: enumValue(value.status, catalogTaxonomyStatusSet, 'category.status'),
    serviceFee: { state, valueBps },
  };
}

function parseCatalogTag(input: unknown): CatalogTag {
  const value = record(input, 'catalog tag');
  return {
    tagId: string(value.tagId, 'tag.tagId'),
    version: atomicAmount(value.version, 'tag.version'),
    name: string(value.name, 'tag.name'),
    example: optionalString(value.example, 'tag.example'),
    sortOrder: nonNegativeInteger(value.sortOrder, 'tag.sortOrder'),
    status: enumValue(value.status, catalogTaxonomyStatusSet, 'tag.status'),
  };
}

function parseProductSlot(input: unknown, expectedStoreId: string): ProductSlotProjection {
  const value = record(input, 'merchant product slot');
  exact(value.artifactVersion, artifactVersion, 'product slot artifactVersion');
  const storeId = string(value.storeId, 'product slot storeId');
  exact(storeId, expectedStoreId, 'product slot storeId');
  const merchantId = string(value.merchantId, 'product slot merchantId');
  const product = value.product === null ? null : parseManagedCatalogProduct(value.product);
  if (product) {
    exact(product.storeId, storeId, 'product slot product storeId');
    exact(product.merchantId, merchantId, 'product slot product merchantId');
  }
  return {
    artifactVersion,
    storeId,
    merchantId,
    product,
    allowedActions: parseCatalogProductActions(value.allowedActions, 'product slot allowedActions'),
    writeLock: value.writeLock === null ? null : parseCatalogWriteLock(value.writeLock),
  };
}

function parseManagedCatalogProduct(input: unknown): ManagedCatalogProduct {
  const value = record(input, 'managed catalog product');
  exact(value.artifactVersion, artifactVersion, 'managed product artifactVersion');
  const productId = string(value.productId, 'managed product.productId');
  return {
    artifactVersion,
    productId,
    chainProductId: bytes32(value.chainProductId, 'managed product.chainProductId'),
    merchantId: string(value.merchantId, 'managed product.merchantId'),
    storeId: nullableString(value.storeId, 'managed product.storeId'),
    supersedesProductId: nullableString(value.supersedesProductId, 'managed product.supersedesProductId'),
    version: atomicAmount(value.version, 'managed product.version'),
    title: string(value.title, 'managed product.title'),
    subtitle: optionalString(value.subtitle, 'managed product.subtitle'),
    lifecycleState: enumValue<CatalogProductLifecycleState>(
      value.lifecycleState,
      catalogProductLifecycleSet,
      'managed product.lifecycleState',
    ),
    productPolicyHash: bytes32(value.productPolicyHash, 'managed product.productPolicyHash'),
    merchantConcessionBps: bps(value.merchantConcessionBps, 'managed product.merchantConcessionBps'),
    mainImageAssetIds: array(value.mainImageAssetIds, 'managed product.mainImageAssetIds')
      .map((assetId) => bytes32(assetId, 'managed product.mainImageAssetId')),
    videoAssetId: nullableBytes32(value.videoAssetId, 'managed product.videoAssetId'),
    richDetail: jsonObject(value.richDetail, 'managed product.richDetail'),
    defaultFreightUsdt: atomicAmount(value.defaultFreightUsdt, 'managed product.defaultFreightUsdt'),
    fulfillmentModes: array(value.fulfillmentModes, 'managed product.fulfillmentModes')
      .map((mode) => enumValue(mode, fulfillmentModeSet, 'managed product.fulfillmentMode')),
    categoryId: nullableString(value.categoryId, 'managed product.categoryId'),
    tagIds: stringArray(value.tagIds, 'managed product.tagIds'),
    skus: array(value.skus, 'managed product.skus').map(parseManagedCatalogSku),
    allowedActions: parseCatalogProductActions(value.allowedActions, 'managed product.allowedActions'),
    writeLock: value.writeLock === null ? null : parseCatalogWriteLock(value.writeLock),
    createdAt: dateTime(value.createdAt, 'managed product.createdAt'),
    updatedAt: dateTime(value.updatedAt, 'managed product.updatedAt'),
  };
}

function parseManagedCatalogSku(input: unknown): ManagedCatalogSku {
  const value = record(input, 'managed catalog SKU');
  return {
    skuId: string(value.skuId, 'managed SKU.skuId'),
    chainSkuId: bytes32(value.chainSkuId, 'managed SKU.chainSkuId'),
    version: atomicAmount(value.version, 'managed SKU.version'),
    attributes: jsonObject(value.attributes, 'managed SKU.attributes'),
    listPriceUsdt: atomicAmount(value.listPriceUsdt, 'managed SKU.listPriceUsdt'),
    merchantBaseReceivableUsdt: atomicAmount(
      value.merchantBaseReceivableUsdt,
      'managed SKU.merchantBaseReceivableUsdt',
    ),
    stockTotal: atomicAmount(value.stockTotal, 'managed SKU.stockTotal'),
    stockAvailable: atomicAmount(value.stockAvailable, 'managed SKU.stockAvailable'),
    stockReserved: atomicAmount(value.stockReserved, 'managed SKU.stockReserved'),
    proposedSeckillInventory: atomicAmount(
      value.proposedSeckillInventory,
      'managed SKU.proposedSeckillInventory',
    ),
    lifecycleState: enumValue<CatalogProductLifecycleState>(
      value.lifecycleState,
      catalogProductLifecycleSet,
      'managed SKU.lifecycleState',
    ),
  };
}

function parseCatalogProductActions(input: unknown, name: string) {
  return array(input, name).map((action) => enumValue<CatalogProductAction>(action, catalogProductActionSet, name));
}

function parseCatalogWriteLock(input: unknown): CatalogWriteLock {
  const value = record(input, 'catalog write lock');
  return {
    type: string(value.type, 'writeLock.type'),
    id: string(value.id, 'writeLock.id'),
    state: string(value.state, 'writeLock.state'),
  };
}

function parseMerchantConcessionPreview(
  input: unknown,
  expectedProductId: string,
  expectedConcessionBps: number,
): MerchantConcessionPreview {
  const value = record(input, 'merchant concession preview');
  exact(value.artifactVersion, artifactVersion, 'concession preview artifactVersion');
  const productId = string(value.productId, 'concession preview.productId');
  exact(productId, expectedProductId, 'concession preview.productId');
  const productVersion = atomicAmount(value.productVersion, 'concession preview.productVersion');
  const merchantId = string(value.merchantId, 'concession preview.merchantId');
  const policyVersion = atomicAmount(value.policyVersion, 'concession preview.policyVersion');
  const merchantConcessionBps = bps(value.merchantConcessionBps, 'concession preview.merchantConcessionBps');
  exact(merchantConcessionBps, expectedConcessionBps, 'concession preview.merchantConcessionBps');
  const previewId = bytes32(value.previewId, 'concession preview.previewId');
  const catalogFingerprint = bytes32(value.catalogFingerprint, 'concession preview.catalogFingerprint');
  const destinationSetHash = bytes32(value.destinationSetHash, 'concession preview.destinationSetHash');
  const previewHash = bytes32(value.previewHash, 'concession preview.previewHash');
  const expiresAt = dateTime(value.expiresAt, 'concession preview.expiresAt');
  const payloadValue = record(value.payload, 'concession preview.payload');
  exact(payloadValue.artifactVersion, artifactVersion, 'concession preview payload artifactVersion');
  exact(string(payloadValue.productId, 'concession preview payload.productId'), productId, 'preview payload productId');
  exact(
    String(positiveInteger(payloadValue.productVersion, 'concession preview payload.productVersion')),
    productVersion,
    'preview payload productVersion',
  );
  exact(string(payloadValue.merchantId, 'concession preview payload.merchantId'), merchantId, 'preview payload merchantId');
  exact(
    String(positiveInteger(payloadValue.policyVersion, 'concession preview payload.policyVersion')),
    policyVersion,
    'preview payload policyVersion',
  );
  exact(
    bps(payloadValue.merchantConcessionBps, 'concession preview payload.merchantConcessionBps'),
    merchantConcessionBps,
    'preview payload merchantConcessionBps',
  );
  exact(
    bytes32(payloadValue.destinationSetHash, 'concession preview payload.destinationSetHash'),
    destinationSetHash,
    'preview payload destinationSetHash',
  );
  exact(
    bytes32(payloadValue.catalogFingerprint, 'concession preview payload.catalogFingerprint'),
    catalogFingerprint,
    'preview payload catalogFingerprint',
  );
  exact(dateTime(payloadValue.expiresAt, 'concession preview payload.expiresAt'), expiresAt, 'preview payload expiresAt');
  const items = array(payloadValue.items, 'concession preview payload.items').map((itemInput) => {
    const item = record(itemInput, 'concession preview item');
    const concessionAmount = atomicAmount(item.merchantConcessionAmount, 'preview item.merchantConcessionAmount');
    const allocations = array(item.allocations, 'preview item.allocations').map((allocationInput) => {
      const allocation = record(allocationInput, 'concession allocation');
      exactObjectKeys(allocation, ['pool', 'amount', 'balanceState'], 'concession allocation');
      exact(allocation.balanceState, 'LOCKED', 'concession allocation.balanceState');
      return {
        pool: enumValue<MerchantConcessionAllocation['pool']>(
          allocation.pool,
          merchantConcessionPoolSet,
          'concession allocation.pool',
        ),
        amount: atomicAmount(allocation.amount, 'concession allocation.amount'),
        balanceState: 'LOCKED' as const,
      };
    });
    if (allocations.reduce((total, allocation) => total + BigInt(allocation.amount), 0n) !== BigInt(concessionAmount)) {
      invalid('concession allocation total does not match the authoritative concession amount');
    }
    const base = atomicAmount(item.merchantBaseReceivableUsdt, 'preview item.merchantBaseReceivableUsdt');
    const net = atomicAmount(item.merchantNetReceivableUsdt, 'preview item.merchantNetReceivableUsdt');
    if (BigInt(base) - BigInt(concessionAmount) !== BigInt(net)) {
      invalid('merchant net receivable does not reconcile to the signed preview');
    }
    const itemBps = bps(item.merchantConcessionBps, 'preview item.merchantConcessionBps');
    exact(itemBps, merchantConcessionBps, 'preview item.merchantConcessionBps');
    return {
      skuId: string(item.skuId, 'preview item.skuId'),
      merchantBaseReceivableUsdt: base,
      merchantConcessionBps: itemBps,
      merchantConcessionAmount: concessionAmount,
      merchantNetReceivableUsdt: net,
      allocations,
    };
  });
  if (items.length === 0) invalid('concession preview requires at least one item');
  const payload = {
    artifactVersion,
    productId,
    productVersion: Number(productVersion),
    merchantId,
    policyVersion: Number(policyVersion),
    merchantConcessionBps,
    destinationSetHash,
    catalogFingerprint,
    items,
    expiresAt,
  } as const;
  const authorization = parseCatalogAuthorization(value.authorization, {
    previewId,
    previewHash,
    policyVersion: Number(policyVersion),
    expiresAt,
  });
  return {
    artifactVersion,
    previewId,
    productId,
    productVersion,
    merchantId,
    policyVersion,
    merchantConcessionBps,
    catalogFingerprint,
    destinationSetHash,
    previewHash,
    payload,
    authorization,
    expiresAt,
    createdAt: dateTime(value.createdAt, 'concession preview.createdAt'),
  };
}

function parseCatalogAuthorization(input: unknown, expected: {
  previewId: string;
  previewHash: string;
  policyVersion: number;
  expiresAt: string;
}): MerchantConcessionPreview['authorization'] {
  const value = record(input, 'concession preview authorization');
  const domain = record(value.domain, 'concession authorization.domain');
  exactObjectKeys(domain, ['name', 'version', 'chainId'], 'concession authorization.domain');
  exact(domain.name, 'Abu24KCatalog', 'concession authorization.domain.name');
  exact(domain.version, '2', 'concession authorization.domain.version');
  exact(domain.chainId, 56, 'concession authorization.domain.chainId');
  const types = record(value.types, 'concession authorization.types');
  exactObjectKeys(types, ['MerchantConcessionPreview'], 'concession authorization.types');
  const fields = array(types.MerchantConcessionPreview, 'concession authorization type fields');
  const expectedFields = [
    ['previewHash', 'bytes32'],
    ['previewId', 'bytes32'],
    ['productIdHash', 'bytes32'],
    ['policyVersion', 'uint64'],
    ['expiresAt', 'uint64'],
  ] as const;
  if (fields.length !== expectedFields.length) invalid('concession authorization type fields do not match');
  fields.forEach((field, index) => {
    const parsed = record(field, `concession authorization field ${index}`);
    exactObjectKeys(parsed, ['name', 'type'], `concession authorization field ${index}`);
    exact(parsed.name, expectedFields[index]![0], `concession authorization field ${index} name`);
    exact(parsed.type, expectedFields[index]![1], `concession authorization field ${index} type`);
  });
  exact(value.primaryType, 'MerchantConcessionPreview', 'concession authorization.primaryType');
  const message = record(value.message, 'concession authorization.message');
  exactObjectKeys(
    message,
    ['previewHash', 'previewId', 'productIdHash', 'policyVersion', 'expiresAt'],
    'concession authorization.message',
  );
  exact(bytes32(message.previewHash, 'authorization.message.previewHash'), expected.previewHash, 'authorization previewHash');
  exact(bytes32(message.previewId, 'authorization.message.previewId'), expected.previewId, 'authorization previewId');
  bytes32(message.productIdHash, 'authorization.message.productIdHash');
  exact(message.policyVersion, expected.policyVersion, 'authorization policyVersion');
  exact(
    message.expiresAt,
    Math.floor(new Date(expected.expiresAt).getTime() / 1000),
    'authorization expiresAt',
  );
  const signature = string(value.signature, 'concession authorization.signature');
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) invalid('concession authorization.signature must be hexadecimal');
  return {
    domain,
    types,
    primaryType: 'MerchantConcessionPreview',
    message,
    digest: bytes32(value.digest, 'concession authorization.digest'),
    signature,
    signer: address(value.signer, 'concession authorization.signer'),
  };
}

function parseMediaUploadIntent(
  input: unknown,
  expected: MediaUploadIntentRequest,
  expectedOwnerWallet: string,
): MediaUploadIntentProjection {
  const value = record(input, 'media upload intent');
  exact(value.artifactVersion, artifactVersion, 'media upload artifactVersion');
  exact(address(value.ownerWallet, 'media upload.ownerWallet').toLowerCase(), expectedOwnerWallet.toLowerCase(), 'media upload owner');
  exact(value.purpose, expected.purpose, 'media upload purpose');
  exact(value.resourceType, expected.resourceType, 'media upload resourceType');
  exact(value.resourceId, expected.resourceId, 'media upload resourceId');
  exact(value.contentType, expected.contentType, 'media upload contentType');
  exact(atomicAmount(value.sizeBytes, 'media upload.sizeBytes'), String(expected.sizeBytes), 'media upload sizeBytes');
  exact(bytes32(value.contentSha256, 'media upload.contentSha256').toLowerCase(), expected.contentSha256.toLowerCase(), 'media upload contentSha256');
  exact(value.state, 'UPLOADED', 'media upload state');
  exact(value.method, 'PUT', 'media upload method');
  exact(value.writeOnce, true, 'media upload writeOnce');
  const headersValue = record(value.headers, 'media upload.headers');
  const headers: Record<string, string> = {};
  Object.entries(headersValue).forEach(([name, headerValue]) => {
    headers[name] = string(headerValue, `media upload header ${name}`);
  });
  return {
    artifactVersion,
    uploadIntentId: bytes32(value.uploadIntentId, 'media upload.uploadIntentId'),
    ownerWallet: address(value.ownerWallet, 'media upload.ownerWallet'),
    purpose: enumValue(value.purpose, mediaPurposeSet, 'media upload.purpose'),
    resourceType: enumValue(value.resourceType, mediaResourceTypeSet, 'media upload.resourceType'),
    resourceId: string(value.resourceId, 'media upload.resourceId'),
    contentType: enumValue(value.contentType, mediaContentTypeSet, 'media upload.contentType'),
    sizeBytes: atomicAmount(value.sizeBytes, 'media upload.sizeBytes'),
    contentSha256: bytes32(value.contentSha256, 'media upload.contentSha256'),
    state: 'UPLOADED',
    expiresAt: dateTime(value.expiresAt, 'media upload.expiresAt'),
    method: 'PUT',
    uploadUrl: absoluteUrl(value.uploadUrl, 'media upload.uploadUrl'),
    headers,
    providerReferenceHash: bytes32(value.providerReferenceHash, 'media upload.providerReferenceHash'),
    writeOnce: true,
  };
}

function parseMediaAsset(input: unknown, upload: MediaUploadIntentProjection): MediaAssetProjection {
  const value = record(input, 'media asset');
  exact(value.artifactVersion, artifactVersion, 'media asset artifactVersion');
  exact(value.uploadIntentId, upload.uploadIntentId, 'media asset uploadIntentId');
  exact(address(value.ownerWallet, 'media asset.ownerWallet').toLowerCase(), upload.ownerWallet.toLowerCase(), 'media asset owner');
  exact(value.purpose, upload.purpose, 'media asset purpose');
  exact(value.resourceType, upload.resourceType, 'media asset resourceType');
  exact(value.resourceId, upload.resourceId, 'media asset resourceId');
  exact(value.contentType, upload.contentType, 'media asset contentType');
  exact(value.sizeBytes, upload.sizeBytes, 'media asset sizeBytes');
  exact(bytes32(value.contentSha256, 'media asset.contentSha256').toLowerCase(), upload.contentSha256.toLowerCase(), 'media asset contentSha256');
  return {
    artifactVersion,
    assetId: bytes32(value.assetId, 'media asset.assetId'),
    uploadIntentId: upload.uploadIntentId,
    ownerWallet: address(value.ownerWallet, 'media asset.ownerWallet'),
    purpose: upload.purpose,
    resourceType: upload.resourceType,
    resourceId: upload.resourceId,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    contentSha256: upload.contentSha256,
    providerEvidenceHash: bytes32(value.providerEvidenceHash, 'media asset.providerEvidenceHash'),
    objectVersionHash: bytes32(value.objectVersionHash, 'media asset.objectVersionHash'),
    createdAt: dateTime(value.createdAt, 'media asset.createdAt'),
  };
}

function parseMediaReadAccess(
  input: unknown,
  expectedAssetId: string,
  expected?: { resourceType: MediaResourceType; resourceId: string; purpose: MediaPurpose },
): MediaReadAccessProjection {
  const value = record(input, 'media read access');
  exact(value.artifactVersion, artifactVersion, 'media read artifactVersion');
  const assetId = bytes32(value.assetId, 'media read.assetId');
  exact(assetId, expectedAssetId, 'media read assetId');
  const purpose = enumValue<MediaPurpose>(value.purpose, mediaPurposeSet, 'media read.purpose');
  const resourceType = enumValue<MediaResourceType>(value.resourceType, mediaResourceTypeSet, 'media read.resourceType');
  const resourceId = string(value.resourceId, 'media read.resourceId');
  if (expected) {
    exact(purpose, expected.purpose, 'media read purpose');
    exact(resourceType, expected.resourceType, 'media read resourceType');
    exact(resourceId, expected.resourceId, 'media read resourceId');
  }
  exact(value.method, 'GET', 'media read method');
  return {
    artifactVersion,
    assetId,
    purpose,
    resourceType,
    resourceId,
    contentType: enumValue(value.contentType, mediaContentTypeSet, 'media read.contentType'),
    sizeBytes: atomicAmount(value.sizeBytes, 'media read.sizeBytes'),
    contentSha256: bytes32(value.contentSha256, 'media read.contentSha256'),
    objectVersionHash: bytes32(value.objectVersionHash, 'media read.objectVersionHash'),
    accessScope: enumValue(value.accessScope, new Set(['PUBLIC', 'AUTHENTICATED']), 'media read.accessScope'),
    method: 'GET',
    readUrl: absoluteUrl(value.readUrl, 'media read.readUrl'),
    expiresAt: dateTime(value.expiresAt, 'media read.expiresAt'),
    providerReferenceHash: bytes32(value.providerReferenceHash, 'media read.providerReferenceHash'),
  };
}

function parseMerchantProfile(input: unknown): MerchantProfile {
  const value = record(input, 'merchant profile');
  exactObjectKeys(value, [
    'artifactVersion',
    'merchantId',
    'shopName',
    'logoAssetId',
    'settlementWallet',
    'settlementWalletMutable',
    'version',
    'updatedAt',
  ], 'merchant profile');
  exact(value.artifactVersion, artifactVersion, 'merchant profile artifactVersion');
  exact(value.settlementWalletMutable, false, 'merchant profile settlementWalletMutable');
  return {
    artifactVersion,
    merchantId: string(value.merchantId, 'merchant profile merchantId'),
    shopName: value.shopName === null ? null : string(value.shopName, 'merchant profile shopName'),
    logoAssetId: nullableBytes32(value.logoAssetId, 'merchant profile logoAssetId'),
    settlementWallet: address(value.settlementWallet, 'merchant profile settlementWallet'),
    settlementWalletMutable: false,
    version: positiveInteger(value.version, 'merchant profile version'),
    updatedAt: dateTime(value.updatedAt, 'merchant profile updatedAt'),
  };
}

function parseMerchantAuditList(input: unknown): MerchantAuditList {
  const value = record(input, 'merchant audit list');
  exactObjectKeys(value, ['entries', 'proofScope', 'historyStatus', 'chainProof', 'nextCursor'], 'merchant audit list');
  exact(value.proofScope, 'MERCHANT_SCOPED_ENTRY_HASHES', 'merchant audit proofScope');
  exact(value.historyStatus, 'PARTIAL_PRE_MERCHANT_SCOPE', 'merchant audit historyStatus');
  const entries = array(value.entries, 'merchant audit entries').map(parseMerchantAuditEntry);
  for (let index = 1; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (current && previous && (
      Date.parse(current.operationTime) > Date.parse(previous.operationTime)
      || (current.operationTime === previous.operationTime && current.entryId >= previous.entryId)
    )) invalid('merchant audit entries are not in reverse-time order');
  }
  const proof = record(value.chainProof, 'merchant audit chainProof');
  exactObjectKeys(proof, ['merchantId', 'entries'], 'merchant audit chainProof');
  return {
    entries,
    proofScope: 'MERCHANT_SCOPED_ENTRY_HASHES',
    historyStatus: 'PARTIAL_PRE_MERCHANT_SCOPE',
    chainProof: {
      merchantId: string(proof.merchantId, 'merchant audit chainProof merchantId'),
      entries: nonNegativeInteger(proof.entries, 'merchant audit chainProof entries'),
    },
    nextCursor: value.nextCursor === null ? null : parseMerchantAuditCursor(value.nextCursor),
  };
}

function parseMerchantAuditEntry(input: unknown): MerchantAuditList['entries'][number] {
  const value = record(input, 'merchant audit entry');
  exactObjectKeys(value, [
    'entryId',
    'operationTime',
    'operationType',
    'module',
    'detail',
    'signatureHash',
    'chainTxHash',
    'entryHash',
  ], 'merchant audit entry');
  const entryHash = string(value.entryHash, 'merchant audit entryHash');
  if (!/^[0-9a-f]{64}$/.test(entryHash)) invalid('merchant audit entryHash must be a lowercase hash');
  return {
    entryId: string(value.entryId, 'merchant audit entryId'),
    operationTime: dateTime(value.operationTime, 'merchant audit operationTime'),
    operationType: string(value.operationType, 'merchant audit operationType'),
    module: string(value.module, 'merchant audit module'),
    detail: string(value.detail, 'merchant audit detail'),
    signatureHash: nullableBytes32(value.signatureHash, 'merchant audit signatureHash'),
    chainTxHash: nullableBytes32(value.chainTxHash, 'merchant audit chainTxHash'),
    entryHash,
  };
}

function parseMerchantAuditCursor(input: unknown): NonNullable<MerchantAuditList['nextCursor']> {
  const value = record(input, 'merchant audit cursor');
  exactObjectKeys(value, ['createdAt', 'entryId'], 'merchant audit cursor');
  return {
    createdAt: dateTime(value.createdAt, 'merchant audit cursor createdAt'),
    entryId: string(value.entryId, 'merchant audit cursor entryId'),
  };
}

function parseMerchantAuditExport(input: unknown): MerchantAuditExport {
  const value = record(input, 'merchant audit export');
  exactObjectKeys(value, ['merchantId', 'contentType', 'filename', 'entryCount', 'csv'], 'merchant audit export');
  exact(value.contentType, 'text/csv; charset=utf-8', 'merchant audit export contentType');
  const filename = string(value.filename, 'merchant audit export filename');
  if (/[/\\\r\n]/.test(filename)) invalid('merchant audit export filename is unsafe');
  const entryCount = nonNegativeInteger(value.entryCount, 'merchant audit export entryCount');
  if (entryCount > 1_000) invalid('merchant audit export entryCount exceeds 1000');
  return {
    merchantId: string(value.merchantId, 'merchant audit export merchantId'),
    contentType: 'text/csv; charset=utf-8',
    filename,
    entryCount,
    csv: string(value.csv, 'merchant audit export csv'),
  };
}

function parseMerchantOrderExport(input: unknown): MerchantOrderExport {
  const value = record(input, 'merchant order export');
  exactObjectKeys(value, [
    'artifactVersion',
    'exportId',
    'merchantId',
    'contentType',
    'filename',
    'rowCount',
    'contentHash',
    'contentBase64',
    'nextCursor',
    'filters',
  ], 'merchant order export');
  exact(value.artifactVersion, artifactVersion, 'merchant order export artifactVersion');
  exact(value.contentType, 'application/vnd.ms-excel; charset=utf-8', 'merchant order export contentType');
  const filename = string(value.filename, 'merchant order export filename');
  if (filename.length > 160 || /[/\\\r\n]/.test(filename)) invalid('merchant order export filename is unsafe');
  const rowCount = nonNegativeInteger(value.rowCount, 'merchant order export rowCount');
  if (rowCount > 1_000) invalid('merchant order export rowCount exceeds 1000');
  const filters = record(value.filters, 'merchant order export filters');
  exactObjectKeys(filters, [
    'from',
    'to',
    'skuId',
    'state',
    'fulfillmentMode',
    'orderKind',
    'cursorCreatedAt',
    'cursorOrderId',
    'limit',
  ], 'merchant order export filters');
  const limit = positiveInteger(filters.limit, 'merchant order export filters.limit');
  if (limit > 1_000) invalid('merchant order export filters.limit exceeds 1000');
  const parsedFilters: MerchantOrderExport['filters'] = {
    from: dateTime(filters.from, 'merchant order export filters.from'),
    to: dateTime(filters.to, 'merchant order export filters.to'),
    skuId: nullableString(filters.skuId, 'merchant order export filters.skuId'),
    state: filters.state === null
      ? null
      : enumValue(filters.state, orderStateSet, 'merchant order export filters.state'),
    fulfillmentMode: filters.fulfillmentMode === null
      ? null
      : enumValue(filters.fulfillmentMode, fulfillmentModeSet, 'merchant order export filters.fulfillmentMode'),
    orderKind: filters.orderKind === null
      ? null
      : enumValue(filters.orderKind, orderKindSet, 'merchant order export filters.orderKind'),
    cursorCreatedAt: nullableDateTime(
      filters.cursorCreatedAt,
      'merchant order export filters.cursorCreatedAt',
    ),
    cursorOrderId: nullableString(filters.cursorOrderId, 'merchant order export filters.cursorOrderId'),
    limit,
  };
  if (Date.parse(parsedFilters.from) > Date.parse(parsedFilters.to)) {
    invalid('merchant order export filters date range is reversed');
  }
  if (Date.parse(parsedFilters.to) - Date.parse(parsedFilters.from) > 31 * 24 * 60 * 60 * 1_000) {
    invalid('merchant order export filters date range exceeds 31 days');
  }
  if ((parsedFilters.cursorCreatedAt === null) !== (parsedFilters.cursorOrderId === null)) {
    invalid('merchant order export cursor is incomplete');
  }
  const contentBase64 = base64(value.contentBase64, 'merchant order export contentBase64');
  return {
    artifactVersion,
    exportId: bytes32(value.exportId, 'merchant order export exportId'),
    merchantId: string(value.merchantId, 'merchant order export merchantId'),
    contentType: 'application/vnd.ms-excel; charset=utf-8',
    filename,
    rowCount,
    contentHash: bytes32(value.contentHash, 'merchant order export contentHash'),
    contentBase64,
    nextCursor: value.nextCursor === null
      ? null
      : parseMerchantOrderExportCursor(value.nextCursor),
    filters: parsedFilters,
  };
}

function parseMerchantOrderExportCursor(input: unknown): NonNullable<MerchantOrderExport['nextCursor']> {
  const value = record(input, 'merchant order export cursor');
  exactObjectKeys(value, ['createdAt', 'orderId'], 'merchant order export cursor');
  return {
    createdAt: dateTime(value.createdAt, 'merchant order export cursor.createdAt'),
    orderId: string(value.orderId, 'merchant order export cursor.orderId'),
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
    quantity: atomicAmount(value.quantity, 'order.quantity'),
    createdAt: dateTime(value.createdAt, 'order.createdAt'),
    orderKind: enumValue(value.orderKind, orderKindSet, 'order.orderKind'),
    paymentTxHash: nullableBytes32(value.paymentTxHash, 'order.paymentTxHash'),
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
    allowedActions: array(value.allowedActions, 'order.allowedActions').map(parseAllowedAction),
  };
}

function parseFulfillmentOrderCursor(input: unknown): FulfillmentOrderCursor {
  const value = record(input, 'fulfillment order cursor');
  return {
    createdAt: dateTime(value.createdAt, 'fulfillment order cursor.createdAt'),
    orderId: string(value.orderId, 'fulfillment order cursor.orderId'),
  };
}

function parseFulfillmentExactAmounts(input: unknown): FulfillmentExactAmounts {
  const value = record(input, 'order.exactAmounts');
  return {
    listPriceUsdt: atomicAmount(value.listPriceUsdt, 'exactAmounts.listPriceUsdt'),
    productUsdtPaymentAmount: atomicAmount(value.productUsdtPaymentAmount, 'exactAmounts.productUsdtPaymentAmount'),
    platformServiceFeeUsdt: atomicAmount(value.platformServiceFeeUsdt, 'exactAmounts.platformServiceFeeUsdt'),
    custodyProductUsdt: atomicAmount(value.custodyProductUsdt, 'exactAmounts.custodyProductUsdt'),
    freightUsdt: atomicAmount(value.freightUsdt, 'exactAmounts.freightUsdt'),
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
    trackingNumber: value.trackingNumber === null ? null : string(value.trackingNumber, 'shipment.trackingNumber'),
    trackingNumberHash: bytes32(value.trackingNumberHash, 'shipment.trackingNumberHash'),
    note: value.note === null ? null : string(value.note, 'shipment.note'),
    evidenceHash: bytes32(value.evidenceHash, 'shipment.evidenceHash'),
    mediaAssetIds: array(value.mediaAssetIds, 'shipment.mediaAssetIds').map((assetId) => (
      bytes32(assetId, 'shipment.mediaAssetId')
    )),
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

function parseTakeoverCaseList(input: unknown): TakeoverCaseList {
  const value = record(input, 'merchant takeover case list');
  exactObjectKeys(value, ['artifactVersion', 'cases', 'nextCursor'], 'merchant takeover case list');
  exact(value.artifactVersion, artifactVersion, 'merchant takeover case list artifactVersion');
  return {
    artifactVersion,
    cases: array(value.cases, 'merchant takeover cases').map(parseTakeoverCase),
    nextCursor: value.nextCursor === null ? null : parseTakeoverCaseCursor(value.nextCursor),
  };
}

function parseTakeoverCaseDetail(input: unknown): TakeoverCaseDetail {
  const value = record(input, 'merchant takeover case detail');
  exactObjectKeys(
    value,
    ['artifactVersion', 'case', 'assignments', 'transitions'],
    'merchant takeover case detail',
  );
  exact(value.artifactVersion, artifactVersion, 'merchant takeover case detail artifactVersion');
  const takeover = parseTakeoverCaseWithActions(value.case);
  const assignments = array(value.assignments, 'merchant takeover assignments').map(parseTakeoverAssignment);
  if (
    !takeover.currentAssignment
    || assignments.length !== 1
    || assignments[0]?.assignmentId !== takeover.currentAssignment.assignmentId
  ) invalid('Merchant takeover detail must expose only the current assignment');
  for (const assignment of assignments) assertTakeoverAssignmentScope(takeover, assignment);
  return {
    artifactVersion,
    case: takeover,
    assignments,
    transitions: array(value.transitions, 'merchant takeover transitions').map(parseTakeoverTransition),
  };
}

const takeoverCaseKeys = [
  'caseId',
  'orderId',
  'originalMerchantId',
  'policyVersion',
  'state',
  'requiredUsdt',
  'funding',
  'evidenceHash',
  'openedAt',
  'closedAt',
  'updatedAt',
  'order',
  'currentAssignment',
] as const;

function parseTakeoverCase(input: unknown): TakeoverCase {
  const value = record(input, 'merchant takeover case');
  exactObjectKeys(value, takeoverCaseKeys, 'merchant takeover case');
  return parseTakeoverCaseValue(value);
}

function parseTakeoverCaseWithActions(input: unknown): TakeoverCaseDetail['case'] {
  const value = record(input, 'merchant takeover case detail case');
  exactObjectKeys(value, [...takeoverCaseKeys, 'allowedActions'], 'merchant takeover case detail case');
  return {
    ...parseTakeoverCaseValue(value),
    allowedActions: array(value.allowedActions, 'merchant takeover allowedActions').map(parseAllowedAction),
  };
}

function parseTakeoverCaseValue(value: Record<string, unknown>): TakeoverCase {
  const funding = record(value.funding, 'merchant takeover funding');
  exactObjectKeys(funding, [
    'guaranteeUsedUsdt',
    'frozenReceivablesUsedUsdt',
    'futureProceedsUsedUsdt',
    'platformAdvanceUsdt',
    'disbursedUsdt',
    'merchantDebtUsdt',
  ], 'merchant takeover funding');
  const order = record(value.order, 'merchant takeover order');
  exactObjectKeys(order, [
    'productId',
    'skuId',
    'quantity',
    'fulfillmentMode',
    'fulfillmentTargetHash',
    'state',
    'paymentFinal',
  ], 'merchant takeover order');
  const takeover: TakeoverCase = {
    caseId: string(value.caseId, 'merchant takeover caseId'),
    orderId: string(value.orderId, 'merchant takeover orderId'),
    originalMerchantId: string(value.originalMerchantId, 'merchant takeover originalMerchantId'),
    policyVersion: atomicAmount(value.policyVersion, 'merchant takeover policyVersion'),
    state: enumValue(value.state, takeoverStateSet, 'merchant takeover state'),
    requiredUsdt: nullableAtomicAmount(value.requiredUsdt, 'merchant takeover requiredUsdt'),
    funding: {
      guaranteeUsedUsdt: atomicAmount(funding.guaranteeUsedUsdt, 'merchant takeover guaranteeUsedUsdt'),
      frozenReceivablesUsedUsdt: atomicAmount(
        funding.frozenReceivablesUsedUsdt,
        'merchant takeover frozenReceivablesUsedUsdt',
      ),
      futureProceedsUsedUsdt: atomicAmount(
        funding.futureProceedsUsedUsdt,
        'merchant takeover futureProceedsUsedUsdt',
      ),
      platformAdvanceUsdt: atomicAmount(funding.platformAdvanceUsdt, 'merchant takeover platformAdvanceUsdt'),
      disbursedUsdt: atomicAmount(funding.disbursedUsdt, 'merchant takeover disbursedUsdt'),
      merchantDebtUsdt: atomicAmount(funding.merchantDebtUsdt, 'merchant takeover merchantDebtUsdt'),
    },
    evidenceHash: bytes32(value.evidenceHash, 'merchant takeover evidenceHash'),
    openedAt: dateTime(value.openedAt, 'merchant takeover openedAt'),
    closedAt: nullableDateTime(value.closedAt, 'merchant takeover closedAt'),
    updatedAt: dateTime(value.updatedAt, 'merchant takeover updatedAt'),
    order: {
      productId: string(order.productId, 'merchant takeover productId'),
      skuId: string(order.skuId, 'merchant takeover skuId'),
      quantity: atomicAmount(order.quantity, 'merchant takeover quantity'),
      fulfillmentMode: enumValue(order.fulfillmentMode, fulfillmentModeSet, 'merchant takeover fulfillmentMode'),
      fulfillmentTargetHash: bytes32(order.fulfillmentTargetHash, 'merchant takeover fulfillmentTargetHash'),
      state: enumValue(order.state, orderStateSet, 'merchant takeover order state'),
      paymentFinal: boolean(order.paymentFinal, 'merchant takeover paymentFinal'),
    },
    currentAssignment: value.currentAssignment === null
      ? null
      : parseTakeoverAssignment(value.currentAssignment),
  };
  if (takeover.currentAssignment) assertTakeoverAssignmentScope(takeover, takeover.currentAssignment);
  return takeover;
}

function parseTakeoverAssignment(input: unknown): TakeoverAssignment {
  const value = record(input, 'merchant takeover assignment');
  exactObjectKeys(value, [
    'assignmentId',
    'caseId',
    'orderId',
    'version',
    'originalMerchantId',
    'replacementMerchantId',
    'replacementWallet',
    'replacementApplicationVersion',
    'replacementLicenseAssetId',
    'supersedesAssignmentId',
    'reasonCode',
    'evidenceHash',
    'assignedBy',
    'correlationId',
    'assignedAt',
  ], 'merchant takeover assignment');
  return {
    assignmentId: bytes32(value.assignmentId, 'merchant takeover assignmentId'),
    caseId: string(value.caseId, 'merchant takeover assignment caseId'),
    orderId: string(value.orderId, 'merchant takeover assignment orderId'),
    version: positiveInteger(value.version, 'merchant takeover assignment version'),
    originalMerchantId: string(value.originalMerchantId, 'merchant takeover assignment originalMerchantId'),
    replacementMerchantId: string(
      value.replacementMerchantId,
      'merchant takeover assignment replacementMerchantId',
    ),
    replacementWallet: address(value.replacementWallet, 'merchant takeover assignment replacementWallet'),
    replacementApplicationVersion: positiveInteger(
      value.replacementApplicationVersion,
      'merchant takeover assignment replacementApplicationVersion',
    ),
    replacementLicenseAssetId: bytes32(
      value.replacementLicenseAssetId,
      'merchant takeover assignment replacementLicenseAssetId',
    ),
    supersedesAssignmentId: nullableBytes32(
      value.supersedesAssignmentId,
      'merchant takeover assignment supersedesAssignmentId',
    ),
    reasonCode: string(value.reasonCode, 'merchant takeover assignment reasonCode'),
    evidenceHash: bytes32(value.evidenceHash, 'merchant takeover assignment evidenceHash'),
    assignedBy: address(value.assignedBy, 'merchant takeover assignment assignedBy'),
    correlationId: string(value.correlationId, 'merchant takeover assignment correlationId'),
    assignedAt: dateTime(value.assignedAt, 'merchant takeover assignment assignedAt'),
  };
}

function assertTakeoverAssignmentScope(takeover: TakeoverCase, assignment: TakeoverAssignment) {
  if (
    assignment.caseId !== takeover.caseId
    || assignment.orderId !== takeover.orderId
    || assignment.originalMerchantId !== takeover.originalMerchantId
  ) invalid('Takeover assignment is not bound to its case and order');
}

function parseTakeoverCaseCursor(input: unknown): TakeoverCaseCursor {
  const value = record(input, 'merchant takeover cursor');
  exactObjectKeys(value, ['openedAt', 'caseId'], 'merchant takeover cursor');
  return {
    openedAt: dateTime(value.openedAt, 'merchant takeover cursor openedAt'),
    caseId: string(value.caseId, 'merchant takeover cursor caseId'),
  };
}

function parseTakeoverTransition(input: unknown): TakeoverCaseTransition {
  const value = record(input, 'merchant takeover transition');
  exactObjectKeys(
    value,
    ['transitionId', 'fromState', 'toState', 'evidenceType', 'evidenceHash', 'occurredAt'],
    'merchant takeover transition',
  );
  return {
    transitionId: string(value.transitionId, 'merchant takeover transitionId'),
    fromState: value.fromState === null
      ? null
      : enumValue(value.fromState, takeoverStateSet, 'merchant takeover transition fromState'),
    toState: enumValue(value.toState, takeoverStateSet, 'merchant takeover transition toState'),
    evidenceType: string(value.evidenceType, 'merchant takeover transition evidenceType'),
    evidenceHash: bytes32(value.evidenceHash, 'merchant takeover transition evidenceHash'),
    occurredAt: dateTime(value.occurredAt, 'merchant takeover transition occurredAt'),
  };
}

function parseEvidenceEnvelope(
  input: unknown,
  expectedOrderId: string,
  expectedCarrierCode: LogisticsCarrierCode,
): EvidenceEnvelopeProjection {
  const value = record(input, 'tracking evidence');
  exactObjectKeys(value, [
    'artifactVersion',
    'evidenceHash',
    'ownerWallet',
    'actorRole',
    'purpose',
    'resourceType',
    'resourceId',
    'action',
    'reasonCode',
    'trackingNumberHash',
    'mediaAssetIds',
    'payload',
    'carrierCode',
    'createdAt',
  ], 'tracking evidence');
  exact(value.artifactVersion, artifactVersion, 'tracking evidence artifactVersion');
  exact(value.actorRole, 'MERCHANT', 'tracking evidence actorRole');
  exact(value.purpose, 'SHIPMENT_TRACKING', 'tracking evidence purpose');
  exact(value.resourceType, 'ORDER', 'tracking evidence resourceType');
  exact(value.resourceId, expectedOrderId, 'tracking evidence resourceId');
  exact(value.action, 'RECORD_SHIPMENT', 'tracking evidence action');
  exact(value.reasonCode, null, 'tracking evidence reasonCode');
  exact(value.carrierCode, expectedCarrierCode, 'tracking evidence carrierCode');
  const trackingNumberHash = bytes32(value.trackingNumberHash, 'tracking evidence trackingNumberHash');
  const mediaAssetIds = array(value.mediaAssetIds, 'tracking evidence mediaAssetIds').map((assetId) => (
    bytes32(assetId, 'tracking evidence mediaAssetId')
  ));
  if (mediaAssetIds.length !== 0) invalid('Tracking evidence cannot contain media assets');
  return {
    artifactVersion,
    evidenceHash: bytes32(value.evidenceHash, 'tracking evidence evidenceHash'),
    ownerWallet: address(value.ownerWallet, 'tracking evidence ownerWallet'),
    actorRole: 'MERCHANT',
    purpose: 'SHIPMENT_TRACKING',
    resourceType: 'ORDER',
    resourceId: expectedOrderId,
    action: 'RECORD_SHIPMENT',
    reasonCode: null,
    trackingNumberHash,
    mediaAssetIds,
    payload: jsonObject(value.payload, 'tracking evidence payload'),
    carrierCode: expectedCarrierCode,
    createdAt: dateTime(value.createdAt, 'tracking evidence createdAt'),
  };
}

function parseActionEvidenceEnvelope(
  input: unknown,
  expectedOrderId: string,
  expectedAction: 'REQUEST_FORCED_RECEIPT',
  expectedReasonCode: string,
): EvidenceEnvelopeProjection {
  const value = record(input, 'action evidence');
  exactObjectKeys(value, [
    'artifactVersion', 'evidenceHash', 'ownerWallet', 'actorRole', 'purpose',
    'resourceType', 'resourceId', 'action', 'reasonCode', 'trackingNumberHash',
    'mediaAssetIds', 'payload', 'createdAt',
  ], 'action evidence');
  exact(value.artifactVersion, artifactVersion, 'action evidence artifactVersion');
  exact(value.actorRole, 'MERCHANT', 'action evidence actorRole');
  exact(value.purpose, 'FULFILLMENT_ACTION', 'action evidence purpose');
  exact(value.resourceType, 'ORDER', 'action evidence resourceType');
  exact(value.resourceId, expectedOrderId, 'action evidence resourceId');
  exact(value.action, expectedAction, 'action evidence action');
  exact(value.reasonCode, expectedReasonCode, 'action evidence reasonCode');
  exact(value.trackingNumberHash, null, 'action evidence trackingNumberHash');
  return {
    artifactVersion,
    evidenceHash: bytes32(value.evidenceHash, 'action evidence evidenceHash'),
    ownerWallet: address(value.ownerWallet, 'action evidence ownerWallet'),
    actorRole: 'MERCHANT',
    purpose: 'FULFILLMENT_ACTION',
    resourceType: 'ORDER',
    resourceId: expectedOrderId,
    action: expectedAction,
    reasonCode: expectedReasonCode,
    trackingNumberHash: null,
    mediaAssetIds: array(value.mediaAssetIds, 'action evidence mediaAssetIds').map((assetId) => (
      bytes32(assetId, 'action evidence mediaAssetId')
    )),
    payload: jsonObject(value.payload, 'action evidence payload'),
    createdAt: dateTime(value.createdAt, 'action evidence createdAt'),
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
  const name = string(value.name, 'store.name');
  const longitude = finiteNumber(value.longitude, 'store.longitude');
  const latitude = finiteNumber(value.latitude, 'store.latitude');
  const phone = string(value.phone, 'store.phone');
  const businessHours = optionalString(value.businessHours, 'store.businessHours');
  const imageAssetIds = array(value.imageAssetIds, 'store.imageAssetIds').map((assetId) => (
    bytes32(assetId, 'store.imageAssetId')
  ));
  if (name.length > 100) invalid('store.name exceeds the coordinated maximum length');
  if (longitude < -180 || longitude > 180) invalid('store.longitude is outside the coordinated range');
  if (latitude < -90 || latitude > 90) invalid('store.latitude is outside the coordinated range');
  if (!/^[+]?[0-9-]{7,20}$/.test(phone)) invalid('store.phone does not match the coordinated format');
  if (businessHours.length > 240) invalid('store.businessHours exceeds the coordinated maximum length');
  if (imageAssetIds.length > 5 || new Set(imageAssetIds).size !== imageAssetIds.length) {
    invalid('store.imageAssetIds must contain at most five unique assets');
  }
  return {
    storeId: string(value.storeId, 'store.storeId'),
    merchantId: string(value.merchantId, 'store.merchantId'),
    name,
    regionCode: regionCode(value.regionCode, 'store.regionCode'),
    longitude,
    latitude,
    address: string(value.address, 'store.address'),
    phone,
    businessHours,
    imageAssetIds,
    status: enumValue(value.status, storeStatusSet, 'store.status'),
    version: positiveInteger(value.version, 'store.version'),
  };
}

function parseMerchantManagedStore(input: unknown): MerchantManagedStore {
  const value = record(input, 'managed merchant store');
  exact(value.artifactVersion, artifactVersion, 'managed store artifactVersion');
  const allowedActions = array(value.allowedActions, 'managed store allowedActions').map((inputCapability) => {
    const capability = record(inputCapability, 'managed store capability');
    const action = enumValue(capability.action, merchantStoreActionSet, 'managed store capability action');
    const enabled = boolean(capability.enabled, 'managed store capability enabled');
    if (enabled && capability.reasonCode !== undefined) invalid('Enabled store capability cannot include a reason code');
    if (!enabled && capability.reasonCode === undefined) invalid('Disabled store capability requires a reason code');
    return {
      action: action as MerchantStoreAction,
      enabled,
      ...(!enabled
        ? { reasonCode: enumValue(
            capability.reasonCode,
            merchantStoreActionReasonSet,
            'managed store capability reasonCode',
          ) as MerchantStoreActionReason }
        : {}),
    };
  });
  if (allowedActions.length !== 3 || new Set(allowedActions.map((item) => item.action)).size !== 3) {
    invalid('Managed store must publish each store capability exactly once');
  }
  return {
    artifactVersion,
    ...parseMerchantStore(input),
    allowedActions,
  };
}

function parsePrinterBindingChallenge(
  input: unknown,
  expectedStoreId: string,
  expectedProvider: PrinterBindingChallengeRequest['provider'],
): PrinterBindingChallenge {
  const value = record(input, 'printer binding challenge');
  exact(value.artifactVersion, artifactVersion, 'printer binding challenge artifactVersion');
  const storeId = string(value.storeId, 'printer binding challenge.storeId');
  exact(storeId, expectedStoreId, 'printer binding challenge.storeId');
  const merchantId = string(value.merchantId, 'printer binding challenge.merchantId');
  const signer = address(value.signer, 'printer binding challenge.signer');
  const expiresAt = dateTime(value.expiresAt, 'printer binding challenge.expiresAt');
  const typedData = record(value.typedData, 'printer binding challenge.typedData');
  const domain = record(typedData.domain, 'printer binding challenge.typedData.domain');
  const types = record(typedData.types, 'printer binding challenge.typedData.types');
  const message = record(typedData.message, 'printer binding challenge.typedData.message');
  exactObjectKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'], 'printer binding domain');
  exact(domain.name, 'Abu24KMerchantPrinter', 'printer binding domain.name');
  exact(domain.version, '2', 'printer binding domain.version');
  exact(domain.chainId, 56, 'printer binding domain.chainId');
  address(domain.verifyingContract, 'printer binding domain.verifyingContract');
  exactObjectKeys(types, ['MerchantPrinterBinding'], 'printer binding types');
  const fields = array(types.MerchantPrinterBinding, 'printer binding type fields');
  const expectedFields = [
    ['storeId', 'string'],
    ['merchantId', 'string'],
    ['provider', 'string'],
    ['deviceIdHash', 'bytes32'],
    ['oldValueHash', 'bytes32'],
    ['newValueHash', 'bytes32'],
    ['nonce', 'uint256'],
    ['deadline', 'uint64'],
  ] as const;
  if (fields.length !== expectedFields.length) invalid('printer binding type fields do not match');
  expectedFields.forEach(([name, type], index) => {
    const field = record(fields[index], `printer binding type field ${index}`);
    exactObjectKeys(field, ['name', 'type'], `printer binding type field ${index}`);
    exact(field.name, name, `printer binding type field ${index}.name`);
    exact(field.type, type, `printer binding type field ${index}.type`);
  });
  exact(typedData.primaryType, 'MerchantPrinterBinding', 'printer binding primaryType');
  exactObjectKeys(
    message,
    ['storeId', 'merchantId', 'provider', 'deviceIdHash', 'oldValueHash', 'newValueHash', 'nonce', 'deadline'],
    'printer binding message',
  );
  exact(message.storeId, storeId, 'printer binding message.storeId');
  exact(message.merchantId, merchantId, 'printer binding message.merchantId');
  exact(message.provider, expectedProvider, 'printer binding message.provider');
  bytes32(message.deviceIdHash, 'printer binding message.deviceIdHash');
  bytes32(message.oldValueHash, 'printer binding message.oldValueHash');
  bytes32(message.newValueHash, 'printer binding message.newValueHash');
  atomicAmount(message.nonce, 'printer binding message.nonce');
  const deadline = atomicAmount(message.deadline, 'printer binding message.deadline');
  exact(deadline, String(Math.floor(Date.parse(expiresAt) / 1000)), 'printer binding message.deadline');
  return {
    artifactVersion,
    challengeId: bytes32(value.challengeId, 'printer binding challenge.challengeId'),
    storeId,
    merchantId,
    signer,
    expiresAt,
    typedData: { domain, types, primaryType: 'MerchantPrinterBinding', message },
    digest: bytes32(value.digest, 'printer binding challenge.digest'),
  };
}

function parsePrinterBinding(input: unknown, expectedStoreId: string): PrinterBinding {
  const value = record(input, 'printer binding');
  exact(value.artifactVersion, artifactVersion, 'printer binding artifactVersion');
  const storeId = string(value.storeId, 'printer binding.storeId');
  exact(storeId, expectedStoreId, 'printer binding.storeId');
  const deviceId = string(value.deviceId, 'printer binding.deviceId');
  if (deviceId.length < 3 || deviceId.length > 128) invalid('printer binding.deviceId has invalid length');
  return {
    artifactVersion,
    bindingId: bytes32(value.bindingId, 'printer binding.bindingId'),
    storeId,
    merchantId: string(value.merchantId, 'printer binding.merchantId'),
    provider: enumValue(value.provider, printProviderSet, 'printer binding.provider'),
    deviceId,
    bindingHash: bytes32(value.bindingHash, 'printer binding.bindingHash'),
    version: positiveInteger(value.version, 'printer binding.version'),
    verifiedByWallet: address(value.verifiedByWallet, 'printer binding.verifiedByWallet'),
    signatureHash: bytes32(value.signatureHash, 'printer binding.signatureHash'),
    updatedAt: dateTime(value.updatedAt, 'printer binding.updatedAt'),
  };
}

function parseWaybillBatchResult(input: unknown, expected: WaybillBatchRequest): WaybillBatchResult {
  const value = record(input, 'waybill batch result');
  exact(value.artifactVersion, artifactVersion, 'waybill batch artifactVersion');
  const batchId = bytes32(value.batchId, 'waybill batch.batchId');
  const items = array(value.items, 'waybill batch.items').map((item) => (
    parseWaybillResult(item, { ...expected, batchId })
  ));
  if (items.length !== expected.orderIds.length) invalid('waybill batch item count does not match request');
  const requested = new Set(expected.orderIds);
  if (requested.size !== expected.orderIds.length || items.some((item) => !requested.delete(item.orderId)) || requested.size) {
    invalid('waybill batch order IDs do not match request');
  }
  return { artifactVersion, batchId, items };
}

function parseWaybillResult(
  input: unknown,
  expected: WaybillBatchRequest & { batchId: string },
): WaybillResult {
  const value = record(input, 'waybill result');
  exact(value.artifactVersion, artifactVersion, 'waybill result artifactVersion');
  exact(value.batchId, expected.batchId, 'waybill result.batchId');
  exact(value.storeId, expected.storeId, 'waybill result.storeId');
  exact(value.provider, expected.provider, 'waybill result.provider');
  exact(value.carrierCode, expected.carrierCode, 'waybill result.carrierCode');
  return {
    artifactVersion,
    requestId: bytes32(value.requestId, 'waybill result.requestId'),
    batchId: expected.batchId,
    merchantId: string(value.merchantId, 'waybill result.merchantId'),
    orderId: string(value.orderId, 'waybill result.orderId'),
    storeId: expected.storeId,
    provider: enumValue(value.provider, waybillProviderSet, 'waybill result.provider'),
    carrierCode: enumValue(value.carrierCode, waybillCarrierSet, 'waybill result.carrierCode'),
    state: enumValue(value.state, waybillRequestStateSet, 'waybill result.state'),
    providerReference: nullableString(value.providerReference, 'waybill result.providerReference'),
    trackingNumber: nullableString(value.trackingNumber, 'waybill result.trackingNumber'),
    trackingNumberHash: nullableBytes32(value.trackingNumberHash, 'waybill result.trackingNumberHash'),
    shipmentEvidenceHash: nullableBytes32(value.shipmentEvidenceHash, 'waybill result.shipmentEvidenceHash'),
    printJobId: nullableBytes32(value.printJobId, 'waybill result.printJobId'),
    errorCode: nullableString(value.errorCode, 'waybill result.errorCode'),
    updatedAt: dateTime(value.updatedAt, 'waybill result.updatedAt'),
  };
}

function parsePrintJob(input: unknown): PrintJob {
  const value = record(input, 'print job');
  exact(value.artifactVersion, artifactVersion, 'print job artifactVersion');
  const state = enumValue<PrintJob['state']>(value.state, printJobStateSet, 'print job.state');
  const provider = value.provider === null
    ? null
    : enumValue<NonNullable<PrintJob['provider']>>(value.provider, printProviderSet, 'print job.provider');
  const deviceId = nullableString(value.deviceId, 'print job.deviceId');
  if (state !== 'CONFIGURATION_REQUIRED' && (!provider || !deviceId)) {
    invalid('configured print job is missing provider or device');
  }
  const copyCount = enumNumber<PrintJob['copyCount']>(value.copyCount, new Set([1, 2]), 'print job.copyCount');
  const attempts = nonNegativeInteger(value.attempts, 'print job.attempts');
  if (attempts > 5) invalid('print job.attempts exceeds the published retry bound');
  return {
    artifactVersion,
    printJobId: bytes32(value.printJobId, 'print job.printJobId'),
    merchantId: string(value.merchantId, 'print job.merchantId'),
    orderId: string(value.orderId, 'print job.orderId'),
    storeId: string(value.storeId, 'print job.storeId'),
    jobKind: enumValue(value.jobKind, new Set(['WAYBILL', 'PICKUP_RECEIPT']), 'print job.jobKind'),
    provider,
    deviceId,
    copyCount,
    contentHash: bytes32(value.contentHash, 'print job.contentHash'),
    state,
    attempts,
    providerReference: nullableString(value.providerReference, 'print job.providerReference'),
    errorCode: nullableString(value.errorCode, 'print job.errorCode'),
    nextAttemptAt: nullableDateTime(value.nextAttemptAt, 'print job.nextAttemptAt'),
    createdAt: dateTime(value.createdAt, 'print job.createdAt'),
    updatedAt: dateTime(value.updatedAt, 'print job.updatedAt'),
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

function parseShipmentBatchResult(input: unknown, expectedOrderIds: readonly string[]): ShipmentBatchResult {
  const value = record(input, 'shipment batch result');
  const shipments = array(value.shipments, 'shipment batch result.shipments');
  if (shipments.length !== expectedOrderIds.length) {
    invalid('shipment batch result count does not match the request');
  }
  return {
    batchId: bytes32(value.batchId, 'shipment batch result.batchId'),
    shipments: shipments.map((shipment, index) => parseShipmentResult(shipment, expectedOrderIds[index]!)),
    createdAt: dateTime(value.createdAt, 'shipment batch result.createdAt'),
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
    intent.executorWallet.toLowerCase(),
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
    ['executorWallet', 'address'],
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
        backingWalletAddress: address(item.backingWalletAddress, 'settlement intent item.backingWalletAddress'),
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
    executorWallet: address(value.executorWallet, 'settlement intent.executorWallet'),
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

function parseMerchantReceivableStatementPage(input: unknown): MerchantReceivableStatementPage {
  const value = record(input, 'merchant receivable statement page');
  exactObjectKeys(
    value,
    ['artifactVersion', 'merchantId', 'settlementWallet', 'statements', 'nextCursor'],
    'merchant receivable statement page',
  );
  exact(value.artifactVersion, artifactVersion, 'merchant receivable statement page artifactVersion');
  return {
    artifactVersion,
    merchantId: string(value.merchantId, 'merchant receivable statement page merchantId'),
    settlementWallet: address(value.settlementWallet, 'merchant receivable statement page settlementWallet'),
    statements: array(value.statements, 'merchant receivable statements').map(parseMerchantReceivableStatement),
    nextCursor: value.nextCursor === null ? null : parseOrderStatementCursor(value.nextCursor),
  };
}

function parseOrderStatementCursor(input: unknown): OrderStatementCursor {
  const value = record(input, 'order statement cursor');
  exactObjectKeys(value, ['createdAt', 'orderId'], 'order statement cursor');
  return {
    createdAt: dateTime(value.createdAt, 'order statement cursor.createdAt'),
    orderId: bytes32(value.orderId, 'order statement cursor.orderId'),
  };
}

function parseMerchantReceivableStatement(input: unknown): MerchantReceivableStatement {
  const value = record(input, 'merchant receivable statement');
  exactObjectKeys(value, [
    'orderId', 'productId', 'skuId', 'quantity', 'orderState', 'paymentTxHash',
    'paymentFinalizedAt', 'fulfilledAt', 'createdAt', 'orderKind', 'frozenAmounts',
    'currentReceivableUsdt', 'removedFromReceivableUsdt', 'receivableLifecycle',
    'journalEvidence', 'settlementRefs',
  ], 'merchant receivable statement');
  const frozenAmounts = record(value.frozenAmounts, 'merchant receivable frozen amounts');
  exactObjectKeys(frozenAmounts, [
    'listPriceUsdt', 'productUsdtPaymentAmount', 'platformServiceFeeUsdt', 'custodyProductUsdt',
    'freightUsdt', 'buyerPaidUsdt', 'merchantBaseReceivableUsdt', 'merchantConcessionAmount',
    'merchantNetReceivableUsdt',
  ], 'merchant receivable frozen amounts');
  return {
    orderId: bytes32(value.orderId, 'merchant receivable orderId'),
    productId: string(value.productId, 'merchant receivable productId'),
    skuId: string(value.skuId, 'merchant receivable skuId'),
    quantity: positiveAtomicAmount(value.quantity, 'merchant receivable quantity'),
    orderState: enumValue(value.orderState, orderStateSet, 'merchant receivable orderState'),
    paymentTxHash: bytes32(value.paymentTxHash, 'merchant receivable paymentTxHash'),
    paymentFinalizedAt: dateTime(value.paymentFinalizedAt, 'merchant receivable paymentFinalizedAt'),
    fulfilledAt: nullableDateTime(value.fulfilledAt, 'merchant receivable fulfilledAt'),
    createdAt: dateTime(value.createdAt, 'merchant receivable createdAt'),
    orderKind: enumValue(value.orderKind, orderKindSet, 'merchant receivable orderKind'),
    frozenAmounts: {
      listPriceUsdt: atomicAmount(frozenAmounts.listPriceUsdt, 'merchant receivable listPriceUsdt'),
      productUsdtPaymentAmount: atomicAmount(
        frozenAmounts.productUsdtPaymentAmount,
        'merchant receivable productUsdtPaymentAmount',
      ),
      platformServiceFeeUsdt: atomicAmount(
        frozenAmounts.platformServiceFeeUsdt,
        'merchant receivable platformServiceFeeUsdt',
      ),
      custodyProductUsdt: atomicAmount(
        frozenAmounts.custodyProductUsdt,
        'merchant receivable custodyProductUsdt',
      ),
      freightUsdt: atomicAmount(frozenAmounts.freightUsdt, 'merchant receivable freightUsdt'),
      buyerPaidUsdt: atomicAmount(frozenAmounts.buyerPaidUsdt, 'merchant receivable buyerPaidUsdt'),
      merchantBaseReceivableUsdt: atomicAmount(
        frozenAmounts.merchantBaseReceivableUsdt,
        'merchant receivable merchantBaseReceivableUsdt',
      ),
      merchantConcessionAmount: atomicAmount(
        frozenAmounts.merchantConcessionAmount,
        'merchant receivable merchantConcessionAmount',
      ),
      merchantNetReceivableUsdt: atomicAmount(
        frozenAmounts.merchantNetReceivableUsdt,
        'merchant receivable merchantNetReceivableUsdt',
      ),
    },
    currentReceivableUsdt: atomicAmount(value.currentReceivableUsdt, 'merchant receivable currentReceivableUsdt'),
    removedFromReceivableUsdt: atomicAmount(
      value.removedFromReceivableUsdt,
      'merchant receivable removedFromReceivableUsdt',
    ),
    receivableLifecycle: array(value.receivableLifecycle, 'merchant receivable lifecycle').map((entry) => {
      const lifecycle = record(entry, 'merchant receivable lifecycle entry');
      exactObjectKeys(lifecycle, ['state', 'amount', 'journalIds'], 'merchant receivable lifecycle entry');
      return {
        state: enumValue(lifecycle.state, balanceStateSet, 'merchant receivable lifecycle state'),
        amount: atomicAmount(lifecycle.amount, 'merchant receivable lifecycle amount'),
        journalIds: stringArray(lifecycle.journalIds, 'merchant receivable lifecycle journalIds'),
      };
    }),
    journalEvidence: array(value.journalEvidence, 'merchant receivable journal evidence').map((entry) => {
      const evidence = record(entry, 'merchant receivable journal evidence entry');
      exactObjectKeys(
        evidence,
        ['journalId', 'eventType', 'state', 'delta', 'sourceKind', 'sourceReferenceHash', 'createdAt'],
        'merchant receivable journal evidence entry',
      );
      return {
        journalId: string(evidence.journalId, 'merchant receivable journalId'),
        eventType: string(evidence.eventType, 'merchant receivable eventType'),
        state: enumValue(evidence.state, balanceStateSet, 'merchant receivable journal state'),
        delta: signedAtomicAmount(evidence.delta, 'merchant receivable journal delta'),
        sourceKind: string(evidence.sourceKind, 'merchant receivable journal sourceKind'),
        sourceReferenceHash: bytes32(
          evidence.sourceReferenceHash,
          'merchant receivable journal sourceReferenceHash',
        ),
        createdAt: dateTime(evidence.createdAt, 'merchant receivable journal createdAt'),
      };
    }),
    settlementRefs: array(value.settlementRefs, 'merchant receivable settlement refs').map((entry) => {
      const reference = record(entry, 'merchant receivable settlement ref');
      exactObjectKeys(reference, [
        'requestId', 'amount', 'state', 'transferId', 'finalExecutionTxHash',
        'journals', 'requestedAt', 'submittedAt', 'settledAt',
      ], 'merchant receivable settlement ref');
      const journals = record(reference.journals, 'merchant receivable settlement journals');
      exactObjectKeys(journals, ['requested', 'submitted', 'settled'], 'merchant receivable settlement journals');
      return {
        requestId: bytes32(reference.requestId, 'merchant receivable settlement requestId'),
        amount: positiveAtomicAmount(reference.amount, 'merchant receivable settlement amount'),
        state: enumValue(reference.state, settlementRequestStateSet, 'merchant receivable settlement state'),
        transferId: nullableBytes32(reference.transferId, 'merchant receivable settlement transferId'),
        finalExecutionTxHash: nullableBytes32(
          reference.finalExecutionTxHash,
          'merchant receivable settlement finalExecutionTxHash',
        ),
        journals: {
          requested: string(journals.requested, 'merchant receivable settlement requested journal'),
          submitted: nullableString(journals.submitted, 'merchant receivable settlement submitted journal'),
          settled: nullableString(journals.settled, 'merchant receivable settlement settled journal'),
        },
        requestedAt: dateTime(reference.requestedAt, 'merchant receivable settlement requestedAt'),
        submittedAt: nullableDateTime(reference.submittedAt, 'merchant receivable settlement submittedAt'),
        settledAt: nullableDateTime(reference.settledAt, 'merchant receivable settlement settledAt'),
      };
    }),
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
    executor_wallet: address(value.executor_wallet, 'settlement request.executor_wallet'),
    amount: positiveAtomicAmount(value.amount, 'settlement request.amount'),
    items_hash: bytes32(value.items_hash, 'settlement request.items_hash'),
    intent_digest: bytes32(value.intent_digest, 'settlement request.intent_digest'),
    signature_hash: bytes32(value.signature_hash, 'settlement request.signature_hash'),
    state: enumValue(value.state, settlementRequestStateSet, 'settlement request.state'),
    transfer_ids: array(value.transfer_ids, 'settlement request.transfer_ids').map((transferId) => (
      bytes32(transferId, 'settlement request.transfer_id')
    )),
    final_execution_tx_hashes: array(
      value.final_execution_tx_hashes,
      'settlement request.final_execution_tx_hashes',
    ).map((txHash) => bytes32(txHash, 'settlement request.final_execution_tx_hash')),
    requested_at: dateTime(value.requested_at, 'settlement request.requested_at'),
    submitted_at: nullableDateTime(value.submitted_at, 'settlement request.submitted_at'),
    settled_at: nullableDateTime(value.settled_at, 'settlement request.settled_at'),
    items: array(value.items, 'settlement request.items').map((inputItem) => {
      const item = record(inputItem, 'settlement request item');
      return {
        item_index: nonNegativeInteger(item.item_index, 'settlement request item.item_index'),
        order_id: string(item.order_id, 'settlement request item.order_id'),
        account_id: string(item.account_id, 'settlement request item.account_id'),
        backing_wallet_address: address(
          item.backing_wallet_address,
          'settlement request item.backing_wallet_address',
        ),
        amount: atomicAmount(item.amount, 'settlement request item.amount'),
        requested_journal_id: string(item.requested_journal_id, 'settlement request item.requested_journal_id'),
        submitted_journal_id: nullableString(
          item.submitted_journal_id,
          'settlement request item.submitted_journal_id',
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
        transfer_id: nullableString(transition.transfer_id, 'settlement transition.transfer_id'),
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

function parseMerchantBusinessDashboard(input: unknown): MerchantBusinessDashboard {
  const value = record(input, 'merchant business dashboard');
  exactObjectKeys(value, [
    'artifactVersion', 'timezone', 'window', 'merchant', 'product', 'orders',
    'sales', 'shipmentRate', 'settlements',
  ], 'merchant business dashboard');
  exact(value.artifactVersion, artifactVersion, 'merchant dashboard artifactVersion');
  exact(value.timezone, 'Asia/Shanghai', 'merchant dashboard timezone');

  const window = record(value.window, 'merchant dashboard window');
  exactObjectKeys(window, ['start', 'end', 'generatedAt'], 'merchant dashboard window');
  const merchant = record(value.merchant, 'merchant dashboard merchant');
  exactObjectKeys(merchant, ['merchantId', 'status', 'guaranteeStatus'], 'merchant dashboard merchant');
  const orders = record(value.orders, 'merchant dashboard orders');
  exactObjectKeys(orders, [
    'finalizedToday', 'pendingShipment', 'shipped', 'delivered', 'fulfilled',
    'arbitration', 'takeover', 'pickupVerifiedToday',
  ], 'merchant dashboard orders');
  const sales = record(value.sales, 'merchant dashboard sales');
  exactObjectKeys(sales, [
    'listPriceUsdt', 'buyerUsdtPaid', 'merchantBaseReceivableUsdt',
    'merchantNetReceivableUsdt',
  ], 'merchant dashboard sales');
  const shipmentRate = record(value.shipmentRate, 'merchant dashboard shipmentRate');
  exactObjectKeys(shipmentRate, ['numerator', 'denominator', 'bps'], 'merchant dashboard shipmentRate');
  const settlements = record(value.settlements, 'merchant dashboard settlements');
  exactObjectKeys(settlements, [
    'requestedCount', 'requestedUsdt', 'settledCount', 'settledUsdt',
  ], 'merchant dashboard settlements');

  let product: MerchantBusinessDashboard['product'] = null;
  if (value.product !== null) {
    const productValue = record(value.product, 'merchant dashboard product');
    exactObjectKeys(
      productValue,
      ['productId', 'title', 'state', 'stock', 'seckill', 'updatedAt'],
      'merchant dashboard product',
    );
    const stock = record(productValue.stock, 'merchant dashboard product stock');
    exactObjectKeys(stock, ['total', 'available', 'reserved'], 'merchant dashboard product stock');
    let seckill: NonNullable<MerchantBusinessDashboard['product']>['seckill'] = null;
    if (productValue.seckill !== null) {
      const seckillValue = record(productValue.seckill, 'merchant dashboard product seckill');
      exactObjectKeys(seckillValue, ['sessionId', 'phase'], 'merchant dashboard product seckill');
      seckill = {
        sessionId: bytes32(seckillValue.sessionId, 'merchant dashboard product seckill.sessionId'),
        phase: enumValue(seckillValue.phase, seckillStateSet, 'merchant dashboard product seckill.phase'),
      };
    }
    product = {
      productId: string(productValue.productId, 'merchant dashboard product.productId'),
      title: string(productValue.title, 'merchant dashboard product.title'),
      state: enumValue(productValue.state, catalogProductLifecycleSet, 'merchant dashboard product.state'),
      stock: {
        total: atomicAmount(stock.total, 'merchant dashboard product stock.total'),
        available: atomicAmount(stock.available, 'merchant dashboard product stock.available'),
        reserved: atomicAmount(stock.reserved, 'merchant dashboard product stock.reserved'),
      },
      seckill,
      updatedAt: dateTime(productValue.updatedAt, 'merchant dashboard product.updatedAt'),
    };
  }

  return {
    artifactVersion,
    timezone: 'Asia/Shanghai',
    window: {
      start: dateTime(window.start, 'merchant dashboard window.start'),
      end: dateTime(window.end, 'merchant dashboard window.end'),
      generatedAt: dateTime(window.generatedAt, 'merchant dashboard window.generatedAt'),
    },
    merchant: {
      merchantId: string(merchant.merchantId, 'merchant dashboard merchant.merchantId'),
      status: string(merchant.status, 'merchant dashboard merchant.status'),
      guaranteeStatus: enumValue(
        merchant.guaranteeStatus,
        guaranteeStatusSet,
        'merchant dashboard merchant.guaranteeStatus',
      ),
    },
    product,
    orders: {
      finalizedToday: atomicAmount(orders.finalizedToday, 'merchant dashboard orders.finalizedToday'),
      pendingShipment: atomicAmount(orders.pendingShipment, 'merchant dashboard orders.pendingShipment'),
      shipped: atomicAmount(orders.shipped, 'merchant dashboard orders.shipped'),
      delivered: atomicAmount(orders.delivered, 'merchant dashboard orders.delivered'),
      fulfilled: atomicAmount(orders.fulfilled, 'merchant dashboard orders.fulfilled'),
      arbitration: atomicAmount(orders.arbitration, 'merchant dashboard orders.arbitration'),
      takeover: atomicAmount(orders.takeover, 'merchant dashboard orders.takeover'),
      pickupVerifiedToday: atomicAmount(
        orders.pickupVerifiedToday,
        'merchant dashboard orders.pickupVerifiedToday',
      ),
    },
    sales: {
      listPriceUsdt: atomicAmount(sales.listPriceUsdt, 'merchant dashboard sales.listPriceUsdt'),
      buyerUsdtPaid: atomicAmount(sales.buyerUsdtPaid, 'merchant dashboard sales.buyerUsdtPaid'),
      merchantBaseReceivableUsdt: atomicAmount(
        sales.merchantBaseReceivableUsdt,
        'merchant dashboard sales.merchantBaseReceivableUsdt',
      ),
      merchantNetReceivableUsdt: atomicAmount(
        sales.merchantNetReceivableUsdt,
        'merchant dashboard sales.merchantNetReceivableUsdt',
      ),
    },
    shipmentRate: {
      numerator: atomicAmount(shipmentRate.numerator, 'merchant dashboard shipmentRate.numerator'),
      denominator: atomicAmount(shipmentRate.denominator, 'merchant dashboard shipmentRate.denominator'),
      bps: nullableAtomicAmount(shipmentRate.bps, 'merchant dashboard shipmentRate.bps'),
    },
    settlements: {
      requestedCount: atomicAmount(settlements.requestedCount, 'merchant dashboard settlements.requestedCount'),
      requestedUsdt: atomicAmount(settlements.requestedUsdt, 'merchant dashboard settlements.requestedUsdt'),
      settledCount: atomicAmount(settlements.settledCount, 'merchant dashboard settlements.settledCount'),
      settledUsdt: atomicAmount(settlements.settledUsdt, 'merchant dashboard settlements.settledUsdt'),
    },
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
    operationsWalletAddress: address(value.operationsWalletAddress, 'guarantee deposit.operationsWalletAddress'),
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
  const settlementEligibility = record(
    value.settlementEligibility,
    'merchant finance.settlementEligibility',
  );
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
      backing_wallet_address: address(guarantee.backing_wallet_address, 'merchant guarantee.backing_wallet_address'),
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
        operations_wallet_address: address(
          deposit.operations_wallet_address,
          'merchant guarantee deposit.operations_wallet_address',
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
    allowedActions: array(value.allowedActions, 'merchant finance.allowedActions').map((action) => (
      enumValue(action, merchantFinanceActionSet, 'merchant finance.allowedActions item')
    )),
    settlementEligibility: {
      mode: enumValue(
        settlementEligibility.mode,
        merchantSettlementEligibilityModeSet,
        'merchant finance.settlementEligibility.mode',
      ),
      expiresAt: nullableDateTime(
        settlementEligibility.expiresAt,
        'merchant finance.settlementEligibility.expiresAt',
      ),
    },
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

function optionalString(input: unknown, name: string) {
  if (typeof input !== 'string') invalid(`${name} must be a string`);
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

function enumNumber<T extends number>(input: unknown, allowed: ReadonlySet<number>, name: string): T {
  if (typeof input !== 'number' || !allowed.has(input)) invalid(`${name} contains an unknown enum value`);
  return input as T;
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

function signedAtomicAmount(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^(0|-?[1-9][0-9]*)$/.test(value)) invalid(`${name} must be a canonical signed integer string`);
  return value;
}

function base64(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalid(`${name} must be canonical base64`);
  }
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

function bps(input: unknown, name: string) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > 10_000) {
    invalid(`${name} must be an integer from 0 to 10000`);
  }
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

function absoluteUrl(input: unknown, name: string) {
  const value = string(input, name);
  try {
    new URL(value);
  } catch {
    invalid(`${name} must be an absolute URL`);
  }
  return value;
}

function jsonObject(input: unknown, name: string): JsonObject {
  const value = record(input, name);
  const output: Record<string, JsonObject[string]> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = jsonValue(entry, `${name}.${key}`);
  return output;
}

function jsonValue(input: unknown, name: string): JsonObject[string] {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return input.map((entry, index) => jsonValue(entry, `${name}[${index}]`));
  if (typeof input === 'object') return jsonObject(input, name);
  invalid(`${name} is not a JSON value`);
}

function invalid(message: string): never {
  throw new CoreApiError('InvalidResponse', message);
}

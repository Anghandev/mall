import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createSiweChallenge,
  issueSessionToken,
  normalizeAddress,
  requireRole,
  verifySessionToken,
  verifySiwe,
  type NonceRateLimiter,
  type NonceStore,
} from './auth.ts';
import { orderAllowedActions, type ActionContext, type OrderProjection } from './allowed-actions.ts';
import type { CoreConfig, RuntimeReadinessSnapshot } from './config.ts';
import { publicReadiness } from './config.ts';
import {
  CORE_ARTIFACT_VERSION,
  adminExportFormats,
  adminResourceTypes,
  auditStreamNames,
  breakerScopes,
  cmsContentFormats,
  cmsContentTypes,
  executableOrderActionNames,
  merchantLifecycleStatuses,
  merchantReviewActions,
  notificationCampaignTopics,
  notificationChannels,
  notificationProviders,
  orderProjectionStates,
  settlementTransferStates,
  settlementRails,
  settlementRequestStates,
  systemConfigKeys,
  takeoverStates,
  type AdminExportFormat,
  type AdminResourceType,
  type BreakerScope,
  type CatalogReviewDecision,
  type SettlementTransferState,
  type SettlementRail,
  type SettlementRequestState,
  type TakeoverState,
  type UserRole,
} from './enums.ts';
import { CoreError, errorBody } from './errors.ts';
import type { CreateOrdinaryQuoteInput, CreateSeckillQuoteInput } from '../data/catalog-payment-service.ts';
import type { ProductSlotInput } from '../data/catalog-management-service.ts';
import type {
  AdminExportInput,
  AdminGlobalSearchQuery,
} from '../data/admin-global-operations-service.ts';
import type {
  ArbitrationDecisionInput,
  DecisionInput,
  FulfillmentActor,
  FulfillmentCommandInput,
  FulfillmentRequestDecisionInput,
  LogisticsUpdateInput,
  OrderKind,
  OrderPageQuery,
  PickupCredentialInput,
  PickupVerificationInput,
  RequestInput,
  ShipmentBatchInput,
  ShipmentInput,
} from '../data/fulfillment-service.ts';
import type {
  DeliveryTargetInput,
  MerchantOrderExportInput,
  MerchantOrderExportResult,
  PickupTargetInput,
  StoreInput,
  StoreProfileInput,
  StoreVersionInput,
} from '../data/fulfillment-target-service.ts';
import type {
  AdminSettlementTransferQuery,
  AdminSettlementRequestQuery,
  GovernedSettlementApprovalInput,
  GovernedSettlementRail,
} from '../data/settlement-service.ts';
import type { ConfigApprovalInput } from '../data/system-config-service.ts';
import type { TakeoverAssignmentInput, TakeoverCaseQuery } from '../data/takeover-case-service.ts';
import type { OrderStatementQuery } from '../data/order-statement-service.ts';
import type { AuditQuery } from '../data/audit-service.ts';
import type {
  BuyerAddressInput,
  BuyerProfileUpdate,
  MerchantProfileUpdate,
} from '../data/account-service.ts';
import type { RiskObservationInput, RiskSubjectType } from '../data/risk-service.ts';
import type {
  CarrierConfigInput,
  ProviderConfigInput,
  WarehouseInput,
  WarehouseUpdateInput,
} from '../data/logistics-admin-service.ts';
import type {
  Carrier,
  EvidenceAction,
  MediaPurpose,
  MediaResourceType,
} from '../data/evidence-service.ts';
import { verifyWebhookHmac } from './providers.ts';
import { attachRealtimeServer, type RealtimeEventPage } from './realtime.ts';

const PRODUCT_SLOT_KEYS = [
  'idempotencyKey',
  'title',
  'subtitle',
  'mainImageAssetIds',
  'videoAssetId',
  'richDetail',
  'defaultFreightUsdt',
  'merchantConcessionBps',
  'fulfillmentModes',
  'categoryId',
  'tagIds',
  'skus',
] as const;

export interface PaymentApiService {
  listCatalog(buyerWallet?: string): Promise<unknown>;
  getProduct(productId: string, buyerWallet?: string): Promise<unknown>;
  createOrdinaryQuote(buyerWallet: string, input: CreateOrdinaryQuoteInput): Promise<unknown>;
  createSeckillQuote(buyerWallet: string, input: CreateSeckillQuoteInput): Promise<unknown>;
  submitPayment(
    buyerWallet: string,
    input: { orderId: string; txHash: string; replacementForTxHash?: string },
  ): Promise<unknown>;
  recoverPayment(
    actor: FulfillmentActor,
    input: { orderId: string; txHash: string; replacementForTxHash?: string },
  ): Promise<unknown>;
  getPayment(buyerWallet: string, orderId: string): Promise<unknown>;
  getAdminPayment(actor: FulfillmentActor, orderId: string): Promise<unknown>;
}

export interface PaymentWriteContext {
  buyerWallet: string;
  productId: string;
  quantity: number;
}

export interface SeckillApiService {
  current(): Promise<unknown>;
  get(sessionId: string): Promise<unknown>;
  history(input?: { cursor?: string; limit?: number }): Promise<unknown>;
  events(sessionId: string, input?: { cursor?: string; limit?: number }): Promise<RealtimeEventPage>;
}

export interface SeckillOperationsApiService {
  list(actor: FulfillmentActor): Promise<unknown>;
  get(actor: FulfillmentActor, actionId: string): Promise<unknown>;
  listPrizeReorgExposures(actor: FulfillmentActor): Promise<unknown>;
  getPrizeReorgExposure(actor: FulfillmentActor, exposureId: string): Promise<unknown>;
  createSession(actor: FulfillmentActor, input: {
    policyVersion: string;
    rulesContentHash: string;
    productId: string;
    skuId: string;
    inventory: number;
    seckillListPriceUsdt: string;
    startsAt: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  createForceClose(actor: FulfillmentActor, sessionId: string, input: {
    reasonCode: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  createResume(actor: FulfillmentActor, input: {
    sessionId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  createPrizeInjection(actor: FulfillmentActor, sessionId: string, input: {
    amountUsdt: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  reviewWinner(actor: FulfillmentActor, sessionId: string, input: {
    decision: 'APPROVE' | 'REJECT';
    reasonCode: string;
    evidenceHash: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  prizeRecoveryChallenge(actor: FulfillmentActor, exposureId: string, input: {
    nonce: string;
    deadline: string;
  }): Promise<unknown>;
  submitPrizeRecovery(actor: FulfillmentActor, exposureId: string, input: {
    snapshotId: string;
    nonce: string;
    deadline: string;
    signature: string;
    correlationId: string;
  }): Promise<unknown>;
  approvalChallenge(actor: FulfillmentActor, actionId: string, input: {
    nonce: string;
    deadline: string;
  }): Promise<unknown>;
  submitApproval(actor: FulfillmentActor, actionId: string, input: {
    nonce: string;
    deadline: string;
    signature: string;
    correlationId: string;
  }): Promise<unknown>;
  execute(actor: FulfillmentActor, actionId: string, correlationId: string): Promise<unknown>;
  cancel(actor: FulfillmentActor, actionId: string, input: { correlationId: string }): Promise<unknown>;
}

export interface CatalogManagementApiService {
  listCategories(includeInactive?: boolean, actor?: FulfillmentActor): Promise<unknown>;
  listTags(includeInactive?: boolean, actor?: FulfillmentActor): Promise<unknown>;
  upsertCategory(actor: FulfillmentActor, input: {
    categoryId?: string;
    parentCategoryId?: string | null;
    name: string;
    iconAssetId?: string;
    sortOrder: number;
    serviceFeeBps?: number;
    status?: 'ENABLED' | 'DISABLED' | 'DELETED';
    idempotencyKey: string;
  }): Promise<unknown>;
  upsertTag(actor: FulfillmentActor, input: {
    tagId?: string;
    name: string;
    example?: string;
    sortOrder: number;
    status?: 'ENABLED' | 'DISABLED' | 'DELETED';
    idempotencyKey: string;
  }): Promise<unknown>;
  getProductSlot(actor: FulfillmentActor, storeId: string, targetMerchantId?: string): Promise<unknown>;
  saveProductSlot(
    actor: FulfillmentActor,
    storeId: string,
    input: ProductSlotInput,
    targetMerchantId?: string,
  ): Promise<unknown>;
  createConcessionPreview(actor: FulfillmentActor, productId: string, input: {
    merchantConcessionBps: number;
    idempotencyKey: string;
  }): Promise<unknown>;
  submitReview(actor: FulfillmentActor, productId: string, input: {
    previewId: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  decideReview(actor: FulfillmentActor, productId: string, input: {
    decision: 'APPROVE' | 'REJECT' | 'PUBLISH' | 'HIDE' | 'DELIST';
    reasonCode: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  delistProduct(actor: FulfillmentActor, productId: string, input: {
    reasonCode: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  adjustInventory(actor: FulfillmentActor, skuId: string, input: {
    delta: string;
    reasonCode: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  listAdminProducts(actor: FulfillmentActor): Promise<unknown>;
  batchAddProductTags(actor: FulfillmentActor, input: {
    productIds: string[];
    tagIds: string[];
    idempotencyKey: string;
  }): Promise<unknown>;
  batchProductLifecycle(actor: FulfillmentActor, input: {
    action: CatalogReviewDecision;
    productIds: string[];
    reasonCode: string;
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface AdminGlobalOperationsApiService {
  search(actor: FulfillmentActor, input?: AdminGlobalSearchQuery): Promise<unknown>;
  exportSelection(actor: FulfillmentActor, input: AdminExportInput): Promise<unknown>;
}

export interface FulfillmentApiService {
  getOrder(actor: FulfillmentActor, orderId: string): Promise<unknown>;
  listOrders(actor: FulfillmentActor): Promise<unknown>;
  listOrderPage(actor: FulfillmentActor, input?: OrderPageQuery): Promise<unknown>;
  searchAdminOrders(actor: FulfillmentActor, input?: OrderPageQuery): Promise<unknown>;
  previewOrderBatchActions(actor: FulfillmentActor, orderIds: string[]): Promise<unknown>;
  recordShipment(actor: FulfillmentActor, orderId: string, input: ShipmentInput): Promise<unknown>;
  recordShipmentBatch(actor: FulfillmentActor, input: ShipmentBatchInput): Promise<unknown>;
  recordDelivery(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput): Promise<unknown>;
  recordLogisticsUpdate(actor: FulfillmentActor, orderId: string, input: LogisticsUpdateInput): Promise<unknown>;
  registerPickupCredential(actor: FulfillmentActor, orderId: string, input: PickupCredentialInput): Promise<unknown>;
  verifyPickup(
    actor: FulfillmentActor,
    orderId: string,
    input: PickupVerificationInput,
  ): Promise<unknown>;
  requestExchange(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  requestDelay(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideFulfillmentRequest(
    actor: FulfillmentActor,
    orderId: string,
    input: FulfillmentRequestDecisionInput,
  ): Promise<unknown>;
  openArbitration(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideArbitration(actor: FulfillmentActor, orderId: string, input: ArbitrationDecisionInput): Promise<unknown>;
  openTakeover(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  requestForcedReceipt(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideForcedReceipt(actor: FulfillmentActor, orderId: string, input: DecisionInput): Promise<unknown>;
  confirmReceipt(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput): Promise<unknown>;
}

export interface OrderStatementApiService {
  listBuyerShopping(actor: FulfillmentActor, input?: OrderStatementQuery): Promise<unknown>;
  listMerchantReceivables(actor: FulfillmentActor, input?: OrderStatementQuery): Promise<unknown>;
}

export interface FulfillmentTargetApiService {
  createDeliveryTarget(actor: FulfillmentActor, input: DeliveryTargetInput): Promise<unknown>;
  createPickupTarget(actor: FulfillmentActor, input: PickupTargetInput): Promise<unknown>;
  createStore(actor: FulfillmentActor, input: StoreInput): Promise<unknown>;
  listStores(regionCode?: string, productId?: string): Promise<unknown>;
  listMerchantStores(actor: FulfillmentActor): Promise<unknown>;
  updateStore(actor: FulfillmentActor, storeId: string, input: StoreProfileInput): Promise<unknown>;
  activateStore(actor: FulfillmentActor, storeId: string, input: StoreVersionInput): Promise<unknown>;
  closeStore(actor: FulfillmentActor, storeId: string, input: StoreVersionInput): Promise<unknown>;
  exportMerchantOrders(actor: FulfillmentActor, input: MerchantOrderExportInput): Promise<MerchantOrderExportResult>;
  getOrderTarget(actor: FulfillmentActor, orderId: string): Promise<unknown>;
}

export interface LogisticsPrintingApiService {
  createPrinterBindingChallenge(actor: FulfillmentActor, storeId: string, input: {
    provider: 'FEIE' | 'YILIANYUN';
    deviceId: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  applyPrinterBinding(actor: FulfillmentActor, storeId: string, input: {
    challengeId: string;
    signature: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  getPrinterBinding(actor: FulfillmentActor, storeId: string): Promise<unknown>;
  createWaybillBatch(actor: FulfillmentActor, input: {
    provider: 'KUAIDI100' | 'CAINIAO';
    carrierCode: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
    storeId: string;
    orderIds: string[];
    idempotencyKey: string;
  }): Promise<unknown>;
  listPrintJobs(actor: FulfillmentActor, limit?: number): Promise<unknown>;
  retryPrintJob(actor: FulfillmentActor, printJobId: string, idempotencyKey: string): Promise<unknown>;
  createAdminWaybillBatch(actor: FulfillmentActor, input: {
    merchantId: string;
    provider: 'KUAIDI100' | 'CAINIAO';
    carrierCode: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
    storeId: string;
    orderIds: string[];
    idempotencyKey: string;
  }): Promise<unknown>;
  listAdminWaybills(actor: FulfillmentActor, input?: { merchantId?: string; limit?: number }): Promise<unknown>;
  listAdminPrintJobs(actor: FulfillmentActor, input?: { merchantId?: string; limit?: number }): Promise<unknown>;
  retryAdminPrintJob(actor: FulfillmentActor, printJobId: string, idempotencyKey: string): Promise<unknown>;
}

export interface LogisticsAdminApiService {
  listCarrierConfig(actor: FulfillmentActor): Promise<unknown>;
  createCarrierConfigVersion(actor: FulfillmentActor, input: CarrierConfigInput): Promise<unknown>;
  listProviderConfigs(actor: FulfillmentActor): Promise<unknown>;
  createProviderConfigVersion(actor: FulfillmentActor, input: ProviderConfigInput): Promise<unknown>;
  listWarehouses(actor: FulfillmentActor): Promise<unknown>;
  createWarehouse(actor: FulfillmentActor, input: WarehouseInput): Promise<unknown>;
  updateWarehouse(actor: FulfillmentActor, warehouseId: string, input: WarehouseUpdateInput): Promise<unknown>;
  deactivateWarehouse(actor: FulfillmentActor, warehouseId: string, input: {
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<unknown>;
}

export interface EvidenceApiService {
  createActionEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    action: EvidenceAction;
    reasonCode: string;
    mediaAssetIds?: string[];
    idempotencyKey: string;
  }): Promise<unknown>;
  createTrackingEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumber: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  assertActionEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    action: EvidenceAction;
    evidenceHash: string;
    reasonCode?: string;
  }): Promise<unknown>;
  assertTrackingEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumberHash: string;
    evidenceHash: string;
  }): Promise<unknown>;
  createUploadIntent(actor: FulfillmentActor, input: {
    purpose: MediaPurpose;
    resourceType: MediaResourceType;
    resourceId: string;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'application/pdf';
    sizeBytes: number;
    contentSha256: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  completeUpload(actor: FulfillmentActor, uploadIntentId: string): Promise<unknown>;
  createReadAccess(actor: FulfillmentActor | undefined, assetId: string): Promise<unknown>;
}

export interface SettlementApiService {
  createIntent(
    actor: FulfillmentActor,
    input: { rail: SettlementRail; amount: string; idempotencyKey: string; correlationId: string },
  ): Promise<unknown>;
  createGovernedIntent(
    actor: FulfillmentActor,
    input: {
      rail: GovernedSettlementRail;
      resourceId: string;
      orderId: string;
      accountId: string;
      recipient: string;
      fulfillmentTargetHash?: string;
      amount: string;
      idempotencyKey: string;
      correlationId: string;
      approval: GovernedSettlementApprovalInput;
    },
  ): Promise<unknown>;
  submitRequest(
    actor: FulfillmentActor,
    input: { intentId: string; signature: string; correlationId: string },
  ): Promise<unknown>;
  list(actor: FulfillmentActor): Promise<unknown>;
  listAdminRequests(actor: FulfillmentActor, input?: AdminSettlementRequestQuery): Promise<unknown>;
  getAdminRequest(actor: FulfillmentActor, requestId: string): Promise<unknown>;
  listAdminTransfers(actor: FulfillmentActor, input?: AdminSettlementTransferQuery): Promise<unknown>;
  getAdminTransfer(actor: FulfillmentActor, transferId: string): Promise<unknown>;
}

export interface TakeoverFundingApiService {
  fundingApprovalChallenge(
    actor: FulfillmentActor,
    input: { caseId: string; requiredUsdt: string; nonce: string; deadline: string },
  ): Promise<unknown>;
  fundTakeover(
    actor: FulfillmentActor,
    input: {
      caseId: string;
      requiredUsdt: string;
      idempotencyKey: string;
      correlationId: string;
      approval: ConfigApprovalInput;
    },
  ): Promise<unknown>;
  getMerchantFinance(actor: FulfillmentActor, merchantId?: string): Promise<unknown>;
  getTakeoverFunding(actor: FulfillmentActor, caseId: string): Promise<unknown>;
}

export interface TakeoverCaseApiService {
  listAdmin(actor: FulfillmentActor, input?: TakeoverCaseQuery): Promise<unknown>;
  getAdmin(actor: FulfillmentActor, caseId: string): Promise<unknown>;
  listCandidates(actor: FulfillmentActor, caseId: string): Promise<unknown>;
  assign(actor: FulfillmentActor, caseId: string, input: TakeoverAssignmentInput): Promise<unknown>;
  listMerchant(actor: FulfillmentActor, input?: TakeoverCaseQuery): Promise<unknown>;
  getMerchant(actor: FulfillmentActor, caseId: string): Promise<unknown>;
}

export interface GuaranteeDepositApiService {
  submit(actor: FulfillmentActor, input: {
    policyVersion: string;
    expectedAmountUsdt: string;
    transactionHash: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
}

export interface PolicyApiService {
  createDraft(actor: FulfillmentActor, input: { payload: unknown; idempotencyKey: string; correlationId: string }): Promise<unknown>;
  updateDraft(actor: FulfillmentActor, draftId: string, input: { payload: unknown; correlationId: string }): Promise<unknown>;
  approvalChallenge(actor: FulfillmentActor, draftId: string, input: { nonce: string; deadline: string }): Promise<unknown>;
  submitSecondarySignature(
    actor: FulfillmentActor,
    draftId: string,
    input: { nonce: string; deadline: string; signature: string; correlationId: string },
  ): Promise<unknown>;
  execute(actor: FulfillmentActor, draftId: string, correlationId: string): Promise<unknown>;
  getDraft(actor: FulfillmentActor, draftId: string): Promise<unknown>;
  listDrafts(actor: FulfillmentActor): Promise<unknown>;
}

export interface CoverageBreakerApiService {
  resumeChallenge(actor: FulfillmentActor, input: { nonce: string; deadline: string }): Promise<unknown>;
  submitResume(
    actor: FulfillmentActor,
    input: { snapshotId: string; nonce: string; deadline: string; signature: string; correlationId: string },
  ): Promise<unknown>;
  listActions(actor: FulfillmentActor): Promise<unknown>;
}

export interface CmsApiService {
  createVersion(actor: FulfillmentActor, input: {
    entryId?: string;
    slug: string;
    contentType:
      | 'BANNER' | 'RECOMMENDATION' | 'SPLASH' | 'CAMPAIGN_POPUP' | 'SECKILL_RULES'
      | 'FAQ' | 'SERVICE_AGREEMENT' | 'PRIVACY' | 'ABOUT' | 'RELEASE_ANNOUNCEMENT'
      | 'UPDATE_NOTICE' | 'CONTRACT_NOTICE';
    placement: string;
    locale: string;
    contentFormat: 'STRUCTURED_RICH_TEXT' | 'STRUCTURED_CAMPAIGN';
    content: unknown;
    audience: unknown;
    startsAt?: string;
    endsAt?: string;
    frequencyCap?: number;
    policyVersion?: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  publish(actor: FulfillmentActor, versionId: string, input: { evidenceHash: string; correlationId: string }): Promise<unknown>;
  rollback(actor: FulfillmentActor, versionId: string, input: { evidenceHash: string; correlationId: string }): Promise<unknown>;
  getVersion(actor: FulfillmentActor, versionId: string): Promise<unknown>;
  listPublished(context?: { actor?: FulfillmentActor; now?: Date }): Promise<unknown>;
}

export interface NotificationApiService {
  registerEndpoint(actor: FulfillmentActor, input: {
    channel: 'IN_APP' | 'SMS' | 'EMAIL' | 'PUSH';
    provider: 'CORE' | 'ALIYUN_SMS' | 'TENCENT_SMS' | 'SMTP' | 'FIREBASE' | 'JPUSH';
    endpointReference: string;
    topics: string[];
    regionCode?: string;
    correlationId: string;
  }): Promise<unknown>;
  createCampaign(actor: FulfillmentActor, input: {
    topic: 'ANNOUNCEMENT' | 'MAINTENANCE' | 'ACTIVITY';
    audience: unknown;
    message: unknown;
    cmsVersionId?: string;
    startsAt?: string;
    endsAt?: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  publishCampaign(actor: FulfillmentActor, campaignId: string, input: { evidenceHash: string; correlationId: string }): Promise<unknown>;
  listCampaigns(actor: FulfillmentActor, limit?: number): Promise<unknown>;
  retryCampaignDeliveries(actor: FulfillmentActor, campaignId: string, input: { correlationId: string }): Promise<unknown>;
  listInbox(actor: FulfillmentActor, limit?: number): Promise<unknown>;
}

export interface SystemConfigApiService {
  createVersion(actor: FulfillmentActor, input: {
    configKey: 'BUSINESS' | 'RPC' | 'NPL_QUOTE' | 'GAS' | 'CHAIN' | 'INTEGRATIONS';
    payload: unknown;
    effectiveFrom: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  approvalChallenge(actor: FulfillmentActor, configVersionId: string, input: { nonce: string; deadline: string }): Promise<unknown>;
  publish(actor: FulfillmentActor, configVersionId: string, approval: ConfigApprovalInput): Promise<unknown>;
  list(actor: FulfillmentActor): Promise<unknown>;
}

export interface AuditApiService {
  list(actor: FulfillmentActor, query: AuditQuery): Promise<unknown>;
  listMerchant(actor: FulfillmentActor, query: Omit<AuditQuery, 'actorWallet' | 'merchantId'>): Promise<unknown>;
  exportMerchant(
    actor: FulfillmentActor,
    query: Omit<AuditQuery, 'actorWallet' | 'merchantId' | 'limit'>,
  ): Promise<{ contentType: string; filename: string; entryCount: number; csv: string }>;
}

export interface MonitoringApiService {
  dashboard(actor: FulfillmentActor): Promise<unknown>;
  acknowledge(actor: FulfillmentActor, alertKey: string, correlationId: string): Promise<unknown>;
}

export interface BusinessAnalyticsApiService {
  merchantDashboard(actor: FulfillmentActor): Promise<unknown>;
  adminDashboard(actor: FulfillmentActor): Promise<unknown>;
}

export interface AccountApiService {
  ensureBuyerUid(walletAddress: string): Promise<string>;
  getBuyerProfile(actor: FulfillmentActor): Promise<unknown>;
  updateBuyerProfile(actor: FulfillmentActor, input: BuyerProfileUpdate): Promise<unknown>;
  parseBuyerAddress(actor: FulfillmentActor, rawText: string): Promise<unknown>;
  listBuyerAddresses(actor: FulfillmentActor): Promise<unknown>;
  createBuyerAddress(actor: FulfillmentActor, input: BuyerAddressInput): Promise<unknown>;
  updateBuyerAddress(actor: FulfillmentActor, addressId: string, input: BuyerAddressInput): Promise<unknown>;
  deleteBuyerAddress(
    actor: FulfillmentActor,
    addressId: string,
    input: { expectedVersion: number; idempotencyKey: string },
  ): Promise<unknown>;
  setDefaultBuyerAddress(
    actor: FulfillmentActor,
    addressId: string,
    input: { expectedVersion: number; idempotencyKey: string },
  ): Promise<unknown>;
  createBuyerAddressTarget(actor: FulfillmentActor, addressId: string, idempotencyKey: string): Promise<unknown>;
  getBuyerOverview(actor: FulfillmentActor): Promise<unknown>;
  getBuyerTakeoverTimeline(actor: FulfillmentActor, orderId: string): Promise<unknown>;
  getMerchantProfile(actor: FulfillmentActor): Promise<unknown>;
  updateMerchantProfile(actor: FulfillmentActor, input: MerchantProfileUpdate): Promise<unknown>;
  recordMerchantAuditExport(actor: FulfillmentActor, input: {
    from: Date;
    to: Date;
    entryCount: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  recordMerchantOrderExport(actor: FulfillmentActor, input: {
    exportId: string;
    contentHash: string;
    rowCount: number;
    filters: Record<string, unknown>;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
}

export interface RiskApiService {
  ingestObservation(input: RiskObservationInput, correlationId: string): Promise<unknown>;
  listOverview(actor: FulfillmentActor): Promise<unknown>;
  createManualRestriction(actor: FulfillmentActor, input: {
    subjectType: RiskSubjectType;
    subjectValue: string;
    restrictionKind: 'NEW_PAYMENT' | 'BLACKLIST';
    reasonCode: string;
    evidenceHash: string;
    expiresAt?: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  overrideRestriction(actor: FulfillmentActor, restrictionId: string, input: {
    reasonCode: string;
    evidenceHash: string;
    correlationId: string;
  }): Promise<unknown>;
  submitAppeal(actor: FulfillmentActor, input: {
    restrictionId: string;
    statementHash: string;
    evidenceHash: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  decideAppeal(actor: FulfillmentActor, appealId: string, input: {
    decision: 'APPROVE' | 'REJECT';
    reasonCode: string;
    evidenceHash: string;
    correlationId: string;
  }): Promise<unknown>;
}

export interface MerchantLifecycleApiService {
  list(actor: FulfillmentActor, query: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'BLACKLISTED';
    search?: string;
    limit?: number;
    cursorCreatedAt?: Date;
    cursorMerchantId?: string;
  }): Promise<unknown>;
  get(actor: FulfillmentActor, merchantId: string): Promise<unknown>;
  createApplication(actor: FulfillmentActor, input: {
    shopName: string;
    legalName: string;
    legalId: string;
    contactPhone: string;
    settlementWallet: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  createPublicApplication(walletAddress: string, input: {
    shopName: string;
    legalName: string;
    legalId: string;
    contactPhone: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  updateApplication(actor: FulfillmentActor, merchantId: string, input: {
    shopName: string;
    legalName: string;
    legalId: string;
    contactPhone: string;
    licenseAssetId: string | null;
    expectedVersion: number;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  createReviewChallenge(actor: FulfillmentActor, merchantId: string, input: {
    action: 'APPROVE' | 'REJECT' | 'BLACKLIST';
    reasonCode: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<unknown>;
  publishReview(actor: FulfillmentActor, merchantId: string, actionId: string, signature: string): Promise<unknown>;
}

export interface ApiDependencies {
  config: CoreConfig;
  runtimeReadiness?: RuntimeReadinessSnapshot | (() => RuntimeReadinessSnapshot | undefined);
  nonceStore: NonceStore;
  nonceRateLimiter: NonceRateLimiter;
  authDomain: string;
  authUri: string;
  resolveRoles(walletAddress: string): Promise<{ roles: readonly UserRole[]; merchantId?: string }>;
  getOrderProjection(orderId: string): Promise<OrderProjection | undefined>;
  getPausedScopes(): Promise<ActionContext['pausedScopes']>;
  paymentService: PaymentApiService;
  catalogManagementService: CatalogManagementApiService;
  adminGlobalOperationsService: AdminGlobalOperationsApiService;
  seckillService: SeckillApiService;
  seckillOperationsService: SeckillOperationsApiService;
  fulfillmentService: FulfillmentApiService;
  orderStatementService: OrderStatementApiService;
  fulfillmentTargetService: FulfillmentTargetApiService;
  logisticsPrintingService: LogisticsPrintingApiService;
  logisticsAdminService: LogisticsAdminApiService;
  evidenceService: EvidenceApiService;
  settlementService: SettlementApiService;
  takeoverFundingService: TakeoverFundingApiService;
  takeoverCaseService: TakeoverCaseApiService;
  guaranteeDepositService: GuaranteeDepositApiService;
  policyService: PolicyApiService;
  coverageBreakerService: CoverageBreakerApiService;
  cmsService: CmsApiService;
  notificationService: NotificationApiService;
  systemConfigService: SystemConfigApiService;
  auditService: AuditApiService;
  monitoringService: MonitoringApiService;
  businessAnalyticsService: BusinessAnalyticsApiService;
  accountService: AccountApiService;
  riskService: RiskApiService;
  merchantLifecycleService: MerchantLifecycleApiService;
  riskSignalToken?: string;
  recordRuntimeMetric?(kind: 'HTTP' | 'PAYMENT' | 'FULFILLMENT', durationMs: number, error: boolean, at: Date): void;
  logisticsWebhookSecrets?: Readonly<Partial<Record<'KUAIDI100' | 'CAINIAO', string>>>;
  clock(): Date;
}

export function createApiServer(dependencies: ApiDependencies) {
  const server = createServer(async (request, response) => {
    const correlationId = request.headers['x-correlation-id']?.toString() ?? randomUUID();
    const startedAt = performance.now();
    response.once('finish', () => {
      const duration = performance.now() - startedAt;
      const error = response.statusCode >= 500;
      dependencies.recordRuntimeMetric?.('HTTP', duration, error, dependencies.clock());
      const domain = runtimeMetricKind(request.url ?? '/');
      if (domain) dependencies.recordRuntimeMetric?.(domain, duration, error, dependencies.clock());
    });
    try {
      await route(dependencies, request, response, correlationId);
    } catch (error) {
      if (!(error instanceof CoreError)) {
        console.error(JSON.stringify({
          event: 'core_unexpected_error',
          correlationId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          source: unexpectedErrorSource(error),
        }));
      }
      const result = errorBody(error, correlationId);
      sendJson(response, result.status, result.body, correlationId);
    }
  });
  attachRealtimeServer(server, dependencies.seckillService);
  return server;
}

function unexpectedErrorSource(error: unknown) {
  if (!(error instanceof Error) || !error.stack) return 'unknown';
  return error.stack.split('\n').find((line) => line.includes('/app/'))?.trim() ?? 'unknown';
}

async function route(
  dependencies: ApiDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/v2/bootstrap') {
    sendJson(
      response,
      200,
      {
        artifactVersion: CORE_ARTIFACT_VERSION,
        status: 'CORE_API_READY',
        readiness: publicReadiness(dependencies.config, currentRuntimeReadiness(dependencies), dependencies.clock()),
      },
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/internal/risk/observations') {
    requireInternalRiskToken(request, dependencies.riskSignalToken);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'observationId', 'signalType', 'sourceType', 'walletAddress', 'ipHash', 'deviceHash',
      'resourceId', 'txHash', 'gasPriceWei', 'evidenceHash', 'observedAt',
    ]);
    sendJson(response, 202, await dependencies.riskService.ingestObservation({
      observationId: requiredString(body, 'observationId'),
      signalType: riskSignalType(body.signalType),
      sourceType: riskSourceType(body.sourceType),
      walletAddress: requiredString(body, 'walletAddress'),
      ...(body.ipHash === undefined ? {} : { ipHash: requiredString(body, 'ipHash') }),
      ...(body.deviceHash === undefined ? {} : { deviceHash: requiredString(body, 'deviceHash') }),
      ...(body.resourceId === undefined ? {} : { resourceId: requiredString(body, 'resourceId') }),
      ...(body.txHash === undefined ? {} : { txHash: requiredString(body, 'txHash') }),
      ...(body.gasPriceWei === undefined ? {} : { gasPriceWei: requiredString(body, 'gasPriceWei') }),
      evidenceHash: requiredString(body, 'evidenceHash'),
      observedAt: requiredString(body, 'observedAt'),
    }, correlationId), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/seckill/sessions/current') {
    sendJson(response, 200, await dependencies.seckillService.current(), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/seckill/sessions/history') {
    sendJson(response, 200, await dependencies.seckillService.history({
      ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      ...(url.searchParams.get('limit')
        ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
        : {}),
    }), correlationId);
    return;
  }
  const seckillEvents = url.pathname.match(/^\/v2\/seckill\/sessions\/(0x[0-9a-fA-F]{64})\/events$/);
  if (request.method === 'GET' && seckillEvents) {
    sendJson(response, 200, await dependencies.seckillService.events(seckillEvents[1]!, {
      ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      ...(url.searchParams.get('limit')
        ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
        : {}),
    }), correlationId);
    return;
  }
  const seckillSession = url.pathname.match(/^\/v2\/seckill\/sessions\/(0x[0-9a-fA-F]{64})$/);
  if (request.method === 'GET' && seckillSession) {
    sendJson(response, 200, await dependencies.seckillService.get(seckillSession[1]!), correlationId);
    return;
  }
  if (await routeAdminServices(dependencies, request, response, url, correlationId)) return;
  if (request.method === 'POST' && url.pathname === '/v2/auth/nonce') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['walletAddress']);
    const walletAddress = normalizeAddress(requiredString(body, 'walletAddress'));
    const now = dependencies.clock();
    await dependencies.nonceRateLimiter.consume({
      walletAddress,
      clientAddress: request.socket.remoteAddress ?? 'unknown',
      now,
    });
    const challenge = await createSiweChallenge(dependencies.nonceStore, {
      walletAddress,
      domain: dependencies.authDomain,
      uri: dependencies.authUri,
      statement: 'Sign in to 24K商城 V2',
    }, now);
    sendJson(response, 201, challenge, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/auth/verify') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['message', 'signature']);
    const verified = await verifySiwe(dependencies.nonceStore, {
      message: requiredString(body, 'message'),
      signature: requiredString(body, 'signature'),
      expectedDomain: dependencies.authDomain,
      expectedUri: dependencies.authUri,
    }, dependencies.clock());
    const binding = await dependencies.resolveRoles(verified.walletAddress);
    if (binding.roles.length === 0) throw new CoreError('Forbidden', 'Wallet is not authorized', 403);
    if (!dependencies.config.jwtSecret) throw new CoreError('ConfigurationRequired', 'JWT service is unavailable', 503);
    const token = issueSessionToken(
      {
        walletAddress: verified.walletAddress,
        roles: binding.roles,
        ...(binding.merchantId ? { merchantId: binding.merchantId } : {}),
      },
      dependencies.config.jwtSecret,
      dependencies.clock(),
    );
    if (binding.roles.includes('BUYER')) await dependencies.accountService.ensureBuyerUid(verified.walletAddress);
    sendJson(response, 200, {
      token,
      walletAddress: verified.walletAddress,
      roles: binding.roles,
      ...(binding.merchantId ? { merchantId: binding.merchantId } : {}),
    }, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/public/merchant-applications') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['message', 'signature', 'shopName', 'legalName', 'legalId', 'contactPhone', 'idempotencyKey']);
    const verified = await verifySiwe(dependencies.nonceStore, {
      message: requiredString(body, 'message'),
      signature: requiredString(body, 'signature'),
      expectedDomain: dependencies.authDomain,
      expectedUri: dependencies.authUri,
    }, dependencies.clock());
    sendJson(response, 201, await dependencies.merchantLifecycleService.createPublicApplication(
      verified.walletAddress,
      {
        shopName: requiredString(body, 'shopName'),
        legalName: requiredString(body, 'legalName'),
        legalId: requiredString(body, 'legalId'),
        contactPhone: requiredString(body, 'contactPhone'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      },
    ), correlationId);
    return;
  }
  const logisticsProvider = logisticsWebhookProvider(url.pathname);
  if (request.method === 'POST' && logisticsProvider) {
    const secret = dependencies.logisticsWebhookSecrets?.[logisticsProvider];
    if (!secret) throw new CoreError('ConfigurationRequired', `${logisticsProvider} webhook is not configured`, 503);
    const signature = request.headers['x-provider-signature']?.toString() ?? '';
    const raw = await readBody(request);
    verifyWebhookHmac(raw, signature, secret);
    const body = parseJsonBody(raw);
    assertOnlyKeys(body, ['eventId', 'orderId', 'status', 'occurredAt', 'locationHash']);
    const systemWallet = dependencies.config.governanceWalletAddress;
    if (!systemWallet) throw new CoreError('ExternalBlocked', 'Platform governance wallet is unavailable', 503);
    const eventId = requiredString(body, 'eventId');
    const result = await dependencies.fulfillmentService.recordLogisticsUpdate(
      { walletAddress: systemWallet, roles: ['OPERATOR'] },
      requiredString(body, 'orderId'),
      {
        idempotencyKey: `logistics:${logisticsProvider}:${eventId}`,
        evidenceHash: sha256Hash(raw),
        provider: logisticsProvider,
        providerEventIdHash: sha256Hash(Buffer.from(`${logisticsProvider}:${eventId}`, 'utf8')),
        status: logisticsStatus(body.status),
        occurredAt: requiredDate(body, 'occurredAt'),
        ...(body.locationHash === undefined ? {} : { locationHash: requiredString(body, 'locationHash') }),
      },
    );
    sendJson(response, 202, result, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/actions/order') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['orderId']);
    const orderId = requiredString(body, 'orderId');
    const order = await dependencies.getOrderProjection(orderId);
    if (!order) throw new CoreError('InvalidRequest', 'Order not found', 404);
    const context: ActionContext = {
      actorWallet: claims.sub,
      roles: claims.roles,
      ...(claims.merchantId ? { actorMerchantId: claims.merchantId } : {}),
      now: dependencies.clock(),
      pausedScopes: await dependencies.getPausedScopes(),
      executableActions: new Set(executableOrderActionNames),
    };
    sendJson(response, 200, { allowedActions: orderAllowedActions(order, context) }, correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/dashboard') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(
      response,
      200,
      await dependencies.businessAnalyticsService.merchantDashboard(fulfillmentActor(claims)),
      correlationId,
    );
    return;
  }
  if (url.pathname === '/v2/buyer/profile') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    if (request.method === 'GET') {
      sendJson(response, 200, await dependencies.accountService.getBuyerProfile(fulfillmentActor(claims)), correlationId);
      return;
    }
    if (request.method === 'PUT') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['nickname', 'avatarAssetId', 'expectedVersion', 'idempotencyKey']);
      sendJson(response, 200, await dependencies.accountService.updateBuyerProfile(fulfillmentActor(claims), {
        nickname: nullableString(body, 'nickname'),
        avatarAssetId: nullableString(body, 'avatarAssetId'),
        expectedVersion: requiredNonNegativeInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      }), correlationId);
      return;
    }
  }
  if (request.method === 'POST' && url.pathname === '/v2/buyer/addresses/parse') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['rawText']);
    sendJson(
      response,
      200,
      await dependencies.accountService.parseBuyerAddress(fulfillmentActor(claims), requiredString(body, 'rawText')),
      correlationId,
    );
    return;
  }
  if (url.pathname === '/v2/buyer/addresses') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    if (request.method === 'GET') {
      sendJson(response, 200, await dependencies.accountService.listBuyerAddresses(fulfillmentActor(claims)), correlationId);
      return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      sendJson(
        response,
        201,
        await dependencies.accountService.createBuyerAddress(
          fulfillmentActor(claims),
          buyerAddressInput(body, false),
        ),
        correlationId,
      );
      return;
    }
  }
  const buyerAddressPath = matchResourceAction(url.pathname, '/v2/buyer/addresses/');
  if (buyerAddressPath && request.method === 'PUT' && buyerAddressPath.action === undefined) {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    sendJson(response, 200, await dependencies.accountService.updateBuyerAddress(
      fulfillmentActor(claims),
      buyerAddressPath.resourceId,
      buyerAddressInput(body, true),
    ), correlationId);
    return;
  }
  if (buyerAddressPath && request.method === 'DELETE' && buyerAddressPath.action === undefined) {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['expectedVersion', 'idempotencyKey']);
    sendJson(response, 200, await dependencies.accountService.deleteBuyerAddress(
      fulfillmentActor(claims),
      buyerAddressPath.resourceId,
      {
        expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return;
  }
  if (buyerAddressPath && request.method === 'POST' && buyerAddressPath.action === 'default') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['expectedVersion', 'idempotencyKey']);
    sendJson(response, 200, await dependencies.accountService.setDefaultBuyerAddress(
      fulfillmentActor(claims),
      buyerAddressPath.resourceId,
      {
        expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return;
  }
  if (buyerAddressPath && request.method === 'POST' && buyerAddressPath.action === 'fulfillment-target') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey']);
    sendJson(response, 201, await dependencies.accountService.createBuyerAddressTarget(
      fulfillmentActor(claims),
      buyerAddressPath.resourceId,
      requiredString(body, 'idempotencyKey'),
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/buyer/overview') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    sendJson(response, 200, await dependencies.accountService.getBuyerOverview(fulfillmentActor(claims)), correlationId);
    return;
  }
  const takeoverTimeline = url.pathname.match(/^\/v2\/orders\/([^/]+)\/takeover-timeline$/);
  if (request.method === 'GET' && takeoverTimeline) {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    sendJson(response, 200, await dependencies.accountService.getBuyerTakeoverTimeline(
      fulfillmentActor(claims),
      decodedPathPart(takeoverTimeline[1]!),
    ), correlationId);
    return;
  }
  if (url.pathname === '/v2/merchant/profile') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const actor = fulfillmentActor(claims);
    if (request.method === 'GET') {
      sendJson(response, 200, await dependencies.accountService.getMerchantProfile(actor), correlationId);
      return;
    }
    if (request.method === 'PUT') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['shopName', 'logoAssetId', 'expectedVersion', 'idempotencyKey']);
      sendJson(response, 200, await dependencies.accountService.updateMerchantProfile(actor, {
        shopName: requiredString(body, 'shopName'),
        logoAssetId: nullableString(body, 'logoAssetId'),
        expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      }), correlationId);
      return;
    }
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/audit/entries') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const actor = fulfillmentActor(claims);
    await dependencies.accountService.getMerchantProfile(actor);
    sendJson(
      response,
      200,
      await dependencies.auditService.listMerchant(actor, merchantAuditQuery(url)),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/merchant/audit/exports') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const actor = fulfillmentActor(claims);
    await dependencies.accountService.getMerchantProfile(actor);
    const body = await readJson(request);
    assertOnlyKeys(body, ['from', 'to', 'streamName', 'eventType', 'resourceType', 'idempotencyKey']);
    const from = requiredDate(body, 'from');
    const to = requiredDate(body, 'to');
    const exported = await dependencies.auditService.exportMerchant(actor, {
      from,
      to,
      ...(body.streamName === undefined ? {} : { streamName: auditStream(requiredString(body, 'streamName')) }),
      ...(body.eventType === undefined ? {} : { eventType: requiredString(body, 'eventType') }),
      ...(body.resourceType === undefined ? {} : { resourceType: requiredString(body, 'resourceType') }),
    });
    await dependencies.accountService.recordMerchantAuditExport(actor, {
      from,
      to,
      entryCount: exported.entryCount,
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    });
    sendJson(response, 200, exported, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/merchant/orders/exports') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const actor = fulfillmentActor(claims);
    const body = await readJson(request);
    const input = merchantOrderExportInput(body);
    const exported = await dependencies.fulfillmentTargetService.exportMerchantOrders(actor, input);
    await dependencies.accountService.recordMerchantOrderExport(actor, {
      exportId: exported.exportId,
      contentHash: exported.contentHash,
      rowCount: exported.rowCount,
      filters: exported.filters,
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    });
    sendJson(response, 200, exported, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/settlement-intents') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['rail', 'amount', 'idempotencyKey']);
    sendJson(
      response,
      201,
      await dependencies.settlementService.createIntent(fulfillmentActor(claims), {
        rail: settlementRail(body.rail),
        amount: requiredString(body, 'amount'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/settlement-intents') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'ARBITRATOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'rail',
      'resourceId',
      'orderId',
      'accountId',
      'recipient',
      'fulfillmentTargetHash',
      'amount',
      'idempotencyKey',
      'approval',
    ]);
    const approval = requiredObject(body, 'approval');
    assertOnlyKeys(approval, [
      'action',
      'resourceType',
      'resourceId',
      'policyVersion',
      'oldValueHash',
      'newValueHash',
      'executorWallet',
      'nonce',
      'deadline',
      'signature',
    ]);
    sendJson(
      response,
      201,
      await dependencies.settlementService.createGovernedIntent(fulfillmentActor(claims), {
        rail: governedSettlementRail(body.rail),
        resourceId: requiredString(body, 'resourceId'),
        orderId: requiredString(body, 'orderId'),
        accountId: requiredString(body, 'accountId'),
        recipient: requiredString(body, 'recipient'),
        ...(body.fulfillmentTargetHash === undefined
          ? {}
          : { fulfillmentTargetHash: requiredString(body, 'fulfillmentTargetHash') }),
        amount: requiredString(body, 'amount'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
        approval: {
          action: requiredString(approval, 'action'),
          resourceType: requiredString(approval, 'resourceType'),
          resourceId: requiredString(approval, 'resourceId'),
          policyVersion: requiredString(approval, 'policyVersion'),
          oldValueHash: requiredString(approval, 'oldValueHash'),
          newValueHash: requiredString(approval, 'newValueHash'),
          executorWallet: requiredString(approval, 'executorWallet'),
          nonce: requiredString(approval, 'nonce'),
          deadline: requiredString(approval, 'deadline'),
          signature: requiredString(approval, 'signature'),
        },
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/settlement-requests') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['intentId', 'signature']);
    sendJson(
      response,
      201,
      await dependencies.settlementService.submitRequest(fulfillmentActor(claims), {
        intentId: requiredString(body, 'intentId'),
        signature: requiredString(body, 'signature'),
        correlationId,
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/settlements') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      await dependencies.settlementService.list(fulfillmentActor(claims)),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/buyer/shopping-statements') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['BUYER']);
    sendJson(
      response,
      200,
      await dependencies.orderStatementService.listBuyerShopping(
        fulfillmentActor(claims),
        orderStatementQuery(url),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/receivable-statements') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(
      response,
      200,
      await dependencies.orderStatementService.listMerchantReceivables(
        fulfillmentActor(claims),
        orderStatementQuery(url),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/finance/merchant') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const merchantId = url.searchParams.get('merchantId') ?? undefined;
    sendJson(
      response,
      200,
      await dependencies.takeoverFundingService.getMerchantFinance(
        fulfillmentActor(claims),
        merchantId,
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/takeover-cases') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.takeoverCaseService.listAdmin(
      fulfillmentActor(claims),
      takeoverCaseQuery(url),
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/takeover-cases') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(response, 200, await dependencies.takeoverCaseService.listMerchant(
      fulfillmentActor(claims),
      takeoverCaseQuery(url),
    ), correlationId);
    return;
  }
  const adminTakeoverCasePath = url.pathname.match(/^\/v2\/admin\/takeover-cases\/([^/]+)(?:\/(candidates|assignments))?$/);
  if (adminTakeoverCasePath) {
    const caseId = decodedPathPart(adminTakeoverCasePath[1]!);
    const action = adminTakeoverCasePath[2];
    if (request.method === 'GET' && action === undefined) {
      const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      assertOnlySearchParams(url, []);
      sendJson(response, 200, await dependencies.takeoverCaseService.getAdmin(fulfillmentActor(claims), caseId), correlationId);
      return;
    }
    if (request.method === 'GET' && action === 'candidates') {
      const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      assertOnlySearchParams(url, []);
      sendJson(response, 200, await dependencies.takeoverCaseService.listCandidates(fulfillmentActor(claims), caseId), correlationId);
      return;
    }
    if (request.method === 'POST' && action === 'assignments') {
      const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
      const body = await readJson(request);
      assertOnlyKeys(body, ['replacementMerchantId', 'reasonCode', 'evidenceHash', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.takeoverCaseService.assign(fulfillmentActor(claims), caseId, {
        replacementMerchantId: requiredString(body, 'replacementMerchantId'),
        reasonCode: requiredString(body, 'reasonCode'),
        evidenceHash: requiredString(body, 'evidenceHash'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      }), correlationId);
      return;
    }
  }
  const merchantTakeoverCasePath = url.pathname.match(/^\/v2\/merchant\/takeover-cases\/([^/]+)$/);
  if (request.method === 'GET' && merchantTakeoverCasePath) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    assertOnlySearchParams(url, []);
    sendJson(response, 200, await dependencies.takeoverCaseService.getMerchant(
      fulfillmentActor(claims),
      decodedPathPart(merchantTakeoverCasePath[1]!),
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/finance/merchant/guarantee-deposits') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['policyVersion', 'expectedAmountUsdt', 'transactionHash', 'idempotencyKey']);
    sendJson(
      response,
      201,
      await dependencies.guaranteeDepositService.submit(fulfillmentActor(claims), {
        policyVersion: requiredString(body, 'policyVersion'),
        expectedAmountUsdt: requiredString(body, 'expectedAmountUsdt'),
        transactionHash: requiredString(body, 'transactionHash'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/takeover-funding/approval-challenge') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'ARBITRATOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, ['caseId', 'requiredUsdt', 'nonce', 'deadline']);
    sendJson(
      response,
      200,
      await dependencies.takeoverFundingService.fundingApprovalChallenge(fulfillmentActor(claims), {
        caseId: requiredString(body, 'caseId'),
        requiredUsdt: requiredString(body, 'requiredUsdt'),
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/takeover-funding') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'ARBITRATOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, ['caseId', 'requiredUsdt', 'idempotencyKey', 'approval']);
    sendJson(
      response,
      201,
      await dependencies.takeoverFundingService.fundTakeover(fulfillmentActor(claims), {
        caseId: requiredString(body, 'caseId'),
        requiredUsdt: requiredString(body, 'requiredUsdt'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
        approval: sensitiveApproval(requiredObject(body, 'approval')),
      }),
      correlationId,
    );
    return;
  }
  const takeoverFundingCaseId = pathParameter(url.pathname, '/v2/admin/takeover-funding/');
  if (request.method === 'GET' && takeoverFundingCaseId) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.takeoverFundingService.getTakeoverFunding(
        fulfillmentActor(claims),
        takeoverFundingCaseId,
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/stores') {
    const regionCode = url.searchParams.get('regionCode') ?? undefined;
    const productId = url.searchParams.get('productId') ?? undefined;
    sendJson(
      response,
      200,
      { stores: await dependencies.fulfillmentTargetService.listStores(regionCode, productId) },
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/stores') {
    assertOnlySearchParams(url, []);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(
      response,
      200,
      { stores: await dependencies.fulfillmentTargetService.listMerchantStores(fulfillmentActor(claims)) },
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/merchant/stores') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey', 'name', 'phone', 'businessHours', 'longitude', 'latitude',
      'address', 'province', 'city', 'district', 'regionCode',
    ]);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createStore(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        name: requiredString(body, 'name'),
        phone: requiredString(body, 'phone'),
        businessHours: requiredString(body, 'businessHours'),
        longitude: requiredNumber(body, 'longitude'),
        latitude: requiredNumber(body, 'latitude'),
        ...(body.address === undefined ? {} : { address: requiredString(body, 'address') }),
        ...(body.province === undefined ? {} : { province: requiredString(body, 'province') }),
        ...(body.city === undefined ? {} : { city: requiredString(body, 'city') }),
        ...(body.district === undefined ? {} : { district: requiredString(body, 'district') }),
        ...(body.regionCode === undefined ? {} : { regionCode: requiredString(body, 'regionCode') }),
        correlationId,
      }),
      correlationId,
    );
    return;
  }
  const merchantStorePath = matchMerchantStorePath(url.pathname);
  if (merchantStorePath && request.method === 'PUT' && !merchantStorePath.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'name', 'phone', 'businessHours', 'imageAssetIds', 'expectedVersion', 'idempotencyKey',
    ]);
    sendJson(
      response,
      200,
      await dependencies.fulfillmentTargetService.updateStore(
        fulfillmentActor(claims),
        merchantStorePath.storeId,
        {
          name: requiredString(body, 'name'),
          phone: requiredString(body, 'phone'),
          businessHours: requiredString(body, 'businessHours'),
          imageAssetIds: requiredStringArray(body, 'imageAssetIds'),
          expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          correlationId,
        },
      ),
      correlationId,
    );
    return;
  }
  if (merchantStorePath?.action && request.method === 'POST') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['expectedVersion', 'idempotencyKey']);
    const input = {
      expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    };
    const store = merchantStorePath.action === 'activate'
      ? await dependencies.fulfillmentTargetService.activateStore(fulfillmentActor(claims), merchantStorePath.storeId, input)
      : await dependencies.fulfillmentTargetService.closeStore(fulfillmentActor(claims), merchantStorePath.storeId, input);
    sendJson(response, 200, store, correlationId);
    return;
  }
  const printerBindingPath = matchMerchantPrinterBindingPath(url.pathname);
  if (printerBindingPath && request.method === 'GET' && !printerBindingPath.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(
      response,
      200,
      await dependencies.logisticsPrintingService.getPrinterBinding(
        fulfillmentActor(claims),
        printerBindingPath.storeId,
      ),
      correlationId,
    );
    return;
  }
  if (printerBindingPath && request.method === 'POST' && printerBindingPath.action === 'challenge') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['provider', 'deviceId', 'idempotencyKey']);
    sendJson(
      response,
      201,
      await dependencies.logisticsPrintingService.createPrinterBindingChallenge(
        fulfillmentActor(claims),
        printerBindingPath.storeId,
        {
          provider: requiredEnum(body, 'provider', ['FEIE', 'YILIANYUN']),
          deviceId: requiredString(body, 'deviceId'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ),
      correlationId,
    );
    return;
  }
  if (printerBindingPath && request.method === 'PUT' && !printerBindingPath.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['challengeId', 'signature', 'idempotencyKey']);
    sendJson(
      response,
      200,
      await dependencies.logisticsPrintingService.applyPrinterBinding(
        fulfillmentActor(claims),
        printerBindingPath.storeId,
        {
          challengeId: requiredString(body, 'challengeId'),
          signature: requiredString(body, 'signature'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/merchant/waybills/batches') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['provider', 'carrierCode', 'storeId', 'orderIds', 'idempotencyKey']);
    sendJson(
      response,
      201,
      await dependencies.logisticsPrintingService.createWaybillBatch(fulfillmentActor(claims), {
        provider: requiredEnum(body, 'provider', ['KUAIDI100', 'CAINIAO']),
        carrierCode: requiredEnum(body, 'carrierCode', ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS']),
        storeId: requiredString(body, 'storeId'),
        orderIds: requiredStringArray(body, 'orderIds'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/merchant/print-jobs') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    sendJson(
      response,
      200,
      await dependencies.logisticsPrintingService.listPrintJobs(
        fulfillmentActor(claims),
        optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit'),
      ),
      correlationId,
    );
    return;
  }
  const printJobRetryId = matchMerchantPrintJobRetryPath(url.pathname);
  if (printJobRetryId && request.method === 'POST') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey']);
    sendJson(
      response,
      200,
      await dependencies.logisticsPrintingService.retryPrintJob(
        fulfillmentActor(claims),
        printJobRetryId,
        requiredString(body, 'idempotencyKey'),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/logistics/carriers') {
    assertOnlySearchParams(url, []);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.logisticsAdminService.listCarrierConfig(
      fulfillmentActor(claims),
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/logistics/carrier-versions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 201, await dependencies.logisticsAdminService.createCarrierConfigVersion(
      fulfillmentActor(claims),
      logisticsCarrierConfigInput(body),
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/logistics/providers') {
    assertOnlySearchParams(url, []);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.logisticsAdminService.listProviderConfigs(
      fulfillmentActor(claims),
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/logistics/provider-versions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 201, await dependencies.logisticsAdminService.createProviderConfigVersion(
      fulfillmentActor(claims),
      logisticsProviderConfigInput(body),
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/logistics/warehouses') {
    assertOnlySearchParams(url, []);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.logisticsAdminService.listWarehouses(
      fulfillmentActor(claims),
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/logistics/warehouses') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 201, await dependencies.logisticsAdminService.createWarehouse(
      fulfillmentActor(claims),
      logisticsWarehouseInput(body, false),
    ), correlationId);
    return;
  }
  const logisticsWarehousePath = matchAdminLogisticsWarehousePath(url.pathname);
  if (logisticsWarehousePath && request.method === 'PUT' && !logisticsWarehousePath.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 200, await dependencies.logisticsAdminService.updateWarehouse(
      fulfillmentActor(claims),
      logisticsWarehousePath.warehouseId,
      logisticsWarehouseInput(body, true),
    ), correlationId);
    return;
  }
  if (logisticsWarehousePath?.action === 'deactivate' && request.method === 'POST') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['expectedVersion', 'idempotencyKey']);
    sendJson(response, 200, await dependencies.logisticsAdminService.deactivateWarehouse(
      fulfillmentActor(claims),
      logisticsWarehousePath.warehouseId,
      {
        expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/logistics/waybills/batches') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['merchantId', 'provider', 'carrierCode', 'storeId', 'orderIds', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.logisticsPrintingService.createAdminWaybillBatch(
      fulfillmentActor(claims),
      {
        merchantId: requiredString(body, 'merchantId'),
        provider: requiredEnum(body, 'provider', ['KUAIDI100', 'CAINIAO']),
        carrierCode: requiredEnum(body, 'carrierCode', ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS']),
        storeId: requiredString(body, 'storeId'),
        orderIds: requiredStringArray(body, 'orderIds'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/logistics/waybills') {
    assertOnlySearchParams(url, ['merchantId', 'limit']);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const merchantId = url.searchParams.get('merchantId');
    const limit = optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit');
    sendJson(response, 200, await dependencies.logisticsPrintingService.listAdminWaybills(
      fulfillmentActor(claims),
      { ...(merchantId ? { merchantId } : {}), ...(limit ? { limit } : {}) },
    ), correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/logistics/print-jobs') {
    assertOnlySearchParams(url, ['merchantId', 'limit']);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const merchantId = url.searchParams.get('merchantId');
    const limit = optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit');
    sendJson(response, 200, await dependencies.logisticsPrintingService.listAdminPrintJobs(
      fulfillmentActor(claims),
      { ...(merchantId ? { merchantId } : {}), ...(limit ? { limit } : {}) },
    ), correlationId);
    return;
  }
  const adminPrintJobRetryId = matchAdminLogisticsPrintJobRetryPath(url.pathname);
  if (adminPrintJobRetryId && request.method === 'POST') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey']);
    sendJson(response, 200, await dependencies.logisticsPrintingService.retryAdminPrintJob(
      fulfillmentActor(claims),
      adminPrintJobRetryId,
      requiredString(body, 'idempotencyKey'),
    ), correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/fulfillment-targets/delivery') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'recipientName',
      'phone',
      'address',
      'longitude',
      'latitude',
      'province',
      'city',
      'district',
      'regionCode',
    ]);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createDeliveryTarget(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        recipientName: requiredString(body, 'recipientName'),
        phone: requiredString(body, 'phone'),
        address: requiredString(body, 'address'),
        ...(body.longitude === undefined ? {} : { longitude: body.longitude === null ? null : requiredNumber(body, 'longitude') }),
        ...(body.latitude === undefined ? {} : { latitude: body.latitude === null ? null : requiredNumber(body, 'latitude') }),
        ...(body.province === undefined ? {} : { province: requiredString(body, 'province') }),
        ...(body.city === undefined ? {} : { city: requiredString(body, 'city') }),
        ...(body.district === undefined ? {} : { district: requiredString(body, 'district') }),
        ...(body.regionCode === undefined ? {} : { regionCode: requiredString(body, 'regionCode') }),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/fulfillment-targets/pickup') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey', 'storeId']);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createPickupTarget(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        storeId: requiredString(body, 'storeId'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/media/upload-intents') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'purpose',
      'resourceType',
      'resourceId',
      'contentType',
      'sizeBytes',
      'contentSha256',
      'idempotencyKey',
    ]);
    sendJson(
      response,
      201,
      await dependencies.evidenceService.createUploadIntent(fulfillmentActor(claims), {
        purpose: mediaPurpose(body.purpose),
        resourceType: mediaResourceType(body.resourceType),
        resourceId: requiredString(body, 'resourceId'),
        contentType: mediaContentType(body.contentType),
        sizeBytes: requiredPositiveInteger(body, 'sizeBytes'),
        contentSha256: requiredString(body, 'contentSha256'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      }),
      correlationId,
    );
    return;
  }
  const completeUpload = url.pathname.match(/^\/v2\/media\/upload-intents\/(0x[0-9a-fA-F]{64})\/complete$/);
  if (request.method === 'POST' && completeUpload) {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, []);
    sendJson(
      response,
      200,
      await dependencies.evidenceService.completeUpload(fulfillmentActor(claims), completeUpload[1]!),
      correlationId,
    );
    return;
  }
  const readMedia = url.pathname.match(/^\/v2\/media\/assets\/(0x[0-9a-fA-F]{64})\/access$/);
  if (request.method === 'GET' && readMedia) {
    const claims = request.headers.authorization
      ? authorize(request, dependencies.config, dependencies.clock())
      : undefined;
    sendJson(
      response,
      200,
      await dependencies.evidenceService.createReadAccess(
        claims ? fulfillmentActor(claims) : undefined,
        readMedia[1]!,
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/orders') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      await dependencies.fulfillmentService.listOrderPage(
        fulfillmentActor(claims),
        fulfillmentOrderPageQuery(url),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/orders') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.fulfillmentService.searchAdminOrders(
        fulfillmentActor(claims),
        adminOrderSearchQuery(url),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/orders/batch-actions/preview') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, ['orderIds']);
    sendJson(
      response,
      200,
      await dependencies.fulfillmentService.previewOrderBatchActions(
        fulfillmentActor(claims),
        requiredStringArray(body, 'orderIds'),
      ),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/shipments/batches') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['MERCHANT', 'ADMIN', 'OPERATOR'],
    );
    const body = await readJson(request);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentService.recordShipmentBatch(
        fulfillmentActor(claims),
        shipmentBatchInput(body),
      ),
      correlationId,
    );
    return;
  }
  const orderPath = matchOrderPath(url.pathname);
  if (orderPath && request.method === 'GET' && !orderPath.action) {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      { order: await dependencies.fulfillmentService.getOrder(fulfillmentActor(claims), orderPath.orderId) },
      correlationId,
    );
    return;
  }
  if (orderPath && request.method === 'GET' && orderPath.action === 'fulfillment-target') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      { target: await dependencies.fulfillmentTargetService.getOrderTarget(fulfillmentActor(claims), orderPath.orderId) },
      correlationId,
    );
    return;
  }
  if (orderPath && request.method === 'POST' && orderPath.action) {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const actor = fulfillmentActor(claims);
    const body = await readJson(request);
    const base = () => {
      assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash']);
      return {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        evidenceHash: requiredString(body, 'evidenceHash'),
      };
    };
    let status = 200;
    let result: unknown;
    switch (orderPath.action) {
      case 'evidence':
        assertOnlyKeys(body, ['action', 'reasonCode', 'mediaAssetIds', 'idempotencyKey']);
        status = 201;
        result = await dependencies.evidenceService.createActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: evidenceAction(body.action),
          reasonCode: requiredString(body, 'reasonCode'),
          ...(body.mediaAssetIds === undefined
            ? {}
            : { mediaAssetIds: requiredStringArray(body, 'mediaAssetIds') }),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        });
        break;
      case 'tracking-evidence':
        assertOnlyKeys(body, ['carrierCode', 'trackingNumber', 'note', 'mediaAssetIds', 'idempotencyKey']);
        status = 201;
        result = await dependencies.evidenceService.createTrackingEvidence(actor, {
          orderId: orderPath.orderId,
          carrierCode: evidenceCarrier(body.carrierCode),
          trackingNumber: requiredString(body, 'trackingNumber'),
          ...(body.note === undefined ? {} : { note: nullableString(body, 'note') }),
          ...(body.mediaAssetIds === undefined
            ? {}
            : { mediaAssetIds: requiredStringArray(body, 'mediaAssetIds') }),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        });
        break;
      case 'shipments': {
        assertOnlyKeys(body, [
          'idempotencyKey',
          'evidenceHash',
          'carrierCode',
          'trackingNumberHash',
          'providerReferenceHash',
        ]);
        status = 201;
        const carrierCode = evidenceCarrier(body.carrierCode);
        const trackingNumberHash = requiredString(body, 'trackingNumberHash');
        const evidenceHash = requiredString(body, 'evidenceHash');
        await dependencies.evidenceService.assertTrackingEvidence(actor, {
          orderId: orderPath.orderId,
          carrierCode,
          trackingNumberHash,
          evidenceHash,
        });
        result = await dependencies.fulfillmentService.recordShipment(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash,
          carrierCode,
          trackingNumberHash,
          ...(body.providerReferenceHash === undefined
            ? {}
            : { providerReferenceHash: requiredString(body, 'providerReferenceHash') }),
        });
        break;
      }
      case 'delivery': {
        const input = base();
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'RECORD_DELIVERY',
          evidenceHash: input.evidenceHash,
        });
        result = await dependencies.fulfillmentService.recordDelivery(actor, orderPath.orderId, input);
        break;
      }
      case 'pickup-credential':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'code', 'expiresAt']);
        status = 201;
        result = await dependencies.fulfillmentService.registerPickupCredential(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          code: requiredString(body, 'code'),
          expiresAt: requiredDate(body, 'expiresAt'),
        });
        break;
      case 'pickup-verification': {
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'code', 'storeId']);
        const evidenceHash = requiredString(body, 'evidenceHash');
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'VERIFY_PICKUP',
          evidenceHash,
        });
        result = await dependencies.fulfillmentService.verifyPickup(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash,
          code: requiredString(body, 'code'),
          storeId: requiredString(body, 'storeId'),
        });
        break;
      }
      case 'exchange-requests': {
        status = 201;
        const input = requestInput(body);
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'REQUEST_EXCHANGE',
          evidenceHash: input.evidenceHash,
          reasonCode: input.reasonCode,
        });
        result = await dependencies.fulfillmentService.requestExchange(
          actor,
          orderPath.orderId,
          input,
        );
        break;
      }
      case 'delay-requests': {
        status = 201;
        const input = requestInput(body);
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'REQUEST_DELAY',
          evidenceHash: input.evidenceHash,
          reasonCode: input.reasonCode,
        });
        result = await dependencies.fulfillmentService.requestDelay(
          actor,
          orderPath.orderId,
          input,
        );
        break;
      }
      case 'request-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'requestId', 'approved', 'noteCode']);
        result = await dependencies.fulfillmentService.decideFulfillmentRequest(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          requestId: requiredString(body, 'requestId'),
          approved: requiredBoolean(body, 'approved'),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'arbitrations': {
        status = 201;
        const input = requestInput(body);
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'OPEN_ARBITRATION',
          evidenceHash: input.evidenceHash,
          reasonCode: input.reasonCode,
        });
        result = await dependencies.fulfillmentService.openArbitration(
          actor,
          orderPath.orderId,
          input,
        );
        break;
      }
      case 'arbitration-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'outcome', 'noteCode']);
        result = await dependencies.fulfillmentService.decideArbitration(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          outcome: arbitrationOutcome(body.outcome),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'takeover':
        status = 201;
        result = await dependencies.fulfillmentService.openTakeover(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'forced-receipt-requests': {
        status = 201;
        const input = requestInput(body);
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'REQUEST_FORCED_RECEIPT',
          evidenceHash: input.evidenceHash,
          reasonCode: input.reasonCode,
        });
        result = await dependencies.fulfillmentService.requestForcedReceipt(
          actor,
          orderPath.orderId,
          input,
        );
        break;
      }
      case 'forced-receipt-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'approved', 'noteCode']);
        result = await dependencies.fulfillmentService.decideForcedReceipt(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          approved: requiredBoolean(body, 'approved'),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'receipt-confirmation': {
        const input = base();
        await dependencies.evidenceService.assertActionEvidence(actor, {
          orderId: orderPath.orderId,
          action: 'CONFIRM_RECEIPT',
          evidenceHash: input.evidenceHash,
        });
        result = await dependencies.fulfillmentService.confirmReceipt(actor, orderPath.orderId, input);
        break;
      }
      default:
        throw new CoreError('InvalidRequest', 'Order action route not found', 404);
    }
    sendJson(response, status, result, correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/catalog/categories') {
    sendJson(response, 200, { categories: await dependencies.catalogManagementService.listCategories(false) }, correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/catalog/tags') {
    sendJson(response, 200, { tags: await dependencies.catalogManagementService.listTags(false) }, correlationId);
    return;
  }
  const merchantSlot = /^\/v2\/merchant\/stores\/([^/]+)\/product-slot$/.exec(url.pathname);
  if (merchantSlot && (request.method === 'GET' || request.method === 'PUT')) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const storeId = decodedPathPart(merchantSlot[1]!);
    const actor = merchantCatalogActor(claims);
    if (request.method === 'GET') {
      sendJson(response, 200, await dependencies.catalogManagementService.getProductSlot(actor, storeId), correlationId);
      return;
    }
    const body = await readJson(request);
    sendJson(
      response,
      200,
      await dependencies.catalogManagementService.saveProductSlot(actor, storeId, productSlotInput(body)),
      correlationId,
    );
    return;
  }
  const merchantProduct = matchResourceAction(url.pathname, '/v2/merchant/products/');
  if (request.method === 'POST' && merchantProduct?.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['MERCHANT']);
    const actor = merchantCatalogActor(claims);
    const body = await readJson(request);
    if (merchantProduct.action === 'concession-previews') {
      assertOnlyKeys(body, ['merchantConcessionBps', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.catalogManagementService.createConcessionPreview(
        actor,
        merchantProduct.resourceId,
        {
          merchantConcessionBps: requiredBps(body, 'merchantConcessionBps'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return;
    }
    if (merchantProduct.action === 'review-submissions') {
      assertOnlyKeys(body, ['previewId', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.catalogManagementService.submitReview(
        actor,
        merchantProduct.resourceId,
        {
          previewId: requiredString(body, 'previewId'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return;
    }
    if (merchantProduct.action === 'delist') {
      assertOnlyKeys(body, ['reasonCode', 'idempotencyKey']);
      sendJson(response, 200, await dependencies.catalogManagementService.delistProduct(
        actor,
        merchantProduct.resourceId,
        {
          reasonCode: requiredString(body, 'reasonCode'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return;
    }
  }
  if (request.method === 'GET' && url.pathname === '/v2/catalog/products') {
    const claims = request.headers.authorization
      ? authorize(request, dependencies.config, dependencies.clock())
      : undefined;
    sendJson(response, 200, {
      products: await dependencies.paymentService.listCatalog(
        claims?.roles.includes('BUYER') ? claims.sub : undefined,
      ),
    }, correlationId);
    return;
  }
  const productId = pathParameter(url.pathname, '/v2/catalog/products/');
  if (request.method === 'GET' && productId) {
    const claims = request.headers.authorization
      ? authorize(request, dependencies.config, dependencies.clock())
      : undefined;
    sendJson(response, 200, {
      product: await dependencies.paymentService.getProduct(
        productId,
        claims?.roles.includes('BUYER') ? claims.sub : undefined,
      ),
    }, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/payments/quotes') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'productId',
      'skuId',
      'quantity',
      'fulfillmentMode',
      'fulfillmentTargetHash',
      'regionCodeHash',
    ]);
    const quoteInput: CreateOrdinaryQuoteInput = {
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      productId: requiredString(body, 'productId'),
      skuId: requiredString(body, 'skuId'),
      quantity: requiredPositiveInteger(body, 'quantity'),
      fulfillmentMode: fulfillmentMode(body.fulfillmentMode),
      fulfillmentTargetHash: requiredString(body, 'fulfillmentTargetHash'),
      regionCodeHash: requiredString(body, 'regionCodeHash'),
    };
    await assertPaymentWritesEnabled(dependencies, ['NEW_PAYMENT'], {
      buyerWallet: claims.sub,
      productId: quoteInput.productId,
      quantity: quoteInput.quantity,
    });
    sendJson(
      response,
      201,
      await dependencies.paymentService.createOrdinaryQuote(claims.sub, quoteInput),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/seckill/quotes') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'sessionId',
      'productId',
      'skuId',
      'quantity',
      'fulfillmentMode',
      'fulfillmentTargetHash',
      'regionCodeHash',
    ]);
    const quoteInput: CreateSeckillQuoteInput = {
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      sessionId: requiredString(body, 'sessionId'),
      productId: requiredString(body, 'productId'),
      skuId: requiredString(body, 'skuId'),
      quantity: requiredPositiveInteger(body, 'quantity'),
      fulfillmentMode: fulfillmentMode(body.fulfillmentMode),
      fulfillmentTargetHash: requiredString(body, 'fulfillmentTargetHash'),
      regionCodeHash: requiredString(body, 'regionCodeHash'),
    };
    await assertPaymentWritesEnabled(dependencies, ['NEW_PAYMENT', 'SECKILL_PURCHASE'], {
      buyerWallet: claims.sub,
      productId: quoteInput.productId,
      quantity: quoteInput.quantity,
    });
    sendJson(
      response,
      201,
      await dependencies.paymentService.createSeckillQuote(claims.sub, quoteInput),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/payments/submissions') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['orderId', 'txHash', 'replacementForTxHash']);
    sendJson(
      response,
      202,
      await dependencies.paymentService.submitPayment(claims.sub, {
        orderId: requiredString(body, 'orderId'),
        txHash: requiredString(body, 'txHash'),
        ...(body.replacementForTxHash === undefined
          ? {}
          : { replacementForTxHash: requiredString(body, 'replacementForTxHash') }),
      }),
      correlationId,
    );
    return;
  }
  const paymentOrderId = pathParameter(url.pathname, '/v2/payments/');
  if (request.method === 'GET' && paymentOrderId) {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      await dependencies.paymentService.getPayment(claims.sub, paymentOrderId),
      correlationId,
    );
    return;
  }
  throw new CoreError('InvalidRequest', 'Route not found', 404);
}

async function routeAdminServices(
  dependencies: ApiDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  correlationId: string,
) {
  const adminPaymentRecovery = url.pathname.match(
    /^\/v2\/admin\/payments\/(0x[0-9a-fA-F]{64})\/txhash-recovery$/,
  );
  if (request.method === 'POST' && adminPaymentRecovery) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, ['txHash', 'replacementForTxHash']);
    sendJson(
      response,
      202,
      await dependencies.paymentService.recoverPayment(fulfillmentActor(claims), {
        orderId: adminPaymentRecovery[1]!.toLowerCase(),
        txHash: requiredString(body, 'txHash'),
        ...(body.replacementForTxHash === undefined
          ? {}
          : { replacementForTxHash: requiredString(body, 'replacementForTxHash') }),
      }),
      correlationId,
    );
    return true;
  }
  const adminPaymentOrderId = pathParameter(url.pathname, '/v2/admin/payments/');
  if (request.method === 'GET' && adminPaymentOrderId) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.paymentService.getAdminPayment(fulfillmentActor(claims), adminPaymentOrderId),
      correlationId,
    );
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/settlement-requests') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.settlementService.listAdminRequests(
        fulfillmentActor(claims),
        adminSettlementRequestQuery(url),
      ),
      correlationId,
    );
    return true;
  }
  const adminSettlementRequestId = pathParameter(url.pathname, '/v2/admin/settlement-requests/');
  if (request.method === 'GET' && adminSettlementRequestId) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.settlementService.getAdminRequest(
        fulfillmentActor(claims),
        adminSettlementRequestId,
      ),
      correlationId,
    );
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/settlement-transfers') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.settlementService.listAdminTransfers(
        fulfillmentActor(claims),
        adminSettlementTransferQuery(url),
      ),
      correlationId,
    );
    return true;
  }
  const adminSettlementTransferId = pathParameter(url.pathname, '/v2/admin/settlement-transfers/');
  if (request.method === 'GET' && adminSettlementTransferId) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    sendJson(
      response,
      200,
      await dependencies.settlementService.getAdminTransfer(
        fulfillmentActor(claims),
        adminSettlementTransferId,
      ),
      correlationId,
    );
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/global/resources') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    assertOnlySearchParams(url, [
      'resourceType', 'orderId', 'productId', 'merchantId', 'txHash', 'uid', 'wallet',
      'relation', 'walletMatch', 'from', 'to', 'pendingReview', 'limit',
    ], ['resourceType']);
    sendJson(response, 200, await dependencies.adminGlobalOperationsService.search(
      fulfillmentActor(claims),
      adminGlobalSearchQuery(url),
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/global/exports') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    const body = await readJson(request);
    assertOnlyKeys(body, ['selection', 'format', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.adminGlobalOperationsService.exportSelection(
      fulfillmentActor(claims),
      adminExportRequest(body),
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/catalog/products/batch-tags') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['productIds', 'tagIds', 'idempotencyKey']);
    sendJson(response, 200, await dependencies.catalogManagementService.batchAddProductTags(
      platformCatalogActor(claims),
      {
        productIds: requiredStringArray(body, 'productIds'),
        tagIds: requiredStringArray(body, 'tagIds'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/catalog/products/batch-lifecycle') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['action', 'productIds', 'reasonCode', 'idempotencyKey']);
    sendJson(response, 200, await dependencies.catalogManagementService.batchProductLifecycle(
      platformCatalogActor(claims),
      {
        action: catalogReviewDecision(body.action),
        productIds: requiredStringArray(body, 'productIds'),
        reasonCode: requiredString(body, 'reasonCode'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return true;
  }
  if (url.pathname === '/v2/admin/merchants') {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      request.method === 'POST' ? ['ADMIN', 'OPERATOR'] : ['ADMIN', 'OPERATOR', 'AUDITOR'],
    );
    const actor = fulfillmentActor(claims);
    if (request.method === 'GET') {
      assertOnlySearchParams(url, ['status', 'search', 'limit', 'cursorCreatedAt', 'cursorMerchantId']);
      sendJson(response, 200, await dependencies.merchantLifecycleService.list(actor, {
        ...(url.searchParams.get('status')
          ? { status: merchantLifecycleStatus(url.searchParams.get('status')) }
          : {}),
        ...(url.searchParams.get('search') ? { search: url.searchParams.get('search')! } : {}),
        ...(url.searchParams.get('limit')
          ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
          : {}),
        ...(url.searchParams.get('cursorCreatedAt')
          ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
          : {}),
        ...(url.searchParams.get('cursorMerchantId')
          ? { cursorMerchantId: url.searchParams.get('cursorMerchantId')! }
          : {}),
      }), correlationId);
      return true;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      assertOnlyKeys(body, [
        'shopName', 'legalName', 'legalId', 'contactPhone', 'settlementWallet', 'idempotencyKey',
      ]);
      sendJson(response, 201, await dependencies.merchantLifecycleService.createApplication(actor, {
        shopName: requiredString(body, 'shopName'),
        legalName: requiredString(body, 'legalName'),
        legalId: requiredString(body, 'legalId'),
        contactPhone: requiredString(body, 'contactPhone'),
        settlementWallet: requiredString(body, 'settlementWallet'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      }), correlationId);
      return true;
    }
  }
  const merchantApplicationPath = url.pathname.match(/^\/v2\/admin\/merchants\/([^/]+)\/application$/);
  if (request.method === 'PUT' && merchantApplicationPath) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'shopName', 'legalName', 'legalId', 'contactPhone', 'licenseAssetId',
      'expectedVersion', 'idempotencyKey',
    ]);
    sendJson(response, 200, await dependencies.merchantLifecycleService.updateApplication(
      fulfillmentActor(claims),
      decodedPathPart(merchantApplicationPath[1]!),
      {
        shopName: requiredString(body, 'shopName'),
        legalName: requiredString(body, 'legalName'),
        legalId: requiredString(body, 'legalId'),
        contactPhone: requiredString(body, 'contactPhone'),
        licenseAssetId: nullableString(body, 'licenseAssetId'),
        expectedVersion: requiredPositiveInteger(body, 'expectedVersion'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      },
    ), correlationId);
    return true;
  }
  const merchantReviewChallengePath = url.pathname.match(/^\/v2\/admin\/merchants\/([^/]+)\/review-challenges$/);
  if (request.method === 'POST' && merchantReviewChallengePath) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['action', 'reasonCode', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.merchantLifecycleService.createReviewChallenge(
      fulfillmentActor(claims),
      decodedPathPart(merchantReviewChallengePath[1]!),
      {
        action: merchantReviewAction(body.action),
        reasonCode: requiredString(body, 'reasonCode'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      },
    ), correlationId);
    return true;
  }
  const merchantReviewPublishPath = url.pathname.match(
    /^\/v2\/admin\/merchants\/([^/]+)\/review-actions\/(0x[0-9a-fA-F]{64})\/publish$/,
  );
  if (request.method === 'POST' && merchantReviewPublishPath) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['signature']);
    sendJson(response, 200, await dependencies.merchantLifecycleService.publishReview(
      fulfillmentActor(claims),
      decodedPathPart(merchantReviewPublishPath[1]!),
      merchantReviewPublishPath[2]!.toLowerCase(),
      requiredString(body, 'signature'),
    ), correlationId);
    return true;
  }
  const merchantPath = matchResourceAction(url.pathname, '/v2/admin/merchants/');
  if (request.method === 'GET' && merchantPath && merchantPath.action === undefined) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    assertOnlySearchParams(url, []);
    sendJson(response, 200, await dependencies.merchantLifecycleService.get(
      fulfillmentActor(claims),
      merchantPath.resourceId,
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/seckill/actions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.seckillOperationsService.list(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/seckill/sessions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'policyVersion', 'rulesContentHash', 'productId', 'skuId', 'inventory',
      'seckillListPriceUsdt', 'startsAt', 'idempotencyKey',
    ]);
    const productId = requiredString(body, 'productId');
    const inventory = requiredPositiveInteger(body, 'inventory');
    const seckillListPriceUsdt = requiredString(body, 'seckillListPriceUsdt');
    await assertSeckillSessionWritesEnabled(dependencies, { productId, inventory, seckillListPriceUsdt });
    sendJson(response, 201, await dependencies.seckillOperationsService.createSession(fulfillmentActor(claims), {
      policyVersion: requiredString(body, 'policyVersion'),
      rulesContentHash: requiredString(body, 'rulesContentHash'),
      productId,
      skuId: requiredString(body, 'skuId'),
      inventory,
      seckillListPriceUsdt,
      startsAt: requiredString(body, 'startsAt'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/seckill/prize-reorgs') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    assertOnlySearchParams(url, []);
    sendJson(response, 200, await dependencies.seckillOperationsService.listPrizeReorgExposures(
      fulfillmentActor(claims),
    ), correlationId);
    return true;
  }
  const prizeReorgExposure = url.pathname.match(
    /^\/v2\/admin\/seckill\/prize-reorgs\/(0x[0-9a-fA-F]{64})$/,
  );
  if (request.method === 'GET' && prizeReorgExposure) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    assertOnlySearchParams(url, []);
    sendJson(response, 200, await dependencies.seckillOperationsService.getPrizeReorgExposure(
      fulfillmentActor(claims),
      prizeReorgExposure[1]!.toLowerCase(),
    ), correlationId);
    return true;
  }
  const prizeRecoveryAction = url.pathname.match(
    /^\/v2\/admin\/seckill\/prize-reorgs\/(0x[0-9a-fA-F]{64})\/(recovery-challenge|recovery)$/,
  );
  if (request.method === 'POST' && prizeRecoveryAction) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    const exposureId = prizeRecoveryAction[1]!.toLowerCase();
    if (prizeRecoveryAction[2] === 'recovery-challenge') {
      assertOnlyKeys(body, ['nonce', 'deadline']);
      sendJson(response, 200, await dependencies.seckillOperationsService.prizeRecoveryChallenge(
        fulfillmentActor(claims),
        exposureId,
        {
          nonce: requiredString(body, 'nonce'),
          deadline: requiredString(body, 'deadline'),
        },
      ), correlationId);
      return true;
    }
    assertOnlyKeys(body, ['snapshotId', 'nonce', 'deadline', 'signature']);
    sendJson(response, 201, await dependencies.seckillOperationsService.submitPrizeRecovery(
      fulfillmentActor(claims),
      exposureId,
      {
        snapshotId: requiredString(body, 'snapshotId'),
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
        signature: requiredString(body, 'signature'),
        correlationId,
      },
    ), correlationId);
    return true;
  }
  const seckillSessionAction = url.pathname.match(
    /^\/v2\/admin\/seckill\/sessions\/(0x[0-9a-fA-F]{64})\/(force-close|prize-injections|winner-review)$/,
  );
  if (request.method === 'POST' && seckillSessionAction) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    const sessionId = seckillSessionAction[1]!.toLowerCase();
    if (seckillSessionAction[2] === 'winner-review') {
      assertOnlyKeys(body, ['decision', 'reasonCode', 'evidenceHash', 'idempotencyKey']);
      const decision = requiredString(body, 'decision');
      if (decision !== 'APPROVE' && decision !== 'REJECT') {
        throw new CoreError('InvalidRequest', 'Winner review decision must be APPROVE or REJECT');
      }
      sendJson(response, 200, await dependencies.seckillOperationsService.reviewWinner(
        fulfillmentActor(claims),
        sessionId,
        {
          decision,
          reasonCode: requiredString(body, 'reasonCode'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          correlationId,
        },
      ), correlationId);
      return true;
    }
    if (seckillSessionAction[2] === 'force-close') {
      assertOnlyKeys(body, ['reasonCode', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.seckillOperationsService.createForceClose(
        fulfillmentActor(claims),
        sessionId,
        {
          reasonCode: requiredString(body, 'reasonCode'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          correlationId,
        },
      ), correlationId);
      return true;
    }
    assertOnlyKeys(body, ['amountUsdt', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.seckillOperationsService.createPrizeInjection(
      fulfillmentActor(claims),
      sessionId,
      {
        amountUsdt: requiredString(body, 'amountUsdt'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        correlationId,
      },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/seckill/breaker/resume') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['sessionId', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.seckillOperationsService.createResume(fulfillmentActor(claims), {
      sessionId: requiredString(body, 'sessionId'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const seckillGovernanceAction = url.pathname.match(
    /^\/v2\/admin\/seckill\/actions\/(0x[0-9a-fA-F]{64})(?:\/(approval-challenge|secondary-signature|execute|cancel))?$/,
  );
  if (seckillGovernanceAction) {
    const actionName = seckillGovernanceAction[2];
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      request.method === 'GET' && !actionName ? ['ADMIN', 'OPERATOR', 'AUDITOR'] : ['ADMIN'],
    );
    const actor = fulfillmentActor(claims);
    const actionId = seckillGovernanceAction[1]!.toLowerCase();
    if (request.method === 'GET' && !actionName) {
      sendJson(response, 200, await dependencies.seckillOperationsService.get(actor, actionId), correlationId);
      return true;
    }
    if (request.method === 'POST' && actionName === 'approval-challenge') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['nonce', 'deadline']);
      sendJson(response, 200, await dependencies.seckillOperationsService.approvalChallenge(actor, actionId, {
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
      }), correlationId);
      return true;
    }
    if (request.method === 'POST' && actionName === 'secondary-signature') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['nonce', 'deadline', 'signature']);
      sendJson(response, 200, await dependencies.seckillOperationsService.submitApproval(actor, actionId, {
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
        signature: requiredString(body, 'signature'),
        correlationId,
      }), correlationId);
      return true;
    }
    if (request.method === 'POST' && actionName === 'execute') {
      const body = await readJson(request);
      assertOnlyKeys(body, []);
      sendJson(response, 202, await dependencies.seckillOperationsService.execute(actor, actionId, correlationId), correlationId);
      return true;
    }
    if (request.method === 'POST' && actionName === 'cancel') {
      const body = await readJson(request);
      assertOnlyKeys(body, []);
      sendJson(response, 200, await dependencies.seckillOperationsService.cancel(actor, actionId, { correlationId }), correlationId);
      return true;
    }
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/catalog/categories') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, {
      categories: await dependencies.catalogManagementService.listCategories(true, platformCatalogActor(claims)),
    }, correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/catalog/categories') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 201, await dependencies.catalogManagementService.upsertCategory(
      platformCatalogActor(claims),
      categoryInput(body),
    ), correlationId);
    return true;
  }
  const categoryId = pathParameter(url.pathname, '/v2/admin/catalog/categories/');
  if (request.method === 'PUT' && categoryId) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 200, await dependencies.catalogManagementService.upsertCategory(
      platformCatalogActor(claims),
      { ...categoryInput(body), categoryId },
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/catalog/tags') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, {
      tags: await dependencies.catalogManagementService.listTags(true, platformCatalogActor(claims)),
    }, correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/catalog/tags') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 201, await dependencies.catalogManagementService.upsertTag(
      platformCatalogActor(claims),
      tagInput(body),
    ), correlationId);
    return true;
  }
  const tagId = pathParameter(url.pathname, '/v2/admin/catalog/tags/');
  if (request.method === 'PUT' && tagId) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    sendJson(response, 200, await dependencies.catalogManagementService.upsertTag(
      platformCatalogActor(claims),
      { ...tagInput(body), tagId },
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/catalog/products') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, {
      products: await dependencies.catalogManagementService.listAdminProducts(platformCatalogActor(claims)),
    }, correlationId);
    return true;
  }
  const adminSlot = /^\/v2\/admin\/catalog\/stores\/([^/]+)\/product-slot$/.exec(url.pathname);
  if (adminSlot && (request.method === 'GET' || request.method === 'PUT')) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      request.method === 'GET' ? ['ADMIN', 'OPERATOR', 'AUDITOR'] : ['ADMIN', 'OPERATOR'],
    );
    const storeId = decodedPathPart(adminSlot[1]!);
    const actor = platformCatalogActor(claims);
    const merchantId = url.searchParams.get('merchantId') ?? undefined;
    if (request.method === 'GET') {
      sendJson(response, 200, await dependencies.catalogManagementService.getProductSlot(actor, storeId, merchantId), correlationId);
      return true;
    }
    const body = await readJson(request);
    assertOnlyKeys(body, ['merchantId', ...PRODUCT_SLOT_KEYS]);
    sendJson(response, 200, await dependencies.catalogManagementService.saveProductSlot(
      actor,
      storeId,
      productSlotInput(body, true),
      requiredString(body, 'merchantId'),
    ), correlationId);
    return true;
  }
  const adminProduct = matchResourceAction(url.pathname, '/v2/admin/catalog/products/');
  if (request.method === 'POST' && adminProduct?.action) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const actor = platformCatalogActor(claims);
    const body = await readJson(request);
    if (adminProduct.action === 'concession-previews') {
      assertOnlyKeys(body, ['merchantConcessionBps', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.catalogManagementService.createConcessionPreview(
        actor,
        adminProduct.resourceId,
        {
          merchantConcessionBps: requiredBps(body, 'merchantConcessionBps'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return true;
    }
    if (adminProduct.action === 'review-decisions') {
      assertOnlyKeys(body, ['decision', 'reasonCode', 'idempotencyKey']);
      sendJson(response, 200, await dependencies.catalogManagementService.decideReview(
        actor,
        adminProduct.resourceId,
        {
          decision: catalogReviewDecision(body.decision),
          reasonCode: requiredString(body, 'reasonCode'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return true;
    }
    if (adminProduct.action === 'review-submissions') {
      assertOnlyKeys(body, ['previewId', 'idempotencyKey']);
      sendJson(response, 201, await dependencies.catalogManagementService.submitReview(
        actor,
        adminProduct.resourceId,
        {
          previewId: requiredString(body, 'previewId'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return true;
    }
    if (adminProduct.action === 'delist') {
      assertOnlyKeys(body, ['reasonCode', 'idempotencyKey']);
      sendJson(response, 200, await dependencies.catalogManagementService.delistProduct(
        actor,
        adminProduct.resourceId,
        {
          reasonCode: requiredString(body, 'reasonCode'),
          idempotencyKey: requiredString(body, 'idempotencyKey'),
        },
      ), correlationId);
      return true;
    }
  }
  const adminSku = matchResourceAction(url.pathname, '/v2/admin/catalog/skus/');
  if (request.method === 'POST' && adminSku?.action === 'inventory-adjustments') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['delta', 'reasonCode', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.catalogManagementService.adjustInventory(
      platformCatalogActor(claims),
      adminSku.resourceId,
      {
        delta: requiredString(body, 'delta'),
        reasonCode: requiredString(body, 'reasonCode'),
        idempotencyKey: requiredString(body, 'idempotencyKey'),
      },
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/cms/public') {
    if ([...url.searchParams].length !== 0) {
      throw new CoreError('InvalidRequest', 'CMS audience context cannot be supplied by the caller');
    }
    const claims = request.headers.authorization
      ? authorize(request, dependencies.config, dependencies.clock())
      : undefined;
    sendJson(response, 200, await dependencies.cmsService.listPublished({
      ...(claims ? { actor: fulfillmentActor(claims) } : {}),
      now: dependencies.clock(),
    }), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/notification-endpoints') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['channel', 'provider', 'endpointReference', 'topics', 'regionCode']);
    sendJson(response, 201, await dependencies.notificationService.registerEndpoint(fulfillmentActor(claims), {
      channel: notificationChannel(body.channel),
      provider: notificationProvider(body.provider),
      endpointReference: requiredString(body, 'endpointReference'),
      topics: requiredStringArray(body, 'topics'),
      ...(body.regionCode === undefined ? {} : { regionCode: requiredString(body, 'regionCode') }),
      correlationId,
    }), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/notifications') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      await dependencies.notificationService.listInbox(
        fulfillmentActor(claims),
        optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit'),
      ),
      correlationId,
    );
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/policy-drafts') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.policyService.listDrafts(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/coverage-breaker/actions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.coverageBreakerService.listActions(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/risk/overview') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.riskService.listOverview(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/risk/restrictions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'subjectType', 'subjectValue', 'restrictionKind', 'reasonCode',
      'evidenceHash', 'expiresAt', 'idempotencyKey',
    ]);
    sendJson(response, 201, await dependencies.riskService.createManualRestriction(fulfillmentActor(claims), {
      subjectType: riskSubjectType(body.subjectType),
      subjectValue: requiredString(body, 'subjectValue'),
      restrictionKind: riskRestrictionKind(body.restrictionKind),
      reasonCode: requiredString(body, 'reasonCode'),
      evidenceHash: requiredString(body, 'evidenceHash'),
      ...(body.expiresAt === undefined ? {} : { expiresAt: requiredString(body, 'expiresAt') }),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const restrictionOverride = url.pathname.match(/^\/v2\/admin\/risk\/restrictions\/(0x[0-9a-fA-F]{64})\/override$/);
  if (request.method === 'POST' && restrictionOverride) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['reasonCode', 'evidenceHash']);
    sendJson(response, 200, await dependencies.riskService.overrideRestriction(
      fulfillmentActor(claims),
      restrictionOverride[1]!.toLowerCase(),
      { reasonCode: requiredString(body, 'reasonCode'), evidenceHash: requiredString(body, 'evidenceHash'), correlationId },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/risk/appeals') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['restrictionId', 'statementHash', 'evidenceHash', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.riskService.submitAppeal(fulfillmentActor(claims), {
      restrictionId: requiredString(body, 'restrictionId'),
      statementHash: requiredString(body, 'statementHash'),
      evidenceHash: requiredString(body, 'evidenceHash'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const appealDecision = url.pathname.match(/^\/v2\/admin\/risk\/appeals\/(0x[0-9a-fA-F]{64})\/decision$/);
  if (request.method === 'POST' && appealDecision) {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['decision', 'reasonCode', 'evidenceHash']);
    sendJson(response, 200, await dependencies.riskService.decideAppeal(
      fulfillmentActor(claims),
      appealDecision[1]!.toLowerCase(),
      {
        decision: riskAppealDecision(body.decision),
        reasonCode: requiredString(body, 'reasonCode'),
        evidenceHash: requiredString(body, 'evidenceHash'),
        correlationId,
      },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/coverage-breaker/resume-challenge') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['nonce', 'deadline']);
    sendJson(response, 200, await dependencies.coverageBreakerService.resumeChallenge(fulfillmentActor(claims), {
      nonce: requiredString(body, 'nonce'),
      deadline: requiredString(body, 'deadline'),
    }), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/coverage-breaker/resume-actions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['snapshotId', 'nonce', 'deadline', 'signature']);
    sendJson(response, 201, await dependencies.coverageBreakerService.submitResume(fulfillmentActor(claims), {
      snapshotId: requiredString(body, 'snapshotId'),
      nonce: requiredString(body, 'nonce'),
      deadline: requiredString(body, 'deadline'),
      signature: requiredString(body, 'signature'),
      correlationId,
    }), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/policy-drafts') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['payload', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.policyService.createDraft(fulfillmentActor(claims), {
      payload: requiredObject(body, 'payload'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const policyPath = matchResourceAction(url.pathname, '/v2/admin/policy-drafts/');
  if (policyPath) {
    const allowedRoles = request.method === 'GET'
      ? ['ADMIN', 'OPERATOR', 'AUDITOR'] as const
      : policyPath.action === 'approval-challenge'
        || policyPath.action === 'secondary-signature'
        || policyPath.action === 'execute'
        ? ['ADMIN'] as const
        : ['ADMIN', 'OPERATOR'] as const;
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), allowedRoles);
    const actor = fulfillmentActor(claims);
    if (request.method === 'GET' && !policyPath.action) {
      sendJson(response, 200, await dependencies.policyService.getDraft(actor, policyPath.resourceId), correlationId);
      return true;
    }
    if (request.method === 'PUT' && !policyPath.action) {
      const body = await readJson(request);
      assertOnlyKeys(body, ['payload']);
      sendJson(response, 200, await dependencies.policyService.updateDraft(actor, policyPath.resourceId, {
        payload: requiredObject(body, 'payload'),
        correlationId,
      }), correlationId);
      return true;
    }
    if (request.method === 'POST' && policyPath.action === 'approval-challenge') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['nonce', 'deadline']);
      sendJson(response, 200, await dependencies.policyService.approvalChallenge(actor, policyPath.resourceId, {
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
      }), correlationId);
      return true;
    }
    if (request.method === 'POST' && policyPath.action === 'secondary-signature') {
      const body = await readJson(request);
      assertOnlyKeys(body, ['nonce', 'deadline', 'signature']);
      sendJson(response, 200, await dependencies.policyService.submitSecondarySignature(actor, policyPath.resourceId, {
        nonce: requiredString(body, 'nonce'),
        deadline: requiredString(body, 'deadline'),
        signature: requiredString(body, 'signature'),
        correlationId,
      }), correlationId);
      return true;
    }
    if (request.method === 'POST' && policyPath.action === 'execute') {
      const body = await readJson(request);
      assertOnlyKeys(body, []);
      sendJson(
        response,
        202,
        await dependencies.policyService.execute(actor, policyPath.resourceId, correlationId),
        correlationId,
      );
      return true;
    }
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/cms/versions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'entryId', 'slug', 'contentType', 'placement', 'locale', 'contentFormat',
      'content', 'audience', 'startsAt', 'endsAt', 'frequencyCap', 'policyVersion',
      'idempotencyKey',
    ]);
    sendJson(response, 201, await dependencies.cmsService.createVersion(fulfillmentActor(claims), {
      ...(body.entryId === undefined ? {} : { entryId: requiredString(body, 'entryId') }),
      slug: requiredString(body, 'slug'),
      contentType: cmsContentType(body.contentType),
      placement: requiredString(body, 'placement'),
      locale: requiredString(body, 'locale'),
      contentFormat: cmsContentFormat(body.contentFormat),
      content: requiredObject(body, 'content'),
      audience: requiredObject(body, 'audience'),
      ...(body.startsAt === undefined ? {} : { startsAt: requiredString(body, 'startsAt') }),
      ...(body.endsAt === undefined ? {} : { endsAt: requiredString(body, 'endsAt') }),
      ...(body.frequencyCap === undefined ? {} : { frequencyCap: requiredPositiveInteger(body, 'frequencyCap') }),
      ...(body.policyVersion === undefined ? {} : { policyVersion: requiredString(body, 'policyVersion') }),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const cmsPath = matchResourceAction(url.pathname, '/v2/admin/cms/versions/');
  if (cmsPath) {
    const claims = authorizeRoles(
      request,
      dependencies.config,
      dependencies.clock(),
      request.method === 'GET' ? ['ADMIN', 'OPERATOR', 'AUDITOR'] : ['ADMIN', 'OPERATOR'],
    );
    const actor = fulfillmentActor(claims);
    if (request.method === 'GET' && !cmsPath.action) {
      sendJson(response, 200, await dependencies.cmsService.getVersion(actor, cmsPath.resourceId), correlationId);
      return true;
    }
    if (request.method === 'POST' && (cmsPath.action === 'publish' || cmsPath.action === 'rollback')) {
      const body = await readJson(request);
      assertOnlyKeys(body, ['evidenceHash']);
      const input = { evidenceHash: requiredString(body, 'evidenceHash'), correlationId };
      const result = cmsPath.action === 'publish'
        ? await dependencies.cmsService.publish(actor, cmsPath.resourceId, input)
        : await dependencies.cmsService.rollback(actor, cmsPath.resourceId, input);
      sendJson(response, 200, result, correlationId);
      return true;
    }
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/notification-campaigns') {
    assertOnlySearchParams(url, ['limit']);
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.notificationService.listCampaigns(
      fulfillmentActor(claims),
      optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit'),
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/notification-campaigns') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['topic', 'audience', 'message', 'cmsVersionId', 'startsAt', 'endsAt', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.notificationService.createCampaign(fulfillmentActor(claims), {
      topic: notificationCampaignTopic(body.topic),
      audience: requiredObject(body, 'audience'),
      message: requiredObject(body, 'message'),
      ...(body.cmsVersionId === undefined ? {} : { cmsVersionId: requiredString(body, 'cmsVersionId') }),
      ...(body.startsAt === undefined ? {} : { startsAt: requiredString(body, 'startsAt') }),
      ...(body.endsAt === undefined ? {} : { endsAt: requiredString(body, 'endsAt') }),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const campaignPath = matchResourceAction(url.pathname, '/v2/admin/notification-campaigns/');
  if (request.method === 'POST' && campaignPath?.action === 'publish') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['evidenceHash']);
    sendJson(response, 200, await dependencies.notificationService.publishCampaign(
      fulfillmentActor(claims),
      campaignPath.resourceId,
      { evidenceHash: requiredString(body, 'evidenceHash'), correlationId },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && campaignPath?.action === 'retry-failed') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, []);
    sendJson(response, 200, await dependencies.notificationService.retryCampaignDeliveries(
      fulfillmentActor(claims),
      campaignPath.resourceId,
      { correlationId },
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/system-config/versions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.systemConfigService.list(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/admin/system-config/versions') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['configKey', 'payload', 'effectiveFrom', 'idempotencyKey']);
    sendJson(response, 201, await dependencies.systemConfigService.createVersion(fulfillmentActor(claims), {
      configKey: systemConfigKey(body.configKey),
      payload: requiredObject(body, 'payload'),
      effectiveFrom: requiredString(body, 'effectiveFrom'),
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      correlationId,
    }), correlationId);
    return true;
  }
  const configPath = matchResourceAction(url.pathname, '/v2/admin/system-config/versions/');
  if (request.method === 'POST' && configPath?.action === 'approval-challenge') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['nonce', 'deadline']);
    sendJson(response, 200, await dependencies.systemConfigService.approvalChallenge(
      fulfillmentActor(claims),
      configPath.resourceId,
      { nonce: requiredString(body, 'nonce'), deadline: requiredString(body, 'deadline') },
    ), correlationId);
    return true;
  }
  if (request.method === 'POST' && configPath?.action === 'publish') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN']);
    const body = await readJson(request);
    assertOnlyKeys(body, ['approval']);
    const approval = sensitiveApproval(requiredObject(body, 'approval'));
    sendJson(response, 200, await dependencies.systemConfigService.publish(
      fulfillmentActor(claims),
      configPath.resourceId,
      approval,
    ), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/audit/entries') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'AUDITOR']);
    const query: AuditQuery = {
      ...(url.searchParams.get('streamName') ? { streamName: auditStream(url.searchParams.get('streamName')) } : {}),
      ...(url.searchParams.get('eventType') ? { eventType: url.searchParams.get('eventType')! } : {}),
      ...(url.searchParams.get('resourceType') ? { resourceType: url.searchParams.get('resourceType')! } : {}),
      ...(url.searchParams.get('resourceId') ? { resourceId: url.searchParams.get('resourceId')! } : {}),
      ...(url.searchParams.get('actorWallet') ? { actorWallet: url.searchParams.get('actorWallet')! } : {}),
      ...(url.searchParams.get('correlationId') ? { correlationId: url.searchParams.get('correlationId')! } : {}),
      ...(url.searchParams.get('from') ? { from: dateParameter(url.searchParams.get('from')!, 'from') } : {}),
      ...(url.searchParams.get('to') ? { to: dateParameter(url.searchParams.get('to')!, 'to') } : {}),
      ...(url.searchParams.get('cursorCreatedAt')
        ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
        : {}),
      ...(url.searchParams.get('cursorEntryId') ? { cursorEntryId: url.searchParams.get('cursorEntryId')! } : {}),
      ...(url.searchParams.get('limit') ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! } : {}),
    };
    sendJson(response, 200, await dependencies.auditService.list(fulfillmentActor(claims), query), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/monitoring') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(response, 200, await dependencies.monitoringService.dashboard(fulfillmentActor(claims)), correlationId);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/v2/admin/dashboard') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR', 'AUDITOR']);
    sendJson(
      response,
      200,
      await dependencies.businessAnalyticsService.adminDashboard(fulfillmentActor(claims)),
      correlationId,
    );
    return true;
  }
  const alertPath = matchResourceAction(url.pathname, '/v2/admin/monitoring/alerts/');
  if (request.method === 'POST' && alertPath?.action === 'acknowledge') {
    const claims = authorizeRoles(request, dependencies.config, dependencies.clock(), ['ADMIN', 'OPERATOR']);
    const body = await readJson(request);
    assertOnlyKeys(body, []);
    sendJson(response, 200, await dependencies.monitoringService.acknowledge(
      fulfillmentActor(claims),
      alertPath.resourceId,
      correlationId,
    ), correlationId);
    return true;
  }
  return false;
}

function authorize(request: IncomingMessage, config: CoreConfig, now: Date) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !config.jwtSecret) {
    throw new CoreError('Unauthorized', 'Bearer session is required', 401);
  }
  return verifySessionToken(header.slice('Bearer '.length), config.jwtSecret, now);
}

function authorizeRoles(
  request: IncomingMessage,
  config: CoreConfig,
  now: Date,
  allowed: readonly UserRole[],
) {
  const claims = authorize(request, config, now);
  requireRole(claims, allowed);
  return claims;
}

function authorizeBuyer(request: IncomingMessage, config: CoreConfig, now: Date) {
  const claims = authorize(request, config, now);
  if (!claims.roles.includes('BUYER')) throw new CoreError('Forbidden', 'Buyer role is required', 403);
  return claims;
}

async function assertPaymentWritesEnabled(
  dependencies: ApiDependencies,
  scopes: readonly ('NEW_PAYMENT' | 'SECKILL_PURCHASE')[],
  context?: PaymentWriteContext,
) {
  const now = dependencies.clock();
  const readiness = publicReadiness(
    dependencies.config,
    currentRuntimeReadiness(dependencies),
    now,
  );
  if (readiness.writesEnabled) {
    await assertPaymentBreakersOpen(dependencies, scopes);
    return;
  }
  if (allowsBoundedMainnetMicrotestPaymentWrite(dependencies.config, readiness, now, context)) {
    await assertPaymentBreakersOpen(dependencies, scopes);
    return;
  }
  if (readiness.paymentDecisionBlocked.length > 0) {
    throw new CoreError('DecisionBlocked', 'New payment quotes are blocked by unresolved payment policy', 409, {
      blocked: readiness.paymentDecisionBlocked,
    });
  }
  if (readiness.paymentExternalBlocked.length > 0) {
    throw new CoreError('ExternalBlocked', 'New payment quotes are blocked by unavailable payment infrastructure', 503, {
      blocked: readiness.paymentExternalBlocked,
    });
  }
  throw new CoreError('ConfigurationRequired', 'New payment quotes require a fresh verified runtime readiness snapshot', 503);
}

async function assertPaymentBreakersOpen(
  dependencies: ApiDependencies,
  scopes: readonly ('NEW_PAYMENT' | 'SECKILL_PURCHASE')[],
) {
  const paused = await dependencies.getPausedScopes();
  const active = scopes.filter((scope) => paused.has(scope));
  if (active.length > 0) {
    throw new CoreError('BreakerActive', 'New payment quote is paused', 409, { scopes: active });
  }
}

async function assertSeckillSessionWritesEnabled(
  dependencies: ApiDependencies,
  input: { productId: string; inventory: number; seckillListPriceUsdt: string },
) {
  const now = dependencies.clock();
  const readiness = publicReadiness(
    dependencies.config,
    currentRuntimeReadiness(dependencies),
    now,
  );
  if (readiness.writesEnabled) {
    await assertPaymentBreakersOpen(dependencies, ['NEW_PAYMENT', 'SECKILL_PURCHASE']);
    return;
  }
  const entitlement = dependencies.config.mainnetMicrotestEntitlement;
  const seckillPrice = /^(0|[1-9][0-9]*)$/.test(input.seckillListPriceUsdt)
    ? BigInt(input.seckillListPriceUsdt)
    : undefined;
  if (
    entitlement
    && dependencies.config.releaseAuthorization?.status === 'MICROTEST_AUTHORIZED'
    && now < entitlement.expiresAt
    && input.productId === entitlement.productId
    && input.inventory === entitlement.seckillInventory
    && seckillPrice !== undefined
    && seckillPrice <= entitlement.maxListPriceUsdt
    && readiness.paymentDecisionBlocked.length === 0
    && readiness.paymentExternalBlocked.length === 1
    && readiness.paymentExternalBlocked[0] === 'COORDINATED_DEPLOYMENT_AUTHORIZATION'
    && readiness.runtimeBlockers.length === 1
    && readiness.runtimeBlockers[0] === 'PAYMENT_CONFIGURATION_REQUIRED'
  ) {
    await assertPaymentBreakersOpen(dependencies, ['NEW_PAYMENT', 'SECKILL_PURCHASE']);
    return;
  }
  await assertPaymentWritesEnabled(dependencies, ['NEW_PAYMENT', 'SECKILL_PURCHASE']);
}

export function allowsBoundedMainnetMicrotestPaymentWrite(
  config: CoreConfig,
  readiness: ReturnType<typeof publicReadiness>,
  now: Date,
  context?: PaymentWriteContext,
) {
  const entitlement = config.mainnetMicrotestEntitlement;
  if (!context || !entitlement || now >= entitlement.expiresAt) return false;
  if (
    context.quantity !== 1
    || context.productId !== entitlement.productId
    || !entitlement.buyerWallets.has(normalizeAddress(context.buyerWallet))
  ) return false;
  if (config.releaseAuthorization?.status !== 'MICROTEST_AUTHORIZED') return false;
  return readiness.paymentDecisionBlocked.length === 0
    && readiness.paymentExternalBlocked.length === 1
    && readiness.paymentExternalBlocked[0] === 'COORDINATED_DEPLOYMENT_AUTHORIZATION'
    && readiness.runtimeBlockers.length === 1
    && readiness.runtimeBlockers[0] === 'PAYMENT_CONFIGURATION_REQUIRED';
}

function currentRuntimeReadiness(dependencies: ApiDependencies) {
  return typeof dependencies.runtimeReadiness === 'function'
    ? dependencies.runtimeReadiness()
    : dependencies.runtimeReadiness;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new CoreError('InvalidRequest', 'Request contains unsupported fields', 400, { unexpected });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return parseJsonBody(await readBody(request));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new CoreError('InvalidRequest', 'Request body is too large', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid JSON body');
  }
}

function requiredString(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('InvalidRequest', `${name} is required`);
  return value;
}

function requiredEnum<const Values extends readonly string[]>(
  body: Record<string, unknown>,
  name: string,
  values: Values,
): Values[number] {
  const value = requiredString(body, name);
  if (!values.includes(value)) throw new CoreError('InvalidRequest', `${name} is unsupported`);
  return value as Values[number];
}

function requireInternalRiskToken(request: IncomingMessage, expected: string | undefined) {
  if (!expected) throw new CoreError('ConfigurationRequired', 'Risk observation transport is not configured', 503);
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const left = createHash('sha256').update(supplied).digest();
  const right = createHash('sha256').update(expected).digest();
  if (!supplied || !timingSafeEqual(left, right)) throw new CoreError('Unauthorized', 'Risk observation token is invalid', 401);
}

function riskSignalType(value: unknown): RiskObservationInput['signalType'] {
  if (!['HIGH_GAS', 'WALLET_CONTEXT', 'ORDER_CANCELLATION'].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported risk signal');
  return value as RiskObservationInput['signalType'];
}

function riskSourceType(value: unknown): RiskObservationInput['sourceType'] {
  if (!['CHAIN_MONITOR', 'EDGE_AUTH', 'ORDER_SERVICE'].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported risk source');
  return value as RiskObservationInput['sourceType'];
}

function riskSubjectType(value: unknown): RiskSubjectType {
  if (!['WALLET', 'IP', 'DEVICE'].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported risk subject');
  return value as RiskSubjectType;
}

function riskRestrictionKind(value: unknown): 'NEW_PAYMENT' | 'BLACKLIST' {
  if (!['NEW_PAYMENT', 'BLACKLIST'].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported risk restriction');
  return value as 'NEW_PAYMENT' | 'BLACKLIST';
}

function riskAppealDecision(value: unknown): 'APPROVE' | 'REJECT' {
  if (!['APPROVE', 'REJECT'].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported risk appeal decision');
  return value as 'APPROVE' | 'REJECT';
}

function nullableString(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoreError('InvalidRequest', `${name} must be a non-empty string or null`);
  }
  return value;
}

function requiredObject(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidRequest', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function productSlotInput(body: Record<string, unknown>, allowMerchantId = false): ProductSlotInput {
  assertOnlyKeys(body, allowMerchantId ? ['merchantId', ...PRODUCT_SLOT_KEYS] : PRODUCT_SLOT_KEYS);
  if (!Array.isArray(body.skus)) throw new CoreError('InvalidRequest', 'skus must be an array');
  const skus = body.skus.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CoreError('InvalidRequest', `skus[${index}] must be an object`);
    }
    const sku = value as Record<string, unknown>;
    assertOnlyKeys(sku, [
      'skuId', 'attributes', 'listPriceUsdt', 'stockTotal',
      'proposedSeckillInventory',
    ]);
    return {
      ...(sku.skuId === undefined ? {} : { skuId: requiredString(sku, 'skuId') }),
      attributes: requiredObject(sku, 'attributes'),
      listPriceUsdt: requiredString(sku, 'listPriceUsdt'),
      stockTotal: requiredPositiveInteger(sku, 'stockTotal'),
      proposedSeckillInventory: requiredPositiveInteger(sku, 'proposedSeckillInventory'),
    };
  });
  return {
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    title: requiredString(body, 'title'),
    ...(body.subtitle === undefined ? {} : { subtitle: requiredString(body, 'subtitle') }),
    ...(body.mainImageAssetIds === undefined ? {} : { mainImageAssetIds: requiredStringArray(body, 'mainImageAssetIds') }),
    ...(body.videoAssetId === undefined ? {} : { videoAssetId: requiredString(body, 'videoAssetId') }),
    richDetail: requiredObject(body, 'richDetail'),
    defaultFreightUsdt: requiredString(body, 'defaultFreightUsdt'),
    merchantConcessionBps: requiredBps(body, 'merchantConcessionBps'),
    fulfillmentModes: fulfillmentModes(body.fulfillmentModes),
    ...(body.categoryId === undefined ? {} : { categoryId: requiredString(body, 'categoryId') }),
    ...(body.tagIds === undefined ? {} : { tagIds: requiredStringArray(body, 'tagIds') }),
    skus,
  };
}

function fulfillmentOrderPageQuery(url: URL): OrderPageQuery {
  const state = url.searchParams.get('state');
  const orderKind = url.searchParams.get('orderKind');
  return {
    ...(url.searchParams.get('cursorCreatedAt')
      ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
      : {}),
    ...(url.searchParams.get('cursorOrderId')
      ? { cursorOrderId: url.searchParams.get('cursorOrderId')! }
      : {}),
    ...(url.searchParams.get('limit')
      ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
      : {}),
    ...(url.searchParams.get('from')
      ? { from: dateParameter(url.searchParams.get('from')!, 'from') }
      : {}),
    ...(url.searchParams.get('to')
      ? { to: dateParameter(url.searchParams.get('to')!, 'to') }
      : {}),
    ...(url.searchParams.get('skuId') ? { skuId: url.searchParams.get('skuId')! } : {}),
    ...(url.searchParams.get('wallet') ? { wallet: url.searchParams.get('wallet')! } : {}),
    ...(state ? { state: orderStateParameter(state) } : {}),
    ...(url.searchParams.get('fulfillmentMode')
      ? { fulfillmentMode: fulfillmentMode(url.searchParams.get('fulfillmentMode')) }
      : {}),
    ...(orderKind ? { orderKind: orderKindParameter(orderKind) } : {}),
  };
}

function orderStatementQuery(url: URL): OrderStatementQuery {
  assertOnlySearchParams(url, ['kind', 'cursorCreatedAt', 'cursorOrderId', 'limit']);
  return {
    ...(url.searchParams.get('kind') ? { kind: orderKindParameter(url.searchParams.get('kind')!) } : {}),
    ...(url.searchParams.get('cursorCreatedAt')
      ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
      : {}),
    ...(url.searchParams.get('cursorOrderId')
      ? { cursorOrderId: url.searchParams.get('cursorOrderId')! }
      : {}),
    ...(url.searchParams.get('limit')
      ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
      : {}),
  };
}

function merchantOrderExportInput(body: Record<string, unknown>): MerchantOrderExportInput {
  assertOnlyKeys(body, [
    'from', 'to', 'skuId', 'state', 'fulfillmentMode', 'orderKind',
    'cursorCreatedAt', 'cursorOrderId', 'limit', 'idempotencyKey',
  ]);
  return {
    ...(body.from === undefined ? {} : { from: requiredDate(body, 'from') }),
    ...(body.to === undefined ? {} : { to: requiredDate(body, 'to') }),
    ...(body.skuId === undefined ? {} : { skuId: requiredString(body, 'skuId') }),
    ...(body.state === undefined ? {} : { state: orderStateParameter(requiredString(body, 'state')) }),
    ...(body.fulfillmentMode === undefined
      ? {}
      : { fulfillmentMode: fulfillmentMode(requiredString(body, 'fulfillmentMode')) }),
    ...(body.orderKind === undefined
      ? {}
      : { orderKind: orderKindParameter(requiredString(body, 'orderKind')) }),
    ...(body.cursorCreatedAt === undefined
      ? {}
      : { cursorCreatedAt: requiredDate(body, 'cursorCreatedAt') }),
    ...(body.cursorOrderId === undefined
      ? {}
      : { cursorOrderId: requiredString(body, 'cursorOrderId') }),
    ...(body.limit === undefined ? {} : { limit: requiredPositiveInteger(body, 'limit') }),
  };
}

function shipmentBatchInput(body: Record<string, unknown>): ShipmentBatchInput {
  assertOnlyKeys(body, ['idempotencyKey', 'items']);
  if (!Array.isArray(body.items)) throw new CoreError('InvalidRequest', 'items must be an array');
  return {
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    items: body.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CoreError('InvalidRequest', 'Shipment batch item must be an object');
      }
      const item = value as Record<string, unknown>;
      assertOnlyKeys(item, [
        'orderId', 'idempotencyKey', 'evidenceHash', 'carrierCode',
        'trackingNumberHash', 'providerReferenceHash',
      ]);
      return {
        orderId: requiredString(item, 'orderId'),
        idempotencyKey: requiredString(item, 'idempotencyKey'),
        evidenceHash: requiredString(item, 'evidenceHash'),
        carrierCode: evidenceCarrier(item.carrierCode),
        trackingNumberHash: requiredString(item, 'trackingNumberHash'),
        ...(item.providerReferenceHash === undefined
          ? {}
          : { providerReferenceHash: requiredString(item, 'providerReferenceHash') }),
      };
    }),
  };
}

function adminOrderSearchQuery(url: URL): OrderPageQuery {
  const base = fulfillmentOrderPageQuery(url);
  return {
    ...base,
    ...(url.searchParams.get('orderId') ? { orderId: url.searchParams.get('orderId')! } : {}),
    ...(url.searchParams.get('productId') ? { productId: url.searchParams.get('productId')! } : {}),
    ...(url.searchParams.get('txHash') ? { txHash: url.searchParams.get('txHash')! } : {}),
    ...(url.searchParams.get('wallet') ? { wallet: url.searchParams.get('wallet')! } : {}),
    ...(url.searchParams.get('pendingReview')
      ? { pendingProductReview: booleanParameter(url.searchParams.get('pendingReview')!, 'pendingReview') }
      : {}),
    ...(url.searchParams.get('breakerScope')
      ? { breakerScope: breakerScopeParameter(url.searchParams.get('breakerScope')!) }
      : {}),
  };
}

function adminGlobalSearchQuery(url: URL): AdminGlobalSearchQuery {
  const resourceTypes = url.searchParams.getAll('resourceType');
  return {
    ...(resourceTypes.length ? { resourceTypes: resourceTypes.map(adminResourceType) } : {}),
    ...(url.searchParams.get('relation')
      ? { relation: adminSearchRelation(url.searchParams.get('relation')!) }
      : {}),
    ...(url.searchParams.get('orderId') ? { orderId: url.searchParams.get('orderId')! } : {}),
    ...(url.searchParams.get('productId') ? { productId: url.searchParams.get('productId')! } : {}),
    ...(url.searchParams.get('merchantId') ? { merchantId: url.searchParams.get('merchantId')! } : {}),
    ...(url.searchParams.get('txHash') ? { txHash: url.searchParams.get('txHash')! } : {}),
    ...(url.searchParams.get('uid') ? { uid: url.searchParams.get('uid')! } : {}),
    ...(url.searchParams.get('wallet') ? { wallet: url.searchParams.get('wallet')! } : {}),
    ...(url.searchParams.get('walletMatch')
      ? { walletMatch: adminWalletMatch(url.searchParams.get('walletMatch')!) }
      : {}),
    ...(url.searchParams.get('from') ? { from: dateParameter(url.searchParams.get('from')!, 'from') } : {}),
    ...(url.searchParams.get('to') ? { to: dateParameter(url.searchParams.get('to')!, 'to') } : {}),
    ...(url.searchParams.get('pendingReview')
      ? { pendingReview: booleanParameter(url.searchParams.get('pendingReview')!, 'pendingReview') }
      : {}),
    ...(url.searchParams.get('limit')
      ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
      : {}),
  };
}

function adminSearchRelation(value: string): 'AND' | 'OR' {
  if (value !== 'AND' && value !== 'OR') throw new CoreError('InvalidRequest', 'Unsupported Admin search relation');
  return value;
}

function adminWalletMatch(value: string): 'EXACT' | 'FUZZY' {
  if (value !== 'EXACT' && value !== 'FUZZY') throw new CoreError('InvalidRequest', 'Unsupported Admin wallet match mode');
  return value;
}

function adminExportRequest(body: Record<string, unknown>): AdminExportInput {
  if (!Array.isArray(body.selection)) throw new CoreError('InvalidRequest', 'selection must be an array');
  return {
    format: adminExportFormat(body.format),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    selection: body.selection.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CoreError('InvalidRequest', 'selection item must be an object');
      }
      const item = value as Record<string, unknown>;
      assertOnlyKeys(item, ['resourceType', 'resourceId']);
      return {
        resourceType: adminResourceType(requiredString(item, 'resourceType')),
        resourceId: requiredString(item, 'resourceId'),
      };
    }),
  };
}

function adminResourceType(value: string): AdminResourceType {
  if (!adminResourceTypes.includes(value as AdminResourceType)) {
    throw new CoreError('InvalidRequest', 'Unsupported Admin resource type');
  }
  return value as AdminResourceType;
}

function adminExportFormat(value: unknown): AdminExportFormat {
  if (typeof value !== 'string' || !adminExportFormats.includes(value as AdminExportFormat)) {
    throw new CoreError('InvalidRequest', 'Unsupported Admin export format');
  }
  return value as AdminExportFormat;
}

function breakerScopeParameter(value: string): BreakerScope {
  if (!(breakerScopes as readonly string[]).includes(value)) {
    throw new CoreError('InvalidRequest', 'Unsupported breaker scope');
  }
  return value as BreakerScope;
}

function booleanParameter(value: string, name: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CoreError('InvalidRequest', `${name} must be true or false`);
}

function orderStateParameter(value: string): (typeof orderProjectionStates)[number] {
  if (!(orderProjectionStates as readonly string[]).includes(value)) {
    throw new CoreError('InvalidRequest', 'Unsupported order state');
  }
  return value as (typeof orderProjectionStates)[number];
}

function orderKindParameter(value: string): OrderKind {
  if (!['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(value)) {
    throw new CoreError('InvalidRequest', 'Unsupported order kind');
  }
  return value as OrderKind;
}

function categoryInput(body: Record<string, unknown>) {
  assertOnlyKeys(body, [
    'parentCategoryId', 'name', 'iconAssetId', 'sortOrder',
    'serviceFeeBps', 'status', 'idempotencyKey',
  ]);
  return {
    ...(body.parentCategoryId === undefined
      ? {}
      : { parentCategoryId: body.parentCategoryId === null ? null : requiredString(body, 'parentCategoryId') }),
    name: requiredString(body, 'name'),
    ...(body.iconAssetId === undefined ? {} : { iconAssetId: requiredString(body, 'iconAssetId') }),
    sortOrder: requiredNonNegativeInteger(body, 'sortOrder'),
    ...(body.serviceFeeBps === undefined ? {} : { serviceFeeBps: requiredBps(body, 'serviceFeeBps') }),
    ...(body.status === undefined ? {} : { status: taxonomyStatus(body.status) }),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
}

function tagInput(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['name', 'example', 'sortOrder', 'status', 'idempotencyKey']);
  return {
    name: requiredString(body, 'name'),
    ...(body.example === undefined ? {} : { example: requiredString(body, 'example') }),
    sortOrder: requiredNonNegativeInteger(body, 'sortOrder'),
    ...(body.status === undefined ? {} : { status: taxonomyStatus(body.status) }),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
}

function requiredStringArray(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CoreError('InvalidRequest', `${name} must be a string array`);
  }
  return value as string[];
}

function logisticsCarrierConfigInput(body: Record<string, unknown>): CarrierConfigInput {
  assertOnlyKeys(body, ['carriers', 'defaultCarrierCode', 'idempotencyKey']);
  if (!Array.isArray(body.carriers)) throw new CoreError('InvalidRequest', 'carriers must be an array');
  const carriers = body.carriers.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CoreError('InvalidRequest', 'Carrier config entry must be an object');
    }
    const entry = value as Record<string, unknown>;
    assertOnlyKeys(entry, ['carrierCode', 'enabled']);
    return {
      carrierCode: requiredEnum(entry, 'carrierCode', ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS']),
      enabled: requiredBoolean(entry, 'enabled'),
    };
  });
  return {
    carriers,
    defaultCarrierCode: requiredEnum(body, 'defaultCarrierCode', ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS']),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
}

function logisticsProviderConfigInput(body: Record<string, unknown>): ProviderConfigInput {
  assertOnlyKeys(body, [
    'provider', 'enabled', 'partnerIdSecretRef', 'credentialSecretRef',
    'monthlyAccountSecretRef', 'callbackSecretRef', 'idempotencyKey',
  ]);
  return {
    provider: requiredEnum(body, 'provider', ['KUAIDI100', 'CAINIAO']),
    enabled: requiredBoolean(body, 'enabled'),
    partnerIdSecretRef: requiredString(body, 'partnerIdSecretRef'),
    credentialSecretRef: requiredString(body, 'credentialSecretRef'),
    monthlyAccountSecretRef: requiredString(body, 'monthlyAccountSecretRef'),
    callbackSecretRef: requiredString(body, 'callbackSecretRef'),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
}

function logisticsWarehouseInput(body: Record<string, unknown>, requireVersion: false): WarehouseInput;
function logisticsWarehouseInput(body: Record<string, unknown>, requireVersion: true): WarehouseUpdateInput;
function logisticsWarehouseInput(
  body: Record<string, unknown>,
  requireVersion: boolean,
): WarehouseInput | WarehouseUpdateInput {
  assertOnlyKeys(body, [
    'warehouseKind', 'name', 'partnerName', 'contactName', 'phone', 'regionCode',
    'addressLine', 'enabled', 'expectedVersion', 'idempotencyKey',
  ]);
  if (!Object.hasOwn(body, 'partnerName')) throw new CoreError('InvalidRequest', 'partnerName is required');
  if (!requireVersion && body.expectedVersion !== undefined) {
    throw new CoreError('InvalidRequest', 'expectedVersion is unsupported when creating a warehouse');
  }
  const value: WarehouseInput = {
    warehouseKind: requiredEnum(body, 'warehouseKind', ['PLATFORM', 'PARTNER']),
    name: requiredString(body, 'name'),
    partnerName: body.partnerName === null ? null : requiredString(body, 'partnerName'),
    contactName: requiredString(body, 'contactName'),
    phone: requiredString(body, 'phone'),
    regionCode: requiredString(body, 'regionCode'),
    addressLine: requiredString(body, 'addressLine'),
    enabled: requiredBoolean(body, 'enabled'),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
  return requireVersion
    ? { ...value, expectedVersion: requiredPositiveInteger(body, 'expectedVersion') }
    : value;
}

function requiredPositiveInteger(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new CoreError('InvalidRequest', `${name} must be a positive integer`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CoreError('InvalidRequest', `${name} must be a non-negative integer`);
  }
  return Number(value);
}

function requiredBps(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10_000) {
    throw new CoreError('InvalidRequest', `${name} must be between 0 and 10000`);
  }
  return Number(value);
}

function requiredNumber(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoreError('InvalidRequest', `${name} must be a finite number`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'boolean') throw new CoreError('InvalidRequest', `${name} must be boolean`);
  return value;
}

function requiredDate(body: Record<string, unknown>, name: string) {
  const value = requiredString(body, name);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CoreError('InvalidRequest', `${name} must be a canonical ISO timestamp`);
  }
  return date;
}

function buyerAddressInput(body: Record<string, unknown>, requireVersion: boolean): BuyerAddressInput {
  assertOnlyKeys(body, [
    'label', 'recipientName', 'phone', 'detailAddress', 'longitude', 'latitude',
    'province', 'city', 'district', 'regionCode',
    'isDefault', 'expectedVersion', 'idempotencyKey',
  ]);
  return {
    label: requiredString(body, 'label'),
    recipientName: requiredString(body, 'recipientName'),
    phone: requiredString(body, 'phone'),
    detailAddress: requiredString(body, 'detailAddress'),
    ...(body.longitude === undefined ? {} : { longitude: body.longitude === null ? null : requiredNumber(body, 'longitude') }),
    ...(body.latitude === undefined ? {} : { latitude: body.latitude === null ? null : requiredNumber(body, 'latitude') }),
    ...(body.province === undefined ? {} : { province: requiredString(body, 'province') }),
    ...(body.city === undefined ? {} : { city: requiredString(body, 'city') }),
    ...(body.district === undefined ? {} : { district: requiredString(body, 'district') }),
    ...(body.regionCode === undefined ? {} : { regionCode: requiredString(body, 'regionCode') }),
    isDefault: requiredBoolean(body, 'isDefault'),
    ...(requireVersion ? { expectedVersion: requiredPositiveInteger(body, 'expectedVersion') } : {}),
    idempotencyKey: requiredString(body, 'idempotencyKey'),
  };
}

function merchantAuditQuery(url: URL): Omit<AuditQuery, 'actorWallet' | 'merchantId'> {
  return {
    ...(url.searchParams.get('streamName') ? { streamName: auditStream(url.searchParams.get('streamName')) } : {}),
    ...(url.searchParams.get('eventType') ? { eventType: url.searchParams.get('eventType')! } : {}),
    ...(url.searchParams.get('resourceType') ? { resourceType: url.searchParams.get('resourceType')! } : {}),
    ...(url.searchParams.get('resourceId') ? { resourceId: url.searchParams.get('resourceId')! } : {}),
    ...(url.searchParams.get('correlationId') ? { correlationId: url.searchParams.get('correlationId')! } : {}),
    ...(url.searchParams.get('from') ? { from: dateParameter(url.searchParams.get('from')!, 'from') } : {}),
    ...(url.searchParams.get('to') ? { to: dateParameter(url.searchParams.get('to')!, 'to') } : {}),
    ...(url.searchParams.get('cursorCreatedAt')
      ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
      : {}),
    ...(url.searchParams.get('cursorEntryId') ? { cursorEntryId: url.searchParams.get('cursorEntryId')! } : {}),
    ...(url.searchParams.get('limit')
      ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
      : {}),
  };
}

function adminSettlementRequestQuery(url: URL): AdminSettlementRequestQuery {
  assertOnlySearchParams(url, [
    'requestId', 'merchantId', 'walletAddress', 'orderId', 'transferId', 'executionTxHash',
    'rail', 'asset', 'state', 'from', 'to', 'cursorRequestedAt', 'cursorRequestId', 'limit',
  ]);
  return {
    ...(url.searchParams.get('requestId') ? { requestId: url.searchParams.get('requestId')! } : {}),
    ...(url.searchParams.get('merchantId') ? { merchantId: url.searchParams.get('merchantId')! } : {}),
    ...(url.searchParams.get('walletAddress') ? { walletAddress: url.searchParams.get('walletAddress')! } : {}),
    ...(url.searchParams.get('orderId') ? { orderId: url.searchParams.get('orderId')! } : {}),
    ...(url.searchParams.get('transferId') ? { transferId: url.searchParams.get('transferId')! } : {}),
    ...(url.searchParams.get('executionTxHash')
      ? { executionTxHash: url.searchParams.get('executionTxHash')! }
      : {}),
    ...(url.searchParams.get('rail') ? { rail: adminSettlementRail(url.searchParams.get('rail')) } : {}),
    ...(url.searchParams.get('asset') ? { asset: adminSettlementAsset(url.searchParams.get('asset')) } : {}),
    ...(url.searchParams.get('state')
      ? { state: adminSettlementRequestState(url.searchParams.get('state')) }
      : {}),
    ...(url.searchParams.get('from') ? { from: dateParameter(url.searchParams.get('from')!, 'from') } : {}),
    ...(url.searchParams.get('to') ? { to: dateParameter(url.searchParams.get('to')!, 'to') } : {}),
    ...(url.searchParams.get('cursorRequestedAt')
      ? { cursorRequestedAt: dateParameter(url.searchParams.get('cursorRequestedAt')!, 'cursorRequestedAt') }
      : {}),
    ...(url.searchParams.get('cursorRequestId')
      ? { cursorRequestId: url.searchParams.get('cursorRequestId')! }
      : {}),
    ...(url.searchParams.get('limit')
      ? { limit: adminSettlementLimit(url.searchParams.get('limit')) }
      : {}),
  };
}

function adminSettlementTransferQuery(url: URL): AdminSettlementTransferQuery {
  assertOnlySearchParams(url, [
    'transferId', 'merchantId', 'orderId', 'executorWallet', 'executionTxHash', 'asset', 'state',
    'from', 'to', 'cursorCreatedAt', 'cursorTransferId', 'limit',
  ]);
  return {
    ...(url.searchParams.get('transferId') ? { transferId: url.searchParams.get('transferId')! } : {}),
    ...(url.searchParams.get('merchantId') ? { merchantId: url.searchParams.get('merchantId')! } : {}),
    ...(url.searchParams.get('orderId') ? { orderId: url.searchParams.get('orderId')! } : {}),
    ...(url.searchParams.get('executorWallet')
      ? { executorWallet: url.searchParams.get('executorWallet')! }
      : {}),
    ...(url.searchParams.get('executionTxHash')
      ? { executionTxHash: url.searchParams.get('executionTxHash')! }
      : {}),
    ...(url.searchParams.get('asset') ? { asset: adminSettlementAsset(url.searchParams.get('asset')) } : {}),
    ...(url.searchParams.get('state')
      ? { state: adminSettlementTransferState(url.searchParams.get('state')) }
      : {}),
    ...(url.searchParams.get('from') ? { from: dateParameter(url.searchParams.get('from')!, 'from') } : {}),
    ...(url.searchParams.get('to') ? { to: dateParameter(url.searchParams.get('to')!, 'to') } : {}),
    ...(url.searchParams.get('cursorCreatedAt')
      ? { cursorCreatedAt: dateParameter(url.searchParams.get('cursorCreatedAt')!, 'cursorCreatedAt') }
      : {}),
    ...(url.searchParams.get('cursorTransferId')
      ? { cursorTransferId: url.searchParams.get('cursorTransferId')! }
      : {}),
    ...(url.searchParams.get('limit')
      ? { limit: adminSettlementLimit(url.searchParams.get('limit')) }
      : {}),
  };
}

function adminSettlementRail(value: string | null): SettlementRail {
  if (!settlementRails.includes(value as SettlementRail)) {
    throw new CoreError('InvalidRequest', 'Unsupported settlement rail');
  }
  return value as SettlementRail;
}

function adminSettlementAsset(value: string | null): 'USDT' | 'NPL' {
  if (value !== 'USDT' && value !== 'NPL') throw new CoreError('InvalidRequest', 'Unsupported settlement asset');
  return value;
}

function adminSettlementRequestState(value: string | null): SettlementRequestState {
  if (!settlementRequestStates.includes(value as SettlementRequestState)) {
    throw new CoreError('InvalidRequest', 'Unsupported settlement request state');
  }
  return value as SettlementRequestState;
}

function adminSettlementTransferState(value: string | null): SettlementTransferState {
  if (!settlementTransferStates.includes(value as SettlementTransferState)) {
    throw new CoreError('InvalidRequest', 'Unsupported settlement transfer state');
  }
  return value as SettlementTransferState;
}

function adminSettlementLimit(value: string | null) {
  const limit = optionalPositiveIntegerParameter(value, 'limit')!;
  if (limit > 100) throw new CoreError('InvalidRequest', 'limit must not exceed 100');
  return limit;
}

function requestInput(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'reasonCode']);
  return {
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    evidenceHash: requiredString(body, 'evidenceHash'),
    reasonCode: requiredString(body, 'reasonCode'),
  };
}

function evidenceAction(value: unknown): EvidenceAction {
  if (![
    'REQUEST_EXCHANGE',
    'REQUEST_DELAY',
    'CONFIRM_RECEIPT',
    'OPEN_ARBITRATION',
    'VERIFY_PICKUP',
    'REQUEST_FORCED_RECEIPT',
    'RECORD_DELIVERY',
  ].includes(String(value))) throw new CoreError('InvalidRequest', 'Unsupported evidence action');
  return value as EvidenceAction;
}

function evidenceCarrier(value: unknown): Carrier {
  if (!['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported carrier code');
  }
  return value as Carrier;
}

function mediaPurpose(value: unknown): MediaPurpose {
  if (![
    'PRODUCT_IMAGE',
    'PRODUCT_VIDEO',
    'CATEGORY_ICON',
    'STORE_IMAGE',
    'FULFILLMENT_EVIDENCE',
    'BUYER_AVATAR',
    'MERCHANT_LOGO',
    'MERCHANT_LICENSE',
  ].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported media purpose');
  }
  return value as MediaPurpose;
}

function mediaResourceType(value: unknown): MediaResourceType {
  if (!['PRODUCT', 'CATEGORY', 'STORE', 'ORDER', 'BUYER', 'MERCHANT'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported media resource type');
  }
  return value as MediaResourceType;
}

function mediaContentType(value: unknown): 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'application/pdf' {
  if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported media content type');
  }
  return value as 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'application/pdf';
}

function arbitrationOutcome(value: unknown): 'FULFILL' | 'RESUME_FULFILLMENT' {
  if (value !== 'FULFILL' && value !== 'RESUME_FULFILLMENT') {
    throw new CoreError('InvalidRequest', 'outcome must be FULFILL or RESUME_FULFILLMENT');
  }
  return value;
}

function logisticsStatus(value: unknown): LogisticsUpdateInput['status'] {
  if (!['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported logistics status');
  }
  return value as LogisticsUpdateInput['status'];
}

function fulfillmentMode(value: unknown): 'DELIVERY' | 'PICKUP' {
  if (value !== 'DELIVERY' && value !== 'PICKUP') {
    throw new CoreError('InvalidRequest', 'fulfillmentMode must be DELIVERY or PICKUP');
  }
  return value;
}

function fulfillmentModes(value: unknown): Array<'DELIVERY' | 'PICKUP'> {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => item !== 'DELIVERY' && item !== 'PICKUP')) {
    throw new CoreError('InvalidRequest', 'fulfillmentModes must contain DELIVERY or PICKUP');
  }
  return value as Array<'DELIVERY' | 'PICKUP'>;
}

function taxonomyStatus(value: unknown): 'ENABLED' | 'DISABLED' | 'DELETED' {
  if (!['ENABLED', 'DISABLED', 'DELETED'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported taxonomy status');
  }
  return value as 'ENABLED' | 'DISABLED' | 'DELETED';
}

function catalogReviewDecision(value: unknown): 'APPROVE' | 'REJECT' | 'PUBLISH' | 'HIDE' | 'DELIST' {
  if (!['APPROVE', 'REJECT', 'PUBLISH', 'HIDE', 'DELIST'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported catalog review decision');
  }
  return value as 'APPROVE' | 'REJECT' | 'PUBLISH' | 'HIDE' | 'DELIST';
}

function settlementRail(value: unknown): SettlementRail {
  if (!settlementRails.includes(value as SettlementRail)) {
    throw new CoreError('InvalidRequest', 'Unsupported settlement rail');
  }
  return value as SettlementRail;
}

function governedSettlementRail(value: unknown): GovernedSettlementRail {
  if (value !== 'TAKEOVER_USDT' && value !== 'OPERATIONS_REIMBURSEMENT_USDT') {
    throw new CoreError('InvalidRequest', 'Unsupported governed settlement rail');
  }
  return value;
}

function pathParameter(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length);
  if (!value || value.includes('/')) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid URL path');
  }
}

function decodedPathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid URL path');
  }
}

function matchResourceAction(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return undefined;
  const parts = pathname.slice(prefix.length).split('/');
  if (parts.length < 1 || parts.length > 2 || !parts[0]) return undefined;
  try {
    return {
      resourceId: decodeURIComponent(parts[0]),
      action: parts[1] ? decodeURIComponent(parts[1]) : undefined,
    };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid resource URL path');
  }
}

function assertOnlySearchParams(url: URL, allowed: readonly string[], repeatable: readonly string[] = []) {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || (seen.has(key) && !repeatable.includes(key))) {
      throw new CoreError('InvalidRequest', 'Request contains unsupported or duplicate query parameters');
    }
    seen.add(key);
  }
}

function optionalPositiveIntegerParameter(value: string | null, name: string) {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new CoreError('InvalidRequest', `${name} must be a positive integer`);
  }
  return Number(value);
}

function dateParameter(value: string, name: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new CoreError('InvalidRequest', `${name} must be a canonical ISO timestamp`);
  }
  return date;
}

function takeoverCaseQuery(url: URL): TakeoverCaseQuery {
  assertOnlySearchParams(url, [
    'state', 'originalMerchantId', 'replacementMerchantId',
    'cursorOpenedAt', 'cursorCaseId', 'limit',
  ]);
  return {
    ...(url.searchParams.get('state') ? { state: takeoverCaseState(url.searchParams.get('state')) } : {}),
    ...(url.searchParams.get('originalMerchantId')
      ? { originalMerchantId: url.searchParams.get('originalMerchantId')! }
      : {}),
    ...(url.searchParams.get('replacementMerchantId')
      ? { replacementMerchantId: url.searchParams.get('replacementMerchantId')! }
      : {}),
    ...(url.searchParams.get('cursorOpenedAt')
      ? { cursorOpenedAt: dateParameter(url.searchParams.get('cursorOpenedAt')!, 'cursorOpenedAt') }
      : {}),
    ...(url.searchParams.get('cursorCaseId') ? { cursorCaseId: url.searchParams.get('cursorCaseId')! } : {}),
    ...(url.searchParams.get('limit')
      ? { limit: optionalPositiveIntegerParameter(url.searchParams.get('limit'), 'limit')! }
      : {}),
  };
}

function takeoverCaseState(value: string | null): TakeoverState {
  if (!takeoverStates.includes(value as TakeoverState)) {
    throw new CoreError('InvalidRequest', 'Unsupported takeover state');
  }
  return value as TakeoverState;
}

function merchantLifecycleStatus(value: string | null): NonNullable<Parameters<MerchantLifecycleApiService['list']>[1]['status']> {
  if (!merchantLifecycleStatuses.includes(value as typeof merchantLifecycleStatuses[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported merchant lifecycle status');
  }
  return value as NonNullable<Parameters<MerchantLifecycleApiService['list']>[1]['status']>;
}

function merchantReviewAction(value: unknown): Parameters<MerchantLifecycleApiService['createReviewChallenge']>[2]['action'] {
  if (!merchantReviewActions.includes(value as typeof merchantReviewActions[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported merchant review action');
  }
  return value as Parameters<MerchantLifecycleApiService['createReviewChallenge']>[2]['action'];
}

function cmsContentType(value: unknown): Parameters<CmsApiService['createVersion']>[1]['contentType'] {
  if (!cmsContentTypes.includes(value as typeof cmsContentTypes[number])) throw new CoreError('InvalidRequest', 'Unsupported CMS content type');
  return value as typeof cmsContentTypes[number];
}

function cmsContentFormat(value: unknown): Parameters<CmsApiService['createVersion']>[1]['contentFormat'] {
  if (!cmsContentFormats.includes(value as typeof cmsContentFormats[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported CMS content format');
  }
  return value as typeof cmsContentFormats[number];
}

function notificationChannel(value: unknown): Parameters<NotificationApiService['registerEndpoint']>[1]['channel'] {
  if (!notificationChannels.includes(value as typeof notificationChannels[number])) throw new CoreError('InvalidRequest', 'Unsupported notification channel');
  return value as Parameters<NotificationApiService['registerEndpoint']>[1]['channel'];
}

function notificationProvider(value: unknown): Parameters<NotificationApiService['registerEndpoint']>[1]['provider'] {
  if (!notificationProviders.includes(value as typeof notificationProviders[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported notification provider');
  }
  return value as Parameters<NotificationApiService['registerEndpoint']>[1]['provider'];
}

function notificationCampaignTopic(value: unknown): Parameters<NotificationApiService['createCampaign']>[1]['topic'] {
  if (!notificationCampaignTopics.includes(value as typeof notificationCampaignTopics[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported notification campaign topic');
  }
  return value as Parameters<NotificationApiService['createCampaign']>[1]['topic'];
}

function systemConfigKey(value: unknown): Parameters<SystemConfigApiService['createVersion']>[1]['configKey'] {
  if (!systemConfigKeys.includes(value as typeof systemConfigKeys[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported system config key');
  }
  return value as Parameters<SystemConfigApiService['createVersion']>[1]['configKey'];
}

function sensitiveApproval(body: Record<string, unknown>): ConfigApprovalInput {
  assertOnlyKeys(body, [
    'action', 'resourceType', 'resourceId', 'policyVersion', 'oldValueHash',
    'newValueHash', 'executorWallet', 'nonce', 'deadline', 'signature',
  ]);
  return {
    action: requiredString(body, 'action'),
    resourceType: requiredString(body, 'resourceType'),
    resourceId: requiredString(body, 'resourceId'),
    policyVersion: requiredString(body, 'policyVersion'),
    oldValueHash: requiredString(body, 'oldValueHash'),
    newValueHash: requiredString(body, 'newValueHash'),
    executorWallet: requiredString(body, 'executorWallet'),
    nonce: requiredString(body, 'nonce'),
    deadline: requiredString(body, 'deadline'),
    signature: requiredString(body, 'signature'),
  };
}

function auditStream(value: string | null): NonNullable<AuditQuery['streamName']> {
  if (!auditStreamNames.includes(value as typeof auditStreamNames[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported audit stream');
  }
  return value as NonNullable<AuditQuery['streamName']>;
}

function runtimeMetricKind(path: string): 'PAYMENT' | 'FULFILLMENT' | undefined {
  if (/^\/v2\/(?:payments|seckill)/.test(path)) return 'PAYMENT';
  if (/^\/v2\/(?:orders|fulfillment-targets|stores|media)/.test(path)) return 'FULFILLMENT';
  return undefined;
}

function matchOrderPath(pathname: string) {
  const match = /^\/v2\/orders\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return { orderId: decodeURIComponent(match[1]!), action: match[2] ? decodeURIComponent(match[2]) : undefined };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid order URL path');
  }
}

function matchMerchantPrinterBindingPath(pathname: string) {
  const match = /^\/v2\/merchant\/stores\/([^/]+)\/printer-binding(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return {
      storeId: decodeURIComponent(match[1]!),
      action: match[2] ? decodeURIComponent(match[2]) : undefined,
    };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid printer binding URL path');
  }
}

function matchMerchantStorePath(pathname: string) {
  const match = /^\/v2\/merchant\/stores\/([^/]+)(?:\/(activate|close))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return {
      storeId: decodeURIComponent(match[1]!),
      action: match[2] as 'activate' | 'close' | undefined,
    };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid merchant store URL path');
  }
}

function matchMerchantPrintJobRetryPath(pathname: string) {
  const match = /^\/v2\/merchant\/print-jobs\/([^/]+)\/retry$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid print job URL path');
  }
}

function matchAdminLogisticsWarehousePath(pathname: string) {
  const match = /^\/v2\/admin\/logistics\/warehouses\/([^/]+)(?:\/(deactivate))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return {
      warehouseId: decodeURIComponent(match[1]!),
      action: match[2] as 'deactivate' | undefined,
    };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid logistics warehouse URL path');
  }
}

function matchAdminLogisticsPrintJobRetryPath(pathname: string) {
  const match = /^\/v2\/admin\/logistics\/print-jobs\/([^/]+)\/retry$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid admin print job URL path');
  }
}

function logisticsWebhookProvider(pathname: string): 'KUAIDI100' | 'CAINIAO' | undefined {
  const match = /^\/v2\/providers\/(kuaidi100|cainiao)\/webhooks\/logistics$/.exec(pathname);
  return match?.[1]?.toUpperCase() as 'KUAIDI100' | 'CAINIAO' | undefined;
}

function sha256Hash(value: Buffer) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function fulfillmentActor(claims: { sub: string; roles: readonly UserRole[]; merchantId?: string }): FulfillmentActor {
  return {
    walletAddress: claims.sub,
    roles: claims.roles,
    ...(claims.merchantId ? { merchantId: claims.merchantId } : {}),
  };
}

function merchantCatalogActor(claims: { sub: string; roles: readonly UserRole[]; merchantId?: string }): FulfillmentActor {
  if (!claims.roles.includes('MERCHANT') || !claims.merchantId) {
    throw new CoreError('Forbidden', 'Merchant catalog scope is unavailable', 403);
  }
  return { walletAddress: claims.sub, roles: ['MERCHANT'], merchantId: claims.merchantId };
}

function platformCatalogActor(claims: { sub: string; roles: readonly UserRole[] }): FulfillmentActor {
  const role = claims.roles.includes('ADMIN')
    ? 'ADMIN'
    : claims.roles.includes('OPERATOR')
      ? 'OPERATOR'
      : claims.roles.includes('AUDITOR') ? 'AUDITOR' : undefined;
  if (!role) throw new CoreError('Forbidden', 'Platform catalog scope is unavailable', 403);
  return { walletAddress: claims.sub, roles: [role] };
}

function sendJson(response: ServerResponse, status: number, body: unknown, correlationId: string) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-correlation-id': correlationId,
  });
  response.end(payload);
}

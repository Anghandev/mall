export declare const artifactVersion: "2.0.0-merchant-stores.1";
export declare const chainIdentity: Readonly<{ chainId: 56; usdtAddress: "0x55d398326f99059ff775485246999027b3197955"; nplAddress: "0x4e8277ab31e4956b2cd48449793a57656dfc03d2" }>;
export type AtomicAmount = string;
export type Bytes32 = string;
export type Address = string;
export type Timestamp = string;
export type AdminResourceType = "ORDER" | "PRODUCT" | "MERCHANT";
export type AdminExportFormat = "CSV" | "EXCEL";
export type AdminBatchAction = "EXPORT_CSV" | "EXPORT_EXCEL" | "ADD_PRODUCT_TAGS";
export type OrderProjectionState = "QUOTED" | "SUBMITTED" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED" | "REORG_PENDING";
export type ContractOrderState = "NONE" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED";
export type OrderFinalityStatus = "NOT_SUBMITTED" | "PENDING" | "CONFIRMED" | "REPLACED" | "REORGED" | "FINAL";
export type TransactionFinalityState = "SUBMITTED" | "MINED" | "REPLACED" | "REORGED" | "FINAL" | "FAILED";
export type UserRole = "BUYER" | "MERCHANT" | "ADMIN" | "OPERATOR" | "ARBITRATOR" | "AUDITOR";
export type MerchantLevel = "V1" | "V2" | "V3" | "V4" | "V5";
export type MerchantLifecycleStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | "BLACKLISTED";
export type MerchantReviewAction = "APPROVE" | "REJECT" | "BLACKLIST";
export type MerchantQualificationAccess = "FULL" | "REDACTED" | "UNAVAILABLE";
export type BreakerScope = "NEW_PAYMENT" | "SECKILL_PURCHASE" | "NEW_SETTLEMENT_BATCH";
export type CatalogProductAction = "SAVE_DRAFT" | "CREATE_CONCESSION_PREVIEW" | "SUBMIT_REVIEW" | "APPROVE" | "REJECT" | "PUBLISH" | "ADJUST_INVENTORY" | "HIDE" | "DELIST";
export type CatalogProductLifecycleState = "DRAFT" | "REVIEW" | "SCHEDULED" | "ACTIVE" | "SOLD_OUT" | "HIDDEN" | "DELISTED" | "LOCKED";
export type CatalogReviewDecision = "APPROVE" | "REJECT" | "PUBLISH" | "HIDE" | "DELIST";
export type CatalogTaxonomyStatus = "ENABLED" | "DISABLED" | "DELETED";
export type AllowedActionName = "PAY_ORDER" | "REQUEST_EXCHANGE" | "REQUEST_DELAY" | "DECIDE_FULFILLMENT_REQUEST" | "CONFIRM_RECEIPT" | "REQUEST_FORCED_RECEIPT" | "VERIFY_PICKUP" | "OPEN_ARBITRATION" | "OPEN_TAKEOVER" | "RECORD_SHIPMENT" | "RECORD_DELIVERY" | "REGISTER_PICKUP_CREDENTIAL" | "DECIDE_ARBITRATION" | "DECIDE_FORCED_RECEIPT" | "REQUEST_MERCHANT_SETTLEMENT" | "REQUEST_REWARD_SETTLEMENT" | "REQUEST_PRIZE_SETTLEMENT" | "RECONCILE" | "RECOVER_SURPLUS";
export type AllowedActionReasonCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "MerchantFrozen" | "PickupTakeoverDecisionBlocked" | "UnknownState";
export type CoreErrorCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "EmptySessionPrizeDecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "IdempotencyConflict" | "InvalidFinality" | "InvalidRequest" | "InvalidSignature" | "InventoryUnavailable" | "NonceExpired" | "NonceReplay" | "SeckillOnlyProduct" | "PickupTakeoverDecisionBlocked" | "ProviderSignatureInvalid" | "ProductWriteLocked" | "QuoteExpired" | "ReorgPending" | "ReservationConflict" | "RiskRestricted" | "Unauthorized" | "UnknownState";
export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type OrderKind = 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
export type FulfillmentMethod = "CUSTOMER_RECEIPT" | "PICKUP_VERIFICATION" | "FORCED_RECEIPT" | "ARBITRATION";
export type StoreStatus = "DRAFT" | "ACTIVE" | "SUSPENDED" | "CLOSED";
export type FulfillmentRequestType = "EXCHANGE" | "DELAY" | "ARBITRATION" | "FORCED_RECEIPT";
export type FulfillmentRequestState = "OPEN" | "APPROVED" | "REJECTED" | "RESOLVED";
export type LogisticsProvider = "KUAIDI100" | "CAINIAO";
export type LogisticsCarrierCode = "SF" | "JD" | "YTO" | "ZTO" | "STO" | "EMS";
export type LogisticsProviderReadiness = "READY" | "DISABLED" | "CONFIGURATION_REQUIRED";
export type LogisticsWarehouseKind = "PLATFORM" | "PARTNER";
export type LogisticsWarehouseAccess = "FULL" | "REDACTED";
export type LogisticsStatus = "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION";
export type PrintProvider = "FEIE" | "YILIANYUN";
export type PrintJobState = "CONFIGURATION_REQUIRED" | "QUEUED" | "PROCESSING" | "ACCEPTED" | "RETRYABLE" | "FAILED";
export type WaybillProvider = "KUAIDI100" | "CAINIAO";
export type WaybillRequestState = "PENDING_PROVIDER" | "CONFIGURATION_REQUIRED" | "PROVIDER_ACCEPTED" | "SHIPMENT_RECORDED" | "COMPLETED" | "FAILED";
export type MediaContentType = "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "application/pdf";
export type MediaPurpose = "PRODUCT_IMAGE" | "PRODUCT_VIDEO" | "CATEGORY_ICON" | "STORE_IMAGE" | "FULFILLMENT_EVIDENCE" | "BUYER_AVATAR" | "MERCHANT_LOGO" | "MERCHANT_LICENSE";
export type MediaResourceType = "PRODUCT" | "CATEGORY" | "STORE" | "ORDER" | "BUYER" | "MERCHANT";
export type FulfillmentAsset = "USDT" | "NPL" | "BNM_POINTS";
export type ArbitrationOutcome = "FULFILL" | "RESUME_FULFILLMENT";
export type SettlementRail = "MERCHANT_USDT" | "REWARD_NPL" | "PRIZE_USDT" | "TAKEOVER_USDT" | "OPERATIONS_REIMBURSEMENT_USDT";
export type SettlementIntentState = "ISSUED" | "CONSUMED" | "EXPIRED" | "CANCELLED";
export type SettlementRequestState = "REQUESTED" | "BATCHED" | "SETTLED" | "RETRYABLE" | "QUARANTINED";
export type SettlementBatchState = "APPROVAL_PENDING" | "APPROVED" | "SUBMITTING" | "SUBMITTED" | "MINED" | "SETTLED" | "FAILED" | "REORGED" | "RETRYABLE" | "QUARANTINED";
export type MerchantGuaranteeDepositState = "SUBMITTED" | "MINED" | "FINAL" | "REORGED" | "QUARANTINED";
export type GuaranteeStatus = "DECISION_BLOCKED" | "BELOW_MINIMUM" | "READY" | "FROZEN";
export type BreakerAction = "PAUSE" | "RESUME";
export type BreakerCauseType = "COVERAGE" | "GOVERNANCE" | "SECURITY" | "OPERATIONS";
export type ReservationState = "ACTIVE" | "CONSUMED" | "EXPIRED" | "RELEASED";
export type BalanceState = "LOCKED" | "AVAILABLE" | "REQUESTED" | "BATCHED" | "SETTLED" | "DISPUTED";
export type RewardSubtype = "GENESIS" | "DIRECT_REFERRAL" | "DISTRICT" | "CITY" | "PROVINCE" | "REGION" | "OPERATIONS" | "ROUNDING_REMAINDER";
export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' | 'SECKILL_PRIZE_LIABILITY';
export type TakeoverState = "OPEN" | "FUNDED" | "FULFILLING" | "FULFILLMENT_PENDING" | "CLOSED" | "DECISION_BLOCKED";
export type SeckillState = "PREHEAT" | "LIVE" | "SETTLING" | "SETTLED" | "FORCE_CLOSED";
export type PolicyPublicationState = "DRAFT" | "DECISION_BLOCKED" | "PUBLISHED" | "SUPERSEDED";
export type PolicyDraftState = "DRAFT" | "DECISION_BLOCKED" | "SECONDARY_SIGNED" | "SAFE_PROPOSED" | "FINALITY_PENDING" | "REORGED" | "REJECTED" | "PUBLISHED";
export type CmsContentType = "BANNER" | "RECOMMENDATION" | "SPLASH" | "CAMPAIGN_POPUP" | "SECKILL_RULES" | "FAQ" | "SERVICE_AGREEMENT" | "PRIVACY" | "ABOUT" | "RELEASE_ANNOUNCEMENT" | "UPDATE_NOTICE" | "CONTRACT_NOTICE";
export type CmsContentFormat = "STRUCTURED_RICH_TEXT" | "STRUCTURED_CAMPAIGN";
export type CmsPublicationEventType = "PUBLISHED" | "ROLLED_BACK";
export type NotificationChannel = "IN_APP" | "SMS" | "EMAIL" | "PUSH";
export type NotificationProvider = "CORE" | "ALIYUN_SMS" | "TENCENT_SMS" | "SMTP" | "FIREBASE" | "JPUSH";
export type NotificationEndpointState = "ACTIVE" | "PAUSED" | "REVOKED";
export type NotificationCampaignTopic = "ANNOUNCEMENT" | "MAINTENANCE" | "ACTIVITY";
export type NotificationCampaignState = "DRAFT" | "PUBLISHED" | "CANCELLED";
export type NotificationDeliveryState = "PENDING" | "PROCESSING" | "DELIVERED" | "RETRY" | "CONFIGURATION_REQUIRED" | "DEAD_LETTER";
export type SystemConfigKey = "BUSINESS" | "FREIGHT" | "RPC" | "ORACLE" | "GAS" | "CHAIN" | "INTEGRATIONS";
export type AuditStreamName = "financial" | "governance" | "authentication" | "operational" | "backup";
export type AuditEvidenceProfile = "RBAC" | "AUTHORIZATION" | "SIGNED_OFFCHAIN" | "SAFE_APPROVED" | "CHAIN_OBSERVED" | "CHAIN_FINAL" | "SYSTEM";
export type OperationsMetricComponent = "HOST" | "REDIS" | "MQ" | "DATABASE" | "HTTP" | "PAYMENT" | "FULFILLMENT" | "RPC_PRIMARY" | "RPC_FALLBACK" | "EXPLORER";
export type OperationsMetricUnit = "PERCENT" | "BYTES" | "COUNT" | "MILLISECONDS" | "BLOCK" | "PER_SECOND";
export type OperationsMetricStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "UNAVAILABLE" | "CONFIGURATION_REQUIRED";
export type OperationsAlertEventType = "OPENED" | "ACKNOWLEDGED" | "RECOVERED";
export type OperationsAlertSeverity = "WARNING" | "CRITICAL";
export type AdapterProvider = "AMAP" | "KUAIDI100" | "CAINIAO" | "FEIE" | "YILIANYUN" | "BNM" | "ALIYUN_SMS" | "TENCENT_SMS" | "ALIYUN_OSS" | "SMTP" | "FIREBASE" | "JPUSH";
export type InfrastructureProvider = "RPC_PRIMARY" | "RPC_FALLBACK" | "EXPLORER";
export type ProviderReadinessState = "READY" | "CONFIGURATION_REQUIRED";
export type RiskSignalType = "HIGH_GAS" | "WALLET_CONTEXT" | "ORDER_CANCELLATION";
export type RiskSourceType = "CHAIN_MONITOR" | "EDGE_AUTH" | "ORDER_SERVICE";
export type RiskSubjectType = "WALLET" | "IP" | "DEVICE";
export type RiskRestrictionKind = "NEW_PAYMENT" | "BLACKLIST";
export type RiskRestrictionState = "ACTIVE" | "EXPIRED" | "OVERRIDDEN";
export type RiskAppealState = "PENDING" | "APPROVED" | "REJECTED";
export declare const adminResourceTypes: readonly AdminResourceType[];
export declare const adminExportFormats: readonly AdminExportFormat[];
export declare const adminBatchActions: readonly AdminBatchAction[];
export declare const orderProjectionStates: readonly OrderProjectionState[];
export declare const contractOrderStates: readonly ContractOrderState[];
export declare const orderFinalityStatuses: readonly OrderFinalityStatus[];
export declare const finalityStates: readonly TransactionFinalityState[];
export declare const userRoles: readonly UserRole[];
export declare const merchantLevels: readonly MerchantLevel[];
export declare const merchantLifecycleStatuses: readonly MerchantLifecycleStatus[];
export declare const merchantReviewActions: readonly MerchantReviewAction[];
export declare const merchantQualificationAccess: readonly MerchantQualificationAccess[];
export declare const breakerScopes: readonly BreakerScope[];
export declare const catalogProductActions: readonly CatalogProductAction[];
export declare const catalogProductLifecycleStates: readonly CatalogProductLifecycleState[];
export declare const catalogReviewDecisions: readonly CatalogReviewDecision[];
export declare const catalogTaxonomyStatuses: readonly CatalogTaxonomyStatus[];
export declare const allowedActionNames: readonly AllowedActionName[];
export declare const executableOrderActionNames: readonly AllowedActionName[];
export declare const allowedActionReasonCodes: readonly AllowedActionReasonCode[];
export declare const coreErrorCodes: readonly CoreErrorCode[];
export declare const fulfillmentModes: readonly FulfillmentMode[];
export declare const fulfillmentMethods: readonly FulfillmentMethod[];
export declare const storeStatuses: readonly StoreStatus[];
export declare const fulfillmentRequestTypes: readonly FulfillmentRequestType[];
export declare const fulfillmentRequestStates: readonly FulfillmentRequestState[];
export declare const logisticsProviders: readonly LogisticsProvider[];
export declare const logisticsCarrierCodes: readonly LogisticsCarrierCode[];
export declare const logisticsProviderReadinessStates: readonly LogisticsProviderReadiness[];
export declare const logisticsWarehouseKinds: readonly LogisticsWarehouseKind[];
export declare const logisticsWarehouseAccessLevels: readonly LogisticsWarehouseAccess[];
export declare const logisticsStatuses: readonly LogisticsStatus[];
export declare const printProviders: readonly PrintProvider[];
export declare const printJobStates: readonly PrintJobState[];
export declare const waybillProviders: readonly WaybillProvider[];
export declare const waybillRequestStates: readonly WaybillRequestState[];
export declare const mediaContentTypes: readonly MediaContentType[];
export declare const mediaPurposes: readonly MediaPurpose[];
export declare const mediaResourceTypes: readonly MediaResourceType[];
export declare const fulfillmentAssets: readonly FulfillmentAsset[];
export declare const arbitrationOutcomes: readonly ArbitrationOutcome[];
export declare const settlementRails: readonly SettlementRail[];
export declare const settlementIntentStates: readonly SettlementIntentState[];
export declare const settlementRequestStates: readonly SettlementRequestState[];
export declare const settlementBatchStates: readonly SettlementBatchState[];
export declare const merchantGuaranteeDepositStates: readonly MerchantGuaranteeDepositState[];
export declare const guaranteeStatuses: readonly GuaranteeStatus[];
export declare const breakerActions: readonly BreakerAction[];
export declare const breakerCauseTypes: readonly BreakerCauseType[];
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const rewardSubtypes: readonly RewardSubtype[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const policyDraftStates: readonly PolicyDraftState[];
export declare const cmsContentTypes: readonly CmsContentType[];
export declare const cmsContentFormats: readonly CmsContentFormat[];
export declare const cmsPublicationEventTypes: readonly CmsPublicationEventType[];
export declare const notificationChannels: readonly NotificationChannel[];
export declare const notificationProviders: readonly NotificationProvider[];
export declare const notificationEndpointStates: readonly NotificationEndpointState[];
export declare const notificationCampaignTopics: readonly NotificationCampaignTopic[];
export declare const notificationCampaignStates: readonly NotificationCampaignState[];
export declare const notificationDeliveryStates: readonly NotificationDeliveryState[];
export declare const systemConfigKeys: readonly SystemConfigKey[];
export declare const auditStreamNames: readonly AuditStreamName[];
export declare const auditEvidenceProfiles: readonly AuditEvidenceProfile[];
export declare const operationsMetricComponents: readonly OperationsMetricComponent[];
export declare const operationsMetricUnits: readonly OperationsMetricUnit[];
export declare const operationsMetricStatuses: readonly OperationsMetricStatus[];
export declare const operationsAlertEventTypes: readonly OperationsAlertEventType[];
export declare const operationsAlertSeverities: readonly OperationsAlertSeverity[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];
export declare const riskSignalTypes: readonly RiskSignalType[];
export declare const riskSourceTypes: readonly RiskSourceType[];
export declare const riskSubjectTypes: readonly RiskSubjectType[];
export declare const riskRestrictionKinds: readonly RiskRestrictionKind[];
export declare const riskRestrictionStates: readonly RiskRestrictionState[];
export declare const riskAppealStates: readonly RiskAppealState[];

export type JsonObject = Readonly<Record<string, unknown>>;

export interface MerchantLifecycleSummary {
  merchantId: string;
  shopName: string | null;
  settlementWallet: Address;
  settlementWalletMutable: false;
  status: MerchantLifecycleStatus;
  level: MerchantLevel;
  guaranteeStatus: GuaranteeStatus;
  applicationVersion: number;
  qualificationComplete: boolean;
  reviewedAt: Timestamp | null;
  reviewedBy: Address | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type MerchantQualification =
  | {
      access: 'FULL' | 'REDACTED';
      legalName: string | null;
      legalId: string | null;
      contactPhone: string | null;
      licenseAssetId: Bytes32 | null;
      payloadHash: Bytes32;
      retentionPolicyVersion: string | null;
      version: number;
      updatedAt: Timestamp;
    }
  | { access: 'UNAVAILABLE'; reason: 'PARTIAL_LEGACY'; licenseAssetId: null };

export interface MerchantLifecycleList {
  artifactVersion: typeof artifactVersion;
  merchants: readonly MerchantLifecycleSummary[];
  nextCursor: Readonly<{ createdAt: Timestamp; merchantId: string }> | null;
}

export interface MerchantApplicationCreateRequest {
  shopName: string;
  legalName: string;
  legalId: string;
  contactPhone: string;
  settlementWallet: Address;
  level: MerchantLevel;
  idempotencyKey: string;
}

export interface MerchantApplicationUpdateRequest {
  shopName: string;
  legalName: string;
  legalId: string;
  contactPhone: string;
  level: MerchantLevel;
  licenseAssetId: Bytes32 | null;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface MerchantReviewChallengeRequest {
  action: MerchantReviewAction;
  reasonCode: string;
  idempotencyKey: string;
}

export interface MerchantReviewPublishRequest { signature: string }

export interface MerchantReviewChallenge {
  artifactVersion: typeof artifactVersion;
  actionId: Bytes32;
  merchantId: string;
  action: MerchantReviewAction;
  fromStatus: MerchantLifecycleStatus;
  toStatus: MerchantLifecycleStatus;
  applicationVersion: number;
  reasonCode: string;
  state: 'DRAFT' | 'PUBLISHED' | 'EXPIRED';
  secondarySigner: Address;
  expiresAt: Timestamp;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface MerchantReviewEvidence {
  actionId: Bytes32;
  action: MerchantReviewAction;
  fromStatus: MerchantLifecycleStatus;
  toStatus: MerchantLifecycleStatus;
  applicationVersion: number;
  reasonCode: string;
  state: 'DRAFT' | 'PUBLISHED' | 'EXPIRED';
  secondarySigner: Address | null;
  actionDigest: Bytes32 | null;
  safeTxHash: Bytes32 | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MerchantNamedAmounts {
  listPriceUsdt: AtomicAmount;
  buyerPaidUsdt: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
}

export interface MerchantLifecycleDetail {
  artifactVersion: typeof artifactVersion;
  merchant: MerchantLifecycleSummary;
  qualification: MerchantQualification;
  levelPolicy: Readonly<{ status: 'DecisionBlocked'; reason: string }>;
  analytics: Readonly<{
    orders: {
      totalFinalized: AtomicAmount;
      ordinaryFinalized: AtomicAmount;
      seckillFinalized: AtomicAmount;
      cumulative: MerchantNamedAmounts;
      today: MerchantNamedAmounts;
      timezone: 'Asia/Shanghai';
      window: Readonly<{ start: Timestamp; end: Timestamp }>;
    };
    fulfillment: {
      pendingShipment: AtomicAmount;
      inTransit: AtomicAmount;
      completed: AtomicAmount;
      pickupCompleted: AtomicAmount;
      fastShip48h: Readonly<{
        status: 'DecisionBlocked'; numerator: null; denominator: null; bps: null; reason: string;
      }>;
    };
    risk: {
      takeoverCases: AtomicAmount;
      guaranteeUsedUsdt: AtomicAmount;
      frozenReceivableUsedUsdt: AtomicAmount;
      futureProceedsUsedUsdt: AtomicAmount;
      platformAdvanceUsdt: AtomicAmount;
      outstandingDebtUsdt: AtomicAmount;
      abnormalOrderRateBps: null;
      unavailableReason: 'DecisionBlocked';
    };
    contributions: {
      finalizedNplBurnAmount: AtomicAmount;
      fulfillmentAvailableBnmAmount: AtomicAmount;
      ledgerReconciled: true;
    };
  }>;
  balances: readonly Readonly<{
    state: 'LOCKED' | 'AVAILABLE' | 'REQUESTED' | 'BATCHED' | 'SETTLED'; amount: AtomicAmount;
  }>[];
  settlements: readonly Readonly<{
    requestId: Bytes32; asset: 'USDT' | 'NPL'; amount: AtomicAmount; state: SettlementRequestState;
    requestedAt: Timestamp; safeTxHash: Bytes32 | null; settledAt: Timestamp | null;
  }>[];
  reviews: readonly MerchantReviewEvidence[];
}

export interface PrinterBindingChallengeRequest {
  provider: PrintProvider;
  deviceId: string;
  idempotencyKey: string;
}

export interface PrinterBindingChallenge {
  artifactVersion: typeof artifactVersion;
  challengeId: Bytes32;
  storeId: string;
  merchantId: string;
  signer: Address;
  expiresAt: Timestamp;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface ApplyPrinterBindingRequest {
  challengeId: Bytes32;
  signature: string;
  idempotencyKey: string;
}

export interface PrinterBinding {
  artifactVersion: typeof artifactVersion;
  bindingId: Bytes32;
  storeId: string;
  merchantId: string;
  provider: PrintProvider;
  deviceId: string;
  bindingHash: Bytes32;
  version: number;
  verifiedByWallet: Address;
  signatureHash: Bytes32;
  updatedAt: Timestamp;
}

export interface WaybillBatchRequest {
  provider: WaybillProvider;
  carrierCode: LogisticsCarrierCode;
  storeId: string;
  orderIds: readonly string[];
  idempotencyKey: string;
}

export interface WaybillResult {
  artifactVersion: typeof artifactVersion;
  requestId: Bytes32;
  batchId: Bytes32;
  merchantId: string;
  orderId: string;
  storeId: string;
  provider: WaybillProvider;
  carrierCode: WaybillBatchRequest['carrierCode'];
  state: WaybillRequestState;
  providerReference: string | null;
  trackingNumber: string | null;
  trackingNumberHash: Bytes32 | null;
  shipmentEvidenceHash: Bytes32 | null;
  printJobId: Bytes32 | null;
  errorCode: string | null;
  updatedAt: Timestamp;
}

export interface WaybillBatchResult {
  artifactVersion: typeof artifactVersion;
  batchId: Bytes32;
  items: readonly WaybillResult[];
}

export interface PrintJob {
  artifactVersion: typeof artifactVersion;
  printJobId: Bytes32;
  merchantId: string;
  orderId: string;
  storeId: string;
  jobKind: 'WAYBILL' | 'PICKUP_RECEIPT';
  provider: PrintProvider | null;
  deviceId: string | null;
  copyCount: 1 | 2;
  contentHash: Bytes32;
  state: PrintJobState;
  attempts: number;
  providerReference: string | null;
  errorCode: string | null;
  nextAttemptAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PrintJobRetryRequest { idempotencyKey: string }

export interface LogisticsCarrierConfigRequest {
  carriers: readonly Readonly<{ carrierCode: LogisticsCarrierCode; enabled: boolean }>[];
  defaultCarrierCode: LogisticsCarrierCode;
  idempotencyKey: string;
}

export interface LogisticsCarrierConfig {
  artifactVersion: typeof artifactVersion;
  configVersionId: Bytes32 | null;
  version: number;
  defaultCarrierCode: LogisticsCarrierCode | null;
  readiness: 'READY' | 'CONFIGURATION_REQUIRED';
  carriers: readonly Readonly<{ carrierCode: LogisticsCarrierCode; enabled: boolean }>[];
  createdBy: Address | null;
  createdAt: Timestamp | null;
}

export interface LogisticsProviderConfigRequest {
  provider: WaybillProvider;
  enabled: boolean;
  partnerIdSecretRef: string;
  credentialSecretRef: string;
  monthlyAccountSecretRef: string;
  callbackSecretRef: string;
  idempotencyKey: string;
}

export interface LogisticsProviderConfig {
  provider: WaybillProvider;
  providerConfigVersionId: Bytes32 | null;
  version: number;
  enabled: boolean;
  configured: boolean;
  configuredFields: Readonly<{
    partnerId: boolean; credential: boolean; monthlyAccount: boolean; callbackSecret: boolean;
  }>;
  configHash: Bytes32 | null;
  readiness: LogisticsProviderReadiness;
  createdBy: Address | null;
  createdAt: Timestamp | null;
}

export interface LogisticsProviderConfigList {
  artifactVersion: typeof artifactVersion;
  providers: readonly LogisticsProviderConfig[];
}

export interface LogisticsWarehouseRequest {
  warehouseKind: LogisticsWarehouseKind;
  name: string;
  partnerName: string | null;
  contactName: string;
  phone: string;
  regionCode: string;
  addressLine: string;
  enabled: boolean;
  idempotencyKey: string;
}

export interface LogisticsWarehouseUpdateRequest extends LogisticsWarehouseRequest {
  expectedVersion: number;
}

export interface LogisticsWarehouseDeactivateRequest {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface LogisticsWarehouse {
  artifactVersion: typeof artifactVersion;
  warehouseId: string;
  warehouseVersionId: Bytes32;
  version: number;
  warehouseKind: LogisticsWarehouseKind;
  name: string;
  partnerName: string | null;
  regionCode: string;
  enabled: boolean;
  access: LogisticsWarehouseAccess;
  contactName: string | null;
  phone: string | null;
  addressLine: string | null;
  payloadHash: Bytes32;
  createdBy: Address;
  createdAt: Timestamp;
}

export interface LogisticsWarehouseList {
  artifactVersion: typeof artifactVersion;
  warehouses: readonly LogisticsWarehouse[];
}

export interface AdminWaybillBatchRequest extends WaybillBatchRequest { merchantId: string }

export interface AdminWaybillList {
  artifactVersion: typeof artifactVersion;
  waybills: readonly WaybillResult[];
}

export interface AdminPrintJobList {
  artifactVersion: typeof artifactVersion;
  printJobs: readonly PrintJob[];
}

export interface SeckillSessionProduct {
  productId: string;
  skuId: string;
  title: string;
  metadata: JsonObject;
  attributes: JsonObject;
  seckillListPriceUsdt: AtomicAmount;
}

export interface SeckillSessionTimers {
  mainDurationSeconds: number;
  relayInitialSeconds: number;
  relayIncrementSeconds: number;
  relayCapSeconds: number;
}

export interface SeckillSessionInventory {
  total: AtomicAmount;
  sold: AtomicAmount;
  reserved: AtomicAmount;
  available: AtomicAmount;
}

export interface SeckillSessionProjection {
  artifactVersion: typeof artifactVersion;
  sessionId: Bytes32;
  policyVersion: AtomicAmount;
  merchantId: string;
  product: SeckillSessionProduct;
  phase: SeckillState;
  storedPhase: SeckillState;
  serverTime: string;
  startsAt: string;
  mainDeadline: string;
  relayDeadline: string;
  settlementEarliestAt: string;
  settlementDeadline: string;
  timers: SeckillSessionTimers;
  inventory: SeckillSessionInventory;
  prizePoolUsdt: AtomicAmount;
  lastBuyerWallet: Address | null;
  winnerWallet: Address | null;
  snapshot: JsonObject;
  governanceActionId: Bytes32 | null;
  rulesContentHash: Bytes32 | null;
  publicationTxHash: Bytes32 | null;
  allowedActions: readonly string[];
}

export interface SeckillSessionHistoryPage {
  items: readonly SeckillSessionProjection[];
  nextCursor: string | null;
}

export type SeckillGovernanceActionKind = 'OPEN_SESSION' | 'FORCE_CLOSE' | 'RESUME_PURCHASES' | 'PRIZE_INJECTION';
export type SeckillGovernanceActionState =
  | 'DRAFT' | 'SECONDARY_SIGNED' | 'PENDING_PROPOSAL' | 'SAFE_PROPOSED'
  | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED' | 'CANCELLED';

export interface SeckillSessionCreateRequest {
  policyVersion: AtomicAmount;
  rulesContentHash: Bytes32;
  productId: string;
  skuId: string;
  inventory: number;
  seckillListPriceUsdt: AtomicAmount;
  startsAt: string;
  idempotencyKey: string;
}

export interface SeckillForceCloseRequest { reasonCode: string; idempotencyKey: string }
export interface SeckillPrizeInjectionRequest { amountUsdt: AtomicAmount; idempotencyKey: string }
export interface SeckillBreakerResumeRequest { sessionId: Bytes32; idempotencyKey: string }
export interface SeckillGovernanceChallengeRequest { nonce: AtomicAmount; deadline: AtomicAmount }
export interface SeckillGovernanceApprovalRequest extends SeckillGovernanceChallengeRequest { signature: string }

export interface SeckillGovernanceChallenge {
  artifactVersion: typeof artifactVersion;
  actionId: Bytes32;
  sessionId: Bytes32;
  actionKind: SeckillGovernanceActionKind;
  signer: Address;
  safeAddress: Address;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface SeckillSessionPlanProjection {
  merchantId: string;
  productId: string;
  skuId: string;
  productPolicyHash: Bytes32;
  rulesContentHash: Bytes32;
  startsAt: string;
  mainDeadline: string;
  relayDeadline: string;
  inventory: AtomicAmount;
  seckillListPriceUsdt: AtomicAmount;
  timers: SeckillSessionTimers;
  snapshot: JsonObject;
  inventoryLockState: 'LOCKED' | 'RELEASED';
  releasedAt: string | null;
}

export interface SeckillPrizeInjectionProjection {
  injectionId: Bytes32;
  amountUsdt: AtomicAmount;
  operationsSafeAddress: Address;
  custodySafeAddress: Address;
  tokenAddress: Address;
  finalJournalId: string | null;
  reversalJournalId: string | null;
}

export interface SeckillGovernanceActionProjection {
  artifactVersion: typeof artifactVersion;
  actionId: Bytes32;
  sessionId: Bytes32;
  policyVersion: AtomicAmount;
  actionKind: SeckillGovernanceActionKind;
  state: SeckillGovernanceActionState;
  evidenceHash: Bytes32;
  safeAddress: Address;
  targetAddress: Address;
  calldataHash: Bytes32;
  safeNonce: AtomicAmount | null;
  safeTxHash: Bytes32 | null;
  proposalHash: Bytes32 | null;
  executionTxHash: Bytes32 | null;
  blockNumber: AtomicAmount | null;
  blockHash: Bytes32 | null;
  confirmations: number;
  canonical: boolean | null;
  actorWallet: Address;
  secondarySigner: Address | null;
  approvalNonce: AtomicAmount | null;
  approvalDeadline: string | null;
  createdAt: string;
  updatedAt: string;
  sessionPlan: SeckillSessionPlanProjection | null;
  prizeInjection: SeckillPrizeInjectionProjection | null;
  allowedActions: readonly string[];
}

export interface RealtimeEventEnvelope {
  artifactVersion: typeof artifactVersion;
  protocolVersion: 1;
  eventId: string;
  channel: string;
  cursor: AtomicAmount;
  eventType: 'SeckillRelayExtended';
  resourceType: 'SECKILL_SESSION';
  resourceId: Bytes32;
  occurredAt: string;
  finality: 'FINAL';
  payload: JsonObject;
}

export interface RealtimeEventPage {
  items: readonly RealtimeEventEnvelope[];
  nextCursor: AtomicAmount;
}

export interface SensitiveApproval {
  action: string;
  resourceType: string;
  resourceId: string;
  policyVersion: AtomicAmount;
  oldValueHash: Bytes32;
  newValueHash: Bytes32;
  safeAddress: Address;
  nonce: AtomicAmount;
  deadline: AtomicAmount;
  signature: string;
}

export interface SettlementIntentRequest {
  rail: 'MERCHANT_USDT' | 'REWARD_NPL' | 'PRIZE_USDT';
  amount: AtomicAmount;
  idempotencyKey: string;
}

export interface GovernedSettlementIntentRequest {
  rail: 'TAKEOVER_USDT' | 'OPERATIONS_REIMBURSEMENT_USDT';
  resourceId: string;
  orderId: string;
  accountId: string;
  recipient: Address;
  fulfillmentTargetHash?: Bytes32;
  amount: AtomicAmount;
  idempotencyKey: string;
  approval: SensitiveApproval;
}

export interface SettlementRequestSubmission {
  intentId: Bytes32;
  signature: string;
}

export interface SettlementRequestIntent {
  intentId: Bytes32;
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  recipient: Address;
  rail: SettlementRail;
  asset: Address;
  safeAddress: Address;
  amount: AtomicAmount;
  itemsHash: Bytes32;
  nonce: AtomicAmount;
  deadline: number;
}

export interface SettlementIntentItem {
  itemIndex: number;
  orderId: string;
  accountId: string;
  backingSafeAddress: Address;
  amount: AtomicAmount;
  itemHash: Bytes32;
}

export interface Eip712TypedData {
  domain: JsonObject;
  types: JsonObject;
  primaryType: string;
  message: JsonObject;
}

export interface SettlementIntentProjection {
  intent: SettlementRequestIntent;
  digest: Bytes32;
  typedData: Eip712TypedData;
  items: readonly SettlementIntentItem[];
  createdAt: string;
}

export interface SettlementRequestItem {
  item_index: number;
  order_id: string;
  account_id: string;
  backing_safe_address: Address;
  amount: AtomicAmount;
  requested_journal_id: string;
  batched_journal_id: string | null;
  settled_journal_id: string | null;
}

export interface SettlementRequestItemTransition {
  transition_id: string;
  request_item_index: number;
  batch_id: string | null;
  transition_sequence: AtomicAmount;
  transition_type: string;
  journal_id: string;
  created_at: string;
}

export interface SettlementRequestProjection {
  request_id: string;
  intent_id: Bytes32;
  artifact_version: typeof artifactVersion;
  wallet_address: Address;
  recipient_address: Address;
  rail: SettlementRail;
  asset: 'USDT' | 'NPL';
  asset_address: Address;
  safe_address: Address;
  amount: AtomicAmount;
  items_hash: Bytes32;
  intent_digest: Bytes32;
  signature_hash: Bytes32;
  state: SettlementRequestState;
  batch_id: string | null;
  final_safe_tx_hash: Bytes32 | null;
  final_execution_tx_hash: Bytes32 | null;
  requested_at: string;
  batched_at: string | null;
  settled_at: string | null;
  items: readonly SettlementRequestItem[];
  transitions: readonly SettlementRequestItemTransition[];
}

export interface SettlementBalance {
  asset: 'USDT' | 'NPL';
  purpose: string;
  rewardSubtype: RewardSubtype | null;
  state: BalanceState;
  amount: AtomicAmount;
}

export interface BnmPointsBalance {
  pointsType: 'BNM';
  purpose: 'BNM_LIABILITY';
  state: 'LOCKED' | 'AVAILABLE';
  amount: AtomicAmount;
  transferable: false;
}

export interface SettlementListProjection {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  balances: readonly SettlementBalance[];
  points: readonly BnmPointsBalance[];
  requests: readonly SettlementRequestProjection[];
}

export interface GuaranteeDepositRequest {
  policyVersion: AtomicAmount;
  expectedAmountUsdt: AtomicAmount;
  transactionHash: Bytes32;
  idempotencyKey: string;
}

export interface GuaranteeDepositProjection {
  depositId: string;
  merchantId: string;
  policyVersion: number;
  transactionHash: Bytes32;
  expectedAmountUsdt: AtomicAmount;
  operationsSafeAddress: Address;
  state: MerchantGuaranteeDepositState;
  confirmations: number;
  blockNumber?: number;
  blockHash?: Bytes32;
  logIndex?: number;
}

export interface TakeoverFundingChallengeRequest {
  caseId: string;
  requiredUsdt: AtomicAmount;
  nonce: AtomicAmount;
  deadline: AtomicAmount;
}

export interface TakeoverFundingRequest {
  caseId: string;
  requiredUsdt: AtomicAmount;
  idempotencyKey: string;
  approval: SensitiveApproval;
}

export interface TakeoverFundingReceivable {
  orderId: string;
  accountId: string;
  backingSafeAddress: Address;
  amount: AtomicAmount;
}

export interface TakeoverFundingPlan {
  caseId: string;
  orderId: string;
  policyVersion: number;
  requiredUsdt: AtomicAmount;
  operationsSafe: Address;
  guaranteeUsedUsdt: AtomicAmount;
  receivables: readonly TakeoverFundingReceivable[];
  frozenReceivablesUsedUsdt: AtomicAmount;
  platformAdvanceUsdt: AtomicAmount;
  oldValueHash: Bytes32;
  newValueHash: Bytes32;
}

export interface TakeoverFundingChallenge {
  plan: TakeoverFundingPlan;
  typedData: Eip712TypedData;
}

export interface TakeoverFundingResult {
  caseId: string;
  state: 'FUNDED';
  requiredUsdt: AtomicAmount;
  guaranteeUsedUsdt: AtomicAmount;
  frozenReceivablesUsedUsdt: AtomicAmount;
  futureProceedsUsedUsdt: AtomicAmount;
  platformAdvanceUsdt: AtomicAmount;
  merchantDebtUsdt: AtomicAmount;
}

export interface MerchantFinanceMerchant {
  merchant_id: string;
  status: string;
  guarantee_status: GuaranteeStatus;
  settlement_wallet: Address;
}

export interface MerchantGuarantee {
  backing_safe_address: Address;
  balance_usdt: AtomicAmount;
  minimum_usdt: AtomicAmount;
  source_evidence_hash: Bytes32;
  updated_at: string;
}

export interface MerchantGuaranteeDeposit {
  deposit_id: string;
  policy_version: AtomicAmount;
  token_address: Address;
  operations_safe_address: Address;
  expected_amount_usdt: AtomicAmount;
  transaction_hash: Bytes32;
  state: MerchantGuaranteeDepositState;
  observed_block_number: AtomicAmount | null;
  observed_block_hash: Bytes32 | null;
  observed_log_index: number | null;
  confirmations: number;
  transfer_evidence_hash: Bytes32 | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}

export interface MerchantDebt {
  incurred_usdt: AtomicAmount;
  recovered_usdt: AtomicAmount;
  outstanding_usdt: AtomicAmount;
  latest_evidence_hash: Bytes32;
  updated_at: string;
}

export interface MerchantTakeover {
  case_id: string;
  order_id: string;
  state: TakeoverState;
  required_usdt: AtomicAmount | null;
  guarantee_used_usdt: AtomicAmount | null;
  merchant_available_used_usdt: AtomicAmount | null;
  future_proceeds_used_usdt: AtomicAmount | null;
  platform_advance_usdt: AtomicAmount | null;
  disbursed_usdt: AtomicAmount | null;
  merchant_debt_usdt: AtomicAmount | null;
  evidence_hash: Bytes32;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

export interface MerchantFinanceProjection {
  merchant: MerchantFinanceMerchant;
  guarantee: MerchantGuarantee | null;
  guaranteeDeposits: readonly MerchantGuaranteeDeposit[];
  debt: MerchantDebt | null;
  takeovers: readonly MerchantTakeover[];
}

export interface TakeoverFundingProjection {
  case_id: string;
  state: TakeoverState;
  required_usdt: AtomicAmount | null;
  guarantee_used_usdt: AtomicAmount | null;
  merchant_available_used_usdt: AtomicAmount | null;
  future_proceeds_used_usdt: AtomicAmount | null;
  platform_advance_usdt: AtomicAmount | null;
  merchant_debt_usdt: AtomicAmount | null;
}

export interface TakeoverFundingItem {
  source_type: string;
  amount_usdt: AtomicAmount;
  journal_id: string;
  evidence_hash: Bytes32;
  created_at: string;
}

export interface MerchantDebtRecovery {
  recovery_id: string;
  order_id: string;
  amount_usdt: AtomicAmount;
  operations_safe_address: Address;
  backing_safe_address: Address;
  journal_id: string;
  evidence_hash: Bytes32;
  recovered_at: string;
  reversed_at: string | null;
  reversal_evidence_hash: Bytes32 | null;
}

export interface TakeoverFundingDetail extends TakeoverFundingProjection {
  items: readonly TakeoverFundingItem[];
  debtRecoveries: readonly MerchantDebtRecovery[];
}

export interface PolicyDraftCreateRequest { payload: JsonObject; idempotencyKey: string }
export interface PolicyDraftUpdateRequest { payload: JsonObject }
export interface PolicyApprovalChallengeRequest { nonce: AtomicAmount; deadline: AtomicAmount }
export interface PolicySecondarySignatureRequest extends PolicyApprovalChallengeRequest { signature: string }

export interface PolicyDraftProjection {
  draftId: string;
  nextPolicyVersion: AtomicAmount;
  basePolicyVersion: AtomicAmount | null;
  artifactVersion: string | null;
  payload: JsonObject;
  validationErrors: readonly Readonly<{ code: string; field: string }>[];
  state: PolicyDraftState;
  policyHash: Bytes32 | null;
  operationsHash: Bytes32 | null;
  publicationDigest: Bytes32 | null;
  publicationNonce: AtomicAmount | null;
  publicationDeadline: string | null;
  secondarySigner: Address | null;
  secondarySignatureHash: Bytes32 | null;
  safeAddress: Address | null;
  safeCalldataHash: Bytes32 | null;
  safeTxHash: Bytes32 | null;
  safeProposalHash: Bytes32 | null;
  createdBy: Address;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDraftTransition {
  transitionId: string;
  fromState: PolicyDraftState | null;
  toState: PolicyDraftState;
  evidenceHash: Bytes32;
  actorWallet: Address;
  createdAt: string;
}

export interface PolicyDraftDetail extends PolicyDraftProjection {
  transitions: readonly PolicyDraftTransition[];
}

export interface PolicyApprovalChallenge {
  draftId: string;
  policyVersion: number;
  signer: Address;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface CoverageBreakerResumeChallengeRequest { nonce: AtomicAmount; deadline: AtomicAmount }
export interface CoverageBreakerResumeRequest extends CoverageBreakerResumeChallengeRequest {
  snapshotId: Bytes32;
  signature: string;
}

export interface CoverageBreakerResumeChallenge {
  artifactVersion: string;
  snapshotId: Bytes32;
  evidenceHash: Bytes32;
  policyVersion: AtomicAmount;
  signer: Address;
  safeAddress: Address;
  routerAddress: Address;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface CoverageBreakerActionProjection {
  artifactVersion: string;
  actionId: Bytes32;
  snapshotId: Bytes32;
  policyVersion: AtomicAmount;
  action: 'PAUSE' | 'RESUME';
  targetPaused: boolean;
  evidenceHash: Bytes32;
  governanceSafeAddress: Address;
  routerAddress: Address;
  calldataHash: Bytes32;
  state: 'PENDING_PROPOSAL' | 'SAFE_PROPOSED' | 'MINED' | 'FINAL' | 'REORGED' | 'FAILED' | 'SUPERSEDED';
  safeNonce: AtomicAmount | null;
  safeTxHash: Bytes32 | null;
  proposalHash: Bytes32 | null;
  executionTxHash: Bytes32 | null;
  confirmations: number;
  actorWallet: Address | null;
  secondarySigner: Address | null;
  secondarySignatureHash: Bytes32 | null;
  approvalNonce: AtomicAmount | null;
  approvalDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CmsVersionCreateRequest {
  entryId?: string;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  contentFormat: CmsContentFormat;
  content: JsonObject;
  audience: JsonObject;
  startsAt?: string;
  endsAt?: string;
  frequencyCap?: number;
  policyVersion?: AtomicAmount;
  idempotencyKey: string;
}

export interface CmsVersionProjection {
  entryId: string;
  versionId: string;
  version: number;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  contentFormat: CmsContentFormat;
  content: JsonObject;
  contentHash: Bytes32;
  audience: JsonObject;
  startsAt: string | null;
  endsAt: string | null;
  frequencyCap: number | null;
  policyVersion: AtomicAmount | null;
  published: boolean;
  publicationType: CmsPublicationEventType | null;
  createdBy: Address;
  createdAt: string;
}

export interface CmsPublicItem {
  entryId: string;
  versionId: string;
  version: number;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  content: JsonObject;
  contentHash: Bytes32;
  audience: JsonObject;
  startsAt: string | null;
  endsAt: string | null;
  frequencyCap: number | null;
  policyVersion: AtomicAmount | null;
}

export interface NotificationEndpointRequest {
  channel: NotificationChannel;
  provider: NotificationProvider;
  endpointReference: string;
  topics: readonly string[];
  regionCode?: string;
}

export interface NotificationEndpointProjection {
  endpointId: string;
  channel: NotificationChannel;
  provider: NotificationProvider;
  topics: readonly string[];
  state: NotificationEndpointState;
}

export interface NotificationInboxItem {
  messageId: string;
  sourceEventType: string;
  topic: string;
  templateData: JsonObject;
  deliveryState: NotificationDeliveryState;
  createdAt: string;
}

export interface NotificationCampaignRequest {
  topic: NotificationCampaignTopic;
  audience: JsonObject;
  message: JsonObject;
  cmsVersionId?: string;
  startsAt?: string;
  endsAt?: string;
  idempotencyKey: string;
}

export interface NotificationCampaignCreateResult {
  campaignId: string;
  state: NotificationCampaignState;
  contentHash: Bytes32;
}

export interface NotificationCampaignPublishResult { campaignId: string; state: 'PUBLISHED' }

export interface SystemConfigCreateRequest {
  configKey: SystemConfigKey;
  payload: JsonObject;
  effectiveFrom: string;
  idempotencyKey: string;
}

export interface SystemConfigProjection {
  configVersionId: string;
  configKey: SystemConfigKey;
  version: number;
  payload: JsonObject;
  payloadHash: Bytes32;
  effectiveFrom: string;
  published: boolean;
  createdBy: Address;
  createdAt: string;
}

export interface AuditEntry {
  entryId: string;
  sourceEventId: string;
  streamName: AuditStreamName;
  evidenceProfile: AuditEvidenceProfile;
  sequence: AtomicAmount;
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet: Address | null;
  actorRole: string | null;
  correlationId: string;
  requestHash: string;
  payload: JsonObject;
  signatureEvidence: JsonObject | null;
  authorizationEvidence: JsonObject | null;
  transactionEvidence: JsonObject | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface AuditChainProof { verified: boolean; entries: number; headHash: string | null }
export interface AuditCursor { createdAt: string; entryId: string }
export interface AuditListResponse {
  entries: readonly AuditEntry[];
  chainProof: Readonly<Partial<Record<AuditStreamName, AuditChainProof>>>;
  nextCursor: AuditCursor | null;
}

export interface MonitoringMetric {
  snapshotId: string;
  component: OperationsMetricComponent;
  metricName: string;
  unit: OperationsMetricUnit;
  value: number | null;
  status: OperationsMetricStatus;
  windowStartedAt: string;
  windowEndedAt: string;
  evidence: JsonObject;
  observedAt: string;
}

export interface MonitoringAlert {
  alertEventId: string;
  alertKey: string;
  state: OperationsAlertEventType;
  severity: OperationsAlertSeverity;
  snapshotId: string;
  actorWallet: Address | null;
  createdAt: string;
}

export interface MonitoringCoverage {
  asset: 'USDT' | 'NPL';
  safe_address: Address;
  assets: AtomicAmount;
  unsettled_liabilities: AtomicAmount;
  covered: boolean;
  observed_at: string;
}

export interface MonitoringDashboard {
  metrics: readonly MonitoringMetric[];
  alerts: readonly MonitoringAlert[];
  coverage: readonly MonitoringCoverage[];
}

export interface MonitoringAcknowledgeResult { alertKey: string; state: 'ACKNOWLEDGED' }

export interface BusinessDayWindow { start: string; end: string; generatedAt: string }
export interface BusinessRatio { numerator: AtomicAmount; denominator: AtomicAmount; bps: AtomicAmount | null }

export interface MerchantBusinessDashboard {
  artifactVersion: typeof artifactVersion;
  timezone: 'Asia/Shanghai';
  window: BusinessDayWindow;
  merchant: { merchantId: string; status: string; level: string; guaranteeStatus: GuaranteeStatus };
  product: {
    productId: string;
    title: string;
    state: CatalogProductLifecycleState;
    stock: { total: AtomicAmount; available: AtomicAmount; reserved: AtomicAmount };
    seckill: { sessionId: Bytes32; phase: SeckillState } | null;
    updatedAt: string;
  } | null;
  orders: {
    finalizedToday: AtomicAmount; pendingShipment: AtomicAmount; shipped: AtomicAmount;
    delivered: AtomicAmount; fulfilled: AtomicAmount; arbitration: AtomicAmount;
    takeover: AtomicAmount; pickupVerifiedToday: AtomicAmount;
  };
  sales: {
    listPriceUsdt: AtomicAmount; buyerUsdtPaid: AtomicAmount;
    merchantBaseReceivableUsdt: AtomicAmount; merchantNetReceivableUsdt: AtomicAmount;
  };
  shipmentRate: BusinessRatio;
  settlements: { requestedCount: AtomicAmount; requestedUsdt: AtomicAmount; settledCount: AtomicAmount; settledUsdt: AtomicAmount };
}

export interface AdminBusinessDashboard {
  artifactVersion: typeof artifactVersion;
  timezone: 'Asia/Shanghai';
  window: BusinessDayWindow;
  orders: {
    finalizedToday: AtomicAmount; listPriceUsdt: AtomicAmount; buyerUsdtPaid: AtomicAmount;
    pendingShipment: AtomicAmount; shipped: AtomicAmount; delivered: AtomicAmount;
    fulfilled: AtomicAmount; shipmentRate: BusinessRatio;
  };
  merchants: { total: AtomicAmount; newToday: AtomicAmount; pending: AtomicAmount; approved: AtomicAmount; suspended: AtomicAmount };
  products: { total: AtomicAmount; pendingReview: AtomicAmount; soldOut: AtomicAmount };
  seckill: { createdToday: AtomicAmount; active: AtomicAmount; settling: AtomicAmount };
  fulfillmentQueues: { exchange: AtomicAmount; delay: AtomicAmount; arbitration: AtomicAmount; forcedReceipt: AtomicAmount; takeover: AtomicAmount };
  settlements: { requestedCount: AtomicAmount; requestedUsdt: AtomicAmount; settledCount: AtomicAmount; settledUsdt: AtomicAmount; failedTransactions: AtomicAmount };
  coverage: readonly {
    snapshotId: string; blockNumber: AtomicAmount; recordedAt: string; asset: 'USDT' | 'NPL';
    safeAddress: Address; verifiedAssets: AtomicAmount; unsettledLiabilities: AtomicAmount; covered: boolean;
  }[];
  breakers: readonly { scope: BreakerScope; paused: boolean }[];
  risk: {
    abnormalObservationsToday: AtomicAmount;
    blacklistBlocksToday: AtomicAmount;
    activeRestrictions: AtomicAmount;
    pendingAppeals: AtomicAmount;
  };
  unavailable: readonly { metric: string; reasonCode: 'DecisionBlocked' | 'ExternalBlocked'; detail: string }[];
}

export interface RiskObservationRequest {
  observationId: Bytes32;
  signalType: RiskSignalType;
  sourceType: RiskSourceType;
  walletAddress: Address;
  ipHash?: Bytes32;
  deviceHash?: Bytes32;
  resourceId?: string;
  txHash?: Bytes32;
  gasPriceWei?: AtomicAmount;
  evidenceHash: Bytes32;
  observedAt: string;
}

export interface RiskObservation {
  observationId: Bytes32;
  signalType: RiskSignalType;
  sourceType: RiskSourceType;
  walletAddress: Address;
  ipHash: Bytes32 | null;
  deviceHash: Bytes32 | null;
  resourceId: string | null;
  txHash: Bytes32 | null;
  gasPriceWei: AtomicAmount | null;
  evidenceHash: Bytes32;
  observedAt: string;
  recordedAt: string;
}

export interface RiskRestriction {
  restrictionId: Bytes32;
  subjectType: RiskSubjectType;
  subjectValue: string;
  restrictionKind: RiskRestrictionKind;
  triggerType: 'HIGH_GAS' | 'WALLET_SWITCH' | 'ORDER_CANCELLATION' | 'SUBJECT_BLACKLIST' | 'MANUAL';
  reasonCode: string;
  evidenceHash: Bytes32;
  sourceObservationId: Bytes32 | null;
  state: RiskRestrictionState;
  startsAt: string;
  expiresAt: string | null;
  createdBy: Address | null;
  overrideBy: Address | null;
  overrideReasonCode: string | null;
  overrideEvidenceHash: Bytes32 | null;
  overrideAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskAppeal {
  appealId: Bytes32;
  restrictionId: Bytes32;
  submittedBy: Address;
  statementHash: Bytes32;
  evidenceHash: Bytes32;
  state: RiskAppealState;
  decidedBy: Address | null;
  decisionReasonCode: string | null;
  decisionEvidenceHash: Bytes32 | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskObservationResult {
  artifactVersion: typeof artifactVersion;
  observation: RiskObservation;
  restrictions: readonly RiskRestriction[];
}

export interface RiskOverview {
  artifactVersion: typeof artifactVersion;
  generatedAt: string;
  observations: readonly RiskObservation[];
  restrictions: readonly RiskRestriction[];
  appeals: readonly RiskAppeal[];
  decisionBlocked: readonly {
    capability: string;
    reasonCode: 'DecisionBlocked' | 'ExternalBlocked';
  }[];
}

export interface RiskRestrictionCreateRequest {
  subjectType: RiskSubjectType;
  subjectValue: string;
  restrictionKind: RiskRestrictionKind;
  reasonCode: string;
  evidenceHash: Bytes32;
  expiresAt?: string;
  idempotencyKey: string;
}

export interface RiskOverrideRequest { reasonCode: string; evidenceHash: Bytes32 }
export interface RiskAppealCreateRequest {
  restrictionId: Bytes32;
  statementHash: Bytes32;
  evidenceHash: Bytes32;
  idempotencyKey: string;
}
export interface RiskAppealDecisionRequest {
  decision: 'APPROVE' | 'REJECT';
  reasonCode: string;
  evidenceHash: Bytes32;
}

export interface ProductPolicy {
  policyVersion: number;
  oracleVersion: Bytes32;
  usdtPaymentBps: number;
  nplPaymentBps: number;
  nplBurnListPriceBps: number;
  nplRewardListPriceBps: number;
  genesisBps: number;
  directReferralBps: number;
  districtBps: number;
  cityBps: number;
  provinceBps: number;
  regionBps: number;
  operationsBps: number;
  platformFeeBps: number;
  seckillPrizeBps: number;
  oracleWindowSeconds: 1800;
  oracleMaxDeviationBps: 500;
  oracleMaxAgeSeconds: 600;
  oracleMinimumUsdtLiquidity: AtomicAmount;
  requiredConfirmations: 15;
  merchantGuaranteeMinimumUsdt: AtomicAmount;
  usdtCustodySafe: Address;
  nplRewardSafe: Address;
  operationsTreasurySafe: Address;
  circulationPool: Address;
  concessionDestinationSetHash: Bytes32;
  concessionDestinations: readonly WeightedDestination[];
  operationsDestinations: readonly WeightedDestination[];
  otherUsdtDestinations: readonly WeightedDestination[];
  seckillPrizePoolAccount: Address;
}

export interface WeightedDestination {
  account: Address;
  weightBps: number;
}

export interface CatalogSeckillInventory {
  total: AtomicAmount;
  sold: AtomicAmount;
  reserved: AtomicAmount;
  available: AtomicAmount;
}

export interface CatalogSeckillOverlay {
  sessionId: Bytes32;
  policyVersion: AtomicAmount;
  phase: 'PREHEAT' | 'LIVE' | 'SETTLING';
  startsAt: Timestamp;
  mainDeadline: Timestamp;
  relayDeadline: Timestamp;
  seckillListPriceUsdt: AtomicAmount;
  inventory: CatalogSeckillInventory;
  ordinaryCheckoutAllowed: false;
}

export interface CatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  attributes: Readonly<Record<string, unknown>>;
  listPriceUsdt: AtomicAmount;
  stockAvailable: AtomicAmount;
  seckill: CatalogSeckillOverlay | null;
}

export interface CatalogProduct {
  productId: string;
  chainProductId: Bytes32;
  title: string;
  subtitle: string;
  metadata: Readonly<Record<string, unknown>>;
  mainImageAssetIds: readonly Bytes32[];
  videoAssetId: Bytes32 | null;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId: string | null;
  tagIds: readonly string[];
  skus: readonly CatalogSku[];
}

export interface CatalogCategory {
  categoryId: string;
  version: AtomicAmount;
  parentCategoryId: string | null;
  level: 1 | 2 | 3;
  name: string;
  iconAssetId: Bytes32 | null;
  sortOrder: number;
  status: CatalogTaxonomyStatus;
  serviceFee: Readonly<{ state: 'Frozen' | 'DecisionBlocked'; valueBps: number | null }>;
}

export interface CatalogTag {
  tagId: string;
  version: AtomicAmount;
  name: string;
  example: string;
  sortOrder: number;
  status: CatalogTaxonomyStatus;
}

export interface ProductSkuInput {
  skuId?: string;
  attributes: JsonObject;
  listPriceUsdt: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  stockTotal: number;
  proposedSeckillInventory: number;
}

export interface ProductSlotInput {
  idempotencyKey: string;
  title: string;
  subtitle?: string;
  mainImageAssetIds?: readonly Bytes32[];
  videoAssetId?: Bytes32;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  merchantConcessionBps: number;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId?: string;
  tagIds?: readonly string[];
  skus: readonly ProductSkuInput[];
}

export interface AdminProductSlotInput extends ProductSlotInput {
  merchantId: string;
}

export interface CatalogWriteLock {
  type: string;
  id: string;
  state: string;
}

export interface ManagedCatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  version: AtomicAmount;
  attributes: JsonObject;
  listPriceUsdt: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  stockTotal: AtomicAmount;
  stockAvailable: AtomicAmount;
  stockReserved: AtomicAmount;
  proposedSeckillInventory: AtomicAmount;
  lifecycleState: CatalogProductLifecycleState;
}

export interface ManagedCatalogProduct {
  artifactVersion: typeof artifactVersion;
  productId: string;
  chainProductId: Bytes32;
  merchantId: string;
  storeId: string | null;
  supersedesProductId: string | null;
  version: AtomicAmount;
  title: string;
  subtitle: string;
  lifecycleState: CatalogProductLifecycleState;
  productPolicyHash: Bytes32;
  merchantConcessionBps: number;
  mainImageAssetIds: readonly Bytes32[];
  videoAssetId: Bytes32 | null;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId: string | null;
  tagIds: readonly string[];
  skus: readonly ManagedCatalogSku[];
  allowedActions: readonly CatalogProductAction[];
  writeLock: CatalogWriteLock | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSlotProjection {
  artifactVersion: typeof artifactVersion;
  storeId: string;
  merchantId: string;
  product: ManagedCatalogProduct | null;
  allowedActions: readonly CatalogProductAction[];
  writeLock: CatalogWriteLock | null;
}

export interface MerchantConcessionAllocation {
  account: Address;
  amount: AtomicAmount;
}

export interface MerchantConcessionPreviewItem {
  skuId: string;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionBps: number;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  allocations: readonly MerchantConcessionAllocation[];
}

export interface MerchantConcessionPreviewPayload {
  artifactVersion: typeof artifactVersion;
  productId: string;
  productVersion: number;
  merchantId: string;
  policyVersion: number;
  merchantConcessionBps: number;
  destinationSetHash: Bytes32;
  catalogFingerprint: Bytes32;
  items: readonly MerchantConcessionPreviewItem[];
  expiresAt: string;
}

export interface CatalogSignedAuthorization extends Eip712TypedData {
  primaryType: 'MerchantConcessionPreview';
  digest: Bytes32;
  signature: string;
  signer: Address;
}

export interface MerchantConcessionPreview {
  artifactVersion: typeof artifactVersion;
  previewId: Bytes32;
  productId: string;
  productVersion: AtomicAmount;
  merchantId: string;
  policyVersion: AtomicAmount;
  merchantConcessionBps: number;
  catalogFingerprint: Bytes32;
  destinationSetHash: Bytes32;
  previewHash: Bytes32;
  payload: MerchantConcessionPreviewPayload;
  authorization: CatalogSignedAuthorization;
  expiresAt: string;
  createdAt: string;
}

export interface MediaUploadIntentProjection {
  artifactVersion: typeof artifactVersion;
  uploadIntentId: Bytes32;
  ownerWallet: Address;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  state: 'UPLOADED';
  expiresAt: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Readonly<Record<string, string>>;
  providerReferenceHash: Bytes32;
  writeOnce: true;
}

export interface MediaAssetProjection {
  artifactVersion: typeof artifactVersion;
  assetId: Bytes32;
  uploadIntentId: Bytes32;
  ownerWallet: Address;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  providerEvidenceHash: Bytes32;
  objectVersionHash: Bytes32;
  createdAt: string;
}

export interface MediaReadAccessProjection {
  artifactVersion: typeof artifactVersion;
  assetId: Bytes32;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  objectVersionHash: Bytes32;
  accessScope: 'PUBLIC' | 'AUTHENTICATED';
  method: 'GET';
  readUrl: string;
  expiresAt: string;
  providerReferenceHash: Bytes32;
}

export interface EvidenceEnvelopeProjection {
  artifactVersion: typeof artifactVersion;
  evidenceHash: Bytes32;
  ownerWallet: Address;
  actorRole: 'BUYER' | 'MERCHANT' | 'ADMIN' | 'OPERATOR';
  purpose: 'FULFILLMENT_ACTION' | 'SHIPMENT_TRACKING';
  resourceType: 'ORDER';
  resourceId: string;
  action: string;
  reasonCode: string | null;
  trackingNumberHash: Bytes32 | null;
  mediaAssetIds: readonly Bytes32[];
  payload: JsonObject;
  carrierCode?: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
  createdAt: string;
}

export interface InventoryAdjustmentProjection {
  artifactVersion: typeof artifactVersion;
  adjustmentId: Bytes32;
  skuId: string;
  beforeTotal: AtomicAmount;
  beforeAvailable: AtomicAmount;
  delta: string;
  afterTotal: AtomicAmount;
  afterAvailable: AtomicAmount;
  reasonCode: string;
  actorWallet: Address;
  createdAt: string;
}

export interface MerchantStore {
  storeId: string;
  merchantId: string;
  name: string;
  regionCode: string;
  longitude: number;
  latitude: number;
  address: string;
  phone: string;
  businessHours: string;
  imageAssetIds: readonly Bytes32[];
  status: StoreStatus;
  version: number;
}

export type MerchantStoreAction = 'UPDATE_PROFILE' | 'ACTIVATE' | 'CLOSE';
export type MerchantStoreActionReason = 'STORE_PROFILE_INCOMPLETE' | 'STORE_SUSPENDED' | 'STORE_CLOSED' | 'STORE_STATE_MISMATCH';

export interface MerchantStoreCapability {
  action: MerchantStoreAction;
  enabled: boolean;
  reasonCode?: MerchantStoreActionReason;
}

export interface MerchantManagedStore extends MerchantStore {
  artifactVersion: typeof artifactVersion;
  allowedActions: readonly MerchantStoreCapability[];
}

export interface CreateMerchantStoreRequest {
  idempotencyKey: string;
  name: string;
  phone: string;
  businessHours: string;
  longitude: number;
  latitude: number;
}

export interface UpdateMerchantStoreRequest {
  name: string;
  phone: string;
  businessHours: string;
  imageAssetIds: readonly Bytes32[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface MerchantStoreVersionRequest {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface CreateDeliveryTargetRequest {
  idempotencyKey: string;
  recipientName: string;
  phone: string;
  address: string;
  longitude: number;
  latitude: number;
}

export interface CreatePickupTargetRequest {
  idempotencyKey: string;
  storeId: string;
}

export interface FulfillmentTargetSummary {
  targetId: string;
  targetHash: Bytes32;
  fulfillmentMode: FulfillmentMode;
  regionCode: string;
  regionCodeHash: Bytes32;
  expiresAt: string;
}

export interface DeliveryTarget extends FulfillmentTargetSummary {
  fulfillmentMode: 'DELIVERY';
}

export interface PickupTarget extends FulfillmentTargetSummary {
  fulfillmentMode: 'PICKUP';
  storeId: string;
  store: MerchantStore;
}

export interface DeliveryTargetPayload {
  recipientName: string;
  phone: string;
  address: string;
  longitude: number;
  latitude: number;
  regionCode: string;
}

export type FulfillmentTarget =
  | (DeliveryTarget & { payload: DeliveryTargetPayload })
  | (Omit<PickupTarget, 'store'> & { payload: MerchantStore });

export interface FulfillmentExactAmounts {
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplQuoteAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  nplBurnAmount: AtomicAmount;
  nplRewardAmount: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  bnmAmount: AtomicAmount;
}

export interface FulfillmentRequestProjection {
  requestId: string;
  requestType: FulfillmentRequestType;
  state: FulfillmentRequestState;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface ShipmentProjection {
  shipmentId: string;
  carrierCode: string;
  trackingNumberHash: Bytes32;
  providerReferenceHash: Bytes32 | null;
  createdAt: string;
}

export interface LogisticsProjection {
  logisticsEventId: string;
  provider: LogisticsProvider;
  status: LogisticsStatus;
  locationHash: Bytes32 | null;
  occurredAt: string;
}

export interface FulfillmentBalance {
  asset: FulfillmentAsset;
  state: BalanceState;
  amount: AtomicAmount;
}

export interface FulfillmentOrder {
  orderId: Bytes32;
  artifactVersion: string;
  buyerWallet: Address;
  merchantId: string;
  merchantWallet: Address;
  productId: string;
  skuId: string;
  quantity: AtomicAmount;
  createdAt: Timestamp;
  orderKind: OrderKind;
  paymentTxHash: Bytes32 | null;
  fulfillmentMode: FulfillmentMode;
  state: OrderProjectionState;
  finalityStatus: OrderFinalityStatus;
  exactAmounts: FulfillmentExactAmounts;
  paidAt: string | null;
  paymentFinalizedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  fulfilledAt: string | null;
  takeoverOpenedAt: string | null;
  arbitrationOpenedAt: string | null;
  requests: readonly FulfillmentRequestProjection[];
  shipments: readonly ShipmentProjection[];
  logistics: readonly LogisticsProjection[];
  balances: readonly FulfillmentBalance[];
  allowedActions: readonly AllowedAction[];
}

export interface FulfillmentOrderCursor {
  createdAt: Timestamp;
  orderId: string;
}

export interface FulfillmentOrderPage {
  orders: readonly FulfillmentOrder[];
  nextCursor: FulfillmentOrderCursor | null;
}

export interface AdminOrderSearchPage extends FulfillmentOrderPage {
  pausedScopes: readonly BreakerScope[];
  breaker: Readonly<{ scope: BreakerScope; active: boolean }> | null;
  pendingProductReview: boolean | null;
}

export interface AdminBatchCapability {
  action: AdminBatchAction;
  enabled: boolean;
  reasonCode?: 'Forbidden' | 'ProductWriteLocked';
}

export interface AdminResourceSummary {
  resourceType: AdminResourceType;
  resourceId: string;
  title: string;
  status: string;
  merchantId: string | null;
  productId: string | null;
  tagIds: readonly string[];
  allowedBatchActions: readonly AdminBatchCapability[];
  createdAt: Timestamp;
}

export interface AdminGlobalSearchResponse {
  artifactVersion: typeof artifactVersion;
  relation: 'AND';
  resources: readonly AdminResourceSummary[];
  truncated: boolean;
  unavailableFilters: readonly ('OR' | 'FUZZY_WALLET' | 'UID' | 'PHONE' | 'YELLOW_QUEUE')[];
}

export interface AdminResourceSelection {
  resourceType: AdminResourceType;
  resourceId: string;
}

export interface AdminResourceExportRequest {
  selection: readonly AdminResourceSelection[];
  format: AdminExportFormat;
  idempotencyKey: string;
}

export interface AdminResourceExport {
  artifactVersion: typeof artifactVersion;
  exportId: Bytes32;
  format: AdminExportFormat;
  filename: string;
  mediaType: 'text/csv; charset=utf-8' | 'application/vnd.ms-excel; charset=utf-8';
  rowCount: number;
  byteLength: number;
  contentHash: Bytes32;
  contentBase64: string;
  createdAt: Timestamp;
}

export interface AdminProductBatchTagRequest {
  productIds: readonly string[];
  tagIds: readonly string[];
  idempotencyKey: string;
}

export interface AdminProductBatchTagItem {
  productId: string;
  previousVersion: AtomicAmount;
  version: AtomicAmount;
  addedTagIds: readonly string[];
}

export interface AdminProductBatchTagResult {
  artifactVersion: typeof artifactVersion;
  operationId: Bytes32;
  action: 'ADD_PRODUCT_TAGS';
  tagIds: readonly string[];
  changedCount: number;
  products: readonly AdminProductBatchTagItem[];
  createdAt: Timestamp;
}

export interface OrderBatchActionPreviewRow {
  orderId: Bytes32;
  allowedActions: readonly AllowedAction[];
}

export interface OrderBatchActionPreview {
  rows: readonly OrderBatchActionPreviewRow[];
  enabledActionIntersection: readonly AllowedActionName[];
}

export interface FulfillmentCommandInput {
  idempotencyKey: string;
  evidenceHash: Bytes32;
}

export interface FulfillmentReasonRequest extends FulfillmentCommandInput {
  reasonCode: string;
}

export interface ShipmentRequest extends FulfillmentCommandInput {
  carrierCode: string;
  trackingNumberHash: Bytes32;
  providerReferenceHash?: Bytes32;
}

export interface ShipmentBatchItemRequest extends ShipmentRequest {
  orderId: Bytes32;
  carrierCode: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
}

export interface ShipmentBatchRequest {
  idempotencyKey: string;
  items: readonly ShipmentBatchItemRequest[];
}

export interface PickupCredentialRequest extends FulfillmentCommandInput {
  code: string;
  expiresAt: string;
}

export interface PickupVerificationRequest extends FulfillmentCommandInput {
  code: string;
  storeId: string;
}

export interface FulfillmentRequestDecision extends FulfillmentCommandInput {
  requestId: string;
  approved: boolean;
  noteCode: string;
}

export interface FulfillmentDecision extends FulfillmentCommandInput {
  approved: boolean;
  noteCode: string;
}

export interface ArbitrationDecision extends FulfillmentCommandInput {
  outcome: ArbitrationOutcome;
  noteCode: string;
}

export interface LogisticsWebhookRequest {
  eventId: string;
  orderId: Bytes32;
  status: LogisticsStatus;
  occurredAt: string;
  locationHash?: Bytes32;
}

export interface ShipmentResult {
  orderId: Bytes32;
  state: 'SHIPPED';
  shipmentId: string;
  carrierCode: string;
  trackingNumberHash: Bytes32;
  recordedAt: string;
}

export interface ShipmentBatchResult {
  batchId: Bytes32;
  shipments: readonly ShipmentResult[];
  createdAt: Timestamp;
}

export interface DeliveryResult {
  orderId: Bytes32;
  state: 'DELIVERED';
  deliveredAt: string;
}

export interface LogisticsUpdateResult {
  orderId: Bytes32;
  logisticsEventId: string;
  provider: LogisticsProvider;
  status: LogisticsStatus;
  state: 'SHIPPED' | 'DELIVERED';
  occurredAt: string;
}

export interface PickupCredentialResult {
  orderId: Bytes32;
  credentialId: string;
  expiresAt: string;
}

export interface FulfillmentRequestResult {
  orderId: Bytes32;
  requestId: string;
  requestType: 'EXCHANGE' | 'DELAY';
  state: 'OPEN';
  requestedAt: string;
}

export interface FulfillmentRequestDecisionResult {
  orderId: Bytes32;
  requestId: string;
  requestType: 'EXCHANGE' | 'DELAY';
  state: 'APPROVED' | 'REJECTED';
  decidedAt: string;
}

export interface ArbitrationOpenedResult {
  orderId: Bytes32;
  requestId: string;
  state: 'ARBITRATION';
  openedAt: string;
}

export interface ArbitrationResumedResult {
  orderId: Bytes32;
  state: 'SHIPPED' | 'DELIVERED' | 'TAKEOVER' | 'FULFILLMENT_PENDING';
  outcome: 'RESUME_FULFILLMENT';
  decidedAt: string;
}

export interface TakeoverOpenedResult {
  orderId: Bytes32;
  caseId: string;
  state: 'TAKEOVER';
  customerFundsRemainLocked: true;
}

export interface ForcedReceiptRequestResult {
  orderId: Bytes32;
  requestId: string;
  state: 'OPEN';
  platformReviewRequired: true;
  canFinalizeDirectly: false;
}

export interface ForcedReceiptRejectedResult {
  orderId: Bytes32;
  state: 'DELIVERED';
  approved: false;
  decidedAt: string;
}

export interface FulfillmentCompletedResult {
  orderId: Bytes32;
  state: 'FULFILLED';
  method: FulfillmentMethod;
  fulfilledAt: string;
}

export type ArbitrationDecisionResult = FulfillmentCompletedResult | ArbitrationResumedResult;
export type ForcedReceiptDecisionResult = FulfillmentCompletedResult | ForcedReceiptRejectedResult;
export type FulfillmentCommandResult =
  | ShipmentResult
  | DeliveryResult
  | LogisticsUpdateResult
  | PickupCredentialResult
  | FulfillmentRequestResult
  | FulfillmentRequestDecisionResult
  | ArbitrationOpenedResult
  | ArbitrationResumedResult
  | TakeoverOpenedResult
  | ForcedReceiptRequestResult
  | ForcedReceiptRejectedResult
  | FulfillmentCompletedResult;

export interface InventoryReservation {
  reservationId: Bytes32;
  reservationHash: Bytes32;
  policyVersion: number;
  skuId: Bytes32;
  buyerWallet: Address;
  quantity: number;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
  state: ReservationState;
  expiresAt: string;
}

export interface BeneficiarySnapshot {
  genesis: Address;
  directReferral: Address;
  district: Address;
  city: Address;
  province: Address;
  region: Address;
}

export interface MerchantConcessionAllocation {
  account: Address;
  amount: AtomicAmount;
}

export interface OtherUsdtAllocation extends MerchantConcessionAllocation {
  purpose: UsdtLiabilityPurpose;
}

export type NplRewardRole = 'genesis' | 'directReferral' | 'district' | 'city' | 'province' | 'region' | 'operations' | 'roundingRemainder';

export interface NplRewardAllocation extends MerchantConcessionAllocation {
  role: NplRewardRole;
}

export interface AllocationSnapshot {
  beneficiaries: BeneficiarySnapshot;
  concession: readonly MerchantConcessionAllocation[];
  otherUsdt: readonly OtherUsdtAllocation[];
  nplRewards: readonly NplRewardAllocation[];
}

export interface PaymentRouterIntent {
  orderId: Bytes32;
  policyVersion: number;
  oracleVersion: Bytes32;
  buyer: Address;
  merchant: Address;
  productId: Bytes32;
  skuId: Bytes32;
  quantity: number;
  fulfillmentMode: 0 | 1;
  fulfillmentTargetHash: Bytes32;
  regionCodeHash: Bytes32;
  productPolicyHash: Bytes32;
  reservationId: Bytes32;
  reservationHash: Bytes32;
  reservationDeadline: number;
  issuedAt: number;
  deadline: number;
  nonce: AtomicAmount;
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplQuoteAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  nplBurnAmount: AtomicAmount;
  nplRewardAmount: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionBps: number;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  concessionAllocationHash: Bytes32;
  bnmAmount: AtomicAmount;
  seckill: boolean;
  sessionId: Bytes32;
  beneficiaries: BeneficiarySnapshot;
}

export interface CanonicalPaymentIntent extends Omit<PaymentRouterIntent, 'fulfillmentMode'> {
  fulfillmentMode: FulfillmentMode;
  merchantConcessionAllocations: readonly MerchantConcessionAllocation[];
  otherUsdtAllocations: readonly OtherUsdtAllocation[];
  nplRewardAllocations: readonly NplRewardAllocation[];
  requiredConfirmations: 15;
}

export interface ApprovalRequirement {
  token: Address;
  spender: Address;
  requiredAmount: AtomicAmount;
  requestedAllowance: AtomicAmount;
  approvalMode: 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED';
  risk: 'UNLIMITED_TOKEN_ALLOWANCE';
  revocation: Readonly<{ method: 'ERC20_APPROVE_ZERO'; token: Address; spender: Address }>;
}

export interface Eip712Domain {
  name: 'Abu24KPaymentRouter';
  version: '2';
  chainId: 56;
  verifyingContract: Address;
}

export interface PaymentBuyerAuthorization {
  domain: Eip712Domain;
  types: Readonly<{ PaymentAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
  primaryType: 'PaymentAuthorization';
  message: Readonly<{
    paymentHash: Bytes32;
    orderId: Bytes32;
    buyer: Address;
    merchant: Address;
    productId: Bytes32;
    skuId: Bytes32;
    quantity: number;
    fulfillmentMode: 0 | 1;
    listPriceUsdt: AtomicAmount;
    usdtPaymentAmount: AtomicAmount;
    nplPaymentAmount: AtomicAmount;
    deadline: number;
  }>;
  digest: Bytes32;
}

export interface SeckillBuyerAuthorization {
  domain: Eip712Domain;
  types: Readonly<{ SeckillAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
  primaryType: 'SeckillAuthorization';
  message: Readonly<{
    seckillHash: Bytes32;
    orderId: Bytes32;
    buyer: Address;
    merchant: Address;
    productId: Bytes32;
    skuId: Bytes32;
    quantity: number;
    fulfillmentMode: 0 | 1;
    seckillListPriceUsdt: AtomicAmount;
    seckillUsdtPaymentAmount: AtomicAmount;
    seckillNplPaymentAmount: AtomicAmount;
    fallbackListPriceUsdt: AtomicAmount;
    fallbackUsdtPaymentAmount: AtomicAmount;
    fallbackNplPaymentAmount: AtomicAmount;
    deadline: number;
  }>;
  digest: Bytes32;
}

export interface OrdinaryRouterCall {
  functionName: 'pay';
  intent: PaymentRouterIntent;
  quoteSignature: string;
}

export interface SeckillRouterCall {
  functionName: 'paySeckill';
  intent: Readonly<{
    sessionId: Bytes32;
    seckillPayment: PaymentRouterIntent;
    fallbackPayment: PaymentRouterIntent;
  }>;
  quoteSignature: string;
}

export type PaymentQuoteState = 'QUOTED' | 'SUBMITTED' | 'PAID' | 'REORGED' | 'EXPIRED';

export interface PaymentQuoteResponse {
  artifactVersion: typeof artifactVersion;
  orderId: Bytes32;
  state: PaymentQuoteState;
  paymentRouterAddress: Address;
  intent: CanonicalPaymentIntent;
  snapshotHash: Bytes32;
  authorizationDigest: Bytes32;
  buyerAuthorization: PaymentBuyerAuthorization;
  quoteSignature: string;
  submittedTxHash: Bytes32 | null;
  approvalRequirements: readonly ApprovalRequirement[];
  routerCall: OrdinaryRouterCall;
}

export interface CanonicalSeckillIntent {
  sessionId: Bytes32;
  seckill: CanonicalPaymentIntent;
  fallback: CanonicalPaymentIntent;
  classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP';
}

export interface SeckillQuoteResponse {
  artifactVersion: typeof artifactVersion;
  orderId: Bytes32;
  state: PaymentQuoteState;
  paymentRouterAddress: Address;
  dual: CanonicalSeckillIntent;
  seckillHash: Bytes32;
  snapshotHashes: Readonly<{ seckill: Bytes32; fallback: Bytes32 }>;
  authorizationDigest: Bytes32;
  buyerAuthorization: SeckillBuyerAuthorization;
  quoteSignature: string;
  submittedTxHash: Bytes32 | null;
  approvalRequirements: readonly ApprovalRequirement[];
  routerCall: SeckillRouterCall;
}

export interface PaymentSubmissionRequest {
  orderId: Bytes32;
  txHash: Bytes32;
  replacementForTxHash?: Bytes32;
}

export interface PaymentSubmissionResponse {
  orderId: Bytes32;
  txHash: Bytes32;
  state: 'SUBMITTED';
}

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: AllowedActionReasonCode;
  deadline?: string;
}

export interface BuyerProfile {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  accountId: null;
  accountIdStatus: 'DecisionBlocked';
  nickname: string | null;
  avatarAssetId: Bytes32 | null;
  version: number;
  updatedAt: Timestamp | null;
}

export interface BuyerSavedAddress {
  addressId: string;
  label: string;
  recipientName: string;
  phone: string;
  detailAddress: string;
  longitude: number;
  latitude: number;
  province: string;
  city: string;
  district: string;
  formattedAddress: string;
  regionCode: string;
  isDefault: boolean;
  version: number;
  updatedAt: Timestamp;
}

export interface BuyerOverviewCount {
  status: 'AVAILABLE';
  count: AtomicAmount;
}

export interface BuyerOverview {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  orderCounts: Readonly<{
    pendingPayment: Readonly<{
      status: 'DecisionBlocked';
      count: null;
      blocker: 'BUYER_PENDING_PAYMENT_PROJECTION';
    }>;
    pendingShipment: BuyerOverviewCount;
    pendingReceipt: BuyerOverviewCount;
    afterSale: BuyerOverviewCount;
    total: BuyerOverviewCount;
  }>;
}

export interface BuyerTakeoverTransition {
  transitionId: string;
  fromState: TakeoverState | null;
  toState: TakeoverState;
  evidenceType: string;
  occurredAt: Timestamp;
}

export interface BuyerTakeoverTimeline {
  artifactVersion: typeof artifactVersion;
  orderId: string;
  historyStatus: 'COMPLETE' | 'PARTIAL_LEGACY';
  transitions: readonly BuyerTakeoverTransition[];
}

export interface MerchantProfile {
  artifactVersion: typeof artifactVersion;
  merchantId: string;
  shopName: string | null;
  logoAssetId: Bytes32 | null;
  settlementWallet: Address;
  settlementWalletMutable: false;
  version: number;
  updatedAt: Timestamp;
}

export interface MerchantAuditEntry {
  entryId: string;
  operationTime: Timestamp;
  operationType: string;
  module: string;
  detail: string;
  signatureHash: Bytes32 | null;
  safeOrChainTxHash: Bytes32 | null;
  entryHash: string;
}

export interface MerchantAuditList {
  entries: readonly MerchantAuditEntry[];
  proofScope: 'MERCHANT_SCOPED_ENTRY_HASHES';
  historyStatus: 'PARTIAL_PRE_MERCHANT_SCOPE';
  chainProof: Readonly<{ merchantId: string; entries: number }>;
  nextCursor: Readonly<{ createdAt: Timestamp; entryId: string }> | null;
}

export interface MerchantAuditExport {
  merchantId: string;
  contentType: 'text/csv; charset=utf-8';
  filename: string;
  entryCount: number;
  csv: string;
}

export interface PaymentFinality {
  transactionHash: Bytes32;
  replacementForTxHash: Bytes32 | null;
  blockNumber: number;
  blockHash: Bytes32;
  confirmations: number;
  requiredConfirmations: 15;
  receiptStatus: 1;
  state: 'MINED' | 'REORGED' | 'FINAL';
  canonicalBlock: boolean;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
}

export type PaymentProjection = (PaymentQuoteResponse | SeckillQuoteResponse) & { finality: PaymentFinality | null };

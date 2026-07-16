export const CORE_ARTIFACT_VERSION = '2.0.0-settlement-admin.12';
export const BSC_CHAIN_ID = 56;
export const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
export const NPL_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
export const NPL_USDT_PAIR_ADDRESS = '0x2955e33bb120714abf11ace2766e614e6e5955b2';
export const REQUIRED_CONFIRMATIONS = 15;

export const orderProjectionStates = [
  'QUOTED',
  'SUBMITTED',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'ARBITRATION',
  'TAKEOVER',
  'FULFILLMENT_PENDING',
  'FULFILLED',
  'REORG_PENDING',
] as const;
export type OrderState = (typeof orderProjectionStates)[number];

export const contractOrderStates = [
  'NONE',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'ARBITRATION',
  'TAKEOVER',
  'FULFILLMENT_PENDING',
  'FULFILLED',
] as const;
export type ContractOrderState = (typeof contractOrderStates)[number];

export const finalityStates = ['SUBMITTED', 'MINED', 'REPLACED', 'REORGED', 'FINAL', 'FAILED'] as const;
export type FinalityState = (typeof finalityStates)[number];

export const orderFinalityStatuses = [
  'NOT_SUBMITTED',
  'PENDING',
  'CONFIRMED',
  'REPLACED',
  'REORGED',
  'FINAL',
] as const;
export type OrderFinalityStatus = (typeof orderFinalityStatuses)[number];

export const userRoles = ['BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'] as const;
export type UserRole = (typeof userRoles)[number];

export const merchantLevels = ['V1', 'V2', 'V3', 'V4', 'V5'] as const;
export type MerchantLevel = (typeof merchantLevels)[number];

export const merchantLifecycleStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLACKLISTED'] as const;
export type MerchantLifecycleStatus = (typeof merchantLifecycleStatuses)[number];

export const merchantReviewActions = ['APPROVE', 'REJECT', 'BLACKLIST'] as const;
export type MerchantReviewAction = (typeof merchantReviewActions)[number];

export const merchantQualificationAccess = ['FULL', 'REDACTED', 'UNAVAILABLE'] as const;
export type MerchantQualificationAccess = (typeof merchantQualificationAccess)[number];

export const adminResourceTypes = ['ORDER', 'PRODUCT', 'MERCHANT'] as const;
export type AdminResourceType = (typeof adminResourceTypes)[number];

export const adminExportFormats = ['CSV', 'EXCEL'] as const;
export type AdminExportFormat = (typeof adminExportFormats)[number];

export const adminBatchActions = ['EXPORT_CSV', 'EXPORT_EXCEL', 'ADD_PRODUCT_TAGS'] as const;
export type AdminBatchAction = (typeof adminBatchActions)[number];

export const breakerScopes = [
  'NEW_PAYMENT',
  'SECKILL_PURCHASE',
  'NEW_SETTLEMENT_BATCH',
] as const;
export type BreakerScope = (typeof breakerScopes)[number];

export const allowedActionNames = [
  'PAY_ORDER',
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'DECIDE_FULFILLMENT_REQUEST',
  'CONFIRM_RECEIPT',
  'REQUEST_FORCED_RECEIPT',
  'VERIFY_PICKUP',
  'OPEN_ARBITRATION',
  'OPEN_TAKEOVER',
  'RECORD_SHIPMENT',
  'RECORD_DELIVERY',
  'REGISTER_PICKUP_CREDENTIAL',
  'DECIDE_ARBITRATION',
  'DECIDE_FORCED_RECEIPT',
  'REQUEST_MERCHANT_SETTLEMENT',
  'REQUEST_REWARD_SETTLEMENT',
  'REQUEST_PRIZE_SETTLEMENT',
  'RECONCILE',
  'RECOVER_SURPLUS',
] as const;
export type AllowedActionName = (typeof allowedActionNames)[number];

export const executableOrderActionNames = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'DECIDE_FULFILLMENT_REQUEST',
  'CONFIRM_RECEIPT',
  'REQUEST_FORCED_RECEIPT',
  'VERIFY_PICKUP',
  'OPEN_ARBITRATION',
  'OPEN_TAKEOVER',
  'RECORD_SHIPMENT',
  'RECORD_DELIVERY',
  'REGISTER_PICKUP_CREDENTIAL',
  'DECIDE_ARBITRATION',
  'DECIDE_FORCED_RECEIPT',
] as const satisfies readonly AllowedActionName[];

export const allowedActionReasonCodes = [
  'ArtifactVersionMismatch',
  'BreakerActive',
  'ConfigurationRequired',
  'DecisionBlocked',
  'ExternalBlocked',
  'FinalityPending',
  'Forbidden',
  'MerchantFrozen',
  'PickupTakeoverDecisionBlocked',
  'UnknownState',
] as const;
export type AllowedActionReasonCode = (typeof allowedActionReasonCodes)[number];

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: AllowedActionReasonCode;
  deadline?: string;
}

export const fulfillmentModes = ['DELIVERY', 'PICKUP'] as const;
export type FulfillmentMode = (typeof fulfillmentModes)[number];

export const fulfillmentMethods = [
  'CUSTOMER_RECEIPT',
  'PICKUP_VERIFICATION',
  'FORCED_RECEIPT',
  'ARBITRATION',
] as const;
export type FulfillmentMethod = (typeof fulfillmentMethods)[number];

export const storeStatuses = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type StoreStatus = (typeof storeStatuses)[number];

export const catalogProductLifecycleStates = [
  'DRAFT',
  'REVIEW',
  'SCHEDULED',
  'ACTIVE',
  'SOLD_OUT',
  'HIDDEN',
  'DELISTED',
  'LOCKED',
] as const;
export type CatalogProductLifecycleState = (typeof catalogProductLifecycleStates)[number];

export const catalogTaxonomyStatuses = ['ENABLED', 'DISABLED', 'DELETED'] as const;
export type CatalogTaxonomyStatus = (typeof catalogTaxonomyStatuses)[number];

export const catalogReviewDecisions = ['APPROVE', 'REJECT', 'PUBLISH', 'HIDE', 'DELIST'] as const;
export type CatalogReviewDecision = (typeof catalogReviewDecisions)[number];

export const catalogProductActions = [
  'SAVE_DRAFT',
  'CREATE_CONCESSION_PREVIEW',
  'SUBMIT_REVIEW',
  'APPROVE',
  'REJECT',
  'PUBLISH',
  'ADJUST_INVENTORY',
  'HIDE',
  'DELIST',
] as const;
export type CatalogProductAction = (typeof catalogProductActions)[number];

export const mediaPurposes = [
  'PRODUCT_IMAGE',
  'PRODUCT_VIDEO',
  'CATEGORY_ICON',
  'STORE_IMAGE',
  'FULFILLMENT_EVIDENCE',
  'BUYER_AVATAR',
  'MERCHANT_LOGO',
  'MERCHANT_LICENSE',
] as const;
export type MediaPurpose = (typeof mediaPurposes)[number];

export const mediaResourceTypes = ['PRODUCT', 'CATEGORY', 'STORE', 'ORDER', 'BUYER', 'MERCHANT'] as const;
export type MediaResourceType = (typeof mediaResourceTypes)[number];

export const mediaContentTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'application/pdf',
] as const;
export type MediaContentType = (typeof mediaContentTypes)[number];

export const fulfillmentRequestTypes = ['EXCHANGE', 'DELAY', 'ARBITRATION', 'FORCED_RECEIPT'] as const;
export type FulfillmentRequestType = (typeof fulfillmentRequestTypes)[number];

export const fulfillmentRequestStates = ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED'] as const;
export type FulfillmentRequestState = (typeof fulfillmentRequestStates)[number];

export const logisticsProviders = ['KUAIDI100', 'CAINIAO'] as const;
export type LogisticsProvider = (typeof logisticsProviders)[number];

export const logisticsCarrierCodes = ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] as const;
export type LogisticsCarrierCode = (typeof logisticsCarrierCodes)[number];

export const logisticsWarehouseKinds = ['PLATFORM', 'PARTNER'] as const;
export type LogisticsWarehouseKind = (typeof logisticsWarehouseKinds)[number];

export const logisticsWarehouseAccessLevels = ['FULL', 'REDACTED'] as const;
export type LogisticsWarehouseAccess = (typeof logisticsWarehouseAccessLevels)[number];

export const logisticsProviderReadinessStates = ['READY', 'DISABLED', 'CONFIGURATION_REQUIRED'] as const;
export type LogisticsProviderReadiness = (typeof logisticsProviderReadinessStates)[number];

export const logisticsStatuses = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] as const;
export type LogisticsStatus = (typeof logisticsStatuses)[number];

export const printProviders = ['FEIE', 'YILIANYUN'] as const;
export type PrintProvider = (typeof printProviders)[number];

export const waybillProviders = ['KUAIDI100', 'CAINIAO'] as const;
export type WaybillProvider = (typeof waybillProviders)[number];

export const printJobStates = [
  'CONFIGURATION_REQUIRED',
  'QUEUED',
  'PROCESSING',
  'ACCEPTED',
  'RETRYABLE',
  'FAILED',
] as const;
export type PrintJobState = (typeof printJobStates)[number];

export const waybillRequestStates = [
  'PENDING_PROVIDER',
  'CONFIGURATION_REQUIRED',
  'PROVIDER_ACCEPTED',
  'SHIPMENT_RECORDED',
  'COMPLETED',
  'FAILED',
] as const;
export type WaybillRequestState = (typeof waybillRequestStates)[number];

export const fulfillmentAssets = ['USDT', 'NPL', 'BNM_POINTS'] as const;
export type FulfillmentAsset = (typeof fulfillmentAssets)[number];

export const arbitrationOutcomes = ['FULFILL', 'RESUME_FULFILLMENT'] as const;
export type ArbitrationOutcome = (typeof arbitrationOutcomes)[number];

export const settlementRails = [
  'MERCHANT_USDT',
  'REWARD_NPL',
  'PRIZE_USDT',
  'TAKEOVER_USDT',
  'OPERATIONS_REIMBURSEMENT_USDT',
] as const;
export type SettlementRail = (typeof settlementRails)[number];

export const reservationStates = ['ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED'] as const;
export type ReservationState = (typeof reservationStates)[number];

export const balanceStates = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED'] as const;
export type BalanceState = (typeof balanceStates)[number];

export const settlementIntentStates = ['ISSUED', 'CONSUMED', 'EXPIRED', 'CANCELLED'] as const;
export type SettlementIntentState = (typeof settlementIntentStates)[number];

export const settlementRequestStates = ['REQUESTED', 'BATCHED', 'SETTLED', 'RETRYABLE', 'QUARANTINED'] as const;
export type SettlementRequestState = (typeof settlementRequestStates)[number];

export const settlementBatchStates = [
  'APPROVAL_PENDING',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'MINED',
  'SETTLED',
  'FAILED',
  'REORGED',
  'RETRYABLE',
  'QUARANTINED',
] as const;
export type SettlementBatchState = (typeof settlementBatchStates)[number];

export const merchantGuaranteeDepositStates = ['SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'QUARANTINED'] as const;
export type MerchantGuaranteeDepositState = (typeof merchantGuaranteeDepositStates)[number];

export const guaranteeStatuses = ['DECISION_BLOCKED', 'BELOW_MINIMUM', 'READY', 'FROZEN'] as const;
export type GuaranteeStatus = (typeof guaranteeStatuses)[number];

export const breakerActions = ['PAUSE', 'RESUME'] as const;
export type BreakerAction = (typeof breakerActions)[number];

export const breakerCauseTypes = ['COVERAGE', 'GOVERNANCE', 'SECURITY', 'OPERATIONS'] as const;
export type BreakerCauseType = (typeof breakerCauseTypes)[number];

export const takeoverStates = [
  'OPEN',
  'FUNDED',
  'FULFILLING',
  'FULFILLMENT_PENDING',
  'CLOSED',
  'DECISION_BLOCKED',
] as const;
export type TakeoverState = (typeof takeoverStates)[number];

export const seckillStates = ['PREHEAT', 'LIVE', 'SETTLING', 'SETTLED', 'FORCE_CLOSED'] as const;
export type SeckillState = (typeof seckillStates)[number];

export const rewardSubtypes = [
  'GENESIS',
  'DIRECT_REFERRAL',
  'DISTRICT',
  'CITY',
  'PROVINCE',
  'REGION',
  'OPERATIONS',
  'ROUNDING_REMAINDER',
] as const;
export type RewardSubtype = (typeof rewardSubtypes)[number];

export const policyPublicationStates = ['DRAFT', 'DECISION_BLOCKED', 'PUBLISHED', 'SUPERSEDED'] as const;
export type PolicyPublicationState = (typeof policyPublicationStates)[number];

export const policyDraftStates = [
  'DRAFT',
  'DECISION_BLOCKED',
  'SECONDARY_SIGNED',
  'SAFE_PROPOSED',
  'FINALITY_PENDING',
  'REORGED',
  'REJECTED',
  'PUBLISHED',
] as const;
export type PolicyDraftState = (typeof policyDraftStates)[number];

export const cmsContentTypes = [
  'BANNER',
  'RECOMMENDATION',
  'SPLASH',
  'CAMPAIGN_POPUP',
  'SECKILL_RULES',
  'FAQ',
  'SERVICE_AGREEMENT',
  'PRIVACY',
  'ABOUT',
  'RELEASE_ANNOUNCEMENT',
  'UPDATE_NOTICE',
  'CONTRACT_NOTICE',
] as const;
export type CmsContentType = (typeof cmsContentTypes)[number];

export const cmsContentFormats = ['STRUCTURED_RICH_TEXT', 'STRUCTURED_CAMPAIGN'] as const;
export type CmsContentFormat = (typeof cmsContentFormats)[number];

export const cmsPublicationEventTypes = ['PUBLISHED', 'ROLLED_BACK'] as const;
export type CmsPublicationEventType = (typeof cmsPublicationEventTypes)[number];

export const notificationChannels = ['IN_APP', 'SMS', 'EMAIL', 'PUSH'] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

export const notificationProviders = ['CORE', 'ALIYUN_SMS', 'TENCENT_SMS', 'SMTP', 'FIREBASE', 'JPUSH'] as const;
export type NotificationProvider = (typeof notificationProviders)[number];

export const notificationEndpointStates = ['ACTIVE', 'PAUSED', 'REVOKED'] as const;
export type NotificationEndpointState = (typeof notificationEndpointStates)[number];

export const notificationCampaignTopics = ['ANNOUNCEMENT', 'MAINTENANCE', 'ACTIVITY'] as const;
export type NotificationCampaignTopic = (typeof notificationCampaignTopics)[number];

export const notificationCampaignStates = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export type NotificationCampaignState = (typeof notificationCampaignStates)[number];

export const notificationDeliveryStates = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'RETRY',
  'CONFIGURATION_REQUIRED',
  'DEAD_LETTER',
] as const;
export type NotificationDeliveryState = (typeof notificationDeliveryStates)[number];

export const systemConfigKeys = ['BUSINESS', 'FREIGHT', 'RPC', 'ORACLE', 'GAS', 'CHAIN', 'INTEGRATIONS'] as const;
export type SystemConfigKey = (typeof systemConfigKeys)[number];

export const auditStreamNames = ['financial', 'governance', 'authentication', 'operational', 'backup'] as const;
export type AuditStreamName = (typeof auditStreamNames)[number];

export const auditEvidenceProfiles = [
  'RBAC',
  'AUTHORIZATION',
  'SIGNED_OFFCHAIN',
  'SAFE_APPROVED',
  'CHAIN_OBSERVED',
  'CHAIN_FINAL',
  'SYSTEM',
] as const;
export type AuditEvidenceProfile = (typeof auditEvidenceProfiles)[number];

export const operationsMetricComponents = [
  'HOST',
  'REDIS',
  'MQ',
  'DATABASE',
  'HTTP',
  'PAYMENT',
  'FULFILLMENT',
  'RPC_PRIMARY',
  'RPC_FALLBACK',
  'EXPLORER',
] as const;
export type OperationsMetricComponent = (typeof operationsMetricComponents)[number];

export const operationsMetricUnits = ['PERCENT', 'BYTES', 'COUNT', 'MILLISECONDS', 'BLOCK', 'PER_SECOND'] as const;
export type OperationsMetricUnit = (typeof operationsMetricUnits)[number];

export const operationsMetricStatuses = ['HEALTHY', 'WARNING', 'CRITICAL', 'UNAVAILABLE', 'CONFIGURATION_REQUIRED'] as const;
export type OperationsMetricStatus = (typeof operationsMetricStatuses)[number];

export const operationsAlertEventTypes = ['OPENED', 'ACKNOWLEDGED', 'RECOVERED'] as const;
export type OperationsAlertEventType = (typeof operationsAlertEventTypes)[number];

export const operationsAlertSeverities = ['WARNING', 'CRITICAL'] as const;
export type OperationsAlertSeverity = (typeof operationsAlertSeverities)[number];

export const adapterProviders = [
  'AMAP',
  'KUAIDI100',
  'CAINIAO',
  'FEIE',
  'YILIANYUN',
  'BNM',
  'ALIYUN_SMS',
  'TENCENT_SMS',
  'ALIYUN_OSS',
  'SMTP',
  'FIREBASE',
  'JPUSH',
] as const;
export type AdapterProvider = (typeof adapterProviders)[number];

export const infrastructureProviders = ['RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'] as const;
export type InfrastructureProvider = (typeof infrastructureProviders)[number];

export const providerReadinessStates = ['READY', 'CONFIGURATION_REQUIRED'] as const;
export type ProviderReadinessState = (typeof providerReadinessStates)[number];

export const riskSignalTypes = ['HIGH_GAS', 'WALLET_CONTEXT', 'ORDER_CANCELLATION'] as const;
export type RiskSignalType = (typeof riskSignalTypes)[number];

export const riskSourceTypes = ['CHAIN_MONITOR', 'EDGE_AUTH', 'ORDER_SERVICE'] as const;
export type RiskSourceType = (typeof riskSourceTypes)[number];

export const riskSubjectTypes = ['WALLET', 'IP', 'DEVICE'] as const;
export type RiskSubjectType = (typeof riskSubjectTypes)[number];

export const riskRestrictionKinds = ['NEW_PAYMENT', 'BLACKLIST'] as const;
export type RiskRestrictionKind = (typeof riskRestrictionKinds)[number];

export const riskRestrictionStates = ['ACTIVE', 'EXPIRED', 'OVERRIDDEN'] as const;
export type RiskRestrictionState = (typeof riskRestrictionStates)[number];

export const riskAppealStates = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type RiskAppealState = (typeof riskAppealStates)[number];

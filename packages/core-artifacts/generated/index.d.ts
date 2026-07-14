export declare const artifactVersion: "2.0.0-settlement-admin.1";
export declare const chainIdentity: Readonly<{ chainId: 56; usdtAddress: "0x55d398326f99059ff775485246999027b3197955"; nplAddress: "0x4e8277ab31e4956b2cd48449793a57656dfc03d2" }>;
export type AtomicAmount = string;
export type Bytes32 = string;
export type Address = string;
export type OrderProjectionState = "QUOTED" | "SUBMITTED" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED" | "REORG_PENDING";
export type ContractOrderState = "NONE" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED";
export type OrderFinalityStatus = "NOT_SUBMITTED" | "PENDING" | "CONFIRMED" | "REPLACED" | "REORGED" | "FINAL";
export type TransactionFinalityState = "SUBMITTED" | "MINED" | "REPLACED" | "REORGED" | "FINAL" | "FAILED";
export type UserRole = "BUYER" | "MERCHANT" | "ADMIN" | "OPERATOR" | "ARBITRATOR" | "AUDITOR";
export type BreakerScope = "NEW_PAYMENT" | "SECKILL_PURCHASE" | "NEW_SETTLEMENT_BATCH";
export type AllowedActionName = "PAY_ORDER" | "REQUEST_EXCHANGE" | "REQUEST_DELAY" | "DECIDE_FULFILLMENT_REQUEST" | "CONFIRM_RECEIPT" | "REQUEST_FORCED_RECEIPT" | "VERIFY_PICKUP" | "OPEN_ARBITRATION" | "OPEN_TAKEOVER" | "RECORD_SHIPMENT" | "RECORD_DELIVERY" | "REGISTER_PICKUP_CREDENTIAL" | "DECIDE_ARBITRATION" | "DECIDE_FORCED_RECEIPT" | "REQUEST_MERCHANT_SETTLEMENT" | "REQUEST_REWARD_SETTLEMENT" | "REQUEST_PRIZE_SETTLEMENT" | "RECONCILE" | "RECOVER_SURPLUS";
export type AllowedActionReasonCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "MerchantFrozen" | "PickupTakeoverDecisionBlocked" | "UnknownState";
export type CoreErrorCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "EmptySessionPrizeDecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "IdempotencyConflict" | "InvalidFinality" | "InvalidRequest" | "InvalidSignature" | "InventoryUnavailable" | "NonceExpired" | "NonceReplay" | "PickupTakeoverDecisionBlocked" | "ProviderSignatureInvalid" | "QuoteExpired" | "ReorgPending" | "ReservationConflict" | "Unauthorized" | "UnknownState";
export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type FulfillmentMethod = "CUSTOMER_RECEIPT" | "PICKUP_VERIFICATION" | "FORCED_RECEIPT" | "ARBITRATION";
export type StoreStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
export type FulfillmentRequestType = "EXCHANGE" | "DELAY" | "ARBITRATION" | "FORCED_RECEIPT";
export type FulfillmentRequestState = "OPEN" | "APPROVED" | "REJECTED" | "RESOLVED";
export type LogisticsProvider = "KUAIDI100" | "CAINIAO";
export type LogisticsStatus = "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION";
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
export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' | 'SECKILL_PRIZE_LIABILITY';
export type TakeoverState = "OPEN" | "FUNDED" | "FULFILLING" | "FULFILLMENT_PENDING" | "CLOSED" | "DECISION_BLOCKED";
export type SeckillState = "SCHEDULED" | "LIVE" | "ENDED" | "SETTLED" | "NO_WINNER";
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
export declare const orderProjectionStates: readonly OrderProjectionState[];
export declare const contractOrderStates: readonly ContractOrderState[];
export declare const orderFinalityStatuses: readonly OrderFinalityStatus[];
export declare const finalityStates: readonly TransactionFinalityState[];
export declare const userRoles: readonly UserRole[];
export declare const breakerScopes: readonly BreakerScope[];
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
export declare const logisticsStatuses: readonly LogisticsStatus[];
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

export type JsonObject = Readonly<Record<string, unknown>>;

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
  state: BalanceState;
  amount: AtomicAmount;
}

export interface SettlementListProjection {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  balances: readonly SettlementBalance[];
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

export interface CatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  attributes: Readonly<Record<string, unknown>>;
  listPriceUsdt: AtomicAmount;
  stockAvailable: AtomicAmount;
}

export interface CatalogProduct {
  productId: string;
  chainProductId: Bytes32;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
  skus: readonly CatalogSku[];
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
  status: StoreStatus;
  version: number;
}

export interface CreateMerchantStoreRequest {
  idempotencyKey: string;
  name: string;
  phone: string;
  longitude: number;
  latitude: number;
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

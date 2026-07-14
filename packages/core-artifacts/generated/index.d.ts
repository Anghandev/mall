export declare const artifactVersion: "2.0.0-fulfillment.1";
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
export type SettlementRail = "MERCHANT_USDT" | "REWARD_NPL" | "PRIZE_USDT";
export type ReservationState = "ACTIVE" | "CONSUMED" | "EXPIRED" | "RELEASED";
export type BalanceState = "LOCKED" | "AVAILABLE" | "REQUESTED" | "BATCHED" | "SETTLED" | "DISPUTED";
export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' | 'SECKILL_PRIZE_LIABILITY';
export type TakeoverState = "OPEN" | "FUNDED" | "FULFILLING" | "FULFILLMENT_PENDING" | "CLOSED" | "DECISION_BLOCKED";
export type SeckillState = "SCHEDULED" | "LIVE" | "ENDED" | "SETTLED" | "NO_WINNER";
export type PolicyPublicationState = "DRAFT" | "DECISION_BLOCKED" | "PUBLISHED" | "SUPERSEDED";
export type AdapterProvider = "AMAP" | "KUAIDI100" | "CAINIAO" | "FEIE" | "YILIANYUN" | "BNM" | "ALIYUN_SMS" | "ALIYUN_OSS" | "SMTP" | "JPUSH";
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
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];

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

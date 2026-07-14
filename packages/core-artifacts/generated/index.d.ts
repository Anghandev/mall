export declare const artifactVersion: "2.0.0-payment.1";
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
export type AllowedActionName = "PAY_ORDER" | "CONFIRM_RECEIPT" | "REQUEST_FORCED_RECEIPT" | "VERIFY_PICKUP" | "OPEN_ARBITRATION" | "OPEN_TAKEOVER" | "RECORD_SHIPMENT" | "RECORD_DELIVERY" | "REQUEST_MERCHANT_SETTLEMENT" | "REQUEST_REWARD_SETTLEMENT" | "REQUEST_PRIZE_SETTLEMENT" | "RECONCILE" | "RECOVER_SURPLUS";
export type AllowedActionReasonCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "MerchantFrozen" | "PickupTakeoverDecisionBlocked" | "UnknownState";
export type CoreErrorCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "EmptySessionPrizeDecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "IdempotencyConflict" | "InvalidFinality" | "InvalidRequest" | "InvalidSignature" | "InventoryUnavailable" | "NonceExpired" | "NonceReplay" | "PickupTakeoverDecisionBlocked" | "ProviderSignatureInvalid" | "QuoteExpired" | "ReorgPending" | "ReservationConflict" | "Unauthorized" | "UnknownState";
export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type FulfillmentMethod = "CUSTOMER_RECEIPT" | "PICKUP_VERIFICATION" | "FORCED_RECEIPT" | "ARBITRATION";
export type SettlementRail = "MERCHANT_USDT" | "REWARD_NPL" | "PRIZE_USDT";
export type ReservationState = "ACTIVE" | "CONSUMED" | "EXPIRED" | "RELEASED";
export type BalanceState = "LOCKED" | "AVAILABLE" | "REQUESTED" | "BATCHED" | "SETTLED" | "DISPUTED";
export type TakeoverState = "ELIGIBILITY_PENDING" | "OPEN" | "FUNDED" | "FULFILLMENT_PENDING" | "CLOSED" | "DECISION_BLOCKED";
export type SeckillState = "SCHEDULED" | "LIVE" | "ENDED" | "SETTLED" | "NO_WINNER";
export type PolicyPublicationState = "DRAFT" | "DECISION_BLOCKED" | "PUBLISHED" | "SUPERSEDED";
export type AdapterProvider = "AMAP" | "KUAIDI100" | "FEIE" | "ALIYUN_SMS" | "ALIYUN_OSS" | "SMTP" | "JPUSH";
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
  purpose: string;
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

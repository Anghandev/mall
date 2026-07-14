export declare const artifactVersion: "2.0.0-rc.1";
export declare const chainIdentity: Readonly<{ chainId: 56; usdtAddress: "0x55d398326f99059ff775485246999027b3197955"; nplAddress: "0x4e8277ab31e4956b2cd48449793a57656dfc03d2" }>;
export type AtomicAmount = string;
export type Bytes32 = string;
export type Address = string;
export type OrderProjectionState = "QUOTED" | "SUBMITTED" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED" | "REORG_PENDING";
export type ContractOrderState = "NONE" | "PAID" | "SHIPPED" | "DELIVERED" | "ARBITRATION" | "TAKEOVER" | "FULFILLMENT_PENDING" | "FULFILLED";
export type OrderFinalityStatus = "NOT_SUBMITTED" | "PENDING" | "CONFIRMED" | "REPLACED" | "REORGED" | "FINAL";
export type TransactionFinalityState = "SUBMITTED" | "MINED" | "REPLACED" | "REORGED" | "FINAL" | "FAILED";
export type UserRole = "BUYER" | "MERCHANT" | "ADMIN" | "OPERATOR" | "ARBITRATOR" | "AUDITOR";
export type BreakerScope = "NEW_ORDERS" | "SECKILL_PURCHASE" | "SECKILL_SETTLEMENT" | "MERCHANT_CLAIM" | "REWARD_CLAIM" | "PRIZE_CLAIM";
export type AllowedActionName = "PAY_ORDER" | "CONFIRM_RECEIPT" | "REQUEST_FORCED_RECEIPT" | "VERIFY_PICKUP" | "OPEN_ARBITRATION" | "OPEN_TAKEOVER" | "RECORD_SHIPMENT" | "RECORD_DELIVERY" | "CLAIM_MERCHANT_USDT" | "CLAIM_REWARD_NPL" | "CLAIM_PRIZE_USDT" | "CLAIM_BNM" | "RECONCILE" | "RECOVER_SURPLUS";
export type AllowedActionReasonCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "MerchantFrozen" | "PickupTakeoverDecisionBlocked" | "UnknownState";
export type CoreErrorCode = "ArtifactVersionMismatch" | "BreakerActive" | "ConfigurationRequired" | "DecisionBlocked" | "EmptySessionPrizeDecisionBlocked" | "ExternalBlocked" | "FinalityPending" | "Forbidden" | "IdempotencyConflict" | "InvalidFinality" | "InvalidRequest" | "InvalidSignature" | "InventoryUnavailable" | "NonceExpired" | "NonceReplay" | "PickupTakeoverDecisionBlocked" | "ProviderSignatureInvalid" | "QuoteExpired" | "ReorgPending" | "ReservationConflict" | "Unauthorized" | "UnknownState";
export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type FulfillmentMethod = "CUSTOMER_RECEIPT" | "PICKUP_VERIFICATION" | "FORCED_RECEIPT" | "ARBITRATION";
export type ClaimRail = "MERCHANT_USDT" | "REWARD_NPL" | "PRIZE_USDT" | "BNM";
export type ReservationState = "ACTIVE" | "CONSUMED" | "EXPIRED" | "RELEASED";
export type BalanceState = "LOCKED" | "PENDING_SETTLEMENT" | "AVAILABLE" | "CLAIMED";
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
export declare const claimRails: readonly ClaimRail[];
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];

export interface ProductPolicy {
  artifactVersion: typeof artifactVersion;
  policyVersion: number;
  policyHash: Bytes32;
  oracleVersion: Bytes32;
  publicationStatus: 'PUBLISHED';
  usdtPaymentBps: number;
  nplPaymentBps: number;
  burnBps: number;
  routeBps: number;
  genesisBps: number;
  directReferralBps: number;
  districtBps: number;
  cityBps: number;
  provinceBps: number;
  regionBps: number;
  operationsBps: number;
  operationsBeneficiaries: readonly Address[];
  operationsWeights: readonly number[];
  merchantStoreBps: number;
  platformFeeBps: number;
  seckillPrizeBps: number;
  seckillMainDurationSeconds: 3600;
  relayInitialSeconds: 60;
  relayIncrementSeconds: 30;
  relayCapSeconds: 60;
  oracleMaxAgeSeconds: number;
  oracleMinimumLiquidity: AtomicAmount;
  merchantGuaranteeMinimumUsdt: AtomicAmount;
  platformRiskReserveMinimumUsdt: AtomicAmount;
  guaranteeTopupLineUsdt: AtomicAmount;
  platformTreasury: Address;
  circulationPool: Address;
  usdtRemainderAccount: Address;
  genesisCredential: Address;
  genesisTokenId: AtomicAmount;
  genesisCredentialStandard: 'NONE' | 'ERC721' | 'ERC1155';
  beneficiarySetHash: Bytes32;
  decisionEvidenceHash: Bytes32;
  rulesContentHash: Bytes32;
}

export interface AllocationSnapshot {
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  merchantUsdtAmount: AtomicAmount;
  platformUsdtAmount: AtomicAmount;
  prizeUsdtAmount: AtomicAmount;
  usdtRemainderAmount: AtomicAmount;
  burnedNplAmount: AtomicAmount;
  routedNplAmount: AtomicAmount;
  bnmAmount: AtomicAmount;
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
  merchantStore: Address;
}

export interface ContractOrderIntent {
  orderId: Bytes32;
  policyVersion: number;
  oracleVersion: Bytes32;
  buyer: Address;
  merchant: Address;
  productId: Bytes32;
  skuId: Bytes32;
  quantity: number;
  fulfillmentMode: FulfillmentMode;
  fulfillmentTargetHash: Bytes32;
  regionCodeHash: Bytes32;
  productPolicyHash: Bytes32;
  reservationId: Bytes32;
  reservationHash: Bytes32;
  reservationDeadline: number;
  nonce: string;
  deadline: number;
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  rewardBaseNpl: AtomicAmount;
  merchantUsdtAmount: AtomicAmount;
  platformUsdtAmount: AtomicAmount;
  prizeUsdtAmount: AtomicAmount;
  usdtRemainderAmount: AtomicAmount;
  bnmAmount: AtomicAmount;
  seckill: boolean;
  sessionId: Bytes32 | '';
  beneficiaries: BeneficiarySnapshot;
}

export interface SignedOrderIntent {
  artifactVersion: typeof artifactVersion;
  intent: ContractOrderIntent;
  allocation: AllocationSnapshot;
  reservation: InventoryReservation;
  quoteSignature: string;
  buyerSignature: string;
}

export interface FallbackRetailQuote extends SignedOrderIntent {
  classification: 'FALLBACK_RETAIL';
  intent: ContractOrderIntent & { seckill: false; sessionId: '' };
  reservation: InventoryReservation & { classification: 'FALLBACK_RETAIL' };
}

export interface SeckillQuote {
  artifactVersion: typeof artifactVersion;
  policyVersion: number;
  sessionId: Bytes32;
  seckillOrder: ContractOrderIntent & { seckill: true };
  fallbackOrder: ContractOrderIntent & { seckill: false; sessionId: '' };
  seckillAllocation: AllocationSnapshot;
  fallbackAllocation: AllocationSnapshot;
  seckillReservation: InventoryReservation & { classification: 'SECKILL' };
  fallbackReservation: InventoryReservation & { classification: 'FALLBACK_RETAIL' };
  deadline: number;
  quoteSignature: string;
  buyerAcknowledgementSignature: string;
  classificationAuthority: 'CHAIN_TIMESTAMP';
}

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: AllowedActionReasonCode;
  deadline?: string;
}

export interface TransactionFinality {
  artifactVersion: typeof artifactVersion;
  resourceType: string;
  resourceId: string;
  chainId: 56;
  contractAddress: Address;
  expectedEventHash: Bytes32;
  txHash: Bytes32;
  replacementForTxHash?: Bytes32;
  blockNumber?: number;
  blockHash?: Bytes32;
  confirmations: number;
  requiredConfirmations: number;
  receiptStatus?: 0 | 1;
  eventResourceId?: string;
  observedEventHash?: Bytes32;
  canonicalBlock: boolean;
  state: TransactionFinalityState;
}

export interface FulfillmentEvidence {
  orderId: Bytes32;
  method: FulfillmentMethod;
  evidenceHash: Bytes32;
  sourceChainId: 56;
  sourceContract: Address;
  sourceEventHash: Bytes32;
  sourceTxHash: Bytes32;
  blockHash: Bytes32;
  confirmations: number;
  receiptStatus: 1;
}

export interface FulfillmentFinality extends TransactionFinality {
  resourceType: 'FULFILLMENT';
  evidence: FulfillmentEvidence;
}

export interface MerchantTakeoverCase {
  caseId: string;
  orderId: Bytes32;
  policyVersion: number;
  fulfillmentMode: FulfillmentMode;
  state: TakeoverState;
  eligibleAt?: string;
  guaranteeReservedUsdt: AtomicAmount;
  merchantAvailableReservedUsdt: AtomicAmount;
  riskReserveReservedUsdt: AtomicAmount;
  actualRiskReserveDisbursedUsdt: AtomicAmount;
  merchantDebtUsdt: AtomicAmount;
  allowedActions: readonly AllowedAction[];
  blockedReason?: 'PickupTakeoverDecisionBlocked';
}

export interface ClaimProjection {
  rail: ClaimRail;
  asset: Address;
  balanceState: BalanceState;
  amount: AtomicAmount;
  allowedAction: AllowedAction;
  finality?: TransactionFinality;
}

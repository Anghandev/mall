export const CORE_ARTIFACT_VERSION = '2.0.0-fulfillment.1';
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

export const storeStatuses = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type StoreStatus = (typeof storeStatuses)[number];

export const fulfillmentRequestTypes = ['EXCHANGE', 'DELAY', 'ARBITRATION', 'FORCED_RECEIPT'] as const;
export type FulfillmentRequestType = (typeof fulfillmentRequestTypes)[number];

export const fulfillmentRequestStates = ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED'] as const;
export type FulfillmentRequestState = (typeof fulfillmentRequestStates)[number];

export const logisticsProviders = ['KUAIDI100', 'CAINIAO'] as const;
export type LogisticsProvider = (typeof logisticsProviders)[number];

export const logisticsStatuses = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] as const;
export type LogisticsStatus = (typeof logisticsStatuses)[number];

export const fulfillmentAssets = ['USDT', 'NPL', 'BNM_POINTS'] as const;
export type FulfillmentAsset = (typeof fulfillmentAssets)[number];

export const arbitrationOutcomes = ['FULFILL', 'RESUME_FULFILLMENT'] as const;
export type ArbitrationOutcome = (typeof arbitrationOutcomes)[number];

export const settlementRails = ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT'] as const;
export type SettlementRail = (typeof settlementRails)[number];

export const reservationStates = ['ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED'] as const;
export type ReservationState = (typeof reservationStates)[number];

export const balanceStates = ['LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED'] as const;
export type BalanceState = (typeof balanceStates)[number];

export const takeoverStates = [
  'OPEN',
  'FUNDED',
  'FULFILLING',
  'FULFILLMENT_PENDING',
  'CLOSED',
  'DECISION_BLOCKED',
] as const;
export type TakeoverState = (typeof takeoverStates)[number];

export const seckillStates = ['SCHEDULED', 'LIVE', 'ENDED', 'SETTLED', 'NO_WINNER'] as const;
export type SeckillState = (typeof seckillStates)[number];

export const policyPublicationStates = ['DRAFT', 'DECISION_BLOCKED', 'PUBLISHED', 'SUPERSEDED'] as const;
export type PolicyPublicationState = (typeof policyPublicationStates)[number];

export const adapterProviders = [
  'AMAP',
  'KUAIDI100',
  'CAINIAO',
  'FEIE',
  'YILIANYUN',
  'BNM',
  'ALIYUN_SMS',
  'ALIYUN_OSS',
  'SMTP',
  'JPUSH',
] as const;
export type AdapterProvider = (typeof adapterProviders)[number];

export const infrastructureProviders = ['RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'] as const;
export type InfrastructureProvider = (typeof infrastructureProviders)[number];

export const providerReadinessStates = ['READY', 'CONFIGURATION_REQUIRED'] as const;
export type ProviderReadinessState = (typeof providerReadinessStates)[number];

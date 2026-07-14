export const CORE_ARTIFACT_VERSION = '2.0.0-rc.1';
export const BSC_CHAIN_ID = 56;
export const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
export const NPL_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

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
  'NEW_ORDERS',
  'SECKILL_PURCHASE',
  'SECKILL_SETTLEMENT',
  'MERCHANT_CLAIM',
  'REWARD_CLAIM',
  'PRIZE_CLAIM',
] as const;
export type BreakerScope = (typeof breakerScopes)[number];

export const allowedActionNames = [
  'PAY_ORDER',
  'CONFIRM_RECEIPT',
  'REQUEST_FORCED_RECEIPT',
  'VERIFY_PICKUP',
  'OPEN_ARBITRATION',
  'OPEN_TAKEOVER',
  'RECORD_SHIPMENT',
  'RECORD_DELIVERY',
  'CLAIM_MERCHANT_USDT',
  'CLAIM_REWARD_NPL',
  'CLAIM_PRIZE_USDT',
  'CLAIM_BNM',
  'RECONCILE',
  'RECOVER_SURPLUS',
] as const;
export type AllowedActionName = (typeof allowedActionNames)[number];

export const executableOrderActionNames = [] as const satisfies readonly AllowedActionName[];

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

export const claimRails = ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT', 'BNM'] as const;
export type ClaimRail = (typeof claimRails)[number];

export const reservationStates = ['ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED'] as const;
export type ReservationState = (typeof reservationStates)[number];

export const balanceStates = ['LOCKED', 'PENDING_SETTLEMENT', 'AVAILABLE', 'CLAIMED'] as const;
export type BalanceState = (typeof balanceStates)[number];

export const takeoverStates = [
  'ELIGIBILITY_PENDING',
  'OPEN',
  'FUNDED',
  'FULFILLMENT_PENDING',
  'CLOSED',
  'DECISION_BLOCKED',
] as const;
export type TakeoverState = (typeof takeoverStates)[number];

export const seckillStates = ['SCHEDULED', 'LIVE', 'ENDED', 'SETTLED', 'NO_WINNER'] as const;
export type SeckillState = (typeof seckillStates)[number];

export const policyPublicationStates = ['DRAFT', 'DECISION_BLOCKED', 'PUBLISHED', 'SUPERSEDED'] as const;
export type PolicyPublicationState = (typeof policyPublicationStates)[number];

export const adapterProviders = ['AMAP', 'KUAIDI100', 'FEIE', 'ALIYUN_SMS', 'ALIYUN_OSS', 'SMTP', 'JPUSH'] as const;
export type AdapterProvider = (typeof adapterProviders)[number];

export const infrastructureProviders = ['RPC_PRIMARY', 'RPC_FALLBACK', 'EXPLORER'] as const;
export type InfrastructureProvider = (typeof infrastructureProviders)[number];

export const providerReadinessStates = ['READY', 'CONFIGURATION_REQUIRED'] as const;
export type ProviderReadinessState = (typeof providerReadinessStates)[number];

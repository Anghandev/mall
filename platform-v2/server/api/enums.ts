export const CORE_ARTIFACT_VERSION = '2.0.0-rc.1';
export const BSC_CHAIN_ID = 56;
export const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
export const NPL_ADDRESS = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

export const orderStates = [
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
export type OrderState = (typeof orderStates)[number];

export const finalityStates = ['SUBMITTED', 'MINED', 'REPLACED', 'REORGED', 'FINAL', 'FAILED'] as const;
export type FinalityState = (typeof finalityStates)[number];

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

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: string;
  deadline?: string;
}

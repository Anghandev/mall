import {
  artifactVersion,
  executableOrderActionNames,
  type AllowedActionName,
} from '@abu24k/core-artifacts';

const executableOrderActionSet = new Set<AllowedActionName>(executableOrderActionNames);

export const coreBoundary = Object.freeze({
  artifactVersion,
  artifactsAvailable: true,
  executableOrderActionNames,
  reason: '支付批次已发布；履约、商家订单投影和结算批次尚未发布',
} as const);

export function canExecuteOrderAction(action: AllowedActionName) {
  return executableOrderActionSet.has(action);
}

export const unavailableValue = '不可用';

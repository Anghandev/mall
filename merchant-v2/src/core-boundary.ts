import {
  artifactVersion,
  executableOrderActionNames,
  type AllowedAction,
  type AllowedActionName,
} from '@abu24k/core-artifacts';

const executableOrderActionSet = new Set<AllowedActionName>(executableOrderActionNames);

export const coreBoundary = Object.freeze({
  artifactVersion,
  artifactsAvailable: true,
  executableOrderActionNames,
  reason: '支付、履约、结算、商品管理、媒体与经营聚合批次已发布',
} as const);

export function canExecuteOrderAction(action: AllowedActionName, allowedActions?: readonly AllowedAction[]) {
  return executableOrderActionSet.has(action)
    && allowedActions?.some((item) => item.action === action && item.enabled) === true;
}

export const unavailableValue = '不可用';

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
  reason: '商品、门店、履约、结算和资料功能已接入；没有权限的操作会自动拦住',
  auditReason: '支付、履约、替代商家接管、结算、商品、媒体、商家资料、审计与订单导出能力已发布；平台全局运营与清算读取保持 Admin-only',
} as const);

export function canExecuteOrderAction(action: AllowedActionName, allowedActions?: readonly AllowedAction[]) {
  return executableOrderActionSet.has(action)
    && allowedActions?.some((item) => item.action === action && item.enabled) === true;
}

export const unavailableValue = '暂无数据';

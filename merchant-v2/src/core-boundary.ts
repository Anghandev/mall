import {
  artifactVersion,
  executableOrderActionNames,
  type AllowedActionName,
} from '@abu24k/core-artifacts';

const executableOrderActionSet = new Set<AllowedActionName>(executableOrderActionNames);

export const coreBoundary = Object.freeze({
  artifactVersion,
  artifactsAvailable: true,
  runtimeAvailable: false,
  executableOrderActionNames,
  reason: 'Core 协调版 artifacts 已发布；商家认证和执行接口尚未接入',
} as const);

export function canExecuteOrderAction(action: AllowedActionName) {
  return coreBoundary.runtimeAvailable && executableOrderActionSet.has(action);
}

export const unavailableValue = '不可用';

import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Notification campaigns`,
  reason: '共享 Core 已发布通知活动列表、投递计数与动作目录；Admin 仅消费同版本 allowedActions，不伪造供应商成功。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWriteWithoutRuntimeAuthorization: productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization,
} as const);

export type CoreState = typeof coreState;

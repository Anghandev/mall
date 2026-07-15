import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Logistics checkpoint`,
  reason: '共享 Core 已更新到物流版；新增的运单、打印机绑定与打印作业只属于 Merchant。Admin 未发布的物流配置和打印操作继续 fail-closed。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWriteWithoutRuntimeAuthorization: productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization,
} as const);

export type CoreState = typeof coreState;

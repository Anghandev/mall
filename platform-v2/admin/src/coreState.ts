import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Logistics admin`,
  reason: '共享 Core 已发布 Admin 承运商、Provider 密钥引用、加密仓库、跨商家面单与打印作业接口。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWriteWithoutRuntimeAuthorization: productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization,
} as const);

export type CoreState = typeof coreState;

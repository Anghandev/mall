import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Settlement/Admin checkpoint`,
  reason: '结算与后台 Core 资源已同版本发布；页面继续按运行时 SIWE/RBAC、readiness、allowedActions 和外部配置 fail-closed。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWriteWithoutRuntimeAuthorization: productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization,
} as const);

export type CoreState = typeof coreState;

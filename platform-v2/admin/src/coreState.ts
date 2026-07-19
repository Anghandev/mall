import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Merchant governance`,
  reason: '共享 Core 已发布商家履约指标与永久不可变更的结算钱包绑定；Admin 不推断比率、资金或最终状态。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWriteWithoutRuntimeAuthorization: productBaseline.adminCapabilities.writesWithoutRuntimeAuthorization,
} as const);

export type CoreState = typeof coreState;

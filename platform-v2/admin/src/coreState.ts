import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Admin API 未发布`,
  reason: '协调 Core artifacts 已发布；Admin 投影、监控、政策与写入契约尚未发布。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWrite:
    productBaseline.adminCapabilities.writes
    && productBaseline.publicCatalogs.executableOrderActionNames.length > 0,
} as const);

export type CoreState = typeof coreState;

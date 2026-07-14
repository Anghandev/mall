import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: productBaseline.artifactVersion,
  connectionLabel: `Core ${productBaseline.artifactVersion} · Payment checkpoint`,
  reason: '支付 readiness、公开目录和钱包绑定支付投影已发布；Admin 全局投影、监控、政策与写入契约尚未发布。',
  executableOrderActionNames: productBaseline.publicCatalogs.executableOrderActionNames,
  canRead: productBaseline.adminCapabilities.projections,
  canWrite:
    productBaseline.adminCapabilities.writes
    && productBaseline.publicCatalogs.executableOrderActionNames.length > 0,
} as const);

export type CoreState = typeof coreState;

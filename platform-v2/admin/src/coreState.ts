import { productBaseline } from './bootstrap';

export const coreState = Object.freeze({
  artifactStatus: productBaseline.coreArtifacts,
  artifactVersion: null,
  connectionLabel: 'Core artifacts 未发布',
  reason: '等待同版本 OpenAPI、generated types、ABI、manifest、enums 与 consumer tests。',
  canRead: false,
  canWrite: false,
} as const);

export type CoreState = typeof coreState;

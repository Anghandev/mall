import { CORE_ARTIFACT_VERSION } from './api/enums.ts';

export const coreBaseline = Object.freeze({
  artifactVersion: CORE_ARTIFACT_VERSION,
  status: 'core-api-draft',
} as const);

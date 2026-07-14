import { artifactVersion } from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: artifactVersion,
  surface: 'merchant',
} as const);

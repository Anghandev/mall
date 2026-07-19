import { artifactVersion } from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: artifactVersion,
  surface: 'merchant',
} as const);

export const merchantDeployment = Object.freeze({
  publicBasePath: '/merchant/',
  routerBasename: '/merchant',
  coreApiBaseUrl: '/core',
} as const);

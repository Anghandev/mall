import {
  artifactVersion,
  breakerScopes,
  executableOrderActionNames,
  policyPublicationStates,
  userRoles,
} from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: 'coordinated-rc',
  artifactVersion,
  publicCatalogs: Object.freeze({
    breakerScopes,
    executableOrderActionNames,
    policyPublicationStates,
    userRoles,
  }),
  adminCapabilities: Object.freeze({
    projections: false,
    monitoring: false,
    policyPublication: false,
    writes: false,
  }),
  surface: 'platform-admin',
} as const);

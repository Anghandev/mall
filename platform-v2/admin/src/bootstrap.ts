import {
  artifactVersion,
  breakerScopes,
  executableOrderActionNames,
  policyPublicationStates,
  userRoles,
} from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: 'coordinated-payment-checkpoint',
  artifactVersion,
  publicCatalogs: Object.freeze({
    breakerScopes,
    executableOrderActionNames,
    policyPublicationStates,
    userRoles,
  }),
  adminCapabilities: Object.freeze({
    bootstrapReadiness: true,
    catalogRead: true,
    paymentProjection: 'BUYER_WALLET_SCOPED',
    projections: true,
    monitoring: false,
    policyPublication: false,
    writes: false,
  }),
  surface: 'platform-admin',
} as const);

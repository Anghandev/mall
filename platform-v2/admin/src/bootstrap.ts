import {
  artifactVersion,
  breakerScopes,
  executableOrderActionNames,
  policyPublicationStates,
  userRoles,
} from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: 'coordinated-fulfillment-checkpoint',
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
    fulfillmentOrderProjection: 'ADMIN_RBAC_SCOPED',
    orderAllowedActions: true,
    takeoverCommand: true,
    projections: true,
    monitoring: false,
    policyPublication: false,
    writesWithoutRuntimeAuthorization: false,
  }),
  surface: 'platform-admin',
} as const);

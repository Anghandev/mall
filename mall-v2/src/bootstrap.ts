import {
  allowedActionNames,
  artifactVersion,
  chainIdentity,
  executableOrderActionNames,
  type AllowedActionName,
} from '@abu24k/core-artifacts';
import coordinatedManifest from '@abu24k/core-artifacts/manifest' with { type: 'json' };
import contractManifest from '@abu24k/core-artifacts/contracts/manifest' with { type: 'json' };

const paymentRouterDeployment = (contractManifest.contracts as readonly Readonly<{
  name: string;
  address: string | null;
}>[]).find((contract) => contract.name === 'PaymentRouterV2');

export const productBaseline = Object.freeze({
  coreArtifacts: artifactVersion,
  surface: 'mall',
  chainId: chainIdentity.chainId,
  knownOrderActions: allowedActionNames,
  executableOrderActions: executableOrderActionNames,
  deploymentAuthorized:
    coordinatedManifest.deploymentAuthorized === true && contractManifest.deploymentAuthorized === true,
  paymentRouterAddress: paymentRouterDeployment?.address ?? null,
  paymentCapabilities: Object.freeze({
    catalog: coordinatedManifest.capabilityStatus.catalogHttp === 'AVAILABLE',
    ordinaryQuote: coordinatedManifest.capabilityStatus.paymentQuoteHttp === 'AVAILABLE',
    seckillQuote: coordinatedManifest.capabilityStatus.seckillQuoteHttp === 'AVAILABLE',
    submission: coordinatedManifest.capabilityStatus.paymentSubmissionHttp === 'AVAILABLE',
    projection: coordinatedManifest.capabilityStatus.paymentProjectionHttp === 'AVAILABLE',
  }),
  settlementAdminCapabilities: Object.freeze({
    settlements: coordinatedManifest.capabilityStatus.settlementHttp === 'AVAILABLE',
    cms: coordinatedManifest.capabilityStatus.cmsHttp === 'AVAILABLE',
    notifications: coordinatedManifest.capabilityStatus.notificationHttp === 'AVAILABLE',
    seckillSessions: coordinatedManifest.capabilityStatus.seckillSessionHttp === 'AVAILABLE',
    websocket: coordinatedManifest.capabilityStatus.websocket === 'AVAILABLE',
  }),
  payOrderExecutable: executableOrderActionNames.includes('PAY_ORDER'),
} as const);

export function isCoreOrderActionExecutable(action: AllowedActionName) {
  return executableOrderActionNames.includes(action);
}

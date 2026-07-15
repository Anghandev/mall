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

const manifestsAligned = String(coordinatedManifest.artifactVersion) === artifactVersion
  && String(contractManifest.artifactVersion) === artifactVersion;

export const productBaseline = Object.freeze({
  coreArtifacts: artifactVersion,
  manifestsAligned,
  surface: 'mall',
  chainId: chainIdentity.chainId,
  knownOrderActions: allowedActionNames,
  executableOrderActions: executableOrderActionNames,
  deploymentAuthorized: manifestsAligned
    && coordinatedManifest.deploymentAuthorized === true
    && contractManifest.deploymentAuthorized === true,
  paymentRouterAddress: manifestsAligned ? paymentRouterDeployment?.address ?? null : null,
  paymentCapabilities: Object.freeze({
    catalog: manifestsAligned && coordinatedManifest.capabilityStatus.catalogHttp === 'AVAILABLE',
    ordinaryQuote: manifestsAligned && coordinatedManifest.capabilityStatus.paymentQuoteHttp === 'AVAILABLE',
    seckillQuote: manifestsAligned && coordinatedManifest.capabilityStatus.seckillQuoteHttp === 'AVAILABLE',
    submission: manifestsAligned && coordinatedManifest.capabilityStatus.paymentSubmissionHttp === 'AVAILABLE',
    projection: manifestsAligned && coordinatedManifest.capabilityStatus.paymentProjectionHttp === 'AVAILABLE',
  }),
  settlementAdminCapabilities: Object.freeze({
    settlements: manifestsAligned && coordinatedManifest.capabilityStatus.settlementHttp === 'AVAILABLE',
    cms: manifestsAligned && coordinatedManifest.capabilityStatus.cmsHttp === 'AVAILABLE',
    notifications: manifestsAligned && coordinatedManifest.capabilityStatus.notificationHttp === 'AVAILABLE',
    seckillSessions: manifestsAligned && coordinatedManifest.capabilityStatus.seckillSessionHttp === 'AVAILABLE',
    websocket: manifestsAligned && coordinatedManifest.capabilityStatus.websocket === 'AVAILABLE',
  }),
  payOrderExecutable: executableOrderActionNames.includes('PAY_ORDER'),
} as const);

export function isCoreOrderActionExecutable(action: AllowedActionName) {
  return executableOrderActionNames.includes(action);
}

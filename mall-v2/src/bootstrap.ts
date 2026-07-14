import {
  allowedActionNames,
  artifactVersion,
  chainIdentity,
  executableOrderActionNames,
  type AllowedActionName,
} from '@abu24k/core-artifacts';

export const productBaseline = Object.freeze({
  coreArtifacts: artifactVersion,
  surface: 'mall',
  chainId: chainIdentity.chainId,
  knownOrderActions: allowedActionNames,
  executableOrderActions: executableOrderActionNames,
} as const);

export function isCoreOrderActionExecutable(action: AllowedActionName) {
  return executableOrderActionNames.includes(action);
}

import { keccak256, toUtf8Bytes } from 'ethers';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function routerCutoverEvidenceHash(value) {
  const normalized = normalizedCutover(value);
  return keccak256(toUtf8Bytes(JSON.stringify([
    normalized.status,
    normalized.priorRouter,
    normalized.activeRouter,
    normalized.platformServiceFeeWallet,
    normalized.deploymentTxHash,
    normalized.deploymentBlock,
    normalized.deployedCodeHash,
  ]))).toLowerCase();
}

export function validateRouterCutover(value, expected) {
  const normalized = normalizedCutover(value);
  if (
    normalized.status !== 'PRE_LAUNCH_DIRECT_REPLACEMENT'
    || normalized.priorRouter === normalized.activeRouter
    || normalized.activeRouter !== normalizedAddress(expected.activeRouter, 'expected active Router')
    || normalized.platformServiceFeeWallet !== normalizedAddress(
      expected.platformServiceFeeWallet,
      'expected service-fee wallet',
    )
    || normalized.deploymentBlock !== expected.deploymentBlock
    || normalized.deployedCodeHash !== normalizedHash(expected.deployedCodeHash, 'expected deployed code hash')
    || normalized.evidenceHash !== routerCutoverEvidenceHash(normalized)
  ) throw new Error('Router pre-launch cutover evidence is inconsistent');
  return normalized;
}

function normalizedCutover(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Router pre-launch cutover evidence is invalid');
  }
  if (!Number.isSafeInteger(value.deploymentBlock) || value.deploymentBlock <= 0) {
    throw new Error('Router pre-launch deployment block is invalid');
  }
  return {
    status: value.status,
    priorRouter: normalizedAddress(value.priorRouter, 'prior Router'),
    activeRouter: normalizedAddress(value.activeRouter, 'active Router'),
    platformServiceFeeWallet: normalizedAddress(value.platformServiceFeeWallet, 'service-fee wallet'),
    deploymentTxHash: normalizedHash(value.deploymentTxHash, 'deployment transaction hash'),
    deploymentBlock: value.deploymentBlock,
    deployedCodeHash: normalizedHash(value.deployedCodeHash, 'deployed code hash'),
    evidenceHash: normalizedHash(value.evidenceHash, 'cutover evidence hash'),
  };
}

function normalizedAddress(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}

function normalizedHash(value, name) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`Invalid ${name}`);
  return value.toLowerCase();
}

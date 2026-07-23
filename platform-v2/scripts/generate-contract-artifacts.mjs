#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ARTIFACT_VERSION } from '../server/api/enums.ts';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(coreRoot, '..');
const outputRoot = join(repoRoot, 'packages/core-artifacts/contracts');
const checkOnly = process.argv.includes('--check');
const artifactVersion = CORE_ARTIFACT_VERSION;
const contracts = [
  'PolicyRegistryV2',
  'BeneficiaryRegistryV2',
  'PaymentRouterV2',
];
const deploymentEvidencePath = join(coreRoot, 'deployments', 'bsc-payment-v2.json');
const releaseAuthorizationPath = join(coreRoot, 'deployments', 'bsc-fulfillment-launch-authorization.json');
const verifiedDeploymentArtifactVersions = new Map([
  ['2.0.0-fulfillment-launch.29', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.28', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.27', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.26', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.25', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.24', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.23', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.22', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.20', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.19', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-fulfillment-launch.18', new Set([
    '2.0.0-settlement-admin.17',
    '2.0.0-settlement-admin.16',
  ])],
  ['2.0.0-settlement-admin.17', new Set(['2.0.0-settlement-admin.16'])],
]);
const deploymentEvidence = existsSync(deploymentEvidencePath)
  ? validateDeploymentEvidence(JSON.parse(readFileSync(deploymentEvidencePath, 'utf8')))
  : undefined;
const releaseAuthorization = existsSync(releaseAuthorizationPath)
  ? validateReleaseAuthorization(
    JSON.parse(readFileSync(releaseAuthorizationPath, 'utf8')),
    deploymentEvidence,
  )
  : undefined;

const roleGrants = [];

const sourceFiles = contracts.map((name) => join(coreRoot, 'contracts', `${name}.sol`)).concat([
  join(coreRoot, 'contracts/interfaces/IV2Core.sol'),
  join(coreRoot, 'contracts/types/V2Types.sol'),
]);

const bundle = {};
const contractEntries = [];
const events = [];
const roles = [];

for (const name of contracts) {
  const artifactPath = join(coreRoot, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing Foundry artifact ${relative(repoRoot, artifactPath)}. Run forge build first.`);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const abi = [...artifact.abi].sort(compareAbi);
  const forbidden = abi.filter((item) => item.type === 'function' && /refund/i.test(item.name ?? ''));
  if (forbidden.length > 0) throw new Error(`${name}: business refund function is forbidden`);

  bundle[name] = abi;
  const constructor = abi.find((item) => item.type === 'constructor') ?? { inputs: [] };
  const bytecode = artifact.bytecode?.object ?? '';
  const deployedBytecode = artifact.deployedBytecode?.object ?? '';
  const deployment = deploymentEvidence?.contracts[name];
  contractEntries.push({
    name,
    source: `platform-v2/contracts/${name}.sol`,
    address: deployment?.address ?? null,
    deploymentBlock: deployment?.deploymentBlock ?? null,
    status: deployment ? 'DEPLOYED' : 'PENDING',
    constructorInputs: constructor.inputs,
    bytecodeSha256: sha256(bytecode),
    deployedBytecodeSha256: sha256(deployedBytecode),
    deployedCodeHash: deployment?.deployedCodeHash ?? null,
  });
  for (const item of abi) {
    if (item.type === 'event') {
      events.push({
        contract: name,
        name: item.name,
        signature: `${item.name}(${item.inputs.map((input) => canonicalType(input)).join(',')})`,
        inputs: item.inputs,
      });
    }
    if (item.type === 'function' && /_ROLE$/.test(item.name ?? '') && item.inputs.length === 0) {
      roles.push({ contract: name, role: item.name, authority: roleAuthority(name, item.name) });
    }
  }
}

events.sort((left, right) => `${left.contract}.${left.signature}`.localeCompare(`${right.contract}.${right.signature}`));
roles.sort((left, right) => `${left.contract}.${left.role}`.localeCompare(`${right.contract}.${right.role}`));

const sourceDigest = sha256(sourceFiles.map((path) => `${relative(repoRoot, path)}\0${readFileSync(path)}`).join('\0'));
const manifest = {
  artifactVersion,
  publicationStatus: 'coordinated-settlement-admin-checkpoint',
  chain: {
    name: 'BSC Mainnet',
    chainId: 56,
    explorer: 'https://bscscan.com',
  },
  fixedTokens: {
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    NPL: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    NPL_BURN_ADDRESS: '0x000000000000000000000000000000000000dEaD',
  },
  compiler: {
    version: '0.8.26',
    optimizer: true,
    optimizerRuns: 1,
    viaIR: true,
    evmVersion: 'cancun',
    bytecodeHash: 'none',
    cborMetadata: false,
  },
  sourceDigestSha256: sourceDigest,
  deploymentStatus: deploymentEvidence?.deploymentStatus ?? 'PENDING',
  deploymentArtifactVersion: deploymentEvidence?.artifactVersion ?? null,
  deploymentAuthorized: releaseAuthorization?.releaseGateStatus === 'GO',
  deploymentAuthorizationEvidenceHash: releaseAuthorization?.authorizationEvidenceHash ?? null,
  releaseGateStatus: releaseAuthorization?.releaseGateStatus ?? 'NO_GO_REPAIR_BASELINE',
  historicalDeploymentLineage: deploymentEvidence
    ? {
      artifactVersion: deploymentEvidence.artifactVersion ?? null,
      deploymentAuthorized: deploymentEvidence.deploymentAuthorized === true,
      deploymentAuthorizationEvidenceHash: deploymentEvidence.authorizationEvidenceHash ?? null,
    }
    : null,
  externalBlocked: deploymentEvidence?.deploymentStatus === 'DEPLOYED'
    ? []
    : ['EOA_CONTRACT_REDEPLOYMENT_REQUIRED'],
  decisionBlocked: [],
  deploymentOrder: contracts,
  contracts: contractEntries,
  postDeploymentRoleGrants: roleGrants.map(([contract, role, grantee]) => ({ contract, role, grantee })),
  coordinatedPublication: 'packages/core-artifacts/coordinated-manifest.json',
};

const files = new Map();
for (const name of contracts) files.set(`abi/${name}.json`, json(bundle[name]));
files.set('abi-bundle.json', json({ artifactVersion, contracts: bundle }));
files.set('contract-manifest.json', json(manifest));
files.set('event-catalog.json', json({ artifactVersion, events }));
files.set('role-catalog.json', json({ artifactVersion, roles, requiredGrants: manifest.postDeploymentRoleGrants }));

const checksums = [...files.entries()]
  .map(([path, content]) => `${sha256(content)}  ${path}`)
  .sort()
  .join('\n') + '\n';
files.set('SHA256SUMS', checksums);

if (checkOnly) {
  const mismatches = [];
  for (const [path, expected] of files) {
    const absolute = join(outputRoot, path);
    if (!existsSync(absolute) || readFileSync(absolute, 'utf8') !== expected) mismatches.push(path);
  }
  if (mismatches.length > 0) throw new Error(`Stale or missing contract artifacts: ${mismatches.join(', ')}`);
  console.log(`OK contract artifacts ${artifactVersion}: ${contracts.length} ABIs, ${events.length} events, ${roles.length} roles`);
  process.exit(0);
}

rmSync(outputRoot, { recursive: true, force: true });
for (const [path, content] of files) {
  const absolute = join(outputRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
console.log(`wrote contract artifacts ${artifactVersion}: ${contracts.length} ABIs, ${events.length} events, ${roles.length} roles`);

function canonicalType(input) {
  if (!input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  return `(${input.components.map((component) => canonicalType(component)).join(',')})${suffix}`;
}

function compareAbi(left, right) {
  const leftKey = `${left.type}:${left.name ?? ''}:${(left.inputs ?? []).map((input) => canonicalType(input)).join(',')}`;
  const rightKey = `${right.type}:${right.name ?? ''}:${(right.inputs ?? []).map((input) => canonicalType(input)).join(',')}`;
  return leftKey.localeCompare(rightKey);
}

function roleAuthority(contract, role) {
  if (role === 'DEFAULT_ADMIN_ROLE') return 'Platform Governance EOA';
  if (
    contract === 'PolicyRegistryV2' && role === 'POLICY_PUBLISHER_ROLE'
  ) {
    return 'Platform Governance EOA plus bound EIP-712 signature';
  }
  if (role === 'PAUSER_ROLE' || role === 'SESSION_ADMIN_ROLE' || role === 'REGISTRY_EDITOR_ROLE') {
    return 'Platform Governance EOA';
  }
  return 'Governance-granted Core contract or bounded EOA executor';
}

function validateDeploymentEvidence(value) {
  if (
    value?.artifactVersion === artifactVersion && value.chainId === 56
      && value.architecture === 'FIVE_ROLE_EOA_V2' && value.deploymentStatus === 'PENDING'
      && value.deploymentAuthorized === false && value.authorizationEvidenceHash === null
      && value.contracts && Object.keys(value.contracts).length === 0
  ) {
    return { deploymentStatus: 'PENDING', deploymentAuthorized: false, contracts: {} };
  }
  if (
    !value || !compatibleDeploymentArtifactVersion(value.artifactVersion) || value.chainId !== 56
      || value.architecture !== 'FIVE_ROLE_EOA_V2' || value.deploymentStatus !== 'DEPLOYED'
      || value.deploymentAuthorized !== true
      || !/^0x[0-9a-fA-F]{64}$/.test(value.authorizationEvidenceHash ?? '')
      || !value.contracts || typeof value.contracts !== 'object' || Array.isArray(value.contracts)
  ) throw new Error('Invalid BSC payment deployment evidence header');
  const names = Object.keys(value.contracts).sort();
  if (JSON.stringify(names) !== JSON.stringify([...contracts].sort())) {
    throw new Error('Deployment evidence must contain exactly the coordinated payment contracts');
  }
  const addresses = new Set();
  const deployments = {};
  for (const name of contracts) {
    const entry = value.contracts[name];
    if (
      !entry || !/^0x[0-9a-fA-F]{40}$/.test(entry.address ?? '')
        || !Number.isSafeInteger(entry.deploymentBlock) || entry.deploymentBlock < 0
        || !/^0x[0-9a-fA-F]{64}$/.test(entry.deployedCodeHash ?? '')
    ) throw new Error(`Invalid deployment evidence for ${name}`);
    const address = entry.address.toLowerCase();
    if (addresses.has(address)) throw new Error('Deployment evidence contains duplicate contract addresses');
    addresses.add(address);
    deployments[name] = {
      address,
      deploymentBlock: entry.deploymentBlock,
      deployedCodeHash: entry.deployedCodeHash.toLowerCase(),
    };
  }
  return {
    artifactVersion: value.artifactVersion,
    deploymentStatus: 'DEPLOYED',
    deploymentAuthorized: true,
    authorizationEvidenceHash: value.authorizationEvidenceHash.toLowerCase(),
    contracts: deployments,
  };
}

function compatibleDeploymentArtifactVersion(value) {
  return typeof value === 'string'
    && (value === artifactVersion || verifiedDeploymentArtifactVersions.get(artifactVersion)?.has(value) === true);
}

function validateReleaseAuthorization(value, deploymentEvidence) {
  if (!deploymentEvidence || deploymentEvidence.deploymentStatus !== 'DEPLOYED' || deploymentEvidence.deploymentAuthorized !== true) {
    throw new Error('Release authorization requires deployed payment evidence');
  }
  if (
    !value || value.artifactVersion !== artifactVersion || value.chainId !== 56
      || value.architecture !== 'FIVE_ROLE_EOA_V2' || value.releaseGateStatus !== 'GO'
      || !/^0x[0-9a-fA-F]{64}$/.test(value.authorizationEvidenceHash ?? '')
      || value.deploymentEvidence?.artifactVersion !== deploymentEvidence.artifactVersion
      || value.deploymentEvidence?.authorizationEvidenceHash?.toLowerCase() !== deploymentEvidence.authorizationEvidenceHash
  ) throw new Error('Invalid fulfillment launch release authorization');
  validateNonZeroPrizeAuthorizationEvidence(value.mainnetMicrotestEvidence);
  const payload = { ...value };
  delete payload.authorizationEvidenceHash;
  const expected = `0x${sha256(stableJson(payload))}`;
  if (value.authorizationEvidenceHash.toLowerCase() !== expected) {
    throw new Error('Release authorization evidence hash mismatch');
  }
  return {
    releaseGateStatus: 'GO',
    authorizationEvidenceHash: value.authorizationEvidenceHash.toLowerCase(),
  };
}


function validateNonZeroPrizeAuthorizationEvidence(evidence) {
  const prize = evidence?.seckillPrize;
  if (
    !evidence || evidence.artifactVersionTested !== artifactVersion
      || !Number.isSafeInteger(evidence.payments?.requiredConfirmations)
      || evidence.payments.requiredConfirmations < 15
      || !prize
      || !Number.isSafeInteger(prize.merchantConcessionBps)
      || prize.merchantConcessionBps <= 0
      || positiveAtomicString(prize.prizePoolUsdtAtomic) !== true
      || prize.expectedPrizePoolUsdtAtomic !== prize.prizePoolUsdtAtomic
      || prize.winnerFrozen !== true
      || !/^0x[0-9a-fA-F]{40}$/.test(prize.winnerWallet ?? '')
      || !/^0x[0-9a-fA-F]{64}$/.test(prize.winnerPayoutTxHash ?? '')
      || !Number.isSafeInteger(prize.winnerPayoutConfirmations)
      || prize.winnerPayoutConfirmations < evidence.payments.requiredConfirmations
      || prize.operationsPrizeInjectionUsed !== false
  ) {
    throw new Error('Release authorization requires non-zero seckill prize and confirmed winner USDT payout evidence');
  }
}

function positiveAtomicString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

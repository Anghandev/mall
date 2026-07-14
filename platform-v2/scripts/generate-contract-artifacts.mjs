#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(coreRoot, '..');
const outputRoot = join(repoRoot, 'packages/core-artifacts/contracts');
const checkOnly = process.argv.includes('--check');
const artifactVersion = '2.0.0-contracts.1';
const contracts = [
  'PolicyRegistryV2',
  'BeneficiaryRegistryV2',
  'TwapOracleAdapterV2',
  'BNMTokenV2',
  'ClaimVaultV2',
  'RewardLedgerV2',
  'MerchantGuaranteeVaultV2',
  'PaymentEscrowV2',
  'SeckillV2',
];

const roleGrants = [
  ['BNMTokenV2', 'MINTER_ROLE', 'ClaimVaultV2'],
  ['ClaimVaultV2', 'MERCHANT_CREDITOR_ROLE', 'PaymentEscrowV2'],
  ['ClaimVaultV2', 'MERCHANT_CREDITOR_ROLE', 'MerchantGuaranteeVaultV2'],
  ['ClaimVaultV2', 'REWARD_CREDITOR_ROLE', 'RewardLedgerV2'],
  ['ClaimVaultV2', 'PRIZE_CREDITOR_ROLE', 'SeckillV2'],
  ['ClaimVaultV2', 'BNM_CREDITOR_ROLE', 'PaymentEscrowV2'],
  ['ClaimVaultV2', 'MERCHANT_FREEZER_ROLE', 'PaymentEscrowV2'],
  ['ClaimVaultV2', 'MERCHANT_ENCUMBER_ROLE', 'MerchantGuaranteeVaultV2'],
  ['RewardLedgerV2', 'PAYMENT_LOCKER_ROLE', 'PaymentEscrowV2'],
  ['RewardLedgerV2', 'FULFILLMENT_RELEASER_ROLE', 'PaymentEscrowV2'],
  ['MerchantGuaranteeVaultV2', 'TAKEOVER_ROLE', 'PaymentEscrowV2'],
  ['MerchantGuaranteeVaultV2', 'ORDER_RESERVER_ROLE', 'PaymentEscrowV2'],
  ['MerchantGuaranteeVaultV2', 'TAKEOVER_CLOSER_ROLE', 'PaymentEscrowV2'],
  ['PaymentEscrowV2', 'SECKILL_ROLE', 'SeckillV2'],
];

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
  contractEntries.push({
    name,
    source: `platform-v2/contracts/${name}.sol`,
    address: null,
    status: 'ExternalBlocked',
    constructorInputs: constructor.inputs,
    bytecodeSha256: sha256(bytecode),
    deployedBytecodeSha256: sha256(deployedBytecode),
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
  publicationStatus: 'contracts-frozen-not-coordinated',
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
  compiler: { version: '0.8.26', optimizer: true, optimizerRuns: 200, viaIR: true, evmVersion: 'cancun' },
  sourceDigestSha256: sourceDigest,
  deploymentStatus: 'ExternalBlocked',
  externalBlocked: ['SAFE_ADDRESS', 'SECONDARY_SIGNER', 'QUOTE_SIGNER', 'FINALITY_SIGNER', 'TWAP_SOURCE', 'BSC_RPC_URL'],
  decisionBlocked: [
    'launch ProductPolicy commercial values',
    'merchant guarantee and platform reserve thresholds',
    'Oracle maxAge and minimum liquidity',
    'genesis credential contract and token ID',
    'pickup timeout and takeover evidence',
    'empty-session injected prize allocation',
  ],
  deploymentOrder: contracts,
  contracts: contractEntries,
  postDeploymentRoleGrants: roleGrants.map(([contract, role, grantee]) => ({ contract, role, grantee })),
  coordinatedPublicationRequired: [
    'OpenAPI',
    'generated types',
    'state and error enums',
    'WebSocket protocol',
    'consumer tests',
  ],
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
  if (role === 'DEFAULT_ADMIN_ROLE') return 'Safe multisig';
  if (
    (contract === 'PolicyRegistryV2' && role === 'POLICY_PUBLISHER_ROLE') ||
    (contract === 'SeckillV2' && role === 'SESSION_ADMIN_ROLE') ||
    (contract === 'MerchantGuaranteeVaultV2' && role === 'TAKEOVER_DISBURSER_ROLE')
  ) {
    return 'Safe multisig plus secondary signature';
  }
  if (role === 'PAUSER_ROLE' || role === 'RECOVERY_ROLE') return 'Safe multisig';
  return 'Safe-granted Core contract or bounded executor';
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

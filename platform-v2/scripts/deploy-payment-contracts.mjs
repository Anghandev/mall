#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getAddress,
  getCreateAddress,
  keccak256,
  parseEther,
} from 'ethers';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from '../server/api/enums.ts';
import { routerCutoverEvidenceHash } from '../deploy/router-cutover.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const coreRoot = join(repoRoot, 'platform-v2');
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const args = new Set(process.argv.slice(2));
const broadcast = args.has('--broadcast');
const outPath = option('--out') ?? join(repoRoot, 'output', `bsc-payment-v2-${CORE_ARTIFACT_VERSION}-${timestamp()}-private.json`);
const deploymentEvidencePath = option('--deployment-evidence') ?? join(coreRoot, 'deployments', 'bsc-payment-v2.json');
const chainIdExpected = 56n;

const env = loadEnvFiles([
  join(repoRoot, '.env'),
  join(repoRoot, '.env.runtime'),
  join(repoRoot, '.env.wallets.local'),
  join(coreRoot, '.env'),
]);

const provider = new JsonRpcProvider(required('BSC_RPC_URL'));
const fallbackProvider = new JsonRpcProvider(required('BSC_FALLBACK_RPC_URL'));
const signer = new Wallet(required('PLATFORM_TECH_PRIVATE_KEY'), provider);
const governanceWallet = getAddress(required('PLATFORM_GOVERNANCE_WALLET_ADDRESS'));
if (signer.address !== governanceWallet) throw new Error('PLATFORM_TECH_PRIVATE_KEY must match PLATFORM_GOVERNANCE_WALLET_ADDRESS');

const roleWallets = {
  governanceWallet,
  platformServiceFeeWallet: getAddress(required('PLATFORM_SERVICE_FEE_WALLET_ADDRESS')),
  usdtSettlementWallet: getAddress(required('USDT_SETTLEMENT_WALLET_ADDRESS')),
  nplRewardWallet: getAddress(required('NPL_REWARD_WALLET_ADDRESS')),
  operationsWallet: getAddress(required('OPERATIONS_GUARANTEE_WALLET_ADDRESS')),
};
assertDistinct(Object.values(roleWallets), 'production role wallet');

const artifacts = Object.fromEntries(['PolicyRegistryV2', 'BeneficiaryRegistryV2', 'PaymentRouterV2'].map((name) => [
  name,
  readArtifact(name),
]));
const runtimeHashes = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [
  name,
  keccak256(artifact.deployedBytecode.object).toLowerCase(),
]));

const primaryNetwork = await provider.getNetwork();
const fallbackNetwork = await fallbackProvider.getNetwork();
if (primaryNetwork.chainId !== chainIdExpected || fallbackNetwork.chainId !== chainIdExpected) {
  throw new Error('Both RPC providers must be BSC chain 56');
}

const feeData = await provider.getFeeData();
const gasPrice = feeData.gasPrice;
if (!gasPrice) throw new Error('RPC did not return a gas price');
const nonce = await provider.getTransactionCount(signer.address, 'pending');
const balance = await provider.getBalance(signer.address);

const plan = await buildPlan(nonce, gasPrice);
const totalGasCostWei = plan.deployments.reduce((sum, item) => sum + item.maxGasCostWei, 0n);
const maxTotal = optionalNative('DEPLOY_MAX_TOTAL_GAS_COST_BNB') ?? optionalNative('MAX_TOTAL_BUDGET_NATIVE');
const maxPerTx = optionalNative('DEPLOY_MAX_GAS_COST_PER_TX_BNB') ?? optionalNative('MAX_GAS_COST_PER_TX_NATIVE');
if (maxTotal !== undefined && totalGasCostWei > maxTotal) throw new Error('Deployment gas estimate exceeds total budget');
if (maxPerTx !== undefined) {
  for (const item of plan.deployments) {
    if (item.maxGasCostWei > maxPerTx) throw new Error(`${item.name} gas estimate exceeds per-tx budget`);
  }
}
if (balance < totalGasCostWei) throw new Error('Deployment wallet has insufficient BNB for estimated gas');

const packet = {
  schema: 'abu24k.paymentContractsDeployment.v1',
  artifactVersion: CORE_ARTIFACT_VERSION,
  chainId: 56,
  mode: broadcast ? 'BROADCAST' : 'PLAN_ONLY',
  generatedAt: new Date().toISOString(),
  deployer: signer.address,
  roles: roleWallets,
  nonceStart: nonce,
  gasPriceWei: gasPrice.toString(),
  balanceWei: balance.toString(),
  estimatedMaxGasCostWei: totalGasCostWei.toString(),
  budget: {
    maxTotalGasCostWei: maxTotal?.toString() ?? null,
    maxPerTxGasCostWei: maxPerTx?.toString() ?? null,
  },
  runtimeBytecodeHash: runtimeHashes,
  deployments: plan.deployments.map((item) => ({
    name: item.name,
    nonce: item.nonce,
    predictedAddress: item.predictedAddress,
    constructorArgs: item.constructorArgs,
    gasLimit: item.gasLimit.toString(),
    maxGasCostWei: item.maxGasCostWei.toString(),
    txHash: null,
    deploymentBlock: null,
    deployedCodeHash: null,
  })),
  previousDeployment: previousLineage(),
  broadcastComplete: false,
};

writePrivateJson(outPath, packet);
console.log(JSON.stringify({
  mode: packet.mode,
  artifactVersion: packet.artifactVersion,
  chainId: packet.chainId,
  deployer: redact(signer.address),
  nonceStart: packet.nonceStart,
  estimatedMaxGasCostBNB: formatEther(totalGasCostWei),
  output: outPath,
}, null, 2));

if (!broadcast) process.exit(0);

const receipts = [];
let policyAddress;
let beneficiaryAddress;
let routerAddress;
for (const item of plan.deployments) {
  const factory = new ContractFactory(artifacts[item.name].abi, artifacts[item.name].bytecode.object, signer);
  const contract = await factory.deploy(...item.constructorArgs, {
    nonce: item.nonce,
    gasLimit: item.gasLimit,
    gasPrice,
  });
  if (contract.deploymentTransaction()?.hash) item.txHash = contract.deploymentTransaction().hash;
  const receipt = await contract.deploymentTransaction().wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${item.name} deployment failed`);
  const address = await contract.getAddress();
  if (address.toLowerCase() !== item.predictedAddress.toLowerCase()) throw new Error(`${item.name} address mismatch`);
  const [primaryCode, fallbackCode] = await Promise.all([
    provider.getCode(address),
    fallbackProvider.getCode(address),
  ]);
  const primaryHash = keccak256(primaryCode).toLowerCase();
  const fallbackHash = keccak256(fallbackCode).toLowerCase();
  if (primaryHash !== runtimeHashes[item.name] || fallbackHash !== runtimeHashes[item.name]) {
    throw new Error(`${item.name} deployed runtime hash mismatch`);
  }
  item.deploymentBlock = receipt.blockNumber;
  item.deployedCodeHash = primaryHash;
  receipts.push({ name: item.name, address, txHash: item.txHash, blockNumber: receipt.blockNumber, codeHash: primaryHash });
  if (item.name === 'PolicyRegistryV2') policyAddress = address;
  if (item.name === 'BeneficiaryRegistryV2') beneficiaryAddress = address;
  if (item.name === 'PaymentRouterV2') routerAddress = address;
  packet.deployments = packet.deployments.map((record) => record.name === item.name
    ? {
      ...record,
      txHash: item.txHash,
      deploymentBlock: item.deploymentBlock,
      deployedCodeHash: item.deployedCodeHash,
    }
    : record);
  writePrivateJson(outPath, { ...packet, receipts });
}

await verifyRouterBindings(routerAddress, policyAddress, beneficiaryAddress);
const finalEvidence = deploymentEvidence(packet, receipts, routerAddress);
writePrivateJson(outPath, finalEvidence);
console.log(JSON.stringify({
  mode: 'BROADCAST_COMPLETE',
  artifactVersion: finalEvidence.artifactVersion,
  contracts: Object.fromEntries(Object.entries(finalEvidence.contracts).map(([name, value]) => [
    name,
    { address: redact(value.address), block: value.deploymentBlock, txHash: redactHash(value.deploymentTxHash) },
  ])),
  output: outPath,
}, null, 2));

async function buildPlan(startNonce, price) {
  const previous = previousLineage();
  const deployments = [];
  const policy = planDeployment('PolicyRegistryV2', startNonce, [governanceWallet]);
  deployments.push(policy);
  const beneficiary = planDeployment('BeneficiaryRegistryV2', startNonce + 1, [policy.predictedAddress]);
  beneficiary.estimateArgs = [previous?.contracts?.PolicyRegistryV2?.address ?? policy.predictedAddress];
  deployments.push(beneficiary);
  const router = planDeployment('PaymentRouterV2', startNonce + 2, [
    USDT_ADDRESS,
    NPL_ADDRESS,
    policy.predictedAddress,
    beneficiary.predictedAddress,
    roleWallets.platformServiceFeeWallet,
    roleWallets.usdtSettlementWallet,
    roleWallets.nplRewardWallet,
    roleWallets.operationsWallet,
  ]);
  router.estimateArgs = [
    USDT_ADDRESS,
    NPL_ADDRESS,
    previous?.contracts?.PolicyRegistryV2?.address ?? policy.predictedAddress,
    previous?.contracts?.BeneficiaryRegistryV2?.address ?? beneficiary.predictedAddress,
    roleWallets.platformServiceFeeWallet,
    roleWallets.usdtSettlementWallet,
    roleWallets.nplRewardWallet,
    roleWallets.operationsWallet,
  ];
  deployments.push(router);
  for (const item of deployments) {
    const factory = new ContractFactory(artifacts[item.name].abi, artifacts[item.name].bytecode.object, signer);
    const tx = await factory.getDeployTransaction(...(item.estimateArgs ?? item.constructorArgs));
    const estimated = await provider.estimateGas({ ...tx, from: signer.address });
    item.gasLimit = estimated * 120n / 100n + 10_000n;
    item.maxGasCostWei = item.gasLimit * price;
  }
  return { deployments };
}

function planDeployment(name, itemNonce, constructorArgs) {
  return {
    name,
    nonce: itemNonce,
    predictedAddress: getCreateAddress({ from: signer.address, nonce: itemNonce }),
    constructorArgs,
    gasLimit: 0n,
    maxGasCostWei: 0n,
    txHash: null,
    deploymentBlock: null,
    deployedCodeHash: null,
  };
}

async function verifyRouterBindings(routerAddress, policyAddress, beneficiaryAddress) {
  const router = new Contract(routerAddress, artifacts.PaymentRouterV2.abi, provider);
  const expected = {
    governanceWallet,
    quoteSigner: governanceWallet,
    policyRegistry: policyAddress,
    beneficiaryRegistry: beneficiaryAddress,
    platformServiceFeeWallet: roleWallets.platformServiceFeeWallet,
    usdtSettlementWallet: roleWallets.usdtSettlementWallet,
    nplRewardWallet: roleWallets.nplRewardWallet,
    operationsWallet: roleWallets.operationsWallet,
  };
  for (const [name, value] of Object.entries(expected)) {
    const actual = getAddress(await router[name]());
    if (actual !== getAddress(value)) throw new Error(`Router ${name} binding mismatch`);
  }
  if (getAddress(await router.usdt()) !== getAddress(USDT_ADDRESS)) throw new Error('Router USDT binding mismatch');
  if (getAddress(await router.npl()) !== getAddress(NPL_ADDRESS)) throw new Error('Router NPL binding mismatch');
}

function deploymentEvidence(packetValue, receiptRecords, routerAddress) {
  const contracts = {};
  for (const receipt of receiptRecords) {
    contracts[receipt.name] = {
      address: receipt.address,
      deploymentBlock: receipt.blockNumber,
      deployedCodeHash: receipt.codeHash,
      deploymentTxHash: receipt.txHash,
      sourceVerified: false,
    };
  }
  const previous = packetValue.previousDeployment;
  const routerCutover = {
    status: 'PRE_LAUNCH_DIRECT_REPLACEMENT',
    priorRouter: previous?.contracts?.PaymentRouterV2?.address ?? '0x0000000000000000000000000000000000000000',
    activeRouter: routerAddress,
    platformServiceFeeWallet: roleWallets.platformServiceFeeWallet,
    deploymentTxHash: contracts.PaymentRouterV2.deploymentTxHash,
    deploymentBlock: contracts.PaymentRouterV2.deploymentBlock,
    deployedCodeHash: contracts.PaymentRouterV2.deployedCodeHash,
  };
  routerCutover.evidenceHash = routerCutoverEvidenceHash(routerCutover);
  return {
    schema: 'abu24k.paymentDeploymentEvidence.v1',
    artifactVersion: CORE_ARTIFACT_VERSION,
    chainId: 56,
    architecture: 'FIVE_ROLE_EOA_V2',
    deploymentStatus: 'DEPLOYED',
    deploymentAuthorized: false,
    authorizationEvidenceHash: null,
    currentArtifactDeployment: true,
    contracts,
    routerCutover,
    previousHistoricalLineage: previous ? {
      artifactVersion: previous.artifactVersion,
      deploymentAuthorized: false,
      deploymentAuthorizationEvidenceHash:
        previous.historicalAuthorization?.authorizationEvidenceHash ?? previous.authorizationEvidenceHash ?? null,
      note: 'Previous deployment lineage only; current artifact was redeployed separately.',
    } : null,
    broadcastComplete: true,
    deploymentPacketSha256: sha256File(outPath),
  };
}

function previousLineage() {
  if (!existsSync(deploymentEvidencePath)) return null;
  const value = JSON.parse(readFileSync(deploymentEvidencePath, 'utf8'));
  return {
    artifactVersion: value.artifactVersion,
    deploymentStatus: value.deploymentStatus,
    contracts: value.contracts,
    historicalAuthorization: value.historicalAuthorization ?? null,
    authorizationEvidenceHash: value.authorizationEvidenceHash ?? null,
  };
}

function readArtifact(name) {
  const path = join(coreRoot, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) throw new Error(`Missing Foundry artifact for ${name}; run pnpm --filter @abu24k/core contracts:build`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadEnvFiles(paths) {
  const result = { ...process.env };
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (!key || result[key] !== undefined) continue;
      result[key] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNative(name) {
  const value = env[name]?.trim();
  if (!value) return undefined;
  return parseEther(value);
}

function assertDistinct(values, label) {
  const lowered = values.map((value) => getAddress(value).toLowerCase());
  if (new Set(lowered).size !== lowered.length) throw new Error(`${label} collision`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256File(path) {
  return `0x${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function redact(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function redactHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : null;
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/0x[0-9a-fA-F]{128,}/g, '0x<redacted-bytecode>')
    .replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted-hash>')
    .replace(/0x[0-9a-fA-F]{40}/g, '0x<redacted-address>');
  console.error(`deploy-payment-contracts failed: ${sanitized}`);
  process.exit(1);
}

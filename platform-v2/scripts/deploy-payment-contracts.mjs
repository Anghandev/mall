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
const resume = args.has('--resume');
const outPath = option('--out') ?? join(repoRoot, 'output', `bsc-payment-v2-${CORE_ARTIFACT_VERSION}-${timestamp()}-private.json`);
const deploymentEvidencePath = option('--deployment-evidence') ?? join(coreRoot, 'deployments', 'bsc-payment-v2.json');
const resumePacket = loadResumePacket(option('--resume-packet'));
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
const normalizedRuntimeHashes = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [
  name,
  normalizedRuntimeHash(artifact, artifact.deployedBytecode.object),
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
const nonceStart = parseNonceStart(option('--nonce-start') ?? env.DEPLOY_NONCE_START, nonce);
if (nonceStart < nonce && !resume) {
  throw new Error('Nonce start is behind the deployer pending nonce; use --resume only after reconciling the existing deployment');
}
const balance = await provider.getBalance(signer.address);

const plan = await buildPlan(nonceStart, gasPrice);
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
  resume,
  generatedAt: new Date().toISOString(),
  deployer: signer.address,
  roles: roleWallets,
  nonceStart,
  deployerPendingNonce: nonce,
  gasPriceWei: gasPrice.toString(),
  balanceWei: balance.toString(),
  estimatedMaxGasCostWei: totalGasCostWei.toString(),
  budget: {
    maxTotalGasCostWei: maxTotal?.toString() ?? null,
    maxPerTxGasCostWei: maxPerTx?.toString() ?? null,
  },
  runtimeBytecodeHash: runtimeHashes,
  normalizedRuntimeBytecodeHash: normalizedRuntimeHashes,
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
    normalizedRuntimeBytecodeHash: null,
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
  const resumed = resume ? await reconcileExistingDeployment(item) : null;
  if (resumed) {
    item.txHash = resumed.txHash;
    item.deploymentBlock = resumed.blockNumber;
    item.deployedCodeHash = resumed.codeHash;
    item.normalizedRuntimeBytecodeHash = resumed.normalizedHash;
    receipts.push({
      name: item.name,
      address: item.predictedAddress,
      txHash: item.txHash,
      blockNumber: item.deploymentBlock,
      codeHash: item.deployedCodeHash,
      normalizedHash: item.normalizedRuntimeBytecodeHash,
      resumed: true,
    });
    if (item.name === 'PolicyRegistryV2') policyAddress = item.predictedAddress;
    if (item.name === 'BeneficiaryRegistryV2') beneficiaryAddress = item.predictedAddress;
    if (item.name === 'PaymentRouterV2') routerAddress = item.predictedAddress;
    updatePacketDeployment(item, receipts);
    continue;
  }
  if (item.nonce < nonce) {
    throw new Error(`${item.name} nonce was already consumed but no matching deployment exists at the predicted address`);
  }
  const factory = new ContractFactory(artifacts[item.name].abi, artifacts[item.name].bytecode.object, signer);
  const contract = await factory.deploy(...item.constructorArgs, {
    nonce: item.nonce,
    gasLimit: item.gasLimit,
    gasPrice,
  });
  if (contract.deploymentTransaction()?.hash) item.txHash = contract.deploymentTransaction().hash;
  updatePacketDeployment(item, receipts);
  const receipt = await contract.deploymentTransaction().wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${item.name} deployment failed`);
  const address = await contract.getAddress();
  if (address.toLowerCase() !== item.predictedAddress.toLowerCase()) throw new Error(`${item.name} address mismatch`);
  const [primaryCode, fallbackCode] = await Promise.all([
    provider.getCode(address),
    fallbackProvider.getCode(address),
  ]);
  const { codeHash: primaryHash, normalizedHash } = verifyDeploymentCode(item.name, primaryCode, fallbackCode);
  item.deploymentBlock = receipt.blockNumber;
  item.deployedCodeHash = primaryHash;
  item.normalizedRuntimeBytecodeHash = normalizedHash;
  receipts.push({
    name: item.name,
    address,
    txHash: item.txHash,
    blockNumber: receipt.blockNumber,
    codeHash: primaryHash,
    normalizedHash,
    resumed: false,
  });
  if (item.name === 'PolicyRegistryV2') policyAddress = address;
  if (item.name === 'BeneficiaryRegistryV2') beneficiaryAddress = address;
  if (item.name === 'PaymentRouterV2') routerAddress = address;
  updatePacketDeployment(item, receipts);
}

await verifyRegistryBindings(policyAddress, beneficiaryAddress);
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

async function verifyRegistryBindings(policyAddress, beneficiaryAddress) {
  const policy = new Contract(policyAddress, artifacts.PolicyRegistryV2.abi, provider);
  if (getAddress(await policy.governanceWallet()) !== governanceWallet) {
    throw new Error('PolicyRegistry governanceWallet binding mismatch');
  }
  if (getAddress(await policy.secondarySigner()) !== governanceWallet) {
    throw new Error('PolicyRegistry secondarySigner binding mismatch');
  }
  const beneficiary = new Contract(beneficiaryAddress, artifacts.BeneficiaryRegistryV2.abi, provider);
  if (getAddress(await beneficiary.policyRegistry()) !== getAddress(policyAddress)) {
    throw new Error('BeneficiaryRegistry policyRegistry binding mismatch');
  }
}

function deploymentEvidence(packetValue, receiptRecords, routerAddress) {
  const contracts = {};
  for (const receipt of receiptRecords) {
    contracts[receipt.name] = {
      address: receipt.address,
      deploymentBlock: receipt.blockNumber,
      deployedCodeHash: receipt.codeHash,
      normalizedRuntimeBytecodeHash: receipt.normalizedHash,
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
  routerCutover.evidenceHash = routerCutoverEvidenceHash({ ...routerCutover, evidenceHash: `0x${'0'.repeat(64)}` });
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

function updatePacketDeployment(item, receiptRecords) {
  packet.deployments = packet.deployments.map((record) => record.name === item.name
    ? {
      ...record,
      txHash: item.txHash,
      deploymentBlock: item.deploymentBlock,
      deployedCodeHash: item.deployedCodeHash,
      normalizedRuntimeBytecodeHash: item.normalizedRuntimeBytecodeHash,
    }
    : record);
  writePrivateJson(outPath, { ...packet, receipts: receiptRecords });
}

async function reconcileExistingDeployment(item) {
  const [primaryCode, fallbackCode] = await Promise.all([
    provider.getCode(item.predictedAddress),
    fallbackProvider.getCode(item.predictedAddress),
  ]);
  if (primaryCode === '0x' && fallbackCode === '0x') return null;
  const verified = verifyDeploymentCode(item.name, primaryCode, fallbackCode);
  const receipt = await findResumePacketReceipt(item) ?? await findDeploymentReceipt(item);
  if (!receipt) throw new Error(`${item.name} existing deployment receipt was not found during resume scan`);
  return {
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    codeHash: verified.codeHash,
    normalizedHash: verified.normalizedHash,
  };
}

async function findResumePacketReceipt(item) {
  const record = resumePacketRecord(item);
  if (!record?.txHash) return null;
  const receipt = await provider.getTransactionReceipt(record.txHash);
  if (
    receipt?.status !== 1
      || receipt.contractAddress?.toLowerCase() !== item.predictedAddress.toLowerCase()
  ) {
    throw new Error(`${item.name} resume packet receipt does not match the predicted deployment`);
  }
  if (record.blockNumber !== null && record.blockNumber !== undefined && receipt.blockNumber !== record.blockNumber) {
    throw new Error(`${item.name} resume packet block does not match the receipt`);
  }
  return { txHash: record.txHash, blockNumber: receipt.blockNumber };
}

function resumePacketRecord(item) {
  if (!resumePacket) return null;
  const candidates = [
    ...(Array.isArray(resumePacket.receipts) ? resumePacket.receipts : []),
    ...(Array.isArray(resumePacket.deployments) ? resumePacket.deployments : []),
  ];
  for (const candidate of candidates) {
    if (candidate?.name !== item.name) continue;
    const address = candidate.address ?? candidate.predictedAddress;
    if (typeof address !== 'string' || address.toLowerCase() !== item.predictedAddress.toLowerCase()) continue;
    const nonce = candidate.nonce;
    if (nonce !== undefined && nonce !== item.nonce) continue;
    return {
      txHash: candidate.txHash,
      blockNumber: candidate.blockNumber ?? candidate.deploymentBlock ?? null,
    };
  }
  return null;
}

async function findDeploymentReceipt(item) {
  const scanBlocks = Number.parseInt(env.DEPLOY_RESUME_SCAN_BLOCKS ?? '5000', 10);
  if (!Number.isSafeInteger(scanBlocks) || scanBlocks < 1) throw new Error('DEPLOY_RESUME_SCAN_BLOCKS must be a positive integer');
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - scanBlocks);
  const expectedAddress = item.predictedAddress.toLowerCase();
  const deployer = signer.address.toLowerCase();
  for (let blockNumber = latest; blockNumber >= fromBlock; blockNumber -= 1) {
    const block = await provider.getBlock(blockNumber, true);
    const transactions = block.prefetchedTransactions ?? block.transactions ?? [];
    for (const tx of transactions) {
      if (typeof tx === 'string') continue;
      if (String(tx.from).toLowerCase() !== deployer || tx.nonce !== item.nonce) continue;
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (
        receipt?.status === 1
          && receipt.contractAddress?.toLowerCase() === expectedAddress
      ) {
        return { txHash: tx.hash, blockNumber: receipt.blockNumber };
      }
    }
  }
  return null;
}

function verifyDeploymentCode(name, primaryCode, fallbackCode) {
  if (primaryCode === '0x' || fallbackCode === '0x') throw new Error(`${name} deployment code missing on one RPC`);
  const primaryHash = keccak256(primaryCode).toLowerCase();
  const fallbackHash = keccak256(fallbackCode).toLowerCase();
  if (primaryHash !== fallbackHash) throw new Error(`${name} deployed runtime differs across RPC providers`);
  const primaryNormalized = normalizedRuntimeHash(artifacts[name], primaryCode);
  const fallbackNormalized = normalizedRuntimeHash(artifacts[name], fallbackCode);
  if (
    primaryNormalized !== normalizedRuntimeHashes[name]
      || fallbackNormalized !== normalizedRuntimeHashes[name]
  ) {
    throw new Error(`${name} normalized deployed runtime hash mismatch`);
  }
  return { codeHash: primaryHash, normalizedHash: primaryNormalized };
}

function normalizedRuntimeHash(artifact, bytecode) {
  return keccak256(normalizeImmutableReferences(bytecode, artifact.deployedBytecode?.immutableReferences ?? {})).toLowerCase();
}

function normalizeImmutableReferences(bytecode, immutableReferences) {
  const bytes = strip0x(bytecode);
  const ranges = Object.values(immutableReferences).flat();
  if (ranges.length === 0) return `0x${bytes}`;
  const chars = bytes.split('');
  for (const range of ranges) {
    const start = range.start * 2;
    const end = start + range.length * 2;
    for (let index = start; index < end; index += 1) chars[index] = '0';
  }
  return `0x${chars.join('')}`;
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

function loadResumePacket(path) {
  if (!path) return null;
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error('Resume packet does not exist');
  const value = JSON.parse(readFileSync(absolute, 'utf8'));
  if (value?.artifactVersion !== CORE_ARTIFACT_VERSION || value.chainId !== 56) {
    throw new Error('Resume packet does not match the current artifact version and chain');
  }
  return value;
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

function parseNonceStart(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Nonce start must be a non-negative integer');
  return parsed;
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

function strip0x(value) {
  return value.startsWith('0x') ? value.slice(2) : value;
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

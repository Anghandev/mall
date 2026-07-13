#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { readEnvFile, requireEnv, targetChain } from '../microtest/env-utils.mjs';
import { appendTxLog, assertTxBudget, weiToNativeString } from '../microtest/tx-guard.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const DEPLOYMENT_PATH = 'deployments/mainnet-micro-test.json';
const WRITE_ENV = process.argv.includes('--write-env') || process.env.WRITE_ENV_ESCROW === '1';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);

if (chain.key !== 'bsc') {
  throw new Error('24K PaymentEscrow is BSC-only. Set TARGET_CHAIN=bsc before deploying escrow.');
}
if (String(env.CHAIN_ID || '') !== String(chain.chainId)) {
  throw new Error(`CHAIN_ID=${env.CHAIN_ID || '<empty>'} does not match BSC chainId ${chain.chainId}`);
}
if (env.MICRO_TEST !== 'true' && env.ALLOW_PRODUCTION_DEPLOY !== 'true') {
  throw new Error('Refusing deploy: set MICRO_TEST=true for this guarded workflow, or ALLOW_PRODUCTION_DEPLOY=true intentionally.');
}

requireEnv(env, ['TARGET_CHAIN', 'CHAIN_ID', 'PRIVATE_KEY']);

const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
if (!rpcUrl) {
  throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);
}
const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
const network = await provider.getNetwork();
if (Number(network.chainId) !== chain.chainId) {
  throw new Error(`RPC chainId ${network.chainId} does not match BSC ${chain.chainId}`);
}

const signer = new Wallet(normalizePrivateKey(env.PRIVATE_KEY), provider);
const deployer = await signer.getAddress();
if (env.EXPO_PUBLIC_NPL_BSC_ADDRESS && env.EXPO_PUBLIC_NPL_BSC_ADDRESS.toLowerCase() !== DEFAULT_BSC_NPL.toLowerCase()) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${DEFAULT_BSC_NPL} on BSC`);
}
const npl = DEFAULT_BSC_NPL;
const owner = requireSafeOwner(env.ESCROW_OWNER_ADDRESS);
if ((await provider.getCode(owner)) === '0x') throw new Error('ESCROW_OWNER_ADDRESS must be a deployed multisig contract');
const rewardLedgerAddress = requireAddress(
  env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS,
  'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS'
);
const orderSigner = requireAddress(env.ORDER_SIGNER_ADDRESS, 'ORDER_SIGNER_ADDRESS');
const seller = requireAddress(
  env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS,
  'MERCHANT_RECEIVER_ADDRESS or EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS'
);
const retainedNplReceiver = requireAddress(
  env.RETAINED_NPL_RECEIVER_ADDRESS || env.PRIZE_POOL_RECEIVER_ADDRESS || env.DEV_WALLET || deployer,
  'RETAINED_NPL_RECEIVER_ADDRESS, PRIZE_POOL_RECEIVER_ADDRESS or DEV_WALLET'
);
const splitConfig = readSplitConfig(env);

run('forge', ['build']);

const artifact = JSON.parse(readFileSync('out/Abu24KPaymentEscrow.sol/Abu24KPaymentEscrow.json'));
const bytecode = typeof artifact.bytecode === 'object' ? artifact.bytecode.object : artifact.bytecode;
const factory = new ContractFactory(artifact.abi, bytecode, signer);
const deployTx = await factory.getDeployTransaction(npl, rewardLedgerAddress, orderSigner, retainedNplReceiver, deployer);
const estimatedGas = await signer.estimateGas(deployTx);
const feeData = await provider.getFeeData();
const maxFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGasWei) throw new Error('Could not read gas price from RPC');

assertTxBudget({
  env,
  operation: 'deploy Abu24KPaymentEscrow',
  functionCall: 'constructor(address npl,address rewardLedger,address orderSigner,address retainedNplReceiver,address initialOwner)',
  target: 'CREATE',
  valueWei: 0n,
  estimatedGas,
  maxFeePerGasWei,
  expectedResult: 'escrow contract deployed',
});

console.log('=== Deploy Abu24KPaymentEscrow ===');
console.log(`chain: ${chain.key} (${chain.chainId})`);
console.log(`deployer: ${deployer}`);
console.log(`owner: ${owner}`);
console.log(`npl: ${npl}`);
console.log(`reward ledger: ${rewardLedgerAddress}`);
console.log(`order signer: ${orderSigner}`);
console.log(`approved seller: ${seller}`);
console.log(`retained NPL receiver: ${retainedNplReceiver}`);
console.log(`estimated gas: ${estimatedGas}`);
console.log(`estimated max gas cost: ${weiToNativeString(estimatedGas * maxFeePerGasWei)} ${chain.native}`);

const contract = await factory.deploy(npl, rewardLedgerAddress, orderSigner, retainedNplReceiver, deployer);
const tx = contract.deploymentTransaction();
if (!tx) throw new Error('Deployment transaction was not created');

console.log(`deploy tx: ${tx.hash}`);
const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
const receipt = await tx.wait(confirmations);
if (!receipt || receipt.status !== 1) {
  throw new Error(`Deployment failed or receipt missing for tx ${tx.hash}`);
}

const address = await contract.getAddress();
const gasPriceWei = receipt.gasPrice ?? maxFeePerGasWei;
const costWei = receipt.gasUsed * gasPriceWei;

appendTxLog({
  operation: 'deploy Abu24KPaymentEscrow',
  functionCall: 'constructor(address npl,address rewardLedger,address orderSigner,address retainedNplReceiver,address initialOwner)',
  target: address,
  value: '0',
  estimatedGas: estimatedGas.toString(),
  gasUsed: receipt.gasUsed.toString(),
  maxFeePerGasWei: maxFeePerGasWei.toString(),
  gasPriceWei: gasPriceWei.toString(),
  costWei: costWei.toString(),
  hash: tx.hash,
  result: 'success',
});

const split = await guardedCall({
  contract,
  target: address,
  operation: 'configure escrow split',
  functionCall: 'Abu24KPaymentEscrow.setSplitConfig((address,address,address,address,address,address,uint16,uint16,uint16,uint16,uint16,uint16,uint16))',
  method: 'setSplitConfig',
  args: [splitConfig],
  maxFeePerGasWei,
});
const sellerApproval = await guardedCall({
  contract,
  target: address,
  operation: 'approve escrow seller',
  functionCall: 'Abu24KPaymentEscrow.setSeller(address,bool)',
  method: 'setSeller',
  args: [seller, true],
  maxFeePerGasWei,
});

const ledger = new Contract(rewardLedgerAddress, [
  'function owner() view returns (address)',
  'function operators(address) view returns (bool)',
  'function setOperator(address,bool)'
], signer);
const ledgerOwner = await ledger.owner();
if (ledgerOwner.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error(`RewardLedger owner must be the deployer for setOperator: ${ledgerOwner} !== ${deployer}`);
}
const ledgerOperator = await guardedCall({
  contract: ledger,
  target: rewardLedgerAddress,
  operation: 'authorize Escrow as RewardLedger operator',
  functionCall: 'Abu24KRewardLedger.setOperator(address,bool)',
  method: 'setOperator',
  args: [address, true],
  maxFeePerGasWei,
});
const unpause = await guardedCall({
  contract,
  target: address,
  operation: 'unpause configured escrow',
  functionCall: 'Abu24KPaymentEscrow.unpause()',
  method: 'unpause',
  args: [],
  maxFeePerGasWei,
});

let transferOwnershipTxHash = '';
if (owner.toLowerCase() !== deployer.toLowerCase()) {
  const ownership = await guardedCall({
    contract,
    target: address,
    operation: 'transfer Escrow ownership',
    functionCall: 'Abu24KPaymentEscrow.transferOwnership(address)',
    method: 'transferOwnership',
    args: [owner],
    maxFeePerGasWei,
  });
  transferOwnershipTxHash = ownership.txHash;
}

const splitVersion = await contract.currentSplitVersion();
if (splitVersion !== 1n) throw new Error(`Expected initial escrow split version 1, got ${splitVersion}`);
if (!(await contract.approvedSellers(seller))) throw new Error('Escrow seller approval was not recorded');
if (!(await ledger.operators(address))) throw new Error('Escrow RewardLedger operator authorization was not recorded');
if (await contract.paused()) throw new Error('Escrow remained paused after initialization');

fs.mkdirSync('deployments', { recursive: true });
const deployment = {
  contractName: 'Abu24KPaymentEscrow',
  address,
  txHash: tx.hash,
  chain: chain.key,
  chainId: chain.chainId,
  npl,
  rewardLedgerAddress,
  orderSigner,
  seller,
  retainedNplReceiver,
  splitVersion: splitVersion.toString(),
  splitConfig,
  owner,
  deployer,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  gasPriceWei: gasPriceWei.toString(),
  nativeCost: weiToNativeString(costWei),
  setSplitConfigTxHash: split.txHash,
  setSellerTxHash: sellerApproval.txHash,
  setLedgerOperatorTxHash: ledgerOperator.txHash,
  unpauseTxHash: unpause.txHash,
  transferOwnershipTxHash,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(deployment, null, 2)}\n`);

if (WRITE_ENV) {
  updateEnvFile('.env', {
    EXPO_PUBLIC_ESCROW_ADDRESS: address,
    EXPO_PUBLIC_NPL_BSC_ADDRESS: npl,
    EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    ORDER_SIGNER_ADDRESS: orderSigner,
    ESCROW_SPLIT_VERSION: splitVersion.toString(),
    RETAINED_NPL_RECEIVER_ADDRESS: retainedNplReceiver,
    ESCROW_FROM_BLOCK: String(receipt.blockNumber),
  });
}

console.log('deploy: PASS');
console.log(`wrote ${DEPLOYMENT_PATH}`);
console.log(`EXPO_PUBLIC_ESCROW_ADDRESS=${address}`);
console.log(`ESCROW_SPLIT_VERSION=${splitVersion}`);
console.log(`ESCROW_FROM_BLOCK=${receipt.blockNumber}`);
if (!WRITE_ENV) {
  console.log('提示：需要自动写入 .env 时，用 pnpm deploy:escrow -- --write-env。');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function readFileSync(file) {
  return fs.readFileSync(resolve(file), 'utf8');
}

async function guardedCall({ contract, target, operation, functionCall, method, args, maxFeePerGasWei }) {
  const txRequest = await contract[method].populateTransaction(...args);
  const estimatedGas = await signer.estimateGas({ ...txRequest, to: target });
  assertTxBudget({
    env,
    operation,
    functionCall,
    target,
    valueWei: 0n,
    estimatedGas,
    maxFeePerGasWei,
    expectedResult: operation,
  });
  const tx = await contract[method](...args);
  console.log(`${operation} tx: ${tx.hash}`);
  const result = await tx.wait(confirmations);
  if (!result || result.status !== 1) throw new Error(`${operation} failed or receipt missing for tx ${tx.hash}`);
  const gasPriceWei = result.gasPrice ?? maxFeePerGasWei;
  appendTxLog({
    operation,
    functionCall,
    target,
    value: '0',
    estimatedGas: estimatedGas.toString(),
    gasUsed: result.gasUsed.toString(),
    maxFeePerGasWei: maxFeePerGasWei.toString(),
    gasPriceWei: gasPriceWei.toString(),
    costWei: (result.gasUsed * gasPriceWei).toString(),
    hash: tx.hash,
    result: 'success',
  });
  return { txHash: tx.hash, blockNumber: result.blockNumber };
}

function readSplitConfig(values) {
  const bps = {
    merchantBps: readBps(values.ESCROW_MERCHANT_BPS, 7000, 'ESCROW_MERCHANT_BPS'),
    platformBps: readBps(values.ESCROW_PLATFORM_BPS, 1000, 'ESCROW_PLATFORM_BPS'),
    regionBps: readBps(values.ESCROW_REGION_BPS, 500, 'ESCROW_REGION_BPS'),
    referralBps: readBps(values.ESCROW_REFERRAL_BPS, 500, 'ESCROW_REFERRAL_BPS'),
    prizePoolBps: readBps(values.ESCROW_PRIZE_POOL_BPS, 500, 'ESCROW_PRIZE_POOL_BPS'),
    burnBps: readBps(values.ESCROW_BURN_BPS, 300, 'ESCROW_BURN_BPS'),
    circulationBps: readBps(values.ESCROW_CIRCULATION_BPS, 200, 'ESCROW_CIRCULATION_BPS')
  };
  if (Object.values(bps).reduce((sum, value) => sum + value, 0) !== 10_000 || bps.merchantBps === 0) {
    throw new Error('Escrow split BPS must total 10000 and merchant BPS must be greater than zero');
  }
  return {
    platformReceiver: requireSplitReceiver(values.PLATFORM_RECEIVER_ADDRESS, bps.platformBps, 'PLATFORM_RECEIVER_ADDRESS'),
    regionReceiver: requireSplitReceiver(values.REGION_RECEIVER_ADDRESS, bps.regionBps, 'REGION_RECEIVER_ADDRESS'),
    referralReceiver: requireSplitReceiver(values.REFERRAL_RECEIVER_ADDRESS, bps.referralBps, 'REFERRAL_RECEIVER_ADDRESS'),
    prizePoolReceiver: requireSplitReceiver(values.PRIZE_POOL_RECEIVER_ADDRESS, bps.prizePoolBps, 'PRIZE_POOL_RECEIVER_ADDRESS'),
    burnReceiver: requireSplitReceiver(values.BURN_RECEIVER_ADDRESS, bps.burnBps, 'BURN_RECEIVER_ADDRESS'),
    circulationReceiver: requireSplitReceiver(values.CIRCULATION_RECEIVER_ADDRESS, bps.circulationBps, 'CIRCULATION_RECEIVER_ADDRESS'),
    ...bps
  };
}

function readBps(value, fallback, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) throw new Error(`${name} must be an integer from 0 to 10000`);
  return number;
}

function requireSplitReceiver(value, bps, name) {
  if (bps === 0 && !value) return ZERO;
  return requireAddress(value, name);
}

function normalizePrivateKey(value) {
  const key = String(value || '').trim();
  const hex = key.startsWith('0x') ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex key. It will not be printed.');
  }
  return `0x${hex}`;
}

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return address;
}

function requireSafeOwner(value) {
  const address = requireAddress(value, 'ESCROW_OWNER_ADDRESS or DEV_WALLET');
  const lower = address.toLowerCase();
  if (lower === ZERO.toLowerCase() || lower === DEAD.toLowerCase()) {
    throw new Error('Escrow owner cannot be zero/dead address');
  }
  return address;
}

function updateEnvFile(file, updates) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seen = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log('updated .env with escrow address, retained NPL receiver and from-block');
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`deploy refused: ${message}`);
  process.exit(1);
}

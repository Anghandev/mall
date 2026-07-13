#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { readEnvFile, requireEnv, targetChain } from '../microtest/env-utils.mjs';
import { appendTxLog, assertTxBudget, weiToNativeString } from '../microtest/tx-guard.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const DEPLOYMENT_PATH = 'deployments/seckill-mainnet-micro-test.json';
const WRITE_ENV = process.argv.includes('--write-env') || process.env.WRITE_ENV_SECKILL === '1';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
if (chain.key !== 'bsc') throw new Error('24K Seckill deployment is BSC-only. Set TARGET_CHAIN=bsc.');
if (String(env.CHAIN_ID || '') !== String(chain.chainId)) throw new Error(`CHAIN_ID=${env.CHAIN_ID || '<empty>'} does not match BSC chainId ${chain.chainId}`);
if (env.MICRO_TEST !== 'true' && env.ALLOW_PRODUCTION_DEPLOY !== 'true') {
  throw new Error('Refusing deploy: set MICRO_TEST=true for this guarded workflow, or ALLOW_PRODUCTION_DEPLOY=true intentionally.');
}
requireEnv(env, ['TARGET_CHAIN', 'CHAIN_ID', 'PRIVATE_KEY']);

const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
if (!rpcUrl) throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);
const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
const network = await provider.getNetwork();
if (Number(network.chainId) !== chain.chainId) throw new Error(`RPC chainId ${network.chainId} does not match BSC ${chain.chainId}`);

const signer = new Wallet(normalizePrivateKey(env.PRIVATE_KEY), provider);
const deployer = await signer.getAddress();
const owner = requireSafeOwner(env.SECKILL_OWNER_ADDRESS, 'SECKILL_OWNER_ADDRESS');
const finalLedgerOwner = requireSafeOwner(env.REWARDS_OWNER_ADDRESS, 'REWARDS_OWNER_ADDRESS');
if ((await provider.getCode(owner)) === '0x') throw new Error('SECKILL_OWNER_ADDRESS must be a deployed multisig contract');
if ((await provider.getCode(finalLedgerOwner)) === '0x') throw new Error('REWARDS_OWNER_ADDRESS must be a deployed multisig contract');
if (env.EXPO_PUBLIC_NPL_BSC_ADDRESS && env.EXPO_PUBLIC_NPL_BSC_ADDRESS.toLowerCase() !== DEFAULT_BSC_NPL) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${DEFAULT_BSC_NPL} on BSC`);
}
const nplAddress = DEFAULT_BSC_NPL;
const escrowAddress = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const rewardLedgerAddress = requireAddress(
  env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS,
  'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS'
);
const maxGasPriceWei = requirePositiveUint(env.SECKILL_MAX_GAS_PRICE_WEI, 'SECKILL_MAX_GAS_PRICE_WEI');

run('forge', ['build']);
const artifact = JSON.parse(readFileSync('out/Abu24KSeckill.sol/Abu24KSeckill.json'));
const bytecode = typeof artifact.bytecode === 'object' ? artifact.bytecode.object : artifact.bytecode;
const factory = new ContractFactory(artifact.abi, bytecode, signer);
const deployTx = await factory.getDeployTransaction(nplAddress, escrowAddress, rewardLedgerAddress, deployer);
const estimatedGas = await signer.estimateGas(deployTx);
const feeData = await provider.getFeeData();
const maxFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGasWei) throw new Error('Could not read gas price from RPC');

assertTxBudget({
  env,
  operation: 'deploy Abu24KSeckill',
  functionCall: 'constructor(address npl,address escrow,address rewardLedger,address initialOwner)',
  target: 'CREATE',
  valueWei: 0n,
  estimatedGas,
  maxFeePerGasWei,
  expectedResult: 'seckill contract deployed with transparent pause/forceClose controls and tx.origin caller block',
});

console.log('=== Deploy Abu24KSeckill ===');
console.log(`chain: ${chain.key} (${chain.chainId})`);
console.log(`deployer: ${deployer}`);
console.log(`owner: ${owner}`);
console.log(`npl: ${nplAddress}`);
console.log(`escrow: ${escrowAddress}`);
console.log(`reward ledger: ${rewardLedgerAddress}`);
console.log(`estimated gas: ${estimatedGas}`);
console.log(`estimated max gas cost: ${weiToNativeString(estimatedGas * maxFeePerGasWei)} ${chain.native}`);

const contract = await factory.deploy(nplAddress, escrowAddress, rewardLedgerAddress, deployer);
const tx = contract.deploymentTransaction();
if (!tx) throw new Error('Deployment transaction was not created');
console.log(`deploy tx: ${tx.hash}`);

const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
const receipt = await tx.wait(confirmations);
if (!receipt || receipt.status !== 1) throw new Error(`Deployment failed or receipt missing for tx ${tx.hash}`);
const address = await contract.getAddress();
const gasPriceWei = receipt.gasPrice ?? maxFeePerGasWei;
const costWei = receipt.gasUsed * gasPriceWei;

appendTxLog({
  operation: 'deploy Abu24KSeckill',
  functionCall: 'constructor(address npl,address escrow,address rewardLedger,address initialOwner)',
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
  operation: 'authorize Seckill as RewardLedger operator',
  functionCall: 'Abu24KRewardLedger.setOperator(address,bool)',
  method: 'setOperator',
  args: [address, true],
  maxFeePerGasWei,
});

const gasPriceGuard = await guardedCall({
  contract,
  target: address,
  operation: 'configure Seckill max gas price',
  functionCall: 'Abu24KSeckill.setMaxGasPriceWei(uint256)',
  method: 'setMaxGasPriceWei',
  args: [maxGasPriceWei],
  maxFeePerGasWei,
});

let ledgerTransferOwnershipTxHash = '';
if (finalLedgerOwner.toLowerCase() !== deployer.toLowerCase()) {
  const ledgerOwnership = await guardedCall({
    contract: ledger,
    target: rewardLedgerAddress,
    operation: 'transfer RewardLedger ownership after operator configuration',
    functionCall: 'Abu24KRewardLedger.transferOwnership(address)',
    method: 'transferOwnership',
    args: [finalLedgerOwner],
    maxFeePerGasWei,
  });
  ledgerTransferOwnershipTxHash = ledgerOwnership.txHash;
}

let transferOwnershipTxHash = '';
if (owner.toLowerCase() !== deployer.toLowerCase()) {
  const ownership = await guardedCall({
    contract,
    target: address,
    operation: 'transfer Seckill ownership',
    functionCall: 'Abu24KSeckill.transferOwnership(address)',
    method: 'transferOwnership',
    args: [owner],
    maxFeePerGasWei,
  });
  transferOwnershipTxHash = ownership.txHash;
}
if (!(await ledger.operators(address))) throw new Error('Seckill RewardLedger operator authorization was not recorded');

fs.mkdirSync('deployments', { recursive: true });
const deployment = {
  contractName: 'Abu24KSeckill',
  address,
  txHash: tx.hash,
  chain: chain.key,
  chainId: chain.chainId,
  nplAddress,
  escrowAddress,
  rewardLedgerAddress,
  rewardLedgerOwner: finalLedgerOwner,
  owner,
  deployer,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  gasPriceWei: gasPriceWei.toString(),
  nativeCost: weiToNativeString(costWei),
  setLedgerOperatorTxHash: ledgerOperator.txHash,
  setMaxGasPriceTxHash: gasPriceGuard.txHash,
  maxGasPriceWei: maxGasPriceWei.toString(),
  ledgerTransferOwnershipTxHash,
  transferOwnershipTxHash,
  callerRule: 'tx.origin == msg.sender',
  circuitBreakers: ['pause', 'unpause', 'forceClose'],
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(deployment, null, 2)}\n`);

if (WRITE_ENV) {
  updateEnvFile('.env', {
    EXPO_PUBLIC_SECKILL_ADDRESS: address,
    SECKILL_ADDRESS: address,
    SECKILL_OWNER_ADDRESS: owner,
    SECKILL_FROM_BLOCK: String(receipt.blockNumber),
  });
}

console.log('deploy seckill: PASS');
console.log(`wrote ${DEPLOYMENT_PATH}`);
console.log(`EXPO_PUBLIC_SECKILL_ADDRESS=${address}`);
console.log(`SECKILL_FROM_BLOCK=${receipt.blockNumber}`);
if (!WRITE_ENV) console.log('提示：需要自动写入 .env 时，用 pnpm deploy:seckill -- --write-env。');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
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

function normalizePrivateKey(value) {
  const key = String(value || '').trim();
  const hex = key.startsWith('0x') ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('PRIVATE_KEY must be a 32-byte hex key. It will not be printed.');
  return `0x${hex}`;
}

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function requireSafeOwner(value, name) {
  const address = requireAddress(value, name);
  const lower = address.toLowerCase();
  if (lower === ZERO.toLowerCase() || lower === DEAD.toLowerCase()) throw new Error('Seckill owner cannot be zero/dead address');
  return address;
}

function requirePositiveUint(value, name) {
  const text = String(value || '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive integer in wei`);
  return BigInt(text);
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
  console.log('updated .env with Seckill address and from-block');
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`deploy seckill refused: ${message}`);
  process.exit(1);
}

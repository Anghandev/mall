#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { readEnvFile, requireEnv, targetChain } from '../microtest/env-utils.mjs';
import { appendTxLog, assertTxBudget, weiToNativeString } from '../microtest/tx-guard.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const DEPLOYMENT_PATH = 'deployments/rewards-mainnet-micro-test.json';
const WRITE_ENV = process.argv.includes('--write-env') || process.env.WRITE_ENV_REWARDS === '1';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
if (chain.key !== 'bsc') throw new Error('24K rewards deployment is BSC-only. Set TARGET_CHAIN=bsc.');
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

const signer = new NonceManager(new Wallet(normalizePrivateKey(env.PRIVATE_KEY), provider));
const deployer = await signer.getAddress();
const initialOwner = deployer;
const finalOwner = requireSafeOwner(env.REWARDS_OWNER_ADDRESS, 'REWARDS_OWNER_ADDRESS');
if ((await provider.getCode(finalOwner)) === '0x') throw new Error('REWARDS_OWNER_ADDRESS must be a deployed multisig contract');
if (env.EXPO_PUBLIC_NPL_BSC_ADDRESS && env.EXPO_PUBLIC_NPL_BSC_ADDRESS.toLowerCase() !== DEFAULT_BSC_NPL.toLowerCase()) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${DEFAULT_BSC_NPL} on BSC`);
}
const nplAddress = DEFAULT_BSC_NPL;
if ((await provider.getCode(nplAddress)) === '0x') throw new Error(`No NPL contract code at ${nplAddress}`);

run('forge', ['build']);
const feeData = await provider.getFeeData();
const maxFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGasWei) throw new Error('Could not read gas price from RPC');

console.log('=== Deploy 24K BNMToken + Abu24KRewardLedger ===');
console.log(`chain: ${chain.key} (${chain.chainId})`);
console.log(`deployer: ${deployer}`);
console.log(`initial owner: ${initialOwner}`);
console.log(`BNM final owner: ${finalOwner}`);
console.log(`RewardLedger owner until Seckill setup: ${deployer}`);
console.log(`RewardLedger final owner after Seckill setup: ${finalOwner}`);

const bnm = await guardedDeploy({
  artifactPath: 'out/BNMToken.sol/BNMToken.json',
  contractName: 'BNMToken',
  args: [initialOwner],
  functionCall: 'constructor(address initialOwner)',
  maxFeePerGasWei,
});
const bnmAddress = await bnm.contract.getAddress();

const ledger = await guardedDeploy({
  artifactPath: 'out/Abu24KRewardLedger.sol/Abu24KRewardLedger.json',
  contractName: 'Abu24KRewardLedger',
  args: [bnmAddress, nplAddress, initialOwner],
  functionCall: 'constructor(address bnm,address npl,address owner)',
  maxFeePerGasWei,
});
const rewardLedgerAddress = await ledger.contract.getAddress();

const setMinterTxReq = await bnm.contract.setMinter.populateTransaction(rewardLedgerAddress, true);
const setMinterGas = await signer.estimateGas({ ...setMinterTxReq, to: bnmAddress });
assertTxBudget({
  env,
  operation: 'set RewardLedger as BNM minter',
  functionCall: 'BNMToken.setMinter(address,bool)',
  target: bnmAddress,
  valueWei: 0n,
  estimatedGas: setMinterGas,
  maxFeePerGasWei,
  expectedResult: 'RewardLedger can mint BNM on claim',
});
const setMinterTx = await bnm.contract.setMinter(rewardLedgerAddress, true);
console.log(`setMinter tx: ${setMinterTx.hash}`);
const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
const setMinterReceipt = await setMinterTx.wait(confirmations);
if (!setMinterReceipt || setMinterReceipt.status !== 1) throw new Error(`setMinter failed or receipt missing for tx ${setMinterTx.hash}`);
const setMinterGasPriceWei = setMinterReceipt.gasPrice ?? maxFeePerGasWei;
appendTxLog({
  operation: 'set RewardLedger as BNM minter',
  functionCall: 'BNMToken.setMinter(address,bool)',
  target: bnmAddress,
  value: '0',
  estimatedGas: setMinterGas.toString(),
  gasUsed: setMinterReceipt.gasUsed.toString(),
  maxFeePerGasWei: maxFeePerGasWei.toString(),
  gasPriceWei: setMinterGasPriceWei.toString(),
  costWei: (setMinterReceipt.gasUsed * setMinterGasPriceWei).toString(),
  hash: setMinterTx.hash,
  result: 'success',
});

let bnmTransferOwnershipTxHash = '';
if (finalOwner.toLowerCase() !== deployer.toLowerCase()) {
  const bnmTransfer = await guardedCall({
    contract: bnm.contract,
    target: bnmAddress,
    operation: 'transfer BNM ownership',
    functionCall: 'BNMToken.transferOwnership(address)',
    method: 'transferOwnership',
    args: [finalOwner],
    maxFeePerGasWei,
  });
  bnmTransferOwnershipTxHash = bnmTransfer.txHash;
}

const [
  configuredBnmOwner,
  configuredBnmPaused,
  configuredLedgerMinter,
  configuredLedgerOwner,
  configuredLedgerPaused,
  configuredLedgerBnm,
  configuredLedgerNpl,
] = await Promise.all([
  bnm.contract.owner(),
  bnm.contract.paused(),
  bnm.contract.minters(rewardLedgerAddress),
  ledger.contract.owner(),
  ledger.contract.paused(),
  ledger.contract.bnm(),
  ledger.contract.npl(),
]);
if (configuredBnmOwner.toLowerCase() !== finalOwner.toLowerCase()) {
  throw new Error(`BNM final owner mismatch: ${configuredBnmOwner} !== ${finalOwner}`);
}
if (configuredBnmPaused) throw new Error('BNM is paused after deployment');
if (!configuredLedgerMinter) throw new Error('RewardLedger BNM minter authorization was not recorded');
if (configuredLedgerOwner.toLowerCase() !== deployer.toLowerCase()) {
  throw new Error(`RewardLedger setup owner mismatch: ${configuredLedgerOwner} !== ${deployer}`);
}
if (configuredLedgerPaused) throw new Error('RewardLedger is paused after deployment');
if (configuredLedgerBnm.toLowerCase() !== bnmAddress.toLowerCase()) {
  throw new Error(`RewardLedger BNM mismatch: ${configuredLedgerBnm} !== ${bnmAddress}`);
}
if (configuredLedgerNpl.toLowerCase() !== nplAddress) {
  throw new Error(`RewardLedger NPL mismatch: ${configuredLedgerNpl} !== ${nplAddress}`);
}

fs.mkdirSync('deployments', { recursive: true });
const deployment = {
  contractGroup: '24K Rewards',
  chain: chain.key,
  chainId: chain.chainId,
  deployer,
  initialOwner,
  bnmOwner: finalOwner,
  rewardLedgerOwner: deployer,
  intendedRewardLedgerOwner: finalOwner,
  bnmAddress,
  nplAddress,
  rewardLedgerAddress,
  bnmTxHash: bnm.txHash,
  rewardLedgerTxHash: ledger.txHash,
  setMinterTxHash: setMinterTx.hash,
  bnmTransferOwnershipTxHash,
  rewardLedgerTransferOwnershipTxHash: '',
  rewardLedgerOwnershipDeferredUntilSeckill: true,
  fromBlock: Math.min(bnm.blockNumber, ledger.blockNumber, setMinterReceipt.blockNumber),
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(DEPLOYMENT_PATH, `${JSON.stringify(deployment, null, 2)}\n`);

if (WRITE_ENV) {
  updateEnvFile('.env', {
    EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
    EXPO_PUBLIC_NPL_BSC_ADDRESS: nplAddress,
    EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    REWARD_LEDGER_FROM_BLOCK: String(deployment.fromBlock),
    REWARDS_OWNER_ADDRESS: finalOwner,
  });
}

console.log('deploy rewards: PASS');
console.log(`wrote ${DEPLOYMENT_PATH}`);
console.log(`EXPO_PUBLIC_BNM_BSC_ADDRESS=${bnmAddress}`);
console.log(`EXPO_PUBLIC_REWARD_LEDGER_ADDRESS=${rewardLedgerAddress}`);
console.log(`REWARD_LEDGER_FROM_BLOCK=${deployment.fromBlock}`);
if (!WRITE_ENV) console.log('提示：需要自动写入 .env 时，用 pnpm deploy:rewards -- --write-env。');

async function guardedDeploy({ artifactPath, contractName, args, functionCall, maxFeePerGasWei }) {
  const artifact = JSON.parse(readFileSync(artifactPath));
  const bytecode = typeof artifact.bytecode === 'object' ? artifact.bytecode.object : artifact.bytecode;
  const factory = new ContractFactory(artifact.abi, bytecode, signer);
  const deployTx = await factory.getDeployTransaction(...args);
  const estimatedGas = await signer.estimateGas(deployTx);
  assertTxBudget({
    env,
    operation: `deploy ${contractName}`,
    functionCall,
    target: 'CREATE',
    valueWei: 0n,
    estimatedGas,
    maxFeePerGasWei,
    expectedResult: `${contractName} deployed`,
  });
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${contractName} deployment transaction was not created`);
  console.log(`${contractName} deploy tx: ${tx.hash}`);
  const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
  const receipt = await tx.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`${contractName} deployment failed or receipt missing for tx ${tx.hash}`);
  const address = await contract.getAddress();
  const gasPriceWei = receipt.gasPrice ?? maxFeePerGasWei;
  const costWei = receipt.gasUsed * gasPriceWei;
  appendTxLog({
    operation: `deploy ${contractName}`,
    functionCall,
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
  console.log(`${contractName}: ${address}`);
  console.log(`${contractName} gas: ${receipt.gasUsed} cost ${weiToNativeString(costWei)} ${chain.native}`);
  return { contract, txHash: tx.hash, blockNumber: receipt.blockNumber };
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
  const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
  const receipt = await tx.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`${operation} failed or receipt missing for tx ${tx.hash}`);
  const gasPriceWei = receipt.gasPrice ?? maxFeePerGasWei;
  const costWei = receipt.gasUsed * gasPriceWei;
  appendTxLog({
    operation,
    functionCall,
    target,
    value: '0',
    estimatedGas: estimatedGas.toString(),
    gasUsed: receipt.gasUsed.toString(),
    maxFeePerGasWei: maxFeePerGasWei.toString(),
    gasPriceWei: gasPriceWei.toString(),
    costWei: costWei.toString(),
    hash: tx.hash,
    result: 'success',
  });
  console.log(`${operation} gas: ${receipt.gasUsed} cost ${weiToNativeString(costWei)} ${chain.native}`);
  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
}

function readFileSync(file) {
  return fs.readFileSync(resolve(file), 'utf8');
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
  if (lower === ZERO.toLowerCase() || lower === DEAD.toLowerCase()) throw new Error('Rewards owner cannot be zero/dead address');
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
  console.log('updated .env with BNM and RewardLedger addresses');
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`deploy rewards refused: ${message}`);
  process.exit(1);
}

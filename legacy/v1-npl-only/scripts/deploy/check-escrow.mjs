#!/usr/bin/env node
import { Contract, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from '../microtest/env-utils.mjs';

const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
if (chain.key !== 'bsc') throw new Error('24K PaymentEscrow check is BSC-only. Set TARGET_CHAIN=bsc.');

const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
if (!rpcUrl) throw new Error(`Missing RPC URL: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);

const escrowAddress = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
if (env.EXPO_PUBLIC_NPL_BSC_ADDRESS && env.EXPO_PUBLIC_NPL_BSC_ADDRESS.toLowerCase() !== DEFAULT_BSC_NPL.toLowerCase()) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${DEFAULT_BSC_NPL} on BSC`);
}
const expectedOwner = requireAddress(env.ESCROW_OWNER_ADDRESS, 'ESCROW_OWNER_ADDRESS');
const expectedLedger = requireAddress(
  env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS,
  'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS'
);
const expectedOrderSigner = requireAddress(env.ORDER_SIGNER_ADDRESS, 'ORDER_SIGNER_ADDRESS');
const expectedSeller = requireAddress(
  env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS,
  'MERCHANT_RECEIVER_ADDRESS or EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS'
);
const expectedSplitVersion = requirePositiveInteger(env.ESCROW_SPLIT_VERSION, 'ESCROW_SPLIT_VERSION');

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const [network, code, nplCode] = await Promise.all([
  provider.getNetwork(),
  provider.getCode(escrowAddress),
  provider.getCode(DEFAULT_BSC_NPL),
]);
if (Number(network.chainId) !== chain.chainId) throw new Error(`RPC chainId ${network.chainId} does not match BSC ${chain.chainId}`);
if (!code || code === '0x') throw new Error(`No contract code at EXPO_PUBLIC_ESCROW_ADDRESS=${escrowAddress}`);
if (!nplCode || nplCode === '0x') throw new Error(`No NPL contract code at ${DEFAULT_BSC_NPL}`);

const escrow = new Contract(escrowAddress, [
  'function npl() view returns (address)',
  'function rewardLedger() view returns (address)',
  'function orderSigner() view returns (address)',
  'function currentSplitVersion() view returns (uint32)',
  'function approvedSellers(address) view returns (bool)',
  'function splitConfigs(uint32) view returns (address platformReceiver,address regionReceiver,address referralReceiver,address prizePoolReceiver,address burnReceiver,address circulationReceiver,uint16 merchantBps,uint16 platformBps,uint16 regionBps,uint16 referralBps,uint16 prizePoolBps,uint16 burnBps,uint16 circulationBps)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)'
], provider);

let npl;
let rewardLedger;
let orderSigner;
let currentSplitVersion;
let sellerApproved;
let splitConfig;
let owner;
let paused;
try {
  [npl, rewardLedger, orderSigner, currentSplitVersion, sellerApproved, splitConfig, owner, paused] = await Promise.all([
    escrow.npl(),
    escrow.rewardLedger(),
    escrow.orderSigner(),
    escrow.currentSplitVersion(),
    escrow.approvedSellers(expectedSeller),
    escrow.splitConfigs(expectedSplitVersion),
    escrow.owner(),
    escrow.paused()
  ]);
} catch (error) {
  throw new Error(`Configured escrow is not the NPL-only Abu24KPaymentEscrow: ${error instanceof Error ? error.message : String(error)}`);
}

if (npl.toLowerCase() !== DEFAULT_BSC_NPL.toLowerCase()) throw new Error(`Escrow NPL mismatch: ${npl} !== ${DEFAULT_BSC_NPL}`);
if (rewardLedger.toLowerCase() !== expectedLedger.toLowerCase()) throw new Error(`Escrow RewardLedger mismatch: ${rewardLedger} !== ${expectedLedger}`);
if (orderSigner.toLowerCase() !== expectedOrderSigner.toLowerCase()) throw new Error(`Escrow order signer mismatch: ${orderSigner} !== ${expectedOrderSigner}`);
if (owner.toLowerCase() !== expectedOwner.toLowerCase()) throw new Error(`Escrow owner mismatch: ${owner} !== ${expectedOwner}`);
if ((await provider.getCode(owner)) === '0x') throw new Error(`Escrow owner must be a deployed multisig contract, got EOA ${owner}`);
if (Number(currentSplitVersion) !== expectedSplitVersion) throw new Error(`Escrow split version mismatch: ${currentSplitVersion} !== ${expectedSplitVersion}`);
if (!sellerApproved) throw new Error(`Escrow seller is not approved: ${expectedSeller}`);
if (paused) throw new Error('Escrow is still paused after deployment configuration');
const splitTotal = ['merchantBps', 'platformBps', 'regionBps', 'referralBps', 'prizePoolBps', 'burnBps', 'circulationBps']
  .reduce((sum, key) => sum + Number(splitConfig[key]), 0);
if (splitTotal !== 10_000 || Number(splitConfig.merchantBps) === 0) throw new Error(`Escrow split config is invalid: total=${splitTotal}`);
const expectedBps = {
  merchantBps: Number(env.ESCROW_MERCHANT_BPS || 7000),
  platformBps: Number(env.ESCROW_PLATFORM_BPS || 1000),
  regionBps: Number(env.ESCROW_REGION_BPS || 500),
  referralBps: Number(env.ESCROW_REFERRAL_BPS || 500),
  prizePoolBps: Number(env.ESCROW_PRIZE_POOL_BPS || 500),
  burnBps: Number(env.ESCROW_BURN_BPS || 300),
  circulationBps: Number(env.ESCROW_CIRCULATION_BPS || 200)
};
for (const [key, expected] of Object.entries(expectedBps)) {
  if (Number(splitConfig[key]) !== expected) throw new Error(`Escrow ${key} mismatch: ${splitConfig[key]} !== ${expected}`);
}
for (const [key, { envName, bpsKey }] of Object.entries({
  platformReceiver: { envName: 'PLATFORM_RECEIVER_ADDRESS', bpsKey: 'platformBps' },
  regionReceiver: { envName: 'REGION_RECEIVER_ADDRESS', bpsKey: 'regionBps' },
  referralReceiver: { envName: 'REFERRAL_RECEIVER_ADDRESS', bpsKey: 'referralBps' },
  prizePoolReceiver: { envName: 'PRIZE_POOL_RECEIVER_ADDRESS', bpsKey: 'prizePoolBps' },
  burnReceiver: { envName: 'BURN_RECEIVER_ADDRESS', bpsKey: 'burnBps' },
  circulationReceiver: { envName: 'CIRCULATION_RECEIVER_ADDRESS', bpsKey: 'circulationBps' }
})) {
  const expected = expectedBps[bpsKey] > 0
    ? requireAddress(env[envName], envName)
    : String(env[envName] || '0x0000000000000000000000000000000000000000');
  if (!/^0x[0-9a-fA-F]{40}$/.test(expected)) throw new Error(`${envName} must be a valid EVM address`);
  if (splitConfig[key].toLowerCase() !== expected.toLowerCase()) throw new Error(`Escrow ${key} mismatch: ${splitConfig[key]} !== ${expected}`);
}

const ledger = new Contract(expectedLedger, ['function operators(address) view returns (bool)'], provider);
if (!(await ledger.operators(escrowAddress))) throw new Error('Escrow is not configured as a RewardLedger operator');

console.log('24K NPL-only escrow check: PASS');
console.log(`chain=${chain.key} (${chain.chainId})`);
console.log(`escrow=${escrowAddress}`);
console.log(`npl=${npl}`);
console.log(`rewardLedger=${rewardLedger}`);
console.log(`orderSigner=${orderSigner}`);
console.log(`seller=${expectedSeller}`);
console.log(`sellerApproved=${sellerApproved}`);
console.log(`splitVersion=${currentSplitVersion}`);
console.log(`splitBpsTotal=${splitTotal}`);
console.log(`owner=${owner}`);
console.log(`paused=${paused}`);

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return address;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

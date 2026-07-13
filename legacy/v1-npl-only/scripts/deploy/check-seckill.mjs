#!/usr/bin/env node
import { Contract, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from '../microtest/env-utils.mjs';

const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
if (chain.key !== 'bsc') throw new Error('24K Seckill check is BSC-only. Set TARGET_CHAIN=bsc.');

const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
if (!rpcUrl) throw new Error(`Missing RPC URL: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);

const seckillAddress = requireAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS, 'EXPO_PUBLIC_SECKILL_ADDRESS or SECKILL_ADDRESS');
const expectedEscrow = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const expectedLedger = requireAddress(
  env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS,
  'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS'
);
const expectedOwner = requireAddress(env.SECKILL_OWNER_ADDRESS, 'SECKILL_OWNER_ADDRESS');
const expectedMaxGasPriceWei = requirePositiveUint(env.SECKILL_MAX_GAS_PRICE_WEI, 'SECKILL_MAX_GAS_PRICE_WEI');
const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const [network, code, nplCode] = await Promise.all([
  provider.getNetwork(),
  provider.getCode(seckillAddress),
  provider.getCode(DEFAULT_BSC_NPL),
]);
if (Number(network.chainId) !== chain.chainId) throw new Error(`RPC chainId ${network.chainId} does not match BSC ${chain.chainId}`);
if (!code || code === '0x') throw new Error(`No contract code at EXPO_PUBLIC_SECKILL_ADDRESS=${seckillAddress}`);
if (!nplCode || nplCode === '0x') throw new Error(`No NPL contract code at ${DEFAULT_BSC_NPL}`);

const seckill = new Contract(seckillAddress, [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function nonce() view returns (uint256)',
  'function npl() view returns (address)',
  'function escrow() view returns (address)',
  'function rewardLedger() view returns (address)',
  'function maxGasPriceWei() view returns (uint256)',
  'function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)',
  'function sessions(bytes32) view returns (bytes32 productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint32 relayExtendSeconds,uint64 maxRelaySeconds,uint256 minimumNplAmount,uint256 prizePoolNpl,uint256 totalBuys,address lastBuyer,bytes32 winningOrderId,uint8 status)'
], provider);

let owner;
let paused;
let nonce;
let npl;
let escrow;
let rewardLedger;
let maxGasPriceWei;
try {
  [owner, paused, nonce, npl, escrow, rewardLedger, maxGasPriceWei] = await Promise.all([
    seckill.owner(),
    seckill.paused(),
    seckill.nonce(),
    seckill.npl(),
    seckill.escrow(),
    seckill.rewardLedger(),
    seckill.maxGasPriceWei()
  ]);
} catch (error) {
  throw new Error(`Configured seckill is not Abu24KSeckill or is missing 24K getters: ${error instanceof Error ? error.message : String(error)}`);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('Seckill owner is invalid');
if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
  throw new Error(`Seckill owner mismatch: ${owner} !== ${expectedOwner}`);
}
if ((await provider.getCode(owner)) === '0x') throw new Error(`Seckill owner must be a deployed multisig contract, got EOA ${owner}`);
if (npl.toLowerCase() !== DEFAULT_BSC_NPL) throw new Error(`Seckill NPL mismatch: ${npl} !== ${DEFAULT_BSC_NPL}`);
if (escrow.toLowerCase() !== expectedEscrow.toLowerCase()) throw new Error(`Seckill Escrow mismatch: ${escrow} !== ${expectedEscrow}`);
if (rewardLedger.toLowerCase() !== expectedLedger.toLowerCase()) throw new Error(`Seckill RewardLedger mismatch: ${rewardLedger} !== ${expectedLedger}`);
if (maxGasPriceWei !== expectedMaxGasPriceWei) throw new Error(`Seckill max gas price mismatch: ${maxGasPriceWei} !== ${expectedMaxGasPriceWei}`);
if (paused) throw new Error('Seckill is paused');
const ledger = new Contract(expectedLedger, [
  'function operators(address) view returns (bool)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)'
], provider);
const [seckillIsOperator, ledgerOwner, ledgerPaused] = await Promise.all([
  ledger.operators(seckillAddress),
  ledger.owner(),
  ledger.paused(),
]);
if (!seckillIsOperator) throw new Error('Seckill is not configured as a RewardLedger operator');
const expectedLedgerOwner = requireAddress(env.REWARDS_OWNER_ADDRESS, 'REWARDS_OWNER_ADDRESS');
if (ledgerOwner.toLowerCase() !== expectedLedgerOwner.toLowerCase()) {
  throw new Error(`RewardLedger final owner mismatch: ${ledgerOwner} !== ${expectedLedgerOwner}`);
}
if ((await provider.getCode(ledgerOwner)) === '0x') throw new Error(`RewardLedger owner must be a deployed multisig contract, got EOA ${ledgerOwner}`);
if (ledgerPaused) throw new Error('RewardLedger is paused');

console.log('24K seckill check: PASS');
console.log(`chain=${chain.key} (${chain.chainId})`);
console.log(`seckill=${seckillAddress}`);
console.log(`owner=${owner}`);
console.log(`npl=${npl}`);
console.log(`escrow=${escrow}`);
console.log(`rewardLedger=${rewardLedger}`);
console.log(`maxGasPriceWei=${maxGasPriceWei}`);
console.log(`rewardLedgerOwner=${ledgerOwner}`);
console.log(`rewardLedgerPaused=${ledgerPaused}`);
console.log(`paused=${paused}`);
console.log(`nonce=${nonce}`);
console.log('callerRule=tx.origin == msg.sender (validated by local Foundry tests; runtime getter check is read-only)');

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function requirePositiveUint(value, name) {
  const text = String(value || '').trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive integer in wei`);
  return BigInt(text);
}

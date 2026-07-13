#!/usr/bin/env node
import { Contract, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from '../microtest/env-utils.mjs';

const DEFAULT_BSC_NPL = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
if (chain.key !== 'bsc') throw new Error('24K Rewards check is BSC-only. Set TARGET_CHAIN=bsc.');

const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
if (!rpcUrl) throw new Error(`Missing RPC URL: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);

const bnmAddress = requireAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS, 'EXPO_PUBLIC_BNM_BSC_ADDRESS');
const rewardLedgerAddress = requireAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS, 'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS');
const expectedOwner = optionalAddress(env.REWARDS_OWNER_ADDRESS || env.DEV_WALLET, 'REWARDS_OWNER_ADDRESS or DEV_WALLET');
const escrowAddress = optionalAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const seckillAddress = optionalAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS, 'EXPO_PUBLIC_SECKILL_ADDRESS or SECKILL_ADDRESS');

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const [network, bnmCode, ledgerCode] = await Promise.all([
  provider.getNetwork(),
  provider.getCode(bnmAddress),
  provider.getCode(rewardLedgerAddress)
]);
if (Number(network.chainId) !== chain.chainId) throw new Error(`RPC chainId ${network.chainId} does not match BSC ${chain.chainId}`);
if (!bnmCode || bnmCode === '0x') throw new Error(`No contract code at EXPO_PUBLIC_BNM_BSC_ADDRESS=${bnmAddress}`);
if (!ledgerCode || ledgerCode === '0x') throw new Error(`No contract code at EXPO_PUBLIC_REWARD_LEDGER_ADDRESS=${rewardLedgerAddress}`);

const bnm = new Contract(bnmAddress, [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function minters(address) view returns (bool)'
], provider);
const ledger = new Contract(rewardLedgerAddress, [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function bnm() view returns (address)',
  'function npl() view returns (address)',
  'function nplReserved() view returns (uint256)',
  'function entryCount() view returns (uint256)',
  'function operators(address) view returns (bool)',
  'function setOperator(address,bool)',
  'function burnOrderRewards(bytes32) returns (uint256)'
], provider);

let name;
let symbol;
let decimals;
let bnmOwner;
let bnmPaused;
let ledgerIsMinter;
let ledgerOwner;
let ledgerPaused;
let ledgerBnm;
let ledgerNpl;
let nplReserved;
let entryCount;
let escrowIsOperator;
let seckillIsOperator;
try {
  [name, symbol, decimals, bnmOwner, bnmPaused, ledgerIsMinter, ledgerOwner, ledgerPaused, ledgerBnm, ledgerNpl, nplReserved, entryCount, escrowIsOperator, seckillIsOperator] = await Promise.all([
    bnm.name(),
    bnm.symbol(),
    bnm.decimals(),
    bnm.owner(),
    bnm.paused(),
    bnm.minters(rewardLedgerAddress),
    ledger.owner(),
    ledger.paused(),
    ledger.bnm(),
    ledger.npl(),
    ledger.nplReserved(),
    ledger.entryCount(),
    escrowAddress ? ledger.operators(escrowAddress) : null,
    seckillAddress ? ledger.operators(seckillAddress) : null
  ]);
} catch (error) {
  throw new Error(`Configured rewards contracts are not BNMToken + Abu24KRewardLedger or are missing 24K getters: ${error instanceof Error ? error.message : String(error)}`);
}

if (symbol !== 'BNM') throw new Error(`BNM symbol mismatch: ${symbol} !== BNM`);
if (String(name) !== '24K BNM Rebate') throw new Error(`BNM name mismatch: ${name} !== 24K BNM Rebate`);
if (Number(decimals) !== 18) throw new Error(`BNM decimals mismatch: ${decimals} !== 18`);
if (ledgerBnm.toLowerCase() !== bnmAddress.toLowerCase()) throw new Error(`RewardLedger.bnm mismatch: ${ledgerBnm} !== ${bnmAddress}`);
if (ledgerNpl.toLowerCase() !== DEFAULT_BSC_NPL.toLowerCase()) throw new Error(`RewardLedger.npl mismatch: ${ledgerNpl} !== ${DEFAULT_BSC_NPL}`);
if (!ledgerIsMinter) throw new Error('RewardLedger is not configured as a BNM minter');
if (escrowAddress && !escrowIsOperator) throw new Error('Escrow is not configured as a RewardLedger operator');
if (seckillAddress && !seckillIsOperator) throw new Error('Seckill is not configured as a RewardLedger operator');
if (!/^0x[0-9a-fA-F]{40}$/.test(bnmOwner)) throw new Error('BNM owner is invalid');
if (!/^0x[0-9a-fA-F]{40}$/.test(ledgerOwner)) throw new Error('RewardLedger owner is invalid');
if (expectedOwner) {
  if (bnmOwner.toLowerCase() !== expectedOwner.toLowerCase()) throw new Error(`BNM owner mismatch: ${bnmOwner} !== ${expectedOwner}`);
  if (ledgerOwner.toLowerCase() !== expectedOwner.toLowerCase()) throw new Error(`RewardLedger owner mismatch: ${ledgerOwner} !== ${expectedOwner}`);
}
if ((await provider.getCode(bnmOwner)) === '0x') throw new Error(`BNM owner must be a deployed multisig contract, got EOA ${bnmOwner}`);
if ((await provider.getCode(ledgerOwner)) === '0x') throw new Error(`RewardLedger owner must be a deployed multisig contract, got EOA ${ledgerOwner}`);

console.log('24K rewards check: PASS');
console.log(`chain=${chain.key} (${chain.chainId})`);
console.log(`bnm=${bnmAddress}`);
console.log(`rewardLedger=${rewardLedgerAddress}`);
console.log(`bnmName=${name}`);
console.log(`bnmSymbol=${symbol}`);
console.log(`bnmDecimals=${decimals}`);
console.log(`bnmOwner=${bnmOwner}`);
console.log(`bnmPaused=${bnmPaused}`);
console.log(`ledgerOwner=${ledgerOwner}`);
console.log(`ledgerPaused=${ledgerPaused}`);
console.log(`ledgerIsBnmMinter=${ledgerIsMinter}`);
console.log(`ledgerNpl=${ledgerNpl}`);
console.log(`nplReserved=${nplReserved}`);
console.log(`entryCount=${entryCount}`);
if (escrowAddress) console.log(`escrowOperator=${escrowIsOperator}`);
if (seckillAddress) console.log(`seckillOperator=${seckillIsOperator}`);

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function optionalAddress(value, name) {
  if (!value) return '';
  return requireAddress(value, name);
}

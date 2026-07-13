#!/usr/bin/env node
import { Contract, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from './env-utils.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const bnmAddress = requireAddress(env.EXPO_PUBLIC_BNM_BSC_ADDRESS, 'EXPO_PUBLIC_BNM_BSC_ADDRESS');
const rewardLedgerAddress = requireAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS, 'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS');
const escrowAddress = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const seckillAddress = requireAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS, 'EXPO_PUBLIC_SECKILL_ADDRESS or SECKILL_ADDRESS');

if (chain.key !== 'bsc' || chain.chainId !== 56) throw new Error('RewardLedger read-only check is BSC-only.');
if (String(env.CHAIN_ID || '') !== '56') throw new Error('CHAIN_ID must be 56.');
if (!rpcUrl) throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const bnm = new Contract(bnmAddress, [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
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

const [network, name, symbol, decimals, bnmPaused, ledgerIsMinter, owner, ledgerPaused, ledgerBnm, ledgerNpl, nplReserved, entryCount, escrowOperator, seckillOperator] = await Promise.all([
  provider.getNetwork(),
  bnm.name(),
  bnm.symbol(),
  bnm.decimals(),
  bnm.paused(),
  bnm.minters(rewardLedgerAddress),
  ledger.owner(),
  ledger.paused(),
  ledger.bnm(),
  ledger.npl(),
  ledger.nplReserved(),
  ledger.entryCount(),
  ledger.operators(escrowAddress),
  ledger.operators(seckillAddress)
]);

if (Number(network.chainId) !== 56) throw new Error(`RPC chainId ${network.chainId} does not match BSC 56.`);
if (name !== '24K BNM Rebate' || symbol !== 'BNM' || Number(decimals) !== 18) throw new Error(`Unexpected BNM metadata: ${name}/${symbol}/${decimals}`);
if (!isAddress(owner)) throw new Error(`RewardLedger owner is invalid: ${owner}`);
if (ledgerBnm.toLowerCase() !== bnmAddress.toLowerCase()) throw new Error(`RewardLedger.bnm mismatch: ${ledgerBnm} !== ${bnmAddress}`);
if (ledgerNpl.toLowerCase() !== fixedNpl) throw new Error(`RewardLedger.npl mismatch: ${ledgerNpl} !== ${fixedNpl}`);
if (!ledgerIsMinter) throw new Error('RewardLedger is not configured as a BNM minter.');
if (!escrowOperator || !seckillOperator) throw new Error(`RewardLedger operators are incomplete: escrow=${escrowOperator} seckill=${seckillOperator}`);

console.log(JSON.stringify({
  ok: true,
  mode: 'read-only',
  sendsTransactions: false,
  chainId: Number(network.chainId),
  bnmAddress,
  rewardLedgerAddress,
  nplAddress: ledgerNpl,
  owner,
  bnmPaused,
  ledgerPaused,
  nplReserved: nplReserved.toString(),
  entryCount: entryCount.toString(),
  escrowOperator,
  seckillOperator
}, null, 2));

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!isAddress(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reward-ledger read-only check refused: ${message}`);
  process.exit(1);
}

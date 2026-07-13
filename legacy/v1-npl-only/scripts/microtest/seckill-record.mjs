#!/usr/bin/env node
import { Contract, JsonRpcProvider } from 'ethers';
import { readEnvFile, targetChain } from './env-utils.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const seckillAddress = requireAddress(env.EXPO_PUBLIC_SECKILL_ADDRESS || env.SECKILL_ADDRESS, 'EXPO_PUBLIC_SECKILL_ADDRESS or SECKILL_ADDRESS');
const sessionId = optionalBytes32(env.MICRO_SECKILL_SESSION_ID, 'MICRO_SECKILL_SESSION_ID');

if (chain.key !== 'bsc' || chain.chainId !== 56) throw new Error('Seckill read-only check is BSC-only.');
if (String(env.CHAIN_ID || '') !== '56') throw new Error('CHAIN_ID must be 56.');
if (!rpcUrl) throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const seckill = new Contract(seckillAddress, [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function nonce() view returns (uint256)',
  'function npl() view returns (address)',
  'function escrow() view returns (address)',
  'function rewardLedger() view returns (address)',
  'function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)',
  'function sessions(bytes32) view returns (bytes32 productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint32 relayExtendSeconds,uint64 maxRelaySeconds,uint256 minimumNplAmount,uint256 prizePoolNpl,uint256 totalBuys,address lastBuyer,bytes32 winningOrderId,uint8 status)'
], provider);

const [network, owner, paused, nonce, npl, escrow, rewardLedger, session] = await Promise.all([
  provider.getNetwork(),
  seckill.owner(),
  seckill.paused(),
  seckill.nonce(),
  seckill.npl(),
  seckill.escrow(),
  seckill.rewardLedger(),
  sessionId ? seckill.sessions(sessionId) : null
]);

if (Number(network.chainId) !== 56) throw new Error(`RPC chainId ${network.chainId} does not match BSC 56.`);
if (!isAddress(owner)) throw new Error(`Seckill owner is invalid: ${owner}`);

console.log(JSON.stringify({
  ok: true,
  mode: 'read-only',
  sendsTransactions: false,
  chainId: Number(network.chainId),
  seckillAddress,
  owner,
  paused,
  nonce: nonce.toString(),
  npl,
  escrow,
  rewardLedger,
  session: session ? {
    sessionId,
    productId: session.productId,
    startsAt: Number(session.startsAt),
    mainEndsAt: Number(session.mainEndsAt),
    relayEndsAt: Number(session.relayEndsAt),
    minimumNplAmount: session.minimumNplAmount.toString(),
    prizePoolNpl: session.prizePoolNpl.toString(),
    totalBuys: session.totalBuys.toString(),
    lastBuyer: session.lastBuyer,
    winningOrderId: session.winningOrderId,
    status: Number(session.status)
  } : null
}, null, 2));

function requireAddress(value, name) {
  const address = String(value || '').trim();
  if (!isAddress(address)) throw new Error(`${name} must be a valid EVM address`);
  return address;
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function optionalBytes32(value, name) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error(`${name} must be bytes32`);
  return text;
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`seckill read-only check refused: ${message}`);
  process.exit(1);
}

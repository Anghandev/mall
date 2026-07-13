#!/usr/bin/env node
import crypto from 'node:crypto';
import { readEnvFile, requireEnv, targetChain, redact } from './env-utils.mjs';

const env = readEnvFile('.env');
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv];

console.log('=== Mainnet Micro-Test Preflight ===');
console.log(`target chain: ${chain.key} (${chain.chainId})`);
console.log(`native token: ${chain.native}`);
console.log(`explorer API key: ${redact(env.EXPLORER_API_KEY)}`);

requireEnv(env, ['TARGET_CHAIN', 'CHAIN_ID', chain.rpcEnv, 'PRIVATE_KEY', 'DEV_WALLET', 'MARKETING_WALLET', 'MICRO_TEST']);

if (env.MICRO_TEST !== 'true') {
  throw new Error('MICRO_TEST must be true for this workflow');
}

if (String(env.CHAIN_ID) !== String(chain.chainId)) {
  throw new Error(`CHAIN_ID=${env.CHAIN_ID} does not match TARGET_CHAIN=${chain.key} expected ${chain.chainId}`);
}

const actualChainId = await rpc(rpcUrl, 'eth_chainId', []);
const actualChainIdDecimal = Number.parseInt(actualChainId, 16);
if (actualChainIdDecimal !== chain.chainId) {
  throw new Error(`RPC chainId ${actualChainIdDecimal} does not match expected ${chain.chainId}`);
}

const walletAddress = await deriveAddress(env.PRIVATE_KEY);
const balanceHex = await rpc(rpcUrl, 'eth_getBalance', [walletAddress, 'latest']);
const balanceWei = BigInt(balanceHex);
const balanceNative = Number(balanceWei) / 1e18;

console.log(`deployer address: ${walletAddress}`);
console.log(`deployer balance: ${balanceNative.toFixed(8)} ${chain.native}`);
console.log(`DEV_WALLET: ${env.DEV_WALLET}`);
console.log(`MARKETING_WALLET: ${env.MARKETING_WALLET}`);
console.log(`max tx value: ${env.MAX_TX_VALUE_NATIVE || '0.0001'} ${chain.native}`);
console.log(`max total budget: ${env.MAX_TOTAL_BUDGET_NATIVE || '0.001'} ${chain.native}`);
console.log(`max gas cost per tx: ${env.MAX_GAS_COST_PER_TX_NATIVE || '0.0002'} ${chain.native}`);
console.log('preflight: PASS');

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} for ${method}`);
  }
  const json = await response.json();
  if (json.error) {
    throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function deriveAddress(privateKey) {
  let key = privateKey.trim();
  if (key.startsWith('0x')) key = key.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex key. It will not be printed.');
  }

  try {
    const { Wallet } = await import('ethers');
    return new Wallet(`0x${key}`).address;
  } catch {
    const pseudo = crypto.createHash('sha256').update(key).digest('hex');
    throw new Error(`Cannot derive wallet address because package "ethers" is not installed. Install project deps first. key-check=${pseudo.slice(0, 8)}`);
  }
}

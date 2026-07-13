#!/usr/bin/env node
import crypto from 'node:crypto';
import { readEnvFile, requireEnv, targetChain, redact } from './env-utils.mjs';

const env = readEnvFile('.env');
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

console.log('=== Mainnet Micro-Test Preflight ===');
console.log(`target chain: ${chain.key} (${chain.chainId})`);
console.log(`native token: ${chain.native}`);
console.log(`explorer API key: ${redact(env.EXPLORER_API_KEY)}`);

requireEnv(env, [
  'TARGET_CHAIN',
  'CHAIN_ID',
  'PRIVATE_KEY',
  'MICRO_TEST',
  'EXPO_PUBLIC_REOWN_PROJECT_ID',
  'INDEXER_SECRET',
  'ADMIN_SECRET',
  'ORDER_SIGNER_ADDRESS',
  'ESCROW_SPLIT_VERSION',
]);
if (!rpcUrl) {
  throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);
}
if (env.MICRO_TEST !== 'true') {
  throw new Error('MICRO_TEST must be true for this workflow');
}
if (String(env.EXPO_PUBLIC_NPL_BSC_ADDRESS || '').toLowerCase() !== fixedNpl) {
  throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed to ${fixedNpl}`);
}
assertMicroNplAmount(env.MICRO_SMOKE_NPL_AMOUNT || '0.000001', env.MAX_MICRO_NPL_AMOUNT || '0.001', 'MICRO_SMOKE_NPL_AMOUNT');
assertMicroNplAmount(env.MICRO_FUND_TX_NPL_AMOUNT || '0.000001', env.MAX_MICRO_NPL_AMOUNT || '0.001', 'MICRO_FUND_TX_NPL_AMOUNT');

if (String(env.CHAIN_ID) !== String(chain.chainId)) {
  throw new Error(`CHAIN_ID=${env.CHAIN_ID} does not match TARGET_CHAIN=${chain.key} expected ${chain.chainId}`);
}

const actualChainId = await rpc(rpcUrl, 'eth_chainId', []);
const actualChainIdDecimal = Number.parseInt(actualChainId, 16);
if (actualChainIdDecimal !== chain.chainId) {
  throw new Error(`RPC chainId ${actualChainIdDecimal} does not match expected ${chain.chainId}`);
}

const walletAddress = await deriveAddress(env.PRIVATE_KEY);
const devWallet = env.DEV_WALLET || walletAddress;
const marketingWallet = env.MARKETING_WALLET || walletAddress;
const merchantReceiver = env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS || walletAddress;
requireAddress(devWallet, 'DEV_WALLET');
requireAddress(marketingWallet, 'MARKETING_WALLET');
requireAddress(merchantReceiver, 'MERCHANT_RECEIVER_ADDRESS');
requireAddress(env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || env.REWARD_LEDGER_ADDRESS, 'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS or REWARD_LEDGER_ADDRESS');
requireAddress(env.ORDER_SIGNER_ADDRESS, 'ORDER_SIGNER_ADDRESS');
if (env.ORDER_SIGNER_ADDRESS.toLowerCase() !== walletAddress.toLowerCase()) {
  throw new Error('Micro payment PRIVATE_KEY must match ORDER_SIGNER_ADDRESS so the local HTTP signer can authorize test orders.');
}
if (!/^[1-9][0-9]*$/.test(String(env.ESCROW_SPLIT_VERSION)) || Number(env.ESCROW_SPLIT_VERSION) > 0xffffffff) {
  throw new Error('ESCROW_SPLIT_VERSION must be a positive uint32.');
}
const balanceHex = await rpc(rpcUrl, 'eth_getBalance', [walletAddress, 'latest']);
const balanceWei = BigInt(balanceHex);
const balanceNative = Number(balanceWei) / 1e18;

console.log(`deployer address: ${walletAddress}`);
console.log(`deployer balance: ${balanceNative.toFixed(8)} ${chain.native}`);
console.log(`DEV_WALLET: ${devWallet}${env.DEV_WALLET ? '' : ' (deployer fallback)'}`);
console.log(`MARKETING_WALLET: ${marketingWallet}${env.MARKETING_WALLET ? '' : ' (deployer fallback)'}`);
console.log(`MERCHANT_RECEIVER_ADDRESS: ${merchantReceiver}${env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS ? '' : ' (deployer fallback)'}`);
console.log(`ORDER_SIGNER_ADDRESS: ${env.ORDER_SIGNER_ADDRESS}`);
console.log(`ESCROW_SPLIT_VERSION: ${env.ESCROW_SPLIT_VERSION}`);
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

function requireAddress(value, name) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value || '').trim())) {
    throw new Error(`${name} must be a valid EVM address`);
  }
}

function assertMicroNplAmount(value, max, name) {
  const amount = decimal18(value, name);
  const maximum = decimal18(max, 'MAX_MICRO_NPL_AMOUNT');
  if (amount <= 0n || amount > maximum) throw new Error(`${name} must be greater than 0 and no more than ${max} NPL`);
}

function decimal18(value, name) {
  const text = String(value);
  if (!/^[0-9]+(\.[0-9]{0,18})?$/.test(text)) throw new Error(`${name} must be a decimal with at most 18 places`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0');
}

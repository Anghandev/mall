#!/usr/bin/env node
import crypto from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet, MaxUint256, formatUnits, parseUnits, toUtf8Bytes, keccak256 } from 'ethers';
import { readEnvFile, requireEnv, targetChain } from './env-utils.mjs';
import { appendTxLog, assertTxBudget, weiToNativeString } from './tx-guard.mjs';
import { startOrderSigner } from '../test-support/order-signer.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const escrowAddress = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const nplAddress = requireAddress(env.EXPO_PUBLIC_NPL_BSC_ADDRESS, 'EXPO_PUBLIC_NPL_BSC_ADDRESS');
const merchantReceiver = requireAddress(
  env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS,
  'MERCHANT_RECEIVER_ADDRESS or EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS'
);
const smokeAmountNpl = env.MICRO_SMOKE_NPL_AMOUNT || '0.000001';
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

if (chain.key !== 'bsc') throw new Error('NPL escrow smoke is BSC-only.');
if (nplAddress.toLowerCase() !== fixedNpl) throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be ${fixedNpl}`);
requireEnv(env, ['TARGET_CHAIN', 'CHAIN_ID', 'PRIVATE_KEY', 'MICRO_TEST']);
if (!rpcUrl) throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);
if (env.MICRO_TEST !== 'true') throw new Error('MICRO_TEST must be true for this workflow');

const provider = new JsonRpcProvider(rpcUrl, chain.chainId);
const signer = new Wallet(normalizePrivateKey(env.PRIVATE_KEY), provider);
const buyer = await signer.getAddress();
const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
const nplAmount = parseUnits(smokeAmountNpl, 18);
const maxMicroNplAmount = parseUnits(env.MAX_MICRO_NPL_AMOUNT || '0.001', 18);
if (nplAmount <= 0n || nplAmount > maxMicroNplAmount) throw new Error(`MICRO_SMOKE_NPL_AMOUNT must be greater than 0 and no more than ${env.MAX_MICRO_NPL_AMOUNT || '0.001'} NPL`);

const npl = new Contract(nplAddress, [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)'
], signer);
const escrow = new Contract(escrowAddress, [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function npl() view returns (address)',
  'function rewardLedger() view returns (address)',
  'function orderSigner() view returns (address)',
  'function currentSplitVersion() view returns (uint32)',
  'function approvedSellers(address) view returns (bool)',
  'function payOrder(bytes32,address,bytes32,uint256,uint256,uint64,bytes32,uint32,bytes)',
  'function forceRefund(bytes32,uint256)',
  'function orders(bytes32) view returns (address buyer,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,uint8 status)'
], signer);

const [network, owner, paused, escrowNpl, configuredOrderSigner, splitVersion, sellerApproved, nplBalance] = await Promise.all([
  provider.getNetwork(),
  escrow.owner(),
  escrow.paused(),
  escrow.npl(),
  escrow.orderSigner(),
  escrow.currentSplitVersion(),
  escrow.approvedSellers(merchantReceiver),
  npl.balanceOf(buyer)
]);
if (Number(network.chainId) !== chain.chainId) throw new Error(`RPC chainId ${network.chainId} does not match ${chain.chainId}`);
if (paused) throw new Error('Escrow is paused; refusing smoke test.');
if (owner.toLowerCase() !== buyer.toLowerCase()) {
  throw new Error('Smoke test needs PRIVATE_KEY to be the escrow owner so it can refund the test order.');
}
if (configuredOrderSigner.toLowerCase() !== buyer.toLowerCase()) {
  throw new Error(`Smoke test wallet must match Escrow.orderSigner: ${buyer} !== ${configuredOrderSigner}`);
}
if (splitVersion <= 0n) throw new Error('Escrow split version is not configured');
if (!sellerApproved) throw new Error(`Escrow seller is not approved: ${merchantReceiver}`);
if (escrowNpl.toLowerCase() !== nplAddress.toLowerCase()) throw new Error(`Escrow NPL mismatch: ${escrowNpl} !== ${nplAddress}`);
if (nplBalance < nplAmount) {
  throw new Error(`Insufficient NPL for smoke test. Need ${smokeAmountNpl}, current ${formatUnits(nplBalance, 18)}.`);
}

const orderId = keccak256(toUtf8Bytes(`24k-smoke:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`));
const orderDigest = keccak256(toUtf8Bytes(`micro-smoke:${smokeAmountNpl}`));
const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
const productId = keccak256(toUtf8Bytes(env.MICRO_TEST_PRODUCT_ID || 'p-24k-runner'));
const localOrderSigner = await startOrderSigner({ chainId: chain.chainId, escrowAddress, wallet: signer });
const authorization = await requestAuthorization(localOrderSigner, {
  orderId,
  buyer,
  seller: merchantReceiver,
  productId,
  nplAmount,
  bnmLocked: nplAmount,
  deadline,
  orderDigest,
  splitVersion
});
const feeData = await provider.getFeeData();
const maxFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGasWei) throw new Error('Could not read gas price from RPC');

console.log('=== Escrow Mainnet Smoke ===');
console.log(`chain: ${chain.key} (${chain.chainId})`);
console.log(`buyer/owner: ${buyer}`);
console.log(`merchant receiver: ${merchantReceiver}`);
console.log(`escrow: ${escrowAddress}`);
console.log(`amount: ${formatUnits(nplAmount, 18)} NPL`);

await sendGuardedTx({
  operation: 'approve NPL for smoke escrow',
  functionCall: 'approve(address,uint256)',
  target: nplAddress,
  expectedResult: 'escrow unlimited NPL allowance set for docs allowance skip',
  build: () => npl.approve.populateTransaction(escrowAddress, MaxUint256),
});
if (await npl.allowance(buyer, escrowAddress) !== MaxUint256) throw new Error('NPL MaxUint256 approval was not recorded.');

await sendGuardedTx({
  operation: 'pay smoke order',
  functionCall: 'payOrder(bytes32,address,bytes32,uint256,uint256,uint64,bytes32,uint32,bytes)',
  target: escrowAddress,
  expectedResult: 'micro order paid into 24K escrow',
  build: () => escrow.payOrder.populateTransaction(orderId, merchantReceiver, productId, nplAmount, nplAmount, deadline, orderDigest, splitVersion, authorization),
});

const funded = await escrow.orders(orderId);
if (funded.status !== 1n && Number(funded.status) !== 1) throw new Error('Smoke order was not PaidLocked after payOrder.');
if (funded.nplAmount !== nplAmount || funded.bnmLocked !== nplAmount) throw new Error('Smoke order NPL/BNM amount mismatch after payOrder.');

await sendGuardedTx({
  operation: 'force-refund smoke order',
  functionCall: 'forceRefund(bytes32,uint256)',
  target: escrowAddress,
  expectedResult: 'micro order force-refunded to buyer',
  build: () => escrow.forceRefund.populateTransaction(orderId, nplAmount),
});

const refunded = await escrow.orders(orderId);
if (refunded.status !== 4n && Number(refunded.status) !== 4) throw new Error('Smoke order was not ForcedRefunded after forceRefund.');

console.log(`escrow smoke: PASS order=${orderId} npl=${formatUnits(nplAmount, 18)}`);
await localOrderSigner.close();

async function sendGuardedTx({ operation, functionCall, target, expectedResult, build }) {
  const request = await build();
  request.from = buyer;
  const estimatedGas = await signer.estimateGas(request);
  assertTxBudget({
    env,
    operation,
    functionCall,
    target,
    valueWei: BigInt(request.value || 0),
    estimatedGas,
    maxFeePerGasWei,
    expectedResult,
  });

  const tx = await signer.sendTransaction(request);
  console.log(`${operation} tx: ${tx.hash}`);
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
  console.log(`${operation}: PASS gas=${receipt.gasUsed} cost=${weiToNativeString(costWei)} ${chain.native}`);
}

async function requestAuthorization(localSigner, value) {
  const domain = { name: '24K Mall Escrow', version: '1', chainId: chain.chainId, verifyingContract: escrowAddress };
  const types = { OrderAuthorization: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'nplAmount', type: 'uint256' },
    { name: 'bnmLocked', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'orderDigest', type: 'bytes32' },
    { name: 'splitVersion', type: 'uint32' }
  ] };
  const response = await fetch(localSigner.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localSigner.token}` },
    body: JSON.stringify({ domain, types, primaryType: 'OrderAuthorization', value: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'bigint' ? entry.toString() : entry])) })
  });
  const body = await response.json();
  if (!response.ok || body.signer?.toLowerCase() !== buyer.toLowerCase() || !body.signature) throw new Error(`Local order signer failed: ${JSON.stringify(body)}`);
  return body.signature;
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

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`escrow smoke refused: ${message}`);
  process.exit(1);
}

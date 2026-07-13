#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Contract, JsonRpcProvider, Wallet, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { readEnvFile, requireEnv, targetChain } from './env-utils.mjs';
import { appendTxLog, assertTxBudget, weiToNativeString } from './tx-guard.mjs';
import { startOrderSigner } from '../test-support/order-signer.mjs';

process.on('uncaughtException', failCleanly);
process.on('unhandledRejection', failCleanly);

const env = { ...readEnvFile('.env'), ...process.env };
const chain = targetChain(env);
const rpcUrl = env[chain.rpcEnv] || env.EXPO_PUBLIC_BSC_RPC_URL;
const apiPort = Number(env.MICRO_FUND_TX_API_PORT || 8796);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const tempDir = mkdtempSync(join(tmpdir(), '24k-mainnet-fund-e2e-'));
const dbPath = resolve(tempDir, 'fund-tx.db');
const escrowAddress = requireAddress(env.EXPO_PUBLIC_ESCROW_ADDRESS, 'EXPO_PUBLIC_ESCROW_ADDRESS');
const nplAddress = requireAddress(env.EXPO_PUBLIC_NPL_BSC_ADDRESS, 'EXPO_PUBLIC_NPL_BSC_ADDRESS');
const merchantReceiver = requireAddress(
  env.MERCHANT_RECEIVER_ADDRESS || env.EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS,
  'MERCHANT_RECEIVER_ADDRESS or EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS'
);
const amountNpl = env.MICRO_FUND_TX_NPL_AMOUNT || '0.000001';
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';

if (chain.key !== 'bsc') throw new Error('NPL fund-tx micro e2e is BSC-only.');
if (nplAddress.toLowerCase() !== fixedNpl) throw new Error(`EXPO_PUBLIC_NPL_BSC_ADDRESS must be ${fixedNpl}`);
requireEnv(env, ['TARGET_CHAIN', 'CHAIN_ID', 'PRIVATE_KEY', 'MICRO_TEST', 'INDEXER_SECRET', 'ADMIN_SECRET']);
if (!rpcUrl) throw new Error(`Missing required env: ${chain.rpcEnv} or EXPO_PUBLIC_BSC_RPC_URL`);
if (env.MICRO_TEST !== 'true') throw new Error('MICRO_TEST must be true for this workflow');

rmSync(dbPath, { force: true });

const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { batchMaxCount: 1 });
const signer = new Wallet(normalizePrivateKey(env.PRIVATE_KEY), provider);
const buyer = await signer.getAddress();
const totalAmount = parseUnits(amountNpl, 18);
const maxMicroNplAmount = parseUnits(env.MAX_MICRO_NPL_AMOUNT || '0.001', 18);
if (totalAmount <= 0n || totalAmount > maxMicroNplAmount) throw new Error(`MICRO_FUND_TX_NPL_AMOUNT must be greater than 0 and no more than ${env.MAX_MICRO_NPL_AMOUNT || '0.001'} NPL`);
const confirmations = Math.max(1, Number(env.DEPLOY_CONFIRMATIONS || 1));
const feeData = await provider.getFeeData();
const maxFeePerGasWei = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGasWei) throw new Error('Could not read gas price from RPC');

const npl = new Contract(nplAddress, [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
], signer);
const escrow = new Contract(escrowAddress, [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function npl() view returns (address)',
  'function orderSigner() view returns (address)',
  'function currentSplitVersion() view returns (uint32)',
  'function approvedSellers(address) view returns (bool)',
  'function payOrder(bytes32,address,bytes32,uint256,uint256,uint64,bytes32,uint32,bytes)',
  'function forceRefund(bytes32,uint256)',
  'function orders(bytes32) view returns (address buyer,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,uint8 status)',
  'event OrderPaid(bytes32 indexed orderId,address indexed buyer,address indexed seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)',
  'event OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 retainedNpl,address indexed retainedNplReceiver,uint256 burnedRewards)'
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
if (paused) throw new Error('Escrow is paused; refusing fund-tx micro e2e.');
if (owner.toLowerCase() !== buyer.toLowerCase()) {
  throw new Error('fund-tx micro e2e needs PRIVATE_KEY to be the escrow owner so it can refund the test order.');
}
if (configuredOrderSigner.toLowerCase() !== buyer.toLowerCase()) {
  throw new Error(`fund-tx test wallet must match Escrow.orderSigner: ${buyer} !== ${configuredOrderSigner}`);
}
if (splitVersion <= 0n) throw new Error('Escrow split version is not configured');
if (!sellerApproved) throw new Error(`Escrow seller is not approved: ${merchantReceiver}`);
if (escrowNpl.toLowerCase() !== nplAddress.toLowerCase()) throw new Error(`Escrow NPL mismatch: ${escrowNpl} !== ${nplAddress}`);
if (nplBalance < totalAmount) {
  throw new Error(`Insufficient NPL for micro e2e. Need ${amountNpl}, current ${formatUnits(nplBalance, 18)}.`);
}

const children = [];
let localOrderSigner;
try {
  localOrderSigner = await startOrderSigner({ chainId: chain.chainId, escrowAddress, wallet: signer });
  const api = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      PRIVATE_KEY: '',
      PORT: String(apiPort),
      DB_PATH: dbPath,
      CHAIN_ID: String(chain.chainId),
      EXPO_PUBLIC_BSC_CHAIN_ID: String(chain.chainId),
      EXPO_PUBLIC_NPL_BSC_ADDRESS: nplAddress,
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      MERCHANT_RECEIVER_ADDRESS: merchantReceiver,
      EXPO_PUBLIC_MERCHANT_RECEIVER_ADDRESS: merchantReceiver,
      ...localOrderSigner.env,
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'false',
      CHAIN_EVENT_RPC_URL: rpcUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(api);
  await waitForHealth(apiUrl);
  setMicroProductPrice(dbPath, amountNpl, merchantReceiver);

  const order = await post(`${apiUrl}/api/orders`, {
    buyerAddress: buyer,
    idempotencyKey: `mainnet-fund-tx-e2e:${buyer}:${Date.now()}`,
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true, fulfillmentMode: 'delivery', addressId: 'addr-default', regionCode: '210211' }]
  }, {}, 201);
  if (order.status !== 'Draft') throw new Error(`Expected Draft order, got ${order.status}`);
  const orderNplAmount = parseUnits(order.amountNpl, 18);
  if (orderNplAmount !== totalAmount) {
    throw new Error(`Expected NPL total ${normalizeDecimal18(amountNpl)}, got ${order.amountNpl}`);
  }
  const paymentIntent = await get(`${apiUrl}/api/orders/${order.orderId}/payment-intent?buyerAddress=${buyer}`);
  if (paymentIntent.approvalPolicy?.type !== 'unlimited-npl' || paymentIntent.allowanceChecks?.length !== 1 || paymentIntent.approvalTransactions?.length !== 1) {
    throw new Error('Backend payment intent must contain one NPL allowance check and one MaxUint256 approval.');
  }
  const [approvalSpender, approvalAmount] = npl.interface.decodeFunctionData('approve', paymentIntent.approvalTransactions[0].data);
  if (String(approvalSpender).toLowerCase() !== escrowAddress.toLowerCase() || approvalAmount !== MaxUint256) throw new Error('Backend NPL approval calldata mismatch.');
  const [intentOrderId, intentSeller, intentProductId, intentNplAmount, intentBnmLocked, intentDeadline, intentDigest, intentSplitVersion, intentAuthorization] = escrow.interface.decodeFunctionData('payOrder', paymentIntent.payOrderTransaction.data);
  if (intentOrderId !== order.orderId || String(intentSeller).toLowerCase() !== merchantReceiver.toLowerCase() || !/^0x[0-9a-fA-F]{64}$/.test(intentProductId) || intentNplAmount !== orderNplAmount || intentBnmLocked !== parseUnits(order.bnmLocked, 18) || intentDeadline <= BigInt(Math.floor(Date.now() / 1000)) || intentDigest !== order.orderDigest || intentSplitVersion !== splitVersion || !/^0x[0-9a-fA-F]{130}$/.test(intentAuthorization)) {
    throw new Error('Backend signed 9-parameter payOrder calldata mismatch.');
  }

  console.log('=== Mainnet Fund-Tx Backend E2E ===');
  console.log(`chain: ${chain.key} (${chain.chainId})`);
  console.log(`buyer/owner: ${buyer}`);
  console.log(`merchant receiver: ${merchantReceiver}`);
  console.log(`escrow: ${escrowAddress}`);
  console.log(`backend order: ${order.orderId}`);
  console.log(`amount: ${order.amountNpl} NPL`);

  await sendGuardedTx({
    operation: 'approve NPL for backend fund-tx e2e',
    functionCall: 'approve(address,uint256)',
    target: nplAddress,
    expectedResult: 'escrow unlimited NPL allowance set for docs allowance skip',
    build: () => npl.approve.populateTransaction(escrowAddress, MaxUint256),
  });

  const fundReceipt = await sendGuardedTx({
    operation: 'fund backend e2e order',
    functionCall: 'payOrder(bytes32,address,bytes32,uint256,uint256,uint64,bytes32,uint32,bytes)',
    target: escrowAddress,
    expectedResult: 'backend e2e order funded into escrow',
    build: () => Promise.resolve({
      to: paymentIntent.payOrderTransaction.to,
      data: paymentIntent.payOrderTransaction.data,
      value: paymentIntent.payOrderTransaction.value
    }),
  });

  const submitted = await post(`${apiUrl}/api/orders/${order.orderId}/fund-tx`, {
    buyerAddress: buyer,
    txHash: fundReceipt.hash
  }, {}, 201);
  if (submitted.status !== 'PaidLocked') throw new Error(`Expected backend PaidLocked after fund-tx, got ${submitted.status}`);

  const duplicate = await post(`${apiUrl}/api/orders/${order.orderId}/fund-tx`, {
    buyerAddress: buyer,
    txHash: fundReceipt.hash
  }, {}, 200);
  if (duplicate.status !== 'PaidLocked') throw new Error(`Expected duplicate fund-tx to remain PaidLocked, got ${duplicate.status}`);

  const refundReceipt = await sendGuardedTx({
    operation: 'refund backend e2e order',
    functionCall: 'forceRefund(bytes32,uint256)',
    target: escrowAddress,
    expectedResult: 'backend e2e micro order refunded to buyer',
    build: () => escrow.forceRefund.populateTransaction(order.orderId, orderNplAmount),
  });

  const refundPayload = eventPayloadFromReceipt(refundReceipt, 'OrderForcedRefunded');
  const refunded = await post(`${apiUrl}/api/chain-events`, refundPayload, { 'x-indexer-secret': env.INDEXER_SECRET }, 201);
  if (refunded.order.status !== 'ForcedRefunded') throw new Error(`Expected backend ForcedRefunded after refund event, got ${refunded.order.status}`);

  console.log(`mainnet fund-tx e2e: PASS order=${order.orderId.slice(0, 10)}... npl=${order.amountNpl}`);
} finally {
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
  }
  if (localOrderSigner) await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

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
  return receipt;
}

function eventPayloadFromReceipt(receipt, eventName) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== escrowAddress.toLowerCase()) continue;
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name !== eventName) continue;
    const base = {
      eventName: parsed.name,
      chainId: chain.chainId,
      contractAddress: escrowAddress,
      orderId: parsed.args.orderId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      logIndex: log.index
    };
    if (eventName === 'OrderForcedRefunded') {
      return {
        ...base,
        buyer: parsed.args.buyer,
        refundedNplWei: parsed.args.refundedNpl.toString(),
        retainedNplWei: parsed.args.retainedNpl.toString(),
        retainedNplReceiver: parsed.args.retainedNplReceiver,
        amountWei: parsed.args.refundedNpl.toString(),
        amountNpl: formatUnits(parsed.args.refundedNpl, 18),
        retainedNpl: formatUnits(parsed.args.retainedNpl, 18),
        burnedRewards: Number(parsed.args.burnedRewards)
      };
    }
  }
  throw new Error(`${eventName} event not found in receipt`);
}

function setMicroProductPrice(file, priceNpl, sellerAddress) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('UPDATE products SET price_npl = ?, stock = ?, seller_address = ? WHERE id = ?').run(
      normalizeDecimal18(priceNpl),
      1,
      sellerAddress,
      'p-24k-runner'
    );
  } finally {
    db.close();
  }
}

async function waitForHealth(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`backend did not start at ${baseUrl}`);
}

async function post(url, payload, headers = {}, expectedStatus) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(`${url} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function get(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function normalizeDecimal18(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole || '0'}.${`${fraction}000000000000000000`.slice(0, 18)}`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failCleanly(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mainnet fund-tx e2e refused: ${message}`);
  process.exit(1);
}

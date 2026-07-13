#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Wallet } from 'ethers';
import { startOrderSigner } from './test-support/order-signer.mjs';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const legacySettlementAsset = ['US', 'DT'].join('');
const fixtureMode = process.argv.includes('--fixtures');
const port = Number(process.env.DAPP_CONTRACTS_PORT || 8832);
const baseUrl = process.env.DAPP_BASE_URL || `http://127.0.0.1:${port}`;
const shouldSpawn = fixtureMode && !process.env.DAPP_BASE_URL;
const outDir = process.env.DAPP_CONTRACTS_OUT_DIR || (fixtureMode ? 'test-artifacts/fixtures' : 'test-artifacts');
const tempDir = mkdtempSync(join(tmpdir(), '24k-dapp-contracts-export-'));
const dbPath = resolve(tempDir, 'export.db');
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();
let server;
let stderr = '';
let localOrderSigner;

if (!process.env.DAPP_BASE_URL && !fixtureMode) {
  throw new Error('DAPP_BASE_URL_REQUIRED: production contract exports must come from the deployed API; use --fixtures only for isolated local tests.');
}

if (shouldSpawn) {
  rmSync(dbPath, { force: true });
  const escrowAddress = process.env.EXPO_PUBLIC_ESCROW_ADDRESS || '0x2222222222222222222222222222222222222222';
  localOrderSigner = await startOrderSigner({ chainId: 56, escrowAddress });
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: dbPath,
      MICRO_TEST: 'false',
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      EXPO_PUBLIC_SECKILL_ADDRESS: process.env.EXPO_PUBLIC_SECKILL_ADDRESS || '0x3333333333333333333333333333333333333333',
      EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: process.env.EXPO_PUBLIC_REWARD_LEDGER_ADDRESS || '0x4444444444444444444444444444444444444444',
      EXPO_PUBLIC_BNM_BSC_ADDRESS: process.env.EXPO_PUBLIC_BNM_BSC_ADDRESS || '0x5555555555555555555555555555555555555555',
      EXPO_PUBLIC_NPL_BSC_ADDRESS: fixedNpl,
      MERCHANT_RECEIVER_ADDRESS: process.env.MERCHANT_RECEIVER_ADDRESS || merchantWallet.address,
      ...localOrderSigner.env,
      ADMIN_WALLET_ADDRESS: process.env.ADMIN_WALLET_ADDRESS || adminWallet.address,
      JWT_SECRET: process.env.JWT_SECRET || 'dapp-contracts-export-jwt',
      INDEXER_SECRET: process.env.INDEXER_SECRET || 'dapp-contracts-export-indexer',
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => { stderr += chunk; });
}

try {
  await waitForHealth();
  fs.mkdirSync(outDir, { recursive: true });
  const contracts = await getJson('/api/dapp/contracts.json');
  assert(contracts.version === '24k-dapp-contracts-v1', 'contracts version mismatch');
  assert(contracts.tokens?.npl?.fixedBscAddress?.toLowerCase() === fixedNpl, 'fixed NPL missing');
  assert(JSON.stringify(Object.keys(contracts.tokens || {}).sort()) === JSON.stringify(['bnm', 'npl']), 'contracts bundle must expose only NPL and BNM tokens');
  assert(contracts.humanReadableAbi?.erc20?.some((item) => item.includes('allowance')), 'ERC20 allowance ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)'), 'Escrow signed payOrder ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event OrderPaid(bytes32 indexed orderId,address indexed buyer,address indexed seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion)'), 'Escrow OrderPaid ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event OrderCompleted(bytes32 indexed orderId,address indexed seller,uint256 nplAmount,uint32 splitVersion)'), 'Escrow OrderCompleted ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event OrderForcedRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 retainedNpl,address indexed retainedNplReceiver,uint256 burnedRewards)'), 'Escrow forced refund ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event OrderEmergencyRefunded(bytes32 indexed orderId,address indexed buyer,uint256 refundedNpl,uint256 burnedRewards)'), 'Escrow emergency refund ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event SellerApprovalUpdated(address indexed seller,bool approved)'), 'Escrow SellerApprovalUpdated ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)'), 'Escrow SplitConfigUpdated ABI missing');
  assert(contracts.humanReadableAbi?.escrow?.includes('function forceRefund(bytes32 orderId,uint256 refundNplAmount)'), 'Escrow partial forceRefund ABI missing');
  assert(contracts.humanReadableAbi?.rewardLedger?.includes('function setOperator(address operator,bool enabled)') && contracts.humanReadableAbi.rewardLedger.includes('function burnOrderRewards(bytes32 orderId) returns (uint256 burnedCount)'), 'RewardLedger operator/burn ABI missing');
  assert(contracts.humanReadableAbi?.rewardLedger?.includes('event OperatorUpdated(address indexed operator,bool enabled)') && contracts.humanReadableAbi.rewardLedger.includes('event LockedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId)') && contracts.humanReadableAbi.rewardLedger.includes('event UnclaimedRewardBurned(uint256 indexed entryId,bytes32 indexed orderId,uint8 previousState)'), 'RewardLedger operator/burn events missing');
  assert(contracts.humanReadableAbi?.seckill?.includes('function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)'), 'Seckill startSession ABI missing');
  assert(contracts.humanReadableAbi?.seckill?.includes('function maxGasPriceWei() view returns (uint256)') && contracts.humanReadableAbi.seckill.includes('function setMaxGasPriceWei(uint256 newMaxGasPriceWei)') && contracts.humanReadableAbi.seckill.includes('event MaxGasPriceUpdated(uint256 previousMaxGasPriceWei,uint256 newMaxGasPriceWei)'), 'Seckill max gas circuit ABI missing');
  assert(contracts.humanReadableAbi?.seckill?.includes('event SessionStarted(bytes32 indexed sessionId,bytes32 indexed productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint256 minimumNplAmount,uint256 prizePoolNpl)') && contracts.humanReadableAbi.seckill.includes('event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)'), 'Seckill session/prize event ABI missing');
  assert(!JSON.stringify(contracts).toLowerCase().includes(legacySettlementAsset.toLowerCase()), 'contracts bundle must not contain the legacy settlement asset');
  const outFile = resolve(outDir, 'dapp-contracts.json');
  fs.writeFileSync(outFile, `${JSON.stringify(contracts, null, 2)}\n`);
  console.log('DApp contracts export: PASS');
  console.log(`source: ${baseUrl}`);
  console.log(`wrote ${outFile}`);
  console.log('PRIVATE_KEY included: false');
} finally {
  if (server) {
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  }
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  if (localOrderSigner) await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch {}
    if (stderr && /EADDRINUSE|Error:/i.test(stderr)) break;
    await sleep(100);
  }
  throw new Error(`DApp backend not reachable at ${baseUrl}\n${stderr}`);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json().catch(() => ({}));
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

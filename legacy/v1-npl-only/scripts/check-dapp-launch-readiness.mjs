#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { Wallet } from 'ethers';
import { startOrderSigner } from './test-support/order-signer.mjs';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const legacySettlementAsset = ['US', 'DT'].join('');
const port = Number(process.env.DAPP_LAUNCH_PORT || 8821);
const baseUrl = process.env.DAPP_BASE_URL || `http://127.0.0.1:${port}`;
const shouldSpawn = !process.env.DAPP_BASE_URL;
const tempDir = mkdtempSync(join(os.tmpdir(), '24k-dapp-launch-check-'));
const dbPath = resolve(tempDir, 'check.db');
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();
let server;
let stderr = '';
let localOrderSigner;

if (shouldSpawn) {
  rmSync(dbPath, { force: true });
  localOrderSigner = await startOrderSigner({ chainId: 56, escrowAddress: '0x2222222222222222222222222222222222222222' });
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: dbPath,
      MICRO_TEST: 'false',
      EXPO_PUBLIC_ESCROW_ADDRESS: '0x2222222222222222222222222222222222222222',
      EXPO_PUBLIC_SECKILL_ADDRESS: '0x3333333333333333333333333333333333333333',
      EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: '0x4444444444444444444444444444444444444444',
      EXPO_PUBLIC_BNM_BSC_ADDRESS: '0x5555555555555555555555555555555555555555',
      EXPO_PUBLIC_NPL_BSC_ADDRESS: fixedNpl,
      MERCHANT_RECEIVER_ADDRESS: merchantWallet.address,
      ...localOrderSigner.env,
      ADMIN_WALLET_ADDRESS: adminWallet.address,
      JWT_SECRET: 'dapp-launch-readiness-jwt',
      INDEXER_SECRET: 'dapp-launch-readiness-indexer',
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => { stderr += chunk; });
}

try {
  await waitForHealth();

  const wellKnown = await getJson('/.well-known/24k-dapp.json');
  const manifest = await getJson('/api/dapp/manifest');
  const integration = await getJson('/api/dapp/integration');
  const handoff = await getJson(`/api/dapp/handoff?address=${merchantWallet.address}`);
  const frontendBrief = await getText(`/api/dapp/frontend-brief.md?address=${merchantWallet.address}`);
  const launchKit = await getJson(`/api/dapp/launch-kit?address=${merchantWallet.address}`);
  const contracts = await getJson('/api/dapp/contracts.json');
  const readiness = await getJson('/api/dapp/readiness');
  const launchStatus = await getJson('/api/dapp/launch-status');
  const home = await getJson(`/api/dapp/home?address=${merchantWallet.address}`);
  const bootstrap = await getJson(`/api/dapp/bootstrap?address=${merchantWallet.address}`);
  const openapi = await getJson('/api/dapp/openapi.json');
  const types = await getText('/api/dapp/types.d.ts');
  const sdk = await getText('/api/dapp/sdk.ts');

  assert(JSON.stringify(wellKnown) === JSON.stringify(integration), 'well-known should mirror integration contract');
  assert(handoff.version === '24k-dapp-handoff-v1' && handoff.integration?.version === integration.version, 'handoff bundle should include integration contract');
  assert(frontendBrief.includes('24K DApp 前端线程任务提示词') && frontendBrief.includes('/api/dapp/handoff'), 'frontend brief should expose copy-paste instructions for the separate frontend thread');
  assert(launchKit.version === '24k-dapp-launch-kit-v1' && launchKit.qr?.data && launchKit.urls?.handoff, 'launch kit should expose wallet URL, QR payload and handoff URL');
  assert(launchKit.qr?.externalPng?.includes('create-qr-code') && launchKit.qr?.data.includes(merchantWallet.address), 'launch kit QR should encode address-bound launch URL');
  assert(launchKit.urls?.frontendBrief?.includes('/api/dapp/frontend-brief.md') && launchKit.urls?.launchStatus?.includes('/api/dapp/launch-status') && launchKit.urls?.home?.includes('/api/dapp/home'), 'launch kit should expose frontend brief, launch status and home URLs');
  assert(launchStatus.kind === '24k-dapp-launch-status' && launchStatus.localOk === true && Array.isArray(launchStatus.criticalPath), 'launch status should expose runtime strict gates and critical path');
  assert(home.version === '24k-dapp-home-v1' && home.tabs?.length === 4 && home.tabs?.some((tab) => tab.key === 'assets'), 'home should expose one-call four-tab DApp payload');
  assert(
    contracts.version === '24k-dapp-contracts-v1'
      && contracts.humanReadableAbi?.escrow?.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)')
      && contracts.humanReadableAbi.escrow.includes('function forceRefund(bytes32 orderId)')
      && contracts.humanReadableAbi.escrow.includes('event SellerApprovalUpdated(address indexed seller,bool approved)')
      && contracts.humanReadableAbi.escrow.includes('event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)')
      && contracts.humanReadableAbi?.rewardLedger?.includes('function setOperator(address operator,bool enabled)')
      && contracts.humanReadableAbi.rewardLedger.includes('function burnOrderRewards(bytes32 orderId) returns (uint256 burnedCount)')
      && contracts.humanReadableAbi?.seckill?.includes('function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)')
      && contracts.humanReadableAbi.seckill.includes('event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)'),
    'contracts bundle should expose current Escrow, RewardLedger and Seckill ABI'
  );
  assert(JSON.stringify(Object.keys(contracts.tokens || {}).sort()) === JSON.stringify(['bnm', 'npl']), 'contracts bundle should expose only NPL and BNM tokens');
  assert(readiness.ok === true && readiness.modules?.payment?.ready === true, `readiness should be launchable, blockers=${JSON.stringify(readiness.blockers)}`);
  assert(manifest.tokens?.npl?.toLowerCase() === fixedNpl, 'manifest must expose fixed NPL');
  assert(integration.tokens?.npl?.toLowerCase() === fixedNpl && integration.policies?.payment?.firstPaymentApproval === 'unlimited-npl' && integration.policies?.payment?.approvalAmount === 'MaxUint256', 'integration must expose fixed NPL and its MaxUint256 policy');
  assert(bootstrap.config?.nplAddress?.toLowerCase() === fixedNpl && bootstrap.endpoints?.openapi === '/api/dapp/openapi.json' && bootstrap.endpoints?.launchStatus === '/api/dapp/launch-status' && bootstrap.endpoints?.home === '/api/dapp/home', 'bootstrap must expose fixed NPL, OpenAPI, home and launch status endpoints');
  assert(bootstrap.endpoints?.sdk === '/api/dapp/sdk.ts' && bootstrap.endpoints?.frontendBrief === '/api/dapp/frontend-brief.md' && launchKit.urls?.sdk?.includes('/api/dapp/sdk.ts'), 'bootstrap and launch kit must expose SDK and frontend brief endpoints');
  assert(openapi.openapi === '3.1.0' && openapi.paths?.['/api/dapp/checkout-intent']?.post && openapi.paths?.['/api/dapp/sdk.ts']?.get && openapi.paths?.['/api/dapp/frontend-brief.md']?.get && openapi.paths?.['/api/dapp/launch-status']?.get && openapi.paths?.['/api/dapp/home']?.get, 'OpenAPI should expose checkout intent, SDK, frontend brief, home and launch status endpoints');
  assert(types.includes("export type AssetSymbol = 'NPL' | 'BNM';") && types.includes("type: 'unlimited-npl';") && types.includes('export interface PaymentIntent') && types.includes('export interface ClaimIntentResponse') && types.includes('export interface DappHomeResponse') && types.includes('export interface DappLaunchStatusResponse'), 'Type definitions should expose NPL/BNM wallet payment, claim, home and launch status contracts');
  assert(sdk.includes('create24kDappClient') && sdk.includes('fetchDappLaunchStatus') && sdk.includes('fetchDappHome') && sdk.includes('switchTo24kChain') && sdk.includes('pollFundingTxStatus') && sdk.includes('sendPaymentIntent') && sdk.includes('submitClaimRequest'), 'SDK should expose client, home, launch status, chain switch, wallet tx and polling helpers');
  assert(!`${types}\n${sdk}\n${JSON.stringify(openapi)}`.toLowerCase().includes(legacySettlementAsset.toLowerCase()), 'generated types, SDK and OpenAPI should accept only NPL/BNM settlement assets');
  assert(openapi.components?.schemas?.PaymentIntent?.properties?.approvalPolicy?.properties?.type?.const === 'unlimited-npl', 'OpenAPI should expose the NPL-only approval policy');

  const lanUrls = shouldSpawn ? lanAddresses().map((address) => `http://${address}:${port}`) : [];
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    lanUrls,
    discovery: `${baseUrl}/.well-known/24k-dapp.json`,
    launchKit: `${baseUrl}/api/dapp/launch-kit?address=<wallet>`,
    launchStatus: `${baseUrl}/api/dapp/launch-status`,
    home: `${baseUrl}/api/dapp/home?address=<wallet>`,
    frontendBrief: `${baseUrl}/api/dapp/frontend-brief.md?address=<wallet>`,
    contracts: `${baseUrl}/api/dapp/contracts.json`,
    qrData: launchKit.qr.data,
    handoff: `${baseUrl}/api/dapp/handoff?address=<wallet>`,
    bootstrap: `${baseUrl}/api/dapp/bootstrap?address=<wallet>`,
    openapi: `${baseUrl}/api/dapp/openapi.json`,
    types: `${baseUrl}/api/dapp/types.d.ts`,
    sdk: `${baseUrl}/api/dapp/sdk.ts`,
    fixedNpl,
    note: 'DApp launch readiness: PASS'
  }, null, 2));
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

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.text();
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${payload}`);
  return payload;
}

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('198.18.')) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

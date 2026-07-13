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
const port = Number(process.env.DAPP_HANDOFF_PORT || 8831);
const baseUrl = process.env.DAPP_BASE_URL || `http://127.0.0.1:${port}`;
const shouldSpawn = fixtureMode && !process.env.DAPP_BASE_URL;
const outDir = process.env.DAPP_HANDOFF_OUT_DIR || (fixtureMode ? 'test-artifacts/fixtures' : 'test-artifacts');
const tempDir = mkdtempSync(join(tmpdir(), '24k-dapp-handoff-export-'));
const dbPath = resolve(tempDir, 'handoff.db');
const buyerWallet = process.env.DAPP_SAMPLE_WALLET && /^0x[a-fA-F0-9]{40}$/.test(process.env.DAPP_SAMPLE_WALLET)
  ? { address: process.env.DAPP_SAMPLE_WALLET }
  : Wallet.createRandom();
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();

let server;
let stderr = '';
let localOrderSigner;

if (!process.env.DAPP_BASE_URL && !fixtureMode) {
  throw new Error('DAPP_BASE_URL_REQUIRED: production handoff exports must come from the deployed API; use --fixtures only for isolated local tests.');
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
      JWT_SECRET: process.env.JWT_SECRET || 'dapp-handoff-export-jwt',
      INDEXER_SECRET: process.env.INDEXER_SECRET || 'dapp-handoff-export-indexer',
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => { stderr += chunk; });
}

try {
  await waitForHealth();
  fs.mkdirSync(outDir, { recursive: true });

  const address = buyerWallet.address;
  const [launchKit, launchStatus, handoff, frontendBrief, integration, manifest, readiness, bootstrap, contracts, openapi, types, sdk] = await Promise.all([
    getJson(`/api/dapp/launch-kit?address=${address}`),
    getJson('/api/dapp/launch-status'),
    getJson(`/api/dapp/handoff?address=${address}`),
    getText(`/api/dapp/frontend-brief.md?address=${address}`),
    getJson('/api/dapp/integration'),
    getJson('/api/dapp/manifest'),
    getJson('/api/dapp/readiness'),
    getJson(`/api/dapp/bootstrap?address=${address}`),
    getJson('/api/dapp/contracts.json'),
    getJson('/api/dapp/openapi.json'),
    getText('/api/dapp/types.d.ts'),
    getText('/api/dapp/sdk.ts')
  ]);

  assert(launchKit.version === '24k-dapp-launch-kit-v1', 'launch-kit version mismatch');
  assert(launchStatus.kind === '24k-dapp-launch-status' && Array.isArray(launchStatus.criticalPath), 'launch-status shape mismatch');
  assert(handoff.version === '24k-dapp-handoff-v1', 'handoff version mismatch');
  assert(integration.tokens?.fixedBscNplAddress?.toLowerCase() === fixedNpl, 'fixed NPL missing from integration');
  assert(
    contracts.version === '24k-dapp-contracts-v1'
      && contracts.humanReadableAbi?.escrow?.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)')
      && contracts.humanReadableAbi.escrow.includes('function forceRefund(bytes32 orderId,uint256 refundNplAmount)')
      && contracts.humanReadableAbi.escrow.includes('event SellerApprovalUpdated(address indexed seller,bool approved)')
      && contracts.humanReadableAbi.escrow.includes('event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)')
      && contracts.humanReadableAbi?.rewardLedger?.includes('function setOperator(address operator,bool enabled)')
      && contracts.humanReadableAbi.rewardLedger.includes('function burnOrderRewards(bytes32 orderId) returns (uint256 burnedCount)')
      && contracts.humanReadableAbi?.seckill?.includes('function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)')
      && contracts.humanReadableAbi.seckill.includes('function maxGasPriceWei() view returns (uint256)')
      && contracts.humanReadableAbi.seckill.includes('function setMaxGasPriceWei(uint256 newMaxGasPriceWei)')
      && contracts.humanReadableAbi.seckill.includes('event MaxGasPriceUpdated(uint256 previousMaxGasPriceWei,uint256 newMaxGasPriceWei)')
      && contracts.humanReadableAbi.seckill.includes('event SessionStarted(bytes32 indexed sessionId,bytes32 indexed productId,uint64 startsAt,uint64 mainEndsAt,uint64 relayEndsAt,uint256 minimumNplAmount,uint256 prizePoolNpl)')
      && contracts.humanReadableAbi.seckill.includes('event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)'),
    'contracts bundle missing current Escrow, RewardLedger or Seckill ABI'
  );
  assert(JSON.stringify(Object.keys(contracts.tokens || {}).sort()) === JSON.stringify(['bnm', 'npl']), 'contracts bundle should expose only NPL and BNM tokens');
  assert(openapi.paths?.['/api/dapp/checkout-intent']?.post && openapi.paths?.['/api/dapp/launch-status']?.get, 'OpenAPI missing checkout intent or launch status');
  assert(types.includes("export type AssetSymbol = 'NPL' | 'BNM';") && types.includes("type: 'unlimited-npl';") && types.includes('export interface DappLaunchKitResponse') && types.includes('export interface DappLaunchStatusResponse'), 'types missing NPL/BNM asset policy or launch responses');
  assert(sdk.includes('export function create24kDappClient') && sdk.includes('fetchDappLaunchStatus') && sdk.includes('switchTo24kChain') && sdk.includes('createCheckoutIntent') && sdk.includes('sendPaymentIntent') && sdk.includes('submitClaimRequest'), 'sdk missing key DApp helpers');
  assert(openapi.components?.schemas?.PaymentIntent?.properties?.approvalPolicy?.properties?.type?.const === 'unlimited-npl', 'OpenAPI should expose the NPL-only approval policy');
  assert(!`${types}\n${sdk}\n${JSON.stringify(openapi)}\n${JSON.stringify(contracts)}`.toLowerCase().includes(legacySettlementAsset.toLowerCase()), 'generated contracts, types, SDK and OpenAPI must not expose the legacy settlement asset');
  assert(frontendBrief.includes('24K DApp 前端线程任务提示词') && frontendBrief.includes('/api/dapp/sdk.ts') && frontendBrief.includes(fixedNpl), 'frontend brief missing DApp prompt details');

  const bundle = {
    kind: '24k-dapp-frontend-handoff-bundle',
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: baseUrl,
    sampleWallet: address,
    fixedNpl,
    privateKeyPrinted: false,
    files: {
      bundle: `${outDir}/dapp-frontend-handoff.bundle.json`,
      launchKit: `${outDir}/dapp-launch-kit.json`,
      launchStatus: `${outDir}/dapp-launch-status.json`,
      handoff: `${outDir}/dapp-handoff.json`,
      integration: `${outDir}/dapp-integration.json`,
      manifest: `${outDir}/dapp-manifest.json`,
      readiness: `${outDir}/dapp-readiness.json`,
      bootstrap: `${outDir}/dapp-bootstrap.json`,
      contracts: `${outDir}/dapp-contracts.json`,
      openapi: `${outDir}/dapp-openapi.json`,
      types: `${outDir}/dapp-types.d.ts`,
      sdk: `${outDir}/dapp-sdk.ts`,
      frontendThreadPrompt: `${outDir}/dapp-frontend-thread-prompt.md`,
      markdown: `${outDir}/dapp-frontend-handoff.md`
    },
    launchKit,
    launchStatus,
    handoff,
    integration,
    manifest,
    readiness,
    bootstrap,
    contracts,
    openapi,
    types,
    sdk,
    frontendBrief
  };

  writeJson('dapp-frontend-handoff.bundle.json', bundle);
  writeJson('dapp-launch-kit.json', launchKit);
  writeJson('dapp-launch-status.json', launchStatus);
  writeJson('dapp-handoff.json', handoff);
  writeJson('dapp-integration.json', integration);
  writeJson('dapp-manifest.json', manifest);
  writeJson('dapp-readiness.json', readiness);
  writeJson('dapp-bootstrap.json', bootstrap);
  writeJson('dapp-contracts.json', contracts);
  writeJson('dapp-openapi.json', openapi);
  fs.writeFileSync(resolve(outDir, 'dapp-types.d.ts'), types);
  fs.writeFileSync(resolve(outDir, 'dapp-sdk.ts'), sdk);
  fs.writeFileSync(resolve(outDir, 'dapp-frontend-thread-prompt.md'), frontendBrief);
  fs.writeFileSync(resolve(outDir, 'dapp-frontend-handoff.md'), renderMarkdown({ address, launchKit, launchStatus, handoff, readiness }));

  console.log('DApp frontend handoff export: PASS');
  console.log(`source: ${baseUrl}`);
  console.log(`sample wallet: ${address}`);
  console.log(`wrote ${resolve(outDir, 'dapp-frontend-handoff.bundle.json')}`);
  console.log(`wrote ${resolve(outDir, 'dapp-launch-status.json')}`);
  console.log(`wrote ${resolve(outDir, 'dapp-types.d.ts')}`);
  console.log(`wrote ${resolve(outDir, 'dapp-sdk.ts')}`);
  console.log(`wrote ${resolve(outDir, 'dapp-frontend-thread-prompt.md')}`);
  console.log(`wrote ${resolve(outDir, 'dapp-frontend-handoff.md')}`);
} finally {
  if (server) {
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  }
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  if (localOrderSigner) await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function writeJson(name, value) {
  fs.writeFileSync(resolve(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
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

function renderMarkdown({ address, launchKit, launchStatus, handoff, readiness }) {
  return `# 24K DApp Frontend Handoff Export

- Generated at: ${new Date().toISOString()}
- Source base URL: ${baseUrl}
- Sample wallet: ${address}
- Readiness OK: ${readiness.ok ? 'yes' : 'no'}
- Strict launch OK: ${launchStatus.strictLaunchOk ? 'yes' : 'no'}
- Fixed NPL: ${fixedNpl}
- Private key printed: false

## Start Here

1. Read \`dapp-frontend-handoff.bundle.json\` for everything in one file.
2. Copy \`dapp-frontend-thread-prompt.md\` into the separate frontend Codex conversation.
3. Copy \`dapp-types.d.ts\` into the frontend project if needed.
4. Copy \`dapp-sdk.ts\` if the frontend wants ready-made fetch/wallet helpers.
5. Use the four tab state endpoints from the prompt: seckill-state / mall-state / stores-state / assets-state.
6. Use \`handoff.endpoints.checkoutIntent\`, \`seckillIntent\`, and \`claimIntent\` for wallet actions.
7. If working inside this repo, \`pnpm dapp:frontend-check\` validates tab states, final-check, checkout intent, fixed-NPL approvals, seckill intent, and claim intent without deploying or sending transactions.
8. Do not run QR, deploy, production env, micro-test, or chain transaction scripts in the frontend thread.

## Wallet Browser URL

\`\`\`txt
${launchKit.walletBrowserEntryUrl}
\`\`\`

## Required Policies

- Chain: BSC 56 / 0x38
- NPL: ${fixedNpl}
- Payment: NPL
- First payment: one NPL approve(MaxUint256), then allowance skip
- Refund: no user no-reason refund; platform force refund / 7-day timeout / emergency refund only
- Claim: personal_sign first, backend submit second, RewardLedger.claim(entryId) when available

## Main Endpoints

\`\`\`json
${JSON.stringify(handoff.endpoints, null, 2)}
\`\`\`
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Interface, Wallet } from 'ethers';
import { startOrderSigner } from './test-support/order-signer.mjs';

const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const legacySettlementAsset = ['US', 'DT'].join('');
const port = Number(process.env.DAPP_FRONTEND_CHECK_PORT || 8841);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = mkdtempSync(join(tmpdir(), '24k-dapp-frontend-check-'));
const dbPath = resolve(tempDir, 'check.db');
const outDir = process.env.DAPP_FRONTEND_CHECK_OUT_DIR || 'test-artifacts';
const reportFile = resolve(outDir, 'dapp-frontend-consumption.report.json');
const merchantWallet = Wallet.createRandom();
const merchantReceiver = merchantWallet.address;
const adminWallet = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const escrowAddress = '0x2222222222222222222222222222222222222222';
const seckillAddress = '0x3333333333333333333333333333333333333333';
const rewardLedgerAddress = '0x4444444444444444444444444444444444444444';
const bnmAddress = '0x5555555555555555555555555555555555555555';
const buyerWallet = Wallet.createRandom();
const buyerAddress = buyerWallet.address;
let defaultBuyerToken = '';

rmSync(dbPath, { force: true });
mkdirSync(outDir, { recursive: true });
const localOrderSigner = await startOrderSigner({ chainId: 56, escrowAddress });

const serverEnv = {
  ...process.env,
  PRIVATE_KEY: '',
  NODE_ENV: 'development',
  PORT: String(port),
  DB_PATH: dbPath,
  MICRO_TEST: 'false',
  DAPP_BASE_URL: baseUrl,
  DAPP_ENTRY_URL: baseUrl,
  EXPO_PUBLIC_API_BASE_URL: baseUrl,
  EXPO_PUBLIC_NPL_BSC_ADDRESS: fixedNpl,
  EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
  EXPO_PUBLIC_SECKILL_ADDRESS: seckillAddress,
  EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
  EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
  REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
  SECKILL_ADDRESS: seckillAddress,
  MERCHANT_RECEIVER_ADDRESS: merchantReceiver,
  ...localOrderSigner.env,
  ADMIN_WALLET_ADDRESS: adminWallet,
  JWT_SECRET: 'dapp-frontend-consumption-jwt',
  INDEXER_SECRET: 'dapp-frontend-consumption-indexer',
  ADMIN_SECRET: 'dapp-frontend-consumption-admin',
  CHAIN_EVENT_RPC_URL: '',
  BSC_RPC_URL: '',
  EXPO_PUBLIC_BSC_RPC_URL: '',
  ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true',
  EXPO_PUBLIC_REOWN_PROJECT_ID: process.env.EXPO_PUBLIC_REOWN_PROJECT_ID || 'test-reown-project-id'
};

let stderr = '';
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  await waitForHealth();
  const anonymousAssetsResponse = await fetch(`${baseUrl}/api/dapp/assets-state`);
  assert(anonymousAssetsResponse.status === 401, 'assets-state should require a buyer JWT');
  const buyerSession = await siweLogin(buyerWallet, 'buyer');
  defaultBuyerToken = buyerSession.token;
  const buyerHeaders = authHeaders(buyerSession.token);
  const merchantSession = await siweLogin(merchantWallet, 'merchant');
  await postJson('/api/merchant/stores', await withSecondary(merchantWallet, merchantSession.token, 'merchant.store.upsert', {
    storeId: 'store-dl-gaoxin',
    name: '24K 大连高新自提店',
    regionCode: '210211',
    city: '大连市'
  }), 201, authHeaders(merchantSession.token));

  const [readiness, bootstrap, handoff, openapi, types, sdk, frontendBrief, seckillState, mallState, storesState, assetsState] = await Promise.all([
    getJson('/api/dapp/readiness'),
    getJson('/api/dapp/bootstrap'),
    getJson('/api/dapp/handoff'),
    getJson('/api/dapp/openapi.json'),
    getText('/api/dapp/types.d.ts'),
    getText('/api/dapp/sdk.ts'),
    getText('/api/dapp/frontend-brief.md'),
    getJson('/api/dapp/seckill-state'),
    getJson('/api/dapp/mall-state'),
    getJson('/api/dapp/stores-state?lat=38.86&lng=121.52'),
    getJson(`/api/dapp/assets-state?address=${buyerAddress}`)
  ]);

  const bootstrapHasTabStates = bootstrap.endpoints?.seckillState === '/api/dapp/seckill-state?address=0x...'
    && bootstrap.endpoints?.mallState === '/api/dapp/mall-state?address=0x...'
    && bootstrap.endpoints?.storesState === '/api/dapp/stores-state?address=0x...&lat=38.86&lng=121.52'
    && bootstrap.endpoints?.assetsState === '/api/dapp/assets-state?address=0x...';
  const tabStatesFetch = {
    seckillState: seckillState.version === '24k-dapp-seckill-state-v1',
    mallState: mallState.version === '24k-dapp-mall-state-v1',
    storesState: storesState.version === '24k-dapp-stores-state-v1',
    assetsState: assetsState.version === '24k-dapp-assets-state-v1'
  };

  assert(readiness.ok === true, `readiness not ok: ${JSON.stringify(readiness.blockers)}`);
  assert(bootstrapHasTabStates, 'bootstrap missing four tab state endpoints');
  assert(handoff.frontendBrief?.includes('24K DApp 前端线程任务提示词'), 'handoff missing embedded frontend brief');
  assert(openapi.paths?.['/api/dapp/seckill-state']?.get
    && openapi.paths?.['/api/dapp/mall-state']?.get
    && openapi.paths?.['/api/dapp/stores-state']?.get
    && openapi.paths?.['/api/dapp/assets-state']?.get
    && openapi.paths?.['/api/dapp/sdk.ts']?.get, 'openapi missing tab-state or SDK paths');
  assert(['fetchDappSeckillState', 'fetchDappMallState', 'fetchDappStoresState', 'fetchDappAssetsState', 'sendPaymentIntent', 'submitClaimRequest'].every((marker) => sdk.includes(marker)), 'sdk missing frontend tab-state or wallet helpers');
  assert(types.includes("export type AssetSymbol = 'NPL' | 'BNM';"), 'types should accept only NPL and BNM assets');
  assert(!`${types}\n${sdk}\n${JSON.stringify(openapi)}`.toLowerCase().includes(legacySettlementAsset.toLowerCase()), 'generated types, SDK and OpenAPI should not expose the legacy settlement asset');
  assert(openapi.components?.schemas?.PaymentIntent?.properties?.approvalPolicy?.properties?.type?.const === 'unlimited-npl', 'OpenAPI should expose the NPL-only approval policy');
  assert(frontendBrief.includes('fetchDappAssetsState') && frontendBrief.includes(fixedNpl) && frontendBrief.includes('不要跑部署'), 'frontend brief missing tab-state or fixed NPL guidance');
  assert(!frontendBrief.includes('Launch kit / QR payload'), 'frontend brief should not steer frontend thread into Launch kit / QR payload work');
  assert(Object.values(tabStatesFetch).every(Boolean), `tab states returned unexpected versions: ${JSON.stringify(tabStatesFetch)}`);
  assert(assetsState.connectRequired === false && assetsState.connectedAddress?.toLowerCase() === buyerAddress.toLowerCase(), 'authenticated assets-state should bind the buyer wallet');

  const fulfillmentOptions = await getJson(`/api/dapp/fulfillment-options?address=${buyerAddress}&lat=38.86&lng=121.52&city=大连市&limit=2`);
  assert(fulfillmentOptions.version === '24k-fulfillment-options-v1'
    && fulfillmentOptions.checkoutTemplates?.delivery?.fulfillmentMode === 'delivery'
    && fulfillmentOptions.policy?.regionCodeLockedOnPayment === true, 'fulfillment-options should expose delivery template and region-lock policy');

  const addressPayload = {
    walletAddress: buyerAddress,
    name: 'DApp 前端消费检查',
    phone: '13800000001',
    province: '辽宁省',
    city: '大连市',
    district: '高新区',
    detail: '软件园路 24K 号',
    regionCode: '210211',
    isDefault: true
  };
  const anonymousAddressResponse = await fetch(`${baseUrl}/api/address-book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(addressPayload)
  });
  assert(anonymousAddressResponse.status === 401, 'address writes should require a buyer JWT');
  const savedAddress = await postJson('/api/address-book', await withSecondary(buyerWallet, buyerSession.token, 'buyer.address.upsert', addressPayload), 201, buyerHeaders);
  const pickupTemplate = fulfillmentOptions.checkoutTemplates?.pickup;
  assert(pickupTemplate?.fulfillmentMode === 'pickup' && pickupTemplate.storeId && pickupTemplate.regionCode, 'fulfillment-options should expose pickup checkout template');
  const pickupItem = {
    productId: 'p-24k-tea',
    quantity: 1,
    selected: true,
    fulfillmentMode: 'pickup',
    storeId: pickupTemplate.storeId,
    regionCode: pickupTemplate.regionCode
  };
  const pickupFinalCheck = await postJson('/api/dapp/final-check', {
    buyerAddress,
    idempotencyKey: `frontend-consumption:${buyerAddress}:pickup-final-check`,
    items: [pickupItem]
  });
  assert(pickupFinalCheck.ok === true
    && pickupFinalCheck.factors?.some((entry) => entry.label === '自提门店 / 行政区')
    && pickupFinalCheck.summary?.regionCodes?.includes(pickupTemplate.regionCode), 'pickup final-check should bind store region code');
  const pickupCheckoutIntent = await postJson('/api/dapp/checkout-intent', {
    buyerAddress,
    idempotencyKey: `frontend-consumption:${buyerAddress}:pickup-checkout`,
    items: [pickupItem]
  }, 201);
  assert(pickupCheckoutIntent.ok === true
    && pickupCheckoutIntent.preflight?.ok === true
    && pickupCheckoutIntent.finalCheck?.passed === true
    && pickupCheckoutIntent.paymentIntent?.allowanceChecks?.length === 1
    && pickupCheckoutIntent.paymentIntent?.approvalTransactions?.length === 1
    && pickupCheckoutIntent.paymentIntent?.payOrderTransaction?.data?.startsWith('0x'), 'pickup checkout-intent should expose final check and payment calldata');

  const checkoutItem = {
    productId: 'p-24k-bag',
    quantity: 1,
    selected: true,
    fulfillmentMode: 'delivery',
    addressId: savedAddress.id,
    regionCode: '210211'
  };
  const finalCheck = await postJson('/api/dapp/final-check', {
    buyerAddress,
    idempotencyKey: `frontend-consumption:${buyerAddress}:final-check`,
    items: [checkoutItem]
  });
  assert(finalCheck.ok === true
    && finalCheck.version === '24k-dapp-final-check-v1'
    && finalCheck.nextAction?.endpoint === '/api/dapp/checkout-intent'
    && finalCheck.factors?.some((entry) => entry.label === 'SKU / 数量'), 'final-check should expose docs five-factor checkout modal contract');

  const checkoutIntent = await postJson('/api/dapp/checkout-intent', {
    buyerAddress,
    idempotencyKey: `frontend-consumption:${buyerAddress}:checkout`,
    items: [checkoutItem]
  }, 201);
  assert(checkoutIntent.ok === true && checkoutIntent.preflight?.ok === true && checkoutIntent.finalCheck?.passed === true, 'checkout-intent should run stock preflight and final check');
  assert(checkoutIntent.paymentIntent?.approvalPolicy?.type === 'unlimited-npl'
    && checkoutIntent.paymentIntent?.approvalPolicy?.amount === 'MaxUint256'
    && checkoutIntent.paymentIntent?.allowanceChecks?.length === 1
    && checkoutIntent.paymentIntent?.approvalTransactions?.length === 1, 'checkout-intent should expose one NPL allowance check and one MaxUint256 approval');
  assert(checkoutIntent.paymentIntent?.approvalTransactions?.some((tx) => tx.symbol === 'NPL' && tx.to?.toLowerCase() === fixedNpl), 'checkout-intent should approve the fixed docs NPL contract');
  assert(checkoutIntent.paymentIntent?.payOrderTransaction?.to?.toLowerCase() === escrowAddress.toLowerCase()
    && typeof checkoutIntent.paymentIntent?.payOrderTransaction?.data === 'string'
    && checkoutIntent.paymentIntent.payOrderTransaction.data.startsWith('0x'), 'checkout-intent should expose payOrder wallet transaction calldata');
  const escrow = new Interface(['function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)']);
  const [payOrderId, paySeller, payProductId, payNplAmount, payBnmLocked, , payDigest, paySplitVersion, payAuthorization] = escrow.decodeFunctionData('payOrder', checkoutIntent.paymentIntent.payOrderTransaction.data);
  assert(payOrderId === checkoutIntent.order.orderId && paySeller.toLowerCase() === merchantReceiver.toLowerCase() && /^0x[0-9a-fA-F]{64}$/.test(payProductId), 'checkout-intent should bind order, seller and product');
  assert(payNplAmount === parseDecimal18(checkoutIntent.order.amountNpl) && payBnmLocked === parseDecimal18(checkoutIntent.order.bnmLocked) && payDigest === checkoutIntent.order.orderDigest, 'checkout-intent should bind NPL, BNM and digest');
  assert(paySplitVersion === 1n && /^0x[0-9a-fA-F]{130}$/.test(payAuthorization) && checkoutIntent.paymentIntent.payOrderTransaction.orderSigner.toLowerCase() === localOrderSigner.address.toLowerCase(), 'checkout-intent should include split version and webhook authorization');

  const connectedAssetsState = await getJson(`/api/dapp/assets-state?address=${buyerAddress}`);
  assert(connectedAssetsState.version === '24k-dapp-assets-state-v1'
    && connectedAssetsState.connectRequired === false
    && connectedAssetsState.summary?.orders?.some((order) => order.orderId === checkoutIntent.order.orderId)
    && connectedAssetsState.summary?.orderStateCounts?.pendingPayment >= 1, 'connected assets-state should expose the newly created draft order');
  const draftOrderState = await getJson(`/api/dapp/order-state?buyerAddress=${buyerAddress}&orderId=${checkoutIntent.order.orderId}`);
  assert(draftOrderState.version === '24k-dapp-order-state-v1'
    && draftOrderState.primaryAction?.key === 'payOrder'
    && draftOrderState.funding?.status === 'not_started', 'order-state should expose draft payment action before wallet broadcast');

  await postJson('/api/chain-events', {
    eventName: 'RewardLocked',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: '1',
    orderId: checkoutIntent.order.orderId,
    user: buyerAddress,
    asset: bnmAddress,
    amountWei: parseDecimal18(checkoutIntent.order.bnmLocked || '0').toString(),
    bucket: 0,
    txHash: hex32('frontend-consumption-reward-locked'),
    blockNumber: 101,
    logIndex: 0
  }, 201, { 'x-indexer-secret': serverEnv.INDEXER_SECRET });
  await postJson('/api/chain-events', {
    eventName: 'RewardReleased',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: '1',
    orderId: checkoutIntent.order.orderId,
    txHash: hex32('frontend-consumption-reward-released'),
    blockNumber: 102,
    logIndex: 0
  }, 201, { 'x-indexer-secret': serverEnv.INDEXER_SECRET });
  const claimableAssetsState = await getJson(`/api/dapp/assets-state?address=${buyerAddress}`);
  assert(claimableAssetsState.summary?.ledger?.some((entry) => entry.id === 'reward-ledger-1' && entry.state === 'Available')
    && claimableAssetsState.summary?.buckets?.some((bucket) => bucket.claimEndpoint === '/api/dapp/claim-intent'), 'assets-state should expose claimable RewardLedger entry and claim endpoint after release event');
  const claimableOrderState = await getJson(`/api/dapp/order-state?buyerAddress=${buyerAddress}&orderId=${checkoutIntent.order.orderId}&claimRewardId=reward-ledger-1`);
  assert(claimableOrderState.claim?.status === 'Available', 'order-state should expose claimable reward when claimRewardId is provided');
  const claimIntent = await postJson('/api/dapp/claim-intent', {
    walletAddress: buyerAddress,
    bucketId: 'bnm',
    rewardId: 'reward-ledger-1'
  });
  assert(claimIntent.ok === true
    && claimIntent.signatureKind === 'personal_sign'
    && claimIntent.secondaryMessage?.includes('Action: buyer.claim')
    && claimIntent.claimTransaction?.to?.toLowerCase() === rewardLedgerAddress.toLowerCase()
    && claimIntent.submit?.endpoint === '/api/claims', 'claim-intent should expose personal_sign message, submit template and RewardLedger claim tx');

  const sessionId = hex32('frontend-consumption-seckill-session');
  await postJson('/api/chain-events', {
    eventName: 'SessionStarted',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId,
    productId: hex32('frontend-consumption-runner-product'),
    productIdText: 'p-24k-runner',
    startsAt: Math.floor(Date.now() / 1000) - 60,
    mainEndsAt: Math.floor(Date.now() / 1000) + 3600,
    relayEndsAt: Math.floor(Date.now() / 1000) + 180,
    minimumNplAmountWei: parseDecimal18('120').toString(),
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: hex32('frontend-consumption-session-started'),
    blockNumber: 201,
    logIndex: 0
  }, 201, { 'x-indexer-secret': serverEnv.INDEXER_SECRET });
  const seckillIntent = await postJson('/api/dapp/seckill-intent', {
    buyerAddress,
    idempotencyKey: `frontend-consumption:${buyerAddress}:seckill`,
    items: [{ ...checkoutItem, productId: 'p-24k-runner' }]
  }, 201);
  assert(seckillIntent.ok === true
    && seckillIntent.seckill?.contractCallerBlocked === true
    && seckillIntent.seckill?.recordPurchaseTransaction?.to?.toLowerCase() === seckillAddress.toLowerCase()
    && seckillIntent.seckill?.recordPurchaseTransaction?.sessionId === sessionId
    && seckillIntent.nextActions?.includes('sendRecordPurchase'), 'seckill-intent should expose tx.origin policy and recordPurchase wallet transaction');

  const report = {
    kind: '24k-dapp-frontend-consumption-check',
    generatedAt: new Date().toISOString(),
    baseUrl,
    privateKeyPrinted: false,
    checks: {
      readinessOk: readiness.ok === true,
      bootstrapHasTabStates,
      handoffHasFrontendBrief: handoff.frontendBrief?.includes('前端线程任务提示词') === true,
      openapiHasTabStates: Boolean(openapi.paths?.['/api/dapp/seckill-state']?.get
        && openapi.paths?.['/api/dapp/mall-state']?.get
        && openapi.paths?.['/api/dapp/stores-state']?.get
        && openapi.paths?.['/api/dapp/assets-state']?.get),
      openapiHasSdk: Boolean(openapi.paths?.['/api/dapp/sdk.ts']?.get),
      sdkHasWalletHelpers: sdk.includes('sendPaymentIntent') && sdk.includes('submitClaimRequest'),
      sdkHasTabStateHelpers: sdk.includes('fetchDappSeckillState')
        && sdk.includes('fetchDappMallState')
        && sdk.includes('fetchDappStoresState')
        && sdk.includes('fetchDappAssetsState'),
      frontendBriefHasFixedNpl: frontendBrief.includes(fixedNpl),
      frontendBriefHasNoQrLaunchNoise: !frontendBrief.includes('Launch kit / QR payload'),
      tabStatesFetch,
      authenticatedAssetsReady: assetsState.connectRequired === false && assetsState.connectedAddress?.toLowerCase() === buyerAddress.toLowerCase(),
      fulfillmentOptionsReady: fulfillmentOptions.version === '24k-fulfillment-options-v1',
      finalCheckReady: finalCheck.ok === true && finalCheck.version === '24k-dapp-final-check-v1',
      checkoutIntentReady: checkoutIntent.ok === true && checkoutIntent.paymentIntent?.allowanceChecks?.length === 1 && checkoutIntent.paymentIntent?.approvalTransactions?.length === 1,
      pickupCheckoutReady: pickupCheckoutIntent.ok === true && pickupCheckoutIntent.paymentIntent?.allowanceChecks?.length === 1 && pickupCheckoutIntent.paymentIntent?.approvalTransactions?.length === 1,
      fixedNplApprovalReady: checkoutIntent.paymentIntent?.approvalTransactions?.some((tx) => tx.symbol === 'NPL' && tx.to?.toLowerCase() === fixedNpl) === true,
      connectedAssetsOrderReady: connectedAssetsState.summary?.orders?.some((order) => order.orderId === checkoutIntent.order.orderId) === true,
      draftOrderStateReady: draftOrderState.primaryAction?.key === 'payOrder' && draftOrderState.funding?.status === 'not_started',
      claimableAssetsReady: claimableAssetsState.summary?.ledger?.some((entry) => entry.id === 'reward-ledger-1' && entry.state === 'Available') === true,
      claimIntentReady: claimIntent.ok === true && Boolean(claimIntent.claimTransaction),
      seckillIntentReady: seckillIntent.ok === true && Boolean(seckillIntent.seckill?.recordPurchaseTransaction)
    }
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log('DApp frontend consumption check: PASS');
  console.log(`source: ${baseUrl}`);
  console.log(`wrote ${reportFile}`);
  console.log('PRIVATE_KEY printed: false');
} finally {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  await localOrderSigner.close();
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
  const response = await fetch(`${baseUrl}${path}`, { headers: buyerAuthorization({}) });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getText(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: buyerAuthorization({}) });
  const payload = await response.text();
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${payload}`);
  return payload;
}

async function siweLogin(wallet, role) {
  const nonce = await postJson('/api/auth/siwe/nonce', { address: wallet.address, role }, 201);
  const signature = await wallet.signMessage(nonce.message);
  return postJson('/api/auth/siwe/verify', { address: wallet.address, role, message: nonce.message, signature }, 201);
}

async function withSecondary(wallet, token, action, payload) {
  const intent = await postJson('/api/auth/action-intent', { action, payload }, 201, authHeaders(token));
  assert(intent.action === action && intent.walletAddress?.toLowerCase() === wallet.address.toLowerCase(), 'action-intent should bind address action and buyer wallet');
  assert(intent.payloadHash === payloadHashForSignature(payload) && intent.signatureKind === 'personal_sign', 'action-intent should bind the exact address payload');
  const secondarySignature = await wallet.signMessage(intent.secondaryMessage);
  return { ...payload, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function payloadHashForSignature(payload) {
  return `0x${createHash('sha256').update(stableStringify(payload || {})).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function postJson(path, body, expectedStatus = 200, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expectedStatus, `POST ${path} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function buyerAuthorization(headers) {
  if (!defaultBuyerToken || headers.authorization) return headers;
  return { authorization: `Bearer ${defaultBuyerToken}`, ...headers };
}

function parseDecimal18(value) {
  const [whole, fractional = ''] = String(value).split('.');
  assert(/^\d+$/.test(whole) && /^\d*$/.test(fractional) && fractional.length <= 18, `bad decimal: ${value}`);
  return BigInt(whole) * 10n ** 18n + BigInt((fractional.padEnd(18, '0')) || '0');
}

function hex32(seed) {
  return `0x${createHash('sha256').update(String(seed)).digest('hex')}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Interface, MaxUint256, parseUnits, Wallet } from 'ethers';
import { strFromU8, unzipSync } from 'fflate';
import { startOrderSigner } from './test-support/order-signer.mjs';

const port = process.env.BACKEND_CHECK_PORT ? Number(process.env.BACKEND_CHECK_PORT) : await availablePort();
const tempDir = mkdtempSync(join(tmpdir(), '24k-backend-check-'));
const dbPath = resolve(tempDir, 'check-backend.db');
const escrowAddress = '0x2222222222222222222222222222222222222222';
const seckillAddress = '0x3333333333333333333333333333333333333333';
const rewardLedgerAddress = '0x4444444444444444444444444444444444444444';
const bnmAddress = '0x5555555555555555555555555555555555555555';
const multisigAddress = '0x8888888888888888888888888888888888888888';
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();
const blacklistedWallet = Wallet.createRandom();
const platformSellerWallet = Wallet.createRandom();
const merchantAddress = merchantWallet.address;
const adminAddress = adminWallet.address;
const indexerSecret = 'local-check-secret';
const adminSecret = 'local-admin-secret';
const multisigCallbackSecret = 'local-multisig-callback-secret-1234567890';
const actionTokens = new Map();
let defaultBuyerToken = '';
rmSync(dbPath, { force: true });
const localOrderSigner = await startOrderSigner({ chainId: 56, escrowAddress });
const runtimeMock = await startRuntimeMock(await availablePort());

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PRIVATE_KEY: '',
    NODE_ENV: 'development',
    PORT: String(port),
    DB_PATH: dbPath,
    MICRO_TEST: 'false',
    EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
    EXPO_PUBLIC_SECKILL_ADDRESS: seckillAddress,
    MERCHANT_RECEIVER_ADDRESS: merchantAddress,
    ...localOrderSigner.env,
    ADMIN_WALLET_ADDRESS: adminAddress,
    JWT_SECRET: 'local-jwt-secret',
    INDEXER_SECRET: indexerSecret,
    ADMIN_SECRET: adminSecret,
    MULTISIG_CALLBACK_SECRET: multisigCallbackSecret,
    REDIS_HEALTH_TOKEN: 'redis-health-secret-that-must-not-leak',
    MQ_HEALTH_TOKEN: 'mq-health-secret-that-must-not-leak',
    CHAIN_EVENT_RPC_URL: '',
    CHAIN_EVENT_RPC_FALLBACK_URL: '',
    BSC_RPC_URL: '',
    EXPO_PUBLIC_BSC_RPC_URL: '',
    EXPLORER_API_KEY: '',
    BSCSCAN_API_KEY: '',
    RATE_LIMIT_REQUESTS_PER_MINUTE: '5000',
    ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
server.stderr.on('data', (chunk) => { stderr += chunk; });
try {
  await waitForHealth();

  const rootHtml = await getText('/');
  assert(rootHtml.includes('24K 全量系统预览') && rootHtml.includes('秒杀大厅') && rootHtml.includes('常规商城'), 'root should render 24K C端 preview');
  assert(['线下门店', '我的资产', 'NPL', 'BNM'].every((marker) => rootHtml.includes(marker)), 'root preview should include four 24K tabs and NPL/BNM markers');

  const previewHtml = await getText('/preview');
  assert(previewHtml.includes('24K 三端前端预搭') && previewHtml.includes('data-tab="seckill"'), 'preview should render 24K tab shell');
  assert(previewHtml.includes('/merchant') && previewHtml.includes('/admin'), 'preview side panel should link backstage pages');

  const merchantHtml = await getText('/merchant');
  const merchantJs = await getText('/backstage/merchant.js');
  assert(merchantHtml.includes('24K 商家后台') && merchantHtml.includes('/backstage/merchant.js'), 'merchant backstage should load its dedicated application');
  assert(['SIWE', '单品提报', '自提核销', 'Claim'].every((marker) => merchantJs.includes(marker)), 'merchant backstage application should expose docs modules');
  const adminHtml = await getText('/admin');
  const adminJs = await getText('/backstage/admin.js');
  assert(adminHtml.includes('24K 平台运营后台') && adminHtml.includes('/backstage/admin.js'), 'admin backstage should load its dedicated application');
  assert(['秒杀排期', '强制退款', '风控与黑名单', '审计日志'].every((marker) => adminJs.includes(marker)), 'admin backstage application should expose docs modules');
  const backstageCommonJs = await getText('/backstage/common.js');
  const intentIndex = backstageCommonJs.indexOf("api('/api/auth/action-intent'");
  const signIndex = backstageCommonJs.indexOf('personalSign(intent.secondaryMessage', intentIndex);
  const submitIndex = backstageCommonJs.indexOf('api(submitPath', signIndex);
  assert(intentIndex >= 0 && signIndex > intentIndex && submitIndex > signIndex, 'backstage writes should request backend action intent before personal_sign and submission');

  const publicMerchantDashboard = await fetch(`http://localhost:${port}/api/merchant/dashboard`);
  assert(publicMerchantDashboard.status === 401, 'merchant dashboard should require SIWE JWT');
  const publicAdminDashboard = await fetch(`http://localhost:${port}/api/admin/dashboard`);
  assert(publicAdminDashboard.status === 401, 'admin dashboard should require admin auth');
  const publicMerchantSummary = await fetch(`http://localhost:${port}/api/merchant/summary`);
  assert(publicMerchantSummary.status === 401, 'merchant summary should require merchant auth');
  const publicAdminSummary = await fetch(`http://localhost:${port}/api/admin/summary`);
  assert(publicAdminSummary.status === 401, 'admin summary should require admin auth');
  const adminSecretWriteBypass = await fetch(`http://localhost:${port}/api/admin/ratio-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': adminSecret },
    body: JSON.stringify({ bnmRebateRate: 100, nplBurnBps: 7000 })
  });
  assert(adminSecretWriteBypass.status === 401, 'x-admin-secret must not bypass admin write secondary signature');
  await assertAdminSiweRequiresConfiguredWallet();
  await assertDuplicateSubmissionMigration();
  await assertProductionSecretsFailClosed();
  await assertProductionDistinctSecretsFailClosed();
  await assertOnchainSeckillPrizeRewardSync();
  await assertStrictSiweValidation(merchantWallet);
  await assertSiweNonceReplayIsAtomic(merchantWallet);

  const merchantAuth = await siweLogin(merchantWallet, 'merchant');
  const adminAuth = await siweLogin(adminWallet, 'admin');
  const buyerAuth = await siweLogin(merchantWallet, 'buyer');
  const blacklistedBuyerAuth = await siweLogin(blacklistedWallet, 'buyer');
  defaultBuyerToken = buyerAuth.token;
  assert(merchantAuth.role === 'merchant' && merchantAuth.token, 'merchant SIWE should return JWT token');
  assert(adminAuth.role === 'admin' && adminAuth.token, 'admin SIWE should return JWT token');
  const merchantHeaders = authHeaders(merchantAuth.token);
  const adminHeaders = authHeaders(adminAuth.token);
  const buyerHeaders = authHeaders(buyerAuth.token);
  const blacklistedBuyerHeaders = authHeaders(blacklistedBuyerAuth.token);
  const updatedProfile = await patch('/api/merchant/profile', await withSecondary(merchantWallet, 'merchant.profile.update', {
    name: '24K 官方严选升级店',
    logoUrl: 'https://cdn.example.test/merchant-logo.png',
    contactPhone: '13800000000',
    supportUrl: 'https://support.example.test',
    announcement: '仅使用 NPL 支付'
  }), merchantHeaders);
  assert(updatedProfile.name === '24K 官方严选升级店' && updatedProfile.profile?.announcement === '仅使用 NPL 支付' && updatedProfile.walletAddress === merchantAddress.toLowerCase(), 'merchant profile should update editable fields without changing wallet or status');
  const immutableProfile = await patch('/api/merchant/profile', await withSecondary(merchantWallet, 'merchant.profile.update', { status: 'Approved' }), merchantHeaders, 400);
  assert(immutableProfile.error === 'MERCHANT_PROFILE_IMMUTABLE_FIELD', 'merchant profile must reject immutable wallet/status fields');
  const initialStore = await post('/api/merchant/stores', await withSecondary(merchantWallet, 'merchant.store.upsert', {
    ...merchantStoreInput({ storeId: 'store-dl-gaoxin', name: '24K 大连高新自提店' })
  }), merchantHeaders);
  assert(initialStore.id === 'store-dl-gaoxin' && initialStore.regionCode === '210211', 'merchant should persist the GPS pickup store through action-intent');
  const actionIntentWithoutJwt = await fetch(`http://localhost:${port}/api/auth/action-intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'admin.cms.publish', payload: { key: 'no-jwt' } })
  });
  assert(actionIntentWithoutJwt.status === 401, 'action-intent should require a SIWE JWT');
  await post('/api/auth/action-intent', { action: 'admin.cms.publish', payload: { key: 'wrong-role' } }, merchantHeaders, 403);
  const forgedCms = await withLocallyGeneratedSecondary(adminWallet, 'admin.cms.publish', { key: 'forged-nonce', text: '不得写入' });
  const forgedNonceResult = await post('/api/admin/cms', forgedCms, adminHeaders, 401);
  assert(forgedNonceResult.error === 'ACTION_NONCE_NOT_ISSUED', 'locally fabricated action nonce should be rejected');
  const merchantDashboard = await get('/api/merchant/dashboard', merchantHeaders);
  assert(merchantDashboard.paymentAsset === 'NPL' && merchantDashboard.merchant?.walletAddress?.toLowerCase() === merchantAddress.toLowerCase() && merchantDashboard.stats, 'merchant dashboard should work with SIWE JWT');
  const adminDashboard = await get('/api/admin/dashboard', adminHeaders);
  assert(adminDashboard.paymentAsset === 'NPL' && adminDashboard.stats && adminDashboard.todo && Array.isArray(adminDashboard.circuits), 'admin dashboard should work with SIWE JWT');
  const authMerchantSummary = await get('/api/merchant/summary', merchantHeaders);
  assert(authMerchantSummary.paymentAsset === 'NPL' && authMerchantSummary.merchant?.walletAddress?.toLowerCase() === merchantAddress.toLowerCase(), 'merchant summary should work with SIWE JWT');
  const authAdminSummary = await get('/api/admin/summary', adminHeaders);
  assert(authAdminSummary.paymentAsset === 'NPL' && authAdminSummary.stats && authAdminSummary.todo, 'admin summary should work with SIWE JWT');

  const reusableSignedCms = await withSecondary(adminWallet, 'admin.cms.publish', { key: 'replay-check', text: '首次写入' });
  await post('/api/admin/cms', reusableSignedCms, adminHeaders);
  const replayedCms = await post('/api/admin/cms', reusableSignedCms, adminHeaders, 401);
  assert(replayedCms.error === 'ACTION_NONCE_REPLAYED', 'backend-issued action nonce should be single-use');
  const tamperSignedCms = await withSecondary(adminWallet, 'admin.cms.publish', { key: 'tamper-check', text: '原文' });
  const tamperedCms = await post('/api/admin/cms', { ...tamperSignedCms, text: '被篡改' }, adminHeaders, 400);
  assert(tamperedCms.error === 'SECONDARY_PAYLOAD_MISMATCH', 'action-intent signature should reject payload tampering');

  const pausedOrders = await post('/api/admin/pause-orders', await withSecondary(adminWallet, 'admin.circuit.orders', { enabled: true, reason: 'backend check pause' }), adminHeaders);
  assert(pausedOrders.state === 'PendingPause' && pausedOrders.circuit?.enabled === true && pausedOrders.transactionIntents?.[0]?.data, 'admin pause-orders should fail closed while the owner transaction is pending');
  await post('/api/orders', {
    buyerAddress: merchantAddress,
    idempotencyKey: 'backend-check:paused-order',
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true }]
  }, {}, 423);
  const confirmedPause = await post('/api/chain-events', {
    eventName: 'EscrowPaused',
    chainId: 56,
    contractAddress: escrowAddress,
    account: adminAddress,
    txHash: hex32('e1'),
    blockNumber: 91,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(confirmedPause.circuit?.state === 'Paused' && confirmedPause.circuit.enabled === true, 'EscrowPaused should confirm the backend order circuit');
  const resumedOrders = await post('/api/admin/pause-orders', await withSecondary(adminWallet, 'admin.circuit.orders', { enabled: false, reason: 'backend check resume' }), adminHeaders);
  assert(resumedOrders.state === 'PendingResume' && resumedOrders.circuit?.enabled === true, 'admin resume must remain fail closed until EscrowUnpaused is indexed');
  await post('/api/orders', {
    buyerAddress: merchantAddress,
    idempotencyKey: 'backend-check:pending-resume-order',
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true }]
  }, {}, 423);
  const confirmedResume = await post('/api/chain-events', {
    eventName: 'EscrowUnpaused',
    chainId: 56,
    contractAddress: escrowAddress,
    account: adminAddress,
    txHash: hex32('e2'),
    blockNumber: 92,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(confirmedResume.circuit?.state === 'Open' && confirmedResume.circuit.enabled === false, 'EscrowUnpaused should reopen order creation');

  await post('/api/admin/blacklist', await withSecondary(adminWallet, 'admin.blacklist.update', { address: blacklistedWallet.address, reason: 'backend check' }), adminHeaders);
  await post('/api/orders', {
    buyerAddress: blacklistedWallet.address,
    idempotencyKey: 'backend-check:blacklisted-order',
    items: [{ productId: 'p-24k-runner', quantity: 1, selected: true }]
  }, blacklistedBuyerHeaders, 403);

  const products = await get('/api/products');
  assert(products.length >= 4, 'products API should return 24K seeded products');
  const runner = productById(products, 'p-24k-runner');
  assert(runner.shopBadge === '秒杀' && runner.nplRatio === 100 && runner.bnmRebateRate === 100, 'products API should include NPL-only payment and BNM fields');
  assert(Array.isArray(runner.skus) && runner.skus.length >= 1 && runner.fulfillmentModes.includes('pickup'), 'products API should include SKU and fulfillment fields');
  assert(runner.sellerAddress.toLowerCase() === merchantAddress.toLowerCase(), 'products API seller should use configured merchant address');
  const dappBootstrap = await get(`/api/dapp/bootstrap?address=${merchantAddress}`);
  assert(dappBootstrap.config?.nplAddress?.toLowerCase() === '0x4e8277ab31e4956b2cd48449793a57656dfc03d2', 'DApp bootstrap should expose fixed NPL address');
  assert(dappBootstrap.config?.payment?.firstPaymentApproval === 'unlimited-npl' && dappBootstrap.abiFragments?.escrow?.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)'), 'DApp bootstrap should expose the signed 9-parameter payOrder ABI');
  assert(dappBootstrap.endpoints?.buyerOrders && dappBootstrap.endpoints?.paymentIntent && dappBootstrap.endpoints?.seckillState?.startsWith('/api/dapp/seckill-state') && dappBootstrap.endpoints?.mallState?.startsWith('/api/dapp/mall-state') && dappBootstrap.endpoints?.storesState?.startsWith('/api/dapp/stores-state') && dappBootstrap.endpoints?.assetsState?.startsWith('/api/dapp/assets-state') && dappBootstrap.initialData?.assetsState?.version === '24k-dapp-assets-state-v1' && dappBootstrap.initialData?.buyer?.assets?.buckets?.length, 'DApp bootstrap should expose buyer endpoints, payment intent, tab states and asset seed data');
  assert(dappBootstrap.config?.chain?.chainIdHex === '0x38' && dappBootstrap.config?.wallet?.switchEthereumChain?.method === 'wallet_switchEthereumChain', 'DApp bootstrap should expose wallet switch chain params');
  assert(dappBootstrap.config?.wallet?.addEthereumChain?.params?.[0]?.rpcUrls?.length && dappBootstrap.config.wallet.addEthereumChain.params[0].blockExplorerUrls?.[0]?.includes('bscscan'), 'DApp bootstrap should expose wallet add-chain params');
  const dappManifest = await get('/api/dapp/manifest');
  assert(dappManifest.name === '24K Mall DApp' && dappManifest.wallet?.addEthereumChain?.method === 'wallet_addEthereumChain' && dappManifest.tokens?.npl?.toLowerCase() === fixedNplAddress(), 'DApp manifest should expose app metadata, wallet add-chain and fixed NPL');
  const dappReadiness = await get('/api/dapp/readiness');
  assert(dappReadiness.ok === true && dappReadiness.modules?.payment?.ready === true, 'DApp readiness should report payment readiness when escrow and merchant are configured');
  assert(dappReadiness.modules?.claims?.backendIntentReady === true && dappReadiness.modules.claims.onchainReady === false, 'DApp readiness should separate backend Claim intent from on-chain RewardLedger readiness');
  assert(dappReadiness.warnings?.includes('REWARD_LEDGER_ADDRESS_NOT_CONFIGURED') && dappReadiness.endpoints?.checkoutIntent === '/api/dapp/checkout-intent', 'DApp readiness should expose launch warnings and intent endpoints');
  const corsOrigin = 'http://localhost:19006';
  const corsPreflight = await fetch(`http://localhost:${port}/api/dapp/bootstrap`, {
    method: 'OPTIONS',
    headers: { origin: corsOrigin, 'access-control-request-method': 'GET' }
  });
  assert(corsPreflight.status === 204 && corsPreflight.headers.get('access-control-allow-origin') === corsOrigin && corsPreflight.headers.get('vary') === 'origin', 'local DApp browser preflight should echo the allowed origin');
  const rejectedCorsPreflight = await fetch(`http://localhost:${port}/api/dapp/bootstrap`, {
    method: 'OPTIONS',
    headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'GET' }
  });
  assert(rejectedCorsPreflight.status === 204 && !rejectedCorsPreflight.headers.get('access-control-allow-origin'), 'unconfigured browser origins should not receive CORS access');

  const seckill = await get('/api/seckill/current');
  assert(seckill.session.status === 'idle' && seckill.feed.length === 0 && !seckill.product, 'seckill API should expose a real empty state before a chain session is indexed');
  const dappSeckillState = await get(`/api/dapp/seckill-state?address=${merchantAddress}`);
  assert(dappSeckillState.version === '24k-dapp-seckill-state-v1' && dappSeckillState.phase?.key === 'idle' && dappSeckillState.timers?.relay && dappSeckillState.cta?.enabled === false && dappSeckillState.rules?.version === '24k-seckill-rules-v1', 'DApp seckill-state should expose a disabled empty state before a real session exists');
  const dappMallState = await get(`/api/dapp/mall-state?address=${merchantAddress}&limit=2`);
  assert(dappMallState.version === '24k-dapp-mall-state-v1' && dappMallState.products?.[0]?.primaryAction && dappMallState.finalCheckTemplate?.endpoint === '/api/dapp/final-check', 'DApp mall-state should expose product cards and final-check template');
  const dappStoresState = await get(`/api/dapp/stores-state?address=${merchantAddress}&lat=38.86&lng=121.52&limit=2`);
  assert(dappStoresState.version === '24k-dapp-stores-state-v1' && dappStoresState.stores?.[0]?.regionCode === '210211' && dappStoresState.stores[0].distanceSource !== 'seed' && dappStoresState.checkoutTemplates?.pickup?.fulfillmentMode === 'pickup', 'DApp stores-state should expose the persisted pickup store without a fake distance');
  const dappAssetsState = await get(`/api/dapp/assets-state?address=${merchantAddress}`);
  assert(dappAssetsState.version === '24k-dapp-assets-state-v1' && dappAssetsState.summary?.buckets?.some((bucket) => bucket.id === 'bnm') && dappAssetsState.sections?.orders?.counts && dappAssetsState.primaryAction?.key && dappAssetsState.endpoints?.summary?.startsWith('/api/assets/summary'), 'DApp assets-state should expose asset summary sections and primary action');
  const stores = await get('/api/stores');
  assert(stores.length >= 1 && stores[0].regionCode === '210211' && stores[0].distanceSource !== 'seed', 'stores API should expose the persisted region without a fake distance');
  assert(stores[0].pickupContext?.checkoutItemPatch?.fulfillmentMode === 'pickup' && stores[0].dapp?.lockPreview?.regionBinding === true, 'stores API should expose pickup checkout patch and region lock metadata');
  const assets = await get('/api/assets/summary');
  assert(assets.buckets.some((bucket) => bucket.id === 'bnm') && assets.ledger.length === 0 && assets.claims.length === 0, 'asset summary should expose zeroed real buckets without fabricated ledger or claim records');
  for (const bucketId of ['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops']) {
    const bucket = assets.buckets.find((entry) => entry.id === bucketId);
    assert(bucket?.docsKey === bucketId && bucket.claimEndpoint === '/api/dapp/claim-intent' && bucket.stateSummary, `asset summary should expose docs bucket metadata for ${bucketId}`);
  }
  assert(assets.buckets.find((entry) => entry.id === 'genesis-node')?.visible === false && assets.entitlements?.genesisNode?.entitled === false, 'genesis-node rewards must stay hidden when the onchain credential contract is not configured');
  assert(assets.buckets.find((entry) => entry.id === 'ops')?.assetSymbol === 'NPL', 'ops bucket should follow docs NPL pool policy');
  const merchantSummary = await get('/api/merchant/summary', merchantHeaders);
  assert(merchantSummary.paymentAsset === 'NPL' && merchantSummary.stats && merchantSummary.assets && merchantSummary.fulfillment, 'merchant summary API should expose NPL stats, assets and fulfillment');
  const adminSummary = await get('/api/admin/summary', adminHeaders);
  assert(adminSummary.paymentAsset === 'NPL' && adminSummary.stats && adminSummary.todo && adminSummary.infrastructure, 'admin summary API should expose NPL operations and infrastructure state');
  const emptyReconciliation = await get('/api/admin/reconciliation', adminHeaders);
  assert(emptyReconciliation.status === 'NoData' && emptyReconciliation.checked === 0, 'reconciliation must report NoData instead of a false success before any chain evidence exists');
  const operations = await get('/api/admin/ops', adminHeaders);
  assert(operations.components?.db?.status === 'healthy' && operations.components?.redis?.status === 'notConfigured' && operations.components?.mq?.status === 'notConfigured', 'operations snapshot should report real DB health and explicit Redis/MQ notConfigured states');
  assert(Number.isFinite(operations.traffic?.qps) && Number.isFinite(operations.traffic?.tps) && Number.isFinite(operations.traffic?.errorRatePct) && operations.blockchain?.status === 'notConfigured', 'operations snapshot should expose QPS/TPS/error rate and explicit blockchain configuration state');

  const chainRuntimeConfig = {
    chainId: 56,
    multisigAddress,
    primaryRpcUrl: runtimeMock.primaryRpcUrl,
    backupRpcUrl: runtimeMock.fallbackRpcUrl
  };
  const rejectedWrongChain = await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'chain',
    value: { chainId: 56, multisigAddress, primaryRpcUrl: runtimeMock.wrongChainRpcUrl }
  }), adminHeaders, 400);
  assert(rejectedWrongChain.error.startsWith('RPC_CHAIN_ID_MISMATCH'), 'runtime RPC configuration must reject an endpoint on a different chain');
  const savedChainRuntime = await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', { key: 'chain', value: chainRuntimeConfig }), adminHeaders);
  assert(savedChainRuntime.applied === true && savedChainRuntime.config?.chainId === 56, 'chain runtime configuration should validate, persist and apply immediately');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'oracle-gas',
    value: { oracleAddress: runtimeMock.oracleAddress, oracleDeviationBps: 150, oracleReferencePrice: '2.02', oracleMaxAgeSeconds: 3600, maxGasGwei: '2' }
  }), adminHeaders);
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'infrastructure',
    value: { redisHealthUrl: runtimeMock.redisHealthUrl, mqHealthUrl: runtimeMock.mqHealthUrl, cdnEnabled: false }
  }), adminHeaders);
  const rejectedCredentialUrl = await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'infrastructure',
    value: { redisHealthUrl: `${runtimeMock.redisHealthUrl}?apiToken=must-not-persist` }
  }), adminHeaders, 400);
  assert(rejectedCredentialUrl.error.includes('CREDENTIALS'), 'runtime URLs must reject credential-like query parameters');
  const rejectedSecretConfig = await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'infrastructure',
    value: { redisHealthUrl: runtimeMock.redisHealthUrl, apiToken: 'must-not-persist' }
  }), adminHeaders, 400);
  assert(rejectedSecretConfig.error === 'SECRETS_MUST_USE_ENV', 'system configuration should reject nested credentials before persistence or audit');
  const runtimeOperations = await get('/api/admin/ops', adminHeaders);
  assert(runtimeOperations.blockchain?.rpc?.activeEndpoint === 'fallback' && runtimeOperations.blockchain.rpc.degraded === true && runtimeMock.counts.primaryRpc > 0 && runtimeMock.counts.fallbackRpc > 0, 'RPC should audit a failed primary attempt and route the request through fallback');
  assert(runtimeOperations.blockchain?.oracle?.status === 'healthy' && runtimeOperations.blockchain.oracle.livePrice === '2.0' && runtimeOperations.blockchain.oracle.deviationBps < 150 && runtimeOperations.blockchain.oracle.alert === false, 'Chainlink reader should expose live/reference price, deviation and threshold state');
  assert(runtimeOperations.blockchain?.gas?.blocked === false && runtimeOperations.blockchain.gas.priceGwei === 1 && runtimeOperations.blockchain.gas.limitGwei === 2, 'operations snapshot should expose live gas and configured block threshold');
  assert(runtimeOperations.components?.redis?.status === 'healthy' && runtimeOperations.components.redis.hitRatioPct === 90, 'Redis HTTP probe should report real hit ratio');
  assert(runtimeOperations.components?.mq?.status === 'healthy' && runtimeOperations.components.mq.backlog === 7, 'MQ management probe should report real backlog');
  assert(!runtimeMock.counts.redisAuthorization && !runtimeMock.counts.mqAuthorization, 'database-configured health URLs must not receive environment Authorization credentials');
  assert(runtimeOperations.host?.disk?.status === 'healthy' && Number.isFinite(runtimeOperations.host.disk.usedPct), 'operations snapshot should expose live disk waterline');
  assert(Number.isFinite(runtimeOperations.traffic?.latencyAvgMs) && Number.isFinite(runtimeOperations.traffic?.latencyP95Ms) && runtimeOperations.traffic.endpoints?.length > 0, 'operations snapshot should expose average and percentile endpoint latency');
  assert(!JSON.stringify(runtimeOperations).includes(runtimeMock.baseUrl), 'operations response must not disclose configured RPC or health endpoint URLs');
  const rpcAudit = await get('/api/admin/rpc-audit-logs', adminHeaders);
  assert(rpcAudit.some((entry) => entry.request?.endpointRole === 'primary' && entry.status === 'http_error') && rpcAudit.some((entry) => entry.request?.endpointRole === 'fallback' && entry.status === 'success'), 'RPC audit database should append every primary and fallback attempt without endpoint URLs');
  assert(!JSON.stringify(rpcAudit).includes(runtimeMock.baseUrl), 'RPC audit records must not contain endpoint URLs');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'chain',
    value: { chainId: 56, multisigAddress }
  }), adminHeaders);
  const clearedRuntimeOperations = await get('/api/admin/ops', adminHeaders);
  assert(clearedRuntimeOperations.blockchain?.status === 'notConfigured', 'clearing runtime RPC URLs must restore the environment fallback instead of retaining stale endpoints');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', { key: 'chain', value: chainRuntimeConfig }), adminHeaders);
  await assertAuditFailureBlocksBusinessMutation(adminWallet, adminHeaders);
  const messages = await get('/api/messages');
  assert(messages.some((message) => message.id === 'm-seckill'), 'messages API should seed 24K notifications');

  const productDetail = await get('/api/products/p-24k-runner');
  assert(productDetail.fiveFactorTemplate && productDetail.risk?.finalFiveFactorCheck, 'product detail should expose five-factor template and risk profile');
  assert(productDetail.dapp?.version === '24k-product-detail-v1' && productDetail.dapp.buyNow?.enabled === true && productDetail.dapp.seckillOverlay?.active === false, 'product detail should keep regular purchase enabled until a real seckill session locks the product');
  assert(productDetail.dapp.finalCheck?.warning?.includes('行政区划编码') && productDetail.dapp.paymentPolicy?.approvalAmount === 'MaxUint256', 'product detail DApp contract should expose final-check warning and docs approval policy');
  const addressPayload = { id: 'addr-default', walletAddress: merchantAddress, name: '测试用户', phone: '13800000001', province: '辽宁省', city: '大连市', district: '高新区', detail: '软件园路 1 号', regionCode: '210211', isDefault: true };
  const anonymousAddressResponse = await fetch(`http://localhost:${port}/api/address-book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(addressPayload)
  });
  assert(anonymousAddressResponse.status === 401, 'address writes should require a buyer JWT');
  await post('/api/address-book', await withSecondary(merchantWallet, 'buyer.address.upsert', { ...addressPayload, regionCode: '21021X' }), buyerHeaders, 400);
  const savedAddress = await post('/api/address-book', await withSecondary(merchantWallet, 'buyer.address.upsert', addressPayload), buyerHeaders);
  assert(savedAddress.regionCode === '210211' && savedAddress.deliveryContext?.regionBinding === true, 'address book should save region code and delivery lock metadata');
  const addressBook = await get('/api/address-book', buyerHeaders);
  assert(addressBook.some((entry) => entry.id === savedAddress.id), 'address book should return saved entries');
  const fulfillmentOptions = await get(`/api/dapp/fulfillment-options?address=${merchantAddress}&lat=38.86&lng=121.52&city=大连市&limit=2`);
  assert(fulfillmentOptions.version === '24k-fulfillment-options-v1' && fulfillmentOptions.checkoutTemplates?.pickup?.regionCode === '210211', 'DApp fulfillment options should expose pickup template and locked region');
  const deliveryWithoutAddress = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [{ productId: 'p-24k-runner', quantity: 1, selected: true, fulfillmentMode: 'delivery' }] }, {}, 200);
  assert(!deliveryWithoutAddress.ok && deliveryWithoutAddress.lines[0].reason === 'ADDRESS_REQUIRED', 'delivery preflight should require buyer-owned address');
  const pickupWithoutStore = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [{ productId: 'p-24k-runner', quantity: 1, selected: true, fulfillmentMode: 'pickup' }] }, {}, 200);
  assert(!pickupWithoutStore.ok && pickupWithoutStore.lines[0].reason === 'STORE_REQUIRED', 'pickup preflight should require a store');
  const unsupportedPickup = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [{ productId: 'p-24k-phone', quantity: 1, selected: true, fulfillmentMode: 'pickup', storeId: 'store-dl-gaoxin', regionCode: '210211' }] }, {}, 200);
  assert(!unsupportedPickup.ok && unsupportedPickup.lines[0].reason === 'FULFILLMENT_MODE_NOT_SUPPORTED', 'preflight should reject unsupported fulfillment mode');
  const preflight = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [deliveryItem('p-24k-runner', { addressId: savedAddress.id })] }, {}, 200);
  assert(preflight.ok && preflight.lines[0].fiveFactors.payment.includes('NPL'), 'stock preflight should expose final payment factors');
  assert(preflight.quote?.totalNpl === '120.000000000000000000' && preflight.quote?.amountNpl === '120.000000000000000000' && preflight.quote?.bnmLocked === '120.000000000000000000', 'stock preflight should expose NPL and BNM totals');
  assert(preflight.quote?.approval?.type === 'unlimited-npl' && preflight.quote?.approval?.amount === 'MaxUint256' && preflight.quote?.approval?.allowanceSkip === true, 'stock preflight should expose one unlimited NPL approval policy');
  assert(preflight.lines[0].quote?.totalNpl === '120.000000000000000000' && preflight.lines[0].quote?.amountNpl === '120.000000000000000000' && preflight.lines[0].quote?.bnmLocked === '120.000000000000000000', 'stock preflight line should expose NPL and BNM values');
  const finalized = await post('/api/orders/finalize', { buyerAddress: merchantAddress, idempotencyKey: 'backend-check:finalize', items: [deliveryItem('p-24k-bag', { addressId: savedAddress.id })] });
  assert(finalized.finalCheck?.passed && finalized.preflight?.ok, 'finalize order should run stock preflight and five-factor check');
  const releasedForClaim = await post('/api/admin/rewards/release', await withSecondary(adminWallet, 'admin.reward.release', { walletAddress: merchantAddress, orderId: finalized.orderId, amount: '1.000000000000000000', source: 'backend check claim prepare' }), adminHeaders);
  const claimPrepare = await post('/api/claims/prepare', { walletAddress: merchantAddress, rewardId: releasedForClaim.reward.id, bucketId: 'bnm' }, {}, 200);
  assert(claimPrepare.secondaryMessage.includes('Action: buyer.claim') && claimPrepare.secondaryMessage.includes(`RewardId: ${releasedForClaim.reward.id}`), 'claim prepare should return a wallet-signable buyer claim message');
  const claimIntent = await post('/api/dapp/claim-intent', { walletAddress: merchantAddress, rewardId: releasedForClaim.reward.id, bucketId: 'bnm' }, {}, 200);
  assert(claimIntent.secondaryMessage.includes(`RewardId: ${releasedForClaim.reward.id}`) && claimIntent.nextActions?.includes('submitClaimRequest'), 'DApp claim intent should include wallet-sign message and submit action');
  assert(claimIntent.claimTransaction === null && claimIntent.unavailableReason === 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED', 'DApp claim intent should explain missing on-chain claim tx when RewardLedger is not configured');
  const unavailableClaimStatus = await get(`/api/dapp/claim-tx-status?walletAddress=${merchantAddress}&rewardId=${releasedForClaim.reward.id}&txHash=0x5555555555555555555555555555555555555555555555555555555555555555`);
  assert(unavailableClaimStatus.status === 'unavailable' && unavailableClaimStatus.error === 'REWARD_ID_NOT_ONCHAIN_ENTRY', 'DApp claim tx status should explain non-onchain reward ids');
  const preparedClaimSignature = await merchantWallet.signMessage(claimPrepare.secondaryMessage);
  const preparedClaim = await post('/api/claims', { ...claimPrepare.submit.body, secondarySignature: preparedClaimSignature });
  assert(preparedClaim.status === 'pending' && preparedClaim.rewardId === releasedForClaim.reward.id, 'prepared claim message should submit a pending buyer claim');
  const claims = await get(`/api/claims?address=${merchantAddress}`);
  assert(claims.length >= 1, 'claims API should expose claim records');

  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('x'.repeat(61), { storeId: 'invalid-title' })), merchantHeaders, 400);
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('图片过量', { storeId: 'invalid-images', imageUrls: Array.from({ length: 6 }, (_, index) => `https://cdn.example.test/${index}.png`) })), merchantHeaders, 400);
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('SKU 缺失', { storeId: 'invalid-empty-skus', skus: [] })), merchantHeaders, 400);
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('SKU 重复', { storeId: 'invalid-duplicate-skus', skus: [{ id: 'same', name: 'A', settlementPriceNpl: '1', stock: 1 }, { id: 'SAME', name: 'B', settlementPriceNpl: '2', stock: 1 }] })), merchantHeaders, 400);
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('履约非法', { storeId: 'invalid-fulfillment', fulfillmentModes: ['drone'] })), merchantHeaders, 400);
  const submittedProduct = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('24K 测试提报商品', { descriptionHtml: '<p>安全详情</p><script>alert(1)</script><a href="javascript:alert(1)">链接</a>' })), merchantHeaders);
  assert(submittedProduct.status === 'PendingReview' && submittedProduct.locked, 'merchant product submission should be pending and locked');
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('24K 重复提报应被拒绝')), merchantHeaders, 423);
  await patch(`/api/merchant/products/${submittedProduct.id}`, await withSecondary(merchantWallet, 'merchant.product.update', { title: '锁定后不能修改' }), merchantHeaders, 423);
  const lockedProduct = await post(`/api/merchant/products/${submittedProduct.id}/lock`, await withSecondary(merchantWallet, 'merchant.product.lock', {}), merchantHeaders, 200);
  assert(lockedProduct.action === 'merchant.product.lock', 'merchant product lock should write audit action');
  const merchantStores = await get('/api/merchant/stores', merchantHeaders);
  assert(merchantStores.length >= 1, 'merchant stores API should list stores');
  await post('/api/merchant/stores', await withSecondary(merchantWallet, 'merchant.store.upsert', merchantStoreInput({ storeId: 'store-invalid-photo', photos: ['http://cdn.example.test/store.png'] })), merchantHeaders, 400);
  const savedStore = await post('/api/merchant/stores', await withSecondary(merchantWallet, 'merchant.store.upsert', merchantStoreInput({ storeId: 'store-check', name: '测试自提点' })), merchantHeaders);
  assert(savedStore.action === 'merchant.store.upsert', 'merchant store upsert should write audit action');
  const printer = await post('/api/merchant/printer', await withSecondary(merchantWallet, 'merchant.printer.configure', { deviceId: 'printer-1' }), merchantHeaders);
  assert(printer.action === 'merchant.printer.configure', 'merchant printer configure should write audit action');
  const printers = await get('/api/merchant/printers', merchantHeaders);
  assert(printers.some((entry) => entry.deviceId === 'printer-1' && entry.enabled === true), 'merchant printers API should return persisted device configuration');
  const unsignedExport = await fetch(`http://localhost:${port}/api/merchant/export`, { headers: merchantHeaders });
  assert(unsignedExport.status === 405, 'merchant export must reject unsigned GET requests');
  const signedExport = await post('/api/merchant/export', await withSecondary(merchantWallet, 'merchant.orders.export', { format: 'csv', filters: {} }), merchantHeaders, 200);
  assert(signedExport.fileName?.endsWith('.csv') && typeof signedExport.content === 'string' && signedExport.rowCount >= 0, 'merchant export should return a signed, downloadable CSV payload');
  const signedXlsxExport = await post('/api/merchant/export', await withSecondary(merchantWallet, 'merchant.orders.export', { format: 'excel', filters: {} }), merchantHeaders, 200);
  assertValidXlsxArtifact(signedXlsxExport, 'merchant Excel export');
  const draftProduct = await post('/api/merchant/products/drafts', await withSecondary(merchantWallet, 'merchant.product.draft', merchantProductInput('24K 草稿商品', { storeId: 'draft-store', priceNpl: '3.00' })), merchantHeaders);
  assert(draftProduct.status === 'Draft' && draftProduct.locked === false, 'merchant should save an editable product draft');
  const submittedDraft = await post(`/api/merchant/products/${draftProduct.id}/submit-review`, await withSecondary(merchantWallet, 'merchant.product.submit-review', {}), merchantHeaders, 200);
  assert(submittedDraft.status === 'PendingReview' && submittedDraft.locked === true, 'submitting a draft should lock it for platform review');
  await patch(`/api/merchant/products/${draftProduct.id}`, await withSecondary(merchantWallet, 'merchant.product.update', { title: '锁定后不得修改' }), merchantHeaders, 423);
  await post('/api/merchant/pickup/verify', await withSecondary(merchantWallet, 'merchant.pickup.verify', { code: 'PICKUP-001' }), merchantHeaders, 400);
  await post('/api/admin/rewards/release', await withSecondary(adminWallet, 'admin.reward.release', { walletAddress: merchantAddress, amount: '0.000001000000000000', assetSymbol: 'NPL', source: 'backend check merchant claim' }), adminHeaders);
  const merchantClaim = await post('/api/merchant/claims', await withSecondary(merchantWallet, 'merchant.claim.request', { bucketId: 'bnm' }), merchantHeaders, 409);
  assert(merchantClaim.error === 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED', 'merchant claim must not fake success before the RewardLedger contract is configured');
  const pendingProducts = await get('/api/admin/products/pending', adminHeaders);
  assert(pendingProducts.some((entry) => entry.id === submittedProduct.id && entry.locked && entry.storeId === 'default'), 'admin pending product API should expose locked merchant submissions');
  const sanitizedSubmission = pendingProducts.find((entry) => entry.id === submittedProduct.id);
  assert(sanitizedSubmission.payload.descriptionHtml.includes('<p>安全详情</p>') && !/script|javascript:/i.test(sanitizedSubmission.payload.descriptionHtml), 'merchant product rich text must be sanitized before immutable storage');
  const adminMerchants = await get('/api/admin/merchants', adminHeaders);
  assert(adminMerchants.some((entry) => entry.walletAddress.toLowerCase() === merchantAddress.toLowerCase()), 'admin merchants API should expose merchant whitelist');
  const adminReview = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: submittedProduct.id, decision: 'approved' }), adminHeaders);
  assert(adminReview.action === 'admin.product.review' && adminReview.approvedProduct?.id, 'admin product review should write audit action and create formal product');
  setSubmissionStatus(submittedProduct.id, 'Scheduled');
  await post(`/api/merchant/products/${submittedProduct.id}/takedown`, await withSecondary(merchantWallet, 'merchant.product.takedown', { reason: '活动期间不得主动下架' }), merchantHeaders, 423);
  setSubmissionStatus(submittedProduct.id, 'Approved');
  const takedownRequest = await post(`/api/merchant/products/${submittedProduct.id}/takedown`, await withSecondary(merchantWallet, 'merchant.product.takedown', { reason: '商品停止销售' }), merchantHeaders, 200);
  assert(takedownRequest.status === 'TakedownRequested', 'approved merchant product should enter takedown review');
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('下架待审期间不得绕过')), merchantHeaders, 423);
  const takedownApproved = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: submittedProduct.id, decision: 'approved' }), adminHeaders);
  assert(takedownApproved.status === 'TakenDown', 'admin should approve a pending takedown and release the single-product slot');
  const inactiveProductId = adminReview.approvedProduct.id;
  assert(!(await get('/api/products')).some((entry) => entry.id === inactiveProductId), 'public product list must hide inactive products');
  assert((await get('/api/products?includeInactive=true', adminHeaders)).some((entry) => entry.id === inactiveProductId && entry.status === 'Inactive'), 'admin product list should retain inactive products for operations');
  const inactiveDetail = await fetch(`http://localhost:${port}/api/products/${inactiveProductId}`);
  assert(inactiveDetail.status === 404, 'public product detail must hide inactive products');
  const inactivePreflight = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [deliveryItem(inactiveProductId)] }, {}, 200);
  assert(inactivePreflight.ok === false && inactivePreflight.lines[0].reason === 'PRODUCT_NOT_ACTIVE', 'inactive product must fail stock preflight');
  await post('/api/dapp/checkout-intent', { buyerAddress: merchantAddress, idempotencyKey: 'backend-check:inactive-product', items: [deliveryItem(inactiveProductId)] }, {}, 400);
  const rejectSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('拒绝后不可复审', { storeId: 'risk-reject' })), merchantHeaders);
  const rejected = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: rejectSubmission.id, decision: 'rejected' }), adminHeaders);
  assert(rejected.status === 'Rejected', 'admin can reject pending product submission');
  await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: rejectSubmission.id, decision: 'approved' }), adminHeaders, 409);
  await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('坏价格提报', { storeId: 'risk-bad-price', priceNpl: 'bad-price' })), merchantHeaders, 400);
  const runnerBeforeCollision = productById(await get('/api/products'), 'p-24k-runner');
  const collisionSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('恶意覆盖官方商品', {
    storeId: 'risk-collision',
    productId: 'p-24k-runner',
    priceNpl: '0.01',
    stock: 9999,
    skus: [{ id: 'sku-runner-42', name: '恶意 SKU', settlementPriceNpl: '0.01', stock: 9999 }]
  })), merchantHeaders);
  const collisionReview = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: collisionSubmission.id, decision: 'approved' }), adminHeaders);
  assert(collisionReview.approvedProduct?.id && collisionReview.approvedProduct.id !== 'p-24k-runner', 'approval should ignore merchant-supplied productId');
  const runnerAfterCollision = productById(await get('/api/products'), 'p-24k-runner');
  assert(runnerAfterCollision.title === runnerBeforeCollision.title && runnerAfterCollision.stock === runnerBeforeCollision.stock && runnerAfterCollision.sellerAddress.toLowerCase() === runnerBeforeCollision.sellerAddress.toLowerCase(), 'malicious productId/SKU collision must not overwrite official product');
  const batchSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('批量审核商品', { storeId: 'risk-batch', priceNpl: '2.00' })), merchantHeaders);
  const batchApprove = await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'review.approve', resource: 'productSubmissions', targetIds: [batchSubmission.id] }), adminHeaders);
  assert(batchApprove.batch?.results?.[0]?.ok && batchApprove.batch.results[0].approvedProductId, 'batch review.approve should create formal product and return per-item result');
  assert(productById(await get('/api/products'), batchApprove.batch.results[0].approvedProductId).title === '批量审核商品', 'batch-approved product should appear in formal product list');
  await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'review.approve', resource: 'productSubmissions', targetIds: ['missing-submission'] }), adminHeaders, 400);
  const soldOutSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('售罄释放商品', { storeId: 'sold-out-store', stock: 1 })), merchantHeaders);
  const soldOutReview = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: soldOutSubmission.id, decision: 'approved' }), adminHeaders);
  const soldOutOrder = await post('/api/orders', { buyerAddress: merchantAddress, idempotencyKey: 'backend-check:sold-out-release', items: [deliveryItem(soldOutReview.approvedProduct.id)] });
  await post('/api/chain-events', fundedEvent(soldOutOrder, hex32('d1'), 89), { 'x-indexer-secret': indexerSecret }, 201);
  const soldOutState = (await get('/api/admin/products/pending', adminHeaders)).find((entry) => entry.id === soldOutSubmission.id);
  assert(soldOutState?.status === 'SoldOut' && !(await get('/api/products')).some((entry) => entry.id === soldOutReview.approvedProduct.id), 'stock reaching zero should mark the formal product and submission SoldOut');
  const replacementSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('售罄后的替换商品', { storeId: 'sold-out-store' })), merchantHeaders);
  assert(replacementSubmission.status === 'PendingReview', 'SoldOut submission should release the one-store-one-product slot');
  const futureStartsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const futureEndsAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const futureSeckill = await post('/api/admin/seckill/schedule', await withSecondary(adminWallet, 'admin.seckill.schedule', { productId: 'p-24k-phone', startsAt: futureStartsAt, endsAt: futureEndsAt, durationSeconds: 3600 }), adminHeaders);
  await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'product.down', resource: 'products', targetIds: ['p-24k-phone'] }), adminHeaders, 400);
  await post('/api/admin/seckill/publish', await withSecondary(adminWallet, 'admin.seckill.publish', { sessionId: futureSeckill.sessionId }), adminHeaders, 409);
  await post('/api/admin/seckill/schedule', await withSecondary(adminWallet, 'admin.seckill.schedule', { productId: 'p-24k-phone', startsAt: futureStartsAt, endsAt: futureEndsAt, durationSeconds: 3600, status: 'live' }), adminHeaders, 409);
  const fartherStartsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const fartherEndsAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
  await post('/api/admin/seckill/schedule', await withSecondary(adminWallet, 'admin.seckill.schedule', { productId: 'p-24k-tea', startsAt: fartherStartsAt, endsAt: fartherEndsAt, durationSeconds: 3600 }), adminHeaders);
  const nextScheduled = await get('/api/seckill/current');
  assert(nextScheduled.session?.id === futureSeckill.sessionId, 'current seckill should choose the nearest upcoming startsAt, not the latest-created schedule');
  const scheduledStartsAt = new Date(Date.now() - 60_000).toISOString();
  const scheduledEndsAt = new Date(Date.now() + 59 * 60_000).toISOString();
  const adminSeckill = await post('/api/admin/seckill/schedule', await withSecondary(adminWallet, 'admin.seckill.schedule', { productId: 'p-24k-runner', startsAt: scheduledStartsAt, endsAt: scheduledEndsAt, durationSeconds: 3600 }), adminHeaders);
  assert(adminSeckill.action === 'admin.seckill.schedule' && adminSeckill.status === 'Scheduled' && !adminSeckill.transactionIntent, 'admin seckill scheduling should remain off-chain until an explicit publish action');
  const scheduledSessions = await get('/api/admin/seckill/sessions', adminHeaders);
  assert(scheduledSessions.some((entry) => entry.id === adminSeckill.sessionId && entry.status === 'scheduled'), 'admin seckill sessions API should expose the persisted schedule');
  const publishSeckill = await post('/api/admin/seckill/publish', await withSecondary(adminWallet, 'admin.seckill.publish', { sessionId: adminSeckill.sessionId }), adminHeaders);
  assert(publishSeckill.status === 'PendingChainConfirmation' && publishSeckill.transactionIntent?.data, 'due seckill schedule should return a startSession owner transaction and stay pending');
  const seckillSessionId = hex32('11');
  const seckillOrderId = hex32('12');
  const chainSessionStartsAt = Math.floor(Date.now() / 1000) - 5;
  const seckillStarted = await post('/api/chain-events', {
    eventName: 'SessionStarted',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId: seckillSessionId,
    productId: hex32('13'),
    productIdText: 'p-24k-runner',
    startsAt: chainSessionStartsAt,
    mainEndsAt: chainSessionStartsAt + 3600,
    relayEndsAt: chainSessionStartsAt + 180,
    minimumNplAmountWei: parseDecimal18('120').toString(),
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: hex32('14'),
    blockNumber: 140,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(seckillStarted.session?.id === seckillSessionId && seckillStarted.session.productId === 'p-24k-runner', 'seckill SessionStarted event should create API session');
  const publishedSchedules = await get('/api/admin/seckill/sessions', adminHeaders);
  const publishedSchedule = publishedSchedules.find((entry) => entry.id === adminSeckill.sessionId);
  assert(publishedSchedule?.status === 'Published' && publishedSchedule.chainSessionId === seckillSessionId, `SessionStarted should link the off-chain schedule to its live chain session: ${JSON.stringify(publishedSchedule)}`);
  await post('/api/chain-events', {
    eventName: 'PurchaseRecorded',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId: seckillSessionId,
    buyer: orderInputPreviewBuyer(),
    orderId: seckillOrderId,
    relayEndsAt: chainSessionStartsAt + 210,
    totalBuys: 1,
    txHash: hex32('15'),
    blockNumber: 141,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  const seckillFeed = await get(`/api/seckill/feed?sessionId=${seckillSessionId}`);
  assert(seckillFeed.feed?.[0]?.orderId === seckillOrderId && seckillFeed.feed[0].totalBuys === 1, 'seckill feed should come from indexed PurchaseRecorded events');
  const seckillFeedStream = await getText(`/api/seckill/feed/stream?sessionId=${seckillSessionId}&once=1`);
  assert(seckillFeedStream.includes('event: snapshot') && seckillFeedStream.includes(seckillOrderId) && seckillFeedStream.includes('24k-seckill-feed-stream-v1'), 'seckill feed stream should emit a DApp rolling-wall snapshot event');
  const regularSeckillPreflight = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [deliveryItem('p-24k-runner')] }, {}, 200);
  assert(regularSeckillPreflight.ok === false && regularSeckillPreflight.lines[0].reason === 'SUPER_SECKILL_LOCKED', 'live seckill product must reject regular stock preflight');
  await post('/api/dapp/checkout-intent', { buyerAddress: merchantAddress, idempotencyKey: 'backend-check:seckill-regular-bypass', items: [deliveryItem('p-24k-runner')] }, {}, 400);
  await post('/api/orders', { buyerAddress: merchantAddress, idempotencyKey: 'backend-check:seckill-direct-bypass', items: [deliveryItem('p-24k-runner')] }, {}, 409);
  const seckillIntent = await post('/api/dapp/seckill-intent', {
    buyerAddress: orderInputPreviewBuyer(),
    idempotencyKey: 'backend-check:dapp-seckill-intent',
    items: [deliveryItem('p-24k-runner')]
  }, {}, 201);
  assert(seckillIntent.seckill?.session?.id === seckillSessionId && seckillIntent.paymentIntent?.payOrderTransaction?.data, 'DApp seckill intent should include current session and payment calldata');
  assert(seckillIntent.seckill?.recordPurchaseTransaction?.to?.toLowerCase() === seckillAddress.toLowerCase() && seckillIntent.nextActions?.includes('sendRecordPurchase'), 'DApp seckill intent should include recordPurchase transaction and next action');
  const seckillIface = new Interface(['function recordPurchase(bytes32 sessionId,bytes32 orderId)']);
  const [intentSessionId, intentSeckillOrderId] = seckillIface.decodeFunctionData('recordPurchase', seckillIntent.seckill.recordPurchaseTransaction.data);
  assert(intentSessionId === seckillSessionId && intentSeckillOrderId === seckillIntent.order.orderId, 'DApp seckill recordPurchase calldata should bind session and checkout order');
  const seckillSettlementTxHash = hex32('1a');
  const seckillRewardOrderId = hex32('17');
  const seckillPrizeReleased = await post('/api/chain-events', {
    eventName: 'SeckillPrizeReleased',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId: seckillSessionId,
    rewardOrderId: seckillRewardOrderId,
    winner: orderInputPreviewBuyer(),
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: seckillSettlementTxHash,
    blockNumber: 142,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(seckillPrizeReleased.prizeReward?.orderId === seckillRewardOrderId && seckillPrizeReleased.prizeReward.state === 'Available', 'SeckillPrizeReleased should create the available NPL prize reward using its reward order id');
  const seckillSettled = await post('/api/chain-events', {
    eventName: 'SessionSettled',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId: seckillSessionId,
    winner: orderInputPreviewBuyer(),
    orderId: seckillOrderId,
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: seckillSettlementTxHash,
    blockNumber: 142,
    logIndex: 1
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(seckillSettled.report?.winningOrderId === seckillOrderId && seckillSettled.report.status === 'settled', 'seckill SessionSettled should create battle report');
  const seckillReport = await get(`/api/seckill/report?sessionId=${seckillSessionId}`);
  assert(seckillReport.status === 'settled' && seckillReport.totalBuys === 1 && seckillReport.prizePoolNpl === 18.88, 'seckill report API should expose the indexed NPL prize pool');
  const seckillWinnerAssets = await get(`/api/assets/summary?address=${orderInputPreviewBuyer()}`);
  const prizeReward = seckillWinnerAssets.ledger.find((entry) => entry.assetSymbol === 'NPL' && entry.orderId === seckillRewardOrderId);
  assert(prizeReward?.state === 'Available' && prizeReward.amount === 18.88, 'SeckillPrizeReleased should create an available NPL seckill prize reward for the winner in local ledger mode');
  assert(seckillWinnerAssets.buckets.some((bucket) => bucket.id === 'seckill-prize' && bucket.available === 18.88 && bucket.docsKey === 'seckill-prize' && bucket.assetSymbol === 'NPL'), 'asset summary should expose the seckill prize NPL bucket');
  assert(seckillWinnerAssets.seckillRecords.some((entry) => entry.orderId === seckillRewardOrderId && entry.prizeClaim?.claimable === true && entry.prizeClaim?.rewardId === prizeReward.id), 'asset summary SeckillPrizeReleased record should expose prize claim intent');
  const prizeClaimIntent = await post('/api/dapp/claim-intent', { walletAddress: orderInputPreviewBuyer(), bucketId: 'seckill-prize', rewardId: prizeReward.id }, {}, 200);
  assert(prizeClaimIntent.assetSymbol === 'NPL' && prizeClaimIntent.submit?.body?.rewardId === prizeReward.id, 'seckill prize should reuse DApp claim intent as an NPL reward');
  await post('/api/admin/force-refund', await withSecondary(adminWallet, 'admin.force-refund', { orderId: finalized.orderId, reason: '未付款订单不能强制退款' }), adminHeaders, 400);
  await post('/api/admin/merchants/review', await withSecondary(adminWallet, 'admin.merchant.review', { merchantId: 'merchant-incomplete', walletAddress: merchantAddress, name: '资质不完整商家', decision: 'approved' }), adminHeaders, 400);
  const pendingMerchantApproval = await post('/api/admin/merchants/review', await withSecondary(adminWallet, 'admin.merchant.review', merchantReviewInput(merchantAddress, { merchantId: 'merchant-abu-24k', name: '24K 官方严选' })), adminHeaders);
  assert(pendingMerchantApproval.status === 'PendingChainApproval' && pendingMerchantApproval.transactionIntent?.data, 'merchant approval should remain pending until the Escrow event is indexed');
  const indexedMerchantApproval = await post('/api/chain-events', {
    eventName: 'SellerApprovalUpdated',
    chainId: 56,
    contractAddress: escrowAddress,
    seller: merchantAddress,
    approved: true,
    txHash: hex32('17'),
    blockNumber: 143,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(indexedMerchantApproval.status === 'Approved', 'SellerApprovalUpdated should activate the merchant whitelist record');
  const ratioConfig = await post('/api/admin/ratio-config', await withSecondary(adminWallet, 'admin.ratio.configure', { bnmRebateRate: 100, nplBurnBps: 7000, beneficiaries: [{ address: adminAddress, weightBps: 10000, role: 'platform' }] }), adminHeaders);
  assert(ratioConfig.status === 'PendingChainConfirmation' && ratioConfig.config?.nplPaymentBps === 10000 && ratioConfig.config?.bnmRebateBps === 10000 && ratioConfig.config?.beneficiaryWeights?.length === 1, 'ratio config should remain pending and preserve the signed NPL allocation payload');
  const indexedRatioConfig = await post('/api/chain-events', {
    eventName: 'SplitConfigUpdated',
    chainId: 56,
    contractAddress: escrowAddress,
    splitVersion: 1,
    configHash: ratioConfig.config.configHash,
    txHash: hex32('18'),
    blockNumber: 144,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(indexedRatioConfig.splitVersion === 1 && indexedRatioConfig.config?.status === 'Active', 'SplitConfigUpdated should promote the matching pending config');
  const ratioProducts = await get('/api/products');
  const ratioRunner = productById(ratioProducts, 'p-24k-runner');
  assert(ratioRunner.nplRatio === 100 && ratioRunner.paymentRatioBps?.nplPaymentBps === 10000 && ratioRunner.paymentRatioBps?.source === 'admin-config', 'products API should keep the effective NPL-only ratio config');
  const ratioDetail = await get('/api/products/p-24k-runner');
  assert(ratioDetail.fiveFactorTemplate.payment === '100% NPL', 'product detail five-factor payment should stay NPL-only');
  const ratioPreflight = await post('/api/stock/preflight', { buyerAddress: merchantAddress, items: [deliveryItem('p-24k-runner')] }, {}, 200);
  assert(ratioPreflight.lines[0].fiveFactors.payment === '100% NPL', 'stock preflight should match the NPL-only ratio');
  assert(ratioPreflight.quote?.amountNpl === '120.000000000000000000' && ratioPreflight.quote?.bnmLocked === '120.000000000000000000', 'stock preflight quote should remain fully NPL funded');
  assert(ratioPreflight.lines[0].quote?.amountNpl === '120.000000000000000000' && ratioPreflight.lines[0].quote?.nplPaymentBps === 10000, 'stock preflight line quote should remain 100% NPL');
  assert(ratioPreflight.quote?.approval?.type === 'unlimited-npl' && ratioPreflight.quote?.approval?.amount === 'MaxUint256', 'stock preflight quote should retain one unlimited NPL approval after ratio update');
  const checkoutIntent = await post('/api/dapp/checkout-intent', {
    buyerAddress: orderInputPreviewBuyer(),
    idempotencyKey: 'backend-check:dapp-checkout-intent',
    items: [deliveryItem('p-24k-bag')]
  }, {}, 201);
  assert(checkoutIntent.preflight?.ok && checkoutIntent.finalCheck?.passed && checkoutIntent.order?.status === 'Draft', 'DApp checkout intent should run preflight and create a draft order');
  assert(checkoutIntent.paymentIntent?.approvalPolicy?.type === 'unlimited-npl' && checkoutIntent.paymentIntent?.allowanceChecks?.length === 1 && checkoutIntent.paymentIntent?.approvalTransactions?.length === 1 && checkoutIntent.paymentIntent?.payOrderTransaction?.data, 'DApp checkout intent should return one NPL allowance/approval and payment calldata');
  assert(checkoutIntent.nextActions?.includes('pollFundingStatus') && checkoutIntent.endpoints?.fundingStatus?.includes('/fund-tx-status'), 'DApp checkout intent should return frontend next actions and polling endpoint');
  const previewAfterRatio = await getText('/preview');
  assert(previewAfterRatio.includes('100% NPL'), 'preview HTML should display the NPL-only payment policy');
  const adminBundleAfterRatio = await getText('/backstage/admin.js');
  assert(adminBundleAfterRatio.includes('NPL 支付比例（bps）') && adminBundleAfterRatio.includes('config.nplPaymentBps ?? 10000'), 'admin application should render the NPL-only payment policy from the live config API');
  const unavailablePrizePool = await post('/api/admin/prize-pool', await withSecondary(adminWallet, 'admin.prize-pool.inject', { amountNpl: '10' }), adminHeaders, 409);
  assert(unavailablePrizePool.error === 'REWARD_LEDGER_ADDRESS_NOT_CONFIGURED', 'prize-pool injection must not fake success before RewardLedger is configured');
  const adminSearch = await get('/api/admin/search?q=24K', adminHeaders);
  assert(adminSearch.results?.products?.length >= 1 && adminSearch.batchActions?.includes('export.csv'), 'admin search should expose global results and batch actions');
  const adminAndSearch = await get(`/api/admin/search?logic=AND&orderId=${encodeURIComponent(seckillIntent.order.orderId)}&productId=p-24k-runner&wallet=${encodeURIComponent(orderInputPreviewBuyer())}`, adminHeaders);
  assert(adminAndSearch.filters?.logic === 'AND' && adminAndSearch.filters?.orderId === seckillIntent.order.orderId.toLowerCase() && adminAndSearch.results?.orders?.length === 1, 'admin AND search should apply exact order/product/wallet filters in the backend');
  const adminOrSearch = await get('/api/admin/search?logic=OR&orderId=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff&productId=p-24k-runner', adminHeaders);
  assert(adminOrSearch.filters?.logic === 'OR' && adminOrSearch.results?.products?.some((entry) => entry.id === 'p-24k-runner'), 'admin OR search should return entities matching any exact field');
  const adminBatch = await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'export.csv', resource: 'products', targetIds: ['p-24k-runner'] }), adminHeaders);
  assert(adminBatch.batch?.status === 'Accepted' && adminBatch.batch?.exportFile?.endsWith('.csv') && adminBatch.batch?.download?.contentBase64, 'admin batch should return a real export artifact for selected targets');
  const exportedCsv = Buffer.from(adminBatch.batch.download.contentBase64, 'base64').toString('utf8');
  assert(exportedCsv.includes('p-24k-runner') && !exportedCsv.includes('p-24k-phone'), 'admin export must contain only explicitly selected targets');
  const adminExcel = await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'export.excel', resource: 'products', targetIds: ['p-24k-runner'] }), adminHeaders);
  assertValidXlsxArtifact(adminExcel.batch.download, 'admin Excel export', 'p-24k-runner');
  await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', { operation: 'export.csv', resource: 'products', targetIds: [] }), adminHeaders, 400);
  await post('/api/admin/blacklist', await withSecondary(adminWallet, 'admin.blacklist.update', { address: '0x9999999999999999999999999999999999999999' }), adminHeaders);
  await post('/api/admin/logistics', await withSecondary(adminWallet, 'admin.logistics.configure', { carrier: 'SF' }), adminHeaders);
  await post('/api/admin/cms', await withSecondary(adminWallet, 'admin.cms.publish', { key: 'rules', text: '24K 秒杀规则' }), adminHeaders);
  await post('/api/admin/cms', await withSecondary(adminWallet, 'admin.cms.publish', { key: 'home-banner', title: '大连自提专场', text: '24K 大连门店自提', placement: 'banner', regionCodes: ['210211'], frequency: 'daily', mediaUrl: 'https://cdn.example.test/banner.png' }), adminHeaders);
  await post('/api/admin/cms', await withSecondary(adminWallet, 'admin.cms.publish', { key: 'app-update', title: '版本升级', text: '请升级后继续使用', placement: 'update', minAppVersion: '2.0.0', forceUpdate: true, frequency: 'once' }), adminHeaders);
  const seckillRules = await get('/api/seckill/rules');
  assert(seckillRules.version === '24k-seckill-rules-v1' && seckillRules.body === '24K 秒杀规则' && seckillRules.actions?.reports === '/api/seckill/reports', 'DApp seckill rules should expose latest CMS rules and report-history action');
  const placements = await get('/api/cms/placements?regionCode=210211&appVersion=1.0.0');
  assert(placements.placements?.some((entry) => entry.key === 'home-banner' && entry.placement === 'banner') && placements.blockingUpdate?.key === 'app-update', 'public CMS placements should apply region targeting and expose a blocking forced update');
  const otherRegionPlacements = await get('/api/cms/placements?regionCode=110105&appVersion=2.0.0');
  assert(!otherRegionPlacements.placements?.some((entry) => entry.key === 'home-banner') && !otherRegionPlacements.blockingUpdate, 'CMS placements should exclude other regions and stop blocking at the minimum version');
  const seckillCurrentAfterCms = await get('/api/seckill/current');
  assert(seckillCurrentAfterCms.rules?.body === '24K 秒杀规则' && Array.isArray(seckillCurrentAfterCms.reportHistory), 'current seckill payload should bundle rules and report history for DApp modals');
  const seckillReports = await get('/api/seckill/reports');
  assert(seckillReports.version === '24k-seckill-report-history-v1' && Array.isArray(seckillReports.reports) && seckillReports.reports.length >= 1, 'DApp seckill report history should expose modal-ready battle reports');
  await post('/api/admin/messages', await withSecondary(adminWallet, 'admin.message.notify', { title: '24K 通知', text: '后台真实通知投递测试', channels: ['in-app'], audience: 'all' }), adminHeaders);
  const merchantLevels = await post('/api/admin/merchant-levels', await withSecondary(adminWallet, 'admin.merchant.levels.configure', { v1PriceLimitNpl: '10', v1SeckillQuota: 2, v5PriceLimitNpl: '1000', v5SeckillQuota: 20 }), adminHeaders);
  assert(merchantLevels.config?.v1PriceLimitNpl === '10.000000000000000000' && merchantLevels.config?.v5SeckillQuota === 20, 'merchant level matrix should persist validated NPL limits and quotas');
  const riskPolicies = await post('/api/admin/risk/policies', await withSecondary(adminWallet, 'admin.risk.policies.configure', { maxGasGwei: 8, walletSwitchesPerMinute: 5, cancellationsPerFiveMinutes: 3, fulfillmentChangesPerFiveMinutes: 3, tradeLockMinutes: 30, blockContractCallers: true, flashLoanDetection: true }), adminHeaders);
  assert(riskPolicies.config?.walletSwitchesPerMinute === 5 && riskPolicies.config?.flashLoanDetection === true && riskPolicies.transactionIntent?.key === 'seckillSetMaxGasPrice', 'risk policy endpoint should persist controls and return the owner transaction for the onchain gas ceiling');
  const logisticsTemplate = await post('/api/admin/logistics/templates', await withSecondary(adminWallet, 'admin.logistics.template.upsert', { id: 'template-standard', name: '标准运费', chargeMode: 'quantity', baseFeeNpl: '1', incrementFeeNpl: '0.1', blockedRegionCodes: ['110101'], dalianPickupFree: true }), adminHeaders);
  assert(logisticsTemplate.template?.baseFeeNpl === '1.000000000000000000', 'logistics template should persist exact NPL fees');
  const logisticsAddress = await post('/api/admin/logistics/addresses', await withSecondary(adminWallet, 'admin.logistics.address.upsert', { id: 'address-main', type: 'shipping', name: '主发货仓', contactName: '运营', phone: '13800000000', regionCode: '210211', address: '辽宁省大连市高新区软件园路 1 号', enabled: true }), adminHeaders);
  assert(logisticsAddress.address?.regionCode === '210211', 'logistics address should persist a six-digit region code');
  const rejectedLogisticsSecret = await post('/api/admin/logistics/credentials', await withSecondary(adminWallet, 'admin.logistics.credentials.configure', { carrier: 'SF', provider: 'kuaidi100', secret: 'must-not-persist' }), adminHeaders, 400);
  assert(rejectedLogisticsSecret.error === 'SECRETS_MUST_USE_ENV', 'logistics credentials endpoint must reject database secrets');
  const logisticsCredentials = await post('/api/admin/logistics/credentials', await withSecondary(adminWallet, 'admin.logistics.credentials.configure', { carrier: 'SF', provider: 'kuaidi100', partnerId: 'partner-test', monthlyAccount: 'monthly-test', electronicWaybill: true }), adminHeaders);
  assert(logisticsCredentials.config?.credentialsSource === 'environment' && logisticsCredentials.config?.secret === undefined, 'logistics config should only persist non-secret metadata');
  const rejectedGatewaySecret = await post('/api/admin/messages/gateways', await withSecondary(adminWallet, 'admin.message.gateway.configure', { smsProvider: 'aliyun', smsSecret: 'must-not-persist' }), adminHeaders, 400);
  assert(rejectedGatewaySecret.error === 'SECRETS_MUST_USE_ENV', 'message gateway endpoint must reject database secrets');
  await post('/api/admin/messages/gateways', await withSecondary(adminWallet, 'admin.message.gateway.configure', { smsProvider: 'aliyun', smtpHost: 'smtp.example.test', smtpUser: 'mailer', pushProvider: 'firebase' }), adminHeaders);

  await post('/api/admin/merchants/review', await withSecondary(adminWallet, 'admin.merchant.review', merchantReviewInput(platformSellerWallet.address, { merchantId: 'merchant-platform-seller', name: '平台代运营商家' })), adminHeaders);
  await post('/api/chain-events', {
    eventName: 'SellerApprovalUpdated',
    chainId: 56,
    contractAddress: escrowAddress,
    seller: platformSellerWallet.address,
    approved: true,
    txHash: hex32('19'),
    blockNumber: 145,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret }, 201);
  await post('/api/admin/categories/upsert', await withSecondary(adminWallet, 'admin.category.upsert', { id: 'cat-home', name: '家居', level: 1 }), adminHeaders);
  await post('/api/admin/categories/upsert', await withSecondary(adminWallet, 'admin.category.upsert', { id: 'cat-home-life', name: '生活用品', level: 2, parentId: 'cat-home' }), adminHeaders);
  await post('/api/admin/categories/upsert', await withSecondary(adminWallet, 'admin.category.upsert', { id: 'cat-home-life-cup', name: '杯具', level: 3, parentId: 'cat-home-life' }), adminHeaders);
  await post('/api/admin/tags/upsert', await withSecondary(adminWallet, 'admin.tag.upsert', { id: 'tag-new', name: '新品' }), adminHeaders);
  const adminProduct = await post('/api/admin/products', await withSecondary(adminWallet, 'admin.product.create', { title: '24K 平台代上架商品', sellerAddress: platformSellerWallet.address, categoryId: 'cat-home-life-cup', tags: ['tag-new'], imageUrl: 'https://cdn.example.test/product.png', imageUrls: ['https://cdn.example.test/product.png'], descriptionHtml: '<p>平台代上架商品</p>', fulfillmentModes: ['delivery'], skus: [{ id: 'standard', name: '标准款', stock: 3, settlementPriceNpl: '2.5' }] }), adminHeaders);
  assert(adminProduct.product?.status === 'Active' && adminProduct.product?.sellerAddress?.toLowerCase() === platformSellerWallet.address.toLowerCase() && adminProduct.product?.tagIds?.includes('tag-new'), 'admin product creation should enforce approved seller, taxonomy, SKU and NPL pricing');
  await post('/api/admin/tags/delete', await withSecondary(adminWallet, 'admin.tag.delete', { id: 'tag-new' }), adminHeaders, 423);
  const updatedAdminProduct = await post('/api/admin/products/update', await withSecondary(adminWallet, 'admin.product.update', { productId: adminProduct.product.id, priceNpl: '3.25', stock: 4 }), adminHeaders);
  assert(updatedAdminProduct.product?.priceNpl === 3.25 && updatedAdminProduct.product?.stock === 4 && updatedAdminProduct.historyRecorded, 'admin product update should persist price and inventory');
  const productHistory = await get(`/api/admin/products/history?productId=${encodeURIComponent(adminProduct.product.id)}`, adminHeaders);
  assert(productHistory.some((entry) => entry.change?.oldValue?.stock === 3 && entry.change?.newValue?.stock === 4 && entry.signatureHash), 'admin product history should preserve signed old/new snapshots');
  const deletedAdminProduct = await post('/api/admin/products/delete', await withSecondary(adminWallet, 'admin.product.delete', { productId: adminProduct.product.id, reason: '生命周期回归' }), adminHeaders);
  assert(deletedAdminProduct.product?.status === 'Inactive', 'admin product delete should soft-delete without removing history');

  const multisigBody = {
    safeAddress: multisigAddress,
    signerAddress: adminAddress,
    safeTxHash: hex32('f1'),
    txHash: hex32('f2'),
    action: 'escrow.setSplitConfig',
    decision: 'executed',
    signedAt: new Date().toISOString(),
    approvalSignature: adminWallet.signingKey.sign(hex32('f1')).serialized
  };
  const rejectedMultisigOwner = await post('/api/integrations/multisig/approval', { ...multisigBody, safeAddress: '0x9999999999999999999999999999999999999999' }, { 'x-multisig-secret': multisigCallbackSecret }, 403);
  assert(rejectedMultisigOwner.error === 'MULTISIG_OWNER_MISMATCH', 'multisig callback must reject approvals for an unconfigured owner address');
  const rejectedMultisigSigner = await post('/api/integrations/multisig/approval', { ...multisigBody, approvalSignature: blacklistedWallet.signingKey.sign(multisigBody.safeTxHash).serialized }, { 'x-multisig-secret': multisigCallbackSecret }, 401);
  assert(rejectedMultisigSigner.error === 'MULTISIG_SIGNER_MISMATCH', 'multisig callback must reject a signature that does not recover the declared owner');
  const multisigApproval = await post('/api/integrations/multisig/approval', multisigBody, { 'x-multisig-secret': multisigCallbackSecret }, 202);
  assert(multisigApproval.duplicate === false && multisigApproval.signatureHash && multisigApproval.execution?.status === 'Finalized', 'multisig callback should verify owner signature and finalized Safe execution before appending proof');
  const duplicateMultisigApproval = await post('/api/integrations/multisig/approval', multisigBody, { 'x-multisig-secret': multisigCallbackSecret }, 202);
  assert(duplicateMultisigApproval.duplicate === true, 'multisig approval callback should be idempotent per safe transaction and signer');
  const multisigApprovals = await get('/api/admin/multisig/approvals', adminHeaders);
  assert(multisigApprovals.some((entry) => entry.safeTxHash === multisigBody.safeTxHash.toLowerCase() && entry.approvalAction === multisigBody.action), 'admin should query recorded multisig approvals');

  const savedTemplates = await get('/api/admin/logistics/templates', adminHeaders);
  const savedAddresses = await get('/api/admin/logistics/addresses', adminHeaders);
  const messageDeliveries = await get('/api/admin/messages', adminHeaders);
  const messageGateways = await get('/api/admin/messages/gateways', adminHeaders);
  const auditStreams = await get('/api/admin/audit-streams', adminHeaders);
  const savedConfigs = await get('/api/admin/configs', adminHeaders);
  assert(savedTemplates.some((entry) => entry.id === 'template-standard') && savedAddresses.some((entry) => entry.id === 'address-main'), 'admin logistics reads should return persisted templates and addresses');
  assert(messageDeliveries.some((entry) => entry.title === '24K 通知') && Array.isArray(messageGateways.channels), 'admin message reads should return real deliveries and gateway readiness');
  assert(auditStreams.some((entry) => entry.id === 'admin' && entry.readOnly === true) && savedConfigs.some((entry) => entry.key === 'merchant-levels') && savedConfigs.some((entry) => entry.key === 'risk-policies'), 'admin audit streams and config reads should expose persisted control-plane state');
  const audit = await get('/api/admin/audit-logs', adminHeaders);
  assert(audit.some((entry) => entry.action === 'merchant.product.submit') && audit.some((entry) => entry.action === 'admin.message.notify'), 'audit logs should include merchant and admin sensitive actions');

  const orderInput = {
    buyerAddress: merchantAddress,
    idempotencyKey: 'backend-check:p-24k-runner:1',
    items: [deliveryItem('p-24k-runner')]
  };
  await post('/api/orders', { ...orderInput, idempotencyKey: 'backend-check:bad-quantity', items: [deliveryItem('p-24k-runner', { quantity: 1.5 })] }, {}, 400);
  await post('/api/orders', { ...orderInput, idempotencyKey: 'backend-check:oversized-body', note: 'x'.repeat(300_000) }, {}, 413);

  const firstOrder = await post('/api/orders', orderInput);
  const secondOrder = await post('/api/orders', orderInput);
  assert(firstOrder.orderId === secondOrder.orderId, 'idempotent draft order should return same orderId');
  await post('/api/orders', { ...orderInput, items: [deliveryItem('p-24k-phone')] }, {}, 409);
  const crossBuyerOrder = await post('/api/orders', { ...orderInput, buyerAddress: blacklistedWallet.address }, buyerHeaders, 403);
  assert(crossBuyerOrder.error === 'BUYER_ADDRESS_MISMATCH', 'buyer JWT must not create an order for another wallet');
  assert(firstOrder.amountNpl === '120.000000000000000000', '24K order should carry the full NPL amount');
  assert(firstOrder.sellerAddress.toLowerCase() === merchantAddress.toLowerCase(), 'seller should use configured merchant address');
  const paymentIntent = await get(`/api/orders/${firstOrder.orderId}/payment-intent?buyerAddress=${orderInput.buyerAddress}`);
  assert(paymentIntent.approvalPolicy?.type === 'unlimited-npl' && paymentIntent.allowanceChecks?.length === 1 && paymentIntent.approvalTransactions?.length === 1, 'DApp payment intent should require one NPL allowance check and one approval');
  assert(paymentIntent.fundingStatusEndpoint?.includes('/fund-tx-status'), 'DApp payment intent should expose a funding tx status endpoint');
  const erc20 = new Interface(['function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)']);
  const escrow = new Interface(['function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)']);
  const nplApprove = paymentIntent.approvalTransactions.find((tx) => tx.key === 'npl');
  assert(nplApprove?.from?.toLowerCase() === orderInput.buyerAddress.toLowerCase() && nplApprove.to.toLowerCase() === fixedNplAddress(), 'NPL approval tx should bind buyer and fixed token');
  const [approveSpender, approveAmount] = erc20.decodeFunctionData('approve', nplApprove.data);
  assert(String(approveSpender).toLowerCase() === escrowAddress.toLowerCase() && approveAmount === MaxUint256, 'NPL approval tx should approve escrow for MaxUint256');
  const [allowanceOwner, allowanceSpender] = erc20.decodeFunctionData('allowance', paymentIntent.allowanceChecks[0].data);
  assert(String(allowanceOwner).toLowerCase() === orderInput.buyerAddress.toLowerCase() && String(allowanceSpender).toLowerCase() === escrowAddress.toLowerCase(), 'NPL allowance call should check buyer to escrow');
  const [intentOrderId, intentSeller, intentProductId, intentNplAmount, intentBnmLocked, intentDeadline, intentDigest, intentSplitVersion, intentAuthorization] = escrow.decodeFunctionData('payOrder', paymentIntent.payOrderTransaction.data);
  assert(intentOrderId === firstOrder.orderId && String(intentSeller).toLowerCase() === merchantAddress.toLowerCase(), 'payment intent payOrder should bind order and seller');
  assert(/^0x[0-9a-fA-F]{64}$/.test(intentProductId) && intentNplAmount === parseUnits(firstOrder.amountNpl, 18) && intentBnmLocked === parseUnits(firstOrder.bnmLocked, 18), 'payment intent payOrder should bind product, NPL and BNM amounts');
  assert(intentDigest === firstOrder.orderDigest && intentDeadline > BigInt(Math.floor(Date.now() / 1000)) && intentSplitVersion === 1n, 'payment intent payOrder should bind digest, future deadline and split version');
  assert(/^0x[0-9a-fA-F]{130}$/.test(intentAuthorization) && paymentIntent.payOrderTransaction.orderSigner.toLowerCase() === localOrderSigner.address.toLowerCase(), 'payment intent should contain webhook signer authorization');
  await fetch(`http://localhost:${port}/api/orders/${firstOrder.orderId}/payment-intent?buyerAddress=${blacklistedWallet.address}`, { headers: buyerHeaders }).then(async (response) => {
    assert(response.status === 403, 'payment intent should reject wrong buyer');
  });
  const unconfiguredFundingStatus = await get(`/api/orders/${firstOrder.orderId}/fund-tx-status?buyerAddress=${orderInput.buyerAddress}&txHash=0x7777777777777777777777777777777777777777777777777777777777777777`);
  assert(['pending', 'rpc_unavailable'].includes(unconfiguredFundingStatus.status) && unconfiguredFundingStatus.retryable === true, 'funding tx status should be retryable before a payment receipt is available');
  const buyerOrders = await get(`/api/buyer/orders?buyerAddress=${orderInput.buyerAddress}`);
  assert(buyerOrders.some((order) => order.orderId === firstOrder.orderId && order.fulfillment?.type === 'delivery'), 'buyer orders API should list the connected wallet orders');
  const connectedAssets = await get(`/api/assets/summary?address=${orderInput.buyerAddress}`);
  assert(connectedAssets.orders?.some((order) => order.orderId === firstOrder.orderId) && connectedAssets.shoppingRecords?.some((row) => row.orderId === firstOrder.orderId), 'asset summary should aggregate connected buyer orders and shopping records');
  const connectedAssetOrder = connectedAssets.orders.find((order) => order.orderId === firstOrder.orderId);
  assert(connectedAssetOrder?.primaryAction?.key === 'payOrder' && connectedAssetOrder.actions?.payment?.available === true, 'asset summary order card should expose DApp payment action while draft');
  assert(connectedAssets.shoppingRecords.find((row) => row.orderId === firstOrder.orderId)?.dapp?.primaryAction?.key === 'payOrder', 'asset summary shopping record should expose DApp primary action');
  assert(connectedAssets.orderStateCounts?.pendingPayment >= 1 && connectedAssets.actions?.timeoutRefundRequest === '/api/dapp/timeout-refund-request', 'asset summary should expose order state counts and DApp actions for the assets tab');
  const buyerOrdersViaOrdersRoute = await get(`/api/orders?buyerAddress=${orderInput.buyerAddress}`);
  assert(buyerOrdersViaOrdersRoute.some((order) => order.orderId === firstOrder.orderId), 'orders API should support buyer-scoped list for DApp while keeping admin list protected');
  const dustSubmission = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', merchantProductInput('1 wei dust 商品', { storeId: 'risk-dust', priceNpl: '0.000000000000000001' })), merchantHeaders);
  const dustApproval = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', { productId: dustSubmission.id, decision: 'approved' }), adminHeaders);
  const dustOrder = await post('/api/orders', { buyerAddress: orderInput.buyerAddress, idempotencyKey: 'backend-check:dust', items: [deliveryItem(dustApproval.approvedProduct.id)] });
  assert(parseDecimal18(dustOrder.amountNpl) === 1n, 'NPL amount should keep exact 1 wei precision without dust loss');

  const merchantOrders = await get('/api/merchant/orders', merchantHeaders);
  assert(merchantOrders.some((order) => order.orderId === firstOrder.orderId), 'merchant orders API should expose merchant orders');
  await post(`/api/merchant/orders/${firstOrder.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', { trackingNo: 'UNPAID' }), merchantHeaders, 400);

  const noBuyerOrderLookup = await fetch(`http://localhost:${port}/api/orders/${firstOrder.orderId}`);
  assert(noBuyerOrderLookup.status === 401, 'single order lookup should require buyer address or admin secret');
  const wrongBuyerOrderLookup = await fetch(`http://localhost:${port}/api/orders/${firstOrder.orderId}`, { headers: blacklistedBuyerHeaders });
  assert(wrongBuyerOrderLookup.status === 403, 'single order lookup should reject a different buyer wallet');
  const publicList = await fetch(`http://localhost:${port}/api/orders`);
  assert(publicList.status === 401, 'order list must require admin secret');

  const event = fundedEvent(firstOrder, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 123);
  await post('/api/chain-events', legacyFundedEvent(firstOrder, '0x9999999999999999999999999999999999999999999999999999999999999999', 122), { 'x-indexer-secret': indexerSecret }, 400);
  const recorded = await post('/api/chain-events', event, { 'x-indexer-secret': indexerSecret }, 201);
  await post('/api/admin/products/delete', await withSecondary(adminWallet, 'admin.product.delete', { productId: 'p-24k-runner', reason: '锁定资产不得下架' }), adminHeaders, 423);
  assert(recorded.order.status === 'PaidLocked', 'OrderPaid should move order to PaidLocked');
  const confirmedFundingStatus = await get(`/api/orders/${firstOrder.orderId}/fund-tx-status?buyerAddress=${orderInput.buyerAddress}&txHash=${event.txHash}`);
  assert(confirmedFundingStatus.status === 'confirmed' && confirmedFundingStatus.order.status === 'PaidLocked', 'funding tx status should report confirmed after OrderPaid is indexed');
  const paidRetry = await post('/api/orders', orderInput);
  assert(paidRetry.orderId === firstOrder.orderId && paidRetry.status === 'PaidLocked', 'idempotent retry after payment should return existing paid order, not create a duplicate draft');
  assert(recorded.order.amountNpl === firstOrder.amountNpl, 'funded order should retain the exact NPL amount');
  const fundedProducts = await get('/api/products');
  assert(productById(fundedProducts, 'p-24k-runner').stock === runner.stock - 1, 'OrderPaid should deduct 24K stock');
  const shipped = await post(`/api/merchant/orders/${firstOrder.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', { trackingNo: 'SF123456789' }), merchantHeaders, 200);
  assert(shipped.trackingNo === 'SF123456789' && shipped.status === 'Shipped', 'merchant ship API should accept paid secondary signed shipment');
  const fulfillment = await get(`/api/orders/${firstOrder.orderId}/fulfillment?buyerAddress=${orderInput.buyerAddress}`);
  assert(fulfillment.fulfillments.some((entry) => entry.status === 'Shipped') && fulfillment.logistics.some((entry) => entry.trackingNo === 'SF123456789'), 'fulfillment snapshot should expose shipment chain');
  assert(fulfillment.version === '24k-fulfillment-snapshot-v1' && fulfillment.confirmability?.canComplete === true && fulfillment.completeOrderCall?.available === true, 'fulfillment snapshot should expose DApp confirmability and complete-order call');
  assert(fulfillment.releasePreview?.stateBeforeComplete === 'Locked' && fulfillment.releasePreview?.stateAfterComplete === 'Available' && fulfillment.nextActions?.includes('createCompleteOrderIntent'), 'fulfillment snapshot should expose BNM release preview and DApp next actions');

  const pickupFulfillmentOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:pickup-fulfillment',
    items: [pickupItem('p-24k-tea')]
  });
  await post('/api/chain-events', fundedEvent(pickupFulfillmentOrder, '0x3131313131313131313131313131313131313131313131313131313131313131', 131), { 'x-indexer-secret': indexerSecret }, 201);
  const pickupBeforeVerify = await get(`/api/orders/${pickupFulfillmentOrder.orderId}/fulfillment?buyerAddress=${orderInput.buyerAddress}`);
  assert(pickupBeforeVerify.current?.status === 'AwaitingPickupVerification' && pickupBeforeVerify.confirmability?.reason === 'WAITING_FOR_PICKUP_VERIFICATION', 'pickup fulfillment should wait for merchant verification before buyer completion');
  const pickupCode = pickupBeforeVerify.current?.payload?.pickupCode;
  assert(/^\d{6}$/.test(String(pickupCode || '')), 'paid pickup fulfillment should expose the buyer pickup code');
  await post(`/api/merchant/orders/${pickupFulfillmentOrder.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', { trackingNo: 'PICKUP-SHOULD-NOT-SHIP' }), merchantHeaders, 400);
  const pickupVerified = await post('/api/merchant/pickup/verify', await withSecondary(merchantWallet, 'merchant.pickup.verify', { orderId: pickupFulfillmentOrder.orderId, storeId: 'store-dl-gaoxin', code: pickupCode }), merchantHeaders);
  assert(pickupVerified.status === 'PickupReady' && pickupVerified.storeId === 'store-dl-gaoxin', 'pickup verify should bind the paid pickup store');
  const pickupFulfillment = await get(`/api/orders/${pickupFulfillmentOrder.orderId}/fulfillment?buyerAddress=${orderInput.buyerAddress}`);
  assert(pickupFulfillment.pickups.some((entry) => entry.code === pickupCode) && pickupFulfillment.fulfillments.some((entry) => entry.status === 'VerifiedAwaitingSettlement') && !pickupFulfillment.current?.payload?.pickupCode, 'fulfillment snapshot should expose pickup verification, clear the one-time code and enter pending settlement');
  assert(pickupFulfillment.confirmability?.canComplete === true && pickupFulfillment.releaseStatus?.mode === 'pickup', 'pickup fulfillment should enable complete-order after merchant verification');

  const duplicate = await post('/api/chain-events', event, { 'x-indexer-secret': indexerSecret }, 200);
  assert(duplicate.duplicate === true, 'duplicate txHash/logIndex should be idempotent');
  const forcedRefund = forcedRefundEvent(firstOrder, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 124);
  const refunded = await post('/api/chain-events', forcedRefund, { 'x-indexer-secret': indexerSecret }, 201);
  assert(refunded.order.status === 'ForcedRefunded', 'OrderForcedRefunded should move order to ForcedRefunded');
  const restoredProducts = await get('/api/products');
  assert(productById(restoredProducts, 'p-24k-runner').stock === runner.stock, 'OrderForcedRefunded should restore deducted stock');

  const completedOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:completed',
    items: [deliveryItem('p-24k-phone')]
  });
  await post('/api/chain-events', fundedEvent(completedOrder, '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 125), { 'x-indexer-secret': indexerSecret }, 201);
  const completed = await post('/api/chain-events', completedEvent(completedOrder, '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 126), { 'x-indexer-secret': indexerSecret }, 201);
  assert(completed.order.status === 'Released', 'OrderCompleted should move order to Released');
  await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:completed',
    items: [deliveryItem('p-24k-phone')]
  }, {}, 409);

  const teaBefore = productById(await get('/api/products'), 'p-24k-tea').stock;
  const emergencyOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:emergency',
    items: [deliveryItem('p-24k-tea')]
  });
  await post('/api/chain-events', fundedEvent(emergencyOrder, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 127), { 'x-indexer-secret': indexerSecret }, 201);
  const emergencyRefunded = await post('/api/chain-events', emergencyRefundEvent(emergencyOrder, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 128), { 'x-indexer-secret': indexerSecret }, 201);
  assert(emergencyRefunded.order.status === 'EmergencyRefunded', 'OrderEmergencyRefunded should move order to EmergencyRefunded');
  assert(productById(await get('/api/products'), 'p-24k-tea').stock === teaBefore, 'OrderEmergencyRefunded should restore deducted stock');

  const adminRefundOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:admin-force-refund',
    items: [deliveryItem('p-24k-bag')]
  });
  await post('/api/chain-events', fundedEvent(adminRefundOrder, '0xabababababababababababababababababababababababababababababababab', 129), { 'x-indexer-secret': indexerSecret }, 201);
  const rejectedPartialRefund = await post('/api/admin/force-refund', await withSecondary(adminWallet, 'admin.force-refund', { orderId: adminRefundOrder.orderId, reason: '部分退款不允许', refundNplAmount: '1' }), adminHeaders, 400);
  assert(rejectedPartialRefund.error === 'FULL_REFUND_ONLY', 'admin force refund must reject caller-controlled partial refund amounts');
  const adminForceRefund = await post('/api/admin/force-refund', await withSecondary(adminWallet, 'admin.force-refund', { orderId: adminRefundOrder.orderId, reason: '7 天未发货' }), adminHeaders);
  assert(adminForceRefund.status === 'RefundRequested', 'admin force refund should wait for chain event before terminal status');
  const forceRefundInterface = new Interface(['function forceRefund(bytes32 orderId)']);
  const [forcedRefundOrderId] = forceRefundInterface.decodeFunctionData('forceRefund', adminForceRefund.transactionIntent.data);
  assert(forcedRefundOrderId === adminRefundOrder.orderId && adminForceRefund.transactionIntent.fullRefundNpl === adminRefundOrder.amountNpl, 'admin force refund calldata must use the frozen one-argument full refund ABI');
  const adminRefunded = await post('/api/chain-events', forcedRefundEvent(adminRefundOrder, '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 130), { 'x-indexer-secret': indexerSecret }, 201);
  assert(adminRefunded.order.status === 'ForcedRefunded', 'OrderForcedRefunded event should finalize admin force refund');

  const timeoutRefundOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:buyer-timeout-refund',
    items: [deliveryItem('p-24k-bag')]
  });
  await post('/api/chain-events', fundedEvent(timeoutRefundOrder, '0x1313131313131313131313131313131313131313131313131313131313131313', 132), { 'x-indexer-secret': indexerSecret }, 201);
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'business-parameters',
    value: { shippingTimeoutHours: 1, confirmationTimeoutHours: 1, siweNonceTtlMinutes: 10, actionIntentTtlMinutes: 10, claimRequestTtlMinutes: 10 }
  }), adminHeaders);
  backdateOrderBy(timeoutRefundOrder.orderId, 2 * 60 * 60_000);
  const timeoutActions = await get(`/api/orders/${timeoutRefundOrder.orderId}/timeout-actions?buyerAddress=${orderInput.buyerAddress}`);
  assert(timeoutActions.buyerTimeoutRefund?.eligible === true && timeoutActions.buyerTimeoutRefund.clock?.windowHours === 1 && timeoutActions.policy?.noUserNoReasonRefund === true, 'runtime shipping timeout should take effect immediately without enabling no-reason refunds');
  const timeoutRefundPayload = { buyerAddress: orderInput.buyerAddress, orderId: timeoutRefundOrder.orderId, reason: '7 天未发货' };
  const buyerTimeoutRefund = await post('/api/dapp/timeout-refund-request', await withSecondary(merchantWallet, 'buyer.timeout-refund.request', timeoutRefundPayload), buyerHeaders);
  assert(buyerTimeoutRefund.status === 'RefundRequested' && buyerTimeoutRefund.noUserNoReasonRefund === true, 'buyer timeout refund request should create RefundRequested without enabling no-reason refunds');
  const timeoutAdminForce = await post('/api/admin/force-refund', await withSecondary(adminWallet, 'admin.force-refund', { orderId: timeoutRefundOrder.orderId, reason: '7 天未发货' }), adminHeaders);
  assert(timeoutAdminForce.status === 'RefundRequested', 'admin force refund should accept buyer timeout RefundRequested order');
  const timeoutRefunded = await post('/api/chain-events', { ...forcedRefundEvent(timeoutRefundOrder, '0x1414141414141414141414141414141414141414141414141414141414141414', 133), logIndex: 1 }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(timeoutRefunded.order.status === 'ForcedRefunded', 'OrderForcedRefunded should finalize buyer timeout refund');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'business-parameters',
    value: { shippingTimeoutHours: 168, confirmationTimeoutHours: 168, siweNonceTtlMinutes: 10, actionIntentTtlMinutes: 10, claimRequestTtlMinutes: 10 }
  }), adminHeaders);

  const forceSignOrder = await post('/api/orders', {
    buyerAddress: orderInput.buyerAddress,
    idempotencyKey: 'backend-check:merchant-force-sign',
    items: [deliveryItem('p-24k-phone')]
  });
  await post('/api/chain-events', { ...fundedEvent(forceSignOrder, '0x1515151515151515151515151515151515151515151515151515151515151515', 134), logIndex: 1 }, { 'x-indexer-secret': indexerSecret }, 201);
  await post(`/api/merchant/orders/${forceSignOrder.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', { trackingNo: 'FORCE-SIGN-001' }), merchantHeaders, 200);
  backdateFulfillmentForTimeout(forceSignOrder.orderId);
  const forceSignActions = await get(`/api/orders/${forceSignOrder.orderId}/timeout-actions?buyerAddress=${orderInput.buyerAddress}`);
  assert(forceSignActions.merchantForceSign?.eligible === true && forceSignActions.merchantForceSign?.resultStatus === 'Arbitration', 'timeout actions should allow merchant force-sign after 7-day receipt timeout');
  const forceSignRequest = await post(`/api/merchant/orders/${forceSignOrder.orderId}/force-sign-request`, await withSecondary(merchantWallet, 'merchant.order.force-sign-request', { reason: '7 天未确认收货' }), merchantHeaders);
  assert(forceSignRequest.status === 'Arbitration' && forceSignRequest.chainActionRequired?.includes('completeOrder'), 'merchant force-sign request should move order to Arbitration for platform owner completion');
  const forceSignCompleted = await post('/api/chain-events', { ...completedEvent(forceSignOrder, '0x1616161616161616161616161616161616161616161616161616161616161616', 135), logIndex: 1 }, { 'x-indexer-secret': indexerSecret }, 201);
  assert(forceSignCompleted.order.status === 'Released', 'OrderCompleted should finalize platform force-sign completion');

  const merchantInsights = await get(`/api/admin/merchant-insights?walletAddress=${encodeURIComponent(merchantAddress)}`, adminHeaders);
  assert(merchantInsights.orders.total >= 1 && merchantInsights.npl.grossFlow && merchantInsights.rewards.fiveStates.Locked && merchantInsights.afterSales.refunds >= 1, 'admin merchant insights should reconcile orders, NPL, SLA, refunds and five-state rewards');
  let mismatchedReconciliation;
  setOrderFundTxHash(firstOrder.orderId, hex32('bad-reconciliation'));
  try {
    mismatchedReconciliation = await get('/api/admin/reconciliation', adminHeaders);
  } finally {
    setOrderFundTxHash(firstOrder.orderId, event.txHash);
  }
  assert(mismatchedReconciliation.status === 'AttentionRequired' && mismatchedReconciliation.mismatches.some((entry) => entry.eventName === 'OrderPaid' && entry.target === firstOrder.orderId && entry.reasons?.includes('TX_HASH_MISMATCH')), 'reconciliation must fail a known-bad order funding TxHash sample');
  const reconciliation = await get('/api/admin/reconciliation', adminHeaders);
  assert(reconciliation.status === 'Reconciled' && reconciliation.checked >= 1 && Array.isArray(reconciliation.records) && reconciliation.records.every((entry) => entry.match) && reconciliation.circuitSnapshot.length === 4, 'admin reconciliation should match finalized chain amounts, state and tx hashes to order/ledger deltas and include breaker state');
  backdateAuthSessionsFor(merchantAddress);
  await siweLogin(merchantWallet, 'buyer');
  const finalAdminSummary = await get('/api/admin/summary', adminHeaders);
  const riskFields = ['pendingClaims', 'failedTransactions', 'anomalies', 'blacklisted', 'botEvents', 'pausedCircuits'];
  assert(finalAdminSummary.stats.walletUids === 3 && finalAdminSummary.today.newWalletUids === 2, `admin summary should count a returning wallet once and preserve its original first-seen date: ${JSON.stringify({ walletUids: finalAdminSummary.stats.walletUids, newWalletUids: finalAdminSummary.today.newWalletUids })}`);
  assert(finalAdminSummary.riskWaterline && riskFields.every((field) => Number.isFinite(finalAdminSummary.riskWaterline[field])) && Array.isArray(finalAdminSummary.circuits), 'admin summary should expose claims, failed transactions, anomalies, blacklist, bot and circuit waterlines');
  const qualifiedMerchants = await get('/api/admin/merchants', adminHeaders);
  const qualifiedMerchant = qualifiedMerchants.find((entry) => entry.walletAddress.toLowerCase() === merchantAddress.toLowerCase());
  assert(qualifiedMerchant?.qualificationReady === true && qualifiedMerchant.payload?.qualification?.contactPhoneMasked && !qualifiedMerchant.payload.qualification.contactPhone && qualifiedMerchant.payload.qualification.legalIdentityHash, 'merchant qualifications should be validated and sensitive contact data masked in admin reads');

  const completeCsvExport = await post('/api/merchant/export', await withSecondary(merchantWallet, 'merchant.orders.export', { format: 'csv', filters: {} }), merchantHeaders, 200);
  assert(completeCsvExport.content.includes(firstOrder.orderId) && completeCsvExport.content.includes('SF123456789') && completeCsvExport.content.includes('13800000001') && completeCsvExport.content.includes(',1,'), 'merchant CSV export should use persisted quantity, order time, logistics and delivery contact fields');
  const completeXlsxExport = await post('/api/merchant/export', await withSecondary(merchantWallet, 'merchant.orders.export', { format: 'excel', filters: {} }), merchantHeaders, 200);
  assertValidXlsxArtifact(completeXlsxExport, 'merchant complete XLSX export', firstOrder.orderId);

  const rejectedContractMapping = await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'contracts',
    value: { nplAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2', bnmAddress: '0x7777777777777777777777777777777777777777' }
  }), adminHeaders, 400);
  assert(rejectedContractMapping.error.startsWith('CONTRACT_CODE_NOT_FOUND'), 'runtime contract mapping must reject an address without deployed code');
  const contractRuntimeConfig = { nplAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2', bnmAddress, escrowAddress, seckillAddress, rewardLedgerAddress };
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'contracts',
    value: contractRuntimeConfig
  }), adminHeaders);
  const runtimePublicConfig = await get('/api/config');
  assert(runtimePublicConfig.bnmAddress === bnmAddress.toLowerCase() && runtimePublicConfig.rewardLedgerAddress === rewardLedgerAddress.toLowerCase(), 'validated contract mappings should be consumed by public runtime config');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', {
    key: 'contracts',
    value: { nplAddress: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2' }
  }), adminHeaders);
  const clearedContractConfig = await get('/api/config');
  assert(clearedContractConfig.bnmAddress === '', 'clearing contract mappings must restore the environment fallback instead of retaining stale addresses');
  await post('/api/admin/system-config', await withSecondary(adminWallet, 'admin.system.configure', { key: 'contracts', value: contractRuntimeConfig }), adminHeaders);

  const finalAudit = await get('/api/admin/audit-logs', adminHeaders);
  assert(finalAudit.some((entry) => entry.action === 'admin.force-refund'), 'audit logs should include admin force refund action');
  assert(finalAudit.some((entry) => entry.action === 'buyer.timeout-refund.request') && finalAudit.some((entry) => entry.action === 'merchant.order.force-sign-request'), 'audit logs should include timeout refund and merchant force-sign actions');
  const merchantReviewAudits = finalAudit.filter((entry) => entry.action.startsWith('admin.merchant.review'));
  assert(merchantReviewAudits.length > 0 && !JSON.stringify(merchantReviewAudits).includes('210202199001010011') && !JSON.stringify(merchantReviewAudits).includes('13800000000'), 'append-only merchant review audits must not retain raw legal identity or contact phone');

  const residue = JSON.stringify({ rootHtml, previewHtml, products, messages });
  for (const marker of [['DI','OR'].join(''), ['88','VIP'].join(''), ['天','猫'].join('')]) assert(!residue.includes(marker), `legacy marker should not leak: ${marker}`);

  console.log('backend check: PASS');
} finally {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  await localOrderSigner.close();
  await runtimeMock.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function fundedEvent(order, txHash, blockNumber) {
  return {
    eventName: 'OrderPaid',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash,
    blockNumber,
    logIndex: 0,
    buyer: order.buyerAddress,
    seller: order.sellerAddress,
    nplAmountWei: parseDecimal18(order.amountNpl).toString(),
    bnmLockedWei: parseDecimal18(order.bnmLocked || order.amountNpl).toString(),
    amountNpl: order.amountNpl,
    orderDigest: order.orderDigest,
    splitVersion: 1
  };
}

function legacyFundedEvent(order, txHash, blockNumber) {
  return {
    eventName: 'OrderFunded',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash,
    blockNumber,
    logIndex: 0,
    buyer: order.buyerAddress,
    seller: order.sellerAddress,
    amountWei: parseDecimal18(order.amountNpl).toString(),
    amountNpl: order.amountNpl,
    orderDigest: order.orderDigest
  };
}

function forcedRefundEvent(order, txHash, blockNumber) {
  const refundedNpl = parseDecimal18(order.amountNpl);
  return {
    eventName: 'OrderForcedRefunded',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash,
    blockNumber,
    logIndex: 0,
    buyer: order.buyerAddress,
    refundedNplWei: refundedNpl.toString(),
    amountNpl: order.amountNpl,
    burnedRewards: 1
  };
}

function completedEvent(order, txHash, blockNumber) {
  return {
    eventName: 'OrderCompleted',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash,
    blockNumber,
    logIndex: 0,
    seller: order.sellerAddress,
    amountWei: parseDecimal18(order.amountNpl).toString(),
    amountNpl: order.amountNpl,
    splitVersion: 1
  };
}

function emergencyRefundEvent(order, txHash, blockNumber) {
  return {
    eventName: 'OrderEmergencyRefunded',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash,
    blockNumber,
    logIndex: 0,
    buyer: order.buyerAddress,
    refundedNplWei: parseDecimal18(order.amountNpl).toString(),
    amountNpl: order.amountNpl,
    burnedRewards: 1,
    emergency: true
  };
}

async function siweLogin(wallet, role) {
  const nonce = await post('/api/auth/siwe/nonce', { address: wallet.address, role });
  const signature = await wallet.signMessage(nonce.message);
  const session = await post('/api/auth/siwe/verify', { address: wallet.address, role, message: nonce.message, signature });
  actionTokens.set(`${role}:${wallet.address.toLowerCase()}`, session.token);
  return session;
}

async function assertStrictSiweValidation(wallet) {
  const cases = [
    {
      expected: 'SIWE_URI_MISMATCH',
      mutate: (message) => message.replace(/^URI: .*$/m, 'URI: https://evil.example')
    },
    {
      expected: 'SIWE_CHAIN_ID_MISMATCH',
      mutate: (message) => message.replace(/^Chain ID: .*$/m, 'Chain ID: 1')
    },
    {
      expected: 'SIWE_RESOURCES_MISMATCH',
      mutate: (message) => message.replace(/\nResources:\n- urn:24k:role:merchant$/, '')
    }
  ];
  for (const testCase of cases) {
    const challenge = await post('/api/auth/siwe/nonce', { address: wallet.address, role: 'merchant' });
    const message = testCase.mutate(challenge.message);
    const signature = await wallet.signMessage(message);
    const rejected = await post('/api/auth/siwe/verify', { address: wallet.address, role: 'merchant', message, signature }, {}, 401);
    assert(rejected.error === testCase.expected, `strict SIWE parser should reject ${testCase.expected}`);
  }
}

async function assertSiweNonceReplayIsAtomic(wallet) {
  const challenge = await post('/api/auth/siwe/nonce', { address: wallet.address, role: 'buyer' });
  const signature = await wallet.signMessage(challenge.message);
  const request = () => fetch(`http://localhost:${port}/api/auth/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, role: 'buyer', message: challenge.message, signature })
  });
  const responses = await Promise.all([request(), request()]);
  const statuses = responses.map((response) => response.status).sort((left, right) => left - right);
  assert(statuses[0] === 201 && statuses[1] === 401, `SIWE nonce must be consumed by exactly one concurrent verification: ${statuses.join(',')}`);
}

async function assertAuditFailureBlocksBusinessMutation(wallet, headers) {
  const value = { shippingTimeoutHours: 2, confirmationTimeoutHours: 2, siweNonceTtlMinutes: 5, actionIntentTtlMinutes: 5, claimRequestTtlMinutes: 5 };
  const signed = await withSecondary(wallet, 'admin.system.configure', { key: 'business-parameters', value });
  const auditLock = new DatabaseSync(`${dbPath}.audit.db`);
  auditLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  try {
    await post('/api/admin/system-config', signed, headers, 500);
  } finally {
    auditLock.exec('ROLLBACK');
    auditLock.close();
  }
  const checkDb = new DatabaseSync(dbPath);
  try {
    const persisted = checkDb.prepare("SELECT key FROM admin_configs WHERE key = 'business-parameters'").get();
    assert(!persisted, 'business mutation must not commit when the required attempted-action audit cannot be written');
  } finally {
    checkDb.close();
  }
}

async function assertAdminSiweRequiresConfiguredWallet() {
  const testPort = await availablePort();
  const testDbPath = resolve(tempDir, 'check-admin-auth.db');
  rmSync(testDbPath, { force: true });
  let testStderr = '';
  const testServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'development',
      PORT: String(testPort),
      DB_PATH: testDbPath,
      MICRO_TEST: 'false',
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      MERCHANT_RECEIVER_ADDRESS: merchantAddress,
      ADMIN_SECRET: adminSecret,
      ADMIN_WALLET_ADDRESS: '',
      JWT_SECRET: 'local-jwt-secret-no-admin-wallet',
      INDEXER_SECRET: indexerSecret,
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  testServer.stderr.on('data', (chunk) => { testStderr += chunk; });
  try {
    await waitForHealth(testPort, () => testStderr);
    const wallet = Wallet.createRandom();
    const response = await fetch(`http://localhost:${testPort}/api/auth/siwe/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, role: 'admin' })
    });
    const payload = await response.json().catch(() => ({}));
    assert(response.status === 503 && payload.error === 'ADMIN_WALLET_NOT_CONFIGURED', 'admin SIWE should be closed when ADMIN_WALLET_ADDRESS is missing');
  } finally {
    testServer.kill('SIGTERM');
    setTimeout(() => testServer.kill('SIGKILL'), 1_000).unref();
    await sleep(100);
    rmSync(testDbPath, { force: true });
  }
}

async function assertDuplicateSubmissionMigration() {
  const testPort = await availablePort();
  const testDbPath = resolve(tempDir, 'check-duplicate-submissions.db');
  rmSync(testDbPath, { force: true });
  const sqlite = new DatabaseSync(testDbPath);
  sqlite.exec(`
    CREATE TABLE product_submissions (
      id TEXT PRIMARY KEY,
      merchant_address TEXT NOT NULL,
      store_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      locked_at TEXT,
      immutable_payload_json TEXT,
      approved_product_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  sqlite.prepare('INSERT INTO product_submissions (id, merchant_address, store_id, title, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-old', merchantAddress.toLowerCase(), 'legacy-store', '旧提报', 'PendingReview', '{}', '2026-07-01T00:00:00.000Z');
  sqlite.prepare('INSERT INTO product_submissions (id, merchant_address, store_id, title, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-new', merchantAddress.toLowerCase(), 'legacy-store', '新提报', 'PendingReview', '{}', '2026-07-02T00:00:00.000Z');
  sqlite.close();

  let testStderr = '';
  const testServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'development',
      PORT: String(testPort),
      DB_PATH: testDbPath,
      MICRO_TEST: 'false',
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      MERCHANT_RECEIVER_ADDRESS: merchantAddress,
      ADMIN_SECRET: adminSecret,
      ADMIN_WALLET_ADDRESS: adminAddress,
      JWT_SECRET: 'local-jwt-secret-duplicate-migration',
      INDEXER_SECRET: indexerSecret,
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  testServer.stderr.on('data', (chunk) => { testStderr += chunk; });
  try {
    await waitForHealth(testPort, () => testStderr);
  } finally {
    testServer.kill('SIGTERM');
    setTimeout(() => testServer.kill('SIGKILL'), 1_000).unref();
    await sleep(100);
  }

  const checkDb = new DatabaseSync(testDbPath);
  try {
    const rows = checkDb.prepare('SELECT id, status FROM product_submissions WHERE id IN (?, ?) ORDER BY id').all('legacy-new', 'legacy-old');
    assert(rows.some((row) => row.id === 'legacy-new' && row.status === 'PendingReview'), 'duplicate active migration should keep latest active submission');
    assert(rows.some((row) => row.id === 'legacy-old' && row.status === 'Superseded'), 'duplicate active migration should mark older submission Superseded');
  } finally {
    checkDb.close();
    rmSync(testDbPath, { force: true });
  }
}

async function assertProductionSecretsFailClosed() {
  const testPort = await availablePort();
  const testDbPath = resolve(tempDir, 'check-production-secrets.db');
  rmSync(testDbPath, { force: true });
  let output = '';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(testPort),
      DB_PATH: testDbPath,
      PRIVATE_KEY: '',
      DEPLOYER_PRIVATE_KEY: '',
      OWNER_PRIVATE_KEY: '',
      JWT_SECRET: '',
      ADMIN_SECRET: '',
      INDEXER_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const exitCode = await waitForChildExit(child, 'production server did not fail closed');
    assert(exitCode !== 0 && output.includes('PRODUCTION_CONFIGURATION_INVALID') && output.includes('JWT_SECRET') && output.includes('ADMIN_SECRET') && output.includes('INDEXER_SECRET'), 'production server should reject each missing server secret before listening');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(testDbPath, { force: true });
  }
}

async function assertProductionDistinctSecretsFailClosed() {
  const testPort = await availablePort();
  const sharedSecret = 'same-production-secret-value-1234567890';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'production',
      PORT: String(testPort),
      JWT_SECRET: sharedSecret,
      ADMIN_SECRET: sharedSecret,
      INDEXER_SECRET: sharedSecret
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const exitCode = await waitForChildExit(child, 'production distinct-secret check did not exit');
  assert(exitCode !== 0 && childStderr.includes('SERVER_SECRETS_MUST_BE_DISTINCT'), 'production must reject shared JWT, admin and indexer secrets');
}

async function assertOnchainSeckillPrizeRewardSync() {
  const testPort = await availablePort();
  const testDbPath = resolve(tempDir, 'check-onchain-seckill-prize.db');
  const sessionId = hex32('a1');
  const rewardOrderId = hex32('a2');
  const prizeAmount = '18.880000000000000000';
  let testStderr = '';
  rmSync(testDbPath, { force: true });
  const testServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIVATE_KEY: '',
      NODE_ENV: 'development',
      PORT: String(testPort),
      DB_PATH: testDbPath,
      MICRO_TEST: 'false',
      EXPO_PUBLIC_ESCROW_ADDRESS: escrowAddress,
      EXPO_PUBLIC_SECKILL_ADDRESS: seckillAddress,
      EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
      REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
      EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
      MERCHANT_RECEIVER_ADDRESS: merchantAddress,
      ADMIN_WALLET_ADDRESS: adminAddress,
      JWT_SECRET: 'local-jwt-secret-seckill-prize',
      INDEXER_SECRET: indexerSecret,
      ADMIN_SECRET: adminSecret,
      CHAIN_EVENT_RPC_URL: '',
      BSC_RPC_URL: '',
      EXPO_PUBLIC_BSC_RPC_URL: '',
      ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  testServer.stderr.on('data', (chunk) => { testStderr += chunk; });
  try {
    await waitForHealth(testPort, () => testStderr);
    const prizeEvent = await postAt(testPort, '/api/chain-events', {
      eventName: 'SeckillPrizeReleased',
      chainId: 56,
      contractAddress: seckillAddress,
      sessionId,
      rewardOrderId,
      winner: merchantAddress,
      prizePoolNplWei: parseDecimal18(prizeAmount).toString(),
      txHash: hex32('a3'),
      blockNumber: 501,
      logIndex: 0
    }, { 'x-indexer-secret': indexerSecret }, 201);
    assert(prizeEvent.prizeReward?.state === 'PendingRewardLocked', 'onchain seckill prize should wait for RewardLocked');

    const rejected = await postAt(testPort, '/api/chain-events', {
      eventName: 'RewardLocked',
      chainId: 56,
      contractAddress: rewardLedgerAddress,
      entryId: '7',
      orderId: rewardOrderId,
      user: blacklistedWallet.address,
      asset: fixedNplAddress(),
      amountWei: parseDecimal18(prizeAmount).toString(),
      bucket: 5,
      txHash: hex32('a4'),
      blockNumber: 502,
      logIndex: 0
    }, { 'x-indexer-secret': indexerSecret }, 400);
    assert(rejected.error === 'SECKILL_PRIZE_REWARD_USER_MISMATCH', 'synthetic seckill reward must match the indexed winner');

    const locked = await postAt(testPort, '/api/chain-events', {
      eventName: 'RewardLocked',
      chainId: 56,
      contractAddress: rewardLedgerAddress,
      entryId: '7',
      orderId: rewardOrderId,
      user: merchantAddress,
      asset: fixedNplAddress(),
      amountWei: parseDecimal18(prizeAmount).toString(),
      bucket: 5,
      txHash: hex32('a5'),
      blockNumber: 502,
      logIndex: 1
    }, { 'x-indexer-secret': indexerSecret }, 201);
    assert(locked.reward?.state === 'Locked' && locked.reward?.bucketId === 'seckill-prize', 'RewardLocked should persist the synthetic seckill prize entry');

    const released = await postAt(testPort, '/api/chain-events', {
      eventName: 'RewardReleased',
      chainId: 56,
      contractAddress: rewardLedgerAddress,
      entryId: '7',
      orderId: rewardOrderId,
      txHash: hex32('a6'),
      blockNumber: 502,
      logIndex: 2
    }, { 'x-indexer-secret': indexerSecret }, 201);
    assert(released.reward?.state === 'Available' && released.reward?.bucketId === 'seckill-prize', 'RewardReleased should make the synthetic seckill prize claimable');
  } finally {
    testServer.kill('SIGTERM');
    setTimeout(() => testServer.kill('SIGKILL'), 1_000).unref();
    await sleep(100);
    rmSync(testDbPath, { force: true });
  }
}

function waitForChildExit(child, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(timeoutMessage));
    }, 5_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function backdateOrderBy(orderId, elapsedMs) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    const old = new Date(Date.now() - elapsedMs).toISOString();
    checkDb.prepare('UPDATE orders SET updated_at = ? WHERE order_id = ?').run(old, orderId);
    checkDb.prepare('UPDATE fulfillment_orders SET created_at = ? WHERE order_id = ?').run(old, orderId);
  } finally {
    checkDb.close();
  }
}

function backdateAuthSessionsFor(address) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    checkDb.prepare("UPDATE auth_sessions SET created_at = datetime('now', '-2 days') WHERE lower(address) = ?").run(address.toLowerCase());
  } finally {
    checkDb.close();
  }
}

function setOrderFundTxHash(orderId, txHash) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    checkDb.prepare('UPDATE orders SET fund_tx_hash = ? WHERE order_id = ?').run(txHash, orderId);
  } finally {
    checkDb.close();
  }
}

function backdateFulfillmentForTimeout(orderId) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    checkDb.prepare('UPDATE orders SET updated_at = ? WHERE order_id = ?').run(old, orderId);
    checkDb.prepare("UPDATE fulfillment_orders SET created_at = ? WHERE order_id = ? AND status IN ('Shipped', 'PickupReady')").run(old, orderId);
  } finally {
    checkDb.close();
  }
}

async function withSecondary(wallet, action, body) {
  const role = action.split('.')[0];
  const token = actionTokens.get(`${role}:${wallet.address.toLowerCase()}`);
  assert(token, `missing SIWE JWT for ${wallet.address}`);
  const intent = await post('/api/auth/action-intent', { action, payload: body }, authHeaders(token), 201);
  assert(intent.action === action && intent.walletAddress?.toLowerCase() === wallet.address.toLowerCase(), 'action-intent should bind action and SIWE wallet');
  assert(intent.payloadHash === payloadHashForSignature(body) && intent.signatureKind === 'personal_sign', 'action-intent should bind the exact payload hash and signature kind');
  assert(intent.submitBody?.secondaryMessage === intent.secondaryMessage && intent.submitBody?.secondarySignature === '<wallet-signature>', 'action-intent should return the bound submit body template');
  const secondarySignature = await wallet.signMessage(intent.secondaryMessage);
  return { ...body, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

async function withLocallyGeneratedSecondary(wallet, action, body) {
  const expiresAt = Date.now() + 10 * 60_000;
  const secondaryMessage = [
    '24K Mall Secondary Authorization',
    `Action: ${action}`,
    `Wallet: ${wallet.address.toLowerCase()}`,
    'ChainId: 56',
    `PayloadHash: ${payloadHashForSignature(body)}`,
    `Nonce: local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    `ExpiresAt: ${expiresAt}`
  ].join('\n');
  const secondarySignature = await wallet.signMessage(secondaryMessage);
  return { ...body, secondaryMessage, secondarySignature };
}

function payloadHashForSignature(body) {
  return `0x${createHash('sha256').update(stableStringify(body || {})).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function waitForHealth(targetPort = port, stderrProvider = () => stderr) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`http://localhost:${targetPort}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become healthy. stderr: ${stderrProvider()}`);
}

async function get(path, headers = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, { headers: buyerAuthorization(headers) });
  if (!response.ok) {
    const body = await response.text();
    assert(false, `GET ${path} failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function getText(path) {
  const response = await fetch(`http://localhost:${port}${path}`);
  assert(response.ok, `GET ${path} failed: ${response.status}`);
  return response.text();
}

async function post(path, body, headers = {}, expected = 201) {
  const resolvedBody = await body;
  const response = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(resolvedBody)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expected, `POST ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postAt(targetPort, path, body, headers = {}, expected = 201) {
  const response = await fetch(`http://localhost:${targetPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(await body)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expected, `POST ${path} on ${targetPort} expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function patch(path, body, headers = {}, expected = 200) {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expected, `PATCH ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function buyerAuthorization(headers) {
  if (!defaultBuyerToken || headers.authorization) return headers;
  return { authorization: `Bearer ${defaultBuyerToken}`, ...headers };
}

function productById(products, id) {
  const product = products.find((entry) => entry.id === id);
  assert(product, `missing product ${id}`);
  return product;
}

function fixedNplAddress() {
  return '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
}

function deliveryItem(productId, overrides = {}) {
  return {
    productId,
    quantity: 1,
    selected: true,
    fulfillmentMode: 'delivery',
    addressId: 'addr-default',
    regionCode: '210211',
    ...overrides
  };
}

function merchantProductInput(title, overrides = {}) {
  const {
    sku = '标准 SKU',
    priceNpl = '1.00',
    stock = 10,
    ...rest
  } = overrides;
  return {
    title,
    imageUrls: ['https://cdn.example.test/products/24k-product.png'],
    descriptionHtml: '<p>24K 商家商品详情</p>',
    fulfillmentModes: ['delivery'],
    skus: [{ id: 'sku-main', name: sku, settlementPriceNpl: priceNpl, stock }],
    ...rest
  };
}

function merchantStoreInput(overrides = {}) {
  return {
    storeId: 'store-test',
    name: '24K 测试自提店',
    regionCode: '210211',
    city: '大连市',
    address: '辽宁省大连市高新区软件园路 1 号',
    hours: '09:00-21:00',
    phone: '13800000000',
    lat: 38.86,
    lng: 121.52,
    photos: ['https://cdn.example.test/stores/24k-store.png'],
    ...overrides
  };
}

function merchantReviewInput(walletAddress, overrides = {}) {
  return {
    merchantId: `merchant-${walletAddress.slice(2, 10).toLowerCase()}`,
    walletAddress,
    name: '24K 审核商家',
    decision: 'approved',
    businessLicenseNumber: '91210200MA24K00001',
    businessLicenseUrl: 'https://cdn.example.test/licenses/merchant-license.png',
    legalRepresentative: '张三',
    legalIdentity: '210202199001010011',
    contactName: '李四',
    contactPhone: '13800000000',
    settlementWallet: walletAddress,
    ...overrides
  };
}

function setSubmissionStatus(id, status) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    checkDb.prepare('UPDATE product_submissions SET status = ? WHERE id = ?').run(status, id);
  } finally {
    checkDb.close();
  }
}

function assertValidXlsxArtifact(artifact, label, expectedText = '') {
  assert(artifact?.fileName?.endsWith('.xlsx'), `${label} should use .xlsx`);
  assert(artifact?.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${label} should use the XLSX MIME type`);
  assert(artifact?.encoding === 'base64' && artifact.contentBase64, `${label} should return base64 binary content`);
  const entries = unzipSync(Buffer.from(artifact.contentBase64, 'base64'));
  assert(entries['[Content_Types].xml'] && entries['xl/workbook.xml'] && entries['xl/worksheets/sheet1.xml'], `${label} should contain required OOXML parts`);
  const sheet = strFromU8(entries['xl/worksheets/sheet1.xml']);
  assert(sheet.includes('<worksheet') && (!expectedText || sheet.includes(expectedText)), `${label} worksheet content mismatch`);
}

function pickupItem(productId, overrides = {}) {
  return {
    productId,
    quantity: 1,
    selected: true,
    fulfillmentMode: 'pickup',
    storeId: 'store-dl-gaoxin',
    regionCode: '210211',
    ...overrides
  };
}

function orderInputPreviewBuyer() {
  return merchantAddress;
}

function hex32(byte) {
  return `0x${String(byte).repeat(64).slice(0, 64)}`;
}

function parseDecimal18(value) {
  const text = String(value);
  if (!/^[0-9]+(\.[0-9]{0,18})?$/.test(text)) throw new Error(`invalid decimal ${value}`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole || '0') * 10n ** 18n + BigInt(`${fraction}000000000000000000`.slice(0, 18));
}

async function startRuntimeMock(port) {
  const oracleAddress = '0x6666666666666666666666666666666666666666';
  const oracle = new Interface([
    'function decimals() view returns (uint8)',
    'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)'
  ]);
  const escrow = new Interface(['function currentSplitVersion() view returns (uint32)']);
  const safeMultisig = new Interface([
    'function isOwner(address owner) view returns (bool)',
    'event ExecutionSuccess(bytes32 txHash,uint256 payment)'
  ]);
  const contractAddresses = new Set([
    '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    bnmAddress,
    escrowAddress,
    seckillAddress,
    rewardLedgerAddress,
    multisigAddress
  ].map((address) => address.toLowerCase()));
  const counts = { primaryRpc: 0, fallbackRpc: 0, redis: 0, mq: 0, redisAuthorization: '', mqAuthorization: '' };
  const server = createHttpServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/redis-health') {
      counts.redis += 1;
      counts.redisAuthorization = String(req.headers.authorization || '');
      return sendMockJson(res, 200, { ok: true, keyspace_hits: 90, keyspace_misses: 10 });
    }
    if (req.method === 'GET' && req.url === '/mq-health') {
      counts.mq += 1;
      counts.mqAuthorization = String(req.headers.authorization || '');
      return sendMockJson(res, 200, { ok: true, queue_totals: { messages: 7, messages_ready: 5, messages_unacknowledged: 2 } });
    }
    if (req.method === 'POST' && req.url === '/rpc-primary') {
      counts.primaryRpc += 1;
      return sendMockJson(res, 503, { error: 'primary unavailable' });
    }
    if (req.method === 'POST' && req.url === '/rpc-wrong-chain') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw || '{}');
      return sendMockJson(res, 200, { jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x1' : null });
    }
    if (req.method === 'POST' && req.url === '/rpc-fallback') {
      counts.fallbackRpc += 1;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw || '{}');
      let result;
      if (request.method === 'eth_chainId') result = '0x38';
      else if (request.method === 'eth_blockNumber') result = '0x64';
      else if (request.method === 'eth_gasPrice') result = '0x3b9aca00';
      else if (request.method === 'eth_getCode') result = contractAddresses.has(String(request.params?.[0] || '').toLowerCase()) ? '0x6000' : '0x';
      else if (request.method === 'eth_getTransactionReceipt') {
        const transactionHash = String(request.params?.[0] || '').toLowerCase();
        if (transactionHash !== hex32('f2').toLowerCase()) result = null;
        else {
          const execution = safeMultisig.encodeEventLog(safeMultisig.getEvent('ExecutionSuccess'), [hex32('f1'), 0n]);
          result = {
            transactionHash,
            status: '0x1',
            to: multisigAddress,
            blockNumber: '0x50',
            blockHash: hex32('f3'),
            logs: [{ address: multisigAddress, topics: execution.topics, data: execution.data }]
          };
        }
      }
      else if (request.method === 'eth_call') {
        const data = String(request.params?.[0]?.data || '').toLowerCase();
        if (data === oracle.encodeFunctionData('decimals').toLowerCase()) result = oracle.encodeFunctionResult('decimals', [8]);
        else if (data === oracle.encodeFunctionData('latestRoundData').toLowerCase()) {
          const updatedAt = BigInt(Math.floor(Date.now() / 1000) - 5);
          result = oracle.encodeFunctionResult('latestRoundData', [10n, 200_000_000n, updatedAt, updatedAt, 10n]);
        } else if (data === escrow.encodeFunctionData('currentSplitVersion').toLowerCase()) {
          result = escrow.encodeFunctionResult('currentSplitVersion', [1]);
        } else if (data.startsWith(safeMultisig.getFunction('isOwner').selector.toLowerCase())) {
          const [owner] = safeMultisig.decodeFunctionData('isOwner', data);
          result = safeMultisig.encodeFunctionResult('isOwner', [String(owner).toLowerCase() === adminAddress.toLowerCase()]);
        } else return sendMockJson(res, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown eth_call' } });
      } else return sendMockJson(res, 200, { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unknown method' } });
      return sendMockJson(res, 200, { jsonrpc: '2.0', id: request.id, result });
    }
    return sendMockJson(res, 404, { error: 'not found' });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    primaryRpcUrl: `${baseUrl}/rpc-primary`,
    fallbackRpcUrl: `${baseUrl}/rpc-fallback`,
    wrongChainRpcUrl: `${baseUrl}/rpc-wrong-chain`,
    redisHealthUrl: `${baseUrl}/redis-health`,
    mqHealthUrl: `${baseUrl}/mq-health`,
    oracleAddress,
    counts,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

function sendMockJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', rejectPort);
    probe.listen(0, '::', () => {
      const address = probe.address();
      const selectedPort = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? rejectPort(error) : resolvePort(selectedPort));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

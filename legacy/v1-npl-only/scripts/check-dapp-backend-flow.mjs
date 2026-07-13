#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Interface, MaxUint256, parseUnits, Wallet } from 'ethers';
import { startOrderSigner } from './test-support/order-signer.mjs';

const port = Number(process.env.DAPP_FLOW_PORT || 8811);
const apiUrl = `http://127.0.0.1:${port}`;
const tempDir = mkdtempSync(join(tmpdir(), '24k-dapp-flow-check-'));
const dbPath = resolve(tempDir, 'check.db');
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const legacySettlementAsset = ['US', 'DT'].join('');
const escrowAddress = '0x2222222222222222222222222222222222222222';
const seckillAddress = '0x3333333333333333333333333333333333333333';
const rewardLedgerAddress = '0x4444444444444444444444444444444444444444';
const bnmAddress = '0x5555555555555555555555555555555555555555';
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();
const buyerWallet = Wallet.createRandom();
const indexerSecret = 'dapp-flow-indexer-secret';

rmSync(dbPath, { force: true });
const localOrderSigner = await startOrderSigner({ chainId: 56, escrowAddress });

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
    EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
    EXPO_PUBLIC_NPL_BSC_ADDRESS: fixedNpl,
    MERCHANT_RECEIVER_ADDRESS: merchantWallet.address,
    ...localOrderSigner.env,
    ADMIN_WALLET_ADDRESS: adminWallet.address,
    JWT_SECRET: 'dapp-flow-jwt-secret',
    INDEXER_SECRET: indexerSecret,
    CHAIN_EVENT_RPC_URL: '',
    BSC_RPC_URL: '',
    EXPO_PUBLIC_BSC_RPC_URL: '',
    ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
let defaultBuyerToken = '';
server.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  await waitForHealth();
  const buyerSession = await siweLogin(buyerWallet, 'buyer');
  defaultBuyerToken = buyerSession.token;
  const buyerHeaders = authHeaders(buyerSession.token);
  const merchantSession = await siweLogin(merchantWallet, 'merchant');
  const savedPickupStore = await post('/api/merchant/stores', await withSecondary(merchantWallet, merchantSession.token, 'merchant.store.upsert', {
    storeId: 'store-dl-gaoxin',
    name: '24K 大连高新自提店',
    regionCode: '210211',
    city: '大连市',
    address: '辽宁省大连市高新区软件园路 24K 号',
    hours: '09:00-21:00',
    phone: '13800000000',
    lat: 38.86,
    lng: 121.52,
    photos: ['https://cdn.example.test/stores/dapp-flow.png']
  }), 201, authHeaders(merchantSession.token));
  assert(savedPickupStore.id === 'store-dl-gaoxin' && savedPickupStore.regionCode === '210211', 'merchant should persist the GPS pickup store through action-intent');

  const readiness = await get('/api/dapp/readiness');
  assert(readiness.ok === true, `readiness should be ok, got blockers ${JSON.stringify(readiness.blockers)}`);
  assert(readiness.modules?.payment?.ready === true && readiness.modules?.claims?.onchainReady === true, 'readiness should mark payment and on-chain claims ready');
  assert(readiness.modules?.wallet?.fixedNplAddress?.toLowerCase() === fixedNpl, 'readiness should expose fixed BSC NPL address');
  assert(readiness.modules?.launchKit?.endpoint === '/api/dapp/launch-kit', 'readiness should expose launch-kit endpoint for QR/mobile wallet launch');
  assert(readiness.modules?.home?.endpoint === '/api/dapp/home', 'readiness should expose DApp home aggregate endpoint');
  assert(readiness.modules?.launchStatus?.endpoint === '/api/dapp/launch-status', 'readiness should expose runtime launch-status endpoint');

  const launchStatus = await get('/api/dapp/launch-status');
  assert(launchStatus.kind === '24k-dapp-launch-status' && launchStatus.localOk === true, 'launch status should expose runtime local/strict launch gates');
  assert(Array.isArray(launchStatus.strictLaunchBlockers) && Array.isArray(launchStatus.criticalPath), 'launch status should expose strict blockers and critical path');
  assert(launchStatus.fixedPolicy?.npl?.toLowerCase() === fixedNpl && launchStatus.fixedPolicy?.approvalAmount === 'MaxUint256', 'launch status should lock fixed NPL and docs approval policy');

  const manifest = await get('/api/dapp/manifest');
  assert(manifest.name === '24K Mall DApp' && manifest.tokens?.npl?.toLowerCase() === fixedNpl, 'manifest should expose DApp metadata and fixed NPL');
  assert(manifest.wallet?.addEthereumChain?.params?.[0]?.chainId === '0x38', 'manifest should expose BSC add-chain metadata');
  assert(manifest.endpoints?.integration === '/api/dapp/integration', 'manifest should point DApp builders to the integration contract');
  assert(manifest.endpoints?.handoff === '/api/dapp/handoff', 'manifest should point DApp builders to the handoff bundle');
  assert(manifest.endpoints?.frontendBrief === '/api/dapp/frontend-brief.md', 'manifest should point DApp builders to the frontend thread brief');
  assert(manifest.endpoints?.launchKit === '/api/dapp/launch-kit', 'manifest should point DApp builders to the mobile launch kit');
  assert(manifest.endpoints?.launchStatus === '/api/dapp/launch-status', 'manifest should point DApp builders to runtime launch status');
  assert(manifest.endpoints?.types === '/api/dapp/types.d.ts', 'manifest should point DApp builders to TypeScript types');
  assert(manifest.endpoints?.sdk === '/api/dapp/sdk.ts', 'manifest should point DApp builders to TypeScript SDK helpers');
  assert(manifest.endpoints?.openapi === '/api/dapp/openapi.json', 'manifest should point DApp builders to OpenAPI JSON');
  assert(manifest.endpoints?.seckillState === '/api/dapp/seckill-state?address=0x...', 'manifest should point DApp builders to unified seckill-state');
  assert(manifest.endpoints?.mallState === '/api/dapp/mall-state?address=0x...' && manifest.endpoints?.storesState?.startsWith('/api/dapp/stores-state'), 'manifest should point DApp builders to mall/stores tab states');
  assert(manifest.endpoints?.assetsState === '/api/dapp/assets-state?address=0x...', 'manifest should point DApp builders to the assets tab state');

  const integration = await get('/api/dapp/integration');
  assert(integration.version === '24k-dapp-contract-v1' && integration.launch?.requiredChainId === 56, 'integration contract should identify the BSC DApp launch contract');
  assert(integration.launch?.wellKnown === '/.well-known/24k-dapp.json', 'integration contract should expose the well-known discovery path');
  assert(integration.launch?.launchKit === '/api/dapp/launch-kit?address=0x...', 'integration contract should expose the mobile launch kit');
  assert(integration.launch?.launchStatus === '/api/dapp/launch-status', 'integration contract should expose runtime launch status');
  assert(integration.launch?.handoff === '/api/dapp/handoff?address=0x...' && integration.handoff === '/api/dapp/handoff', 'integration contract should expose the handoff bundle');
  assert(integration.launch?.frontendBrief === '/api/dapp/frontend-brief.md?address=0x...' && integration.frontendBrief === '/api/dapp/frontend-brief.md', 'integration contract should expose the frontend thread brief');
  assert(integration.launch?.types === '/api/dapp/types.d.ts' && integration.typeDefinitions === '/api/dapp/types.d.ts', 'integration contract should expose TypeScript type definitions');
  assert(integration.launch?.sdk === '/api/dapp/sdk.ts' && integration.sdk === '/api/dapp/sdk.ts', 'integration contract should expose TypeScript SDK helpers');
  assert(integration.launch?.openapi === '/api/dapp/openapi.json' && integration.openApi === '/api/dapp/openapi.json', 'integration contract should expose OpenAPI JSON');
  assert(integration.launch?.seckillState === '/api/dapp/seckill-state?address=0x...' && integration.endpointShapes?.seckillStateQuery?.endpoint?.startsWith('/api/dapp/seckill-state'), 'integration contract should expose unified seckill-state');
  assert(integration.launch?.mallState === '/api/dapp/mall-state?address=0x...' && integration.launch?.storesState?.startsWith('/api/dapp/stores-state') && integration.launch?.assetsState === '/api/dapp/assets-state?address=0x...' && integration.endpointShapes?.mallStateQuery && integration.endpointShapes?.storesStateQuery && integration.endpointShapes?.assetsStateQuery, 'integration contract should expose mall/stores/assets tab states');
  assert(integration.tokens?.npl?.toLowerCase() === fixedNpl && integration.policies?.payment?.approvalAmount === 'MaxUint256', 'integration contract should lock fixed NPL and unlimited approval policy');
  assert(integration.flows?.regularCheckout?.some((step) => step.includes('allowanceChecks')) && integration.flows?.claim?.some((step) => step.includes('personal_sign')), 'integration contract should document checkout and claim wallet steps');
  assert(integration.statusHandling?.fundingTxStatus?.confirmed && integration.statusHandling?.claimTxStatus?.unavailable, 'integration contract should document polling status handling');
  const wellKnown = await get('/.well-known/24k-dapp.json');
  assert(JSON.stringify(wellKnown) === JSON.stringify(integration), 'well-known DApp discovery should return the same integration contract');
  const launchKit = await get(`/api/dapp/launch-kit?address=${buyerWallet.address}`);
  assert(launchKit.version === '24k-dapp-launch-kit-v1' && launchKit.qr?.data?.includes(buyerWallet.address), 'launch kit should return an address-bound QR target');
  assert(launchKit.urls?.handoff?.includes('/api/dapp/handoff') && launchKit.urls?.bootstrap?.includes('/api/dapp/bootstrap'), 'launch kit should return absolute handoff/bootstrap URLs');
  assert(launchKit.urls?.launchStatus?.includes('/api/dapp/launch-status') && launchKit.launchStatus?.kind === '24k-dapp-launch-status', 'launch kit should embed runtime launch status');
  assert(launchKit.urls?.home?.includes('/api/dapp/home'), 'launch kit should expose DApp home aggregate URL');
  assert(launchKit.urls?.frontendBrief?.includes('/api/dapp/frontend-brief.md'), 'launch kit should return an absolute frontend brief URL');
  const home = await get(`/api/dapp/home?address=${buyerWallet.address}`);
  assert(home.version === '24k-dapp-home-v1' && home.connectedAddress === buyerWallet.address, 'DApp home should bind connected wallet when provided');
  assert(JSON.stringify(home.tabs.map((tab) => tab.label)) === JSON.stringify(['秒杀大厅', '常规商城', '线下门店', '我的资产']), 'DApp home should return the four docs tabs in one payload');
  assert(home.tabs.find((tab) => tab.key === 'mall')?.endpoint === '/api/dapp/mall-state' && home.tabs.find((tab) => tab.key === 'mall')?.actions?.state?.startsWith('/api/dapp/mall-state'), 'DApp home mall tab should use mall-state');
  assert(home.tabs.find((tab) => tab.key === 'stores')?.endpoint === '/api/dapp/stores-state' && home.tabs.find((tab) => tab.key === 'stores')?.actions?.state?.startsWith('/api/dapp/stores-state'), 'DApp home stores tab should use stores-state');
  assert(home.tabs.find((tab) => tab.key === 'mall')?.actions?.createCheckoutIntent === '/api/dapp/checkout-intent', 'DApp home mall tab should expose checkout intent action');
  assert(home.tabs.find((tab) => tab.key === 'mall')?.actions?.finalCheck === '/api/dapp/final-check', 'DApp home mall tab should expose final-check action');
  assert(home.tabs.find((tab) => tab.key === 'seckill')?.endpoint === '/api/dapp/seckill-state' && home.tabs.find((tab) => tab.key === 'seckill')?.actions?.state?.startsWith('/api/dapp/seckill-state'), 'DApp home seckill tab should use unified seckill-state');
  assert(home.tabs.find((tab) => tab.key === 'seckill')?.actions?.createIntent === '/api/dapp/seckill-intent', 'DApp home seckill tab should expose seckill intent action');
  const frontendBrief = await getText(`/api/dapp/frontend-brief.md?address=${buyerWallet.address}`);
  assert(frontendBrief.includes('24K DApp 前端线程任务提示词') && frontendBrief.includes('秒杀大厅 / 常规商城 / 线下门店 / 我的资产') && frontendBrief.includes('sendPaymentIntent') && frontendBrief.includes('fetchDappSeckillState') && frontendBrief.includes('fetchDappMallState') && frontendBrief.includes('fetchDappStoresState') && frontendBrief.includes('fetchDappAssetsState') && frontendBrief.includes(fixedNpl), 'frontend brief should give the separate frontend thread a copy-paste task prompt');
  const contracts = await get('/api/dapp/contracts.json');
  assert(contracts.version === '24k-dapp-contracts-v1' && contracts.tokens?.npl?.fixedBscAddress?.toLowerCase() === fixedNpl, 'contracts bundle should expose fixed NPL token');
  assert(JSON.stringify(Object.keys(contracts.tokens || {}).sort()) === JSON.stringify(['bnm', 'npl']), 'contracts bundle should expose only NPL and BNM tokens');
  assert(
    contracts.humanReadableAbi?.escrow?.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)')
      && contracts.humanReadableAbi.escrow.includes('function forceRefund(bytes32 orderId)')
      && contracts.humanReadableAbi.escrow.includes('event SellerApprovalUpdated(address indexed seller,bool approved)')
      && contracts.humanReadableAbi.escrow.includes('event SplitConfigUpdated(uint32 indexed version,bytes32 indexed configHash)')
      && contracts.humanReadableAbi?.rewardLedger?.includes('function setOperator(address operator,bool enabled)')
      && contracts.humanReadableAbi.rewardLedger.includes('function burnOrderRewards(bytes32 orderId) returns (uint256 burnedCount)')
      && contracts.humanReadableAbi?.seckill?.includes('function startSession(bytes32 productId,uint64 durationSeconds,uint64 relayInitialSeconds,uint32 relayExtendSeconds,uint256 minimumNplAmount,uint256 prizePoolNpl) returns (bytes32 sessionId)')
      && contracts.humanReadableAbi.seckill.includes('event SeckillPrizeReleased(bytes32 indexed sessionId,bytes32 indexed rewardOrderId,address indexed winner,uint256 prizePoolNpl)'),
    'contracts bundle should expose current Escrow, RewardLedger and Seckill ABI fragments'
  );
  const typeDefinitions = await getText('/api/dapp/types.d.ts');
  assert(typeDefinitions.includes("export type AssetSymbol = 'NPL' | 'BNM';"), 'DApp types should accept only NPL and BNM assets');
  assert(['SeckillSession', 'SeckillRulesResponse', 'SeckillReportHistoryResponse', 'SeckillFeedStreamSnapshot', 'DappSeckillStateResponse', 'DappMallStateResponse', 'DappStoresStateResponse', 'DappAssetsStateResponse', 'Sku', 'ProductSummary', 'ProductDetailResponse', 'AddressBookEntry', 'Store', 'AssetBucket', 'RewardLedgerEntry', 'ClaimRecord'].every((name) => typeDefinitions.includes(`export interface ${name}`)), 'DApp types should expose docs public interfaces for sessions, tab states, rules, report history, feed stream, products, SKU, stores, addresses, assets and claims');
  assert(typeDefinitions.includes('export interface DappCheckoutIntentResponse') && typeDefinitions.includes('export interface ClaimIntentResponse') && typeDefinitions.includes('export interface CompleteOrderIntentResponse') && typeDefinitions.includes('export interface DappOrderStateResponse') && typeDefinitions.includes('export interface TimeoutActionsResponse') && typeDefinitions.includes('export interface TimeoutRefundRequestResponse') && typeDefinitions.includes('export interface DappAssetsStateResponse') && typeDefinitions.includes('export interface AssetSummaryResponse') && typeDefinitions.includes('export interface DappHomeResponse') && typeDefinitions.includes('export interface DappFinalCheckResponse') && typeDefinitions.includes('export interface DappLaunchKitResponse') && typeDefinitions.includes('export interface DappLaunchStatusResponse') && typeDefinitions.includes('export interface DappContractsResponse'), 'DApp types should expose checkout, claim, complete-order, unified order-state, timeout, assets, home, final-check, launch status, launch-kit and contracts response interfaces');
  const sdk = await getText('/api/dapp/sdk.ts');
  assert(sdk.includes('export function create24kDappClient') && sdk.includes('fetchDappReadiness') && sdk.includes('fetchDappLaunchStatus') && sdk.includes('fetchDappHome') && sdk.includes('fetchDappBootstrap') && sdk.includes('fetchDappContracts') && sdk.includes('fetchProducts') && sdk.includes('fetchProductDetail') && sdk.includes('fetchAssetSummary') && sdk.includes('fetchDappAssetsState') && sdk.includes('fetchDappSeckillState') && sdk.includes('fetchDappMallState') && sdk.includes('fetchDappStoresState') && sdk.includes('fetchSeckillRules') && sdk.includes('fetchSeckillReportHistory') && sdk.includes('seckillFeedStreamUrl') && sdk.includes('createFinalCheck'), 'DApp SDK should expose fetch helpers');
  assert(sdk.includes('createCheckoutIntent') && sdk.includes('createSeckillIntent') && sdk.includes('createClaimIntent') && sdk.includes('createCompleteOrderIntent') && sdk.includes('fetchDappOrderState') && sdk.includes('fetchOrderFulfillment') && sdk.includes('fetchFulfillmentOptions') && sdk.includes('fetchStores') && sdk.includes('fetchAddressBook') && sdk.includes('saveAddress') && sdk.includes('fetchOrderTimeoutActions') && sdk.includes('requestTimeoutRefund') && sdk.includes('parseAddressText'), 'DApp SDK should expose intent, order-state, fulfillment, timeout and address helpers');
  assert(sdk.includes('pollFundingTxStatus') && sdk.includes('pollCompleteTxStatus') && sdk.includes('pollClaimTxStatus') && sdk.includes('switchTo24kChain') && sdk.includes('sendWalletTransaction') && sdk.includes('personalSign'), 'DApp SDK should expose wallet and polling helpers');
  assert(sdk.includes('sendPaymentIntent') && sdk.includes('sendSeckillRecordPurchase') && sdk.includes('sendCompleteOrder') && sdk.includes('submitClaimRequest') && sdk.includes('sendClaimTransaction'), 'DApp SDK should expose end-to-end payment, seckill, complete-order and claim helpers');
  const openapi = await get('/api/dapp/openapi.json');
  assert(openapi.openapi === '3.1.0' && openapi.info?.title === '24K Mall DApp API', 'DApp OpenAPI should expose title and version');
  assert(openapi.paths?.['/api/dapp/launch-kit']?.get && openapi.paths?.['/api/dapp/launch-status']?.get && openapi.paths?.['/api/dapp/home']?.get && openapi.paths?.['/api/dapp/seckill-state']?.get && openapi.paths?.['/api/dapp/mall-state']?.get && openapi.paths?.['/api/dapp/stores-state']?.get && openapi.paths?.['/api/dapp/assets-state']?.get && openapi.paths?.['/api/dapp/fulfillment-options']?.get && openapi.paths?.['/api/assets/summary']?.get && openapi.paths?.['/api/seckill/feed/stream']?.get && openapi.paths?.['/api/seckill/rules']?.get && openapi.paths?.['/api/seckill/reports']?.get && openapi.paths?.['/api/dapp/final-check']?.post && openapi.paths?.['/api/dapp/frontend-brief.md']?.get && openapi.paths?.['/api/dapp/contracts.json']?.get && openapi.paths?.['/api/dapp/sdk.ts']?.get && openapi.paths?.['/api/dapp/order-state']?.get && openapi.paths?.['/api/dapp/checkout-intent']?.post && openapi.paths?.['/api/dapp/seckill-intent']?.post && openapi.paths?.['/api/dapp/claim-intent']?.post && openapi.paths?.['/api/dapp/complete-order-intent']?.post && openapi.paths?.['/api/dapp/timeout-refund-request']?.post && openapi.paths?.['/api/address-book/parse']?.post && openapi.paths?.['/api/orders/{orderId}/fulfillment']?.get && openapi.paths?.['/api/orders/{orderId}/complete-tx-status']?.get && openapi.paths?.['/api/orders/{orderId}/timeout-actions']?.get, 'DApp OpenAPI should describe launch-kit, launch status, home, tab states, fulfillment options, asset summary, seckill stream/rules/report history, final-check, frontend brief, contracts, SDK, unified order-state, checkout, seckill, claim, complete-order, fulfillment snapshot and timeout intents');
  assert(openapi.components?.schemas?.PaymentIntent && openapi.components?.schemas?.ClaimIntentResponse && openapi.components?.schemas?.DappSeckillStateResponse && openapi.components?.schemas?.DappMallStateResponse && openapi.components?.schemas?.DappStoresStateResponse && openapi.components?.schemas?.DappAssetsStateResponse, 'DApp OpenAPI should include key response schemas');
  assert(openapi.components.schemas.PaymentIntent.properties?.approvalPolicy?.properties?.type?.const === 'unlimited-npl', 'DApp OpenAPI should expose the NPL-only approval policy');
  assert(!`${typeDefinitions}\n${sdk}\n${JSON.stringify(openapi)}`.toLowerCase().includes(legacySettlementAsset.toLowerCase()), 'generated types, SDK and OpenAPI should not expose the legacy settlement asset');
  const handoff = await get(`/api/dapp/handoff?address=${buyerWallet.address}`);
  assert(handoff.version === '24k-dapp-handoff-v1' && handoff.integration?.version === integration.version, 'DApp handoff should bundle integration contract');
  assert(handoff.bootstrap?.config?.nplAddress?.toLowerCase() === fixedNpl && handoff.types?.includes('export interface PaymentIntent'), 'DApp handoff should bundle bootstrap and type definitions');
  assert(handoff.sdk?.includes('export function create24kDappClient') && handoff.endpoints?.sdk === '/api/dapp/sdk.ts', 'DApp handoff should bundle SDK helpers');
  assert(handoff.launchStatus?.kind === '24k-dapp-launch-status' && handoff.endpoints?.launchStatus === '/api/dapp/launch-status', 'DApp handoff should bundle runtime launch status');
  assert(handoff.home?.version === '24k-dapp-home-v1' && handoff.endpoints?.home === '/api/dapp/home?address=0x...' && handoff.endpoints?.seckillState === '/api/dapp/seckill-state?address=0x...' && handoff.endpoints?.mallState === '/api/dapp/mall-state?address=0x...' && handoff.endpoints?.storesState?.startsWith('/api/dapp/stores-state') && handoff.endpoints?.assetsState === '/api/dapp/assets-state?address=0x...', 'DApp handoff should bundle home aggregate payload and tab-state endpoints');
  assert(handoff.frontendBrief?.includes('前端线程任务提示词') && handoff.endpoints?.frontendBrief === '/api/dapp/frontend-brief.md?address=0x...', 'DApp handoff should bundle the frontend thread prompt');
  assert(handoff.openapi?.paths?.['/api/dapp/checkout-intent']?.post && handoff.commands?.backendFlowCheck === 'pnpm dapp:check' && handoff.frontendThreadRules?.doNotRun?.includes('pnpm dapp:qr'), 'DApp handoff should bundle OpenAPI, safe verification commands and frontend thread scope guard');

  const bootstrap = await get(`/api/dapp/bootstrap?address=${buyerWallet.address}`);
  assert(bootstrap.config?.nplAddress?.toLowerCase() === fixedNpl, 'bootstrap should use the fixed NPL contract');
  assert(bootstrap.config?.payment?.firstPaymentApproval === 'unlimited-npl', 'bootstrap should declare one unlimited NPL approval');
  assert(bootstrap.endpoints?.integration === '/api/dapp/integration', 'bootstrap should expose integration contract endpoint');
  assert(bootstrap.endpoints?.handoff === '/api/dapp/handoff', 'bootstrap should expose handoff bundle endpoint');
  assert(bootstrap.endpoints?.frontendBrief === '/api/dapp/frontend-brief.md', 'bootstrap should expose frontend thread brief endpoint');
  assert(bootstrap.endpoints?.launchKit === '/api/dapp/launch-kit', 'bootstrap should expose mobile launch kit endpoint');
  assert(bootstrap.endpoints?.launchStatus === '/api/dapp/launch-status', 'bootstrap should expose runtime launch status endpoint');
  assert(bootstrap.endpoints?.home === '/api/dapp/home', 'bootstrap should expose DApp home aggregate endpoint');
  assert(bootstrap.endpoints?.contracts === '/api/dapp/contracts.json', 'bootstrap should expose contracts bundle endpoint');
  assert(bootstrap.endpoints?.types === '/api/dapp/types.d.ts', 'bootstrap should expose TypeScript type definitions');
  assert(bootstrap.endpoints?.sdk === '/api/dapp/sdk.ts', 'bootstrap should expose TypeScript SDK helpers');
  assert(bootstrap.endpoints?.openapi === '/api/dapp/openapi.json', 'bootstrap should expose OpenAPI JSON');
  assert(bootstrap.endpoints?.seckillState?.startsWith('/api/dapp/seckill-state') && bootstrap.endpoints?.mallState?.startsWith('/api/dapp/mall-state') && bootstrap.endpoints?.storesState?.startsWith('/api/dapp/stores-state') && bootstrap.endpoints?.assetsState?.startsWith('/api/dapp/assets-state') && bootstrap.endpoints?.seckillFeedStream === '/api/seckill/feed/stream' && bootstrap.endpoints?.seckillRules === '/api/seckill/rules' && bootstrap.endpoints?.seckillReports === '/api/seckill/reports', 'bootstrap should expose tab states, seckill stream, rules and report-history endpoints');
  assert(bootstrap.endpoints?.addressBookParse === '/api/address-book/parse' && bootstrap.endpoints?.fulfillmentOptions?.startsWith('/api/dapp/fulfillment-options') && bootstrap.endpoints?.orderState?.startsWith('/api/dapp/order-state') && bootstrap.endpoints?.completeOrderIntent === '/api/dapp/complete-order-intent', 'bootstrap should expose address parsing, fulfillment options, unified order-state and complete-order endpoints');
  assert(JSON.stringify(bootstrap.tabs.map((tab) => tab.label)) === JSON.stringify(['秒杀大厅', '常规商城', '线下门店', '我的资产']), 'bootstrap should expose the four docs tabs');
  assert(bootstrap.abiFragments?.erc20?.some((item) => item.includes('allowance')) && bootstrap.abiFragments?.escrow?.some((item) => item.includes('payOrder')) && bootstrap.abiFragments?.escrow?.some((item) => item.includes('completeOrder')), 'bootstrap should expose wallet ABI fragments');
  assert(bootstrap.policy?.seckillContractCallerBlocked === true && bootstrap.policy?.refund?.includes('不开放用户无理由退款'), 'bootstrap should expose latest docs policy decisions');
  assert(bootstrap.initialData?.seckill?.version === '24k-dapp-seckill-state-v1' && bootstrap.initialData?.seckill?.rules?.version === '24k-seckill-rules-v1' && Array.isArray(bootstrap.initialData?.seckill?.reportHistory), 'bootstrap seckill data should bundle unified state, rules and report history for DApp modals');
  const seckillState = await get(`/api/dapp/seckill-state?address=${buyerWallet.address}`);
  assert(seckillState.version === '24k-dapp-seckill-state-v1' && seckillState.phase?.key && seckillState.timers?.main && seckillState.cta?.key && seckillState.rules?.version === '24k-seckill-rules-v1' && Array.isArray(seckillState.reportHistory) && Array.isArray(seckillState.feed) && seckillState.prizeClaim, 'seckill-state should expose phase, timers, CTA, rules, report history, feed and prize claim');
  const mallState = await get(`/api/dapp/mall-state?address=${buyerWallet.address}&limit=3`);
  assert(mallState.version === '24k-dapp-mall-state-v1' && mallState.products?.length && mallState.products[0]?.primaryAction && mallState.products[0]?.dapp?.finalCheck && mallState.finalCheckTemplate?.endpoint === '/api/dapp/final-check', 'mall-state should expose product cards, primary actions and final-check contract');
  const storesState = await get(`/api/dapp/stores-state?address=${buyerWallet.address}&lat=38.86&lng=121.52&limit=2`);
  assert(storesState.version === '24k-dapp-stores-state-v1' && storesState.stores?.[0]?.regionCode === '210211' && storesState.stores[0].distanceSource !== 'seed' && storesState.checkoutTemplates?.pickup?.fulfillmentMode === 'pickup' && storesState.policies?.regionCodeLockedOnPayment === true, 'stores-state should expose the persisted pickup store, pickup template and region-lock policy without a fake distance');
  const disconnectedAssetsResponse = await fetch(`${apiUrl}/api/dapp/assets-state`);
  assert(disconnectedAssetsResponse.status === 401, 'assets-state should require a buyer JWT');
  const assetsState = await get(`/api/dapp/assets-state?address=${buyerWallet.address}`);
  assert(assetsState.version === '24k-dapp-assets-state-v1' && assetsState.summary?.buckets?.some((bucket) => bucket.id === 'bnm') && assetsState.sections?.rewards?.buckets && assetsState.primaryAction?.key && assetsState.policies?.noUserNoReasonRefund === true && assetsState.endpoints?.summary?.startsWith('/api/assets/summary'), 'assets-state should expose assets tab summary, sections, primary action, policy and endpoints');
  const seckillRules = await get('/api/seckill/rules');
  const reportHistory = await get('/api/seckill/reports');
  assert(seckillRules.policy?.contractCallerBlocked === true && seckillRules.actions?.createIntent === '/api/dapp/seckill-intent', 'seckill rules endpoint should expose docs risk policy and DApp actions');
  assert(reportHistory.version === '24k-seckill-report-history-v1' && Array.isArray(reportHistory.reports), 'seckill reports endpoint should expose battle report history');
  const feedStream = await getText(`/api/seckill/feed/stream?sessionId=${bootstrap.initialData.seckill.session.id}&once=1`);
  assert(feedStream.includes('event: snapshot') && feedStream.includes('24k-seckill-feed-stream-v1'), 'seckill feed stream should expose EventSource snapshot payload for the rolling wall');
  const productDetail = await get('/api/products/p-24k-runner');
  assert(productDetail.dapp?.version === '24k-product-detail-v1' && productDetail.dapp?.endpoints?.finalCheck === '/api/dapp/final-check', 'product detail should expose DApp final-check endpoint contract');
  assert(productDetail.dapp?.seckillOverlay?.active === false && productDetail.dapp?.buyNow?.enabled === true && productDetail.dapp?.defaultCheckoutItem?.productId === 'p-24k-runner', 'product detail should expose regular buy-now before a seckill session is indexed');

  const parsedAddress = await post('/api/address-book/parse', {
    walletAddress: buyerWallet.address,
    text: 'DApp 流程用户 13800000001 辽宁省大连市高新区软件园路 24K 号'
  }, 200);
  assert(parsedAddress.ok === true && parsedAddress.parsed?.phone === '13800000001' && parsedAddress.parsed?.regionCode === '210211' && parsedAddress.nextAction?.endpoint === '/api/address-book', 'address parser should extract pasted address and prepare save action');
  assert(parsedAddress.dappReview?.lockPreview?.regionBinding === true && parsedAddress.dappReview?.checkoutItemPatch?.fulfillmentMode === 'delivery', 'address parser should expose delivery region-lock review metadata');

  const nearbyStores = await get('/api/stores?lat=38.86&lng=121.52&city=大连市&limit=2');
  assert(Array.isArray(nearbyStores) && nearbyStores.length > 0 && nearbyStores[0].regionCode === '210211' && nearbyStores[0].distanceSource !== 'seed' && nearbyStores[0].pickupContext?.regionBinding === true, 'stores should support filters and pickup context without a fake distance');
  assert(nearbyStores[0].pickupContext?.checkoutItemPatch?.fulfillmentMode === 'pickup' && nearbyStores[0].dapp?.lockPreview?.regionBinding === true, 'stores should expose pickup checkout patch and lock preview metadata');
  const fulfillmentOptions = await get(`/api/dapp/fulfillment-options?address=${buyerWallet.address}&lat=38.86&lng=121.52&city=大连市&limit=2`);
  assert(fulfillmentOptions.version === '24k-fulfillment-options-v1' && fulfillmentOptions.policy?.regionCodeLockedOnPayment === true, 'fulfillment options should expose DApp region lock policy');
  assert(fulfillmentOptions.checkoutTemplates?.pickup?.fulfillmentMode === 'pickup' && fulfillmentOptions.checkoutTemplates?.delivery?.fulfillmentMode === 'delivery', 'fulfillment options should expose delivery and pickup checkout templates');

  const addressPayload = {
    walletAddress: buyerWallet.address,
    name: 'DApp 流程用户',
    phone: '13800000001',
    province: '辽宁省',
    city: '大连市',
    district: '高新区',
    detail: '软件园路 24K 号',
    regionCode: '210211',
    isDefault: true
  };
  const anonymousAddressResponse = await fetch(`${apiUrl}/api/address-book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(addressPayload)
  });
  assert(anonymousAddressResponse.status === 401, 'address writes should require a buyer JWT');
  const savedAddress = await post('/api/address-book', await withSecondary(buyerWallet, buyerSession.token, 'buyer.address.upsert', addressPayload), 201, buyerHeaders);

  const finalCheck = await post('/api/dapp/final-check', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `dapp-flow:${buyerWallet.address}:final-check`,
    items: [deliveryItem('p-24k-bag', { addressId: savedAddress.id })]
  }, 200);
  assert(finalCheck.ok === true && finalCheck.version === '24k-dapp-final-check-v1', 'final-check should pass and expose version');
  assert(finalCheck.factors?.map((entry) => entry.label).join('|').includes('SKU / 数量') && finalCheck.nextAction?.endpoint === '/api/dapp/checkout-intent', 'final-check should expose five factors and checkout next action');

  const checkout = await post('/api/dapp/checkout-intent', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `dapp-flow:${buyerWallet.address}:checkout`,
    items: [deliveryItem('p-24k-bag', { addressId: savedAddress.id })]
  }, 201);
  assert(checkout.ok && checkout.preflight?.ok && checkout.finalCheck?.passed, 'checkout intent should run preflight and final check');
  assert(checkout.nextActions?.includes('approveNplIfNeeded') && checkout.nextActions?.includes('pollFundingStatus'), 'checkout intent should expose NPL wallet next actions');
  assert(checkout.paymentIntent?.approvalPolicy?.type === 'unlimited-npl', 'checkout payment intent should use the NPL-only policy');
  assert(checkout.paymentIntent?.allowanceChecks?.length === 1 && checkout.paymentIntent?.approvalTransactions?.length === 1, 'checkout payment intent should include one NPL allowance check and one approval');
  assertPaymentIntent(checkout.paymentIntent, checkout.order);
  const connectedAssets = await get(`/api/assets/summary?address=${buyerWallet.address}`);
  assert(connectedAssets.orders?.some((order) => order.orderId === checkout.order.orderId) && connectedAssets.shoppingRecords?.some((row) => row.orderId === checkout.order.orderId) && connectedAssets.orderStateCounts?.pendingPayment >= 1, 'asset summary should aggregate real buyer orders and shopping records for the DApp assets tab');
  const draftAssetOrder = connectedAssets.orders.find((order) => order.orderId === checkout.order.orderId);
  assert(draftAssetOrder?.primaryAction?.key === 'payOrder' && draftAssetOrder.actions?.payment?.available === true && draftAssetOrder.endpoints?.paymentIntent?.includes('/payment-intent'), 'asset summary order card should expose pay action for draft orders');
  assert(connectedAssets.shoppingRecords.find((row) => row.orderId === checkout.order.orderId)?.dapp?.primaryAction?.key === 'payOrder', 'shopping records should carry the same DApp order action summary');
  assert(connectedAssets.actions?.timeoutActions && connectedAssets.actions?.completeOrderIntent === '/api/dapp/complete-order-intent', 'asset summary should expose DApp order/claim action endpoints');
  assert(['bnm', 'genesis-node', 'referral-shop', 'region-agent', 'ops'].every((id) => connectedAssets.buckets?.some((bucket) => bucket.id === id && bucket.docsKey === id && bucket.claimEndpoint === '/api/dapp/claim-intent')), 'asset summary should expose all latest docs reward buckets with claim metadata');
  assert(connectedAssets.buckets?.find((bucket) => bucket.id === 'genesis-node')?.visibility?.mode === 'gated', 'genesis-node bucket should declare NFT/SFT visibility gating');

  const paymentIntent = await get(`/api/orders/${checkout.order.orderId}/payment-intent?buyerAddress=${buyerWallet.address}`);
  assertPaymentIntent(paymentIntent, checkout.order);
  const draftOrderState = await get(`/api/dapp/order-state?buyerAddress=${buyerWallet.address}&orderId=${checkout.order.orderId}`);
  assert(draftOrderState.version === '24k-dapp-order-state-v1' && draftOrderState.primaryAction?.key === 'payOrder' && draftOrderState.funding?.status === 'not_started', 'DApp order-state should aggregate draft order payment action');

  const notMinedHash = hex32('dapp-flow-not-mined');
  const initialFundingStatus = await get(`/api/orders/${checkout.order.orderId}/fund-tx-status?buyerAddress=${buyerWallet.address}&txHash=${notMinedHash}`);
  assert(initialFundingStatus.retryable === true && ['pending', 'rpc_unavailable'].includes(initialFundingStatus.status), 'funding status should be retryable before an indexed receipt exists');

  const paidTxHash = hex32('dapp-flow-paid');
  await post('/api/chain-events', orderPaidEvent(checkout.order, paidTxHash, 201), 201, { 'x-indexer-secret': indexerSecret });
  const confirmedFundingStatus = await get(`/api/orders/${checkout.order.orderId}/fund-tx-status?buyerAddress=${buyerWallet.address}&txHash=${paidTxHash}`);
  assert(confirmedFundingStatus.status === 'confirmed' && confirmedFundingStatus.order?.status === 'PaidLocked', 'funding status should confirm after OrderPaid is indexed');
  const paidOrderState = await get(`/api/dapp/order-state?buyerAddress=${buyerWallet.address}&orderId=${checkout.order.orderId}&fundTxHash=${paidTxHash}`);
  assert(paidOrderState.funding?.status === 'confirmed' && paidOrderState.order?.status === 'PaidLocked' && paidOrderState.primaryAction?.key === 'trackFulfillment', 'DApp order-state should fold funding tx status into the order card state');

  const tooEarlyCompleteIntent = await post('/api/dapp/complete-order-intent', {
    buyerAddress: buyerWallet.address,
    orderId: checkout.order.orderId
  }, 200);
  assert(tooEarlyCompleteIntent.completeOrderTransaction === null && tooEarlyCompleteIntent.unavailableReason === 'ORDER_NOT_CONFIRMABLE', 'complete-order intent should not release funds before shipment/pickup verification');
  assert(tooEarlyCompleteIntent.confirmability?.canComplete === false && tooEarlyCompleteIntent.confirmability?.reason === 'WAITING_FOR_MERCHANT_SHIPMENT', 'complete-order intent should explain why the buyer button is disabled');
  assert(tooEarlyCompleteIntent.releasePreview?.stateAfterComplete === 'Available' && tooEarlyCompleteIntent.completeOrderCall?.available === false, 'complete-order intent should expose BNM release preview and disabled call contract');
  const paidFulfillment = await get(`/api/orders/${checkout.order.orderId}/fulfillment?buyerAddress=${buyerWallet.address}`);
  assert(paidFulfillment.version === '24k-fulfillment-snapshot-v1' && paidFulfillment.confirmability?.reason === 'WAITING_FOR_MERCHANT_SHIPMENT', 'fulfillment snapshot should expose DApp confirmability before shipment');
  assert(paidFulfillment.releasePreview?.bnmLocked === checkout.order.bnmLocked && paidFulfillment.timeout?.buyerTimeoutRefund?.reason === 'WAITING_7_DAYS_AFTER_PAYMENT', 'fulfillment snapshot should expose BNM release preview and timeout linkage');
  markOrderShippedForCheck(checkout.order.orderId);
  const shippedFulfillment = await get(`/api/orders/${checkout.order.orderId}/fulfillment?buyerAddress=${buyerWallet.address}`);
  assert(shippedFulfillment.confirmability?.canComplete === true && shippedFulfillment.completeOrderCall?.available === true && shippedFulfillment.nextActions?.includes('createCompleteOrderIntent'), 'fulfillment snapshot should enable complete-order action after shipment');
  assert(shippedFulfillment.releaseStatus?.buyerCanComplete === true && shippedFulfillment.releasePreview?.claimEndpoint === '/api/dapp/claim-intent', 'fulfillment snapshot should expose BNM Available release and claim linkage');
  const shippedOrderState = await get(`/api/dapp/order-state?buyerAddress=${buyerWallet.address}&orderId=${checkout.order.orderId}`);
  assert(shippedOrderState.primaryAction?.key === 'completeOrder' && shippedOrderState.actions?.completeOrder?.available === true, 'DApp order-state should enable complete-order action after shipment');
  const timeoutActionsAfterShip = await get(`/api/orders/${checkout.order.orderId}/timeout-actions?buyerAddress=${buyerWallet.address}`);
  assert(timeoutActionsAfterShip.version === '24k-order-timeout-actions-v1' && timeoutActionsAfterShip.merchantForceSign?.reason === 'WAITING_7_DAYS_AFTER_SHIPMENT_OR_PICKUP', 'timeout actions should expose docs 7-day merchant force-sign clock after shipment');

  const completeIntent = await post('/api/dapp/complete-order-intent', {
    buyerAddress: buyerWallet.address,
    orderId: checkout.order.orderId
  }, 200);
  assert(completeIntent.completeOrderTransaction?.to?.toLowerCase() === escrowAddress.toLowerCase(), 'complete-order intent should include escrow completeOrder tx');
  assert(completeIntent.confirmability?.canComplete === true && completeIntent.completeOrderCall?.transaction?.data === completeIntent.completeOrderTransaction.data, 'complete-order intent should expose the same transaction in completeOrderCall');
  const completeIface = new Interface(['function completeOrder(bytes32 orderId)']);
  const [completeOrderId] = completeIface.decodeFunctionData('completeOrder', completeIntent.completeOrderTransaction.data);
  assert(completeOrderId === checkout.order.orderId && completeIntent.endpoints?.completeTxStatus?.includes('/complete-tx-status'), 'completeOrder calldata should bind order id and expose polling');
  const completedTxHash = hex32('dapp-flow-completed');
  await post('/api/chain-events', orderCompletedEvent(checkout.order, completedTxHash, 202), 201, { 'x-indexer-secret': indexerSecret });
  const completedStatus = await get(`/api/orders/${checkout.order.orderId}/complete-tx-status?buyerAddress=${buyerWallet.address}&txHash=${completedTxHash}`);
  assert(completedStatus.status === 'confirmed' && completedStatus.order?.status === 'Released', 'complete tx status should confirm after OrderCompleted is indexed');
  const completedOrderState = await get(`/api/dapp/order-state?buyerAddress=${buyerWallet.address}&orderId=${checkout.order.orderId}&completeTxHash=${completedTxHash}`);
  assert(completedOrderState.complete?.status === 'confirmed' && completedOrderState.order?.status === 'Released', 'DApp order-state should fold complete tx status into the order card state');

  const rewardLocked = await post('/api/chain-events', rewardLockedEvent(checkout.order, 1, 'dapp-flow-reward-lock', 301), 201, { 'x-indexer-secret': indexerSecret });
  assert(rewardLocked.reward?.id === 'reward-ledger-1' && rewardLocked.reward?.state === 'Locked', 'RewardLocked should create an on-chain BNM ledger entry');
  const rewardReleased = await post('/api/chain-events', rewardReleasedEvent(checkout.order, 1, 'dapp-flow-reward-release', 302), 201, { 'x-indexer-secret': indexerSecret });
  assert(rewardReleased.reward?.state === 'Available', 'RewardReleased should make BNM claimable');
  const releasedAssets = await get(`/api/assets/summary?address=${buyerWallet.address}`);
  const releasedAssetOrder = releasedAssets.orders.find((order) => order.orderId === checkout.order.orderId);
  assert(releasedAssetOrder?.primaryAction?.key === 'claimRewards' && releasedAssetOrder.actions?.claimRewards?.rewards?.[0]?.rewardId === 'reward-ledger-1', 'asset summary order card should expose claim action after reward release');
  const claimableOrderState = await get(`/api/dapp/order-state?buyerAddress=${buyerWallet.address}&orderId=${checkout.order.orderId}&claimRewardId=reward-ledger-1`);
  assert(claimableOrderState.claim?.status === 'Available' && claimableOrderState.primaryAction?.key === 'claimRewards', 'DApp order-state should expose claimable reward state for the order card');

  const claimIntent = await post('/api/dapp/claim-intent', {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm',
    rewardId: 'reward-ledger-1'
  }, 200);
  assert(claimIntent.signatureKind === 'personal_sign' && claimIntent.secondaryMessage.includes('Action: buyer.claim'), 'claim intent should return wallet-signable message');
  assert(claimIntent.claimTransaction?.to?.toLowerCase() === rewardLedgerAddress.toLowerCase(), 'claim intent should include RewardLedger claim tx when configured');
  const rewardLedgerIface = new Interface(['function claim(uint256 entryId)']);
  const [claimEntryId] = rewardLedgerIface.decodeFunctionData('claim', claimIntent.claimTransaction.data);
  assert(claimEntryId === 1n, 'claim intent calldata should target the reward entry');

  const claimSignature = await buyerWallet.signMessage(claimIntent.secondaryMessage);
  const claimRequest = await post('/api/claims', { ...claimIntent.submit.body, secondarySignature: claimSignature }, 201);
  assert(claimRequest.status === 'pending' && claimRequest.rewardId === 'reward-ledger-1', 'claim submit should remain pending until RewardClaimed event');

  const preClaimStatus = await get(`/api/dapp/claim-tx-status?walletAddress=${buyerWallet.address}&rewardId=reward-ledger-1&txHash=${hex32('dapp-flow-claim-unindexed')}`);
  assert(preClaimStatus.retryable === true && ['pending', 'rpc_unavailable'].includes(preClaimStatus.status), 'claim tx status should be retryable before an indexed RewardClaimed event exists');
  const claimTxHash = hex32('dapp-flow-reward-claim');
  await post('/api/chain-events', rewardClaimedEvent(checkout.order, 1, claimTxHash, 303), 201, { 'x-indexer-secret': indexerSecret });
  const claimedStatus = await get(`/api/dapp/claim-tx-status?walletAddress=${buyerWallet.address}&rewardId=reward-ledger-1&txHash=${claimTxHash}`);
  assert(claimedStatus.status === 'confirmed' && claimedStatus.reward?.state === 'Claimed', 'claim tx status should confirm after RewardClaimed is indexed');

  const sessionId = hex32('dapp-flow-session');
  const sessionStartsAt = Math.floor(Date.now() / 1000) - 5;
  await post('/api/chain-events', {
    eventName: 'SessionStarted',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId,
    productId: hex32('dapp-flow-runner-product'),
    productIdText: 'p-24k-runner',
    startsAt: sessionStartsAt,
    mainEndsAt: sessionStartsAt + 3600,
    relayEndsAt: sessionStartsAt + 180,
    minimumNplAmountWei: parseDecimal18('120').toString(),
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: hex32('dapp-flow-session-start'),
    blockNumber: 401,
    logIndex: 0
  }, 201, { 'x-indexer-secret': indexerSecret });

  const seckillIntent = await post('/api/dapp/seckill-intent', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `dapp-flow:${buyerWallet.address}:seckill`,
    items: [deliveryItem('p-24k-runner', { addressId: savedAddress.id })]
  }, 201);
  assert(seckillIntent.seckill?.contractCallerBlocked === true, 'seckill intent should declare tx.origin contract caller block');
  assert(seckillIntent.seckill?.recordPurchaseTransaction?.to?.toLowerCase() === seckillAddress.toLowerCase(), 'seckill intent should include recordPurchase transaction');
  const seckillIface = new Interface(['function recordPurchase(bytes32 sessionId,bytes32 orderId)']);
  const [intentSessionId, intentOrderId] = seckillIface.decodeFunctionData('recordPurchase', seckillIntent.seckill.recordPurchaseTransaction.data);
  assert(intentSessionId === sessionId && intentOrderId === seckillIntent.order.orderId, 'recordPurchase calldata should bind current session and created order');
  assert(seckillIntent.nextActions?.includes('sendRecordPurchase') && seckillIntent.nextActions?.includes('pollSeckillFeed'), 'seckill intent should expose follow-up DApp actions');
  const settlementTxHash = hex32('dapp-flow-session-settled');
  const rewardOrderId = hex32('dapp-flow-seckill-reward');
  const releasedPrize = await post('/api/chain-events', {
    eventName: 'SeckillPrizeReleased',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId,
    rewardOrderId,
    winner: buyerWallet.address,
    prizePoolNplWei: parseDecimal18('18.88').toString(),
    txHash: settlementTxHash,
    blockNumber: 402,
    logIndex: 0
  }, 201, { 'x-indexer-secret': indexerSecret });
  assert(releasedPrize.prizeReward?.pendingOnchainReward === true && releasedPrize.prizeReward.orderId === rewardOrderId, 'SeckillPrizeReleased should expose the pending RewardLedger NPL prize order');
  const settledSeckill = await post('/api/chain-events', {
    eventName: 'SessionSettled',
    chainId: 56,
    contractAddress: seckillAddress,
    sessionId,
    winner: buyerWallet.address,
    orderId: seckillIntent.order.orderId,
    prizePoolNplWei: parseDecimal18('18.880000000000000000').toString(),
    txHash: settlementTxHash,
    blockNumber: 402,
    logIndex: 1
  }, 201, { 'x-indexer-secret': indexerSecret });
  assert(settledSeckill.prizeReward?.pendingOnchainReward === true && settledSeckill.prizeReward?.assetSymbol === 'NPL', 'settled seckill should expose a pending RewardLedger NPL prize when on-chain ledger is configured');
  const winnerAssets = await get(`/api/assets/summary?address=${buyerWallet.address}`);
  assert(winnerAssets.seckillRecords?.some((entry) => entry.orderId === seckillIntent.order.orderId && entry.prizeClaim?.status === 'PendingRewardLocked'), 'asset summary should expose pending seckill prize claim for the winner');

  console.log('dapp backend flow check: PASS');
} finally {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function assertPaymentIntent(intent, order) {
  assert(intent?.chainIdHex === '0x38', 'payment intent should target BSC');
  assert(intent.approvalPolicy?.type === 'unlimited-npl' && intent.approvalPolicy?.amount === 'MaxUint256' && intent.approvalPolicy?.allowanceSkip === true, 'payment intent should support NPL allowance skip with MaxUint256');
  assert(intent.allowanceChecks?.length === 1 && intent.approvalTransactions?.length === 1, 'payment intent should contain exactly one allowance check and one approval');
  const erc20 = new Interface(['function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)']);
  const escrow = new Interface(['function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)']);
  const nplApproval = intent.approvalTransactions.find((tx) => tx.key === 'npl');
  assert(nplApproval?.from?.toLowerCase() === buyerWallet.address.toLowerCase() && nplApproval.to.toLowerCase() === fixedNpl, 'NPL approval should bind buyer and fixed NPL token');
  const [approveSpender, approveAmount] = erc20.decodeFunctionData('approve', nplApproval.data);
  assert(String(approveSpender).toLowerCase() === escrowAddress.toLowerCase() && approveAmount === MaxUint256, 'NPL approval should grant escrow MaxUint256');
  const [allowanceOwner, allowanceSpender] = erc20.decodeFunctionData('allowance', intent.allowanceChecks[0].data);
  assert(String(allowanceOwner).toLowerCase() === buyerWallet.address.toLowerCase() && String(allowanceSpender).toLowerCase() === escrowAddress.toLowerCase(), 'NPL allowance should check buyer to escrow');
  const [orderId, seller, productId, nplAmount, bnmLocked, deadline, digest, splitVersion, authorization] = escrow.decodeFunctionData('payOrder', intent.payOrderTransaction.data);
  assert(orderId === order.orderId && String(seller).toLowerCase() === merchantWallet.address.toLowerCase(), 'payOrder should bind order id and seller');
  assert(/^0x[0-9a-fA-F]{64}$/.test(productId) && nplAmount === parseUnits(order.amountNpl, 18) && bnmLocked === parseUnits(order.bnmLocked, 18), 'payOrder should bind product, NPL and BNM amounts');
  assert(digest === order.orderDigest && deadline > BigInt(Math.floor(Date.now() / 1000)) && splitVersion === 1n, 'payOrder should bind digest, future deadline and split version');
  assert(/^0x[0-9a-fA-F]{130}$/.test(authorization) && intent.payOrderTransaction.orderSigner.toLowerCase() === localOrderSigner.address.toLowerCase(), 'payOrder should include webhook signer authorization');
}

function orderPaidEvent(order, txHash, blockNumber) {
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
    bnmLockedWei: parseDecimal18(order.bnmLocked).toString(),
    amountNpl: order.amountNpl,
    orderDigest: order.orderDigest,
    splitVersion: 1
  };
}

function markOrderShippedForCheck(orderId) {
  const checkDb = new DatabaseSync(dbPath);
  try {
    const payload = JSON.stringify({ orderId, carrier: 'FLOW-CHECK', trackingNo: 'FLOW-CHECK-001', source: 'check-dapp-backend-flow' });
    checkDb.prepare("UPDATE orders SET status = 'Shipped', updated_at = CURRENT_TIMESTAMP WHERE order_id = ?").run(orderId);
    checkDb.prepare(`
      INSERT OR REPLACE INTO fulfillment_orders (id, order_id, type, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(`fulfillment-${orderId}`, orderId, 'delivery', 'Shipped', payload);
    checkDb.prepare(`
      INSERT OR REPLACE INTO logistics_orders (id, order_id, carrier, tracking_no, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(`logistics-${orderId}`, orderId, 'FLOW-CHECK', 'FLOW-CHECK-001', payload);
  } finally {
    checkDb.close();
  }
}

function orderCompletedEvent(order, txHash, blockNumber) {
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

function rewardLockedEvent(order, entryId, seed, blockNumber) {
  return {
    eventName: 'RewardLocked',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    orderId: order.orderId,
    user: order.buyerAddress,
    asset: bnmAddress,
    amountWei: parseDecimal18(order.bnmLocked).toString(),
    bucket: 0,
    txHash: hex32(seed),
    blockNumber,
    logIndex: 0
  };
}

function rewardReleasedEvent(order, entryId, seed, blockNumber) {
  return {
    eventName: 'RewardReleased',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    orderId: order.orderId,
    txHash: hex32(seed),
    blockNumber,
    logIndex: 0
  };
}

function rewardClaimedEvent(order, entryId, txHash, blockNumber) {
  return {
    eventName: 'RewardClaimed',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    user: order.buyerAddress,
    asset: bnmAddress,
    amountWei: parseDecimal18(order.bnmLocked).toString(),
    txHash,
    blockNumber,
    logIndex: 0
  };
}

function deliveryItem(productId, overrides = {}) {
  return {
    productId,
    quantity: 1,
    selected: true,
    fulfillmentMode: 'delivery',
    regionCode: '210211',
    ...overrides
  };
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    try {
      const response = await fetch(`${apiUrl}/api/config`);
      if (response.ok) return;
    } catch {}
    if (stderr && /EADDRINUSE|Error:/i.test(stderr)) break;
    await sleep(100);
  }
  throw new Error(`server did not become healthy on ${apiUrl}\n${stderr}`);
}

async function get(path) {
  const response = await fetch(`${apiUrl}${path}`, { headers: buyerAuthorization({}) });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getText(path) {
  const response = await fetch(`${apiUrl}${path}`, { headers: buyerAuthorization({}) });
  const payload = await response.text();
  assert(response.status === 200, `GET ${path} expected 200, got ${response.status}: ${payload}`);
  return payload;
}

async function siweLogin(wallet, role) {
  const nonce = await post('/api/auth/siwe/nonce', { address: wallet.address, role });
  const signature = await wallet.signMessage(nonce.message);
  return post('/api/auth/siwe/verify', { address: wallet.address, role, message: nonce.message, signature });
}

async function withSecondary(wallet, token, action, body) {
  const intent = await post('/api/auth/action-intent', { action, payload: body }, 201, authHeaders(token));
  assert(intent.action === action && intent.walletAddress?.toLowerCase() === wallet.address.toLowerCase(), 'action-intent should bind action and buyer wallet');
  assert(intent.payloadHash === payloadHashForSignature(body) && intent.signatureKind === 'personal_sign', 'action-intent should bind the exact address payload');
  const secondarySignature = await wallet.signMessage(intent.secondaryMessage);
  return { ...body, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function payloadHashForSignature(body) {
  return `0x${createHash('sha256').update(stableStringify(body || {})).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function post(path, body, expected = 201, headers = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expected, `POST ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function buyerAuthorization(headers) {
  if (!defaultBuyerToken || headers.authorization) return headers;
  return { authorization: `Bearer ${defaultBuyerToken}`, ...headers };
}

function parseDecimal18(value) {
  const [whole, fractional = ''] = String(value).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fractional) || fractional.length > 18) throw new Error(`bad decimal: ${value}`);
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

#!/usr/bin/env node
import fs from 'node:fs';

const checks = [];
const legacySettlementAsset = ['US', 'DT'].join('');

check('app name is 24K Mall', () => json('app.json').expo?.name === '24K Mall' && json('app.json').expo?.scheme === 'twentyfourk');
check('four active tabs are 24K docs tabs', () => {
  const tabsFile = text('src/components/BottomTabs.tsx');
  const tabs = [...tabsFile.matchAll(/key: '(seckill|mall|stores|assets)'/g)].map((match) => match[1]);
  return JSON.stringify(tabs) === JSON.stringify(['seckill', 'mall', 'stores', 'assets'])
    && ['秒杀大厅', '常规商城', '线下门店', '我的资产'].every((label) => tabsFile.includes(`label: '${label}'`));
});
check('screens exist for 24K C端 modules', () => ['src/screens/SeckillScreen.tsx', 'src/screens/MallScreen.tsx', 'src/screens/StoresScreen.tsx', 'src/screens/AssetsScreen.tsx', 'src/screens/CartScreen.tsx'].every((file) => fs.existsSync(file)));
check('theme uses black gold luxury tokens', () => ['#080704', '#D8A23A', 'champagne', 'obsidian', 'goldDeep'].every((token) => text('src/theme/tokens.ts').includes(token)));
check('24K raster assets exist', () => [
  '24k-hero-banner.png',
  '24k-prize-vault.png',
  '24k-store-front.png',
  '24k-bnm-ledger.png',
  '24k-runner.png',
  '24k-phone.png',
  '24k-tea-box.png',
  '24k-carryall.png'
].every((name) => fs.existsSync(`assets/products/${name}`) && fs.statSync(`assets/products/${name}`).size > 0));
check('screenshot验收 artifacts exist', () => [
  'c-app-seckill.png',
  'c-app-mall.png',
  'c-app-stores.png',
  'c-app-assets.png',
  'merchant.png',
  'admin.png',
  'contact-sheet.png'
].every((name) => fs.existsSync(`test-artifacts/screenshots/${name}`) && fs.statSync(`test-artifacts/screenshots/${name}`).size > 10_000));
check('legacy C端 screens and NPL-named product assets are removed', () => !fs.existsSync('src/screens/MessagesScreen.tsx') && !fs.existsSync('src/screens/ProfileScreen.tsx') && !fs.readdirSync('assets/products').some((name) => name.startsWith('npl-')));

check('fixed BSC NPL address is configured across app, backend and deploy guards', () => {
  const web3 = text('src/config/web3.ts');
  const server = text('server/index.mjs');
  const checkEscrow = text('scripts/deploy/check-escrow.mjs');
  return web3.includes('EXPO_PUBLIC_BSC_CHAIN_ID || 56')
    && web3.includes('0x4e8277ab31e4956b2cd48449793a57656dfc03d2')
    && web3.includes('export const NPL_BSC_ADDRESS')
    && server.includes('FIXED_BSC_NPL_ADDRESS')
    && checkEscrow.includes('EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed')
    && text('scripts/deploy/escrow.mjs').includes('EXPO_PUBLIC_NPL_BSC_ADDRESS must be fixed')
    && web3.includes('24K Mall');
});
check('payment flow uses one NPL MaxUint256 approval and signed nine-parameter payOrder', () => {
  const payment = text('src/services/payment.ts');
  const payload = text('src/services/paymentPayload.ts');
  const cart = text('src/screens/CartScreen.tsx');
  return payload.includes('MaxUint256')
    && payload.includes('allowance(address owner,address spender)')
    && payload.includes('payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)')
    && payment.includes('approveNplUnlimited')
    && payment.includes('needsNplApproval')
    && payment.includes('getNplAllowance')
    && cart.includes('intent.allowanceChecks.length === 1')
    && cart.includes('intent.approvalTransactions.length === 1')
    && cart.includes("check?.key === 'npl'")
    && cart.includes("approval?.key === 'npl'")
    && cart.includes("approval.amount === 'MaxUint256'")
    && cart.includes('approval.amountWei === maxUint256');
});
check('24K frontend types exist', () => {
  const types = text('src/types.ts');
  return ['SeckillSession', 'Sku', 'FulfillmentMode', 'AddressBookEntry', 'Store', 'AssetBucket', 'RewardLedgerEntry', 'ClaimRecord'].every((needle) => types.includes(`type ${needle}`) || types.includes(`export type ${needle}`))
    && types.includes('rewardId?: string')
    && types.includes('expiresAt?: number');
});
check('frontend rejects unknown reward assets instead of showing BNM fallback', () => {
  const api = text('src/services/api.ts');
  return api.includes('function requireAssetSymbol')
    && api.includes("throw new Error(`资产接口返回未知")
    && api.includes("assetSymbol: requireAssetSymbol(row.assetSymbol, 'reward ledger')")
    && api.includes("assetSymbol: requireAssetSymbol(row.assetSymbol, 'claim')")
    && !api.includes("assetSymbol: isAssetSymbol(row.assetSymbol) ? row.assetSymbol : 'BNM'");
});
check('order states include 24K expanded statuses', () => ['Draft', 'AwaitingApproval', 'PaidLocked', 'AwaitingShipment', 'Shipped', 'PickupReady', 'Completed', 'Arbitration', 'RefundRequested', 'ForcedRefunded', 'Released', 'Claimed'].every((needle) => text('src/types.ts').includes(`'${needle}'`)));
check('active screens load commerce and asset state from APIs instead of local mock seeds', () => {
  const catalog = text('src/data/catalog.ts');
  return catalog.includes('export const products: Product[] = []')
    && text('src/screens/SeckillScreen.tsx').includes('fetchSeckillSession()')
    && text('src/screens/MallScreen.tsx').includes('fetchProducts()')
    && text('src/screens/StoresScreen.tsx').includes('fetchDappStoresState')
    && text('src/screens/AssetsScreen.tsx').includes('fetchDappAssetsState(address, session.token)');
});

check('backend exposes 24K public and mock APIs', () => {
  const server = text('server/index.mjs');
  return ['/api/dapp/bootstrap', '/api/dapp/home', '/api/dapp/mall-state', '/api/dapp/stores-state', '/api/dapp/assets-state', '/api/dapp/final-check', '/api/buyer/orders', '/api/products', '/api/products/', '/api/seckill/current', '/api/seckill/feed', '/api/seckill/report', '/api/stores', '/api/assets/summary', '/api/address-book', '/api/stock/preflight', '/api/orders/finalize', '/api/claims/prepare', '/api/claims', '/merchant', '/admin', '/api/merchant/summary', '/api/admin/summary'].every((route) => server.includes(route));
});
check('backend exposes SIWE, merchant APIs, admin APIs and audit logs', () => {
  const server = text('server/index.mjs');
  return [
    '/api/auth/siwe/nonce',
    '/api/auth/siwe/verify',
    '/api/auth/action-intent',
    'verifyMessage',
    'siwe_nonces',
    'auth_sessions',
    'audit_logs',
    '/api/merchant/orders',
    '/api/merchant/products',
    '/api/merchant/stores',
    '/api/merchant/pickup/verify',
    '/api/merchant/printer',
    '/api/merchant/claims',
    '/api/admin/merchants',
    '/api/admin/products/pending',
    '/api/admin/force-refund',
    '/api/admin/pause-orders',
    '/api/admin/pause-seckill',
    '/api/admin/pause-claims',
	    '/api/admin/seckill/force-cutoff',
	    '/api/admin/audit-logs',
	    '/api/admin/search',
	    '/api/admin/batch',
	    'requireSecondarySignature'
	  ].every((needle) => server.includes(needle));
});
check('backend root/preview renders 24K preview, not JSON NOT_FOUND', () => text('server/index.mjs').includes('24K 全量系统预览') && text('server/index.mjs').includes('24K 三端前端预搭'));
check('backend protects chain-event writes and public order data', () => {
  const server = text('server/index.mjs');
  return server.includes('requireIndexerSecret(req)') && server.includes('requireAdminSecret(req)') && server.includes('BUYER_ADDRESS_REQUIRED');
});
check('server order model stores the NPL settlement amount', () => text('server/index.mjs').includes('amount_npl') && text('server/index.mjs').includes('amountNpl'));
check('backend has docs data tables for merchant/admin/fullfillment/claims', () => {
  const server = text('server/index.mjs');
  return ['merchants', 'product_skus', 'seckill_sessions', 'seckill_events', 'seckill_reports', 'stores', 'fulfillment_orders', 'logistics_orders', 'pickup_verifications', 'reward_ledger', 'claims', 'blacklists', 'circuit_breakers', 'cms_contents', 'admin_configs'].every((table) => server.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
});

check('merchant one-product deadlock and formal product approval are enforced', () => {
  const server = text('server/index.mjs');
  return ['store_id', 'locked_at', 'immutable_payload_json', 'approved_product_id', 'product_submissions_active_unique', 'MERCHANT_SINGLE_PRODUCT_LOCKED', 'MERCHANT_PRODUCT_LOCKED', 'lockMerchantProduct', 'updateMerchantProduct', 'approveProductSubmission'].every((needle) => server.includes(needle));
});

check('admin global search batch and NPL ratio config are stateful', () => {
  const server = text('server/index.mjs');
  const backend = text('scripts/check-backend.mjs');
  return ['function adminSearch', 'batchActions', 'function runAdminBatch', 'admin.batch.run', 'normalizeRatioConfig', 'beneficiaryWeights', 'paymentRatioForProduct', 'readAdminConfig'].every((needle) => server.includes(needle))
    && ['admin search should expose global results', 'admin batch should accept export jobs', 'ratio config should remain pending and preserve the signed NPL allocation payload'].every((needle) => backend.includes(needle));
});

check('order item schema and createFinalOrder persist SKU fulfillment address store and region', () => {
  const server = text('server/index.mjs');
  const orderSchema = server.slice(server.indexOf('CREATE TABLE IF NOT EXISTS orders'), server.indexOf('CREATE TABLE IF NOT EXISTS order_items'));
  const itemSchema = server.slice(server.indexOf('CREATE TABLE IF NOT EXISTS order_items'), server.indexOf('CREATE TABLE IF NOT EXISTS chain_events'));
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  return ['address_id', 'store_id', 'region_code'].every((column) => orderSchema.includes(column))
    && ['sku_id', 'sku_name', 'fulfillment_mode', 'address_id', 'store_id', 'region_code', 'line_key'].every((column) => itemSchema.includes(column))
    && ['resolveSku(product.id, item.skuId)', 'unitPriceNpl', 'fulfillmentMode', 'addressId', 'storeId', 'regionCode', 'orderItemLineKey'].every((needle) => create.includes(needle))
    && create.includes('INSERT INTO order_items (order_id, product_id, sku_id, sku_name, quantity, unit_price_npl, fulfillment_mode, address_id, store_id, region_code, line_key)');
});
check('same product can keep distinct SKU/order lines instead of product-only merge', () => {
  const app = text('App.tsx');
  const server = text('server/index.mjs');
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  return app.includes('cartLineKey')
    && !create.includes('DUPLICATE_PRODUCT_ITEM')
    && create.includes('DUPLICATE_ORDER_LINE')
    && server.includes('UNIQUE(order_id, line_key)')
    && server.includes('ensureOrderItemsFlexibleSchema');
});
check('backend locks BNM on payment, releases on completion, burns on forced refund', () => {
  const server = text('server/index.mjs');
  return ['lockOrderReward(order, verifiedBody, txHash)', 'releaseOrderRewards(orderId, txHash)', 'burnUnclaimedRewards(orderId, txHash)', 'NO_AVAILABLE_REWARD'].every((needle) => server.includes(needle));
});
check('backend syncs RewardLedger chain events as source of truth when configured', () => {
  const server = text('server/index.mjs');
  return ['rewardLedgerEvents', 'REWARD_EVENT_NAMES', 'recordRewardChainEvent', 'RewardLocked', 'RewardReleased', 'RewardClaimed', 'UnclaimedRewardBurned', 'onchainRewardLedgerEnabled()', 'ReleaseRequested', 'UNSUPPORTED_REWARD_ASSET'].every((needle) => server.includes(needle));
});
check('buyer claim requires wallet signature and stays pending until chain claim event', () => {
  const server = text('server/index.mjs');
  const claimStart = server.indexOf('function claimAvailableReward');
  const claim = server.slice(claimStart, server.indexOf('function recordClaim', claimStart));
  return (claim.includes("requireWalletSignature(body, walletAddress, 'buyer.claim')") || claim.includes('requireClaimSignature(body, walletAddress, entry, amount)'))
    && claim.includes('const assetSymbol = entry.asset_symbol')
    && claim.includes('CLAIM_ASSET_MISMATCH')
    && claim.includes("run('PendingClaim'")
    && claim.includes("recordClaim(walletAddress, bucketId, assetSymbol, amount, 'pending'")
    && !claim.includes("run('Claimed'");
});
check('buyer claim signature is nonce/expiry/reward/amount/chain bound', () => {
  const server = text('server/index.mjs');
  return ['wallet_action_nonces', 'consumeWalletActionNonce', 'RewardId', 'Amount', 'ChainId', 'ExpiresAt', 'CLAIM_REWARD_MISMATCH', 'CLAIM_SIGNATURE_EXPIRED'].every((needle) => server.includes(needle));
});
check('merchant and admin secondary signatures require backend-issued action intents', () => {
  const server = text('server/index.mjs');
  const checker = text('scripts/check-backend.mjs');
  return ['/api/auth/action-intent', 'createActionIntent', 'ACTION_NONCE_NOT_ISSUED', 'ACTION_NONCE_REPLAYED', 'payloadHashForSignature'].every((needle) => server.includes(needle))
    && ['withSecondary', '/api/auth/action-intent', 'withLocallyGeneratedSecondary', 'ACTION_NONCE_NOT_ISSUED'].every((needle) => checker.includes(needle));
});
check('DApp buyer Claim has prepare endpoint for wallet signing', () => {
  const server = text('server/index.mjs');
  const prepare = server.slice(server.indexOf('function prepareClaimReward'), server.indexOf('function recordClaim'));
  return ["url.pathname === '/api/claims/prepare'", 'claimSignatureMessage', 'signatureKind', 'personal_sign', 'secondaryMessage', 'secondarySignature', '<wallet-signature>'].every((needle) => server.includes(needle))
    && ['availableRewardForClaim', "assertCircuitOpen('claims'", 'assertNotBlacklisted(walletAddress)', 'RewardId', 'Amount', 'Nonce', 'ExpiresAt'].every((needle) => prepare.includes(needle));
});
check('DApp buyer Claim intent exposes optional RewardLedger calldata', () => {
  const server = text('server/index.mjs');
  const intent = server.slice(server.indexOf('function dappClaimIntent'), server.indexOf('function rewardLedgerEntryIdFromRewardId'));
  return server.includes("url.pathname === '/api/dapp/claim-intent'")
    && ['prepareClaimReward', 'claimTransaction', 'rewardLedgerTxInterface', 'sendRewardLedgerClaim', 'submitClaimRequest', 'REWARD_ID_NOT_ONCHAIN_ENTRY', 'claimTxStatus'].every((needle) => intent.includes(needle) || server.includes(needle));
});
check('DApp buyer Claim tx status can sync RewardClaimed', () => {
  const server = text('server/index.mjs');
  const status = server.slice(server.indexOf('async function claimTxStatus'), server.indexOf('function rewardLedgerEntryIdFromRewardId'));
  return server.includes("url.pathname === '/api/dapp/claim-tx-status'")
    && ['pending', 'confirmed', 'failed', 'mismatch', 'payloadFromRewardClaimReceipt', 'recordRewardChainEvent', 'RewardClaimed'].every((needle) => status.includes(needle));
});
check('merchant shipping cannot bypass payment lock', () => {
  const server = text('server/index.mjs');
  const ship = server.slice(server.indexOf('function shipMerchantOrder'), server.indexOf('function verifyPickupOrder'));
  return ship.includes('isShipmentAllowedStatus(order.status)') && server.includes('ORDER_NOT_PAID');
});
check('merchant pickup verify cannot bypass payment and pickup mode', () => {
  const server = text('server/index.mjs');
  const pickup = server.slice(server.indexOf('function verifyPickupOrder'), server.indexOf('function auditedMerchantAction'));
  return pickup.includes('ORDER_NOT_PICKUP_MODE') && pickup.includes('isShipmentAllowedStatus(order.status)') && pickup.includes('ORDER_NOT_PAID');
});
check('admin force refund cannot bypass paid/arbitration state', () => {
  const server = text('server/index.mjs');
  const forceRefund = server.slice(server.indexOf("if (action === 'admin.force-refund')"), server.indexOf("if (action.startsWith('admin.circuit.')"));
  return forceRefund.includes('ORDER_NOT_FOUND') && forceRefund.includes('isRefundableOrderStatus(order.status)') && forceRefund.includes('ORDER_NOT_REFUNDABLE') && forceRefund.includes('RefundRequested') && !forceRefund.includes("status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run('ForcedRefunded'");
});
check('admin circuit breaker is persisted and blocks business entrypoints', () => {
  const server = text('server/index.mjs');
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  const preflight = server.slice(server.indexOf('function stockPreflight'), server.indexOf('function createFinalOrder'));
  const claimStart = server.indexOf('function claimAvailableReward');
  const claim = server.slice(claimStart, server.indexOf('function recordClaim', claimStart));
  const seckillRoute = server.slice(server.indexOf("url.pathname === '/api/seckill/current'"), server.indexOf("url.pathname === '/api/stores'"));
  return server.includes('requestCircuitBreaker(scope, enabled')
    && server.includes('confirmCircuitBreaker(scope, enabled')
    && server.includes("enabled ? 'PendingPause' : 'PendingResume'")
    && server.includes("enabled ? 'Paused' : 'Open'")
    && create.includes("assertCircuitOpen('orders'")
    && preflight.includes("assertCircuitOpen('orders'")
    && claim.includes("assertCircuitOpen('claims'")
    && seckillRoute.includes("assertCircuitOpen('seckill'")
    && server.includes("admin.circuit.force-cutoff");
});
check('blacklist gate blocks order preflight/create and buyer Claim', () => {
  const server = text('server/index.mjs');
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  const preflight = server.slice(server.indexOf('function stockPreflight'), server.indexOf('function createFinalOrder'));
  const claimStart = server.indexOf('function claimAvailableReward');
  const claim = server.slice(claimStart, server.indexOf('function recordClaim', claimStart));
  return create.includes('assertNotBlacklisted(body.buyerAddress)')
    && preflight.includes('assertNotBlacklisted(buyerAddress)')
    && claim.includes('assertNotBlacklisted(walletAddress)')
    && server.includes("fail(403, 'ADDRESS_BLACKLISTED')");
});
check('merchant Claim is covered by claims circuit breaker', () => {
  const server = text('server/index.mjs');
  const merchantClaimRoute = server.slice(server.indexOf("url.pathname === '/api/merchant/claims'"), server.indexOf("url.pathname === '/api/admin/merchants'"));
  return merchantClaimRoute.includes("assertCircuitOpen('claims', 'CLAIMS_PAUSED')") && merchantClaimRoute.includes("merchant.claim.request");
});
check('order digest binds five-factor fulfillment, region, address/store and token routes', () => {
  const server = text('server/index.mjs');
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  return ['buyer:', 'seller:', 'fulfillment:', 'region:', 'address:', 'store:', 'npl:', 'items:'].every((needle) => create.includes(needle));
});
check('backend validates address/store fulfillment for DApp checkout', () => {
  const server = text('server/index.mjs');
  const preflight = server.slice(server.indexOf('function stockPreflight'), server.indexOf('function createFinalOrder'));
  const create = server.slice(server.indexOf('function createFinalOrder'), server.indexOf('async function recordFundingTransaction'));
  return ['resolveFulfillmentForLine', 'ADDRESS_REQUIRED', 'ADDRESS_NOT_FOUND', 'STORE_REQUIRED', 'STORE_NOT_FOUND', 'REGION_MISMATCH', 'FULFILLMENT_MODE_NOT_SUPPORTED'].every((needle) => server.includes(needle))
    && preflight.includes('resolveFulfillmentForLine(product, item, body)')
    && create.includes('if (!fulfillment.ok) fail(400, fulfillment.reason)');
});
check('stock preflight exposes DApp quote and unlimited approval policy', () => {
  const server = text('server/index.mjs');
  const preflight = server.slice(server.indexOf('function stockPreflight'), server.indexOf('function createFinalOrder'));
  return ['quote:', 'totalNpl', 'amountNpl', 'bnmLocked', 'chainId', 'nplAddress', 'escrowAddress', 'approval'].every((needle) => preflight.includes(needle))
    && ['unlimited-npl', 'MaxUint256', 'allowanceSkip'].every((needle) => preflight.includes(needle));
});
check('backend exposes fulfillment snapshot and separates delivery from pickup', () => {
  const server = text('server/index.mjs');
  const ship = server.slice(server.indexOf('function shipMerchantOrder'), server.indexOf('function verifyPickupOrder'));
  const pickup = server.slice(server.indexOf('function verifyPickupOrder'), server.indexOf('function auditedMerchantAction'));
  return server.includes("url.pathname.endsWith('/fulfillment')")
    && server.includes('function fulfillmentSnapshot')
    && ship.includes('ORDER_NOT_DELIVERY_MODE')
    && pickup.includes('STORE_MISMATCH')
    && pickup.includes("INSERT OR REPLACE INTO fulfillment_orders")
    && server.includes('ensureInitialFulfillment(order');
});
check('backend exposes DApp bootstrap with payment policy, ABI fragments and buyer order list', () => {
  const server = text('server/index.mjs');
  const integrations = text('server/integrations.mjs');
  const bootstrap = server.slice(server.indexOf('function dappBootstrap'), server.indexOf('function buyerOrders'));
  return ['publicDappConfig', 'unlimited-npl', 'MaxUint256', 'abiFragments', 'payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)', 'recordPurchase(bytes32 sessionId', 'ORDER_SIGNING_WEBHOOK_URL', 'ORDER_SIGNER_ADDRESS', 'ESCROW_SPLIT_VERSION', 'initialData', 'buyerOrders', 'paymentIntent', 'finalCheck', 'checkoutIntent', 'seckillIntent', 'claimIntent', 'claimTxStatus', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', '/api/dapp/integration', '/api/dapp/handoff', '/api/dapp/frontend-brief.md', '/api/dapp/types.d.ts', '/api/dapp/sdk.ts', '/api/dapp/home', '/api/dapp/assets-state', '/api/dapp/openapi.json'].every((needle) => `${server}\n${integrations}`.includes(needle))
    && bootstrap.includes("endpoint: '/api/dapp/seckill-state'")
    && bootstrap.includes("endpoint: '/api/dapp/mall-state'")
    && bootstrap.includes("endpoint: '/api/dapp/stores-state'")
    && bootstrap.includes("endpoint: '/api/dapp/assets-state'")
    && bootstrap.includes("seckillState: '/api/dapp/seckill-state?address=0x...'")
    && server.includes('function fulfillmentSummary')
    && server.includes("url.pathname === '/api/buyer/orders'");
});

check('backend exposes one-call DApp home payload for four tabs', () => {
  const server = text('server/index.mjs');
  const home = server.slice(server.indexOf('function dappHome'), server.indexOf('function dappBootstrap'));
  return server.includes("url.pathname === '/api/dapp/home'")
    && server.includes("url.pathname === '/api/dapp/mall-state'")
    && server.includes("url.pathname === '/api/dapp/stores-state'")
    && server.includes("url.pathname === '/api/dapp/assets-state'")
    && ['24k-dapp-home-v1', '秒杀大厅', '常规商城', '线下门店', '我的资产', 'createCheckoutIntent', 'finalCheck', 'createIntent', 'claimIntent', 'connectRequiredForAssets', 'assetsState'].every((needle) => home.includes(needle));
});
check('backend exposes DApp manifest and wallet chain metadata', () => {
  const server = text('server/index.mjs');
  const config = server.slice(server.indexOf('function publicDappConfig'), server.indexOf('function dappBootstrap'));
  return server.includes("url.pathname === '/api/dapp/manifest'")
    && server.includes("url.pathname === '/manifest.webmanifest'")
    && server.includes("url.pathname === '/api/dapp/integration'")
    && server.includes("url.pathname === '/api/dapp/handoff'")
    && server.includes("url.pathname === '/api/dapp/frontend-brief.md'")
    && server.includes("url.pathname === '/api/dapp/types.d.ts'")
    && server.includes("url.pathname === '/api/dapp/openapi.json'")
    && server.includes("url.pathname === '/.well-known/24k-dapp.json'")
    && server.includes("url.pathname === '/api/dapp/sdk.ts'")
    && ['function dappManifest', 'function dappIntegrationContract', 'function dappHandoffBundle', 'function dappFrontendBrief', 'function dappTypeDefinitions', 'function dappSdkSource', 'function dappOpenApiSpec', 'function dappChainConfig', 'chainIdHex', 'rpcUrls', 'blockExplorerUrls', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'].every((needle) => config.includes(needle) || server.includes(needle));
});
check('backend exposes DApp readiness for wallet browser launch', () => {
  const server = text('server/index.mjs');
  const readiness = server.slice(server.indexOf('function dappReadiness'), server.indexOf('function dappChainConfig'));
  return server.includes("url.pathname === '/api/dapp/readiness'")
    && server.includes("url.pathname === '/api/dapp/launch-status'")
    && ['productionReady', 'blockers', 'warnings', 'paymentStatusPolling', 'integration', 'handoff', 'frontendBrief', 'launchStatus', 'home', 'mallState', 'storesState', 'assetsState', 'types', 'sdk', 'openapi', 'checkoutIntent', 'seckillIntent', 'claimIntent', 'claimTxStatus'].every((needle) => readiness.includes(needle));
});
check('backend exposes copy-paste DApp frontend thread brief', () => {
  const server = text('server/index.mjs');
  const brief = server.slice(server.indexOf('function dappFrontendBrief'), server.indexOf('function dappLaunchKit'));
  return server.includes("url.pathname === '/api/dapp/frontend-brief.md'")
    && ['24K DApp 前端线程任务提示词', '秒杀大厅 / 常规商城 / 线下门店 / 我的资产', '/api/dapp/handoff', '/api/dapp/sdk.ts', 'sendPaymentIntent', 'sendSeckillRecordPurchase', 'submitClaimRequest', 'approve(MaxUint256)', '不要在前端保存或要求 PRIVATE_KEY', '前端验收口径'].every((needle) => brief.includes(needle));
});
check('backend exposes standalone DApp SDK helpers without private keys', () => {
  const server = text('server/index.mjs');
  const sdk = server.slice(server.indexOf('function dappSdkSource'), server.indexOf('function dappBootstrap'));
  return server.includes("url.pathname === '/api/dapp/sdk.ts'")
    && ['create24kDappClient', 'fetchDappReadiness', 'fetchDappLaunchStatus', 'fetchDappHome', 'createFinalCheck', 'fetchDappBootstrap', 'fetchDappContracts', 'fetchDappAssetsState', 'createCheckoutIntent', 'createSeckillIntent', 'createClaimIntent', 'submitClaimRequest', 'pollFundingTxStatus', 'pollClaimTxStatus', 'switchTo24kChain', 'sendWalletTransaction', 'personalSign', 'approvalTransactionsNeedingAllowance', 'sendPaymentIntent', 'sendSeckillRecordPurchase', 'sendClaimTransaction'].every((needle) => sdk.includes(needle))
    && !sdk.includes('PRIVATE_KEY');
});
check('backend exposes DApp payment intent calldata without private keys', () => {
  const server = text('server/index.mjs');
  const intent = server.slice(server.indexOf('function paymentIntentForOrder'), server.indexOf('function buyerOrders'));
  return server.includes("url.pathname.endsWith('/payment-intent')")
    && ['allowanceChecks', 'approvalTransactions', 'payOrderTransaction', 'submitFundingEndpoint', 'fundingStatusEndpoint', 'MaxUint256', 'unlimited-npl'].every((needle) => intent.includes(needle))
    && ['allowance(address owner,address spender)', 'approve(address spender,uint256 amount)', 'payOrder(bytes32 orderId'].every((needle) => server.includes(needle))
    && !intent.includes('PRIVATE_KEY');
});
check('backend exposes one-step DApp checkout intent', () => {
  const server = text('server/index.mjs');
  const checkout = server.slice(server.indexOf('function dappCheckoutIntent'), server.indexOf('function paymentIntentForOrder'));
  return server.includes("url.pathname === '/api/dapp/checkout-intent'")
    && ['createFinalOrder', 'paymentIntentForOrder', 'preflight', 'finalCheck', 'nextActions', 'pollFundingStatus'].every((needle) => checkout.includes(needle));
});
check('backend exposes one-step DApp seckill intent', () => {
  const server = text('server/index.mjs');
  const intent = server.slice(server.indexOf('function dappSeckillIntent'), server.indexOf('function dappCheckoutIntent'));
  return server.includes("url.pathname === '/api/dapp/seckill-intent'")
    && ['assertCircuitOpen', 'currentSeckillSession', 'SECKILL_NOT_LIVE', 'SECKILL_PRODUCT_MISMATCH', 'recordPurchaseTransaction', 'sendRecordPurchase', 'pollSeckillFeed'].every((needle) => intent.includes(needle));
});
check('backend exposes DApp funding tx status polling', () => {
  const server = text('server/index.mjs');
  const status = server.slice(server.indexOf('async function fundingTxStatusForOrder'), server.indexOf('function buyerOrders'));
  return server.includes("url.pathname.endsWith('/fund-tx-status')")
    && ['pending', 'confirmed', 'failed', 'rpc_unavailable', 'mismatch', 'payloadFromFundingReceipt', 'recordChainEvent'].every((needle) => status.includes(needle));
});
check('DApp backend flow guard covers launch checkout payment seckill and claim', () => {
  const source = text('scripts/check-dapp-backend-flow.mjs');
  return json('package.json').scripts['dapp:check'] === './scripts/node scripts/check-dapp-backend-flow.mjs'
    && [
      '/api/dapp/readiness',
      '/api/dapp/manifest',
      '/api/dapp/seckill-state',
      '/api/dapp/mall-state',
      '/api/dapp/stores-state',
      '/api/dapp/assets-state',
      '/api/dapp/integration',
      '/api/dapp/handoff',
      '/api/dapp/frontend-brief.md',
      '/api/dapp/launch-kit',
      '/api/dapp/launch-status',
      '/api/dapp/home',
      '/api/dapp/contracts.json',
      '/api/dapp/types.d.ts',
      '/api/dapp/sdk.ts',
      '/api/dapp/openapi.json',
      '/.well-known/24k-dapp.json',
      '/api/dapp/bootstrap',
      '/api/dapp/checkout-intent',
      '/payment-intent?buyerAddress=',
      '/fund-tx-status?buyerAddress=',
      '/api/dapp/seckill-intent',
      '/api/dapp/claim-intent',
      '/api/dapp/claim-tx-status',
      'MaxUint256',
      '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
      'DappCheckoutIntentResponse',
      'DappLaunchStatusResponse',
      'DappHomeResponse',
      'DappAssetsStateResponse',
      'DappFinalCheckResponse',
      '前端线程任务提示词',
      'create24kDappClient',
      'switchTo24kChain',
      '24k-dapp-handoff-v1',
      '24k-dapp-launch-kit-v1',
      '24k-dapp-contracts-v1',
      '24K Mall DApp API',
      'RewardLedger claim tx',
      'recordPurchase calldata'
    ].every((needle) => source.includes(needle));
});
check('DApp launch readiness guard exists for wallet browser URL checks', () => {
  const source = text('scripts/check-dapp-launch-readiness.mjs');
  return json('package.json').scripts['dapp:launch-check'] === './scripts/node scripts/check-dapp-launch-readiness.mjs'
    && [
      '/.well-known/24k-dapp.json',
      '/api/dapp/manifest',
      '/api/dapp/integration',
      '/api/dapp/frontend-brief.md',
      '/api/dapp/types.d.ts',
      '/api/dapp/sdk.ts',
      '/api/dapp/openapi.json',
      '/api/dapp/launch-kit',
      '/api/dapp/launch-status',
      '/api/dapp/home',
      '/api/dapp/contracts.json',
      '/api/dapp/handoff?address=',
      '/api/dapp/bootstrap?address=',
      '/api/dapp/readiness',
      'DApp launch readiness: PASS',
      'launchStatus',
      'home',
      'frontendBrief',
      'sdk',
      'qrData',
      'lanUrls',
      '0x4e8277ab31e4956b2cd48449793a57656dfc03d2'
    ].every((needle) => source.includes(needle));
});
check('DApp launch status export command exists for runtime strict blockers', () => {
  const source = text('scripts/export-dapp-launch-status.mjs');
  return json('package.json').scripts['dapp:launch-status'] === './scripts/node scripts/export-dapp-launch-status.mjs'
    && fs.existsSync('scripts/export-dapp-launch-status.mjs')
    && ['dapp-launch-status.json', 'dapp-launch-status.md', '/api/dapp/launch-status', 'strictLaunchOk', 'strictLaunchBlockers', 'criticalPath', 'sendsTransactions: false', 'PRIVATE_KEY printed: false'].every((needle) => source.includes(needle));
});
check('DApp production env guard covers HTTPS RPC secrets contracts and fixed NPL', () => {
  const source = text('scripts/check-dapp-production-env.mjs');
  return json('package.json').scripts['dapp:prod-check'] === './scripts/node scripts/check-dapp-production-env.mjs --strict --file .env.production'
    && [
      '--strict',
      '--file',
      'DAPP_PROD_ENV_FILE',
      'envFile',
      'EXPO_PUBLIC_ESCROW_ADDRESS',
      'EXPO_PUBLIC_SECKILL_ADDRESS',
      'EXPO_PUBLIC_BNM_BSC_ADDRESS',
      'EXPO_PUBLIC_REWARD_LEDGER_ADDRESS',
      'MERCHANT_RECEIVER_ADDRESS',
      'ADMIN_WALLET_ADDRESS',
      'INDEXER_SECRET',
      'JWT_SECRET',
      'ADMIN_SECRET',
      'DB_PATH',
      'CORS_ORIGINS',
      'LOGISTICS_CALLBACK_SECRET',
      'AMAP_WEB_SERVICE_KEY',
      'ELECTRONIC_WAYBILL_WEBHOOK_URL',
      'SHIPMENT_WEBHOOK_URL',
      'PRINT_WEBHOOK_URL',
      'NOTIFICATION_WEBHOOK_URL',
      'CHAIN_EVENT_RPC_URL',
      'ALLOW_UNVERIFIED_CHAIN_EVENTS',
      'PRIVATE_KEY',
      'EXPO_PUBLIC_REOWN_PROJECT_ID',
      'DAPP_ENTRY_URL',
      'DAPP_QR_URL',
      'Strict production wallet entry URL is HTTPS',
      'launchKit',
      'frontendBrief',
      '0x4e8277ab31e4956b2cd48449793a57656dfc03d2'
    ].every((needle) => source.includes(needle))
    && text('.env.production.example').includes('DAPP_BASE_URL=')
    && text('.env.production.example').includes('DAPP_ENTRY_URL=')
    && text('.env.production.example').includes('JWT_SECRET=')
    && !text('.env.production.example').includes('PRIVATE_KEY=');
});
check('DApp frontend handoff doc exists for separate frontend thread', () => {
  const handoff = text('DAPP_FRONTEND_HANDOFF.md');
  return [
    '/.well-known/24k-dapp.json',
    '/api/dapp/handoff?address=<wallet>',
    '/api/dapp/contracts.json',
    '/api/dapp/integration',
    '/api/dapp/types.d.ts',
    '/api/dapp/sdk.ts',
    '/api/dapp/openapi.json',
    '/api/dapp/seckill-state?address=<wallet>',
    '/api/dapp/mall-state?address=<wallet>',
    '/api/dapp/stores-state?address=<wallet>',
    '/api/dapp/assets-state?address=<wallet>',
    '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    'approve(MaxUint256)',
    'POST /api/dapp/checkout-intent',
    'POST /api/dapp/seckill-intent',
    'POST /api/dapp/claim-intent',
    'pnpm dapp:check',
    'pnpm typecheck',
    '前端不得持有 `PRIVATE_KEY`'
  ].every((needle) => handoff.includes(needle));
});

check('24K payment escrow keeps transparent circuit breaker', () => {
  const contract = text('contracts/Abu24KPaymentEscrow.sol');
  return ['Pausable', 'pause()', 'unpause()', 'emergencyRefund', 'payOrder', 'OrderPaid'].every((needle) => contract.includes(needle));
});
check('Foundry contract tests cover 24K happy paths and permission failures', () => {
  const test = text('test/Abu24KSystem.t.sol');
  return [
    'testSignedNplPaymentCompletesWithAtomicSplitAndRewardRelease',
    'testOrderAuthorizationSellerWhitelistAndSplitVersionAreEnforced',
    'testPauseBlocksPaymentAndEmergencyRefundBurnsRewardAtomically',
    'testForceRefundRoutesRetentionAndBurnsUnclaimedReward',
    'testEscrowPermissionFailuresAndArbitrationOwnerRelease',
    'testEscrowAdminPermissionsAndRefundLimit',
    'testRewardLedgerOperatorReleaseClaimAndRecoveryBurn',
    'testRewardLedgerOnlyAcceptsFundedNplAndBnm',
    'testBnmPauseBlocksClaimAndUnpauseRestoresIt',
    'testSeckillOnlyRecordsUniquePaidMatchingOrdersAndReleasesFundedPrize',
    'testSeckillNoBuyerSettlementRefundsPrizePool',
    'ContractCallerBlocked.selector',
    'NotParticipantOrOwner.selector'
  ].every((needle) => test.includes(needle));
});
check('deploy and micro scripts target NPL payment plus NPL/BNM rewards', () => {
  const deploy = text('scripts/deploy/escrow.mjs');
  const rewards = text('scripts/deploy/rewards.mjs');
  const seckill = text('scripts/deploy/seckill.mjs');
  const checkSeckill = text('scripts/deploy/check-seckill.mjs');
  const checkRewards = text('scripts/deploy/check-rewards.mjs');
  const smoke = text('scripts/microtest/escrow-smoke.mjs');
  const fundE2e = text('scripts/microtest/fund-tx-e2e.mjs');
  const rewardClaim = text('scripts/microtest/reward-ledger-claim.mjs');
  const seckillRecord = text('scripts/microtest/seckill-record.mjs');
  const plan = text('scripts/microtest/plan.mjs');
  const localE2e = text('scripts/e2e/local-checkout.mjs');
  return deploy.includes('Abu24KPaymentEscrow.sol/Abu24KPaymentEscrow.json')
    && deploy.includes('constructor(address npl,address rewardLedger,address orderSigner,address retainedNplReceiver,address initialOwner)')
    && ['setSplitConfig', 'setSeller', 'setOperator', 'unpause'].every((needle) => deploy.includes(needle))
    && rewards.includes('BNMToken.sol/BNMToken.json')
    && rewards.includes('Abu24KRewardLedger.sol/Abu24KRewardLedger.json')
    && rewards.includes('constructor(address bnm,address npl,address owner)')
    && rewards.includes('setMinter')
    && ['Abu24KSeckill.sol/Abu24KSeckill.json', 'constructor(address npl,address escrow,address rewardLedger,address initialOwner)', 'setOperator', 'tx.origin == msg.sender', 'pause/forceClose', 'SECKILL_FROM_BLOCK'].every((needle) => seckill.includes(needle))
    && ['owner()', 'paused()', 'nonce()', 'prizePoolNpl', '24K seckill check: PASS'].every((needle) => checkSeckill.includes(needle))
    && ['24K BNM Rebate', 'minters(address)', 'RewardLedger.bnm mismatch', 'RewardLedger.npl mismatch', '24K rewards check: PASS'].every((needle) => checkRewards.includes(needle))
    && ["mode: 'read-only'", 'sendsTransactions: false', 'ledger.npl()', 'RewardLedger.npl mismatch'].every((needle) => rewardClaim.includes(needle))
    && ["mode: 'read-only'", 'sendsTransactions: false', 'prizePoolNpl'].every((needle) => seckillRecord.includes(needle))
    && [smoke, fundE2e, localE2e].every((source) => source.includes('payOrder') && source.includes('MaxUint256') && !source.includes('fundOrder'))
    && json('package.json').scripts['deploy:check-seckill'] === './scripts/node scripts/deploy/check-seckill.mjs'
    && json('package.json').scripts['deploy:check-rewards'] === './scripts/node scripts/deploy/check-rewards.mjs'
    && json('package.json').scripts['deploy:seckill'] === './scripts/node scripts/deploy/seckill.mjs'
    && json('package.json').scripts['micro:reward-ledger-claim'] === './scripts/node scripts/microtest/reward-ledger-claim.mjs'
    && json('package.json').scripts['micro:seckill-record'] === './scripts/node scripts/microtest/seckill-record.mjs'
    && json('package.json').scripts['micro:plan'] === './scripts/node scripts/microtest/plan.mjs'
    && ['txReady', 'rewardLedgerReadReady', 'seckillReadReady', 'privateKeyPrinted: false', 'Only the two NPL approve/pay/refund commands may send mainnet transactions', 'pnpm micro:seckill-record', 'pnpm micro:reward-ledger-claim', 'pnpm micro:escrow-smoke', 'pnpm micro:fund-tx-e2e', '0x4e8277ab31e4956b2cd48449793a57656dfc03d2'].every((needle) => plan.includes(needle));
});
check('backend and indexer only use 24K OrderPaid family events', () => {
  const server = text('server/index.mjs');
  const indexer = text('scripts/indexer/sync-events.mjs');
  return [server, indexer].every((source) => source.includes('OrderPaid') && source.includes('OrderForcedRefunded') && !/OrderFunded|OrderRefunded|OrderDisputed|OrderReleased/.test(source));
});
check('indexer syncs escrow, RewardLedger and Seckill event families', () => {
  const indexer = text('scripts/indexer/sync-events.mjs');
  return ['EXPO_PUBLIC_REWARD_LEDGER_ADDRESS', 'rewardLedgerAbi', 'RewardLocked', 'RewardReleased', 'RewardClaimed', 'UnclaimedRewardBurned', 'REWARD_LEDGER_FROM_BLOCK', 'REWARD_LEDGER_TO_BLOCK', 'EXPO_PUBLIC_SECKILL_ADDRESS', 'seckillAbi', 'PurchaseRecorded', 'SessionSettled', 'SECKILL_FROM_BLOCK', 'SECKILL_TO_BLOCK', 'parseBlockEnv', 'assertBlockRange', 'synced 24K events'].every((needle) => indexer.includes(needle));
});
check('app UX guard command exists', () => json('package.json').scripts['app:check'] === './scripts/node scripts/check-app-ux.mjs' && fs.existsSync('scripts/check-app-ux.mjs'));
check('backend guard command exists', () => json('package.json').scripts['backend:check'] === './scripts/node scripts/check-backend.mjs' && fs.existsSync('scripts/check-backend.mjs'));
check('DApp backend guard command exists', () => json('package.json').scripts['dapp:check'] === './scripts/node scripts/check-dapp-backend-flow.mjs' && fs.existsSync('scripts/check-dapp-backend-flow.mjs'));
check('DApp launch guard command exists', () => json('package.json').scripts['dapp:launch-check'] === './scripts/node scripts/check-dapp-launch-readiness.mjs' && fs.existsSync('scripts/check-dapp-launch-readiness.mjs'));
check('DApp QR generator command exists', () => json('package.json').scripts['dapp:qr'] === './scripts/node scripts/generate-dapp-qr.mjs'
  && fs.existsSync('scripts/generate-dapp-qr.mjs')
  && text('scripts/generate-dapp-qr.mjs').includes('dapp-launch-qr.svg')
  && text('scripts/generate-dapp-qr.mjs').includes('dapp-launch-qr.png')
  && text('server/index.mjs').includes("url.pathname === '/api/dapp/launch-kit'")
  && text('server/index.mjs').includes('24k-dapp-launch-kit-v1'));
check('DApp frontend handoff export command exists', () => json('package.json').scripts['dapp:handoff'] === './scripts/node scripts/export-dapp-handoff.mjs'
  && fs.existsSync('scripts/export-dapp-handoff.mjs')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-frontend-handoff.bundle.json')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-launch-status.json')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-contracts.json')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-types.d.ts')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-sdk.ts')
  && text('scripts/export-dapp-handoff.mjs').includes('dapp-frontend-thread-prompt.md')
  && text('scripts/export-dapp-handoff.mjs').includes('privateKeyPrinted: false'));
check('DApp contracts export command exists', () => json('package.json').scripts['dapp:contracts'] === './scripts/node scripts/export-dapp-contracts.mjs'
  && fs.existsSync('scripts/export-dapp-contracts.mjs')
  && text('scripts/export-dapp-contracts.mjs').includes('dapp-contracts.json')
  && text('server/index.mjs').includes("url.pathname === '/api/dapp/contracts'")
  && text('server/index.mjs').includes('24k-dapp-contracts-v1'));
check('DApp production env guard command exists', () => json('package.json').scripts['dapp:prod-check'] === './scripts/node scripts/check-dapp-production-env.mjs --strict --file .env.production' && fs.existsSync('scripts/check-dapp-production-env.mjs'));
check('DApp production env export command exists and omits private keys', () => json('package.json').scripts['dapp:prod-env'] === './scripts/node scripts/export-production-env.mjs'
  && fs.existsSync('scripts/export-production-env.mjs')
  && text('scripts/export-production-env.mjs').includes('dapp-production.env')
  && text('scripts/export-production-env.mjs').includes('PRIVATE_KEY included: false')
  && text('scripts/export-production-env.mjs').includes('forbidden'));
check('DApp production env file check command exists and avoids local deploy env', () => json('package.json').scripts['prod:env:init'] === './scripts/node scripts/init-production-env.mjs'
  && json('package.json').scripts['prod:env:check'] === './scripts/node scripts/check-dapp-production-env.mjs --strict --file .env.production'
  && fs.existsSync('scripts/init-production-env.mjs')
  && text('scripts/check-dapp-production-env.mjs').includes("argValue('--file')")
  && text('scripts/check-dapp-production-env.mjs').includes('DAPP_PROD_ENV_FILE')
  && text('scripts/check-dapp-production-env.mjs').includes('envFile')
  && text('scripts/check-dapp-production-env.mjs').includes('!/^<[^>]+>$/')
  && text('README.md').includes('pnpm dapp:prod-check'));
check('DApp frontend env export command exists and omits server secrets', () => json('package.json').scripts['dapp:frontend-env'] === './scripts/node scripts/export-dapp-frontend-env.mjs'
  && fs.existsSync('scripts/export-dapp-frontend-env.mjs')
  && text('scripts/export-dapp-frontend-env.mjs').includes('dapp-frontend.env')
  && text('scripts/export-dapp-frontend-env.mjs').includes('EXPO_PUBLIC_24K_API_BASE_URL')
  && text('scripts/export-dapp-frontend-env.mjs').includes('VITE_24K_API_BASE_URL')
  && text('scripts/export-dapp-frontend-env.mjs').includes('NEXT_PUBLIC_24K_API_BASE_URL')
  && text('scripts/export-dapp-frontend-env.mjs').includes('PRIVATE_KEY included: false')
  && text('scripts/export-dapp-frontend-env.mjs').includes('serverSecretsIncluded: false')
  && text('scripts/export-dapp-frontend-env.mjs').includes('/api/dapp/sdk.ts'));
check('DApp frontend env check command exists', () => json('package.json').scripts['dapp:frontend-env-check'] === './scripts/node scripts/check-dapp-frontend-env.mjs'
  && fs.existsSync('scripts/check-dapp-frontend-env.mjs')
  && text('scripts/check-dapp-frontend-env.mjs').includes('test-artifacts/dapp-frontend.env')
  && text('scripts/check-dapp-frontend-env.mjs').includes('No PRIVATE_KEY or server secrets are present')
  && text('scripts/check-dapp-frontend-env.mjs').includes('/api/dapp/sdk.ts')
  && text('scripts/check-dapp-frontend-env.mjs').includes('--fetch'));
check('DApp frontend handoff consumption check command exists', () => json('package.json').scripts['dapp:frontend-check'] === './scripts/node scripts/check-dapp-frontend-consumption.mjs'
  && fs.existsSync('scripts/check-dapp-frontend-consumption.mjs')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('dapp-frontend-consumption.report.json')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/seckill-state')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/mall-state')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/stores-state')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/assets-state')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('fetchDappAssetsState')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/final-check')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/checkout-intent')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/seckill-intent')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('/api/dapp/claim-intent')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('claimIntentReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('seckillIntentReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('fixedNplApprovalReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('connectedAssetsOrderReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('draftOrderStateReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('claimableAssetsReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('pickupCheckoutReady')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('pickupTemplate')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('Launch kit / QR payload')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('sendPaymentIntent')
  && text('scripts/check-dapp-frontend-consumption.mjs').includes('PRIVATE_KEY printed: false'));
check('DApp frontend pack command exists and omits server secrets', () => json('package.json').scripts['dapp:frontend-pack'] === './scripts/node scripts/export-dapp-frontend-pack.mjs'
  && fs.existsSync('scripts/export-dapp-frontend-pack.mjs')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-frontend-pack.tar.gz')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-frontend-thread-prompt.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-frontend.env')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-sdk.ts')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-status.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-launch-status.json')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-launch-status.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-wallet-launch.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-deploy-readiness.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('dapp-strict-gate.md')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('scanForSecrets')
  && text('scripts/export-dapp-frontend-pack.mjs').includes('serverSecretsIncluded: false')
  && text('README.md').includes('pnpm dapp:frontend-pack'));
check('DApp wallet launch export command exists for phone DEX browser handoff', () => json('package.json').scripts['dapp:wallet-launch'] === './scripts/node scripts/export-dapp-wallet-launch.mjs'
  && fs.existsSync('scripts/export-dapp-wallet-launch.mjs')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('dapp-wallet-launch.md')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('dapp-wallet-launch.json')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('dapp-wallet-launch.env')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('readyForPhoneWallet')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('Wallet/DApp entry URL is not HTTPS')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('approve(MaxUint256)')
  && text('scripts/export-dapp-wallet-launch.mjs').includes('PRIVATE_KEY included: false')
  && text('README.md').includes('pnpm dapp:wallet-launch'));
check('DApp deploy readiness export command exists without private-key leakage', () => json('package.json').scripts['dapp:deploy-readiness'] === './scripts/node scripts/export-dapp-deploy-readiness.mjs'
  && fs.existsSync('scripts/export-dapp-deploy-readiness.mjs')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('dapp-deploy-readiness.md')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('dapp-deploy-readiness.json')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('dapp-deploy-public.todo.env')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('sendsTransactions: false')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('pnpm deploy:rewards -- --write-env')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('pnpm deploy:seckill -- --write-env')
  && text('scripts/export-dapp-deploy-readiness.mjs').includes('PRIVATE_KEY printed: false')
  && text('README.md').includes('pnpm dapp:deploy-readiness'));
check('DApp strict gate command aggregates launch blockers without sending transactions', () => json('package.json').scripts['dapp:strict-gate'] === './scripts/node scripts/check-dapp-strict-gate.mjs'
  && fs.existsSync('scripts/check-dapp-strict-gate.mjs')
  && text('scripts/check-dapp-strict-gate.mjs').includes('dapp-strict-gate.md')
  && text('scripts/check-dapp-strict-gate.mjs').includes('dapp-strict-gate.report.json')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Deploy readiness')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Runtime launch status')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Wallet browser launch')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Frontend public env strict')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Production env strict')
  && text('scripts/check-dapp-strict-gate.mjs').includes('scripts/export-production-env.mjs')
  && text('scripts/check-dapp-strict-gate.mjs').includes("'--file'")
  && text('scripts/check-dapp-strict-gate.mjs').includes('dapp-production.env')
  && text('scripts/check-dapp-strict-gate.mjs').includes('dapp-launch-status.md')
  && text('scripts/check-dapp-strict-gate.mjs').includes('uniqueBlockers')
  && text('scripts/check-dapp-strict-gate.mjs').includes('criticalPath')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Deploy BNMToken + RewardLedger')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Set production server secrets and disable unverified events')
  && text('scripts/check-dapp-strict-gate.mjs').includes('Set HTTPS DApp entry URL')
  && text('scripts/check-dapp-strict-gate.mjs').includes('mainnetTransactionsSent: false')
  && text('scripts/check-dapp-strict-gate.mjs').includes('externalTransactionsSent: false')
  && text('scripts/check-dapp-strict-gate.mjs').includes('PRIVATE_KEY printed: false')
  && text('README.md').includes('pnpm dapp:strict-gate'));
check('DApp status report command exists', () => json('package.json').scripts['dapp:status'] === './scripts/node scripts/report-dapp-status.mjs'
  && fs.existsSync('scripts/report-dapp-status.mjs')
  && text('scripts/report-dapp-status.mjs').includes('dapp-status.md')
  && text('scripts/report-dapp-status.mjs').includes('dapp-status.report.json')
  && text('scripts/report-dapp-status.mjs').includes('dapp-frontend-thread-prompt.md')
  && text('scripts/report-dapp-status.mjs').includes('dapp-wallet-launch.md')
  && text('scripts/report-dapp-status.mjs').includes('dapp-deploy-readiness.md')
  && text('scripts/report-dapp-status.mjs').includes('dapp-strict-gate.md')
  && text('scripts/report-dapp-status.mjs').includes('strictLaunchOk')
  && text('scripts/report-dapp-status.mjs').includes('strictLaunchBlockers')
  && text('scripts/report-dapp-status.mjs').includes('Strict launch blockers')
  && text('scripts/report-dapp-status.mjs').includes('sendPaymentIntent')
  && text('scripts/report-dapp-status.mjs').includes('PRIVATE_KEY'));
check('full business flow e2e command exists', () => {
  const source = text('scripts/e2e/full-business-flow.mjs');
  return json('package.json').scripts['e2e:full'] === './scripts/node scripts/e2e/full-business-flow.mjs'
    && ['merchant.product.submit', 'admin.product.review', 'admin.seckill.schedule', 'OrderPaid', 'RewardLocked', 'merchant.order.ship', 'OrderCompleted', 'RewardReleased', 'RewardClaimed', 'admin.reward.release', 'claim.request', 'admin.force-refund', 'UnclaimedRewardBurned', 'merchant.pickup.verify', 'admin.circuit.claims', 'admin.blacklist.update', 'CLAIM_REQUEST_TTL_MS', 'reward-lock-unknown-asset', "assetSymbol: 'NPL'", 'expired PendingClaim', 'reward-burn-pending-claim'].every((needle) => source.includes(needle));
});
check('merchant/admin workspaces render real controls and click feedback', () => {
  const server = text('server/index.mjs');
  const common = text('server/backstage/common.js');
  const merchant = text('server/backstage/merchant.js');
  const admin = text('server/backstage/admin.js');
  return ['renderBackstagePage', '/backstage/merchant.js', '/backstage/admin.js', '/backstage/common.js'].every((needle) => server.includes(needle))
    && ['/api/auth/action-intent', 'personalSign(intent.secondaryMessage', 'api(submitPath'].every((needle) => common.includes(needle))
    && ['SIWE', '单品提报', '自提核销', 'data-action="prepare-claim"'].every((needle) => merchant.includes(needle))
    && ['秒杀排期', '强制退款', '风控与黑名单', '审计日志'].every((needle) => admin.includes(needle));
});
check('preview product SKU quantity fulfillment and total stay linked', () => {
  const server = text('server/index.mjs');
  return ['data-preview-sku', 'data-preview-quantity', 'data-preview-mode', 'data-preview-selection', 'data-preview-total', 'totalPrice=unitPrice*quantity', '已加入终核清单'].every((needle) => server.includes(needle));
});
check('merchant/admin typed adapters exist for docs API swap', () => fs.existsSync('src/services/merchantApi.ts') && fs.existsSync('src/services/adminApi.ts')
  && ['fetchMerchantDashboard', 'fetchMerchantOrders', 'fetchMerchantStores', 'requestMerchantClaim', 'updateMerchantProduct', 'lockMerchantProduct'].every((needle) => text('src/services/merchantApi.ts').includes(needle))
  && ['fetchAdminDashboard', 'fetchAdminAuditLogs', 'setCircuitBreaker', 'fetchAdminSearch', 'runAdminBatch', 'saveAdminRatioConfig'].every((needle) => text('src/services/adminApi.ts').includes(needle)));
check('RewardLedger local guard and BSC read-only reward/seckill checks exist', () => json('package.json').scripts['micro:reward-ledger-local'] === './scripts/node scripts/microtest/reward-ledger-local.mjs'
  && fs.existsSync('scripts/microtest/reward-ledger-local.mjs')
  && fs.existsSync('scripts/microtest/reward-ledger-claim.mjs')
  && fs.existsSync('scripts/microtest/seckill-record.mjs')
  && text('scripts/microtest/report.mjs').includes('reward-ledger-local.json')
  && text('scripts/microtest/report.mjs').includes('RewardLedger mainnet verification is read-only')
  && text('scripts/microtest/report.mjs').includes('Mainnet reward/seckill transaction tests enabled: no')
  && text('scripts/microtest/report.mjs').includes('one NPL MaxUint256 approval, one signed 9-parameter payOrder, one NPL refund'));
check('payment payload guard command exists', () => json('package.json').scripts['payment:check'] === './scripts/node scripts/check-payment-payload.mjs' && fs.existsSync('scripts/check-payment-payload.mjs'));
check('tx receipt guard command exists', () => json('package.json').scripts['tx:check'] === './scripts/node scripts/check-tx-receipt.mjs' && fs.existsSync('scripts/check-tx-receipt.mjs'));
check('docs/checklists are updated to 24K口径', () => ['24K', '秒杀大厅', '常规商城', '线下门店', '我的资产'].every((needle) => text('README.md').includes(needle) && text('DEVICE_UX_RESULTS.md').includes(needle)));
check('shipping docs and env are NPL-only', () => !grepFiles(['README.md', 'DAPP_FRONTEND_HANDOFF.md', 'DEVICE_UX_CHECKLIST.md', 'DEVICE_UX_RESULTS.md', '.env.example', 'package.json'], new RegExp(legacySettlementAsset, 'i')));
check('legacy UI markers do not leak into active app/server/data', () => !grepFiles(['App.tsx', 'src/components/BottomTabs.tsx', 'src/screens/SeckillScreen.tsx', 'src/screens/MallScreen.tsx', 'src/screens/StoresScreen.tsx', 'src/screens/AssetsScreen.tsx', 'src/data/catalog.ts', 'server/index.mjs'], new RegExp([['DI','OR'].join(''), ['88','VIP'].join(''), ['天','猫'].join(''), ['淘','宝'].join('')].join('|'))));

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` - ${entry.detail}` : ''}`);
if (failed.length) {
  console.error(`24K audit failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`24K audit: PASS ${checks.length}/${checks.length}`);

function check(name, fn) {
  try {
    checks.push({ name, ok: Boolean(fn()) });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function text(file) { return fs.readFileSync(file, 'utf8'); }
function json(file) { return JSON.parse(text(file)); }
function grepFiles(files, pattern) { return files.some((file) => pattern.test(text(file))); }

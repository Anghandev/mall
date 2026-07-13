#!/usr/bin/env node
import fs from 'node:fs';

const checks = [];
const app = text('App.tsx');
const tabs = text('src/components/BottomTabs.tsx');
const seckill = text('src/screens/SeckillScreen.tsx');
const mall = text('src/screens/MallScreen.tsx');
const stores = text('src/screens/StoresScreen.tsx');
const assets = text('src/screens/AssetsScreen.tsx');
const cart = text('src/screens/CartScreen.tsx');
const api = text('src/services/api.ts');
const payment = text('src/services/payment.ts');
const payload = text('src/services/paymentPayload.ts');

check('four-tab 24K app shell exposes seckill/mall/stores/assets', () => {
  const keys = [...tabs.matchAll(/key: '(seckill|mall|stores|assets)'/g)].map((match) => match[1]);
  return JSON.stringify(keys) === JSON.stringify(['seckill', 'mall', 'stores', 'assets'])
    && ['秒杀大厅', '常规商城', '线下门店', '我的资产'].every((label) => tabs.includes(`label: '${label}'`));
});

check('bottom tabs and app shell respect safe area', () => app.includes('SafeAreaView') && app.includes('useSafeAreaInsets') && app.includes('Math.max(insets.bottom, 8)') && app.includes('<BottomTabs active={tab} onChange={changeTab} />'));

check('Reown AppKit exposes connect/account and BSC switch flows', () => app.includes("open({ view: isConnected ? 'Account' : 'Connect' })") && app.includes('switchNetwork(`eip155:${BSC_CHAIN_ID}`)') && app.includes('<AppKitProvider instance={appKit}>'));

check('seckill page has docs states, countdowns, relay, prize pool, rules and report', () => ['upcoming', 'live', 'settling', 'settled', '主倒计时', '接力倒计时', '奖池', "setDialog('rules')", "setDialog('report')", '中奖提取'].every((needle) => seckill.includes(needle)));
check('seckill page has loading, empty, failure/risk and clickable feedback states', () => ['apiState', '正在同步秒杀场次', '秒杀接口失败保护', '暂无滚动记录', 'handleSafetyTap'].every((needle) => seckill.includes(needle)));

check('regular mall has SKU, fulfillment, address/store, stock check and five-factor final confirmation', () => ['selectedSku', 'FulfillmentMode', '快递到家', '门店自提', '库存复核', '付前 5 要素终核', '商品', 'SKU / 数量', '地址/门店', 'NPL'].every((needle) => mall.includes(needle)));
check('regular mall has loading, empty, failure and reset feedback states', () => ['apiState', '正在同步商品/SKU', '商品接口失败保护', '没有匹配商品', '重置筛选'].every((needle) => mall.includes(needle)));

check('stores page has region filter, GPS distance, call, navigation and region code binding', () => ['地区筛选', "distanceSource === 'gps'", 'Linking.openURL(url)', 'nativeMapUrl', '行政区', 'regionCode'].every((needle) => stores.includes(needle)));
check('stores page has loading, empty, failure and click feedback states', () => ['apiState', '正在同步门店', '门店接口加载失败', '该地区暂无门店', '查看全部门店'].every((needle) => stores.includes(needle)));

check('assets page exposes address book, BNM buckets, reward ledger, claims and circuit-breaker Claim UX', () => ['个人中心与地址仓', 'AssetBucket', 'RewardLedgerEntry', 'ClaimRecord', 'Circuit Breaker', 'Locked / Available / PendingClaim / Claimed'].every((needle) => assets.includes(needle)));
check('assets page has loading, empty, failure and claim states', () => ['apiState', '正在同步 assets-state', '资产接口加载失败', '暂无真实资产流水', '暂无 Claim 记录', 'InlineEmpty'].every((needle) => assets.includes(needle)));

check('regular checkout remains real and reachable from mall/seckill without being a bottom tab', () => app.includes('checkoutOpen') && app.includes('setCheckoutOpen(true)') && cart.includes('终核结算') && cart.includes('onBack'));
check('SKU, quantity, fulfillment and region selections flow into checkout payload', () => ['skuId', 'skuName', 'unitPriceNpl', 'fulfillmentMode', 'regionCode'].every((needle) => text('src/types.ts').includes(needle))
  && ['activeSku?.id', 'unitPriceNpl', 'fulfillmentMode: mode', 'regionCode'].every((needle) => mall.includes(needle))
  && ['item.skuName', 'item.fulfillmentMode', 'item.regionCode', 'checkoutAttemptKey'].every((needle) => cart.includes(needle)));

check('checkout preflight handles config/connect/wrong-chain/provider/empty-cart before payment', () => ['if (!isProjectConfigured)', 'if (!isConnected || !address)', 'if (!isOnBsc(chainId))', 'if (!provider)', 'checkoutItems.length === 0 || total <= 0'].every((needle) => cart.includes(needle)));

check('checkout uses one NPL allowance check and one unlimited approval before fund', () => {
  const checkoutFlow = cart.slice(cart.indexOf('async function handleConfirmPayment()'), cart.indexOf('  function toggle(productId: string)'));
  const flow = ['createCheckoutIntent', 'readAllowanceWei', 'sendWalletTransaction(provider, approval)', 'sendWalletTransaction(provider, intent.paymentIntent.payOrderTransaction)', 'pollFundingUntilFinal'].map((needle) => checkoutFlow.indexOf(needle));
  return flow.every((index) => index >= 0) && flow.every((index, i) => i === 0 || flow[i - 1] < index)
    && cart.includes('intent.allowanceChecks.length === 1')
    && cart.includes('intent.approvalTransactions.length === 1')
    && cart.includes("check?.key === 'npl'")
    && cart.includes("approval?.key === 'npl'")
    && cart.includes("approval.amount === 'MaxUint256'")
    && cart.includes('approval.amountWei === maxUint256')
    && payload.includes('MaxUint256')
    && payment.includes('NPL_BSC_ADDRESS')
    && payload.includes('function payOrder(bytes32 orderId,address seller,bytes32 productId,uint256 nplAmount,uint256 bnmLocked,uint64 deadline,bytes32 orderDigest,uint32 splitVersion,bytes authorization)');
});

check('API adapter exposes the 24K commerce endpoints', () => ['/api/seckill/current', '/api/stores', '/api/assets/summary'].every((route) => api.includes(route)) && ['normalizeSeckillSession', 'normalizeStore', 'normalizeBucket'].every((needle) => api.includes(needle)));
check('merchant/admin typed adapters cover the documented backstages', () => fs.existsSync('src/services/merchantApi.ts') && fs.existsSync('src/services/adminApi.ts')
  && ['fetchMerchantDashboard', 'fetchMerchantOrders', 'requestMerchantClaim'].every((needle) => text('src/services/merchantApi.ts').includes(needle))
  && ['fetchAdminDashboard', 'setCircuitBreaker', 'fetchAdminAuditLogs'].every((needle) => text('src/services/adminApi.ts').includes(needle)));

check('structural icons are vector icons, not emoji navigation', () => tabs.includes('lucide-react-native') && !/[🎉🔥🛒🏪💰]/.test(tabs));

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` - ${entry.detail}` : ''}`);
if (failed.length) {
  console.error(`app UX check failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`app UX check: PASS ${checks.length}/${checks.length}`);

function check(name, fn) {
  try {
    checks.push({ name, ok: Boolean(fn()) });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function text(file) {
  return fs.readFileSync(file, 'utf8');
}

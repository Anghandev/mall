#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Interface, Wallet } from 'ethers';
import { startOrderSigner } from '../test-support/order-signer.mjs';

const port = Number(process.env.FULL_E2E_API_PORT || 8801);
const apiUrl = `http://127.0.0.1:${port}`;
const tempDir = mkdtempSync(join(tmpdir(), '24k-full-business-e2e-'));
const dbPath = resolve(tempDir, 'full-business.db');
const escrowAddress = '0x2222222222222222222222222222222222222222';
const rewardLedgerAddress = '0x3333333333333333333333333333333333333333';
const bnmAddress = '0x4444444444444444444444444444444444444444';
const fixedNpl = '0x4e8277ab31e4956b2cd48449793a57656dfc03d2';
const merchantWallet = Wallet.createRandom();
const adminWallet = Wallet.createRandom();
const buyerWallet = Wallet.createRandom();
const indexerSecret = 'full-flow-indexer-secret';
const adminSecret = 'full-flow-admin-secret';
const actionTokens = new Map();
let defaultBuyerToken = '';

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
    EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: rewardLedgerAddress,
    EXPO_PUBLIC_BNM_BSC_ADDRESS: bnmAddress,
    EXPO_PUBLIC_NPL_BSC_ADDRESS: fixedNpl,
    MERCHANT_RECEIVER_ADDRESS: merchantWallet.address,
    ...localOrderSigner.env,
    ADMIN_WALLET_ADDRESS: adminWallet.address,
    JWT_SECRET: 'full-flow-jwt-secret',
    INDEXER_SECRET: indexerSecret,
    ADMIN_SECRET: adminSecret,
    CHAIN_EVENT_RPC_URL: '',
    BSC_RPC_URL: '',
    EXPO_PUBLIC_BSC_RPC_URL: '',
    ALLOW_UNVERIFIED_CHAIN_EVENTS: 'true',
    CLAIM_REQUEST_TTL_MS: '20'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
server.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  await waitForHealth();

  const config = await get('/api/config');
  assert(config.nplAddress.toLowerCase() === fixedNpl, 'NPL address must stay fixed to the supplied contract');
  assert(config.escrowAddress.toLowerCase() === escrowAddress.toLowerCase(), 'escrow address should use test config');
  assert(config.rewardLedgerAddress.toLowerCase() === rewardLedgerAddress.toLowerCase(), 'reward ledger should use test config');

  const merchantAuth = await siweLogin(merchantWallet, 'merchant');
  const adminAuth = await siweLogin(adminWallet, 'admin');
  const buyerAuth = await siweLogin(buyerWallet, 'buyer');
  defaultBuyerToken = buyerAuth.token;
  const merchantHeaders = authHeaders(merchantAuth.token);
  const adminHeaders = authHeaders(adminAuth.token);
  const buyerHeaders = authHeaders(buyerAuth.token);

  const addressPayload = {
    id: 'addr-default',
    walletAddress: buyerWallet.address,
    name: 'Full Flow Buyer',
    phone: '13800000001',
    province: '辽宁省',
    city: '大连市',
    district: '高新区',
    detail: '软件园路 24K 号',
    regionCode: '210211',
    isDefault: true
  };
  const savedAddress = await post('/api/address-book', await withSecondary(buyerWallet, 'buyer.address.upsert', addressPayload), buyerHeaders);
  assert(savedAddress.id === 'addr-default' && savedAddress.regionCode === '210211', 'buyer should save the delivery address through action-intent');
  const savedStore = await post('/api/merchant/stores', await withSecondary(merchantWallet, 'merchant.store.upsert', {
    storeId: 'store-dl-gaoxin',
    name: '24K 大连高新自提店',
    regionCode: '210211',
    address: '辽宁省大连市高新区软件园路 24K 号',
    hours: '09:00-21:00',
    phone: '13800000000',
    lat: 38.86,
    lng: 121.52,
    photos: ['https://cdn.example.test/stores/full-flow.png']
  }), merchantHeaders);
  assert(savedStore.store?.id === 'store-dl-gaoxin' || savedStore.id === 'store-dl-gaoxin', 'merchant should persist the pickup store through action-intent');

  const submittedProduct = await post('/api/merchant/products', await withSecondary(merchantWallet, 'merchant.product.submit', {
    title: '24K 全链路测试单品',
    imageUrls: ['https://cdn.example.test/products/full-flow.png'],
    descriptionHtml: '<p>24K 全链路测试商品</p>',
    skus: [{ id: 'black-gold', name: '黑金测试 SKU', settlementPriceNpl: '120.00', stock: 10 }],
    fulfillmentModes: ['delivery', 'pickup']
  }), merchantHeaders);
  assert(submittedProduct.status === 'PendingReview' && submittedProduct.locked, 'merchant product submit should enter locked pending review');

  const reviewedProduct = await post('/api/admin/products/review', await withSecondary(adminWallet, 'admin.product.review', {
    productId: submittedProduct.id,
    decision: 'approved'
  }), adminHeaders);
  assert(reviewedProduct.status === 'Approved', 'admin should approve merchant product');

  const seckillSchedule = await post('/api/admin/seckill/schedule', await withSecondary(adminWallet, 'admin.seckill.schedule', {
    sessionId: 'sk-full-flow-001',
    productId: 'p-24k-runner',
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString()
  }), adminHeaders);
  assert(seckillSchedule.sessionId === 'sk-full-flow-001', 'admin should schedule seckill session');

  const order = await post('/api/orders/finalize', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `full-flow:${buyerWallet.address}:runner`,
    fulfillmentMode: 'delivery',
    regionCode: '210211',
    items: [deliveryItem('p-24k-runner')]
  });
  assert(order.finalCheck?.passed && order.orderId && order.amountNpl === '120.000000000000000000', 'finalize should run five-factor check and create an NPL-only order');

  await post(`/api/merchant/orders/${order.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', {
    trackingNo: 'UNPAID-SHOULD-BLOCK'
  }), merchantHeaders, 400);

  const paid = await post('/api/chain-events', orderPaidEvent(order, 'paid-runner', 101, 'p-24k-runner'), { 'x-indexer-secret': indexerSecret });
  assert(paid.order.status === 'PaidLocked', 'OrderPaid should lock paid order');
  await post('/api/chain-events', rewardLockedEvent(order, 1, 'reward-lock-runner', 201), { 'x-indexer-secret': indexerSecret });
  await post('/api/chain-events', { ...rewardLockedEvent(order, 99, 'reward-lock-unknown-asset', 299), asset: '0x5555555555555555555555555555555555555555' }, { 'x-indexer-secret': indexerSecret }, 400);

  let assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  const lockedReward = assets.ledger.find((entry) => entry.id === 'reward-ledger-1');
  assert(lockedReward?.state === 'Locked' && lockedReward.assetSymbol === 'BNM', 'OrderPaid should create Locked BNM ledger entry');

  const shipped = await post(`/api/merchant/orders/${order.orderId}/ship`, await withSecondary(merchantWallet, 'merchant.order.ship', {
    carrier: 'SF Express',
    trackingNo: 'SF-FULL-0001'
  }), merchantHeaders, 200);
  assert(shipped.status === 'Shipped' && shipped.trackingNo === 'SF-FULL-0001', 'merchant should ship only after payment lock');
  const printBatch = await post('/api/admin/batch', await withSecondary(adminWallet, 'admin.batch.run', {
    operation: 'print.shipments',
    resource: 'orders',
    targetIds: [order.orderId]
  }), adminHeaders);
  const printHtml = Buffer.from(printBatch.batch?.printDocument?.contentBase64 || '', 'base64').toString('utf8');
  assert(printBatch.batch?.printDocument?.mimeType?.startsWith('text/html') && printHtml.includes(order.orderId) && printHtml.includes('window.print'), 'batch printing should return a real printable document for selected shipment orders');

  const afterSaleRequest = await post('/api/dapp/after-sale/request', await withSecondary(buyerWallet, 'buyer.after-sale.request', {
    orderId: order.orderId,
    type: 'exchange',
    reason: '商品故障，申请换货'
  }), buyerHeaders);
  assert(afterSaleRequest.case?.status === 'AwaitingDisputeTransaction' && afterSaleRequest.assetState === 'Locked' && afterSaleRequest.transactionIntent?.data, 'exchange request should wait for disputeOrder finality, keep rewards locked and return calldata');
  const afterSaleCases = await get('/api/admin/after-sales', adminHeaders);
  assert(afterSaleCases.cases?.some((entry) => entry.id === afterSaleRequest.case.id && entry.orderId === order.orderId), 'admin should receive the after-sale arbitration case');
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  const pendingDisputeOrder = assets.orders.find((entry) => entry.orderId === order.orderId);
  assert(pendingDisputeOrder?.afterSale?.case?.status === 'AwaitingDisputeTransaction' && pendingDisputeOrder.afterSale.transactionIntent?.data === afterSaleRequest.transactionIntent.data, 'assets-state should preserve disputeOrder calldata for wallet retry');
  await post('/api/admin/after-sales/resolve', await withSecondary(adminWallet, 'admin.after-sale.resolve', {
    caseId: afterSaleRequest.case.id,
    resolution: 'exchange',
    note: '链上仲裁前必须拒绝平台裁决'
  }), adminHeaders, 409);
  await post('/api/chain-events', orderArbitrationEvent(order, 'arbitration-runner', 102), { 'x-indexer-secret': indexerSecret });
  const exchangeApproved = await post('/api/admin/after-sales/resolve', await withSecondary(adminWallet, 'admin.after-sale.resolve', {
    caseId: afterSaleRequest.case.id,
    resolution: 'exchange',
    note: '批准换货并保持链上收益锁定'
  }), adminHeaders);
  assert(exchangeApproved.case?.status === 'ExchangeApproved', 'admin should resolve the case to an exchange workflow');
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  const arbitratingOrder = assets.orders.find((entry) => entry.orderId === order.orderId);
  assert(arbitratingOrder?.primaryAction?.key === 'waitAfterSale' && arbitratingOrder.afterSale?.assetState === 'Locked', 'asset center should block completion and show locked after-sale state');

  const completed = await post('/api/chain-events', orderCompletedEvent(order, 'complete-runner', 103), { 'x-indexer-secret': indexerSecret });
  assert(completed.order.status === 'Released', 'OrderCompleted should release order');
  await post('/api/chain-events', rewardReleasedEvent(order, 1, 'reward-release-runner', 202), { 'x-indexer-secret': indexerSecret });

  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  assert(assets.ledger.some((entry) => entry.state === 'Available' && entry.assetSymbol === 'BNM'), 'completion should move BNM ledger to Available');

  const releasedReward = await post('/api/admin/rewards/release', await withSecondary(adminWallet, 'admin.reward.release', {
    walletAddress: buyerWallet.address,
    orderId: order.orderId,
    amount: order.bnmLocked,
    source: '后台签收复核释放 BNM'
  }), adminHeaders);
  assert(releasedReward.status === 'AwaitingOwnerTransaction' && releasedReward.transactionIntent?.to?.toLowerCase() === rewardLedgerAddress.toLowerCase(), 'admin reward release should return the owner transaction intent when ledger is configured');

  const draftBeforeLedgerPause = await post('/api/orders/finalize', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `full-flow:${buyerWallet.address}:ledger-pause-draft`,
    fulfillmentMode: 'delivery',
    regionCode: '210211',
    items: [deliveryItem('p-24k-phone')]
  });
  assert(draftBeforeLedgerPause.status === 'Draft', 'test setup should create a payable draft before pausing RewardLedger');

  const pauseClaims = await post('/api/admin/pause-claims', await withSecondary(adminWallet, 'admin.circuit.claims', { enabled: true, reason: 'full-flow pause claim gate' }), adminHeaders);
  assert(pauseClaims.state === 'PendingPause' && pauseClaims.circuit?.enabled === true, 'claim pause should fail closed while the ledger transaction is pending');
  await post('/api/chain-events', {
    eventName: 'LedgerPaused',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    account: adminWallet.address,
    txHash: txHash('ledger-paused'),
    blockNumber: 204,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret });
  await post('/api/stock/preflight', { buyerAddress: buyerWallet.address, items: [deliveryItem('p-24k-phone')] }, buyerHeaders, 423);
  await post('/api/orders', { buyerAddress: buyerWallet.address, idempotencyKey: 'ledger-paused-order', items: [deliveryItem('p-24k-phone')] }, buyerHeaders, 423);
  const pausedPaymentIntent = await fetch(`${apiUrl}/api/orders/${draftBeforeLedgerPause.orderId}/payment-intent?buyerAddress=${buyerWallet.address}`, { headers: buyerHeaders });
  assert(pausedPaymentIntent.status === 423 && (await pausedPaymentIntent.json()).error === 'REWARD_LEDGER_PAUSED', 'RewardLedger pause must block payment intents without altering the independent Escrow circuit');
  await post('/api/claims', {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm'
  }, {}, 423);
  const resumeClaims = await post('/api/admin/pause-claims', await withSecondary(adminWallet, 'admin.circuit.claims', { enabled: false, reason: 'full-flow resume claim gate' }), adminHeaders);
  assert(resumeClaims.state === 'PendingResume' && resumeClaims.circuit?.enabled === true, 'claim resume should stay closed before LedgerUnpaused');
  await post('/api/claims', {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm'
  }, {}, 423);
  const claimsOpened = await post('/api/chain-events', {
    eventName: 'LedgerUnpaused',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    account: adminWallet.address,
    txHash: txHash('ledger-unpaused'),
    blockNumber: 205,
    logIndex: 0
  }, { 'x-indexer-secret': indexerSecret });
  assert(claimsOpened.circuit?.state === 'Open' && claimsOpened.circuit.enabled === false, 'LedgerUnpaused should reopen claims');
  const resumedPaymentIntent = await get(`/api/orders/${draftBeforeLedgerPause.orderId}/payment-intent?buyerAddress=${buyerWallet.address}`, buyerHeaders);
  assert(resumedPaymentIntent.payOrderTransaction?.data, 'LedgerUnpaused should restore new-payment intent generation');
  const preparedClaimMessage = await post('/api/dapp/claim-intent', {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm',
    rewardId: lockedReward.id
  }, {}, 200);
  assert(preparedClaimMessage.amount === order.bnmLocked && preparedClaimMessage.secondaryMessage.includes(`RewardId: ${lockedReward.id}`), 'claim intent should bind rewardId and amount for wallet signature');
  assert(preparedClaimMessage.claimTransaction?.to?.toLowerCase() === rewardLedgerAddress.toLowerCase(), 'claim intent should return RewardLedger claim tx when configured');
  const rewardLedgerIface = new Interface(['function claim(uint256 entryId)']);
  const [claimEntryId] = rewardLedgerIface.decodeFunctionData('claim', preparedClaimMessage.claimTransaction.data);
  assert(claimEntryId === 1n, 'claim intent calldata should target RewardLedger entryId 1');
  const preparedClaimSignature = await buyerWallet.signMessage(preparedClaimMessage.secondaryMessage);
  await post('/api/claims', { ...preparedClaimMessage.submit.body, assetSymbol: 'NPL', secondarySignature: preparedClaimSignature }, {}, 400);
  const claim = await post('/api/claims', { ...preparedClaimMessage.submit.body, secondarySignature: preparedClaimSignature });
  assert(claim.status === 'pending' && claim.assetSymbol === 'BNM' && Number(claim.amount) > 0, 'buyer claim should require wallet signature and wait for chain claim event');
  const claimedEvent = rewardClaimedEvent(order, 1, 'reward-claim-runner', 203);
  await post('/api/chain-events', claimedEvent, { 'x-indexer-secret': indexerSecret });
  const claimStatus = await get(`/api/dapp/claim-tx-status?walletAddress=${buyerWallet.address}&rewardId=${lockedReward.id}&txHash=${claimedEvent.txHash}`);
  assert(claimStatus.status === 'confirmed' && claimStatus.reward?.state === 'Claimed', 'claim tx status should report confirmed after RewardClaimed is indexed');
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  assert(assets.ledger.some((entry) => entry.id === 'reward-ledger-1' && entry.state === 'Claimed'), 'RewardClaimed should finalize BNM claim');
  const completedClaim = assets.claims.find((entry) => entry.id === claim.id);
  assert(completedClaim?.gasUsed === '50000' && completedClaim?.effectiveGasPriceWei === '3000000000' && completedClaim?.gasBnb === '0.00015', `claim history should persist receipt gas usage and BNB cost: ${JSON.stringify(completedClaim)}`);

  const expiryOrder = await post('/api/orders/finalize', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `full-flow:${buyerWallet.address}:claim-expiry`,
    fulfillmentMode: 'delivery',
    regionCode: '210211',
    items: [deliveryItem('p-24k-bag')]
  });
  await post('/api/chain-events', orderPaidEvent(expiryOrder, 'paid-claim-expiry', 106, 'p-24k-bag'), { 'x-indexer-secret': indexerSecret });
  await post('/api/chain-events', rewardLockedEvent(expiryOrder, 3, 'reward-lock-claim-expiry', 206), { 'x-indexer-secret': indexerSecret });
  await post('/api/chain-events', rewardReleasedEvent(expiryOrder, 3, 'reward-release-claim-expiry', 207), { 'x-indexer-secret': indexerSecret });
  const expiringClaim = await post('/api/claims', withClaimSignature(buyerWallet, {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm',
    rewardId: 'reward-ledger-3',
    amount: expiryOrder.bnmLocked
  }));
  assert(expiringClaim.status === 'pending', 'claim request should enter PendingClaim before on-chain claim');
  await sleep(30);
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  assert(assets.ledger.some((entry) => entry.id === 'reward-ledger-3' && entry.state === 'Available'), 'expired PendingClaim should restore reward to Available');
  assert(assets.claims.some((entry) => entry.id === expiringClaim.id && entry.status === 'failed'), 'expired PendingClaim should mark claim failed');
  const burnPendingClaim = await post('/api/claims', withClaimSignature(buyerWallet, {
    walletAddress: buyerWallet.address,
    bucketId: 'bnm',
    rewardId: 'reward-ledger-3',
    amount: expiryOrder.bnmLocked
  }));
  await post('/api/chain-events', rewardBurnedEvent(expiryOrder, 3, 'reward-burn-pending-claim', 208), { 'x-indexer-secret': indexerSecret });
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  assert(assets.ledger.some((entry) => entry.id === 'reward-ledger-3' && entry.state === 'Burned'), 'Reward burn event should burn PendingClaim reward');
  assert(assets.claims.some((entry) => entry.id === burnPendingClaim.id && entry.status === 'failed'), 'Reward burn event should fail pending claim');

  const refundOrder = await post('/api/orders/finalize', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `full-flow:${buyerWallet.address}:refund`,
    fulfillmentMode: 'pickup',
    storeRegionCode: '210211',
    items: [pickupItem('p-24k-tea')]
  });
  await post('/api/chain-events', orderPaidEvent(refundOrder, 'paid-refund', 103, 'p-24k-tea'), { 'x-indexer-secret': indexerSecret });
  await post('/api/chain-events', rewardLockedEvent(refundOrder, 2, 'reward-lock-refund', 204), { 'x-indexer-secret': indexerSecret });
  const forcedRefund = await post('/api/admin/force-refund', await withSecondary(adminWallet, 'admin.force-refund', {
    orderId: refundOrder.orderId,
    reason: '商家 7 天未发货，平台强制退款并销毁未领取 BNM'
  }), adminHeaders);
  assert(forcedRefund.status === 'RefundRequested', 'admin force refund should only request a chain refund');
  const refundFinal = await post('/api/chain-events', forcedRefundEvent(refundOrder, 'force-refund', 104), { 'x-indexer-secret': indexerSecret });
  assert(refundFinal.order.status === 'ForcedRefunded', 'OrderForcedRefunded event should finalize refund and burn unclaimed rewards');
  await post('/api/chain-events', rewardBurnedEvent(refundOrder, 2, 'reward-burn-refund', 205), { 'x-indexer-secret': indexerSecret });
  assets = await get(`/api/assets/summary?address=${buyerWallet.address}`, buyerHeaders);
  assert(assets.ledger.some((entry) => entry.id === 'reward-ledger-2' && entry.state === 'Burned'), 'Reward burn event should burn unclaimed BNM');

  const pickupOrder = await post('/api/orders/finalize', {
    buyerAddress: buyerWallet.address,
    idempotencyKey: `full-flow:${buyerWallet.address}:pickup`,
    fulfillmentMode: 'pickup',
    storeRegionCode: '210211',
    items: [pickupItem('p-24k-tea')]
  });
  await post('/api/chain-events', orderPaidEvent(pickupOrder, 'paid-pickup', 105, 'p-24k-tea'), { 'x-indexer-secret': indexerSecret });
  const pickupFulfillment = await get(`/api/orders/${pickupOrder.orderId}/fulfillment?buyerAddress=${buyerWallet.address}`, buyerHeaders);
  const pickupCode = pickupFulfillment.current?.payload?.pickupCode;
  assert(/^\d{6}$/.test(String(pickupCode || '')), 'paid pickup order should expose the buyer pickup code');
  const pickup = await post('/api/merchant/pickup/verify', await withSecondary(merchantWallet, 'merchant.pickup.verify', {
    orderId: pickupOrder.orderId,
    storeId: 'store-dl-gaoxin',
    code: pickupCode
  }), merchantHeaders);
  assert(pickup.action === 'merchant.pickup.verify', 'merchant should record pickup verification');

  const cancellationOrders = [draftBeforeLedgerPause];
  for (let index = 0; index < 2; index += 1) {
    cancellationOrders.push(await post('/api/orders', {
      buyerAddress: buyerWallet.address,
      idempotencyKey: `full-flow:${buyerWallet.address}:cancel-${index}`,
      items: [deliveryItem('p-24k-phone')]
    }, buyerHeaders));
  }
  for (const [index, cancellable] of cancellationOrders.entries()) {
    await post('/api/dapp/order-cancel', await withSecondary(buyerWallet, 'buyer.order.cancel', { orderId: cancellable.orderId, reason: `取消测试 ${index + 1}` }), buyerHeaders, 200);
  }
  const lockedPreflight = await post('/api/stock/preflight', { buyerAddress: buyerWallet.address, items: [deliveryItem('p-24k-phone')] }, buyerHeaders, 423);
  assert(lockedPreflight.error === 'TRADE_TEMPORARILY_LOCKED', 'three cancellations in five minutes should lock new trades for the configured period');
  const riskEvents = await get('/api/admin/risk-events', adminHeaders);
  assert(riskEvents.events?.some((entry) => entry.kind === 'trade-lock' && entry.walletAddress === buyerWallet.address.toLowerCase() && Number(entry.payload?.lockedUntil) > Date.now()), 'trade lock should be visible in the admin risk event stream with an expiry');

  await post('/api/admin/blacklist', await withSecondary(adminWallet, 'admin.blacklist.update', {
    address: '0x9999999999999999999999999999999999999999',
    reason: 'full-flow risk fixture'
  }), adminHeaders);
  await post('/api/admin/cms', await withSecondary(adminWallet, 'admin.cms.publish', { key: 'seckill-rules', text: '24K 秒杀规则 full flow' }), adminHeaders);

  const audit = await get('/api/admin/audit-logs', adminHeaders);
  for (const action of [
    'merchant.product.submit',
    'admin.product.review',
    'admin.seckill.schedule',
    'order.create',
    'chain.OrderPaid',
    'merchant.order.ship',
    'buyer.after-sale.request',
    'admin.after-sale.resolve',
    'chain.OrderCompleted',
    'chain.RewardLocked',
    'chain.RewardReleased',
    'chain.RewardClaimed',
    'chain.UnclaimedRewardBurned',
    'admin.reward.release',
    'claim.request',
    'admin.force-refund',
    'merchant.pickup.verify',
    'admin.blacklist.update',
    'admin.circuit.claims',
    'admin.cms.publish'
  ]) {
    assert(audit.some((entry) => entry.action === action), `audit logs should contain ${action}`);
  }

  console.log('full business flow e2e: PASS');
} finally {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 1_000).unref();
  if (stderr && !stderr.includes('ExperimentalWarning')) process.stderr.write(stderr);
  await localOrderSigner.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function orderPaidEvent(order, label, blockNumber, productId) {
  return {
    eventName: 'OrderPaid',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    buyer: order.buyerAddress,
    seller: order.sellerAddress,
    productId: bytes32(productId),
    nplAmountWei: parseDecimal18(order.amountNpl).toString(),
    bnmLockedWei: parseDecimal18(order.bnmLocked).toString(),
    amountNpl: order.amountNpl,
    bnmLocked: order.bnmLocked,
    deadline: Math.floor(Date.now() / 1000) + 1800,
    orderDigest: order.orderDigest,
    splitVersion: 1
  };
}

function orderCompletedEvent(order, label, blockNumber) {
  return {
    eventName: 'OrderCompleted',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    seller: order.sellerAddress,
    amountWei: parseDecimal18(order.amountNpl).toString(),
    amountNpl: order.amountNpl,
    splitVersion: 1
  };
}

function orderArbitrationEvent(order, label, blockNumber) {
  return {
    eventName: 'OrderArbitration',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    caller: order.buyerAddress
  };
}

function forcedRefundEvent(order, label, blockNumber) {
  const refundedNpl = parseDecimal18(order.amountNpl);
  return {
    eventName: 'OrderForcedRefunded',
    chainId: 56,
    contractAddress: escrowAddress,
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    buyer: order.buyerAddress,
    refundedNplWei: refundedNpl.toString(),
    amountNpl: order.amountNpl,
    burnedRewards: 1
  };
}

function rewardLockedEvent(order, entryId, label, blockNumber) {
  return {
    eventName: 'RewardLocked',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    user: order.buyerAddress,
    asset: bnmAddress,
    amountWei: parseDecimal18(order.bnmLocked).toString(),
    amount: order.bnmLocked,
    bucket: 0
  };
}

function rewardReleasedEvent(order, entryId, label, blockNumber) {
  return {
    eventName: 'RewardReleased',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber
  };
}

function rewardClaimedEvent(order, entryId, label, blockNumber) {
  return {
    eventName: 'RewardClaimed',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    user: order.buyerAddress,
    asset: bnmAddress,
    amountWei: parseDecimal18(order.bnmLocked).toString(),
    amount: order.bnmLocked,
    gasUsed: '50000',
    effectiveGasPriceWei: '3000000000',
    gasBnb: '0.00015'
  };
}

function rewardBurnedEvent(order, entryId, label, blockNumber) {
  return {
    eventName: 'UnclaimedRewardBurned',
    chainId: 56,
    contractAddress: rewardLedgerAddress,
    entryId: String(entryId),
    orderId: order.orderId,
    txHash: txHash(label),
    blockNumber,
    logIndex: blockNumber,
    previousState: 0
  };
}

async function siweLogin(wallet, role) {
  const nonce = await post('/api/auth/siwe/nonce', { address: wallet.address, role });
  const signature = await wallet.signMessage(nonce.message);
  const session = await post('/api/auth/siwe/verify', { address: wallet.address, role, message: nonce.message, signature });
  actionTokens.set(wallet.address.toLowerCase(), session.token);
  return session;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function withSecondary(wallet, action, body) {
  const token = actionTokens.get(wallet.address.toLowerCase());
  assert(token, `missing SIWE JWT for ${wallet.address}`);
  const intent = await post('/api/auth/action-intent', { action, payload: body }, authHeaders(token), 201);
  assert(intent.action === action && intent.walletAddress?.toLowerCase() === wallet.address.toLowerCase(), 'action-intent should bind action and SIWE wallet');
  assert(intent.payloadHash === payloadHashForSignature(body) && intent.signatureKind === 'personal_sign', 'action-intent should bind payload hash and signature kind');
  assert(intent.submitBody?.secondaryMessage === intent.secondaryMessage && intent.submitBody?.secondarySignature === '<wallet-signature>', 'action-intent should return the bound submit body template');
  const secondarySignature = await wallet.signMessage(intent.secondaryMessage);
  return { ...body, secondaryMessage: intent.secondaryMessage, secondarySignature };
}

function payloadHashForSignature(body) {
  return `0x${createHash('sha256').update(stableStringify(body || {})).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
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

async function withClaimSignature(wallet, body) {
  const intent = await post('/api/dapp/claim-intent', {
    walletAddress: body.walletAddress,
    bucketId: body.bucketId,
    rewardId: body.rewardId
  }, {}, 200);
  assert(intent.amount === body.amount && intent.signatureKind === 'personal_sign', 'claim intent should bind reward amount and signature kind');
  const secondarySignature = await wallet.signMessage(intent.secondaryMessage);
  return { ...intent.submit.body, secondarySignature };
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become healthy. stderr: ${stderr}`);
}

async function get(path, headers = {}) {
  const response = await fetch(`${apiUrl}${path}`, { headers: buyerAuthorization(headers) });
  const body = await response.json().catch(() => ({}));
  assert(response.ok, `GET ${path} failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function post(path, body, headers = {}, expected = 201) {
  const resolvedBody = await body;
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...buyerAuthorization(headers) },
    body: JSON.stringify(resolvedBody)
  });
  const payload = await response.json().catch(() => ({}));
  assert(response.status === expected, `POST ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function buyerAuthorization(headers) {
  if (!defaultBuyerToken || headers.authorization) return headers;
  return { authorization: `Bearer ${defaultBuyerToken}`, ...headers };
}

function txHash(label) {
  return `0x${createHash('sha256').update(`24k-full-flow:${label}`).digest('hex')}`;
}

function bytes32(value) {
  return `0x${createHash('sha256').update(String(value)).digest('hex')}`;
}

function parseDecimal18(value) {
  const text = String(value || '0');
  if (!/^[0-9]+(\.[0-9]{0,18})?$/.test(text)) throw new Error(`invalid decimal ${value}`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole || '0') * 10n ** 18n + BigInt(`${fraction}000000000000000000`.slice(0, 18));
}

function short(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

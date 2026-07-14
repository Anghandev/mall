import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Wallet } from 'ethers';
import { orderAllowedActions, settlementRequestAllowedAction } from './allowed-actions.ts';
import {
  createSiweChallenge,
  issueSessionToken,
  sensitiveActionDomain,
  sensitiveActionTypes,
  verifySensitiveActionApproval,
  verifySessionToken,
  verifySiwe,
  type NonceStore,
  type StoredNonce,
} from './auth.ts';
import { createApiServer } from './app.ts';
import {
  buildDualPaymentQuote,
  buildPaymentIntent,
  type CanonicalPaymentIntent,
  type FrozenPaymentPolicy,
  type PaymentQuoteRequest,
} from './checkout.ts';
import { allowedActionNames, CORE_ARTIFACT_VERSION } from './enums.ts';
import { loadConfig, publicReadiness, requireProvider } from './config.ts';
import { applyReceipt, replaceTransaction, requireFinal, submittedFinality } from './finality.ts';
import {
  paymentAuthorizationDigest,
  paymentIntentHash,
  seckillAuthorizationDigest,
  seckillIntentHash,
} from './payment-signing.ts';
import { assertEmptySessionPrizeDecision, evaluateForcedReceipt, evaluateTakeover } from './fulfillment.ts';
import { executeProvider, verifyWebhookHmac } from './providers.ts';

const HASH = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const ORDER_ID = `0x${'a'.repeat(64)}`;
const PRODUCT_ID = `0x${'b'.repeat(64)}`;
const SKU_ID = `0x${'c'.repeat(64)}`;
const RESERVATION_ID = `0x${'d'.repeat(64)}`;
const FALLBACK_RESERVATION_ID = `0x${'e'.repeat(64)}`;
const SESSION_ID = `0x${'f'.repeat(64)}`;
const CONTRACT = '0x3333333333333333333333333333333333333333';
const SAFE = '0x4444444444444444444444444444444444444444';
const EXECUTABLE_ACTIONS = new Set(allowedActionNames);

test('typed config reports blocked inputs without exposing secret values', () => {
  const blocked = loadConfig({ CHAIN_ID: '56' });
  assert.ok(blocked.decisionBlocked.includes('PLATFORM_SERVICE_FEE_BPS'));
  assert.equal(blocked.requiredConfirmations, 15);
  assert.ok(blocked.decisionBlocked.includes('PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE'));
  assert.ok(blocked.externalBlocked.includes('DATABASE_URL'));
  assert.equal(blocked.providerReadiness.KUAIDI100, 'CONFIGURATION_REQUIRED');
  assert.equal(publicReadiness(blocked).writesEnabled, false);
  assert.throws(() => requireProvider(blocked, 'KUAIDI100'), { name: 'CoreError' });

  const ready = loadConfig(completeEnvironment());
  const serialized = JSON.stringify(publicReadiness(ready));
  assert.equal(publicReadiness(ready).writesEnabled, false);
  assert.ok(ready.externalBlocked.includes('COORDINATED_DEPLOYMENT_AUTHORIZATION'));
  assert.equal(serialized.includes('test-jwt-secret'), false);
  assert.equal(serialized.includes('provider-secret'), false);
  const readinessTime = new Date('2026-07-14T00:00:00.000Z');
  const paymentReady = {
    ...ready,
    deploymentReady: true,
    decisionBlocked: ['PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE'],
    externalBlocked: ['AUDIT_DATABASE_URL', 'SETTLEMENT_EXECUTOR_URL'],
    paymentDecisionBlocked: [],
    paymentExternalBlocked: [],
    providerReadiness: Object.fromEntries(
      Object.keys(ready.providerReadiness).map((provider) => [provider, 'CONFIGURATION_REQUIRED']),
    ) as typeof ready.providerReadiness,
  };
  assert.equal(publicReadiness(paymentReady, paymentRuntimeReadiness(readinessTime, true), readinessTime).writesEnabled, true);
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), PLATFORM_SERVICE_FEE_BPS: 'not-a-number' }),
    /integer BPS/,
  );
  assert.throws(() => loadConfig({ ...completeEnvironment(), REQUIRED_CONFIRMATIONS: '12' }), /frozen at 15/);
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), SETTLEMENT_EXECUTOR_URL: 'http://executor.example.invalid' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), QUOTE_SIGNER_ADDRESS: SAFE }),
    /distinct addresses/,
  );
});

test('SIWE nonce is domain-bound, one-use and yields an expiring RBAC session', async () => {
  const wallet = Wallet.createRandom();
  const store = new MemoryNonceStore();
  const now = new Date('2026-07-14T01:00:00.000Z');
  const challenge = await createSiweChallenge(
    store,
    {
      walletAddress: wallet.address,
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      statement: 'Sign in to Abu 24K V2',
    },
    now,
  );
  const parallelChallenge = await createSiweChallenge(
    store,
    {
      walletAddress: wallet.address,
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      statement: 'Sign in to Abu 24K V2',
    },
    now,
  );
  const signature = await wallet.signMessage(challenge.message);
  const verified = await verifySiwe(
    store,
    {
      message: challenge.message,
      signature,
      expectedDomain: 'mall.abu.test',
      expectedUri: 'https://mall.abu.test',
    },
    now,
  );
  assert.equal(verified.walletAddress, wallet.address.toLowerCase());
  const parallelVerified = await verifySiwe(
    store,
    {
      message: parallelChallenge.message,
      signature: await wallet.signMessage(parallelChallenge.message),
      expectedDomain: 'mall.abu.test',
      expectedUri: 'https://mall.abu.test',
    },
    now,
  );
  assert.equal(parallelVerified.walletAddress, wallet.address.toLowerCase());
  await assert.rejects(
    verifySiwe(
      store,
      {
        message: challenge.message,
        signature,
        expectedDomain: 'mall.abu.test',
        expectedUri: 'https://mall.abu.test',
      },
      now,
    ),
    /already used/,
  );

  const contractStore = new MemoryNonceStore();
  const contractChallenge = await createSiweChallenge(
    contractStore,
    {
      walletAddress: CONTRACT,
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      statement: 'Sign in to Abu 24K V2',
    },
    now,
  );
  const contractVerified = await verifySiwe(
    contractStore,
    {
      message: contractChallenge.message,
      signature: '0x1234',
      expectedDomain: 'mall.abu.test',
      expectedUri: 'https://mall.abu.test',
    },
    now,
    {
      isValid: async (walletAddress, message, signature) =>
        walletAddress === CONTRACT && message === contractChallenge.message && signature === '0x1234',
    },
  );
  assert.equal(contractVerified.walletAddress, CONTRACT);

  const secret = 'test-jwt-secret-that-is-at-least-32-bytes';
  const token = issueSessionToken({ walletAddress: wallet.address, roles: ['BUYER'] }, secret, now);
  assert.deepEqual(verifySessionToken(token, secret, new Date(now.getTime() + 60_000)).roles, ['BUYER']);
  assert.throws(() => verifySessionToken(token, secret, new Date(now.getTime() + 16 * 60_000)), /Expired/);
});

test('sensitive action binds exact resource, old/new hashes, policy, Safe, nonce and deadline', async () => {
  const secondary = Wallet.createRandom();
  const intent = {
    action: 'PUBLISH_POLICY',
    resourceType: 'POLICY',
    resourceId: 'policy-2',
    policyVersion: 2n,
    oldValueHash: HASH,
    newValueHash: HASH_2,
    safeAddress: SAFE,
    nonce: 1n,
    deadline: 1_800_000_000n,
  };
  const signature = await secondary.signTypedData(sensitiveActionDomain(CONTRACT), sensitiveActionTypes, intent);
  const verified = verifySensitiveActionApproval(
    intent,
    signature,
    secondary.address,
    SAFE,
    CONTRACT,
    new Date(1_799_999_000 * 1000),
  );
  assert.equal(verified.signer, secondary.address.toLowerCase());
  assert.throws(
    () =>
      verifySensitiveActionApproval(
        { ...intent, resourceId: 'policy-3' },
        signature,
        secondary.address,
        SAFE,
        CONTRACT,
        new Date(1_799_999_000 * 1000),
      ),
    /Secondary signer mismatch/,
  );
});

test('Core quote math conserves both assets and dual quote keeps independent reservations', () => {
  const policy = readyPolicy();
  const request = quoteRequest();
  const ordinary = buildPaymentIntent(request, policy, 'ORDINARY', request.issuedAt);
  assert.deepEqual(
    {
      usdt: ordinary.usdtPaymentAmount,
      merchantBase: ordinary.merchantBaseReceivableUsdt,
      concession: ordinary.merchantConcessionAmount,
      merchantNet: ordinary.merchantNetReceivableUsdt,
      other: ordinary.otherUsdtAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(),
      npl: ordinary.nplPaymentAmount,
      burned: ordinary.nplBurnAmount,
      reward: ordinary.nplRewardAmount,
      bnm: ordinary.bnmAmount,
    },
    {
      usdt: '70',
      merchantBase: '60',
      concession: '15',
      merchantNet: '45',
      other: '10',
      npl: '300',
      burned: '200',
      reward: '100',
      bnm: '100',
    },
  );
  assert.equal(ordinary.merchantConcessionAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n), 15n);
  assert.equal(ordinary.nplRewardAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n), 100n);
  assert.equal(ordinary.requiredConfirmations, 15);

  const futurePolicy = {
    ...policy,
    policyVersion: 2,
    nplBurnListPriceBps: 1_800,
    nplRewardListPriceBps: 1_200,
    operationsBps: 600,
  };
  const future = buildPaymentIntent(
    { ...request, latestPolicyVersion: 2 },
    futurePolicy,
    'ORDINARY',
    request.issuedAt,
  );
  assert.equal(future.nplBurnAmount, '180');
  assert.equal(future.nplRewardAmount, '120');
  assert.equal(future.nplRewardAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n), 120n);

  const zeroReward = buildPaymentIntent(
    { ...request, latestPolicyVersion: 2 },
    {
      ...policy,
      policyVersion: 2,
      nplBurnListPriceBps: 3_000,
      nplRewardListPriceBps: 0,
      genesisBps: 0,
      directReferralBps: 0,
      districtBps: 0,
      cityBps: 0,
      provinceBps: 0,
      regionBps: 0,
      operationsBps: 0,
    },
    'ORDINARY',
    request.issuedAt,
  );
  assert.equal(zeroReward.nplBurnAmount, '300');
  assert.equal(zeroReward.nplRewardAmount, '0');
  assert.deepEqual(zeroReward.nplRewardAllocations, []);

  const zeroBurn = buildPaymentIntent(
    { ...request, latestPolicyVersion: 2 },
    {
      ...policy,
      policyVersion: 2,
      nplBurnListPriceBps: 0,
      nplRewardListPriceBps: 3_000,
      operationsBps: 2_400,
    },
    'ORDINARY',
    request.issuedAt,
  );
  assert.equal(zeroBurn.nplBurnAmount, '0');
  assert.equal(zeroBurn.nplRewardAmount, '300');
  assert.equal(zeroBurn.nplRewardAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n), 300n);

  const dual = buildDualPaymentQuote(
    {
      ...request,
      sessionId: SESSION_ID,
    },
    { ...request, reservationId: FALLBACK_RESERVATION_ID, reservationHash: HASH_2 },
    policy,
    request.issuedAt,
  );
  assert.equal(dual.fallback.reservationId, FALLBACK_RESERVATION_ID);
  assert.notEqual(dual.seckill.reservationId, dual.fallback.reservationId);
  assert.equal(dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');

  assert.throws(
    () => buildPaymentIntent({ ...request, latestPolicyVersion: 2 }, policy, 'ORDINARY', request.issuedAt),
    /latest policy/,
  );
  assert.throws(() =>
    buildDualPaymentQuote(
      {
        ...request,
        latestPolicyVersion: 2,
        sessionId: SESSION_ID,
      },
      {
        ...request,
        latestPolicyVersion: 2,
        reservationId: FALLBACK_RESERVATION_ID,
        reservationHash: HASH_2,
      },
      policy,
      request.issuedAt,
    ),
    /latest policy/,
  );
  const blockedPolicy = { ...policy };
  delete blockedPolicy.usdtCustodySafe;
  assert.throws(
    () => buildPaymentIntent(request, blockedPolicy, 'ORDINARY', request.issuedAt),
    /missing Safe or destination/,
  );
});

test('payment snapshot and EIP-712 digest match the frozen Solidity encoding vector', () => {
  const intent = signingVectorIntent();
  assert.equal(paymentIntentHash(intent), '0xc125633288a4ba4ccb0602dae00c885dbe1adb7a0a77cc842f34d3d425d9279f');
  assert.equal(
    paymentAuthorizationDigest(intent, '0x9999999999999999999999999999999999999999'),
    '0x3b991a7728e91bdf283431b553258f94dffe4b516b6283ad3c34a588f7cd21a0',
  );
});

test('seckill snapshot and EIP-712 digest bind both Router payment intents', () => {
  const base = signingVectorIntent();
  const dual = {
    sessionId: `0x${'5'.repeat(64)}`,
    seckill: { ...base, seckill: true, sessionId: `0x${'5'.repeat(64)}` },
    fallback: { ...base, reservationId: `0x${'6'.repeat(64)}`, reservationHash: `0x${'7'.repeat(64)}` },
  };
  assert.equal(seckillIntentHash(dual), '0x292fee156f4df5e8469fcff24055093e8820768b91784e417559b0fabd4d1bce');
  assert.equal(
    seckillAuthorizationDigest(dual, '0x9999999999999999999999999999999999999999'),
    '0x8fd49d5723d836b830cc81647eaaad6b4e5e996f560a9bd034402549241e8246',
  );
});

test('allowedActions obey breakers, timeouts, roles and merchant prize exception', () => {
  const buyer = '0x1111111111111111111111111111111111111111';
  const merchant = '0x2222222222222222222222222222222222222222';
  const now = new Date('2026-07-14T12:00:00.000Z');
  const takeover = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: buyer,
      merchantWallet: merchant,
      paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: buyer, roles: ['BUYER'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(takeover.find((item) => item.action === 'OPEN_TAKEOVER')?.enabled, true);

  const unrelated = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: buyer,
      merchantWallet: merchant,
      paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: SAFE, roles: ['BUYER'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(unrelated.some((item) => item.action === 'OPEN_TAKEOVER'), false);

  const pickup = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'PICKUP',
      buyerWallet: buyer,
      merchantWallet: merchant,
      paidAt: now,
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: buyer, roles: ['BUYER'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(pickup.find((item) => item.action === 'OPEN_TAKEOVER')?.reasonCode, 'PickupTakeoverDecisionBlocked');
  assert.equal(settlementRequestAllowedAction('PRIZE_USDT', 10n, true).enabled, true);
  assert.equal(settlementRequestAllowedAction('MERCHANT_USDT', 10n, true).enabled, false);
  assert.equal(settlementRequestAllowedAction('REWARD_NPL', 0n, false).reasonCode, 'FinalityPending');

  const merchantShipment = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: buyer,
      merchantWallet: merchant,
      paidAt: now,
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: merchant, roles: ['MERCHANT'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(merchantShipment.some((item) => item.action === 'RECORD_SHIPMENT'), true);
});

test('finality rejects mismatched events and handles confirmation, replacement and reorg', () => {
  const submitted = submittedFinality(
    loadConfig(completeEnvironment()),
    {
      resourceType: 'FULFILLMENT',
      resourceId: 'order-1',
      contractAddress: CONTRACT,
      expectedEventHash: HASH,
      txHash: HASH_2,
    },
  );
  assert.equal(submitted.requiredConfirmations, 15);
  const receipt = {
    txHash: HASH_2,
    chainId: 56,
    contractAddress: CONTRACT,
    eventHash: HASH,
    eventResourceId: 'order-1',
    blockNumber: 100,
    blockHash: `0x${'3'.repeat(64)}`,
    confirmations: 11,
    status: 1 as const,
    canonicalBlock: true,
  };
  assert.throws(() => applyReceipt(submitted, { ...receipt, eventHash: `0x${'4'.repeat(64)}` }), /bind/);
  const mined = applyReceipt(submitted, receipt);
  assert.equal(mined.state, 'MINED');
  assert.throws(() => requireFinal(mined), /not reached finality/);
  assert.equal(requireFinal(applyReceipt(submitted, { ...receipt, confirmations: 15 })).state, 'FINAL');
  const replaced = replaceTransaction(submitted, `0x${'5'.repeat(64)}`);
  assert.equal(replaced.replacementForTxHash, HASH_2);
  const reorged = applyReceipt(
    replaced,
    { ...receipt, txHash: replaced.txHash, confirmations: 15, canonicalBlock: false },
  );
  assert.equal(reorged.state, 'REORGED');
  assert.throws(() => requireFinal(reorged), /canonical chain/);
});

test('fulfillment eligibility preserves locked funds and fails closed on undefined branches', () => {
  const paidAt = new Date('2026-07-01T00:00:00.000Z');
  const delivery = {
    orderId: 'order-1',
    fulfillmentMode: 'DELIVERY' as const,
    state: 'PAID' as const,
    paidAt,
    takeoverOpened: false,
  };
  assert.equal(evaluateTakeover(delivery, new Date('2026-07-09T00:00:00.000Z')).customerFundsRemainLocked, true);
  assert.throws(
    () => evaluateTakeover({ ...delivery, fulfillmentMode: 'PICKUP' }, new Date('2026-07-09T00:00:00.000Z')),
    /not defined/,
  );
  const delivered = {
    ...delivery,
    state: 'DELIVERED' as const,
    deliveredAt: new Date('2026-07-01T00:00:00.000Z'),
  };
  assert.equal(
    evaluateForcedReceipt(delivered, 'MERCHANT', new Date('2026-07-09T00:00:00.000Z')).canFinalizeDirectly,
    false,
  );
  assert.throws(() => assertEmptySessionPrizeDecision(undefined, 1n), /remains Locked/);
});

test('provider calls and webhooks fail closed until configured and signed', async () => {
  const blocked = loadConfig({ CHAIN_ID: '56' });
  await assert.rejects(
    executeProvider(blocked, {}, { provider: 'KUAIDI100', operation: 'CREATE_WAYBILL', payload: {}, idempotencyKey: '1' }),
    /not configured/,
  );
  const secret = 'provider-secret';
  const body = Buffer.from('{"state":"delivered"}');
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookHmac(body, signature, secret), true);
  assert.throws(() => verifyWebhookHmac(body, '0'.repeat(64), secret), /mismatch/);
});

test('HTTP bootstrap and SIWE flow return correlated JSON and protect order actions', async () => {
  const wallet = Wallet.createRandom();
  const store = new MemoryNonceStore();
  const now = new Date('2026-07-14T00:00:00.000Z');
  const config = {
    ...loadConfig(completeEnvironment()),
    deploymentReady: true,
    paymentDecisionBlocked: [],
    paymentExternalBlocked: [],
  };
  const runtimeReadiness = paymentRuntimeReadiness(now, false);
  const server = createApiServer({
    config,
    runtimeReadiness,
    nonceStore: store,
    nonceRateLimiter: { consume: async () => undefined },
    authDomain: 'mall.abu.test',
    authUri: 'https://mall.abu.test',
    resolveRoles: async () => ({ roles: ['BUYER'] }),
    getOrderProjection: async (orderId) =>
      orderId === 'order-1'
        ? {
            state: 'DELIVERED',
            fulfillmentMode: 'DELIVERY',
            buyerWallet: wallet.address,
            merchantWallet: SAFE,
            deliveredAt: new Date('2026-07-13T00:00:00.000Z'),
            shipmentEvidence: true,
            takeoverOpened: false,
          }
        : undefined,
    getPausedScopes: async () => new Set(),
    paymentService: {
      listCatalog: async () => [{ productId: 'product-1', skus: [{ skuId: 'sku-1', listPriceUsdt: '100' }] }],
      getProduct: async (productId) => ({ productId, skus: [{ skuId: 'sku-1', listPriceUsdt: '100' }] }),
      createOrdinaryQuote: async (buyerWallet, input) => ({
        orderId: ORDER_ID,
        buyerWallet,
        productId: input.productId,
        state: 'QUOTED',
      }),
      createSeckillQuote: async (buyerWallet, input) => ({
        orderId: ORDER_ID,
        buyerWallet,
        sessionId: input.sessionId,
        state: 'QUOTED',
      }),
      submitPayment: async (buyerWallet, input) => ({ ...input, buyerWallet, state: 'SUBMITTED' }),
      getPayment: async (buyerWallet, orderId) => ({ orderId, buyerWallet, state: 'SUBMITTED' }),
    },
    clock: () => now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await fetch(`${base}/v2/bootstrap`);
    assert.equal(bootstrap.status, 200);
    assert.ok(bootstrap.headers.get('x-correlation-id'));
    const catalog = await fetch(`${base}/v2/catalog/products`);
    assert.equal(catalog.status, 200);

    const extraField = await fetch(`${base}/v2/auth/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress: wallet.address, ignored: true }),
    });
    assert.equal(extraField.status, 400);

    const nonceResponse = await fetch(`${base}/v2/auth/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletAddress: wallet.address }),
    });
    const challenge = (await nonceResponse.json()) as { message: string };
    const signature = await wallet.signMessage(challenge.message);
    const login = await fetch(`${base}/v2/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: challenge.message, signature }),
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token: string };

    const unauthorized = await fetch(`${base}/v2/actions/order`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    const unauthorizedQuote = await fetch(`${base}/v2/payments/quotes`, { method: 'POST', body: '{}' });
    assert.equal(unauthorizedQuote.status, 401);
    const actions = await fetch(`${base}/v2/actions/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ orderId: 'order-1' }),
    });
    assert.equal(actions.status, 200);
    const projection = (await actions.json()) as {
      allowedActions: Array<{ action: string; enabled: boolean; reasonCode?: string }>;
    };
    const confirmReceipt = projection.allowedActions.find((item) => item.action === 'CONFIRM_RECEIPT');
    assert.deepEqual(confirmReceipt, {
      action: 'CONFIRM_RECEIPT',
      enabled: false,
      reasonCode: 'ConfigurationRequired',
    });
    const quotePayload = {
      idempotencyKey: 'checkout-attempt-1',
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    const blockedQuote = await fetch(`${base}/v2/payments/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify(quotePayload),
    });
    assert.equal(blockedQuote.status, 503);
    runtimeReadiness.indexerHealthy = true;
    const quote = await fetch(`${base}/v2/payments/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify(quotePayload),
    });
    assert.equal(quote.status, 201);
    const quoteBody = (await quote.json()) as { orderId: string; buyerWallet: string };
    assert.equal(quoteBody.buyerWallet, wallet.address.toLowerCase());
    const seckillQuote = await fetch(`${base}/v2/seckill/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'seckill-attempt-1',
        sessionId: SESSION_ID,
        productId: 'product-1',
        skuId: 'sku-1',
        quantity: 1,
        fulfillmentMode: 'DELIVERY',
        fulfillmentTargetHash: HASH,
        regionCodeHash: HASH,
      }),
    });
    assert.equal(seckillQuote.status, 201);
    const submission = await fetch(`${base}/v2/payments/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ orderId: quoteBody.orderId, txHash: HASH_2 }),
    });
    assert.equal(submission.status, 202);
    const payment = await fetch(`${base}/v2/payments/${quoteBody.orderId}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(payment.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

class MemoryNonceStore implements NonceStore {
  readonly #values = new Map<string, StoredNonce>();

  async save(nonce: StoredNonce) {
    this.#values.set(nonce.nonceHash, nonce);
  }

  async consume(walletAddress: string, nonceHash: string, now: Date) {
    const value = this.#values.get(nonceHash);
    if (!value || value.walletAddress !== walletAddress || value.consumedAt || value.expiresAt < now) return undefined;
    value.consumedAt = now;
    return value;
  }
}

function readyPolicy(): FrozenPaymentPolicy {
  return {
    policyVersion: 1,
    oracleVersion: HASH,
    usdtPaymentBps: 7_000,
    nplPaymentBps: 3_000,
    nplBurnListPriceBps: 2_000,
    nplRewardListPriceBps: 1_000,
    genesisBps: 200,
    directReferralBps: 100,
    districtBps: 120,
    cityBps: 80,
    provinceBps: 60,
    regionBps: 40,
    operationsBps: 400,
    oracleWindowSeconds: 1_800,
    oracleMaxDeviationBps: 500,
    oracleMaxAgeSeconds: 600,
    oracleMinimumUsdtLiquidity: 50_000n * 10n ** 18n,
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: 1_000n * 10n ** 18n,
    usdtCustodySafe: '0x3333333333333333333333333333333333333333',
    nplRewardSafe: '0x4444444444444444444444444444444444444444',
    operationsTreasurySafe: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6666666666666666666666666666666666666666',
    concessionDestinationSetHash: HASH_2,
    concessionDestinations: [
      { account: '0x7777777777777777777777777777777777777777', weightBps: 4_000 },
      { account: '0x8888888888888888888888888888888888888888', weightBps: 6_000 },
    ],
    operationsDestinations: [
      { account: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', weightBps: 4_000 },
      { account: '0xcccccccccccccccccccccccccccccccccccccccc', weightBps: 6_000 },
    ],
  };
}

function quoteRequest(): PaymentQuoteRequest {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    orderId: ORDER_ID,
    latestPolicyVersion: 1,
    buyer: '0x1111111111111111111111111111111111111111',
    merchant: '0x2222222222222222222222222222222222222222',
    productId: PRODUCT_ID,
    skuId: SKU_ID,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH,
    regionCodeHash: HASH,
    productPolicyHash: HASH,
    reservationId: RESERVATION_ID,
    reservationHash: HASH,
    reservationDeadline: issuedAt + 600,
    issuedAt,
    nonce: 1n,
    deadline: issuedAt + 300,
    listPriceUsdt: 100n,
    nplQuoteAmount: 1_000n,
    merchantBaseReceivableUsdt: 60n,
    merchantConcessionBps: 2_500,
    otherUsdtAllocations: [
      { account: '0x9999999999999999999999999999999999999999', amount: 10n, purpose: 'POLICY_ALLOCATION' },
    ],
    beneficiaries: {
      genesis: SAFE,
      directReferral: '0x5555555555555555555555555555555555555555',
      district: '0x6666666666666666666666666666666666666666',
      city: '0x7777777777777777777777777777777777777777',
      province: '0x8888888888888888888888888888888888888888',
      region: '0x9999999999999999999999999999999999999999',
      operations: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
}

function signingVectorIntent(): CanonicalPaymentIntent {
  const hash = (character: string) => `0x${character.repeat(64)}`;
  const address = (character: string) => `0x${character.repeat(40)}`;
  return {
    orderId: hash('a'),
    policyVersion: 1,
    oracleVersion: hash('1'),
    buyer: address('1'),
    merchant: address('2'),
    productId: hash('b'),
    skuId: hash('c'),
    quantity: 2,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: hash('d'),
    regionCodeHash: hash('e'),
    productPolicyHash: hash('f'),
    reservationId: hash('2'),
    reservationHash: hash('3'),
    reservationDeadline: 1_800_000_600,
    issuedAt: 1_800_000_000,
    deadline: 1_800_000_300,
    nonce: '7',
    listPriceUsdt: '100000000000000000000',
    usdtPaymentAmount: '70000000000000000000',
    nplQuoteAmount: '1000000000000000000000',
    nplPaymentAmount: '300000000000000000000',
    nplBurnAmount: '200000000000000000000',
    nplRewardAmount: '100000000000000000000',
    merchantBaseReceivableUsdt: '60000000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '15000000000000000000',
    merchantNetReceivableUsdt: '45000000000000000000',
    concessionAllocationHash: hash('4'),
    bnmAmount: '100000000000000000000',
    seckill: false,
    sessionId: hash('0'),
    beneficiaries: {
      genesis: address('3'),
      directReferral: address('4'),
      district: address('5'),
      city: address('6'),
      province: address('7'),
      region: address('8'),
      operations: address('0'),
    },
    merchantConcessionAllocations: [],
    otherUsdtAllocations: [],
    nplRewardAllocations: [],
    requiredConfirmations: 15,
  };
}

function completeEnvironment(): Record<string, string> {
  return {
    CHAIN_ID: '56',
    DATABASE_URL: 'postgres://test:test@localhost/business',
    AUDIT_DATABASE_URL: 'postgres://test:test@localhost/audit',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    AUTH_DOMAIN: 'mall.abu.test',
    AUTH_URI: 'https://mall.abu.test',
    BSC_RPC_URL: 'https://rpc.example.invalid',
    BSC_FALLBACK_RPC_URL: 'https://fallback-rpc.example.invalid',
    PLATFORM_SAFE_ADDRESS: SAFE,
    USDT_CUSTODY_SAFE_ADDRESS: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    NPL_REWARD_SAFE_ADDRESS: '0xcccccccccccccccccccccccccccccccccccccccc',
    OPERATIONS_TREASURY_SAFE_ADDRESS: '0xdddddddddddddddddddddddddddddddddddddddd',
    SECONDARY_SIGNER_ADDRESS: '0x5555555555555555555555555555555555555555',
    QUOTE_SIGNER_ADDRESS: '0x6666666666666666666666666666666666666666',
    FINALITY_SIGNER_ADDRESS: '0x7777777777777777777777777777777777777777',
    TWAP_SOURCE_ADDRESS: '0x8888888888888888888888888888888888888888',
    SIGNER_SERVICE_URL: 'https://signer.example.invalid',
    SIGNER_SERVICE_TOKEN: 'provider-secret',
    SETTLEMENT_EXECUTOR_URL: 'https://executor.example.invalid',
    SETTLEMENT_EXECUTOR_TOKEN: 'provider-secret',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    PLATFORM_SERVICE_FEE_BPS: '500',
    SECKILL_PRIZE_POOL_BPS: '1000',
    MERCHANT_CONCESSION_DESTINATIONS_JSON:
      '[{"account":"0x1111111111111111111111111111111111111111","weightBps":4000},{"account":"0x2222222222222222222222222222222222222222","weightBps":6000}]',
    CIRCULATION_REWARD_POOL_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    GENESIS_CREDENTIAL_ADDRESS: '0x9999999999999999999999999999999999999999',
    GENESIS_CREDENTIAL_TOKEN_ID: '1',
    REQUIRED_CONFIRMATIONS: '15',
    AMAP_WEB_SERVICE_KEY: 'provider-secret',
    KUAIDI100_CUSTOMER: 'provider-secret',
    KUAIDI100_KEY: 'provider-secret',
    KUAIDI100_SECRET: 'provider-secret',
    KUAIDI100_CALLBACK_SECRET: 'provider-secret',
    FEIE_USER: 'provider-secret',
    FEIE_UKEY: 'provider-secret',
    ALIYUN_SMS_ACCESS_KEY_ID: 'provider-secret',
    ALIYUN_SMS_ACCESS_KEY_SECRET: 'provider-secret',
    ALIYUN_OSS_ACCESS_KEY_ID: 'provider-secret',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'provider-secret',
    SMTP_URL: 'smtp://provider.invalid',
    JPUSH_APP_KEY: 'provider-secret',
    JPUSH_MASTER_SECRET: 'provider-secret',
  };
}

function paymentRuntimeReadiness(now: Date, indexerHealthy: boolean) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    checkedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    componentHashesVerified: true,
    deployedRuntimeCodeVerified: true,
    roleGrantsVerified: true,
    safeAdminVerified: true,
    signerBindingsVerified: true,
    oracleDeploymentVerified: true,
    indexerHealthy,
    databaseHealthy: true,
    redisHealthy: true,
    rpcChain56Healthy: true,
    signerHealthy: true,
  };
}

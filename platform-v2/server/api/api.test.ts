import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Wallet } from 'ethers';
import { orderAllowedActions, claimAllowedAction } from './allowed-actions.ts';
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
import { buildDualQuote, buildOrderIntent, type FrozenPolicyTerms, type QuoteRequest } from './checkout.ts';
import { allowedActionNames } from './enums.ts';
import { loadConfig, publicReadiness, requireProvider } from './config.ts';
import { applyReceipt, replaceTransaction, requireFinal, submittedFinality } from './finality.ts';
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
  assert.ok(blocked.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'));
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
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), PLATFORM_SERVICE_FEE_BPS: 'not-a-number' }),
    /integer BPS/,
  );
  assert.throws(() => loadConfig({ ...completeEnvironment(), REQUIRED_CONFIRMATIONS: '4294967296' }), /uint32/);
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
  const ordinary = buildOrderIntent(request, policy, 'ORDINARY');
  assert.deepEqual(
    {
      usdt: ordinary.usdtPaymentAmount,
      merchant: ordinary.merchantUsdtAmount,
      platform: ordinary.platformUsdtAmount,
      prize: ordinary.prizeUsdtAmount,
      remainder: ordinary.usdtRemainderAmount,
      npl: ordinary.nplPaymentAmount,
      burned: ordinary.burnedNplAmount,
      routed: ordinary.routedNplAmount,
      bnm: ordinary.bnmAmount,
    },
    {
      usdt: '50',
      merchant: '30',
      platform: '5',
      prize: '0',
      remainder: '15',
      npl: '500',
      burned: '100',
      routed: '400',
      bnm: '100',
    },
  );

  const dual = buildDualQuote(
    {
      ...request,
      sessionId: SESSION_ID,
      fallbackReservationId: FALLBACK_RESERVATION_ID,
      fallbackReservationHash: HASH_2,
    },
    policy,
  );
  assert.equal(dual.seckill.prizeUsdtAmount, '10');
  assert.equal(dual.seckill.usdtRemainderAmount, '5');
  assert.equal(dual.fallback.prizeUsdtAmount, '0');
  assert.equal(dual.fallback.reservationId, FALLBACK_RESERVATION_ID);
  assert.notEqual(dual.seckill.reservationId, dual.fallback.reservationId);
  assert.equal(dual.classificationAuthority, 'CHAIN_TIMESTAMP');

  assert.throws(
    () => buildOrderIntent({ ...request, latestPolicyVersion: 2 }, policy, 'ORDINARY'),
    /latest policy/,
  );
  assert.doesNotThrow(() =>
    buildDualQuote(
      {
        ...request,
        latestPolicyVersion: 2,
        sessionId: SESSION_ID,
        fallbackReservationId: FALLBACK_RESERVATION_ID,
        fallbackReservationHash: HASH_2,
      },
      policy,
    ),
  );
  const blockedPolicy = { ...policy };
  delete blockedPolicy.platformFeeBps;
  assert.throws(() => buildOrderIntent(request, blockedPolicy, 'ORDINARY'), /unresolved production values/);
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
  assert.equal(claimAllowedAction('PRIZE_USDT', 10n, true, new Set()).enabled, true);
  assert.equal(claimAllowedAction('MERCHANT_USDT', 10n, true, new Set()).enabled, false);
  assert.equal(claimAllowedAction('BNM', 10n, false, new Set(['REWARD_CLAIM'])).reasonCode, 'BreakerActive');

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
  assert.equal(submitted.requiredConfirmations, 12);
  assert.throws(
    () =>
      submittedFinality(
        { requiredConfirmations: undefined },
        {
          resourceType: 'FULFILLMENT',
          resourceId: 'order-1',
          contractAddress: CONTRACT,
          expectedEventHash: HASH,
          txHash: HASH_2,
        },
      ),
    /not frozen/,
  );
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
  assert.equal(requireFinal(applyReceipt(submitted, { ...receipt, confirmations: 12 })).state, 'FINAL');
  const replaced = replaceTransaction(submitted, `0x${'5'.repeat(64)}`);
  assert.equal(replaced.replacementForTxHash, HASH_2);
  const reorged = applyReceipt(
    replaced,
    { ...receipt, txHash: replaced.txHash, confirmations: 12, canonicalBlock: false },
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
  const server = createApiServer({
    config: loadConfig(completeEnvironment()),
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
    clock: () => new Date('2026-07-14T00:00:00.000Z'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await fetch(`${base}/v2/bootstrap`);
    assert.equal(bootstrap.status, 200);
    assert.ok(bootstrap.headers.get('x-correlation-id'));

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

function readyPolicy(): FrozenPolicyTerms {
  return {
    policyVersion: 1,
    oracleVersion: HASH,
    usdtPaymentBps: 5_000,
    nplPaymentBps: 5_000,
    burnBps: 2_000,
    routeBps: 8_000,
    platformFeeBps: 500,
    seckillPrizeBps: 1_000,
    merchantStoreBps: 100,
    oracleMaxAgeSeconds: 600,
    oracleMinimumLiquidity: 100n,
    merchantGuaranteeMinimumUsdt: 100n,
    platformRiskReserveMinimumUsdt: 100n,
  };
}

function quoteRequest(): QuoteRequest {
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
    reservationDeadline: 1_800_000_000,
    nonce: 1n,
    deadline: 1_800_000_000,
    listPriceUsdt: 100n,
    rewardBaseNpl: 1_000n,
    merchantSettlementUsdt: 30n,
    beneficiaries: { genesis: SAFE },
  };
}

function completeEnvironment(): Record<string, string> {
  return {
    CHAIN_ID: '56',
    DATABASE_URL: 'postgres://test:test@localhost/business',
    AUDIT_DATABASE_URL: 'postgres://test:test@localhost/audit',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    BSC_RPC_URL: 'https://rpc.example.invalid',
    PLATFORM_SAFE_ADDRESS: SAFE,
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
    MERCHANT_STORE_NPL_REWARD_BPS: '100',
    MERCHANT_GUARANTEE_MINIMUM_USDT: '100',
    PLATFORM_RISK_RESERVE_MINIMUM_USDT: '100',
    GUARANTEE_TOP_UP_LINE_USDT: '50',
    ORACLE_MAX_AGE_SECONDS: '600',
    ORACLE_MINIMUM_LIQUIDITY: '100',
    GENESIS_CREDENTIAL_ADDRESS: '0x9999999999999999999999999999999999999999',
    GENESIS_CREDENTIAL_TOKEN_ID: '1',
    REQUIRED_CONFIRMATIONS: '12',
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

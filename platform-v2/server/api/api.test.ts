import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
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
import { concessionPreviewAuthorization } from './catalog-signing.ts';
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
import {
  parsePaymentPolicySnapshot,
  paymentAllocationSetHash,
  type PaymentPolicySnapshot,
} from './payment-policy.ts';
import { assertEmptySessionPrizeDecision, evaluateForcedReceipt, evaluateTakeover } from './fulfillment.ts';
import {
  AmapAdministrativeRegionResolver,
  AmapPostalAddressParser,
  executeProvider,
  verifyWebhookHmac,
} from './providers.ts';
import { AmbiguousProviderResultError } from '../data/logistics-printing-service.ts';
import {
  CainiaoWaybillAdapter,
  FeiePrintAdapter,
  Kuaidi100WaybillAdapter,
  YilianyunPrintAdapter,
} from './logistics-providers.ts';
import {
  settlementIntentDigest,
  settlementRequestDomain,
  settlementRequestTypes,
  verifySettlementRequestSignature,
} from './settlement-signing.ts';
import { assertSafeSettlementBatch, buildSafeSettlementBatch } from '../chain/safe-multisend.ts';

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
  assert.deepEqual(blocked.decisionBlocked, []);
  assert.deepEqual(blocked.paymentDecisionBlocked, []);
  assert.equal(blocked.requiredConfirmations, 15);
  assert.ok(blocked.externalBlocked.includes('DATABASE_URL'));
  assert.ok(blocked.externalBlocked.includes('PII_RETENTION_POLICY_VERSION'));
  assert.ok(blocked.paymentExternalBlocked.includes('PLATFORM_SERVICE_FEE_SAFE_ADDRESS'));
  assert.equal(blocked.providerReadiness.KUAIDI100, 'CONFIGURATION_REQUIRED');
  assert.equal(blocked.providerReadiness.BNM, 'CONFIGURATION_REQUIRED');
  assert.equal(publicReadiness(blocked).writesEnabled, false);
  assert.throws(() => requireProvider(blocked, 'KUAIDI100'), { name: 'CoreError' });

  const ready = loadConfig(completeEnvironment());
  const serialized = JSON.stringify(publicReadiness(ready));
  assert.equal(publicReadiness(ready).writesEnabled, false);
  assert.ok(ready.externalBlocked.includes('COORDINATED_DEPLOYMENT_AUTHORIZATION'));
  assert.equal(serialized.includes('test-jwt-secret'), false);
  assert.equal(serialized.includes('provider-secret'), false);
  assert.equal(ready.providerReadiness.BNM, 'READY');
  const unverifiedBnm = loadConfig({
    ...completeEnvironment(),
    BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH: undefined,
  });
  assert.equal(unverifiedBnm.providerReadiness.BNM, 'CONFIGURATION_REQUIRED');
  assert.ok(unverifiedBnm.externalBlocked.includes('BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH'));
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH: 'unverified' }),
    /must be bytes32/,
  );
  const readinessTime = new Date('2026-07-14T00:00:00.000Z');
  const paymentReady = {
    ...ready,
    deploymentReady: true,
    decisionBlocked: [],
    externalBlocked: ['AUDIT_DATABASE_URL', 'SETTLEMENT_EXECUTOR_URL'],
    paymentDecisionBlocked: [],
    paymentExternalBlocked: [],
    providerReadiness: Object.fromEntries(
      Object.keys(ready.providerReadiness).map((provider) => [provider, 'CONFIGURATION_REQUIRED']),
    ) as typeof ready.providerReadiness,
  };
  assert.equal(publicReadiness(paymentReady, paymentRuntimeReadiness(readinessTime, true), readinessTime).writesEnabled, true);
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), PLATFORM_SERVICE_FEE_SAFE_ADDRESS: 'not-an-address' }),
    /address/,
  );
  assert.throws(() => loadConfig({ ...completeEnvironment(), REQUIRED_CONFIRMATIONS: '12' }), /frozen at 15/);
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), SETTLEMENT_EXECUTOR_URL: 'http://executor.example.invalid' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), BSC_RPC_URL: 'wss://rpc.example.invalid' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({
      ...completeEnvironment(),
      BSC_RPC_URL: 'https://rpc.example.invalid',
      BSC_FALLBACK_RPC_URL: 'https://rpc.example.invalid/',
    }),
    /must be distinct/,
  );
  assert.throws(
    () => loadConfig({ ...completeEnvironment(), QUOTE_SIGNER_ADDRESS: SAFE }),
    /must not use a Safe address/,
  );
  assert.doesNotThrow(() => loadConfig({
    ...completeEnvironment(),
    SECONDARY_SIGNER_ADDRESS: '0x5555555555555555555555555555555555555555',
    QUOTE_SIGNER_ADDRESS: '0x5555555555555555555555555555555555555555',
    FINALITY_SIGNER_ADDRESS: '0x5555555555555555555555555555555555555555',
  }));
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

test('settlement EIP-712 intent and Safe MultiSend bind wallet, items, nonce and exact transfers', async () => {
  const wallet = Wallet.createRandom();
  const intent = {
    intentId: ORDER_ID,
    artifactVersion: CORE_ARTIFACT_VERSION,
    wallet: wallet.address,
    recipient: wallet.address,
    rail: 'MERCHANT_USDT' as const,
    asset: '0x55d398326f99059ff775485246999027b3197955',
    safeAddress: SAFE,
    amount: '45',
    itemsHash: HASH,
    nonce: '3',
    deadline: 1_800_000_300,
  };
  const signature = await wallet.signTypedData(
    settlementRequestDomain(SAFE),
    settlementRequestTypes,
    intent,
  );
  const verified = await verifySettlementRequestSignature(
    intent,
    signature,
    new Date(1_800_000_000_000),
  );
  assert.equal(verified.wallet, wallet.address.toLowerCase());
  assert.equal(verified.digest, settlementIntentDigest(intent));
  await assert.rejects(
    verifySettlementRequestSignature(
      { ...intent, amount: '46' },
      signature,
      new Date(1_800_000_000_000),
    ),
    /signer does not match/,
  );

  const batch = buildSafeSettlementBatch({
    batchId: HASH_2,
    safeAddress: SAFE,
    safeNonce: '7',
    items: [
      {
        orderId: ORDER_ID,
        requestId: HASH_2,
        requestItemIndex: 0,
        accountId: `merchant:${wallet.address.toLowerCase()}:usdt`,
        tokenAddress: intent.asset,
        recipientAddress: wallet.address,
        amount: '45',
      },
    ],
  });
  assert.equal(batch.safeTransaction.operation, 1);
  assert.equal(batch.safeTransaction.safeTxGas, '0');
  assert.equal(batch.items[0]?.transferCalldata.slice(0, 10), '0xa9059cbb');
  assert.equal(assertSafeSettlementBatch(batch).safeTxHash, batch.safeTxHash);
  assert.throws(
    () => assertSafeSettlementBatch({ ...batch, totalAmount: '46' }),
    /totalAmount/,
  );
});

test('catalog concession authorization binds preview identity, product, policy and expiry', () => {
  const authorization = concessionPreviewAuthorization({
    previewHash: HASH,
    previewId: HASH_2,
    productId: 'product-1',
    policyVersion: 3,
    expiresAt: 1_800_000_000,
  });
  assert.equal(authorization.message.previewId, HASH_2);
  assert.notEqual(authorization.digest, concessionPreviewAuthorization({
    previewHash: HASH,
    previewId: ORDER_ID,
    productId: 'product-1',
    policyVersion: 3,
    expiresAt: 1_800_000_000,
  }).digest);
  assert.notEqual(authorization.digest, concessionPreviewAuthorization({
    previewHash: HASH,
    previewId: HASH_2,
    productId: 'product-2',
    policyVersion: 3,
    expiresAt: 1_800_000_000,
  }).digest);
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
      fee: ordinary.platformServiceFeeUsdt,
      custody: ordinary.custodyProductUsdt,
      npl: ordinary.nplPaymentAmount,
      burned: ordinary.nplBurnAmount,
      reward: ordinary.nplRewardAmount,
      bnm: ordinary.bnmAmount,
    },
    {
      usdt: '70',
      merchantBase: '69',
      concession: '17',
      merchantNet: '52',
      fee: '1',
      custody: '69',
      npl: '300',
      burned: '200',
      reward: '100',
      bnm: '100',
    },
  );
  assert.equal(ordinary.merchantConcessionAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n), 17n);
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

test('governed USDT concession uses only the fixed 45/45/10 Custody pools', () => {
  const policy = governedPaymentPolicy();
  const request = quoteRequest();
  const intent = buildPaymentIntent(request, policy, 'ORDINARY', request.issuedAt);
  assert.deepEqual(intent.merchantConcessionAllocations, [
    { pool: 'SECKILL_PRIZE', amount: '7', balanceState: 'LOCKED' },
    { pool: 'NODE_REWARD', amount: '7', balanceState: 'LOCKED' },
    { pool: 'REWARD_RESERVE', amount: '3', balanceState: 'LOCKED' },
  ]);
  assert.equal(policy.concessionDestinationSetHash, paymentAllocationSetHash());

  const payload = {
    ...policy,
    oracleMinimumUsdtLiquidity: policy.oracleMinimumUsdtLiquidity.toString(),
    merchantGuaranteeMinimumUsdt: policy.merchantGuaranteeMinimumUsdt.toString(),
  };
  assert.throws(
    () => parsePaymentPolicySnapshot(1, HASH, { ...payload, platformFeeBps: 101 }),
    /Frozen launch payment or safety policy/,
  );
  assert.throws(
    () => parsePaymentPolicySnapshot(1, HASH, { ...payload, concessionDestinationSetHash: HASH }),
    /invalid governed fields/,
  );
});

test('payment snapshot and EIP-712 digest match the frozen Solidity encoding vector', () => {
  const intent = signingVectorIntent();
  assert.equal(paymentIntentHash(intent), '0x99ccfc957ff13dd932246ab4f65c3636c3557d7bfdd00369ee9a4c4a597c90b9');
  assert.equal(
    paymentAuthorizationDigest(intent, '0x9999999999999999999999999999999999999999'),
    '0x8d92356ce3efbaa3271f6c99d9166b7bb90787905fd35308c9b0b6bb094ff033',
  );
});

test('seckill snapshot and EIP-712 digest bind both Router payment intents', () => {
  const base = signingVectorIntent();
  const dual = {
    sessionId: `0x${'5'.repeat(64)}`,
    seckill: { ...base, seckill: true, sessionId: `0x${'5'.repeat(64)}` },
    fallback: { ...base, reservationId: `0x${'6'.repeat(64)}`, reservationHash: `0x${'7'.repeat(64)}` },
  };
  assert.equal(seckillIntentHash(dual), '0xf222066b7b08d6c1cec6fd2121354ff180c25df10879612465567ec53447536b');
  assert.equal(
    seckillAuthorizationDigest(dual, '0x9999999999999999999999999999999999999999'),
    '0x19d2d96a413026200dce3a6b06fffe55ee6a9dffba237ed48ca03f92eb09d4fd',
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
      merchantId: 'merchant-1',
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
      merchantId: 'merchant-1',
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
      merchantId: 'merchant-1',
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
      merchantId: 'merchant-1',
      merchantWallet: merchant,
      paidAt: now,
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: merchant, roles: ['MERCHANT'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(merchantShipment.some((item) => item.action === 'RECORD_SHIPMENT'), true);
  const merchantSubwallet = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: buyer,
      merchantId: 'merchant-1',
      merchantWallet: merchant,
      paidAt: now,
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    {
      actorWallet: SAFE,
      actorMerchantId: 'merchant-1',
      roles: ['MERCHANT'],
      now,
      pausedScopes: new Set(),
      executableActions: EXECUTABLE_ACTIONS,
    },
  );
  assert.equal(merchantSubwallet.some((item) => item.action === 'RECORD_SHIPMENT'), true);

  const pickupWithCredential = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'PICKUP',
      buyerWallet: buyer,
      merchantId: 'merchant-1',
      merchantWallet: merchant,
      paidAt: now,
      shipmentEvidence: false,
      takeoverOpened: false,
      activePickupCredential: true,
      openRequestTypes: ['EXCHANGE'],
    },
    { actorWallet: buyer, roles: ['BUYER'], now, pausedScopes: new Set(), executableActions: EXECUTABLE_ACTIONS },
  );
  assert.equal(pickupWithCredential.some((item) => item.action === 'REGISTER_PICKUP_CREDENTIAL'), false);
  assert.equal(pickupWithCredential.some((item) => item.action === 'REQUEST_EXCHANGE'), false);
  assert.equal(pickupWithCredential.some((item) => item.action === 'REQUEST_DELAY'), true);

  const deliveredForPlatform = {
    state: 'DELIVERED' as const,
    fulfillmentMode: 'DELIVERY' as const,
    buyerWallet: buyer,
    merchantId: 'merchant-1',
    merchantWallet: merchant,
    paidAt: now,
    deliveredAt: now,
    shipmentEvidence: true,
    takeoverOpened: false,
  };
  const platformContext = {
    actorWallet: SAFE,
    roles: ['OPERATOR'] as const,
    now,
    pausedScopes: new Set<'NEW_PAYMENT' | 'SECKILL_PURCHASE' | 'NEW_SETTLEMENT_BATCH'>(),
    executableActions: EXECUTABLE_ACTIONS,
  };
  assert.equal(
    orderAllowedActions(deliveredForPlatform, platformContext)
      .some((item) => item.action === 'DECIDE_FORCED_RECEIPT'),
    false,
  );
  const platformActions = orderAllowedActions(
    { ...deliveredForPlatform, openRequestTypes: ['FORCED_RECEIPT'], approvedExchange: true },
    platformContext,
  );
  assert.equal(platformActions.some((item) => item.action === 'DECIDE_FORCED_RECEIPT'), true);
  assert.equal(platformActions.some((item) => item.action === 'RECORD_SHIPMENT'), true);
  assert.equal(platformActions.some((item) => item.action === 'OPEN_ARBITRATION'), true);
  const merchantWithForcedRequest = orderAllowedActions(
    { ...deliveredForPlatform, openRequestTypes: ['FORCED_RECEIPT'] },
    {
      actorWallet: merchant,
      roles: ['MERCHANT'],
      now: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000),
      pausedScopes: new Set(),
      executableActions: EXECUTABLE_ACTIONS,
    },
  );
  assert.equal(merchantWithForcedRequest.some((item) => item.action === 'REQUEST_FORCED_RECEIPT'), false);

  const platformTakeover = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: buyer,
      merchantId: 'merchant-1',
      merchantWallet: merchant,
      paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    platformContext,
  );
  assert.equal(platformTakeover.some((item) => item.action === 'OPEN_TAKEOVER'), true);
  assert.equal(
    orderAllowedActions(
      {
        state: 'PAID',
        fulfillmentMode: 'DELIVERY',
        buyerWallet: buyer,
        merchantId: 'merchant-1',
        merchantWallet: merchant,
        paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
        shipmentEvidence: false,
        takeoverOpened: true,
      },
      platformContext,
    ).some((item) => item.action === 'OPEN_TAKEOVER'),
    false,
  );
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
    paymentFinalizedAt: paidAt,
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

  await assert.rejects(
    new AmapAdministrativeRegionResolver({}).reverseGeocode({ longitude: 116.397, latitude: 39.908 }),
    /not configured/,
  );
  let requestedUrl = '';
  const amap = new AmapAdministrativeRegionResolver({
    key: 'amap-secret',
    fetch: (async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({
        status: '1',
        regeocode: {
          formatted_address: 'Beijing Dongcheng Test Road 1',
          addressComponent: {
            adcode: '110101',
            province: 'Beijing',
            city: [],
            district: 'Dongcheng',
          },
        },
      }), { status: 200 });
    }) as typeof fetch,
  });
  const region = await amap.reverseGeocode({ longitude: 116.397, latitude: 39.908 });
  assert.equal(region.regionCode, '110101');
  assert.equal(region.city, 'Beijing');
  assert.ok(requestedUrl.startsWith('https://restapi.amap.com/v3/geocode/regeo?'));
  await assert.rejects(
    new AmapPostalAddressParser({}).parse({ rawText: '张三 13800138000 辽宁省大连市甘井子区软件园' }),
    /not configured/,
  );
  const parser = new AmapPostalAddressParser({
    key: 'amap-secret',
    fetch: (async () => new Response(JSON.stringify({
      status: '1',
      geocodes: [{
        formatted_address: '辽宁省大连市甘井子区软件园',
        province: '辽宁省',
        city: '大连市',
        district: '甘井子区',
        adcode: '210211',
        location: '121.600000,38.900000',
      }],
    }), { status: 200 })) as typeof fetch,
  });
  const parsed = await parser.parse({ rawText: '张三 13800138000 辽宁省大连市甘井子区软件园' });
  assert.equal(parsed.recipientName, '张三');
  assert.equal(parsed.phone, '13800138000');
  assert.equal(parsed.regionCode, '210211');
});

test('logistics adapters send provider-documented idempotency and cloud-print fields', async () => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
    if (url.includes('kuaidi100')) {
      return Response.json({ success: true, code: 200, data: { taskId: 'task-1', kuaidinum: 'SF12345678' } });
    }
    if (url.includes('feieyun')) return Response.json({ ret: 0, msg: 'ok', data: 'feie-order-1' });
    if (url.includes('10ss.net')) return Response.json({ error: 0, body: { id: 'yilian-order-1' } });
    return Response.json({ success: true, waybillCloudPrintResponseList: [{ objectId: HASH, waybillCode: 'YT12345678' }] });
  }) as typeof fetch;
  const waybill = {
    requestId: HASH,
    orderId: ORDER_ID,
    carrierCode: 'SF' as const,
    sender: { name: 'Abu Store', phone: '13800138000', address: 'Dalian Software Park 1' },
    recipient: { name: 'Buyer Name', phone: '13900139000', address: 'Dalian Software Park 2' },
    quantity: '2',
  };

  await new Kuaidi100WaybillAdapter({
    key: 'key-1', secret: 'secret-1', customer: 'partner-1', siid: 'printer-1', fetch: fetcher,
  }).createWaybill(waybill);
  const kuaidi = requests.at(-1)!.body;
  const kuaidiParam = JSON.parse(kuaidi.get('param')!) as Record<string, unknown>;
  assert.equal(kuaidiParam.orderId, HASH.slice(2));
  assert.equal(kuaidiParam.printType, 'CLOUD');
  assert.equal(kuaidiParam.siid, 'printer-1');
  assert.equal(kuaidiParam.reorder, false);
  assert.equal(kuaidi.get('sign'), createHash('md5')
    .update(`${kuaidi.get('param')}${kuaidi.get('t')}key-1secret-1`).digest('hex').toUpperCase());

  await new FeiePrintAdapter({ user: 'feie-user', ukey: 'feie-key', fetch: fetcher }).print({
    printJobId: HASH, deviceId: 'FEIE-001', content: 'receipt', copyCount: 2,
  });
  const feie = requests.at(-1)!.body;
  assert.equal(feie.get('apiname'), 'Open_printMsg');
  assert.equal(feie.get('times'), '2');
  assert.equal(feie.get('sig'), createHash('sha1')
    .update(`feie-userfeie-key${feie.get('stime')}`).digest('hex'));

  await new YilianyunPrintAdapter({
    clientId: 'client-1', clientSecret: 'client-secret-1', accessToken: 'access-1', fetch: fetcher,
  }).print({ printJobId: HASH, deviceId: 'YLY-001', content: 'receipt', copyCount: 1 });
  const yilian = requests.at(-1)!.body;
  assert.equal(yilian.get('origin_id'), HASH.slice(2));
  assert.equal(yilian.get('idempotence'), '1');
  assert.equal(yilian.get('copies'), '1');
  assert.equal(yilian.get('sign'), createHash('md5')
    .update(`client-1${yilian.get('timestamp')}client-secret-1`).digest('hex'));

  let signedPayload = '';
  await new CainiaoWaybillAdapter({
    logisticProviderId: 'provider-1',
    signer: { sign: async (payload) => { signedPayload = payload; return 'official-onboarding-digest'; } },
    fetch: fetcher,
  }).createWaybill({ ...waybill, carrierCode: 'YTO' });
  const cainiao = requests.at(-1)!.body;
  assert.equal(cainiao.get('msg_type'), 'TMS_WAYBILL_GET');
  assert.equal(cainiao.get('logistic_provider_id'), 'provider-1');
  assert.equal(cainiao.get('data_digest'), 'official-onboarding-digest');
  assert.equal(cainiao.get('logistics_interface'), signedPayload);
});

test('logistics adapters fail closed for missing credentials, oversized payloads and ambiguous transport results', async () => {
  await assert.rejects(
    new Kuaidi100WaybillAdapter({}).createWaybill({
      requestId: HASH,
      orderId: ORDER_ID,
      carrierCode: 'SF',
      sender: { name: 'Sender', phone: '13800138000', address: 'Sender address' },
      recipient: { name: 'Buyer', phone: '13900139000', address: 'Buyer address' },
      quantity: '1',
    }),
    /KUAIDI100 is not configured/,
  );
  await assert.rejects(
    new FeiePrintAdapter({ user: 'user', ukey: 'key' }).print({
      printJobId: HASH, deviceId: 'FEIE-001', content: 'x'.repeat(5_001), copyCount: 1,
    }),
    /exceeds 5000 bytes/,
  );
  await assert.rejects(
    new FeiePrintAdapter({
      user: 'user',
      ukey: 'key',
      fetch: (async () => { throw new Error('timeout'); }) as typeof fetch,
    }).print({ printJobId: HASH, deviceId: 'FEIE-001', content: 'receipt', copyCount: 1 }),
    AmbiguousProviderResultError,
  );
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
  const fulfillmentCalls: Array<{ operation: string; wallet: string; orderId: string; input?: unknown }> = [];
  const statementCalls: Array<{ operation: string; wallet: string; input?: unknown }> = [];
  const evidenceCalls: Array<{ operation: string; wallet: string; input: unknown }> = [];
  const cmsPublishedContexts: unknown[] = [];
  let notificationEndpointCorrelationId: string | undefined;
  let monitoringCorrelationId: string | undefined;
  let ensuredBuyerUidWallet: string | undefined;
  const server = createApiServer({
    config,
    runtimeReadiness,
    nonceStore: store,
    nonceRateLimiter: { consume: async () => undefined },
    authDomain: 'mall.abu.test',
    authUri: 'https://mall.abu.test',
    resolveRoles: async () => ({
      roles: ['BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'],
      merchantId: 'merchant-1',
    }),
    getOrderProjection: async (orderId) =>
      orderId === 'order-1'
        ? {
            state: 'DELIVERED',
            fulfillmentMode: 'DELIVERY',
            buyerWallet: wallet.address,
            merchantId: 'merchant-1',
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
      getAdminPayment: async (actor, orderId) => ({ orderId, actor: actor.walletAddress, state: 'SUBMITTED' }),
    },
    catalogManagementService: {
      listCategories: async (includeInactive) => [{ categoryId: 'category-1', includeInactive }],
      listTags: async (includeInactive) => [{ tagId: 'tag-1', includeInactive }],
      upsertCategory: async (actor, input) => ({ actor: actor.walletAddress, categoryId: 'category-1', ...input }),
      upsertTag: async (actor, input) => ({ actor: actor.walletAddress, tagId: 'tag-1', ...input }),
      getProductSlot: async (actor, storeId, merchantId) => ({ actor: actor.walletAddress, storeId, merchantId, product: null }),
      saveProductSlot: async (actor, storeId, input, merchantId) => ({
        actor: actor.walletAddress,
        storeId,
        merchantId,
        productId: 'product-managed-1',
        ...input,
      }),
      createConcessionPreview: async (actor, productId, input) => ({
        actor: actor.walletAddress,
        productId,
        previewId: HASH,
        ...input,
      }),
      submitReview: async (actor, productId, input) => ({ actor: actor.walletAddress, productId, state: 'REVIEW', ...input }),
      decideReview: async (actor, productId, input) => ({ actor: actor.walletAddress, productId, ...input }),
      delistProduct: async (actor, productId, input) => ({ actor: actor.walletAddress, productId, state: 'DELISTED', ...input }),
      adjustInventory: async (actor, skuId, input) => ({ actor: actor.walletAddress, skuId, ...input }),
      listAdminProducts: async (actor) => [{ actor: actor.walletAddress, productId: 'product-managed-1' }],
      batchAddProductTags: async (actor, input) => ({ actor: actor.walletAddress, ...input }),
      batchProductLifecycle: async (actor, input) => ({ actor: actor.walletAddress, ...input }),
    },
    adminGlobalOperationsService: {
      search: async (actor, input) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: actor.walletAddress,
        relation: input?.relation ?? 'AND',
        walletMatch: input?.walletMatch ?? 'EXACT',
        resources: [],
        truncated: false,
        unavailableFilters: ['PHONE', 'YELLOW_QUEUE'],
        query: input,
      }),
      exportSelection: async (actor, input) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: actor.walletAddress,
        exportId: HASH,
        ...input,
      }),
    },
    seckillService: {
      current: async () => ({ sessionId: SESSION_ID, phase: 'LIVE' }),
      get: async (sessionId) => ({ sessionId, phase: 'LIVE' }),
      history: async (input) => ({ items: [], nextCursor: input?.cursor ?? null }),
      events: async (sessionId, input) => input?.cursor === '1'
        ? { items: [], nextCursor: '1' }
        : {
            items: [{ sessionId, cursor: '1', eventType: 'SeckillRelayExtended' }],
            nextCursor: '1',
      },
    },
    seckillOperationsService: {
      list: async () => [],
      get: async (_actor, actionId) => ({ actionId, state: 'DRAFT' }),
      createSession: async (actor, input) => ({ actionId: HASH, actor: actor.walletAddress, ...input }),
      createForceClose: async (actor, sessionId, input) => ({ actionId: HASH, actor: actor.walletAddress, sessionId, ...input }),
      createResume: async (actor, input) => ({ actionId: HASH, actor: actor.walletAddress, ...input }),
      createPrizeInjection: async (actor, sessionId, input) => ({ actionId: HASH, actor: actor.walletAddress, sessionId, ...input }),
      reviewWinner: async (actor, sessionId, input) => ({ actor: actor.walletAddress, sessionId, ...input }),
      approvalChallenge: async (_actor, actionId, input) => ({ actionId, ...input, typedData: {} }),
      submitApproval: async (_actor, actionId, input) => ({ actionId, state: 'SECONDARY_SIGNED', ...input }),
      propose: async (_actor, actionId) => ({ actionId, state: 'PENDING_PROPOSAL' }),
      cancel: async (_actor, actionId) => ({ actionId, state: 'CANCELLED' }),
    },
    fulfillmentService: {
      getOrder: async (_actor, orderId) => ({ orderId, state: 'DELIVERED' }),
      listOrders: async () => [{ orderId: 'order-1', state: 'DELIVERED' }],
      listOrderPage: async (_actor, input) => ({
        orders: [{ orderId: 'order-1', state: 'DELIVERED', query: input }],
        nextCursor: null,
      }),
      searchAdminOrders: async (_actor, input) => ({
        orders: [{ orderId: 'order-1', state: 'DELIVERED', query: input }],
        nextCursor: null,
        pausedScopes: [],
      }),
      previewOrderBatchActions: async (_actor, orderIds) => ({
        rows: orderIds.map((orderId) => ({ orderId, allowedActions: [] })),
        enabledActionIntersection: [],
      }),
      recordShipment: async (_actor, orderId) => ({ orderId, state: 'SHIPPED' }),
      recordShipmentBatch: async (_actor, input) => ({ batchId: HASH, shipments: input.items }),
      recordDelivery: async (_actor, orderId) => ({ orderId, state: 'DELIVERED' }),
      recordLogisticsUpdate: async (actor, orderId, input) => {
        fulfillmentCalls.push({ operation: 'LOGISTICS_UPDATE', wallet: actor.walletAddress, orderId, input });
        return { orderId, state: input.status === 'DELIVERED' ? 'DELIVERED' : 'SHIPPED' };
      },
      registerPickupCredential: async (_actor, orderId) => ({ orderId, credentialId: 'pickup-1' }),
      verifyPickup: async (_actor, orderId) => ({ orderId, state: 'FULFILLED' }),
      requestExchange: async (actor, orderId, input) => {
        fulfillmentCalls.push({ operation: 'REQUEST_EXCHANGE', wallet: actor.walletAddress, orderId, input });
        return { orderId, requestType: 'EXCHANGE' };
      },
      requestDelay: async (_actor, orderId) => ({ orderId, requestType: 'DELAY' }),
      decideFulfillmentRequest: async (_actor, orderId, input) => ({
        orderId,
        requestId: input.requestId,
        state: input.approved ? 'APPROVED' : 'REJECTED',
      }),
      openArbitration: async (_actor, orderId) => ({ orderId, state: 'ARBITRATION' }),
      decideArbitration: async (_actor, orderId) => ({ orderId, state: 'FULFILLED' }),
      openTakeover: async (_actor, orderId) => ({ orderId, state: 'TAKEOVER' }),
      requestForcedReceipt: async (_actor, orderId) => ({ orderId, state: 'OPEN' }),
      decideForcedReceipt: async (_actor, orderId) => ({ orderId, state: 'FULFILLED' }),
      confirmReceipt: async (actor, orderId, input) => {
        fulfillmentCalls.push({ operation: 'CONFIRM_RECEIPT', wallet: actor.walletAddress, orderId, input });
        return { orderId, state: 'FULFILLED' };
      },
    },
    orderStatementService: {
      listBuyerShopping: async (actor, input) => {
        statementCalls.push({ operation: 'BUYER_SHOPPING', wallet: actor.walletAddress, input });
        return {
          artifactVersion: CORE_ARTIFACT_VERSION,
          buyerWallet: actor.walletAddress,
          statements: [{ orderId: ORDER_ID, orderKind: input?.kind ?? 'ORDINARY' }],
          nextCursor: null,
        };
      },
      listMerchantReceivables: async (actor, input) => {
        statementCalls.push({ operation: 'MERCHANT_RECEIVABLE', wallet: actor.walletAddress, input });
        return {
          artifactVersion: CORE_ARTIFACT_VERSION,
          merchantId: actor.merchantId,
          settlementWallet: actor.walletAddress,
          statements: [{ orderId: ORDER_ID, orderKind: input?.kind ?? 'ORDINARY' }],
          nextCursor: null,
        };
      },
    },
    fulfillmentTargetService: {
      createDeliveryTarget: async (actor) => ({
        targetId: 'target-1',
        targetHash: HASH,
        regionCodeHash: HASH_2,
        buyerWallet: actor.walletAddress,
      }),
      createPickupTarget: async (actor, input) => ({
        targetId: 'target-2',
        targetHash: HASH_2,
        storeId: input.storeId,
        buyerWallet: actor.walletAddress,
      }),
      createStore: async (actor) => ({ storeId: 'store-1', merchantId: actor.merchantId }),
      listStores: async () => [{ storeId: 'store-1', regionCode: '110101' }],
      listMerchantStores: async (actor) => [{ storeId: 'store-1', merchantId: actor.merchantId }],
      updateStore: async (actor, storeId, input) => ({ storeId, merchantId: actor.merchantId, ...input }),
      activateStore: async (actor, storeId, input) => ({ storeId, merchantId: actor.merchantId, ...input, status: 'ACTIVE' }),
      closeStore: async (actor, storeId, input) => ({ storeId, merchantId: actor.merchantId, ...input, status: 'CLOSED' }),
      exportMerchantOrders: async (actor, input) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        exportId: HASH,
        merchantId: actor.merchantId!,
        contentType: 'application/vnd.ms-excel; charset=utf-8' as const,
        filename: 'merchant-orders.xls',
        rowCount: 1,
        contentHash: HASH_2,
        contentBase64: 'PGV4Y2VsIC8+',
        nextCursor: null,
        filters: { limit: input.limit ?? 1_000 },
      }),
      getOrderTarget: async (actor, orderId) => ({ orderId, buyerWallet: actor.walletAddress }),
    },
    logisticsPrintingService: {
      createPrinterBindingChallenge: async (actor, storeId, input) => ({
        challengeId: HASH,
        actor: actor.walletAddress,
        storeId,
        ...input,
      }),
      applyPrinterBinding: async (actor, storeId, input) => ({
        bindingId: HASH,
        actor: actor.walletAddress,
        storeId,
        ...input,
      }),
      getPrinterBinding: async (_actor, storeId) => ({ bindingId: HASH, storeId }),
      createWaybillBatch: async (_actor, input) => ({ batchId: HASH, items: input.orderIds }),
      listPrintJobs: async () => [],
      retryPrintJob: async (_actor, printJobId) => ({ printJobId, state: 'QUEUED' }),
      createAdminWaybillBatch: async (_actor, input) => ({ batchId: HASH, merchantId: input.merchantId, items: input.orderIds }),
      listAdminWaybills: async (_actor, input) => ({ waybills: [{ requestId: HASH, merchantId: input?.merchantId ?? 'merchant-1' }] }),
      listAdminPrintJobs: async (_actor, input) => ({ printJobs: [{ printJobId: HASH, merchantId: input?.merchantId ?? 'merchant-1' }] }),
      retryAdminPrintJob: async (_actor, printJobId) => ({ printJobId, state: 'QUEUED', merchantId: 'merchant-1' }),
    },
    logisticsAdminService: {
      listCarrierConfig: async () => ({
        version: 1,
        defaultCarrierCode: 'SF',
        carriers: [{ carrierCode: 'SF', enabled: true }],
      }),
      createCarrierConfigVersion: async (_actor, input) => ({ version: 2, ...input }),
      listProviderConfigs: async () => ({ providers: [{ provider: 'KUAIDI100', readiness: 'READY' }] }),
      createProviderConfigVersion: async (_actor, input) => ({
        provider: input.provider,
        enabled: input.enabled,
        version: 1,
        configured: true,
        readiness: input.enabled ? 'READY' : 'DISABLED',
        configHash: HASH,
      }),
      listWarehouses: async () => ({ warehouses: [] }),
      createWarehouse: async (_actor, input) => ({ warehouseId: 'warehouse:test', version: 1, ...input }),
      updateWarehouse: async (_actor, warehouseId, input) => ({ warehouseId, version: input.expectedVersion + 1, ...input }),
      deactivateWarehouse: async (_actor, warehouseId, input) => ({ warehouseId, version: input.expectedVersion + 1, enabled: false }),
    },
    evidenceService: {
      createActionEvidence: async (actor, input) => {
        evidenceCalls.push({ operation: 'ACTION', wallet: actor.walletAddress, input });
        return { artifactVersion: CORE_ARTIFACT_VERSION, evidenceHash: HASH, ...input };
      },
      createTrackingEvidence: async (actor, input) => {
        evidenceCalls.push({ operation: 'TRACKING', wallet: actor.walletAddress, input });
        return { artifactVersion: CORE_ARTIFACT_VERSION, evidenceHash: HASH_2, ...input };
      },
      assertActionEvidence: async (actor, input) => {
        evidenceCalls.push({ operation: 'ASSERT_ACTION', wallet: actor.walletAddress, input });
        return input;
      },
      assertTrackingEvidence: async (actor, input) => {
        evidenceCalls.push({ operation: 'ASSERT_TRACKING', wallet: actor.walletAddress, input });
        return input;
      },
      createUploadIntent: async (actor, input) => {
        evidenceCalls.push({ operation: 'UPLOAD_INTENT', wallet: actor.walletAddress, input });
        return {
          artifactVersion: CORE_ARTIFACT_VERSION,
          uploadIntentId: HASH,
          ownerWallet: actor.walletAddress,
          purpose: input.purpose,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          contentType: input.contentType,
          sizeBytes: String(input.sizeBytes),
          contentSha256: input.contentSha256,
          method: 'PUT',
          uploadUrl: 'https://uploads.example.invalid/signed-object',
          headers: { 'if-none-match': '*' },
          writeOnce: true,
          state: 'UPLOADED',
        };
      },
      completeUpload: async (actor, uploadIntentId) => {
        evidenceCalls.push({ operation: 'UPLOAD_COMPLETE', wallet: actor.walletAddress, input: { uploadIntentId } });
        return { artifactVersion: CORE_ARTIFACT_VERSION, uploadIntentId, assetId: HASH_2 };
      },
      createReadAccess: async (actor, assetId) => {
        evidenceCalls.push({ operation: 'MEDIA_READ', wallet: actor?.walletAddress ?? 'PUBLIC', input: { assetId } });
        return {
          artifactVersion: CORE_ARTIFACT_VERSION,
          assetId,
          method: 'GET',
          readUrl: 'https://media.example.invalid/signed-object',
          expiresAt: new Date(now.getTime() + 300_000).toISOString(),
          accessScope: actor ? 'AUTHENTICATED' : 'PUBLIC',
        };
      },
    },
    settlementService: {
      createIntent: async (actor, input) => ({
        intentId: ORDER_ID,
        wallet: actor.walletAddress,
        ...input,
      }),
      createGovernedIntent: async (actor, input) => ({
        intentId: HASH,
        wallet: actor.walletAddress,
        ...input,
      }),
      submitRequest: async (actor, input) => ({
        requestId: HASH_2,
        wallet: actor.walletAddress,
        intentId: input.intentId,
        state: 'REQUESTED',
      }),
      list: async (actor) => ({ wallet: actor.walletAddress, balances: [], requests: [] }),
      listAdminRequests: async (actor, input) => ({
        actor: actor.walletAddress,
        requests: [{ requestId: HASH, state: input?.state ?? 'REQUESTED' }],
        nextCursor: null,
      }),
      getAdminRequest: async (actor, requestId) => ({
        actor: actor.walletAddress,
        request: { requestId, state: 'REQUESTED' },
        items: [],
        transitions: [],
      }),
      listAdminBatches: async (actor, input) => ({
        actor: actor.walletAddress,
        batches: [{ batchId: HASH_2, state: input?.state ?? 'APPROVAL_PENDING' }],
        nextCursor: null,
      }),
      getAdminBatch: async (actor, batchId) => ({
        actor: actor.walletAddress,
        batch: { batchId, state: 'APPROVAL_PENDING' },
        items: [],
        approvals: [],
        attempts: [],
      }),
    },
    takeoverFundingService: {
      fundingApprovalChallenge: async (_actor, input) => ({ ...input, digest: HASH }),
      fundTakeover: async (_actor, input) => ({ ...input, state: 'FUNDED' }),
      getMerchantFinance: async (actor, merchantId) => ({
        wallet: actor.walletAddress,
        merchantId: merchantId ?? actor.merchantId ?? 'merchant-1',
      }),
      getTakeoverFunding: async (_actor, caseId) => ({ caseId, state: 'FUNDED' }),
    },
    takeoverCaseService: {
      listAdmin: async (_actor, input) => ({ artifactVersion: CORE_ARTIFACT_VERSION, cases: [{ caseId: 'takeover-1', state: input?.state ?? 'OPEN' }], nextCursor: null }),
      getAdmin: async (_actor, caseId) => ({ artifactVersion: CORE_ARTIFACT_VERSION, case: { caseId } }),
      listCandidates: async (_actor, caseId) => ({ artifactVersion: CORE_ARTIFACT_VERSION, caseId, candidates: [{ merchantId: 'replacement-1' }] }),
      assign: async (_actor, caseId, input) => ({ artifactVersion: CORE_ARTIFACT_VERSION, assignment: { caseId, ...input } }),
      listMerchant: async (_actor, input) => ({ artifactVersion: CORE_ARTIFACT_VERSION, cases: [{ caseId: 'takeover-1', state: input?.state ?? 'FUNDED' }], nextCursor: null }),
      getMerchant: async (_actor, caseId) => ({ artifactVersion: CORE_ARTIFACT_VERSION, case: { caseId } }),
    },
    guaranteeDepositService: {
      submit: async (actor, input) => ({ merchantId: actor.merchantId, ...input, state: 'SUBMITTED' }),
    },
    policyService: {
      createDraft: async (actor, input) => ({ draftId: 'policy-draft-1', actor: actor.walletAddress, ...input }),
      updateDraft: async (_actor, draftId, input) => ({ draftId, ...input }),
      approvalChallenge: async (_actor, draftId, input) => ({ draftId, ...input, digest: HASH }),
      submitSecondarySignature: async (_actor, draftId, input) => ({ draftId, ...input, state: 'SECONDARY_SIGNED' }),
      proposeToSafe: async (_actor, draftId) => ({ draftId, state: 'SAFE_PROPOSED' }),
      getDraft: async (_actor, draftId) => ({ draftId, state: 'DRAFT' }),
      listDrafts: async () => [],
    },
    coverageBreakerService: {
      resumeChallenge: async (actor, input) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: actor.walletAddress,
        signer: SAFE,
        ...input,
      }),
      submitResume: async (actor, input) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: actor.walletAddress,
        actionId: HASH,
        state: 'PENDING_PROPOSAL',
        ...input,
      }),
      listActions: async (actor) => [{ actor: actor.walletAddress, actionId: HASH, state: 'FINAL' }],
    },
    cmsService: {
      createVersion: async (_actor, input) => ({ versionId: 'cms-version-1', ...input }),
      publish: async (_actor, versionId) => ({ versionId, published: true }),
      rollback: async (_actor, versionId) => ({ versionId, publicationType: 'ROLLED_BACK' }),
      getVersion: async (_actor, versionId) => ({ versionId }),
      listPublished: async (context) => {
        cmsPublishedContexts.push(context);
        return [];
      },
    },
    notificationService: {
      registerEndpoint: async (actor, input) => {
        notificationEndpointCorrelationId = input.correlationId;
        return { wallet: actor.walletAddress, ...input };
      },
      createCampaign: async (_actor, input) => ({ campaignId: 'campaign-1', ...input }),
      publishCampaign: async (_actor, campaignId) => ({ campaignId, state: 'PUBLISHED' }),
      listCampaigns: async () => [{ campaignId: 'campaign-1', state: 'PUBLISHED' }],
      retryCampaignDeliveries: async (_actor, campaignId) => ({ campaignId, state: 'RETRY_SCHEDULED', retriedDeliveries: 1 }),
      listInbox: async (actor) => ({ wallet: actor.walletAddress, messages: [] }),
    },
    systemConfigService: {
      createVersion: async (_actor, input) => ({ configVersionId: 'config-1', ...input }),
      approvalChallenge: async (_actor, configVersionId, input) => ({ configVersionId, ...input, signer: SAFE }),
      publish: async (_actor, configVersionId) => ({ configVersionId, published: true }),
      list: async () => [],
    },
    auditService: {
      list: async (_actor, query) => ({ entries: [], query }),
      listMerchant: async (actor, query) => ({ merchantId: actor.merchantId, entries: [], query }),
      exportMerchant: async (actor, query) => ({
        merchantId: actor.merchantId,
        query,
        contentType: 'text/csv; charset=utf-8',
        filename: 'merchant-audit.csv',
        entryCount: 0,
        csv: 'operationTime\n',
      }),
    },
    monitoringService: {
      dashboard: async () => ({ metrics: [], alerts: [] }),
      acknowledge: async (_actor, alertKey, correlationId) => {
        monitoringCorrelationId = correlationId;
        return { alertKey, state: 'ACKNOWLEDGED' };
      },
    },
    businessAnalyticsService: {
      merchantDashboard: async (actor) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        merchantId: actor.merchantId,
        timezone: 'Asia/Shanghai',
      }),
      adminDashboard: async (actor) => ({
        artifactVersion: CORE_ARTIFACT_VERSION,
        actor: actor.walletAddress,
        timezone: 'Asia/Shanghai',
      }),
    },
    accountService: {
      ensureBuyerUid: async (walletAddress) => { ensuredBuyerUidWallet = walletAddress; return '1'; },
      getBuyerProfile: async (actor) => ({ wallet: actor.walletAddress, version: 0 }),
      updateBuyerProfile: async (actor, input) => ({ wallet: actor.walletAddress, ...input, version: 1 }),
      parseBuyerAddress: async (_actor, rawText) => ({ rawTextLength: rawText.length, canSave: true }),
      listBuyerAddresses: async (actor) => ({ wallet: actor.walletAddress, addresses: [] }),
      createBuyerAddress: async (actor, input) => ({ wallet: actor.walletAddress, addressId: 'address-1', ...input }),
      updateBuyerAddress: async (actor, addressId, input) => ({ wallet: actor.walletAddress, addressId, ...input }),
      deleteBuyerAddress: async (_actor, addressId) => ({ addressId, status: 'DELETED' }),
      setDefaultBuyerAddress: async (_actor, addressId, input) => ({ addressId, ...input, isDefault: true }),
      createBuyerAddressTarget: async (_actor, addressId, idempotencyKey) => ({ addressId, idempotencyKey, targetId: 'target-1' }),
      getBuyerOverview: async (actor) => ({ wallet: actor.walletAddress, orderCounts: {} }),
      getBuyerTakeoverTimeline: async (_actor, orderId) => ({ orderId, transitions: [] }),
      getMerchantProfile: async (actor) => ({ merchantId: actor.merchantId, settlementWalletMutable: false }),
      updateMerchantProfile: async (actor, input) => ({ merchantId: actor.merchantId, ...input }),
      recordMerchantAuditExport: async () => ({ recorded: true }),
      recordMerchantOrderExport: async () => ({ recorded: true }),
    },
    riskService: {
      ingestObservation: async (input) => ({ observation: input, restrictions: [] }),
      listOverview: async () => ({ observations: [], restrictions: [], appeals: [] }),
      createManualRestriction: async (_actor, input) => ({ restrictionId: HASH, ...input }),
      overrideRestriction: async (_actor, restrictionId, input) => ({ restrictionId, state: 'OVERRIDDEN', ...input }),
      submitAppeal: async (_actor, input) => ({ appealId: HASH_2, state: 'PENDING', ...input }),
      decideAppeal: async (_actor, appealId, input) => ({ appealId, state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' }),
    },
    merchantLifecycleService: {
      list: async (_actor, query) => ({ merchants: [], query }),
      get: async (_actor, merchantId) => ({ merchant: { merchantId } }),
      createApplication: async (_actor, input) => ({ merchant: { merchantId: 'merchant-created' }, input }),
      updateApplication: async (_actor, merchantId, input) => ({ merchant: { merchantId }, input }),
      createReviewChallenge: async (_actor, merchantId, input) => ({ merchantId, actionId: HASH, input }),
      publishReview: async (_actor, merchantId, actionId) => ({ merchant: { merchantId }, actionId }),
    },
    riskSignalToken: 'risk-signal-token',
    logisticsWebhookSecrets: {
      KUAIDI100: 'kuaidi-webhook-secret',
      CAINIAO: 'cainiao-webhook-secret',
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
    assert.equal((await fetch(`${base}/v2/catalog/categories`)).status, 200);
    assert.equal((await fetch(`${base}/v2/catalog/tags`)).status, 200);
    const seckillCurrent = await fetch(`${base}/v2/seckill/sessions/current`);
    assert.equal(seckillCurrent.status, 200);
    assert.equal(((await seckillCurrent.json()) as { sessionId: string }).sessionId, SESSION_ID);
    const seckillEvents = await fetch(`${base}/v2/seckill/sessions/${SESSION_ID}/events?cursor=0&limit=20`);
    assert.equal(seckillEvents.status, 200);
    assert.equal(((await seckillEvents.json()) as { items: unknown[] }).items.length, 1);
    assert.equal((await fetch(`${base}/v2/seckill/sessions/${SESSION_ID}`)).status, 200);
    assert.equal((await fetch(`${base}/v2/seckill/sessions/history?limit=20`)).status, 200);
    const realtimeEvent = await new Promise<{ sessionId: string; cursor: string; eventType: string }>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}/v2/ws?artifactVersion=${CORE_ARTIFACT_VERSION}&channel=seckill:${SESSION_ID}&cursor=0`,
      );
      client.once('error', reject);
      client.once('message', (data) => {
        resolve(JSON.parse(data.toString()) as { sessionId: string; cursor: string; eventType: string });
        client.close();
      });
    });
    assert.deepEqual(realtimeEvent, {
      sessionId: SESSION_ID,
      cursor: '1',
      eventType: 'SeckillRelayExtended',
    });
    const mismatchClose = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}/v2/ws?artifactVersion=stale&channel=seckill:${SESSION_ID}`,
      );
      client.once('error', reject);
      client.once('close', (code) => resolve(code));
    });
    assert.equal(mismatchClose, 4409);

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
    assert.equal(ensuredBuyerUidWallet, wallet.address.toLowerCase());
    const session = (await login.json()) as { token: string; merchantId?: string };
    assert.equal(session.merchantId, 'merchant-1');
    const bearerHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${session.token}`,
    };
    const buyerOnlyToken = issueSessionToken(
      { walletAddress: wallet.address, roles: ['BUYER'] },
      config.jwtSecret!,
      now,
    );
    const auditorOnlyToken = issueSessionToken(
      { walletAddress: wallet.address, roles: ['AUDITOR'] },
      config.jwtSecret!,
      now,
    );
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/product-slot`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/catalog/categories`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/merchant/dashboard`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/dashboard`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const merchantDashboard = await fetch(`${base}/v2/merchant/dashboard`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(merchantDashboard.status, 200);
    assert.equal(((await merchantDashboard.json()) as { merchantId: string }).merchantId, 'merchant-1');
    const buyerStatements = await fetch(
      `${base}/v2/buyer/shopping-statements?kind=ORDINARY&limit=20`,
      { headers: { authorization: `Bearer ${buyerOnlyToken}` } },
    );
    assert.equal(buyerStatements.status, 200);
    assert.equal(((await buyerStatements.json()) as { statements: Array<{ orderKind: string }> }).statements[0]?.orderKind, 'ORDINARY');
    assert.equal((await fetch(`${base}/v2/buyer/shopping-statements?kind=UNKNOWN`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/buyer/shopping-statements?unsupported=true`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/merchant/receivable-statements`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const merchantStatements = await fetch(
      `${base}/v2/merchant/receivable-statements?kind=SECKILL&limit=10`,
      { headers: { authorization: `Bearer ${session.token}` } },
    );
    assert.equal(merchantStatements.status, 200);
    assert.equal(((await merchantStatements.json()) as { statements: Array<{ orderKind: string }> }).statements[0]?.orderKind, 'SECKILL');
    assert.deepEqual(statementCalls.map((call) => call.operation), ['BUYER_SHOPPING', 'MERCHANT_RECEIVABLE']);
    const adminDashboard = await fetch(`${base}/v2/admin/dashboard`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(adminDashboard.status, 200);
    assert.equal(((await adminDashboard.json()) as { timezone: string }).timezone, 'Asia/Shanghai');
    assert.equal((await fetch(`${base}/v2/admin/payments/${ORDER_ID}`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/settlement-requests`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const adminPayment = await fetch(`${base}/v2/admin/payments/${ORDER_ID}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(adminPayment.status, 200);
    assert.equal(((await adminPayment.json()) as { orderId: string }).orderId, ORDER_ID);
    const adminRequests = await fetch(`${base}/v2/admin/settlement-requests?state=BATCHED&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(adminRequests.status, 200);
    assert.equal(((await adminRequests.json()) as { requests: Array<{ state: string }> }).requests[0]?.state, 'BATCHED');
    assert.equal((await fetch(`${base}/v2/admin/settlement-requests?state=UNKNOWN`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/settlement-requests/${HASH}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const adminBatches = await fetch(`${base}/v2/admin/settlement-batches?state=APPROVAL_PENDING&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(adminBatches.status, 200);
    assert.equal(((await adminBatches.json()) as { batches: Array<{ state: string }> }).batches[0]?.state, 'APPROVAL_PENDING');
    assert.equal((await fetch(`${base}/v2/admin/settlement-batches/${HASH_2}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/settlement-batches?limit=101`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/takeover-cases`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const takeoverCases = await fetch(`${base}/v2/admin/takeover-cases?state=FUNDED&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(takeoverCases.status, 200);
    assert.equal(((await takeoverCases.json()) as { cases: Array<{ state: string }> }).cases[0]?.state, 'FUNDED');
    assert.equal((await fetch(`${base}/v2/admin/takeover-cases?state=UNKNOWN`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/takeover-cases/takeover-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/takeover-cases/takeover-1/candidates`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const takeoverAssignment = await fetch(`${base}/v2/admin/takeover-cases/takeover-1/assignments`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        replacementMerchantId: 'replacement-1',
        reasonCode: 'WAREHOUSE_MATCH',
        evidenceHash: HASH,
        idempotencyKey: 'takeover-assignment-http-1',
      }),
    });
    assert.equal(takeoverAssignment.status, 201);
    assert.equal(((await takeoverAssignment.json()) as { assignment: { replacementMerchantId: string } }).assignment.replacementMerchantId, 'replacement-1');
    assert.equal((await fetch(`${base}/v2/admin/takeover-cases/takeover-1/assignments`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        replacementMerchantId: 'replacement-1', reasonCode: 'WAREHOUSE_MATCH',
        evidenceHash: HASH, idempotencyKey: 'takeover-assignment-extra', ignored: true,
      }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/merchant/takeover-cases`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/merchant/takeover-cases?state=FUNDED`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/takeover-cases/takeover-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/merchants`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/merchants?status=PENDING&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/merchants?status=PENDING&status=APPROVED`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/merchants?unsupported=true`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 400);
    const merchantApplication = await fetch(`${base}/v2/admin/merchants`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        shopName: 'HTTP Merchant',
        legalName: 'Legal Name',
        legalId: '210211199001011234',
        contactPhone: '13800138000',
        settlementWallet: SAFE,
        level: 'V1',
        idempotencyKey: 'merchant-http-create-1',
      }),
    });
    assert.equal(merchantApplication.status, 201);
    assert.equal(((await merchantApplication.json()) as { merchant: { merchantId: string } }).merchant.merchantId, 'merchant-created');
    assert.equal((await fetch(`${base}/v2/admin/merchants`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        shopName: 'HTTP Merchant', legalName: 'Legal Name', legalId: '210211199001011234',
        contactPhone: '13800138000', settlementWallet: SAFE, level: 'V1',
        idempotencyKey: 'merchant-http-extra-field', ignored: true,
      }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/merchants/merchant-created`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/merchants/merchant-created/application`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        shopName: 'HTTP Merchant', legalName: 'Legal Name', legalId: '210211199001011234',
        contactPhone: '13800138000', level: 'V1', licenseAssetId: HASH,
        expectedVersion: 1, idempotencyKey: 'merchant-http-update-1',
      }),
    })).status, 200);
    const merchantReview = await fetch(`${base}/v2/admin/merchants/merchant-created/review-challenges`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        action: 'APPROVE', reasonCode: 'QUALIFICATION_VERIFIED', idempotencyKey: 'merchant-http-review-1',
      }),
    });
    assert.equal(merchantReview.status, 201);
    assert.equal(((await merchantReview.json()) as { actionId: string }).actionId, HASH);
    const merchantWalletChange = await fetch(`${base}/v2/admin/merchants/merchant-created/review-challenges`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        action: 'CHANGE_SETTLEMENT_WALLET', reasonCode: 'WALLET_ROTATION',
        proposedSettlementWallet: '0x1212121212121212121212121212121212121212',
        idempotencyKey: 'merchant-http-wallet-change-1',
      }),
    });
    assert.equal(merchantWalletChange.status, 400);
    assert.equal((await fetch(`${base}/v2/admin/merchants/merchant-created/review-actions/${HASH}/publish`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ signature: '0x1234' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/seckill/actions`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/seckill/actions`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const seckillDraft = await fetch(`${base}/v2/admin/seckill/sessions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        policyVersion: '1',
        rulesContentHash: HASH,
        productId: 'product-1',
        skuId: 'sku-1',
        inventory: 4,
        seckillListPriceUsdt: '80',
        startsAt: '2026-07-15T01:00:00.000Z',
        idempotencyKey: 'seckill-http-session-1',
      }),
    });
    assert.equal(seckillDraft.status, 201);
    assert.equal(((await seckillDraft.json()) as { actionId: string }).actionId, HASH);
    assert.equal((await fetch(`${base}/v2/admin/seckill/actions/${HASH}/approval-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1783990200' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/seckill/actions/${HASH}/secondary-signature`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1783990200', signature: '0x1234' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/seckill/actions/${HASH}/safe-proposal`, {
      method: 'POST',
      headers: bearerHeaders,
      body: '{}',
    })).status, 202);
    assert.equal((await fetch(`${base}/v2/admin/seckill/sessions/${SESSION_ID}/force-close`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ reasonCode: 'OPERATIONS_STOP', idempotencyKey: 'seckill-http-close-1' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/seckill/sessions/${SESSION_ID}/prize-injections`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ amountUsdt: '50', idempotencyKey: 'seckill-http-prize-1' }),
    })).status, 201);
    const winnerReview = await fetch(`${base}/v2/admin/seckill/sessions/${SESSION_ID}/winner-review`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        decision: 'APPROVE',
        reasonCode: 'ORDER_VALID',
        evidenceHash: HASH_2,
        idempotencyKey: 'seckill-http-winner-review-1',
      }),
    });
    assert.equal(winnerReview.status, 200);
    const reviewedWinner = await winnerReview.json() as Record<string, unknown>;
    assert.equal(reviewedWinner.actor, wallet.address.toLowerCase());
    assert.equal(reviewedWinner.sessionId, SESSION_ID);
    assert.equal(reviewedWinner.decision, 'APPROVE');
    assert.equal(reviewedWinner.evidenceHash, HASH_2);
    assert.equal((await fetch(`${base}/v2/admin/seckill/breaker/resume`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ sessionId: SESSION_ID, idempotencyKey: 'seckill-http-resume-1' }),
    })).status, 201);
    const riskObservationBody = {
      observationId: HASH,
      signalType: 'HIGH_GAS',
      sourceType: 'CHAIN_MONITOR',
      walletAddress: wallet.address,
      txHash: HASH_2,
      gasPriceWei: '101',
      evidenceHash: HASH,
      observedAt: now.toISOString(),
    };
    assert.equal((await fetch(`${base}/v2/internal/risk/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(riskObservationBody),
    })).status, 401);
    assert.equal((await fetch(`${base}/v2/internal/risk/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer risk-signal-token' },
      body: JSON.stringify(riskObservationBody),
    })).status, 202);
    assert.equal((await fetch(`${base}/v2/admin/risk/overview`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/risk/overview`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/risk/restrictions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        subjectType: 'WALLET',
        subjectValue: wallet.address,
        restrictionKind: 'BLACKLIST',
        reasonCode: 'MANUAL_REVIEW',
        evidenceHash: HASH,
        idempotencyKey: 'risk-http-manual-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/risk/restrictions/${HASH}/override`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ reasonCode: 'REVIEW_CLEARED', evidenceHash: HASH_2 }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/risk/appeals`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        restrictionId: HASH,
        statementHash: HASH,
        evidenceHash: HASH_2,
        idempotencyKey: 'risk-http-appeal-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/risk/appeals/${HASH_2}/decision`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ decision: 'APPROVE', reasonCode: 'APPEAL_ACCEPTED', evidenceHash: HASH }),
    })).status, 200);

    const buyerHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${buyerOnlyToken}`,
    };
    assert.equal((await fetch(`${base}/v2/buyer/profile`, { headers: buyerHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/profile`, {
      method: 'PUT',
      headers: buyerHeaders,
      body: JSON.stringify({
        nickname: 'Buyer',
        avatarAssetId: null,
        expectedVersion: 0,
        idempotencyKey: 'buyer-profile-http-1',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/addresses/parse`, {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ rawText: 'Zhang San 13800138000 Dalian Software Park' }),
    })).status, 200);
    const addressBody = {
      label: 'Home',
      recipientName: 'Zhang San',
      phone: '13800138000',
      detailAddress: 'Dalian Software Park Building 1',
      longitude: 121.6,
      latitude: 38.9,
      isDefault: true,
      idempotencyKey: 'buyer-address-http-1',
    };
    assert.equal((await fetch(`${base}/v2/buyer/addresses`, {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify(addressBody),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/buyer/addresses`, { headers: buyerHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/addresses/address-1`, {
      method: 'PUT',
      headers: buyerHeaders,
      body: JSON.stringify({ ...addressBody, expectedVersion: 1, idempotencyKey: 'buyer-address-http-update-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/addresses/address-1/default`, {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'buyer-address-http-default-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/addresses/address-1/fulfillment-target`, {
      method: 'POST',
      headers: buyerHeaders,
      body: JSON.stringify({ idempotencyKey: 'buyer-address-http-target-1' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/buyer/overview`, { headers: buyerHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v2/orders/order-1/takeover-timeline`, { headers: buyerHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v2/buyer/addresses/address-1`, {
      method: 'DELETE',
      headers: buyerHeaders,
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: 'buyer-address-http-delete-1' }),
    })).status, 200);

    assert.equal((await fetch(`${base}/v2/merchant/profile`, { headers: bearerHeaders })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/profile`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        shopName: 'Merchant',
        logoAssetId: null,
        settlementWallet: SAFE,
        expectedVersion: 1,
        idempotencyKey: 'merchant-profile-wallet-injection',
      }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/merchant/profile`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        shopName: 'Merchant',
        logoAssetId: null,
        expectedVersion: 1,
        idempotencyKey: 'merchant-profile-http-1',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/audit/entries`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/merchant/audit/entries?limit=20`, {
      headers: bearerHeaders,
    })).status, 200);
    const auditExport = await fetch(`${base}/v2/merchant/audit/exports`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        from: '2026-07-14T00:00:00.000Z',
        to: '2026-07-15T00:00:00.000Z',
        idempotencyKey: 'merchant-audit-export-http-1',
      }),
    });
    assert.equal(auditExport.status, 200);
    assert.equal(((await auditExport.json()) as { merchantId: string }).merchantId, 'merchant-1');
    assert.equal((await fetch(`${base}/v2/merchant/orders/exports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${buyerOnlyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'merchant-order-export-buyer-denied' }),
    })).status, 403);
    const orderExport = await fetch(`${base}/v2/merchant/orders/exports`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        from: '2026-07-14T00:00:00.000Z',
        to: '2026-07-15T00:00:00.000Z',
        fulfillmentMode: 'DELIVERY',
        orderKind: 'ORDINARY',
        limit: 100,
        idempotencyKey: 'merchant-order-export-http-1',
      }),
    });
    assert.equal(orderExport.status, 200);
    assert.deepEqual(await orderExport.json(), {
      artifactVersion: CORE_ARTIFACT_VERSION,
      exportId: HASH,
      merchantId: 'merchant-1',
      contentType: 'application/vnd.ms-excel; charset=utf-8',
      filename: 'merchant-orders.xls',
      rowCount: 1,
      contentHash: HASH_2,
      contentBase64: 'PGV4Y2VsIC8+',
      nextCursor: null,
      filters: { limit: 100 },
    });

    const productSlotBody = {
      idempotencyKey: 'http-product-slot-save-1',
      title: '24K Product',
      subtitle: 'Catalog draft',
      mainImageAssetIds: [],
      richDetail: { blocks: [] },
      defaultFreightUsdt: '0',
      merchantConcessionBps: 2500,
      fulfillmentModes: ['DELIVERY', 'PICKUP'],
      categoryId: 'category-1',
      tagIds: ['tag-1'],
      skus: [{
        attributes: { size: 'standard' },
        listPriceUsdt: '100',
        merchantBaseReceivableUsdt: '60',
        stockTotal: 10,
        proposedSeckillInventory: 3,
      }],
    };
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/product-slot`, {
      headers: bearerHeaders,
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/product-slot`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify(productSlotBody),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/products/product-managed-1/concession-previews`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ merchantConcessionBps: 2500, idempotencyKey: 'http-preview-1' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/merchant/products/product-managed-1/concession-previews`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ merchantConcessionBps: 10001, idempotencyKey: 'http-preview-invalid-1' }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/catalog/categories`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ name: 'Gold', sortOrder: 1, idempotencyKey: 'http-category-create-1' }),
    })).status, 201);
    const rootCategory = await fetch(`${base}/v2/admin/catalog/categories/category-1`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        parentCategoryId: null,
        name: 'Gold',
        sortOrder: 1,
        idempotencyKey: 'http-category-move-root-1',
      }),
    });
    assert.equal(rootCategory.status, 200);
    assert.equal(((await rootCategory.json()) as { parentCategoryId: string | null }).parentCategoryId, null);
    assert.equal((await fetch(`${base}/v2/admin/catalog/categories/category-1`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        parentCategoryId: 7,
        name: 'Gold',
        sortOrder: 1,
        idempotencyKey: 'http-category-invalid-parent-1',
      }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/catalog/products/product-managed-1/review-decisions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ decision: 'APPROVE', reasonCode: 'APPROVED', idempotencyKey: 'http-review-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/catalog/skus/sku-1/inventory-adjustments`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ delta: '2', reasonCode: 'RESTOCK', idempotencyKey: 'http-stock-1' }),
    })).status, 201);
    const orderPage = await fetch(
      `${base}/v2/orders?limit=25&state=PAID&fulfillmentMode=DELIVERY&orderKind=ORDINARY&skuId=sku-1`,
      { headers: bearerHeaders },
    );
    assert.equal(orderPage.status, 200);
    assert.deepEqual(
      ((await orderPage.json()) as { orders: Array<{ query: Record<string, unknown> }> }).orders[0]?.query,
      { limit: 25, state: 'PAID', fulfillmentMode: 'DELIVERY', orderKind: 'ORDINARY', skuId: 'sku-1' },
    );
    assert.equal((await fetch(`${base}/v2/orders?state=NOT_A_STATE`, {
      headers: bearerHeaders,
    })).status, 400);
    const adminOrders = await fetch(
      `${base}/v2/admin/orders?orderId=order-1&productId=product-1&txHash=${HASH}&wallet=${SAFE}`
        + '&pendingReview=true&breakerScope=NEW_PAYMENT',
      { headers: bearerHeaders },
    );
    assert.equal(adminOrders.status, 200);
    assert.deepEqual(
      ((await adminOrders.json()) as { orders: Array<{ query: Record<string, unknown> }> }).orders[0]?.query,
      {
        orderId: 'order-1',
        productId: 'product-1',
        txHash: HASH,
        wallet: SAFE,
        pendingProductReview: true,
        breakerScope: 'NEW_PAYMENT',
      },
    );
    assert.equal((await fetch(`${base}/v2/admin/orders`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const globalResources = await fetch(
      `${base}/v2/admin/global/resources?resourceType=ORDER&resourceType=PRODUCT`
        + `&relation=OR&productId=product-1&wallet=${SAFE}&walletMatch=FUZZY`
        + '&pendingReview=false&limit=20',
      { headers: bearerHeaders },
    );
    assert.equal(globalResources.status, 200);
    assert.deepEqual(
      (await globalResources.json() as { query: Record<string, unknown> }).query,
      {
        resourceTypes: ['ORDER', 'PRODUCT'],
        relation: 'OR',
        productId: 'product-1',
        wallet: SAFE,
        walletMatch: 'FUZZY',
        pendingReview: false,
        limit: 20,
      },
    );
    const globalUidResources = await fetch(`${base}/v2/admin/global/resources?uid=42`, {
      headers: bearerHeaders,
    });
    assert.equal(globalUidResources.status, 200);
    assert.equal(
      (await globalUidResources.json() as { query: Record<string, unknown> }).query.uid,
      '42',
    );
    assert.equal((await fetch(`${base}/v2/admin/global/resources?resourceType=UNKNOWN`, {
      headers: bearerHeaders,
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/global/resources?relation=XOR`, {
      headers: bearerHeaders,
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/global/resources?walletMatch=PREFIX`, {
      headers: bearerHeaders,
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/global/resources`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    const globalExport = await fetch(`${base}/v2/admin/global/exports`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        selection: [{ resourceType: 'ORDER', resourceId: 'order-1' }],
        format: 'CSV',
        idempotencyKey: 'http-admin-global-export-1',
      }),
    });
    assert.equal(globalExport.status, 201);
    assert.equal((await globalExport.json() as { format: string }).format, 'CSV');
    assert.equal((await fetch(`${base}/v2/admin/catalog/products/batch-tags`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        productIds: ['product-managed-1'],
        tagIds: ['tag-1'],
        idempotencyKey: 'http-product-batch-tags-1',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/catalog/products/batch-tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerOnlyToken}` },
      body: JSON.stringify({
        productIds: ['product-managed-1'],
        tagIds: ['tag-1'],
        idempotencyKey: 'http-product-batch-tags-denied',
      }),
    })).status, 403);
    const lifecycleBatch = await fetch(`${base}/v2/admin/catalog/products/batch-lifecycle`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        action: 'HIDE',
        productIds: ['product-managed-1'],
        reasonCode: 'OPERATIONS_HIDE',
        idempotencyKey: 'http-product-batch-lifecycle-1',
      }),
    });
    assert.equal(lifecycleBatch.status, 200);
    assert.equal((await lifecycleBatch.json() as { action: string }).action, 'HIDE');
    assert.equal((await fetch(`${base}/v2/admin/catalog/products/batch-lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerOnlyToken}` },
      body: JSON.stringify({
        action: 'DELIST',
        productIds: ['product-managed-1'],
        reasonCode: 'OPERATIONS_DELIST',
        idempotencyKey: 'http-product-batch-lifecycle-denied',
      }),
    })).status, 403);
    const actionPreview = await fetch(`${base}/v2/admin/orders/batch-actions/preview`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ orderIds: ['order-1'] }),
    });
    assert.equal(actionPreview.status, 200);
    assert.deepEqual(
      ((await actionPreview.json()) as { rows: Array<{ orderId: string }> }).rows.map((row) => row.orderId),
      ['order-1'],
    );
    const shipmentBatch = await fetch(`${base}/v2/shipments/batches`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        idempotencyKey: 'http-shipment-batch-1',
        items: [{
          orderId: 'order-1',
          idempotencyKey: 'http-shipment-item-1',
          evidenceHash: HASH,
          carrierCode: 'SF',
          trackingNumberHash: HASH_2,
        }],
      }),
    });
    assert.equal(shipmentBatch.status, 201);
    assert.equal(((await shipmentBatch.json()) as { shipments: unknown[] }).shipments.length, 1);
    const postOrderAction = (action: string, body: Record<string, unknown>) => fetch(
      `${base}/v2/orders/order-1/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify(body),
      },
    );

    assert.equal((await fetch(`${base}/v2/media/upload-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).status, 401);
    assert.equal((await fetch(`${base}/v2/media/upload-intents`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        purpose: 'FULFILLMENT_EVIDENCE',
        resourceType: 'ORDER',
        resourceId: 'order-1',
        contentType: 'image/webp',
        sizeBytes: 512,
        contentSha256: HASH,
        idempotencyKey: 'http-media-upload-1',
      }),
    })).status, 201);
    for (const upload of [
      { purpose: 'BUYER_AVATAR', resourceType: 'BUYER', resourceId: wallet.address.toLowerCase(), idempotencyKey: 'buyer-avatar-http-1' },
      { purpose: 'MERCHANT_LOGO', resourceType: 'MERCHANT', resourceId: 'merchant-1', idempotencyKey: 'merchant-logo-http-1' },
    ]) {
      assert.equal((await fetch(`${base}/v2/media/upload-intents`, {
        method: 'POST',
        headers: bearerHeaders,
        body: JSON.stringify({
          ...upload,
          contentType: 'image/webp',
          sizeBytes: 512,
          contentSha256: HASH,
        }),
      })).status, 201);
    }
    assert.equal((await fetch(`${base}/v2/media/upload-intents/${HASH}/complete`, {
      method: 'POST',
      headers: bearerHeaders,
      body: '{}',
    })).status, 200);
    const publicMedia = await fetch(`${base}/v2/media/assets/${HASH_2}/access`);
    assert.equal(publicMedia.status, 200);
    assert.equal(((await publicMedia.json()) as { accessScope: string }).accessScope, 'PUBLIC');
    assert.equal((await postOrderAction('evidence', {
      action: 'REQUEST_EXCHANGE',
      reasonCode: 'DAMAGED_PACKAGE',
      mediaAssetIds: [HASH_2],
      idempotencyKey: 'http-action-evidence-1',
    })).status, 201);
    assert.equal((await postOrderAction('tracking-evidence', {
      carrierCode: 'SF',
      trackingNumber: 'SF123456',
      idempotencyKey: 'http-tracking-evidence-1',
    })).status, 201);
    assert.deepEqual(evidenceCalls.map((call) => call.operation), [
      'UPLOAD_INTENT',
      'UPLOAD_INTENT',
      'UPLOAD_INTENT',
      'UPLOAD_COMPLETE',
      'MEDIA_READ',
      'ACTION',
      'TRACKING',
    ]);

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
    assert.deepEqual(confirmReceipt, { action: 'CONFIRM_RECEIPT', enabled: true });

    const settlementIntent = await fetch(`${base}/v2/settlement-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        rail: 'PRIZE_USDT',
        amount: '10',
        idempotencyKey: 'settlement-intent-http-1',
      }),
    });
    assert.equal(settlementIntent.status, 201);
    const governedSettlementIntent = await fetch(`${base}/v2/admin/settlement-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        rail: 'TAKEOVER_USDT',
        resourceId: 'takeover:1',
        orderId: ORDER_ID,
        accountId: 'takeover:takeover:1:usdt',
        recipient: SAFE,
        fulfillmentTargetHash: HASH,
        amount: '10',
        idempotencyKey: 'governed-settlement-intent-http-1',
        approval: {
          action: 'CREATE_TAKEOVER_PAYOUT',
          resourceType: 'TAKEOVER_CASE',
          resourceId: 'takeover:1',
          policyVersion: '1',
          oldValueHash: HASH,
          newValueHash: HASH_2,
          safeAddress: SAFE,
          nonce: '1',
          deadline: '1800000000',
          signature: '0x1234',
        },
      }),
    });
    assert.equal(governedSettlementIntent.status, 201);
    const settlementRequest = await fetch(`${base}/v2/settlement-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ intentId: ORDER_ID, signature: '0x1234' }),
    });
    assert.equal(settlementRequest.status, 201);
    assert.equal((await fetch(`${base}/v2/settlements`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);

    assert.equal((await fetch(`${base}/v2/finance/merchant`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/finance/merchant/guarantee-deposits`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        policyVersion: '1',
        expectedAmountUsdt: '1000000000000000000000',
        transactionHash: HASH,
        idempotencyKey: 'guarantee-deposit-http-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/takeover-funding/approval-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        caseId: 'takeover-1',
        requiredUsdt: '10',
        nonce: '1',
        deadline: '1800000000',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/takeover-funding`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        caseId: 'takeover-1',
        requiredUsdt: '10',
        idempotencyKey: 'takeover-funding-http-1',
        approval: {
          action: 'FUND_TAKEOVER',
          resourceType: 'TAKEOVER_CASE',
          resourceId: 'takeover-1',
          policyVersion: '1',
          oldValueHash: HASH,
          newValueHash: HASH_2,
          safeAddress: SAFE,
          nonce: '1',
          deadline: '1800000000',
          signature: '0x1234',
        },
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/takeover-funding/takeover-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);

    assert.equal((await fetch(`${base}/v2/cms/public`)).status, 200);
    assert.equal((await fetch(`${base}/v2/cms/public?walletAddress=${wallet.address}`)).status, 400);
    assert.equal((await fetch(`${base}/v2/cms/public`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((cmsPublishedContexts[0] as { actor?: unknown }).actor, undefined);
    assert.deepEqual((cmsPublishedContexts[1] as { actor: { walletAddress: string; merchantId: string } }).actor, {
      walletAddress: wallet.address.toLowerCase(),
      roles: ['BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR', 'ARBITRATOR', 'AUDITOR'],
      merchantId: 'merchant-1',
    });
    const notificationEndpointResponse = await fetch(`${base}/v2/notification-endpoints`, {
      method: 'POST',
      headers: { ...bearerHeaders, 'x-correlation-id': 'notification-endpoint-http' },
      body: JSON.stringify({
        channel: 'IN_APP',
        provider: 'CORE',
        endpointReference: 'recipient://wallet',
        topics: ['ORDER'],
      }),
    });
    assert.equal(notificationEndpointResponse.status, 201);
    assert.equal(notificationEndpointCorrelationId, 'notification-endpoint-http');
    assert.equal(notificationEndpointResponse.headers.get('x-correlation-id'), 'notification-endpoint-http');
    assert.equal((await fetch(`${base}/v2/notifications`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);

    assert.equal((await fetch(`${base}/v2/admin/policy-drafts`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ payload: {}, idempotencyKey: 'policy-draft-http-1' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts/policy-draft-1`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({ payload: {} }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts/policy-draft-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts/policy-draft-1/approval-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1800000000' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts/policy-draft-1/secondary-signature`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1800000000', signature: '0x1234' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/policy-drafts/policy-draft-1/safe-proposal`, {
      method: 'POST',
      headers: bearerHeaders,
      body: '{}',
    })).status, 202);
    assert.equal((await fetch(`${base}/v2/admin/coverage-breaker/actions`, {
      headers: bearerHeaders,
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/coverage-breaker/resume-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '2', deadline: '1800000000' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/coverage-breaker/resume-actions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ snapshotId: HASH, nonce: '2', deadline: '1800000000', signature: '0x1234' }),
    })).status, 201);

    assert.equal((await fetch(`${base}/v2/admin/cms/versions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        slug: 'seckill-rules',
        contentType: 'SECKILL_RULES',
        placement: 'SECKILL',
        locale: 'zh-CN',
        contentFormat: 'STRUCTURED_RICH_TEXT',
        content: {},
        audience: {},
        idempotencyKey: 'cms-version-http-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/cms/versions/cms-version-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    for (const action of ['publish', 'rollback']) {
      assert.equal((await fetch(`${base}/v2/admin/cms/versions/cms-version-1/${action}`, {
        method: 'POST',
        headers: bearerHeaders,
        body: JSON.stringify({ evidenceHash: HASH }),
      })).status, 200, `cms ${action}`);
    }

    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        topic: 'ANNOUNCEMENT',
        audience: {},
        message: {},
        idempotencyKey: 'notification-campaign-http-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns?limit=25`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns`, {
      headers: { authorization: `Bearer ${buyerOnlyToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns`, {
      headers: { authorization: `Bearer ${auditorOnlyToken}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auditorOnlyToken}` },
      body: '{}',
    })).status, 403);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns/campaign-1/publish`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ evidenceHash: HASH }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns/campaign-1/retry-failed`, {
      method: 'POST',
      headers: bearerHeaders,
      body: '{}',
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/notification-campaigns/campaign-1/retry-failed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auditorOnlyToken}` },
      body: '{}',
    })).status, 403);

    assert.equal((await fetch(`${base}/v2/admin/system-config/versions`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/system-config/versions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        configKey: 'BUSINESS',
        payload: {},
        effectiveFrom: now.toISOString(),
        idempotencyKey: 'system-config-http-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/system-config/versions/config-1/approval-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1800000000' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/system-config/versions/config-1/approval-challenge`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ nonce: '1', deadline: '1800000000', approval: {} }),
    })).status, 400);
    assert.equal((await fetch(`${base}/v2/admin/system-config/versions/config-1/publish`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        approval: {
          action: 'PUBLISH_SYSTEM_CONFIG',
          resourceType: 'SYSTEM_CONFIG',
          resourceId: 'config-1',
          policyVersion: '1',
          oldValueHash: HASH,
          newValueHash: HASH_2,
          safeAddress: SAFE,
          nonce: '1',
          deadline: '1800000000',
          signature: '0x1234',
        },
      }),
    })).status, 200);

    assert.equal((await fetch(`${base}/v2/admin/audit/entries?streamName=governance&limit=25`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/monitoring`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const monitoringResponse = await fetch(`${base}/v2/admin/monitoring/alerts/RPC_PRIMARY:height_lag/acknowledge`, {
      method: 'POST',
      headers: { ...bearerHeaders, 'x-correlation-id': 'monitoring-http-correlation' },
      body: '{}',
    });
    assert.equal(monitoringResponse.status, 200);
    assert.equal(monitoringCorrelationId, 'monitoring-http-correlation');
    assert.equal(monitoringResponse.headers.get('x-correlation-id'), 'monitoring-http-correlation');

    const unauthorizedOrders = await fetch(`${base}/v2/orders`);
    assert.equal(unauthorizedOrders.status, 401);
    const orders = await fetch(`${base}/v2/orders`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(orders.status, 200);
    const order = await fetch(`${base}/v2/orders/order-1`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(order.status, 200);
    const stores = await fetch(`${base}/v2/stores?regionCode=110101`);
    assert.equal(stores.status, 200);
    const deliveryTarget = await fetch(`${base}/v2/fulfillment-targets/delivery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'delivery-target-1',
        recipientName: 'Buyer',
        phone: '+8613800000000',
        address: 'Test address 1',
        longitude: 116.397,
        latitude: 39.908,
      }),
    });
    assert.equal(deliveryTarget.status, 201);
    const pickupTarget = await fetch(`${base}/v2/fulfillment-targets/pickup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ idempotencyKey: 'pickup-target-1', storeId: 'store-1' }),
    });
    assert.equal(pickupTarget.status, 201);
    assert.equal((await fetch(`${base}/v2/stores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'create-store-1',
        name: 'Store',
        phone: '+8613800000000',
        businessHours: '09:00-18:00',
        longitude: 116.397,
        latitude: 39.908,
      }),
    })).status, 404);
    assert.equal((await fetch(`${base}/v2/merchant/stores`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const createStore = await fetch(`${base}/v2/merchant/stores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'create-store-1',
        name: 'Store',
        phone: '+8613800000000',
        businessHours: '09:00-18:00',
        longitude: 116.397,
        latitude: 39.908,
      }),
    });
    assert.equal(createStore.status, 201);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        name: 'Updated Store',
        phone: '+8613900000000',
        businessHours: '10:00-20:00',
        imageAssetIds: [HASH],
        expectedVersion: 1,
        idempotencyKey: 'update-store-1',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ expectedVersion: 2, idempotencyKey: 'activate-store-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ expectedVersion: 3, idempotencyKey: 'close-store-1' }),
    })).status, 200);
    const printerChallenge = await fetch(`${base}/v2/merchant/stores/store-1/printer-binding/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        provider: 'YILIANYUN',
        deviceId: 'printer-001',
        idempotencyKey: 'printer-challenge-http-1',
      }),
    });
    assert.equal(printerChallenge.status, 201);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/printer-binding`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ challengeId: HASH, signature: '0x1234', idempotencyKey: 'printer-apply-http-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/stores/store-1/printer-binding`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/waybills/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        provider: 'KUAIDI100',
        carrierCode: 'SF',
        storeId: 'store-1',
        orderIds: ['order-1'],
        idempotencyKey: 'waybill-http-batch-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/merchant/print-jobs?limit=50`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/merchant/print-jobs/${HASH}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ idempotencyKey: 'print-retry-http-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/carriers`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/carrier-versions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        carriers: [
          { carrierCode: 'SF', enabled: true },
          { carrierCode: 'JD', enabled: true },
          { carrierCode: 'YTO', enabled: true },
          { carrierCode: 'ZTO', enabled: true },
          { carrierCode: 'STO', enabled: true },
          { carrierCode: 'EMS', enabled: true },
        ],
        defaultCarrierCode: 'SF',
        idempotencyKey: 'admin-logistics-carriers-http-1',
      }),
    })).status, 201);
    const providerConfig = await fetch(`${base}/v2/admin/logistics/provider-versions`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        provider: 'KUAIDI100',
        enabled: true,
        partnerIdSecretRef: 'secret://logistics/kuaidi100/partner-id',
        credentialSecretRef: 'vault://logistics/kuaidi100/credential',
        monthlyAccountSecretRef: 'secret://logistics/kuaidi100/monthly-account',
        callbackSecretRef: 'vault://logistics/kuaidi100/callback',
        idempotencyKey: 'admin-logistics-provider-http-1',
      }),
    });
    assert.equal(providerConfig.status, 201);
    assert.equal(JSON.stringify(await providerConfig.json()).includes('secret://'), false);
    assert.equal((await fetch(`${base}/v2/admin/logistics/providers`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    const warehouse = await fetch(`${base}/v2/admin/logistics/warehouses`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        warehouseKind: 'PLATFORM',
        name: 'Dalian Warehouse',
        partnerName: null,
        contactName: 'Warehouse Operator',
        phone: '+8641112345678',
        regionCode: '210211',
        addressLine: 'Dalian Logistics Road 18',
        enabled: true,
        idempotencyKey: 'admin-logistics-warehouse-http-1',
      }),
    });
    assert.equal(warehouse.status, 201);
    assert.equal((await fetch(`${base}/v2/admin/logistics/warehouses`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/warehouses/warehouse%3Atest`, {
      method: 'PUT',
      headers: bearerHeaders,
      body: JSON.stringify({
        warehouseKind: 'PARTNER',
        name: 'Partner Warehouse',
        partnerName: 'Partner Logistics',
        contactName: 'Partner Operator',
        phone: '+8641187654321',
        regionCode: '210211',
        addressLine: 'Dalian Logistics Road 20',
        enabled: true,
        expectedVersion: 1,
        idempotencyKey: 'admin-logistics-warehouse-http-2',
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/warehouses/warehouse%3Atest/deactivate`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ expectedVersion: 2, idempotencyKey: 'admin-logistics-warehouse-http-3' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/waybills/batches`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({
        merchantId: 'merchant-1',
        provider: 'KUAIDI100',
        carrierCode: 'SF',
        storeId: 'store-1',
        orderIds: ['order-1'],
        idempotencyKey: 'admin-waybill-http-batch-1',
      }),
    })).status, 201);
    assert.equal((await fetch(`${base}/v2/admin/logistics/waybills?merchantId=merchant-1&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/print-jobs?merchantId=merchant-1&limit=20`, {
      headers: { authorization: `Bearer ${session.token}` },
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/print-jobs/${HASH}/retry`, {
      method: 'POST',
      headers: bearerHeaders,
      body: JSON.stringify({ idempotencyKey: 'admin-print-retry-http-1' }),
    })).status, 200);
    assert.equal((await fetch(`${base}/v2/admin/logistics/carrier-versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerOnlyToken}` },
      body: '{}',
    })).status, 403);
    const target = await fetch(`${base}/v2/orders/order-1/fulfillment-target`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(target.status, 200);
    const logisticsBody = Buffer.from(JSON.stringify({
      eventId: 'kuaidi-event-1',
      orderId: 'order-1',
      status: 'DELIVERED',
      occurredAt: now.toISOString(),
      locationHash: HASH,
    }));
    const logisticsSignature = createHmac('sha256', 'kuaidi-webhook-secret').update(logisticsBody).digest('hex');
    const logistics = await fetch(`${base}/v2/providers/kuaidi100/webhooks/logistics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': logisticsSignature },
      body: logisticsBody,
    });
    assert.equal(logistics.status, 202);
    const badLogisticsSignature = await fetch(`${base}/v2/providers/kuaidi100/webhooks/logistics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': '0'.repeat(64) },
      body: logisticsBody,
    });
    assert.equal(badLogisticsSignature.status, 401);
    const cainiaoBody = Buffer.from(JSON.stringify({
      eventId: 'cainiao-event-1',
      orderId: 'order-1',
      status: 'IN_TRANSIT',
      occurredAt: now.toISOString(),
    }));
    const cainiaoSignature = createHmac('sha256', 'cainiao-webhook-secret').update(cainiaoBody).digest('hex');
    const cainiao = await fetch(`${base}/v2/providers/cainiao/webhooks/logistics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': cainiaoSignature },
      body: cainiaoBody,
    });
    assert.equal(cainiao.status, 202);
    const exchange = await fetch(`${base}/v2/orders/order-1/exchange-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        idempotencyKey: 'exchange-command-1',
        evidenceHash: HASH,
        reasonCode: 'SIZE_MISMATCH',
      }),
    });
    assert.equal(exchange.status, 201);
    const actionCases: Array<[string, Record<string, unknown>, number]> = [
      ['shipments', {
        idempotencyKey: 'shipment-command-1',
        evidenceHash: HASH,
        carrierCode: 'SF',
        trackingNumberHash: HASH_2,
      }, 201],
      ['delivery', { idempotencyKey: 'delivery-command-1', evidenceHash: HASH }, 200],
      ['pickup-credential', {
        idempotencyKey: 'pickup-credential-1',
        evidenceHash: HASH,
        code: '123456',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }, 201],
      ['pickup-verification', {
        idempotencyKey: 'pickup-verification-1', evidenceHash: HASH, code: '123456', storeId: 'store-1',
      }, 200],
      ['delay-requests', {
        idempotencyKey: 'delay-command-1', evidenceHash: HASH, reasonCode: 'NEED_MORE_TIME',
      }, 201],
      ['request-decisions', {
        idempotencyKey: 'request-decision-1', evidenceHash: HASH, requestId: 'request-1',
        approved: true, noteCode: 'APPROVED',
      }, 200],
      ['arbitrations', {
        idempotencyKey: 'arbitration-command-1', evidenceHash: HASH, reasonCode: 'EVIDENCE_DISPUTED',
      }, 201],
      ['arbitration-decisions', {
        idempotencyKey: 'arbitration-decision-1', evidenceHash: HASH,
        outcome: 'FULFILL', noteCode: 'FULFILL_ORDER',
      }, 200],
      ['takeover', {
        idempotencyKey: 'takeover-command-1', evidenceHash: HASH, reasonCode: 'NO_SHIPMENT',
      }, 201],
      ['forced-receipt-requests', {
        idempotencyKey: 'forced-receipt-request-1', evidenceHash: HASH, reasonCode: 'DELIVERED',
      }, 201],
      ['forced-receipt-decisions', {
        idempotencyKey: 'forced-receipt-decision-1', evidenceHash: HASH,
        approved: true, noteCode: 'EVIDENCE_ACCEPTED',
      }, 200],
    ];
    for (const [path, body, expectedStatus] of actionCases) {
      assert.equal((await postOrderAction(path, body)).status, expectedStatus, path);
    }
    const receipt = await fetch(`${base}/v2/orders/order-1/receipt-confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ idempotencyKey: 'receipt-command-1', evidenceHash: HASH_2 }),
    });
    assert.equal(receipt.status, 200);
    assert.deepEqual(
      evidenceCalls.filter((call) => call.operation.startsWith('ASSERT_')).map((call) => call.operation),
      [
        'ASSERT_ACTION',
        'ASSERT_TRACKING',
        'ASSERT_ACTION',
        'ASSERT_ACTION',
        'ASSERT_ACTION',
        'ASSERT_ACTION',
        'ASSERT_ACTION',
      ],
    );
    assert.deepEqual(
      fulfillmentCalls.map(({ operation, wallet, orderId }) => ({ operation, wallet, orderId })),
      [
        { operation: 'LOGISTICS_UPDATE', wallet: SAFE, orderId: 'order-1' },
        { operation: 'LOGISTICS_UPDATE', wallet: SAFE, orderId: 'order-1' },
        { operation: 'REQUEST_EXCHANGE', wallet: wallet.address.toLowerCase(), orderId: 'order-1' },
        { operation: 'CONFIRM_RECEIPT', wallet: wallet.address.toLowerCase(), orderId: 'order-1' },
      ],
    );
    const extraFulfillmentField = await fetch(`${base}/v2/orders/order-1/receipt-confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ idempotencyKey: 'receipt-command-2', evidenceHash: HASH_2, refund: true }),
    });
    assert.equal(extraFulfillmentField.status, 400);
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
    platformFeeBps: 100,
    oracleWindowSeconds: 1_800,
    oracleMaxDeviationBps: 500,
    oracleMaxAgeSeconds: 600,
    oracleMinimumUsdtLiquidity: 50_000n * 10n ** 18n,
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: 1_000n * 10n ** 18n,
    platformServiceFeeSafe: '0x2222222222222222222222222222222222222223',
    usdtCustodySafe: '0x3333333333333333333333333333333333333333',
    nplRewardSafe: '0x4444444444444444444444444444444444444444',
    operationsTreasurySafe: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6666666666666666666666666666666666666666',
    concessionDestinationSetHash: paymentAllocationSetHash(),
    genesisNodeDestinations: [
      { account: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', weightBps: 10_000 },
    ],
    operationsDestinations: [
      { account: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', weightBps: 2_500 },
      { account: '0xcccccccccccccccccccccccccccccccccccccccc', weightBps: 2_500 },
      { account: '0xdddddddddddddddddddddddddddddddddddddddd', weightBps: 2_500 },
      { account: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', weightBps: 2_500 },
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
    freightUsdt: 0n,
    nplQuoteAmount: 1_000n,
    merchantConcessionBps: 2_500,
    beneficiaries: {
      genesis: '0x0000000000000000000000000000000000000000',
      directReferral: '0x5555555555555555555555555555555555555555',
      district: '0x6666666666666666666666666666666666666666',
      city: '0x7777777777777777777777777777777777777777',
      province: '0x8888888888888888888888888888888888888888',
      region: '0x9999999999999999999999999999999999999999',
      operations: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
}

function governedPaymentPolicy(): PaymentPolicySnapshot {
  const base = readyPolicy();
  return {
    ...base,
    platformServiceFeeSafe: base.platformServiceFeeSafe!,
    usdtCustodySafe: base.usdtCustodySafe!,
    nplRewardSafe: base.nplRewardSafe!,
    operationsTreasurySafe: base.operationsTreasurySafe!,
    circulationPool: base.circulationPool!,
    concessionDestinationSetHash: base.concessionDestinationSetHash!,
    genesisNodeDestinations: base.genesisNodeDestinations!,
    operationsDestinations: base.operationsDestinations!,
    platformFeeBps: 100,
    seckillPrizeBps: 0,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    decisionEvidenceHash: HASH_2,
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
    productUsdtPaymentAmount: '70000000000000000000',
    platformServiceFeeUsdt: '1000000000000000000',
    custodyProductUsdt: '69000000000000000000',
    freightUsdt: '0',
    usdtPaymentAmount: '70000000000000000000',
    nplQuoteAmount: '1000000000000000000000',
    nplPaymentAmount: '300000000000000000000',
    nplBurnAmount: '200000000000000000000',
    nplRewardAmount: '100000000000000000000',
    merchantBaseReceivableUsdt: '69000000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '17250000000000000000',
    merchantNetReceivableUsdt: '51750000000000000000',
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
    DELIVERY_DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    PII_RETENTION_POLICY_VERSION: 'pii-v1',
    BSC_RPC_URL: 'https://rpc.example.invalid',
    BSC_FALLBACK_RPC_URL: 'https://fallback-rpc.example.invalid',
    PLATFORM_SAFE_ADDRESS: SAFE,
    PLATFORM_SERVICE_FEE_SAFE_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    USDT_CUSTODY_SAFE_ADDRESS: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    NPL_REWARD_SAFE_ADDRESS: '0xcccccccccccccccccccccccccccccccccccccccc',
    OPERATIONS_TREASURY_SAFE_ADDRESS: '0xdddddddddddddddddddddddddddddddddddddddd',
    SECONDARY_SIGNER_ADDRESS: '0x5555555555555555555555555555555555555555',
    QUOTE_SIGNER_ADDRESS: '0x6666666666666666666666666666666666666666',
    FINALITY_SIGNER_ADDRESS: '0x7777777777777777777777777777777777777777',
    TWAP_SOURCE_ADDRESS: '0x8888888888888888888888888888888888888888',
    TWAP_SOURCE_CODEHASH: HASH,
    SIGNER_SERVICE_URL: 'https://signer.example.invalid',
    SIGNER_SERVICE_TOKEN: 'provider-secret',
    SETTLEMENT_EXECUTOR_URL: 'https://executor.example.invalid',
    SETTLEMENT_EXECUTOR_TOKEN: 'provider-secret',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    SETTLEMENT_REPLACEMENT_DELAY_MS: '300000',
    SAFE_APPROVAL_VERIFIER_URL: 'https://safe-approvals.example.invalid',
    SAFE_APPROVAL_VERIFIER_TOKEN: 'provider-secret',
    SAFE_INTERNAL_MTLS_ENABLED: 'true',
    USDT_SAFE_PROXY_CODE_HASH: HASH,
    USDT_SAFE_OWNER_SET_HASH: HASH_2,
    USDT_SAFE_THRESHOLD: '2',
    USDT_SAFE_GUARD_ADDRESS: '0x0000000000000000000000000000000000000000',
    USDT_SAFE_FALLBACK_HANDLER_ADDRESS: '0x0000000000000000000000000000000000000000',
    USDT_SAFE_MODULES_HASH: HASH_2,
    USDT_TOKEN_CODE_HASH: HASH,
    USDT_TRANSFER_CONFORMANCE_EVIDENCE_HASH: HASH_2,
    NPL_SAFE_PROXY_CODE_HASH: HASH,
    NPL_SAFE_OWNER_SET_HASH: HASH_2,
    NPL_SAFE_THRESHOLD: '2',
    NPL_SAFE_GUARD_ADDRESS: '0x0000000000000000000000000000000000000000',
    NPL_SAFE_FALLBACK_HANDLER_ADDRESS: '0x0000000000000000000000000000000000000000',
    NPL_SAFE_MODULES_HASH: HASH_2,
    NPL_TOKEN_CODE_HASH: HASH,
    NPL_TRANSFER_CONFORMANCE_EVIDENCE_HASH: HASH_2,
    OPERATIONS_SAFE_PROXY_CODE_HASH: HASH,
    OPERATIONS_SAFE_OWNER_SET_HASH: HASH_2,
    OPERATIONS_SAFE_THRESHOLD: '2',
    OPERATIONS_SAFE_GUARD_ADDRESS: '0x0000000000000000000000000000000000000000',
    OPERATIONS_SAFE_FALLBACK_HANDLER_ADDRESS: '0x0000000000000000000000000000000000000000',
    OPERATIONS_SAFE_MODULES_HASH: HASH_2,
    OPERATIONS_TOKEN_CODE_HASH: HASH,
    OPERATIONS_TRANSFER_CONFORMANCE_EVIDENCE_HASH: HASH_2,
    REQUIRED_CONFIRMATIONS: '15',
    AMAP_WEB_SERVICE_KEY: 'provider-secret',
    KUAIDI100_CUSTOMER: 'provider-secret',
    KUAIDI100_KEY: 'provider-secret',
    KUAIDI100_SECRET: 'provider-secret',
    KUAIDI100_SIID: 'provider-secret',
    KUAIDI100_CALLBACK_SECRET: 'provider-secret',
    CAINIAO_LOGISTIC_PROVIDER_ID: 'provider-secret',
    CAINIAO_DATA_DIGEST_SIGNER_URL: 'https://cainiao-signer.example.invalid',
    CAINIAO_DATA_DIGEST_SIGNER_TOKEN: 'provider-secret',
    CAINIAO_CALLBACK_SECRET: 'provider-secret',
    FEIE_USER: 'provider-secret',
    FEIE_UKEY: 'provider-secret',
    YILIANYUN_CLIENT_ID: 'provider-secret',
    YILIANYUN_CLIENT_SECRET: 'provider-secret',
    YILIANYUN_ACCESS_TOKEN: 'provider-secret',
    BNM_AVAILABILITY_URL: 'https://bnm.example.invalid/v1/order-points/state',
    BNM_API_TOKEN: 'provider-secret',
    BNM_PROJECT_ID: 'abu-24k',
    BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH: HASH_2,
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

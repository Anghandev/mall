import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedActionNames, artifactVersion } from '../../../packages/core-artifacts/generated/index.js';
import { productBaseline as mallBaseline, isCoreOrderActionExecutable } from '../../../mall-v2/src/bootstrap.ts';
import { productBaseline as merchantBaseline } from '../../../merchant-v2/src/bootstrap.ts';
import { coreBoundary as merchantCore } from '../../../merchant-v2/src/core-boundary.ts';
import { productBaseline as adminBaseline } from '../../admin/src/bootstrap.ts';
import { orderAllowedActions, settlementRequestAllowedAction } from '../../server/api/allowed-actions.ts';
import {
  buildDualPaymentQuote,
  buildPaymentIntent,
  type FrozenPaymentPolicy,
  type PaymentQuoteRequest,
} from '../../server/api/checkout.ts';
import { CoreError } from '../../server/api/errors.ts';
import { applyReceipt, replaceTransaction, requireFinal, submittedFinality } from '../../server/api/finality.ts';
import { assertEmptySessionPrizeDecision, evaluateForcedReceipt, evaluateTakeover } from '../../server/api/fulfillment.ts';
import { loadConfig, requireProvider } from '../../server/api/config.ts';

const HASH = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const CONTRACT = '0x3333333333333333333333333333333333333333';
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';

test('all products consume one coordinated artifact and expose no executable write', () => {
  assert.equal(mallBaseline.coreArtifacts, artifactVersion);
  assert.equal(merchantBaseline.coreArtifacts, artifactVersion);
  assert.equal(adminBaseline.artifactVersion, artifactVersion);
  assert.equal(merchantCore.artifactVersion, artifactVersion);
  assert.equal(merchantCore.runtimeAvailable, false);
  assert.equal(adminBaseline.adminCapabilities.writes, false);
  assert.equal(adminBaseline.adminCapabilities.projections, false);
  for (const action of allowedActionNames) assert.equal(isCoreOrderActionExecutable(action), false, action);
});

test('ordinary and seckill quotes conserve funds and keep independent reservations', () => {
  const request = quoteRequest();
  const ordinary = buildPaymentIntent(request, readyPolicy(), 'ORDINARY', request.issuedAt);
  assert.equal(
    BigInt(ordinary.merchantNetReceivableUsdt) +
      BigInt(ordinary.merchantConcessionAmount) +
      ordinary.otherUsdtAllocations.reduce((sum, item) => sum + BigInt(item.amount), 0n),
    BigInt(ordinary.usdtPaymentAmount),
  );
  assert.equal(BigInt(ordinary.nplBurnAmount) + BigInt(ordinary.nplRewardAmount), BigInt(ordinary.nplPaymentAmount));

  const dual = buildDualPaymentQuote(
    {
      ...request,
      sessionId: `0x${'f'.repeat(64)}`,
    },
    { ...request, reservationId: `0x${'e'.repeat(64)}`, reservationHash: HASH_2 },
    readyPolicy(),
    request.issuedAt,
  );
  assert.equal(dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');
  assert.notEqual(dual.seckill.reservationId, dual.fallback.reservationId);
  assert.throws(
    () => buildPaymentIntent({ ...request, latestPolicyVersion: 2 }, readyPolicy(), 'ORDINARY', request.issuedAt),
    /latest policy/,
  );
});

test('permissions, breakers and Claims remain fail closed across products', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const actions = orderAllowedActions(
    {
      state: 'PAID',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: BUYER,
      merchantWallet: MERCHANT,
      paidAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    { actorWallet: BUYER, roles: ['BUYER'], now, pausedScopes: new Set(), executableActions: new Set() },
  );
  assert.deepEqual(actions.find((item) => item.action === 'OPEN_TAKEOVER')?.reasonCode, 'ConfigurationRequired');

  const pausedPayment = orderAllowedActions(
    {
      state: 'QUOTED',
      fulfillmentMode: 'DELIVERY',
      buyerWallet: BUYER,
      merchantWallet: MERCHANT,
      shipmentEvidence: false,
      takeoverOpened: false,
    },
    {
      actorWallet: BUYER,
      roles: ['BUYER'],
      now,
      pausedScopes: new Set(['NEW_PAYMENT']),
      executableActions: new Set(),
    },
  );
  assert.equal(pausedPayment.find((item) => item.action === 'PAY_ORDER')?.reasonCode, 'BreakerActive');
  assert.equal(settlementRequestAllowedAction('PRIZE_USDT', 1n, true).enabled, true);
  assert.equal(settlementRequestAllowedAction('MERCHANT_USDT', 1n, true).reasonCode, 'MerchantFrozen');
  assert.equal(settlementRequestAllowedAction('REWARD_NPL', 0n, false).reasonCode, 'FinalityPending');
});

test('takeover, fulfillment and empty-session decisions preserve locked funds', () => {
  const paidAt = new Date('2026-07-01T00:00:00.000Z');
  const delivery = {
    orderId: 'order-1',
    fulfillmentMode: 'DELIVERY' as const,
    state: 'PAID' as const,
    paidAt,
    takeoverOpened: false,
  };
  assert.equal(evaluateTakeover(delivery, new Date('2026-07-09T00:00:00.000Z')).customerFundsRemainLocked, true);
  assertCoreError(
    () => evaluateTakeover({ ...delivery, fulfillmentMode: 'PICKUP' }, new Date('2026-07-09T00:00:00.000Z')),
    'PickupTakeoverDecisionBlocked',
  );
  assert.equal(
    evaluateForcedReceipt(
      { ...delivery, state: 'DELIVERED', deliveredAt: paidAt },
      'MERCHANT',
      new Date('2026-07-09T00:00:00.000Z'),
    ).canFinalizeDirectly,
    false,
  );
  assertCoreError(() => assertEmptySessionPrizeDecision(undefined, 1n), 'EmptySessionPrizeDecisionBlocked');
});

test('finality binds the configured threshold, replacement and canonical block', () => {
  const submitted = submittedFinality(
    { requiredConfirmations: 15 },
    {
      resourceType: 'FULFILLMENT',
      resourceId: 'order-1',
      contractAddress: CONTRACT,
      expectedEventHash: HASH,
      txHash: HASH_2,
    },
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
  assert.equal(applyReceipt(submitted, receipt).state, 'MINED');
  assert.equal(requireFinal(applyReceipt(submitted, { ...receipt, confirmations: 15 })).state, 'FINAL');
  const replacement = replaceTransaction(submitted, `0x${'4'.repeat(64)}`);
  assert.equal(replacement.requiredConfirmations, 15);
  const reorged = applyReceipt(replacement, {
    ...receipt,
    txHash: replacement.txHash,
    confirmations: 15,
    canonicalBlock: false,
  });
  assertCoreError(() => requireFinal(reorged), 'ReorgPending');
});

test('provider and production decisions stay unavailable without external configuration', () => {
  const config = loadConfig({ CHAIN_ID: '56' });
  assert.equal(config.requiredConfirmations, 15);
  assert.equal(config.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'), false);
  assert.throws(() => requireProvider(config, 'KUAIDI100'), /not configured/);
});

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
    orderId: `0x${'a'.repeat(64)}`,
    latestPolicyVersion: 1,
    buyer: BUYER,
    merchant: MERCHANT,
    productId: `0x${'b'.repeat(64)}`,
    skuId: `0x${'c'.repeat(64)}`,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH,
    regionCodeHash: HASH,
    productPolicyHash: HASH,
    reservationId: `0x${'d'.repeat(64)}`,
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
      genesis: CONTRACT,
      directReferral: '0x5555555555555555555555555555555555555555',
      district: '0x6666666666666666666666666666666666666666',
      city: '0x7777777777777777777777777777777777777777',
      province: '0x8888888888888888888888888888888888888888',
      region: '0x9999999999999999999999999999999999999999',
      operations: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  };
}

function assertCoreError(run: () => unknown, code: string) {
  assert.throws(run, (error) => error instanceof CoreError && error.code === code);
}

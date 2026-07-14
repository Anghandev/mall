import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedActionNames, artifactVersion } from '../../../packages/core-artifacts/generated/index.js';
import { productBaseline as mallBaseline, isCoreOrderActionExecutable } from '../../../mall-v2/src/bootstrap.ts';
import { productBaseline as merchantBaseline } from '../../../merchant-v2/src/bootstrap.ts';
import { coreBoundary as merchantCore } from '../../../merchant-v2/src/core-boundary.ts';
import { productBaseline as adminBaseline } from '../../admin/src/bootstrap.ts';
import { claimAllowedAction, orderAllowedActions } from '../../server/api/allowed-actions.ts';
import { buildDualQuote, buildOrderIntent, type FrozenPolicyTerms, type QuoteRequest } from '../../server/api/checkout.ts';
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
  const ordinary = buildOrderIntent(request, readyPolicy(), 'ORDINARY');
  assert.equal(
    BigInt(ordinary.merchantUsdtAmount) +
      BigInt(ordinary.platformUsdtAmount) +
      BigInt(ordinary.prizeUsdtAmount) +
      BigInt(ordinary.usdtRemainderAmount),
    BigInt(ordinary.usdtPaymentAmount),
  );
  assert.equal(BigInt(ordinary.burnedNplAmount) + BigInt(ordinary.routedNplAmount), BigInt(ordinary.nplPaymentAmount));

  const dual = buildDualQuote(
    {
      ...request,
      sessionId: `0x${'f'.repeat(64)}`,
      fallbackReservationId: `0x${'e'.repeat(64)}`,
      fallbackReservationHash: HASH_2,
    },
    readyPolicy(),
  );
  assert.equal(dual.classificationAuthority, 'CHAIN_TIMESTAMP');
  assert.notEqual(dual.seckill.reservationId, dual.fallback.reservationId);
  assert.equal(dual.seckill.prizeUsdtAmount, '10');
  assert.equal(dual.fallback.prizeUsdtAmount, '0');
  assert.throws(
    () => buildOrderIntent({ ...request, latestPolicyVersion: 2 }, readyPolicy(), 'ORDINARY'),
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
      pausedScopes: new Set(['NEW_ORDERS']),
      executableActions: new Set(),
    },
  );
  assert.equal(pausedPayment.find((item) => item.action === 'PAY_ORDER')?.reasonCode, 'BreakerActive');
  assert.equal(claimAllowedAction('PRIZE_USDT', 1n, true, new Set()).enabled, true);
  assert.equal(claimAllowedAction('MERCHANT_USDT', 1n, true, new Set()).reasonCode, 'MerchantFrozen');
  assert.equal(claimAllowedAction('BNM', 1n, false, new Set(['REWARD_CLAIM'])).reasonCode, 'BreakerActive');
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
    { requiredConfirmations: 12 },
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
  assert.equal(requireFinal(applyReceipt(submitted, { ...receipt, confirmations: 12 })).state, 'FINAL');
  const replacement = replaceTransaction(submitted, `0x${'4'.repeat(64)}`);
  assert.equal(replacement.requiredConfirmations, 12);
  const reorged = applyReceipt(replacement, {
    ...receipt,
    txHash: replacement.txHash,
    confirmations: 12,
    canonicalBlock: false,
  });
  assertCoreError(() => requireFinal(reorged), 'ReorgPending');
});

test('provider and production decisions stay unavailable without external configuration', () => {
  const config = loadConfig({ CHAIN_ID: '56' });
  assert.equal(config.requiredConfirmations, undefined);
  assert.ok(config.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'));
  assert.throws(() => requireProvider(config, 'KUAIDI100'), /not configured/);
});

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
  const reservationDeadline = Math.floor(Date.now() / 1000) + 3_600;
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
    reservationDeadline,
    nonce: 1n,
    deadline: reservationDeadline,
    listPriceUsdt: 100n,
    rewardBaseNpl: 1_000n,
    merchantSettlementUsdt: 30n,
    beneficiaries: { genesis: CONTRACT },
  };
}

function assertCoreError(run: () => unknown, code: string) {
  assert.throws(run, (error) => error instanceof CoreError && error.code === code);
}

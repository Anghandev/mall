import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from 'pg';
import { buildPaymentIntent, type CanonicalPaymentIntent } from '../../server/api/checkout.ts';
import { CORE_ARTIFACT_VERSION } from '../../server/api/enums.ts';
import { paymentAllocationSetHash, parsePaymentPolicySnapshot } from '../../server/api/payment-policy.ts';
import { paymentIntentHash } from '../../server/api/payment-signing.ts';
import type {
  PaymentReceiptCandidate,
  PaymentReceiptObservation,
} from '../../server/chain/payment-receipt-worker.ts';
import { reserveInventory } from '../../server/data/inventory.ts';
import { applyMigrations, type SqlExecutor, type SqlTransactionRunner } from '../../server/data/migrations.ts';
import { PostgresPaymentReceiptRepository } from '../../server/data/payment-receipt-repository.ts';
import {
  PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
  paymentEventKey,
} from '../../server/data/payment-store.ts';

const MIGRATIONS = fileURLToPath(new URL('../../server/data/migrations/business/', import.meta.url));
const ROUTER = '0x9999999999999999999999999999999999999999';
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const TX_1 = `0x${'6'.repeat(64)}`;
const TX_2 = `0x${'7'.repeat(64)}`;
const SESSION_ID = `0x${'f'.repeat(64)}`;
const POLICY = Object.freeze({
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
  seckillPrizeBps: 0,
  seckillMainDuration: 3_600,
  relayInitial: 60,
  relayIncrement: 30,
  relayCap: 60,
  requiredConfirmations: 15,
  merchantGuaranteeMinimumUsdt: (1_000n * 10n ** 18n).toString(),
  platformServiceFeeWallet: '0x2222222222222222222222222222222222222223',
  usdtSettlementWallet: '0x3333333333333333333333333333333333333333',
  nplRewardWallet: '0x4444444444444444444444444444444444444444',
  operationsWallet: '0x5555555555555555555555555555555555555555',
  circulationPool: '0x6000000000000000000000000000000000000001',
  concessionDestinationSetHash: paymentAllocationSetHash(),
  decisionEvidenceHash: HASH_2,
  genesisNodeDestinations: [
    { account: '0x5000000000000000000000000000000000000011', weightBps: 10_000 },
  ],
  operationsDestinations: [
    { account: '0x5000000000000000000000000000000000000007', weightBps: 2_500 },
    { account: '0x5000000000000000000000000000000000000008', weightBps: 2_500 },
    { account: '0x5000000000000000000000000000000000000009', weightBps: 2_500 },
    { account: '0x5000000000000000000000000000000000000010', weightBps: 2_500 },
  ],
});

test('real PostgreSQL atomically resumes and finalizes payment plus seckill relay receipts', {
  timeout: 300_000,
}, async () => {
  const adminConnectionString = requiredPostgresAdminUrl();
  const databaseName = `abu24k_receipt_${randomBytes(6).toString('hex')}`;
  const databaseConnectionString = connectionForDatabase(adminConnectionString, databaseName);
  const admin = new Client({ connectionString: connectionForDatabase(adminConnectionString, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const setup = await connected(databaseConnectionString);
    try {
      await applyMigrations(setup, 'core', MIGRATIONS);
      await seedCatalog(setup);

      const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      const ordinary = paymentIntent({
        orderId: `0x${'a'.repeat(64)}`,
        reservationId: `0x${'b'.repeat(64)}`,
        reservationHash: `0x${'c'.repeat(64)}`,
        issuedAt: Math.floor(now.getTime() / 1_000),
        classification: 'ORDINARY',
      });
      await seedQuote(setup, ordinary, 'ORDINARY');
      await submitQuote(setup, ordinary.orderId, TX_1);
      await setup.query(
        `INSERT INTO core.transaction_finality (
           transaction_id, resource_type, resource_id, chain_id, contract_address,
           expected_event_hash, tx_hash, block_number, block_hash, confirmations,
           required_confirmations, receipt_status, state, evidence, submitted_at
         ) VALUES ($1,'ORDER_PAYMENT',$2,56,$3,$4,$5,100,$6,14,15,1,'MINED',$7,$8)`,
        [
          `payment:${paymentEventKey(TX_1, 0, HASH_2)}`,
          ordinary.orderId,
          ROUTER,
          PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
          TX_1,
          HASH_2,
          JSON.stringify({ source: 'LEGACY_PAYMENT_INDEXER' }),
          now,
        ],
      );
      const runner = transactionRunner(databaseConnectionString);
      const repository = new PostgresPaymentReceiptRepository({ transactions: runner, routerAddress: ROUTER });
      const candidate = (await repository.pendingReceipts())[0]!;
      await repository.recordMined(candidate, receipt(candidate, now, 14));
      const resumed = (await new PostgresPaymentReceiptRepository({
        transactions: transactionRunner(databaseConnectionString),
        routerAddress: ROUTER,
      }).pendingReceipts())[0]!;
      assert.equal(resumed.finalityState, 'MINED');

      const ordinaryFinal = receipt(resumed, now, 15);
      await Promise.all([
        repository.recordFinal({
          candidate: resumed,
          observation: ordinaryFinal,
          events: [paymentEvent(ordinary, ordinaryFinal, 'ORDINARY')],
        }),
        new PostgresPaymentReceiptRepository({
          transactions: transactionRunner(databaseConnectionString),
          routerAddress: ROUTER,
        }).recordFinal({
          candidate: resumed,
          observation: ordinaryFinal,
          events: [paymentEvent(ordinary, ordinaryFinal, 'ORDINARY')],
        }),
      ]);
      assert.deepEqual((await setup.query<{
        journals: string;
        finality_rows: string;
        finality_state: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM core.ledger_journals WHERE order_id = $1) AS journals,
           (SELECT count(*)::text FROM core.transaction_finality
            WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1) AS finality_rows,
           (SELECT state FROM core.transaction_finality
            WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1) AS finality_state`,
        [ordinary.orderId],
      )).rows[0], { journals: '1', finality_rows: '1', finality_state: 'FINAL' });

      await seedSession(setup, now);
      const seckill = paymentIntent({
        orderId: `0x${'d'.repeat(64)}`,
        reservationId: `0x${'e'.repeat(64)}`,
        reservationHash: `0x${'9'.repeat(64)}`,
        issuedAt: Math.floor(now.getTime() / 1_000),
        classification: 'SECKILL',
      });
      await seedQuote(setup, seckill, 'SECKILL');
      await submitQuote(setup, seckill.orderId, TX_2);
      const seckillRepository = new PostgresPaymentReceiptRepository({
        transactions: transactionRunner(databaseConnectionString),
        routerAddress: ROUTER,
      });
      const seckillCandidate = (await seckillRepository.pendingReceipts())
        .find((item) => item.orderId === seckill.orderId)!;
      const seckillReceipt = receipt(seckillCandidate, new Date(now.getTime() + 42_000), 15);
      const initialDeadline = Math.floor((now.getTime() + 60_000) / 1_000);
      const relayDeadline = initialDeadline + 30;
      await seedUnresolvedSeckillPredecessor(setup);
      await assert.rejects(
        seckillRepository.recordFinal({
          candidate: seckillCandidate,
          observation: seckillReceipt,
          events: [
            paymentEvent(seckill, seckillReceipt, 'SECKILL'),
            relayEvent(seckill, seckillReceipt, initialDeadline + 42),
          ],
        }),
        /Earlier canonical seckill relay is not projected yet/,
      );
      await setup.query(
        "UPDATE core.transaction_finality SET state = 'FAILED' WHERE transaction_id = 'receipt-missing-predecessor'",
      );
      await assert.rejects(
        seckillRepository.recordFinal({
          candidate: seckillCandidate,
          observation: seckillReceipt,
          events: [
            paymentEvent(seckill, seckillReceipt, 'SECKILL'),
            relayEvent(seckill, seckillReceipt, relayDeadline + 1),
          ],
        }),
        /deadline does not match/,
      );
      assert.equal((await setup.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM core.payment_events WHERE order_id = $1',
        [seckill.orderId],
      )).rows[0]?.count, '0');
      assert.equal(Math.floor((await setup.query<{ relay_deadline: Date }>(
        'SELECT relay_deadline FROM core.seckill_sessions WHERE session_id = $1',
        [SESSION_ID],
      )).rows[0]!.relay_deadline.getTime() / 1_000), initialDeadline);

      await setup.query(
        "UPDATE core.seckill_sessions SET phase = 'FORCE_CLOSED' WHERE session_id = $1",
        [SESSION_ID],
      );
      await seckillRepository.recordFinal({
        candidate: seckillCandidate,
        observation: seckillReceipt,
        events: [
          paymentEvent(seckill, seckillReceipt, 'SECKILL'),
          relayEvent(seckill, seckillReceipt, relayDeadline),
        ],
      });
      assert.deepEqual((await setup.query<{
        finalized: boolean;
        payment_state: string;
        session_phase: string;
        relay_deadline: Date;
        relay_outbox: string;
      }>(
        `SELECT relay.finalized, finality.state AS payment_state,
           session.phase AS session_phase, relay.relay_deadline,
           (SELECT count(*)::text FROM core.outbox_events
            WHERE aggregate_id = $1 AND event_type = 'SeckillRelayExtended') AS relay_outbox
         FROM core.seckill_relay_events relay
         JOIN core.seckill_sessions session ON session.session_id = relay.session_id
         JOIN core.transaction_finality finality
           ON finality.resource_type = 'ORDER_PAYMENT'
          AND finality.resource_id = relay.order_id
         WHERE relay.session_id = $1`,
        [SESSION_ID],
      )).rows.map((row) => ({
        ...row,
        relay_deadline: Math.floor(row.relay_deadline.getTime() / 1_000),
      })), [{
        finalized: true,
        payment_state: 'FINAL',
        session_phase: 'FORCE_CLOSED',
        relay_deadline: relayDeadline,
        relay_outbox: '1',
      }]);

      await seedOrderingCandidates(setup);
      const ordered = (await seckillRepository.pendingReceipts()).filter((item) => (
        BigInt(item.orderId) >= 4_096n && BigInt(item.orderId) <= 4_196n
      ));
      assert.equal(ordered.length, 101);
      assert.deepEqual(
        ordered.map((item) => item.observedBlockNumber),
        Array.from({ length: 101 }, (_, index) => 1_000 + index),
      );

      await repository.recordReorged(
        { ...resumed, finalityState: 'FINAL' },
        `0x${'8'.repeat(64)}`,
      );
      assert.deepEqual((await setup.query<{
        journals: string;
        finality_state: string;
        manual_reconcile: string | null;
        breaker_paused: boolean;
        reconcile_jobs: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM core.ledger_journals WHERE order_id = $1) AS journals,
           (SELECT state FROM core.transaction_finality
            WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1) AS finality_state,
           (SELECT evidence ->> 'manualReconciliationRequired' FROM core.transaction_finality
            WHERE resource_type = 'ORDER_PAYMENT' AND resource_id = $1) AS manual_reconcile,
           (SELECT paused FROM core.circuit_breakers WHERE scope = 'NEW_PAYMENT') AS breaker_paused,
           (SELECT count(*)::text FROM core.durable_jobs
            WHERE job_type = 'RECONCILE' AND resource_id = $1) AS reconcile_jobs`,
        [ordinary.orderId],
      )).rows[0], {
        journals: '2',
        finality_state: 'REORGED',
        manual_reconcile: 'true',
        breaker_paused: true,
        reconcile_jobs: '1',
      });
    } finally {
      await setup.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

async function seedCatalog(client: Client) {
  await client.query(
    `INSERT INTO core.policy_snapshots (
       policy_version, artifact_version, policy_hash, rules_content_hash,
       beneficiary_set_hash, payload, publication_status
     ) VALUES (1,$1,$2,$2,$2,$3,'PUBLISHED')`,
    [CORE_ARTIFACT_VERSION, HASH_1, JSON.stringify(POLICY)],
  );
  await client.query(
    `INSERT INTO core.merchants (merchant_id, settlement_wallet, status, level, guarantee_status)
     VALUES ('merchant-1',$1,'APPROVED','V1','READY')`,
    [MERCHANT],
  );
  await client.query(
    `INSERT INTO core.products (
       product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
       product_policy_hash, merchant_concession_bps, metadata, subtitle,
       rich_detail, default_freight_usdt, fulfillment_modes
     ) VALUES ('product-1',$1,'merchant-1',1,'Product','ACTIVE',$2,2500,
       '{}','Receipt integration','{"blocks":[]}',0,'["DELIVERY"]')`,
    [`0x${'b'.repeat(64)}`, HASH_1],
  );
  await client.query(
    `INSERT INTO core.skus (
       sku_id, chain_sku_id, product_id, sku_version, attributes, list_price_usdt,
       merchant_cost_usdt, stock_total, stock_available, lifecycle_state
     ) VALUES ('sku-1',$1,'product-1',1,'{}',100,60,2,2,'ACTIVE')`,
    [`0x${'c'.repeat(64)}`],
  );
}

async function seedSession(client: Client, now: Date) {
  await client.query(
    `INSERT INTO core.seckill_sessions (
       session_id, policy_version, merchant_id, product_id, sku_id,
       product_policy_hash, starts_at, main_deadline, relay_deadline,
       inventory, seckill_list_price_usdt, phase, snapshot
     ) VALUES ($1,1,'merchant-1','product-1','sku-1',$2,$3,$4,$5,1,90,'LIVE','{}')`,
    [
      SESSION_ID,
      HASH_1,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 59 * 60_000),
      new Date(now.getTime() + 60_000),
    ],
  );
}

async function seedOrderingCandidates(client: Client) {
  await client.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, seckill_list_price_usdt,
       merchant_cost_usdt, merchant_concession_bps, policy_version, quote_kind,
       session_id, authorization_digest, quote_signature, deadline, state,
       submitted_tx_hash, submitted_at
     )
     SELECT
       '0x' || lpad(to_hex(4096 + candidate), 64, '0'),
       'receipt-ordering-' || candidate,
       $1, $2, 'merchant-1', $3, 'product-1', 'sku-1', $4, $5, $6,
       90, 90, 60, 2500, 1, 'SECKILL', $7, $6, '0x11',
       clock_timestamp() + interval '1 day', 'SUBMITTED',
       '0x' || lpad(to_hex(8192 + candidate), 64, '0'),
       clock_timestamp() + candidate * interval '1 millisecond'
     FROM generate_series(0, 100) AS candidate`,
    [
      CORE_ARTIFACT_VERSION,
      BUYER,
      MERCHANT,
      `0x${'b'.repeat(64)}`,
      `0x${'c'.repeat(64)}`,
      HASH_1,
      SESSION_ID,
    ],
  );
  await client.query(
    `INSERT INTO core.transaction_finality (
       transaction_id, resource_type, resource_id, chain_id, contract_address,
       expected_event_hash, tx_hash, block_number, block_hash, confirmations,
       required_confirmations, receipt_status, state, evidence, submitted_at
     )
     SELECT
       'receipt-ordering:' || candidate, 'ORDER_PAYMENT',
       '0x' || lpad(to_hex(4096 + candidate), 64, '0'), 56, $1, $2,
       '0x' || lpad(to_hex(8192 + candidate), 64, '0'),
       1100 - candidate, $2, 1, 15, 1, 'MINED',
       jsonb_build_object('paymentLogIndex', candidate), clock_timestamp()
     FROM generate_series(0, 100) AS candidate`,
    [ROUTER, HASH_1],
  );
}

async function seedUnresolvedSeckillPredecessor(client: Client) {
  const orderId = `0x${(5_000).toString(16).padStart(64, '0')}`;
  const txHash = `0x${(9_000).toString(16).padStart(64, '0')}`;
  await client.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, seckill_list_price_usdt,
       merchant_cost_usdt, merchant_concession_bps, policy_version, quote_kind,
       session_id, authorization_digest, quote_signature, deadline, state,
       submitted_tx_hash, submitted_at
     ) VALUES ($1,'receipt-missing-predecessor',$2,$3,'merchant-1',$4,
       'product-1','sku-1',$5,$6,$7,90,90,60,2500,1,'SECKILL',$8,$7,
       '0x11',clock_timestamp() + interval '1 day','SUBMITTED',$9,clock_timestamp())`,
    [
      orderId,
      CORE_ARTIFACT_VERSION,
      BUYER,
      MERCHANT,
      `0x${'b'.repeat(64)}`,
      `0x${'c'.repeat(64)}`,
      HASH_1,
      SESSION_ID,
      txHash,
    ],
  );
  await client.query(
    `INSERT INTO core.transaction_finality (
       transaction_id, resource_type, resource_id, chain_id, contract_address,
       expected_event_hash, tx_hash, confirmations, required_confirmations,
       state, evidence, submitted_at
     ) VALUES ('receipt-missing-predecessor','ORDER_PAYMENT',$1,56,$2,$3,$4,
       0,15,'SUBMITTED','{}',clock_timestamp())`,
    [orderId, ROUTER, HASH_1, txHash],
  );
}

function paymentIntent(input: {
  orderId: string;
  reservationId: string;
  reservationHash: string;
  issuedAt: number;
  classification: 'ORDINARY' | 'SECKILL';
}) {
  return buildPaymentIntent({
    orderId: input.orderId,
    latestPolicyVersion: 1,
    buyer: BUYER,
    merchant: MERCHANT,
    productId: `0x${'b'.repeat(64)}`,
    skuId: `0x${'c'.repeat(64)}`,
    quantity: 1,
    fulfillmentMode: 'DELIVERY',
    fulfillmentTargetHash: HASH_1,
    regionCodeHash: HASH_1,
    productPolicyHash: HASH_1,
    reservationId: input.reservationId,
    reservationHash: input.reservationHash,
    reservationDeadline: input.issuedAt + 120,
    issuedAt: input.issuedAt,
    deadline: input.issuedAt + 60,
    nonce: input.classification === 'ORDINARY' ? 1n : 2n,
    listPriceUsdt: input.classification === 'ORDINARY' ? 100n : 90n,
    freightUsdt: 0n,
    nplQuoteAmount: input.classification === 'ORDINARY' ? 1_000n : 900n,
    merchantConcessionBps: 2_500,
    ...(input.classification === 'SECKILL' ? { sessionId: SESSION_ID } : {}),
    beneficiaries: {
      genesis: '0x0000000000000000000000000000000000000000',
      directReferral: '0x5000000000000000000000000000000000000002',
      district: '0x5000000000000000000000000000000000000003',
      city: '0x5000000000000000000000000000000000000004',
      province: '0x5000000000000000000000000000000000000005',
      region: '0x5000000000000000000000000000000000000006',
    },
  }, parsePaymentPolicySnapshot(1, POLICY), input.classification, input.issuedAt);
}

async function seedQuote(
  client: Client,
  intent: CanonicalPaymentIntent,
  classification: 'ORDINARY' | 'SECKILL',
) {
  await reserveInventory(client, {
    reservationId: intent.reservationId,
    reservationHash: intent.reservationHash,
    policyVersion: 1,
    skuId: 'sku-1',
    buyerWallet: BUYER,
    quantity: 1,
    classification,
    ...(classification === 'SECKILL' ? { sessionId: SESSION_ID } : {}),
    expiresAt: new Date(intent.reservationDeadline * 1_000),
  });
  await client.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id,
       merchant_wallet, product_id, sku_id, chain_product_id, chain_sku_id,
       product_policy_hash, list_price_usdt, seckill_list_price_usdt,
       merchant_cost_usdt, merchant_concession_bps, policy_version, quote_kind,
       session_id, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1,$2,$3,$4,'merchant-1',$5,'product-1','sku-1',$6,$7,$8,
       100,$9,60,2500,1,$10,$11,$12,$13,$14,'QUOTED')`,
    [
      intent.orderId,
      `postgres-receipt:${intent.orderId}`,
      CORE_ARTIFACT_VERSION,
      BUYER,
      MERCHANT,
      intent.productId,
      intent.skuId,
      intent.productPolicyHash,
      classification === 'SECKILL' ? intent.listPriceUsdt : null,
      classification,
      classification === 'SECKILL' ? SESSION_ID : null,
      paymentIntentHash(intent),
      `0x${'1'.repeat(130)}`,
      new Date(intent.deadline * 1_000),
    ],
  );
  await client.query(
    `INSERT INTO core.payment_quote_legs (
       order_id, classification, reservation_id, snapshot_hash, intent,
       product_usdt_payment_amount, platform_service_fee_usdt,
       custody_product_usdt, freight_usdt, usdt_payment_amount
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      intent.orderId,
      classification,
      intent.reservationId,
      paymentIntentHash(intent),
      JSON.stringify(intent),
      intent.productUsdtPaymentAmount,
      intent.platformServiceFeeUsdt,
      intent.custodyProductUsdt,
      intent.freightUsdt,
      intent.usdtPaymentAmount,
    ],
  );
}

async function submitQuote(client: Client, orderId: string, txHash: string) {
  await client.query(
    `UPDATE core.payment_quotes SET state = 'SUBMITTED', submitted_tx_hash = $2,
       submitted_at = clock_timestamp() WHERE order_id = $1`,
    [orderId, txHash],
  );
}

function receipt(
  candidate: PaymentReceiptCandidate,
  at: Date,
  confirmations: number,
): Extract<PaymentReceiptObservation, { state: 'MINED' }> {
  return {
    state: 'MINED',
    chainId: 56,
    transactionHash: candidate.txHash,
    status: 1,
    to: ROUTER,
    block: { number: 100, hash: HASH_2, parentHash: HASH_1, timestamp: Math.floor(at.getTime() / 1_000) },
    ...(confirmations >= 15 ? {
      confirmationBlock: {
        number: 114,
        hash: `0x${'3'.repeat(64)}`,
        parentHash: `0x${'4'.repeat(64)}`,
        timestamp: Math.floor(at.getTime() / 1_000) + 42,
      },
    } : {}),
    confirmations,
    logs: [],
    paymentLogIndex: 0,
  };
}

function paymentEvent(
  intent: CanonicalPaymentIntent,
  observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>,
  classification: 'ORDINARY' | 'SECKILL',
) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    contract: 'PaymentRouterV2',
    eventName: 'PaymentCompleted',
    eventSignature: 'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
    resourceId: intent.orderId,
    contractAddress: ROUTER,
    eventHash: PAYMENT_COMPLETED_EVENT_SIGNATURE_HASH,
    transactionHash: observation.transactionHash,
    blockHash: observation.block.hash,
    blockNumber: observation.block.number,
    logIndex: 0,
    values: {
      orderId: intent.orderId,
      buyer: intent.buyer,
      merchant: intent.merchant,
      classification: classification === 'ORDINARY' ? '0' : '1',
      policyVersion: String(intent.policyVersion),
      listPriceUsdt: intent.listPriceUsdt,
      productUsdtPaid: intent.productUsdtPaymentAmount,
      platformServiceFeeUsdt: intent.platformServiceFeeUsdt,
      custodyProductUsdt: intent.custodyProductUsdt,
      freightUsdt: intent.freightUsdt,
      usdtPaid: intent.usdtPaymentAmount,
      nplPaid: intent.nplPaymentAmount,
      nplBurned: intent.nplBurnAmount,
      nplRewarded: intent.nplRewardAmount,
      bnmLocked: intent.bnmAmount,
      reservationId: intent.reservationId,
      snapshotHash: paymentIntentHash(intent),
    },
  };
}

function relayEvent(
  intent: CanonicalPaymentIntent,
  observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>,
  relayDeadline: number,
) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    contract: 'PaymentRouterV2',
    eventName: 'SeckillRelayExtended',
    eventSignature: 'SeckillRelayExtended(bytes32,bytes32,uint64)',
    resourceId: SESSION_ID,
    contractAddress: ROUTER,
    eventHash: HASH_2,
    transactionHash: observation.transactionHash,
    blockHash: observation.block.hash,
    blockNumber: observation.block.number,
    logIndex: 1,
    values: { sessionId: SESSION_ID, orderId: intent.orderId, relayDeadline: String(relayDeadline) },
  };
}

function transactionRunner(connectionString: string): SqlTransactionRunner {
  return {
    transaction: async <Result>(operation: (executor: SqlExecutor) => Promise<Result>) => {
      const client = await connected(connectionString);
      await client.query('BEGIN');
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}

async function connected(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

function requiredPostgresAdminUrl() {
  const value = process.env.POSTGRES_ADMIN_URL;
  if (!value || !/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error('POSTGRES_ADMIN_URL is required for the real PostgreSQL payment receipt gate');
  }
  return value;
}

function connectionForDatabase(connectionString: string, database: string) {
  const value = new URL(connectionString);
  value.pathname = `/${database}`;
  return value.href;
}

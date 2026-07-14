import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Interface, type InterfaceAbi } from 'ethers';
import type { CanonicalPaymentIntent } from '../api/checkout.ts';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { paymentIntentHash } from '../api/payment-signing.ts';
import { AbiEventDecoder } from '../chain/abi-decoder.ts';
import { BnmAvailabilityWorker } from '../chain/bnm-availability-worker.ts';
import { FulfillmentSchedulerWorker } from '../chain/fulfillment-scheduler-worker.ts';
import { ChainIndexer, type IndexedChainBlock } from '../chain/indexer.ts';
import { appendAuditEntry, verifyAuditChain, type AuditRow } from './audit-chain.ts';
import { PostgresNonceStore, RedisNonceRateLimiter } from './auth-store.ts';
import { CatalogPaymentService } from './catalog-payment-service.ts';
import { FulfillmentService } from './fulfillment-service.ts';
import { FulfillmentTargetService, assertQuoteFulfillmentTarget } from './fulfillment-target-service.ts';
import { PostgresIndexerStore } from './indexer-store.ts';
import { reserveInventory } from './inventory.ts';
import { applyMigrations, type SqlExecutor, type SqlTransactionRunner } from './migrations.ts';
import {
  advancePaymentFinality,
  paymentEventKey,
  PostgresPaymentStore,
  type RecordPaymentInput,
} from './payment-store.ts';
import { leaseDurableJobs } from './queue.ts';

const BUSINESS_MIGRATIONS = fileURLToPath(new URL('./migrations/business/', import.meta.url));
const AUDIT_MIGRATIONS = fileURLToPath(new URL('./migrations/audit/', import.meta.url));
const ABI_BUNDLE_PATH = fileURLToPath(
  new URL('../../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);
const HASH = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';

test('business and audit migrations apply from empty databases', async () => {
  const business = await PGlite.create();
  const audit = await PGlite.create();
  try {
    const businessNames = await applyMigrations(adapter(business), 'core', BUSINESS_MIGRATIONS);
    const auditNames = await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    assert.deepEqual(businessNames, [
      '001_core_schema.sql',
      '002_inventory_and_queue.sql',
      '003_indexer.sql',
      '004_parallel_auth_nonces.sql',
      '005_payment_ledger.sql',
      '006_fulfillment.sql',
    ]);
    assert.deepEqual(auditNames, ['001_audit_schema.sql', '002_evidence_policy.sql']);
    const businessTables = await business.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name",
    );
    assert.ok(businessTables.rows.some((row) => row.table_name === 'orders'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'outbox_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'chain_blocks'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'ledger_journals'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'payment_events'));
    assert.equal(businessTables.rows.some((row) => row.table_name === 'claim_projections'), false);
    const finalityColumns = await business.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'transaction_finality'",
    );
    assert.ok(finalityColumns.rows.some((row) => row.column_name === 'required_confirmations'));
    const auditTables = await audit.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'audit' ORDER BY table_name",
    );
    assert.deepEqual(
      auditTables.rows.map((row) => row.table_name),
      ['entries', 'schema_migrations', 'stream_heads'],
    );
    await assert.rejects(
      audit.query(
        `INSERT INTO audit.entries (
           entry_id, stream_name, sequence, event_type, resource_type, resource_id,
           correlation_id, request_hash, payload, previous_hash, entry_hash
         ) VALUES ('missing-evidence', 'financial', 1, 'PaymentIndexed', 'ORDER', 'order-1',
           'constraint-test', $1, '{}', $1, $2)`,
        ['a'.repeat(64), 'b'.repeat(64)],
      ),
      /audit_entries_stream_evidence_check/,
    );
  } finally {
    await business.close();
    await audit.close();
  }
});

test('existing rc.1 database upgrades from wallet-keyed to parallel SIWE nonces', async () => {
  const db = await PGlite.create();
  try {
    await db.exec(
      `CREATE SCHEMA core;
       CREATE TABLE core.schema_migrations (
         migration_name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       );`,
    );
    for (const name of ['001_core_schema.sql', '002_inventory_and_queue.sql']) {
      await db.exec(readFileSync(join(BUSINESS_MIGRATIONS, name), 'utf8'));
      await db.query('INSERT INTO core.schema_migrations (migration_name) VALUES ($1)', [name]);
    }
    const now = new Date('2026-07-14T00:00:00.000Z');
    await db.query(
      `INSERT INTO core.auth_nonces (
         wallet_address, nonce_hash, domain, uri, chain_id, issued_at, expires_at
       ) VALUES ($1, $2, 'mall.abu.test', 'https://mall.abu.test', 56, $3, $4)`,
      [BUYER, 'a'.repeat(64), now, new Date(now.getTime() + 60_000)],
    );
    await applyMigrations(adapter(db), 'core', BUSINESS_MIGRATIONS);
    const store = new PostgresNonceStore(adapter(db));
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'b'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    assert.ok(await store.consume(BUYER, 'a'.repeat(64), now));
    assert.ok(await store.consume(BUYER, 'b'.repeat(64), now));
  } finally {
    await db.close();
  }
});

test('PostgreSQL indexer replaces a proven segment atomically and preserves old branch evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    const store = new PostgresIndexerStore(transactionAdapter(db));
    const block100 = { number: 100, hash: HASH, parentHash: `0x${'0'.repeat(64)}`, timestamp: 1_800_000_000 };
    const block101 = { number: 101, hash: HASH_2, parentHash: HASH, timestamp: 1_800_000_001 };
    await store.appendCanonical(undefined, [{ block: block100, events: [] }, { block: block101, events: [] }]);
    assert.deepEqual(await store.canonicalAt(100), { blockNumber: 100, blockHash: HASH });
    const replacement = {
      number: 101,
      hash: `0x${'3'.repeat(64)}`,
      parentHash: HASH,
      timestamp: 1_800_000_002,
    };
    await store.replaceCanonical(
      { blockNumber: 101, blockHash: HASH_2 },
      { blockNumber: 100, blockHash: HASH },
      [{ block: replacement, events: [] }],
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: replacement.hash });
    const branches = await db.query<{ block_hash: string; canonical: boolean }>(
      'SELECT block_hash, canonical FROM core.chain_blocks WHERE block_number = 101 ORDER BY block_hash',
    );
    assert.deepEqual(branches.rows, [
      { block_hash: HASH_2, canonical: false },
      { block_hash: replacement.hash, canonical: true },
    ]);

    const failingStore = new PostgresIndexerStore(
      transactionAdapter(db, (sql) => {
        if (sql.startsWith('INSERT INTO core.chain_blocks')) throw new Error('InjectedIndexerFailure');
      }),
    );
    await assert.rejects(
      failingStore.replaceCanonical(
        { blockNumber: 101, blockHash: replacement.hash },
        { blockNumber: 100, blockHash: HASH },
        [{ block: { ...replacement, hash: `0x${'4'.repeat(64)}` }, events: [] }],
      ),
      /InjectedIndexerFailure/,
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: replacement.hash });
  } finally {
    await db.close();
  }
});

test('PostgreSQL indexer atomically projects payment, rolls back a bad reorg and reaches 15 confirmations', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresIndexerStore(transactionAdapter(db));
    const block99 = chainBlock(99, blockHash(99), blockHash(98), intent.issuedAt - 1);
    const original100 = chainBlock(100, blockHash(100), block99.block.hash, intent.issuedAt);
    await store.appendCanonical(undefined, [block99, {
      ...original100,
      events: [decodedPaymentEvent(intent, original100.block.hash)],
    }]);
    assert.deepEqual(await store.checkpoint(), { blockNumber: 100, blockHash: original100.block.hash });
    await assertLedgerBalanced(db, 1);

    const replacement100 = chainBlock(100, blockHash(1_100), block99.block.hash, intent.issuedAt + 1);
    const invalidEvent = decodedPaymentEvent(intent, replacement100.block.hash);
    invalidEvent.values.snapshotHash = HASH;
    await assert.rejects(
      store.replaceCanonical(
        { blockNumber: 100, blockHash: original100.block.hash },
        { blockNumber: 99, blockHash: block99.block.hash },
        [{ ...replacement100, events: [invalidEvent] }],
      ),
      /signed quote leg/,
    );
    assert.deepEqual(await store.checkpoint(), { blockNumber: 100, blockHash: original100.block.hash });
    await assertLedgerBalanced(db, 1);

    await store.replaceCanonical(
      { blockNumber: 100, blockHash: original100.block.hash },
      { blockNumber: 99, blockHash: block99.block.hash },
      [{ ...replacement100, events: [decodedPaymentEvent(intent, replacement100.block.hash)] }],
    );
    const canonical = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.payment_events WHERE canonical',
    );
    assert.equal(canonical.rows[0]?.count, '1');
    await assertLedgerBalanced(db, 1);

    const confirmations: IndexedChainBlock[] = [];
    let parentHash = replacement100.block.hash;
    for (let number = 101; number <= 114; number += 1) {
      const block = chainBlock(number, blockHash(1_000 + number), parentHash, intent.issuedAt + number - 99);
      confirmations.push(block);
      parentHash = block.block.hash;
    }
    await store.appendCanonical({ blockNumber: 100, blockHash: replacement100.block.hash }, confirmations);
    const final = await db.query<{ confirmations: string; finality_status: string; state: string; finalized_at: Date }>(
      `SELECT payment.confirmations::text, orders.finality_status, finality.state, finality.finalized_at
       FROM core.payment_events payment
       JOIN core.orders orders ON orders.order_id = payment.order_id
       JOIN core.transaction_finality finality ON finality.transaction_id = 'payment:' || payment.event_key
       WHERE payment.canonical`,
    );
    assert.deepEqual(final.rows[0], {
      confirmations: '15',
      finality_status: 'FINAL',
      state: 'FINAL',
      finalized_at: new Date((intent.issuedAt + 15) * 1000),
    });
  } finally {
    await db.close();
  }
});

test('generated PaymentRouter ABI decodes through the Indexer into a balanced PostgreSQL payment journal', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);

    const routerAddress = '0x9999999999999999999999999999999999999999';
    const bundle = JSON.parse(readFileSync(ABI_BUNDLE_PATH, 'utf8')) as {
      contracts: { PaymentRouterV2: InterfaceAbi };
    };
    const router = new Interface(bundle.contracts.PaymentRouterV2);
    const paymentCompleted = router.getEvent('PaymentCompleted');
    assert.ok(paymentCompleted);
    const encoded = router.encodeEventLog(paymentCompleted, [
      intent.orderId,
      intent.buyer,
      intent.merchant,
      0,
      intent.policyVersion,
      intent.listPriceUsdt,
      intent.usdtPaymentAmount,
      intent.nplPaymentAmount,
      intent.nplBurnAmount,
      intent.nplRewardAmount,
      intent.bnmAmount,
      intent.reservationId,
      paymentIntentHash(intent),
    ]);
    const block99 = chainBlock(99, blockHash(99), blockHash(98), intent.issuedAt - 1);
    const block100 = chainBlock(100, blockHash(100), block99.block.hash, intent.issuedAt);
    const confirmationBlocks: IndexedChainBlock[] = [];
    let confirmationParent = block100.block.hash;
    for (let number = 101; number <= 114; number += 1) {
      const confirmation = chainBlock(
        number,
        blockHash(number),
        confirmationParent,
        intent.issuedAt + number - 100,
      );
      confirmationBlocks.push(confirmation);
      confirmationParent = confirmation.block.hash;
    }
    const decoder = await AbiEventDecoder.load(ABI_BUNDLE_PATH, { PaymentRouterV2: routerAddress });
    const indexer = new ChainIndexer(decoder, new PostgresIndexerStore(transactionAdapter(db)));
    await indexer.ingestSegment([
      { block: block99.block, logs: [] },
      {
        block: block100.block,
        logs: [{
          address: routerAddress,
          topics: encoded.topics,
          data: encoded.data,
          transactionHash: `0x${'6'.repeat(64)}`,
          blockHash: block100.block.hash,
          blockNumber: block100.block.number,
          logIndex: 0,
        }],
      },
      ...confirmationBlocks.map(({ block }) => ({ block, logs: [] })),
    ]);
    const projection = await db.query<{
      classification: string;
      confirmations: string;
      canonical: boolean;
      finalized_at: Date;
    }>(
      `SELECT payment.classification, payment.confirmations::text, payment.canonical, finality.finalized_at
       FROM core.payment_events payment
       JOIN core.transaction_finality finality ON finality.resource_id = payment.order_id
       WHERE payment.order_id = $1`,
      [intent.orderId],
    );
    assert.deepEqual(projection.rows[0], {
      classification: 'ORDINARY',
      confirmations: '15',
      canonical: true,
      finalized_at: new Date((intent.issuedAt + 14) * 1000),
    });
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('inventory reservation is atomic, idempotent and cannot oversell', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const expiresAt = new Date(Date.now() + 60_000);
    const common = {
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY' as const,
      expiresAt,
    };
    const attempts = await Promise.allSettled([
      reserveInventory(adapter(db), { ...common, reservationId: 'reservation-a', reservationHash: HASH }),
      reserveInventory(adapter(db), { ...common, reservationId: 'reservation-b', reservationHash: HASH_2 }),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    const stock = await db.query<{ stock_available: number; stock_reserved: number }>(
      "SELECT stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_available: 0, stock_reserved: 1 });

    const winner = attempts.find((result) => result.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    const replay = await reserveInventory(adapter(db), {
      ...common,
      reservationId: winner.value.reservation_id,
      reservationHash: winner.value.reservation_id === 'reservation-a' ? HASH : HASH_2,
    });
    assert.equal(replay.reservation_id, winner.value.reservation_id);
    const count = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.inventory_reservations');
    assert.equal(count.rows[0]?.count, '1');
  } finally {
    await db.close();
  }
});

test('two PaymentCompleted logs in one transaction keep independent finality records', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    const first = paymentIntent();
    const second: CanonicalPaymentIntent = {
      ...paymentIntent(),
      orderId: `0x${'7'.repeat(64)}`,
      reservationId: `0x${'8'.repeat(64)}`,
      reservationHash: `0x${'9'.repeat(64)}`,
      nonce: '2',
    };
    for (const intent of [first, second]) {
      await reserveInventory(adapter(db), {
        reservationId: intent.reservationId,
        reservationHash: intent.reservationHash,
        policyVersion: 1,
        skuId: 'sku-1',
        buyerWallet: BUYER,
        quantity: 1,
        classification: 'ORDINARY',
        expiresAt: new Date(intent.reservationDeadline * 1000),
      });
    }
    await insertPaymentQuote(db, first, 'same-tx-order-1');
    await insertPaymentQuote(db, second, 'same-tx-order-2');
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await store.record(paymentInput(first));
    const secondInput = paymentInput(second);
    secondInput.event.logIndex = 1;
    await store.record(secondInput);

    const rows = await db.query<{ resource_id: string; tx_hash: string; state: string }>(
      `SELECT resource_id, tx_hash, state FROM core.transaction_finality
       WHERE resource_type = 'ORDER_PAYMENT' ORDER BY resource_id`,
    );
    assert.deepEqual(rows.rows, [
      { resource_id: second.orderId, tx_hash: secondInput.event.transactionHash, state: 'FINAL' },
      { resource_id: first.orderId, tx_hash: secondInput.event.transactionHash, state: 'FINAL' },
    ]);
  } finally {
    await db.close();
  }
});

test('seckill and fallback reservations use independent session and retail inventory', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const sessionId = `0x${'f'.repeat(64)}`;
    const now = new Date();
    await db.query(
      `INSERT INTO core.seckill_sessions (
         session_id, policy_version, merchant_id, product_id, sku_id,
         product_policy_hash, starts_at, main_deadline, relay_deadline,
         inventory, seckill_list_price_usdt, phase, snapshot
       ) VALUES ($1, 1, 'merchant-1', 'product-1', 'sku-1', $2,
         $3, $4, $5, 1, 80, 'LIVE', '{}')`,
      [
        sessionId,
        HASH,
        new Date(now.getTime() - 60_000),
        new Date(now.getTime() + 59 * 60_000),
        new Date(now.getTime() + 60_000),
      ],
    );
    await reserveInventory(adapter(db), {
      reservationId: 'seckill-reservation',
      reservationHash: HASH,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'SECKILL',
      sessionId,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await reserveInventory(adapter(db), {
      reservationId: 'fallback-reservation',
      reservationHash: HASH_2,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'FALLBACK_RETAIL',
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    const reserved = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(reserved.rows[0], { stock_available: 0, stock_reserved: 1, session_reserved: 1, sold: 0 });
    await db.query('SELECT core.consume_inventory_reservation_at($1, $2, $3)', [
      'seckill-reservation',
      `0x${'a'.repeat(64)}`,
      now,
    ]);
    await db.query("SELECT core.release_inventory_reservation('fallback-reservation', 'RELEASED')");
    const consumed = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(consumed.rows[0], { stock_available: 1, stock_reserved: 0, session_reserved: 0, sold: 1 });
    await db.query("SELECT core.restore_reorged_inventory_reservation('seckill-reservation')");
    const restored = await db.query<{ reserved: number; sold: number }>(
      'SELECT reserved, sold FROM core.seckill_sessions WHERE session_id = $1',
      [sessionId],
    );
    assert.deepEqual(restored.rows[0], { reserved: 1, sold: 0 });
  } finally {
    await db.close();
  }
});

test('catalog payment service builds an authoritative idempotent quote and records transaction replacement', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    const quoteNow = new Date();
    let signCalls = 0;
    const ids = [`0x${'9'.repeat(64)}`, `0x${'d'.repeat(64)}`];
    const service = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: {
        sign: async (request) => {
          signCalls += 1;
          assert.equal(request.purpose, 'ORDER_QUOTE');
          return { signature: `0x${'1'.repeat(130)}`, signer: '0x8888888888888888888888888888888888888888' };
        },
      },
      oracle: {
        quote: async ({ oracleVersion }) => ({ nplQuoteAmount: 1_000n, oracleVersion }),
      },
      beneficiaries: {
        resolve: async () => ({
          genesis: '0x5000000000000000000000000000000000000001',
          directReferral: '0x5000000000000000000000000000000000000002',
          district: '0x5000000000000000000000000000000000000003',
          city: '0x5000000000000000000000000000000000000004',
          province: '0x5000000000000000000000000000000000000005',
          region: '0x5000000000000000000000000000000000000006',
        }),
      },
      policies: { assertPublished: async () => undefined },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => quoteNow,
      bytes32: () => ids.shift()!,
      nonce: () => 7n,
    });
    const request = {
      idempotencyKey: 'checkout-attempt-1',
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY' as const,
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    const catalog = await service.listCatalog();
    assert.equal(catalog[0]?.skus[0]?.listPriceUsdt, '100');
    assert.equal('merchantCostUsdt' in (catalog[0]?.skus[0] ?? {}), false);

    const quote = await service.createOrdinaryQuote(BUYER, request);
    assert.equal(quote.intent.usdtPaymentAmount, '70');
    assert.equal(quote.intent.nplPaymentAmount, '300');
    assert.equal(quote.intent.productId, `0x${'b'.repeat(64)}`);
    assert.equal(quote.snapshotHash, paymentIntentHash(quote.intent));
    assert.equal(quote.approvalRequirements[0]?.requiredAmount, '70');
    assert.equal(quote.approvalRequirements[0]?.approvalMode, 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED');
    assert.equal(quote.approvalRequirements[0]?.revocation.method, 'ERC20_APPROVE_ZERO');
    assert.equal((await service.createOrdinaryQuote(BUYER, request)).orderId, quote.orderId);
    assert.equal(signCalls, 1);
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, quantity: 2 }),
      /Idempotency key was used for a different quote/,
    );
    const stock = await db.query<{ stock_available: number; stock_reserved: number }>(
      "SELECT stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_available: 1, stock_reserved: 1 });
    await db.query(
      `INSERT INTO core.circuit_breakers (scope, paused, evidence_hash, policy_version, changed_by)
       VALUES ('NEW_PAYMENT', true, $1, 1, 'test')`,
      [HASH],
    );
    await assert.rejects(
      service.createOrdinaryQuote(BUYER, { ...request, idempotencyKey: 'checkout-attempt-2' }),
      /New payments are paused/,
    );

    const firstTx = `0x${'6'.repeat(64)}`;
    const replacementTx = `0x${'7'.repeat(64)}`;
    assert.equal((await service.submitPayment(BUYER, { orderId: quote.orderId, txHash: firstTx })).state, 'SUBMITTED');
    await assert.rejects(
      service.submitPayment(BUYER, { orderId: quote.orderId, txHash: replacementTx }),
      /Replacement transaction does not match/,
    );
    await service.submitPayment(BUYER, {
      orderId: quote.orderId,
      txHash: replacementTx,
      replacementForTxHash: firstTx,
    });
    const projection = await service.getPayment(BUYER, quote.orderId);
    assert.equal(projection.state, 'SUBMITTED');
    assert.equal(projection.submittedTxHash, replacementTx);
    await db.query("UPDATE core.payment_quotes SET state = 'REORGED' WHERE order_id = $1", [quote.orderId]);
    const reorgReplacement = `0x${'9'.repeat(64)}`;
    assert.equal((await service.submitPayment(BUYER, {
      orderId: quote.orderId,
      txHash: reorgReplacement,
      replacementForTxHash: replacementTx,
    })).state, 'SUBMITTED');
  } finally {
    await db.close();
  }
});

test('seckill quote locks both inventories and final classification releases the unused fallback leg', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const now = new Date();
    const sessionId = `0x${'f'.repeat(64)}`;
    await insertLiveSeckillSession(db, sessionId, now, 90);
    const ids = [`0x${'8'.repeat(64)}`, `0x${'d'.repeat(64)}`, `0x${'e'.repeat(64)}`];
    let signCalls = 0;
    const service = new CatalogPaymentService({
      transactions: transactionAdapter(db),
      signer: {
        sign: async () => {
          signCalls += 1;
          return {
            signature: `0x${'1'.repeat(130)}`,
            signer: '0x8888888888888888888888888888888888888888',
          };
        },
      },
      oracle: {
        quote: async ({ listPriceUsdt, oracleVersion }) => ({
          nplQuoteAmount: listPriceUsdt * 10n,
          oracleVersion,
        }),
      },
      beneficiaries: {
        resolve: async () => ({
          genesis: '0x5000000000000000000000000000000000000001',
          directReferral: '0x5000000000000000000000000000000000000002',
          district: '0x5000000000000000000000000000000000000003',
          city: '0x5000000000000000000000000000000000000004',
          province: '0x5000000000000000000000000000000000000005',
          region: '0x5000000000000000000000000000000000000006',
        }),
      },
      policies: { assertPublished: async () => undefined },
      paymentRouterAddress: '0x9999999999999999999999999999999999999999',
      clock: () => now,
      bytes32: () => ids.shift()!,
      nonce: () => 9n,
    });
    const request = {
      idempotencyKey: 'seckill-attempt-1',
      sessionId,
      productId: 'product-1',
      skuId: 'sku-1',
      quantity: 1,
      fulfillmentMode: 'DELIVERY' as const,
      fulfillmentTargetHash: HASH,
      regionCodeHash: HASH,
    };
    const quote = await service.createSeckillQuote(BUYER, request);
    assert.equal(quote.dual.seckill.listPriceUsdt, '90');
    assert.equal(quote.dual.fallback.listPriceUsdt, '100');
    assert.deepEqual(
      quote.approvalRequirements.map((item) => item.requiredAmount),
      ['70', '300'],
    );
    const repeated = await service.createSeckillQuote(BUYER, request);
    assert.equal(repeated.orderId, quote.orderId);
    assert.equal(repeated.dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');
    assert.equal(signCalls, 1);
    const reserved = await db.query<{ stock_reserved: number; session_reserved: number }>(
      `SELECT sku.stock_reserved, session.reserved AS session_reserved
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(reserved.rows[0], { stock_reserved: 1, session_reserved: 1 });

    const event = paymentInput(quote.dual.seckill, 'SECKILL');
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await store.record(event);
    await advancePaymentFinality(adapter(db), event.event.blockNumber + 14);
    const inventory = await db.query<{
      stock_available: number;
      stock_reserved: number;
      session_reserved: number;
      sold: number;
    }>(
      `SELECT sku.stock_available, sku.stock_reserved, session.reserved AS session_reserved, session.sold
       FROM core.skus sku JOIN core.seckill_sessions session ON session.sku_id = sku.sku_id`,
    );
    assert.deepEqual(inventory.rows[0], { stock_available: 1, stock_reserved: 0, session_reserved: 0, sold: 1 });
    const projection = await service.getPayment(BUYER, quote.orderId);
    assert.ok('dual' in projection);
    assert.equal(projection.dual.classificationAuthority, 'PAYMENT_ROUTER_BLOCK_TIMESTAMP');
    assert.deepEqual(projection.finality, {
      transactionHash: event.event.transactionHash,
      replacementForTxHash: null,
      blockNumber: event.event.blockNumber,
      blockHash: event.event.blockHash,
      confirmations: 15,
      requiredConfirmations: 15,
      receiptStatus: 1,
      state: 'FINAL',
      canonicalBlock: true,
      classification: 'SECKILL',
    });
    await assertLedgerBalanced(db, 1, { usdt: 63n, nplReward: 90n, bnm: 90n });

    const fulfillment = new FulfillmentService({
      transactions: transactionAdapter(db),
      clock: () => new Date(event.event.finalizedAt!.getTime() + 60_000),
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const arbitrator = { walletAddress: '0x4444444444444444444444444444444444444444', roles: ['ARBITRATOR'] as const };
    await fulfillment.recordShipment(merchant, quote.orderId, {
      idempotencyKey: 'seckill-prize-shipment',
      evidenceHash: `0x${'8'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'7'.repeat(64)}`,
    });
    await fulfillment.openArbitration(buyer, quote.orderId, {
      idempotencyKey: 'seckill-prize-arbitration',
      evidenceHash: `0x${'7'.repeat(64)}`,
      reasonCode: 'SECKILL_DELIVERY_DISPUTE',
    });
    assert.deepEqual(await purposeBalances(db, quote.orderId, 'SECKILL_PRIZE_LIABILITY'), {
      DISPUTED: '2',
    });
    await fulfillment.decideArbitration(arbitrator, quote.orderId, {
      idempotencyKey: 'seckill-prize-fulfill',
      evidenceHash: `0x${'8'.repeat(64)}`,
      outcome: 'FULFILL',
      noteCode: 'PRIZE_REMAINS_LOCKED',
    });
    assert.deepEqual(await purposeBalances(db, quote.orderId, 'SECKILL_PRIZE_LIABILITY'), {
      LOCKED: '2',
    });
    assert.deepEqual(await liabilityStates(db, quote.orderId, 'AVAILABLE'), {
      BNM_POINTS: '90',
      NPL: '90',
      USDT: '61',
    });
    assert.deepEqual(await liabilityStates(db, quote.orderId, 'LOCKED'), { USDT: '2' });

    const selectedEventKey = paymentEventKey(
      event.event.transactionHash,
      event.event.logIndex,
      event.event.blockHash,
    );
    const replacementBlockHash = `0x${'4'.repeat(64)}`;
    await store.reverse(selectedEventKey, replacementBlockHash);
    for (const state of ['LOCKED', 'AVAILABLE', 'DISPUTED']) {
      assert.deepEqual(await liabilityStates(db, quote.orderId, state), {});
    }
    const fallbackEvent = paymentInput(quote.dual.fallback, 'FALLBACK_RETAIL');
    fallbackEvent.event.transactionHash = `0x${'3'.repeat(64)}`;
    fallbackEvent.event.blockHash = replacementBlockHash;
    fallbackEvent.event.blockNumber += 1;
    assert.deepEqual(await store.record(fallbackEvent), {
      status: 'QUARANTINED',
      orderId: quote.orderId,
    });
    const recovery = await db.query<{ state: string; classification: string; jobs: string }>(
      `SELECT reservation.state, reservation.classification,
         (SELECT count(*)::text FROM core.durable_jobs WHERE resource_id = $1) AS jobs
       FROM core.inventory_reservations reservation
       WHERE reservation.reservation_id IN ($2, $3)
       ORDER BY reservation.classification DESC`,
      [quote.orderId, quote.dual.seckill.reservationId, quote.dual.fallback.reservationId],
    );
    assert.deepEqual(recovery.rows, [
      { state: 'CONSUMED', classification: 'SECKILL', jobs: '2' },
      { state: 'RELEASED', classification: 'FALLBACK_RETAIL', jobs: '2' },
    ]);
    await assertLedgerBalanced(db, 0, { usdt: 63n, nplReward: 90n, bnm: 90n });
  } finally {
    await db.close();
  }
});

test('payment event atomically consumes inventory and posts balanced Locked journals with reorg recovery', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    const input = paymentInput(intent);
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresPaymentStore(transactionAdapter(db));
    const recorded = await store.record(input);
    assert.equal(recorded.status, 'RECORDED');
    assert.equal((await store.record(input)).status, 'IDEMPOTENT');
    const stock = await db.query<{ stock_total: number; stock_available: number; stock_reserved: number }>(
      "SELECT stock_total, stock_available, stock_reserved FROM core.skus WHERE sku_id = 'sku-1'",
    );
    assert.deepEqual(stock.rows[0], { stock_total: 0, stock_available: 0, stock_reserved: 0 });
    await assertLedgerBalanced(db, 1);

    const replacementBlockHash = `0x${'8'.repeat(64)}`;
    const eventKey = paymentEventKey(input.event.transactionHash, 0, input.event.blockHash);
    assert.equal((await store.reverse(eventKey, replacementBlockHash)).status, 'REVERSED');
    assert.equal((await store.reverse(eventKey, replacementBlockHash)).status, 'IDEMPOTENT');
    const restored = await db.query<{ state: string; stock_total: number; stock_reserved: number }>(
      `SELECT reservation.state, sku.stock_total, sku.stock_reserved
       FROM core.inventory_reservations reservation
       JOIN core.skus sku ON sku.sku_id = reservation.sku_id
       WHERE reservation.reservation_id = $1`,
      [intent.reservationId],
    );
    assert.deepEqual(restored.rows[0], { state: 'CONSUMED', stock_total: 0, stock_reserved: 0 });
    await assertLedgerBalanced(db, 0);

    const replacement: RecordPaymentInput = {
      ...input,
      event: {
        ...input.event,
        transactionHash: `0x${'9'.repeat(64)}`,
        blockHash: replacementBlockHash,
        replacementForTxHash: input.event.transactionHash,
      },
    };
    assert.equal((await store.record(replacement)).status, 'RECORDED');
    const canonical = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.payment_events WHERE order_id = $1 AND canonical",
      [intent.orderId],
    );
    assert.equal(canonical.rows[0]?.count, '1');
    await assertLedgerBalanced(db, 1);

    await assert.rejects(
      db.query(
        `SELECT core.post_balanced_journal(
           'bad-journal','bad-event','PAYMENT_LOCKED',$1,1,$2,$3,$4,NULL,'{}',
           '[{"account_id":"safe:usdt-custody:0x3333333333333333333333333333333333333333:usdt","side":"DEBIT","amount":"1","balance_state":"POSTED"}]'
         )`,
        [intent.orderId, HASH, input.event.transactionHash, input.event.blockHash],
      ),
      /InvalidLedgerLines/,
    );
  } finally {
    await db.close();
  }
});

test('payment projection rejects a snapshot whose off-chain allocations differ from frozen policy', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const original = paymentIntent();
    const intent: CanonicalPaymentIntent = {
      ...original,
      otherUsdtAllocations: [
        { account: '0x7999999999999999999999999999999999999999', amount: '10', purpose: 'POLICY_ALLOCATION' },
      ],
    };
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await assert.rejects(store.record(paymentInput(intent)), /does not match authoritative catalog and policy/);
    const journals = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.ledger_journals');
    assert.equal(journals.rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('payment projection rejects a ledger account identity bound to different Safe metadata', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 1);
    const intent = paymentIntent();
    await reserveInventory(adapter(db), {
      reservationId: intent.reservationId,
      reservationHash: intent.reservationHash,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(intent.reservationDeadline * 1000),
    });
    await insertPaymentQuote(db, intent);
    await db.query(
      `INSERT INTO core.ledger_accounts (
         account_id, owner_type, owner_id, asset, purpose, safe_address
       ) VALUES ($1, 'SAFE', $2, 'USDT', 'SAFE_ASSET', $2)`,
      [
        'safe:usdt-custody:0x3333333333333333333333333333333333333333:usdt',
        '0x9999999999999999999999999999999999999999',
      ],
    );
    const store = new PostgresPaymentStore(transactionAdapter(db));
    await assert.rejects(store.record(paymentInput(intent)), /immutable account identity/);
    const journals = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM core.ledger_journals');
    assert.equal(journals.rows[0]?.count, '0');
  } finally {
    await db.close();
  }
});

test('fulfillment targets encrypt delivery PII and bind quotes to an AMap six-digit region or active store snapshot', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 3);
    let regionCalls = 0;
    const regions = {
      reverseGeocode: async () => {
        regionCalls += 1;
        return {
          regionCode: '310101',
          province: 'Shanghai',
          city: 'Shanghai',
          district: 'Huangpu',
          formattedAddress: 'Shanghai Huangpu Test Road 1',
          sourceReferenceHash: HASH_2,
        };
      },
    };
    const service = new FulfillmentTargetService({
      transactions: transactionAdapter(db),
      regions,
      encryptionKey: 'ab'.repeat(32),
      clock: () => new Date(),
    });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const store = await service.createStore(merchant, {
      idempotencyKey: 'store-create-command-1',
      name: 'Huangpu Store',
      phone: '+862112345678',
      longitude: 121.4737,
      latitude: 31.2304,
    });
    assert.equal((await service.createStore(merchant, {
      idempotencyKey: 'store-create-command-1',
      name: 'Huangpu Store',
      phone: '+862112345678',
      longitude: 121.4737,
      latitude: 31.2304,
    })).storeId, store.storeId);
    assert.equal(regionCalls, 1);

    const delivery = await service.createDeliveryTarget(buyer, {
      idempotencyKey: 'delivery-target-command-1',
      recipientName: 'Test Recipient',
      phone: '+8613800000000',
      address: 'Test Road 1 Building 2 Room 3',
      longitude: 121.4737,
      latitude: 31.2304,
    });
    assert.equal((await service.createDeliveryTarget(buyer, {
      idempotencyKey: 'delivery-target-command-1',
      recipientName: 'Test Recipient',
      phone: '+8613800000000',
      address: 'Test Road 1 Building 2 Room 3',
      longitude: 121.4737,
      latitude: 31.2304,
    })).targetHash, delivery.targetHash);
    assert.equal(regionCalls, 2);
    const encrypted = await db.query<{ payload_hex: string }>(
      `SELECT encode(encrypted_payload, 'hex') AS payload_hex
       FROM core.fulfillment_targets WHERE target_hash = $1`,
      [delivery.targetHash],
    );
    assert.equal(encrypted.rows[0]?.payload_hex.includes(Buffer.from('Test Recipient').toString('hex')), false);
    assert.equal(encrypted.rows[0]?.payload_hex.includes(Buffer.from('+8613800000000').toString('hex')), false);
    await assertQuoteFulfillmentTarget(adapter(db), {
      buyerWallet: BUYER,
      fulfillmentMode: 'DELIVERY',
      fulfillmentTargetHash: delivery.targetHash,
      regionCodeHash: delivery.regionCodeHash,
      now: new Date(),
    });
    await assert.rejects(
      assertQuoteFulfillmentTarget(adapter(db), {
        buyerWallet: BUYER,
        fulfillmentMode: 'DELIVERY',
        fulfillmentTargetHash: delivery.targetHash,
        regionCodeHash: HASH,
        now: new Date(),
      }),
      /mismatched/,
    );

    const reservationId = `0x${'7'.repeat(64)}`;
    await reserveInventory(adapter(db), {
      reservationId,
      reservationHash: `0x${'8'.repeat(64)}`,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const targetOrderId = `0x${'9'.repeat(64)}`;
    await insertOrder(db, targetOrderId, reservationId, delivery.targetHash, delivery.regionCodeHash);
    const detail = await service.getOrderTarget(buyer, targetOrderId);
    assert.equal(detail.payload.recipientName, 'Test Recipient');
    await assert.rejects(
      service.getOrderTarget(
        { walletAddress: '0x9999999999999999999999999999999999999999', roles: ['BUYER'] },
        targetOrderId,
      ),
      /outside the authenticated wallet scope/,
    );
    await assert.rejects(
      service.getOrderTarget(
        { walletAddress: '0x9999999999999999999999999999999999999999', roles: ['AUDITOR'] },
        targetOrderId,
      ),
      /outside the authenticated wallet scope/,
    );

    const pickup = await service.createPickupTarget(buyer, {
      idempotencyKey: 'pickup-target-command-1',
      storeId: store.storeId,
    });
    assert.equal(pickup.fulfillmentMode, 'PICKUP');
    assert.equal(pickup.storeId, store.storeId);
    assert.equal(pickup.store.regionCode, '310101');
    assert.equal((await service.listStores('310101')).length, 1);
    assert.throws(
      () => new FulfillmentTargetService({ transactions: transactionAdapter(db), regions, encryptionKey: 'short' }),
      /must contain 32 bytes/,
    );
  } finally {
    await db.close();
  }
});

test('fulfillment service keeps evidence append-only and unlocks every order liability only after receipt', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };

    const shipment = await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'shipment-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    assert.equal(shipment.state, 'SHIPPED');
    assert.deepEqual(
      await service.recordShipment(merchant, intent.orderId, {
        idempotencyKey: 'shipment-command-1',
        evidenceHash: `0x${'3'.repeat(64)}`,
        carrierCode: 'SF',
        trackingNumberHash: `0x${'4'.repeat(64)}`,
      }),
      shipment,
    );
    await assert.rejects(
      service.recordShipment(merchant, intent.orderId, {
        idempotencyKey: 'shipment-command-1',
        evidenceHash: `0x${'5'.repeat(64)}`,
        carrierCode: 'SF',
        trackingNumberHash: `0x${'4'.repeat(64)}`,
      }),
      /idempotency key was reused/i,
    );

    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'logistics-transit-command-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'a'.repeat(64)}`,
      status: 'IN_TRANSIT',
      occurredAt: now,
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'logistics-delivered-command-1',
      evidenceHash: `0x${'b'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'c'.repeat(64)}`,
      status: 'DELIVERED',
      occurredAt: now,
    });
    const exchange = await service.requestExchange(buyer, intent.orderId, {
      idempotencyKey: 'exchange-request-command-1',
      evidenceHash: `0x${'d'.repeat(64)}`,
      reasonCode: 'SIZE_MISMATCH',
    });
    await service.decideFulfillmentRequest(merchant, intent.orderId, {
      idempotencyKey: 'exchange-approval-command-1',
      evidenceHash: `0x${'e'.repeat(64)}`,
      requestId: exchange.requestId,
      approved: true,
      noteCode: 'REPLACEMENT_APPROVED',
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'replacement-shipment-command-1',
      evidenceHash: `0x${'f'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'1'.repeat(64)}`,
    });
    now = new Date(now.getTime() + 30_000);
    await service.recordLogisticsUpdate(operator, intent.orderId, {
      idempotencyKey: 'replacement-delivered-command-1',
      evidenceHash: `0x${'2'.repeat(64)}`,
      provider: 'KUAIDI100',
      providerEventIdHash: `0x${'3'.repeat(64)}`,
      status: 'DELIVERED',
      occurredAt: now,
    });
    await service.requestDelay(buyer, intent.orderId, {
      idempotencyKey: 'delay-request-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'CUSTOMER_SCHEDULE',
    });

    const lockedBeforeReceipt = await liabilityStates(db, intent.orderId, 'LOCKED');
    assert.deepEqual(lockedBeforeReceipt, { BNM_POINTS: '100', NPL: '100', USDT: '70' });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {});

    now = new Date(now.getTime() + 60_000);
    const fulfilled = await service.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'receipt-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
    });
    assert.deepEqual(
      { state: fulfilled.state, method: fulfilled.method },
      { state: 'FULFILLED', method: 'CUSTOMER_RECEIPT' },
    );
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {});
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    const projection = await service.getOrder(buyer, intent.orderId);
    assert.equal(projection.state, 'FULFILLED');
    assert.equal(projection.requests[0]?.state, 'RESOLVED');
    assert.deepEqual(
      projection.shipments.map((shipment) => shipment.trackingNumberHash),
      [`0x${'4'.repeat(64)}`, `0x${'1'.repeat(64)}`],
    );
    assert.deepEqual(projection.logistics.map((event) => event.status), ['IN_TRANSIT', 'DELIVERED', 'DELIVERED']);
    await assertLedgerBalanced(db, 1);
    await assert.rejects(
      db.query("UPDATE core.fulfillment_commands SET result = '{}' WHERE command_id LIKE 'command:%'"),
      /ImmutableRecord/,
    );

    const bnmStates: string[] = [];
    const bnmWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      adapter: {
        setState: async (input) => {
          bnmStates.push(input.state);
          return {
            providerReference: `bnm:${input.orderId}:${input.state}`,
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
      workerId: 'bnm-test-worker',
    });
    assert.equal(await bnmWorker.pollOnce(), 1);
    assert.deepEqual(bnmStates, ['AVAILABLE']);

    now = new Date(now.getTime() + 60_000);
    const payment = paymentInput(intent);
    await new PostgresPaymentStore(transactionAdapter(db)).reverse(
      paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
      `0x${'9'.repeat(64)}`,
    );
    for (const state of ['LOCKED', 'AVAILABLE', 'DISPUTED']) {
      assert.deepEqual(await liabilityStates(db, intent.orderId, state), {});
    }
    assert.equal((await service.getOrder(buyer, intent.orderId)).state, 'REORG_PENDING');
    assert.equal(await bnmWorker.pollOnce(), 1);
    assert.deepEqual(bnmStates, ['AVAILABLE', 'LOCKED']);
    const bnmSync = await db.query<{ state: string }>(
      'SELECT state FROM core.bnm_state_syncs WHERE order_id = $1 ORDER BY synced_at, sync_id',
      [intent.orderId],
    );
    assert.deepEqual(bnmSync.rows.map((row) => row.state), ['AVAILABLE', 'LOCKED']);
    await assertLedgerBalanced(db, 0);
  } finally {
    await db.close();
  }
});

test('arbitration moves Locked liabilities to Disputed and only an arbitrator can resume or fulfill', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const arbitrator = { walletAddress: '0x4444444444444444444444444444444444444444', roles: ['ARBITRATOR'] as const };

    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'shipment-arbitration-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    const exchange = await service.requestExchange(buyer, intent.orderId, {
      idempotencyKey: 'exchange-before-arbitration',
      evidenceHash: `0x${'4'.repeat(64)}`,
      reasonCode: 'SIZE_MISMATCH',
    });
    await service.openArbitration(buyer, intent.orderId, {
      idempotencyKey: 'open-arbitration-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      reasonCode: 'DELIVERY_DISPUTE',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {});
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'DISPUTED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    await assert.rejects(
      service.decideFulfillmentRequest(merchant, intent.orderId, {
        idempotencyKey: 'exchange-decision-during-arbitration',
        evidenceHash: `0x${'5'.repeat(64)}`,
        requestId: exchange.requestId,
        approved: true,
        noteCode: 'INVALID_DURING_ARBITRATION',
      }),
      /current order state/,
    );
    await assert.rejects(
      service.decideArbitration(buyer, intent.orderId, {
        idempotencyKey: 'bad-arbitration-decision',
        evidenceHash: `0x${'6'.repeat(64)}`,
        outcome: 'FULFILL',
        noteCode: 'BUYER_CANNOT_DECIDE',
      }),
      /role is required/,
    );

    await service.decideArbitration(arbitrator, intent.orderId, {
      idempotencyKey: 'resume-arbitration-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      outcome: 'RESUME_FULFILLMENT',
      noteCode: 'CONTINUE_DELIVERY',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'DISPUTED'), {});
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });

    now = new Date(now.getTime() + 60_000);
    await service.openArbitration(buyer, intent.orderId, {
      idempotencyKey: 'open-arbitration-2',
      evidenceHash: `0x${'7'.repeat(64)}`,
      reasonCode: 'DELIVERY_DISPUTE',
    });
    await service.decideArbitration(arbitrator, intent.orderId, {
      idempotencyKey: 'fulfill-arbitration-2',
      evidenceHash: `0x${'8'.repeat(64)}`,
      outcome: 'FULFILL',
      noteCode: 'PLATFORM_FULFILLED',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    await assertLedgerBalanced(db, 1);
  } finally {
    await db.close();
  }
});

test('merchant forced receipt remains a platform-reviewed request until seven days after delivery', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    await service.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'forced-shipment-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    await service.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'forced-delivery-command-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
    });
    await assert.rejects(
      service.requestForcedReceipt(merchant, intent.orderId, {
        idempotencyKey: 'forced-too-early-command-1',
        evidenceHash: `0x${'6'.repeat(64)}`,
        reasonCode: 'CUSTOMER_NO_RESPONSE',
      }),
      /not eligible/,
    );
    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    const request = await service.requestForcedReceipt(merchant, intent.orderId, {
      idempotencyKey: 'forced-request-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
      reasonCode: 'CUSTOMER_NO_RESPONSE',
    });
    assert.equal(request.canFinalizeDirectly, false);
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    await service.decideForcedReceipt(operator, intent.orderId, {
      idempotencyKey: 'forced-approval-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
      approved: true,
      noteCode: 'DELIVERY_EVIDENCE_VALID',
    });
    assert.deepEqual(await liabilityStates(db, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    const requests = await db.query<{ state: string; resolved_by: string }>(
      `SELECT state, resolved_by FROM core.fulfillment_requests
       WHERE order_id = $1 AND request_type = 'FORCED_RECEIPT'`,
      [intent.orderId],
    );
    assert.deepEqual(requests.rows[0], { state: 'APPROVED', resolved_by: operator.walletAddress });
  } finally {
    await db.close();
  }
});

test('takeover freezes the merchant after seven days while funds stay Locked and pickup verification is one-use', async () => {
  const deliveryDb = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(deliveryDb);
    const now = new Date((intent.issuedAt + 8 * 24 * 60 * 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(deliveryDb), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    const takeover = await service.openTakeover(buyer, intent.orderId, {
      idempotencyKey: 'takeover-command-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      reasonCode: 'NO_SHIPMENT_SEVEN_DAYS',
    });
    assert.equal(takeover.customerFundsRemainLocked, true);
    assert.deepEqual(await liabilityStates(deliveryDb, intent.orderId, 'LOCKED'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    const frozen = await deliveryDb.query<{ status: string; guarantee_status: string; lifecycle_state: string }>(
      `SELECT merchant.status, merchant.guarantee_status, product.lifecycle_state
       FROM core.merchants merchant JOIN core.products product ON product.merchant_id = merchant.merchant_id`,
    );
    assert.deepEqual(frozen.rows[0], { status: 'SUSPENDED', guarantee_status: 'FROZEN', lifecycle_state: 'LOCKED' });
    const funding = await deliveryDb.query<{ required_usdt: string | null }>(
      'SELECT required_usdt::text FROM core.takeover_cases WHERE order_id = $1',
      [intent.orderId],
    );
    assert.equal(funding.rows[0]?.required_usdt, null);
    await service.recordShipment(operator, intent.orderId, {
      idempotencyKey: 'takeover-shipment-command-1',
      evidenceHash: `0x${'4'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'5'.repeat(64)}`,
    });
    await service.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'takeover-delivery-command-1',
      evidenceHash: `0x${'6'.repeat(64)}`,
    });
    await service.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'takeover-receipt-command-1',
      evidenceHash: `0x${'7'.repeat(64)}`,
    });
    const closed = await deliveryDb.query<{ state: string }>(
      'SELECT state FROM core.takeover_cases WHERE order_id = $1',
      [intent.orderId],
    );
    assert.equal(closed.rows[0]?.state, 'CLOSED');
    assert.deepEqual(await liabilityStates(deliveryDb, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
  } finally {
    await deliveryDb.close();
  }

  const pickupDb = await createBusinessDatabase();
  try {
    const intent = paymentIntent();
    intent.fulfillmentMode = 'PICKUP';
    intent.fulfillmentTargetHash = `0x${'8'.repeat(64)}`;
    await recordFinalPayment(pickupDb, intent);
    await pickupDb.exec(`
      INSERT INTO core.administrative_regions (
        region_code, province, city, district, source, source_reference_hash, status
      ) VALUES ('110101','Beijing','Beijing','Dongcheng','GOVERNED_IMPORT','${HASH}','ACTIVE')
      ON CONFLICT (region_code) DO NOTHING;
      INSERT INTO core.merchant_stores (
        store_id, merchant_id, idempotency_key, request_hash, name, region_code,
        longitude, latitude, address, phone, status, version
      ) VALUES (
        'store-pickup-1','merchant-1','pickup-store-fixture','${HASH_2}',
        'Pickup Store','110101',116.397,39.908,'Pickup Store Address','01012345678','ACTIVE',1
      ), (
        'store-pickup-2','merchant-1','pickup-store-other','${HASH_2}',
        'Other Store','110101',116.398,39.909,'Other Store Address','01012345679','ACTIVE',1
      );
      INSERT INTO core.fulfillment_targets (
        target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
        fulfillment_mode, region_code, region_code_hash, store_id,
        encrypted_payload, encryption_iv, encryption_tag, expires_at, created_at
      ) VALUES (
        'target-pickup-1','${intent.fulfillmentTargetHash}','${BUYER}','pickup-target-fixture','${HASH_2}',
        'PICKUP','110101','${HASH}','store-pickup-1',
        decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        clock_timestamp() + interval '1 day',clock_timestamp()
      );
    `);
    let now = new Date((intent.issuedAt + 60) * 1000);
    const service = new FulfillmentService({ transactions: transactionAdapter(pickupDb), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-1',
      evidenceHash: `0x${'3'.repeat(64)}`,
      code: '123456',
      expiresAt: new Date(now.getTime() + 1_000),
    });
    now = new Date(now.getTime() + 2_000);
    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-2',
      evidenceHash: `0x${'8'.repeat(64)}`,
      code: '234567',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const credentials = await pickupDb.query<{ consumed_at: Date | null; invalidated_at: Date | null }>(
      `SELECT consumed_at, invalidated_at FROM core.pickup_credentials
       WHERE order_id = $1 ORDER BY created_at, credential_id`,
      [intent.orderId],
    );
    assert.equal(credentials.rows[0]?.consumed_at, null);
    assert.ok(credentials.rows[0]?.invalidated_at);
    assert.equal(credentials.rows[1]?.invalidated_at, null);
    const failedAttempts = [
      { idempotencyKey: 'pickup-wrong-store-1', code: '234567', storeId: 'store-pickup-2' },
      { idempotencyKey: 'pickup-unknown-store', code: '234567', storeId: 'store-does-not-exist' },
      { idempotencyKey: 'pickup-wrong-code-3', code: '654322', storeId: 'store-pickup-1' },
      { idempotencyKey: 'pickup-wrong-code-4', code: '654323', storeId: 'store-pickup-1' },
      { idempotencyKey: 'pickup-wrong-code-5', code: '654324', storeId: 'store-pickup-1' },
    ];
    for (const failed of failedAttempts) {
      await assert.rejects(
        service.verifyPickup(merchant, intent.orderId, {
          ...failed,
          evidenceHash: `0x${'4'.repeat(64)}`,
        }),
        /invalid or expired/,
      );
    }
    await assert.rejects(
      service.verifyPickup(merchant, intent.orderId, {
        ...failedAttempts[4]!,
        evidenceHash: `0x${'4'.repeat(64)}`,
      }),
      /invalid or expired/,
    );
    const blockedCredential = await pickupDb.query<{
      failed_attempts: number;
      invalidated_at: Date | null;
      attempts: string;
    }>(
      `SELECT credential.failed_attempts, credential.invalidated_at,
         (SELECT count(*)::text FROM core.pickup_verification_attempts attempt
          WHERE attempt.order_id = credential.order_id AND NOT attempt.successful) AS attempts
       FROM core.pickup_credentials credential
       WHERE credential.order_id = $1 ORDER BY credential.created_at DESC LIMIT 1`,
      [intent.orderId],
    );
    assert.equal(blockedCredential.rows[0]?.failed_attempts, 5);
    assert.ok(blockedCredential.rows[0]?.invalidated_at);
    assert.equal(blockedCredential.rows[0]?.attempts, '5');

    await service.registerPickupCredential(buyer, intent.orderId, {
      idempotencyKey: 'pickup-credential-3',
      evidenceHash: `0x${'9'.repeat(64)}`,
      code: '345678',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    await service.verifyPickup(merchant, intent.orderId, {
      idempotencyKey: 'pickup-correct-code-1',
      evidenceHash: `0x${'5'.repeat(64)}`,
      code: '345678',
      storeId: 'store-pickup-1',
    });
    assert.deepEqual(await liabilityStates(pickupDb, intent.orderId, 'AVAILABLE'), {
      BNM_POINTS: '100',
      NPL: '100',
      USDT: '70',
    });
    await assert.rejects(
      service.verifyPickup(merchant, intent.orderId, {
        idempotencyKey: 'pickup-replay-code-1',
        evidenceHash: `0x${'6'.repeat(64)}`,
        code: '123456',
        storeId: 'store-pickup-1',
      }),
      /paid pickup order/,
    );
  } finally {
    await pickupDb.close();
  }
});

test('payment reorg cancels unsent BNM availability and synchronizes Locked next', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    const now = new Date((intent.issuedAt + 60) * 1000);
    const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
    const buyer = { walletAddress: BUYER, roles: ['BUYER'] as const };
    const merchant = { walletAddress: MERCHANT, roles: ['MERCHANT'] as const, merchantId: 'merchant-1' };
    const operator = { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] as const };
    await fulfillment.recordShipment(merchant, intent.orderId, {
      idempotencyKey: 'bnm-race-shipment',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    });
    await fulfillment.recordDelivery(operator, intent.orderId, {
      idempotencyKey: 'bnm-race-delivery',
      evidenceHash: `0x${'5'.repeat(64)}`,
    });
    await fulfillment.confirmReceipt(buyer, intent.orderId, {
      idempotencyKey: 'bnm-race-receipt',
      evidenceHash: `0x${'6'.repeat(64)}`,
    });

    const payment = paymentInput(intent);
    await new PostgresPaymentStore(transactionAdapter(db)).reverse(
      paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
      `0x${'9'.repeat(64)}`,
    );
    const states: string[] = [];
    const worker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-race-worker',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: `bnm:${input.orderId}:${input.state}`,
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    assert.equal(await worker.pollOnce(), 1);
    assert.deepEqual(states, ['LOCKED']);
    const outbox = await db.query<{ event_type: string; state: string; last_error_code: string | null }>(
      `SELECT event_type, state, last_error_code FROM core.outbox_events
       WHERE aggregate_id = $1 AND event_type IN ('BnmAvailabilityRequested', 'BnmLockRequested')
       ORDER BY event_type`,
      [intent.orderId],
    );
    assert.deepEqual(outbox.rows, [
      { event_type: 'BnmAvailabilityRequested', state: 'DEAD_LETTER', last_error_code: 'PaymentReorged' },
      { event_type: 'BnmLockRequested', state: 'DELIVERED', last_error_code: null },
    ]);
  } finally {
    await db.close();
  }
});

test('payment reorg waits for in-flight BNM availability acknowledgement before synchronizing Locked', async () => {
  const db = await createBusinessDatabase();
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    let releaseAvailable!: () => void;
    let markAvailableStarted!: () => void;
    const availableGate = new Promise<void>((resolve) => { releaseAvailable = resolve; });
    const availableStarted = new Promise<void>((resolve) => { markAvailableStarted = resolve; });
    const states: string[] = [];
    const availableWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-success',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          markAvailableStarted();
          await availableGate;
          return {
            providerReference: 'in-flight-available',
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const lockedWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-locked',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: 'in-flight-locked',
            syncedAt: now.toISOString(),
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });

    const availablePoll = availableWorker.pollOnce();
    await availableStarted;
    await reversePayment(db, intent);
    assert.equal(await lockedWorker.pollOnce(), 0);
    releaseAvailable();
    assert.equal(await availablePoll, 1);
    assert.equal(await lockedWorker.pollOnce(), 1);
    assert.deepEqual(states, ['AVAILABLE', 'LOCKED']);
  } finally {
    await db.close();
  }
});

test('BNM monotonic state version rejects a timed-out AVAILABLE side effect that arrives after reorg Locked', async () => {
  const db = await createBusinessDatabase();
  try {
    const { intent, now } = await completeDeliveryForBnm(db);
    let releaseAvailable!: () => void;
    let markAvailableStarted!: () => void;
    const availableGate = new Promise<void>((resolve) => { releaseAvailable = resolve; });
    const availableStarted = new Promise<void>((resolve) => { markAvailableStarted = resolve; });
    const states: Array<{ state: string; stateVersion: string }> = [];
    let lateAvailable: (() => void) | undefined;
    let external = { state: 'LOCKED' as 'LOCKED' | 'AVAILABLE', stateVersion: '0' };
    const applyAtBackend = (input: { state: 'LOCKED' | 'AVAILABLE'; stateVersion: string }) => {
      const incoming = BigInt(input.stateVersion);
      const current = BigInt(external.stateVersion);
      if (incoming > current) external = { state: input.state, stateVersion: input.stateVersion };
      if (incoming === current && input.state !== external.state) throw new Error('BNM_STATE_VERSION_CONFLICT');
    };
    const availableWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-in-flight-failure',
      adapter: {
        setState: async (input) => {
          states.push({ state: input.state, stateVersion: input.stateVersion });
          lateAvailable = () => applyAtBackend(input);
          markAvailableStarted();
          await availableGate;
          throw new Error('ambiguous provider timeout');
        },
      },
    });
    const lockedWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-after-in-flight-failure',
      adapter: {
        setState: async (input) => {
          states.push({ state: input.state, stateVersion: input.stateVersion });
          applyAtBackend(input);
          return {
            providerReference: 'locked-after-timeout',
            syncedAt: now.toISOString(),
            state: external.state,
            stateVersion: external.stateVersion,
          };
        },
      },
    });

    const availablePoll = availableWorker.pollOnce();
    await availableStarted;
    await reversePayment(db, intent);
    assert.equal(await lockedWorker.pollOnce(), 0);
    releaseAvailable();
    assert.equal(await availablePoll, 1);
    const canceled = await db.query<{ state: string; last_error_code: string | null }>(
      `SELECT state, last_error_code FROM core.outbox_events
       WHERE aggregate_id = $1 AND event_type = 'BnmAvailabilityRequested'`,
      [intent.orderId],
    );
    assert.deepEqual(canceled.rows[0], { state: 'DEAD_LETTER', last_error_code: 'PaymentReorged' });
    assert.equal(await lockedWorker.pollOnce(), 1);
    assert.equal(await lockedWorker.pollOnce(), 0);
    assert.ok(lateAvailable);
    lateAvailable();
    assert.deepEqual(states, [
      { state: 'AVAILABLE', stateVersion: '1' },
      { state: 'LOCKED', stateVersion: '2' },
    ]);
    assert.deepEqual(external, { state: 'LOCKED', stateVersion: '2' });
  } finally {
    await db.close();
  }
});

test('BNM outbox attempt token fences a stale promise after the same worker id re-leases an event', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
       ) VALUES ('bnm-fenced','ORDER',$1,'BnmAvailabilityRequested',$2,'bnm-fenced','PENDING')`,
      [intent.orderId, JSON.stringify({
        orderId: intent.orderId,
        buyerWallet: intent.buyer,
        amount: intent.bnmAmount,
        state: 'AVAILABLE',
        stateVersion: '1',
        reason: 'FENCING_TEST',
        sourceEvidenceHash: HASH,
      })],
    );
    let releaseStale!: () => void;
    let releaseCurrent!: () => void;
    let markStaleStarted!: () => void;
    let markCurrentStarted!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve; });
    const currentStarted = new Promise<void>((resolve) => { markCurrentStarted = resolve; });
    const staleWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'same-worker-id',
      adapter: {
        setState: async (input) => {
          markStaleStarted();
          await staleGate;
          return {
            providerReference: 'stale-provider',
            syncedAt: '2026-07-14T00:00:01.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const currentWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'same-worker-id',
      adapter: {
        setState: async (input) => {
          markCurrentStarted();
          await currentGate;
          return {
            providerReference: 'current-provider',
            syncedAt: '2026-07-14T00:00:02.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });

    const stalePoll = staleWorker.pollOnce();
    await staleStarted;
    await db.query(
      "UPDATE core.outbox_events SET locked_until = clock_timestamp() - interval '1 second' WHERE event_id = 'bnm-fenced'",
    );
    const currentPoll = currentWorker.pollOnce();
    await currentStarted;
    releaseStale();
    assert.equal(await stalePoll, 1);
    const fenced = await db.query<{ state: string; attempt_count: number; syncs: string }>(
      `SELECT event.state, event.attempt_count,
         (SELECT count(*)::text FROM core.bnm_state_syncs sync WHERE sync.event_id = event.event_id) AS syncs
       FROM core.outbox_events event WHERE event.event_id = 'bnm-fenced'`,
    );
    assert.deepEqual(fenced.rows[0], { state: 'PROCESSING', attempt_count: 2, syncs: '0' });
    releaseCurrent();
    assert.equal(await currentPoll, 1);
    const delivered = await db.query<{ state: string; provider_reference_hash: string }>(
      `SELECT event.state, sync.provider_reference_hash
       FROM core.outbox_events event JOIN core.bnm_state_syncs sync ON sync.event_id = event.event_id
       WHERE event.event_id = 'bnm-fenced'`,
    );
    assert.deepEqual(delivered.rows[0], {
      state: 'DELIVERED',
      provider_reference_hash: `0x${createHash('sha256').update('current-provider').digest('hex')}`,
    });
  } finally {
    await db.close();
  }
});

test('BNM outbox leases one event per order and preserves AVAILABLE then LOCKED FIFO', async () => {
  const db = await createBusinessDatabase();
  try {
    const intent = await recordFinalPayment(db);
    const payload = (state: 'AVAILABLE' | 'LOCKED') => JSON.stringify({
      orderId: intent.orderId,
      buyerWallet: intent.buyer,
      amount: intent.bnmAmount,
      state,
      stateVersion: state === 'AVAILABLE' ? '1' : '2',
      reason: 'FIFO_TEST',
      sourceEvidenceHash: state === 'AVAILABLE' ? HASH : HASH_2,
    });
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload,
         idempotency_key, state, created_at
       ) VALUES
         ('bnm-fifo-available','ORDER',$1,'BnmAvailabilityRequested',$2,'bnm-fifo-available','PENDING',$4),
         ('bnm-fifo-locked','ORDER',$1,'BnmLockRequested',$3,'bnm-fifo-locked','PENDING',$4 + interval '1 second')`,
      [intent.orderId, payload('AVAILABLE'), payload('LOCKED'), new Date('2026-07-14T00:00:00.000Z')],
    );
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const states: string[] = [];
    const firstWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-fifo-1',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          markStarted();
          await firstGate;
          return {
            providerReference: 'fifo-available',
            syncedAt: '2026-07-14T00:00:01.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const secondWorker = new BnmAvailabilityWorker({
      transactions: transactionAdapter(db),
      workerId: 'bnm-fifo-2',
      adapter: {
        setState: async (input) => {
          states.push(input.state);
          return {
            providerReference: 'fifo-locked',
            syncedAt: '2026-07-14T00:00:02.000Z',
            state: input.state,
            stateVersion: input.stateVersion,
          };
        },
      },
    });
    const firstPoll = firstWorker.pollOnce();
    await started;
    assert.equal(await secondWorker.pollOnce(), 0);
    releaseFirst();
    assert.equal(await firstPoll, 1);
    assert.equal(await secondWorker.pollOnce(), 1);
    assert.deepEqual(states, ['AVAILABLE', 'LOCKED']);
  } finally {
    await db.close();
  }
});

test('fulfillment scheduler isolates order failures and persists takeover retry evidence', async () => {
  const db = await createBusinessDatabase();
  try {
    const opened: string[] = [];
    const worker = new FulfillmentSchedulerWorker({
      transactions: transactionAdapter(db),
      platformWallet: '0x3333333333333333333333333333333333333333',
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
      service: {
        listOrders: async () => [
          {
            orderId: 'failing-order',
            fulfillmentMode: 'DELIVERY',
            state: 'PAID',
            paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
            shipments: [],
          },
          {
            orderId: 'healthy-order',
            fulfillmentMode: 'DELIVERY',
            state: 'PAID',
            paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
            shipments: [],
          },
        ],
        openTakeover: async (_actor, orderId) => {
          if (orderId === 'failing-order') throw new Error('provider failure');
          opened.push(orderId);
        },
      },
    });
    assert.deepEqual(await worker.pollOnce(), {
      checked: 2,
      opened: 1,
      pickupBlocked: 0,
      deferred: 0,
      failed: 1,
    });
    assert.deepEqual(opened, ['healthy-order']);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderFailure' });
    const failure = await db.query<{ state: string; attempt_count: number; last_error_code: string }>(
      "SELECT state, attempt_count, last_error_code FROM core.durable_jobs WHERE resource_id = 'failing-order'",
    );
    assert.deepEqual(failure.rows[0], {
      state: 'RETRY',
      attempt_count: 1,
      last_error_code: 'UnexpectedTakeoverFailure',
    });
  } finally {
    await db.close();
  }
});

test('fulfillment scheduler honors takeover backoff and stops after the fifth failed attempt', async () => {
  const db = await createBusinessDatabase();
  try {
    let attempts = 0;
    const worker = new FulfillmentSchedulerWorker({
      transactions: transactionAdapter(db),
      platformWallet: '0x3333333333333333333333333333333333333333',
      clock: () => new Date('2026-07-14T00:00:00.000Z'),
      service: {
        listOrders: async () => [{
          orderId: 'backoff-order',
          fulfillmentMode: 'DELIVERY',
          state: 'PAID',
          paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
          shipments: [],
        }],
        openTakeover: async () => {
          attempts += 1;
          throw new Error('provider failure');
        },
      },
    });

    assert.equal((await worker.pollOnce()).failed, 1);
    assert.equal(attempts, 1);
    assert.deepEqual(await worker.pollOnce(), {
      checked: 1,
      opened: 0,
      pickupBlocked: 0,
      deferred: 1,
      failed: 0,
    });
    assert.equal(attempts, 1);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderRetryPending' });

    for (let expectedAttempt = 2; expectedAttempt <= 5; expectedAttempt += 1) {
      await db.query(
        "UPDATE core.durable_jobs SET available_at = clock_timestamp() - interval '1 second' WHERE resource_id = 'backoff-order'",
      );
      assert.equal((await worker.pollOnce()).failed, 1);
      assert.equal(attempts, expectedAttempt);
    }
    const deadLetter = await db.query<{ state: string; attempt_count: number }>(
      "SELECT state, attempt_count FROM core.durable_jobs WHERE resource_id = 'backoff-order'",
    );
    assert.deepEqual(deadLetter.rows[0], { state: 'DEAD_LETTER', attempt_count: 5 });
    assert.equal((await worker.pollOnce()).deferred, 1);
    assert.equal(attempts, 5);
    assert.deepEqual(worker.status(), { healthy: false, errorCode: 'TakeoverOrderDeadLetter' });
  } finally {
    await db.close();
  }
});

test('PostgreSQL SIWE nonces coexist per wallet and each consumes atomically once', async () => {
  const db = await createBusinessDatabase();
  try {
    const store = new PostgresNonceStore(adapter(db));
    const now = new Date('2026-07-14T00:00:00.000Z');
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'a'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await store.save({
      walletAddress: BUYER,
      nonceHash: 'b'.repeat(64),
      domain: 'mall.abu.test',
      uri: 'https://mall.abu.test',
      chainId: 56,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    assert.ok(await store.consume(BUYER, 'a'.repeat(64), now));
    assert.equal(await store.consume(BUYER, 'a'.repeat(64), now), undefined);
    assert.ok(await store.consume(BUYER, 'b'.repeat(64), now));
  } finally {
    await db.close();
  }
});

test('Redis SIWE limiter hashes identities, enforces limits and fails closed', async () => {
  let capturedKeys: string[] = [];
  const allowed = new RedisNonceRateLimiter({
    eval: async (_script, options) => {
      capturedKeys = options.keys;
      return 1;
    },
  });
  await allowed.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date('2026-07-14T00:00:00Z') });
  assert.equal(capturedKeys.some((key) => key.includes(BUYER) || key.includes('127.0.0.1')), false);
  const blocked = new RedisNonceRateLimiter({ eval: async () => 0 });
  await assert.rejects(
    blocked.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date() }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('rate limit exceeded') && 'status' in error && error.status === 429,
  );
  const unavailable = new RedisNonceRateLimiter({ eval: async () => Promise.reject(new Error('offline')) });
  await assert.rejects(
    unavailable.consume({ walletAddress: BUYER, clientAddress: '127.0.0.1', now: new Date() }),
    /unavailable/,
  );
});

test('order financial snapshots and evidence history are immutable', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    await reserveInventory(adapter(db), {
      reservationId: 'reservation-order',
      reservationHash: HASH,
      policyVersion: 1,
      skuId: 'sku-1',
      buyerWallet: BUYER,
      quantity: 1,
      classification: 'ORDINARY',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertOrder(db, 'order-1', 'reservation-order');
    await db.query("UPDATE core.orders SET state = 'SUBMITTED', updated_at = clock_timestamp() WHERE order_id = 'order-1'");
    await assert.rejects(
      db.query("UPDATE core.orders SET exact_amounts = '{\"usdt\":\"999\"}'::jsonb WHERE order_id = 'order-1'"),
      /ImmutableOrderSnapshot/,
    );
    await assert.rejects(db.query("DELETE FROM core.orders WHERE order_id = 'order-1'"), /ImmutableRecord/);

    await db.query(
      `INSERT INTO core.fulfillment_evidence (
         evidence_id, order_id, evidence_type, evidence_hash, source, recorded_by
       ) VALUES ('evidence-1', 'order-1', 'SHIPMENT', $1, 'KUAIDI100', 'worker')`,
      [HASH],
    );
    await assert.rejects(
      db.query("UPDATE core.fulfillment_evidence SET source = 'tampered' WHERE evidence_id = 'evidence-1'"),
      /ImmutableRecord/,
    );
  } finally {
    await db.close();
  }
});

test('policy drafts remain editable while published policy and historical catalog records do not', async () => {
  const db = await createBusinessDatabase();
  try {
    await seedCatalog(db, 2);
    await db.query(
      `INSERT INTO core.policy_drafts (
         draft_id, next_policy_version, base_policy_version, payload, state, created_by
       ) VALUES ('draft-2', 2, 1, '{}', 'DRAFT', 'admin')`,
    );
    await db.query(
      `UPDATE core.policy_drafts
       SET payload = '{"futureOnly":true}', updated_at = clock_timestamp()
       WHERE draft_id = 'draft-2'`,
    );
    await assert.rejects(
      db.query("UPDATE core.policy_snapshots SET artifact_version = 'tampered' WHERE policy_version = 1"),
      /ImmutableRecord/,
    );
    await assert.rejects(
      db.query(
        "UPDATE core.merchants SET settlement_wallet = '0x3333333333333333333333333333333333333333' WHERE merchant_id = 'merchant-1'",
      ),
      /GovernedWalletMigrationRequired/,
    );
    await assert.rejects(db.query("DELETE FROM core.products WHERE product_id = 'product-1'"), /ImmutableRecord/);
  } finally {
    await db.close();
  }
});

test('outbox participates in the business transaction and durable jobs lease once', async () => {
  const db = await createBusinessDatabase();
  try {
    await db.exec('BEGIN');
    await db.query(
      `INSERT INTO core.outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key, state
       ) VALUES ('event-rollback', 'ORDER', 'order-x', 'OrderPrepared', '{}', 'outbox-rollback', 'PENDING')`,
    );
    await db.exec('ROLLBACK');
    const rolledBack = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM core.outbox_events WHERE event_id = 'event-rollback'",
    );
    assert.equal(rolledBack.rows[0]?.count, '0');

    for (const id of ['job-1', 'job-2']) {
      await db.query(
        `INSERT INTO core.durable_jobs (
           job_id, job_type, resource_id, payload, idempotency_key, state
         ) VALUES ($1, 'SYNC_FINALITY', $2, '{}', $3, 'READY')`,
        [id, `resource-${id}`, `idempotency-${id}`],
      );
    }
    const first = await leaseDurableJobs(adapter(db), 'worker-a', 1, 30);
    const second = await leaseDurableJobs(adapter(db), 'worker-b', 1, 30);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0]?.job_id, second[0]?.job_id);
    assert.equal(first[0]?.attempt_count, 1);
    assert.equal(second[0]?.attempt_count, 1);
  } finally {
    await db.close();
  }
});

test('audit database redacts secrets, verifies its hash chain and rejects mutation', async () => {
  const db = await PGlite.create();
  try {
    await applyMigrations(adapter(db), 'audit', AUDIT_MIGRATIONS);
    for (const index of [1, 2]) {
      await appendAuditEntry(transactionAdapter(db), {
          streamName: 'financial',
          eventType: index === 1 ? 'PaymentIndexed' : 'PaymentFinalized',
          resourceType: 'ORDER',
          resourceId: 'order-1',
          actorWallet: BUYER,
          actorRole: 'BUYER',
          correlationId: 'correlation-1',
          requestHash: 'a'.repeat(64),
          payload: {
            state: index,
            authorization: 'Bearer secret',
            nested: {
              phone: '13800000000',
              email: 'buyer@example.invalid',
              shippingAddress: 'private location',
              private_key: 'secret-key',
              credential: 'secret-credential',
            },
          },
          signatureEvidence: {
            scheme: 'EIP712',
            signatureHash: HASH,
            signer: BUYER,
            digest: HASH_2,
            domain: 'Abu24KPaymentRouter:2:56',
            nonce: String(index),
            deadline: '1800000300',
          },
          transactionEvidence: {
            txHash: HASH_2,
            chainId: 56,
            contractAddress: MERCHANT,
            selector: '0x12345678',
            calldataHash: HASH,
            resourceId: 'order-1',
            policyVersion: 1,
          },
          createdAt: new Date(`2026-07-14T00:00:0${index}.000Z`),
      });
    }
    const result = await db.query<AuditRow>('SELECT * FROM audit.entries ORDER BY sequence');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]?.payload.authorization, '[REDACTED]');
    assert.deepEqual(result.rows[0]?.payload.nested, {
      phone: '[REDACTED]',
      email: '[REDACTED]',
      shippingAddress: '[REDACTED]',
      private_key: '[REDACTED]',
      credential: '[REDACTED]',
    });
    assert.deepEqual(result.rows[0]?.signature_evidence, {
      scheme: 'EIP712',
      signatureHash: HASH,
      signer: BUYER,
      digest: HASH_2,
      domain: 'Abu24KPaymentRouter:2:56',
      nonce: '1',
      deadline: '1800000300',
    });
    assert.deepEqual(result.rows[0]?.transaction_evidence, {
      txHash: HASH_2,
      chainId: 56,
      contractAddress: MERCHANT,
      selector: '0x12345678',
      calldataHash: HASH,
      resourceId: 'order-1',
      policyVersion: 1,
    });
    assert.equal(verifyAuditChain(result.rows), true);
    assert.equal(verifyAuditChain([{ ...result.rows[0]!, entry_hash: 'f'.repeat(64) }, result.rows[1]!]), false);
    await assert.rejects(db.query("UPDATE audit.entries SET event_type = 'tampered'"), /AppendOnlyAudit/);
    await assert.rejects(db.query('DELETE FROM audit.entries'), /AppendOnlyAudit/);
    await assert.rejects(
      appendAuditEntry(transactionAdapter(db), {
        streamName: 'financial',
        eventType: 'MissingEvidence',
        resourceType: 'ORDER',
        resourceId: 'order-missing-evidence',
        correlationId: 'correlation-missing-evidence',
        requestHash: 'd'.repeat(64),
        payload: {},
      }),
      /MissingSensitiveAuditEvidence/,
    );
    const failingRunner = transactionAdapter(db, (sql) => {
      if (sql.startsWith('UPDATE audit.stream_heads')) throw new Error('InjectedAuditHeadFailure');
    });
    await assert.rejects(
      appendAuditEntry(failingRunner, {
        streamName: 'financial',
        eventType: 'MustRollback',
        resourceType: 'ORDER',
        resourceId: 'order-2',
        correlationId: 'correlation-rollback',
        requestHash: 'b'.repeat(64),
        payload: {},
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: HASH,
          signer: BUYER,
          digest: HASH_2,
          domain: 'Abu24KPaymentRouter:2:56',
          nonce: '2',
          deadline: '1800000300',
        },
        transactionEvidence: {
          txHash: HASH_2,
          chainId: 56,
          contractAddress: MERCHANT,
          selector: '0x12345678',
          calldataHash: HASH,
          resourceId: 'order-2',
          policyVersion: 1,
        },
      }),
      /InjectedAuditHeadFailure/,
    );
    const afterRollback = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM audit.entries');
    assert.equal(afterRollback.rows[0]?.count, '2');
    await assert.rejects(
      appendAuditEntry(transactionAdapter(db), {
        streamName: 'financial',
        eventType: 'RejectUnknownEvidence',
        resourceType: 'ORDER',
        resourceId: 'order-3',
        correlationId: 'correlation-unknown-evidence',
        requestHash: 'c'.repeat(64),
        payload: {},
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash: HASH,
          signer: BUYER,
          digest: HASH_2,
          domain: 'Abu24KPaymentRouter:2:56',
          nonce: '3',
          deadline: '1800000300',
          private_key: 'must-not-pass',
        } as never,
      }),
      /UnknownAuditEvidenceField/,
    );
  } finally {
    await db.close();
  }
});

test('same-version physical backup restores business and audit data into new databases', async () => {
  const business = await createBusinessDatabase();
  const audit = await PGlite.create();
  let restoredBusiness: PGlite | undefined;
  let restoredAudit: PGlite | undefined;
  try {
    await seedCatalog(business, 3);
    await applyMigrations(adapter(audit), 'audit', AUDIT_MIGRATIONS);
    await appendAuditEntry(transactionAdapter(audit), {
      streamName: 'backup',
      eventType: 'BackupEvidence',
      resourceType: 'DATABASE',
      resourceId: 'audit',
      correlationId: 'backup-roundtrip',
      requestHash: 'b'.repeat(64),
      payload: { verified: true },
    });

    const businessDump = await business.dumpDataDir('gzip');
    const auditDump = await audit.dumpDataDir('gzip');
    restoredBusiness = await PGlite.create({ loadDataDir: businessDump });
    restoredAudit = await PGlite.create({ loadDataDir: auditDump });
    const merchantCount = await restoredBusiness.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.merchants',
    );
    const auditRows = await restoredAudit.query<AuditRow>('SELECT * FROM audit.entries ORDER BY sequence');
    assert.equal(merchantCount.rows[0]?.count, '1');
    assert.equal(verifyAuditChain(auditRows.rows), true);
  } finally {
    await restoredBusiness?.close();
    await restoredAudit?.close();
    await business.close();
    await audit.close();
  }
});

test('production backup enforces encrypted storage acknowledgement and mode 600 artifacts', () => {
  for (const path of ['../../scripts/database-backup.mjs', '../../scripts/database-restore.mjs']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(path, import.meta.url))]);
  }
  const directory = mkdtempSync(join(tmpdir(), 'abu24k-backup-'));
  try {
    const pgDump = join(directory, 'pg_dump');
    writeFileSync(
      pgDump,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--file" ]; then\n    shift\n    printf "test-dump" > "$1"\n    exit 0\n  fi\n  shift\ndone\nexit 1\n',
      { mode: 0o700 },
    );
    chmodSync(pgDump, 0o700);
    const output = join(directory, 'business.dump');
    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-backup.mjs', import.meta.url)), 'business', output], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        DATABASE_URL: 'postgres://test:test@localhost/business',
        BACKUP_STORAGE_ENCRYPTED: 'true',
      },
      stdio: 'pipe',
    });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(statSync(`${output}.sha256`).mode & 0o777, 0o600);
    assert.throws(
      () =>
        execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/database-backup.mjs', import.meta.url)), 'business', output], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ''}`,
            DATABASE_URL: 'postgres://test:test@localhost/business',
            BACKUP_STORAGE_ENCRYPTED: 'true',
          },
          stdio: 'pipe',
        }),
      /Command failed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function recordFinalPayment(db: PGlite, intent = paymentIntent()) {
  await seedCatalog(db, 1);
  await reserveInventory(adapter(db), {
    reservationId: intent.reservationId,
    reservationHash: intent.reservationHash,
    policyVersion: intent.policyVersion,
    skuId: 'sku-1',
    buyerWallet: intent.buyer,
    quantity: intent.quantity,
    classification: 'ORDINARY',
    expiresAt: new Date(intent.reservationDeadline * 1000),
  });
  await insertPaymentQuote(db, intent, `fulfillment-${intent.orderId}`);
  await new PostgresPaymentStore(transactionAdapter(db)).record(paymentInput(intent));
  return intent;
}

async function completeDeliveryForBnm(db: PGlite) {
  const intent = await recordFinalPayment(db);
  const now = new Date((intent.issuedAt + 60) * 1000);
  const fulfillment = new FulfillmentService({ transactions: transactionAdapter(db), clock: () => now });
  await fulfillment.recordShipment(
    { walletAddress: MERCHANT, roles: ['MERCHANT'], merchantId: 'merchant-1' },
    intent.orderId,
    {
      idempotencyKey: 'bnm-in-flight-shipment',
      evidenceHash: `0x${'3'.repeat(64)}`,
      carrierCode: 'SF',
      trackingNumberHash: `0x${'4'.repeat(64)}`,
    },
  );
  await fulfillment.recordDelivery(
    { walletAddress: '0x3333333333333333333333333333333333333333', roles: ['OPERATOR'] },
    intent.orderId,
    { idempotencyKey: 'bnm-in-flight-delivery', evidenceHash: `0x${'5'.repeat(64)}` },
  );
  await fulfillment.confirmReceipt(
    { walletAddress: BUYER, roles: ['BUYER'] },
    intent.orderId,
    { idempotencyKey: 'bnm-in-flight-receipt', evidenceHash: `0x${'6'.repeat(64)}` },
  );
  return { intent, now };
}

async function reversePayment(db: PGlite, intent: CanonicalPaymentIntent) {
  const payment = paymentInput(intent);
  return new PostgresPaymentStore(transactionAdapter(db)).reverse(
    paymentEventKey(payment.event.transactionHash, payment.event.logIndex, payment.event.blockHash),
    `0x${'9'.repeat(64)}`,
  );
}

async function liabilityStates(db: PGlite, orderId: string, state: string) {
  const result = await db.query<{ asset: string; amount: string }>(
    `SELECT account.asset,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND line.balance_state = $2
     GROUP BY account.asset
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY account.asset`,
    [orderId, state],
  );
  return Object.fromEntries(result.rows.map((row) => [row.asset, row.amount]));
}

async function purposeBalances(db: PGlite, orderId: string, purpose: string) {
  const result = await db.query<{ balance_state: string; amount: string }>(
    `SELECT line.balance_state,
       sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END)::text AS amount
     FROM core.ledger_journals journal
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     WHERE journal.order_id = $1 AND account.purpose = $2
     GROUP BY line.balance_state
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) <> 0
     ORDER BY line.balance_state`,
    [orderId, purpose],
  );
  return Object.fromEntries(result.rows.map((row) => [row.balance_state, row.amount]));
}

function paymentIntent(): CanonicalPaymentIntent {
  const now = Math.floor(Date.now() / 1000);
  return {
    orderId: `0x${'a'.repeat(64)}`,
    policyVersion: 1,
    oracleVersion: HASH_2,
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
    reservationHash: `0x${'e'.repeat(64)}`,
    reservationDeadline: now + 600,
    issuedAt: now,
    deadline: now + 300,
    nonce: '1',
    listPriceUsdt: '100',
    usdtPaymentAmount: '70',
    nplQuoteAmount: '1000',
    nplPaymentAmount: '300',
    nplBurnAmount: '200',
    nplRewardAmount: '100',
    merchantBaseReceivableUsdt: '60',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '15',
    merchantNetReceivableUsdt: '45',
    concessionAllocationHash: HASH,
    bnmAmount: '100',
    seckill: false,
    sessionId: `0x${'0'.repeat(64)}`,
    beneficiaries: {
      genesis: '0x5000000000000000000000000000000000000001',
      directReferral: '0x5000000000000000000000000000000000000002',
      district: '0x5000000000000000000000000000000000000003',
      city: '0x5000000000000000000000000000000000000004',
      province: '0x5000000000000000000000000000000000000005',
      region: '0x5000000000000000000000000000000000000006',
    },
    merchantConcessionAllocations: [
      { account: '0x7000000000000000000000000000000000000001', amount: '6' },
      { account: '0x7000000000000000000000000000000000000002', amount: '9' },
    ],
    otherUsdtAllocations: [
      { account: '0x7000000000000000000000000000000000000003', amount: '10', purpose: 'POLICY_ALLOCATION' },
    ],
    nplRewardAllocations: [
      { role: 'genesis', account: '0x5000000000000000000000000000000000000001', amount: '20' },
      { role: 'directReferral', account: '0x5000000000000000000000000000000000000002', amount: '10' },
      { role: 'district', account: '0x5000000000000000000000000000000000000003', amount: '12' },
      { role: 'city', account: '0x5000000000000000000000000000000000000004', amount: '8' },
      { role: 'province', account: '0x5000000000000000000000000000000000000005', amount: '6' },
      { role: 'region', account: '0x5000000000000000000000000000000000000006', amount: '4' },
      { role: 'operations', account: '0x5000000000000000000000000000000000000007', amount: '40' },
    ],
    requiredConfirmations: 15,
  };
}

function paymentInput(
  intent: CanonicalPaymentIntent,
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL' = 'ORDINARY',
): RecordPaymentInput {
  return {
    event: {
      artifactVersion: CORE_ARTIFACT_VERSION,
      orderId: intent.orderId,
      transactionHash: `0x${'6'.repeat(64)}`,
      logIndex: 0,
      blockNumber: 100,
      blockHash: `0x${'5'.repeat(64)}`,
      blockTimestamp: new Date(intent.issuedAt * 1000),
      finalizedAt: new Date((intent.issuedAt + 42) * 1000),
      contractAddress: '0x9999999999999999999999999999999999999999',
      eventHash: HASH,
      snapshotHash: paymentIntentHash(intent),
      classification,
      buyer: intent.buyer,
      merchant: intent.merchant,
      policyVersion: intent.policyVersion,
      listPriceUsdt: intent.listPriceUsdt,
      usdtPaid: intent.usdtPaymentAmount,
      nplPaid: intent.nplPaymentAmount,
      nplBurned: intent.nplBurnAmount,
      nplRewarded: intent.nplRewardAmount,
      bnmLocked: intent.bnmAmount,
      reservationId: intent.reservationId,
      confirmations: 15,
    },
  };
}

async function assertLedgerBalanced(
  db: PGlite,
  expectedPaymentMultiple: number,
  expected = { usdt: 70n, nplReward: 100n, bnm: 100n },
) {
  const balances = await db.query<{ asset: string; delta: string }>(
    `SELECT account.asset,
       sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE -line.amount END)::text AS delta
     FROM core.ledger_lines line
     JOIN core.ledger_accounts account ON account.account_id = line.account_id
     GROUP BY account.asset ORDER BY account.asset`,
  );
  assert.ok(balances.rows.every((row) => row.delta === '0'));
  const safeBalances = await db.query<{ account_id: string; delta: string }>(
    `SELECT line.account_id,
       sum(CASE WHEN line.side = 'DEBIT' THEN line.amount ELSE -line.amount END)::text AS delta
     FROM core.ledger_lines line
     WHERE line.account_id IN (
       'safe:usdt-custody:0x3333333333333333333333333333333333333333:usdt',
       'safe:npl-reward:0x4444444444444444444444444444444444444444:npl',
       'buyer:${BUYER}:bnm')
     GROUP BY line.account_id ORDER BY line.account_id`,
  );
  const values = new Map(safeBalances.rows.map((row) => [row.account_id, BigInt(row.delta)]));
  assert.equal(
    values.get('safe:usdt-custody:0x3333333333333333333333333333333333333333:usdt') ?? 0n,
    expected.usdt * BigInt(expectedPaymentMultiple),
  );
  assert.equal(
    values.get('safe:npl-reward:0x4444444444444444444444444444444444444444:npl') ?? 0n,
    expected.nplReward * BigInt(expectedPaymentMultiple),
  );
  assert.equal(values.get(`buyer:${BUYER}:bnm`) ?? 0n, -expected.bnm * BigInt(expectedPaymentMultiple));
}

function chainBlock(number: number, hash: string, parentHash: string, timestamp: number): IndexedChainBlock {
  return { block: { number, hash, parentHash, timestamp }, events: [] };
}

function blockHash(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function decodedPaymentEvent(intent: CanonicalPaymentIntent, canonicalBlockHash: string) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    contract: 'PaymentRouterV2',
    eventName: 'PaymentCompleted',
    eventSignature: 'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
    resourceId: intent.orderId,
    contractAddress: '0x9999999999999999999999999999999999999999',
    eventHash: HASH,
    transactionHash: `0x${'6'.repeat(64)}`,
    blockHash: canonicalBlockHash,
    blockNumber: 100,
    logIndex: 0,
    values: {
      orderId: intent.orderId,
      buyer: intent.buyer,
      merchant: intent.merchant,
      classification: '0',
      policyVersion: String(intent.policyVersion),
      listPriceUsdt: intent.listPriceUsdt,
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

async function createBusinessDatabase() {
  const db = await PGlite.create();
  await applyMigrations(adapter(db), 'core', BUSINESS_MIGRATIONS);
  return db;
}

function adapter(db: PGlite): SqlExecutor {
  return {
    exec: (sql) => db.exec(sql),
    query: async <Row extends object>(sql: string, params: unknown[] = []) => {
      const result = await db.query<Row>(sql, params);
      return { rows: result.rows };
    },
  };
}

function transactionAdapter(db: PGlite, beforeQuery?: (sql: string) => void): SqlTransactionRunner {
  return {
    transaction: async (operation) => {
      await db.exec('BEGIN');
      try {
        const executor: SqlExecutor = {
          exec: (sql) => db.exec(sql),
          query: async <Row extends object>(sql: string, params: unknown[] = []) => {
            beforeQuery?.(sql);
            const result = await db.query<Row>(sql, params);
            return { rows: result.rows };
          },
        };
        const result = await operation(executor);
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function seedCatalog(db: PGlite, stock: number) {
  await db.query(
    `INSERT INTO core.policy_snapshots (
       policy_version, artifact_version, policy_hash, oracle_version,
       rules_content_hash, beneficiary_set_hash, payload, publication_status
     ) VALUES (1, '${CORE_ARTIFACT_VERSION}', $1, $2, $1, $2, $3, 'PUBLISHED')`,
    [HASH, HASH_2, JSON.stringify(paymentPolicyPayload())],
  );
  await db.query(
    `INSERT INTO core.merchants (
       merchant_id, settlement_wallet, status, level, guarantee_status
     ) VALUES ('merchant-1', $1, 'APPROVED', 'V1', 'READY')`,
    [MERCHANT],
  );
  await db.query(
    `INSERT INTO core.administrative_regions (
       region_code, province, city, district, source, source_reference_hash, status
     ) VALUES ('110101', 'Beijing', 'Beijing', 'Dongcheng', 'GOVERNED_IMPORT', $1, 'ACTIVE')`,
    [HASH],
  );
  await db.query(
    `INSERT INTO core.fulfillment_targets (
       target_id, target_hash, buyer_wallet, idempotency_key, request_hash,
       fulfillment_mode, region_code, region_code_hash, encrypted_payload,
       encryption_iv, encryption_tag, expires_at, created_at
     ) VALUES ('target:test', $1, $2, 'seed-target-test', $1, 'DELIVERY',
       '110101', $1, $3, $4, $5, clock_timestamp() + interval '1 day', clock_timestamp())`,
    [HASH, BUYER, Buffer.from('00', 'hex'), Buffer.alloc(12), Buffer.alloc(16)],
  );
  await db.query(
    `INSERT INTO core.products (
       product_id, chain_product_id, merchant_id, version, title, lifecycle_state,
       product_policy_hash, merchant_concession_bps, metadata
     ) VALUES ('product-1', $1, 'merchant-1', 1, 'Product', 'ACTIVE', $2, 2500, '{}')`,
    [`0x${'b'.repeat(64)}`, HASH],
  );
  await db.query(
    `INSERT INTO core.skus (
       sku_id, chain_sku_id, product_id, sku_version, attributes, list_price_usdt,
       merchant_cost_usdt, stock_total, stock_available, lifecycle_state
     ) VALUES ('sku-1', $1, 'product-1', 1, '{}', 100, 60, $2, $2, 'ACTIVE')`,
    [`0x${'c'.repeat(64)}`, stock],
  );
}

async function insertLiveSeckillSession(db: PGlite, sessionId: string, now: Date, unitPrice: number) {
  await db.query(
    `INSERT INTO core.seckill_sessions (
       session_id, policy_version, merchant_id, product_id, sku_id,
       product_policy_hash, starts_at, main_deadline, relay_deadline,
       inventory, seckill_list_price_usdt, phase, snapshot
     ) VALUES ($1, 1, 'merchant-1', 'product-1', 'sku-1', $2,
       $3, $4, $5, 1, $6, 'LIVE', '{}')`,
    [
      sessionId,
      HASH,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 59 * 60_000),
      new Date(now.getTime() + 60_000),
      unitPrice,
    ],
  );
}

function paymentPolicyPayload() {
  return {
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
    platformFeeBps: 500,
    seckillPrizeBps: 300,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    oracleWindowSeconds: 1_800,
    oracleMaxDeviationBps: 500,
    oracleMaxAgeSeconds: 600,
    oracleMinimumUsdtLiquidity: (50_000n * 10n ** 18n).toString(),
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: (1_000n * 10n ** 18n).toString(),
    usdtCustodySafe: '0x3333333333333333333333333333333333333333',
    nplRewardSafe: '0x4444444444444444444444444444444444444444',
    operationsTreasurySafe: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6000000000000000000000000000000000000001',
    genesisCredential: '0x6000000000000000000000000000000000000002',
    genesisTokenId: '1',
    genesisCredentialStandard: 1,
    concessionDestinationSetHash: HASH,
    decisionEvidenceHash: HASH_2,
    concessionDestinations: [
      { account: '0x7000000000000000000000000000000000000001', weightBps: 4_000 },
      { account: '0x7000000000000000000000000000000000000002', weightBps: 6_000 },
    ],
    operationsDestinations: [
      { account: '0x5000000000000000000000000000000000000007', weightBps: 10_000 },
    ],
    otherUsdtDestinations: [
      { account: '0x7000000000000000000000000000000000000003', weightBps: 10_000 },
    ],
    seckillPrizePoolAccount: '0x7000000000000000000000000000000000000004',
  };
}

async function insertPaymentQuote(
  db: PGlite,
  intent: CanonicalPaymentIntent,
  idempotencyKey = 'test-payment-quote',
) {
  const snapshotHash = paymentIntentHash(intent);
  await db.query(
    `INSERT INTO core.payment_quotes (
       order_id, idempotency_key, artifact_version, buyer_wallet, merchant_id, merchant_wallet,
       product_id, sku_id, chain_product_id, chain_sku_id, product_policy_hash,
       list_price_usdt, merchant_cost_usdt, merchant_concession_bps,
       policy_version, quote_kind, authorization_digest, quote_signature, deadline, state
     ) VALUES ($1, $2, $3, $4, 'merchant-1', $5, 'product-1', 'sku-1', $6, $7, $8,
       100, 60, 2500, 1, 'ORDINARY', $9, $10, $11, 'QUOTED')`,
    [
      intent.orderId,
      idempotencyKey,
      CORE_ARTIFACT_VERSION,
      intent.buyer,
      intent.merchant,
      intent.productId,
      intent.skuId,
      intent.productPolicyHash,
      snapshotHash,
      `0x${'1'.repeat(130)}`,
      new Date(intent.deadline * 1000),
    ],
  );
  await db.query(
    `INSERT INTO core.payment_quote_legs (
       order_id, classification, reservation_id, snapshot_hash, intent
     ) VALUES ($1, 'ORDINARY', $2, $3, $4)`,
    [intent.orderId, intent.reservationId, snapshotHash, JSON.stringify(intent)],
  );
}

async function insertOrder(
  db: PGlite,
  orderId: string,
  reservationId: string,
  fulfillmentTargetHash = HASH,
  regionCodeHash = HASH,
) {
  await db.query(
    `INSERT INTO core.orders (
       order_id, artifact_version, policy_version, oracle_version, buyer_wallet,
       merchant_id, merchant_wallet, product_id, sku_id, quantity, fulfillment_mode,
       fulfillment_target_hash, region_code_hash, product_policy_hash, reservation_id,
       quote_snapshot, allocation_snapshot, exact_amounts, buyer_nonce, quote_deadline,
       state, finality_status
     ) VALUES (
       $1, '${CORE_ARTIFACT_VERSION}', 1, $2, $3, 'merchant-1', $4,
       'product-1', 'sku-1', 1, 'DELIVERY', $6, $7, $2, $5,
       '{}', '{}', '{"usdt":"50","npl":"500"}', 1,
       clock_timestamp() + interval '1 hour', 'QUOTED', 'NOT_SUBMITTED'
     )`,
    [orderId, HASH, BUYER, MERCHANT, reservationId, fulfillmentTargetHash, regionCodeHash],
  );
}

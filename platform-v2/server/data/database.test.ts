import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { appendAuditEntry, verifyAuditChain, type AuditRow } from './audit-chain.ts';
import { PostgresNonceStore, RedisNonceRateLimiter } from './auth-store.ts';
import { PostgresIndexerStore } from './indexer-store.ts';
import { reserveInventory } from './inventory.ts';
import { applyMigrations, type SqlExecutor, type SqlTransactionRunner } from './migrations.ts';
import { leaseDurableJobs } from './queue.ts';

const BUSINESS_MIGRATIONS = fileURLToPath(new URL('./migrations/business/', import.meta.url));
const AUDIT_MIGRATIONS = fileURLToPath(new URL('./migrations/audit/', import.meta.url));
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
    ]);
    assert.deepEqual(auditNames, ['001_audit_schema.sql', '002_evidence_policy.sql']);
    const businessTables = await business.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name",
    );
    assert.ok(businessTables.rows.some((row) => row.table_name === 'orders'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'outbox_events'));
    assert.ok(businessTables.rows.some((row) => row.table_name === 'chain_blocks'));
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
         ) VALUES ('missing-evidence', 'financial', 1, 'OrderPaid', 'ORDER', 'order-1',
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
          eventType: index === 1 ? 'OrderPaid' : 'FulfillmentFinalized',
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
            domain: 'Abu24KPaymentEscrow:2:56',
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
      domain: 'Abu24KPaymentEscrow:2:56',
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
          domain: 'Abu24KPaymentEscrow:2:56',
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
          domain: 'Abu24KPaymentEscrow:2:56',
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
     ) VALUES (1, '${CORE_ARTIFACT_VERSION}', $1, $2, $1, $2, '{}', 'PUBLISHED')`,
    [HASH, HASH_2],
  );
  await db.query(
    `INSERT INTO core.merchants (
       merchant_id, settlement_wallet, status, level, guarantee_status
     ) VALUES ('merchant-1', $1, 'APPROVED', 'V1', 'READY')`,
    [MERCHANT],
  );
  await db.query(
    `INSERT INTO core.products (
       product_id, merchant_id, version, title, lifecycle_state, product_policy_hash, metadata
     ) VALUES ('product-1', 'merchant-1', 1, 'Product', 'ACTIVE', $1, '{}')`,
    [HASH],
  );
  await db.query(
    `INSERT INTO core.skus (
       sku_id, product_id, sku_version, attributes, merchant_cost_usdt,
       stock_total, stock_available, lifecycle_state
     ) VALUES ('sku-1', 'product-1', 1, '{}', 30, $1, $1, 'ACTIVE')`,
    [stock],
  );
}

async function insertOrder(db: PGlite, orderId: string, reservationId: string) {
  await db.query(
    `INSERT INTO core.orders (
       order_id, artifact_version, policy_version, oracle_version, buyer_wallet,
       merchant_id, merchant_wallet, product_id, sku_id, quantity, fulfillment_mode,
       fulfillment_target_hash, region_code_hash, product_policy_hash, reservation_id,
       quote_snapshot, allocation_snapshot, exact_amounts, buyer_nonce, quote_deadline,
       state, finality_status
     ) VALUES (
       $1, '${CORE_ARTIFACT_VERSION}', 1, $2, $3, 'merchant-1', $4,
       'product-1', 'sku-1', 1, 'DELIVERY', $2, $2, $2, $5,
       '{}', '{}', '{"usdt":"50","npl":"500"}', 1,
       clock_timestamp() + interval '1 hour', 'QUOTED', 'NOT_SUBMITTED'
     )`,
    [orderId, HASH, BUYER, MERCHANT, reservationId],
  );
}

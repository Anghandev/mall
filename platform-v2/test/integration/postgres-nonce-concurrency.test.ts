import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from 'pg';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../../server/api/enums.ts';
import { applyMigrations } from '../../server/data/migrations.ts';
import { nextAvailableSettlementExecutorNonce } from '../../server/data/settlement-service.ts';
import { requiredPostgresAdminUrl } from './postgres-env.ts';

const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
const WALLET_A = '0x4444444444444444444444444444444444444444';
const WALLET_B = '0x5555555555555555555555555555555555555555';
const MIGRATIONS = fileURLToPath(new URL('../../server/data/migrations/business/', import.meta.url));

test('real PostgreSQL serializes settlement and WALLET_4 nonce reservations across connections', {
  timeout: 600_000,
}, async () => {
  const adminConnectionString = requiredPostgresAdminUrl('nonce concurrency');
  const databaseName = `abu24k_nonce_${randomBytes(6).toString('hex')}`;
  const databaseConnectionString = connectionForDatabase(adminConnectionString, databaseName);
  const admin = new Client({ connectionString: connectionForDatabase(adminConnectionString, 'postgres') });
  const clients: Client[] = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const migrationClient = await connected(databaseConnectionString, clients);
    await applyMigrations(migrationClient, 'core', MIGRATIONS);

    const settlement = await connected(databaseConnectionString, clients);
    const seckill = await connected(databaseConnectionString, clients);
    await settlementFirst(settlement, seckill);

    const setup = await connected(databaseConnectionString, clients);
    await insertPendingSeckillAction(setup);
    await seckillFirst(seckill, settlement);
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

async function settlementFirst(settlement: Client, seckill: Client) {
  await settlement.query('BEGIN');
  await settlement.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`settlement-executor:${WALLET_A}`],
  );
  assert.equal(await nextAvailableSettlementExecutorNonce(settlement, WALLET_A, '0'), '0');
  await settlement.query('SET LOCAL session_replication_role = replica');
  await settlement.query(
    `INSERT INTO core.settlement_transfers (
       transfer_id, artifact_version, chain_id, request_id, request_item_index,
       order_id, account_id, asset, token_address, executor_wallet, executor_nonce,
       recipient_address, amount, transfer_calldata, content_hash, idempotency_key,
       gas_cap, token_code_hash, token_transfer_conformance_evidence_hash,
       runtime_evidence_hash, runtime_checked_at, state, created_by, created_at
     ) VALUES (
       $1,$2,56,'request:postgres:1',0,'order:postgres:1','account:postgres:1',
       'USDT',$3,$4,0,$5,1,'0xa9059cbb',$6,'postgres-settlement-first',
       100000,$7,$8,$9,clock_timestamp(),'PENDING',$5,clock_timestamp()
     )`,
    [HASH_1, CORE_ARTIFACT_VERSION, USDT_ADDRESS, WALLET_A, WALLET_B, HASH_2, HASH_1, HASH_2, HASH_3],
  );

  let lockAcquired = false;
  let started!: () => void;
  const lockStarted = new Promise<void>((resolve) => { started = resolve; });
  const competing = (async () => {
    await seckill.query('BEGIN');
    started();
    const startedAt = Date.now();
    await seckill.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`settlement-executor:${WALLET_A}`],
    );
    lockAcquired = true;
    const conflict = await seckill.query<{ settlement_conflict: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.settlement_transfers transfer
         WHERE transfer.executor_wallet = $1 AND transfer.nonce_state <> 'RELEASED'
           AND transfer.executor_nonce = 0
       ) AS settlement_conflict`,
      [WALLET_A],
    );
    await seckill.query('COMMIT');
    return { waitedMs: Date.now() - startedAt, conflict: conflict.rows[0]?.settlement_conflict };
  })();
  await lockStarted;
  await delay(100);
  assert.equal(lockAcquired, false);
  await settlement.query('COMMIT');
  const result = await competing;
  assert.equal(result.conflict, true);
  assert.ok(result.waitedMs >= 80);
}

async function seckillFirst(seckill: Client, settlement: Client) {
  await seckill.query('BEGIN');
  await seckill.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`settlement-executor:${WALLET_B}`],
  );
  await seckill.query(
    `UPDATE core.seckill_governance_actions
     SET executor_nonce = 0, nonce_reserved_at = clock_timestamp(),
       nonce_reservation_evidence_hash = $2, execution_artifact_version = $3,
       execution_request_digest = $4, updated_at = clock_timestamp()
     WHERE action_id = $1 AND state = 'PENDING_EXECUTION' AND executor_nonce IS NULL`,
    [HASH_2, HASH_1, CORE_ARTIFACT_VERSION, HASH_3],
  );

  let lockAcquired = false;
  let started!: () => void;
  const lockStarted = new Promise<void>((resolve) => { started = resolve; });
  const competing = (async () => {
    await settlement.query('BEGIN');
    started();
    const startedAt = Date.now();
    await settlement.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`settlement-executor:${WALLET_B}`],
    );
    lockAcquired = true;
    const nonce = await nextAvailableSettlementExecutorNonce(settlement, WALLET_B, '0');
    await settlement.query('COMMIT');
    return { waitedMs: Date.now() - startedAt, nonce };
  })();
  await lockStarted;
  await delay(100);
  assert.equal(lockAcquired, false);
  await seckill.query('COMMIT');
  const result = await competing;
  assert.equal(result.nonce, '1');
  assert.ok(result.waitedMs >= 80);
}

async function insertPendingSeckillAction(client: Client) {
  await client.query('BEGIN');
  await client.query('SET LOCAL session_replication_role = replica');
  await client.query(
    `INSERT INTO core.seckill_governance_actions (
       action_id, session_id, policy_version, action_kind, evidence_hash,
       governance_wallet_address, target_address, calldata, calldata_hash,
       old_value_hash, new_value_hash, state, actor_wallet, idempotency_key,
       request_hash, created_at, updated_at
     ) VALUES ($1,$2,1,'PRIZE_INJECTION',$3,$4,$5,'0x00',$6,$7,$8,
       'PENDING_EXECUTION',$4,'postgres-seckill-first',$9,clock_timestamp(),clock_timestamp())`,
    [HASH_2, HASH_3, HASH_1, WALLET_B, USDT_ADDRESS, HASH_2, HASH_1, HASH_2, HASH_3],
  );
  await client.query('COMMIT');
}

async function connected(connectionString: string, clients: Client[]) {
  const client = new Client({ connectionString });
  await client.connect();
  clients.push(client);
  return client;
}

function connectionForDatabase(connectionString: string, database: string) {
  const value = new URL(connectionString);
  value.pathname = `/${database}`;
  return value.href;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

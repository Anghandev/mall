#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), '24k-database-stage-'));
const businessPath = join(root, 'business.db');
const auditPath = join(root, 'audit.db');
let server;

try {
  server = await startServer(businessPath, auditPath);
  const health = await waitForHealth(server);
  assert.equal(health.database.schemaVersion, 2);
  assert.equal(health.database.chainEventFinalityGuard, true);
  assert.equal(health.auditDatabase.schemaVersion, 1);
  assert.equal(health.auditDatabase.hashChainVerified, true);
  assert.equal(health.auditDatabase.appendOnly, true);
  assert.equal(health.auditDatabase.separate, true);

  const business = new DatabaseSync(businessPath);
  assert.deepEqual(
    business.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })),
    [
      { version: 1, name: 'baseline-business-schema' },
      { version: 2, name: 'chain-event-finality-and-checkpoints' }
    ]
  );
  assert.equal(tableExists(business, 'audit_logs'), false);
  assert.equal(tableExists(business, 'chain_sync_checkpoints'), true);
  assert.equal(tableExists(business, 'chain_reorg_incidents'), true);
  for (const column of ['block_hash', 'confirmation_count', 'required_confirmations', 'finality_status', 'finalized_at']) {
    assert.equal(columnNames(business, 'chain_events').has(column), true, `missing chain_events.${column}`);
  }
  assert.throws(() => insertFinalizedEvent(business, '1', 14, 15), /CHAIN_EVENT_FINALITY_REQUIRED/);
  insertFinalizedEvent(business, '2', 15, 15);
  assert.deepEqual(
    { ...business.prepare("SELECT confirmation_count, required_confirmations, finality_status FROM chain_events WHERE tx_hash = ?").get(hex32('2')) },
    { confirmation_count: 15, required_confirmations: 15, finality_status: 'Finalized' }
  );
  assert.throws(() => business.prepare("UPDATE chain_events SET finality_status = 'Legacy' WHERE tx_hash = ?").run(hex32('2')), /CHAIN_EVENTS_APPEND_ONLY/);
  assert.throws(() => business.prepare('DELETE FROM chain_events WHERE tx_hash = ?').run(hex32('2')), /CHAIN_EVENTS_APPEND_ONLY/);
  business.close();

  await stopServer(server);
  server = undefined;
  appendValidAuditEntry(auditPath);
  assertAuditAppendOnly(auditPath);

  server = await startServer(businessPath, auditPath);
  const restartedHealth = await waitForHealth(server);
  assert.equal(restartedHealth.auditDatabase.hashChainVerified, true);
  const restartedBusiness = new DatabaseSync(businessPath, { readOnly: true });
  assert.equal(restartedBusiness.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
  restartedBusiness.close();
  tamperAuditPayload(auditPath);
  const runtimeTamperHealth = await fetchHealth(server);
  assert.equal(runtimeTamperHealth.response.status, 503);
  assert.equal(runtimeTamperHealth.payload.auditDatabase.status, 'unavailable');
  await stopServer(server);
  server = undefined;

  const tampered = await spawnServer(businessPath, auditPath);
  const tamperedExit = await waitForExit(tampered.child, 8_000);
  assert.notEqual(tamperedExit.code, 0);
  assert.match(tampered.stderr, /AUDIT_CHAIN_INTEGRITY_FAILED/);

  await checkLegacyAuditMigration(root);
  await checkAliasedDatabaseRejection(root);
  console.log('database stage check: PASS');
} finally {
  if (server?.child.exitCode === null) {
    server.child.kill('SIGTERM');
    try { await waitForExit(server.child, 3_000); } catch { server.child.kill('SIGKILL'); }
  }
  rmSync(root, { recursive: true, force: true });
}

async function checkLegacyAuditMigration(base) {
  const legacyBusinessPath = join(base, 'legacy-business.db');
  const legacyAuditPath = join(base, 'legacy-audit.db');
  const legacy = new DatabaseSync(legacyBusinessPath);
  legacy.exec(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_address TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE chain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(tx_hash, log_index)
    );
    INSERT INTO audit_logs (actor_address, role, action, target, payload_json, created_at)
    VALUES ('system', 'system', 'legacy.action', 'legacy-target', '{"legacy":true}', '2026-07-13T00:00:00.000Z');
    INSERT INTO chain_events (chain_id, contract_address, order_id, tx_hash, block_number, log_index, event_name, payload_json)
    VALUES (56, '0x1111111111111111111111111111111111111111', '${hex32('1')}', '${hex32('2')}', 88, 0, 'LegacyEvent', '{}');
  `);
  legacy.close();

  let legacyServer = await startServer(legacyBusinessPath, legacyAuditPath);
  await waitForHealth(legacyServer);
  await stopServer(legacyServer);
  let business = new DatabaseSync(legacyBusinessPath);
  assert.equal(tableExists(business, 'audit_logs'), false);
  assert.equal(columnNames(business, 'chain_events').has('finality_status'), true);
  assert.deepEqual(
    { ...business.prepare("SELECT confirmation_count, required_confirmations, finality_status FROM chain_events WHERE event_name = 'LegacyEvent'").get() },
    { confirmation_count: 0, required_confirmations: 0, finality_status: 'Legacy' }
  );
  const uniqueShapes = uniqueIndexShapes(business, 'chain_events');
  assert.equal(uniqueShapes.includes('tx_hash,log_index'), false);
  assert.equal(uniqueShapes.includes('chain_id,tx_hash,log_index'), true);
  insertFinalizedEvent(business, '3', 15, 15, 57, '2');
  business.close();
  let audit = new DatabaseSync(legacyAuditPath, { readOnly: true });
  assert.equal(audit.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 1);
  assert.equal(audit.prepare('SELECT COUNT(*) AS count FROM audit_migrations').get().count, 1);
  audit.close();

  legacyServer = await startServer(legacyBusinessPath, legacyAuditPath);
  await waitForHealth(legacyServer);
  await stopServer(legacyServer);
  audit = new DatabaseSync(legacyAuditPath, { readOnly: true });
  assert.equal(audit.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 1);
  audit.close();
}

async function checkAliasedDatabaseRejection(base) {
  const businessPath = join(base, 'aliased-business.db');
  const auditPath = join(base, 'aliased-audit.db');
  const database = new DatabaseSync(businessPath);
  database.close();
  linkSync(businessPath, auditPath);
  const aliased = await spawnServer(businessPath, auditPath);
  const result = await waitForExit(aliased.child, 8_000);
  assert.notEqual(result.code, 0);
  assert.match(aliased.stderr, /DATABASE_FILES_MUST_BE_SEPARATE/);
}

function insertFinalizedEvent(database, digit, confirmations, requiredConfirmations, chainId = 56, txDigit = digit) {
  database.prepare(`
    INSERT INTO chain_events (
      chain_id, contract_address, order_id, tx_hash, block_number, block_hash, log_index, event_name,
      payload_json, confirmation_count, required_confirmations, finality_status, finalized_at
    ) VALUES (?, ?, ?, ?, 100, ?, 0, 'DatabaseStageEvent', '{}', ?, ?, 'Finalized', ?)
  `).run(chainId, address(digit), hex32(digit), hex32(txDigit), hex32('a'), confirmations, requiredConfirmations, new Date().toISOString());
}

function appendValidAuditEntry(path) {
  const audit = new DatabaseSync(path);
  const previousHash = `0x${'0'.repeat(64)}`;
  const actorAddress = 'system';
  const role = 'system';
  const action = 'database.stage.verify';
  const target = 'audit-chain';
  const payloadJson = '{"verified":true}';
  const payloadHash = sha256(payloadJson);
  const createdAt = '2026-07-13T00:00:00.000Z';
  const entryHash = sha256([previousHash, actorAddress, role, action, target, '', payloadHash, createdAt].join('|'));
  audit.prepare(`
    INSERT INTO audit_logs (
      actor_address, role, action, target, signature_hash, proof_type, payload_hash, payload_json,
      previous_hash, entry_hash, created_at
    ) VALUES (?, ?, ?, ?, NULL, 'system', ?, ?, ?, ?, ?)
  `).run(actorAddress, role, action, target, payloadHash, payloadJson, previousHash, entryHash, createdAt);
  audit.close();
}

function assertAuditAppendOnly(path) {
  const audit = new DatabaseSync(path);
  assert.throws(() => audit.exec("UPDATE audit_logs SET action = 'tampered' WHERE id = 1"), /AUDIT_LOG_APPEND_ONLY/);
  assert.throws(() => audit.exec('DELETE FROM audit_logs WHERE id = 1'), /AUDIT_LOG_APPEND_ONLY/);
  audit.close();
}

function tamperAuditPayload(path) {
  const audit = new DatabaseSync(path);
  audit.exec(`
    DROP TRIGGER audit_logs_no_update;
    UPDATE audit_logs SET payload_json = '{"verified":false}' WHERE id = 1;
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
    BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_APPEND_ONLY'); END;
  `);
  audit.close();
}

async function startServer(databasePath, auditDatabasePath) {
  const state = await spawnServer(databasePath, auditDatabasePath);
  state.healthUrl = `http://127.0.0.1:${state.port}/health`;
  return state;
}

async function spawnServer(databasePath, auditDatabasePath) {
  const port = await freePort();
  const state = { port, stdout: '', stderr: '' };
  state.child = spawn(process.execPath, [resolve('server/index.mjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: databasePath,
      AUDIT_DB_PATH: auditDatabasePath,
      JWT_SECRET: 'database-stage-jwt',
      ADMIN_SECRET: 'database-stage-admin',
      INDEXER_SECRET: 'database-stage-indexer',
      PRIVATE_KEY: '',
      DEPLOYER_PRIVATE_KEY: '',
      OWNER_PRIVATE_KEY: '',
      EXPO_PUBLIC_NPL_BSC_ADDRESS: '',
      EXPO_PUBLIC_BSC_CHAIN_ID: '56'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  state.child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  state.child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  return state;
}

async function waitForHealth(state) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (state.child.exitCode !== null) throw new Error(`API exited before health check: ${state.stderr}`);
    try {
      const response = await fetch(state.healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`API health timeout: ${state.stderr}`);
}

async function fetchHealth(state) {
  const response = await fetch(state.healthUrl, { signal: AbortSignal.timeout(2_000) });
  return { response, payload: await response.json() };
}

async function stopServer(state) {
  state.child.kill('SIGTERM');
  const result = await waitForExit(state.child, 8_000);
  assert.equal(result.code, 0, state.stderr);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('child process exit timeout'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timeout); rejectExit(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function uniqueIndexShapes(database, table) {
  return database.prepare(`PRAGMA index_list(${table})`).all()
    .filter((index) => Number(index.unique) === 1)
    .map((index) => database.prepare(`PRAGMA index_info(${index.name})`).all().map((row) => row.name).join(','));
}

function sha256(value) {
  return `0x${createHash('sha256').update(String(value)).digest('hex')}`;
}

function address(digit) {
  return `0x${digit.repeat(40)}`;
}

function hex32(digit) {
  return `0x${digit.repeat(64)}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const info = probe.address();
      probe.close((error) => error ? rejectPort(error) : resolvePort(info.port));
    });
  });
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), '24k-server-operations-'));
const databasePath = join(root, 'operations.db');
const backupPath = join(root, 'operations.backup.db');
const rollbackPath = join(root, 'operations.rollback.db');
const corruptBackupPath = join(root, 'corrupt.backup.db');
const corruptRollbackPath = join(root, 'corrupt.rollback.db');
const activeRestoreRollbackPath = join(root, 'active.restore.rollback.db');
const testSecret = 'operations-secret-must-not-leak';
const backupScript = resolve('scripts/ops/backup-db.mjs');
const restoreScript = resolve('scripts/ops/restore-db.mjs');
let apiServer;
let unwritableDirectory;

try {
  const port = await freePort();
  apiServer = startApi(port);
  const firstHealth = await waitForHealthy(port, apiServer);

  assert.equal(firstHealth.response.status, 200);
  assert.deepEqual(firstHealth.payload.liveness, { status: 'ok' });
  assert.deepEqual(firstHealth.payload.readiness, { status: 'ready' });
  assert.deepEqual(firstHealth.payload.database, {
    status: 'ok',
    foreignKeys: true,
    journalMode: 'wal',
    busyTimeoutMs: 5_000
  });
  assert.equal(JSON.stringify(firstHealth.payload).includes(testSecret), false);
  assert.equal(JSON.stringify(firstHealth.payload).includes(databasePath), false);

  const inspection = new DatabaseSync(databasePath);
  assert.equal(inspection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  inspection.exec('CREATE TABLE operations_check (value TEXT PRIMARY KEY); INSERT INTO operations_check VALUES (\'snapshot\');');
  inspection.close();

  const backup = await runNode(backupScript, ['--db', databasePath, '--out', backupPath]);
  assert.equal(backup.code, 0, backup.stderr);
  assert.equal(lastJson(backup.stdout).ok, true);
  assert.deepEqual(markerValues(backupPath), ['snapshot']);
  assertNoSensitiveOutput(backup);

  const overwriteBackup = await runNode(backupScript, ['--db', databasePath, '--out', backupPath]);
  assert.notEqual(overwriteBackup.code, 0);
  assert.equal(lastJson(overwriteBackup.stderr).error, 'BACKUP_ALREADY_EXISTS');
  assert.deepEqual(markerValues(backupPath), ['snapshot']);

  assert.equal(existsSync(`${databasePath}-shm`), true, 'active WAL database should have a shared-memory sidecar');
  const activeRestore = await runNode(restoreScript, [
    '--backup', backupPath,
    '--db', databasePath,
    '--rollback', activeRestoreRollbackPath
  ]);
  assert.notEqual(activeRestore.code, 0);
  assert.equal(lastJson(activeRestore.stderr).error, 'DATABASE_HAS_SQLITE_SIDECARS');
  assert.equal(existsSync(activeRestoreRollbackPath), false);

  const blocker = new DatabaseSync(databasePath);
  blocker.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
  const unavailableHealth = await fetchHealth(port, 8_000);
  assert.equal(unavailableHealth.response.status, 503);
  assert.equal(unavailableHealth.payload.ok, false);
  assert.deepEqual(unavailableHealth.payload.liveness, { status: 'ok' });
  assert.deepEqual(unavailableHealth.payload.readiness, { status: 'not_ready' });
  assert.deepEqual(unavailableHealth.payload.database, { status: 'unavailable' });
  blocker.exec('ROLLBACK');
  blocker.close();

  const recoveredHealth = await fetchHealth(port, 8_000);
  assert.equal(recoveredHealth.response.status, 200);
  assert.equal(recoveredHealth.payload.database.status, 'ok');

  apiServer.child.kill('SIGTERM');
  const stopped = await waitForExit(apiServer.child, 8_000);
  assert.equal(stopped.code, 0, apiServer.stderr);
  assert.equal(stopped.signal, null);
  assert.match(apiServer.stderr, /"event":"server_shutdown_started"/);
  assert.match(apiServer.stderr, /"event":"server_shutdown_complete","exitCode":0/);
  assert.equal(apiServer.stderr.includes(testSecret), false);
  assert.equal(apiServer.stderr.includes(databasePath), false);
  apiServer = undefined;

  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
  const startupRestoreLock = `${databasePath}.restore.lock`;
  writeFileSync(startupRestoreLock, '', { mode: 0o600 });
  const lockedStartup = await runNode(resolve('server/index.mjs'), [], {
    NODE_ENV: 'development',
    PORT: String(await freePort()),
    DB_PATH: databasePath,
    EXPO_PUBLIC_NPL_BSC_ADDRESS: '',
    EXPO_PUBLIC_BSC_CHAIN_ID: '56'
  });
  rmSync(startupRestoreLock, { force: true });
  assert.notEqual(lockedStartup.code, 0);
  assert.match(lockedStartup.stderr, /DATABASE_RESTORE_IN_PROGRESS/);

  const reopened = new DatabaseSync(databasePath);
  reopened.exec('BEGIN IMMEDIATE; INSERT INTO operations_check VALUES (\'after-backup\'); COMMIT;');
  assert.deepEqual(reopened.prepare('SELECT value FROM operations_check ORDER BY value').all().map((row) => row.value), ['after-backup', 'snapshot']);
  reopened.close();

  writeFileSync(corruptBackupPath, 'not a sqlite database', { mode: 0o600 });
  const corruptRestore = await runNode(restoreScript, [
    '--backup', corruptBackupPath,
    '--db', databasePath,
    '--rollback', corruptRollbackPath
  ]);
  assert.notEqual(corruptRestore.code, 0);
  assert.match(lastJson(corruptRestore.stderr).error, /^BACKUP_(?:INTEGRITY_CHECK_FAILED|INVALID_OR_CORRUPT)$/);
  assert.equal(existsSync(corruptRollbackPath), false);

  const restore = await runNode(restoreScript, [
    '--backup', backupPath,
    '--db', databasePath,
    '--rollback', rollbackPath
  ]);
  assert.equal(restore.code, 0, restore.stderr);
  assert.deepEqual(lastJson(restore.stdout), {
    ok: true,
    operation: 'restore',
    rollbackFile: basename(rollbackPath)
  });
  assert.deepEqual(markerValues(databasePath), ['snapshot']);
  assert.deepEqual(markerValues(rollbackPath), ['after-backup', 'snapshot']);
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.equal(statSync(rollbackPath).mode & 0o777, 0o600);
  assertNoSensitiveOutput(restore);

  const samePathRestore = await runNode(restoreScript, ['--backup', databasePath, '--db', databasePath]);
  assert.notEqual(samePathRestore.code, 0);
  assert.equal(lastJson(samePathRestore.stderr).error, 'DATABASE_PATHS_MUST_DIFFER');

  const hardlinkPath = join(root, 'database-hardlink.db');
  linkSync(databasePath, hardlinkPath);
  const hardlinkRestore = await runNode(restoreScript, ['--backup', hardlinkPath, '--db', databasePath]);
  assert.notEqual(hardlinkRestore.code, 0);
  assert.equal(lastJson(hardlinkRestore.stderr).error, 'DATABASE_PATHS_MUST_DIFFER');

  unwritableDirectory = join(root, 'unwritable');
  mkdirSync(unwritableDirectory, { mode: 0o700 });
  chmodSync(unwritableDirectory, 0o500);
  const productionPort = await freePort();
  const production = await runNode(resolve('server/index.mjs'), [], {
    ...productionEnvironment(productionPort, join(unwritableDirectory, 'production.db'))
  });
  assert.notEqual(production.code, 0);
  assert.match(production.stderr, /"event":"uncaught_exception"/);
  assert.match(production.stderr, /PRODUCTION_DB_DIRECTORY_NOT_WRITABLE/);
  assert.equal(production.stderr.includes(testSecret), false);
  assert.equal(production.stderr.includes(unwritableDirectory), false);

  console.log('server operations check: PASS');
} finally {
  if (apiServer?.child.exitCode === null) {
    apiServer.child.kill('SIGTERM');
    try {
      await waitForExit(apiServer.child, 3_000);
    } catch {
      apiServer.child.kill('SIGKILL');
    }
  }
  if (unwritableDirectory) {
    try { chmodSync(unwritableDirectory, 0o700); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}

function startApi(port) {
  const state = { stdout: '', stderr: '' };
  state.child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      NODE_ENV: 'development',
      PORT: String(port),
      DB_PATH: databasePath,
      MICRO_TEST: 'false',
      JWT_SECRET: testSecret,
      ADMIN_SECRET: `${testSecret}-admin`,
      INDEXER_SECRET: `${testSecret}-indexer`,
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

async function waitForHealthy(port, state) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (state.child.exitCode !== null) throw new Error(`API exited before health check: ${state.stderr}`);
    try {
      const result = await fetchHealth(port, 1_000);
      if (result.response.status === 200) return result;
    } catch {}
    await sleep(100);
  }
  throw new Error(`API did not become healthy: ${state.stderr}`);
}

async function fetchHealth(port, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  return { response, payload: await response.json() };
}

async function runNode(script, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await waitForExit(child, 15_000);
  return { ...result, stdout, stderr };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('child process exit timeout'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

function markerValues(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().flatMap((row) => Object.values(row));
    assert.deepEqual(integrity, ['ok']);
    return database.prepare('SELECT value FROM operations_check ORDER BY value').all().map((row) => row.value);
  } finally {
    database.close();
  }
}

function lastJson(output) {
  const line = output.trim().split('\n').filter(Boolean).at(-1);
  assert(line, 'expected JSON process output');
  return JSON.parse(line);
}

function assertNoSensitiveOutput(result) {
  assert.equal(result.stdout.includes(testSecret), false);
  assert.equal(result.stderr.includes(testSecret), false);
}

function productionEnvironment(port, path) {
  const webhookToken = 'w'.repeat(40);
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    DB_PATH: path,
    JWT_SECRET: 'j'.repeat(40),
    ADMIN_SECRET: 'a'.repeat(40),
    INDEXER_SECRET: 'i'.repeat(40),
    LOGISTICS_CALLBACK_SECRET: 'l'.repeat(40),
    ADMIN_WALLET_ADDRESS: address('1'),
    ORDER_SIGNER_ADDRESS: address('2'),
    MERCHANT_RECEIVER_ADDRESS: address('3'),
    EXPO_PUBLIC_ESCROW_ADDRESS: address('4'),
    EXPO_PUBLIC_REWARD_LEDGER_ADDRESS: address('5'),
    REWARD_LEDGER_ADDRESS: address('5'),
    EXPO_PUBLIC_SECKILL_ADDRESS: address('6'),
    SECKILL_ADDRESS: address('6'),
    EXPO_PUBLIC_BNM_BSC_ADDRESS: address('7'),
    CHAIN_EVENT_RPC_URL: 'https://rpc.example.test',
    FRONTEND_URL: 'https://mall.example.test',
    CORS_ORIGINS: 'https://mall.example.test',
    AMAP_WEB_SERVICE_KEY: 'amap-test-key',
    ELECTRONIC_WAYBILL_WEBHOOK_URL: 'https://ops.example.test/waybill',
    ELECTRONIC_WAYBILL_WEBHOOK_TOKEN: webhookToken,
    SHIPMENT_WEBHOOK_URL: 'https://ops.example.test/shipment',
    SHIPMENT_WEBHOOK_TOKEN: webhookToken,
    PRINT_WEBHOOK_URL: 'https://ops.example.test/print',
    PRINT_WEBHOOK_TOKEN: webhookToken,
    NOTIFICATION_WEBHOOK_URL: 'https://ops.example.test/notification',
    NOTIFICATION_WEBHOOK_TOKEN: webhookToken,
    ORDER_SIGNING_WEBHOOK_URL: 'https://ops.example.test/sign',
    ORDER_SIGNING_WEBHOOK_TOKEN: webhookToken,
    PRIVATE_KEY: '',
    DEPLOYER_PRIVATE_KEY: '',
    OWNER_PRIVATE_KEY: '',
    EXPO_PUBLIC_NPL_BSC_ADDRESS: '',
    EXPO_PUBLIC_BSC_CHAIN_ID: '56'
  };
}

function address(digit) {
  return `0x${digit.repeat(40)}`;
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const addressInfo = probe.address();
      probe.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(addressInfo.port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

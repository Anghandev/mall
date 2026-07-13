import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DATABASE_SIDECARS = ['-wal', '-shm', '-journal'];
const CORE_TABLES = ['orders', 'products'];

export function parseOptions(argv, allowedNames) {
  const allowed = new Set(allowedNames);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option)) throw new Error('UNKNOWN_OPTION');
    if (!value || value.startsWith('--')) throw new Error('OPTION_VALUE_REQUIRED');
    if (options[option] !== undefined) throw new Error('DUPLICATE_OPTION');
    options[option] = value;
  }
  return options;
}

export function requireExistingDatabase(value, label) {
  if (!value) throw new Error(`${label}_PATH_REQUIRED`);
  if (!isAbsolute(value)) throw new Error(`${label}_PATH_MUST_BE_ABSOLUTE`);
  let stats;
  try {
    stats = lstatSync(value);
  } catch {
    throw new Error(`${label}_NOT_FOUND`);
  }
  if (stats.isSymbolicLink()) throw new Error(`${label}_SYMLINK_NOT_ALLOWED`);
  if (!stats.isFile()) throw new Error(`${label}_MUST_BE_A_FILE`);
  try {
    return realpathSync(value);
  } catch {
    throw new Error(`${label}_PATH_INVALID`);
  }
}

export function requireUnusedDatabasePath(value, label) {
  if (!value) throw new Error(`${label}_PATH_REQUIRED`);
  if (!isAbsolute(value)) throw new Error(`${label}_PATH_MUST_BE_ABSOLUTE`);

  let parent;
  try {
    parent = realpathSync(dirname(value));
  } catch {
    throw new Error(`${label}_PARENT_NOT_FOUND`);
  }
  if (!lstatSync(parent).isDirectory()) throw new Error(`${label}_PARENT_NOT_A_DIRECTORY`);

  const target = join(parent, basename(value));
  if ([target, ...DATABASE_SIDECARS.map((suffix) => `${target}${suffix}`)].some(existsSync)) {
    throw new Error(`${label}_ALREADY_EXISTS`);
  }
  return target;
}

export function assertDifferentPaths(left, right) {
  if (left === right) throw new Error('DATABASE_PATHS_MUST_DIFFER');
  if (existsSync(left) && existsSync(right)) {
    const leftStats = statSync(left);
    const rightStats = statSync(right);
    if (leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino) {
      throw new Error('DATABASE_PATHS_MUST_DIFFER');
    }
  }
}

export function assertNoSidecars(databasePath, label) {
  if (DATABASE_SIDECARS.some((suffix) => existsSync(`${databasePath}${suffix}`))) {
    throw new Error(`${label}_HAS_SQLITE_SIDECARS`);
  }
}

export function assertNoRestoreInProgress(databasePath) {
  if (existsSync(`${databasePath}.restore.lock`)) throw new Error('RESTORE_IN_PROGRESS');
}

export function openValidatedDatabase(databasePath, label) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON;`);
    assertIntegrity(database, label);
    assertCoreSchema(database, label);
    return database;
  } catch (error) {
    try { database?.close(); } catch {}
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error(`${label}_INVALID_OR_CORRUPT`);
  }
}

export async function createVerifiedCopy(sourceDatabase, destinationPath, label) {
  let pages;
  try {
    pages = await backup(sourceDatabase, destinationPath);
    normalizeStandaloneDatabase(destinationPath, label);
    chmodSync(destinationPath, 0o600);
    syncFile(destinationPath);
    const verification = openValidatedDatabase(destinationPath, label);
    verification.close();
    removeSidecars(destinationPath);
    return pages;
  } catch (error) {
    removeDatabaseArtifacts(destinationPath);
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error(`${label}_COPY_FAILED`);
  }
}

export function publishWithoutOverwrite(stagingPath, destinationPath) {
  let published = false;
  try {
    linkSync(stagingPath, destinationPath);
    published = true;
    syncFile(destinationPath);
  } catch {
    if (published) removeDatabaseArtifacts(destinationPath);
    throw new Error('DESTINATION_ALREADY_EXISTS_OR_UNWRITABLE');
  }
}

export function replaceDatabase(stagingPath, destinationPath) {
  try {
    renameSync(stagingPath, destinationPath);
  } catch {
    throw new Error('DATABASE_REPLACE_FAILED');
  }
}

export function createStagingPath(destinationPath, kind) {
  return join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${kind}-${process.pid}-${randomBytes(8).toString('hex')}`
  );
}

export function acquireRestoreLock(databasePath) {
  const lockPath = `${databasePath}.restore.lock`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    closeSync(descriptor);
    return lockPath;
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    throw new Error('RESTORE_LOCK_UNAVAILABLE');
  }
}

export function databaseIdentity(databasePath) {
  try {
    const stats = statSync(databasePath, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  } catch {
    throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
  }
}

export function removeDatabaseArtifacts(databasePath) {
  rmSync(databasePath, { force: true });
  removeSidecars(databasePath);
}

export function safeFailureCode(error, fallback) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : fallback;
}

function assertIntegrity(database, label) {
  let rows;
  try {
    rows = database.prepare('PRAGMA integrity_check').all();
  } catch {
    throw new Error(`${label}_INTEGRITY_CHECK_FAILED`);
  }
  const results = rows.flatMap((row) => Object.values(row)).map((value) => String(value).toLowerCase());
  if (results.length === 0 || results.some((value) => value !== 'ok')) {
    throw new Error(`${label}_INTEGRITY_CHECK_FAILED`);
  }
}

function assertCoreSchema(database, label) {
  const placeholders = CORE_TABLES.map(() => '?').join(',');
  const rows = database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${placeholders})`).all(...CORE_TABLES);
  if (new Set(rows.map((row) => row.name)).size !== CORE_TABLES.length) {
    throw new Error(`${label}_NOT_24K_DATABASE`);
  }
}

export function normalizeStandaloneDatabase(databasePath, label) {
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    const journalMode = String(database.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode || '').toLowerCase();
    if (journalMode !== 'delete') throw new Error(`${label}_JOURNAL_NORMALIZATION_FAILED`);
    database.close();
    database = undefined;
    removeSidecars(databasePath);
  } catch (error) {
    try { database?.close(); } catch {}
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error(`${label}_JOURNAL_NORMALIZATION_FAILED`);
  }
}

function syncFile(filePath) {
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeSidecars(databasePath) {
  for (const suffix of DATABASE_SIDECARS) rmSync(`${databasePath}${suffix}`, { force: true });
}

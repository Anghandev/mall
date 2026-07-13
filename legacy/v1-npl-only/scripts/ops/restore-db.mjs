#!/usr/bin/env node
import { basename, dirname, join } from 'node:path';
import {
  acquireRestoreLock,
  assertDifferentPaths,
  assertNoSidecars,
  createStagingPath,
  createVerifiedCopy,
  databaseIdentity,
  normalizeStandaloneDatabase,
  openValidatedDatabase,
  parseOptions,
  publishWithoutOverwrite,
  removeDatabaseArtifacts,
  replaceDatabase,
  requireExistingDatabase,
  requireUnusedDatabasePath,
  safeFailureCode
} from './db-utils.mjs';

let lockPath;
let rollbackStagingPath;
let restoreStagingPath;

try {
  const options = parseOptions(process.argv.slice(2), ['--backup', '--db', '--rollback']);
  const backupPath = requireExistingDatabase(options['--backup'], 'BACKUP');
  const databasePath = requireExistingDatabase(options['--db'], 'DATABASE');
  assertDifferentPaths(backupPath, databasePath);
  lockPath = acquireRestoreLock(databasePath);
  assertNoSidecars(backupPath, 'BACKUP');
  assertNoSidecars(databasePath, 'DATABASE');

  const rollbackPath = requireUnusedDatabasePath(
    options['--rollback'] || defaultRollbackPath(databasePath),
    'ROLLBACK'
  );
  assertDifferentPaths(backupPath, rollbackPath);
  assertDifferentPaths(databasePath, rollbackPath);

  rollbackStagingPath = createStagingPath(rollbackPath, 'rollback');
  restoreStagingPath = createStagingPath(databasePath, 'restore');

  const backupDatabase = openValidatedDatabase(backupPath, 'BACKUP');
  let originalDatabase;
  let originalIdentity;
  try {
    normalizeStandaloneDatabase(databasePath, 'DATABASE');
    originalIdentity = databaseIdentity(databasePath);
    originalDatabase = openValidatedDatabase(databasePath, 'DATABASE');
    await createVerifiedCopy(originalDatabase, rollbackStagingPath, 'ROLLBACK');
    publishWithoutOverwrite(rollbackStagingPath, rollbackPath);
    await createVerifiedCopy(backupDatabase, restoreStagingPath, 'RESTORE');
  } finally {
    originalDatabase?.close();
    backupDatabase.close();
  }

  assertNoSidecars(databasePath, 'DATABASE');
  if (databaseIdentity(databasePath) !== originalIdentity) throw new Error('DATABASE_CHANGED_DURING_RESTORE');
  replaceDatabase(restoreStagingPath, databasePath);

  const restoredDatabase = openValidatedDatabase(databasePath, 'RESTORED_DATABASE');
  restoredDatabase.close();
  console.log(JSON.stringify({ ok: true, operation: 'restore', rollbackFile: basename(rollbackPath) }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, operation: 'restore', error: safeFailureCode(error, 'RESTORE_FAILED') }));
  process.exitCode = 1;
} finally {
  if (rollbackStagingPath) removeDatabaseArtifacts(rollbackStagingPath);
  if (restoreStagingPath) removeDatabaseArtifacts(restoreStagingPath);
  if (lockPath) removeDatabaseArtifacts(lockPath);
}

function defaultRollbackPath(databasePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(dirname(databasePath), `${basename(databasePath)}.rollback-${timestamp}-${process.pid}.db`);
}

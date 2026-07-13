#!/usr/bin/env node
import {
  assertDifferentPaths,
  assertNoRestoreInProgress,
  createStagingPath,
  createVerifiedCopy,
  openValidatedDatabase,
  parseOptions,
  publishWithoutOverwrite,
  removeDatabaseArtifacts,
  requireExistingDatabase,
  requireUnusedDatabasePath,
  safeFailureCode
} from './db-utils.mjs';

try {
  const options = parseOptions(process.argv.slice(2), ['--db', '--out']);
  const sourcePath = requireExistingDatabase(options['--db'], 'SOURCE_DATABASE');
  const destinationPath = requireUnusedDatabasePath(options['--out'], 'BACKUP');
  assertDifferentPaths(sourcePath, destinationPath);
  assertNoRestoreInProgress(sourcePath);

  const stagingPath = createStagingPath(destinationPath, 'backup');
  const source = openValidatedDatabase(sourcePath, 'SOURCE_DATABASE');
  try {
    const pages = await createVerifiedCopy(source, stagingPath, 'BACKUP');
    publishWithoutOverwrite(stagingPath, destinationPath);
    console.log(JSON.stringify({ ok: true, operation: 'backup', pages }));
  } finally {
    source.close();
    removeDatabaseArtifacts(stagingPath);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, operation: 'backup', error: safeFailureCode(error, 'BACKUP_FAILED') }));
  process.exitCode = 1;
}

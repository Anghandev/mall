#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const scope = process.argv[2];
const input = process.argv[3];
if (!['business', 'audit'].includes(scope) || !input) {
  throw new Error('Usage: database-restore.mjs <business|audit> <input.dump>');
}
const variable = scope === 'business' ? 'DATABASE_URL' : 'AUDIT_DATABASE_URL';
const connectionString = process.env[variable];
if (!connectionString) throw new Error(`${variable}: ConfigurationRequired`);
if (process.env.BACKUP_STORAGE_ENCRYPTED !== 'true') {
  throw new Error('BACKUP_STORAGE_ENCRYPTED: ExternalBlocked');
}
const databaseUrl = new URL(connectionString);
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
if (!databaseName) throw new Error(`${variable}: database name is required`);
const postgresEnv = {
  ...process.env,
  PGHOST: databaseUrl.hostname,
  PGPORT: databaseUrl.port || '5432',
  PGUSER: decodeURIComponent(databaseUrl.username),
  PGPASSWORD: decodeURIComponent(databaseUrl.password),
  PGDATABASE: databaseName,
};
const sslMode = databaseUrl.searchParams.get('sslmode');
if (sslMode) postgresEnv.PGSSLMODE = sslMode;

const expected = readFileSync(`${input}.sha256`, 'utf8').trim().split(/\s+/)[0];
const actual = createHash('sha256').update(readFileSync(input)).digest('hex');
if (!expected || expected !== actual) throw new Error('Backup checksum mismatch');

const preflight = spawnSync(
  'psql',
  ['--tuples-only', '--no-align', '--command', "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"],
  { env: postgresEnv, encoding: 'utf8' },
);
if (preflight.error) throw new Error('psql is required for restore preflight');
if (preflight.status !== 0 || Number(preflight.stdout.trim()) !== 0) {
  throw new Error('Restore target must be an empty database');
}

const result = spawnSync(
  'pg_restore',
  ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', databaseName, input],
  { env: postgresEnv, encoding: 'utf8' },
);
if (result.error) throw new Error('pg_restore is required for production restore');
if (result.status !== 0) throw new Error(`pg_restore failed with exit ${result.status}`);
console.log(`Restore complete for ${scope}; source checksum verified.`);

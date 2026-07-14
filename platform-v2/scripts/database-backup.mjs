#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

process.umask(0o077);

const scope = process.argv[2];
const output = process.argv[3];
if (!['business', 'audit'].includes(scope) || !output) {
  throw new Error('Usage: database-backup.mjs <business|audit> <output.dump>');
}
const variable = scope === 'business' ? 'DATABASE_URL' : 'AUDIT_DATABASE_URL';
const connectionString = process.env[variable];
if (!connectionString) throw new Error(`${variable}: ConfigurationRequired`);
if (process.env.BACKUP_STORAGE_ENCRYPTED !== 'true') {
  throw new Error('BACKUP_STORAGE_ENCRYPTED: ExternalBlocked');
}
if (existsSync(output) || existsSync(`${output}.sha256`)) throw new Error('Backup output already exists');

const temporary = `${output}.${process.pid}.tmp`;
closeSync(openSync(temporary, 'wx', 0o600));

const result = spawnSync(
  'pg_dump',
  ['--format=custom', '--no-owner', '--no-acl', '--file', temporary],
  { env: { ...process.env, PGDATABASE: connectionString }, encoding: 'utf8' },
);
if (result.error || result.status !== 0) {
  unlinkSync(temporary);
  if (result.error) throw new Error('pg_dump is required for production backup');
  throw new Error(`pg_dump failed with exit ${result.status}`);
}
chmodSync(temporary, 0o600);
renameSync(temporary, output);
chmodSync(output, 0o600);
const checksum = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${checksum}  ${output.split('/').pop()}\n`, { mode: 0o600, flag: 'wx' });
chmodSync(`${output}.sha256`, 0o600);
console.log(`Backup complete for ${scope}; checksum manifest written.`);

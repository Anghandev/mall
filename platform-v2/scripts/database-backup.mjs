#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const scope = process.argv[2];
const output = process.argv[3];
if (!['business', 'audit'].includes(scope) || !output) {
  throw new Error('Usage: database-backup.mjs <business|audit> <output.dump>');
}
const variable = scope === 'business' ? 'DATABASE_URL' : 'AUDIT_DATABASE_URL';
const connectionString = process.env[variable];
if (!connectionString) throw new Error(`${variable}: ConfigurationRequired`);

const result = spawnSync(
  'pg_dump',
  ['--format=custom', '--no-owner', '--no-acl', '--file', output],
  { env: { ...process.env, PGDATABASE: connectionString }, encoding: 'utf8' },
);
if (result.error) throw new Error('pg_dump is required for production backup');
if (result.status !== 0) throw new Error(`pg_dump failed with exit ${result.status}`);
const checksum = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${checksum}  ${output.split('/').pop()}\n`, { mode: 0o600 });
console.log(`Backup complete for ${scope}; checksum manifest written.`);

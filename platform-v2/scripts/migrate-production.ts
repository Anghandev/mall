import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
import { Client } from 'pg';
import { migratePostgres } from '../server/data/migrations.ts';

const here = dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
const auditDatabaseUrl = process.env.AUDIT_DATABASE_URL;
const governanceWallet = process.env.PLATFORM_GOVERNANCE_WALLET_ADDRESS;
if (!databaseUrl || !auditDatabaseUrl || !governanceWallet) {
  throw new Error('DATABASE_URL, AUDIT_DATABASE_URL and PLATFORM_GOVERNANCE_WALLET_ADDRESS are required');
}

const business = await migratePostgres(
  databaseUrl,
  'core',
  join(here, '../server/data/migrations/business'),
);
const audit = await migratePostgres(
  auditDatabaseUrl,
  'audit',
  join(here, '../server/data/migrations/audit'),
);
const normalizedGovernanceWallet = getAddress(governanceWallet).toLowerCase();
const adminEvidenceHash = `0x${createHash('sha256')
  .update('ABU24K_INITIAL_ADMIN_BINDING_V1\0')
  .update(normalizedGovernanceWallet)
  .digest('hex')}`;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `INSERT INTO core.wallet_role_bindings (
       wallet_address, role, merchant_id, status, evidence_hash
     ) VALUES ($1,'ADMIN',NULL,'ACTIVE',$2)
     ON CONFLICT (wallet_address, role) DO NOTHING`,
    [normalizedGovernanceWallet, adminEvidenceHash],
  );
} finally {
  await client.end();
}
console.log(`Applied business migrations: ${business.length}`);
console.log(`Applied audit migrations: ${audit.length}`);

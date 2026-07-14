import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

export interface SqlResult<Row extends object = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<Row>>;
  exec?(sql: string): Promise<unknown>;
}

export async function applyMigrations(executor: SqlExecutor, schema: 'core' | 'audit', directory: string) {
  await execute(
    executor,
    `CREATE SCHEMA IF NOT EXISTS ${schema};
     CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
       migration_name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
     );`,
  );
  const applied = await executor.query<{ migration_name: string }>(
    `SELECT migration_name FROM ${schema}.schema_migrations`,
  );
  const appliedNames = new Set(applied.rows.map((row) => row.migration_name));
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  for (const name of names) {
    if (appliedNames.has(name)) continue;
    const sql = await readFile(join(directory, name), 'utf8');
    await execute(executor, 'BEGIN');
    try {
      await execute(executor, sql);
      await executor.query(`INSERT INTO ${schema}.schema_migrations (migration_name) VALUES ($1)`, [name]);
      await execute(executor, 'COMMIT');
    } catch (error) {
      await execute(executor, 'ROLLBACK');
      throw error;
    }
  }

  return names;
}

export async function migratePostgres(connectionString: string, schema: 'core' | 'audit', directory: string) {
  if (!connectionString) throw new Error(`${schema === 'core' ? 'DATABASE_URL' : 'AUDIT_DATABASE_URL'} is required`);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await applyMigrations(client, schema, directory);
  } finally {
    await client.end();
  }
}

async function execute(executor: SqlExecutor, sql: string) {
  if (executor.exec) return executor.exec(sql);
  return executor.query(sql);
}

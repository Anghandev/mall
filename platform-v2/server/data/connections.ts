import { Pool, type PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';

export function createPostgresPool(connectionString: string) {
  if (!connectionString) throw new Error('Database connection string is required');
  const pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => {
    // Pool errors are surfaced through readiness and structured audit by the caller.
  });
  return pool;
}

export async function withTransaction<Result>(pool: Pool, operation: (client: PoolClient) => Promise<Result>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createRedisConnection(url: string): Promise<RedisClientType> {
  if (!url) throw new Error('REDIS_URL is required');
  const client = createClient({ url });
  client.on('error', () => {
    // Connection failures are exposed as ConfigurationRequired/Unavailable by the caller.
  });
  await client.connect();
  return client;
}

export async function acquireRedisLock(client: RedisClientType, key: string, token: string, ttlMs: number) {
  if (!key || !token || ttlMs < 100 || ttlMs > 60_000) throw new Error('InvalidRedisLock');
  return (await client.set(key, token, { NX: true, PX: ttlMs })) === 'OK';
}

export async function releaseRedisLock(client: RedisClientType, key: string, token: string) {
  const result = await client.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1]
       then return redis.call('del', KEYS[1])
       else return 0
     end`,
    { keys: [key], arguments: [token] },
  );
  return result === 1;
}

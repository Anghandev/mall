import { createHash } from 'node:crypto';
import type { SqlExecutor } from './migrations.ts';
import type { NonceRateLimiter, NonceStore, StoredNonce } from '../api/auth.ts';
import { CoreError } from '../api/errors.ts';

export class PostgresNonceStore implements NonceStore {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async save(nonce: StoredNonce) {
    await this.cleanupExpired(nonce.issuedAt, 100);
    await this.#database.query(
      `INSERT INTO core.auth_nonces (
         wallet_address, nonce_hash, domain, uri, chain_id, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        nonce.walletAddress,
        nonce.nonceHash,
        nonce.domain,
        nonce.uri,
        nonce.chainId,
        nonce.issuedAt,
        nonce.expiresAt,
      ],
    );
  }

  async cleanupExpired(now: Date, limit = 1_000) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new Error('InvalidNonceCleanupLimit');
    await this.#database.query(
      `DELETE FROM core.auth_nonces
       WHERE nonce_hash IN (
         SELECT nonce_hash
         FROM core.auth_nonces
         WHERE expires_at < $1 OR consumed_at IS NOT NULL
         ORDER BY expires_at
         LIMIT $2
       )`,
      [now, limit],
    );
  }

  async consume(walletAddress: string, nonceHash: string, now: Date) {
    const result = await this.#database.query<NonceRow>(
      `UPDATE core.auth_nonces
       SET consumed_at = $3
       WHERE wallet_address = $1
         AND nonce_hash = $2
         AND consumed_at IS NULL
         AND expires_at >= $3
       RETURNING *`,
      [walletAddress, nonceHash, now],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }
}

interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class RedisNonceRateLimiter implements NonceRateLimiter {
  readonly #redis: RedisEvalClient;

  constructor(redis: RedisEvalClient) {
    this.#redis = redis;
  }

  async consume(input: { walletAddress: string; clientAddress: string; now: Date }) {
    const walletWindow = Math.floor(input.now.getTime() / (5 * 60_000));
    const requestWindow = Math.floor(input.now.getTime() / 60_000);
    const keys = [
      `siwe:rate:wallet:${digest(input.walletAddress.toLowerCase())}:${walletWindow}`,
      `siwe:rate:client:${digest(input.clientAddress)}:${requestWindow}`,
      `siwe:rate:global:${requestWindow}`,
    ];
    let allowed: unknown;
    try {
      allowed = await this.#redis.eval(
        `local allowed = 1
         for index, key in ipairs(KEYS) do
           local count = redis.call('INCR', key)
           if count == 1 then redis.call('PEXPIRE', key, ARGV[4]) end
           if count > tonumber(ARGV[index]) then allowed = 0 end
         end
         return allowed`,
        { keys, arguments: ['3', '20', '500', '360000'] },
      );
    } catch {
      throw new CoreError('ExternalBlocked', 'SIWE rate limiter is unavailable', 503);
    }
    if (Number(allowed) !== 1) throw new CoreError('InvalidRequest', 'SIWE challenge rate limit exceeded', 429);
  }
}

interface NonceRow {
  wallet_address: string;
  nonce_hash: string;
  domain: string;
  uri: string;
  chain_id: number | string;
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

function fromRow(row: NonceRow): StoredNonce {
  return {
    walletAddress: row.wallet_address,
    nonceHash: row.nonce_hash,
    domain: row.domain,
    uri: row.uri,
    chainId: Number(row.chain_id) as 56,
    issuedAt: new Date(row.issued_at),
    expiresAt: new Date(row.expires_at),
    ...(row.consumed_at ? { consumedAt: new Date(row.consumed_at) } : {}),
  };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

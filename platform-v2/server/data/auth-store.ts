import type { SqlExecutor } from './migrations.ts';
import type { NonceStore, StoredNonce } from '../api/auth.ts';

export class PostgresNonceStore implements NonceStore {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async save(nonce: StoredNonce) {
    await this.#database.query(
      `INSERT INTO core.auth_nonces (
         wallet_address, nonce_hash, domain, uri, chain_id, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (wallet_address) DO UPDATE SET
         nonce_hash = EXCLUDED.nonce_hash,
         domain = EXCLUDED.domain,
         uri = EXCLUDED.uri,
         chain_id = EXCLUDED.chain_id,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         consumed_at = NULL,
         created_at = clock_timestamp()`,
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

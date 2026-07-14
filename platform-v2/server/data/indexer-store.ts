import { CoreError } from '../api/errors.ts';
import type {
  CanonicalCheckpoint,
  IndexedChainBlock,
  IndexerStore,
} from '../chain/indexer.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

interface BlockRow {
  block_number: string | number;
  block_hash: string;
}

export class PostgresIndexerStore implements IndexerStore {
  readonly #transactions: SqlTransactionRunner;

  constructor(transactions: SqlTransactionRunner) {
    this.#transactions = transactions;
  }

  checkpoint() {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<BlockRow>(
        `SELECT block_number, block_hash
         FROM core.chain_blocks
         WHERE canonical
         ORDER BY block_number DESC
         LIMIT 1`,
      );
      return checkpoint(result.rows[0]);
    });
  }

  canonicalAt(blockNumber: number) {
    return this.#transactions.transaction(async (executor) => {
      const result = await executor.query<BlockRow>(
        `SELECT block_number, block_hash
         FROM core.chain_blocks
         WHERE canonical AND block_number = $1`,
        [blockNumber],
      );
      return checkpoint(result.rows[0]);
    });
  }

  appendCanonical(expectedHead: CanonicalCheckpoint | undefined, segment: IndexedChainBlock[]) {
    return this.#transactions.transaction(async (executor) => {
      await assertHead(executor, expectedHead);
      await insertSegment(executor, segment);
    });
  }

  replaceCanonical(
    expectedHead: CanonicalCheckpoint,
    commonAncestor: CanonicalCheckpoint,
    segment: IndexedChainBlock[],
  ) {
    return this.#transactions.transaction(async (executor) => {
      await assertHead(executor, expectedHead);
      const ancestor = await executor.query<BlockRow>(
        `SELECT block_number, block_hash
         FROM core.chain_blocks
         WHERE canonical AND block_number = $1
         FOR UPDATE`,
        [commonAncestor.blockNumber],
      );
      if (checkpoint(ancestor.rows[0])?.blockHash.toLowerCase() !== commonAncestor.blockHash.toLowerCase()) {
        throw new CoreError('ReorgPending', 'Indexer common ancestor changed', 409);
      }
      await executor.query(
        `UPDATE core.chain_events
         SET canonical = false, replaced_at = clock_timestamp()
         WHERE canonical AND block_number > $1`,
        [commonAncestor.blockNumber],
      );
      await executor.query(
        `UPDATE core.chain_blocks
         SET canonical = false, replaced_at = clock_timestamp()
         WHERE canonical AND block_number > $1`,
        [commonAncestor.blockNumber],
      );
      await insertSegment(executor, segment);
      await executor.query(
        `INSERT INTO core.chain_reorg_evidence (
           from_block, expected_hash, observed_hash, status, common_ancestor
         ) VALUES ($1, $2, $3, 'RECONCILED', $4)`,
        [segment[0]!.block.number, expectedHead.blockHash, segment.at(-1)!.block.hash, commonAncestor.blockNumber],
      );
    });
  }

  markReorg(fromBlock: number, expectedParentHash: string, observedParentHash: string) {
    return this.#transactions.transaction(async (executor) => {
      await executor.query(
        `INSERT INTO core.chain_reorg_evidence (
           from_block, expected_hash, observed_hash, status
         ) VALUES ($1, $2, $3, 'PENDING')`,
        [fromBlock, expectedParentHash, observedParentHash],
      );
    });
  }
}

async function assertHead(executor: SqlExecutor, expected: CanonicalCheckpoint | undefined) {
  const result = await executor.query<BlockRow>(
    `SELECT block_number, block_hash
     FROM core.chain_blocks
     WHERE canonical
     ORDER BY block_number DESC
     LIMIT 1
     FOR UPDATE`,
  );
  const actual = checkpoint(result.rows[0]);
  if (
    actual?.blockNumber !== expected?.blockNumber ||
    actual?.blockHash.toLowerCase() !== expected?.blockHash.toLowerCase()
  ) {
    throw new CoreError('ReorgPending', 'Indexer canonical head changed concurrently', 409);
  }
}

async function insertSegment(executor: SqlExecutor, segment: IndexedChainBlock[]) {
  if (segment.length === 0) throw new CoreError('InvalidFinality', 'Indexer segment is empty');
  for (const { block, events } of segment) {
    await executor.query(
      `INSERT INTO core.chain_blocks (
         block_hash, block_number, parent_hash, block_timestamp, canonical
       ) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (block_hash) DO UPDATE SET
         canonical = true,
         replaced_at = NULL`,
      [block.hash, block.number, block.parentHash, block.timestamp],
    );
    for (const event of events) {
      await executor.query(
        `INSERT INTO core.chain_events (
           block_hash, transaction_hash, log_index, block_number, artifact_version,
           contract_name, event_name, event_signature, resource_id, values, canonical
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
         ON CONFLICT (block_hash, transaction_hash, log_index) DO UPDATE SET
           canonical = true,
           replaced_at = NULL`,
        [
          event.blockHash,
          event.transactionHash,
          event.logIndex,
          event.blockNumber,
          event.artifactVersion,
          event.contract,
          event.eventName,
          event.eventSignature,
          event.resourceId,
          event.values,
        ],
      );
    }
  }
}

function checkpoint(row: BlockRow | undefined): CanonicalCheckpoint | undefined {
  return row ? { blockNumber: Number(row.block_number), blockHash: row.block_hash } : undefined;
}

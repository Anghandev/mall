import { CoreError } from '../api/errors.ts';
import type {
  CanonicalCheckpoint,
  IndexedChainBlock,
  IndexerStore,
} from '../chain/indexer.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import {
  advancePaymentFinality,
  paymentEventKey,
  recordPaymentProjection,
  reversePaymentProjection,
  type CanonicalPaymentEvent,
} from './payment-store.ts';

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
      await projectPayments(executor, segment);
      await advancePaymentFinality(executor, segment.at(-1)!.block.number);
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
      const orphanedPayments = await executor.query<{
        transaction_hash: string;
        log_index: string | number;
        block_hash: string;
      }>(
        `SELECT transaction_hash, log_index, block_hash
         FROM core.chain_events
         WHERE canonical AND block_number > $1
           AND contract_name = 'PaymentRouterV2' AND event_name = 'PaymentCompleted'
         ORDER BY block_number DESC, log_index DESC
         FOR UPDATE`,
        [commonAncestor.blockNumber],
      );
      for (const payment of orphanedPayments.rows) {
        await reversePaymentProjection(
          executor,
          paymentEventKey(payment.transaction_hash, Number(payment.log_index), payment.block_hash),
          segment.at(-1)!.block.hash,
        );
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
      await projectPayments(executor, segment);
      await advancePaymentFinality(executor, segment.at(-1)!.block.number);
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

async function projectPayments(executor: SqlExecutor, segment: IndexedChainBlock[]) {
  const canonicalHead = segment.at(-1)!.block.number;
  for (const { block, events } of segment) {
    for (const event of events) {
      if (event.contract !== 'PaymentRouterV2' || event.eventName !== 'PaymentCompleted') continue;
      await recordPaymentProjection(executor, {
        event: canonicalPaymentEvent(block, event, segment, canonicalHead),
      });
    }
  }
}

function canonicalPaymentEvent(
  block: IndexedChainBlock['block'],
  event: IndexedChainBlock['events'][number],
  segment: IndexedChainBlock[],
  canonicalHead: number,
): CanonicalPaymentEvent {
  const classification = paymentClassification(event.values.classification);
  const confirmations = canonicalHead - block.number + 1;
  const confirmationBlock = confirmations >= 15
    ? segment.find((item) => item.block.number === block.number + 14)?.block
    : undefined;
  if (confirmations >= 15 && !confirmationBlock) {
    throw new CoreError('InvalidFinality', 'Canonical confirmation block is missing from the indexed segment');
  }
  return {
    artifactVersion: event.artifactVersion,
    orderId: event.resourceId,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    blockTimestamp: new Date(block.timestamp * 1000),
    ...(confirmationBlock ? { finalizedAt: new Date(confirmationBlock.timestamp * 1000) } : {}),
    contractAddress: event.contractAddress,
    eventHash: event.eventHash,
    snapshotHash: requiredValue(event.values, 'snapshotHash'),
    classification,
    buyer: requiredValue(event.values, 'buyer'),
    merchant: requiredValue(event.values, 'merchant'),
    policyVersion: safeInteger(event.values, 'policyVersion'),
    listPriceUsdt: decimalValue(event.values, 'listPriceUsdt'),
    usdtPaid: decimalValue(event.values, 'usdtPaid'),
    nplPaid: decimalValue(event.values, 'nplPaid'),
    nplBurned: decimalValue(event.values, 'nplBurned'),
    nplRewarded: decimalValue(event.values, 'nplRewarded'),
    bnmLocked: decimalValue(event.values, 'bnmLocked'),
    reservationId: requiredValue(event.values, 'reservationId'),
    confirmations,
  };
}

function paymentClassification(value: string | undefined): CanonicalPaymentEvent['classification'] {
  const classification = value === '0' ? 'ORDINARY' : value === '1' ? 'SECKILL' : value === '2' ? 'FALLBACK_RETAIL' : undefined;
  if (!classification) throw new CoreError('InvalidFinality', 'Unknown PaymentCompleted classification');
  return classification;
}

function requiredValue(values: Record<string, string>, name: string) {
  const value = values[name];
  if (!value) throw new CoreError('InvalidFinality', `PaymentCompleted is missing ${name}`);
  return value;
}

function decimalValue(values: Record<string, string>, name: string) {
  const value = requiredValue(values, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidFinality', `PaymentCompleted ${name} is invalid`);
  return value;
}

function safeInteger(values: Record<string, string>, name: string) {
  const value = Number(requiredValue(values, name));
  if (!Number.isSafeInteger(value) || value < 0) throw new CoreError('InvalidFinality', `PaymentCompleted ${name} is invalid`);
  return value;
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

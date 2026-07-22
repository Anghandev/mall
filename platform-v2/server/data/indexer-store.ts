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
    const ordered = [...events].sort((left, right) => left.logIndex - right.logIndex);
    for (const event of ordered) {
      if (event.contract !== 'PaymentRouterV2' || event.eventName !== 'PaymentCompleted') continue;
      const confirmations = canonicalHead - block.number + 1;
      const confirmationBlock = confirmations >= 15
        ? segment.find((item) => item.block.number === block.number + 14)?.block
        : undefined;
      await recordPaymentProjection(executor, {
        event: canonicalPaymentEvent(block, event, confirmations, confirmationBlock?.timestamp),
      });
    }
    for (const event of ordered) {
      if (event.contract !== 'PaymentRouterV2' || event.eventName !== 'SeckillRelayExtended') continue;
      await recordSeckillRelayProjection(executor, block, event);
    }
  }
}

export async function recordSeckillRelayProjection(
  executor: SqlExecutor,
  block: IndexedChainBlock['block'],
  event: IndexedChainBlock['events'][number],
) {
  if (event.contract !== 'PaymentRouterV2' || event.eventName !== 'SeckillRelayExtended') {
    throw new CoreError('InvalidFinality', 'Expected a PaymentRouter SeckillRelayExtended event', 409);
  }
  const sessionId = relayValue(event.values, 'sessionId').toLowerCase();
  const orderId = relayValue(event.values, 'orderId').toLowerCase();
  if (sessionId !== event.resourceId.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Seckill relay resource does not match its session', 409);
  }
  const emittedDeadline = safeRelayInteger(event.values, 'relayDeadline');
  const relayEventKey = paymentEventKey(event.transactionHash, event.logIndex, event.blockHash);
  const existing = await executor.query<{
    session_id: string;
    order_id: string;
    transaction_hash: string;
    block_hash: string;
    log_index: string | number;
    relay_deadline: Date;
    canonical: boolean;
  }>('SELECT * FROM core.seckill_relay_events WHERE relay_event_key = $1', [relayEventKey]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      row.session_id.toLowerCase() !== sessionId
      || row.order_id.toLowerCase() !== orderId
      || row.transaction_hash.toLowerCase() !== event.transactionHash.toLowerCase()
      || row.block_hash.toLowerCase() !== event.blockHash.toLowerCase()
      || Number(row.log_index) !== event.logIndex
      || Math.floor(row.relay_deadline.getTime() / 1000) !== emittedDeadline
      || !row.canonical
    ) throw new CoreError('IdempotencyConflict', 'Seckill relay event identity changed', 409);
    return { status: 'IDEMPOTENT' as const, sessionId, orderId, relayDeadline: row.relay_deadline };
  }
  const context = await executor.query<{
    payment_event_key: string;
    buyer_wallet: string;
    session_id: string;
    starts_at: Date;
    relay_deadline: Date;
    main_deadline: Date;
    phase: string;
    relay_increment: string | number;
    relay_cap: string | number;
  }>(
    `SELECT payment.event_key AS payment_event_key, orders.buyer_wallet,
       session.session_id, session.starts_at, session.relay_deadline, session.main_deadline,
       session.phase,
       policy.payload ->> 'relayIncrement' AS relay_increment,
       policy.payload ->> 'relayCap' AS relay_cap
     FROM core.payment_events payment
     JOIN core.orders orders ON orders.order_id = payment.order_id
     JOIN core.seckill_sessions session
       ON session.session_id = orders.seckill_snapshot ->> 'sessionId'
     JOIN core.policy_snapshots policy
       ON policy.policy_version = session.policy_version
     WHERE payment.order_id = $1 AND payment.transaction_hash = $2
       AND payment.block_hash = $3 AND payment.canonical
       AND payment.classification = 'SECKILL' AND payment.log_index < $4
     FOR UPDATE OF session`,
    [orderId, event.transactionHash.toLowerCase(), event.blockHash.toLowerCase(), event.logIndex],
  );
  const row = context.rows[0];
  if (
    !row
    || row.session_id.toLowerCase() !== sessionId
    || !['PREHEAT', 'LIVE', 'FORCE_CLOSED'].includes(row.phase)
  ) {
    throw new CoreError('InvalidFinality', 'Seckill relay event has no matching live payment session', 409);
  }
  const startsAt = Math.floor(row.starts_at.getTime() / 1000);
  const previousDeadline = Math.floor(row.relay_deadline.getTime() / 1000);
  const mainDeadline = Math.floor(row.main_deadline.getTime() / 1000);
  const relayIncrement = Number(row.relay_increment);
  const relayCap = Number(row.relay_cap);
  if (
    block.hash.toLowerCase() !== event.blockHash.toLowerCase()
    || block.number !== event.blockNumber
    || block.timestamp < startsAt
    || block.timestamp >= previousDeadline
    || block.timestamp >= mainDeadline
    || !Number.isSafeInteger(relayIncrement) || relayIncrement <= 0
    || !Number.isSafeInteger(relayCap) || relayCap <= 0
  ) throw new CoreError('InvalidFinality', 'Seckill relay event violates its snapshotted timer state', 409);
  const remaining = previousDeadline - block.timestamp;
  const expectedDeadline = Math.min(
    mainDeadline,
    block.timestamp + Math.min(remaining + relayIncrement, relayCap),
  );
  if (emittedDeadline !== expectedDeadline || emittedDeadline < previousDeadline) {
    throw new CoreError('InvalidFinality', 'Seckill relay deadline does not match the Router event', 409);
  }
  const projectedDeadline = new Date(emittedDeadline * 1000);
  await executor.query(
    `INSERT INTO core.seckill_relay_events (
       relay_event_key, payment_event_key, session_id, order_id, buyer_wallet,
       transaction_hash, log_index, block_number, block_hash,
       previous_relay_deadline, relay_deadline
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      relayEventKey,
      row.payment_event_key,
      sessionId,
      orderId,
      row.buyer_wallet,
      event.transactionHash.toLowerCase(),
      event.logIndex,
      event.blockNumber,
      event.blockHash.toLowerCase(),
      row.relay_deadline,
      projectedDeadline,
    ],
  );
  await executor.query(
    `UPDATE core.seckill_sessions
     SET relay_deadline = $2, last_buyer_wallet = $3, updated_at = clock_timestamp()
     WHERE session_id = $1`,
    [sessionId, projectedDeadline, row.buyer_wallet],
  );
  return { status: 'RECORDED' as const, sessionId, orderId, relayDeadline: projectedDeadline };
}

export function canonicalPaymentEvent(
  block: Pick<IndexedChainBlock['block'], 'number' | 'hash' | 'timestamp'>,
  event: IndexedChainBlock['events'][number],
  confirmations: number,
  confirmationTimestamp?: number,
): CanonicalPaymentEvent {
  const classification = paymentClassification(event.values.classification);
  if (confirmations >= 15 && confirmationTimestamp === undefined) {
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
    ...(confirmationTimestamp !== undefined ? { finalizedAt: new Date(confirmationTimestamp * 1000) } : {}),
    contractAddress: event.contractAddress,
    eventHash: event.eventHash,
    snapshotHash: requiredValue(event.values, 'snapshotHash'),
    classification,
    buyer: requiredValue(event.values, 'buyer'),
    merchant: requiredValue(event.values, 'merchant'),
    policyVersion: safeInteger(event.values, 'policyVersion'),
    listPriceUsdt: decimalValue(event.values, 'listPriceUsdt'),
    productUsdtPaid: decimalValue(event.values, 'productUsdtPaid'),
    platformServiceFeeUsdt: decimalValue(event.values, 'platformServiceFeeUsdt'),
    custodyProductUsdt: decimalValue(event.values, 'custodyProductUsdt'),
    freightUsdt: decimalValue(event.values, 'freightUsdt'),
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

function relayValue(values: Record<string, string>, name: string) {
  const value = values[name];
  if (!value) throw new CoreError('InvalidFinality', `SeckillRelayExtended is missing ${name}`, 409);
  return value;
}

function safeRelayInteger(values: Record<string, string>, name: string) {
  const value = Number(relayValue(values, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CoreError('InvalidFinality', `SeckillRelayExtended ${name} is invalid`, 409);
  }
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
  await executor.query(
    `INSERT INTO core.chain_blocks (
       block_hash, block_number, parent_hash, block_timestamp, canonical
     )
     SELECT block_hash, block_number, parent_hash, block_timestamp, true
     FROM unnest($1::text[], $2::bigint[], $3::text[], $4::bigint[])
       AS input(block_hash, block_number, parent_hash, block_timestamp)
     ON CONFLICT (block_hash) DO UPDATE SET
       canonical = true,
       replaced_at = NULL`,
    [
      segment.map(({ block }) => block.hash),
      segment.map(({ block }) => block.number),
      segment.map(({ block }) => block.parentHash),
      segment.map(({ block }) => block.timestamp),
    ],
  );
  for (const { block, events } of segment) {
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

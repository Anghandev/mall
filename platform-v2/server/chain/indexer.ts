import type { DecodedDomainEvent, IndexedLog } from './abi-decoder.ts';
import { AbiEventDecoder } from './abi-decoder.ts';
import { CoreError } from '../api/errors.ts';

export interface ChainBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface CanonicalCheckpoint {
  blockNumber: number;
  blockHash: string;
}

export interface IndexedChainBlock {
  block: ChainBlock;
  events: DecodedDomainEvent[];
}

export interface IndexerStore {
  checkpoint(): Promise<CanonicalCheckpoint | undefined>;
  canonicalAt(blockNumber: number): Promise<CanonicalCheckpoint | undefined>;
  appendCanonical(expectedHead: CanonicalCheckpoint | undefined, segment: IndexedChainBlock[]): Promise<void>;
  replaceCanonical(
    expectedHead: CanonicalCheckpoint,
    commonAncestor: CanonicalCheckpoint,
    segment: IndexedChainBlock[],
  ): Promise<void>;
  markReorg(fromBlock: number, expectedParentHash: string, observedParentHash: string): Promise<void>;
}

export interface ChainSegmentBlock {
  block: ChainBlock;
  logs: IndexedLog[];
}

export class ChainIndexer {
  readonly #decoder: AbiEventDecoder;
  readonly #store: IndexerStore;

  constructor(decoder: AbiEventDecoder, store: IndexerStore) {
    this.#decoder = decoder;
    this.#store = store;
  }

  async ingest(block: ChainBlock, logs: IndexedLog[]) {
    return this.ingestSegment([{ block, logs }]);
  }

  async ingestSegment(input: ChainSegmentBlock[]) {
    if (input.length === 0) throw new CoreError('InvalidFinality', 'Indexer segment is empty');
    validateSegment(input);
    const checkpoint = await this.#store.checkpoint();
    const first = input[0]!.block;
    const existing = await this.#store.canonicalAt(first.number);
    if (existing?.blockHash.toLowerCase() === first.hash.toLowerCase()) {
      if (input.length === 1) return { status: 'IDEMPOTENT' as const, events: 0 };
      throw new CoreError('InvalidFinality', 'Indexer segment overlaps canonical history');
    }
    const segment = input.map(({ block, logs }) => ({ block, events: this.#decode(block, logs) }));

    if (existing) {
      if (!checkpoint || first.number === 0) {
        await this.#store.markReorg(first.number, existing.blockHash, first.hash);
        throw new CoreError('ReorgPending', 'Replacement segment has no provable common ancestor', 409);
      }
      const commonAncestor = await this.#store.canonicalAt(first.number - 1);
      if (!commonAncestor || commonAncestor.blockHash.toLowerCase() !== first.parentHash.toLowerCase()) {
        await this.#store.markReorg(
          first.number - 1,
          commonAncestor?.blockHash ?? existing.blockHash,
          first.parentHash,
        );
        throw new CoreError('ReorgPending', 'Replacement segment does not identify the common ancestor', 409);
      }
      await this.#store.replaceCanonical(checkpoint, commonAncestor, segment);
      return { status: 'REORG_COMMITTED' as const, events: segment.reduce((count, item) => count + item.events.length, 0) };
    }

    if (checkpoint && first.number !== checkpoint.blockNumber + 1) {
      throw new CoreError('FinalityPending', 'Indexer block gap detected', 409, {
        expected: checkpoint.blockNumber + 1,
        observed: first.number,
      });
    }
    if (checkpoint && first.parentHash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
      await this.#store.markReorg(first.number - 1, checkpoint.blockHash, first.parentHash);
      throw new CoreError('ReorgPending', 'Block parent no longer matches the canonical checkpoint', 409);
    }
    await this.#store.appendCanonical(checkpoint, segment);
    return { status: 'COMMITTED' as const, events: segment.reduce((count, item) => count + item.events.length, 0) };
  }

  #decode(block: ChainBlock, logs: IndexedLog[]) {
    return logs
      .filter((log) => log.blockNumber === block.number && log.blockHash.toLowerCase() === block.hash.toLowerCase())
      .map((log) => this.#decoder.decode(log))
      .filter((event): event is DecodedDomainEvent => Boolean(event));
  }
}

function validateSegment(segment: ChainSegmentBlock[]) {
  for (let index = 0; index < segment.length; index += 1) {
    const block = segment[index]!.block;
    validateBlock(block);
    const previous = segment[index - 1]?.block;
    if (previous && (block.number !== previous.number + 1 || block.parentHash.toLowerCase() !== previous.hash.toLowerCase())) {
      throw new CoreError('InvalidFinality', 'Indexer segment is not a continuous canonical chain');
    }
  }
}

function validateBlock(block: ChainBlock) {
  if (
    !Number.isSafeInteger(block.number) ||
    block.number < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.parentHash) ||
    !Number.isSafeInteger(block.timestamp) ||
    block.timestamp <= 0
  ) {
    throw new CoreError('InvalidFinality', 'Invalid block envelope');
  }
}

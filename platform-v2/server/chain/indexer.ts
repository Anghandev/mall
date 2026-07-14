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

export interface IndexerStore {
  checkpoint(): Promise<CanonicalCheckpoint | undefined>;
  commit(block: ChainBlock, events: DecodedDomainEvent[]): Promise<void>;
  markReorg(fromBlock: number, expectedParentHash: string, observedParentHash: string): Promise<void>;
}

export class ChainIndexer {
  readonly #decoder: AbiEventDecoder;
  readonly #store: IndexerStore;

  constructor(decoder: AbiEventDecoder, store: IndexerStore) {
    this.#decoder = decoder;
    this.#store = store;
  }

  async ingest(block: ChainBlock, logs: IndexedLog[]) {
    validateBlock(block);
    const checkpoint = await this.#store.checkpoint();
    if (checkpoint && block.number <= checkpoint.blockNumber) {
      if (block.number === checkpoint.blockNumber && block.hash.toLowerCase() === checkpoint.blockHash.toLowerCase()) {
        return { status: 'IDEMPOTENT' as const, events: 0 };
      }
      await this.#store.markReorg(block.number, checkpoint.blockHash, block.hash);
      throw new CoreError('ReorgPending', 'Observed block conflicts with indexed canonical history', 409);
    }
    if (checkpoint && block.number !== checkpoint.blockNumber + 1) {
      throw new CoreError('FinalityPending', 'Indexer block gap detected', 409, {
        expected: checkpoint.blockNumber + 1,
        observed: block.number,
      });
    }
    if (checkpoint && block.parentHash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) {
      await this.#store.markReorg(block.number - 1, checkpoint.blockHash, block.parentHash);
      throw new CoreError('ReorgPending', 'Block parent no longer matches the canonical checkpoint', 409);
    }
    const events = logs
      .filter((log) => log.blockNumber === block.number && log.blockHash.toLowerCase() === block.hash.toLowerCase())
      .map((log) => this.#decoder.decode(log))
      .filter((event): event is DecodedDomainEvent => Boolean(event));
    await this.#store.commit(block, events);
    return { status: 'COMMITTED' as const, events: events.length };
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

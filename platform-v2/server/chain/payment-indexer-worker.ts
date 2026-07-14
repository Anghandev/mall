import { JsonRpcProvider } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { IndexedLog } from './abi-decoder.ts';
import {
  ChainIndexer,
  type ChainBlock,
  type ChainSegmentBlock,
  type IndexerStore,
} from './indexer.ts';

export interface PaymentChainSource {
  head(): Promise<number>;
  block(blockNumber: number): Promise<ChainBlock>;
  logs(fromBlock: number, toBlock: number): Promise<IndexedLog[]>;
}

export interface PaymentIndexerStatus {
  healthy: boolean;
  caughtUp: boolean;
  checkedAt?: string;
  lastIndexedBlock?: number;
  observedHead?: number;
  errorCode?: string;
}

export class ResilientBscPaymentChainSource implements PaymentChainSource {
  readonly #providers: JsonRpcProvider[];
  readonly #routerAddress: string;

  constructor(input: { primaryRpcUrl?: string; fallbackRpcUrl?: string; routerAddress?: string }) {
    if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Primary and fallback BSC RPC are required', 503);
    }
    if (!input.routerAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.routerAddress)) {
      throw new CoreError('ExternalBlocked', 'PaymentRouter deployment address is unavailable', 503);
    }
    this.#routerAddress = input.routerAddress.toLowerCase();
    this.#providers = [input.primaryRpcUrl, input.fallbackRpcUrl]
      .map((url) => new JsonRpcProvider(url, 56, { staticNetwork: true }));
  }

  head() {
    return this.#withProvider((provider) => provider.getBlockNumber());
  }

  block(blockNumber: number) {
    assertBlockNumber(blockNumber);
    return this.#withProvider(async (provider) => {
      const value = await provider.getBlock(blockNumber);
      if (!value || !value.hash) throw new CoreError('FinalityPending', 'BSC block is unavailable', 409);
      return {
        number: value.number,
        hash: value.hash,
        parentHash: value.parentHash,
        timestamp: value.timestamp,
      };
    });
  }

  logs(fromBlock: number, toBlock: number) {
    assertBlockNumber(fromBlock);
    assertBlockNumber(toBlock);
    if (toBlock < fromBlock) throw new CoreError('InvalidFinality', 'Invalid payment log range');
    return this.#withProvider(async (provider) => {
      const values = await provider.getLogs({ address: this.#routerAddress, fromBlock, toBlock });
      return values.map((value) => ({
        address: value.address.toLowerCase(),
        topics: [...value.topics],
        data: value.data,
        transactionHash: value.transactionHash,
        blockHash: value.blockHash,
        blockNumber: value.blockNumber,
        logIndex: value.index,
      }));
    });
  }

  async #withProvider<Result>(operation: (provider: JsonRpcProvider) => Promise<Result>) {
    let lastError: unknown;
    for (const provider of this.#providers) {
      try {
        if ((await provider.getNetwork()).chainId !== 56n) {
          throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
        }
        return await operation(provider);
      } catch (error) {
        lastError = error;
      }
    }
    throw new CoreError('ExternalBlocked', 'Both BSC RPC providers failed', 503, {
      reason: lastError instanceof Error ? lastError.name : 'UnknownRpcFailure',
    });
  }
}

export class PollingPaymentIndexer {
  readonly #source: PaymentChainSource;
  readonly #indexer: ChainIndexer;
  readonly #store: IndexerStore;
  readonly #deploymentBlock: number;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #onStatus: ((status: Readonly<PaymentIndexerStatus>) => void) | undefined;
  #status: PaymentIndexerStatus = { healthy: false, caughtUp: false };
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(input: {
    source: PaymentChainSource;
    indexer: ChainIndexer;
    store: IndexerStore;
    deploymentBlock: number;
    batchSize?: number;
    pollIntervalMs?: number;
    onStatus?: (status: Readonly<PaymentIndexerStatus>) => void;
  }) {
    assertBlockNumber(input.deploymentBlock);
    const batchSize = input.batchSize ?? 64;
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1_000) {
      throw new CoreError('InvalidRequest', 'Indexer batch size is invalid');
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new CoreError('InvalidRequest', 'Indexer poll interval is invalid');
    }
    this.#source = input.source;
    this.#indexer = input.indexer;
    this.#store = input.store;
    this.#deploymentBlock = input.deploymentBlock;
    this.#batchSize = batchSize;
    this.#pollIntervalMs = pollIntervalMs;
    this.#onStatus = input.onStatus;
  }

  status() {
    return Object.freeze({ ...this.#status });
  }

  start() {
    if (this.#running) return;
    this.#controller = new AbortController();
    this.#running = this.#run(this.#controller.signal);
  }

  async stop() {
    this.#controller?.abort();
    await this.#running;
    this.#controller = undefined;
    this.#running = undefined;
  }

  async pollOnce() {
    const observedHead = await this.#source.head();
    assertBlockNumber(observedHead);
    const floor = Math.max(0, this.#deploymentBlock - 1);
    const checkpoint = await this.#store.checkpoint();
    if (checkpoint && checkpoint.blockNumber < floor) {
      throw new CoreError('ArtifactVersionMismatch', 'Indexer checkpoint predates the Router deployment baseline', 409);
    }
    if (checkpoint && observedHead < checkpoint.blockNumber) {
      throw new CoreError('FinalityPending', 'RPC head is behind the persisted Indexer checkpoint', 409, {
        checkpoint: checkpoint.blockNumber,
        observedHead,
      });
    }

    let fromBlock = floor;
    if (checkpoint) {
      const observedCheckpoint = checkpoint.blockNumber <= observedHead
        ? await this.#source.block(checkpoint.blockNumber)
        : undefined;
      if (observedCheckpoint?.hash.toLowerCase() === checkpoint.blockHash.toLowerCase()) {
        fromBlock = checkpoint.blockNumber + 1;
      } else {
        const commonAncestor = await this.#findCommonAncestor(Math.min(checkpoint.blockNumber, observedHead), floor);
        fromBlock = commonAncestor + 1;
      }
    }

    if (fromBlock > observedHead) {
      this.#publish({
        healthy: true,
        caughtUp: true,
        checkedAt: new Date().toISOString(),
        ...(checkpoint ? { lastIndexedBlock: checkpoint.blockNumber } : {}),
        observedHead,
      });
      return { progressed: false, caughtUp: true, observedHead } as const;
    }

    const toBlock = Math.min(observedHead, fromBlock + this.#batchSize - 1);
    const segment = await this.#segment(fromBlock, toBlock);
    await this.#indexer.ingestSegment(segment);
    const caughtUp = toBlock >= observedHead;
    this.#publish({
      healthy: true,
      caughtUp,
      checkedAt: new Date().toISOString(),
      lastIndexedBlock: toBlock,
      observedHead,
    });
    return { progressed: true, caughtUp, observedHead, lastIndexedBlock: toBlock } as const;
  }

  async #findCommonAncestor(start: number, floor: number) {
    for (let blockNumber = start; blockNumber >= floor; blockNumber -= 1) {
      const [persisted, observed] = await Promise.all([
        this.#store.canonicalAt(blockNumber),
        this.#source.block(blockNumber),
      ]);
      if (persisted?.blockHash.toLowerCase() === observed.hash.toLowerCase()) return blockNumber;
    }
    throw new CoreError('ReorgPending', 'Reorg exceeds the persisted Router deployment baseline', 409);
  }

  async #segment(fromBlock: number, toBlock: number): Promise<ChainSegmentBlock[]> {
    const blocks: ChainBlock[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      blocks.push(await this.#source.block(blockNumber));
    }
    const logStart = Math.max(fromBlock, this.#deploymentBlock);
    const logs = logStart <= toBlock ? await this.#source.logs(logStart, toBlock) : [];
    const blockHashes = new Map(blocks.map((block) => [block.number, block.hash.toLowerCase()]));
    const byBlock = new Map<number, IndexedLog[]>();
    for (const log of logs) {
      if (blockHashes.get(log.blockNumber) !== log.blockHash.toLowerCase()) {
        throw new CoreError('ReorgPending', 'Payment log does not belong to the fetched canonical block batch', 409, {
          blockNumber: log.blockNumber,
        });
      }
      const values = byBlock.get(log.blockNumber) ?? [];
      values.push(log);
      byBlock.set(log.blockNumber, values);
    }
    return blocks.map((block) => ({ block, logs: byBlock.get(block.number) ?? [] }));
  }

  async #run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const result = await this.pollOnce();
        if (result.progressed && !result.caughtUp) continue;
      } catch (error) {
        this.#publish({
          healthy: false,
          caughtUp: false,
          checkedAt: new Date().toISOString(),
          errorCode: error instanceof CoreError ? error.code : 'UnexpectedIndexerFailure',
        });
      }
      await abortableDelay(this.#pollIntervalMs, signal);
    }
  }

  #publish(status: PaymentIndexerStatus) {
    this.#status = status;
    this.#onStatus?.(Object.freeze({ ...status }));
  }
}

function assertBlockNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new CoreError('InvalidFinality', 'Invalid BSC block number');
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

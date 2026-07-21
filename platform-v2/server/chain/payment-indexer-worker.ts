import { JsonRpcProvider } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { IndexedLog } from './abi-decoder.ts';
import {
  ChainIndexer,
  type ChainBlock,
  type ChainSegmentBlock,
  type IndexerStore,
} from './indexer.ts';
import { readAddressLogs } from './rpc-logs.ts';

const DEFAULT_RPC_STABLE_BLOCK_LAG = 5;
const DEFAULT_INDEXER_BATCH_SIZE = 128;
const DEFAULT_INDEXER_BLOCK_FETCH_CONCURRENCY = 16;
const RPC_PROVIDER_RETRY_ATTEMPTS = 3;
const RPC_PROVIDER_RETRY_DELAY_MS = 250;
const DEFAULT_INDEXER_CAUGHT_UP_TOLERANCE_BLOCKS = 64;
const DEFAULT_INDEXER_TRANSIENT_FAILURE_GRACE_MS = 45_000;

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
  readonly #stableBlockLag: number;
  #lastObservedHead = 0;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    routerAddress?: string;
    providers?: readonly JsonRpcProvider[];
    stableBlockLag?: number;
  }) {
    if (input.providers) {
      if (input.providers.length !== 2) {
        throw new CoreError('ExternalBlocked', 'Payment Indexer requires two independent BSC RPC endpoints', 503);
      }
      this.#providers = [...input.providers];
    } else if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Primary and fallback BSC RPC are required', 503);
    } else {
      const urls = [paymentRpcUrl(input.primaryRpcUrl), paymentRpcUrl(input.fallbackRpcUrl)];
      if (urls[0] === urls[1]) {
        throw new CoreError('ExternalBlocked', 'Payment Indexer requires distinct BSC RPC endpoints', 503);
      }
      this.#providers = urls.map((url) => new JsonRpcProvider(url, 56, { staticNetwork: true }));
    }
    if (!input.routerAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.routerAddress)) {
      throw new CoreError('ExternalBlocked', 'PaymentRouter deployment address is unavailable', 503);
    }
    const stableBlockLag = input.stableBlockLag ?? DEFAULT_RPC_STABLE_BLOCK_LAG;
    if (!Number.isSafeInteger(stableBlockLag) || stableBlockLag < 0 || stableBlockLag > 32) {
      throw new CoreError('InvalidRequest', 'Payment Indexer stable block lag is invalid');
    }
    this.#routerAddress = input.routerAddress.toLowerCase();
    this.#stableBlockLag = stableBlockLag;
  }

  async head() {
    const heads = await this.#readAvailableProviders((provider) => this.#withBscProvider(
      provider,
      () => provider.getBlockNumber(),
    ));
    const stableHead = Math.max(0, Math.min(...heads) - this.#stableBlockLag);
    const observedHead = Math.max(this.#lastObservedHead, stableHead);
    assertBlockNumber(observedHead);
    this.#lastObservedHead = observedHead;
    return observedHead;
  }

  async block(blockNumber: number) {
    assertBlockNumber(blockNumber);
    const blocks = await this.#readAvailableProviders((provider) => this.#withBscProvider(provider, async () => {
      const value = await provider.getBlock(blockNumber);
      if (!value || !value.hash) throw new CoreError('ExternalBlocked', 'BSC block is unavailable from one RPC endpoint', 503);
      return normalizeBlock({
        number: value.number,
        hash: value.hash,
        parentHash: value.parentHash,
        timestamp: value.timestamp,
      });
    }));
    if (blocks.length > 1) assertSameRpcEvidence(blocks[0], blocks[1], 'BSC RPC sources disagree on payment block evidence');
    return blocks[0]!;
  }

  async logs(fromBlock: number, toBlock: number) {
    assertBlockNumber(fromBlock);
    assertBlockNumber(toBlock);
    if (toBlock < fromBlock) throw new CoreError('InvalidFinality', 'Invalid payment log range');
    const observations = await this.#readAvailableProviders((provider) => this.#withBscProvider(provider, async () => {
      const values = await readAddressLogs(provider, {
        addresses: this.#routerAddress,
        fromBlock,
        toBlock,
      });
      return normalizeLogs(values.map((value) => ({
        address: value.address,
        topics: [...value.topics],
        data: value.data,
        transactionHash: value.transactionHash,
        blockHash: value.blockHash,
        blockNumber: value.blockNumber,
        logIndex: value.logIndex,
      })));
    }));
    if (observations.length > 1) assertSameRpcEvidence(observations[0], observations[1], 'BSC RPC sources disagree on payment Router logs');
    return observations[0]!;
  }

  async #readAvailableProviders<Result>(operation: (provider: JsonRpcProvider) => Promise<Result>) {
    const results = await Promise.allSettled(this.#providers.map(operation));
    const values = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (values.length > 0) return values;
    const error = results.find((result) => result.status === 'rejected')?.reason;
    if (error instanceof CoreError) throw error;
    throw new CoreError('ExternalBlocked', 'BSC RPC provider failed', 503, {
      reason: error instanceof Error ? error.name : 'UnknownRpcFailure',
    });
  }

  async #withBscProvider<Result>(provider: JsonRpcProvider, operation: () => Promise<Result>) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RPC_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
      try {
        if ((await provider.getNetwork()).chainId !== 56n) {
          throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
        }
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < RPC_PROVIDER_RETRY_ATTEMPTS) await fixedDelay(RPC_PROVIDER_RETRY_DELAY_MS * attempt);
      }
    }
    if (lastError instanceof CoreError) throw lastError;
    throw new CoreError('ExternalBlocked', 'BSC RPC provider failed', 503, {
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
  readonly #caughtUpToleranceBlocks: number;
  readonly #transientFailureGraceMs: number;
  readonly #onStatus: ((status: Readonly<PaymentIndexerStatus>) => void) | undefined;
  #status: PaymentIndexerStatus = { healthy: false, caughtUp: false };
  #lastHealthyAtMs = 0;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(input: {
    source: PaymentChainSource;
    indexer: ChainIndexer;
    store: IndexerStore;
    deploymentBlock: number;
    batchSize?: number;
    pollIntervalMs?: number;
    caughtUpToleranceBlocks?: number;
    transientFailureGraceMs?: number;
    onStatus?: (status: Readonly<PaymentIndexerStatus>) => void;
  }) {
    assertBlockNumber(input.deploymentBlock);
    const batchSize = input.batchSize ?? DEFAULT_INDEXER_BATCH_SIZE;
    const pollIntervalMs = input.pollIntervalMs ?? 3_000;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1_000) {
      throw new CoreError('InvalidRequest', 'Indexer batch size is invalid');
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new CoreError('InvalidRequest', 'Indexer poll interval is invalid');
    }
    const caughtUpToleranceBlocks = input.caughtUpToleranceBlocks ?? DEFAULT_INDEXER_CAUGHT_UP_TOLERANCE_BLOCKS;
    if (!Number.isSafeInteger(caughtUpToleranceBlocks) || caughtUpToleranceBlocks < 0 || caughtUpToleranceBlocks > 128) {
      throw new CoreError('InvalidRequest', 'Indexer caught-up tolerance is invalid');
    }
    const transientFailureGraceMs = input.transientFailureGraceMs ?? DEFAULT_INDEXER_TRANSIENT_FAILURE_GRACE_MS;
    if (!Number.isSafeInteger(transientFailureGraceMs) || transientFailureGraceMs < 0 || transientFailureGraceMs > 300_000) {
      throw new CoreError('InvalidRequest', 'Indexer transient failure grace is invalid');
    }
    this.#source = input.source;
    this.#indexer = input.indexer;
    this.#store = input.store;
    this.#deploymentBlock = input.deploymentBlock;
    this.#batchSize = batchSize;
    this.#pollIntervalMs = pollIntervalMs;
    this.#caughtUpToleranceBlocks = caughtUpToleranceBlocks;
    this.#transientFailureGraceMs = transientFailureGraceMs;
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
    const caughtUp = observedHead - toBlock <= this.#caughtUpToleranceBlocks;
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
    const blockNumbers = Array.from(
      { length: toBlock - fromBlock + 1 },
      (_, index) => fromBlock + index,
    );
    const blocks = await mapWithConcurrency(
      blockNumbers,
      DEFAULT_INDEXER_BLOCK_FETCH_CONCURRENCY,
      (blockNumber) => this.#source.block(blockNumber),
    );
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
        console.warn('Payment indexer poll failed', {
          code: error instanceof CoreError ? error.code : 'UnexpectedIndexerFailure',
          message: error instanceof Error ? error.message : 'Unexpected payment indexer failure',
        });
        if (!this.#hasRecentHealthyStatus()) {
          this.#publish({
            healthy: false,
            caughtUp: false,
            checkedAt: new Date().toISOString(),
            errorCode: error instanceof CoreError ? error.code : 'UnexpectedIndexerFailure',
          });
        }
      }
      await abortableDelay(this.#pollIntervalMs, signal);
    }
  }

  #publish(status: PaymentIndexerStatus) {
    if (status.healthy) this.#lastHealthyAtMs = Date.now();
    this.#status = status;
    this.#onStatus?.(Object.freeze({ ...status }));
  }

  #hasRecentHealthyStatus() {
    return this.#status.healthy === true
      && this.#lastHealthyAtMs > 0
      && Date.now() - this.#lastHealthyAtMs <= this.#transientFailureGraceMs;
  }
}

function assertBlockNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new CoreError('InvalidFinality', 'Invalid BSC block number');
}

function paymentRpcUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreError('ExternalBlocked', 'Payment Indexer RPC endpoint is invalid', 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('ExternalBlocked', 'Payment Indexer RPC endpoints require HTTPS without embedded credentials', 503);
  }
  return url.href;
}

function normalizeBlock(block: ChainBlock): ChainBlock {
  return {
    number: block.number,
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    timestamp: block.timestamp,
  };
}

function normalizeLogs(logs: readonly IndexedLog[]) {
  return logs.map((log) => ({
    address: log.address.toLowerCase(),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    blockHash: log.blockHash.toLowerCase(),
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  })).sort((left, right) =>
    left.blockNumber - right.blockNumber
    || left.logIndex - right.logIndex
    || left.transactionHash.localeCompare(right.transactionHash));
}

function assertSameRpcEvidence(left: unknown, right: unknown, message: string) {
  if (stableRpcValue(left) !== stableRpcValue(right)) {
    throw new CoreError('InvalidFinality', message, 409);
  }
}

function stableRpcValue(value: unknown) {
  return JSON.stringify(value);
}

function fixedDelay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
) {
  const output: Output[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    output.push(...await Promise.all(values.slice(index, index + concurrency).map(mapper)));
  }
  return output;
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

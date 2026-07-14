import { getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type {
  GuaranteeDepositChainObservation,
  GuaranteeDepositFinalityItem,
  GuaranteeDepositReorgObservation,
  GuaranteeDepositService,
} from '../data/guarantee-deposit-service.ts';

const TRANSFER_EVENT_SIGNATURE_HASH = id('Transfer(address,address,uint256)').toLowerCase();

interface RpcReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  status: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    logIndex: string;
    transactionHash: string;
    blockHash: string;
    blockNumber: string;
    removed?: boolean;
  }>;
}

interface RpcBlock {
  number: string;
  hash: string;
}

export type GuaranteeDepositSourceObservation =
  | { state: 'PENDING' }
  | GuaranteeDepositChainObservation
  | GuaranteeDepositReorgObservation;

export interface GuaranteeDepositChainSource {
  observe(item: GuaranteeDepositFinalityItem): Promise<GuaranteeDepositSourceObservation>;
}

export class ResilientBscGuaranteeDepositSource implements GuaranteeDepositChainSource {
  readonly #clients: readonly JsonRpcClient[];
  readonly #clock: () => Date;

  constructor(input: {
    primaryRpcUrl: string;
    fallbackRpcUrl: string;
    fetchImpl?: typeof fetch;
    clock?: () => Date;
  }) {
    const primary = rpcUrl(input.primaryRpcUrl, 'primary');
    const fallback = rpcUrl(input.fallbackRpcUrl, 'fallback');
    if (primary === fallback) throw new CoreError('ExternalBlocked', 'Guarantee finality RPC endpoints must be independent', 503);
    const fetchImpl = input.fetchImpl ?? fetch;
    this.#clients = [new JsonRpcClient(primary, fetchImpl), new JsonRpcClient(fallback, fetchImpl)];
    this.#clock = input.clock ?? (() => new Date());
  }

  async observe(item: GuaranteeDepositFinalityItem): Promise<GuaranteeDepositSourceObservation> {
    validateItem(item);
    const chainIds = await Promise.all(this.#clients.map((client) => client.request('eth_chainId', [])));
    if (chainIds.some((value) => parseHexNumber(value, 'chain id') !== 56)) {
      throw new CoreError('ExternalBlocked', 'Guarantee finality RPC is not BSC chain 56', 503);
    }
    const receipts = await Promise.all(this.#clients.map((client) => client.request('eth_getTransactionReceipt', [item.transactionHash])));
    if ((receipts[0] === null) !== (receipts[1] === null)) {
      throw new CoreError('InvalidFinality', 'Guarantee receipt providers disagree', 409);
    }
    if (receipts[0] === null && receipts[1] === null) {
      if (item.observedBlockNumber === undefined || !item.observedBlockHash || item.observedLogIndex === undefined) {
        return { state: 'PENDING' };
      }
      return this.#missingReceiptReorg(item);
    }
    const receipt = normalizeReceipt(receipts[0], item.transactionHash);
    const fallbackReceipt = normalizeReceipt(receipts[1], item.transactionHash);
    if (canonicalJson(receipt) !== canonicalJson(fallbackReceipt)) {
      throw new CoreError('InvalidFinality', 'Guarantee receipt providers returned different transactions', 409);
    }
    if (receipt.status !== '0x1') throw new CoreError('InvalidFinality', 'Guarantee transaction did not succeed', 409);
    const [blocks, heads] = await Promise.all([
      Promise.all(this.#clients.map((client) => client.request('eth_getBlockByNumber', [receipt.blockNumber, false]))),
      Promise.all(this.#clients.map((client) => client.request('eth_blockNumber', []))),
    ]);
    const primaryBlock = normalizeBlock(blocks[0], 'receipt block');
    const fallbackBlock = normalizeBlock(blocks[1], 'receipt block');
    if (
      primaryBlock.hash !== fallbackBlock.hash
      || primaryBlock.number !== fallbackBlock.number
      || primaryBlock.hash !== receipt.blockHash
      || primaryBlock.number !== receipt.blockNumber
    ) throw new CoreError('InvalidFinality', 'Guarantee receipt block is not canonical on both providers', 409);
    const blockNumber = parseHexNumber(receipt.blockNumber, 'receipt block number');
    const confirmations = Math.min(...heads.map((head) => {
      const height = parseHexNumber(head, 'BSC head');
      if (height < blockNumber) throw new CoreError('InvalidFinality', 'Guarantee provider head precedes the receipt block', 409);
      return height - blockNumber + 1;
    }));
    const transfer = matchingTransfer(receipt, item);
    const observedAt = this.#clock();
    const transferEvidenceHash = hashJson({
      chainId: 56,
      receipt,
      canonicalBlock: primaryBlock,
      finalityState: confirmations >= 15 ? 'FINAL' : 'MINED',
      transfer,
    });
    let reorgedFrom: GuaranteeDepositChainObservation['reorgedFrom'];
    if (item.observedBlockHash && item.observedBlockHash !== receipt.blockHash) {
      if (item.observedBlockNumber === undefined || item.observedLogIndex === undefined) {
        throw new CoreError('InvalidFinality', 'Guarantee replacement block lacks previous event identity', 409);
      }
      const canonicalBlockHash = await this.#canonicalReplacementHash(item.observedBlockNumber, item.observedBlockHash);
      reorgedFrom = {
        previousBlockNumber: item.observedBlockNumber,
        previousBlockHash: item.observedBlockHash,
        previousLogIndex: item.observedLogIndex,
        canonicalBlockHash,
        confirmations: item.confirmations,
        evidenceHash: hashJson({
          transactionHash: item.transactionHash,
          previousBlockNumber: item.observedBlockNumber,
          previousBlockHash: item.observedBlockHash,
          canonicalBlockHash,
          replacementBlockHash: receipt.blockHash,
        }),
      };
    }
    return {
      state: confirmations >= 15 ? 'FINAL' : 'MINED',
      transactionHash: receipt.transactionHash,
      tokenAddress: USDT_ADDRESS,
      from: transfer.from,
      to: transfer.to,
      amount: transfer.amount,
      blockNumber,
      blockHash: receipt.blockHash,
      logIndex: transfer.logIndex,
      confirmations,
      receiptStatus: 1,
      canonicalBlock: true,
      transferEvidenceHash,
      observedAt,
      ...(reorgedFrom ? { reorgedFrom } : {}),
    };
  }

  async #missingReceiptReorg(item: GuaranteeDepositFinalityItem): Promise<GuaranteeDepositReorgObservation> {
    const canonicalBlockHash = await this.#canonicalReplacementHash(item.observedBlockNumber!, item.observedBlockHash!);
    const observedAt = this.#clock();
    const evidenceHash = hashJson({
      transactionHash: item.transactionHash,
      previousBlockNumber: item.observedBlockNumber,
      previousBlockHash: item.observedBlockHash,
      previousLogIndex: item.observedLogIndex,
      canonicalBlockHash,
      receipts: [null, null],
    });
    return {
      state: 'REORGED',
      transactionHash: item.transactionHash,
      previousBlockNumber: item.observedBlockNumber!,
      previousBlockHash: item.observedBlockHash!,
      previousLogIndex: item.observedLogIndex!,
      canonicalBlockHash,
      confirmations: item.confirmations,
      evidenceHash,
      observedAt,
    };
  }

  async #canonicalReplacementHash(blockNumber: number, previousBlockHash: string) {
    const tag = `0x${blockNumber.toString(16)}`;
    const blocks = await Promise.all(this.#clients.map((client) => client.request('eth_getBlockByNumber', [tag, false])));
    const primary = normalizeBlock(blocks[0], 'previous guarantee block');
    const fallback = normalizeBlock(blocks[1], 'previous guarantee block');
    if (primary.number !== tag || fallback.number !== tag || primary.hash !== fallback.hash) {
      throw new CoreError('InvalidFinality', 'Guarantee reorg providers disagree on the canonical replacement block', 409);
    }
    if (primary.hash === previousBlockHash.toLowerCase()) {
      throw new CoreError('InvalidFinality', 'Guarantee receipt disappeared while its block remains canonical', 409);
    }
    return primary.hash;
  }
}

export class GuaranteeDepositWorker {
  readonly #service: GuaranteeDepositService;
  readonly #source: GuaranteeDepositChainSource;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #lastErrorCode: string | undefined;

  constructor(input: {
    service: GuaranteeDepositService;
    source: GuaranteeDepositChainSource;
    intervalMs?: number;
  }) {
    this.#service = input.service;
    this.#source = input.source;
    this.#intervalMs = input.intervalMs ?? 5_000;
  }

  async pollOnce() {
    const pending = await this.#service.pendingFinality(25);
    let failureCode: string | undefined;
    for (const item of pending) {
      try {
        const observation = await this.#source.observe(item);
        if (observation.state === 'PENDING') continue;
        if (observation.state === 'REORGED') {
          await this.#service.recordReorg(item.depositId, observation);
          continue;
        }
        if (observation.reorgedFrom) {
          await this.#service.recordReorg(item.depositId, {
            state: 'REORGED',
            transactionHash: observation.transactionHash,
            observedAt: observation.observedAt,
            ...observation.reorgedFrom,
          });
        }
        await this.#service.recordObservation(item.depositId, observation);
      } catch (error) {
        failureCode ??= errorCode(error);
      }
    }
    this.#lastErrorCode = failureCode;
    return pending.length;
  }

  start() {
    if (this.#timer || this.#running) return;
    const tick = () => {
      this.#running = this.pollOnce()
        .then(() => undefined)
        .catch((error) => { this.#lastErrorCode = errorCode(error); })
        .finally(() => {
          this.#running = undefined;
          if (this.#timer) this.#timer = setTimeout(tick, this.#intervalMs);
        });
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  status() {
    return Object.freeze({ healthy: this.#lastErrorCode === undefined, errorCode: this.#lastErrorCode });
  }
}

class JsonRpcClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  async request(method: string, params: unknown[]) {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      throw new CoreError('ExternalBlocked', 'Guarantee finality RPC is unavailable', 503);
    }
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Guarantee finality RPC is unavailable', 503);
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error !== undefined || !Object.hasOwn(body, 'result')) {
      throw new CoreError('ExternalBlocked', 'Guarantee finality RPC returned an invalid response', 503);
    }
    return body.result;
  }
}

function normalizeReceipt(value: unknown, expectedTransactionHash: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidFinality', 'Guarantee receipt is invalid', 409);
  }
  const receipt = value as Partial<RpcReceipt>;
  const transactionHash = hash(receipt.transactionHash, 'receipt transaction hash');
  if (transactionHash !== expectedTransactionHash.toLowerCase()) {
    throw new CoreError('InvalidFinality', 'Guarantee receipt transaction hash mismatch', 409);
  }
  const blockHash = hash(receipt.blockHash, 'receipt block hash');
  const blockNumber = hex(receipt.blockNumber, 'receipt block number');
  const transactionIndex = hex(receipt.transactionIndex, 'receipt transaction index');
  const status = hex(receipt.status, 'receipt status');
  if (!Array.isArray(receipt.logs)) throw new CoreError('InvalidFinality', 'Guarantee receipt logs are invalid', 409);
  const logs = receipt.logs.map((log) => ({
    address: normalizedAddress(log.address, 'receipt log address'),
    topics: Array.isArray(log.topics) ? log.topics.map((topic) => hash(topic, 'receipt log topic')) : invalidLogs(),
    data: hexData(log.data, 'receipt log data'),
    logIndex: hex(log.logIndex, 'receipt log index'),
    transactionHash: hash(log.transactionHash, 'receipt log transaction hash'),
    blockHash: hash(log.blockHash, 'receipt log block hash'),
    blockNumber: hex(log.blockNumber, 'receipt log block number'),
    removed: log.removed === true,
  }));
  if (logs.some((log) => log.transactionHash !== transactionHash || log.blockHash !== blockHash || log.blockNumber !== blockNumber || log.removed)) {
    throw new CoreError('InvalidFinality', 'Guarantee receipt log envelope mismatch', 409);
  }
  return { transactionHash, transactionIndex, blockHash, blockNumber, status, logs };
}

function matchingTransfer(receipt: ReturnType<typeof normalizeReceipt>, item: GuaranteeDepositFinalityItem) {
  const expectedFrom = normalizedAddress(item.merchantWallet, 'expected guarantee sender');
  const expectedTo = normalizedAddress(item.operationsSafeAddress, 'expected guarantee recipient');
  const matches = receipt.logs.filter((log) => {
    if (
      log.address !== USDT_ADDRESS
      || log.topics.length !== 3
      || log.topics[0] !== TRANSFER_EVENT_SIGNATURE_HASH
      || !/^0x[0-9a-f]{64}$/.test(log.data)
    ) return false;
    const from = topicAddress(log.topics[1]!);
    const to = topicAddress(log.topics[2]!);
    const amount = BigInt(log.data).toString();
    return from === expectedFrom && to === expectedTo && amount === item.expectedAmountUsdt;
  });
  if (matches.length !== 1) throw new CoreError('InvalidFinality', 'Guarantee receipt must contain one exact USDT Transfer', 409);
  const log = matches[0]!;
  return {
    from: topicAddress(log.topics[1]!),
    to: topicAddress(log.topics[2]!),
    amount: BigInt(log.data).toString(),
    logIndex: parseHexNumber(log.logIndex, 'guarantee log index'),
  };
}

function normalizeBlock(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidFinality', `${name} is unavailable`, 409);
  }
  const block = value as Partial<RpcBlock>;
  return { number: hex(block.number, `${name} number`), hash: hash(block.hash, `${name} hash`) };
}

function validateItem(item: GuaranteeDepositFinalityItem) {
  if (
    !item.depositId
    || !item.merchantId
    || !Number.isSafeInteger(item.policyVersion)
    || item.policyVersion <= 0
    || item.tokenAddress !== USDT_ADDRESS
    || !/^[1-9][0-9]*$/.test(item.expectedAmountUsdt)
    || !isHash(item.transactionHash)
  ) throw new CoreError('InvalidRequest', 'Guarantee finality item is invalid');
  normalizedAddress(item.merchantWallet, 'guarantee merchant wallet');
  normalizedAddress(item.operationsSafeAddress, 'guarantee Operations Safe');
}

function rpcUrl(value: string, name: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('UnsafeRpcUrl');
    url.hash = '';
    return url.toString();
  } catch {
    throw new CoreError('ExternalBlocked', `${name} guarantee RPC must be an HTTPS endpoint without embedded credentials`, 503);
  }
}

function topicAddress(topic: string) {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new CoreError('InvalidFinality', 'Guarantee Transfer address topic is invalid', 409);
  return normalizedAddress(`0x${topic.slice(-40)}`, 'guarantee Transfer address');
}

function parseHexNumber(value: unknown, name: string) {
  const normalized = hex(value, name);
  const result = Number(BigInt(normalized));
  if (!Number.isSafeInteger(result) || result < 0) throw new CoreError('InvalidFinality', `${name} is outside the safe range`, 409);
  return result;
}

function hex(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  }
  return `0x${BigInt(value).toString(16)}`;
}

function hexData(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  }
  return value.toLowerCase();
}

function hash(value: unknown, name: string) {
  if (typeof value !== 'string' || !isHash(value)) throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  return value.toLowerCase();
}

function normalizedAddress(value: unknown, name: string) {
  try {
    return getAddress(String(value)).toLowerCase();
  } catch {
    throw new CoreError('InvalidFinality', `${name} is invalid`, 409);
  }
}

function invalidLogs(): never {
  throw new CoreError('InvalidFinality', 'Guarantee receipt topics are invalid', 409);
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function errorCode(error: unknown) {
  if (error instanceof CoreError) return error.code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.message)) return error.message;
  return 'GuaranteeFinalityUnavailable';
}

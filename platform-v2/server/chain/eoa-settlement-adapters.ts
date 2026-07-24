import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers';
import { CoreError } from '../api/errors.ts';
import type {
  DeterministicEoaSettlementExecutorErrorCode,
  EoaSettlementBroadcaster,
  EoaSettlementChainSource,
  EoaSettlementReceipt,
} from './settlement-worker.ts';
import { deterministicEoaSettlementExecutorErrorCodes } from './settlement-worker.ts';

const TRANSFER_EVENT = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
]);

export class HttpEoaSettlementBroadcaster implements EoaSettlementBroadcaster {
  readonly #url: string;
  readonly #token: string;
  readonly #maxGasLimit: bigint;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(input: {
    url?: string;
    token?: string;
    maxGasLimit: bigint;
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
  }) {
    this.#url = secureEndpoint(input.url, input.token, 'EOA settlement executor').url;
    this.#token = input.token!;
    this.#maxGasLimit = input.maxGasLimit;
    this.#fetch = input.fetch ?? fetch;
    this.#requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 100 || this.#requestTimeoutMs > 60_000) {
      throw new CoreError('InvalidRequest', 'EOA settlement executor timeout is invalid');
    }
  }

  submit(input: Parameters<EoaSettlementBroadcaster['submit']>[0]) {
    return this.#broadcast(input);
  }

  async replace(input: Parameters<EoaSettlementBroadcaster['replace']>[0]) {
    if (!isHash(input.replacementForExecutionTxHash) || !validIdentifier(input.replacementForAttemptId)) {
      throw new CoreError('InvalidRequest', 'EOA replacement evidence is invalid');
    }
    const body = await this.#broadcast(input, true);
    if (body.replacementForExecutionTxHash !== input.replacementForExecutionTxHash.toLowerCase()) {
      throw new CoreError('InvalidFinality', 'EOA executor did not bind the replaced transaction', 502);
    }
    return body as Awaited<ReturnType<EoaSettlementBroadcaster['replace']>>;
  }

  async #broadcast(
    input: Parameters<EoaSettlementBroadcaster['submit']>[0]
      | Parameters<EoaSettlementBroadcaster['replace']>[0],
    replacement = false,
  ) {
    if (
      input.chainId !== 56
      || !isHash(input.transferId)
      || !isAddress(input.executorWallet)
      || !/^(0|[1-9][0-9]*)$/.test(input.executorNonce)
      || !isAddress(input.tokenAddress)
      || !isHash(input.requestId)
      || !Number.isSafeInteger(input.requestItemIndex)
      || input.requestItemIndex < 0
      || !isHash(input.orderId)
      || !validIdentifier(input.accountId)
      || !isAddress(input.backingWalletAddress)
      || !isAddress(input.recipientAddress)
      || !/^[1-9][0-9]*$/.test(input.amount)
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.transferCalldata)
      || !isHash(input.contentHash)
      || !isHash(input.requestDigest)
      || !validIdentifier(input.idempotencyKey)
      || (input.reconciliationOnly !== undefined && input.reconciliationOnly !== true)
      || !/^[1-9][0-9]*$/.test(input.gasLimit)
      || BigInt(input.gasLimit) > this.#maxGasLimit
      || !input.authorization
      || typeof input.authorization !== 'object'
    ) throw new CoreError('InvalidRequest', 'EOA settlement execution envelope is invalid');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CoreError('ExternalBlocked', 'EOA settlement executor result is ambiguous', 503, {
        deterministicExecutorFailure: false,
        failure: controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT',
        cause: error instanceof Error ? error.name : 'UnknownTransportFailure',
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw executorHttpError(response.status, await response.text().catch(() => ''));
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch (error) {
      throw new CoreError('ExternalBlocked', 'EOA settlement executor result is ambiguous', 503, {
        deterministicExecutorFailure: false,
        failure: 'MALFORMED_RESPONSE',
        cause: error instanceof Error ? error.name : 'UnknownResponseFailure',
      });
    }
    if (
      typeof body.executionTxHash !== 'string'
      || !isHash(body.executionTxHash)
      || typeof body.executorWallet !== 'string'
      || !isAddress(body.executorWallet)
      || typeof body.executorNonce !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(body.executorNonce)
      || body.requestDigest !== input.requestDigest
      || (replacement && (
        typeof body.replacementForExecutionTxHash !== 'string'
        || !isHash(body.replacementForExecutionTxHash)
      ))
    ) throw new CoreError('InvalidFinality', 'EOA settlement executor returned malformed evidence', 502);
    return {
      executionTxHash: body.executionTxHash.toLowerCase(),
      executorWallet: getAddress(body.executorWallet).toLowerCase(),
      executorNonce: body.executorNonce,
      requestDigest: body.requestDigest,
      ...(replacement
        ? { replacementForExecutionTxHash: String(body.replacementForExecutionTxHash).toLowerCase() }
        : {}),
    };
  }
}

export class ResilientBscEoaSettlementChainSource implements EoaSettlementChainSource {
  readonly #providers: readonly JsonRpcProvider[];

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    providers?: readonly JsonRpcProvider[];
  }) {
    if (input.providers) {
      if (input.providers.length !== 2) {
        throw new CoreError('ExternalBlocked', 'Settlement finality requires two independent BSC RPC endpoints', 503);
      }
      this.#providers = [...input.providers];
      return;
    }
    if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Two BSC RPC endpoints are required for settlement finality', 503);
    }
    const urls = [input.primaryRpcUrl, input.fallbackRpcUrl].map(settlementRpcUrl);
    if (urls[0] === urls[1]) {
      throw new CoreError('ExternalBlocked', 'Settlement finality requires two independent BSC RPC endpoints', 503);
    }
    this.#providers = urls.map((url) => new JsonRpcProvider(url, 56, { staticNetwork: true }));
  }

  async receipt(executionTxHash: string) {
    if (!isHash(executionTxHash)) throw new CoreError('InvalidRequest', 'Execution transaction hash is invalid');
    const observations = await Promise.all(this.#providers.map((provider) => observe(provider, executionTxHash)));
    if (observations.every((item) => item === undefined)) return undefined;
    if (observations.some((item) => item === undefined)) {
      throw new CoreError('ExternalBlocked', 'BSC RPC sources disagree on settlement receipt availability', 503);
    }
    const [primary, fallback] = observations as [ObservedReceipt, ObservedReceipt];
    const primaryComparable = comparable(primary);
    const fallbackComparable = comparable(fallback);
    if (stableJson(primaryComparable) !== stableJson(fallbackComparable)) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on settlement evidence', 409);
    }
    const confirmations = Math.min(primary.confirmations, fallback.confirmations);
    const result: EoaSettlementReceipt = {
      ...primaryComparable,
      confirmations,
      evidenceHash: hashJson({ primary: primaryComparable, fallback: fallbackComparable, confirmations }),
    };
    return result;
  }

  async canonicalBlock(input: { blockNumber: number; blockHash: string }) {
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 || !isHash(input.blockHash)) {
      throw new CoreError('InvalidRequest', 'Settlement block identity is invalid');
    }
    await Promise.all(this.#providers.map(assertBscProvider));
    const blocks = await Promise.all(this.#providers.map((provider) => provider.getBlock(input.blockNumber)));
    if (blocks.some((block) => !block?.hash || !isHash(block.hash))) {
      throw new CoreError('ExternalBlocked', 'BSC RPC cannot prove settlement block identity', 503);
    }
    const primaryHash = blocks[0]!.hash!.toLowerCase();
    const fallbackHash = blocks[1]!.hash!.toLowerCase();
    if (primaryHash !== fallbackHash) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on canonical settlement block', 409);
    }
    return {
      canonical: primaryHash === input.blockHash.toLowerCase(),
      observedBlockHash: primaryHash,
      evidenceHash: hashJson({
        blockNumber: input.blockNumber,
        expectedBlockHash: input.blockHash.toLowerCase(),
        observedBlockHash: primaryHash,
      }),
    };
  }
}

interface ObservedReceipt extends Omit<EoaSettlementReceipt, 'evidenceHash'> {
  evidenceHash?: never;
}

async function observe(provider: JsonRpcProvider, txHash: string): Promise<ObservedReceipt | undefined> {
  await assertBscProvider(provider);
  const [transaction, receipt, head] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
    provider.getBlockNumber(),
  ]);
  if (!receipt) return undefined;
  if (!transaction || !transaction.to || receipt.status === null) {
    throw new CoreError('InvalidFinality', 'Settlement transaction or receipt is incomplete', 409);
  }
  const canonical = await provider.getBlock(receipt.blockNumber);
  const canonicalBlock = canonical?.hash?.toLowerCase() === receipt.blockHash.toLowerCase();
  const transfers: Array<{ tokenAddress: string; from: string; to: string; amount: string }> = [];
  for (const log of receipt.logs) {
    try {
      const event = TRANSFER_EVENT.parseLog({ topics: [...log.topics], data: log.data });
      if (event?.name === 'Transfer') {
        transfers.push({
          tokenAddress: getAddress(log.address).toLowerCase(),
          from: getAddress(String(event.args.from)).toLowerCase(),
          to: getAddress(String(event.args.to)).toLowerCase(),
          amount: String(event.args.amount),
        });
      }
    } catch {
      // Not an ERC-20 Transfer event.
    }
  }
  const transferEventDeltas = transferEventDeltasFromTransfers(transfers);
  return {
    chainId: 56,
    executionTxHash: txHash.toLowerCase(),
    transactionTo: getAddress(transaction.to).toLowerCase(),
    transactionCalldata: transaction.data.toLowerCase(),
    executorWallet: getAddress(transaction.from).toLowerCase(),
    executorNonce: String(transaction.nonce),
    receiptStatus: receipt.status === 1 ? 1 : 0,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    confirmations: Math.max(0, head - receipt.blockNumber + 1),
    canonicalBlock,
    transfers,
    transferEventDeltas,
  };
}

function transferEventDeltasFromTransfers(
  transfers: readonly { tokenAddress: string; from: string; to: string; amount: string }[],
) {
  const deltas = new Map<string, { tokenAddress: string; account: string; delta: bigint }>();
  const add = (tokenAddress: string, account: string, delta: bigint) => {
    const key = `${tokenAddress}:${account}`;
    const current = deltas.get(key);
    deltas.set(key, {
      tokenAddress,
      account,
      delta: (current?.delta ?? 0n) + delta,
    });
  };
  for (const transfer of transfers) {
    const amount = BigInt(transfer.amount);
    add(transfer.tokenAddress, transfer.from, -amount);
    add(transfer.tokenAddress, transfer.to, amount);
  }
  return [...deltas.values()]
    .sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress) || left.account.localeCompare(right.account))
    .map((item) => ({ ...item, delta: item.delta.toString() }));
}

function comparable(value: ObservedReceipt): Omit<ObservedReceipt, 'confirmations'> {
  const { confirmations: _confirmations, ...comparableValue } = value;
  return {
    ...comparableValue,
    transfers: [...value.transfers],
    transferEventDeltas: [...value.transferEventDeltas],
  };
}

async function assertBscProvider(provider: JsonRpcProvider) {
  const chainId = await provider.send('eth_chainId', []);
  if (typeof chainId !== 'string' || BigInt(chainId) !== 56n) {
    throw new CoreError('ExternalBlocked', 'Settlement RPC is not BSC chain 56', 503);
  }
}

function settlementRpcUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreError('ExternalBlocked', 'Settlement RPC endpoint is invalid', 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('ExternalBlocked', 'Settlement RPC endpoints require HTTPS without embedded credentials', 503);
  }
  return url.href;
}

function executorHttpError(status: number, bodyText: string) {
  const executorErrorCode = executorErrorCodeFromBody(bodyText);
  if (
    status >= 400
    && status < 500
    && executorErrorCode
  ) {
    throw new CoreError('InvalidRequest', 'EOA settlement executor rejected a deterministic envelope', status, {
      deterministicExecutorFailure: true,
      executorErrorCode,
    });
  }
  throw new CoreError('ExternalBlocked', 'EOA settlement executor result is ambiguous', 503, {
    deterministicExecutorFailure: false,
    status,
  });
}

function executorErrorCodeFromBody(bodyText: string): DeterministicEoaSettlementExecutorErrorCode | undefined {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const code = typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined;
    const value = typeof code === 'string'
      ? code
      : (typeof code === 'object' && code !== null && typeof (code as { code?: unknown }).code === 'string'
        ? (code as { code: string }).code
        : undefined);
    return deterministicEoaSettlementExecutorErrorCodes.includes(
      value as DeterministicEoaSettlementExecutorErrorCode,
    )
      ? value as DeterministicEoaSettlementExecutorErrorCode
      : undefined;
  } catch {
    return undefined;
  }
}

function secureEndpoint(urlValue: string | undefined, token: string | undefined, name: string) {
  if (!urlValue || !token) throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CoreError('ExternalBlocked', `${name} URL is invalid`, 503);
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new CoreError('ExternalBlocked', `${name} requires HTTPS outside loopback`, 503);
  }
  return { url: url.toString() };
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9:_-]{1,256}$/.test(value);
}

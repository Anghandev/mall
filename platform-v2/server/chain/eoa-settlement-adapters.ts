import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers';
import { CoreError } from '../api/errors.ts';
import type {
  EoaSettlementBroadcaster,
  EoaSettlementChainSource,
  EoaSettlementReceipt,
} from './settlement-worker.ts';
import { readAddressLogs } from './rpc-logs.ts';

const TRANSFER_EVENT = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
]);
const TRANSFER_TOPIC = TRANSFER_EVENT.getEvent('Transfer')!.topicHash.toLowerCase();
const ERC20_READ = new Interface(['function balanceOf(address account) view returns (uint256)']);

export class HttpEoaSettlementBroadcaster implements EoaSettlementBroadcaster {
  readonly #url: string;
  readonly #token: string;
  readonly #maxGasLimit: bigint;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    maxGasLimit: bigint;
    fetch?: typeof fetch;
  }) {
    this.#url = secureEndpoint(input.url, input.token, 'EOA settlement executor').url;
    this.#token = input.token!;
    this.#maxGasLimit = input.maxGasLimit;
    this.#fetch = input.fetch ?? fetch;
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
      || !isAddress(input.recipientAddress)
      || !/^[1-9][0-9]*$/.test(input.amount)
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.transferCalldata)
      || !isHash(input.contentHash)
      || !isHash(input.requestDigest)
      || !validIdentifier(input.idempotencyKey)
      || !/^[1-9][0-9]*$/.test(input.gasLimit)
      || BigInt(input.gasLimit) > this.#maxGasLimit
    ) throw new CoreError('InvalidRequest', 'EOA settlement execution envelope is invalid');
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'EOA settlement executor rejected the envelope', 503);
    const body = await response.json() as Record<string, unknown>;
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

  constructor(input: { primaryRpcUrl?: string; fallbackRpcUrl?: string }) {
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
  const transactionDeltas = await readTransactionBalanceDeltas(
    provider,
    receipt.blockNumber,
    txHash.toLowerCase(),
    transfers,
  );
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
    transactionDeltas,
  };
}

async function readTransactionBalanceDeltas(
  provider: JsonRpcProvider,
  blockNumber: number,
  executionTxHash: string,
  transfers: readonly { tokenAddress: string; from: string; to: string }[],
) {
  if (blockNumber <= 0) throw new CoreError('InvalidFinality', 'Settlement block has no prior state', 409);
  const pairs = new Map<string, { tokenAddress: string; account: string }>();
  for (const transfer of transfers) {
    for (const account of [transfer.from, transfer.to]) {
      pairs.set(`${transfer.tokenAddress}:${account}`, { tokenAddress: transfer.tokenAddress, account });
    }
  }
  const sortedPairs = [...pairs.values()].sort((left, right) =>
    left.tokenAddress.localeCompare(right.tokenAddress) || left.account.localeCompare(right.account));
  try {
    const blockDeltas = await Promise.all(sortedPairs.map(async ({ tokenAddress, account }) => {
      const data = ERC20_READ.encodeFunctionData('balanceOf', [account]);
      const [beforeResult, afterResult] = await Promise.all([
        provider.send('eth_call', [{ to: tokenAddress, data }, `0x${(blockNumber - 1).toString(16)}`]),
        provider.send('eth_call', [{ to: tokenAddress, data }, `0x${blockNumber.toString(16)}`]),
      ]);
      const before = BigInt(ERC20_READ.decodeFunctionResult('balanceOf', beforeResult)[0]);
      const after = BigInt(ERC20_READ.decodeFunctionResult('balanceOf', afterResult)[0]);
      return { tokenAddress, account, delta: after - before };
    }));
    const tokenAddresses = [...new Set(sortedPairs.map((item) => item.tokenAddress))];
    const blockLogs = tokenAddresses.length === 0
      ? []
      : await readAddressLogs(provider, {
        addresses: tokenAddresses,
        fromBlock: blockNumber,
        toBlock: blockNumber,
        topic0: TRANSFER_TOPIC,
      });
    const unrelatedTransfers = blockLogs
      .filter((log) => log.transactionHash.toLowerCase() !== executionTxHash)
      .map((log) => {
        const event = TRANSFER_EVENT.parseLog({ topics: [...log.topics], data: log.data });
        if (!event || event.name !== 'Transfer') throw new Error('invalid transfer event');
        return {
          tokenAddress: getAddress(log.address).toLowerCase(),
          from: getAddress(String(event.args.from)).toLowerCase(),
          to: getAddress(String(event.args.to)).toLowerCase(),
          amount: String(event.args.amount),
        };
      });
    return reconcileTransactionBalanceDeltas(blockDeltas, unrelatedTransfers);
  } catch (error) {
    throw new CoreError('ExternalBlocked', 'Archive RPC transaction balance evidence is unavailable', 503, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function reconcileTransactionBalanceDeltas(
  blockDeltas: readonly { tokenAddress: string; account: string; delta: bigint }[],
  unrelatedTransfers: readonly { tokenAddress: string; from: string; to: string; amount: string }[],
) {
  const unrelated = new Map<string, bigint>();
  const add = (tokenAddress: string, account: string, delta: bigint) => {
    const key = `${tokenAddress}:${account}`;
    unrelated.set(key, (unrelated.get(key) ?? 0n) + delta);
  };
  for (const transfer of unrelatedTransfers) {
    const amount = BigInt(transfer.amount);
    add(transfer.tokenAddress, transfer.from, -amount);
    add(transfer.tokenAddress, transfer.to, amount);
  }
  return blockDeltas.map((item) => ({
    tokenAddress: item.tokenAddress,
    account: item.account,
    delta: (item.delta - (unrelated.get(`${item.tokenAddress}:${item.account}`) ?? 0n)).toString(),
  }));
}

function comparable(value: ObservedReceipt): Omit<ObservedReceipt, 'confirmations'> {
  const { confirmations: _confirmations, ...comparableValue } = value;
  return {
    ...comparableValue,
    transfers: [...value.transfers],
    transactionDeltas: [...value.transactionDeltas],
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

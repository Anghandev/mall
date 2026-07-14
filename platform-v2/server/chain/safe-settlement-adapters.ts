import {
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers';
import { CoreError } from '../api/errors.ts';
import type {
  SafeApprovalVerifier,
  SafeSettlementBroadcaster,
  SafeSettlementChainSource,
  SafeSettlementReceipt,
  VerifiedSafeApprovals,
} from './settlement-worker.ts';

const SAFE_EVENTS = new Interface([
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
  'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
const TRANSFER_EVENT = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
]);
const SAFE_READ = new Interface(['function nonce() view returns (uint256)']);
const ERC20_READ = new Interface(['function balanceOf(address account) view returns (uint256)']);

export class HttpSafeApprovalVerifier implements SafeApprovalVerifier {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(input: { url?: string; token?: string; mutualTls: boolean; fetch?: typeof fetch }) {
    this.#url = secureEndpoint(input.url, input.token, input.mutualTls, 'Safe approval verifier').url;
    this.#token = input.token!;
    this.#fetch = input.fetch ?? fetch;
  }

  async verify(input: Parameters<SafeApprovalVerifier['verify']>[0]) {
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Safe approval verification failed', 503);
    const value = await response.json() as Partial<VerifiedSafeApprovals>;
    if (
      typeof value.safeAddress !== 'string'
      || typeof value.safeTxHash !== 'string'
      || typeof value.ownerSetHash !== 'string'
      || typeof value.threshold !== 'number'
      || typeof value.proposalReferenceHash !== 'string'
      || typeof value.approvalEvidenceHash !== 'string'
      || typeof value.packedSignatures !== 'string'
      || !Array.isArray(value.approvals)
      || value.approvals.some((approval) =>
        !approval || typeof approval.ownerAddress !== 'string' || typeof approval.signature !== 'string')
    ) throw new CoreError('InvalidFinality', 'Safe approval verifier returned malformed evidence', 502);
    return value as VerifiedSafeApprovals;
  }
}

export class HttpSafeSettlementBroadcaster implements SafeSettlementBroadcaster {
  readonly #url: string;
  readonly #token: string;
  readonly #maxOuterGasLimit: bigint;
  readonly #fetch: typeof fetch;

  constructor(input: {
    url?: string;
    token?: string;
    mutualTls: boolean;
    maxOuterGasLimit: bigint;
    fetch?: typeof fetch;
  }) {
    this.#url = secureEndpoint(input.url, input.token, input.mutualTls, 'Safe broadcaster').url;
    this.#token = input.token!;
    this.#maxOuterGasLimit = input.maxOuterGasLimit;
    this.#fetch = input.fetch ?? fetch;
  }

  async submit(input: Parameters<SafeSettlementBroadcaster['submit']>[0]) {
    return this.#broadcast(input);
  }

  async replace(input: Parameters<SafeSettlementBroadcaster['replace']>[0]) {
    if (
      !/^[A-Za-z0-9:_-]{1,256}$/.test(input.replacementForAttemptId)
      || !isHash(input.replacementForExecutionTxHash)
      || !isAddress(input.outerSender)
      || !/^(0|[1-9][0-9]*)$/.test(input.outerNonce)
    ) throw new CoreError('InvalidRequest', 'Safe replacement evidence is invalid');
    const body = await this.#broadcast(input, true);
    if (
      body.replacementForExecutionTxHash !== input.replacementForExecutionTxHash.toLowerCase()
      || body.outerSender !== getAddress(input.outerSender).toLowerCase()
      || body.outerNonce !== input.outerNonce
    ) {
      throw new CoreError('InvalidFinality', 'Safe broadcaster did not bind the replaced transaction', 502);
    }
    return body as Awaited<ReturnType<SafeSettlementBroadcaster['replace']>>;
  }

  async #broadcast(
    input: Parameters<SafeSettlementBroadcaster['submit']>[0]
      | Parameters<SafeSettlementBroadcaster['replace']>[0],
    replacement = false,
  ) {
    if (
      input.chainId !== 56
      || !isHash(input.batchId)
      || !isAddress(input.safeAddress)
      || !/^(0|[1-9][0-9]*)$/.test(input.safeNonce)
      || !isHash(input.safeTxHash)
      || !isHash(input.contentHash)
      || !isHash(input.requestDigest)
      || !/^0x(?:[0-9a-fA-F]{2})+$/.test(input.execTransactionCalldata)
      || !/^[A-Za-z0-9:_-]{1,256}$/.test(input.idempotencyKey)
      || !/^[1-9][0-9]*$/.test(input.outerGasLimit)
      || BigInt(input.outerGasLimit) > this.#maxOuterGasLimit
    ) throw new CoreError('InvalidRequest', 'Safe execution envelope is invalid');
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Safe broadcaster rejected the envelope', 503);
    const body = await response.json() as Record<string, unknown>;
    if (
      typeof body.executionTxHash !== 'string'
      || !isHash(body.executionTxHash)
      || typeof body.outerSender !== 'string'
      || !isAddress(body.outerSender)
      || typeof body.outerNonce !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(body.outerNonce)
      || body.requestDigest !== input.requestDigest
      || (replacement && (
        typeof body.replacementForExecutionTxHash !== 'string'
        || !isHash(body.replacementForExecutionTxHash)
      ))
    ) throw new CoreError('InvalidFinality', 'Safe broadcaster response is not envelope-bound', 502);
    return {
      executionTxHash: body.executionTxHash.toLowerCase(),
      outerSender: getAddress(body.outerSender).toLowerCase(),
      outerNonce: body.outerNonce,
      requestDigest: body.requestDigest,
      ...(replacement
        ? { replacementForExecutionTxHash: String(body.replacementForExecutionTxHash).toLowerCase() }
        : {}),
    };
  }
}

export class ResilientBscSafeSettlementChainSource implements SafeSettlementChainSource {
  readonly #providers: readonly JsonRpcProvider[];

  constructor(input: { primaryRpcUrl?: string; fallbackRpcUrl?: string }) {
    if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
      throw new CoreError('ExternalBlocked', 'Two BSC RPC endpoints are required for Safe finality', 503);
    }
    const urls = [input.primaryRpcUrl, input.fallbackRpcUrl].map(settlementRpcUrl);
    if (urls[0] === urls[1]) {
      throw new CoreError('ExternalBlocked', 'Safe finality requires two independent BSC RPC endpoints', 503);
    }
    this.#providers = urls.map(
      (url) => new JsonRpcProvider(url, 56, { staticNetwork: true }),
    );
  }

  async receipt(executionTxHash: string) {
    if (!isHash(executionTxHash)) throw new CoreError('InvalidRequest', 'Execution transaction hash is invalid');
    const observations = await Promise.all(this.#providers.map((provider) => observe(provider, executionTxHash)));
    if (observations.every((item) => item === undefined)) return undefined;
    if (observations.some((item) => item === undefined)) {
      throw new CoreError('ExternalBlocked', 'BSC RPC sources disagree on Safe receipt availability', 503);
    }
    const [primary, fallback] = observations as [ObservedReceipt, ObservedReceipt];
    const primaryComparable = comparable(primary);
    const fallbackComparable = comparable(fallback);
    if (stableJson(primaryComparable) !== stableJson(fallbackComparable)) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on Safe canonical evidence', 409);
    }
    const confirmations = Math.min(primary.confirmations, fallback.confirmations);
    const result: SafeSettlementReceipt = {
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
      throw new CoreError('ExternalBlocked', 'BSC RPC cannot prove the settlement block identity', 503);
    }
    const primaryHash = blocks[0]!.hash!.toLowerCase();
    const fallbackHash = blocks[1]!.hash!.toLowerCase();
    if (primaryHash !== fallbackHash) {
      throw new CoreError('InvalidFinality', 'BSC RPC sources disagree on the canonical settlement block', 409);
    }
    const observedBlockHash = primaryHash;
    return {
      canonical: observedBlockHash === input.blockHash.toLowerCase(),
      observedBlockHash,
      evidenceHash: hashJson({
        blockNumber: input.blockNumber,
        expectedBlockHash: input.blockHash.toLowerCase(),
        observedBlockHash,
      }),
    };
  }
}

interface ObservedReceipt extends Omit<SafeSettlementReceipt, 'evidenceHash'> {
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
    throw new CoreError('InvalidFinality', 'Safe transaction or receipt is incomplete', 409);
  }
  const canonical = await provider.getBlock(receipt.blockNumber);
  const canonicalBlock = canonical?.hash?.toLowerCase() === receipt.blockHash.toLowerCase();
  const safeAddress = getAddress(transaction.to).toLowerCase();
  let executionSuccessSafeTxHash: string | undefined;
  let executionFailureSafeTxHash: string | undefined;
  const transfers: Array<{ tokenAddress: string; from: string; to: string; amount: string }> = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === safeAddress) {
      try {
        const event = SAFE_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
        if (event?.name === 'ExecutionSuccess') executionSuccessSafeTxHash = String(event.args.txHash).toLowerCase();
        if (event?.name === 'ExecutionFailure') executionFailureSafeTxHash = String(event.args.txHash).toLowerCase();
      } catch {
        // Not a Safe execution event.
      }
    }
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
  const balanceDeltas = await readBalanceDeltas(provider, receipt.blockNumber, transfers);
  const nonceResult = await provider.send('eth_call', [{
    to: safeAddress,
    data: SAFE_READ.encodeFunctionData('nonce'),
  }, `0x${receipt.blockNumber.toString(16)}`]);
  const safeNonceAfter = String(SAFE_READ.decodeFunctionResult('nonce', nonceResult)[0]);
  return {
    chainId: 56,
    executionTxHash: txHash.toLowerCase(),
    transactionTo: safeAddress,
    transactionCalldata: transaction.data,
    outerSender: getAddress(transaction.from).toLowerCase(),
    outerNonce: String(transaction.nonce),
    receiptStatus: receipt.status === 1 ? 1 : 0,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    confirmations: Math.max(0, head - receipt.blockNumber + 1),
    canonicalBlock,
    ...(executionSuccessSafeTxHash ? { executionSuccessSafeTxHash } : {}),
    ...(executionFailureSafeTxHash ? { executionFailureSafeTxHash } : {}),
    safeNonceAfter,
    transfers,
    balanceDeltas,
  };
}

async function readBalanceDeltas(
  provider: JsonRpcProvider,
  blockNumber: number,
  transfers: readonly { tokenAddress: string; from: string; to: string }[],
) {
  if (blockNumber <= 0) throw new CoreError('InvalidFinality', 'Settlement block has no prior state', 409);
  const pairs = new Map<string, { tokenAddress: string; account: string }>();
  for (const transfer of transfers) {
    for (const account of [transfer.from, transfer.to]) {
      pairs.set(`${transfer.tokenAddress}:${account}`, { tokenAddress: transfer.tokenAddress, account });
    }
  }
  try {
    return await Promise.all([...pairs.values()]
      .sort((left, right) =>
        left.tokenAddress.localeCompare(right.tokenAddress) || left.account.localeCompare(right.account))
      .map(async ({ tokenAddress, account }) => {
        const data = ERC20_READ.encodeFunctionData('balanceOf', [account]);
        const [beforeResult, afterResult] = await Promise.all([
          provider.send('eth_call', [{ to: tokenAddress, data }, `0x${(blockNumber - 1).toString(16)}`]),
          provider.send('eth_call', [{ to: tokenAddress, data }, `0x${blockNumber.toString(16)}`]),
        ]);
        const before = BigInt(ERC20_READ.decodeFunctionResult('balanceOf', beforeResult)[0]);
        const after = BigInt(ERC20_READ.decodeFunctionResult('balanceOf', afterResult)[0]);
        return { tokenAddress, account, delta: (after - before).toString() };
      }));
  } catch (error) {
    throw new CoreError('ExternalBlocked', 'Archive RPC balance evidence is unavailable', 503, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function comparable(value: ObservedReceipt): Omit<ObservedReceipt, 'confirmations'> {
  const { confirmations: _confirmations, ...comparableValue } = value;
  return {
    ...comparableValue,
    transfers: [...value.transfers],
    balanceDeltas: [...value.balanceDeltas],
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
    throw new CoreError('ExternalBlocked', 'Safe finality RPC endpoint is invalid', 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new CoreError('ExternalBlocked', 'Safe finality RPC endpoints require HTTPS without embedded credentials', 503);
  }
  return url.href;
}

function secureEndpoint(urlValue: string | undefined, token: string | undefined, mutualTls: boolean, name: string) {
  if (!urlValue || !token || !mutualTls) throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CoreError('ExternalBlocked', `${name} URL is invalid`, 503);
  }
  if (url.protocol !== 'https:') throw new CoreError('ExternalBlocked', `${name} requires HTTPS and mutual TLS`, 503);
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

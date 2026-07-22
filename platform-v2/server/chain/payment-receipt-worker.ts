import { FetchRequest, Interface, JsonRpcProvider, id } from 'ethers';
import { CoreError } from '../api/errors.ts';
import { AbiEventDecoder, type DecodedDomainEvent, type IndexedLog } from './abi-decoder.ts';

const REQUIRED_CONFIRMATIONS = 15;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_RPC_OPERATION_TIMEOUT_MS = 10_000;
const PAYMENT_COMPLETED_TOPIC = id(
  'PaymentCompleted(bytes32,address,address,uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)',
).toLowerCase();
const USED_ORDER_ID_INTERFACE = new Interface(['function usedOrderId(bytes32 orderId) view returns (bool)']);

export interface PaymentReceiptCandidate {
  orderId: string;
  quoteKind: 'ORDINARY' | 'SECKILL';
  txHash: string;
  replacementForTxHash?: string;
  finalityState: 'SUBMITTED' | 'MINED' | 'REPLACED' | 'REORGED' | 'FINAL';
  observedBlockNumber?: number;
  observedBlockHash?: string;
  paymentEventKey?: string;
}

export interface ExpiredUnresolvedPaymentQuote {
  orderId: string;
  deadline: Date;
}

export interface ReceiptBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface UnresolvedOrderEvidence {
  state: 'CHAIN_DEADLINE_PENDING' | 'USED' | 'UNUSED_AFTER_DEADLINE';
  block: ReceiptBlock;
}

export type PaymentReceiptObservation =
  | { state: 'NOT_FOUND' }
  | { state: 'REORGED'; canonicalBlockHash: string }
  | {
      state: 'MINED';
      chainId: number;
      transactionHash: string;
      status: number;
      to: string | null;
      block: ReceiptBlock;
      confirmationBlock?: ReceiptBlock;
      confirmations: number;
      logs: readonly IndexedLog[];
      paymentLogIndex: number;
    };

export interface FinalPaymentReceipt {
  candidate: PaymentReceiptCandidate;
  observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>;
  events: readonly DecodedDomainEvent[];
}

export interface PaymentReceiptSource {
  observe(candidate: PaymentReceiptCandidate): Promise<PaymentReceiptObservation>;
  unresolvedOrderEvidence(input: ExpiredUnresolvedPaymentQuote): Promise<UnresolvedOrderEvidence>;
}

interface RpcReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  index?: number;
  logIndex?: number;
}

interface RpcReceipt {
  hash: string;
  to: string | null;
  status: number | null;
  blockNumber: number;
  blockHash: string;
  logs: readonly RpcReceiptLog[];
}

interface RpcBlock {
  number: number;
  hash: string | null;
  parentHash: string;
  timestamp: number;
}

export interface PaymentReceiptRpcProvider {
  getNetwork(): Promise<{ chainId: bigint }>;
  getTransactionReceipt(txHash: string): Promise<RpcReceipt | null>;
  getBlock(blockNumber: number): Promise<RpcBlock | null>;
  getBlockNumber(): Promise<number>;
  call(input: { to: string; data: string }, blockTag?: number): Promise<string>;
}

export class ResilientBscPaymentReceiptSource implements PaymentReceiptSource {
  readonly #providers: readonly [PaymentReceiptRpcProvider, PaymentReceiptRpcProvider];
  readonly #routerAddress: string;
  readonly #operationTimeoutMs: number;

  constructor(input: {
    primaryRpcUrl?: string;
    fallbackRpcUrl?: string;
    routerAddress: string;
    providers?: readonly PaymentReceiptRpcProvider[];
    operationTimeoutMs?: number;
  }) {
    if (!isAddress(input.routerAddress)) {
      throw new CoreError('ExternalBlocked', 'PaymentRouter deployment address is unavailable', 503);
    }
    const operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_RPC_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 10 || operationTimeoutMs > 60_000) {
      throw new CoreError('InvalidRequest', 'Payment receipt RPC timeout is invalid');
    }
    if (input.providers) {
      if (input.providers.length !== 2) {
        throw new CoreError('ExternalBlocked', 'Payment receipts require two independent BSC RPC endpoints', 503);
      }
      this.#providers = [input.providers[0]!, input.providers[1]!];
    } else {
      if (!input.primaryRpcUrl || !input.fallbackRpcUrl) {
        throw new CoreError('ExternalBlocked', 'Primary and fallback BSC RPC are required', 503);
      }
      const primary = normalizedRpcUrl(input.primaryRpcUrl);
      const fallback = normalizedRpcUrl(input.fallbackRpcUrl);
      if (primary === fallback) {
        throw new CoreError('ExternalBlocked', 'Payment receipt RPC endpoints must be distinct', 503);
      }
      this.#providers = [rpcProvider(primary, operationTimeoutMs), rpcProvider(fallback, operationTimeoutMs)];
    }
    this.#routerAddress = input.routerAddress.toLowerCase();
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  async observe(candidate: PaymentReceiptCandidate): Promise<PaymentReceiptObservation> {
    let primary: PaymentReceiptObservation;
    try {
      primary = await this.#readProvider(this.#providers[0], candidate);
    } catch (primaryError) {
      const fallback = await this.#readProvider(this.#providers[1], candidate);
      if (fallback.state === 'REORGED' || (fallback.state === 'MINED' && fallback.confirmations >= REQUIRED_CONFIRMATIONS)) {
        throw rpcUnavailable('Primary RPC is unavailable for final payment evidence', primaryError);
      }
      return fallback;
    }
    if (primary.state === 'REORGED') {
      const fallback = await this.#readProvider(this.#providers[1], candidate);
      if (
        fallback.state !== 'REORGED'
        || fallback.canonicalBlockHash.toLowerCase() !== primary.canonicalBlockHash.toLowerCase()
      ) throw new CoreError('ReorgPending', 'BSC RPC sources disagree on payment reorg evidence', 409);
      return primary;
    }
    if (primary.state !== 'MINED' || primary.confirmations < REQUIRED_CONFIRMATIONS) return primary;
    const fallback = await this.#readProvider(this.#providers[1], candidate);
    if (fallback.state !== 'MINED' || fallback.confirmations < REQUIRED_CONFIRMATIONS) {
      throw new CoreError('ReorgPending', 'BSC RPC sources disagree on payment finality', 409);
    }
    if (stableFinalEvidence(primary) !== stableFinalEvidence(fallback)) {
      throw new CoreError('ReorgPending', 'BSC RPC sources disagree on final payment receipt evidence', 409);
    }
    return primary;
  }

  async unresolvedOrderEvidence(input: ExpiredUnresolvedPaymentQuote): Promise<UnresolvedOrderEvidence> {
    if (!isHash(input.orderId) || !Number.isFinite(input.deadline.getTime())) {
      throw new CoreError('InvalidFinality', 'Unresolved payment quote evidence input is invalid');
    }
    const data = USED_ORDER_ID_INTERFACE.encodeFunctionData('usedOrderId', [input.orderId]);
    const heads = await Promise.all(this.#providers.map((provider) => this.#withDeadline(async () => {
      await assertBsc(provider);
      const head = await provider.getBlockNumber();
      if (!Number.isSafeInteger(head) || head < 0) {
        throw new CoreError('ExternalBlocked', 'BSC receipt head is invalid', 503);
      }
      return head;
    })));
    const commonHead = Math.min(...heads);
    const proofBlockNumber = Math.max(0, commonHead - REQUIRED_CONFIRMATIONS + 1);
    const blocks = await Promise.all(this.#providers.map((provider) =>
      this.#withDeadline(() => requiredBlock(provider, proofBlockNumber))));
    if (stableBlockEvidence(blocks[0]!) !== stableBlockEvidence(blocks[1]!)) {
      throw new CoreError('ReorgPending', 'BSC RPC sources disagree on unresolved order proof block', 409);
    }
    const block = receiptBlock(blocks[0]!);
    if (block.timestamp < Math.ceil(input.deadline.getTime() / 1_000)) {
      return { state: 'CHAIN_DEADLINE_PENDING', block };
    }
    const values = await Promise.all(this.#providers.map((provider) => this.#withDeadline(async () => {
      const encoded = await provider.call({ to: this.#routerAddress, data }, proofBlockNumber);
      return Boolean(USED_ORDER_ID_INTERFACE.decodeFunctionResult('usedOrderId', encoded)[0]);
    })));
    if (values[0] !== values[1]) {
      throw new CoreError('ReorgPending', 'BSC RPC sources disagree on Router usedOrderId evidence', 409);
    }
    const verifiedBlocks = await Promise.all(this.#providers.map((provider) =>
      this.#withDeadline(() => requiredBlock(provider, proofBlockNumber))));
    if (verifiedBlocks.some((verified) => stableBlockEvidence(verified) !== stableBlockEvidence(blocks[0]!))) {
      throw new CoreError('ReorgPending', 'Canonical unresolved order proof block changed during verification', 409);
    }
    return { state: values[0] ? 'USED' : 'UNUSED_AFTER_DEADLINE', block };
  }

  async #readProvider(
    provider: PaymentReceiptRpcProvider,
    candidate: PaymentReceiptCandidate,
  ): Promise<PaymentReceiptObservation> {
    return this.#withDeadline(async () => {
      await assertBsc(provider);
      const receipt = await provider.getTransactionReceipt(candidate.txHash);
      if (!receipt) {
        if (candidate.observedBlockNumber !== undefined && candidate.observedBlockHash) {
          const canonical = await requiredBlock(provider, candidate.observedBlockNumber);
          if (canonical.hash!.toLowerCase() !== candidate.observedBlockHash.toLowerCase()) {
            return { state: 'REORGED', canonicalBlockHash: canonical.hash!.toLowerCase() };
          }
        }
        return { state: 'NOT_FOUND' };
      }
      if (
        candidate.observedBlockNumber !== undefined
        && candidate.observedBlockHash
        && (
          receipt.blockNumber !== candidate.observedBlockNumber
          || receipt.blockHash.toLowerCase() !== candidate.observedBlockHash.toLowerCase()
        )
      ) {
        const previousCanonical = await requiredBlock(provider, candidate.observedBlockNumber);
        if (previousCanonical.hash!.toLowerCase() === candidate.observedBlockHash.toLowerCase()) {
          throw new CoreError('ReorgPending', 'Payment receipt moved while its stored block remains canonical', 409);
        }
        return { state: 'REORGED', canonicalBlockHash: previousCanonical.hash!.toLowerCase() };
      }
      const canonical = await requiredBlock(provider, receipt.blockNumber);
      if (canonical.hash!.toLowerCase() !== receipt.blockHash.toLowerCase()) {
        return { state: 'REORGED', canonicalBlockHash: canonical.hash!.toLowerCase() };
      }
      const head = await provider.getBlockNumber();
      if (!Number.isSafeInteger(head) || head < 0) {
        throw new CoreError('ExternalBlocked', 'BSC receipt head is invalid', 503);
      }
      const confirmations = Math.max(0, head - receipt.blockNumber + 1);
      const confirmationBlock = confirmations >= REQUIRED_CONFIRMATIONS
        ? await requiredBlock(provider, receipt.blockNumber + REQUIRED_CONFIRMATIONS - 1)
        : undefined;
      const logs = receipt.logs.map((log) => normalizeReceiptLog(log));
      const paymentLogIndex = logs.find((log) =>
        log.address.toLowerCase() === this.#routerAddress
        && log.topics[0]?.toLowerCase() === PAYMENT_COMPLETED_TOPIC)?.logIndex ?? -1;
      return {
        state: 'MINED',
        chainId: 56,
        transactionHash: receipt.hash.toLowerCase(),
        status: receipt.status ?? -1,
        to: receipt.to?.toLowerCase() ?? null,
        block: {
          number: canonical.number,
          hash: canonical.hash!.toLowerCase(),
          parentHash: canonical.parentHash.toLowerCase(),
          timestamp: canonical.timestamp,
        },
        ...(confirmationBlock ? {
          confirmationBlock: {
            number: confirmationBlock.number,
            hash: confirmationBlock.hash!.toLowerCase(),
            parentHash: confirmationBlock.parentHash.toLowerCase(),
            timestamp: confirmationBlock.timestamp,
          },
        } : {}),
        confirmations,
        logs,
        paymentLogIndex,
      };
    });
  }

  #withDeadline<Result>(operation: () => Promise<Result>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      operation(),
      new Promise<Result>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CoreError(
          'ExternalBlocked',
          'Payment receipt RPC operation timed out',
          503,
          { timeoutMs: this.#operationTimeoutMs },
        )), this.#operationTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

export interface PaymentReceiptRepository {
  pendingReceipts(): Promise<PaymentReceiptCandidate[]>;
  expiredUnresolvedQuotes(now: Date): Promise<ExpiredUnresolvedPaymentQuote[]>;
  recordMined(
    candidate: PaymentReceiptCandidate,
    observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>,
  ): Promise<void>;
  recordFinal(input: FinalPaymentReceipt): Promise<void>;
  recordReorged(candidate: PaymentReceiptCandidate, canonicalBlockHash: string): Promise<void>;
  recordFailed(candidate: PaymentReceiptCandidate, reasonCode: string): Promise<void>;
  recordRecoveryRequired(
    input: ExpiredUnresolvedPaymentQuote,
    evidence: UnresolvedOrderEvidence,
    now: Date,
  ): Promise<void>;
  expireUnresolvedQuote(
    input: ExpiredUnresolvedPaymentQuote,
    evidence: UnresolvedOrderEvidence,
    now: Date,
  ): Promise<void>;
}

export interface PaymentReceiptWorkerStatus {
  healthy: boolean;
  checkedAt?: string;
  errorCode?: string;
}

export class PaymentReceiptWorker {
  readonly #source: PaymentReceiptSource;
  readonly #repository: PaymentReceiptRepository;
  readonly #decoder: AbiEventDecoder;
  readonly #routerAddress: string;
  readonly #clock: () => Date;
  readonly #pollIntervalMs: number;
  #status: PaymentReceiptWorkerStatus = Object.freeze({ healthy: false });
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(input: {
    source: PaymentReceiptSource;
    repository: PaymentReceiptRepository;
    decoder: AbiEventDecoder;
    routerAddress: string;
    clock?: () => Date;
    pollIntervalMs?: number;
  }) {
    if (!isAddress(input.routerAddress)) {
      throw new CoreError('ExternalBlocked', 'PaymentRouter deployment address is unavailable', 503);
    }
    const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new CoreError('InvalidRequest', 'Payment receipt poll interval is invalid');
    }
    this.#source = input.source;
    this.#repository = input.repository;
    this.#decoder = input.decoder;
    this.#routerAddress = input.routerAddress.toLowerCase();
    this.#clock = input.clock ?? (() => new Date());
    this.#pollIntervalMs = pollIntervalMs;
  }

  status() {
    return this.#status;
  }

  async pollOnce() {
    const now = this.#clock();
    const result = {
      checked: 0,
      finalized: 0,
      confirming: 0,
      reorged: 0,
      failed: 0,
      expired: 0,
      recoveryRequired: 0,
    };
    try {
      const candidates = await this.#repository.pendingReceipts();
      result.checked = candidates.length;
      const finalReceipts: FinalPaymentReceipt[] = [];
      for (const candidate of candidates) {
        validateCandidate(candidate);
        const observation = await this.#source.observe(candidate);
        if (observation.state === 'NOT_FOUND') continue;
        if (observation.state === 'REORGED') {
          await this.#repository.recordReorged(candidate, normalizedHash(observation.canonicalBlockHash));
          result.reorged += 1;
          continue;
        }
        if (observation.chainId !== 56) {
          throw new CoreError('ExternalBlocked', 'Payment receipt source is not BSC chain 56', 503);
        }
        const validation = this.#validatedEvents(candidate, observation);
        if (candidate.finalityState === 'FINAL') {
          if (validation.reasonCode) {
            throw new CoreError('ExternalBlocked', 'Final payment receipt evidence changed', 503, {
              reasonCode: validation.reasonCode,
            });
          }
          if (observation.confirmations < REQUIRED_CONFIRMATIONS || !observation.confirmationBlock) {
            throw new CoreError('ReorgPending', 'Final payment receipt lost canonical confirmation depth', 409);
          }
          continue;
        }
        if (validation.reasonCode) {
          await this.#repository.recordFailed(candidate, validation.reasonCode);
          result.failed += 1;
          continue;
        }
        await this.#repository.recordMined(candidate, observation);
        if (observation.confirmations < REQUIRED_CONFIRMATIONS) {
          result.confirming += 1;
          continue;
        }
        if (
          !observation.confirmationBlock
          || observation.confirmationBlock.number !== observation.block.number + REQUIRED_CONFIRMATIONS - 1
        ) {
          throw new CoreError('ExternalBlocked', 'Payment confirmation block evidence is unavailable', 503);
        }
        finalReceipts.push({ candidate, observation, events: validation.events });
      }

      finalReceipts.sort((left, right) =>
        left.observation.block.number - right.observation.block.number
        || left.observation.paymentLogIndex - right.observation.paymentLogIndex
        || left.candidate.orderId.localeCompare(right.candidate.orderId));
      for (const receipt of finalReceipts) {
        try {
          await this.#repository.recordFinal(receipt);
          result.finalized += 1;
        } catch (error) {
          if (error instanceof CoreError && error.code === 'ReorgPending') {
            result.confirming += 1;
            continue;
          }
          if (!(error instanceof CoreError) || !['InvalidFinality', 'InvalidRequest'].includes(error.code)) throw error;
          await this.#repository.recordFailed(receipt.candidate, 'PAYMENT_PROJECTION_REJECTED');
          result.failed += 1;
        }
      }

      for (const quote of await this.#repository.expiredUnresolvedQuotes(now)) {
        if (!isHash(quote.orderId) || !Number.isFinite(quote.deadline.getTime())) {
          throw new CoreError('InvalidFinality', 'Unresolved payment quote identity is invalid');
        }
        const evidence = await this.#source.unresolvedOrderEvidence(quote);
        if (evidence.state === 'CHAIN_DEADLINE_PENDING') continue;
        if (evidence.state === 'USED') {
          await this.#repository.recordRecoveryRequired(quote, evidence, now);
          result.recoveryRequired += 1;
          continue;
        }
        await this.#repository.expireUnresolvedQuote(quote, evidence, now);
        result.expired += 1;
      }
      this.#status = Object.freeze({ healthy: true, checkedAt: now.toISOString() });
      return result;
    } catch (error) {
      this.#status = Object.freeze({
        healthy: false,
        checkedAt: now.toISOString(),
        errorCode: error instanceof CoreError ? error.code : 'ExternalBlocked',
      });
      throw error;
    }
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

  #validatedEvents(
    candidate: PaymentReceiptCandidate,
    observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>,
  ): { events: DecodedDomainEvent[]; reasonCode?: string } {
    if (observation.status !== 1) return { events: [], reasonCode: 'PAYMENT_TRANSACTION_REVERTED' };
    if (observation.to?.toLowerCase() !== this.#routerAddress) {
      return { events: [], reasonCode: 'PAYMENT_ROUTER_MISMATCH' };
    }
    if (observation.transactionHash.toLowerCase() !== candidate.txHash.toLowerCase()) {
      return { events: [], reasonCode: 'PAYMENT_TRANSACTION_HASH_MISMATCH' };
    }
    const orderedLogs = [...observation.logs].sort((left, right) => left.logIndex - right.logIndex);
    if (orderedLogs.some((log) =>
      log.transactionHash.toLowerCase() !== candidate.txHash.toLowerCase()
      || log.blockHash.toLowerCase() !== observation.block.hash.toLowerCase()
      || log.blockNumber !== observation.block.number)) {
      return { events: [], reasonCode: 'PAYMENT_RECEIPT_LOG_IDENTITY_MISMATCH' };
    }
    let decoded: DecodedDomainEvent[];
    try {
      decoded = orderedLogs.flatMap((log) => {
        const event = this.#decoder.decode(log);
        return event ? [event] : [];
      });
    } catch {
      return { events: [], reasonCode: 'PAYMENT_EVENT_INVALID' };
    }
    const payments = decoded.filter((event) => event.contract === 'PaymentRouterV2' && event.eventName === 'PaymentCompleted');
    if (payments.length === 0) return { events: [], reasonCode: 'PAYMENT_EVENT_MISSING' };
    if (payments.length !== 1) return { events: [], reasonCode: 'PAYMENT_EVENT_AMBIGUOUS' };
    const payment = payments[0]!;
    if (
      payment.resourceId.toLowerCase() !== candidate.orderId.toLowerCase()
      || payment.contractAddress.toLowerCase() !== this.#routerAddress
      || payment.logIndex !== observation.paymentLogIndex
    ) return { events: [], reasonCode: 'PAYMENT_EVENT_IDENTITY_MISMATCH' };
    const classification = payment.values.classification;
    if (
      (candidate.quoteKind === 'ORDINARY' && classification !== '0')
      || (candidate.quoteKind === 'SECKILL' && !['1', '2'].includes(classification ?? ''))
    ) return { events: [], reasonCode: 'PAYMENT_CLASSIFICATION_MISMATCH' };

    const relays = decoded.filter((event) => event.contract === 'PaymentRouterV2' && event.eventName === 'SeckillRelayExtended');
    if (classification === '1') {
      if (
        relays.length !== 1
        || relays[0]!.values.orderId?.toLowerCase() !== candidate.orderId.toLowerCase()
        || relays[0]!.logIndex <= payment.logIndex
      ) return { events: [], reasonCode: 'SECKILL_RELAY_EVENT_MISMATCH' };
    } else if (relays.length !== 0) {
      return { events: [], reasonCode: 'UNEXPECTED_SECKILL_RELAY_EVENT' };
    }
    return {
      events: decoded.filter((event) => ['PaymentCompleted', 'SeckillRelayExtended'].includes(event.eventName)),
    };
  }

  async #run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.warn('Payment receipt worker poll failed', {
          code: error instanceof CoreError ? error.code : 'ExternalBlocked',
          message: error instanceof Error ? error.message : 'Unexpected payment receipt failure',
        });
      }
      await abortableDelay(this.#pollIntervalMs, signal);
    }
  }
}

function validateCandidate(candidate: PaymentReceiptCandidate) {
  if (
    !isHash(candidate.orderId)
    || !isHash(candidate.txHash)
    || (candidate.replacementForTxHash !== undefined && !isHash(candidate.replacementForTxHash))
    || (candidate.observedBlockHash !== undefined && !isHash(candidate.observedBlockHash))
    || ((candidate.observedBlockNumber === undefined) !== (candidate.observedBlockHash === undefined))
    || (candidate.observedBlockNumber !== undefined
      && (!Number.isSafeInteger(candidate.observedBlockNumber) || candidate.observedBlockNumber < 0))
    || (candidate.finalityState === 'FINAL' && candidate.observedBlockNumber === undefined)
  ) throw new CoreError('InvalidFinality', 'Pending payment receipt identity is invalid');
}

function normalizedHash(value: string) {
  if (!isHash(value)) throw new CoreError('InvalidFinality', 'Canonical replacement block hash is invalid');
  return value.toLowerCase();
}

function isAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isHash(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
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

function rpcProvider(url: string, timeoutMs: number): PaymentReceiptRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request, 56, { staticNetwork: true }) as unknown as PaymentReceiptRpcProvider;
}

function normalizedRpcUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CoreError('ExternalBlocked', 'Invalid BSC RPC URL', 503);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new CoreError('ExternalBlocked', 'Invalid BSC RPC protocol', 503);
  }
  parsed.hash = '';
  return parsed.toString();
}

async function assertBsc(provider: PaymentReceiptRpcProvider) {
  if ((await provider.getNetwork()).chainId !== 56n) {
    throw new CoreError('ExternalBlocked', 'RPC is not BSC chain 56', 503);
  }
}

async function requiredBlock(provider: PaymentReceiptRpcProvider, blockNumber: number) {
  const block = await provider.getBlock(blockNumber);
  if (
    !block || !block.hash || !isHash(block.hash) || !isHash(block.parentHash)
    || block.number !== blockNumber || !Number.isSafeInteger(block.timestamp)
  ) {
    throw new CoreError('ExternalBlocked', 'Canonical BSC block evidence is unavailable', 503);
  }
  return block;
}

function receiptBlock(block: RpcBlock): ReceiptBlock {
  return {
    number: block.number,
    hash: block.hash!.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    timestamp: block.timestamp,
  };
}

function stableBlockEvidence(block: RpcBlock) {
  return JSON.stringify(receiptBlock(block));
}

function normalizeReceiptLog(log: RpcReceiptLog): IndexedLog {
  const logIndex = log.index ?? log.logIndex;
  if (!Number.isSafeInteger(logIndex) || logIndex! < 0) {
    throw new CoreError('InvalidFinality', 'Payment receipt log index is invalid');
  }
  return {
    address: log.address.toLowerCase(),
    topics: [...log.topics],
    data: log.data,
    transactionHash: log.transactionHash.toLowerCase(),
    blockHash: log.blockHash.toLowerCase(),
    blockNumber: log.blockNumber,
    logIndex: logIndex!,
  };
}

function stableFinalEvidence(observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>) {
  return JSON.stringify({
    chainId: observation.chainId,
    transactionHash: observation.transactionHash.toLowerCase(),
    status: observation.status,
    to: observation.to?.toLowerCase() ?? null,
    block: observation.block,
    confirmationBlock: observation.confirmationBlock,
    logs: observation.logs.map((log) => ({
      address: log.address.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      blockHash: log.blockHash.toLowerCase(),
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
    })),
  });
}

function rpcUnavailable(message: string, error: unknown) {
  if (error instanceof CoreError) return new CoreError(error.code, message, error.status, error.details as Record<string, unknown>);
  return new CoreError('ExternalBlocked', message, 503, {
    reason: error instanceof Error ? error.name : 'UnknownRpcFailure',
  });
}

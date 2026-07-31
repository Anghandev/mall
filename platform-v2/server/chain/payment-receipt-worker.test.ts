import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, type InterfaceAbi } from 'ethers';
import { CoreError } from '../api/errors.ts';
import { AbiEventDecoder, type IndexedLog } from './abi-decoder.ts';
import {
  PaymentReceiptWorker,
  ResilientBscPaymentReceiptSource,
  type ExpiredUnresolvedPaymentQuote,
  type FinalPaymentReceipt,
  type PaymentReceiptCandidate,
  type PaymentReceiptObservation,
  type PaymentReceiptRepository,
  type PaymentReceiptRpcProvider,
  type PaymentReceiptSource,
} from './payment-receipt-worker.ts';

const ROUTER = '0x3333333333333333333333333333333333333333';
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const DEADLINE = new Date('2027-01-15T08:00:00.000Z');
const BUNDLE_PATH = fileURLToPath(
  new URL('../../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);

test('receipt worker finalizes known payments in block and log order only after 15 confirmations', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const paymentInterface = await routerInterface();
  const candidates = [candidate('c'), candidate('a'), candidate('b'), candidate('d')];
  const source = new MemoryReceiptSource(new Map([
    [candidates[0]!.txHash, observation(candidates[0]!, 102, 9, [paymentLog(paymentInterface, candidates[0]!, 102, 9)])],
    [candidates[1]!.txHash, observation(candidates[1]!, 100, 4, [paymentLog(paymentInterface, candidates[1]!, 100, 4)])],
    [candidates[2]!.txHash, observation(candidates[2]!, 101, 2, [paymentLog(paymentInterface, candidates[2]!, 101, 2)])],
    [candidates[3]!.txHash, observation(candidates[3]!, 103, 1, [paymentLog(paymentInterface, candidates[3]!, 103, 1)], 14)],
  ]));
  const repository = new MemoryReceiptRepository(candidates);
  const worker = new PaymentReceiptWorker({ source, repository, decoder, routerAddress: ROUTER });

  assert.deepEqual(await worker.pollOnce(), {
    checked: 4,
    finalized: 3,
    confirming: 1,
    reorged: 0,
    failed: 0,
    expired: 0,
    recoveryRequired: 0,
  });
  assert.deepEqual(repository.finalized.map((item) => item.candidate.orderId), [
    candidates[1]!.orderId,
    candidates[2]!.orderId,
    candidates[0]!.orderId,
  ]);
  assert.deepEqual(repository.mined.map((item) => item.candidate.orderId), candidates.map((item) => item.orderId));
});

test('receipt worker hands PaymentCompleted and SeckillRelayExtended to one atomic finalization in log order', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const paymentInterface = await routerInterface();
  const item = { ...candidate('e'), quoteKind: 'SECKILL' as const };
  const sessionId = hash('f');
  const logs = [
    relayLog(paymentInterface, item, sessionId, 200, 8),
    paymentLog(paymentInterface, item, 200, 3, 1),
  ];
  const repository = new MemoryReceiptRepository([item]);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map([[item.txHash, observation(item, 200, 3, logs)]])),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  await worker.pollOnce();
  assert.equal(repository.finalized.length, 1);
  assert.deepEqual(repository.finalized[0]!.events.map((event) => event.eventName), [
    'PaymentCompleted',
    'SeckillRelayExtended',
  ]);
});

test('receipt worker rejects reverted, wrong-router and missing-payment receipts', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const paymentInterface = await routerInterface();
  const reverted = candidate('1');
  const wrongRouter = candidate('2');
  const missingEvent = candidate('3');
  const source = new MemoryReceiptSource(new Map([
    [reverted.txHash, { ...observation(reverted, 300, 1, [paymentLog(paymentInterface, reverted, 300, 1)]), status: 0 }],
    [wrongRouter.txHash, { ...observation(wrongRouter, 301, 1, [paymentLog(paymentInterface, wrongRouter, 301, 1)]), to: BUYER }],
    [missingEvent.txHash, observation(missingEvent, 302, 1, [])],
  ]));
  const repository = new MemoryReceiptRepository([reverted, wrongRouter, missingEvent]);
  const worker = new PaymentReceiptWorker({ source, repository, decoder, routerAddress: ROUTER });

  const result = await worker.pollOnce();
  assert.equal(result.failed, 3);
  assert.deepEqual(repository.failed.map((item) => item.reasonCode), [
    'PAYMENT_TRANSACTION_REVERTED',
    'PAYMENT_ROUTER_MISMATCH',
    'PAYMENT_EVENT_MISSING',
  ]);
  assert.equal(repository.finalized.length, 0);
});

test('receipt worker fails closed when receipt evidence is not BSC chain 56', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const paymentInterface = await routerInterface();
  const item = candidate('0');
  const wrongChain = {
    ...observation(item, 350, 1, [paymentLog(paymentInterface, item, 350, 1)]),
    chainId: 55,
  };
  const repository = new MemoryReceiptRepository([item]);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map([[item.txHash, wrongChain]])),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  await assert.rejects(worker.pollOnce(), /not BSC chain 56/);
  assert.equal(worker.status().healthy, false);
  assert.equal(repository.finalized.length, 0);
});

test('receipt worker fails closed on RPC timeout even after a recent successful poll', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const item = candidate('1');
  const coldSource = new FlakyReceiptSource();
  coldSource.fail = true;
  const coldWorker = new PaymentReceiptWorker({
    source: coldSource,
    repository: new MemoryReceiptRepository([item]),
    decoder,
    routerAddress: ROUTER,
  });

  await assert.rejects(coldWorker.pollOnce(), /timed out/);
  assert.equal(coldWorker.status().healthy, false);

  const source = new FlakyReceiptSource();
  const worker = new PaymentReceiptWorker({
    source,
    repository: new MemoryReceiptRepository([item]),
    decoder,
    routerAddress: ROUTER,
  });
  await worker.pollOnce();
  assert.equal(worker.status().healthy, true);

  source.fail = true;
  await assert.rejects(worker.pollOnce(), /timed out/);
  assert.equal(worker.status().healthy, false);
});

test('receipt worker records transient RPC failure for already FINAL audit and pauses new payments', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const finalItem: PaymentReceiptCandidate = {
    ...candidate('2'),
    finalityState: 'FINAL',
    observedBlockNumber: 20,
    observedBlockHash: block(20),
  };
  const source = new FlakyReceiptSource();
  source.fail = true;
  const repository = new MemoryReceiptRepository([finalItem]);
  const worker = new PaymentReceiptWorker({
    source,
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  assert.deepEqual(await worker.pollOnce(), {
    checked: 1,
    finalized: 0,
    confirming: 0,
    reorged: 0,
    failed: 0,
    expired: 0,
    recoveryRequired: 0,
  });
  assert.deepEqual(repository.finalAudits, [{ candidate: finalItem, status: 'TRANSIENT_RPC_FAILURE' }]);
  assert.deepEqual(worker.status(), {
    healthy: false,
    checkedAt: worker.status().checkedAt,
    errorCode: 'ExternalBlocked',
  });
});

test('receipt worker cools down already FINAL audit when receipt lookup is unavailable', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const finalItem: PaymentReceiptCandidate = {
    ...candidate('3'),
    finalityState: 'FINAL',
    observedBlockNumber: 20,
    observedBlockHash: block(20),
  };
  const repository = new MemoryReceiptRepository([finalItem]);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map()),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  const result = await worker.pollOnce();
  assert.equal(result.checked, 1);
  assert.deepEqual(repository.finalAudits, [{ candidate: finalItem, status: 'TRANSIENT_RPC_FAILURE' }]);
  assert.deepEqual(worker.status(), {
    healthy: false,
    checkedAt: worker.status().checkedAt,
    errorCode: 'ExternalBlocked',
  });
});

test('receipt worker returns pre-finality reorgs to pending without projecting payment', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const item = candidate('4');
  const repository = new MemoryReceiptRepository([item]);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map([[item.txHash, {
      state: 'REORGED',
      canonicalBlockHash: hash('9'),
    }]])),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  const result = await worker.pollOnce();
  assert.equal(result.reorged, 1);
  assert.deepEqual(repository.reorged, [{ candidate: item, canonicalBlockHash: hash('9') }]);
  assert.equal(repository.finalized.length, 0);
});

test('receipt worker sends a discovered FINAL reorg to durable reconciliation', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const item = {
    ...candidate('f'),
    finalityState: 'FINAL' as const,
    observedBlockNumber: 199,
    observedBlockHash: block(199),
  };
  const repository = new MemoryReceiptRepository([item]);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map([[item.txHash, {
      state: 'REORGED',
      canonicalBlockHash: hash('8'),
    }]])),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  const result = await worker.pollOnce();
  assert.equal(result.reorged, 1);
  assert.deepEqual(repository.reorged, [{ candidate: item, canonicalBlockHash: hash('8') }]);
});

test('receipt worker defers a final relay when its earlier receipt is temporarily unavailable', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const paymentInterface = await routerInterface();
  const predecessor = { ...candidate('d'), quoteKind: 'SECKILL' as const };
  const item = { ...candidate('e'), quoteKind: 'SECKILL' as const };
  const repository = new MemoryReceiptRepository([predecessor, item]);
  repository.finalError = new CoreError('ReorgPending', 'Earlier canonical relay is not projected yet', 409);
  const worker = new PaymentReceiptWorker({
    source: new MemoryReceiptSource(new Map<string, PaymentReceiptObservation>([
      [predecessor.txHash, { state: 'NOT_FOUND' }],
      [item.txHash, observation(item, 250, 1, [
        paymentLog(paymentInterface, item, 250, 1, 1),
        relayLog(paymentInterface, item, hash('c'), 250, 2),
      ])],
    ])),
    repository,
    decoder,
    routerAddress: ROUTER,
  });

  const result = await worker.pollOnce();
  assert.equal(result.checked, 2);
  assert.equal(result.confirming, 1);
  assert.equal(result.failed, 0);
  assert.equal(repository.failed.length, 0);
});

test('expired hashless quotes are released only when both RPC evidence says usedOrderId is false', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const unused = { orderId: hash('5'), deadline: DEADLINE };
  const used = { orderId: hash('6'), deadline: DEADLINE };
  const source = new MemoryReceiptSource(new Map(), new Map([
    [unused.orderId, unresolvedEvidence('UNUSED_AFTER_DEADLINE')],
    [used.orderId, unresolvedEvidence('USED')],
  ]));
  const repository = new MemoryReceiptRepository([], [unused, used]);
  const worker = new PaymentReceiptWorker({ source, repository, decoder, routerAddress: ROUTER });

  assert.deepEqual(await worker.pollOnce(), {
    checked: 0,
    finalized: 0,
    confirming: 0,
    reorged: 0,
    failed: 0,
    expired: 1,
    recoveryRequired: 1,
  });
  assert.deepEqual(repository.expired, [unused.orderId]);
  assert.deepEqual(repository.recoveryRequired, [used.orderId]);
});

test('an expired known hash orphaned before finality also requires usedOrderId=false before release', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: ROUTER });
  const item = { ...candidate('a'), finalityState: 'REORGED' as const };
  const source = new MemoryReceiptSource(
    new Map([[item.txHash, { state: 'NOT_FOUND' }]]),
    new Map([[item.orderId, unresolvedEvidence('UNUSED_AFTER_DEADLINE')]]),
  );
  const repository = new MemoryReceiptRepository([item], [{ orderId: item.orderId, deadline: DEADLINE }]);
  const worker = new PaymentReceiptWorker({ source, repository, decoder, routerAddress: ROUTER });

  const result = await worker.pollOnce();
  assert.equal(result.checked, 1);
  assert.equal(result.expired, 1);
  assert.deepEqual(repository.expired, [item.orderId]);
});

test('receipt source uses the primary RPC normally and cross-checks the fallback only at finality', async () => {
  const item = candidate('7');
  const contract = await routerInterface();
  const primary = receiptProvider(item, contract, 400, 413);
  const fallback = receiptProvider(item, contract, 400, 413);
  const source = new ResilientBscPaymentReceiptSource({
    routerAddress: ROUTER,
    providers: [primary, fallback],
    operationTimeoutMs: 100,
  });

  const pending = await source.observe(item);
  assert.equal(pending.state, 'MINED');
  assert.equal(primary.receiptCalls, 1);
  assert.equal(fallback.receiptCalls, 0);

  primary.head = 414;
  fallback.head = 414;
  const final = await source.observe(item);
  assert.equal(final.state, 'MINED');
  assert.equal(final.state === 'MINED' ? final.confirmations : 0, 15);
  assert.equal(fallback.receiptCalls, 1);
});

test('receipt source fails closed when final RPC evidence disagrees', async () => {
  const item = candidate('8');
  const contract = await routerInterface();
  const primary = receiptProvider(item, contract, 500, 514);
  const fallback = receiptProvider(item, contract, 500, 514);
  fallback.receiptBlockHash = block(501);
  const source = new ResilientBscPaymentReceiptSource({
    routerAddress: ROUTER,
    providers: [primary, fallback],
    operationTimeoutMs: 100,
  });

  await assert.rejects(source.observe(item), (error: unknown) => (
    error instanceof Error && error.message.includes('disagree')
  ));
});

test('receipt source detects a FINAL transaction re-mined in a different canonical block', async () => {
  const contract = await routerInterface();
  const item = {
    ...candidate('c'),
    finalityState: 'FINAL' as const,
    observedBlockNumber: 550,
    observedBlockHash: block(550),
  };
  const primary = receiptProvider(item, contract, 551, 565);
  const fallback = receiptProvider(item, contract, 551, 565);
  const replacementHash = block(1_550);
  primary.blocks.set(550, rpcBlock(550, replacementHash));
  fallback.blocks.set(550, rpcBlock(550, replacementHash));
  const source = new ResilientBscPaymentReceiptSource({
    routerAddress: ROUTER,
    providers: [primary, fallback],
    operationTimeoutMs: 100,
  });

  assert.deepEqual(await source.observe(item), {
    state: 'REORGED',
    canonicalBlockHash: replacementHash,
  });
});

test('receipt source proves a pre-finality reorg and requires matching usedOrderId evidence', async () => {
  const item = {
    ...candidate('9'),
    finalityState: 'MINED' as const,
    observedBlockNumber: 600,
    observedBlockHash: block(600),
  };
  const contract = await routerInterface();
  const primary = receiptProvider(item, contract, 600, 610);
  const fallback = receiptProvider(item, contract, 600, 610);
  primary.receipt = null;
  fallback.receipt = null;
  primary.blocks.set(600, rpcBlock(600, block(601)));
  fallback.blocks.set(600, rpcBlock(600, block(601)));
  const source = new ResilientBscPaymentReceiptSource({
    routerAddress: ROUTER,
    providers: [primary, fallback],
    operationTimeoutMs: 100,
  });

  assert.deepEqual(await source.observe(item), { state: 'REORGED', canonicalBlockHash: block(601) });
  primary.usedOrderIds.set(item.orderId, false);
  fallback.usedOrderIds.set(item.orderId, true);
  primary.blocks.set(596, rpcBlock(596, block(596)));
  fallback.blocks.set(596, rpcBlock(596, block(596)));
  const deadline = new Date((1_800_000_595) * 1_000);
  await assert.rejects(source.unresolvedOrderEvidence({ orderId: item.orderId, deadline }), /disagree/);
});

test('unused order proof waits for a shared canonical block at or after the Router deadline', async () => {
  const item = candidate('b');
  const contract = await routerInterface();
  const primary = receiptProvider(item, contract, 700, 720);
  const fallback = receiptProvider(item, contract, 700, 721);
  const sharedHead = 720;
  const proofBlock = sharedHead - 14;
  const deadline = new Date((1_800_000_900) * 1_000);
  primary.blocks.set(proofBlock, { ...rpcBlock(proofBlock, block(proofBlock)), timestamp: 1_800_000_899 });
  fallback.blocks.set(proofBlock, { ...rpcBlock(proofBlock, block(proofBlock)), timestamp: 1_800_000_899 });
  primary.usedOrderIds.set(item.orderId, false);
  fallback.usedOrderIds.set(item.orderId, false);
  const source = new ResilientBscPaymentReceiptSource({
    routerAddress: ROUTER,
    providers: [primary, fallback],
    operationTimeoutMs: 100,
  });

  assert.equal(
    (await source.unresolvedOrderEvidence({ orderId: item.orderId, deadline })).state,
    'CHAIN_DEADLINE_PENDING',
  );
  primary.blocks.set(proofBlock, { ...rpcBlock(proofBlock, block(proofBlock)), timestamp: 1_800_000_900 });
  fallback.blocks.set(proofBlock, { ...rpcBlock(proofBlock, block(proofBlock)), timestamp: 1_800_000_900 });
  const evidence = await source.unresolvedOrderEvidence({ orderId: item.orderId, deadline });
  assert.equal(evidence.state, 'UNUSED_AFTER_DEADLINE');
  assert.equal(evidence.block.number, proofBlock);
  assert.equal(primary.callBlockTags.at(-1), proofBlock);
  assert.equal(fallback.callBlockTags.at(-1), proofBlock);
});

class MemoryReceiptSource implements PaymentReceiptSource {
  readonly observations: ReadonlyMap<string, PaymentReceiptObservation>;
  readonly unresolved: ReadonlyMap<string, Awaited<ReturnType<PaymentReceiptSource['unresolvedOrderEvidence']>>>;

  constructor(
    observations: ReadonlyMap<string, PaymentReceiptObservation>,
    unresolved: ReadonlyMap<string, Awaited<ReturnType<PaymentReceiptSource['unresolvedOrderEvidence']>>> = new Map(),
  ) {
    this.observations = observations;
    this.unresolved = unresolved;
  }

  observe(candidate: PaymentReceiptCandidate) {
    return Promise.resolve(this.observations.get(candidate.txHash) ?? { state: 'NOT_FOUND' as const });
  }

  unresolvedOrderEvidence(input: ExpiredUnresolvedPaymentQuote) {
    const value = this.unresolved.get(input.orderId);
    if (value === undefined) throw new Error('MissingUsedOrderIdEvidence');
    return Promise.resolve(value);
  }
}

class FlakyReceiptSource implements PaymentReceiptSource {
  fail = false;

  observe() {
    if (this.fail) {
      return Promise.reject(new CoreError('ExternalBlocked', 'Payment receipt RPC operation timed out', 503, {
        timeoutMs: 10_000,
      }));
    }
    return Promise.resolve({ state: 'NOT_FOUND' as const });
  }

  unresolvedOrderEvidence() {
    return Promise.reject(new Error('MissingUsedOrderIdEvidence'));
  }
}

class MemoryRpcProvider implements PaymentReceiptRpcProvider {
  head: number;
  receipt: RpcReceipt | null;
  receiptBlockHash: string;
  receiptCalls = 0;
  readonly callBlockTags: number[] = [];
  readonly blocks = new Map<number, RpcBlock>();
  readonly usedOrderIds = new Map<string, boolean>();

  constructor(receipt: RpcReceipt, head: number) {
    this.receipt = receipt;
    this.receiptBlockHash = receipt.blockHash;
    this.head = head;
    this.blocks.set(receipt.blockNumber, rpcBlock(receipt.blockNumber, receipt.blockHash));
    this.blocks.set(receipt.blockNumber + 14, rpcBlock(receipt.blockNumber + 14, block(receipt.blockNumber + 14)));
  }

  getNetwork() {
    return Promise.resolve({ chainId: 56n });
  }

  getTransactionReceipt() {
    this.receiptCalls += 1;
    return Promise.resolve(this.receipt ? { ...this.receipt, blockHash: this.receiptBlockHash } : null);
  }

  getBlock(blockNumber: number) {
    return Promise.resolve(this.blocks.get(blockNumber) ?? null);
  }

  getBlockNumber() {
    return Promise.resolve(this.head);
  }

  call(input: { data?: string }, blockTag?: number) {
    if (blockTag !== undefined) this.callBlockTags.push(blockTag);
    const orderId = input.data ? `0x${input.data.slice(-64)}` : '';
    const value = this.usedOrderIds.get(orderId);
    if (value === undefined) throw new Error('MissingUsedOrderIdEvidence');
    return Promise.resolve(`0x${(value ? 1n : 0n).toString(16).padStart(64, '0')}`);
  }
}

class MemoryReceiptRepository implements PaymentReceiptRepository {
  readonly mined: Array<{ candidate: PaymentReceiptCandidate; observation: Extract<PaymentReceiptObservation, { state: 'MINED' }> }> = [];
  readonly finalized: FinalPaymentReceipt[] = [];
  readonly reorged: Array<{ candidate: PaymentReceiptCandidate; canonicalBlockHash: string }> = [];
  readonly failed: Array<{ candidate: PaymentReceiptCandidate; reasonCode: string }> = [];
  readonly finalAudits: Array<{
    candidate: PaymentReceiptCandidate;
    status: 'VERIFIED' | 'TRANSIENT_RPC_FAILURE';
  }> = [];
  readonly expired: string[] = [];
  readonly recoveryRequired: string[] = [];
  readonly candidates: PaymentReceiptCandidate[];
  readonly hashless: ExpiredUnresolvedPaymentQuote[];
  finalError: Error | undefined;

  constructor(
    candidates: PaymentReceiptCandidate[],
    hashless: ExpiredUnresolvedPaymentQuote[] = [],
  ) {
    this.candidates = candidates;
    this.hashless = hashless;
  }

  pendingReceipts() {
    return Promise.resolve(this.candidates);
  }

  expiredUnresolvedQuotes() {
    return Promise.resolve(this.hashless);
  }

  recordMined(candidate: PaymentReceiptCandidate, observation: Extract<PaymentReceiptObservation, { state: 'MINED' }>) {
    this.mined.push({ candidate, observation });
    return Promise.resolve();
  }

  recordFinal(input: FinalPaymentReceipt) {
    if (this.finalError) return Promise.reject(this.finalError);
    this.finalized.push(input);
    return Promise.resolve();
  }

  recordFinalAudit(candidate: PaymentReceiptCandidate, status: 'VERIFIED' | 'TRANSIENT_RPC_FAILURE') {
    this.finalAudits.push({ candidate, status });
    return Promise.resolve();
  }

  recordReorged(candidate: PaymentReceiptCandidate, canonicalBlockHash: string) {
    this.reorged.push({ candidate, canonicalBlockHash });
    return Promise.resolve();
  }

  recordFailed(candidate: PaymentReceiptCandidate, reasonCode: string) {
    this.failed.push({ candidate, reasonCode });
    return Promise.resolve();
  }

  recordRecoveryRequired(input: ExpiredUnresolvedPaymentQuote) {
    this.recoveryRequired.push(input.orderId);
    return Promise.resolve();
  }

  expireUnresolvedQuote(input: ExpiredUnresolvedPaymentQuote) {
    this.expired.push(input.orderId);
    return Promise.resolve();
  }
}

function unresolvedEvidence(state: 'USED' | 'UNUSED_AFTER_DEADLINE' | 'CHAIN_DEADLINE_PENDING') {
  return {
    state,
    block: {
      number: 1,
      hash: block(1),
      parentHash: block(0),
      timestamp: Math.floor(DEADLINE.getTime() / 1_000),
    },
  } as const;
}

async function routerInterface() {
  const bundle = (await import(BUNDLE_PATH, { with: { type: 'json' } })).default as {
    contracts: { PaymentRouterV2: InterfaceAbi };
  };
  return new Interface(bundle.contracts.PaymentRouterV2);
}

function candidate(value: string): PaymentReceiptCandidate {
  return {
    orderId: hash(value),
    quoteKind: 'ORDINARY',
    txHash: hash(value.padStart(2, '0')),
    finalityState: 'SUBMITTED',
  };
}

function observation(
  item: PaymentReceiptCandidate,
  blockNumber: number,
  paymentLogIndex: number,
  logs: IndexedLog[],
  confirmations = 15,
): Extract<PaymentReceiptObservation, { state: 'MINED' }> {
  const blockHash = block(blockNumber);
  return {
    state: 'MINED',
    chainId: 56,
    transactionHash: item.txHash,
    status: 1,
    to: ROUTER,
    block: {
      number: blockNumber,
      hash: blockHash,
      parentHash: block(blockNumber - 1),
      timestamp: 1_800_000_000 + blockNumber,
    },
    confirmations,
    ...(confirmations >= 15
      ? { confirmationBlock: {
          number: blockNumber + 14,
          hash: block(blockNumber + 14),
          parentHash: block(blockNumber + 13),
          timestamp: 1_800_000_014 + blockNumber,
        } }
      : {}),
    logs,
    paymentLogIndex,
  };
}

function paymentLog(
  contract: Interface,
  item: PaymentReceiptCandidate,
  blockNumber: number,
  logIndex: number,
  classification = 0,
): IndexedLog {
  const event = contract.getEvent('PaymentCompleted');
  if (!event) throw new Error('MissingPaymentCompletedAbi');
  const encoded = contract.encodeEventLog(event, [
    item.orderId, BUYER, MERCHANT, classification, 1, 100, 70, 1, 69, 0, 70, 300, 200, 100, 100,
    hash('7'), hash('8'),
  ]);
  return {
    address: ROUTER,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: item.txHash,
    blockHash: block(blockNumber),
    blockNumber,
    logIndex,
  };
}

function relayLog(
  contract: Interface,
  item: PaymentReceiptCandidate,
  sessionId: string,
  blockNumber: number,
  logIndex: number,
): IndexedLog {
  const event = contract.getEvent('SeckillRelayExtended');
  if (!event) throw new Error('MissingSeckillRelayExtendedAbi');
  const encoded = contract.encodeEventLog(event, [sessionId, item.orderId, 1_800_001_000]);
  return {
    address: ROUTER,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: item.txHash,
    blockHash: block(blockNumber),
    blockNumber,
    logIndex,
  };
}

function hash(value: string) {
  const normalized = value.replace(/^0x/, '').slice(-1);
  return `0x${normalized.repeat(64)}`;
}

function block(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

interface RpcReceipt {
  hash: string;
  to: string;
  status: number;
  blockNumber: number;
  blockHash: string;
  logs: IndexedLog[];
}

interface RpcBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

function receiptProvider(item: PaymentReceiptCandidate, contract: Interface, blockNumber: number, head: number) {
  return new MemoryRpcProvider({
    hash: item.txHash,
    to: ROUTER,
    status: 1,
    blockNumber,
    blockHash: block(blockNumber),
    logs: [paymentLog(contract, item, blockNumber, 1)],
  }, head);
}

function rpcBlock(number: number, hashValue: string): RpcBlock {
  return { number, hash: hashValue, parentHash: block(number - 1), timestamp: 1_800_000_000 + number };
}

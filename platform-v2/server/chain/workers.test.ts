import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AbiCoder, Interface, Wallet, keccak256, type InterfaceAbi, type JsonRpcProvider } from 'ethers';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import {
  paymentAllocationSetHash,
  paymentBeneficiarySetHash,
  type PaymentPolicySnapshot,
} from '../api/payment-policy.ts';
import { AbiEventDecoder, type DecodedDomainEvent, type IndexedLog } from './abi-decoder.ts';
import { BnmAvailabilityWorker, HttpBnmAvailabilityAdapter } from './bnm-availability-worker.ts';
import { FulfillmentSchedulerWorker } from './fulfillment-scheduler-worker.ts';
import { ResilientBscGuaranteeDepositSource } from './guarantee-deposit-worker.ts';
import type { GuaranteeDepositFinalityItem } from '../data/guarantee-deposit-service.ts';
import { RemoteExecutorClient } from './executor.ts';
import {
  RpcBeneficiarySnapshotSource,
  ResilientBscContractReader,
  RpcPaymentNplQuoteSource,
  RpcPaymentPolicyAttestationSource,
  PAYMENT_POLICY_TUPLE_ABI,
  type ContractReader,
} from './payment-sources.ts';
import {
  ChainIndexer,
  type CanonicalCheckpoint,
  type ChainBlock,
  type IndexedChainBlock,
  type IndexerStore,
} from './indexer.ts';
import {
  PollingPaymentIndexer,
  ResilientBscPaymentChainSource,
  type PaymentChainSource,
} from './payment-indexer-worker.ts';
import { readAddressLogs } from './rpc-logs.ts';
import {
  PaymentRuntimeReadinessMonitor,
  RpcPaymentRuntimeAttestor,
  type RuntimeCodeReader,
} from './runtime-readiness.ts';
import { scheduleFulfillmentJobs } from './scheduler.ts';
import { RemoteSignerClient } from './signer.ts';
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';
import { LogisticsPrintWorker } from './logistics-print-worker.ts';
import { HttpEoaSettlementBroadcaster, ResilientBscEoaSettlementChainSource } from './eoa-settlement-adapters.ts';
import { ResilientBscCoverageSource } from './coverage-source.ts';
import { deterministicEoaSettlementExecutorErrorCodes } from './settlement-worker.ts';

const CONTRACT = '0x3333333333333333333333333333333333333333';
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const ORDER_ID = `0x${'a'.repeat(64)}`;
const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
const EXECUTOR_INTERFACE = new Interface(['function settle(bytes32 resourceId,uint64 policyVersion,uint256 amount)']);
const ALLOWED_CALLDATA = EXECUTOR_INTERFACE.encodeFunctionData('settle', [ORDER_ID, 1, 25]);
const BUNDLE_PATH = fileURLToPath(
  new URL('../../../packages/core-artifacts/contracts/abi-bundle.json', import.meta.url),
);

test('RPC log reader falls back to block receipts without widening the address filter', async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let activeReceipts = 0;
  let maxConcurrentReceipts = 0;
  const provider = {
    getLogs: async () => { throw new Error('limit exceeded'); },
    send: async (method: string, params: unknown[]) => {
      activeReceipts += 1;
      maxConcurrentReceipts = Math.max(maxConcurrentReceipts, activeReceipts);
      calls.push({ method, params });
      const blockNumber = Number(BigInt(String(params[0])));
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReceipts -= 1;
      return [{ logs: [
        rpcReceiptLog({ address: CONTRACT, blockNumber, logIndex: 2 }),
        rpcReceiptLog({ address: BUYER, blockNumber, logIndex: 3 }),
        rpcReceiptLog({ address: CONTRACT, blockNumber, logIndex: 4, topic0: HASH_2 }),
      ] }];
    },
  };
  const logs = await readAddressLogs(provider as Parameters<typeof readAddressLogs>[0], {
    addresses: CONTRACT,
    fromBlock: 100,
    toBlock: 101,
    topic0: HASH_1,
  });
  assert.deepEqual(logs.map((log) => [log.address, log.blockNumber, log.logIndex]), [
    [CONTRACT, 100, 2],
    [CONTRACT, 101, 2],
  ]);
  assert.equal(maxConcurrentReceipts, 1);
  assert.deepEqual(calls, [
    { method: 'eth_getBlockReceipts', params: ['0x64'] },
    { method: 'eth_getBlockReceipts', params: ['0x65'] },
  ]);
});

test('coverage evidence uses the lower common RPC height for every balance', async () => {
  const calls: Array<{ provider: string; blockTag: unknown }> = [];
  const provider = (name: string, head: number) => ({
    getNetwork: async () => ({ chainId: 56n }),
    getBlock: async (tag: string | number) => {
      if (tag === 'latest') return { number: head, hash: head === 123 ? HASH_1 : HASH_2 };
      assert.equal(tag, 123);
      return { number: 123, hash: HASH_1 };
    },
    call: async (transaction: Record<string, unknown>) => {
      calls.push({ provider: name, blockTag: transaction.blockTag });
      return AbiCoder.defaultAbiCoder().encode(['uint256'], [100n]);
    },
  });
  const source = new ResilientBscCoverageSource({
    providers: [
      provider('primary', 124) as unknown as JsonRpcProvider,
      provider('fallback', 123) as unknown as JsonRpcProvider,
    ],
    assets: [{ walletAddress: BUYER, asset: 'USDT', tokenAddress: USDT_ADDRESS }],
  });

  const observation = await source.observe();

  assert.equal(observation.blockNumber, 123);
  assert.equal(observation.assets[0]?.balance, '100');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [
    { provider: 'primary', blockTag: 123 },
    { provider: 'fallback', blockTag: 123 },
  ]);
});

test('logistics print worker serializes polling and waits for the active dispatch on stop', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const worker = new LogisticsPrintWorker({
    intervalMs: 5,
    dispatcher: {
      dispatchNextPrintJob: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve(undefined);
        return new Promise<void>((resolve) => { release = resolve; });
      },
    },
  });
  const first = worker.pollOnce();
  assert.equal(worker.pollOnce(), first);
  assert.equal(calls, 1);
  worker.start();
  const stopping = worker.stop();
  assert.ok(release);
  release();
  await stopping;
  assert.equal(calls, 1);
  await worker.pollOnce();
  assert.equal(calls, 2);
});

test('EOA settlement HTTP broadcaster only treats allowlisted 4xx codes as deterministic', async () => {
  const envelope = {
    chainId: 56 as const,
    transferId: HASH_1,
    executorWallet: BUYER,
    executorNonce: '1',
    tokenAddress: CONTRACT,
    requestId: HASH_2,
    requestItemIndex: 0,
    orderId: ORDER_ID,
    accountId: 'settlement-account',
    backingWalletAddress: BUYER,
    recipientAddress: MERCHANT,
    amount: '25',
    transferCalldata: ALLOWED_CALLDATA,
    contentHash: HASH_2,
    gasLimit: '100000',
    requestDigest: HASH_3,
    idempotencyKey: 'settlement-attempt:test:1',
    authorization: {
      requestId: HASH_2,
      selectedItemIndex: 0,
      intent: {
        intentId: HASH_1,
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet: MERCHANT,
        recipient: MERCHANT,
        rail: 'MERCHANT_USDT' as const,
        asset: CONTRACT,
        executorWallet: BUYER,
        amount: '25',
        itemsHash: HASH_3,
        nonce: '1',
        deadline: 1,
      },
      signature: '0x12',
      items: [{
        itemIndex: 0,
        orderId: ORDER_ID,
        accountId: 'settlement-account',
        backingWalletAddress: BUYER,
        amount: '25',
        itemHash: HASH_1,
      }],
    },
  };
  for (const executorErrorCode of deterministicEoaSettlementExecutorErrorCodes) {
    const deterministic = new HttpEoaSettlementBroadcaster({
      url: 'http://127.0.0.1:8790/settlement',
      token: 'token',
      maxGasLimit: 100000n,
      fetch: (async () => new Response(JSON.stringify({ error: { code: executorErrorCode } }), { status: 400 })) as typeof fetch,
    });
    await assert.rejects(
      deterministic.submit(envelope),
      (error: unknown) => error instanceof CoreError
        && error.code === 'InvalidRequest'
        && error.details.deterministicExecutorFailure === true
        && error.details.executorErrorCode === executorErrorCode,
    );
  }

  const nonceMismatch = new HttpEoaSettlementBroadcaster({
    url: 'http://127.0.0.1:8790/settlement',
    token: 'token',
    maxGasLimit: 100000n,
    fetch: (async () => new Response(JSON.stringify({
      error: { code: 'NONCE_MISMATCH', details: { relation: 'RPC_DIVERGENCE' } },
    }), { status: 409 })) as typeof fetch,
  });
  await assert.rejects(
    nonceMismatch.submit(envelope),
    (error: unknown) => error instanceof CoreError
      && error.code === 'ExternalBlocked'
      && error.details.deterministicExecutorFailure === false,
  );

  const ambiguous = new HttpEoaSettlementBroadcaster({
    url: 'http://127.0.0.1:8790/settlement',
    token: 'token',
    maxGasLimit: 100000n,
    fetch: (async () => new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }), { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    ambiguous.submit(envelope),
    (error: unknown) => error instanceof CoreError
      && error.code === 'ExternalBlocked'
      && error.details.deterministicExecutorFailure === false,
  );

  const timedOut = new HttpEoaSettlementBroadcaster({
    url: 'http://127.0.0.1:8790/settlement',
    token: 'token',
    maxGasLimit: 100000n,
    requestTimeoutMs: 100,
    fetch: ((_: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch,
  });
  await assert.rejects(
    timedOut.submit(envelope),
    (error: unknown) => error instanceof CoreError
      && error.code === 'ExternalBlocked'
      && error.details.deterministicExecutorFailure === false
      && error.details.failure === 'TIMEOUT',
  );
});

test('EOA settlement receipt evidence uses only the finalized transaction receipt, not Archive RPC calls', async () => {
  const transfer = new Interface(['function transfer(address to,uint256 amount)']);
  const transferEvent = new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']).getEvent('Transfer')!;
  const calldata = transfer.encodeFunctionData('transfer', [MERCHANT, 25n]);
  const blockHash = `0x${'b'.repeat(64)}`;
  const log = new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)'])
    .encodeEventLog(transferEvent, [BUYER, MERCHANT, 25n]);
  const rpcCalls: string[] = [];
  const provider = {
    send: async (method: string) => {
      rpcCalls.push(method);
      if (method === 'eth_chainId') return '0x38';
      throw new Error(`UnexpectedSettlementRpcMethod:${method}`);
    },
    getTransaction: async () => ({ to: USDT_ADDRESS, data: calldata, from: BUYER, nonce: 7 }),
    getTransactionReceipt: async () => ({
      status: 1,
      blockNumber: 100,
      blockHash,
      logs: [{ address: USDT_ADDRESS, topics: log.topics, data: log.data }],
    }),
    getBlockNumber: async () => 114,
    getBlock: async () => ({ hash: blockHash }),
  } as unknown as JsonRpcProvider;
  const source = new ResilientBscEoaSettlementChainSource({ providers: [provider, provider] });

  const receipt = await source.receipt(HASH_1);

  assert.ok(receipt);
  assert.deepEqual(receipt.transfers, [{
    tokenAddress: USDT_ADDRESS,
    from: BUYER,
    to: MERCHANT,
    amount: '25',
  }]);
  assert.deepEqual(receipt.transactionDeltas, [{
    tokenAddress: USDT_ADDRESS,
    account: BUYER,
    delta: '-25',
  }, {
    tokenAddress: USDT_ADDRESS,
    account: MERCHANT,
    delta: '25',
  }]);
  assert.deepEqual(rpcCalls, ['eth_chainId', 'eth_chainId']);
});

test('Indexer decodes the frozen ABI, is idempotent and fails closed on reorg', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: CONTRACT });
  const bundle = (await import(BUNDLE_PATH, { with: { type: 'json' } })).default as {
    contracts: { PaymentRouterV2: InterfaceAbi };
  };
  const contractInterface = new Interface(bundle.contracts.PaymentRouterV2);
  const event = contractInterface.getEvent('PaymentCompleted');
  assert.ok(event);
  const encoded = contractInterface.encodeEventLog(event, [
    ORDER_ID,
    BUYER,
    MERCHANT,
    1,
    1,
    100,
    70,
    1,
    69,
    0,
    70,
    300,
    200,
    100,
    100,
    HASH_2,
    HASH_3,
  ]);
  const store = new MemoryIndexerStore();
  const indexer = new ChainIndexer(decoder, store);
  const block: ChainBlock = { number: 100, hash: HASH_1, parentHash: HASH_2, timestamp: 1_800_000_000 };
  const result = await indexer.ingest(block, [
    {
      address: CONTRACT,
      topics: encoded.topics,
      data: encoded.data,
      transactionHash: HASH_3,
      blockHash: block.hash,
      blockNumber: block.number,
      logIndex: 0,
    },
  ]);
  assert.deepEqual(result, { status: 'COMMITTED', events: 1 });
  assert.equal(store.events[0]?.artifactVersion, CORE_ARTIFACT_VERSION);
  assert.equal(store.events[0]?.contract, 'PaymentRouterV2');
  assert.equal(store.events[0]?.eventName, 'PaymentCompleted');
  assert.equal(store.events[0]?.resourceId, ORDER_ID);
  assert.equal(store.events[0]?.contractAddress, CONTRACT);
  assert.equal(store.events[0]?.eventHash, encoded.topics[0]);
  assert.equal(store.events[0]?.values.classification, '1');
  assert.equal(store.events[0]?.values.productUsdtPaid, '70');
  assert.equal(store.events[0]?.values.platformServiceFeeUsdt, '1');
  assert.equal(store.events[0]?.values.custodyProductUsdt, '69');
  assert.equal(store.events[0]?.values.freightUsdt, '0');
  assert.equal(store.events[0]?.values.usdtPaid, '70');
  assert.equal(store.events[0]?.values.nplPaid, '300');
  assert.deepEqual(await indexer.ingest(block, []), { status: 'IDEMPOTENT', events: 0 });

  const block101: ChainBlock = { number: 101, hash: HASH_2, parentHash: HASH_1, timestamp: 1_800_000_001 };
  const block102: ChainBlock = { number: 102, hash: HASH_3, parentHash: HASH_2, timestamp: 1_800_000_002 };
  assert.deepEqual(await indexer.ingestSegment([{ block: block101, logs: [] }, { block: block102, logs: [] }]), {
    status: 'COMMITTED',
    events: 0,
  });
  assert.deepEqual(await indexer.ingest(block101, []), { status: 'IDEMPOTENT', events: 0 });
  assert.equal(store.reorgs.length, 0);

  const replacement101: ChainBlock = {
    number: 101,
    hash: `0x${'5'.repeat(64)}`,
    parentHash: HASH_1,
    timestamp: 1_800_000_003,
  };
  const replacement102: ChainBlock = {
    number: 102,
    hash: `0x${'6'.repeat(64)}`,
    parentHash: replacement101.hash,
    timestamp: 1_800_000_004,
  };
  assert.deepEqual(
    await indexer.ingestSegment([{ block: replacement101, logs: [] }, { block: replacement102, logs: [] }]),
    { status: 'REORG_COMMITTED', events: 0 },
  );
  assert.deepEqual(await store.checkpoint(), { blockNumber: 102, blockHash: replacement102.hash });

  await assert.rejects(
    indexer.ingest({ number: 102, hash: `0x${'7'.repeat(64)}`, parentHash: `0x${'4'.repeat(64)}`, timestamp: 1_800_000_005 }, []),
    /common ancestor/,
  );
  assert.equal(store.reorgs.length, 1);
});

test('polling payment worker persists empty blocks, recovers a common-ancestor reorg and awaits shutdown', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: CONTRACT });
  const bundle = (await import(BUNDLE_PATH, { with: { type: 'json' } })).default as {
    contracts: { PaymentRouterV2: InterfaceAbi };
  };
  const contractInterface = new Interface(bundle.contracts.PaymentRouterV2);
  const paymentEvent = contractInterface.getEvent('PaymentCompleted');
  assert.ok(paymentEvent);
  const encoded = contractInterface.encodeEventLog(paymentEvent, [
    ORDER_ID, BUYER, MERCHANT, 0, 1, 100, 70, 1, 69, 0, 70, 300, 200, 100, 100, HASH_2, HASH_3,
  ]);
  const block99: ChainBlock = { number: 99, hash: blockHash(99), parentHash: blockHash(98), timestamp: 1_800_000_000 };
  const block100: ChainBlock = { number: 100, hash: blockHash(100), parentHash: block99.hash, timestamp: 1_800_000_001 };
  const block101: ChainBlock = { number: 101, hash: blockHash(101), parentHash: block100.hash, timestamp: 1_800_000_002 };
  const source = new MemoryPaymentChainSource([block99, block100, block101], [{
    address: CONTRACT,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: HASH_3,
    blockHash: block100.hash,
    blockNumber: block100.number,
    logIndex: 0,
  }], 5);
  const store = new MemoryIndexerStore();
  const worker = new PollingPaymentIndexer({
    source,
    indexer: new ChainIndexer(decoder, store),
    store,
    deploymentBlock: 100,
    pollIntervalMs: 10,
  });

  assert.deepEqual(await worker.pollOnce(), {
    progressed: true,
    caughtUp: true,
    observedHead: 101,
    lastIndexedBlock: 101,
  });
  assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: block101.hash });
  assert.deepEqual(source.logRanges, [[100, 101]]);
  assert.ok(source.maxConcurrentBlockReads > 1);
  assert.equal(store.events.length, 1);

  const mismatched102: ChainBlock = {
    number: 102,
    hash: blockHash(102),
    parentHash: block101.hash,
    timestamp: 1_800_000_003,
  };
  source.replace([mismatched102], [{
    address: CONTRACT,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: HASH_3,
    blockHash: blockHash(9_999),
    blockNumber: mismatched102.number,
    logIndex: 0,
  }]);
  await assert.rejects(worker.pollOnce(), /does not belong to the fetched canonical block batch/);
  assert.deepEqual(await store.checkpoint(), { blockNumber: 101, blockHash: block101.hash });

  const replacement101: ChainBlock = {
    number: 101,
    hash: blockHash(1_101),
    parentHash: block100.hash,
    timestamp: 1_800_000_003,
  };
  const replacement102: ChainBlock = {
    number: 102,
    hash: blockHash(1_102),
    parentHash: replacement101.hash,
    timestamp: 1_800_000_004,
  };
  source.replace([replacement101, replacement102], []);
  assert.deepEqual(await worker.pollOnce(), {
    progressed: true,
    caughtUp: true,
    observedHead: 102,
    lastIndexedBlock: 102,
  });
  assert.deepEqual(await store.checkpoint(), { blockNumber: 102, blockHash: replacement102.hash });
  assert.equal(store.blocks.get(101)?.block.hash, replacement101.hash);

  source.truncate(101);
  await assert.rejects(worker.pollOnce(), /behind the persisted Indexer checkpoint/);
  assert.deepEqual(await store.checkpoint(), { blockNumber: 102, blockHash: replacement102.hash });
  source.replace([replacement102], []);

  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker.stop();
  assert.deepEqual(worker.status(), {
    healthy: true,
    caughtUp: true,
    checkedAt: worker.status().checkedAt,
    lastIndexedBlock: 102,
    observedHead: 102,
  });
});

test('polling payment worker keeps recent healthy status through transient RPC transport failures', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: CONTRACT });
  const block99: ChainBlock = { number: 99, hash: blockHash(99), parentHash: blockHash(98), timestamp: 1_800_000_000 };
  const store = new MemoryIndexerStore();
  let failHead = false;
  const source: PaymentChainSource = {
    head: async () => {
      if (failHead) throw new Error('transient RPC transport failure');
      return 99;
    },
    block: async (blockNumber: number) => {
      if (blockNumber !== 99) throw new Error(`unexpected block ${blockNumber}`);
      return block99;
    },
    logs: async () => [],
  };
  const worker = new PollingPaymentIndexer({
    source,
    indexer: new ChainIndexer(decoder, store),
    store,
    deploymentBlock: 100,
    pollIntervalMs: 10,
    transientFailureGraceMs: 100,
  });

  await worker.pollOnce();
  assert.equal(worker.status().healthy, true);
  failHead = true;
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await worker.stop();
  assert.equal(worker.status().healthy, true);

  const strictWorker = new PollingPaymentIndexer({
    source,
    indexer: new ChainIndexer(decoder, new MemoryIndexerStore()),
    store: new MemoryIndexerStore(),
    deploymentBlock: 100,
    pollIntervalMs: 10,
    transientFailureGraceMs: 0,
  });
  strictWorker.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await strictWorker.stop();
  assert.equal(strictWorker.status().healthy, false);
});

test('polling payment worker fetches catch-up block batches with bounded concurrency', async () => {
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentRouterV2: CONTRACT });
  const blocks = Array.from({ length: 17 }, (_, index) => ({
    number: 99 + index,
    hash: blockHash(99 + index),
    parentHash: blockHash(98 + index),
    timestamp: 1_800_000_000 + index,
  }));
  const source = new MemoryPaymentChainSource(blocks, [], 10);
  const store = new MemoryIndexerStore();
  const worker = new PollingPaymentIndexer({
    source,
    indexer: new ChainIndexer(decoder, store),
    store,
    deploymentBlock: 100,
    batchSize: 16,
  });

  assert.deepEqual(await worker.pollOnce(), {
    progressed: true,
    caughtUp: true,
    observedHead: 115,
    lastIndexedBlock: 114,
  });
  assert.ok(source.maxConcurrentBlockReads > 1);
});

test('resilient payment chain source cross-checks two RPC endpoints at the lower head', async () => {
  assert.throws(
    () => new ResilientBscPaymentChainSource({
      primaryRpcUrl: 'https://bsc.example.invalid',
      fallbackRpcUrl: 'https://bsc.example.invalid/',
      routerAddress: CONTRACT,
    }),
    /distinct BSC RPC endpoints/,
  );
  const block100: ChainBlock = { number: 100, hash: blockHash(100), parentHash: blockHash(99), timestamp: 1_800_000_000 };
  const log = {
    address: CONTRACT,
    topics: [HASH_1],
    data: '0x1234',
    transactionHash: HASH_2,
    blockHash: block100.hash,
    blockNumber: 100,
    index: 0,
  };
  const source = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 102, blocks: [block100], logs: [log] }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [log] }),
    ],
    stableBlockLag: 0,
  });
  assert.equal(await source.head(), 100);
  assert.deepEqual(await source.block(100), block100);
  assert.deepEqual(await source.logs(100, 100), [{
    address: CONTRACT.toLowerCase(),
    topics: [HASH_1],
    data: '0x1234',
    transactionHash: HASH_2,
    blockHash: block100.hash,
    blockNumber: 100,
    logIndex: 0,
  }]);

  const failing = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [] }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [], failHead: true }),
    ],
  });
  assert.equal(await failing.head(), 95);

  const failingBlock = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [] }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [], failBlock: true }),
    ],
  });
  assert.deepEqual(await failingBlock.block(100), block100);

  const failingLogs = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [] }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [], failLogs: true }),
    ],
  });
  assert.deepEqual(await failingLogs.logs(100, 100), []);

  const allUnavailable = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [], failHead: true }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [], failHead: true }),
    ],
  });
  await assert.rejects(allUnavailable.head(), /BSC RPC provider failed/);

  const divergentBlock = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [] }),
      paymentRpcProvider({
        head: 100,
        blocks: [{ ...block100, parentHash: blockHash(88) }],
        logs: [],
      }),
    ],
  });
  await assert.rejects(divergentBlock.block(100), /payment block evidence/);

  const divergentLogs = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [log] }),
      paymentRpcProvider({ head: 100, blocks: [block100], logs: [{ ...log, data: '0x5678' }] }),
    ],
  });
  await assert.rejects(divergentLogs.logs(100, 100), /payment Router logs/);
});

test('resilient payment chain source stays behind newest BSC RPC head flaps', async () => {
  const stableBlock: ChainBlock = { number: 100, hash: blockHash(100), parentHash: blockHash(99), timestamp: 1_800_000_000 };
  const unstableBlock: ChainBlock = { number: 105, hash: blockHash(105), parentHash: blockHash(104), timestamp: 1_800_000_015 };
  const divergentUnstableBlock: ChainBlock = {
    ...unstableBlock,
    hash: blockHash(106),
    parentHash: blockHash(88),
  };
  const source = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: 105, blocks: [stableBlock, unstableBlock], logs: [] }),
      paymentRpcProvider({ head: 105, blocks: [stableBlock, divergentUnstableBlock], logs: [] }),
    ],
  });

  assert.equal(await source.head(), 100);
  assert.deepEqual(await source.block(await source.head()), stableBlock);
  await assert.rejects(source.block(105), /payment block evidence/);
});

test('resilient payment chain source does not move its safe head backward on RPC jitter', async () => {
  let head = 105;
  const stableBlock: ChainBlock = { number: 100, hash: blockHash(100), parentHash: blockHash(99), timestamp: 1_800_000_000 };
  const source = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({ head: () => head, blocks: [stableBlock], logs: [] }),
      paymentRpcProvider({ head: () => head, blocks: [stableBlock], logs: [] }),
    ],
  });

  assert.equal(await source.head(), 100);
  head = 104;
  assert.equal(await source.head(), 100);
});

test('resilient payment chain source retries transient BSC RPC provider failures', async () => {
  const block100: ChainBlock = { number: 100, hash: blockHash(100), parentHash: blockHash(99), timestamp: 1_800_000_000 };
  let primaryHeadFailures = 1;
  let fallbackBlockFailures = 1;
  const source = new ResilientBscPaymentChainSource({
    routerAddress: CONTRACT,
    providers: [
      paymentRpcProvider({
        head: 105,
        blocks: [block100],
        logs: [],
        failHead: () => primaryHeadFailures-- > 0,
      }),
      paymentRpcProvider({
        head: 105,
        blocks: [block100],
        logs: [],
        failBlock: () => fallbackBlockFailures-- > 0,
      }),
    ],
  });

  assert.equal(await source.head(), 100);
  assert.deepEqual(await source.block(100), block100);
});

test('remote signer validates the recovered signer and never accepts an arbitrary signature', async () => {
  const wallet = Wallet.createRandom();
  const digest = HASH_1;
  const signature = wallet.signingKey.sign(digest).serialized;
  const signer = new RemoteSignerClient({
    url: 'https://signer.example.invalid',
    token: 'test-signer-service-token',
    expectedSigner: wallet.address,
    fetch: async (_url, init) => init?.method === 'GET'
      ? new Response(JSON.stringify({ status: 'READY', signer: wallet.address }), { status: 200 })
      : new Response(JSON.stringify({ signature }), { status: 200 }),
  });
  const result = await signer.sign({
    purpose: 'ORDER_QUOTE',
    digest,
    resourceId: ORDER_ID,
    policyVersion: 1,
    deadline: Math.floor(Date.now() / 1000) + 60,
    idempotencyKey: 'sign-order-1',
  });
  assert.equal(result.signer, wallet.address.toLowerCase());
  assert.equal(await signer.health(), true);

  const other = Wallet.createRandom();
  const invalid = new RemoteSignerClient({
    url: 'https://signer.example.invalid',
    token: 'test-signer-service-token',
    expectedSigner: other.address,
    fetch: async () => new Response(JSON.stringify({ signature }), { status: 200 }),
  });
  await assert.rejects(
    invalid.sign({
      purpose: 'ORDER_QUOTE',
      digest,
      resourceId: ORDER_ID,
      policyVersion: 1,
      deadline: Math.floor(Date.now() / 1000) + 60,
      idempotencyKey: 'sign-order-2',
    }),
    /Unexpected remote signer/,
  );
});

test('remote executor enforces chain, zero native value, gas cap and replacement evidence', async () => {
  const executor = new RemoteExecutorClient({
    url: 'https://executor.example.invalid',
    token: 'test-executor-service-token',
    maxGasLimit: 1_000_000n,
    deployment: executorDeployment(),
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { replacementForTxHash?: string };
      return new Response(
        JSON.stringify({ txHash: HASH_3, ...(request.replacementForTxHash ? { replacementForTxHash: request.replacementForTxHash } : {}) }),
        { status: 200 },
      );
    },
  });
  const result = await executor.execute({
    chainId: 56,
    to: CONTRACT,
    data: ALLOWED_CALLDATA,
    value: '0',
    resourceId: ORDER_ID,
    policyVersion: 1,
    idempotencyKey: 'execute-order-1',
    gasLimit: '500000',
    amounts: { amount: '25' },
    replacementForTxHash: HASH_2,
  });
  assert.equal(result.txHash, HASH_3);
  assert.equal(result.replacementForTxHash, HASH_2);
  await assert.rejects(
    executor.execute({
      chainId: 56,
      to: CONTRACT,
      data: ALLOWED_CALLDATA,
      value: '0',
      resourceId: ORDER_ID,
      policyVersion: 1,
      idempotencyKey: 'execute-order-2',
      gasLimit: '1000001',
      amounts: { amount: '25' },
    }),
    /bounded transaction plan/,
  );
  for (const request of [
    { to: '0x4444444444444444444444444444444444444444' },
    { data: '0x87654321' },
    { resourceId: '' },
    { resourceId: HASH_1 },
    { policyVersion: 0 },
    { policyVersion: 2 },
    { idempotencyKey: '' },
    { amounts: { amount: '26' } },
    { replacementForTxHash: '0x1234' },
  ]) {
    await assert.rejects(
      executor.execute({
        chainId: 56,
        to: CONTRACT,
        data: ALLOWED_CALLDATA,
        value: '0',
        resourceId: ORDER_ID,
        policyVersion: 1,
        idempotencyKey: 'execute-order-rejected',
        gasLimit: '500000',
        amounts: { amount: '25' },
        ...request,
      }),
      /bounded transaction plan/,
    );
  }
  assert.throws(
    () =>
      new RemoteExecutorClient({
        url: 'https://executor.example.invalid',
        token: 'test-executor-service-token',
        maxGasLimit: 1_000_000n,
      }),
    /unavailable/,
  );
});

test('payment RPC sources compute exact NPL amounts from the fixed pair and beneficiary snapshot', async () => {
  const reader = new StubContractReader({
    pairReserves: {
      blockNumber: 40_000_000,
      source: 'PRIMARY',
      token0: USDT_ADDRESS,
      token1: NPL_ADDRESS,
      reserve0: 50_000n * 10n ** 18n,
      reserve1: 500_000n * 10n ** 18n,
      reservesHash: HASH_1,
    },
    referrerOf: MERCHANT,
    regionBeneficiaries: [
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
      '0x6666666666666666666666666666666666666666',
    ],
  });
  const nplQuotes = new RpcPaymentNplQuoteSource({ reader });
  assert.deepEqual(await nplQuotes.quote({ listPriceUsdt: 100n, policyVersion: 1 }), {
    nplQuoteAmount: 1_000n,
    quoteSourceEvidence: { source: 'PRIMARY', observedBlock: 40_000_000, reservesHash: HASH_1 },
  });
  const beneficiaries = new RpcBeneficiarySnapshotSource({ reader, beneficiaryRegistryAddress: CONTRACT });
  assert.deepEqual(await beneficiaries.resolve({
    buyer: BUYER,
    merchant: MERCHANT,
    regionCodeHash: HASH_1,
    policyVersion: 1,
  }), {
    genesis: '0x0000000000000000000000000000000000000000',
    directReferral: MERCHANT,
    district: '0x3333333333333333333333333333333333333333',
    city: '0x4444444444444444444444444444444444444444',
    province: '0x5555555555555555555555555555555555555555',
    region: '0x6666666666666666666666666666666666666666',
  });

  const lowLiquidity = new RpcPaymentNplQuoteSource({
    reader: new StubContractReader({
      pairReserves: {
        blockNumber: 40_000_000,
        source: 'FALLBACK',
        token0: NPL_ADDRESS,
        token1: USDT_ADDRESS,
        reserve0: 500_000n * 10n ** 18n,
        reserve1: 50_000n * 10n ** 18n - 1n,
        reservesHash: HASH_2,
      },
    }),
  });
  await assert.rejects(
    lowLiquidity.quote({ listPriceUsdt: 100n, policyVersion: 1 }),
    /below the frozen minimum/,
  );
});

test('payment quote reader falls back to non-Archive latest reserves and records fallback evidence', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const reader = new ResilientBscContractReader(undefined, undefined, [
    pairRpcProvider({ fail: true }),
    pairRpcProvider({ calls, blockNumber: 40_000_001 }),
  ]);

  const snapshot = await reader.pairReserves(CONTRACT);

  assert.equal(snapshot.source, 'FALLBACK');
  assert.equal(snapshot.blockNumber, 40_000_001);
  assert.equal(snapshot.token0.toLowerCase(), USDT_ADDRESS);
  assert.equal(snapshot.token1.toLowerCase(), NPL_ADDRESS);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => !Object.hasOwn(call, 'blockTag')));

  const unavailable = new ResilientBscContractReader(undefined, undefined, [
    pairRpcProvider({ fail: true }),
    pairRpcProvider({ fail: true }),
  ]);
  await assert.rejects(unavailable.pairReserves(CONTRACT), /latest pair reserves are unavailable/);
});

test('contract reader serializes concurrent public RPC calls per provider', async () => {
  const primary = { active: 0, maximum: 0 };
  const fallback = { active: 0, maximum: 0 };
  const reader = new ResilientBscContractReader(undefined, undefined, [
    pairRpcProvider({ tracker: primary, delayMs: 2 }),
    pairRpcProvider({ tracker: fallback, delayMs: 2 }),
  ]);

  await Promise.all([reader.code(CONTRACT), reader.code(CONTRACT)]);

  assert.equal(primary.maximum, 1);
  assert.equal(fallback.maximum, 1);
});

test('payment policy attestation binds all 27 Registry fields and latest-version semantics', async () => {
  const policy = paymentPolicySnapshot();
  const operationAccounts = policy.operationsDestinations.map((item) => item.account);
  const operationWeights = policy.operationsDestinations.map((item) => BigInt(item.weightBps));
  const beneficiarySetHash = paymentBeneficiarySetHash(
    policy.genesisNodeDestinations,
    policy.operationsDestinations,
  );
  const rulesContentHash = HASH_3;
  const tuple = paymentPolicyTuple(policy, beneficiarySetHash, rulesContentHash);
  const policyHash = keccak256(AbiCoder.defaultAbiCoder().encode([PAYMENT_POLICY_TUPLE_ABI], [tuple]));
  const input = {
    artifactVersion: CORE_ARTIFACT_VERSION,
    policyHash,
    rulesContentHash,
    beneficiarySetHash,
    policy,
    requireLatest: true,
  } as const;
  const source = policySource(tuple, [operationAccounts, operationWeights], 1n);
  await source.assertPublished(input);

  await source.assertPublished({ ...input, artifactVersion: '2.0.0-payment.stale' });
  await assert.rejects(source.assertPublished({ ...input, policyHash: HASH_2 }), /policyHash/);
  await assert.rejects(
    policySource(tuple, [operationAccounts, operationWeights], 2n).assertPublished(input),
    /latestVersion/,
  );
  await policySource(tuple, [operationAccounts, operationWeights], 2n).assertPublished({
    ...input,
    requireLatest: false,
  });

  for (const [name, index, value] of [
    ['usdtSettlementWallet', 19, '0x9999999999999999999999999999999999999999'],
    ['concessionDestinationSetHash', 24, HASH_2],
    ['rulesContentHash', 26, HASH_2],
  ] as const) {
    const changed = [...tuple];
    changed[index] = value;
    const changedPolicyHash = keccak256(
      AbiCoder.defaultAbiCoder().encode([PAYMENT_POLICY_TUPLE_ABI], [changed]),
    );
    await assert.rejects(
      policySource(changed, [operationAccounts, operationWeights], 1n).assertPublished({
        ...input,
        policyHash: changedPolicyHash,
      }),
      new RegExp(name),
    );
  }
  await assert.rejects(
    policySource(tuple, [operationAccounts, [5_000n, 5_000n]], 1n).assertPublished(input),
    /operationAccounts|operationWeights/,
  );
});

test('runtime readiness attests deployed code, bindings, roles, NPL quote source and live infrastructure', async () => {
  const router = '0x1000000000000000000000000000000000000001';
  const policyRegistry = '0x1000000000000000000000000000000000000002';
  const beneficiaryRegistry = '0x1000000000000000000000000000000000000003';
  const governanceWallet = '0x1000000000000000000000000000000000000006';
  const usdtSafe = '0x1000000000000000000000000000000000000007';
  const nplSafe = '0x1000000000000000000000000000000000000008';
  const operationsSafe = '0x1000000000000000000000000000000000000009';
  const secondarySigner = governanceWallet;
  const quoteSigner = governanceWallet;
  const runtimeCode = '0x6001600055';
  const runtimeCodeHash = keccak256(runtimeCode);
  const values: Record<string, unknown> = {
    [`${router}:usdt`]: '0x55d398326f99059ff775485246999027b3197955',
    [`${router}:npl`]: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    [`${router}:policyRegistry`]: policyRegistry,
    [`${router}:beneficiaryRegistry`]: beneficiaryRegistry,
    [`${router}:governanceWallet`]: governanceWallet,
    [`${router}:platformServiceFeeWallet`]: '0x7000000000000000000000000000000000000000',
    [`${router}:usdtSettlementWallet`]: usdtSafe,
    [`${router}:nplRewardWallet`]: nplSafe,
    [`${router}:operationsWallet`]: operationsSafe,
    [`${router}:quoteSigner`]: quoteSigner,
    [`${policyRegistry}:governanceWallet`]: governanceWallet,
    [`${policyRegistry}:secondarySigner`]: secondarySigner,
    [`${beneficiaryRegistry}:policyRegistry`]: policyRegistry,
    [`${governanceWallet}:code`]: '0x',
    ['0x7000000000000000000000000000000000000000:code']: '0x',
    [`${usdtSafe}:code`]: '0x',
    [`${nplSafe}:code`]: '0x',
    [`${operationsSafe}:code`]: '0x',
    pairReserves: {
      blockNumber: 40_000_000,
      source: 'PRIMARY',
      token0: USDT_ADDRESS,
      token1: NPL_ADDRESS,
      reserve0: 50_000n * 10n ** 18n,
      reserve1: 500_000n * 10n ** 18n,
      reservesHash: HASH_1,
    },
    hasRole: true,
  };
  const reader = new StubRuntimeReader(values, runtimeCode);
  const deployments = [router, policyRegistry, beneficiaryRegistry].map((address, index) => ({
    name: `Contract${index}`,
    address,
    deployedCodeHash: runtimeCodeHash,
  }));
  const attestor = new RpcPaymentRuntimeAttestor({
    reader,
    deployments,
    router,
    policyRegistry,
    beneficiaryRegistry,
    governanceWallet,
    platformServiceFeeWallet: '0x7000000000000000000000000000000000000000',
    usdtSettlementWallet: usdtSafe,
    nplRewardWallet: nplSafe,
    operationsWallet: operationsSafe,
  });
  assert.deepEqual(await attestor.attest(), {
    deployedRuntimeCodeVerified: true,
    roleGrantsVerified: true,
    walletRolesVerified: true,
    signerBindingsVerified: true,
    nplQuoteSourceHealthy: true,
    rpcChain56Healthy: true,
  });
  const singleRequestReader = new StubRuntimeReader(values, runtimeCode, 1);
  const singleRequestAttestor = new RpcPaymentRuntimeAttestor({
    reader: singleRequestReader,
    deployments,
    router,
    policyRegistry,
    beneficiaryRegistry,
    governanceWallet,
    platformServiceFeeWallet: '0x7000000000000000000000000000000000000000',
    usdtSettlementWallet: usdtSafe,
    nplRewardWallet: nplSafe,
    operationsWallet: operationsSafe,
  });
  await singleRequestAttestor.attest();
  assert.equal(singleRequestReader.maxConcurrentObserved, 1);

  let transientNow = new Date('2026-07-14T00:00:00.000Z');
  let transientAttempts = 0;
  const transientMonitor = new PaymentRuntimeReadinessMonitor({
    attest: async () => {
      transientAttempts += 1;
      if (transientAttempts === 1) return attestor.attest();
      throw new Error('transient RPC evidence failure');
    },
    componentHashesVerified: async () => true,
    databaseHealthy: async () => true,
    redisHealthy: async () => true,
    signerHealthy: async () => true,
    receiptWorkerStatus: () => ({ healthy: true }),
    clock: () => transientNow,
    intervalMs: 1_000,
  });
  const firstSnapshot = await transientMonitor.pollOnce();
  transientNow = new Date('2026-07-14T00:00:01.000Z');
  const reusedSnapshot = await transientMonitor.pollOnce();
  assert.equal(reusedSnapshot.deployedRuntimeCodeVerified, true);
  assert.equal(reusedSnapshot.nplQuoteSourceHealthy, true);
  assert.equal(reusedSnapshot.expiresAt, firstSnapshot.expiresAt);

  let receiptWorkerHealthy = false;
  const now = new Date('2026-07-14T00:00:00.000Z');
  const monitor = new PaymentRuntimeReadinessMonitor({
    attest: () => attestor.attest(),
    componentHashesVerified: async () => true,
    databaseHealthy: async () => true,
    redisHealthy: async () => true,
    signerHealthy: async () => true,
    receiptWorkerStatus: () => ({ healthy: receiptWorkerHealthy }),
    clock: () => now,
    intervalMs: 10,
  });
  assert.equal((await monitor.pollOnce()).paymentReceiptWorkerHealthy, false);
  receiptWorkerHealthy = true;
  assert.equal(monitor.snapshot()?.paymentReceiptWorkerHealthy, true);
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await monitor.stop();
});

test('scheduler opens eligible delivery takeover and records pickup DecisionBlocked', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const paidAt = new Date('2026-07-01T00:00:00.000Z');
  const result = scheduleFulfillmentJobs(
    [
      {
        orderId: 'delivery-order',
        fulfillmentMode: 'DELIVERY',
        state: 'PAID',
        paymentFinalizedAt: paidAt,
        takeoverOpened: false,
      },
      {
        orderId: 'pickup-order',
        fulfillmentMode: 'PICKUP',
        state: 'PAID',
        paymentFinalizedAt: paidAt,
        takeoverOpened: false,
      },
      {
        orderId: 'delivered-order',
        fulfillmentMode: 'DELIVERY',
        state: 'DELIVERED',
        paymentFinalizedAt: paidAt,
        deliveredAt: paidAt,
        takeoverOpened: false,
      },
    ],
    now,
  );
  assert.deepEqual(
    result.jobs.map((job) => job.jobType).sort(),
    ['FORCED_RECEIPT_ELIGIBILITY', 'OPEN_TAKEOVER'],
  );
  assert.deepEqual(result.blocked, [{ orderId: 'pickup-order', code: 'PickupTakeoverDecisionBlocked' }]);
});

test('fulfillment scheduler executes eligible takeover with deterministic evidence and skips pickup', async () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const opened: Array<{ actor: string; orderId: string; input: Record<string, string> }> = [];
  const worker = new FulfillmentSchedulerWorker({
    platformWallet: CONTRACT,
    transactions: noopTransactions(),
    clock: () => now,
    service: {
      listOrders: async () => [
        {
          orderId: ORDER_ID,
          fulfillmentMode: 'DELIVERY' as const,
          state: 'PAID',
          paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
          shipments: [],
        },
        {
          orderId: HASH_2,
          fulfillmentMode: 'PICKUP' as const,
          state: 'PAID',
          paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
          shipments: [],
        },
        {
          orderId: HASH_3,
          fulfillmentMode: 'DELIVERY' as const,
          state: 'PAID',
          paymentFinalizedAt: '2026-07-01T00:00:00.000Z',
          shipments: [{}],
        },
      ],
      openTakeover: async (actor, orderId, input) => {
        opened.push({ actor: actor.walletAddress, orderId, input });
        return { orderId, state: 'TAKEOVER' };
      },
    },
  });
  assert.deepEqual(await worker.pollOnce(), { checked: 3, opened: 1, pickupBlocked: 1, deferred: 0, failed: 0 });
  assert.equal(opened[0]?.actor, CONTRACT);
  assert.equal(opened[0]?.orderId, ORDER_ID);
  assert.equal(opened[0]?.input.idempotencyKey, `auto-takeover:${ORDER_ID}`);
  assert.equal(opened[0]?.input.reasonCode, 'SEVEN_DAY_NO_SHIPMENT');
  assert.match(opened[0]?.input.evidenceHash ?? '', /^0x[0-9a-f]{64}$/);
  await worker.pollOnce();
  assert.deepEqual(opened[1]?.input, opened[0]?.input);
});

test('guarantee RPC source binds exact BSC USDT transfer and 14/15 confirmation finality', async () => {
  assert.throws(
    () => new ResilientBscGuaranteeDepositSource({
      primaryRpcUrl: 'http://primary.example.invalid',
      fallbackRpcUrl: 'https://fallback.example.invalid',
    }),
    /must be an HTTPS endpoint/,
  );
  assert.throws(
    () => new ResilientBscGuaranteeDepositSource({
      primaryRpcUrl: 'https://same.example.invalid',
      fallbackRpcUrl: 'https://same.example.invalid',
    }),
    /must be independent/,
  );
  assert.throws(
    () => new ResilientBscGuaranteeDepositSource({
      primaryRpcUrl: 'https://user:password@primary.example.invalid',
      fallbackRpcUrl: 'https://fallback.example.invalid',
    }),
    /without embedded credentials/,
  );

  const harness = guaranteeRpcHarness();
  const source = guaranteeChainSource(harness.fetch);
  const mined = await source.observe(guaranteeFinalityItem());
  assert.equal(mined.state, 'MINED');
  if (mined.state !== 'MINED') throw new Error('ExpectedMinedGuarantee');
  assert.equal(mined.confirmations, 14);
  assert.equal(mined.from, MERCHANT);
  assert.equal(mined.to, guaranteeFinalityItem().operationsWalletAddress);
  assert.equal(mined.amount, guaranteeFinalityItem().expectedAmountUsdt);
  assert.equal(mined.logIndex, 3);
  assert.match(mined.transferEvidenceHash, /^0x[0-9a-f]{64}$/);

  harness.state.primaryHead = 114;
  harness.state.fallbackHead = 116;
  const final = await source.observe(guaranteeFinalityItem());
  assert.equal(final.state, 'FINAL');
  if (final.state !== 'FINAL') throw new Error('ExpectedFinalGuarantee');
  assert.equal(final.confirmations, 15);
  harness.state.primaryHead = 120;
  harness.state.fallbackHead = 121;
  assert.equal(final.transferEvidenceHash, (await source.observe(guaranteeFinalityItem()) as typeof final).transferEvidenceHash);
});

test('guarantee RPC source fails closed on chain, receipt, transfer and canonical disagreement', async () => {
  const harness = guaranteeRpcHarness();
  const source = guaranteeChainSource(harness.fetch);

  harness.state.fallbackChainId = 1;
  await assert.rejects(source.observe(guaranteeFinalityItem()), /not BSC chain 56/);
  harness.state.fallbackChainId = 56;

  harness.state.fallbackReceiptMissing = true;
  await assert.rejects(source.observe(guaranteeFinalityItem()), /providers disagree/);
  harness.state.fallbackReceiptMissing = false;

  harness.state.fallbackReceiptBlockHash = HASH_3;
  await assert.rejects(source.observe(guaranteeFinalityItem()), /different transactions/);
  harness.state.fallbackReceiptBlockHash = harness.minedBlockHash;

  harness.state.fallbackCanonicalBlockHash = HASH_3;
  await assert.rejects(source.observe(guaranteeFinalityItem()), /not canonical/);
  harness.state.fallbackCanonicalBlockHash = harness.minedBlockHash;

  harness.state.transferAmount = '999';
  await assert.rejects(source.observe(guaranteeFinalityItem()), /one exact USDT Transfer/);
  harness.state.transferAmount = guaranteeFinalityItem().expectedAmountUsdt;

  harness.state.transferRecipient = BUYER;
  await assert.rejects(source.observe(guaranteeFinalityItem()), /one exact USDT Transfer/);
  harness.state.transferRecipient = guaranteeFinalityItem().operationsWalletAddress;

  harness.state.transferData = '0x01';
  await assert.rejects(source.observe(guaranteeFinalityItem()), /one exact USDT Transfer/);
  harness.state.transferData = null;

  harness.state.receiptStatus = '0x0';
  await assert.rejects(source.observe(guaranteeFinalityItem()), /did not succeed/);
});

test('guarantee RPC source proves deep reorg only when both providers replace the old block', async () => {
  const harness = guaranteeRpcHarness();
  const source = guaranteeChainSource(harness.fetch);
  const observed = {
    ...guaranteeFinalityItem(),
    state: 'FINAL' as const,
    observedBlockNumber: 100,
    observedBlockHash: harness.minedBlockHash,
    observedLogIndex: 3,
    confirmations: 15,
  };
  harness.state.primaryReceiptMissing = true;
  harness.state.fallbackReceiptMissing = true;
  harness.state.primaryCanonicalBlockHash = harness.replacementBlockHash;
  harness.state.fallbackCanonicalBlockHash = harness.replacementBlockHash;
  const reorg = await source.observe(observed);
  assert.equal(reorg.state, 'REORGED');
  if (reorg.state !== 'REORGED') throw new Error('ExpectedGuaranteeReorg');
  assert.equal(reorg.previousBlockHash, harness.minedBlockHash);
  assert.equal(reorg.canonicalBlockHash, harness.replacementBlockHash);

  harness.state.fallbackCanonicalBlockHash = HASH_3;
  await assert.rejects(source.observe(observed), /providers disagree/);
  harness.state.fallbackCanonicalBlockHash = harness.minedBlockHash;
  harness.state.primaryCanonicalBlockHash = harness.minedBlockHash;
  await assert.rejects(source.observe(observed), /block remains canonical/);
});

test('BNM adapter is idempotency-bound, validates acknowledgements and fails closed without configuration', async () => {
  const input = {
    orderId: ORDER_ID,
    buyerWallet: BUYER,
    amount: '100',
    state: 'AVAILABLE' as const,
    stateVersion: '1',
    reason: 'CUSTOMER_RECEIPT',
    sourceEvidenceHash: HASH_1,
    idempotencyKey: 'outbox:bnm:order-1',
  };
  await assert.rejects(new HttpBnmAvailabilityAdapter({}).setState(input), /unavailable/);
  let unverifiedFetchCalled = false;
  await assert.rejects(
    new HttpBnmAvailabilityAdapter({
      url: 'https://bnm.example.invalid/v1/order-points/state',
      token: 'provider-token',
      projectId: 'abu-24k',
      fetch: (async () => {
        unverifiedFetchCalled = true;
        return new Response('{}');
      }) as typeof fetch,
    }).setState(input),
    /unavailable/,
  );
  assert.equal(unverifiedFetchCalled, false);
  assert.throws(
    () => new HttpBnmAvailabilityAdapter({ url: 'http://bnm.example.invalid' }),
    /must use HTTPS/,
  );

  let registrationRequest: Request | undefined;
  const registered = new HttpBnmAvailabilityAdapter({
    url: 'https://bnm.example.invalid/v1/order-points/state',
    token: 'provider-token',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    fetch: (async (input, init) => {
      registrationRequest = new Request(input, init);
      return new Response(JSON.stringify({
        projectId: 'abu-24k',
        walletAddress: BUYER.toLowerCase(),
        registered: true,
        conformanceEvidenceHash: HASH_2,
        checkedAt: '2026-07-14T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await registered.assertRegistered(BUYER);
  assert.equal(registrationRequest?.headers.get('idempotency-key'), `bnm-wallet-status:${BUYER.toLowerCase()}`);
  assert.deepEqual(await registrationRequest?.json(), {
    operation: 'CHECK_WALLET',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    walletAddress: BUYER.toLowerCase(),
  });

  const unregistered = new HttpBnmAvailabilityAdapter({
    url: 'https://bnm.example.invalid/v1/order-points/state',
    token: 'provider-token',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    fetch: (async () => new Response(JSON.stringify({
      projectId: 'abu-24k',
      walletAddress: BUYER.toLowerCase(),
      registered: false,
      conformanceEvidenceHash: HASH_2,
      checkedAt: '2026-07-14T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(
    unregistered.assertRegistered(BUYER),
    (error: unknown) => error instanceof CoreError && error.code === 'Forbidden' && error.status === 403,
  );

  let request: Request | undefined;
  const adapter = new HttpBnmAvailabilityAdapter({
    url: 'https://bnm.example.invalid/v1/order-points/state',
    token: 'provider-token',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    fetch: (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        providerReference: 'bnm-reference-1',
        orderId: ORDER_ID,
        amount: '100',
        state: 'AVAILABLE',
        stateVersion: '1',
        effectiveState: 'AVAILABLE',
        effectiveStateVersion: '1',
        outcome: 'APPLIED',
        conformanceEvidenceHash: HASH_2,
        syncedAt: '2026-07-14T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  assert.deepEqual(await adapter.setState(input), {
    providerReference: 'bnm-reference-1',
    syncedAt: '2026-07-14T00:00:00.000Z',
    state: 'AVAILABLE',
    stateVersion: '1',
  });
  assert.equal(request?.headers.get('idempotency-key'), input.idempotencyKey);
  assert.equal(request?.headers.get('authorization'), 'Bearer provider-token');
  assert.deepEqual(await request?.json(), {
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    orderId: ORDER_ID,
    walletAddress: BUYER,
    amount: '100',
    state: 'AVAILABLE',
    stateVersion: '1',
    reason: 'CUSTOMER_RECEIPT',
    sourceEvidenceHash: HASH_1,
  });

  const stale = new HttpBnmAvailabilityAdapter({
    url: 'https://bnm.example.invalid/v1/order-points/state',
    token: 'provider-token',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    fetch: (async () => new Response(JSON.stringify({
      providerReference: 'bnm-reference-stale',
      orderId: ORDER_ID,
      amount: '100',
      state: 'AVAILABLE',
      stateVersion: '1',
      effectiveState: 'LOCKED',
      effectiveStateVersion: '2',
      outcome: 'IGNORED_STALE',
      conformanceEvidenceHash: HASH_2,
      syncedAt: '2026-07-14T00:00:01.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  assert.deepEqual(await stale.setState(input), {
    providerReference: 'bnm-reference-stale',
    syncedAt: '2026-07-14T00:00:01.000Z',
    state: 'LOCKED',
    stateVersion: '2',
  });

  const invalid = new HttpBnmAvailabilityAdapter({
    url: 'https://bnm.example.invalid/v1/order-points/state',
    token: 'provider-token',
    projectId: 'abu-24k',
    conformanceEvidenceHash: HASH_2,
    fetch: (async () => new Response(JSON.stringify({ state: 'AVAILABLE' }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(invalid.setState(input), /invalid acknowledgement/);
});

test('BNM worker reports outer database failures and stop never rethrows a rejected polling promise', async () => {
  const worker = new BnmAvailabilityWorker({
    transactions: {
      transaction: async () => {
        throw new Error('database unavailable');
      },
    },
    adapter: { setState: async () => { throw new Error('unreachable'); } },
    intervalMs: 10,
  });
  await assert.rejects(worker.pollOnce(), /database unavailable/);
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await worker.stop();
  assert.deepEqual(worker.status(), { healthy: false, errorCode: 'UnexpectedBnmWorkerFailure' });
});

class MemoryIndexerStore implements IndexerStore {
  current: CanonicalCheckpoint | undefined;
  readonly blocks = new Map<number, IndexedChainBlock>();
  get events() {
    return [...this.blocks.values()].flatMap((item) => item.events);
  }
  readonly reorgs: Array<{ fromBlock: number; expected: string; observed: string }> = [];

  async checkpoint() {
    return this.current;
  }

  async canonicalAt(blockNumber: number) {
    const block = this.blocks.get(blockNumber)?.block;
    return block ? { blockNumber, blockHash: block.hash } : undefined;
  }

  async appendCanonical(expectedHead: CanonicalCheckpoint | undefined, segment: IndexedChainBlock[]) {
    assert.deepEqual(this.current, expectedHead);
    for (const item of segment) this.blocks.set(item.block.number, item);
    const last = segment.at(-1)!.block;
    this.current = { blockNumber: last.number, blockHash: last.hash };
  }

  async replaceCanonical(
    expectedHead: CanonicalCheckpoint,
    commonAncestor: CanonicalCheckpoint,
    segment: IndexedChainBlock[],
  ) {
    assert.deepEqual(this.current, expectedHead);
    for (const height of [...this.blocks.keys()]) {
      if (height > commonAncestor.blockNumber) this.blocks.delete(height);
    }
    for (const item of segment) this.blocks.set(item.block.number, item);
    const last = segment.at(-1)!.block;
    this.current = { blockNumber: last.number, blockHash: last.hash };
  }

  async markReorg(fromBlock: number, expected: string, observed: string) {
    this.reorgs.push({ fromBlock, expected, observed });
  }
}

class MemoryPaymentChainSource implements PaymentChainSource {
  readonly blocks = new Map<number, ChainBlock>();
  logsByBlock = new Map<number, IndexedLog[]>();
  readonly logRanges: Array<[number, number]> = [];
  readonly #blockDelayMs: number;
  #activeBlockReads = 0;
  maxConcurrentBlockReads = 0;

  constructor(blocks: ChainBlock[], logs: IndexedLog[], blockDelayMs = 0) {
    this.#blockDelayMs = blockDelayMs;
    this.replace(blocks, logs);
  }

  replace(blocks: ChainBlock[], logs: IndexedLog[]) {
    for (const block of blocks) this.blocks.set(block.number, block);
    for (const block of blocks) this.logsByBlock.delete(block.number);
    for (const log of logs) {
      const values = this.logsByBlock.get(log.blockNumber) ?? [];
      values.push(log);
      this.logsByBlock.set(log.blockNumber, values);
    }
  }

  truncate(head: number) {
    for (const blockNumber of [...this.blocks.keys()]) {
      if (blockNumber > head) this.blocks.delete(blockNumber);
    }
    for (const blockNumber of [...this.logsByBlock.keys()]) {
      if (blockNumber > head) this.logsByBlock.delete(blockNumber);
    }
  }

  async head() {
    return Math.max(...this.blocks.keys());
  }

  async block(blockNumber: number) {
    const block = this.blocks.get(blockNumber);
    if (!block) throw new Error(`Missing block ${blockNumber}`);
    this.#activeBlockReads += 1;
    this.maxConcurrentBlockReads = Math.max(this.maxConcurrentBlockReads, this.#activeBlockReads);
    try {
      if (this.#blockDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#blockDelayMs));
      return block;
    } finally {
      this.#activeBlockReads -= 1;
    }
  }

  async logs(fromBlock: number, toBlock: number) {
    this.logRanges.push([fromBlock, toBlock]);
    return [...this.logsByBlock.entries()]
      .filter(([blockNumber]) => blockNumber >= fromBlock && blockNumber <= toBlock)
      .flatMap(([, logs]) => logs);
  }
}

function paymentRpcProvider(input: {
  head: number | (() => number);
  blocks: ChainBlock[];
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockHash: string;
    blockNumber: number;
    index: number;
  }>;
  failHead?: boolean | (() => boolean);
  failBlock?: boolean | (() => boolean);
  failLogs?: boolean | (() => boolean);
}) {
  const blocks = new Map(input.blocks.map((block) => [block.number, block]));
  return {
    getNetwork: async () => ({ chainId: 56n }),
    getBlockNumber: async () => {
      if (flag(input.failHead)) throw new Error('head unavailable');
      return typeof input.head === 'function' ? input.head() : input.head;
    },
    getBlock: async (blockNumber: number) => {
      if (flag(input.failBlock)) throw new Error('block unavailable');
      return blocks.get(blockNumber) ?? null;
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
      if (flag(input.failLogs)) throw new Error('logs unavailable');
      return input.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    send: async () => {
      throw new Error('unexpected receipt fallback');
    },
  } as unknown as JsonRpcProvider;
}

function flag(value: boolean | (() => boolean) | undefined) {
  return typeof value === 'function' ? value() : value === true;
}

function pairRpcProvider(input: {
  fail?: boolean;
  calls?: Array<Record<string, unknown>>;
  blockNumber?: number;
  delayMs?: number;
  tracker?: { active: number; maximum: number };
}) {
  const pair = new Interface([
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
  ]);
  const tracked = async <Value>(operation: () => Value | Promise<Value>) => {
    if (input.tracker) {
      input.tracker.active += 1;
      input.tracker.maximum = Math.max(input.tracker.maximum, input.tracker.active);
    }
    try {
      if (input.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      return await operation();
    } finally {
      if (input.tracker) input.tracker.active -= 1;
    }
  };
  return {
    getNetwork: async () => tracked(() => ({ chainId: 56n })),
    getBlockNumber: async () => tracked(() => input.blockNumber ?? 40_000_000),
    getCode: async () => tracked(() => '0x6000'),
    call: async (transaction: Record<string, unknown>) => tracked(() => {
      if (input.fail) throw new Error('latest call unavailable');
      input.calls?.push(transaction);
      const data = String(transaction.data).toLowerCase();
      if (data.startsWith(pair.getFunction('token0')!.selector.toLowerCase())) {
        return pair.encodeFunctionResult('token0', [USDT_ADDRESS]);
      }
      if (data.startsWith(pair.getFunction('token1')!.selector.toLowerCase())) {
        return pair.encodeFunctionResult('token1', [NPL_ADDRESS]);
      }
      if (data.startsWith(pair.getFunction('getReserves')!.selector.toLowerCase())) {
        return pair.encodeFunctionResult('getReserves', [
          50_000n * 10n ** 18n,
          500_000n * 10n ** 18n,
          1_800_000_000,
        ]);
      }
      throw new Error('unexpected pair call');
    }),
  } as unknown as JsonRpcProvider;
}

function blockHash(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function rpcReceiptLog(input: { address: string; blockNumber: number; logIndex: number; topic0?: string }) {
  return {
    address: input.address,
    topics: [input.topic0 ?? HASH_1],
    data: '0x',
    transactionHash: HASH_2,
    blockHash: HASH_3,
    blockNumber: `0x${input.blockNumber.toString(16)}`,
    logIndex: `0x${input.logIndex.toString(16)}`,
  };
}

class StubContractReader implements ContractReader {
  readonly #values: Record<string, unknown>;

  constructor(values: Record<string, unknown>) {
    this.#values = values;
  }

  async call(_address: string, _abi: InterfaceAbi, method: string) {
    if (!(method in this.#values)) throw new Error(`Unexpected method ${method}`);
    return this.#values[method];
  }

  async pairReserves(_address: string) {
    if (!this.#values.pairReserves) throw new Error('Unexpected pair reserves request');
    return this.#values.pairReserves as {
      blockNumber: number; source: 'PRIMARY' | 'FALLBACK'; token0: string; token1: string;
      reserve0: bigint; reserve1: bigint; reservesHash: string;
    };
  }
}

class StubRuntimeReader implements RuntimeCodeReader {
  readonly #values: Record<string, unknown>;
  readonly #code: string;
  readonly #maxConcurrent: number;
  #active = 0;
  maxConcurrentObserved = 0;

  constructor(values: Record<string, unknown>, code: string, maxConcurrent = Number.POSITIVE_INFINITY) {
    this.#values = values;
    this.#code = code;
    this.#maxConcurrent = maxConcurrent;
  }

  async call(address: string, _abi: InterfaceAbi, method: string) {
    return this.#bounded(async () => {
      const key = `${address.toLowerCase()}:${method}`;
      if (key in this.#values) return this.#values[key];
      if (method in this.#values) return this.#values[method];
      throw new Error(`Unexpected method ${key}`);
    });
  }

  async chainId() {
    return 56;
  }

  async code(address: string) {
    return this.#bounded(async () => String(this.#values[`${address.toLowerCase()}:code`] ?? this.#code));
  }

  async pairReserves(_address: string) {
    return this.#bounded(async () => this.#values.pairReserves as {
      blockNumber: number; source: 'PRIMARY' | 'FALLBACK'; token0: string; token1: string;
      reserve0: bigint; reserve1: bigint; reservesHash: string;
    });
  }

  async #bounded<Result>(operation: () => Promise<Result>) {
    this.#active += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.#active);
    try {
      if (this.#active > this.#maxConcurrent) throw new Error('Runtime reader concurrency exceeded');
      await Promise.resolve();
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}

function policySource(
  tuple: readonly unknown[],
  operations: readonly [readonly string[], readonly bigint[]],
  latestVersion: bigint,
) {
  return new RpcPaymentPolicyAttestationSource({
    reader: new StubContractReader({ getPolicy: tuple, getOperations: operations, latestVersion }),
    policyRegistryAddress: CONTRACT,
  });
}

function guaranteeFinalityItem(): GuaranteeDepositFinalityItem {
  return {
    depositId: 'guarantee-deposit:rpc-test',
    merchantId: 'merchant-1',
    merchantWallet: MERCHANT,
    policyVersion: 1,
    tokenAddress: USDT_ADDRESS,
    operationsWalletAddress: '0x5555555555555555555555555555555555555555',
    expectedAmountUsdt: (1_000n * 10n ** 18n).toString(),
    transactionHash: HASH_2,
    state: 'SUBMITTED',
    confirmations: 0,
  };
}

function guaranteeChainSource(fetchImpl: typeof fetch) {
  return new ResilientBscGuaranteeDepositSource({
    primaryRpcUrl: 'https://guarantee-primary.example.invalid',
    fallbackRpcUrl: 'https://guarantee-fallback.example.invalid',
    fetchImpl,
    clock: () => new Date('2026-07-15T08:00:00.000Z'),
  });
}

function guaranteeRpcHarness() {
  const minedBlockHash = `0x${'6'.repeat(64)}`;
  const replacementBlockHash = `0x${'7'.repeat(64)}`;
  const transferInterface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event = transferInterface.getEvent('Transfer');
  if (!event) throw new Error('MissingTransferEvent');
  const state = {
    primaryChainId: 56,
    fallbackChainId: 56,
    primaryHead: 113,
    fallbackHead: 113,
    primaryReceiptMissing: false,
    fallbackReceiptMissing: false,
    receiptStatus: '0x1',
    fallbackReceiptBlockHash: minedBlockHash,
    primaryCanonicalBlockHash: minedBlockHash,
    fallbackCanonicalBlockHash: minedBlockHash,
    transferAmount: guaranteeFinalityItem().expectedAmountUsdt,
    transferRecipient: guaranteeFinalityItem().operationsWalletAddress,
    transferData: null as string | null,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const primary = String(input).startsWith('https://guarantee-primary.example.invalid');
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'eth_chainId') {
      result = `0x${(primary ? state.primaryChainId : state.fallbackChainId).toString(16)}`;
    } else if (request.method === 'eth_blockNumber') {
      result = `0x${(primary ? state.primaryHead : state.fallbackHead).toString(16)}`;
    } else if (request.method === 'eth_getBlockByNumber') {
      result = {
        number: String(request.params[0]).toLowerCase(),
        hash: primary ? state.primaryCanonicalBlockHash : state.fallbackCanonicalBlockHash,
      };
    } else if (request.method === 'eth_getTransactionReceipt') {
      const missing = primary ? state.primaryReceiptMissing : state.fallbackReceiptMissing;
      if (missing) {
        result = null;
      } else {
        const encoded = transferInterface.encodeEventLog(event, [
          MERCHANT,
          state.transferRecipient,
          BigInt(state.transferAmount),
        ]);
        const blockHash = primary ? minedBlockHash : state.fallbackReceiptBlockHash;
        result = {
          transactionHash: HASH_2,
          transactionIndex: '0x0',
          blockHash,
          blockNumber: '0x64',
          status: state.receiptStatus,
          logs: [{
            address: USDT_ADDRESS,
            topics: encoded.topics,
            data: state.transferData ?? encoded.data,
            logIndex: '0x3',
            transactionHash: HASH_2,
            blockHash,
            blockNumber: '0x64',
            removed: false,
          }],
        };
      }
    } else {
      throw new Error(`UnexpectedGuaranteeRpcMethod:${request.method}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, result });
  };
  return { state, fetch: fetchImpl, minedBlockHash, replacementBlockHash };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function paymentPolicySnapshot(): PaymentPolicySnapshot {
  return {
    policyVersion: 1,
    usdtPaymentBps: 7_000,
    nplPaymentBps: 3_000,
    nplBurnListPriceBps: 2_000,
    nplRewardListPriceBps: 1_000,
    genesisBps: 200,
    directReferralBps: 100,
    districtBps: 120,
    cityBps: 80,
    provinceBps: 60,
    regionBps: 40,
    operationsBps: 400,
    platformFeeBps: 100,
    seckillPrizeBps: 0,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: 1_000n * 10n ** 18n,
    platformServiceFeeWallet: '0x2222222222222222222222222222222222222223',
    usdtSettlementWallet: '0x3333333333333333333333333333333333333333',
    nplRewardWallet: '0x4444444444444444444444444444444444444444',
    operationsWallet: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6000000000000000000000000000000000000001',
    concessionDestinationSetHash: paymentAllocationSetHash(),
    decisionEvidenceHash: HASH_2,
    genesisNodeDestinations: [
      { account: '0x5000000000000000000000000000000000000006', weightBps: 10_000 },
    ],
    operationsDestinations: [
      { account: '0x5000000000000000000000000000000000000007', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000008', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000009', weightBps: 2_500 },
      { account: '0x5000000000000000000000000000000000000010', weightBps: 2_500 },
    ],
  };
}

function paymentPolicyTuple(
  policy: PaymentPolicySnapshot,
  beneficiarySetHash: string,
  rulesContentHash: string,
) {
  return [
    policy.policyVersion,
    policy.usdtPaymentBps,
    policy.nplPaymentBps,
    policy.nplBurnListPriceBps,
    policy.nplRewardListPriceBps,
    policy.genesisBps,
    policy.directReferralBps,
    policy.districtBps,
    policy.cityBps,
    policy.provinceBps,
    policy.regionBps,
    policy.operationsBps,
    policy.platformFeeBps,
    policy.seckillPrizeBps,
    policy.seckillMainDuration,
    policy.relayInitial,
    policy.relayIncrement,
    policy.relayCap,
    policy.merchantGuaranteeMinimumUsdt,
    policy.usdtSettlementWallet,
    policy.nplRewardWallet,
    policy.operationsWallet,
    policy.circulationPool,
    beneficiarySetHash,
    policy.concessionDestinationSetHash,
    policy.decisionEvidenceHash,
    rulesContentHash,
  ];
}

function executorDeployment() {
  return {
    coordinatedManifest: { artifactVersion: CORE_ARTIFACT_VERSION, deploymentAuthorized: true, chain: { chainId: 56 } },
    contractManifest: {
      artifactVersion: CORE_ARTIFACT_VERSION,
      deploymentStatus: 'DEPLOYED',
      chain: { chainId: 56 },
      contracts: [{ name: 'BoundedExecutorTarget', address: CONTRACT, status: 'DEPLOYED' }],
    },
    allowedCalls: {
      BoundedExecutorTarget: [
        {
          signature: 'settle(bytes32 resourceId,uint64 policyVersion,uint256 amount)',
          resourcePath: ['resourceId'],
          policyVersionPath: ['policyVersion'],
          amountPaths: { amount: ['amount'] },
        },
      ],
    },
    mutualTls: true as const,
  };
}

function noopTransactions(): SqlTransactionRunner {
  const executor: SqlExecutor = { query: async () => ({ rows: [] }) };
  return { transaction: (operation) => operation(executor) };
}

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AbiCoder, Interface, Wallet, keccak256, type InterfaceAbi } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { paymentAllocationSetHash, type PaymentPolicySnapshot } from '../api/payment-policy.ts';
import { AbiEventDecoder, type DecodedDomainEvent, type IndexedLog } from './abi-decoder.ts';
import { RemoteExecutorClient } from './executor.ts';
import {
  RpcBeneficiarySnapshotSource,
  RpcPaymentOracleQuoteSource,
  RpcPaymentPolicyAttestationSource,
  RpcWalletMessageSignatureVerifier,
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
import { PollingPaymentIndexer, type PaymentChainSource } from './payment-indexer-worker.ts';
import {
  PaymentRuntimeReadinessMonitor,
  RpcPaymentRuntimeAttestor,
  type RuntimeCodeReader,
} from './runtime-readiness.ts';
import { scheduleFulfillmentJobs } from './scheduler.ts';
import { RemoteSignerClient } from './signer.ts';

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
    ORDER_ID, BUYER, MERCHANT, 0, 1, 100, 70, 300, 200, 100, 100, HASH_2, HASH_3,
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
  }]);
  const store = new MemoryIndexerStore();
  const worker = new PollingPaymentIndexer({
    source,
    indexer: new ChainIndexer(decoder, store),
    store,
    deploymentBlock: 100,
    batchSize: 16,
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

test('payment RPC sources enforce the frozen Oracle and beneficiary snapshot rules', async () => {
  const now = 1_800_000_000;
  const reader = new StubContractReader({
    pair: '0x2955e33bb120714abf11ace2766e614e6e5955b2',
    consult: [1_000n, 50_000n * 10n ** 18n, BigInt(now)],
    referrerOf: MERCHANT,
    regionBeneficiaries: [
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
      '0x5555555555555555555555555555555555555555',
      '0x6666666666666666666666666666666666666666',
    ],
    isGenesisEligible: true,
  });
  const oracle = new RpcPaymentOracleQuoteSource({
    reader,
    sourceAddress: CONTRACT,
    clock: () => new Date(now * 1000),
  });
  assert.deepEqual(await oracle.quote({ listPriceUsdt: 100n, policyVersion: 1, oracleVersion: HASH_1 }), {
    nplQuoteAmount: 1_000n,
    oracleVersion: HASH_1,
  });
  const beneficiaries = new RpcBeneficiarySnapshotSource({ reader, beneficiaryRegistryAddress: CONTRACT });
  assert.deepEqual(await beneficiaries.resolve({
    buyer: BUYER,
    merchant: MERCHANT,
    regionCodeHash: HASH_1,
    policyVersion: 1,
  }), {
    genesis: BUYER,
    directReferral: MERCHANT,
    district: '0x3333333333333333333333333333333333333333',
    city: '0x4444444444444444444444444444444444444444',
    province: '0x5555555555555555555555555555555555555555',
    region: '0x6666666666666666666666666666666666666666',
  });

  const stale = new RpcPaymentOracleQuoteSource({
    reader: new StubContractReader({
      pair: '0x2955e33bb120714abf11ace2766e614e6e5955b2',
      consult: [1_000n, 50_000n * 10n ** 18n, BigInt(now - 601)],
    }),
    sourceAddress: CONTRACT,
    clock: () => new Date(now * 1000),
  });
  await assert.rejects(
    stale.quote({ listPriceUsdt: 100n, policyVersion: 1, oracleVersion: HASH_1 }),
    /stale/,
  );
});

test('payment policy attestation binds all 33 Registry fields and latest-version semantics', async () => {
  const policy = paymentPolicySnapshot();
  const operationAccounts = policy.operationsDestinations.map((item) => item.account);
  const operationWeights = policy.operationsDestinations.map((item) => BigInt(item.weightBps));
  const beneficiarySetHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]', 'uint16[]'],
    [operationAccounts, operationWeights],
  ));
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

  await assert.rejects(
    source.assertPublished({ ...input, artifactVersion: '2.0.0-payment.stale' }),
    /artifact version/,
  );
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
    ['usdtCustodySafe', 22, '0x9999999999999999999999999999999999999999'],
    ['concessionDestinationSetHash', 30, HASH_2],
    ['rulesContentHash', 32, HASH_2],
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
    /operationsHash/,
  );
});

test('ERC-1271 verifier accepts only the contract-wallet magic value and fails closed on RPC errors', async () => {
  const valid = new RpcWalletMessageSignatureVerifier(new StubContractReader({
    isValidSignature: '0x1626ba7e',
  }));
  assert.equal(await valid.isValid(CONTRACT, 'SIWE message', '0x1234'), true);
  const invalid = new RpcWalletMessageSignatureVerifier(new StubContractReader({
    isValidSignature: '0xffffffff',
  }));
  assert.equal(await invalid.isValid(CONTRACT, 'SIWE message', '0x1234'), false);
  assert.equal(
    await new RpcWalletMessageSignatureVerifier(new StubContractReader({})).isValid(CONTRACT, 'SIWE message', '0x1234'),
    false,
  );
});

test('runtime readiness attests deployed code, bindings, roles, Oracle source and live infrastructure', async () => {
  const router = '0x1000000000000000000000000000000000000001';
  const policyRegistry = '0x1000000000000000000000000000000000000002';
  const beneficiaryRegistry = '0x1000000000000000000000000000000000000003';
  const oracle = '0x1000000000000000000000000000000000000004';
  const twapSource = '0x1000000000000000000000000000000000000005';
  const governanceSafe = '0x1000000000000000000000000000000000000006';
  const usdtSafe = '0x1000000000000000000000000000000000000007';
  const nplSafe = '0x1000000000000000000000000000000000000008';
  const operationsSafe = '0x1000000000000000000000000000000000000009';
  const secondarySigner = '0x1000000000000000000000000000000000000010';
  const quoteSigner = '0x1000000000000000000000000000000000000011';
  const runtimeCode = '0x6001600055';
  const runtimeCodeHash = keccak256(runtimeCode);
  const values: Record<string, unknown> = {
    [`${router}:usdt`]: '0x55d398326f99059ff775485246999027b3197955',
    [`${router}:npl`]: '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    [`${router}:policyRegistry`]: policyRegistry,
    [`${router}:beneficiaryRegistry`]: beneficiaryRegistry,
    [`${router}:oracle`]: oracle,
    [`${router}:governanceSafe`]: governanceSafe,
    [`${router}:usdtCustodySafe`]: usdtSafe,
    [`${router}:nplRewardSafe`]: nplSafe,
    [`${router}:operationsTreasurySafe`]: operationsSafe,
    [`${router}:quoteSigner`]: quoteSigner,
    [`${policyRegistry}:safe`]: governanceSafe,
    [`${policyRegistry}:secondarySigner`]: secondarySigner,
    [`${beneficiaryRegistry}:policyRegistry`]: policyRegistry,
    [`${oracle}:source`]: twapSource,
    [`${twapSource}:pair`]: '0x2955e33bb120714abf11ace2766e614e6e5955b2',
    hasRole: true,
  };
  const reader = new StubRuntimeReader(values, runtimeCode);
  const deployments = [router, policyRegistry, beneficiaryRegistry, oracle].map((address, index) => ({
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
    oracle,
    twapSource,
    twapSourceCodeHash: runtimeCodeHash,
    governanceSafe,
    usdtCustodySafe: usdtSafe,
    nplRewardSafe: nplSafe,
    operationsTreasurySafe: operationsSafe,
    secondarySigner,
    quoteSigner,
  });
  assert.deepEqual(await attestor.attest(), {
    deployedRuntimeCodeVerified: true,
    roleGrantsVerified: true,
    safeAdminVerified: true,
    signerBindingsVerified: true,
    oracleDeploymentVerified: true,
    rpcChain56Healthy: true,
  });

  let indexerHealthy = false;
  const now = new Date('2026-07-14T00:00:00.000Z');
  const monitor = new PaymentRuntimeReadinessMonitor({
    attest: () => attestor.attest(),
    componentHashesVerified: async () => true,
    databaseHealthy: async () => true,
    redisHealthy: async () => true,
    signerHealthy: async () => true,
    indexerStatus: () => ({ healthy: indexerHealthy, caughtUp: indexerHealthy }),
    clock: () => now,
    intervalMs: 10,
  });
  assert.equal((await monitor.pollOnce()).indexerHealthy, false);
  indexerHealthy = true;
  assert.equal(monitor.snapshot()?.indexerHealthy, true);
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
        paidAt,
        takeoverOpened: false,
      },
      {
        orderId: 'pickup-order',
        fulfillmentMode: 'PICKUP',
        state: 'PAID',
        paidAt,
        takeoverOpened: false,
      },
      {
        orderId: 'delivered-order',
        fulfillmentMode: 'DELIVERY',
        state: 'DELIVERED',
        paidAt,
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

  constructor(blocks: ChainBlock[], logs: IndexedLog[]) {
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
    return block;
  }

  async logs(fromBlock: number, toBlock: number) {
    this.logRanges.push([fromBlock, toBlock]);
    return [...this.logsByBlock.entries()]
      .filter(([blockNumber]) => blockNumber >= fromBlock && blockNumber <= toBlock)
      .flatMap(([, logs]) => logs);
  }
}

function blockHash(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}`;
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
}

class StubRuntimeReader implements RuntimeCodeReader {
  readonly #values: Record<string, unknown>;
  readonly #code: string;

  constructor(values: Record<string, unknown>, code: string) {
    this.#values = values;
    this.#code = code;
  }

  async call(address: string, _abi: InterfaceAbi, method: string) {
    const key = `${address.toLowerCase()}:${method}`;
    if (key in this.#values) return this.#values[key];
    if (method in this.#values) return this.#values[method];
    throw new Error(`Unexpected method ${key}`);
  }

  async chainId() {
    return 56;
  }

  async code() {
    return this.#code;
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

function paymentPolicySnapshot(): PaymentPolicySnapshot {
  const concessionDestinations = [
    { account: '0x7000000000000000000000000000000000000001', weightBps: 4_000 },
    { account: '0x7000000000000000000000000000000000000002', weightBps: 6_000 },
  ];
  const otherUsdtDestinations = [
    { account: '0x7000000000000000000000000000000000000003', weightBps: 10_000 },
  ];
  return {
    policyVersion: 1,
    oracleVersion: HASH_1,
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
    platformFeeBps: 500,
    seckillPrizeBps: 1_000,
    seckillMainDuration: 3_600,
    relayInitial: 60,
    relayIncrement: 30,
    relayCap: 60,
    oracleWindowSeconds: 1_800,
    oracleMaxDeviationBps: 500,
    oracleMaxAgeSeconds: 600,
    oracleMinimumUsdtLiquidity: 50_000n * 10n ** 18n,
    requiredConfirmations: 15,
    merchantGuaranteeMinimumUsdt: 1_000n * 10n ** 18n,
    usdtCustodySafe: '0x3333333333333333333333333333333333333333',
    nplRewardSafe: '0x4444444444444444444444444444444444444444',
    operationsTreasurySafe: '0x5555555555555555555555555555555555555555',
    circulationPool: '0x6000000000000000000000000000000000000001',
    genesisCredential: '0x6000000000000000000000000000000000000002',
    genesisTokenId: 1n,
    genesisCredentialStandard: 1,
    concessionDestinationSetHash: paymentAllocationSetHash(concessionDestinations, otherUsdtDestinations),
    decisionEvidenceHash: HASH_2,
    concessionDestinations,
    operationsDestinations: [
      { account: '0x5000000000000000000000000000000000000007', weightBps: 4_000 },
      { account: '0x5000000000000000000000000000000000000008', weightBps: 6_000 },
    ],
    otherUsdtDestinations,
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
    policy.oracleVersion,
    policy.oracleMaxAgeSeconds,
    policy.oracleMinimumUsdtLiquidity,
    policy.merchantGuaranteeMinimumUsdt,
    policy.usdtCustodySafe,
    policy.nplRewardSafe,
    policy.operationsTreasurySafe,
    policy.circulationPool,
    policy.genesisCredential,
    policy.genesisTokenId,
    policy.genesisCredentialStandard,
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

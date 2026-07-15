import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AbiCoder, Interface, Wallet, keccak256, toUtf8Bytes, type InterfaceAbi } from 'ethers';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../api/enums.ts';
import { paymentAllocationSetHash, type PaymentPolicySnapshot } from '../api/payment-policy.ts';
import { AbiEventDecoder, type DecodedDomainEvent, type IndexedLog } from './abi-decoder.ts';
import { BnmAvailabilityWorker, HttpBnmAvailabilityAdapter } from './bnm-availability-worker.ts';
import { FulfillmentSchedulerWorker } from './fulfillment-scheduler-worker.ts';
import { ResilientBscGuaranteeDepositSource } from './guarantee-deposit-worker.ts';
import type { GuaranteeDepositFinalityItem } from '../data/guarantee-deposit-service.ts';
import { HttpTakeoverFundingSafeApprover } from './takeover-funding-governance.ts';
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
import type { SqlExecutor, SqlTransactionRunner } from '../data/migrations.ts';
import {
  HttpSafeApprovalVerifier,
  HttpSafeSettlementBroadcaster,
  ResilientBscSafeSettlementChainSource,
  reconcileTransactionBalanceDeltas,
} from './safe-settlement-adapters.ts';
import {
  RpcSafeRuntimeAttestor,
  emptySafeModulesHash,
  zeroSafeAddress,
} from './safe-runtime-attestor.ts';
import {
  MULTISEND_CALL_ONLY_ADDRESS,
  MULTISEND_CALL_ONLY_CODE_HASH,
  SAFE_L2_SINGLETON_ADDRESS,
  SAFE_L2_SINGLETON_CODE_HASH,
} from './safe-multisend.ts';
import {
  HttpRpcPolicyChainSource,
  type PolicyFinalityCandidate,
} from './policy-publication-worker.ts';
import {
  coverageBreakerSafeTxHash,
  HttpCoverageBreakerSafeProposer,
  ResilientCoverageBreakerChainSource,
  type CoverageBreakerFinalityCandidate,
} from './coverage-breaker-governance.ts';
import {
  HttpSeckillSafeProposer,
  ResilientSeckillChainSource,
  seckillSafeTxHash,
  type SeckillFinalityCandidate,
  type SeckillSafeProposal,
} from './seckill-governance.ts';
import { LogisticsPrintWorker } from './logistics-print-worker.ts';

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

test('Safe runtime attestation binds owners, modules, guard, fallback and deployment code hashes', async () => {
  const owners = [
    '0x1000000000000000000000000000000000000002',
    '0x1000000000000000000000000000000000000001',
  ];
  const ownerSetHash = keccak256(toUtf8Bytes(JSON.stringify({ owners: owners.slice().sort(), threshold: 2 })));
  const reader = {
    chainId: async () => 56,
    codeHash: async (address: string) => {
      const normalized = address.toLowerCase();
      if (normalized === CONTRACT) return HASH_1;
      if (normalized === SAFE_L2_SINGLETON_ADDRESS) return SAFE_L2_SINGLETON_CODE_HASH;
      if (normalized === MULTISEND_CALL_ONLY_ADDRESS) return MULTISEND_CALL_ONLY_CODE_HASH;
      if (normalized === MERCHANT) return HASH_2;
      throw new Error('unknown runtime');
    },
    call: async (_address: string, _abi: InterfaceAbi, method: string) => {
      if (method === 'VERSION') return '1.4.1';
      if (method === 'masterCopy') return SAFE_L2_SINGLETON_ADDRESS;
      if (method === 'getOwners') return owners;
      if (method === 'getThreshold') return 2n;
      if (method === 'nonce') return 7n;
      if (method === 'getModulesPaginated') return [[], '0x0000000000000000000000000000000000000001'];
      if (method === 'getStorageAt') return `0x${'0'.repeat(64)}`;
      throw new Error(`unexpected ${method}`);
    },
  };
  const expected = {
    safeAddress: CONTRACT,
    safeProxyCodeHash: HASH_1,
    ownerSetHash,
    threshold: 2,
    guardAddress: zeroSafeAddress,
    fallbackHandlerAddress: zeroSafeAddress,
    modulesHash: emptySafeModulesHash,
    tokenAddress: MERCHANT,
    tokenCodeHash: HASH_2,
    tokenTransferConformanceEvidenceHash: HASH_3,
  };
  const attested = await new RpcSafeRuntimeAttestor({ reader, expected }).attest();
  assert.equal(attested.safeNonce, '7');
  assert.equal(attested.ownerSetHash, ownerSetHash);
  assert.equal(attested.multisendCodeHash, MULTISEND_CALL_ONLY_CODE_HASH);
  await assert.rejects(
    new RpcSafeRuntimeAttestor({ reader, expected: { ...expected, ownerSetHash: HASH_3 } }).attest(),
    /does not match governed expectations/,
  );
});

test('Safe approval and broadcaster adapters require HTTPS mTLS and echo-bound envelopes', async () => {
  assert.throws(
    () => new HttpSafeApprovalVerifier({ url: 'http://unsafe.invalid', token: 'token', mutualTls: true }),
    /requires HTTPS/,
  );
  assert.throws(
    () => new ResilientBscSafeSettlementChainSource({ primaryRpcUrl: 'https://rpc.invalid' }),
    /Two BSC RPC/,
  );
  assert.throws(
    () => new ResilientBscSafeSettlementChainSource({
      primaryRpcUrl: 'https://rpc.invalid',
      fallbackRpcUrl: 'https://rpc.invalid',
    }),
    /independent BSC RPC/,
  );
  assert.throws(
    () => new ResilientBscSafeSettlementChainSource({
      primaryRpcUrl: 'http://primary.invalid',
      fallbackRpcUrl: 'wss://fallback.invalid',
    }),
    /require HTTPS/,
  );
  const approval = new HttpSafeApprovalVerifier({
    url: 'https://approvals.example.invalid/v1/verify',
    token: 'approval-token',
    mutualTls: true,
    fetch: async () => new Response(JSON.stringify({
      safeAddress: CONTRACT,
      safeTxHash: HASH_1,
      ownerSetHash: HASH_2,
      threshold: 2,
      proposalReferenceHash: HASH_2,
      approvalEvidenceHash: HASH_3,
      packedSignatures: '0x1122',
      approvals: [
        { ownerAddress: BUYER, signature: '0x11' },
        { ownerAddress: MERCHANT, signature: '0x22' },
      ],
    }), { status: 200 }),
  });
  assert.equal((await approval.verify({
    batchId: ORDER_ID,
    safeAddress: CONTRACT,
    safeTxHash: HASH_1,
    signingData: '0x1901',
    ownerSetHash: HASH_2,
    threshold: 2,
  })).approvals.length, 2);

  let requestBody: Record<string, unknown> | undefined;
  const broadcaster = new HttpSafeSettlementBroadcaster({
    url: 'https://executor.example.invalid/v1/safe',
    token: 'executor-token',
    mutualTls: true,
    maxOuterGasLimit: 1_000_000n,
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        executionTxHash: HASH_3,
        outerSender: BUYER,
        outerNonce: '9',
        requestDigest: requestBody.requestDigest,
        ...(requestBody.replacementForExecutionTxHash
          ? { replacementForExecutionTxHash: requestBody.replacementForExecutionTxHash }
          : {}),
      }), { status: 200 });
    },
  });
  const submitted = await broadcaster.submit({
    chainId: 56,
    batchId: ORDER_ID,
    safeAddress: CONTRACT,
    safeNonce: '7',
    safeTxHash: HASH_1,
    contentHash: HASH_2,
    execTransactionCalldata: '0x11223344',
    requestDigest: HASH_3,
    idempotencyKey: 'settlement-attempt:1',
    outerGasLimit: '1000000',
  });
  assert.equal(submitted.executionTxHash, HASH_3);
  assert.equal(requestBody?.safeTxHash, HASH_1);
  const replacement = await broadcaster.replace({
    chainId: 56,
    batchId: ORDER_ID,
    safeAddress: CONTRACT,
    safeNonce: '7',
    safeTxHash: HASH_1,
    contentHash: HASH_2,
    execTransactionCalldata: '0x11223344',
    requestDigest: HASH_3,
    idempotencyKey: 'settlement-attempt:2',
    outerGasLimit: '1000000',
    replacementForAttemptId: 'settlement-attempt:1',
    replacementForExecutionTxHash: HASH_2,
    outerSender: BUYER,
    outerNonce: '9',
  });
  assert.equal(replacement.replacementForExecutionTxHash, HASH_2);
  assert.equal(requestBody?.outerNonce, '9');
  await assert.rejects(
    broadcaster.replace({
      chainId: 56,
      batchId: ORDER_ID,
      safeAddress: CONTRACT,
      safeNonce: '7',
      safeTxHash: HASH_1,
      contentHash: HASH_2,
      execTransactionCalldata: '0x11223344',
      requestDigest: HASH_3,
      idempotencyKey: 'settlement-attempt:3',
      outerGasLimit: '1000000',
      replacementForAttemptId: 'settlement-attempt:2',
      replacementForExecutionTxHash: HASH_3,
      outerSender: BUYER,
      outerNonce: '10',
    }),
    /did not bind/,
  );
});

test('Safe settlement balance evidence excludes unrelated same-block token transfers', () => {
  const token = USDT_ADDRESS.toLowerCase();
  const safe = CONTRACT.toLowerCase();
  const recipient = BUYER.toLowerCase();
  const attacker = MERCHANT.toLowerCase();
  assert.deepEqual(reconcileTransactionBalanceDeltas([
    { tokenAddress: token, account: safe, delta: -99n },
    { tokenAddress: token, account: recipient, delta: 101n },
  ], [
    { tokenAddress: token, from: attacker, to: safe, amount: '1' },
    { tokenAddress: token, from: attacker, to: recipient, amount: '1' },
  ]), [
    { tokenAddress: token, account: safe, delta: '-100' },
    { tokenAddress: token, account: recipient, delta: '100' },
  ]);
});

test('takeover Safe approver rejects malformed owner evidence with a controlled finality error', async () => {
  const input = {
    caseId: 'takeover-case-1',
    policyVersion: 1,
    governanceSafeAddress: CONTRACT,
    operationsSafeAddress: '0x5555555555555555555555555555555555555555',
    actionDigest: HASH_1,
    oldValueHash: HASH_2,
    newValueHash: HASH_3,
  };
  const approver = new HttpTakeoverFundingSafeApprover({
    url: 'https://takeover-safe.example.invalid/verify',
    token: 'takeover-safe-token',
    mutualTls: true,
    fetchImpl: async () => jsonResponse({
      ...input,
      safeTxHash: HASH_1,
      proposalReferenceHash: HASH_2,
      approvalEvidenceHash: HASH_3,
      ownerSetHash: HASH_1,
      threshold: 1,
      approvals: [{ ownerAddress: 'not-an-address', signature: '0x11' }],
    }),
  });
  await assert.rejects(approver.verify(input), /Safe owner approval is malformed/);
});

test('policy RPC finality binds BSC, semantic receipts, canonical blocks and 14/15 confirmations', async () => {
  const harness = policyRpcHarness();
  const source = policyChainSource(harness.fetch);
  harness.state.head = 113;
  const mined = await source.observe(policyFinalityCandidate());
  assert.equal(mined.state, 'MINED');
  if (mined.state !== 'MINED') throw new Error('ExpectedMinedPolicy');
  assert.equal(mined.confirmations, 14);
  assert.equal(mined.executionTxHash, harness.executionTxHash);

  harness.state.head = 114;
  const finalized = await source.observe(policyFinalityCandidate());
  assert.equal(finalized.state, 'FINAL');
  if (finalized.state !== 'FINAL') throw new Error('ExpectedFinalPolicy');
  assert.equal(finalized.confirmations, 15);
  assert.equal(finalized.blockHash, harness.minedBlockHash);
});

test('policy RPC finality fails closed on chain, receipt, transaction and provider disagreement', async () => {
  const cases: Array<[string, (harness: ReturnType<typeof policyRpcHarness>) => void]> = [
    ['wrong chain', (harness) => { harness.state.primaryChainId = 1; }],
    ['one missing receipt', (harness) => { harness.state.fallbackReceiptMissing = true; }],
    ['wrong transaction', (harness) => { harness.state.fallbackTransactionHash = HASH_2; }],
    ['failed transaction', (harness) => { harness.state.receiptStatus = '0x0'; }],
    ['receipt block disagreement', (harness) => { harness.state.fallbackReceiptBlockHash = HASH_2; }],
    ['canonical provider disagreement', (harness) => { harness.state.fallbackCanonicalBlockHash = HASH_2; }],
  ];
  for (const [name, mutate] of cases) {
    const harness = policyRpcHarness();
    mutate(harness);
    await assert.rejects(policyChainSource(harness.fetch).observe(policyFinalityCandidate()), () => true, name);
  }
});

test('policy RPC finality distinguishes pending execution from a proven deep reorg', async () => {
  const harness = policyRpcHarness();
  harness.state.primaryReceiptMissing = true;
  harness.state.fallbackReceiptMissing = true;
  const source = policyChainSource(harness.fetch);
  assert.deepEqual(await source.observe(policyFinalityCandidate()), { state: 'NOT_FOUND' });

  const previous = {
    executionTxHash: harness.executionTxHash,
    blockNumber: 100,
    blockHash: harness.minedBlockHash,
  };
  harness.state.primaryCanonicalBlockHash = harness.replacementBlockHash;
  harness.state.fallbackCanonicalBlockHash = harness.replacementBlockHash;
  const reorged = await source.observe({
    ...policyFinalityCandidate(),
    priorState: 'PUBLISHED',
    priorFinality: previous,
  });
  assert.equal(reorged.state, 'REORGED');
  if (reorged.state !== 'REORGED') throw new Error('ExpectedReorgedPolicy');
  assert.equal(reorged.blockHash, harness.minedBlockHash);
  assert.equal(reorged.canonicalBlockHash, harness.replacementBlockHash);

  assert.deepEqual(await source.observe({
    ...policyFinalityCandidate(),
    priorState: 'REORGED',
    priorFinality: previous,
  }), { state: 'NOT_FOUND' });
});

test('coverage breaker proposer and dual-RPC finality bind Safe, Router event, state and 14/15 confirmations', async () => {
  const candidate = coverageBreakerCandidate();
  let proposedBody: Record<string, unknown> | undefined;
  const proposer = new HttpCoverageBreakerSafeProposer({
    url: 'https://safe-proposer.example.invalid/coverage-breaker',
    token: 'safe-token',
    mutualTls: true,
    fetchImpl: async (_input, init) => {
      proposedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const safeNonce = '7';
      return jsonResponse({
        safeNonce,
        safeTxHash: coverageBreakerSafeTxHash(candidate, safeNonce),
        proposalHash: HASH_3,
        dataHash: candidate.calldataHash,
        resourceId: candidate.actionId,
        targetPaused: true,
        evidenceHash: candidate.evidenceHash,
        policyVersion: 1,
        minimumSafeNonce: candidate.minimumSafeNonce,
      });
    },
  });
  assert.deepEqual(await proposer.propose(candidate), {
    safeNonce: '7',
    safeTxHash: coverageBreakerSafeTxHash(candidate, '7'),
    proposalHash: HASH_3,
  });
  assert.equal(proposedBody?.to, candidate.routerAddress);
  assert.equal(proposedBody?.safeAddress, candidate.safeAddress);
  assert.equal(proposedBody?.minimumSafeNonce, candidate.minimumSafeNonce);

  await assert.rejects(
    new HttpCoverageBreakerSafeProposer({
      url: 'https://safe-proposer.example.invalid/coverage-breaker',
      token: 'safe-token',
      mutualTls: true,
      fetchImpl: async () => jsonResponse({
        safeNonce: '7',
        safeTxHash: HASH_2,
        proposalHash: HASH_3,
        dataHash: candidate.calldataHash,
        resourceId: candidate.actionId,
        targetPaused: true,
        evidenceHash: candidate.evidenceHash,
        policyVersion: 1,
        minimumSafeNonce: candidate.minimumSafeNonce,
      }),
    }).propose(candidate),
    /hash does not match its nonce/,
  );

  const harness = coverageBreakerRpcHarness();
  const source = coverageBreakerChainSource(harness.fetch);
  harness.state.head = 113;
  const mined = await source.observe(candidate);
  assert.equal(mined.state, 'MINED');
  if (mined.state !== 'MINED') throw new Error('ExpectedMinedCoverageBreaker');
  assert.equal(mined.confirmations, 14);

  harness.state.head = 114;
  const finalized = await source.observe(candidate);
  assert.equal(finalized.state, 'FINAL');
  if (finalized.state !== 'FINAL') throw new Error('ExpectedFinalCoverageBreaker');
  assert.equal(finalized.confirmations, 15);
  assert.equal(finalized.targetPaused, true);

  harness.state.receiptStatus = '0x0';
  const failed = await source.observe(candidate);
  assert.equal(failed.state, 'FAILED');
});

test('coverage breaker finality fails closed on wrong authority, event, Router state and provider disagreement', async () => {
  const cases: Array<[string, (harness: ReturnType<typeof coverageBreakerRpcHarness>) => void]> = [
    ['wrong chain', (harness) => { harness.state.primaryChainId = 1; }],
    ['wrong Safe', (harness) => { harness.state.transactionTo = MERCHANT; }],
    ['wrong event evidence', (harness) => { harness.state.eventEvidenceHash = HASH_2; }],
    ['wrong Router state', (harness) => { harness.state.routerPaused = false; }],
    ['receipt disagreement', (harness) => { harness.state.fallbackReceiptBlockHash = HASH_2; }],
    ['canonical disagreement', (harness) => { harness.state.fallbackCanonicalBlockHash = HASH_2; }],
  ];
  for (const [name, mutate] of cases) {
    const harness = coverageBreakerRpcHarness();
    mutate(harness);
    await assert.rejects(
      coverageBreakerChainSource(harness.fetch).observe(coverageBreakerCandidate()),
      () => true,
      name,
    );
  }
});

test('coverage breaker network adapters time out black-hole proposal, lookup and RPC requests', async () => {
  const blackHole: typeof fetch = async () => new Promise<Response>(() => undefined);
  const candidate = coverageBreakerCandidate();
  await assert.rejects(
    new HttpCoverageBreakerSafeProposer({
      url: 'https://safe-proposer.example.invalid/coverage-breaker',
      token: 'safe-token',
      mutualTls: true,
      fetchImpl: blackHole,
      requestTimeoutMs: 5,
    }).propose(candidate),
    /timed out/,
  );
  const blackHoleBody: typeof fetch = async () => new Response(
    new ReadableStream({ start() { /* Response headers arrive, body never completes. */ } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  await assert.rejects(
    new HttpCoverageBreakerSafeProposer({
      url: 'https://safe-proposer.example.invalid/coverage-breaker',
      token: 'safe-token',
      mutualTls: true,
      fetchImpl: blackHoleBody,
      requestTimeoutMs: 5,
    }).propose(candidate),
    /timed out/,
  );
  await assert.rejects(
    new ResilientCoverageBreakerChainSource({
      lookupUrl: 'https://safe-lookup.example.invalid/coverage-breaker',
      lookupToken: 'lookup-token',
      primaryRpcUrl: 'https://coverage-primary-rpc.example.invalid',
      fallbackRpcUrl: 'https://coverage-fallback-rpc.example.invalid',
      fetchImpl: blackHole,
      requestTimeoutMs: 5,
    }).observe(candidate),
    /timed out/,
  );
  const rpcBlackHole: typeof fetch = async (input) => {
    if (String(input).startsWith('https://safe-lookup.example.invalid')) {
      return jsonResponse({
        safeTxHash: candidate.safeTxHash,
        resourceId: candidate.actionId,
        executionTxHash: HASH_3,
      });
    }
    return new Promise<Response>(() => undefined);
  };
  await assert.rejects(
    new ResilientCoverageBreakerChainSource({
      lookupUrl: 'https://safe-lookup.example.invalid/coverage-breaker',
      lookupToken: 'lookup-token',
      primaryRpcUrl: 'https://coverage-primary-rpc.example.invalid',
      fallbackRpcUrl: 'https://coverage-fallback-rpc.example.invalid',
      fetchImpl: rpcBlackHole,
      requestTimeoutMs: 5,
    }).observe(candidate),
    /timed out/,
  );
});

test('seckill Safe proposer and dual-RPC finality bind session open, breaker and prize transfer evidence', async () => {
  const open = seckillCandidate('OPEN_SESSION');
  let proposedBody: Record<string, unknown> | undefined;
  const proposer = new HttpSeckillSafeProposer({
    url: 'https://safe-proposer.example.invalid/seckill',
    token: 'safe-token',
    mutualTls: true,
    fetchImpl: async (_input, init) => {
      proposedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const safeNonce = '9';
      return jsonResponse({
        safeNonce,
        safeTxHash: seckillSafeTxHash(open, safeNonce),
        proposalHash: HASH_3,
        dataHash: open.calldataHash,
        resourceId: open.actionId,
        sessionId: open.sessionId,
        actionKind: open.actionKind,
        policyVersion: open.policyVersion,
        evidenceHash: open.evidenceHash,
        minimumSafeNonce: open.minimumSafeNonce,
      });
    },
  });
  assert.deepEqual(await proposer.propose(open), {
    safeNonce: '9',
    safeTxHash: seckillSafeTxHash(open, '9'),
    proposalHash: HASH_3,
  });
  assert.equal(proposedBody?.to, open.targetAddress);
  assert.equal(proposedBody?.sessionId, open.sessionId);
  assert.equal(proposedBody?.actionKind, 'OPEN_SESSION');

  for (const kind of ['OPEN_SESSION', 'FORCE_CLOSE', 'PRIZE_INJECTION'] as const) {
    const candidate = seckillCandidate(kind);
    const harness = seckillRpcHarness(candidate);
    const source = new ResilientSeckillChainSource({
      lookupUrl: 'https://safe-lookup.example.invalid/seckill',
      lookupToken: 'lookup-token',
      primaryRpcUrl: 'https://seckill-primary-rpc.example.invalid',
      fallbackRpcUrl: 'https://seckill-fallback-rpc.example.invalid',
      fetchImpl: harness.fetch,
    });
    const finalized = await source.observe(candidate);
    assert.equal(finalized.state, 'FINAL', kind);
    if (finalized.state !== 'FINAL') throw new Error(`ExpectedFinalSeckill${kind}`);
    assert.equal(finalized.confirmations, 15);
    assert.equal(finalized.actionKind, kind);
  }

  const wrongPrize = seckillCandidate('PRIZE_INJECTION');
  const wrongPrizeHarness = seckillRpcHarness(wrongPrize);
  wrongPrizeHarness.state.prizeAmount = '51';
  await assert.rejects(
    new ResilientSeckillChainSource({
      lookupUrl: 'https://safe-lookup.example.invalid/seckill',
      lookupToken: 'lookup-token',
      primaryRpcUrl: 'https://seckill-primary-rpc.example.invalid',
      fallbackRpcUrl: 'https://seckill-fallback-rpc.example.invalid',
      fetchImpl: wrongPrizeHarness.fetch,
    }).observe(wrongPrize),
    /exactly one matching USDT Transfer/,
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
  assert.equal(mined.to, guaranteeFinalityItem().operationsSafeAddress);
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
  harness.state.transferRecipient = guaranteeFinalityItem().operationsSafeAddress;

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

function guaranteeFinalityItem(): GuaranteeDepositFinalityItem {
  return {
    depositId: 'guarantee-deposit:rpc-test',
    merchantId: 'merchant-1',
    merchantWallet: MERCHANT,
    policyVersion: 1,
    tokenAddress: USDT_ADDRESS,
    operationsSafeAddress: '0x5555555555555555555555555555555555555555',
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
    transferRecipient: guaranteeFinalityItem().operationsSafeAddress,
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

function policyFinalityCandidate(): PolicyFinalityCandidate {
  return {
    draftId: 'policy-draft-1',
    policyVersion: 2,
    safeTxHash: `0x${'5'.repeat(64)}`,
    policyRegistryAddress: CONTRACT,
    policyHash: HASH_1,
    operationsHash: HASH_2,
    decisionEvidenceHash: HASH_3,
    safeAddress: BUYER,
    priorState: 'SAFE_PROPOSED',
  };
}

function policyChainSource(fetchImpl: typeof fetch) {
  return new HttpRpcPolicyChainSource({
    lookupUrl: 'https://safe-lookup.example.invalid/policy',
    lookupToken: 'lookup-token',
    primaryRpcUrl: 'https://primary-rpc.example.invalid',
    fallbackRpcUrl: 'https://fallback-rpc.example.invalid',
    fetchImpl,
  });
}

function policyRpcHarness() {
  const executionTxHash = `0x${'4'.repeat(64)}`;
  const minedBlockHash = `0x${'6'.repeat(64)}`;
  const replacementBlockHash = `0x${'7'.repeat(64)}`;
  const iface = new Interface([
    'event PolicyPublished(uint64 indexed version,bytes32 indexed policyHash,bytes32 indexed operationsHash,bytes32 decisionEvidenceHash,address safeExecutor)',
  ]);
  const event = iface.getEvent('PolicyPublished');
  if (!event) throw new Error('MissingPolicyPublishedEvent');
  const encoded = iface.encodeEventLog(event, [2, HASH_1, HASH_2, HASH_3, BUYER]);
  const state = {
    primaryChainId: 56,
    fallbackChainId: 56,
    head: 114,
    primaryReceiptMissing: false,
    fallbackReceiptMissing: false,
    receiptStatus: '0x1',
    fallbackTransactionHash: executionTxHash,
    fallbackReceiptBlockHash: minedBlockHash,
    primaryCanonicalBlockHash: minedBlockHash,
    fallbackCanonicalBlockHash: minedBlockHash,
  };
  const log = { address: CONTRACT, topics: encoded.topics, data: encoded.data };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://safe-lookup.example.invalid')) {
      return jsonResponse({
        safeTxHash: policyFinalityCandidate().safeTxHash,
        resourceId: policyFinalityCandidate().draftId,
        executionTxHash,
      });
    }
    const primary = url.startsWith('https://primary-rpc.example.invalid');
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'eth_chainId') {
      result = `0x${(primary ? state.primaryChainId : state.fallbackChainId).toString(16)}`;
    } else if (request.method === 'eth_blockNumber') {
      result = `0x${state.head.toString(16)}`;
    } else if (request.method === 'eth_getBlockByNumber') {
      result = { hash: primary ? state.primaryCanonicalBlockHash : state.fallbackCanonicalBlockHash };
    } else if (request.method === 'eth_getTransactionReceipt') {
      const missing = primary ? state.primaryReceiptMissing : state.fallbackReceiptMissing;
      result = missing
        ? null
        : primary
          ? {
            transactionHash: executionTxHash,
            status: state.receiptStatus,
            blockHash: minedBlockHash,
            blockNumber: '0x64',
            logs: [log],
            providerExtension: 'primary-only',
          }
          : {
            logs: [{ data: log.data, topics: log.topics, address: log.address }],
            blockNumber: '0x64',
            blockHash: state.fallbackReceiptBlockHash,
            status: state.receiptStatus,
            transactionHash: state.fallbackTransactionHash,
            providerExtension: 'fallback-only',
          };
    } else {
      throw new Error(`UnexpectedPolicyRpcMethod:${request.method}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, result });
  };
  return { state, fetch: fetchImpl, executionTxHash, minedBlockHash, replacementBlockHash };
}

function coverageBreakerCandidate(): CoverageBreakerFinalityCandidate {
  const iface = new Interface(['function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)']);
  const calldata = iface.encodeFunctionData('setNewPaymentsPaused', [true, HASH_1]).toLowerCase();
  const proposal = {
    actionId: ORDER_ID,
    safeAddress: BUYER,
    routerAddress: CONTRACT,
    calldata,
    calldataHash: keccak256(calldata).toLowerCase(),
    targetPaused: true,
    evidenceHash: HASH_1,
    policyVersion: 1,
    minimumSafeNonce: '7',
  };
  return {
    ...proposal,
    safeTxHash: coverageBreakerSafeTxHash(proposal, '7'),
    priorState: 'SAFE_PROPOSED',
  };
}

function coverageBreakerChainSource(fetchImpl: typeof fetch) {
  return new ResilientCoverageBreakerChainSource({
    lookupUrl: 'https://safe-lookup.example.invalid/coverage-breaker',
    lookupToken: 'lookup-token',
    primaryRpcUrl: 'https://coverage-primary-rpc.example.invalid',
    fallbackRpcUrl: 'https://coverage-fallback-rpc.example.invalid',
    fetchImpl,
  });
}

function coverageBreakerRpcHarness() {
  const executionTxHash = HASH_3;
  const minedBlockHash = `0x${'6'.repeat(64)}`;
  const iface = new Interface([
    'event PaymentPauseChanged(bool paused,bytes32 indexed evidenceHash)',
    'function newPaymentsPaused() view returns (bool)',
  ]);
  const event = iface.getEvent('PaymentPauseChanged');
  if (!event) throw new Error('MissingPaymentPauseChangedEvent');
  const state = {
    primaryChainId: 56,
    fallbackChainId: 56,
    head: 114,
    receiptStatus: '0x1',
    transactionTo: BUYER,
    eventEvidenceHash: HASH_1,
    eventPaused: true,
    routerPaused: true,
    fallbackReceiptBlockHash: minedBlockHash,
    primaryCanonicalBlockHash: minedBlockHash,
    fallbackCanonicalBlockHash: minedBlockHash,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://safe-lookup.example.invalid')) {
      return jsonResponse({
        safeTxHash: coverageBreakerCandidate().safeTxHash,
        resourceId: coverageBreakerCandidate().actionId,
        executionTxHash,
      });
    }
    const primary = url.startsWith('https://coverage-primary-rpc.example.invalid');
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (request.method === 'eth_chainId') {
      result = `0x${(primary ? state.primaryChainId : state.fallbackChainId).toString(16)}`;
    } else if (request.method === 'eth_blockNumber') {
      result = `0x${state.head.toString(16)}`;
    } else if (request.method === 'eth_getBlockByNumber') {
      result = { hash: primary ? state.primaryCanonicalBlockHash : state.fallbackCanonicalBlockHash };
    } else if (request.method === 'eth_getTransactionByHash') {
      result = { hash: executionTxHash, to: state.transactionTo };
    } else if (request.method === 'eth_call') {
      result = iface.encodeFunctionResult('newPaymentsPaused', [state.routerPaused]);
    } else if (request.method === 'eth_getTransactionReceipt') {
      const encoded = iface.encodeEventLog(event, [state.eventPaused, state.eventEvidenceHash]);
      result = {
        transactionHash: executionTxHash,
        status: state.receiptStatus,
        blockHash: primary ? minedBlockHash : state.fallbackReceiptBlockHash,
        blockNumber: '0x64',
        logs: [{ address: CONTRACT, topics: encoded.topics, data: encoded.data }],
      };
    } else {
      throw new Error(`UnexpectedCoverageBreakerRpcMethod:${request.method}`);
    }
    return jsonResponse({ jsonrpc: '2.0', id: 1, result });
  };
  return { state, fetch: fetchImpl, executionTxHash, minedBlockHash };
}

function seckillCandidate(kind: 'OPEN_SESSION' | 'FORCE_CLOSE' | 'PRIZE_INJECTION'): SeckillFinalityCandidate {
  const router = new Interface([
    'function openSeckillSession(bytes32 sessionId,uint64 policyVersion,uint64 startsAt)',
    'function setSeckillPurchasesPaused(bool paused,bytes32 evidenceHash)',
  ]);
  const token = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);
  let proposal: SeckillSafeProposal;
  if (kind === 'OPEN_SESSION') {
    const calldata = router.encodeFunctionData('openSeckillSession', [ORDER_ID, 1, 1_800_000_000]).toLowerCase();
    proposal = {
      actionId: HASH_2,
      sessionId: ORDER_ID,
      actionKind: kind,
      policyVersion: 1,
      evidenceHash: HASH_1,
      safeAddress: BUYER,
      targetAddress: CONTRACT,
      calldata,
      calldataHash: keccak256(calldata).toLowerCase(),
      minimumSafeNonce: '7',
      expected: {
        kind,
        startsAt: 1_800_000_000,
        mainDeadline: 1_800_003_600,
        relayDeadline: 1_800_000_060,
      },
    };
  } else if (kind === 'FORCE_CLOSE') {
    const calldata = router.encodeFunctionData('setSeckillPurchasesPaused', [true, HASH_1]).toLowerCase();
    proposal = {
      actionId: HASH_2,
      sessionId: ORDER_ID,
      actionKind: kind,
      policyVersion: 1,
      evidenceHash: HASH_1,
      safeAddress: BUYER,
      targetAddress: CONTRACT,
      calldata,
      calldataHash: keccak256(calldata).toLowerCase(),
      minimumSafeNonce: '7',
      expected: { kind, targetPaused: true },
    };
  } else {
    const calldata = token.encodeFunctionData('transfer', [MERCHANT, 50]).toLowerCase();
    proposal = {
      actionId: HASH_2,
      sessionId: ORDER_ID,
      actionKind: kind,
      policyVersion: 1,
      evidenceHash: HASH_1,
      safeAddress: BUYER,
      targetAddress: USDT_ADDRESS,
      calldata,
      calldataHash: keccak256(calldata).toLowerCase(),
      minimumSafeNonce: '7',
      expected: {
        kind,
        amountUsdt: '50',
        operationsSafeAddress: BUYER,
        custodySafeAddress: MERCHANT,
        tokenAddress: USDT_ADDRESS,
      },
    };
  }
  return {
    ...proposal,
    safeTxHash: seckillSafeTxHash(proposal, '7'),
    priorState: 'SAFE_PROPOSED',
  };
}

function seckillRpcHarness(candidate: SeckillFinalityCandidate) {
  const executionTxHash = HASH_3;
  const minedBlockHash = `0x${'6'.repeat(64)}`;
  const router = new Interface([
    'event SeckillSessionOpened(bytes32 indexed sessionId,uint64 indexed policyVersion,uint64 startsAt,uint64 mainDeadline,uint64 relayDeadline)',
    'event SeckillPurchasePauseChanged(bool paused,bytes32 indexed evidenceHash)',
    'function seckillPurchasesPaused() view returns (bool)',
  ]);
  const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const state = {
    head: 114,
    transactionTo: candidate.safeAddress,
    canonicalBlockHash: minedBlockHash,
    routerPaused: true,
    prizeAmount: '50',
  };
  const eventLog = () => {
    if (candidate.expected.kind === 'OPEN_SESSION') {
      const event = router.getEvent('SeckillSessionOpened')!;
      const encoded = router.encodeEventLog(event, [
        candidate.sessionId,
        candidate.policyVersion,
        candidate.expected.startsAt,
        candidate.expected.mainDeadline,
        candidate.expected.relayDeadline,
      ]);
      return { address: candidate.targetAddress, topics: encoded.topics, data: encoded.data };
    }
    if (candidate.expected.kind === 'FORCE_CLOSE' || candidate.expected.kind === 'RESUME_PURCHASES') {
      const event = router.getEvent('SeckillPurchasePauseChanged')!;
      const encoded = router.encodeEventLog(event, [candidate.expected.targetPaused, candidate.evidenceHash]);
      return { address: candidate.targetAddress, topics: encoded.topics, data: encoded.data };
    }
    if (candidate.expected.kind !== 'PRIZE_INJECTION') throw new Error('MissingPrizeExpectation');
    const event = token.getEvent('Transfer')!;
    const encoded = token.encodeEventLog(event, [
      candidate.expected.operationsSafeAddress,
      candidate.expected.custodySafeAddress,
      state.prizeAmount,
    ]);
    return { address: candidate.expected.tokenAddress, topics: encoded.topics, data: encoded.data };
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://safe-lookup.example.invalid')) {
      return jsonResponse({
        safeTxHash: candidate.safeTxHash,
        resourceId: candidate.actionId,
        executionTxHash,
      });
    }
    const request = JSON.parse(String(init?.body)) as { method: string };
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x38';
    else if (request.method === 'eth_blockNumber') result = `0x${state.head.toString(16)}`;
    else if (request.method === 'eth_getBlockByNumber') result = { hash: state.canonicalBlockHash };
    else if (request.method === 'eth_getTransactionByHash') result = { hash: executionTxHash, to: state.transactionTo };
    else if (request.method === 'eth_call') {
      result = router.encodeFunctionResult('seckillPurchasesPaused', [state.routerPaused]);
    } else if (request.method === 'eth_getTransactionReceipt') {
      result = {
        transactionHash: executionTxHash,
        status: '0x1',
        blockHash: minedBlockHash,
        blockNumber: '0x64',
        logs: [eventLog()],
      };
    } else throw new Error(`UnexpectedSeckillRpcMethod:${request.method}`);
    return jsonResponse({ jsonrpc: '2.0', id: 1, result });
  };
  return { state, fetch: fetchImpl };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
    seckillPrizeBps: 300,
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
    concessionDestinationSetHash: paymentAllocationSetHash(
      concessionDestinations,
      otherUsdtDestinations,
      '0x7000000000000000000000000000000000000004',
    ),
    decisionEvidenceHash: HASH_2,
    concessionDestinations,
    operationsDestinations: [
      { account: '0x5000000000000000000000000000000000000007', weightBps: 4_000 },
      { account: '0x5000000000000000000000000000000000000008', weightBps: 6_000 },
    ],
    otherUsdtDestinations,
    seckillPrizePoolAccount: '0x7000000000000000000000000000000000000004',
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

function noopTransactions(): SqlTransactionRunner {
  const executor: SqlExecutor = { query: async () => ({ rows: [] }) };
  return { transaction: (operation) => operation(executor) };
}

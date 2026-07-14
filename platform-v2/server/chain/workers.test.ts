import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Wallet, type InterfaceAbi } from 'ethers';
import { AbiEventDecoder, type DecodedDomainEvent } from './abi-decoder.ts';
import { RemoteExecutorClient } from './executor.ts';
import {
  ChainIndexer,
  type CanonicalCheckpoint,
  type ChainBlock,
  type IndexedChainBlock,
  type IndexerStore,
} from './indexer.ts';
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
  const decoder = await AbiEventDecoder.load(BUNDLE_PATH, { PaymentEscrowV2: CONTRACT });
  const bundle = (await import(BUNDLE_PATH, { with: { type: 'json' } })).default as {
    contracts: { PaymentEscrowV2: InterfaceAbi };
  };
  const contractInterface = new Interface(bundle.contracts.PaymentEscrowV2);
  const event = contractInterface.getEvent('OrderPaid');
  assert.ok(event);
  const encoded = contractInterface.encodeEventLog(event, [
    ORDER_ID,
    BUYER,
    MERCHANT,
    1,
    50,
    500,
    100,
    400,
    100,
    false,
    `0x${'0'.repeat(64)}`,
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
  assert.equal(store.events[0]?.eventName, 'OrderPaid');
  assert.equal(store.events[0]?.resourceId, ORDER_ID);
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

test('remote signer validates the recovered signer and never accepts an arbitrary signature', async () => {
  const wallet = Wallet.createRandom();
  const digest = HASH_1;
  const signature = wallet.signingKey.sign(digest).serialized;
  const signer = new RemoteSignerClient({
    url: 'https://signer.example.invalid',
    token: 'test-signer-service-token',
    expectedSigner: wallet.address,
    fetch: async () => new Response(JSON.stringify({ signature }), { status: 200 }),
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

function executorDeployment() {
  return {
    coordinatedManifest: { artifactVersion: '2.0.0-rc.2', deploymentAuthorized: true, chain: { chainId: 56 } },
    contractManifest: {
      artifactVersion: '2.0.0-rc.2',
      deploymentStatus: 'DEPLOYED',
      chain: { chainId: 56 },
      contracts: [{ name: 'PaymentEscrowV2', address: CONTRACT, status: 'DEPLOYED' }],
    },
    allowedCalls: {
      PaymentEscrowV2: [
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

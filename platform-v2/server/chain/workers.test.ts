import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Wallet, type InterfaceAbi } from 'ethers';
import { AbiEventDecoder, type DecodedDomainEvent } from './abi-decoder.ts';
import { RemoteExecutorClient } from './executor.ts';
import { ChainIndexer, type CanonicalCheckpoint, type ChainBlock, type IndexerStore } from './indexer.ts';
import { scheduleFulfillmentJobs } from './scheduler.ts';
import { RemoteSignerClient } from './signer.ts';

const CONTRACT = '0x3333333333333333333333333333333333333333';
const BUYER = '0x1111111111111111111111111111111111111111';
const MERCHANT = '0x2222222222222222222222222222222222222222';
const ORDER_ID = `0x${'a'.repeat(64)}`;
const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
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

  await assert.rejects(
    indexer.ingest({ number: 101, hash: HASH_3, parentHash: `0x${'4'.repeat(64)}`, timestamp: 1_800_000_001 }, []),
    /parent no longer matches/,
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
    data: '0x1234',
    value: '0',
    resourceId: ORDER_ID,
    policyVersion: 1,
    idempotencyKey: 'execute-order-1',
    gasLimit: '500000',
    replacementForTxHash: HASH_2,
  });
  assert.equal(result.txHash, HASH_3);
  assert.equal(result.replacementForTxHash, HASH_2);
  await assert.rejects(
    executor.execute({
      chainId: 56,
      to: CONTRACT,
      data: '0x1234',
      value: '0',
      resourceId: ORDER_ID,
      policyVersion: 1,
      idempotencyKey: 'execute-order-2',
      gasLimit: '1000001',
    }),
    /bounded transaction plan/,
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
  readonly events: DecodedDomainEvent[] = [];
  readonly reorgs: Array<{ fromBlock: number; expected: string; observed: string }> = [];

  async checkpoint() {
    return this.current;
  }

  async commit(block: ChainBlock, events: DecodedDomainEvent[]) {
    this.current = { blockNumber: block.number, blockHash: block.hash };
    this.events.push(...events);
  }

  async markReorg(fromBlock: number, expected: string, observed: string) {
    this.reorgs.push({ fromBlock, expected, observed });
  }
}

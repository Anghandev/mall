import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, keccak256 } from 'ethers';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import {
  HttpCoverageBreakerEoaExecutor,
  ResilientCoverageBreakerChainSource,
  coverageBreakerExecutionRequestDigest,
  type CoverageBreakerExecution,
  type CoverageBreakerFinalityCandidate,
} from './coverage-breaker-governance.ts';
import {
  HttpSeckillEoaExecutor,
  ResilientSeckillChainSource,
  seckillExecutionRequestDigest,
  type SeckillExecution,
  type SeckillFinalityCandidate,
} from './seckill-governance.ts';

const GOVERNANCE = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
const TX_HASH = `0x${'a'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;

const coverageInterface = new Interface([
  'event PaymentPauseChanged(bool paused,bytes32 indexed evidenceHash)',
  'function setNewPaymentsPaused(bool paused,bytes32 evidenceHash)',
  'function newPaymentsPaused() view returns (bool)',
]);
const seckillInterface = new Interface([
  'event SeckillSessionOpened(bytes32 indexed sessionId,uint64 indexed policyVersion,uint64 startsAt,uint64 mainDeadline,uint64 relayDeadline)',
  'function openSeckillSession(bytes32 sessionId,uint64 policyVersion,uint64 startsAt)',
]);

test('coverage EOA executor and finality bind the exact sender, target, calldata and nonce', async () => {
  const execution = coverageExecution();
  const executor = new HttpCoverageBreakerEoaExecutor({
    url: 'https://executor.example/coverage',
    token: 'token',
    fetchImpl: executorFetch(execution, coverageBreakerExecutionRequestDigest(execution)),
  });
  const submitted = await executor.execute(execution);
  assert.deepEqual(submitted, {
    executorWallet: GOVERNANCE,
    executorNonce: '7',
    submittedTxHash: TX_HASH,
    executionEvidenceHash: HASH_3,
  });

  const harness = coverageRpcHarness();
  const source = new ResilientCoverageBreakerChainSource({
    primaryRpcUrl: 'https://primary.example',
    fallbackRpcUrl: 'https://fallback.example',
    fetchImpl: harness.fetch,
  });
  const candidate: CoverageBreakerFinalityCandidate = {
    ...execution,
    submittedTxHash: TX_HASH,
    priorState: 'SUBMITTED',
  };
  assert.equal((await source.observe(candidate)).state, 'MINED');
  harness.head = 114;
  const finalized = await source.observe(candidate);
  assert.equal(finalized.state, 'FINAL');
  harness.transaction = { ...harness.transaction, from: ROUTER };
  await assert.rejects(() => source.observe(candidate), /drifted from its frozen EOA execution/);
});

test('seckill EOA execution reaches finality without a Safe lookup service', async () => {
  const execution = seckillExecution();
  const executor = new HttpSeckillEoaExecutor({
    url: 'https://executor.example/seckill',
    token: 'token',
    fetchImpl: executorFetch(execution, seckillExecutionRequestDigest(execution)),
  });
  assert.equal((await executor.execute(execution)).submittedTxHash, TX_HASH);
  const fetchImpl = seckillRpcFetch(execution);
  const source = new ResilientSeckillChainSource({
    primaryRpcUrl: 'https://primary.example',
    fallbackRpcUrl: 'https://fallback.example',
    fetchImpl,
  });
  const candidate: SeckillFinalityCandidate = {
    ...execution,
    submittedTxHash: TX_HASH,
    priorState: 'SUBMITTED',
  };
  const observation = await source.observe(candidate);
  assert.equal(observation.state, 'FINAL');
  assert.equal(observation.executionTxHash, TX_HASH);
});

function coverageExecution(): CoverageBreakerExecution {
  const calldata = coverageInterface.encodeFunctionData('setNewPaymentsPaused', [true, HASH_1]).toLowerCase();
  return {
    actionId: HASH_2,
    governanceWallet: GOVERNANCE,
    routerAddress: ROUTER,
    calldata,
    calldataHash: keccak256(calldata).toLowerCase(),
    targetPaused: true,
    evidenceHash: HASH_1,
    policyVersion: 1,
    minimumExecutorNonce: '7',
  };
}

function seckillExecution(): SeckillExecution {
  const startsAt = 1_800_000_000;
  const sessionId = HASH_2;
  const calldata = seckillInterface.encodeFunctionData('openSeckillSession', [sessionId, 1, startsAt]).toLowerCase();
  return {
    actionId: HASH_1,
    sessionId,
    actionKind: 'OPEN_SESSION',
    policyVersion: 1,
    evidenceHash: HASH_3,
    governanceWallet: GOVERNANCE,
    targetAddress: ROUTER,
    calldata,
    calldataHash: keccak256(calldata).toLowerCase(),
    minimumExecutorNonce: '7',
    expected: {
      kind: 'OPEN_SESSION',
      startsAt,
      mainDeadline: startsAt + 3_600,
      relayDeadline: startsAt + 60,
    },
  };
}

function executorFetch(input: CoverageBreakerExecution | SeckillExecution, requestDigest: string): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.artifactVersion, CORE_ARTIFACT_VERSION);
    assert.equal(body.from, input.governanceWallet);
    assert.equal(body.to, 'routerAddress' in input ? input.routerAddress : input.targetAddress);
    assert.equal(body.data, input.calldata);
    return httpJson({
      executorWallet: input.governanceWallet,
      executorNonce: '7',
      submittedTxHash: TX_HASH,
      executionEvidenceHash: HASH_3,
      dataHash: input.calldataHash,
      resourceId: input.actionId,
      ...('targetPaused' in input ? {
        targetPaused: input.targetPaused,
        evidenceHash: input.evidenceHash,
        policyVersion: input.policyVersion,
      } : {
        sessionId: input.sessionId,
        actionKind: input.actionKind,
        policyVersion: input.policyVersion,
        evidenceHash: input.evidenceHash,
      }),
      minimumExecutorNonce: input.minimumExecutorNonce,
      requestDigest,
    });
  }) as typeof fetch;
}

function coverageRpcHarness() {
  const event = coverageInterface.encodeEventLog(
    coverageInterface.getEvent('PaymentPauseChanged')!,
    [true, HASH_1],
  );
  const harness = {
    head: 113,
    transaction: {
      hash: TX_HASH,
      from: GOVERNANCE,
      to: ROUTER,
      input: coverageExecution().calldata,
      nonce: '0x7',
      value: '0x0',
    },
    fetch: undefined as unknown as typeof fetch,
  };
  harness.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (request.method === 'eth_chainId') return json('0x38');
    if (request.method === 'eth_blockNumber') return json(`0x${harness.head.toString(16)}`);
    if (request.method === 'eth_getTransactionByHash') return json(harness.transaction);
    if (request.method === 'eth_getTransactionReceipt') return json({
      transactionHash: TX_HASH,
      blockNumber: '0x64',
      blockHash: BLOCK_HASH,
      status: '0x1',
      logs: [{ address: ROUTER, topics: event.topics, data: event.data }],
    });
    if (request.method === 'eth_getBlockByNumber') return json({ hash: BLOCK_HASH });
    if (request.method === 'eth_call') {
      return json(coverageInterface.encodeFunctionResult('newPaymentsPaused', [true]));
    }
    throw new Error(`UnexpectedRpc:${request.method}`);
  }) as typeof fetch;
  return harness;
}

function seckillRpcFetch(input: SeckillExecution): typeof fetch {
  if (input.expected.kind !== 'OPEN_SESSION') throw new Error('ExpectedOpenSession');
  const event = seckillInterface.encodeEventLog(
    seckillInterface.getEvent('SeckillSessionOpened')!,
    [
      input.sessionId,
      input.policyVersion,
      input.expected.startsAt,
      input.expected.mainDeadline,
      input.expected.relayDeadline,
    ],
  );
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    if (request.method === 'eth_chainId') return json('0x38');
    if (request.method === 'eth_blockNumber') return json('0x72');
    if (request.method === 'eth_getTransactionByHash') return json({
      hash: TX_HASH,
      from: GOVERNANCE,
      to: ROUTER,
      input: input.calldata,
      nonce: '0x7',
      value: '0x0',
    });
    if (request.method === 'eth_getTransactionReceipt') return json({
      transactionHash: TX_HASH,
      blockNumber: '0x64',
      blockHash: BLOCK_HASH,
      status: '0x1',
      logs: [{ address: ROUTER, topics: event.topics, data: event.data }],
    });
    if (request.method === 'eth_getBlockByNumber') return json({ hash: BLOCK_HASH });
    throw new Error(`UnexpectedRpc:${request.method}`);
  }) as typeof fetch;
}

function json(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function httpJson(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

import assert from 'node:assert/strict';
import type { SqlExecutor, SqlResult, SqlTransactionRunner } from '../data/migrations.ts';
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
  SeckillGovernanceWorker,
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
]);
const seckillInterface = new Interface([
  'event SeckillSessionOpened(bytes32 indexed sessionId,uint64 indexed policyVersion,uint64 startsAt,uint64 mainDeadline,uint64 relayDeadline)',
  'event SeckillPurchasePauseChanged(bool paused,bytes32 indexed evidenceHash)',
  'function openSeckillSession(bytes32 sessionId,uint64 policyVersion,uint64 startsAt)',
  'function setSeckillPurchasesPaused(bool paused,bytes32 evidenceHash)',
]);

test('coverage EOA executor and receipt finality bind the exact action without Archive RPC', async () => {
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
  harness.transaction = { ...harness.transaction, gas: '0x186a1' };
  await assert.rejects(() => source.observe(candidate), /drifted from its frozen EOA execution/);
  harness.transaction = { ...harness.transaction, from: ROUTER };
  await assert.rejects(() => source.observe(candidate), /drifted from its frozen EOA execution/);
});

test('coverage EOA executor permits authenticated loopback HTTP but rejects remote HTTP', async () => {
  const execution = coverageExecution();
  const loopback = new HttpCoverageBreakerEoaExecutor({
    url: 'http://127.0.0.1:8790/governance',
    token: 'token',
    fetchImpl: executorFetch(execution, coverageBreakerExecutionRequestDigest(execution)),
  });
  assert.equal((await loopback.execute(execution)).submittedTxHash, TX_HASH);

  const remote = new HttpCoverageBreakerEoaExecutor({
    url: 'http://executor.example/coverage',
    token: 'token',
    fetchImpl: executorFetch(execution, coverageBreakerExecutionRequestDigest(execution)),
  });
  await assert.rejects(() => remote.execute(execution), /requires HTTPS outside loopback/);
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

test('seckill EOA executor permits authenticated loopback HTTP but rejects remote HTTP', async () => {
  const execution = seckillExecution();
  const loopback = new HttpSeckillEoaExecutor({
    url: 'http://127.0.0.1:8790/governance',
    token: 'token',
    fetchImpl: executorFetch(execution, seckillExecutionRequestDigest(execution)),
  });
  assert.equal((await loopback.execute(execution)).submittedTxHash, TX_HASH);

  const remote = new HttpSeckillEoaExecutor({
    url: 'http://executor.example/seckill',
    token: 'token',
    fetchImpl: executorFetch(execution, seckillExecutionRequestDigest(execution)),
  });
  await assert.rejects(() => remote.execute(execution), /requires HTTPS outside loopback/);
});

test('seckill governance worker submits a pending EOA action through the configured executor', async () => {
  const execution = seckillExecution();
  const now = new Date('2026-07-21T00:00:00.000Z');
  const action = {
    action_id: execution.actionId,
    session_id: execution.sessionId,
    policy_version: execution.policyVersion,
    action_kind: execution.actionKind,
    evidence_hash: execution.evidenceHash,
    governance_wallet_address: execution.governanceWallet,
    target_address: execution.targetAddress,
    calldata: execution.calldata,
    calldata_hash: execution.calldataHash,
    old_value_hash: HASH_1,
    new_value_hash: HASH_2,
    state: 'PENDING_EXECUTION',
    executor_nonce: null,
    submitted_tx_hash: null,
    execution_evidence_hash: null,
    execution_tx_hash: null,
    block_number: null,
    block_hash: null,
    confirmations: 0,
    canonical: null,
    actor_wallet: GOVERNANCE,
    secondary_signer: GOVERNANCE,
    secondary_signature_hash: HASH_1,
    approval_nonce: '1',
    approval_deadline: new Date(now.getTime() + 10 * 60_000),
    idempotency_key: 'seckill-worker-test',
    request_hash: HASH_2,
    created_at: now,
    updated_at: now,
  } as const;
  const plan = {
    session_id: execution.sessionId,
    action_id: execution.actionId,
    policy_version: execution.policyVersion,
    merchant_id: 'merchant:test',
    product_id: 'product:test',
    sku_id: 'sku:test',
    product_policy_hash: HASH_1,
    rules_content_hash: HASH_2,
    starts_at: new Date(execution.expected.kind === 'OPEN_SESSION' ? execution.expected.startsAt * 1000 : now.getTime()),
    main_deadline: new Date(execution.expected.kind === 'OPEN_SESSION' ? execution.expected.mainDeadline * 1000 : now.getTime() + 3_600_000),
    relay_deadline: new Date(execution.expected.kind === 'OPEN_SESSION' ? execution.expected.relayDeadline * 1000 : now.getTime() + 60_000),
    inventory: 3,
    seckill_list_price_usdt: '1000',
    snapshot: {},
  };
  const calls: SeckillExecution[] = [];
  const transitions: Array<{ from: unknown; to: unknown }> = [];
  const transactions = new SeckillWorkerMemoryTransactions(action, plan, transitions);
  const worker = new SeckillGovernanceWorker({
    transactions,
    executionGasLimit: '1000000',
    clock: () => now,
    executor: {
      execute: async (input) => {
        calls.push(input);
        assert.deepEqual(input, execution);
        return {
          executorWallet: GOVERNANCE,
          executorNonce: execution.minimumExecutorNonce,
          submittedTxHash: TX_HASH,
          executionEvidenceHash: HASH_3,
        };
      },
    },
    chain: { observe: async () => ({ state: 'NOT_FOUND' }) },
  });

  assert.deepEqual(await worker.pollOnce(), { executions: 1, finality: 1 });
  assert.equal(calls.length, 1);
  assert.equal(transactions.action.state, 'SUBMITTED');
  assert.equal(transactions.action.executor_nonce, execution.minimumExecutorNonce);
  assert.equal(transactions.action.submitted_tx_hash, TX_HASH);
  assert.equal(transactions.action.execution_evidence_hash, HASH_3);
  assert.deepEqual(transitions.map((item) => item.to), ['SUBMITTED']);
  assert.deepEqual(transactions.unexpectedSql, []);
  assert.deepEqual(worker.status(), { healthy: true, errorCode: undefined });
});

test('seckill breaker receipt reaches finality without historical state calls', async () => {
  const execution = seckillBreakerExecution();
  const source = new ResilientSeckillChainSource({
    primaryRpcUrl: 'https://primary.example',
    fallbackRpcUrl: 'https://fallback.example',
    fetchImpl: seckillBreakerRpcFetch(execution),
  });
  const observation = await source.observe({
    ...execution,
    submittedTxHash: TX_HASH,
    priorState: 'SUBMITTED',
  });
  assert.equal(observation.state, 'FINAL');
});

class SeckillWorkerMemoryTransactions implements SqlTransactionRunner {
  action: Record<string, unknown>;
  readonly plan: Record<string, unknown>;
  readonly transitions: Array<{ from: unknown; to: unknown }>;
  readonly unexpectedSql: string[] = [];

  constructor(
    action: Record<string, unknown>,
    plan: Record<string, unknown>,
    transitions: Array<{ from: unknown; to: unknown }>,
  ) {
    this.action = action;
    this.plan = plan;
    this.transitions = transitions;
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>) {
    const executor: SqlExecutor = {
      query: async <Row extends object>(sql: string, params: unknown[] = []): Promise<SqlResult<Row>> => ({ rows: (await this.query(sql, params)).rows as Row[] }),
    };
    return callback(executor);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    if (sql.includes("WHERE state = 'PENDING_EXECUTION' ORDER BY created_at")) {
      return { rows: this.action.state === 'PENDING_EXECUTION' ? [this.action] : [] };
    }
    if (sql.includes("WHERE state IN ('SUBMITTED','MINED','FINAL')")) {
      return { rows: ['SUBMITTED', 'MINED', 'FINAL'].includes(String(this.action.state)) ? [this.action] : [] };
    }
    if (sql.includes('max(executor_nonce)::text') && sql.includes('earlier_pending')) {
      return { rows: [{ max_executor_nonce: '6', earlier_pending: false }] };
    }
    if (sql.includes('SELECT starts_at, main_deadline, relay_deadline FROM core.seckill_session_plans')) {
      return { rows: [this.plan] };
    }
    if (sql.includes('SELECT * FROM core.seckill_governance_actions WHERE action_id = $1 FOR UPDATE')) {
      assert.equal(params[0], this.action.action_id);
      return { rows: [this.action] };
    }
    if (sql.includes("UPDATE core.seckill_governance_actions") && sql.includes("SET state = 'SUBMITTED'")) {
      assert.equal(params[0], this.action.action_id);
      this.action = {
        ...this.action,
        state: 'SUBMITTED',
        executor_nonce: params[1],
        submitted_tx_hash: params[2],
        execution_evidence_hash: params[3],
        updated_at: params[4],
      };
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO core.seckill_governance_transitions')) {
      this.transitions.push({ from: params[2], to: params[3] });
      return { rows: [] };
    }
    if (sql.includes('SELECT request_hash, payload FROM core.audit_outbox_events')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO core.audit_outbox_events')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT session_id FROM core.seckill_sessions')) {
      return { rows: [] };
    }
    if (sql.includes('FROM core.seckill_sessions session') && sql.includes('core.seckill_prize_settlements')) {
      return { rows: [] };
    }
    if (sql.includes('FROM core.seckill_sessions session') && sql.includes('core.seckill_session_plans plan')) {
      return { rows: [] };
    }
    this.unexpectedSql.push(sql);
    return { rows: [] };
  }
}

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
    gasLimit: '100000',
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
    gasLimit: '1000000',
    minimumExecutorNonce: '7',
    expected: {
      kind: 'OPEN_SESSION',
      startsAt,
      mainDeadline: startsAt + 3_600,
      relayDeadline: startsAt + 60,
    },
  };
}

function seckillBreakerExecution(): SeckillExecution {
  const calldata = seckillInterface.encodeFunctionData('setSeckillPurchasesPaused', [true, HASH_3]).toLowerCase();
  return {
    actionId: HASH_1,
    sessionId: HASH_2,
    actionKind: 'FORCE_CLOSE',
    policyVersion: 1,
    evidenceHash: HASH_3,
    governanceWallet: GOVERNANCE,
    targetAddress: ROUTER,
    calldata,
    calldataHash: keccak256(calldata).toLowerCase(),
    gasLimit: '1000000',
    minimumExecutorNonce: '7',
    expected: { kind: 'FORCE_CLOSE', targetPaused: true },
  };
}

function executorFetch(input: CoverageBreakerExecution | SeckillExecution, requestDigest: string): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.artifactVersion, CORE_ARTIFACT_VERSION);
    assert.equal(body.from, input.governanceWallet);
    assert.equal(body.to, 'routerAddress' in input ? input.routerAddress : input.targetAddress);
    assert.equal(body.data, input.calldata);
    assert.equal(body.gasLimit, input.gasLimit);
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
        gasLimit: input.gasLimit,
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
      gas: '0x186a0',
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

function seckillBreakerRpcFetch(input: SeckillExecution): typeof fetch {
  if (input.expected.kind !== 'FORCE_CLOSE') throw new Error('ExpectedForceClose');
  const event = seckillInterface.encodeEventLog(
    seckillInterface.getEvent('SeckillPurchasePauseChanged')!,
    [true, input.evidenceHash],
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

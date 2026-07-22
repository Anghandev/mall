import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { CORE_ARTIFACT_VERSION, USDT_ADDRESS } from '../api/enums.ts';
import { settlementIntentDigest, settlementRequestDomain, settlementRequestTypes } from '../api/settlement-signing.ts';
import { seckillExecutionRequestDigest, type SeckillExecution } from '../chain/seckill-governance.ts';

const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const HASH_3 = `0x${'3'.repeat(64)}`;
const SERVICE = fileURLToPath(new URL('./eoa-runtime-service.ts', import.meta.url));
const TRANSFER = new Interface(['function transfer(address recipient,uint256 amount) returns (bool)']);

test('EOA runtime replays one persisted raw transaction after HTTP response loss and restart', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'abu24k-eoa-runtime-'));
  const stateFile = join(temporary, 'execution-state.json');
  const governance = wallet('1');
  const settlement = wallet('2');
  const reward = wallet('3');
  const operations = wallet('4');
  const recipient = wallet('5').address.toLowerCase();
  const authorization = await signedAuthorization(wallet('5'), settlement.address.toLowerCase(), recipient);
  const broadcasts: string[] = [];
  let firstBroadcastSeen!: () => void;
  let releaseFirstBroadcast!: () => void;
  const firstBroadcast = new Promise<void>((resolve) => { firstBroadcastSeen = resolve; });
  const releaseBroadcast = new Promise<void>((resolve) => { releaseFirstBroadcast = resolve; });
  const rpc = await fakeRpcServer(async (rawTransaction) => {
    broadcasts.push(rawTransaction);
    if (broadcasts.length === 1) {
      firstBroadcastSeen();
      await releaseBroadcast;
    }
    return keccak256(rawTransaction).toLowerCase();
  });
  const runtimePort = await unusedPort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(runtimePort),
    BSC_RPC_URL: `http://127.0.0.1:${address(rpc).port}`,
    BSC_FALLBACK_RPC_URL: `http://127.0.0.1:${address(rpc).port}/?fallback=1`,
    PLATFORM_TECH_PRIVATE_KEY: governance.privateKey,
    PLATFORM_GOVERNANCE_WALLET_ADDRESS: governance.address,
    WALLET_2_PRIVATE_KEY: settlement.privateKey,
    USDT_SETTLEMENT_WALLET_ADDRESS: settlement.address,
    WALLET_3_PRIVATE_KEY: reward.privateKey,
    NPL_REWARD_WALLET_ADDRESS: reward.address,
    WALLET_4_PRIVATE_KEY: operations.privateKey,
    OPERATIONS_GUARANTEE_WALLET_ADDRESS: operations.address,
    SIGNER_SERVICE_TOKEN: 'signer-test-token',
    SETTLEMENT_EXECUTOR_TOKEN: 'settlement-test-token',
    GOVERNANCE_EXECUTOR_TOKEN: 'governance-test-token',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    EXECUTION_STATE_FILE: stateFile,
  };
  const request = {
    chainId: 56,
    transferId: HASH_1,
    executorWallet: settlement.address.toLowerCase(),
    executorNonce: '0',
    tokenAddress: USDT_ADDRESS,
    requestId: authorization.requestId,
    requestItemIndex: 0,
    orderId: authorization.items[0]!.orderId,
    accountId: authorization.items[0]!.accountId,
    backingWalletAddress: authorization.items[0]!.backingWalletAddress,
    recipientAddress: recipient,
    amount: '1',
    transferCalldata: TRANSFER.encodeFunctionData('transfer', [recipient, 1n]).toLowerCase(),
    contentHash: HASH_2,
    gasLimit: '100000',
    requestDigest: HASH_3,
    idempotencyKey: 'settlement-runtime-response-loss-1',
    authorization,
  };
  let runtime: ReturnType<typeof spawn> | undefined;
  try {
    const firstRuntime = await startRuntime(env);
    runtime = firstRuntime;
    const controller = new AbortController();
    const lostResponse = fetch(`http://127.0.0.1:${runtimePort}/settlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer settlement-test-token' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    await withTimeout(firstBroadcast, 'first runtime broadcast');
    controller.abort();
    releaseFirstBroadcast();
    await assert.rejects(lostResponse, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopRuntime(firstRuntime);
    runtime = undefined;

    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, { rawTransaction?: string }>;
    assert.match(persisted['settlement:settlement-runtime-response-loss-1']?.rawTransaction ?? '', /^0x[0-9a-f]+$/);

    const secondRuntime = await startRuntime(env);
    runtime = secondRuntime;
    const reconciliation = await fetch(`http://127.0.0.1:${runtimePort}/settlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer settlement-test-token' },
      body: JSON.stringify({ ...request, reconciliationOnly: true }),
    });
    assert.equal(reconciliation.status, 200);
    assert.equal(
      (await reconciliation.json() as { executionTxHash: string }).executionTxHash,
      keccak256(broadcasts[0]!).toLowerCase(),
    );
    assert.equal(broadcasts.length, 1);
    const missing = await fetch(`http://127.0.0.1:${runtimePort}/settlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer settlement-test-token' },
      body: JSON.stringify({
        ...request,
        idempotencyKey: 'settlement-runtime-reconciliation-missing',
        reconciliationOnly: true,
      }),
    });
    assert.equal(missing.status, 409);
    assert.equal(
      (await missing.json() as { error: { code: string } }).error.code,
      'RECONCILIATION_MISSING',
    );
    assert.equal(broadcasts.length, 1);
    const replay = await fetch(`http://127.0.0.1:${runtimePort}/settlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer settlement-test-token' },
      body: JSON.stringify(request),
    });
    assert.equal(replay.status, 200);
    const response = await replay.json() as { executionTxHash: string };
    assert.equal(response.executionTxHash, keccak256(broadcasts[0]!).toLowerCase());
    assert.equal(broadcasts.length, 2);
    assert.equal(new Set(broadcasts).size, 1);
  } finally {
    releaseFirstBroadcast();
    if (runtime) await stopRuntime(runtime);
    await close(rpc);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('EOA runtime rejects calldata that is not bound to the original signed settlement request', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'abu24k-eoa-runtime-authorization-'));
  const governance = wallet('1');
  const settlement = wallet('2');
  const reward = wallet('3');
  const operations = wallet('4');
  const owner = wallet('5');
  const recipient = owner.address.toLowerCase();
  const attacker = wallet('6').address.toLowerCase();
  const authorization = await signedAuthorization(owner, settlement.address.toLowerCase(), recipient);
  const broadcasts: string[] = [];
  const rpc = await fakeRpcServer(async (rawTransaction) => {
    broadcasts.push(rawTransaction);
    return keccak256(rawTransaction).toLowerCase();
  });
  const runtimePort = await unusedPort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(runtimePort),
    BSC_RPC_URL: `http://127.0.0.1:${address(rpc).port}`,
    BSC_FALLBACK_RPC_URL: `http://127.0.0.1:${address(rpc).port}/?fallback=1`,
    PLATFORM_TECH_PRIVATE_KEY: governance.privateKey,
    PLATFORM_GOVERNANCE_WALLET_ADDRESS: governance.address,
    WALLET_2_PRIVATE_KEY: settlement.privateKey,
    USDT_SETTLEMENT_WALLET_ADDRESS: settlement.address,
    WALLET_3_PRIVATE_KEY: reward.privateKey,
    NPL_REWARD_WALLET_ADDRESS: reward.address,
    WALLET_4_PRIVATE_KEY: operations.privateKey,
    OPERATIONS_GUARANTEE_WALLET_ADDRESS: operations.address,
    SIGNER_SERVICE_TOKEN: 'signer-test-token',
    SETTLEMENT_EXECUTOR_TOKEN: 'settlement-test-token',
    GOVERNANCE_EXECUTOR_TOKEN: 'governance-test-token',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    EXECUTION_STATE_FILE: join(temporary, 'execution-state.json'),
  };
  const runtime = await startRuntime(env);
  try {
    const response = await fetch(`http://127.0.0.1:${runtimePort}/settlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer settlement-test-token' },
      body: JSON.stringify({
        chainId: 56,
        transferId: HASH_1,
        executorWallet: settlement.address.toLowerCase(),
        executorNonce: '0',
        tokenAddress: USDT_ADDRESS,
        requestId: authorization.requestId,
        requestItemIndex: 0,
        orderId: authorization.items[0]!.orderId,
        accountId: authorization.items[0]!.accountId,
        backingWalletAddress: authorization.items[0]!.backingWalletAddress,
        recipientAddress: attacker,
        amount: '1',
        transferCalldata: TRANSFER.encodeFunctionData('transfer', [attacker, 1n]).toLowerCase(),
        contentHash: HASH_2,
        gasLimit: '100000',
        requestDigest: HASH_3,
        idempotencyKey: 'settlement-runtime-tampered-authorization-1',
        authorization,
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'AUTHORIZATION_MISMATCH' } });
    assert.equal(broadcasts.length, 0);
  } finally {
    await stopRuntime(runtime);
    await close(rpc);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('EOA runtime reports and enforces the exact reserved WALLET_4 seckill nonce', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'abu24k-eoa-runtime-wallet4-nonce-'));
  const governance = wallet('1');
  const settlement = wallet('2');
  const reward = wallet('3');
  const operations = wallet('4');
  const broadcasts: string[] = [];
  const rpc = await fakeRpcServer(async (rawTransaction) => {
    broadcasts.push(rawTransaction);
    return keccak256(rawTransaction).toLowerCase();
  });
  const runtimePort = await unusedPort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(runtimePort),
    BSC_RPC_URL: `http://127.0.0.1:${address(rpc).port}`,
    BSC_FALLBACK_RPC_URL: `http://127.0.0.1:${address(rpc).port}/?fallback=1`,
    PLATFORM_TECH_PRIVATE_KEY: governance.privateKey,
    PLATFORM_GOVERNANCE_WALLET_ADDRESS: governance.address,
    WALLET_2_PRIVATE_KEY: settlement.privateKey,
    USDT_SETTLEMENT_WALLET_ADDRESS: settlement.address,
    WALLET_3_PRIVATE_KEY: reward.privateKey,
    NPL_REWARD_WALLET_ADDRESS: reward.address,
    WALLET_4_PRIVATE_KEY: operations.privateKey,
    OPERATIONS_GUARANTEE_WALLET_ADDRESS: operations.address,
    SIGNER_SERVICE_TOKEN: 'signer-test-token',
    SETTLEMENT_EXECUTOR_TOKEN: 'settlement-test-token',
    GOVERNANCE_EXECUTOR_TOKEN: 'governance-test-token',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    EXECUTION_STATE_FILE: join(temporary, 'execution-state.json'),
  };
  const runtime = await startRuntime(env);
  try {
    const nonceResponse = await fetch(`http://127.0.0.1:${runtimePort}/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer governance-test-token' },
      body: JSON.stringify({
        operation: 'PENDING_NONCE',
        artifactVersion: CORE_ARTIFACT_VERSION,
        chainId: 56,
        governanceWallet: operations.address.toLowerCase(),
      }),
    });
    assert.equal(nonceResponse.status, 200);
    const nonce = await nonceResponse.json() as {
      executorWallet: string;
      executorNonce: string;
      evidenceHash: string;
    };
    assert.equal(nonce.executorWallet, operations.address.toLowerCase());
    assert.equal(nonce.executorNonce, '0');
    assert.match(nonce.evidenceHash, /^0x[0-9a-f]{64}$/);

    const calldata = TRANSFER.encodeFunctionData('transfer', [settlement.address, 1n]).toLowerCase();
    const execution = (executorNonce: string): SeckillExecution => ({
      artifactVersion: CORE_ARTIFACT_VERSION,
      actionId: HASH_1,
      sessionId: HASH_2,
      actionKind: 'PRIZE_INJECTION',
      policyVersion: 1,
      evidenceHash: HASH_3,
      governanceWallet: operations.address.toLowerCase(),
      targetAddress: USDT_ADDRESS,
      calldata,
      calldataHash: keccak256(calldata).toLowerCase(),
      gasLimit: '100000',
      minimumExecutorNonce: executorNonce,
      expected: {
        kind: 'PRIZE_INJECTION',
        amountUsdt: '1',
        operationsWalletAddress: operations.address.toLowerCase(),
        settlementWalletAddress: settlement.address.toLowerCase(),
        tokenAddress: USDT_ADDRESS,
      },
    });
    const request = (value: SeckillExecution) => ({
      artifactVersion: CORE_ARTIFACT_VERSION,
      chainId: 56,
      from: value.governanceWallet,
      to: value.targetAddress,
      value: '0',
      data: value.calldata,
      dataHash: value.calldataHash,
      gasLimit: value.gasLimit,
      resourceType: 'SECKILL_GOVERNANCE_ACTION',
      resourceId: value.actionId,
      sessionId: value.sessionId,
      actionKind: value.actionKind,
      policyVersion: value.policyVersion,
      evidenceHash: value.evidenceHash,
      minimumExecutorNonce: value.minimumExecutorNonce,
      expected: value.expected,
      requestDigest: seckillExecutionRequestDigest(value),
    });
    const mismatched = await fetch(`http://127.0.0.1:${runtimePort}/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer governance-test-token' },
      body: JSON.stringify(request(execution('1'))),
    });
    assert.equal(mismatched.status, 409);
    const mismatchBody = await mismatched.json() as {
      error: { code: string; details: Record<string, unknown> };
    };
    assert.equal(mismatchBody.error.code, 'NONCE_MISMATCH');
    assert.deepEqual(mismatchBody.error.details, {
      relation: 'UNSIGNED_UNBROADCAST',
      stateRecordPresent: false,
      executorWallet: operations.address.toLowerCase(),
      reservedNonce: '1',
      primaryPendingNonce: '0',
      fallbackPendingNonce: '0',
    });
    assert.equal(broadcasts.length, 0);

    const replayOnly = await fetch(`http://127.0.0.1:${runtimePort}/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer governance-test-token' },
      body: JSON.stringify({ ...request(execution('0')), reconciliationOnly: true }),
    });
    assert.equal(replayOnly.status, 409);
    const replayOnlyBody = await replayOnly.json() as {
      error: { code: string; details: Record<string, unknown> };
    };
    assert.equal(replayOnlyBody.error.code, 'NONCE_MISMATCH');
    assert.equal(replayOnlyBody.error.details.relation, 'STATE_RECORD_MISSING');
    assert.equal(replayOnlyBody.error.details.stateRecordPresent, false);
    assert.equal(broadcasts.length, 0);

    const submitted = await fetch(`http://127.0.0.1:${runtimePort}/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer governance-test-token' },
      body: JSON.stringify(request(execution('0'))),
    });
    assert.equal(submitted.status, 200);
    assert.equal((await submitted.json() as { executorNonce: string }).executorNonce, '0');
    assert.equal(broadcasts.length, 1);
  } finally {
    await stopRuntime(runtime);
    await close(rpc);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('EOA runtime replays a persisted seckill transaction after an artifact upgrade', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'abu24k-eoa-runtime-seckill-upgrade-'));
  const stateFile = join(temporary, 'execution-state.json');
  const governance = wallet('1');
  const settlement = wallet('2');
  const reward = wallet('3');
  const operations = wallet('4');
  const calldata = TRANSFER.encodeFunctionData('transfer', [settlement.address, 1n]).toLowerCase();
  const execution: SeckillExecution = {
    artifactVersion: '2.0.0-fulfillment-launch.19',
    actionId: HASH_1,
    sessionId: HASH_2,
    actionKind: 'PRIZE_INJECTION',
    policyVersion: 1,
    evidenceHash: HASH_3,
    governanceWallet: operations.address.toLowerCase(),
    targetAddress: USDT_ADDRESS,
    calldata,
    calldataHash: keccak256(calldata).toLowerCase(),
    gasLimit: '100000',
    minimumExecutorNonce: '0',
    expected: {
      kind: 'PRIZE_INJECTION',
      amountUsdt: '1',
      operationsWalletAddress: operations.address.toLowerCase(),
      settlementWalletAddress: settlement.address.toLowerCase(),
      tokenAddress: USDT_ADDRESS,
    },
  };
  const requestDigest = seckillExecutionRequestDigest(execution);
  const request = {
    artifactVersion: execution.artifactVersion,
    chainId: 56,
    from: execution.governanceWallet,
    to: execution.targetAddress,
    value: '0',
    data: execution.calldata,
    dataHash: execution.calldataHash,
    gasLimit: execution.gasLimit,
    resourceType: 'SECKILL_GOVERNANCE_ACTION',
    resourceId: execution.actionId,
    sessionId: execution.sessionId,
    actionKind: execution.actionKind,
    policyVersion: execution.policyVersion,
    evidenceHash: execution.evidenceHash,
    minimumExecutorNonce: execution.minimumExecutorNonce,
    expected: execution.expected,
    requestDigest,
  };
  const rawTransaction = await operations.signTransaction({
    chainId: 56,
    nonce: 0,
    to: USDT_ADDRESS,
    data: calldata,
    value: 0,
    gasLimit: 100000,
    gasPrice: 1,
  });
  const executionTxHash = keccak256(rawTransaction).toLowerCase();
  const response = {
    ...request,
    executionTxHash,
    submittedTxHash: executionTxHash,
    executorWallet: operations.address.toLowerCase(),
    executorNonce: '0',
    executionEvidenceHash: HASH_3,
  };
  await writeFile(stateFile, `${JSON.stringify({
    [`governance:${requestDigest}`]: {
      requestHash: hashJson(request),
      response,
      rawTransaction,
    },
  })}\n`, { mode: 0o600 });

  const broadcasts: string[] = [];
  const rpc = await fakeRpcServer(async (raw) => {
    broadcasts.push(raw);
    return keccak256(raw).toLowerCase();
  });
  const runtimePort = await unusedPort();
  const runtime = await startRuntime({
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(runtimePort),
    BSC_RPC_URL: `http://127.0.0.1:${address(rpc).port}`,
    BSC_FALLBACK_RPC_URL: `http://127.0.0.1:${address(rpc).port}/?fallback=1`,
    PLATFORM_TECH_PRIVATE_KEY: governance.privateKey,
    PLATFORM_GOVERNANCE_WALLET_ADDRESS: governance.address,
    WALLET_2_PRIVATE_KEY: settlement.privateKey,
    USDT_SETTLEMENT_WALLET_ADDRESS: settlement.address,
    WALLET_3_PRIVATE_KEY: reward.privateKey,
    NPL_REWARD_WALLET_ADDRESS: reward.address,
    WALLET_4_PRIVATE_KEY: operations.privateKey,
    OPERATIONS_GUARANTEE_WALLET_ADDRESS: operations.address,
    SIGNER_SERVICE_TOKEN: 'signer-test-token',
    SETTLEMENT_EXECUTOR_TOKEN: 'settlement-test-token',
    GOVERNANCE_EXECUTOR_TOKEN: 'governance-test-token',
    EXECUTOR_MAX_GAS_LIMIT: '1000000',
    EXECUTION_STATE_FILE: stateFile,
  });
  try {
    const replay = await fetch(`http://127.0.0.1:${runtimePort}/governance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer governance-test-token' },
      body: JSON.stringify({ ...request, reconciliationOnly: true }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { executionTxHash: string }).executionTxHash, executionTxHash);
    assert.deepEqual(broadcasts, [rawTransaction]);
  } finally {
    await stopRuntime(runtime);
    await close(rpc);
    await rm(temporary, { recursive: true, force: true });
  }
});

async function signedAuthorization(owner: Wallet, executorWallet: string, recipient: string) {
  const item = {
    itemIndex: 0,
    orderId: HASH_2,
    accountId: 'merchant-usdt-account',
    backingWalletAddress: executorWallet,
    amount: '1',
  };
  const authorizedItem = { ...item, itemHash: hashJson({ intentId: HASH_1, ...item }) };
  const intent = {
    intentId: HASH_1,
    artifactVersion: CORE_ARTIFACT_VERSION,
    wallet: owner.address.toLowerCase(),
    recipient,
    rail: 'MERCHANT_USDT' as const,
    asset: USDT_ADDRESS,
    executorWallet,
    amount: '1',
    itemsHash: hashJson([authorizedItem]),
    nonce: '0',
    deadline: Math.floor(Date.now() / 1000) + 3600,
  };
  const signature = await owner.signTypedData(
    settlementRequestDomain(executorWallet),
    settlementRequestTypes,
    intent,
  );
  return {
    requestId: hashJson({ intentId: intent.intentId, digest: settlementIntentDigest(intent).toLowerCase() }),
    selectedItemIndex: 0,
    intent,
    signature,
    items: [authorizedItem],
  };
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

function wallet(digit: string) {
  return new Wallet(`0x${digit.repeat(64)}`);
}

async function startRuntime(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SERVICE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await withTimeout(new Promise<void>((resolve, reject) => {
    const ready = (chunk: string) => {
      if (chunk.includes('EOA runtime listening')) {
        child.stdout.off('data', ready);
        resolve();
      }
    };
    child.stdout.on('data', ready);
    child.once('exit', (code) => reject(new Error(`EOA runtime exited before readiness (${code}): ${output}`)));
  }), 'EOA runtime readiness');
  return child;
}

async function stopRuntime(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await withTimeout(once(child, 'exit').then(() => undefined), 'EOA runtime shutdown');
}

async function fakeRpcServer(onBroadcast: (rawTransaction: string) => Promise<string>) {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest | RpcRequest[];
      const requests = Array.isArray(body) ? body : [body];
      const replies = await Promise.all(requests.map(async (item) => ({
        jsonrpc: '2.0',
        id: item.id,
        result: await rpcResult(item, onBroadcast),
      })));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    })().catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'RPC_ERROR' }));
    });
  });
  await listen(server, 0);
  return server;
}

interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

async function rpcResult(request: RpcRequest, onBroadcast: (rawTransaction: string) => Promise<string>) {
  if (request.method === 'eth_chainId') return '0x38';
  if (request.method === 'eth_blockNumber') return '0x1';
  if (request.method === 'eth_getTransactionCount') return '0x0';
  if (request.method === 'eth_gasPrice' || request.method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
  if (request.method === 'eth_estimateGas') return '0x186a0';
  if (request.method === 'eth_getBlockByNumber') return rpcBlock();
  if (request.method === 'eth_sendRawTransaction') return onBroadcast(String(request.params[0]));
  if (request.method === 'eth_getTransactionByHash' || request.method === 'eth_getTransactionReceipt') return null;
  throw new Error(`Unexpected RPC method ${request.method}`);
}

function rpcBlock() {
  return {
    number: '0x1',
    hash: HASH_1,
    parentHash: HASH_2,
    nonce: '0x0000000000000000',
    sha3Uncles: HASH_3,
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: HASH_1,
    stateRoot: HASH_2,
    receiptsRoot: HASH_3,
    miner: '0x0000000000000000000000000000000000000000',
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x1',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: '0x1',
    transactions: [],
    uncles: [],
    baseFeePerGas: '0x3b9aca00',
  };
}

async function unusedPort() {
  const server = createServer();
  await listen(server, 0);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function address(server: Server) {
  const value = server.address();
  if (!value || typeof value === 'string') throw new Error('Server address is unavailable');
  return value;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withTimeout<T>(operation: Promise<T>, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

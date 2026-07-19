import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Interface, Wallet, keccak256 } from 'ethers';
import { USDT_ADDRESS } from '../api/enums.ts';

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
    recipientAddress: recipient,
    amount: '1',
    transferCalldata: TRANSFER.encodeFunctionData('transfer', [recipient, 1n]).toLowerCase(),
    contentHash: HASH_2,
    gasLimit: '100000',
    requestDigest: HASH_3,
    idempotencyKey: 'settlement-runtime-response-loss-1',
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

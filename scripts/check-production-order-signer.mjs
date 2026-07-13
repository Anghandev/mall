#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
  Wallet
} from 'ethers';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SIGNER_ENTRY = join(ROOT, 'signer', 'index.mjs');
const CHAIN_ID = 31_337;
const ESCROW_ADDRESS = getAddress('0x1000000000000000000000000000000000000001');
const BUYER_ADDRESS = getAddress('0x2000000000000000000000000000000000000002');
const SELLER_ADDRESS = getAddress('0x3000000000000000000000000000000000000003');
const TOKEN = '6bb932c96f0abf5da8f9012a6a2ff71edeeecf8a5109a041bc579dfaeca31630';
const OPERATION = 'order-authorization.sign';
const MANAGED_ENV_NAMES = [
  'ORDER_SIGNER_PRIVATE_KEY',
  'ORDER_SIGNER_ADDRESS',
  'ORDER_SIGNER_CHAIN_ID',
  'ORDER_SIGNER_ESCROW_ADDRESS',
  'ORDER_SIGNING_WEBHOOK_TOKEN',
  'ORDER_SIGNER_ALLOWED_SOURCES',
  'ORDER_SIGNER_HOST',
  'ORDER_SIGNER_PORT',
  'ORDER_SIGNER_MAX_BODY_BYTES'
];
const ORDER_TYPES = {
  OrderAuthorization: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'productId', type: 'bytes32' },
    { name: 'nplAmount', type: 'uint256' },
    { name: 'bnmLocked', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'orderDigest', type: 'bytes32' },
    { name: 'splitVersion', type: 'uint32' }
  ]
};

let assertionCount = 0;
const processes = new Set();
const completedLogs = [];

function check(condition, message) {
  assertionCount += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertionCount += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}

function cleanEnvironment(overrides) {
  const env = { ...process.env };
  for (const name of MANAGED_ENV_NAMES) delete env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) delete env[name];
    else env[name] = String(value);
  }
  return env;
}

function baseSignerEnvironment(wallet, overrides = {}) {
  return cleanEnvironment({
    ORDER_SIGNER_PRIVATE_KEY: wallet.privateKey,
    ORDER_SIGNER_ADDRESS: wallet.address,
    ORDER_SIGNER_CHAIN_ID: String(CHAIN_ID),
    ORDER_SIGNER_ESCROW_ADDRESS: ESCROW_ADDRESS,
    ORDER_SIGNING_WEBHOOK_TOKEN: TOKEN,
    ORDER_SIGNER_HOST: '127.0.0.1',
    ORDER_SIGNER_PORT: '0',
    ORDER_SIGNER_MAX_BODY_BYTES: '4096',
    ...overrides
  });
}

function spawnSigner(env) {
  const child = spawn(process.execPath, [SIGNER_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processes.add(child);

  const state = {
    stdout: '',
    stderr: '',
    stdoutBuffer: '',
    stderrBuffer: '',
    events: []
  };
  let readyDone = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const readyTimer = setTimeout(() => {
    if (readyDone) return;
    readyDone = true;
    rejectReady(new Error('order signer ready timeout'));
  }, 5_000);

  const consume = (stream, chunk) => {
    const text = String(chunk);
    state[stream] += text;
    const bufferName = `${stream}Buffer`;
    state[bufferName] += text;
    const lines = state[bufferName].split('\n');
    state[bufferName] = lines.pop() || '';
    for (const line of lines) consumeLogLine(line);
  };
  const consumeLogLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      state.events.push(event);
      if (!readyDone && event.event === 'order_signer_ready') {
        readyDone = true;
        clearTimeout(readyTimer);
        resolveReady(event);
      }
    } catch {
      // Non-JSON output is retained and checked for secret leakage below.
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => consume('stdout', chunk));
  child.stderr.on('data', (chunk) => consume('stderr', chunk));

  const closed = new Promise((resolve) => {
    child.once('error', (error) => {
      if (!readyDone) {
        readyDone = true;
        clearTimeout(readyTimer);
        rejectReady(new Error(`order signer spawn failed: ${error.code || 'unknown'}`));
      }
    });
    child.once('close', (code, signal) => {
      consumeLogLine(state.stdoutBuffer);
      consumeLogLine(state.stderrBuffer);
      clearTimeout(readyTimer);
      if (!readyDone) {
        readyDone = true;
        rejectReady(new Error(`order signer exited before ready: ${code ?? signal ?? 'unknown'}`));
      }
      processes.delete(child);
      completedLogs.push(`${state.stdout}${state.stderr}`);
      resolve({ code, signal });
    });
  });

  return {
    child,
    ready,
    closed,
    state,
    logs: () => `${state.stdout}${state.stderr}`
  };
}

async function startSigner(env) {
  const processState = spawnSigner(env);
  const ready = await processState.ready;
  check(Number.isInteger(ready.port) && ready.port > 0, 'ready log must contain the bound port');
  equal(ready.host, '127.0.0.1', 'ready log host mismatch');
  return {
    ...processState,
    ready,
    baseUrl: `http://127.0.0.1:${ready.port}`
  };
}

async function stopSigner(processState) {
  check(processState.child.kill('SIGTERM'), 'SIGTERM must be delivered to signer process');
  const result = await processState.closed;
  equal(result.code, 0, 'signer must exit cleanly after SIGTERM');
  check(
    processState.state.events.some((event) => event.event === 'order_signer_stopped'),
    'signer must log graceful completion'
  );
}

function buildPayload() {
  const domain = {
    name: '24K Mall Escrow',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: ESCROW_ADDRESS
  };
  const value = {
    orderId: keccak256(toUtf8Bytes('production-signer-check-order')),
    buyer: BUYER_ADDRESS,
    seller: SELLER_ADDRESS,
    productId: keccak256(toUtf8Bytes('production-signer-check-product')),
    nplAmount: '1000000000000000000',
    bnmLocked: '1000000000000000000',
    deadline: Math.floor(Date.now() / 1000) + 900,
    orderDigest: keccak256(toUtf8Bytes('production-signer-check-digest')),
    splitVersion: 1
  };
  return {
    version: '24k-order-authorization-v1',
    domain,
    types: ORDER_TYPES,
    primaryType: 'OrderAuthorization',
    value,
    authorizationDigest: TypedDataEncoder.hash(domain, ORDER_TYPES, value)
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function requestJson(url, {
  method = 'POST',
  token = TOKEN,
  operation = OPERATION,
  contentType = 'application/json',
  body
} = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (operation !== null) headers['x-24k-operation'] = operation;
  if (contentType !== null) headers['content-type'] = contentType;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'error'
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { response, text, body: parsed };
}

function expectError(result, status, code) {
  equal(result.response.status, status, `expected HTTP ${status}`);
  deepEqual(result.body, { error: code }, 'error response must be sanitized and stable');
}

function assertNoSecrets(logs, privateKey) {
  const normalized = logs.toLowerCase();
  check(!normalized.includes(privateKey.slice(2).toLowerCase()), 'logs must not contain the private key');
  check(!normalized.includes(TOKEN.toLowerCase()), 'logs must not contain the shared token');
}

async function checkApiHasNoPrivateKey() {
  const sources = await Promise.all([
    readFile(join(ROOT, 'server', 'index.mjs'), 'utf8'),
    readFile(join(ROOT, 'server', 'integrations.mjs'), 'utf8')
  ]);
  check(
    sources.every((source) => !source.includes('ORDER_SIGNER_PRIVATE_KEY')),
    'production API source must not read the signer private key'
  );
}

async function run() {
  await checkApiHasNoPrivateKey();
  const wallet = Wallet.createRandom();
  const payload = buildPayload();
  const signer = await startSigner(baseSignerEnvironment(wallet));
  equal(signer.ready.signer, wallet.address, 'ready signer must match configured signer');

  const health = await requestJson(`${signer.baseUrl}/health`, {
    method: 'GET',
    token: null,
    operation: null,
    contentType: null
  });
  equal(health.response.status, 200, 'health must succeed without credentials');
  deepEqual(health.body, { status: 'ok' }, 'health response must remain minimal');
  equal(health.response.headers.get('cache-control'), 'no-store', 'health must not be cached');
  check(!health.text.includes(wallet.address), 'health must not expose signer address');

  const success = await requestJson(`${signer.baseUrl}/sign-order`, { body: payload });
  equal(success.response.status, 200, 'valid signing request must succeed');
  deepEqual(
    Object.keys(success.body).sort(),
    ['authorizationDigest', 'signature', 'signer'],
    'signing response must use canonical fields only'
  );
  equal(success.body.signer, wallet.address, 'response signer mismatch');
  equal(success.body.authorizationDigest, payload.authorizationDigest, 'response digest mismatch');
  const recovered = verifyTypedData(payload.domain, ORDER_TYPES, payload.value, success.body.signature);
  equal(getAddress(recovered), wallet.address, 'signature must recover to configured signer');

  const badToken = await requestJson(`${signer.baseUrl}/sign-order`, {
    token: `${TOKEN}bad`,
    body: payload
  });
  expectError(badToken, 401, 'UNAUTHORIZED');
  check(!badToken.text.includes(TOKEN), 'authentication failure must not echo token material');

  const extraFieldPayload = { ...clone(payload), unexpected: true };
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, { body: extraFieldPayload }),
    400,
    'INVALID_REQUEST'
  );

  const wrongDigestPayload = clone(payload);
  wrongDigestPayload.authorizationDigest = `0x${'11'.repeat(32)}`;
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, { body: wrongDigestPayload }),
    400,
    'INVALID_REQUEST'
  );

  const wrongChainPayload = clone(payload);
  wrongChainPayload.domain.chainId = CHAIN_ID + 1;
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, { body: wrongChainPayload }),
    400,
    'INVALID_REQUEST'
  );

  const invalidUintPayload = clone(payload);
  invalidUintPayload.value.splitVersion = '4294967296';
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, { body: invalidUintPayload }),
    400,
    'INVALID_REQUEST'
  );

  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, {
      contentType: 'text/plain',
      body: JSON.stringify(payload)
    }),
    415,
    'UNSUPPORTED_MEDIA_TYPE'
  );
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, {
      operation: 'order-authorization.inspect',
      body: payload
    }),
    400,
    'INVALID_REQUEST'
  );
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, { method: 'GET', body: undefined }),
    405,
    'METHOD_NOT_ALLOWED'
  );
  expectError(
    await requestJson(`${signer.baseUrl}/unknown`, { body: payload }),
    404,
    'NOT_FOUND'
  );
  expectError(
    await requestJson(`${signer.baseUrl}/sign-order`, {
      body: JSON.stringify({ ...payload, padding: 'x'.repeat(5_000) })
    }),
    413,
    'PAYLOAD_TOO_LARGE'
  );

  await stopSigner(signer);
  assertNoSecrets(signer.logs(), wallet.privateKey);

  const sourceOnly = await startSigner(baseSignerEnvironment(wallet, {
    ORDER_SIGNING_WEBHOOK_TOKEN: null,
    ORDER_SIGNER_ALLOWED_SOURCES: '127.0.0.1'
  }));
  const sourceOnlySuccess = await requestJson(`${sourceOnly.baseUrl}/sign-order`, {
    token: null,
    body: payload
  });
  equal(sourceOnlySuccess.response.status, 200, 'allowlisted source must work without shared token');
  equal(
    getAddress(verifyTypedData(payload.domain, ORDER_TYPES, payload.value, sourceOnlySuccess.body.signature)),
    wallet.address,
    'source-authorized signature must recover correctly'
  );
  await stopSigner(sourceOnly);
  assertNoSecrets(sourceOnly.logs(), wallet.privateKey);

  const wrongSignerWallet = Wallet.createRandom();
  const wrongSigner = spawnSigner(baseSignerEnvironment(wallet, {
    ORDER_SIGNER_ADDRESS: wrongSignerWallet.address
  }));
  const wrongSignerExit = await wrongSigner.closed;
  equal(wrongSignerExit.code, 1, 'mismatched signer configuration must fail startup');
  check(
    wrongSigner.state.events.some((event) => (
      event.event === 'order_signer_startup_failed'
      && event.code === 'ORDER_SIGNER_ADDRESS_MISMATCH'
    )),
    'mismatched signer startup failure must use a sanitized code'
  );
  assertNoSecrets(wrongSigner.logs(), wallet.privateKey);

  const invalidConfig = spawnSigner(baseSignerEnvironment(wallet, {
    ORDER_SIGNER_CHAIN_ID: '0'
  }));
  const invalidConfigExit = await invalidConfig.closed;
  equal(invalidConfigExit.code, 1, 'invalid chain configuration must fail startup');
  check(
    invalidConfig.state.events.some((event) => (
      event.event === 'order_signer_startup_failed'
      && event.code === 'ORDER_SIGNER_CHAIN_ID_INVALID'
    )),
    'invalid configuration failure must use a sanitized code'
  );
  assertNoSecrets(invalidConfig.logs(), wallet.privateKey);

  const missingAuth = spawnSigner(baseSignerEnvironment(wallet, {
    ORDER_SIGNING_WEBHOOK_TOKEN: null,
    ORDER_SIGNER_ALLOWED_SOURCES: null
  }));
  const missingAuthExit = await missingAuth.closed;
  equal(missingAuthExit.code, 1, 'missing signer authorization controls must fail startup');
  check(
    missingAuth.state.events.some((event) => event.code === 'ORDER_SIGNER_AUTH_NOT_CONFIGURED'),
    'missing authorization controls must report a sanitized configuration code'
  );
  assertNoSecrets(missingAuth.logs(), wallet.privateKey);

  for (const logs of completedLogs) assertNoSecrets(logs, wallet.privateKey);
  process.stdout.write(`Production order signer checks passed (${assertionCount} assertions).\n`);
}

try {
  await run();
} catch (error) {
  process.stderr.write(`Production order signer checks failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
} finally {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

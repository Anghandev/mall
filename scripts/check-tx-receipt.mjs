#!/usr/bin/env node
import fs from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const sourcePath = 'src/services/txReceipt.ts';
const source = fs.readFileSync(sourcePath, 'utf8');
const tempModulePath = resolve(`scripts/.txReceipt.check.${process.pid}.mjs`);
const TX = '0xabababababababababababababababababababababababababababababababab';

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false
  }
}).outputText;
fs.writeFileSync(tempModulePath, compiled);
try {
  const { waitForTransactionReceipt } = await import(`file://${tempModulePath}?t=${Date.now()}`);

  const successProvider = fakeProvider([null, { transactionHash: TX, status: '0x1', blockNumber: '0x10' }]);
  const success = await waitForTransactionReceipt(successProvider, TX, 1_000, 0);
  assert(success.blockNumber === '0x10', 'pending receipt should eventually resolve when blockNumber appears');
  assert(successProvider.calls.length === 2, 'success path should poll until receipt exists');
  assert(successProvider.calls.every((call) => call.method === 'eth_getTransactionReceipt'), 'should only call eth_getTransactionReceipt');
  assert(successProvider.calls.every((call) => call.params?.[0] === TX), 'should poll the requested tx hash');

  const failedProvider = fakeProvider([{ transactionHash: TX, status: '0x0', blockNumber: '0x11' }]);
  await assertRejects(
    () => waitForTransactionReceipt(failedProvider, TX, 1_000, 0),
    '交易失败：0xabababab...',
    'failed receipt should reject so fund failure cannot be treated as paid'
  );

  const noStatusProvider = fakeProvider([{ transactionHash: TX, blockNumber: '0x12' }]);
  const noStatus = await waitForTransactionReceipt(noStatusProvider, TX, 1_000, 0);
  assert(noStatus.blockNumber === '0x12', 'receipt without status should still resolve for wallet/RPC compatibility');

  const timeoutProvider = fakeProvider([]);
  await assertRejects(
    () => waitForTransactionReceipt(timeoutProvider, TX, 0, 0),
    '等待交易确认超时：0xabababab...',
    'timeout should give recoverable pending UX instead of marking paid'
  );

  assert(source.includes("receipt.status && receipt.status !== '0x1'"), 'source should reject non-success status');
  assert(source.includes('等待交易确认超时'), 'source should keep timeout copy');
  console.log('tx receipt check: PASS');
} finally {
  fs.rmSync(tempModulePath, { force: true });
}

function fakeProvider(responses) {
  const calls = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      return responses.length ? responses.shift() : null;
    }
  };
}

async function assertRejects(fn, expectedMessage, label) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof Error && error.message === expectedMessage, `${label}: unexpected error ${error}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

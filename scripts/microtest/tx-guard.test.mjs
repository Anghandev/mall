import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendTxLog,
  assertTxBudget,
  cumulativeSpendWei,
  nativeToWei,
  readTxLog,
  withExclusiveTxExecution,
} from './tx-guard.mjs';

const HASH_1 = `0x${'1'.repeat(64)}`;
const HASH_2 = `0x${'2'.repeat(64)}`;
const WALLET = '0x1111111111111111111111111111111111111111';

test('transaction ledger counts successful value, failed gas and rejects duplicate hashes', async () => {
  await withTemporaryWorkingDirectory(async () => {
    await withExclusiveTxExecution(async () => {
    appendTxLog({ hash: HASH_1, chainId: 56, wallet: WALLET, status: 'SUCCESS', gasCostWei: '10', valueWei: '20' });
    appendTxLog({ hash: HASH_2, chainId: 56, wallet: WALLET, status: 'FAILED', gasCostWei: '5', valueWei: '99' });
    assert.equal(cumulativeSpendWei(), 35n);
    assert.equal(readTxLog()[0].totalSpentWei, '30');
    assert.throws(
      () => appendTxLog({ hash: HASH_1, chainId: 56, wallet: WALLET, status: 'FAILED', gasCostWei: '1', valueWei: '0' }),
      /Duplicate transaction hash/,
    );
    const budget = assertTxBudget({
      env: { MAX_TX_VALUE_NATIVE: '1', MAX_TOTAL_BUDGET_NATIVE: '1', MAX_GAS_COST_PER_TX_NATIVE: '1' },
      operation: 'test',
      functionCall: 'test()',
      target: WALLET,
      valueWei: 20n,
      estimatedGas: 2n,
      maxFeePerGasWei: 5n,
      expectedResult: 'success',
    });
    assert.equal(budget.spentWei, 35n);
    assert.equal(budget.projectedWei, 65n);
    assert.throws(
      () =>
        assertTxBudget({
          env: {},
          operation: 'invalid',
          functionCall: 'invalid()',
          target: WALLET,
          valueWei: -1n,
          estimatedGas: 1n,
          maxFeePerGasWei: 1n,
          expectedResult: 'reject',
        }),
      /non-negative integer/,
    );
    });
  });
});

test('exclusive execution lock rejects a concurrent budget and receipt writer', async () => {
  await withTemporaryWorkingDirectory(async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = withExclusiveTxExecution(async () => gate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(withExclusiveTxExecution(async () => undefined), /execution is active/);
    release();
    await first;
    await withExclusiveTxExecution(async () => {
      assert.equal(readTxLog().length, 0);
    });
  });
});

test('transaction ledger rejects old schemas, corruption and invalid decimals', async () => {
  await withTemporaryWorkingDirectory(async () => {
    assert.throws(() => nativeToWei('-1'), /non-negative decimal/);
    assert.throws(() => nativeToWei('0.0000000000000000001'), /at most 18/);
    assert.throws(() => nativeToWei('1e-3'), /non-negative decimal/);
    mkdirSync('test-artifacts', { mode: 0o700 });
    writeFileSync(join('test-artifacts', 'tx-log.json'), JSON.stringify([{ costWei: '1' }]), { mode: 0o600 });
    assert.throws(() => readTxLog(), /gasCostWei/);
    writeFileSync(join('test-artifacts', 'tx-log.json'), '{broken', { mode: 0o600 });
    assert.throws(() => readTxLog(), /invalid/);
  });
});

async function withTemporaryWorkingDirectory(operation) {
  const directory = mkdtempSync(join(tmpdir(), 'abu24k-tx-guard-'));
  const previous = process.cwd();
  process.chdir(directory);
  try {
    await operation();
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
}

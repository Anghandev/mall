import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const OTHER_TARGET = '0x2222222222222222222222222222222222222222';
const ARTIFACT = '2.0.0-test.1';
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const BUDGET_ENV = {
  MAINNET_MICROTEST_PACKET_PATH: 'packet.json',
  MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX: '1',
  MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '1',
  MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB: '1',
};

test('transaction ledger counts successful value, failed gas and rejects duplicate hashes', async () => {
  await withTemporaryWorkingDirectory(async () => {
    await withExclusiveTxExecution(async () => {
    writeApprovedPacket();
    const preflightResult = preflightResultFor('packet.json');
    appendTxLog({ hash: HASH_1, chainId: 56, wallet: WALLET, status: 'SUCCESS', gasCostWei: '10', valueWei: '20' });
    appendTxLog({ hash: HASH_2, chainId: 56, wallet: WALLET, status: 'FAILED', gasCostWei: '5', valueWei: '99' });
    assert.equal(cumulativeSpendWei(), 35n);
    assert.equal(readTxLog()[0].totalSpentWei, '30');
    assert.throws(
      () => appendTxLog({ hash: HASH_1, chainId: 56, wallet: WALLET, status: 'FAILED', gasCostWei: '1', valueWei: '0' }),
      /Duplicate transaction hash/,
    );
    const budget = assertTxBudget({
      env: BUDGET_ENV,
      preflightResult,
      operation: 'test',
      functionCall: 'test()',
      wallet: WALLET,
      target: WALLET,
      calldataHash: HASH_1,
      nonce: '7',
      valueWei: 20n,
      estimatedGas: 2n,
      maxFeePerGasWei: 5n,
      expectedResult: 'success',
    });
    assert.equal(budget.spentWei, 35n);
    assert.equal(budget.projectedWei, 65n);
    assertTxBudget({
      env: BUDGET_ENV,
      preflightResult,
      operation: 'hash-bound',
      functionCall: 'transfer(address,uint256)',
      wallet: WALLET,
      target: WALLET,
      calldataHash: HASH_1,
      nonce: '7',
      valueWei: 0n,
      estimatedGas: 1n,
      maxFeePerGasWei: 1n,
      expectedResult: 'success',
    });
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult,
        operation: 'hash-bound',
        functionCall: 'transfer(address,uint256)',
        wallet: WALLET,
        target: WALLET,
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject missing calldata binding',
      }),
      /calldataHash is invalid/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult,
        operation: 'hash-bound',
        functionCall: 'transfer(address,uint256)',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_2,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject wrong calldata',
      }),
      /does not authorize this signer/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult,
        operation: 'hash-bound',
        functionCall: 'transfer(address,uint256)',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '8',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject wrong nonce',
      }),
      /does not authorize this signer/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        operation: 'test',
        functionCall: 'test()',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject missing preflight',
      }),
      /requires the current Abu V2 preflight result/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult,
        operation: 'high gas estimate',
        functionCall: 'approve()',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: nativeToWei('2'),
        maxFeePerGasWei: nativeToWei('3'),
        expectedResult: 'reject high gas',
      }),
      /estimated gas cost exceeds/,
    );
    assert.throws(
      () => assertTxBudget({
        env: { ...BUDGET_ENV, MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '2' },
        preflightResult,
        operation: 'env over packet',
        functionCall: 'approve()',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject env budget',
      }),
      /exceeds packet maxGasCostPerTxBnb/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult,
        operation: 'test',
        functionCall: 'test()',
        wallet: WALLET,
        target: OTHER_TARGET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject wrong target',
      }),
      /does not authorize this signer/,
    );
    assert.throws(
      () => assertTxBudget({
        env: BUDGET_ENV,
        preflightResult: { ...preflightResult, packetSha256: HASH_1.slice(2) },
        operation: 'test',
        functionCall: 'test()',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject stale packet',
      }),
      /packet sha256/,
    );
    writeApprovedPacket({ bnbBudget: undefined }, 'packet-missing-budget.json');
    const missingBudgetPreflight = preflightResultFor('packet-missing-budget.json');
    assert.throws(
      () => assertTxBudget({
        env: { ...BUDGET_ENV, MAINNET_MICROTEST_PACKET_PATH: 'packet-missing-budget.json' },
        preflightResult: missingBudgetPreflight,
        operation: 'missing budget',
        functionCall: 'approve()',
        wallet: WALLET,
        target: WALLET,
        calldataHash: HASH_1,
        nonce: '7',
        valueWei: 0n,
        estimatedGas: 1n,
        maxFeePerGasWei: 1n,
        expectedResult: 'reject missing packet budget',
      }),
      /approved BNB ceilings/,
    );
    assert.throws(
      () =>
        assertTxBudget({
          env: BUDGET_ENV,
          preflightResult,
          operation: 'invalid',
          functionCall: 'invalid()',
          wallet: WALLET,
          target: WALLET,
          calldataHash: HASH_1,
          nonce: '7',
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


function writeApprovedPacket(overrides = {}, filename = 'packet.json') {
  writeFileSync(filename, JSON.stringify({
    schema: 'abu24k-v2-mainnet-microtest-acceptance-v1',
    chainId: 56,
    artifactVersion: ARTIFACT,
    gitCommit: COMMIT,
    bnbBudget: {
      maxNativeValuePerTxBnb: '1',
      maxGasCostPerTxBnb: '1',
      maxTotalNativeSpendBnb: '1',
    },
    transactions: [
      { operation: 'test', functionCall: 'test()', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '20', gasLimit: '2', maxFeePerGasWei: '5' },
      { operation: 'hash-bound', functionCall: 'transfer(address,uint256)', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '0', gasLimit: '1', maxFeePerGasWei: '1' },
      { operation: 'high gas estimate', functionCall: 'approve()', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '0', gasLimit: nativeToWei('2').toString(), maxFeePerGasWei: nativeToWei('3').toString() },
      { operation: 'env over packet', functionCall: 'approve()', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '0', gasLimit: '1', maxFeePerGasWei: '1' },
      { operation: 'missing budget', functionCall: 'approve()', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '0', gasLimit: '1', maxFeePerGasWei: '1' },
      { operation: 'invalid', functionCall: 'invalid()', target: WALLET, wallet: WALLET, calldataHash: HASH_1, nonce: '7', valueWei: '0', gasLimit: '1', maxFeePerGasWei: '1' },
    ],
    ...overrides,
  }), { mode: 0o600 });
}

function preflightResultFor(filename) {
  return {
    artifactVersion: ARTIFACT,
    gitCommit: COMMIT,
    packetSha256: createHash('sha256').update(readFileSync(filename)).digest('hex'),
    deploymentAuthorized: true,
    releaseGateStatus: 'GO',
  };
}

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

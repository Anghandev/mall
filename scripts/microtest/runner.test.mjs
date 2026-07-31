import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256 } from 'ethers';
import { PRIVATE_KEY_ENV, normalizeRunnerTransactions, runAbuV2Runner } from './runner.mjs';

const ARTIFACT = '2.0.0-test.1';
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const WALLET = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'1'.repeat(64)}`;
const SIGNED_RAW = '0x123456';
const TX_HASH = keccak256(SIGNED_RAW);
const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const DATA = '0x1234';
const DATA_HASH = keccak256(DATA).toLowerCase();

test('runner local signer env includes all MICROTEST_BUYER_1/2/3 buyer key labels', () => {
  assert.ok(PRIVATE_KEY_ENV.includes('MICROTEST_BUYER_1_PRIVATE_KEY'));
  assert.ok(PRIVATE_KEY_ENV.includes('MICROTEST_BUYER_2_PRIVATE_KEY'));
  assert.ok(PRIVATE_KEY_ENV.includes('MICROTEST_BUYER_3_PRIVATE_KEY'));
  assert.equal(PRIVATE_KEY_ENV.includes('WALLET_1_PRIVATE_KEY'), false);
  assert.equal(PRIVATE_KEY_ENV.includes('WALLET_5_PRIVATE_KEY'), false);
  assert.equal(PRIVATE_KEY_ENV.includes('WALLET_6_PRIVATE_KEY'), false);
});

test('runner calls broadcast preflight, executes only packet-bound calldata and records spend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-runner-'));
  try {
    const packetPath = join(root, 'packet.json');
    const packet = packetFixture();
    writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
    chmodSync(packetPath, 0o600);
    const preflight = {
      artifactVersion: ARTIFACT,
      gitCommit: COMMIT,
      packetPath,
      packetSha256: createHash('sha256').update(readFileSync(packetPath)).digest('hex'),
      deploymentAuthorized: false,
      releaseGateStatus: 'MICROTEST_AUTHORIZED',
      microtestBroadcastAuthorized: true,
    };
    let preflightCalled = false;
    const fakeProvider = {
      getNetwork: async () => ({ chainId: 56n }),
      getTransactionCount: async (wallet, state) => {
        assert.equal(wallet, WALLET);
        assert.equal(state, 'pending');
        return 7;
      },
      call: async (request) => {
        assert.equal(request.data, DATA);
        return '0x';
      },
      estimateGas: async () => 21_000n,
      getFeeData: async () => ({ gasPrice: 5n }),
      broadcastTransaction: async (raw) => {
        assert.equal(raw, SIGNED_RAW);
        return {
          hash: TX_HASH,
          wait: async (confirmations) => {
            assert.equal(confirmations, 15);
            return receiptFixture();
          },
        };
      },
      getTransactionReceipt: async (hash) => {
        assert.equal(hash, TX_HASH);
        return receiptFixture();
      },
      getBlockNumber: async () => 114,
      getBlock: async (blockNumber) => {
        assert.equal(blockNumber, 100);
        return { hash: BLOCK_HASH };
      },
    };
    const result = await runAbuV2Runner({
      cwd: root,
      env: {
        BSC_RPC_URL: 'https://bsc.example.invalid',
        BSC_FALLBACK_RPC_URL: 'https://bsc-fallback.example.invalid',
        MAINNET_MICROTEST_PACKET_PATH: 'packet.json',
        MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX: '0',
        MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '1',
        MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB: '1',
      },
      provider: fakeProvider,
      fallbackProvider: fakeProvider,
      runPreflight: async (input) => {
        preflightCalled = true;
        assert.equal(input.requireBroadcastAuthorized, true);
        return preflight;
      },
      signerFactory: async (wallet) => ({
        address: wallet,
        signTransaction: async (request) => {
          assert.equal(request.to, TARGET);
          assert.equal(request.data, DATA);
          assert.equal(request.nonce, 7);
          return SIGNED_RAW;
        },
      }),
    });
    assert.equal(preflightCalled, true);
    assert.deepEqual(result.hashes, [TX_HASH]);
    const log = JSON.parse(readFileSync(join(root, 'test-artifacts', 'tx-log.json'), 'utf8'));
    assert.equal(log.length, 1);
    assert.equal(log[0].hash, TX_HASH);
    assert.equal(log[0].status, 'SUCCESS');
    assert.equal(log[0].gasCostWei, '105000');
    assert.equal(log[0].packetCalldataHash, DATA_HASH);
    assert.equal(log[0].rawTransactionHash, TX_HASH);
    const rawLog = JSON.parse(readFileSync(join(root, 'test-artifacts', 'signed-raw-transactions.json'), 'utf8'));
    assert.equal(rawLog[0].signedRawTransaction, SIGNED_RAW);
    assert.equal(rawLog[0].hash, TX_HASH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner packet normalization rejects unbound calldata and over-budget token value', () => {
  assert.throws(
    () => normalizeRunnerTransactions(packetFixture({ transactions: [{ ...packetFixture().transactions[0], calldataHash: HASH }] })),
    /calldataHash does not match calldata/,
  );
  assert.throws(
    () => normalizeRunnerTransactions(packetFixture({ transactions: [{ ...packetFixture().transactions[0], tokenValueUsdtAtomic: '3000000000000000001' }] })),
    /exceeds 3 USDT/,
  );
  assert.throws(
    () => normalizeRunnerTransactions({ transactions: [{ ...packetFixture().transactions[0], nonce: undefined }] }),
    /nonce must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeRunnerTransactions({ transactions: [{ ...packetFixture().transactions[0], valueWei: undefined }] }),
    /valueWei is required/,
  );
  assert.throws(
    () => normalizeRunnerTransactions({ transactions: [{ ...packetFixture().transactions[0], gasLimit: undefined }] }),
    /gasLimit must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeRunnerTransactions({ transactions: [{ ...packetFixture().transactions[0], tokenValueUsdtAtomic: undefined }] }),
    /tokenValueUsdtAtomic must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeRunnerTransactions({ transactions: [
      packetFixture().transactions[0],
      { ...packetFixture().transactions[0], sequence: 1, operation: 'duplicate sequence' },
    ] }),
    /transactions\[1\]\.sequence must be 2/,
  );
});

test('runner fails preflight before touching RPC provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-runner-'));
  try {
    await assert.rejects(
      runAbuV2Runner({
        cwd: root,
        env: {},
        provider: {
          getNetwork: async () => {
            throw new Error('provider touched before preflight');
          },
        },
        runPreflight: async (input) => {
          assert.equal(input.requireBroadcastAuthorized, true);
          throw new Error('preflight failed first');
        },
        preflightOptions: { requireBroadcastAuthorized: false },
      }),
      /preflight failed first/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner records submitted hash before receipt wait failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-runner-'));
  try {
    const packetPath = join(root, 'packet.json');
    const packet = packetFixture();
    writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
    chmodSync(packetPath, 0o600);
    const preflight = {
      artifactVersion: ARTIFACT,
      gitCommit: COMMIT,
      packetPath,
      packetSha256: createHash('sha256').update(readFileSync(packetPath)).digest('hex'),
      deploymentAuthorized: false,
      releaseGateStatus: 'MICROTEST_AUTHORIZED',
      microtestBroadcastAuthorized: true,
    };
    const fakeProvider = {
      getNetwork: async () => ({ chainId: 56n }),
      getTransactionCount: async () => 7,
      call: async () => '0x',
      estimateGas: async () => 21_000n,
      getFeeData: async () => ({ gasPrice: 5n }),
      broadcastTransaction: async () => ({
        hash: TX_HASH,
        wait: async () => {
          throw new Error('receipt RPC disconnected');
        },
      }),
    };
    await assert.rejects(
      runAbuV2Runner({
        cwd: root,
        env: {
          BSC_RPC_URL: 'https://bsc.example.invalid',
          BSC_FALLBACK_RPC_URL: 'https://bsc-fallback.example.invalid',
          MAINNET_MICROTEST_PACKET_PATH: 'packet.json',
          MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX: '0',
          MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '1',
          MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB: '1',
        },
        provider: fakeProvider,
        fallbackProvider: fakeProvider,
        runPreflight: async () => preflight,
        signerFactory: async (wallet) => ({
          address: wallet,
          signTransaction: async () => SIGNED_RAW,
        }),
      }),
      /waitForReceipt failed/,
    );
    const log = JSON.parse(readFileSync(join(root, 'test-artifacts', 'tx-log.json'), 'utf8'));
    assert.equal(log.length, 1);
    assert.equal(log[0].hash, TX_HASH);
    assert.equal(log[0].status, 'SUBMITTED');
    assert.equal(log[0].gasCostWei, '210000');
    assert.equal(log[0].totalSpentWei, '210000');
    const rawLog = JSON.parse(readFileSync(join(root, 'test-artifacts', 'signed-raw-transactions.json'), 'utf8'));
    assert.equal(rawLog[0].hash, TX_HASH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner redacts provider error messages before returning them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-runner-'));
  const leakedData = `0x${'f'.repeat(128)}`;
  try {
    const packetPath = join(root, 'packet.json');
    const packet = packetFixture({ transactions: [{ ...packetFixture().transactions[0], calldata: leakedData, calldataHash: keccak256(leakedData).toLowerCase() }] });
    writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
    chmodSync(packetPath, 0o600);
    const preflight = {
      artifactVersion: ARTIFACT,
      gitCommit: COMMIT,
      packetPath,
      packetSha256: createHash('sha256').update(readFileSync(packetPath)).digest('hex'),
      deploymentAuthorized: false,
      releaseGateStatus: 'MICROTEST_AUTHORIZED',
      microtestBroadcastAuthorized: true,
    };
    const fakeProvider = {
      getNetwork: async () => ({ chainId: 56n }),
      getTransactionCount: async () => 7,
      call: async () => {
        throw new Error(`revert target=${TARGET} data=${leakedData} url=https://user:secret@example.invalid/rpc`);
      },
    };
    await assert.rejects(
      runAbuV2Runner({
        cwd: root,
        env: {
          BSC_RPC_URL: 'https://bsc.example.invalid',
          BSC_FALLBACK_RPC_URL: 'https://bsc-fallback.example.invalid',
          MAINNET_MICROTEST_PACKET_PATH: 'packet.json',
          MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX: '0',
          MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '1',
          MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB: '1',
        },
        provider: fakeProvider,
        fallbackProvider: fakeProvider,
        runPreflight: async () => preflight,
        signerFactory: async (wallet) => ({ address: wallet }),
      }),
      (error) => {
        assert.match(error.message, /callStatic failed/);
        assert.doesNotMatch(error.message, new RegExp(TARGET, 'i'));
        assert.doesNotMatch(error.message, new RegExp(leakedData, 'i'));
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function packetFixture(overrides = {}) {
  return {
    schema: 'abu24k-v2-mainnet-microtest-acceptance-v1',
    broadcastAuthorized: true,
    chainId: 56,
    artifactVersion: ARTIFACT,
    gitCommit: COMMIT,
    buyerWallets: [WALLET, '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444'],
    buyerLabels: ['MICROTEST_BUYER_1', 'MICROTEST_BUYER_2', 'MICROTEST_BUYER_3'],
    bnbBudget: {
      maxNativeValuePerTxBnb: '0',
      maxGasCostPerTxBnb: '1',
      maxTotalNativeSpendBnb: '1',
    },
    transactions: [{
      sequence: 1,
      operation: 'packet payment',
      functionCall: 'pay(tuple,bytes,bytes)',
      wallet: WALLET,
      target: TARGET,
      calldata: DATA,
      calldataHash: DATA_HASH,
      nonce: '7',
      valueWei: '0',
      maxFeePerGasWei: '10',
      gasLimit: '21000',
      tokenValueUsdtAtomic: '3000000000000000000',
      expectedResult: 'status-1 receipt',
    }],
    ...overrides,
  };
}

function receiptFixture(overrides = {}) {
  return {
    status: 1,
    gasUsed: 21_000n,
    gasPrice: 5n,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    ...overrides,
  };
}

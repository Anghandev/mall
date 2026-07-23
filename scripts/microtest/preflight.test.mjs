import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet } from 'ethers';
import { validateAbuV2Preflight } from './preflight.mjs';

const HASH = `0x${'1'.repeat(64)}`;
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const ARTIFACT = '2.0.0-fulfillment-launch.30';
const TEST_KEYS = Object.freeze({
  BUYER1: privateKey(11),
  BUYER2: privateKey(12),
  BUYER3: privateKey(13),
  W1: privateKey(1),
  W3: privateKey(3),
  W5: privateKey(5),
  W6: privateKey(6),
  AUTH: privateKey(20),
  OTHER: privateKey(9),
});

test('Abu V2 preflight accepts a commit-bound MICROTEST_BUYER_1/2/3-labeled three-buyer packet', () => {
  withFixture((root, env, packetPath) => {
    const result = validateAbuV2Preflight({ cwd: root, env, packetPath, gitCommit: COMMIT });
    assert.equal(result.artifactVersion, ARTIFACT);
    assert.equal(result.buyerWallets.length, 3);
    assert.match(result.packetSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.packetBnbBudget.maxGasCostPerTxWei, '1000000000000000');
  });
});

test('Abu V2 preflight rejects protocol-role buyers and stale packets', () => {
  withFixture((root, env, packetPath) => {
    assert.throws(
      () => validateAbuV2Preflight({
        cwd: root,
        env: { ...env, MAINNET_MICROTEST_BUYER_WALLETS: [env.NPL_REWARD_WALLET_ADDRESS, buyer(2), buyer(3)].join(',') },
        packetPath,
        gitCommit: COMMIT,
      }),
      /protocol role NPL_REWARD_WALLET_ADDRESS/,
    );

    const stalePacket = join(root, 'packet-stale.json');
    writeFileSync(stalePacket, JSON.stringify(packet({ artifactVersion: '2.0.0-old' })), { mode: 0o600 });
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: stalePacket, gitCommit: COMMIT }),
      /artifactVersion/,
    );
  });
});

test('Abu V2 preflight rejects stale or non-deployed contract manifests', () => {
  withFixture((root, env, packetPath) => {
    writeContractManifest(root, { artifactVersion: '2.0.0-old' });
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env: envForPacket(packetPath), packetPath, gitCommit: COMMIT }),
      /contract manifest artifactVersion/,
    );
  });

  withFixture((root, env, packetPath) => {
    writeContractManifest(root, { chain: { name: 'BSC Testnet', chainId: 97 } });
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env: envForPacket(packetPath), packetPath, gitCommit: COMMIT }),
      /BSC chainId 56/,
    );
  });

  withFixture((root, env, packetPath) => {
    writeContractManifest(root, { deploymentStatus: 'PENDING' });
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env: envForPacket(packetPath), packetPath, gitCommit: COMMIT }),
      /deploymentStatus must be DEPLOYED/,
    );
  });

  withFixture((root, env, packetPath) => {
    writeContractManifest(root, {
      contracts: [
        contract('PolicyRegistryV2', 'a'),
        { ...contract('BeneficiaryRegistryV2', 'b'), status: 'PENDING' },
        contract('PaymentRouterV2', 'c'),
      ],
    });
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env: envForPacket(packetPath), packetPath, gitCommit: COMMIT }),
      /BeneficiaryRegistryV2 deployment status must be DEPLOYED/,
    );
  });
});

test('Abu V2 preflight requires packet-bound MICROTEST_BUYER_1/2/3 buyer wallets', () => {
  withFixture((root, env) => {
    const missingBuyers = writePacket(root, 'packet-missing-buyers.json', packet({ buyerWallets: undefined }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: missingBuyers, gitCommit: COMMIT }),
      /explicitly bind exactly three MICROTEST_BUYER_1\/2\/3/,
    );

    const wrongCount = writePacket(root, 'packet-two-buyers.json', packet({ buyerWallets: [buyer(1), buyer(2)] }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: wrongCount, gitCommit: COMMIT }),
      /explicitly bind exactly three MICROTEST_BUYER_1\/2\/3/,
    );

    const mismatch = writePacket(root, 'packet-mismatch-buyers.json', packet({ buyerWallets: [buyer(1), buyer(2), buyer(9)] }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: mismatch, gitCommit: COMMIT }),
      /does not match MAINNET_MICROTEST_BUYER_WALLETS/,
    );

    const missingLabels = writePacket(root, 'packet-missing-labels.json', packet({ buyerLabels: undefined }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: missingLabels, gitCommit: COMMIT }),
      /packet buyer label\[0\] must be exactly one of MICROTEST_BUYER_1\/2\/3/,
    );

    const w3Label = writePacket(root, 'packet-w3-label.json', packet({ buyerLabels: ['MICROTEST_BUYER_1', 'MICROTEST_BUYER_2', 'W3'] }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: w3Label, gitCommit: COMMIT }),
      /must be exactly one of MICROTEST_BUYER_1\/2\/3/,
    );

    const w3AddressAsW6 = writePacket(root, 'packet-w3-address-as-w6.json', packet({
      broadcastAuthorized: true,
      buyerWallets: [buyer(1), buyer(2), walletForKey(TEST_KEYS.W3)],
      buyerLabels: ['MICROTEST_BUYER_1', 'MICROTEST_BUYER_2', 'MICROTEST_BUYER_3'],
    }));
    assert.throws(
      () => validateAbuV2Preflight({
        cwd: root,
        env: {
          ...envForPacket(w3AddressAsW6),
          MAINNET_MICROTEST_BUYER_WALLETS: [buyer(1), buyer(2), walletForKey(TEST_KEYS.W3)].join(','),
        },
        packetPath: w3AddressAsW6,
        gitCommit: COMMIT,
        requireBroadcastAuthorized: true,
      }),
      /WALLET_3_PRIVATE_KEY must not be a mainnet micro-test buyer/,
    );

    const missingBudget = writePacket(root, 'packet-missing-budget.json', packet({ bnbBudget: undefined }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: missingBudget, gitCommit: COMMIT }),
      /approved BNB ceilings/,
    );

    const envAbovePacket = writePacket(root, 'packet-low-gas-budget.json', packet({ bnbBudget: { maxNativeValuePerTxBnb: '0', maxGasCostPerTxBnb: '0.0001', maxTotalNativeSpendBnb: '0.01' } }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: envAbovePacket, gitCommit: COMMIT }),
      /MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB exceeds packet maxGasCostPerTxBnb/,
    );
  });
});



test('Abu V2 broadcast runner preflight requires bounded packet authorization through external MICROTEST authorization', () => {
  withFixture((root, env) => {
    const broadcastPacket = writePacket(root, 'packet-broadcast.json', packet({ broadcastAuthorized: false }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: broadcastPacket, gitCommit: COMMIT, requireBroadcastAuthorized: true }),
      /micro-test packet is not broadcastAuthorized/,
    );
  });

  withFixture((root, env) => {
    const missingEvidencePacket = writePacket(root, 'packet-broadcast-missing-evidence.json', packet({
      broadcastAuthorized: true,
      broadcastAuthorizationEvidenceHash: undefined,
    }));
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env: envForPacket(missingEvidencePacket), packetPath: missingEvidencePacket, gitCommit: COMMIT, requireBroadcastAuthorized: true }),
      /broadcast authorization evidence hash/,
    );
  });

  withFixture((root) => {
    const productionGoPacket = writePacket(root, 'packet-production-go.json', packet({ broadcastAuthorized: true }));
    assert.throws(
      () => validateAbuV2Preflight({
        cwd: root,
        env: envForPacket(productionGoPacket, { status: 'GO' }),
        packetPath: productionGoPacket,
        gitCommit: COMMIT,
        requireBroadcastAuthorized: true,
      }),
      /Release authorization status GO is not allowed/,
    );
  });

  withFixture((root) => {
    const broadcastPacket = writePacket(root, 'packet-broadcast-go.json', packet({ broadcastAuthorized: true }));
    const result = validateAbuV2Preflight({ cwd: root, env: envForPacket(broadcastPacket), packetPath: broadcastPacket, gitCommit: COMMIT, requireBroadcastAuthorized: true });
    assert.equal(result.deploymentAuthorized, false);
    assert.equal(result.releaseGateStatus, 'MICROTEST_AUTHORIZED');
    assert.equal(result.microtestBroadcastAuthorized, true);
  });
});

test('MICROTEST authorization is signer-pinned and does not require final evidence archive', () => {
  withFixture((root, env, packetPath) => {
    const microtestEnv = { ...env };
    delete microtestEnv.RELEASE_EVIDENCE_ARCHIVE_SHA256;
    assert.equal(
      validateAbuV2Preflight({ cwd: root, env: microtestEnv, packetPath, gitCommit: COMMIT }).releaseGateStatus,
      'MICROTEST_AUTHORIZED',
    );
    assert.throws(
      () => validateAbuV2Preflight({
        cwd: root,
        env: { ...microtestEnv, RELEASE_AUTHORIZATION_SIGNER_ADDRESS: walletForKey(TEST_KEYS.OTHER) },
        packetPath,
        gitCommit: COMMIT,
      }),
      /signer is not the configured trusted signer/,
    );
  });
});

test('Abu V2 broadcast preflight probes DB, queue, signer, executors and BNM before broadcast', async () => {
  await withFixtureAsync(async (root, envForPacket) => {
    const broadcastPacket = writePacket(root, 'packet-broadcast-go.json', packet({ broadcastAuthorized: true }));
    const calls = [];
    const probe = {
      postgres: async (_url, label) => { calls.push(`postgres:${label}`); },
      redis: async (_url, label) => { calls.push(`redis:${label}`); },
      signer: async () => { calls.push('signer'); },
      executor: async (_url, _token, label) => { calls.push(`executor:${label}`); },
      bnm: async () => { calls.push('bnm'); },
    };
    const { runAbuV2Preflight } = await import('./preflight.mjs');
    const result = await runAbuV2Preflight({
      cwd: root,
      env: envForPacket(broadcastPacket),
      packetPath: broadcastPacket,
      gitCommit: COMMIT,
      requireBroadcastAuthorized: true,
      skipRpc: true,
      externalProbe: probe,
    });
    assert.equal(result.broadcastRequired, true);
    assert.deepEqual(calls.sort(), [
      'bnm',
      'executor:governance executor',
      'executor:settlement executor',
      'postgres:audit database',
      'postgres:business database',
      'redis:Redis',
      'redis:queue Redis',
      'signer',
    ]);
  });
});

test('Abu V2 broadcast preflight stops on a dead dependency before runner approval', async () => {
  await withFixtureAsync(async (root, envForPacket) => {
    const broadcastPacket = writePacket(root, 'packet-broadcast-go.json', packet({ broadcastAuthorized: true }));
    const { runAbuV2Preflight } = await import('./preflight.mjs');
    await assert.rejects(
      () => runAbuV2Preflight({
        cwd: root,
        env: envForPacket(broadcastPacket),
        packetPath: broadcastPacket,
        gitCommit: COMMIT,
        requireBroadcastAuthorized: true,
        skipRpc: true,
        externalProbe: {
          postgres: async (_url, label) => {
            if (label === 'business database') throw new Error('business database readiness check failed');
          },
          redis: async () => undefined,
          signer: async () => undefined,
          executor: async () => undefined,
          bnm: async () => undefined,
        },
      }),
      /business database readiness check failed/,
    );
  });
});

test('Abu V2 preflight requires mode-600 private packet files', () => {
  withFixture((root, env) => {
    const openPacket = join(root, 'packet-open.json');
    writeFileSync(openPacket, JSON.stringify(packet()), { mode: 0o644 });
    chmodSync(openPacket, 0o644);
    assert.throws(
      () => validateAbuV2Preflight({ cwd: root, env, packetPath: openPacket, gitCommit: COMMIT }),
      /mode 600/,
    );
  });
});

test('Abu V2 preflight binds the expected mode-600 packet sha256', () => {
  withFixture((root, env, packetPath) => {
    assert.throws(
      () => validateAbuV2Preflight({
        cwd: root,
        env: { ...env, MAINNET_MICROTEST_PACKET_SHA256: '0'.repeat(64) },
        packetPath,
        gitCommit: COMMIT,
      }),
      /packetSha256 does not match MAINNET_MICROTEST_PACKET_SHA256/,
    );
  });
});

function withFixture(operation, coordinatedManifest = {}) {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-v2-preflight-'));
  try {
    mkdirSync(join(root, 'packages/core-artifacts/contracts'), { recursive: true });
    mkdirSync(join(root, 'packages/core-artifacts/openapi'), { recursive: true });
    writeFileSync(join(root, 'packages/core-artifacts/package.json'), JSON.stringify({ version: ARTIFACT }));
    writeFileSync(join(root, 'packages/core-artifacts/coordinated-manifest.json'), JSON.stringify({
      artifactVersion: ARTIFACT,
      deploymentAuthorized: false,
      deploymentAuthorizationEvidenceHash: null,
      releaseGateStatus: 'EXTERNAL_AUTHORIZATION_REQUIRED',
      ...coordinatedManifest,
    }));
    writeFileSync(join(root, 'packages/core-artifacts/openapi/openapi.json'), JSON.stringify({ 'x-artifactVersion': ARTIFACT }));
    writeFileSync(join(root, 'packages/core-artifacts/SHA256SUMS'), `${'1'.repeat(64)}  package.json\n`);
    writeContractManifest(root);
    const packetPath = join(root, 'packet.json');
    writeFileSync(packetPath, JSON.stringify(packet()), { mode: 0o600 });
    chmodSync(packetPath, 0o600);
    operation(root, envForPacket(packetPath), packetPath, envForPacket);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withFixtureAsync(operation, coordinatedManifest = {}) {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-v2-preflight-'));
  try {
    mkdirSync(join(root, 'packages/core-artifacts/contracts'), { recursive: true });
    mkdirSync(join(root, 'packages/core-artifacts/openapi'), { recursive: true });
    writeFileSync(join(root, 'packages/core-artifacts/package.json'), JSON.stringify({ version: ARTIFACT }));
    writeFileSync(join(root, 'packages/core-artifacts/coordinated-manifest.json'), JSON.stringify({
      artifactVersion: ARTIFACT,
      deploymentAuthorized: false,
      deploymentAuthorizationEvidenceHash: null,
      releaseGateStatus: 'EXTERNAL_AUTHORIZATION_REQUIRED',
      ...coordinatedManifest,
    }));
    writeFileSync(join(root, 'packages/core-artifacts/openapi/openapi.json'), JSON.stringify({ 'x-artifactVersion': ARTIFACT }));
    writeFileSync(join(root, 'packages/core-artifacts/SHA256SUMS'), `${'1'.repeat(64)}  package.json\n`);
    writeContractManifest(root);
    await operation(root, envForPacket);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePacket(root, filename, value) {
  const packetPath = join(root, filename);
  writeFileSync(packetPath, JSON.stringify(value), { mode: 0o600 });
  chmodSync(packetPath, 0o600);
  return packetPath;
}

function envForPacket(packetPath, authorizationOverrides = {}) {
  const releaseAuthorization = writeReleaseAuthorization(packetPath, authorizationOverrides);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    CHAIN_ID: '56',
    TARGET_CHAIN: 'bsc',
    BSC_RPC_URL: 'https://primary.example.invalid',
    BSC_FALLBACK_RPC_URL: 'https://fallback.example.invalid',
    DATABASE_URL: 'postgres://db',
    AUDIT_DATABASE_URL: 'postgres://audit',
    REDIS_URL: 'redis://redis',
    QUEUE_URL: 'redis://queue',
    SIGNER_SERVICE_URL: 'http://127.0.0.1:8790/signer',
    SIGNER_SERVICE_TOKEN: 'configured',
    SETTLEMENT_EXECUTOR_URL: 'http://127.0.0.1:8790/settlement',
    SETTLEMENT_EXECUTOR_TOKEN: 'configured',
    GOVERNANCE_EXECUTOR_URL: 'http://127.0.0.1:8790/governance',
    GOVERNANCE_EXECUTOR_TOKEN: 'configured',
    WALLET_1_PRIVATE_KEY: TEST_KEYS.W1,
    WALLET_3_PRIVATE_KEY: TEST_KEYS.W3,
    WALLET_5_PRIVATE_KEY: TEST_KEYS.W5,
    WALLET_6_PRIVATE_KEY: TEST_KEYS.W6,
    MICROTEST_WALLET_6_PRIVATE_KEY: TEST_KEYS.W6,
    MICROTEST_BUYER_1_PRIVATE_KEY: TEST_KEYS.BUYER1,
    MICROTEST_BUYER_2_PRIVATE_KEY: TEST_KEYS.BUYER2,
    MICROTEST_BUYER_3_PRIVATE_KEY: TEST_KEYS.BUYER3,
    MAINNET_MICROTEST_MAX_NATIVE_VALUE_PER_TX: '0',
    MAINNET_MICROTEST_MAX_GAS_COST_PER_TX_BNB: '0.001',
    MAINNET_MICROTEST_MAX_TOTAL_NATIVE_SPEND_BNB: '0.01',
    BNM_AVAILABILITY_URL: 'https://bnm.example.invalid',
    BNM_API_TOKEN: 'configured',
    BNM_PROJECT_ID: 'npleon',
    BNM_MONOTONIC_CONFORMANCE_EVIDENCE_HASH: HASH,
    PLATFORM_GOVERNANCE_WALLET_ADDRESS: role(1),
    PLATFORM_SERVICE_FEE_WALLET_ADDRESS: role(2),
    USDT_SETTLEMENT_WALLET_ADDRESS: role(3),
    NPL_REWARD_WALLET_ADDRESS: role(4),
    OPERATIONS_GUARANTEE_WALLET_ADDRESS: role(5),
    MAINNET_MICROTEST_MERCHANT_ID: 'merchant-1',
    MAINNET_MICROTEST_MERCHANT_WALLET: role(6),
    MAINNET_MICROTEST_PRODUCT_ID: 'product-1',
    MAINNET_MICROTEST_BUYER_WALLETS: [buyer(1), buyer(2), buyer(3)].join(','),
    MAINNET_MICROTEST_EXPIRES_AT: expiresAt,
    MAINNET_MICROTEST_MAX_LIST_PRICE_USDT: '2000000000000000000',
    MAINNET_MICROTEST_MAX_FREIGHT_USDT: '1000000000000000000',
    MAINNET_MICROTEST_MAX_STOCK: '3',
    MAINNET_MICROTEST_SECKILL_INVENTORY: '1',
    MAINNET_MICROTEST_EVIDENCE_HASH: HASH,
    ...(packetPath ? { MAINNET_MICROTEST_PACKET_SHA256: packetSha256(packetPath) } : {}),
    RELEASE_AUTHORIZATION_PATH: releaseAuthorization.path,
    RELEASE_AUTHORIZATION_SHA256: releaseAuthorization.sha256,
    RELEASE_AUTHORIZATION_SIGNER_ADDRESS: releaseAuthorization.signer,
    RELEASE_GIT_COMMIT: COMMIT,
    RELEASE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    RELEASE_RUNTIME_CONFIG_SHA256: `0x${'b'.repeat(64)}`,
  };
}

function packet(overrides = {}) {
  return {
    schema: 'abu24k-v2-mainnet-microtest-acceptance-v1',
    broadcastAuthorized: false,
    broadcastAuthorizationEvidenceHash: HASH,
    chainId: 56,
    artifactVersion: ARTIFACT,
    gitCommit: COMMIT,
    buyerWallets: [buyer(1), buyer(2), buyer(3)],
    buyerLabels: ['MICROTEST_BUYER_1', 'MICROTEST_BUYER_2', 'MICROTEST_BUYER_3'],
    bnbBudget: {
      maxNativeValuePerTxBnb: '0',
      maxGasCostPerTxBnb: '0.001',
      maxTotalNativeSpendBnb: '0.01',
    },
    stopConditions: ['REVERT', 'TOKEN_VALUE_LIMIT', 'ROLE_COLLISION'],
    ...overrides,
  };
}

function contract(name, nibble) {
  return { name, address: role(nibble), deployedCodeHash: HASH, status: 'DEPLOYED' };
}

function role(value) { return `0x${String(value).repeat(40).slice(0, 40)}`; }
function buyer(value) {
  if (value === 1) return walletForKey(TEST_KEYS.BUYER1);
  if (value === 2) return walletForKey(TEST_KEYS.BUYER2);
  if (value === 3) return walletForKey(TEST_KEYS.BUYER3);
  return walletForKey(TEST_KEYS.OTHER);
}

function privateKey(value) {
  return `0x${String(value).padStart(64, '0')}`;
}

function walletForKey(privateKeyValue) {
  return new Wallet(privateKeyValue).address;
}

function packetSha256(packetPath) {
  return createHash('sha256').update(readFileSync(packetPath)).digest('hex');
}

function writeReleaseAuthorization(packetPath, overrides = {}) {
  const root = join(packetPath, '..');
  const wallet = new Wallet(TEST_KEYS.AUTH);
  const packetHash = packetSha256(packetPath);
  const authorizationPath = join(
    root,
    `release-authorization-${String(overrides.status ?? 'MICROTEST_AUTHORIZED').toLowerCase()}-${packetHash.slice(0, 12)}.json`,
  );
  const payload = {
    schema: 'abu24k.releaseAuthorization.v1',
    artifactVersion: ARTIFACT,
    chainId: 56,
    status: overrides.status ?? 'MICROTEST_AUTHORIZED',
    createdAt: '2026-07-24T00:00:00.000Z',
    artifactSha256: `0x${sha256File(join(root, 'packages/core-artifacts/SHA256SUMS'))}`,
    coordinatedManifestSha256: `0x${sha256File(join(root, 'packages/core-artifacts/coordinated-manifest.json'))}`,
    openapiSha256: `0x${sha256File(join(root, 'packages/core-artifacts/openapi/openapi.json'))}`,
    contractsManifestSha256: `0x${sha256File(join(root, 'packages/core-artifacts/contracts/contract-manifest.json'))}`,
    gitCommit: COMMIT,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeConfigSha256: `0x${'b'.repeat(64)}`,
    packetSha256: `0x${packetHash}`,
    ...(overrides.status === 'GO' ? { evidenceArchiveSha256: `0x${'c'.repeat(64)}` } : {}),
    signer: wallet.address,
  };
  const signedPayloadSha256 = `0x${createHash('sha256').update(stableJson(payload)).digest('hex')}`;
  writeFileSync(authorizationPath, `${JSON.stringify({
    ...payload,
    signature: wallet.signMessageSync(signedPayloadSha256),
  })}\n`, { mode: 0o600 });
  chmodSync(authorizationPath, 0o600);
  return { path: authorizationPath, sha256: `0x${sha256File(authorizationPath)}`, signer: wallet.address };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function writeContractManifest(root, overrides = {}) {
  writeFileSync(join(root, 'packages/core-artifacts/contracts/contract-manifest.json'), JSON.stringify({
    artifactVersion: ARTIFACT,
    chain: { name: 'BSC Mainnet', chainId: 56 },
    deploymentStatus: 'DEPLOYED',
    contracts: [
      contract('PolicyRegistryV2', 'a'),
      contract('BeneficiaryRegistryV2', 'b'),
      contract('PaymentRouterV2', 'c'),
    ],
    ...overrides,
  }));
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet } from 'ethers';
import { BSC_CHAIN_ID, CORE_ARTIFACT_VERSION } from './enums.ts';
import {
  sha256,
  sha256File,
  stableJson,
  verifyReleaseAuthorization,
  type ReleaseAuthorizationStatus,
} from './release-authorization.ts';

test('GO release authorization rejects dirty git worktrees by default', async () => {
  const fixture = createReleaseFixture();
  const authorization = await writeAuthorization(fixture, 'GO');
  writeFileSync(join(fixture.root, 'dirty.txt'), 'dirty\n');

  assert.throws(
    () => verifyReleaseAuthorization({
      cwd: fixture.root,
      env: authorization.env,
      allowedStatuses: ['GO'],
    }),
    /clean git worktree/,
  );

  const verified = verifyReleaseAuthorization({
    cwd: fixture.root,
    env: authorization.env,
    allowedStatuses: ['GO'],
    allowDirtyGit: true,
  });
  assert.equal(verified.status, 'GO');
});

test('GO and MICROTEST authorizations bind the current git commit', async () => {
  for (const status of ['GO', 'MICROTEST_AUTHORIZED'] as const) {
    const fixture = createReleaseFixture();
    const authorization = await writeAuthorization(fixture, status, { gitCommit: '1'.repeat(40) });

    assert.throws(
      () => verifyReleaseAuthorization({
        cwd: fixture.root,
        env: authorization.env,
        allowedStatuses: [status],
      }),
      /gitCommit does not match runtime release commit/,
    );
  }
});

test('release authorization is bound to the current artifact checksums', async () => {
  const fixture = createReleaseFixture();
  const authorization = await writeAuthorization(fixture, 'GO');
  writeFileSync(join(fixture.root, 'packages/core-artifacts/SHA256SUMS'), 'tampered\n');

  assert.throws(
    () => verifyReleaseAuthorization({
      cwd: fixture.root,
      env: authorization.env,
      allowedStatuses: ['GO'],
      allowDirtyGit: true,
    }),
    /artifactSha256 does not match current artifacts/,
  );
});

test('runtime env digest fields must match the signed release authorization', async () => {
  const fixture = createReleaseFixture();
  const authorization = await writeAuthorization(fixture, 'GO');

  assert.throws(
    () => verifyReleaseAuthorization({
      cwd: fixture.root,
      env: {
        ...authorization.env,
        RELEASE_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
      },
      allowedStatuses: ['GO'],
    }),
    /imageDigest does not match RELEASE_IMAGE_DIGEST/,
  );
  assert.throws(
    () => verifyReleaseAuthorization({
      cwd: fixture.root,
      env: {
        ...authorization.env,
        RELEASE_RUNTIME_CONFIG_SHA256: `0x${'d'.repeat(64)}`,
      },
      allowedStatuses: ['GO'],
    }),
    /runtimeConfigSha256 does not match RELEASE_RUNTIME_CONFIG_SHA256/,
  );
});

interface ReleaseFixture {
  root: string;
  gitCommit: string;
}

interface AuthorizationFixture {
  env: Record<string, string>;
}

function createReleaseFixture(): ReleaseFixture {
  const root = mkdtempSync(join(tmpdir(), 'abu24k-release-auth-'));
  mkdirSync(join(root, 'packages/core-artifacts/openapi'), { recursive: true });
  mkdirSync(join(root, 'packages/core-artifacts/contracts'), { recursive: true });
  mkdirSync(join(root, 'platform-v2'), { recursive: true });
  writeFileSync(join(root, 'packages/core-artifacts/SHA256SUMS'), 'checksums\n');
  writeFileSync(join(root, 'packages/core-artifacts/coordinated-manifest.json'), '{}\n');
  writeFileSync(join(root, 'packages/core-artifacts/openapi/openapi.json'), '{}\n');
  writeFileSync(join(root, 'packages/core-artifacts/contracts/contract-manifest.json'), '{}\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', [
    '-c',
    'user.email=release-test@example.invalid',
    '-c',
    'user.name=Release Test',
    'commit',
    '-m',
    'fixture',
  ], { cwd: root, stdio: 'ignore' });
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, gitCommit };
}

async function writeAuthorization(
  fixture: ReleaseFixture,
  status: ReleaseAuthorizationStatus,
  overrides: Record<string, unknown> = {},
): Promise<AuthorizationFixture> {
  const wallet = new Wallet(`0x${'7'.repeat(64)}`);
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const runtimeConfigSha256 = `0x${'a'.repeat(64)}`;
  const packetSha256 = `0x${'8'.repeat(64)}`;
  const evidenceArchiveSha256 = `0x${'9'.repeat(64)}`;
  const payload = {
    schema: 'abu24k.releaseAuthorization.v1',
    artifactVersion: CORE_ARTIFACT_VERSION,
    chainId: BSC_CHAIN_ID,
    status,
    createdAt: '2026-07-31T00:00:00.000Z',
    artifactSha256: sha256File(join(fixture.root, 'packages/core-artifacts/SHA256SUMS')),
    coordinatedManifestSha256: sha256File(join(fixture.root, 'packages/core-artifacts/coordinated-manifest.json')),
    openapiSha256: sha256File(join(fixture.root, 'packages/core-artifacts/openapi/openapi.json')),
    contractsManifestSha256: sha256File(join(fixture.root, 'packages/core-artifacts/contracts/contract-manifest.json')),
    gitCommit: fixture.gitCommit,
    imageDigest,
    runtimeConfigSha256,
    packetSha256,
    evidenceArchiveSha256,
    signer: wallet.address,
    ...overrides,
  };
  const signedPayloadSha256 = `0x${sha256(stableJson(payload))}`;
  const authorizationDir = mkdtempSync(join(tmpdir(), 'abu24k-release-auth-file-'));
  const path = join(authorizationDir, `release-${status.toLowerCase()}.json`);
  writeFileSync(path, `${JSON.stringify({
    ...payload,
    signature: await wallet.signMessage(signedPayloadSha256),
  })}\n`, { mode: 0o600 });
  return {
    env: {
      RELEASE_AUTHORIZATION_PATH: path,
      RELEASE_AUTHORIZATION_SHA256: sha256File(path),
      RELEASE_AUTHORIZATION_SIGNER_ADDRESS: wallet.address,
      RELEASE_GIT_COMMIT: fixture.gitCommit,
      RELEASE_IMAGE_DIGEST: imageDigest,
      RELEASE_RUNTIME_CONFIG_SHA256: runtimeConfigSha256,
      MAINNET_MICROTEST_PACKET_SHA256: packetSha256,
      RELEASE_EVIDENCE_ARCHIVE_SHA256: evidenceArchiveSha256,
    },
  };
}

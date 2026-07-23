#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Wallet } from 'ethers';
import {
  sha256,
  sha256File,
  stableJson,
  verifyReleaseAuthorization,
} from '../server/api/release-authorization.ts';
import { BSC_CHAIN_ID, CORE_ARTIFACT_VERSION } from '../server/api/enums.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

if (command === 'create') {
  const out = option('--out');
  const status = option('--status');
  if (!out || !status) throw new Error('usage: release-authorization create --status <STATUS> --out <path>');
  const wallet = new Wallet(required('RELEASE_AUTHORIZATION_PRIVATE_KEY'));
  const normalizedStatus = status.toUpperCase();
  const evidenceArchiveSha256 = process.env.RELEASE_EVIDENCE_ARCHIVE_SHA256?.trim();
  if (normalizedStatus === 'GO' && !evidenceArchiveSha256) {
    throw new Error('RELEASE_EVIDENCE_ARCHIVE_SHA256 is required when creating GO authorization');
  }
  const payload = {
    schema: 'abu24k.releaseAuthorization.v1',
    artifactVersion: CORE_ARTIFACT_VERSION,
    chainId: BSC_CHAIN_ID,
    status: normalizedStatus,
    createdAt: new Date().toISOString(),
    artifactSha256: sha256File(resolve('packages/core-artifacts/SHA256SUMS')),
    coordinatedManifestSha256: sha256File(resolve('packages/core-artifacts/coordinated-manifest.json')),
    openapiSha256: sha256File(resolve('packages/core-artifacts/openapi/openapi.json')),
    contractsManifestSha256: sha256File(resolve('packages/core-artifacts/contracts/contract-manifest.json')),
    gitCommit: process.env.RELEASE_GIT_COMMIT ?? currentGitCommit(),
    imageDigest: required('RELEASE_IMAGE_DIGEST'),
    runtimeConfigSha256: required('RELEASE_RUNTIME_CONFIG_SHA256'),
    packetSha256: required('MAINNET_MICROTEST_PACKET_SHA256'),
    ...(evidenceArchiveSha256 ? { evidenceArchiveSha256 } : {}),
    signer: wallet.address,
  };
  const signedPayloadSha256 = `0x${sha256(stableJson(payload))}`;
  const authorization = {
    ...payload,
    signature: await wallet.signMessage(signedPayloadSha256),
  };
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 });
  console.log(`release authorization: ${target}`);
  console.log(`release authorization sha256: ${sha256File(target)}`);
} else if (command === 'verify') {
  const path = option('--path') ?? process.env.RELEASE_AUTHORIZATION_PATH;
  const hash = option('--hash') ?? process.env.RELEASE_AUTHORIZATION_SHA256;
  const status = option('--status') ?? 'GO';
  if (!path || !hash) throw new Error('usage: release-authorization verify --path <path> --hash <sha256> [--status GO]');
  const result = verifyReleaseAuthorization({
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELEASE_AUTHORIZATION_PATH: path,
      RELEASE_AUTHORIZATION_SHA256: hash,
      RELEASE_AUTHORIZATION_SIGNER_ADDRESS: process.env.RELEASE_AUTHORIZATION_SIGNER_ADDRESS,
    },
    allowedStatuses: [status.toUpperCase()],
    requireGitCommit: true,
    allowDirtyGit: true,
  });
  console.log(`release authorization verified: ${result.status} ${result.artifactVersion}`);
} else {
  console.log('usage: release-authorization <create|verify>');
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function currentGitCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

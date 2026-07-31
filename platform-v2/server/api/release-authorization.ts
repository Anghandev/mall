import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAddress, verifyMessage } from 'ethers';
import { BSC_CHAIN_ID, CORE_ARTIFACT_VERSION } from './enums.ts';
import { CoreError } from './errors.ts';

export const releaseAuthorizationStatuses = [
  'SUSPENDED',
  'MICROTEST_AUTHORIZED',
  'GO',
  'NO_GO',
] as const;

export type ReleaseAuthorizationStatus = (typeof releaseAuthorizationStatuses)[number];

export interface VerifiedReleaseAuthorization {
  artifactVersion: string;
  status: ReleaseAuthorizationStatus;
  authorizationSha256: string;
  artifactSha256: string;
  coordinatedManifestSha256: string;
  openapiSha256: string;
  contractsManifestSha256: string;
  gitCommit: string;
  imageDigest: string;
  runtimeConfigSha256: string;
  packetSha256: string;
  evidenceArchiveSha256: string | undefined;
  signer: string;
  signedPayloadSha256: string;
  createdAt: string;
}

export interface ReleaseAuthorizationEnv {
  RELEASE_AUTHORIZATION_PATH?: string;
  RELEASE_AUTHORIZATION_SHA256?: string;
  RELEASE_AUTHORIZATION_SIGNER_ADDRESS?: string;
  PLATFORM_GOVERNANCE_WALLET_ADDRESS?: string;
  RELEASE_GIT_COMMIT?: string;
  RELEASE_IMAGE_DIGEST?: string;
  RELEASE_RUNTIME_CONFIG_SHA256?: string;
  MAINNET_MICROTEST_PACKET_SHA256?: string;
  RELEASE_EVIDENCE_ARCHIVE_SHA256?: string;
}

export interface VerifyReleaseAuthorizationInput {
  cwd?: string;
  env: Readonly<ReleaseAuthorizationEnv>;
  allowedStatuses: readonly ReleaseAuthorizationStatus[];
  requireGitCommit?: boolean;
  allowDirtyGit?: boolean;
}

export function verifyReleaseAuthorization(input: VerifyReleaseAuthorizationInput): VerifiedReleaseAuthorization {
  const cwd = resolveRepoRoot(input.cwd ?? process.cwd());
  const authorizationPath = input.env.RELEASE_AUTHORIZATION_PATH?.trim();
  const expectedAuthorizationHash = normalizeSha256(
    input.env.RELEASE_AUTHORIZATION_SHA256,
    'RELEASE_AUTHORIZATION_SHA256',
  );
  if (!authorizationPath || !expectedAuthorizationHash) {
    throw new CoreError('ExternalBlocked', 'Release authorization path and hash are required', 503);
  }
  const resolvedAuthorizationPath = resolve(cwd, authorizationPath);
  const authorizationSha256 = sha256File(resolvedAuthorizationPath);
  if (authorizationSha256 !== expectedAuthorizationHash) {
    throw new CoreError('ExternalBlocked', 'Release authorization file hash does not match RELEASE_AUTHORIZATION_SHA256', 503);
  }
  const authorization = parseJson(readFileSync(resolvedAuthorizationPath, 'utf8'), resolvedAuthorizationPath);
  const status = authorizationStatus(authorization.status);
  if (!input.allowedStatuses.includes(status)) {
    throw new CoreError('ExternalBlocked', `Release authorization status ${status} is not allowed here`, 503);
  }
  if (authorization.schema !== 'abu24k.releaseAuthorization.v1') {
    throw new CoreError('ExternalBlocked', 'Release authorization schema is unsupported', 503);
  }
  if (authorization.artifactVersion !== CORE_ARTIFACT_VERSION || authorization.chainId !== BSC_CHAIN_ID) {
    throw new CoreError('ArtifactVersionMismatch', 'Release authorization does not match this artifact', 503);
  }
  const createdAt = stringField(authorization.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new CoreError('ExternalBlocked', 'Release authorization createdAt is invalid', 503);
  }

  const artifactSha256 = sha256File(resolve(cwd, 'packages/core-artifacts/SHA256SUMS'));
  const coordinatedManifestSha256 = sha256File(resolve(cwd, 'packages/core-artifacts/coordinated-manifest.json'));
  const openapiSha256 = sha256File(resolve(cwd, 'packages/core-artifacts/openapi/openapi.json'));
  const contractsManifestSha256 = sha256File(resolve(cwd, 'packages/core-artifacts/contracts/contract-manifest.json'));
  assertHashField(authorization.artifactSha256, artifactSha256, 'artifactSha256');
  assertHashField(authorization.coordinatedManifestSha256, coordinatedManifestSha256, 'coordinatedManifestSha256');
  assertHashField(authorization.openapiSha256, openapiSha256, 'openapiSha256');
  assertHashField(authorization.contractsManifestSha256, contractsManifestSha256, 'contractsManifestSha256');

  const gitCommit = stringField(authorization.gitCommit, 'gitCommit');
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new CoreError('ExternalBlocked', 'Release authorization gitCommit is invalid', 503);
  }
  const allowDirtyGit = input.allowDirtyGit === true;
  const gitStatus = currentGitStatus(cwd);
  if (!allowDirtyGit && gitStatus?.trim()) {
    throw new CoreError('ExternalBlocked', 'Release authorization requires a clean git worktree', 503);
  }
  const runtimeGitCommit = currentGitCommit(cwd);
  const configuredGitCommit = input.env.RELEASE_GIT_COMMIT?.trim();
  if (runtimeGitCommit && configuredGitCommit && configuredGitCommit !== runtimeGitCommit) {
    throw new CoreError('ExternalBlocked', 'RELEASE_GIT_COMMIT does not match the current git HEAD', 503);
  }
  const expectedGitCommit = runtimeGitCommit ?? configuredGitCommit;
  if (!expectedGitCommit) {
    if (input.requireGitCommit !== false) {
      throw new CoreError('ExternalBlocked', 'RELEASE_GIT_COMMIT is required when git commit cannot be verified', 503);
    }
  } else if (gitCommit !== expectedGitCommit) {
    throw new CoreError('ExternalBlocked', 'Release authorization gitCommit does not match runtime release commit', 503);
  }

  const imageDigest = stringField(authorization.imageDigest, 'imageDigest');
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new CoreError('ExternalBlocked', 'Release authorization imageDigest must be sha256:<64 hex>', 503);
  }
  if (input.env.RELEASE_IMAGE_DIGEST?.trim() !== imageDigest) {
    throw new CoreError('ExternalBlocked', 'Release authorization imageDigest does not match RELEASE_IMAGE_DIGEST', 503);
  }
  const runtimeConfigSha256 = requiredSha256(authorization.runtimeConfigSha256, 'runtimeConfigSha256');
  const expectedRuntimeConfigHash = normalizeSha256(
    input.env.RELEASE_RUNTIME_CONFIG_SHA256,
    'RELEASE_RUNTIME_CONFIG_SHA256',
  );
  if (!expectedRuntimeConfigHash || runtimeConfigSha256 !== expectedRuntimeConfigHash) {
    throw new CoreError('ExternalBlocked', 'Release authorization runtimeConfigSha256 does not match RELEASE_RUNTIME_CONFIG_SHA256', 503);
  }
  const packetSha256 = requiredSha256(authorization.packetSha256, 'packetSha256');
  const expectedPacketHash = normalizeSha256(
    input.env.MAINNET_MICROTEST_PACKET_SHA256,
    'MAINNET_MICROTEST_PACKET_SHA256',
  );
  if (expectedPacketHash && packetSha256 !== expectedPacketHash) {
    throw new CoreError('ExternalBlocked', 'Release authorization packetSha256 does not match MAINNET_MICROTEST_PACKET_SHA256', 503);
  }
  const evidenceArchiveSha256 = status === 'GO'
    ? requiredSha256(authorization.evidenceArchiveSha256, 'evidenceArchiveSha256')
    : normalizeSha256(authorization.evidenceArchiveSha256, 'evidenceArchiveSha256');
  const expectedEvidenceHash = normalizeSha256(
    input.env.RELEASE_EVIDENCE_ARCHIVE_SHA256,
    'RELEASE_EVIDENCE_ARCHIVE_SHA256',
  );
  if (status === 'GO' && !expectedEvidenceHash) {
    throw new CoreError('ExternalBlocked', 'RELEASE_EVIDENCE_ARCHIVE_SHA256 is required for GO release authorization', 503);
  }
  if (expectedEvidenceHash && evidenceArchiveSha256 !== expectedEvidenceHash) {
    throw new CoreError('ExternalBlocked', 'Release authorization evidenceArchiveSha256 does not match RELEASE_EVIDENCE_ARCHIVE_SHA256', 503);
  }

  const signer = addressField(authorization.signer, 'signer');
  const trustedSigner = trustedSignerAddress(input.env);
  if (signer.toLowerCase() !== trustedSigner.toLowerCase()) {
    throw new CoreError('ExternalBlocked', 'Release authorization signer is not the configured trusted signer', 503);
  }
  const signature = stringField(authorization.signature, 'signature');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new CoreError('ExternalBlocked', 'Release authorization signature is invalid', 503);
  }
  const unsignedPayload = { ...authorization };
  delete unsignedPayload.signature;
  const signedPayloadSha256 = `0x${sha256(stableJson(unsignedPayload))}`;
  let recovered: string;
  try {
    recovered = getAddress(verifyMessage(signedPayloadSha256, signature)).toLowerCase();
  } catch {
    throw new CoreError('ExternalBlocked', 'Release authorization signature cannot be verified', 503);
  }
  if (recovered !== signer.toLowerCase()) {
    throw new CoreError('ExternalBlocked', 'Release authorization signature signer mismatch', 503);
  }

  return Object.freeze({
    artifactVersion: CORE_ARTIFACT_VERSION,
    status,
    authorizationSha256,
    artifactSha256,
    coordinatedManifestSha256,
    openapiSha256,
    contractsManifestSha256,
    gitCommit,
    imageDigest,
    runtimeConfigSha256,
    packetSha256,
    evidenceArchiveSha256,
    signer,
    signedPayloadSha256,
    createdAt,
  });
}

export function releaseAuthorizationExternalBlockers(env: Readonly<ReleaseAuthorizationEnv>) {
  return [
    ...(!env.RELEASE_AUTHORIZATION_PATH ? ['RELEASE_AUTHORIZATION_PATH'] : []),
    ...(!env.RELEASE_AUTHORIZATION_SHA256 ? ['RELEASE_AUTHORIZATION_SHA256'] : []),
    ...(!env.RELEASE_GIT_COMMIT ? ['RELEASE_GIT_COMMIT'] : []),
    ...(!env.RELEASE_IMAGE_DIGEST ? ['RELEASE_IMAGE_DIGEST'] : []),
    ...(!env.RELEASE_RUNTIME_CONFIG_SHA256 ? ['RELEASE_RUNTIME_CONFIG_SHA256'] : []),
  ] as const;
}

export function sha256File(path: string) {
  const stats = statSync(path);
  if (!stats.isFile()) throw new CoreError('ExternalBlocked', `Release-bound artifact is not a file: ${path}`, 503);
  return `0x${sha256(readFileSync(path))}`;
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function parseJson(content: string, path: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CoreError('ExternalBlocked', `Release authorization JSON is invalid: ${path}`, 503);
  }
}

function authorizationStatus(value: unknown): ReleaseAuthorizationStatus {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!releaseAuthorizationStatuses.includes(normalized as ReleaseAuthorizationStatus)) {
    throw new CoreError('ExternalBlocked', 'Release authorization status is invalid', 503);
  }
  return normalized as ReleaseAuthorizationStatus;
}

function assertHashField(value: unknown, expected: string, name: string) {
  const actual = normalizeSha256(value, name);
  if (actual !== expected) {
    throw new CoreError('ExternalBlocked', `Release authorization ${name} does not match current artifacts`, 503);
  }
}

function normalizeSha256(value: unknown, name: string) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return undefined;
  if (/^0x[0-9a-f]{64}$/.test(text)) return text;
  if (/^[0-9a-f]{64}$/.test(text)) return `0x${text}`;
  throw new CoreError('ExternalBlocked', `${name} must be a SHA-256 hash`, 503);
}

function requiredSha256(value: unknown, name: string) {
  const normalized = normalizeSha256(value, name);
  if (!normalized) throw new CoreError('ExternalBlocked', `${name} must be a SHA-256 hash`, 503);
  return normalized;
}

function stringField(value: unknown, name: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoreError('ExternalBlocked', `Release authorization ${name} is required`, 503);
  }
  return value.trim();
}

function addressField(value: unknown, name: string) {
  try {
    return getAddress(String(value ?? ''));
  } catch {
    throw new CoreError('ExternalBlocked', `Release authorization ${name} must be an address`, 503);
  }
}

function trustedSignerAddress(env: Readonly<ReleaseAuthorizationEnv>) {
  const value = env.RELEASE_AUTHORIZATION_SIGNER_ADDRESS?.trim()
    || env.PLATFORM_GOVERNANCE_WALLET_ADDRESS?.trim();
  if (!value) {
    throw new CoreError('ExternalBlocked', 'Release authorization trusted signer address is required', 503);
  }
  return addressField(value, 'trustedSigner');
}

function currentGitCommit(cwd: string) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function currentGitStatus(cwd: string) {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

function resolveRepoRoot(start: string) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, 'packages/core-artifacts')) && existsSync(resolve(current, 'platform-v2'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

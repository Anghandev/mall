import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage, verifyTypedData, type TypedDataDomain, type TypedDataField } from 'ethers';
import { BSC_CHAIN_ID, userRoles, type UserRole } from './enums.ts';
import { CoreError } from './errors.ts';

export interface StoredNonce {
  walletAddress: string;
  nonceHash: string;
  domain: string;
  uri: string;
  chainId: 56;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
}

export interface NonceStore {
  save(nonce: StoredNonce): Promise<void>;
  consume(walletAddress: string, nonceHash: string, now: Date): Promise<StoredNonce | undefined>;
}

export interface SiweChallenge {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export async function createSiweChallenge(
  store: NonceStore,
  input: { walletAddress: string; domain: string; uri: string; statement: string },
  now = new Date(),
): Promise<SiweChallenge> {
  const walletAddress = normalizeAddress(input.walletAddress);
  if (!input.domain || !input.uri || !input.statement) throw new CoreError('InvalidRequest', 'Incomplete SIWE request');
  const nonce = randomBytes(16).toString('base64url');
  const issuedAt = now;
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  await store.save({
    walletAddress,
    nonceHash: sha256(nonce),
    domain: input.domain,
    uri: input.uri,
    chainId: BSC_CHAIN_ID,
    issuedAt,
    expiresAt,
  });
  return {
    message: formatSiweMessage({
      domain: input.domain,
      walletAddress,
      statement: input.statement,
      uri: input.uri,
      nonce,
      issuedAt,
      expiresAt,
    }),
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifySiwe(
  store: NonceStore,
  input: { message: string; signature: string; expectedDomain: string; expectedUri: string },
  now = new Date(),
) {
  const parsed = parseSiweMessage(input.message);
  if (
    parsed.domain !== input.expectedDomain ||
    parsed.uri !== input.expectedUri ||
    parsed.chainId !== BSC_CHAIN_ID ||
    parsed.issuedAt > now ||
    parsed.expiresAt < now
  ) {
    throw new CoreError('NonceExpired', 'SIWE challenge is expired or outside its bound domain', 401);
  }
  let recovered: string;
  try {
    recovered = normalizeAddress(verifyMessage(input.message, input.signature));
  } catch {
    throw new CoreError('InvalidSignature', 'Invalid SIWE signature', 401);
  }
  if (recovered !== parsed.walletAddress) throw new CoreError('InvalidSignature', 'SIWE signer mismatch', 401);
  const consumed = await store.consume(recovered, sha256(parsed.nonce), now);
  if (!consumed) throw new CoreError('NonceReplay', 'SIWE nonce is unknown or already used', 401);
  if (consumed.domain !== parsed.domain || consumed.uri !== parsed.uri || consumed.expiresAt < now) {
    throw new CoreError('NonceExpired', 'Stored SIWE challenge is no longer valid', 401);
  }
  return { walletAddress: recovered, issuedAt: parsed.issuedAt, nonceHash: consumed.nonceHash };
}

export interface SessionClaims {
  sub: string;
  roles: readonly UserRole[];
  merchantId?: string;
  iat: number;
  exp: number;
  jti: string;
  iss: 'abu24k-v2-core';
  aud: 'abu24k-v2-products';
}

export function issueSessionToken(
  input: { walletAddress: string; roles: readonly UserRole[]; merchantId?: string },
  secret: string,
  now = new Date(),
) {
  assertJwtSecret(secret);
  const claims: SessionClaims = {
    sub: normalizeAddress(input.walletAddress),
    roles: [...input.roles],
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + 15 * 60,
    jti: randomUUID(),
    iss: 'abu24k-v2-core',
    aud: 'abu24k-v2-products',
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
  };
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

export function verifySessionToken(token: string, secret: string, now = new Date()): SessionClaims {
  assertJwtSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3) throw new CoreError('Unauthorized', 'Malformed session token', 401);
  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new CoreError('Unauthorized', 'Invalid session token', 401);
  }
  let claims: SessionClaims;
  try {
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') throw new Error('invalid header');
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    throw new CoreError('Unauthorized', 'Invalid session payload', 401);
  }
  const epoch = Math.floor(now.getTime() / 1000);
  if (
    claims.iss !== 'abu24k-v2-core' ||
    claims.aud !== 'abu24k-v2-products' ||
    claims.exp <= epoch ||
    claims.iat > epoch + 30 ||
    !Array.isArray(claims.roles) ||
    !claims.roles.every((role) => userRoles.includes(role))
  ) {
    throw new CoreError('Unauthorized', 'Expired or invalid session token', 401);
  }
  claims.sub = normalizeAddress(claims.sub);
  return claims;
}

export function requireRole(claims: SessionClaims, allowed: readonly UserRole[]) {
  if (!claims.roles.some((role) => allowed.includes(role))) {
    throw new CoreError('Forbidden', 'Wallet role cannot perform this action', 403, { allowed });
  }
}

export interface SensitiveActionIntent {
  action: string;
  resourceType: string;
  resourceId: string;
  policyVersion: bigint;
  oldValueHash: string;
  newValueHash: string;
  safeAddress: string;
  nonce: bigint;
  deadline: bigint;
}

const sensitiveActionTypes: Record<string, TypedDataField[]> = {
  SensitiveAction: [
    { name: 'action', type: 'string' },
    { name: 'resourceType', type: 'string' },
    { name: 'resourceId', type: 'string' },
    { name: 'policyVersion', type: 'uint64' },
    { name: 'oldValueHash', type: 'bytes32' },
    { name: 'newValueHash', type: 'bytes32' },
    { name: 'safeAddress', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

export function verifySensitiveActionApproval(
  intent: SensitiveActionIntent,
  signature: string,
  expectedSecondarySigner: string,
  expectedSafe: string,
  verifyingContract: string,
  now = new Date(),
) {
  if (intent.deadline < BigInt(Math.floor(now.getTime() / 1000))) {
    throw new CoreError('NonceExpired', 'Sensitive action approval expired', 401);
  }
  if (normalizeAddress(intent.safeAddress) !== normalizeAddress(expectedSafe)) {
    throw new CoreError('InvalidRequest', 'Sensitive action Safe mismatch', 400);
  }
  const domain: TypedDataDomain = {
    name: 'Abu24KV2Core',
    version: '2',
    chainId: BSC_CHAIN_ID,
    verifyingContract: normalizeAddress(verifyingContract),
  };
  let signer: string;
  try {
    signer = normalizeAddress(verifyTypedData(domain, sensitiveActionTypes, intent, signature));
  } catch {
    throw new CoreError('InvalidSignature', 'Invalid secondary approval', 401);
  }
  if (signer !== normalizeAddress(expectedSecondarySigner)) {
    throw new CoreError('InvalidSignature', 'Secondary signer mismatch', 401);
  }
  return { signer, domain, intent };
}

export function sensitiveActionDomain(verifyingContract: string): TypedDataDomain {
  return {
    name: 'Abu24KV2Core',
    version: '2',
    chainId: BSC_CHAIN_ID,
    verifyingContract: normalizeAddress(verifyingContract),
  };
}

export { sensitiveActionTypes };

function formatSiweMessage(input: {
  domain: string;
  walletAddress: string;
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}) {
  return `${input.domain} wants you to sign in with your Ethereum account:\n${input.walletAddress}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${BSC_CHAIN_ID}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${input.expiresAt.toISOString()}`;
}

function parseSiweMessage(message: string) {
  const pattern = /^(.*?) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})\n\n(.+?)\n\nURI: (.+)\nVersion: 1\nChain ID: (\d+)\nNonce: ([A-Za-z0-9_-]+)\nIssued At: (.+)\nExpiration Time: (.+)$/s;
  const match = message.match(pattern);
  if (!match) throw new CoreError('InvalidRequest', 'Malformed SIWE message', 400);
  const [, domain, walletAddress, statement, uri, chainId, nonce, issuedAt, expiresAt] = match;
  if (!domain || !walletAddress || !statement || !uri || !chainId || !nonce || !issuedAt || !expiresAt) {
    throw new CoreError('InvalidRequest', 'Incomplete SIWE message', 400);
  }
  return {
    domain,
    walletAddress: normalizeAddress(walletAddress),
    statement,
    uri,
    chainId: Number(chainId),
    nonce,
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(expiresAt),
  };
}

function normalizeAddress(value: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid wallet address', 400);
  }
}

function assertJwtSecret(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new CoreError('ConfigurationRequired', 'JWT secret is unavailable', 503);
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';

const MAX_FILE_BYTES = 10_485_760;
const MAX_JSON_BYTES = 32_768;
const CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'application/pdf',
]);
const OBJECT_KEY = /^abu24k-v2\/[a-z0-9_-]+\/[a-z0-9_-]+\/[a-f0-9]{32}\/[a-f0-9]{64}-[a-f0-9]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;

type UploadToken = {
  action: 'UPLOAD';
  uploadIntentId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
  expiresAt: number;
};

type ReadToken = {
  action: 'READ';
  assetId: string;
  objectKey: string;
  objectVersionHash: string;
  contentType: string;
  contentSha256: string;
  expiresAt: number;
};

type StoredHeader = {
  version: 1;
  objectKeyHash: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
  iv: string;
};

export type MediaStorageConfig = {
  root: string;
  bearerToken: string;
  signingKey: string;
  encryptionKey: string;
  publicBaseUrl: string;
  now?: () => Date;
};

export async function createMediaStorageServer(input: MediaStorageConfig) {
  const config = validatedConfig(input);
  const objects = join(config.root, 'objects');
  const temporary = join(config.root, 'tmp');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  await chmod(config.root, 0o700);
  await chmod(objects, 0o700);
  await chmod(temporary, 0o700);

  return createServer((request, response) => {
    void route(request, response, { ...config, objects, temporary }).catch((error) => {
      const failure = error instanceof StorageError ? error : new StorageError(500, 'STORAGE_FAILURE');
      sendJson(response, failure.status, { error: failure.code });
    });
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: ReturnType<typeof validatedConfig> & { objects: string; temporary: string },
) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/v1/upload-intents') {
    authorize(request, config.bearerToken);
    const body = await jsonBody(request);
    const upload = uploadRequest(body, config.now());
    const token = signToken(upload, config.signingKey);
    return sendJson(response, 200, {
      method: 'PUT',
      uploadUrl: new URL(`/media-v2/upload/${token}`, config.publicBaseUrl).toString(),
      headers: { 'if-none-match': '*', 'content-type': upload.contentType },
      providerReferenceHash: hashJson({ domain: 'ABU24K_MEDIA_UPLOAD_REFERENCE_V1', ...upload }),
      writeOnce: true,
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/upload-finalizations') {
    authorize(request, config.bearerToken);
    const body = await jsonBody(request);
    const expected = finalizeRequest(body);
    const stored = await verifiedObject(config.objects, config.encryptionKey, expected.objectKey);
    assertStored(stored, expected);
    return sendJson(response, 200, {
      providerEvidenceHash: providerEvidenceHash(expected, stored.objectVersionHash),
      objectVersionHash: stored.objectVersionHash,
      sealed: true,
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/read-authorizations') {
    authorize(request, config.bearerToken);
    const read = readRequest(await jsonBody(request), config.now());
    const stored = await verifiedObject(config.objects, config.encryptionKey, read.objectKey);
    assertStored(stored, read);
    if (stored.objectVersionHash !== read.objectVersionHash) throw new StorageError(409, 'OBJECT_VERSION_MISMATCH');
    const token = signToken(read, config.signingKey);
    return sendJson(response, 200, {
      method: 'GET',
      readUrl: new URL(`/media-v2/read/${token}`, config.publicBaseUrl).toString(),
      expiresAt: new Date(read.expiresAt).toISOString(),
      providerReferenceHash: hashJson({ domain: 'ABU24K_MEDIA_READ_REFERENCE_V1', ...read }),
      assetId: read.assetId,
      contentSha256: read.contentSha256,
      objectVersionHash: read.objectVersionHash,
    });
  }

  const uploadMatch = url.pathname.match(/^\/media-v2\/upload\/([A-Za-z0-9_.-]+)$/);
  if (request.method === 'PUT' && uploadMatch?.[1]) {
    const upload = verifiedToken(uploadMatch[1], 'UPLOAD', config.signingKey, config.now());
    if (request.headers['if-none-match'] !== '*') throw new StorageError(428, 'WRITE_ONCE_REQUIRED');
    if (normalizedContentType(request.headers['content-type']) !== upload.contentType) {
      throw new StorageError(415, 'CONTENT_TYPE_MISMATCH');
    }
    const body = await rawBody(request, upload.sizeBytes);
    if (body.length !== upload.sizeBytes || hash(body) !== upload.contentSha256) {
      throw new StorageError(422, 'CONTENT_EVIDENCE_MISMATCH');
    }
    assertFileSignature(body, upload.contentType);
    await writeOnce(config, upload, body);
    response.writeHead(204, securityHeaders());
    return response.end();
  }

  const readMatch = url.pathname.match(/^\/media-v2\/read\/([A-Za-z0-9_.-]+)$/);
  if (request.method === 'GET' && readMatch?.[1]) {
    const read = verifiedToken(readMatch[1], 'READ', config.signingKey, config.now());
    const stored = await verifiedObject(config.objects, config.encryptionKey, read.objectKey);
    assertStored(stored, read);
    if (stored.objectVersionHash !== read.objectVersionHash) throw new StorageError(409, 'OBJECT_VERSION_MISMATCH');
    response.writeHead(200, {
      ...securityHeaders(),
      'cache-control': 'private, no-store',
      'content-disposition': read.contentType === 'application/pdf' ? 'attachment' : 'inline',
      'content-length': String(stored.plaintext.length),
      'content-type': read.contentType,
    });
    return response.end(stored.plaintext);
  }
  throw new StorageError(404, 'NOT_FOUND');
}

async function writeOnce(
  config: ReturnType<typeof validatedConfig> & { objects: string; temporary: string },
  upload: UploadToken,
  body: Buffer,
) {
  const iv = randomBytes(12);
  const header: StoredHeader = {
    version: 1,
    objectKeyHash: hashText(upload.objectKey),
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    contentSha256: upload.contentSha256,
    iv: iv.toString('hex'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const encrypted = Buffer.concat([length, headerBytes, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  const temporaryPath = join(config.temporary, `${randomBytes(24).toString('hex')}.tmp`);
  const targetPath = objectPath(config.objects, upload.objectKey);
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(encrypted);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporaryPath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError(412, 'OBJECT_ALREADY_EXISTS');
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function verifiedObject(objects: string, encryptionKey: Buffer, objectKey: string) {
  let encrypted: Buffer;
  try {
    encrypted = await readFile(objectPath(objects, objectKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageError(404, 'OBJECT_NOT_FOUND');
    throw error;
  }
  if (encrypted.length < 4 + 2 + 16) throw new StorageError(409, 'OBJECT_CORRUPTED');
  const headerLength = encrypted.readUInt32BE(0);
  if (headerLength < 2 || headerLength > 4096 || encrypted.length <= 4 + headerLength + 16) {
    throw new StorageError(409, 'OBJECT_CORRUPTED');
  }
  let header: StoredHeader;
  try {
    header = JSON.parse(encrypted.subarray(4, 4 + headerLength).toString()) as StoredHeader;
  } catch {
    throw new StorageError(409, 'OBJECT_CORRUPTED');
  }
  if (
    header.version !== 1
    || header.objectKeyHash !== hashText(objectKey)
    || !CONTENT_TYPES.has(header.contentType)
    || !Number.isSafeInteger(header.sizeBytes)
    || header.sizeBytes < 1
    || header.sizeBytes > MAX_FILE_BYTES
    || !HASH.test(header.contentSha256)
    || !/^[0-9a-f]{24}$/.test(header.iv)
  ) throw new StorageError(409, 'OBJECT_CORRUPTED');
  try {
    const ciphertext = encrypted.subarray(4 + headerLength, -16);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(header.iv, 'hex'));
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== header.sizeBytes || hash(plaintext) !== header.contentSha256) {
      throw new StorageError(409, 'OBJECT_CORRUPTED');
    }
    assertFileSignature(plaintext, header.contentType);
    return { header, plaintext, objectVersionHash: hash(encrypted) };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(409, 'OBJECT_CORRUPTED');
  }
}

function uploadRequest(value: unknown, now: Date): UploadToken {
  const body = record(value);
  artifact(body);
  const expiresAt = timestamp(body.expiresAt, 'expiresAt');
  if (expiresAt <= now.getTime() || expiresAt > now.getTime() + 15 * 60_000) {
    throw new StorageError(400, 'INVALID_EXPIRY');
  }
  const result = {
    action: 'UPLOAD',
    uploadIntentId: bytes32(body.uploadIntentId, 'uploadIntentId'),
    objectKey: objectKey(body.objectKey),
    contentType: contentType(body.contentType),
    sizeBytes: size(body.sizeBytes),
    contentSha256: bytes32(body.contentSha256, 'contentSha256'),
    expiresAt,
  } as const;
  assertObjectBinding(result.objectKey, result.uploadIntentId, result.contentSha256);
  return result;
}

function finalizeRequest(value: unknown) {
  const body = record(value);
  artifact(body);
  const result = {
    uploadIntentId: bytes32(body.uploadIntentId, 'uploadIntentId'),
    objectKey: objectKey(body.objectKey),
    contentType: contentType(body.contentType),
    sizeBytes: size(body.sizeBytes),
    contentSha256: bytes32(body.contentSha256, 'contentSha256'),
  };
  assertObjectBinding(result.objectKey, result.uploadIntentId, result.contentSha256);
  return result;
}

function readRequest(value: unknown, now: Date): ReadToken {
  const body = record(value);
  artifact(body);
  const expiresAt = timestamp(body.expiresAt, 'expiresAt');
  if (expiresAt <= now.getTime() || expiresAt > now.getTime() + 6 * 60_000) {
    throw new StorageError(400, 'INVALID_EXPIRY');
  }
  const result = {
    action: 'READ',
    assetId: bytes32(body.assetId, 'assetId'),
    objectKey: objectKey(body.objectKey),
    objectVersionHash: bytes32(body.objectVersionHash, 'objectVersionHash'),
    contentType: contentType(body.contentType),
    contentSha256: bytes32(body.contentSha256, 'contentSha256'),
    expiresAt,
  } as const;
  if (!result.objectKey.endsWith(`-${result.contentSha256.slice(2)}`)) {
    throw new StorageError(400, 'OBJECT_KEY_EVIDENCE_MISMATCH');
  }
  return result;
}

function signToken(payload: UploadToken | ReadToken, key: Buffer) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifiedToken<T extends UploadToken['action'] | ReadToken['action']>(
  token: string,
  action: T,
  key: Buffer,
  now: Date,
): Extract<UploadToken | ReadToken, { action: T }> {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new StorageError(403, 'INVALID_TOKEN');
  const expected = createHmac('sha256', key).update(encoded).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new StorageError(403, 'INVALID_TOKEN'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new StorageError(403, 'INVALID_TOKEN');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new StorageError(403, 'INVALID_TOKEN'); }
  const body = record(value);
  const parsed = action === 'UPLOAD'
    ? uploadToken(body)
    : readToken(body);
  if (parsed.action !== action || parsed.expiresAt <= now.getTime()) throw new StorageError(403, 'EXPIRED_TOKEN');
  return parsed as Extract<UploadToken | ReadToken, { action: T }>;
}

function uploadToken(body: Record<string, unknown>): UploadToken {
  if (body.action !== 'UPLOAD') throw new StorageError(403, 'INVALID_TOKEN');
  const result = {
    action: 'UPLOAD',
    uploadIntentId: bytes32(body.uploadIntentId, 'uploadIntentId'),
    objectKey: objectKey(body.objectKey),
    contentType: contentType(body.contentType),
    sizeBytes: size(body.sizeBytes),
    contentSha256: bytes32(body.contentSha256, 'contentSha256'),
    expiresAt: integer(body.expiresAt, 'expiresAt'),
  } as const;
  assertObjectBinding(result.objectKey, result.uploadIntentId, result.contentSha256);
  return result;
}

function readToken(body: Record<string, unknown>): ReadToken {
  if (body.action !== 'READ') throw new StorageError(403, 'INVALID_TOKEN');
  return {
    action: 'READ',
    assetId: bytes32(body.assetId, 'assetId'),
    objectKey: objectKey(body.objectKey),
    objectVersionHash: bytes32(body.objectVersionHash, 'objectVersionHash'),
    contentType: contentType(body.contentType),
    contentSha256: bytes32(body.contentSha256, 'contentSha256'),
    expiresAt: integer(body.expiresAt, 'expiresAt'),
  };
}

function assertStored(
  stored: Awaited<ReturnType<typeof verifiedObject>>,
  expected: { contentType: string; sizeBytes?: number; contentSha256: string },
) {
  if (
    stored.header.contentType !== expected.contentType
    || stored.header.contentSha256 !== expected.contentSha256
    || (expected.sizeBytes !== undefined && stored.header.sizeBytes !== expected.sizeBytes)
  ) throw new StorageError(409, 'OBJECT_EVIDENCE_MISMATCH');
}

function providerEvidenceHash(
  expected: ReturnType<typeof finalizeRequest>,
  objectVersionHash: string,
) {
  return hashJson({
    domain: 'ABU24K_MEDIA_PROVIDER_EVIDENCE_V1',
    ...expected,
    objectVersionHash,
    sealed: true,
  });
}

function objectPath(objects: string, key: string) {
  return join(objects, `${hashText(key).slice(2)}.media`);
}

async function jsonBody(request: IncomingMessage) {
  const body = await rawBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString()); } catch { throw new StorageError(400, 'INVALID_JSON'); }
}

async function rawBody(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > maximum) throw new StorageError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function authorize(request: IncomingMessage, token: string) {
  const actual = request.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new StorageError(401, 'UNAUTHORIZED');
  }
}

function validatedConfig(input: MediaStorageConfig) {
  if (input.bearerToken.length < 32) throw new Error('MEDIA_STORAGE_SIGNER_TOKEN is invalid');
  if (!/^[0-9a-fA-F]{64}$/.test(input.signingKey)) throw new Error('MEDIA_STORAGE_URL_SIGNING_KEY is invalid');
  if (!/^[0-9a-fA-F]{64}$/.test(input.encryptionKey)) throw new Error('MEDIA_STORAGE_ENCRYPTION_KEY is invalid');
  const publicBaseUrl = new URL(input.publicBaseUrl);
  if (publicBaseUrl.protocol !== 'https:') throw new Error('MEDIA_STORAGE_PUBLIC_BASE_URL must use HTTPS');
  return {
    root: resolve(input.root),
    bearerToken: input.bearerToken,
    signingKey: Buffer.from(input.signingKey, 'hex'),
    encryptionKey: Buffer.from(input.encryptionKey, 'hex'),
    publicBaseUrl,
    now: input.now ?? (() => new Date()),
  };
}

function artifact(body: Record<string, unknown>) {
  if (body.artifactVersion !== CORE_ARTIFACT_VERSION) throw new StorageError(409, 'ARTIFACT_VERSION_MISMATCH');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function objectKey(value: unknown) {
  if (typeof value !== 'string' || !OBJECT_KEY.test(value)) throw new StorageError(400, 'INVALID_OBJECT_KEY');
  return value;
}

function assertObjectBinding(key: string, uploadIntentId: string, contentSha256: string) {
  if (!key.endsWith(`/${uploadIntentId.slice(2)}-${contentSha256.slice(2)}`)) {
    throw new StorageError(400, 'OBJECT_KEY_EVIDENCE_MISMATCH');
  }
}

function contentType(value: unknown) {
  if (typeof value !== 'string' || !CONTENT_TYPES.has(value)) throw new StorageError(400, 'INVALID_CONTENT_TYPE');
  return value;
}

function normalizedContentType(value: string | undefined) {
  return value?.split(';', 1)[0]?.trim().toLowerCase();
}

function size(value: unknown) {
  const result = integer(value, 'sizeBytes');
  if (result < 1 || result > MAX_FILE_BYTES) throw new StorageError(400, 'INVALID_SIZE');
  return result;
}

function integer(value: unknown, code: string) {
  if (!Number.isSafeInteger(value)) throw new StorageError(400, `INVALID_${code.toUpperCase()}`);
  return value as number;
}

function timestamp(value: unknown, code: string) {
  if (typeof value !== 'string') throw new StorageError(400, `INVALID_${code.toUpperCase()}`);
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw new StorageError(400, `INVALID_${code.toUpperCase()}`);
  return result;
}

function bytes32(value: unknown, code: string) {
  if (typeof value !== 'string' || !HASH.test(value.toLowerCase())) throw new StorageError(400, `INVALID_${code.toUpperCase()}`);
  return value.toLowerCase();
}

function hash(value: Buffer) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hashText(value: string) {
  return hash(Buffer.from(value));
}

function hashJson(value: unknown) {
  return hash(Buffer.from(JSON.stringify(value)));
}

function assertFileSignature(value: Buffer, type: string) {
  const valid = type === 'image/png' ? value.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : type === 'image/jpeg' ? value.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    : type === 'image/webp' ? value.subarray(0, 4).toString() === 'RIFF' && value.subarray(8, 12).toString() === 'WEBP'
    : type === 'application/pdf' ? value.subarray(0, 5).toString() === '%PDF-'
    : type === 'video/mp4' ? value.subarray(4, 8).toString() === 'ftyp'
    : false;
  if (!valid) throw new StorageError(415, 'FILE_SIGNATURE_MISMATCH');
}

function securityHeaders() {
  return {
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

class StorageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const host = process.env.MEDIA_STORAGE_HOST ?? '127.0.0.1';
  const port = Number(process.env.MEDIA_STORAGE_PORT ?? '8791');
  if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Media storage must use a valid loopback listener');
  }
  const server = await createMediaStorageServer({
    root: required('MEDIA_STORAGE_ROOT'),
    bearerToken: required('MEDIA_STORAGE_SIGNER_TOKEN'),
    signingKey: required('MEDIA_STORAGE_URL_SIGNING_KEY'),
    encryptionKey: required('MEDIA_STORAGE_ENCRYPTION_KEY'),
    publicBaseUrl: required('MEDIA_STORAGE_PUBLIC_BASE_URL'),
  });
  server.listen(port, host, () => console.log(`24K商城 media storage listening on ${host}:${port}`));
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}

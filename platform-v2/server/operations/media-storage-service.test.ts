import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { HttpMediaStorageAdapter } from '../data/evidence-service.ts';
import { createMediaStorageServer } from './media-storage-service.ts';

const TOKEN = 't'.repeat(64);
const SIGNING_KEY = '11'.repeat(32);
const ENCRYPTION_KEY = '22'.repeat(32);
const ASSET_ID = `0x${'33'.repeat(32)}`;
const UPLOAD_INTENT_ID = `0x${'44'.repeat(32)}`;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('real-private-media')]);
const CONTENT_SHA = sha(PNG);
const OBJECT_KEY = `abu24k-v2/merchant_license/merchant/${'55'.repeat(16)}/${UPLOAD_INTENT_ID.slice(2)}-${CONTENT_SHA.slice(2)}`;

let root: string;
let now = new Date('2026-07-20T12:00:00.000Z');
let server: Server;
let baseUrl: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'abu24k-media-'));
  server = await createMediaStorageServer({
    root,
    bearerToken: TOKEN,
    signingKey: SIGNING_KEY,
    encryptionKey: ENCRYPTION_KEY,
    publicBaseUrl: 'https://www.npleon.com',
    now: () => now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('media test server did not listen');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

test('private media storage enforces auth, exact write-once upload, encrypted persistence and signed read', async () => {
  const unauthorized = await post('/v1/upload-intents', uploadInput(), 'wrong');
  assert.equal(unauthorized.status, 401);

  const targetResponse = await post('/v1/upload-intents', uploadInput());
  assert.equal(targetResponse.status, 200);
  const target = await targetResponse.json() as Record<string, unknown>;
  assert.equal(target.method, 'PUT');
  assert.equal(target.writeOnce, true);
  assert.match(String(target.providerReferenceHash), /^0x[0-9a-f]{64}$/);
  const uploadPath = new URL(String(target.uploadUrl)).pathname;
  const upload = await fetch(`${baseUrl}${uploadPath}`, {
    method: 'PUT',
    headers: target.headers as Record<string, string>,
    body: PNG,
  });
  assert.equal(upload.status, 204);
  assert.equal((await fetch(`${baseUrl}${uploadPath}`, {
    method: 'PUT',
    headers: target.headers as Record<string, string>,
    body: PNG,
  })).status, 412);

  const names = await readdir(join(root, 'objects'));
  assert.equal(names.length, 1);
  const encrypted = await readFile(join(root, 'objects', names[0]!));
  assert.equal(encrypted.includes(PNG), false);

  const finalized = await post('/v1/upload-finalizations', {
    artifactVersion: CORE_ARTIFACT_VERSION,
    uploadIntentId: UPLOAD_INTENT_ID,
    objectKey: OBJECT_KEY,
    contentType: 'image/png',
    sizeBytes: PNG.length,
    contentSha256: CONTENT_SHA,
  });
  assert.equal(finalized.status, 200);
  const evidence = await finalized.json() as Record<string, unknown>;
  assert.equal(evidence.sealed, true);
  assert.match(String(evidence.providerEvidenceHash), /^0x[0-9a-f]{64}$/);
  assert.match(String(evidence.objectVersionHash), /^0x[0-9a-f]{64}$/);

  const readTarget = await post('/v1/read-authorizations', {
    artifactVersion: CORE_ARTIFACT_VERSION,
    assetId: ASSET_ID,
    objectKey: OBJECT_KEY,
    objectVersionHash: evidence.objectVersionHash,
    contentType: 'image/png',
    contentSha256: CONTENT_SHA,
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
  assert.equal(readTarget.status, 200);
  const read = await readTarget.json() as Record<string, unknown>;
  const readPath = new URL(String(read.readUrl)).pathname;
  const downloaded = await fetch(`${baseUrl}${readPath}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), PNG);
});

test('upload token expires and mismatched content is never persisted', async () => {
  const content = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('different-object')]);
  const contentSha = sha(content);
  const intentId = `0x${'66'.repeat(32)}`;
  const objectKey = `abu24k-v2/product_image/product/${'77'.repeat(16)}/${intentId.slice(2)}-${contentSha.slice(2)}`;
  assert.equal((await post('/v1/upload-intents', uploadInput({
    uploadIntentId: `0x${'99'.repeat(32)}`,
    objectKey,
    contentType: 'image/jpeg',
    sizeBytes: content.length,
    contentSha256: contentSha,
  }))).status, 400);
  const response = await post('/v1/upload-intents', uploadInput({
    uploadIntentId: intentId,
    objectKey,
    contentType: 'image/jpeg',
    sizeBytes: content.length,
    contentSha256: contentSha,
  }));
  const target = await response.json() as Record<string, unknown>;
  const path = new URL(String(target.uploadUrl)).pathname;
  assert.equal((await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: target.headers as Record<string, string>,
    body: Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.from('wrong-content')]),
  })).status, 422);
  now = new Date(now.getTime() + 11 * 60_000);
  assert.equal((await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: target.headers as Record<string, string>,
    body: content,
  })).status, 403);
});

test('Core media adapter permits authenticated loopback HTTP but rejects non-loopback HTTP', async () => {
  const mock = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      method: 'PUT',
      uploadUrl: 'https://www.npleon.com/media-v2/upload/test',
      headers: { 'if-none-match': '*' },
      providerReferenceHash: `0x${'88'.repeat(32)}`,
      writeOnce: true,
    }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('mock signer did not listen');
  try {
    const adapter = new HttpMediaStorageAdapter({ url: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const target = await adapter.createUpload({
      uploadIntentId: UPLOAD_INTENT_ID,
      objectKey: OBJECT_KEY,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      contentSha256: CONTENT_SHA,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(target.writeOnce, true);
  } finally {
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  }
  await assert.rejects(
    () => new HttpMediaStorageAdapter({ url: 'http://storage.example.test', token: TOKEN }).createUpload({
      uploadIntentId: UPLOAD_INTENT_ID,
      objectKey: OBJECT_KEY,
      contentType: 'image/png',
      sizeBytes: PNG.length,
      contentSha256: CONTENT_SHA,
      expiresAt: new Date(Date.now() + 60_000),
    }),
    /must use HTTPS outside loopback/,
  );
});

function uploadInput(overrides: Record<string, unknown> = {}) {
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    uploadIntentId: UPLOAD_INTENT_ID,
    objectKey: OBJECT_KEY,
    contentType: 'image/png',
    sizeBytes: PNG.length,
    contentSha256: CONTENT_SHA,
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function post(path: string, body: unknown, token = TOKEN) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sha(value: Buffer) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

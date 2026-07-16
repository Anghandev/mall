import { createHash, createHmac } from 'node:crypto';
import { normalizeAddress } from '../api/auth.ts';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';

const ACTIONS = [
  'REQUEST_EXCHANGE',
  'REQUEST_DELAY',
  'CONFIRM_RECEIPT',
  'OPEN_ARBITRATION',
  'VERIFY_PICKUP',
  'REQUEST_FORCED_RECEIPT',
] as const;
const CARRIERS = ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] as const;
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'] as const;
const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type EvidenceAction = (typeof ACTIONS)[number];
export type Carrier = (typeof CARRIERS)[number];
export type MediaPurpose =
  | 'PRODUCT_IMAGE'
  | 'PRODUCT_VIDEO'
  | 'CATEGORY_ICON'
  | 'STORE_IMAGE'
  | 'FULFILLMENT_EVIDENCE'
  | 'BUYER_AVATAR'
  | 'MERCHANT_LOGO'
  | 'MERCHANT_LICENSE';
export type MediaResourceType = 'PRODUCT' | 'CATEGORY' | 'STORE' | 'ORDER' | 'BUYER' | 'MERCHANT';

export interface MediaUploadLimits {
  maxIntentsPerWalletHour: number;
  maxBytesPerWalletHour: bigint;
}

interface UploadIntentRow {
  upload_intent_id: string;
  owner_wallet: string;
  purpose: MediaPurpose;
  resource_type: MediaResourceType;
  resource_id: string;
  object_key: string;
  content_type: (typeof CONTENT_TYPES)[number];
  size_bytes: string | number;
  content_sha256: string;
  request_hash: string;
  state: 'PENDING' | 'UPLOADED' | 'VERIFIED' | 'REJECTED';
  expires_at: Date;
  provider_reference_hash: string | null;
  provider_evidence_hash: string | null;
  verified_at: Date | null;
  created_at: Date;
}

interface EvidenceRow {
  evidence_hash: string;
  owner_wallet: string;
  actor_role: 'BUYER' | 'MERCHANT' | 'ADMIN' | 'OPERATOR';
  purpose: 'FULFILLMENT_ACTION' | 'SHIPMENT_TRACKING';
  resource_id: string;
  action_type: string;
  reason_code: string | null;
  tracking_number_hash: string | null;
  media_asset_ids: unknown;
  payload: unknown;
  payload_hash: string;
  created_at: Date;
}

interface MediaAssetRow {
  asset_id: string;
  upload_intent_id: string;
  owner_wallet: string;
  purpose: MediaPurpose;
  resource_type: MediaResourceType;
  resource_id: string;
  object_key: string;
  content_type: (typeof CONTENT_TYPES)[number];
  size_bytes: string | number;
  content_sha256: string;
  provider_evidence_hash: string;
  object_version_hash: string;
  created_at: Date;
}

export interface MediaStorageAdapter {
  createUpload(input: {
    uploadIntentId: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    contentSha256: string;
    expiresAt: Date;
  }): Promise<{
    method: 'PUT';
    uploadUrl: string;
    headers: Readonly<Record<string, string>>;
    providerReferenceHash: string;
    writeOnce: true;
  }>;
  finalizeUpload(input: {
    uploadIntentId: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    contentSha256: string;
  }): Promise<{ providerEvidenceHash: string; objectVersionHash: string; sealed: true }>;
  createRead(input: {
    assetId: string;
    objectKey: string;
    objectVersionHash: string;
    contentType: string;
    contentSha256: string;
    expiresAt: Date;
  }): Promise<{
    method: 'GET';
    readUrl: string;
    expiresAt: string;
    providerReferenceHash: string;
    assetId: string;
    contentSha256: string;
    objectVersionHash: string;
  }>;
}

export class EvidenceService {
  readonly #transactions: SqlTransactionRunner;
  readonly #storage: MediaStorageAdapter;
  readonly #trackingHashKey: string | undefined;
  readonly #uploadLimits: MediaUploadLimits | undefined;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    storage: MediaStorageAdapter;
    trackingHashKey?: string;
    uploadLimits?: MediaUploadLimits;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#storage = input.storage;
    this.#trackingHashKey = input.trackingHashKey;
    this.#uploadLimits = input.uploadLimits;
    this.#clock = input.clock ?? (() => new Date());
  }

  createActionEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    action: EvidenceAction;
    reasonCode: string;
    mediaAssetIds?: string[];
    idempotencyKey: string;
  }) {
    const wallet = actorWallet(actor);
    if (!ACTIONS.includes(input.action)) throw new CoreError('InvalidRequest', 'Unsupported evidence action');
    validateResourceId(input.orderId);
    const reasonCode = boundedCode(input.reasonCode, 'reasonCode');
    const mediaAssetIds = uniqueIds(input.mediaAssetIds ?? [], 'mediaAssetIds');
    validateIdempotencyKey(input.idempotencyKey);
    return this.#transactions.transaction(async (executor) => {
      const actorRole = await authorizeActionOrder(executor, actor, input.orderId, input.action);
      await verifyMediaAssets(executor, wallet, 'ORDER', input.orderId, mediaAssetIds);
      const requestHash = hashJson({
        domain: 'ABU24K_FULFILLMENT_EVIDENCE_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        actorRole,
        orderId: input.orderId,
        action: input.action,
        reasonCode,
        mediaAssetIds,
        idempotencyKey: input.idempotencyKey,
      });
      const existing = await executor.query<EvidenceRow>(
        'SELECT * FROM core.evidence_envelopes WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) return existingEvidence(existing.rows[0], requestHash);
      const createdAt = this.#clock();
      const evidenceHash = hashJson({ requestHash, createdAt: createdAt.toISOString() });
      const payload = { actorRole, action: input.action, reasonCode, mediaAssetIds };
      const inserted = await executor.query<EvidenceRow>(
        `INSERT INTO core.evidence_envelopes (
           evidence_hash, owner_wallet, actor_role, purpose, resource_type, resource_id,
           action_type, reason_code, media_asset_ids, payload, payload_hash,
           idempotency_key, created_at
         ) VALUES ($1,$2,$3,'FULFILLMENT_ACTION','ORDER',$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (owner_wallet, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          evidenceHash,
          wallet,
          actorRole,
          input.orderId,
          input.action,
          reasonCode,
          JSON.stringify(mediaAssetIds),
          JSON.stringify(payload),
          requestHash,
          input.idempotencyKey,
          createdAt,
        ],
      );
      if (inserted.rows[0]) return evidenceProjection(inserted.rows[0]);
      const concurrent = await executor.query<EvidenceRow>(
        'SELECT * FROM core.evidence_envelopes WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (!concurrent.rows[0]) throw new CoreError('ExternalBlocked', 'Concurrent evidence write was not visible', 503);
      return existingEvidence(concurrent.rows[0], requestHash);
    });
  }

  createTrackingEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumber: string;
    idempotencyKey: string;
  }) {
    const wallet = actorWallet(actor);
    if (!CARRIERS.includes(input.carrierCode)) throw new CoreError('InvalidRequest', 'Unsupported carrier code');
    validateResourceId(input.orderId);
    const normalizedTracking = normalizeTrackingNumber(input.trackingNumber);
    validateIdempotencyKey(input.idempotencyKey);
    if (input.idempotencyKey.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(normalizedTracking)) {
      throw new CoreError('InvalidRequest', 'Idempotency key must not contain a tracking number');
    }
    const trackingNumberHash = trackingHash(
      this.#trackingHashKey,
      input.orderId,
      input.carrierCode,
      normalizedTracking,
    );
    return this.#transactions.transaction(async (executor) => {
      const actorRole = await authorizeShipmentOrder(executor, actor, input.orderId);
      const requestHash = hashJson({
        domain: 'ABU24K_SHIPMENT_EVIDENCE_V1',
        artifactVersion: CORE_ARTIFACT_VERSION,
        wallet,
        actorRole,
        orderId: input.orderId,
        carrierCode: input.carrierCode,
        trackingNumberHash,
        idempotencyKey: input.idempotencyKey,
      });
      const existing = await executor.query<EvidenceRow>(
        'SELECT * FROM core.evidence_envelopes WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) return existingEvidence(existing.rows[0], requestHash);
      const createdAt = this.#clock();
      const evidenceHash = hashJson({ requestHash, createdAt: createdAt.toISOString() });
      const payload = { actorRole, carrierCode: input.carrierCode, trackingNumberHash };
      const inserted = await executor.query<EvidenceRow>(
        `INSERT INTO core.evidence_envelopes (
           evidence_hash, owner_wallet, actor_role, purpose, resource_type, resource_id,
           action_type, reason_code, tracking_number_hash, media_asset_ids,
           payload, payload_hash, idempotency_key, created_at
         ) VALUES ($1,$2,$3,'SHIPMENT_TRACKING','ORDER',$4,'RECORD_SHIPMENT',NULL,$5,'[]',$6,$7,$8,$9)
         ON CONFLICT (owner_wallet, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          evidenceHash,
          wallet,
          actorRole,
          input.orderId,
          trackingNumberHash,
          JSON.stringify(payload),
          requestHash,
          input.idempotencyKey,
          createdAt,
        ],
      );
      if (inserted.rows[0]) return evidenceProjection(inserted.rows[0]);
      const concurrent = await executor.query<EvidenceRow>(
        'SELECT * FROM core.evidence_envelopes WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (!concurrent.rows[0]) throw new CoreError('ExternalBlocked', 'Concurrent evidence write was not visible', 503);
      return existingEvidence(concurrent.rows[0], requestHash);
    });
  }

  assertActionEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    action: EvidenceAction;
    evidenceHash: string;
    reasonCode?: string;
  }) {
    const wallet = actorWallet(actor);
    validateProviderHash(input.evidenceHash, 'evidence hash');
    const reasonCode = input.reasonCode === undefined ? undefined : boundedCode(input.reasonCode, 'reasonCode');
    return this.#transactions.transaction(async (executor) => {
      const actorRole = await authorizeActionOrder(executor, actor, input.orderId, input.action);
      const row = await loadEvidence(executor, input.evidenceHash);
      if (
        row.owner_wallet !== wallet
        || row.actor_role !== actorRole
        || row.purpose !== 'FULFILLMENT_ACTION'
        || row.resource_id !== input.orderId
        || row.action_type !== input.action
        || (reasonCode !== undefined && row.reason_code !== reasonCode)
      ) throw new CoreError('Forbidden', 'Action evidence does not match the command', 403);
      return evidenceProjection(row);
    });
  }

  assertTrackingEvidence(actor: FulfillmentActor, input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumberHash: string;
    evidenceHash: string;
  }) {
    validateProviderHash(input.evidenceHash, 'evidence hash');
    validateProviderHash(input.trackingNumberHash, 'tracking number hash');
    return this.#transactions.transaction((executor) => (
      assertTrackingEvidenceRecord(executor, actor, input)
    ));
  }

  async createUploadIntent(actor: FulfillmentActor, input: {
    purpose: MediaPurpose;
    resourceType: MediaResourceType;
    resourceId: string;
    contentType: (typeof CONTENT_TYPES)[number];
    sizeBytes: number;
    contentSha256: string;
    idempotencyKey: string;
  }) {
    const wallet = actorWallet(actor);
    validateUploadInput(input);
    const requestHash = hashJson({
      domain: 'ABU24K_MEDIA_UPLOAD_V1',
      artifactVersion: CORE_ARTIFACT_VERSION,
      wallet,
      ...input,
      contentSha256: input.contentSha256.toLowerCase(),
    });
    const row = await this.#transactions.transaction(async (executor) => {
      await authorizeResource(executor, actor, input.purpose, input.resourceType, input.resourceId);
      const existing = await executor.query<UploadIntentRow>(
        'SELECT * FROM core.media_upload_intents WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Upload intent changed', 409);
        return existing.rows[0];
      }
      const now = this.#clock();
      const quotaDuplicate = await reserveUploadQuota(
        executor,
        wallet,
        input.idempotencyKey,
        requestHash,
        input.sizeBytes,
        now,
        this.#uploadLimits,
      );
      if (quotaDuplicate) return quotaDuplicate;
      const expiresAt = new Date(now.getTime() + 10 * 60_000);
      const uploadIntentId = hashJson({ requestHash, issuedAt: now.toISOString() });
      const objectKey = [
        'abu24k-v2',
        input.purpose.toLowerCase(),
        input.resourceType.toLowerCase(),
        safeObjectSegment(input.resourceId),
        `${uploadIntentId.slice(2)}-${input.contentSha256.slice(2).toLowerCase()}`,
      ].join('/');
      const inserted = await executor.query<UploadIntentRow>(
        `INSERT INTO core.media_upload_intents (
           upload_intent_id, owner_wallet, purpose, resource_type, resource_id,
           object_key, content_type, size_bytes, content_sha256, idempotency_key,
           request_hash, state, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12,$13,$13)
         ON CONFLICT (owner_wallet, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          uploadIntentId,
          wallet,
          input.purpose,
          input.resourceType,
          input.resourceId,
          objectKey,
          input.contentType,
          input.sizeBytes,
          input.contentSha256.toLowerCase(),
          input.idempotencyKey,
          requestHash,
          expiresAt,
          now,
        ],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const concurrent = await executor.query<UploadIntentRow>(
        'SELECT * FROM core.media_upload_intents WHERE owner_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      const value = concurrent.rows[0];
      if (!value) throw new CoreError('ExternalBlocked', 'Concurrent upload intent was not visible', 503);
      if (value.request_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Upload intent changed', 409);
      return value;
    });
    if (row.state === 'VERIFIED') throw new CoreError('UnknownState', 'Media upload is already verified', 409);
    if (row.state === 'REJECTED') throw new CoreError('UnknownState', 'Media upload was rejected', 409);
    if (row.expires_at <= this.#clock()) throw new CoreError('UnknownState', 'Media upload intent expired', 409);
    const signed = await this.#storage.createUpload({
      uploadIntentId: row.upload_intent_id,
      objectKey: row.object_key,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
      expiresAt: row.expires_at,
    });
    const target = validatedUploadTarget(signed);
    await this.#transactions.transaction(async (executor) => {
      const current = await executor.query<UploadIntentRow>(
        'SELECT * FROM core.media_upload_intents WHERE upload_intent_id = $1 FOR UPDATE',
        [row.upload_intent_id],
      );
      const value = current.rows[0];
      if (!value || value.owner_wallet !== wallet) throw new CoreError('Forbidden', 'Media upload ownership changed', 403);
      if (value.purpose === 'MERCHANT_LICENSE') {
        await authorizeResource(executor, actor, value.purpose, value.resource_type, value.resource_id);
      }
      if (value.state === 'VERIFIED') throw new CoreError('UnknownState', 'Media upload is already verified', 409);
      if (value.state === 'REJECTED') throw new CoreError('UnknownState', 'Media upload was rejected', 409);
      if (value.provider_reference_hash && value.provider_reference_hash !== target.providerReferenceHash) {
        throw new CoreError('ExternalBlocked', 'Media provider changed the upload reference', 503);
      }
      await executor.query(
        `UPDATE core.media_upload_intents SET state = 'UPLOADED',
           provider_reference_hash = $2, updated_at = $3
         WHERE upload_intent_id = $1 AND state IN ('PENDING','UPLOADED')`,
        [row.upload_intent_id, target.providerReferenceHash, this.#clock()],
      );
    });
    return {
      artifactVersion: CORE_ARTIFACT_VERSION,
      uploadIntentId: row.upload_intent_id,
      ownerWallet: row.owner_wallet,
      purpose: row.purpose,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      contentType: row.content_type,
      sizeBytes: String(row.size_bytes),
      contentSha256: row.content_sha256,
      state: 'UPLOADED' as const,
      expiresAt: row.expires_at.toISOString(),
      method: target.method,
      uploadUrl: target.uploadUrl,
      headers: target.headers,
      writeOnce: target.writeOnce,
      providerReferenceHash: target.providerReferenceHash,
    };
  }

  async completeUpload(actor: FulfillmentActor, uploadIntentId: string) {
    const wallet = actorWallet(actor);
    const row = await this.#transactions.transaction(async (executor) => {
      const result = await executor.query<UploadIntentRow>(
        'SELECT * FROM core.media_upload_intents WHERE upload_intent_id = $1 FOR UPDATE',
        [uploadIntentId],
      );
      const value = result.rows[0];
      if (!value) throw new CoreError('UnknownState', 'Media upload intent was not found', 404);
      if (value.owner_wallet !== wallet) throw new CoreError('Forbidden', 'Media upload belongs to another wallet', 403);
      if (value.purpose === 'MERCHANT_LICENSE') {
        await authorizeResource(executor, actor, value.purpose, value.resource_type, value.resource_id);
      }
      if (value.state === 'REJECTED') throw new CoreError('UnknownState', 'Media upload was rejected', 409);
      if (value.state === 'PENDING') throw new CoreError('UnknownState', 'Media upload target was not issued', 409);
      return value;
    });
    if (row.state === 'VERIFIED') return this.#transactions.transaction((executor) => loadMediaAsset(executor, row.upload_intent_id));
    if (row.expires_at <= this.#clock()) throw new CoreError('UnknownState', 'Media upload intent expired', 409);
    const verified = validatedProviderEvidence(await this.#storage.finalizeUpload({
      uploadIntentId: row.upload_intent_id,
      objectKey: row.object_key,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      contentSha256: row.content_sha256,
    }));
    return this.#transactions.transaction(async (executor) => {
      const current = await executor.query<UploadIntentRow>(
        'SELECT * FROM core.media_upload_intents WHERE upload_intent_id = $1 FOR UPDATE',
        [uploadIntentId],
      );
      const value = current.rows[0];
      if (!value || value.owner_wallet !== wallet) throw new CoreError('Forbidden', 'Media upload ownership changed', 403);
      if (value.purpose === 'MERCHANT_LICENSE') {
        await authorizeResource(executor, actor, value.purpose, value.resource_type, value.resource_id);
      }
      if (value.state === 'VERIFIED') return loadMediaAsset(executor, uploadIntentId);
      if (value.state !== 'UPLOADED') throw new CoreError('UnknownState', 'Media upload can no longer be verified', 409);
      if (value.expires_at <= this.#clock()) throw new CoreError('UnknownState', 'Media upload intent expired', 409);
      const now = this.#clock();
      const assetId = hashJson({
        domain: 'ABU24K_MEDIA_ASSET_V1',
        uploadIntentId,
        contentSha256: value.content_sha256,
        providerEvidenceHash: verified.providerEvidenceHash.toLowerCase(),
        objectVersionHash: verified.objectVersionHash,
      });
      const updated = await executor.query<{ upload_intent_id: string }>(
        `UPDATE core.media_upload_intents SET state = 'VERIFIED',
           provider_evidence_hash = $2, verified_at = $3, updated_at = $3
         WHERE upload_intent_id = $1 AND state = 'UPLOADED'
         RETURNING upload_intent_id`,
        [uploadIntentId, verified.providerEvidenceHash.toLowerCase(), now],
      );
      if (!updated.rows[0]) throw new CoreError('UnknownState', 'Media upload state changed during verification', 409);
      await executor.query(
         `INSERT INTO core.media_assets (
           asset_id, upload_intent_id, owner_wallet, purpose, resource_type,
           resource_id, object_key, content_type, size_bytes, content_sha256,
           provider_evidence_hash, object_version_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (upload_intent_id) DO NOTHING`,
        [
          assetId,
          uploadIntentId,
          value.owner_wallet,
          value.purpose,
          value.resource_type,
          value.resource_id,
          value.object_key,
          value.content_type,
          value.size_bytes,
          value.content_sha256,
          verified.providerEvidenceHash.toLowerCase(),
          verified.objectVersionHash,
          now,
        ],
      );
      return loadMediaAsset(executor, uploadIntentId);
    });
  }

  async createReadAccess(actor: FulfillmentActor | undefined, assetId: string) {
    validateProviderHash(assetId, 'assetId');
    const authorized = await this.#transactions.transaction(async (executor) => {
      const asset = await loadMediaAssetById(executor, assetId.toLowerCase());
      const accessScope = await authorizeMediaRead(executor, actor, asset);
      return { asset, accessScope };
    });
    const expiresAt = new Date(this.#clock().getTime() + 5 * 60_000);
    const readRequest = {
      assetId: authorized.asset.asset_id,
      objectKey: authorized.asset.object_key,
      objectVersionHash: authorized.asset.object_version_hash,
      contentType: authorized.asset.content_type,
      contentSha256: authorized.asset.content_sha256,
      expiresAt,
    };
    const target = validatedReadTarget(
      await this.#storage.createRead(readRequest),
      readRequest,
      this.#clock(),
      expiresAt,
    );
    return {
      artifactVersion: CORE_ARTIFACT_VERSION,
      assetId: authorized.asset.asset_id,
      purpose: authorized.asset.purpose,
      resourceType: authorized.asset.resource_type,
      resourceId: authorized.asset.resource_id,
      contentType: authorized.asset.content_type,
      sizeBytes: String(authorized.asset.size_bytes),
      contentSha256: authorized.asset.content_sha256,
      objectVersionHash: authorized.asset.object_version_hash,
      accessScope: authorized.accessScope,
      ...target,
    };
  }
}

export class HttpMediaStorageAdapter implements MediaStorageAdapter {
  readonly #url: string | undefined;
  readonly #token: string | undefined;

  constructor(input: { url?: string; token?: string }) {
    this.#url = input.url;
    this.#token = input.token;
  }

  createUpload(input: Parameters<MediaStorageAdapter['createUpload']>[0]) {
    return this.#request('/v1/upload-intents', input) as ReturnType<MediaStorageAdapter['createUpload']>;
  }

  finalizeUpload(input: Parameters<MediaStorageAdapter['finalizeUpload']>[0]) {
    return this.#request('/v1/upload-finalizations', input) as ReturnType<MediaStorageAdapter['finalizeUpload']>;
  }

  createRead(input: Parameters<MediaStorageAdapter['createRead']>[0]) {
    return this.#request('/v1/read-authorizations', input) as ReturnType<MediaStorageAdapter['createRead']>;
  }

  async #request(path: string, input: unknown) {
    if (!this.#url || !this.#token) throw new CoreError('ConfigurationRequired', 'Media storage signer is not configured', 503);
    if (!this.#url.startsWith('https://')) throw new CoreError('ConfigurationRequired', 'Media storage signer must use HTTPS', 503);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#url), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ artifactVersion: CORE_ARTIFACT_VERSION, ...input as object }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new CoreError('ExternalBlocked', 'Media storage signer is unavailable', 503);
    }
    if (!response.ok) throw new CoreError('ExternalBlocked', 'Media storage signer rejected the request', 503);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CoreError('ExternalBlocked', 'Media storage signer returned invalid JSON', 503);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CoreError('ExternalBlocked', 'Media storage signer returned an invalid response', 503);
    }
    return body;
  }
}

function validateUploadInput(input: {
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
  idempotencyKey: string;
}) {
  validateResourceId(input.resourceId);
  const expected = input.purpose === 'PRODUCT_IMAGE' || input.purpose === 'PRODUCT_VIDEO'
    ? 'PRODUCT'
    : input.purpose === 'CATEGORY_ICON' ? 'CATEGORY'
    : input.purpose === 'STORE_IMAGE' ? 'STORE'
    : input.purpose === 'BUYER_AVATAR' ? 'BUYER'
    : input.purpose === 'MERCHANT_LOGO' || input.purpose === 'MERCHANT_LICENSE' ? 'MERCHANT'
    : 'ORDER';
  if (input.resourceType !== expected) throw new CoreError('InvalidRequest', 'Media purpose does not match its resource');
  if (!CONTENT_TYPES.includes(input.contentType as (typeof CONTENT_TYPES)[number])) {
    throw new CoreError('InvalidRequest', 'Unsupported media content type');
  }
  if (!contentTypeMatchesPurpose(input.purpose, input.contentType)) {
    throw new CoreError('InvalidRequest', 'Media content type does not match its purpose');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 10_485_760) {
    throw new CoreError('InvalidRequest', 'Media size is outside the allowed range');
  }
  validateProviderHash(input.contentSha256, 'content SHA-256');
  validateIdempotencyKey(input.idempotencyKey);
}

function contentTypeMatchesPurpose(purpose: MediaPurpose, contentType: string) {
  if (purpose === 'PRODUCT_VIDEO') return contentType === 'video/mp4';
  if (purpose === 'FULFILLMENT_EVIDENCE' || purpose === 'MERCHANT_LICENSE') {
    return contentType === 'application/pdf'
      || IMAGE_CONTENT_TYPES.includes(contentType as (typeof IMAGE_CONTENT_TYPES)[number]);
  }
  return IMAGE_CONTENT_TYPES.includes(contentType as (typeof IMAGE_CONTENT_TYPES)[number]);
}

async function authorizeResource(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  purpose: MediaPurpose,
  resourceType: MediaResourceType,
  resourceId: string,
) {
  const wallet = actorWallet(actor);
  if (resourceType === 'ORDER') {
    const row = await loadOrderScope(executor, resourceId);
    if (hasRole(actor, 'ADMIN', 'OPERATOR')) return;
    if (
      (hasRole(actor, 'BUYER') && row.buyer_wallet === wallet)
      || (hasRole(actor, 'MERCHANT') && actor.merchantId === row.merchant_id && row.merchant_wallet === wallet)
    ) return;
  } else if (resourceType === 'PRODUCT') {
    const result = await executor.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.products WHERE product_id = $1',
      [resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new CoreError('UnknownState', 'Product was not found', 404);
    if (hasRole(actor, 'ADMIN', 'OPERATOR')) return;
    if (hasRole(actor, 'MERCHANT') && row.merchant_id === actor.merchantId) return;
  } else if (resourceType === 'CATEGORY') {
    const result = await executor.query<{ category_id: string }>(
      'SELECT category_id FROM core.catalog_categories WHERE category_id = $1',
      [resourceId],
    );
    if (!result.rows[0]) throw new CoreError('UnknownState', 'Category was not found', 404);
    if (hasRole(actor, 'ADMIN', 'OPERATOR')) return;
  } else if (resourceType === 'STORE') {
    const result = await executor.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.merchant_stores WHERE store_id = $1',
      [resourceId],
    );
    const row = result.rows[0];
    if (!row) throw new CoreError('UnknownState', 'Store was not found', 404);
    if (hasRole(actor, 'ADMIN', 'OPERATOR')) return;
    if (hasRole(actor, 'MERCHANT') && row.merchant_id === actor.merchantId) return;
  } else if (resourceType === 'BUYER') {
    if (hasRole(actor, 'BUYER') && resourceId.toLowerCase() === wallet) return;
  } else if (resourceType === 'MERCHANT') {
    if (
      purpose === 'MERCHANT_LICENSE'
      && hasRole(actor, 'ADMIN', 'OPERATOR')
      && await hasActivePlatformMediaRole(executor, actor, wallet, ['ADMIN', 'OPERATOR'])
    ) {
      const merchant = await executor.query<{ merchant_id: string }>(
        'SELECT merchant_id FROM core.merchants WHERE merchant_id = $1',
        [resourceId],
      );
      if (merchant.rows[0]) return;
    }
    if (hasRole(actor, 'MERCHANT') && actor.merchantId === resourceId) {
      const binding = await executor.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM core.wallet_role_bindings
           WHERE wallet_address = $1 AND role = 'MERCHANT' AND merchant_id = $2 AND status = 'ACTIVE'
         ) AS active`,
        [wallet, resourceId],
      );
      if (binding.rows[0]?.active) return;
    }
  }
  throw new CoreError('Forbidden', 'Resource evidence is outside the wallet scope', 403);
}

async function verifyMediaAssets(
  executor: SqlExecutor,
  wallet: string,
  resourceType: string,
  resourceId: string,
  assetIds: string[],
) {
  if (assetIds.length === 0) return;
  const placeholders = assetIds.map((_, index) => `$${index + 4}`).join(',');
  const result = await executor.query<{ asset_id: string }>(
    `SELECT asset_id FROM core.media_assets
     WHERE owner_wallet = $1 AND resource_type = $2 AND resource_id = $3
       AND asset_id IN (${placeholders})`,
    [wallet, resourceType, resourceId, ...assetIds],
  );
  if (result.rows.length !== assetIds.length) throw new CoreError('Forbidden', 'Media evidence is unverified or outside the resource', 403);
}

async function reserveUploadQuota(
  executor: SqlExecutor,
  wallet: string,
  idempotencyKey: string,
  requestHash: string,
  requestedBytes: number,
  now: Date,
  limits: MediaUploadLimits | undefined,
) {
  if (
    !limits
    || !Number.isSafeInteger(limits.maxIntentsPerWalletHour)
    || limits.maxIntentsPerWalletHour < 1
    || limits.maxBytesPerWalletHour < 1n
  ) throw new CoreError('ConfigurationRequired', 'Media upload quota is not configured', 503);
  await executor.query(
    `INSERT INTO core.media_upload_wallet_locks (owner_wallet, updated_at)
     VALUES ($1,$2)
     ON CONFLICT (owner_wallet) DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING owner_wallet`,
    [wallet, now],
  );
  const duplicate = await executor.query<UploadIntentRow>(
    'SELECT * FROM core.media_upload_intents WHERE owner_wallet = $1 AND idempotency_key = $2',
    [wallet, idempotencyKey],
  );
  if (duplicate.rows[0]) {
    if (duplicate.rows[0].request_hash !== requestHash) {
      throw new CoreError('IdempotencyConflict', 'Upload intent changed', 409);
    }
    return duplicate.rows[0];
  }
  const result = await executor.query<{ intents: string | number; bytes: string | number }>(
    `SELECT count(*) AS intents, coalesce(sum(size_bytes), 0) AS bytes
     FROM core.media_upload_intents
     WHERE owner_wallet = $1 AND state <> 'REJECTED' AND created_at >= $2`,
    [wallet, new Date(now.getTime() - 60 * 60_000)],
  );
  const usage = result.rows[0];
  if (
    Number(usage?.intents ?? 0) >= limits.maxIntentsPerWalletHour
    || BigInt(usage?.bytes ?? 0) + BigInt(requestedBytes) > limits.maxBytesPerWalletHour
  ) throw new CoreError('Forbidden', 'Media upload quota exceeded', 429);
  return undefined;
}

async function loadMediaAsset(executor: SqlExecutor, uploadIntentId: string) {
  const result = await executor.query<MediaAssetRow>(
    `SELECT asset_id, upload_intent_id, owner_wallet, purpose, resource_type,
       resource_id, content_type, size_bytes::text AS size_bytes,
       content_sha256, provider_evidence_hash, object_version_hash, created_at
     FROM core.media_assets WHERE upload_intent_id = $1`,
    [uploadIntentId],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Verified media asset is unavailable', 409);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    assetId: row.asset_id,
    uploadIntentId: row.upload_intent_id,
    ownerWallet: row.owner_wallet,
    purpose: row.purpose,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    contentType: row.content_type,
    sizeBytes: String(row.size_bytes),
    contentSha256: row.content_sha256,
    providerEvidenceHash: row.provider_evidence_hash,
    objectVersionHash: row.object_version_hash,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadMediaAssetById(executor: SqlExecutor, assetId: string) {
  const result = await executor.query<MediaAssetRow>(
    'SELECT * FROM core.media_assets WHERE asset_id = $1',
    [assetId],
  );
  if (!result.rows[0]) throw new CoreError('UnknownState', 'Verified media asset was not found', 404);
  return result.rows[0];
}

async function authorizeMediaRead(
  executor: SqlExecutor,
  actor: FulfillmentActor | undefined,
  asset: MediaAssetRow,
): Promise<'PUBLIC' | 'AUTHENTICATED'> {
  if (await isPublicMediaAsset(executor, asset)) return 'PUBLIC';
  if (!actor) throw new CoreError('Forbidden', 'Media asset is not public', 403);
  const wallet = actorWallet(actor);
  if (asset.purpose === 'MERCHANT_LICENSE') {
    if (await hasActivePlatformMediaRole(executor, actor, wallet, ['ADMIN', 'OPERATOR'])) {
      return 'AUTHENTICATED';
    }
    throw new CoreError('Forbidden', 'Merchant license is restricted to active review roles', 403);
  }
  if (wallet === asset.owner_wallet) return 'AUTHENTICATED';
  if (await hasActivePlatformMediaRole(executor, actor, wallet)) return 'AUTHENTICATED';
  if (asset.resource_type === 'ORDER') {
    const order = await loadOrderScope(executor, asset.resource_id);
    if (
      (hasRole(actor, 'BUYER') && order.buyer_wallet === wallet)
      || (
        hasRole(actor, 'MERCHANT')
        && actor.merchantId === order.merchant_id
        && order.merchant_wallet === wallet
      )
    ) return 'AUTHENTICATED';
  }
  if (asset.resource_type === 'PRODUCT') {
    const product = await executor.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.products WHERE product_id = $1',
      [asset.resource_id],
    );
    if (
      hasRole(actor, 'MERCHANT')
      && actor.merchantId
      && product.rows[0]?.merchant_id === actor.merchantId
      && await hasActiveMerchantBinding(executor, wallet, actor.merchantId)
    ) return 'AUTHENTICATED';
  }
  if (asset.resource_type === 'STORE') {
    const store = await executor.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.merchant_stores WHERE store_id = $1',
      [asset.resource_id],
    );
    if (
      hasRole(actor, 'MERCHANT')
      && actor.merchantId
      && store.rows[0]?.merchant_id === actor.merchantId
      && await hasActiveMerchantBinding(executor, wallet, actor.merchantId)
    ) return 'AUTHENTICATED';
  }
  if (asset.resource_type === 'BUYER' && asset.resource_id.toLowerCase() === wallet && hasRole(actor, 'BUYER')) {
    return 'AUTHENTICATED';
  }
  if (
    asset.resource_type === 'MERCHANT'
    && hasRole(actor, 'MERCHANT')
    && actor.merchantId === asset.resource_id
    && await hasActiveMerchantBinding(executor, wallet, actor.merchantId)
  ) return 'AUTHENTICATED';
  throw new CoreError('Forbidden', 'Media asset is outside the actor scope', 403);
}

async function isPublicMediaAsset(executor: SqlExecutor, asset: MediaAssetRow) {
  if (asset.resource_type === 'PRODUCT' && ['PRODUCT_IMAGE', 'PRODUCT_VIDEO'].includes(asset.purpose)) {
    const result = await executor.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.products product
         JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
         WHERE product.product_id = $1 AND product.lifecycle_state = 'ACTIVE'
           AND merchant.status = 'APPROVED' AND merchant.guarantee_status = 'READY'
           AND (
             product.video_asset_id = $2
             OR EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(product.main_image_asset_ids) media(asset_id)
               WHERE media.asset_id = $2
             )
           )
       ) AS visible`,
      [asset.resource_id, asset.asset_id],
    );
    return result.rows[0]?.visible === true;
  }
  if (asset.resource_type === 'CATEGORY' && asset.purpose === 'CATEGORY_ICON') {
    const result = await executor.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM core.catalog_categories category
         JOIN core.catalog_category_versions version
           ON version.category_id = category.category_id AND version.version = category.current_version
         WHERE category.category_id = $1 AND version.status = 'ENABLED' AND version.icon_asset_id = $2
       ) AS visible`,
      [asset.resource_id, asset.asset_id],
    );
    return result.rows[0]?.visible === true;
  }
  return false;
}

async function hasActivePlatformMediaRole(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  wallet: string,
  permitted: readonly ('ADMIN' | 'OPERATOR' | 'AUDITOR' | 'ARBITRATOR')[] = ['ADMIN', 'OPERATOR', 'AUDITOR', 'ARBITRATOR'],
) {
  const platformRoles = ['ADMIN', 'OPERATOR', 'AUDITOR', 'ARBITRATOR'] as const;
  const allowed = platformRoles.filter((role) => permitted.includes(role) && actor.roles.includes(role));
  if (allowed.length === 0) return false;
  const result = await executor.query<{ role: (typeof platformRoles)[number] }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND status = 'ACTIVE'
       AND role IN ('ADMIN','OPERATOR','AUDITOR','ARBITRATOR')`,
    [wallet],
  );
  return result.rows.some((row) => allowed.includes(row.role));
}

async function hasActiveMerchantBinding(executor: SqlExecutor, wallet: string, merchantId: string) {
  const result = await executor.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.wallet_role_bindings
       WHERE wallet_address = $1 AND role = 'MERCHANT' AND merchant_id = $2 AND status = 'ACTIVE'
     ) AS active`,
    [wallet, merchantId],
  );
  return result.rows[0]?.active === true;
}

function existingEvidence(row: EvidenceRow, requestHash: string) {
  if (row.payload_hash !== requestHash) throw new CoreError('IdempotencyConflict', 'Evidence input changed', 409);
  return evidenceProjection(row);
}

function evidenceProjection(row: EvidenceRow) {
  const payload = object(row.payload);
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    evidenceHash: row.evidence_hash,
    ownerWallet: row.owner_wallet,
    actorRole: row.actor_role,
    purpose: row.purpose,
    resourceType: 'ORDER' as const,
    resourceId: row.resource_id,
    action: row.action_type,
    reasonCode: row.reason_code,
    trackingNumberHash: row.tracking_number_hash,
    mediaAssetIds: stringArray(row.media_asset_ids),
    payload,
    ...(row.purpose === 'SHIPMENT_TRACKING' && typeof payload.carrierCode === 'string'
      ? { carrierCode: payload.carrierCode }
      : {}),
    createdAt: row.created_at.toISOString(),
  };
}

function normalizeTrackingNumber(value: string) {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z0-9]{6,40}$/.test(normalized)) throw new CoreError('InvalidRequest', 'Tracking number format is invalid');
  return normalized;
}

function safeObjectSegment(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function boundedCode(value: string, label: string) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) throw new CoreError('InvalidRequest', `${label} is invalid`);
  return value;
}

function validateResourceId(value: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new CoreError('InvalidRequest', 'resourceId is invalid');
  }
}

async function authorizeActionOrder(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  orderId: string,
  action: EvidenceAction,
): Promise<EvidenceRow['actor_role']> {
  const row = await loadOrderScope(executor, orderId);
  const wallet = actorWallet(actor);
  const buyer = hasRole(actor, 'BUYER') && row.buyer_wallet === wallet;
  const merchant = hasRole(actor, 'MERCHANT')
    && actor.merchantId === row.merchant_id;
  if (action === 'REQUEST_FORCED_RECEIPT') {
    if (merchant) return 'MERCHANT';
  } else if (action === 'VERIFY_PICKUP') {
    if (merchant) return 'MERCHANT';
    const platform = platformActorRole(actor);
    if (platform) return platform;
  } else if (action === 'OPEN_ARBITRATION') {
    if (buyer) return 'BUYER';
    const platform = platformActorRole(actor);
    if (platform) return platform;
  } else if (buyer) {
    return 'BUYER';
  }
  throw new CoreError('Forbidden', 'Evidence action is outside the actor order scope', 403);
}

async function authorizeShipmentOrder(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  orderId: string,
): Promise<EvidenceRow['actor_role']> {
  const row = await loadOrderScope(executor, orderId);
  if (
    hasRole(actor, 'MERCHANT')
    && actor.merchantId === row.merchant_id
  ) return 'MERCHANT';
  const platform = platformActorRole(actor);
  if (platform) return platform;
  throw new CoreError('Forbidden', 'Shipment evidence is outside the actor order scope', 403);
}

async function loadOrderScope(executor: SqlExecutor, orderId: string) {
  const result = await executor.query<{ buyer_wallet: string; merchant_id: string; merchant_wallet: string }>(
    'SELECT buyer_wallet, merchant_id, merchant_wallet FROM core.orders WHERE order_id = $1',
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Order was not found', 404);
  return row;
}

function platformActorRole(actor: FulfillmentActor): 'OPERATOR' | 'ADMIN' | undefined {
  if (hasRole(actor, 'OPERATOR')) return 'OPERATOR';
  if (hasRole(actor, 'ADMIN')) return 'ADMIN';
  return undefined;
}

async function loadEvidence(executor: SqlExecutor, evidenceHash: string) {
  const result = await executor.query<EvidenceRow>(
    'SELECT * FROM core.evidence_envelopes WHERE evidence_hash = $1',
    [evidenceHash.toLowerCase()],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Canonical evidence is unavailable', 403);
  return result.rows[0];
}

export async function assertTrackingEvidenceRecord(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  input: {
    orderId: string;
    carrierCode: Carrier;
    trackingNumberHash: string;
    evidenceHash: string;
  },
) {
  const wallet = actorWallet(actor);
  validateProviderHash(input.evidenceHash, 'evidence hash');
  validateProviderHash(input.trackingNumberHash, 'tracking number hash');
  const actorRole = await authorizeShipmentOrder(executor, actor, input.orderId);
  const row = await loadEvidence(executor, input.evidenceHash);
  const payload = object(row.payload);
  if (
    row.owner_wallet !== wallet
    || row.actor_role !== actorRole
    || row.purpose !== 'SHIPMENT_TRACKING'
    || row.resource_id !== input.orderId
    || row.tracking_number_hash !== input.trackingNumberHash.toLowerCase()
    || payload.carrierCode !== input.carrierCode
  ) throw new CoreError('Forbidden', 'Shipment evidence does not match the command', 403);
  return evidenceProjection(row);
}

function validatedUploadTarget(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('ExternalBlocked', 'Media provider returned an invalid upload target', 503);
  }
  const target = value as Record<string, unknown>;
  const headers = normalizedHeaders(target.headers);
  if (
    target.method !== 'PUT'
    || typeof target.uploadUrl !== 'string'
    || !target.uploadUrl.startsWith('https://')
    || !headers
    || headers['if-none-match'] !== '*'
    || typeof target.providerReferenceHash !== 'string'
    || target.writeOnce !== true
  ) throw new CoreError('ExternalBlocked', 'Media provider returned an invalid upload target', 503);
  try {
    validateProviderHash(target.providerReferenceHash, 'provider reference hash');
  } catch {
    throw new CoreError('ExternalBlocked', 'Media provider returned an invalid upload reference', 503);
  }
  return {
    method: 'PUT' as const,
    uploadUrl: target.uploadUrl,
    headers,
    providerReferenceHash: target.providerReferenceHash.toLowerCase(),
    writeOnce: true as const,
  };
}

function validatedReadTarget(
  value: unknown,
  expected: { assetId: string; contentSha256: string; objectVersionHash: string },
  now: Date,
  maximumExpiresAt: Date,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('ExternalBlocked', 'Media provider returned an invalid read target', 503);
  }
  const target = value as Record<string, unknown>;
  const expiresAt = typeof target.expiresAt === 'string' ? new Date(target.expiresAt) : new Date(Number.NaN);
  if (
    target.method !== 'GET'
    || typeof target.readUrl !== 'string'
    || !target.readUrl.startsWith('https://')
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt <= now
    || expiresAt > maximumExpiresAt
    || typeof target.providerReferenceHash !== 'string'
    || typeof target.assetId !== 'string'
    || target.assetId.toLowerCase() !== expected.assetId.toLowerCase()
    || typeof target.contentSha256 !== 'string'
    || target.contentSha256.toLowerCase() !== expected.contentSha256.toLowerCase()
    || typeof target.objectVersionHash !== 'string'
    || target.objectVersionHash.toLowerCase() !== expected.objectVersionHash.toLowerCase()
  ) throw new CoreError('ExternalBlocked', 'Media provider returned an invalid read target', 503);
  try {
    validateProviderHash(target.providerReferenceHash, 'provider reference hash');
  } catch {
    throw new CoreError('ExternalBlocked', 'Media provider returned an invalid read reference', 503);
  }
  return {
    method: 'GET' as const,
    readUrl: target.readUrl,
    expiresAt: expiresAt.toISOString(),
    providerReferenceHash: target.providerReferenceHash.toLowerCase(),
  };
}

function validatedProviderEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('ExternalBlocked', 'Media provider returned invalid verification evidence', 503);
  }
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.providerEvidenceHash !== 'string'
    || typeof evidence.objectVersionHash !== 'string'
    || evidence.sealed !== true
  ) {
    throw new CoreError('ExternalBlocked', 'Media provider returned invalid verification evidence', 503);
  }
  try {
    validateProviderHash(evidence.providerEvidenceHash, 'provider evidence hash');
    validateProviderHash(evidence.objectVersionHash, 'object version hash');
  } catch {
    throw new CoreError('ExternalBlocked', 'Media provider returned invalid verification evidence', 503);
  }
  return {
    providerEvidenceHash: evidence.providerEvidenceHash.toLowerCase(),
    objectVersionHash: evidence.objectVersionHash.toLowerCase(),
    sealed: true as const,
  };
}

function normalizedHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header !== 'string') return undefined;
    const normalized = name.toLowerCase();
    if (headers[normalized] !== undefined && headers[normalized] !== header) return undefined;
    headers[normalized] = header;
  }
  return Object.freeze(headers);
}

function uniqueIds(values: string[], label: string) {
  if (!Array.isArray(values) || values.length > 8 || values.some((value) => !/^0x[0-9a-fA-F]{64}$/.test(value))) {
    throw new CoreError('InvalidRequest', `${label} is invalid`);
  }
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new CoreError('InvalidRequest', `${label} contains duplicates`);
  return normalized.sort();
}

function validateIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'Invalid idempotency key');
}

function validateProviderHash(value: string, label: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${label} is invalid`);
}

function actorWallet(actor: FulfillmentActor) {
  return normalizeAddress(actor.walletAddress);
}

function hasRole(actor: FulfillmentActor, ...roles: string[]) {
  return actor.roles.some((role) => roles.includes(role));
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hashText(value: string) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function trackingHash(key: string | undefined, orderId: string, carrier: Carrier, trackingNumber: string) {
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new CoreError('ConfigurationRequired', 'Tracking hash key is unavailable', 503);
  }
  return `0x${createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`ABU24K_TRACKING_V2\0${orderId}\0${carrier}\0${trackingNumber}`)
    .digest('hex')}`;
}

function hashJson(value: unknown) {
  return hashText(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

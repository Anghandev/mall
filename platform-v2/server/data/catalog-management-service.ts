import { createHash, randomBytes } from 'node:crypto';
import { normalizeAddress } from '../api/auth.ts';
import { concessionPreviewAuthorization } from '../api/catalog-signing.ts';
import { buildMerchantConcessionPreview } from '../api/checkout.ts';
import {
  CORE_ARTIFACT_VERSION,
  catalogReviewDecisions,
  type CatalogReviewDecision,
} from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { parsePaymentPolicySnapshot } from '../api/payment-policy.ts';
import type { SignerRequest } from '../chain/signer.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import {
  isMicrotestProductEligible,
  type MainnetMicrotestEntitlement,
} from './mainnet-microtest-entitlement.ts';

const LOCKED_SESSION_PHASES = ['PREHEAT', 'LIVE', 'SETTLING'] as const;
const FULFILLMENT_MODES = ['DELIVERY', 'PICKUP'] as const;

type CatalogRole = 'MERCHANT' | 'ADMIN' | 'OPERATOR' | 'AUDITOR';
type ProductLifecycle = 'DRAFT' | 'REVIEW' | 'SCHEDULED' | 'ACTIVE' | 'SOLD_OUT' | 'HIDDEN' | 'DELISTED' | 'LOCKED';
type TaxonomyStatus = 'ENABLED' | 'DISABLED' | 'DELETED';

export interface CatalogPreviewSigner {
  sign(request: SignerRequest): Promise<{ signature: string; signer: string }>;
}

export interface ProductSkuInput {
  skuId?: string;
  attributes: Readonly<Record<string, unknown>>;
  listPriceUsdt: string;
  stockTotal: number;
  proposedSeckillInventory: number;
}

export interface ProductSlotInput {
  idempotencyKey: string;
  title: string;
  subtitle?: string;
  mainImageAssetIds?: string[];
  videoAssetId?: string;
  richDetail: Readonly<Record<string, unknown>>;
  defaultFreightUsdt: string;
  merchantConcessionBps: number;
  fulfillmentModes: Array<'DELIVERY' | 'PICKUP'>;
  categoryId?: string;
  tagIds?: string[];
  skus: ProductSkuInput[];
}

export interface CatalogProductLifecycleBatchInput {
  action: CatalogReviewDecision;
  productIds: string[];
  reasonCode: string;
  idempotencyKey: string;
}

interface ProductRow {
  product_id: string;
  chain_product_id: string;
  merchant_id: string;
  store_id: string | null;
  supersedes_product_id: string | null;
  version: string | number;
  title: string;
  subtitle: string;
  lifecycle_state: ProductLifecycle;
  product_policy_hash: string;
  merchant_concession_bps: number;
  metadata: unknown;
  main_image_asset_ids: unknown;
  video_asset_id: string | null;
  rich_detail: unknown;
  default_freight_usdt: string;
  fulfillment_modes: unknown;
  submission_hash: string | null;
  submission_preview_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SkuRow {
  sku_id: string;
  chain_sku_id: string;
  product_id: string;
  sku_version: string | number;
  attributes: unknown;
  list_price_usdt: string;
  merchant_cost_usdt: string;
  stock_total: string | number;
  stock_available: string | number;
  stock_reserved: string | number;
  lifecycle_state: string;
  proposed_seckill_inventory: string | number;
}

interface PreviewRow {
  preview_id: string;
  product_id: string;
  product_version: string | number;
  merchant_id: string;
  policy_version: string | number;
  concession_bps: number;
  catalog_fingerprint: string;
  destination_set_hash: string;
  preview_hash: string;
  authorization_digest: string;
  signature: string;
  signer: string;
  payload: unknown;
  request_hash: string;
  expires_at: Date | string;
  created_at: Date | string;
}

export class CatalogManagementService {
  readonly #transactions: SqlTransactionRunner;
  readonly #signer: CatalogPreviewSigner;
  readonly #clock: () => Date;
  readonly #bytes32: () => string;
  readonly #mainnetMicrotestEntitlement: MainnetMicrotestEntitlement | undefined;

  constructor(input: {
    transactions: SqlTransactionRunner;
    signer: CatalogPreviewSigner;
    clock?: () => Date;
    bytes32?: () => string;
    mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement;
  }) {
    this.#transactions = input.transactions;
    this.#signer = input.signer;
    this.#clock = input.clock ?? (() => new Date());
    this.#bytes32 = input.bytes32 ?? (() => `0x${randomBytes(32).toString('hex')}`);
    this.#mainnetMicrotestEntitlement = input.mainnetMicrotestEntitlement;
  }

  listCategories(includeInactive = false, actor?: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      if (includeInactive) {
        if (!actor) throw new CoreError('Forbidden', 'Platform catalog role is required', 403);
        await requirePlatformRole(executor, actor, true);
      }
      const result = await executor.query<{
        category_id: string;
        version: string | number;
        parent_category_id: string | null;
        level: number;
        name: string;
        icon_asset_id: string | null;
        sort_order: number;
        service_fee_bps: number | null;
        status: TaxonomyStatus;
      }>(
        `SELECT version.category_id, version.version, version.parent_category_id,
           version.level, version.name, version.icon_asset_id, version.sort_order,
           version.service_fee_bps, version.status
         FROM core.catalog_categories category
         JOIN core.catalog_category_versions version
           ON version.category_id = category.category_id
          AND version.version = category.current_version
         ${includeInactive ? '' : "WHERE version.status = 'ENABLED'"}
         ORDER BY version.level, version.sort_order, version.name, version.category_id`,
      );
      return result.rows.map(categoryProjection);
    });
  }

  listTags(includeInactive = false, actor?: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      if (includeInactive) {
        if (!actor) throw new CoreError('Forbidden', 'Platform catalog role is required', 403);
        await requirePlatformRole(executor, actor, true);
      }
      const result = await executor.query<{
        tag_id: string;
        version: string | number;
        name: string;
        example: string;
        sort_order: number;
        status: TaxonomyStatus;
      }>(
        `SELECT version.tag_id, version.version, version.name, version.example,
           version.sort_order, version.status
         FROM core.catalog_tags tag
         JOIN core.catalog_tag_versions version
           ON version.tag_id = tag.tag_id AND version.version = tag.current_version
         ${includeInactive ? '' : "WHERE version.status = 'ENABLED'"}
         ORDER BY version.sort_order, version.name, version.tag_id`,
      );
      return result.rows.map(tagProjection);
    });
  }

  upsertCategory(actor: FulfillmentActor, input: {
    categoryId?: string;
    parentCategoryId?: string | null;
    name: string;
    iconAssetId?: string;
    sortOrder: number;
    serviceFeeBps?: number;
    status?: TaxonomyStatus;
    idempotencyKey: string;
  }) {
    if (input.serviceFeeBps !== undefined) {
      throw new CoreError('DecisionBlocked', 'Category service fee is not frozen', 409, {
        field: 'serviceFeeBps',
      });
    }
    const value = validateCategoryInput(input);
    const wallet = actorWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformRole(executor, actor, false);
      const duplicate = await executor.query<{ category_id: string; request_hash: string }>(
        `SELECT category_id, request_hash FROM core.catalog_category_versions
         WHERE created_by = $1 AND idempotency_key = $2`,
        [wallet, value.idempotencyKey],
      );
      const requestHash = hashJson({ actor: wallet, ...value });
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) throw idempotencyConflict('Category');
        return loadCategory(executor, duplicate.rows[0].category_id);
      }
      const now = this.#clock();
      const categoryId = value.categoryId ?? resourceId('category', this.#bytes32());
      const current = await loadCategoryRow(executor, categoryId, true);
      const parentCategoryId = value.parentCategoryId === undefined
        ? current?.parent_category_id ?? undefined
        : value.parentCategoryId ?? undefined;
      if (parentCategoryId === categoryId) throw new CoreError('InvalidRequest', 'Category cannot be its own parent', 409);
      const parent = parentCategoryId
        ? await loadCategoryRow(executor, parentCategoryId, true)
        : undefined;
      if (parentCategoryId && (!parent || parent.status !== 'ENABLED')) {
        throw new CoreError('InvalidRequest', 'Parent category is unavailable', 409);
      }
      if (current && parentCategoryId !== (current.parent_category_id ?? undefined)) {
        await assertCategoryMoveSafe(executor, categoryId, parentCategoryId);
      }
      const level = parent ? parent.level + 1 : 1;
      if (level > 3) throw new CoreError('InvalidRequest', 'Category depth cannot exceed three levels');
      if (current && value.status !== 'ENABLED') {
        await assertTaxonomyCanDisable(executor, 'CATEGORY', categoryId);
      }
      const version = current ? Number(current.version) + 1 : 1;
      if (!current) {
        await executor.query(
          'INSERT INTO core.catalog_categories (category_id, current_version, created_at) VALUES ($1,$2,$3)',
          [categoryId, version, now],
        );
      }
      if (value.iconAssetId) {
        const icon = await executor.query<{ asset_id: string }>(
          `SELECT asset_id FROM core.media_assets
           WHERE asset_id = $1 AND owner_wallet = $2 AND purpose = 'CATEGORY_ICON'
             AND resource_type = 'CATEGORY' AND resource_id = $3`,
          [value.iconAssetId, wallet, categoryId],
        );
        if (!icon.rows[0]) throw new CoreError('Forbidden', 'Category icon is unverified or outside the category', 403);
      }
      await executor.query(
        `INSERT INTO core.catalog_category_versions (
           category_id, version, parent_category_id, level, name, icon_asset_id,
           sort_order, service_fee_bps, status, request_hash, idempotency_key,
           created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12)`,
        [
          categoryId,
          version,
          parentCategoryId ?? null,
          level,
          value.name,
          value.iconAssetId ?? null,
          value.sortOrder,
          value.status,
          requestHash,
          value.idempotencyKey,
          wallet,
          now,
        ],
      );
      if (current) {
        await executor.query(
          'UPDATE core.catalog_categories SET current_version = $2 WHERE category_id = $1',
          [categoryId, version],
        );
      }
      return loadCategory(executor, categoryId);
    });
  }

  upsertTag(actor: FulfillmentActor, input: {
    tagId?: string;
    name: string;
    example?: string;
    sortOrder: number;
    status?: TaxonomyStatus;
    idempotencyKey: string;
  }) {
    const value = validateTagInput(input);
    const wallet = actorWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformRole(executor, actor, false);
      const duplicate = await executor.query<{ tag_id: string; request_hash: string }>(
        `SELECT tag_id, request_hash FROM core.catalog_tag_versions
         WHERE created_by = $1 AND idempotency_key = $2`,
        [wallet, value.idempotencyKey],
      );
      const requestHash = hashJson({ actor: wallet, ...value });
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) throw idempotencyConflict('Tag');
        return loadTag(executor, duplicate.rows[0].tag_id);
      }
      const now = this.#clock();
      const tagId = value.tagId ?? resourceId('tag', this.#bytes32());
      const current = await loadTagRow(executor, tagId, true);
      if (current && value.status !== 'ENABLED') await assertTaxonomyCanDisable(executor, 'TAG', tagId);
      const version = current ? Number(current.version) + 1 : 1;
      if (!current) {
        await executor.query(
          'INSERT INTO core.catalog_tags (tag_id, current_version, created_at) VALUES ($1,$2,$3)',
          [tagId, version, now],
        );
      }
      await executor.query(
        `INSERT INTO core.catalog_tag_versions (
           tag_id, version, name, example, sort_order, status, request_hash,
           idempotency_key, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tagId, version, value.name, value.example, value.sortOrder, value.status,
          requestHash, value.idempotencyKey, wallet, now],
      );
      if (current) {
        await executor.query('UPDATE core.catalog_tags SET current_version = $2 WHERE tag_id = $1', [tagId, version]);
      }
      return loadTag(executor, tagId);
    });
  }

  getProductSlot(actor: FulfillmentActor, storeId: string, targetMerchantId?: string) {
    validateResourceId(storeId, 'storeId');
    return this.#transactions.transaction(async (executor) => {
      const scope = await authorizeStore(executor, actor, storeId, targetMerchantId);
      const row = await loadCurrentStoreProduct(executor, storeId);
      if (!row) {
        return {
          artifactVersion: CORE_ARTIFACT_VERSION,
          storeId,
          merchantId: scope.merchantId,
          product: null,
          allowedActions: scope.role === 'AUDITOR' ? [] : ['SAVE_DRAFT'],
          writeLock: null,
        };
      }
      const product = await productProjection(executor, row, actor);
      return {
        artifactVersion: CORE_ARTIFACT_VERSION,
        storeId,
        merchantId: scope.merchantId,
        product,
        allowedActions: product.allowedActions,
        writeLock: product.writeLock,
      };
    });
  }

  saveProductSlot(
    actor: FulfillmentActor,
    storeId: string,
    input: ProductSlotInput,
    targetMerchantId?: string,
  ) {
    const value = validateProductSlotInput(input);
    validateResourceId(storeId, 'storeId');
    const wallet = actorWallet(actor);
    const requestHash = hashJson({ actor: wallet, storeId, targetMerchantId: targetMerchantId ?? null, value });
    return this.#transactions.transaction(async (executor) => {
      const scope = await authorizeStore(executor, actor, storeId, targetMerchantId, true);
      const duplicate = await executor.query<{ request_hash: string; resource_id: string }>(
        `SELECT request_hash, resource_id FROM core.catalog_commands
         WHERE actor_wallet = $1 AND command_scope = 'SAVE_PRODUCT_SLOT' AND idempotency_key = $2`,
        [wallet, value.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) throw idempotencyConflict('Product');
        return productProjection(executor, await requireProduct(executor, duplicate.rows[0].resource_id), actor);
      }
      const current = await loadCurrentStoreProduct(executor, storeId, true);
      if (current) await assertProductWriteUnlocked(executor, current, this.#clock());
      const hasHistory = current ? await productHasHistory(executor, current.product_id) : false;
      const historicalPredecessor = current
        ? undefined
        : await loadLatestHistoricalStoreProduct(executor, storeId);
      const now = this.#clock();
      let productId: string;
      let version: number;
      if (!current || hasHistory) {
        if (current) {
          await executor.query(
            `UPDATE core.products SET lifecycle_state = 'DELISTED', updated_at = $2
             WHERE product_id = $1`,
            [current.product_id, now],
          );
          await executor.query(
            "UPDATE core.skus SET lifecycle_state = 'DELISTED' WHERE product_id = $1 AND lifecycle_state <> 'DELISTED'",
            [current.product_id],
          );
        }
        productId = resourceId('product', this.#bytes32());
        version = 1;
        await insertProduct(executor, {
          productId,
          chainProductId: this.#bytes32(),
          merchantId: scope.merchantId,
          storeId,
          supersedesProductId: current?.product_id ?? historicalPredecessor?.product_id ?? null,
          version,
          value,
          now,
        });
      } else {
        productId = current.product_id;
        version = Number(current.version) + 1;
        await updateProduct(executor, productId, version, value, now);
      }
      await verifyProductMedia(executor, wallet, productId, value.mainImageAssetIds, value.videoAssetId);
      await upsertProductSkus(executor, productId, value.skus, now);
      await insertAssignments(executor, productId, version, value.categoryId, value.tagIds, wallet, now);
      const policyHash = await productPolicyHash(executor, productId, version);
      await executor.query(
        'UPDATE core.products SET product_policy_hash = $2 WHERE product_id = $1',
        [productId, policyHash],
      );
      await executor.query(
        `INSERT INTO core.catalog_commands (
           actor_wallet, command_scope, idempotency_key, request_hash, resource_id, created_at
         ) VALUES ($1,'SAVE_PRODUCT_SLOT',$2,$3,$4,$5)`,
        [wallet, value.idempotencyKey, requestHash, productId, now],
      );
      return productProjection(executor, await requireProduct(executor, productId), actor);
    });
  }

  async createConcessionPreview(actor: FulfillmentActor, productId: string, input: {
    merchantConcessionBps: number;
    idempotencyKey: string;
  }) {
    validateResourceId(productId, 'productId');
    validateBps(input.merchantConcessionBps);
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    const requestHash = hashJson({ actor: wallet, productId, ...input });
    const existing = await this.#transactions.transaction(async (executor) => {
      await authorizeProduct(executor, actor, productId, false);
      const result = await executor.query<PreviewRow>(
        'SELECT * FROM core.merchant_concession_previews WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (!result.rows[0]) return undefined;
      if (result.rows[0].request_hash !== requestHash) throw idempotencyConflict('Concession preview');
      return previewProjection(result.rows[0]);
    });
    if (existing) return existing;

    const prepared = await this.#transactions.transaction(async (executor) => {
      const product = await authorizeProduct(executor, actor, productId, false);
      const policy = await latestPaymentPolicy(executor, this.#clock());
      const skus = await loadSkus(executor, productId);
      if (skus.length === 0) throw new CoreError('InvalidRequest', 'Product has no SKU', 409);
      const fingerprint = catalogFingerprint(product, skus);
      const items = skus.map((sku) => ({
        skuId: sku.sku_id,
        ...buildMerchantConcessionPreview(
          postFeeMerchantBase(sku.list_price_usdt),
          input.merchantConcessionBps,
        ),
      }));
      const expiresAt = new Date(this.#clock().getTime() + 5 * 60_000);
      const payload = Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        productId,
        productVersion: Number(product.version),
        merchantId: product.merchant_id,
        policyVersion: Number(policy.row.policy_version),
        merchantConcessionBps: input.merchantConcessionBps,
        destinationSetHash: policy.policy.concessionDestinationSetHash.toLowerCase(),
        catalogFingerprint: fingerprint,
        items,
        expiresAt: expiresAt.toISOString(),
      });
      return { product, policy, skus, payload, fingerprint, expiresAt };
    });
    const previewId = this.#bytes32().toLowerCase();
    const previewHash = hashJson(prepared.payload);
    const expiresAtSeconds = Math.floor(prepared.expiresAt.getTime() / 1000);
    const authorization = concessionPreviewAuthorization({
      previewHash,
      previewId,
      productId,
      policyVersion: Number(prepared.policy.row.policy_version),
      expiresAt: expiresAtSeconds,
    });
    const signed = await this.#signer.sign({
      purpose: 'PRODUCT_CONCESSION_PREVIEW',
      digest: authorization.digest,
      resourceId: previewId,
      policyVersion: Number(prepared.policy.row.policy_version),
      deadline: expiresAtSeconds,
      idempotencyKey: input.idempotencyKey,
    });
    return this.#transactions.transaction(async (executor) => {
      const product = await authorizeProduct(executor, actor, productId, false);
      const policy = await latestPaymentPolicy(executor, this.#clock());
      const skus = await loadSkus(executor, productId);
      if (
        catalogFingerprint(product, skus) !== prepared.fingerprint
        || Number(policy.row.policy_version) !== Number(prepared.policy.row.policy_version)
      ) throw new CoreError('ArtifactVersionMismatch', 'Catalog or policy changed before preview signing', 409);
      await executor.query(
        `INSERT INTO core.merchant_concession_previews (
           preview_id, product_id, product_version, merchant_id, policy_version,
           concession_bps, catalog_fingerprint, destination_set_hash, preview_hash,
           authorization_digest, signature, signer, payload, idempotency_key,
           request_hash, expires_at, created_by, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (created_by, idempotency_key) DO NOTHING`,
        [
          previewId,
          productId,
          product.version,
          product.merchant_id,
          policy.row.policy_version,
          input.merchantConcessionBps,
          prepared.fingerprint,
          prepared.policy.policy.concessionDestinationSetHash.toLowerCase(),
          previewHash,
          authorization.digest,
          signed.signature,
          normalizeAddress(signed.signer),
          JSON.stringify(prepared.payload),
          input.idempotencyKey,
          requestHash,
          prepared.expiresAt,
          wallet,
          this.#clock(),
        ],
      );
      const result = await executor.query<PreviewRow>(
        'SELECT * FROM core.merchant_concession_previews WHERE created_by = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (!result.rows[0] || result.rows[0].request_hash !== requestHash) throw idempotencyConflict('Concession preview');
      return previewProjection(result.rows[0]);
    });
  }

  submitReview(actor: FulfillmentActor, productId: string, input: {
    previewId: string;
    idempotencyKey: string;
  }) {
    validateResourceId(productId, 'productId');
    validateBytes32(input.previewId, 'previewId');
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    const requestHash = hashJson({ actor: wallet, productId, previewId: input.previewId });
    return this.#transactions.transaction(async (executor) => {
      const product = await authorizeProduct(executor, actor, productId, true);
      const duplicate = await executor.query<{ snapshot_hash: string }>(
        'SELECT snapshot_hash FROM core.product_review_events WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].snapshot_hash !== requestHash) throw idempotencyConflict('Review submission');
        return productProjection(executor, await requireProduct(executor, productId), actor);
      }
      if (product.lifecycle_state !== 'DRAFT') throw productLock('PRODUCT_STATE', product.product_id, product.lifecycle_state);
      await assertProductWriteUnlocked(executor, product, this.#clock());
      await assertProductReadyForReview(executor, product, wallet, input.previewId, this.#clock());
      const now = this.#clock();
      await executor.query(
        `UPDATE core.products SET lifecycle_state = 'REVIEW', submission_hash = $2,
           submission_preview_id = $3, updated_at = $4
         WHERE product_id = $1`,
        [productId, requestHash, input.previewId.toLowerCase(), now],
      );
      await executor.query(
        "UPDATE core.skus SET lifecycle_state = 'REVIEW' WHERE product_id = $1 AND lifecycle_state <> 'DELISTED'",
        [productId],
      );
      await insertReviewEvent(executor, {
        eventId: this.#bytes32(), product, decision: 'SUBMITTED', from: 'DRAFT', to: 'REVIEW',
        reasonCode: 'MERCHANT_SUBMISSION', snapshotHash: requestHash,
        wallet, idempotencyKey: input.idempotencyKey, now,
      });
      return productProjection(executor, await requireProduct(executor, productId), actor);
    });
  }

  decideReview(actor: FulfillmentActor, productId: string, input: {
    decision: CatalogReviewDecision;
    reasonCode: string;
    idempotencyKey: string;
  }) {
    validateResourceId(productId, 'productId');
    validateReasonCode(input.reasonCode);
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformRole(executor, actor, false);
      const product = await requireProduct(executor, productId, true);
      const requestHash = hashJson({ actor: wallet, productId, ...input });
      const duplicate = await executor.query<{ snapshot_hash: string }>(
        'SELECT snapshot_hash FROM core.product_review_events WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].snapshot_hash !== requestHash) throw idempotencyConflict('Review decision');
        return productProjection(executor, await requireProduct(executor, productId), actor);
      }
      const now = this.#clock();
      const transition = await prepareProductLifecycleDecision(
        executor,
        product,
        input.decision,
        now,
        this.#mainnetMicrotestEntitlement,
      );
      await applyProductLifecycleDecision(executor, {
        eventId: this.#bytes32(), product, decision: transition.event,
        from: product.lifecycle_state, to: transition.to, reasonCode: input.reasonCode,
        snapshotHash: requestHash, wallet, idempotencyKey: input.idempotencyKey, now,
      });
      return productProjection(executor, await requireProduct(executor, productId), actor);
    });
  }

  delistProduct(actor: FulfillmentActor, productId: string, input: {
    reasonCode: string;
    idempotencyKey: string;
  }) {
    if (actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR')) {
      return this.decideReview(actor, productId, { decision: 'DELIST', ...input });
    }
    validateReasonCode(input.reasonCode);
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    return this.#transactions.transaction(async (executor) => {
      const product = await authorizeProduct(executor, actor, productId, true);
      await assertProductWriteUnlocked(executor, product, this.#clock());
      const requestHash = hashJson({ actor: wallet, productId, ...input });
      const duplicate = await executor.query<{ snapshot_hash: string }>(
        'SELECT snapshot_hash FROM core.product_review_events WHERE actor_wallet = $1 AND idempotency_key = $2',
        [wallet, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].snapshot_hash !== requestHash) throw idempotencyConflict('Product delist');
        return productProjection(executor, await requireProduct(executor, productId), actor);
      }
      const now = this.#clock();
      await executor.query(
        "UPDATE core.products SET lifecycle_state = 'DELISTED', updated_at = $2 WHERE product_id = $1",
        [productId, now],
      );
      await executor.query(
        "UPDATE core.skus SET lifecycle_state = 'DELISTED' WHERE product_id = $1 AND lifecycle_state <> 'DELISTED'",
        [productId],
      );
      await insertReviewEvent(executor, {
        eventId: this.#bytes32(), product, decision: 'DELISTED',
        from: product.lifecycle_state, to: 'DELISTED', reasonCode: input.reasonCode,
        snapshotHash: requestHash, wallet, idempotencyKey: input.idempotencyKey, now,
      });
      return productProjection(executor, await requireProduct(executor, productId), actor);
    });
  }

  adjustInventory(actor: FulfillmentActor, skuId: string, input: {
    delta: string;
    reasonCode: string;
    idempotencyKey: string;
  }) {
    validateResourceId(skuId, 'skuId');
    const delta = signedInteger(input.delta, 'delta');
    if (delta === 0n) throw new CoreError('InvalidRequest', 'Inventory delta cannot be zero');
    validateReasonCode(input.reasonCode);
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    const requestHash = hashJson({
      actor: wallet,
      skuId,
      delta: delta.toString(),
      reasonCode: input.reasonCode,
      idempotencyKey: input.idempotencyKey,
    });
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformRole(executor, actor, false);
      const duplicate = await executor.query<{ adjustment_id: string }>(
        `SELECT adjustment_id FROM core.catalog_inventory_adjustments
         WHERE actor_wallet = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        const existing = await loadInventoryAdjustment(executor, duplicate.rows[0].adjustment_id);
        if (existing.requestHash !== requestHash) throw idempotencyConflict('Inventory adjustment');
        return existing.projection;
      }
      const result = await executor.query<SkuRow>('SELECT * FROM core.skus WHERE sku_id = $1 FOR UPDATE', [skuId]);
      const sku = result.rows[0];
      if (!sku) throw new CoreError('InvalidRequest', 'SKU not found', 404);
      const product = await requireProduct(executor, sku.product_id, true);
      if (
        !['DRAFT', 'ACTIVE', 'SOLD_OUT'].includes(product.lifecycle_state)
        || sku.lifecycle_state === 'DELISTED'
      ) {
        throw productLock('PRODUCT_STATE', product.product_id, product.lifecycle_state);
      }
      await assertNoLiveSession(executor, product.product_id);
      const reservation = await executor.query<{ reservation_id: string }>(
        `SELECT reservation_id FROM core.inventory_reservations
         WHERE sku_id = $1 AND state = 'ACTIVE' AND expires_at > $2 LIMIT 1`,
        [skuId, this.#clock()],
      );
      if (reservation.rows[0]) throw productLock('RESERVATION', reservation.rows[0].reservation_id, 'ACTIVE');
      const liability = await lockedLiabilityForProduct(executor, product.product_id);
      if (liability) throw productLock('ORDER', liability.order_id, liability.balance_state);
      const beforeTotal = BigInt(sku.stock_total);
      const beforeAvailable = BigInt(sku.stock_available);
      const afterTotal = beforeTotal + delta;
      const afterAvailable = beforeAvailable + delta;
      if (afterTotal < BigInt(sku.stock_reserved) || afterAvailable < 0n) {
        throw new CoreError('InventoryUnavailable', 'Inventory adjustment would make stock negative', 409);
      }
      const adjustmentId = this.#bytes32().toLowerCase();
      const now = this.#clock();
      await executor.query(
        `UPDATE core.skus SET stock_total = $2, stock_available = $3, sku_version = sku_version + 1
         WHERE sku_id = $1`,
        [skuId, afterTotal.toString(), afterAvailable.toString()],
      );
      await executor.query(
        `INSERT INTO core.catalog_inventory_adjustments (
           adjustment_id, sku_id, before_total, before_available, delta,
           after_total, after_available, reason_code, actor_wallet,
           idempotency_key, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [adjustmentId, skuId, beforeTotal.toString(), beforeAvailable.toString(), delta.toString(),
          afterTotal.toString(), afterAvailable.toString(), input.reasonCode, wallet,
          input.idempotencyKey, now],
      );
      await executor.query(
        `INSERT INTO core.catalog_commands (
           actor_wallet, command_scope, idempotency_key, request_hash, resource_id, created_at
         ) VALUES ($1,'ADJUST_INVENTORY',$2,$3,$4,$5)`,
        [wallet, input.idempotencyKey, requestHash, adjustmentId, now],
      );
      return (await loadInventoryAdjustment(executor, adjustmentId)).projection;
    });
  }

  listAdminProducts(actor: FulfillmentActor) {
    return this.#transactions.transaction(async (executor) => {
      await requirePlatformRole(executor, actor, true);
      const products = await executor.query<ProductRow>('SELECT * FROM core.products ORDER BY created_at DESC, product_id');
      return Promise.all(products.rows.map((product) => productProjection(executor, product, actor)));
    });
  }

  batchAddProductTags(actor: FulfillmentActor, input: {
    productIds: string[];
    tagIds: string[];
    idempotencyKey: string;
  }) {
    if (!Array.isArray(input.productIds) || input.productIds.length < 1 || input.productIds.length > 100) {
      throw new CoreError('InvalidRequest', 'Product batch tagging requires 1-100 products');
    }
    if (!Array.isArray(input.tagIds) || input.tagIds.length < 1 || input.tagIds.length > 20) {
      throw new CoreError('InvalidRequest', 'Product batch tagging requires 1-20 tags');
    }
    input.productIds.forEach((productId) => validateResourceId(productId, 'productId'));
    input.tagIds.forEach((tagId) => validateResourceId(tagId, 'tagId'));
    if (new Set(input.productIds).size !== input.productIds.length || new Set(input.tagIds).size !== input.tagIds.length) {
      throw new CoreError('InvalidRequest', 'Product batch tagging contains duplicate resources');
    }
    validateIdempotencyKey(input.idempotencyKey);
    const wallet = actorWallet(actor);
    const value = {
      productIds: [...input.productIds].sort(),
      tagIds: [...input.tagIds].sort(),
      idempotencyKey: input.idempotencyKey,
    };
    const requestHash = hashJson({ actor: wallet, ...value });
    return this.#transactions.transaction(async (executor) => {
      const role = await requirePlatformRole(executor, actor, false);
      const existing = await executor.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash, result FROM core.admin_batch_operations
         WHERE actor_wallet = $1 AND operation_type = 'BATCH_ADD_PRODUCT_TAGS'
           AND idempotency_key = $2`,
        [wallet, value.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Product batch tagging');
        return existing.rows[0].result;
      }
      for (const tagId of value.tagIds) {
        const tag = await loadTagRow(executor, tagId, true);
        if (!tag || tag.status !== 'ENABLED') throw new CoreError('InvalidRequest', 'Batch tag is unavailable', 409, { tagId });
      }
      const now = this.#clock();
      const productResults = [];
      for (const productId of value.productIds) {
        const product = await requireProduct(executor, productId, true);
        await assertProductWriteUnlocked(executor, product, now);
        const currentTags = await executor.query<{ tag_id: string }>(
          `SELECT tag_id FROM core.product_tag_assignments
           WHERE product_id = $1 AND product_version = $2 ORDER BY tag_id`,
          [productId, product.version],
        );
        const before = currentTags.rows.map((row) => row.tag_id);
        const after = [...new Set([...before, ...value.tagIds])].sort();
        const added = after.filter((tagId) => !before.includes(tagId));
        const previousVersion = Number(product.version);
        if (added.length > 0) {
          const nextVersion = previousVersion + 1;
          const metadata = object(product.metadata);
          await executor.query(
            'UPDATE core.products SET version = $2, metadata = $3, updated_at = $4 WHERE product_id = $1',
            [productId, nextVersion, JSON.stringify({ ...metadata, tagIds: after }), now],
          );
          await executor.query(
            `INSERT INTO core.product_category_assignments (
               product_id, product_version, category_id, assigned_by, assigned_at
             ) SELECT product_id, $2, category_id, $3, $4
               FROM core.product_category_assignments
              WHERE product_id = $1 AND product_version = $5`,
            [productId, nextVersion, wallet, now, previousVersion],
          );
          for (const tagId of after) {
            await executor.query(
              `INSERT INTO core.product_tag_assignments (
                 product_id, product_version, tag_id, assigned_by, assigned_at
               ) VALUES ($1,$2,$3,$4,$5)`,
              [productId, nextVersion, tagId, wallet, now],
            );
          }
          productResults.push({ productId, previousVersion: String(previousVersion), version: String(nextVersion), addedTagIds: added });
        } else {
          productResults.push({ productId, previousVersion: String(previousVersion), version: String(previousVersion), addedTagIds: [] });
        }
      }
      const operationId = this.#bytes32().toLowerCase();
      const result = Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        operationId,
        action: 'ADD_PRODUCT_TAGS' as const,
        tagIds: value.tagIds,
        changedCount: productResults.filter((item) => item.addedTagIds.length > 0).length,
        products: productResults,
        createdAt: now.toISOString(),
      });
      await executor.query(
        `INSERT INTO core.admin_batch_operations (
           operation_id, operation_type, actor_wallet, actor_role, idempotency_key,
           request_hash, result, created_at
         ) VALUES ($1,'BATCH_ADD_PRODUCT_TAGS',$2,$3,$4,$5,$6,$7)`,
        [operationId, wallet, role, value.idempotencyKey, requestHash, JSON.stringify(result), now],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('catalog-batch-tags', { operationId, requestHash }),
        streamName: 'operational',
        evidenceProfile: 'RBAC',
        eventType: 'CatalogProductsBatchTagged',
        resourceType: 'ADMIN_BATCH_OPERATION',
        resourceId: operationId,
        actorWallet: wallet,
        actorRole: role,
        correlationId: `catalog-batch-tags:${operationId}`,
        requestHash: requestHash.slice(2),
        payload: { productIds: value.productIds, tagIds: value.tagIds, changedCount: result.changedCount },
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles: [role],
          evidenceHash: hashJson({ subject: wallet, role, checkedAt: now.toISOString() }),
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return result;
    });
  }

  batchProductLifecycle(actor: FulfillmentActor, input: CatalogProductLifecycleBatchInput) {
    const value = validateProductLifecycleBatchInput(input);
    const wallet = actorWallet(actor);
    const requestHash = hashJson({ actor: wallet, ...value });
    return this.#transactions.transaction(async (executor) => {
      const role = await requirePlatformRole(executor, actor, false);
      const existing = await executor.query<{ request_hash: string; result: Record<string, unknown> }>(
        `SELECT request_hash, result FROM core.admin_batch_operations
         WHERE actor_wallet = $1 AND operation_type = 'BATCH_PRODUCT_LIFECYCLE'
           AND idempotency_key = $2`,
        [wallet, value.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw idempotencyConflict('Product lifecycle batch');
        return existing.rows[0].result;
      }

      const products: ProductRow[] = [];
      for (const productId of value.productIds) products.push(await requireProduct(executor, productId, true));
      const now = this.#clock();
      const prepared = [];
      for (const product of products) {
        prepared.push({
          product,
          transition: await prepareProductLifecycleDecision(
            executor,
            product,
            value.action,
            now,
            this.#mainnetMicrotestEntitlement,
          ),
        });
      }

      const operationId = this.#bytes32().toLowerCase();
      for (const item of prepared) {
        const eventSeed = { operationId, productId: item.product.product_id };
        await applyProductLifecycleDecision(executor, {
          eventId: hashJson({ ...eventSeed, kind: 'PRODUCT_REVIEW_EVENT' }),
          product: item.product,
          decision: item.transition.event,
          from: item.product.lifecycle_state,
          to: item.transition.to,
          reasonCode: value.reasonCode,
          snapshotHash: hashJson({ requestHash, productId: item.product.product_id }),
          wallet,
          idempotencyKey: `batch:${hashJson(eventSeed).slice(2)}`,
          now,
        });
      }
      const result = Object.freeze({
        artifactVersion: CORE_ARTIFACT_VERSION,
        operationId,
        action: value.action,
        changedCount: prepared.length,
        products: prepared.map((item) => ({
          productId: item.product.product_id,
          previousState: item.product.lifecycle_state,
          state: item.transition.to,
        })),
        createdAt: now.toISOString(),
      });
      await executor.query(
        `INSERT INTO core.admin_batch_operations (
           operation_id, operation_type, actor_wallet, actor_role, idempotency_key,
           request_hash, result, created_at
         ) VALUES ($1,'BATCH_PRODUCT_LIFECYCLE',$2,$3,$4,$5,$6,$7)`,
        [operationId, wallet, role, value.idempotencyKey, requestHash, JSON.stringify(result), now],
      );
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('catalog-product-lifecycle-batch', { operationId, requestHash }),
        streamName: 'operational',
        evidenceProfile: 'RBAC',
        eventType: 'CatalogProductsLifecycleBatchApplied',
        resourceType: 'ADMIN_BATCH_OPERATION',
        resourceId: operationId,
        actorWallet: wallet,
        actorRole: role,
        correlationId: `catalog-product-lifecycle-batch:${operationId}`,
        requestHash: requestHash.slice(2),
        payload: {
          action: value.action,
          productIds: value.productIds,
          reasonCode: value.reasonCode,
          changedCount: result.changedCount,
        },
        authorizationEvidence: {
          scheme: 'RBAC_ROLE_REVALIDATION',
          subject: wallet,
          roles: [role],
          evidenceHash: hashJson({ subject: wallet, role, checkedAt: now.toISOString() }),
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return result;
    });
  }
}

async function authorizeStore(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  storeId: string,
  targetMerchantId?: string,
  write = false,
) {
  const result = await executor.query<{ merchant_id: string; status: string }>(
    `SELECT merchant_id, status FROM core.merchant_stores WHERE store_id = $1${write ? ' FOR UPDATE' : ''}`,
    [storeId],
  );
  const store = result.rows[0];
  if (!store) throw new CoreError('InvalidRequest', 'Store not found', 404);
  if (write && store.status !== 'ACTIVE') throw new CoreError('Forbidden', 'Store is not active', 409);
  if (actor.roles.includes('MERCHANT')) {
    await requireMerchantRole(executor, actor);
    if (actor.merchantId !== store.merchant_id || targetMerchantId) {
      throw new CoreError('Forbidden', 'Store is outside the merchant scope', 403);
    }
    return { merchantId: store.merchant_id, role: 'MERCHANT' as const };
  }
  const role = await requirePlatformRole(executor, actor, !write);
  if (targetMerchantId && targetMerchantId !== store.merchant_id) {
    throw new CoreError('InvalidRequest', 'Store does not belong to the target merchant', 409);
  }
  return { merchantId: store.merchant_id, role };
}

async function authorizeProduct(
  executor: SqlExecutor,
  actor: FulfillmentActor,
  productId: string,
  write: boolean,
) {
  const product = await requireProduct(executor, productId, write);
  if (actor.roles.includes('MERCHANT')) {
    await requireMerchantRole(executor, actor);
    if (actor.merchantId !== product.merchant_id) throw new CoreError('Forbidden', 'Product is outside the merchant scope', 403);
    return product;
  }
  await requirePlatformRole(executor, actor, !write);
  return product;
}

async function requireMerchantRole(executor: SqlExecutor, actor: FulfillmentActor) {
  if (!actor.roles.includes('MERCHANT') || !actor.merchantId) throw new CoreError('Forbidden', 'Merchant role is required', 403);
  const wallet = actorWallet(actor);
  const result = await executor.query<{ merchant_id: string | null }>(
    `SELECT merchant_id FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND role = 'MERCHANT' AND status = 'ACTIVE'`,
    [wallet],
  );
  if (result.rows[0]?.merchant_id !== actor.merchantId) throw new CoreError('Forbidden', 'Merchant binding is not active', 403);
}

async function requirePlatformRole(executor: SqlExecutor, actor: FulfillmentActor, readOnly: boolean): Promise<CatalogRole> {
  const allowed = readOnly ? ['ADMIN', 'OPERATOR', 'AUDITOR'] : ['ADMIN', 'OPERATOR'];
  const sessionRole = allowed.find((role) => actor.roles.includes(role as CatalogRole));
  if (!sessionRole) throw new CoreError('Forbidden', `${readOnly ? 'Catalog read' : 'Catalog write'} role is required`, 403);
  const result = await executor.query<{ role: CatalogRole }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE wallet_address = $1 AND status = 'ACTIVE'
       AND role IN (${allowed.map((_, index) => `$${index + 2}`).join(',')})
     ORDER BY CASE role WHEN 'ADMIN' THEN 1 WHEN 'OPERATOR' THEN 2 ELSE 3 END
     LIMIT 1`,
    [actorWallet(actor), ...allowed],
  );
  if (!result.rows[0] || !actor.roles.includes(result.rows[0].role)) {
    throw new CoreError('Forbidden', 'Catalog role binding is not active', 403);
  }
  return result.rows[0].role;
}

async function assertProductWriteUnlocked(
  executor: SqlExecutor,
  product: ProductRow,
  now: Date,
  allowReviewState = false,
) {
  if (
    ['REVIEW', 'SCHEDULED', 'LOCKED'].includes(product.lifecycle_state)
    && !(allowReviewState && ['REVIEW', 'SCHEDULED'].includes(product.lifecycle_state))
  ) throw productLock('PRODUCT_STATE', product.product_id, product.lifecycle_state);
  await assertNoLiveSession(executor, product.product_id);
  const reservation = await executor.query<{ reservation_id: string }>(
    `SELECT reservation.reservation_id
     FROM core.inventory_reservations reservation
     JOIN core.skus sku ON sku.sku_id = reservation.sku_id
     WHERE sku.product_id = $1 AND reservation.state = 'ACTIVE' AND reservation.expires_at > $2
     ORDER BY reservation.created_at LIMIT 1`,
    [product.product_id, now],
  );
  if (reservation.rows[0]) throw productLock('RESERVATION', reservation.rows[0].reservation_id, 'ACTIVE');
  const liability = await lockedLiabilityForProduct(executor, product.product_id);
  if (liability) throw productLock('ORDER', liability.order_id, liability.balance_state);
}

async function assertNoLiveSession(executor: SqlExecutor, productId: string) {
  const session = await executor.query<{ session_id: string; phase: string }>(
    `SELECT session_id, phase FROM core.seckill_sessions
     WHERE product_id = $1 AND phase IN ('PREHEAT','LIVE','SETTLING')
     ORDER BY created_at LIMIT 1`,
    [productId],
  );
  if (session.rows[0]) throw productLock('SECKILL_SESSION', session.rows[0].session_id, session.rows[0].phase);
}

async function lockedLiabilityForProduct(executor: SqlExecutor, productId: string) {
  const result = await executor.query<{ order_id: string; balance_state: string }>(
    `SELECT journal.order_id, line.balance_state
     FROM core.ledger_journals journal
     JOIN core.orders orders ON orders.order_id = journal.order_id
     JOIN core.ledger_lines line ON line.journal_id = journal.journal_id
     WHERE orders.product_id = $1 AND line.balance_state IN ('LOCKED','DISPUTED')
     GROUP BY journal.order_id, line.balance_state
     HAVING sum(CASE WHEN line.side = 'CREDIT' THEN line.amount ELSE -line.amount END) > 0
     ORDER BY journal.order_id LIMIT 1`,
    [productId],
  );
  return result.rows[0];
}

async function assertTaxonomyCanDisable(executor: SqlExecutor, type: 'CATEGORY' | 'TAG', resourceIdValue: string) {
  const assignmentTable = type === 'CATEGORY' ? 'product_category_assignments' : 'product_tag_assignments';
  const identityColumn = type === 'CATEGORY' ? 'category_id' : 'tag_id';
  const session = await executor.query<{ session_id: string; product_id: string }>(
    `SELECT session.session_id, product.product_id
     FROM core.${assignmentTable} assignment
     JOIN core.products product ON product.product_id = assignment.product_id
       AND product.version = assignment.product_version
     JOIN core.seckill_sessions session ON session.product_id = product.product_id
     WHERE assignment.${identityColumn} = $1
     ORDER BY session.created_at LIMIT 1`,
    [resourceIdValue],
  );
  if (session.rows[0]) {
    throw new CoreError('ProductWriteLocked', `${type.toLowerCase()} contains a seckill product`, 409, {
      blockingResource: { type: 'SECKILL_SESSION', id: session.rows[0].session_id, productId: session.rows[0].product_id },
    });
  }
  const products = await executor.query<{ product_id: string }>(
    `SELECT product.product_id
     FROM core.${assignmentTable} assignment
     JOIN core.products product ON product.product_id = assignment.product_id
       AND product.version = assignment.product_version
     WHERE assignment.${identityColumn} = $1`,
    [resourceIdValue],
  );
  for (const product of products.rows) {
    const liability = await lockedLiabilityForProduct(executor, product.product_id);
    if (liability) {
      throw new CoreError('ProductWriteLocked', `${type.toLowerCase()} contains Locked funds`, 409, {
        blockingResource: { type: 'ORDER', id: liability.order_id, state: liability.balance_state, productId: product.product_id },
      });
    }
  }
}

async function assertCategoryMoveSafe(
  executor: SqlExecutor,
  categoryId: string,
  parentCategoryId: string | undefined,
) {
  const children = await executor.query<{ category_id: string }>(
    `SELECT child.category_id
     FROM core.catalog_categories identity
     JOIN core.catalog_category_versions child
       ON child.category_id = identity.category_id AND child.version = identity.current_version
     WHERE child.parent_category_id = $1 AND child.status <> 'DELETED'
     LIMIT 1`,
    [categoryId],
  );
  if (children.rows[0]) {
    throw new CoreError('ProductWriteLocked', 'Category with children cannot be moved', 409, {
      blockingResource: { type: 'CATEGORY', id: children.rows[0].category_id, state: 'CHILD' },
    });
  }
  if (!parentCategoryId) return;
  const cycle = await executor.query<{ category_id: string }>(
    `WITH RECURSIVE descendants(category_id) AS (
       SELECT child.category_id
       FROM core.catalog_categories identity
       JOIN core.catalog_category_versions child
         ON child.category_id = identity.category_id AND child.version = identity.current_version
       WHERE child.parent_category_id = $1 AND child.status <> 'DELETED'
       UNION ALL
       SELECT child.category_id
       FROM descendants parent
       JOIN core.catalog_category_versions parent_version
         ON parent_version.category_id = parent.category_id
       JOIN core.catalog_categories parent_identity
         ON parent_identity.category_id = parent_version.category_id
        AND parent_identity.current_version = parent_version.version
       JOIN core.catalog_category_versions child ON child.parent_category_id = parent.category_id
       JOIN core.catalog_categories child_identity
         ON child_identity.category_id = child.category_id
        AND child_identity.current_version = child.version
       WHERE child.status <> 'DELETED'
     )
     SELECT category_id FROM descendants WHERE category_id = $2 LIMIT 1`,
    [categoryId, parentCategoryId],
  );
  if (cycle.rows[0]) throw new CoreError('InvalidRequest', 'Category parent would create a cycle', 409);
}

async function assertProductReadyForReview(
  executor: SqlExecutor,
  product: ProductRow,
  wallet: string,
  previewId: string,
  now: Date,
) {
  const images = stringArray(product.main_image_asset_ids);
  if (images.length < 1 || images.length > 5) throw new CoreError('InvalidRequest', 'Product requires 1-5 verified main images', 409);
  await verifyProductMedia(executor, wallet, product.product_id, images, product.video_asset_id ?? undefined);
  const skus = await loadSkus(executor, product.product_id);
  if (skus.length === 0 || skus.some((sku) => BigInt(sku.proposed_seckill_inventory) <= 0n)) {
    throw new CoreError('InvalidRequest', 'Product requires valid SKU and seckill inventory', 409);
  }
  const preview = await executor.query<PreviewRow>(
    `SELECT * FROM core.merchant_concession_previews
     WHERE preview_id = $1 AND product_id = $2 AND created_by = $3`,
    [previewId.toLowerCase(), product.product_id, wallet],
  );
  const row = preview.rows[0];
  if (!row || new Date(row.expires_at) <= now) throw new CoreError('QuoteExpired', 'Concession preview is unavailable or expired', 409);
  const policy = await latestPaymentPolicy(executor, now);
  if (
    Number(row.policy_version) !== Number(policy.row.policy_version)
    || row.catalog_fingerprint !== catalogFingerprint(product, skus)
    || row.concession_bps !== product.merchant_concession_bps
  ) throw new CoreError('ArtifactVersionMismatch', 'Concession preview no longer matches the product or policy', 409);
}

async function assertSubmittedPreviewCurrent(executor: SqlExecutor, product: ProductRow, now: Date) {
  if (!product.submission_preview_id) {
    throw new CoreError('InvalidRequest', 'Product has no submitted concession preview', 409);
  }
  const result = await executor.query<PreviewRow>(
    `SELECT * FROM core.merchant_concession_previews
     WHERE preview_id = $1 AND product_id = $2`,
    [product.submission_preview_id, product.product_id],
  );
  const preview = result.rows[0];
  if (!preview) throw new CoreError('InvalidRequest', 'Submitted concession preview is unavailable', 409);
  const policy = await latestPaymentPolicy(executor, now);
  const skus = await loadSkus(executor, product.product_id);
  if (
    Number(preview.policy_version) !== Number(policy.row.policy_version)
    || preview.catalog_fingerprint !== catalogFingerprint(product, skus)
    || preview.concession_bps !== product.merchant_concession_bps
  ) throw new CoreError('ArtifactVersionMismatch', 'Submitted concession preview no longer matches the catalog or policy', 409);
}

async function latestPaymentPolicy(executor: SqlExecutor, now: Date) {
  const result = await executor.query<{
    policy_version: string | number;
    payload: unknown;
  }>(
    `SELECT policy_version, payload
     FROM core.canonical_policy_publications
     WHERE publication_status = 'PUBLISHED' AND (effective_from IS NULL OR effective_from <= $1)
     ORDER BY policy_version DESC LIMIT 1`,
    [now],
  );
  const row = result.rows[0];
  if (!row) throw new CoreError('DecisionBlocked', 'No canonical policy is available for concession preview', 409);
  return { row, policy: parsePaymentPolicySnapshot(Number(row.policy_version), row.payload) };
}

async function insertProduct(executor: SqlExecutor, input: {
  productId: string;
  chainProductId: string;
  merchantId: string;
  storeId: string;
  supersedesProductId: string | null;
  version: number;
  value: ReturnType<typeof validateProductSlotInput>;
  now: Date;
}) {
  await executor.query(
    `INSERT INTO core.products (
       product_id, chain_product_id, merchant_id, store_id, supersedes_product_id,
       version, title, subtitle, lifecycle_state, product_policy_hash,
       merchant_concession_bps, metadata, main_image_asset_ids, video_asset_id,
       rich_detail, default_freight_usdt, fulfillment_modes, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
    [
      input.productId,
      input.chainProductId.toLowerCase(),
      input.merchantId,
      input.storeId,
      input.supersedesProductId,
      input.version,
      input.value.title,
      input.value.subtitle,
      hashJson({ pending: input.productId }),
      input.value.merchantConcessionBps,
      JSON.stringify({ categoryId: input.value.categoryId ?? null, tagIds: input.value.tagIds }),
      JSON.stringify(input.value.mainImageAssetIds),
      input.value.videoAssetId ?? null,
      JSON.stringify(input.value.richDetail),
      input.value.defaultFreightUsdt,
      JSON.stringify(input.value.fulfillmentModes),
      input.now,
    ],
  );
}

async function updateProduct(
  executor: SqlExecutor,
  productId: string,
  version: number,
  value: ReturnType<typeof validateProductSlotInput>,
  now: Date,
) {
  await executor.query(
    `UPDATE core.products SET version = $2, title = $3, subtitle = $4,
       lifecycle_state = 'DRAFT', merchant_concession_bps = $5, metadata = $6,
       main_image_asset_ids = $7, video_asset_id = $8, rich_detail = $9,
       default_freight_usdt = $10, fulfillment_modes = $11,
       submission_hash = NULL, submission_preview_id = NULL, updated_at = $12
     WHERE product_id = $1`,
    [productId, version, value.title, value.subtitle, value.merchantConcessionBps,
      JSON.stringify({ categoryId: value.categoryId ?? null, tagIds: value.tagIds }),
      JSON.stringify(value.mainImageAssetIds), value.videoAssetId ?? null,
      JSON.stringify(value.richDetail), value.defaultFreightUsdt,
      JSON.stringify(value.fulfillmentModes), now],
  );
}

async function upsertProductSkus(
  executor: SqlExecutor,
  productId: string,
  inputs: ReturnType<typeof validateProductSlotInput>['skus'],
  now: Date,
) {
  const existing = await loadSkus(executor, productId);
  const byId = new Map(existing.map((sku) => [sku.sku_id, sku]));
  const retained = new Set<string>();
  for (const input of inputs) {
    const skuId = input.skuId ?? resourceId('sku', `0x${randomBytes(32).toString('hex')}`);
    const current = byId.get(skuId);
    const merchantBaseReceivableUsdt = postFeeMerchantBase(input.listPriceUsdt).toString();
    if (input.skuId && !current) throw new CoreError('Forbidden', 'SKU is outside the product scope', 403);
    retained.add(skuId);
    if (current) {
      if (BigInt(current.stock_reserved) !== 0n) throw productLock('SKU_RESERVATION', skuId, 'ACTIVE');
      await executor.query(
        `UPDATE core.skus SET sku_version = sku_version + 1, attributes = $2,
           list_price_usdt = $3, merchant_cost_usdt = $4, stock_total = $5,
           stock_available = $5, lifecycle_state = 'DRAFT',
           proposed_seckill_inventory = $6
         WHERE sku_id = $1`,
        [skuId, JSON.stringify(input.attributes), input.listPriceUsdt,
          merchantBaseReceivableUsdt, input.stockTotal, input.proposedSeckillInventory],
      );
    } else {
      await executor.query(
        `INSERT INTO core.skus (
           sku_id, chain_sku_id, product_id, sku_version, attributes,
           list_price_usdt, merchant_cost_usdt, stock_total, stock_available,
           lifecycle_state, proposed_seckill_inventory
         ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$7,'DRAFT',$8)`,
        [skuId, `0x${randomBytes(32).toString('hex')}`, productId, JSON.stringify(input.attributes),
          input.listPriceUsdt, merchantBaseReceivableUsdt, input.stockTotal,
          input.proposedSeckillInventory],
      );
    }
  }
  for (const sku of existing) {
    if (!retained.has(sku.sku_id) && sku.lifecycle_state !== 'DELISTED') {
      if (BigInt(sku.stock_reserved) !== 0n) throw productLock('SKU_RESERVATION', sku.sku_id, 'ACTIVE');
      await executor.query("UPDATE core.skus SET lifecycle_state = 'DELISTED' WHERE sku_id = $1", [sku.sku_id]);
    }
  }
  void now;
}

async function insertAssignments(
  executor: SqlExecutor,
  productId: string,
  productVersion: number,
  categoryId: string | undefined,
  tagIds: string[],
  wallet: string,
  now: Date,
) {
  if (categoryId) {
    const category = await loadCategoryRow(executor, categoryId, true);
    if (!category || category.status !== 'ENABLED') throw new CoreError('InvalidRequest', 'Category is unavailable', 409);
    await executor.query(
      `INSERT INTO core.product_category_assignments (
         product_id, product_version, category_id, assigned_by, assigned_at
       ) VALUES ($1,$2,$3,$4,$5)`,
      [productId, productVersion, categoryId, wallet, now],
    );
  }
  for (const tagId of tagIds) {
    const tag = await loadTagRow(executor, tagId, true);
    if (!tag || tag.status !== 'ENABLED') throw new CoreError('InvalidRequest', 'Tag is unavailable', 409);
    await executor.query(
      `INSERT INTO core.product_tag_assignments (
         product_id, product_version, tag_id, assigned_by, assigned_at
       ) VALUES ($1,$2,$3,$4,$5)`,
      [productId, productVersion, tagId, wallet, now],
    );
  }
}

async function productPolicyHash(executor: SqlExecutor, productId: string, version: number) {
  const product = await requireProduct(executor, productId);
  const skus = await loadSkus(executor, productId);
  return hashJson({
    productId,
    version,
    title: product.title,
    subtitle: product.subtitle,
    concessionBps: product.merchant_concession_bps,
    fulfillmentModes: product.fulfillment_modes,
    skus: skus.filter((sku) => sku.lifecycle_state !== 'DELISTED').map((sku) => ({
      skuId: sku.sku_id,
      version: Number(sku.sku_version),
      listPriceUsdt: sku.list_price_usdt,
      merchantBaseReceivableUsdt: postFeeMerchantBase(sku.list_price_usdt).toString(),
    })),
  });
}

async function verifyProductMedia(
  executor: SqlExecutor,
  wallet: string,
  productId: string,
  imageAssetIds: string[],
  videoAssetId?: string,
) {
  if (imageAssetIds.length > 0) {
    const placeholders = imageAssetIds.map((_, index) => `$${index + 3}`).join(',');
    const result = await executor.query<{ asset_id: string }>(
      `SELECT asset_id FROM core.media_assets
       WHERE owner_wallet = $1 AND resource_type = 'PRODUCT' AND resource_id = $2
         AND purpose = 'PRODUCT_IMAGE' AND asset_id IN (${placeholders})`,
      [wallet, productId, ...imageAssetIds],
    );
    if (result.rows.length !== imageAssetIds.length) throw new CoreError('Forbidden', 'Product image is unverified or outside the product', 403);
  }
  if (videoAssetId) {
    const result = await executor.query<{ asset_id: string }>(
      `SELECT asset_id FROM core.media_assets
       WHERE owner_wallet = $1 AND resource_type = 'PRODUCT' AND resource_id = $2
         AND purpose = 'PRODUCT_VIDEO' AND asset_id = $3`,
      [wallet, productId, videoAssetId],
    );
    if (!result.rows[0]) throw new CoreError('Forbidden', 'Product video is unverified or outside the product', 403);
  }
}

async function productHasHistory(executor: SqlExecutor, productId: string) {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM core.orders WHERE product_id = $1
       UNION ALL SELECT 1 FROM core.seckill_sessions WHERE product_id = $1
     ) AS exists`,
    [productId],
  );
  return result.rows[0]?.exists === true;
}

async function loadCurrentStoreProduct(executor: SqlExecutor, storeId: string, lock = false) {
  const result = await executor.query<ProductRow>(
    `SELECT * FROM core.products
     WHERE store_id = $1 AND lifecycle_state NOT IN ('HIDDEN','DELISTED')
     ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [storeId],
  );
  return result.rows[0];
}

async function loadLatestHistoricalStoreProduct(executor: SqlExecutor, storeId: string) {
  const result = await executor.query<ProductRow>(
    `SELECT product.* FROM core.products product
     WHERE product.store_id = $1 AND product.lifecycle_state IN ('HIDDEN','DELISTED')
       AND EXISTS (
         SELECT 1 FROM core.orders WHERE product_id = product.product_id
         UNION ALL
         SELECT 1 FROM core.seckill_sessions WHERE product_id = product.product_id
       )
     ORDER BY product.updated_at DESC, product.created_at DESC, product.product_id DESC
     LIMIT 1`,
    [storeId],
  );
  return result.rows[0];
}

async function requireProduct(executor: SqlExecutor, productId: string, lock = false) {
  const result = await executor.query<ProductRow>(
    `SELECT * FROM core.products WHERE product_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [productId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Product not found', 404);
  return result.rows[0];
}

async function loadSkus(executor: SqlExecutor, productId: string) {
  const result = await executor.query<SkuRow>(
    `SELECT sku_id, chain_sku_id, product_id, sku_version, attributes,
       list_price_usdt::text, merchant_cost_usdt::text, stock_total,
       stock_available, stock_reserved, lifecycle_state, proposed_seckill_inventory
     FROM core.skus WHERE product_id = $1 ORDER BY sku_id`,
    [productId],
  );
  return result.rows;
}

async function productProjection(executor: SqlExecutor, product: ProductRow, actor: FulfillmentActor) {
  const skus = await loadSkus(executor, product.product_id);
  const category = await executor.query<{ category_id: string }>(
    `SELECT category_id FROM core.product_category_assignments
     WHERE product_id = $1 AND product_version = $2`,
    [product.product_id, product.version],
  );
  const tags = await executor.query<{ tag_id: string }>(
    `SELECT tag_id FROM core.product_tag_assignments
     WHERE product_id = $1 AND product_version = $2 ORDER BY tag_id`,
    [product.product_id, product.version],
  );
  const writeLock = await productWriteLock(executor, product, new Date());
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    productId: product.product_id,
    chainProductId: product.chain_product_id,
    merchantId: product.merchant_id,
    storeId: product.store_id,
    supersedesProductId: product.supersedes_product_id,
    version: String(product.version),
    title: product.title,
    subtitle: product.subtitle,
    lifecycleState: product.lifecycle_state,
    productPolicyHash: product.product_policy_hash,
    merchantConcessionBps: product.merchant_concession_bps,
    mainImageAssetIds: stringArray(product.main_image_asset_ids),
    videoAssetId: product.video_asset_id,
    richDetail: object(product.rich_detail),
    defaultFreightUsdt: product.default_freight_usdt,
    fulfillmentModes: stringArray(product.fulfillment_modes),
    categoryId: category.rows[0]?.category_id ?? null,
    tagIds: tags.rows.map((tag) => tag.tag_id),
    skus: skus.map((sku) => ({
      skuId: sku.sku_id,
      chainSkuId: sku.chain_sku_id,
      version: String(sku.sku_version),
      attributes: object(sku.attributes),
      listPriceUsdt: sku.list_price_usdt,
      merchantBaseReceivableUsdt: postFeeMerchantBase(sku.list_price_usdt).toString(),
      stockTotal: String(sku.stock_total),
      stockAvailable: String(sku.stock_available),
      stockReserved: String(sku.stock_reserved),
      proposedSeckillInventory: String(sku.proposed_seckill_inventory),
      lifecycleState: sku.lifecycle_state,
    })),
    allowedActions: allowedProductActions(product, actor, writeLock),
    writeLock,
    createdAt: new Date(product.created_at).toISOString(),
    updatedAt: new Date(product.updated_at).toISOString(),
  };
}

export interface ProductWriteLockSubject {
  product_id: string;
  lifecycle_state: string;
}

export async function productWriteLock(executor: SqlExecutor, product: ProductWriteLockSubject, now: Date) {
  if (['REVIEW', 'SCHEDULED', 'LOCKED'].includes(product.lifecycle_state)) {
    return { type: 'PRODUCT_STATE', id: product.product_id, state: product.lifecycle_state };
  }
  const session = await executor.query<{ session_id: string; phase: string }>(
    `SELECT session_id, phase FROM core.seckill_sessions
     WHERE product_id = $1 AND phase IN ('PREHEAT','LIVE','SETTLING') LIMIT 1`,
    [product.product_id],
  );
  if (session.rows[0]) return { type: 'SECKILL_SESSION', id: session.rows[0].session_id, state: session.rows[0].phase };
  const reservation = await executor.query<{ reservation_id: string }>(
    `SELECT reservation_id FROM core.inventory_reservations reservation
     JOIN core.skus sku ON sku.sku_id = reservation.sku_id
     WHERE sku.product_id = $1 AND reservation.state = 'ACTIVE' AND reservation.expires_at > $2 LIMIT 1`,
    [product.product_id, now],
  );
  if (reservation.rows[0]) return { type: 'RESERVATION', id: reservation.rows[0].reservation_id, state: 'ACTIVE' };
  const liability = await lockedLiabilityForProduct(executor, product.product_id);
  return liability ? { type: 'ORDER', id: liability.order_id, state: liability.balance_state } : null;
}

export async function productLifecycleDecisionAvailability(
  executor: SqlExecutor,
  productId: string,
  decision: CatalogReviewDecision,
  now: Date,
) {
  try {
    const product = await requireProduct(executor, productId);
    await prepareProductLifecycleDecision(executor, product, decision, now);
    return { enabled: true as const };
  } catch (error) {
    if (error instanceof CoreError) return { enabled: false as const, reasonCode: error.code };
    throw error;
  }
}

function allowedProductActions(product: ProductRow, actor: FulfillmentActor, writeLock: unknown) {
  const platform = actor.roles.includes('ADMIN') || actor.roles.includes('OPERATOR');
  if (platform) return platformProductActions(product, writeLock);
  if (!actor.roles.includes('MERCHANT')) return [];
  if (writeLock) return [];
  if (product.lifecycle_state === 'DRAFT') return ['SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW', 'DELIST'];
  if (['ACTIVE', 'SOLD_OUT'].includes(product.lifecycle_state)) return ['SAVE_DRAFT', 'DELIST'];
  return [];
}

function platformProductActions(product: ProductRow, writeLock: unknown): string[] {
  if (product.lifecycle_state === 'DELISTED') return [];
  if (product.lifecycle_state === 'HIDDEN') return ['DELIST'];
  if (product.lifecycle_state === 'LOCKED') return ['HIDE', 'DELIST'];
  const lock = writeLock as { type?: string } | null;
  if (lock && lock.type !== 'PRODUCT_STATE') return ['HIDE', 'DELIST'];
  if (product.lifecycle_state === 'DRAFT') {
    return ['SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW', 'ADJUST_INVENTORY', 'HIDE', 'DELIST'];
  }
  if (product.lifecycle_state === 'REVIEW') return ['APPROVE', 'REJECT', 'HIDE', 'DELIST'];
  if (product.lifecycle_state === 'SCHEDULED') return ['PUBLISH', 'REJECT', 'HIDE', 'DELIST'];
  if (['ACTIVE', 'SOLD_OUT'].includes(product.lifecycle_state)) {
    return ['SAVE_DRAFT', 'ADJUST_INVENTORY', 'HIDE', 'DELIST'];
  }
  return ['HIDE', 'DELIST'];
}

async function prepareProductLifecycleDecision(
  executor: SqlExecutor,
  product: ProductRow,
  decision: CatalogReviewDecision,
  now: Date,
  mainnetMicrotestEntitlement?: MainnetMicrotestEntitlement,
) {
  const writeLock = await productWriteLock(executor, product, now);
  if (!platformProductActions(product, writeLock).includes(decision)) {
    if (writeLock && !['HIDE', 'DELIST'].includes(decision)) {
      const lock = writeLock as { type: string; id: string; state: string };
      throw productLock(lock.type, lock.id, lock.state);
    }
    reviewTransition(product.lifecycle_state, decision);
    throw new CoreError('InvalidRequest', `Cannot ${decision} a ${product.lifecycle_state} product`, 409);
  }
  const transition = reviewTransition(product.lifecycle_state, decision);
  if (!['HIDDEN', 'DELISTED'].includes(transition.to)) {
    await assertProductWriteUnlocked(executor, product, now, true);
  }
  if (decision === 'APPROVE' || decision === 'PUBLISH') {
    await assertSubmittedPreviewCurrent(executor, product, now);
  }
  if (decision === 'PUBLISH') {
    const merchant = await executor.query<{
      status: string;
      guarantee_status: string;
      settlement_wallet: string;
      default_freight_usdt: string;
      list_price_usdt: string;
      stock_available: string | number;
      guarantee_balance_usdt: string | null;
      guarantee_evidence_hash: string | null;
    }>(
      `SELECT merchant.status, merchant.guarantee_status, merchant.settlement_wallet,
         product.default_freight_usdt::text, sku.list_price_usdt::text,
         sku.stock_available, guarantee.balance_usdt::text AS guarantee_balance_usdt,
         guarantee.source_evidence_hash AS guarantee_evidence_hash
       FROM core.products product
       JOIN core.merchants merchant ON merchant.merchant_id = product.merchant_id
       JOIN core.skus sku ON sku.product_id = product.product_id
       LEFT JOIN core.merchant_guarantees guarantee ON guarantee.merchant_id = merchant.merchant_id
       WHERE product.product_id = $1
       ORDER BY sku.sku_id`,
      [product.product_id],
    );
    const totalStock = merchant.rows.reduce((sum, row) => sum + Number(row.stock_available), 0);
    const microtestEligible = merchant.rows.length > 0 && merchant.rows.every((row) => isMicrotestProductEligible(
      mainnetMicrotestEntitlement,
      {
        merchantId: product.merchant_id,
        merchantWallet: row.settlement_wallet,
        productId: product.product_id,
        listPriceUsdt: row.list_price_usdt,
        freightUsdt: row.default_freight_usdt,
        stockAvailable: totalStock,
        guaranteeBalanceUsdt: row.guarantee_balance_usdt ?? '0',
        guaranteeEvidenceHash: row.guarantee_evidence_hash,
      },
      now,
    ));
    if (
      merchant.rows[0]?.status !== 'APPROVED'
      || (merchant.rows[0]?.guarantee_status !== 'READY' && !microtestEligible)
    ) {
      throw new CoreError('Forbidden', 'Merchant is not eligible for publication', 409);
    }
  }
  return transition;
}

async function applyProductLifecycleDecision(executor: SqlExecutor, input: {
  eventId: string;
  product: ProductRow;
  decision: string;
  from: ProductLifecycle;
  to: ProductLifecycle;
  reasonCode: string;
  snapshotHash: string;
  wallet: string;
  idempotencyKey: string;
  now: Date;
}) {
  await executor.query(
    `UPDATE core.products SET lifecycle_state = $2,
       submission_hash = CASE WHEN $2 = 'DRAFT' THEN NULL ELSE submission_hash END,
       submission_preview_id = CASE WHEN $2 = 'DRAFT' THEN NULL ELSE submission_preview_id END,
       updated_at = $3 WHERE product_id = $1`,
    [input.product.product_id, input.to, input.now],
  );
  await executor.query(
    `UPDATE core.skus SET lifecycle_state = $2
     WHERE product_id = $1 AND lifecycle_state <> 'DELISTED'`,
    [input.product.product_id, skuStateForProduct(input.to)],
  );
  await insertReviewEvent(executor, input);
}

function reviewTransition(from: ProductLifecycle, decision: CatalogReviewDecision) {
  if (decision === 'APPROVE' && from === 'REVIEW') return { to: 'SCHEDULED' as const, event: 'APPROVED' as const };
  if (decision === 'REJECT' && (from === 'REVIEW' || from === 'SCHEDULED')) {
    return { to: 'DRAFT' as const, event: 'REJECTED' as const };
  }
  if (decision === 'PUBLISH' && from === 'SCHEDULED') return { to: 'ACTIVE' as const, event: 'PUBLISHED' as const };
  if (decision === 'HIDE') return { to: 'HIDDEN' as const, event: 'HIDDEN' as const };
  if (decision === 'DELIST') return { to: 'DELISTED' as const, event: 'DELISTED' as const };
  throw new CoreError('InvalidRequest', `Cannot ${decision} a ${from} product`, 409);
}

function skuStateForProduct(state: ProductLifecycle) {
  if (state === 'HIDDEN' || state === 'DELISTED') return 'DELISTED';
  return state;
}

async function insertReviewEvent(executor: SqlExecutor, input: {
  eventId: string;
  product: ProductRow;
  decision: string;
  from: string;
  to: string;
  reasonCode: string;
  snapshotHash: string;
  wallet: string;
  idempotencyKey: string;
  now: Date;
}) {
  await executor.query(
    `INSERT INTO core.product_review_events (
       review_event_id, product_id, product_version, decision, from_state, to_state,
       reason_code, snapshot_hash, actor_wallet, idempotency_key, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.eventId.toLowerCase(), input.product.product_id, input.product.version,
      input.decision, input.from, input.to, input.reasonCode, input.snapshotHash,
      input.wallet, input.idempotencyKey, input.now],
  );
}

function validateProductSlotInput(input: ProductSlotInput) {
  validateIdempotencyKey(input.idempotencyKey);
  const title = boundedText(input.title, 1, 60, 'title');
  const subtitle = boundedText(input.subtitle ?? '', 0, 120, 'subtitle');
  const mainImageAssetIds = uniqueBytes32(input.mainImageAssetIds ?? [], 5, 'mainImageAssetIds');
  const videoAssetId = input.videoAssetId ? normalizedBytes32(input.videoAssetId, 'videoAssetId') : undefined;
  if (!input.richDetail || typeof input.richDetail !== 'object' || Array.isArray(input.richDetail)) {
    throw new CoreError('InvalidRequest', 'richDetail must be an object');
  }
  const defaultFreightUsdt = unsignedInteger(input.defaultFreightUsdt, 'defaultFreightUsdt').toString();
  validateBps(input.merchantConcessionBps);
  const fulfillmentModes = [...new Set(input.fulfillmentModes)].sort() as Array<'DELIVERY' | 'PICKUP'>;
  if (
    fulfillmentModes.length === 0
    || fulfillmentModes.some((mode) => !FULFILLMENT_MODES.includes(mode))
  ) throw new CoreError('InvalidRequest', 'At least one supported fulfillment mode is required');
  const tagIds = uniqueResourceIds(input.tagIds ?? [], 20, 'tagIds');
  const categoryId = input.categoryId ? validateResourceId(input.categoryId, 'categoryId') : undefined;
  if (!Array.isArray(input.skus) || input.skus.length < 1 || input.skus.length > 50) {
    throw new CoreError('InvalidRequest', 'Product requires 1-50 SKUs');
  }
  const skus = input.skus.map((sku, index) => {
    if (!sku.attributes || typeof sku.attributes !== 'object' || Array.isArray(sku.attributes)) {
      throw new CoreError('InvalidRequest', `skus[${index}].attributes must be an object`);
    }
    const listPriceUsdt = positiveInteger(sku.listPriceUsdt, `skus[${index}].listPriceUsdt`).toString();
    if (!Number.isSafeInteger(sku.stockTotal) || sku.stockTotal <= 0) throw new CoreError('InvalidRequest', 'stockTotal must be positive');
    if (!Number.isSafeInteger(sku.proposedSeckillInventory) || sku.proposedSeckillInventory <= 0) {
      throw new CoreError('InvalidRequest', 'proposedSeckillInventory must be a positive integer');
    }
    if (sku.proposedSeckillInventory > sku.stockTotal) {
      throw new CoreError('InvalidRequest', 'proposedSeckillInventory cannot exceed stockTotal');
    }
    return {
      ...(sku.skuId ? { skuId: validateResourceId(sku.skuId, `skus[${index}].skuId`) } : {}),
      attributes: sku.attributes,
      listPriceUsdt,
      stockTotal: sku.stockTotal,
      proposedSeckillInventory: sku.proposedSeckillInventory,
    };
  });
  const suppliedSkuIds = skus.flatMap((sku) => sku.skuId ? [sku.skuId] : []);
  if (new Set(suppliedSkuIds).size !== suppliedSkuIds.length) throw new CoreError('InvalidRequest', 'SKU IDs contain duplicates');
  return {
    idempotencyKey: input.idempotencyKey,
    title,
    subtitle,
    mainImageAssetIds,
    ...(videoAssetId ? { videoAssetId } : {}),
    richDetail: input.richDetail,
    defaultFreightUsdt,
    merchantConcessionBps: input.merchantConcessionBps,
    fulfillmentModes,
    ...(categoryId ? { categoryId } : {}),
    tagIds,
    skus,
  };
}

function validateCategoryInput(input: {
  categoryId?: string;
  parentCategoryId?: string | null;
  name: string;
  iconAssetId?: string;
  sortOrder: number;
  status?: TaxonomyStatus;
  idempotencyKey: string;
}) {
  validateIdempotencyKey(input.idempotencyKey);
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0) throw new CoreError('InvalidRequest', 'sortOrder is invalid');
  const status = input.status ?? 'ENABLED';
  if (!['ENABLED', 'DISABLED', 'DELETED'].includes(status)) throw new CoreError('InvalidRequest', 'Category status is invalid');
  return {
    ...(input.categoryId ? { categoryId: validateResourceId(input.categoryId, 'categoryId') } : {}),
    ...(input.parentCategoryId === undefined
      ? {}
      : { parentCategoryId: input.parentCategoryId === null
        ? null
        : validateResourceId(input.parentCategoryId, 'parentCategoryId') }),
    name: boundedText(input.name, 1, 80, 'name'),
    ...(input.iconAssetId ? { iconAssetId: normalizedBytes32(input.iconAssetId, 'iconAssetId') } : {}),
    sortOrder: input.sortOrder,
    status,
    idempotencyKey: input.idempotencyKey,
  };
}

function validateTagInput(input: {
  tagId?: string;
  name: string;
  example?: string;
  sortOrder: number;
  status?: TaxonomyStatus;
  idempotencyKey: string;
}) {
  validateIdempotencyKey(input.idempotencyKey);
  if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0) throw new CoreError('InvalidRequest', 'sortOrder is invalid');
  const status = input.status ?? 'ENABLED';
  if (!['ENABLED', 'DISABLED', 'DELETED'].includes(status)) throw new CoreError('InvalidRequest', 'Tag status is invalid');
  return {
    ...(input.tagId ? { tagId: validateResourceId(input.tagId, 'tagId') } : {}),
    name: boundedText(input.name, 1, 60, 'name'),
    example: boundedText(input.example ?? '', 0, 240, 'example'),
    sortOrder: input.sortOrder,
    status,
    idempotencyKey: input.idempotencyKey,
  };
}

async function loadCategoryRow(executor: SqlExecutor, categoryId: string, lock = false) {
  const result = await executor.query<{
    category_id: string;
    version: string | number;
    parent_category_id: string | null;
    level: number;
    name: string;
    icon_asset_id: string | null;
    sort_order: number;
    service_fee_bps: number | null;
    status: TaxonomyStatus;
  }>(
    `SELECT version.* FROM core.catalog_categories category
     JOIN core.catalog_category_versions version
       ON version.category_id = category.category_id AND version.version = category.current_version
     WHERE category.category_id = $1${lock ? ' FOR UPDATE OF category' : ''}`,
    [categoryId],
  );
  return result.rows[0];
}

async function loadCategory(executor: SqlExecutor, categoryId: string) {
  const row = await loadCategoryRow(executor, categoryId);
  if (!row) throw new CoreError('InvalidRequest', 'Category not found', 404);
  return categoryProjection(row);
}

function categoryProjection(row: {
  category_id: string;
  version: string | number;
  parent_category_id: string | null;
  level: number;
  name: string;
  icon_asset_id: string | null;
  sort_order: number;
  service_fee_bps: number | null;
  status: TaxonomyStatus;
}) {
  return {
    categoryId: row.category_id,
    version: String(row.version),
    parentCategoryId: row.parent_category_id,
    level: row.level,
    name: row.name,
    iconAssetId: row.icon_asset_id,
    sortOrder: row.sort_order,
    status: row.status,
    serviceFee: row.service_fee_bps === null
      ? { state: 'DecisionBlocked', valueBps: null }
      : { state: 'Frozen', valueBps: row.service_fee_bps },
  };
}

async function loadTagRow(executor: SqlExecutor, tagId: string, lock = false) {
  const result = await executor.query<{
    tag_id: string;
    version: string | number;
    name: string;
    example: string;
    sort_order: number;
    status: TaxonomyStatus;
  }>(
    `SELECT version.* FROM core.catalog_tags tag
     JOIN core.catalog_tag_versions version
       ON version.tag_id = tag.tag_id AND version.version = tag.current_version
     WHERE tag.tag_id = $1${lock ? ' FOR UPDATE OF tag' : ''}`,
    [tagId],
  );
  return result.rows[0];
}

async function loadTag(executor: SqlExecutor, tagId: string) {
  const row = await loadTagRow(executor, tagId);
  if (!row) throw new CoreError('InvalidRequest', 'Tag not found', 404);
  return tagProjection(row);
}

function tagProjection(row: {
  tag_id: string;
  version: string | number;
  name: string;
  example: string;
  sort_order: number;
  status: TaxonomyStatus;
}) {
  return {
    tagId: row.tag_id,
    version: String(row.version),
    name: row.name,
    example: row.example,
    sortOrder: row.sort_order,
    status: row.status,
  };
}

async function loadInventoryAdjustment(executor: SqlExecutor, adjustmentId: string) {
  const result = await executor.query<{
    adjustment_id: string;
    sku_id: string;
    before_total: string | number;
    before_available: string | number;
    delta: string | number;
    after_total: string | number;
    after_available: string | number;
    reason_code: string;
    actor_wallet: string;
    idempotency_key: string;
    created_at: Date | string;
  }>('SELECT * FROM core.catalog_inventory_adjustments WHERE adjustment_id = $1', [adjustmentId]);
  const row = result.rows[0];
  if (!row) throw new CoreError('UnknownState', 'Inventory adjustment is unavailable', 409);
  const requestHashResult = await executor.query<{ request_hash: string }>(
    `SELECT request_hash FROM core.catalog_commands
     WHERE actor_wallet = $1 AND command_scope = 'ADJUST_INVENTORY' AND idempotency_key = $2`,
    [row.actor_wallet, row.idempotency_key],
  );
  return {
    requestHash: requestHashResult.rows[0]?.request_hash,
    projection: {
      artifactVersion: CORE_ARTIFACT_VERSION,
      adjustmentId: row.adjustment_id,
      skuId: row.sku_id,
      beforeTotal: String(row.before_total),
      beforeAvailable: String(row.before_available),
      delta: String(row.delta),
      afterTotal: String(row.after_total),
      afterAvailable: String(row.after_available),
      reasonCode: row.reason_code,
      actorWallet: row.actor_wallet,
      createdAt: new Date(row.created_at).toISOString(),
    },
  };
}

function previewProjection(row: PreviewRow) {
  const authorization = concessionPreviewAuthorization({
    previewHash: row.preview_hash,
    previewId: row.preview_id,
    productId: row.product_id,
    policyVersion: Number(row.policy_version),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
  });
  return {
    artifactVersion: CORE_ARTIFACT_VERSION,
    previewId: row.preview_id,
    productId: row.product_id,
    productVersion: String(row.product_version),
    merchantId: row.merchant_id,
    policyVersion: String(row.policy_version),
    merchantConcessionBps: row.concession_bps,
    catalogFingerprint: row.catalog_fingerprint,
    destinationSetHash: row.destination_set_hash,
    previewHash: row.preview_hash,
    payload: object(row.payload),
    authorization: {
      ...authorization,
      signature: row.signature,
      signer: row.signer,
    },
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function catalogFingerprint(product: ProductRow, skus: SkuRow[]) {
  return hashJson({
    productId: product.product_id,
    productVersion: Number(product.version),
    merchantId: product.merchant_id,
    concessionBps: product.merchant_concession_bps,
    skus: skus.filter((sku) => sku.lifecycle_state !== 'DELISTED').map((sku) => ({
      skuId: sku.sku_id,
      skuVersion: Number(sku.sku_version),
      listPriceUsdt: sku.list_price_usdt,
      merchantBaseReceivableUsdt: postFeeMerchantBase(sku.list_price_usdt).toString(),
    })),
  });
}

function postFeeMerchantBase(listPriceUsdt: string) {
  return postFeeMerchantBaseAmount(BigInt(listPriceUsdt));
}

function postFeeMerchantBaseAmount(listPriceUsdt: bigint) {
  return listPriceUsdt * 7_000n / 10_000n - listPriceUsdt * 100n / 10_000n;
}

function productLock(type: string, id: string, state: string) {
  return new CoreError('ProductWriteLocked', 'Product is locked against catalog writes', 409, {
    blockingResource: { type, id, state },
  });
}

function idempotencyConflict(resource: string) {
  return new CoreError('IdempotencyConflict', `${resource} idempotency key was reused with different input`, 409);
}

function actorWallet(actor: FulfillmentActor) {
  try {
    return normalizeAddress(actor.walletAddress);
  } catch {
    throw new CoreError('Forbidden', 'Actor wallet is invalid', 403);
  }
}

function validateResourceId(value: string, label: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new CoreError('InvalidRequest', `${label} is invalid`);
  return value;
}

function validateIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new CoreError('InvalidRequest', 'idempotencyKey is invalid');
}

function validateReasonCode(value: string) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) throw new CoreError('InvalidRequest', 'reasonCode is invalid');
}

function validateProductLifecycleBatchInput(input: CatalogProductLifecycleBatchInput) {
  if (!catalogReviewDecisions.includes(input.action)) {
    throw new CoreError('InvalidRequest', 'Product lifecycle batch action is invalid');
  }
  if (!Array.isArray(input.productIds) || input.productIds.length < 1 || input.productIds.length > 100) {
    throw new CoreError('InvalidRequest', 'Product lifecycle batch requires 1-100 products');
  }
  input.productIds.forEach((productId) => validateResourceId(productId, 'productId'));
  if (new Set(input.productIds).size !== input.productIds.length) {
    throw new CoreError('InvalidRequest', 'Product lifecycle batch contains duplicate products');
  }
  validateReasonCode(input.reasonCode);
  validateIdempotencyKey(input.idempotencyKey);
  return {
    action: input.action,
    productIds: [...input.productIds].sort(),
    reasonCode: input.reasonCode,
    idempotencyKey: input.idempotencyKey,
  };
}

function validateBps(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new CoreError('InvalidRequest', 'Merchant concession must be between 0% and 100%');
  }
}

function validateBytes32(value: string, label: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('InvalidRequest', `${label} must be bytes32`);
}

function normalizedBytes32(value: string, label: string) {
  validateBytes32(value, label);
  return value.toLowerCase();
}

function uniqueBytes32(values: string[], limit: number, label: string) {
  if (!Array.isArray(values) || values.length > limit) throw new CoreError('InvalidRequest', `${label} is invalid`);
  const result = values.map((value) => normalizedBytes32(value, label));
  if (new Set(result).size !== result.length) throw new CoreError('InvalidRequest', `${label} contains duplicates`);
  return result;
}

function uniqueResourceIds(values: string[], limit: number, label: string) {
  if (!Array.isArray(values) || values.length > limit) throw new CoreError('InvalidRequest', `${label} is invalid`);
  const result = values.map((value) => validateResourceId(value, label));
  if (new Set(result).size !== result.length) throw new CoreError('InvalidRequest', `${label} contains duplicates`);
  return result.sort();
}

function boundedText(value: string, minimum: number, maximum: number, label: string) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new CoreError('InvalidRequest', `${label} length is invalid`);
  }
  return value;
}

function unsignedInteger(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${label} must be an unsigned integer`);
  return BigInt(value);
}

function positiveInteger(value: string, label: string) {
  const amount = unsignedInteger(value, label);
  if (amount <= 0n) throw new CoreError('InvalidRequest', `${label} must be positive`);
  return amount;
}

function signedInteger(value: string, label: string) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `${label} must be an integer`);
  return BigInt(value);
}

function resourceId(prefix: string, seed: string) {
  return `${prefix}:${seed.slice(2).toLowerCase()}`;
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function object(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : [];
}

void LOCKED_SESSION_PHASES;

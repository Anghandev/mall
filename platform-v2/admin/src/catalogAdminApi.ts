import {
  artifactVersion,
  catalogProductActions,
  catalogProductLifecycleStates,
  catalogReviewDecisions,
  catalogTaxonomyStatuses,
  fulfillmentModes,
  mediaContentTypes,
  mediaPurposes,
  mediaResourceTypes,
  type AdminProductSlotInput,
  type CatalogCategory,
  type CatalogReviewDecision,
  type CatalogTag,
  type CatalogTaxonomyStatus,
  type InventoryAdjustmentProjection,
  type ManagedCatalogProduct,
  type MediaReadAccessProjection,
  type MerchantConcessionPreview,
  type ProductSlotProjection,
} from '@abu24k/core-artifacts';
import { CoreApiError, requestCoreJson } from './coreApi';

const amountPattern = /^(0|[1-9][0-9]*)$/;
const signedAmountPattern = /^-?[1-9][0-9]*$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const reasonPattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export type CatalogCategoryWrite = Readonly<{
  name: string;
  parentCategoryId?: string | null;
  iconAssetId?: string;
  sortOrder: number;
  status?: CatalogTaxonomyStatus;
  idempotencyKey: string;
}>;

export type CatalogTagWrite = Readonly<{
  name: string;
  example?: string;
  sortOrder: number;
  status?: CatalogTaxonomyStatus;
  idempotencyKey: string;
}>;

export async function fetchAdminCatalogCategories(token: string, signal?: AbortSignal): Promise<readonly CatalogCategory[]> {
  const body = record(await authenticatedGet('/v2/admin/catalog/categories', token, signal));
  if (!Array.isArray(body.categories) || !body.categories.every(isCatalogCategory)) {
    throw invalid('Catalog category list does not match the coordinated generated type');
  }
  return Object.freeze([...body.categories]);
}

export async function saveCatalogCategory(
  categoryId: string | null,
  input: CatalogCategoryWrite,
  token: string,
): Promise<CatalogCategory> {
  validateCategoryWrite(input);
  const body = await authenticatedWrite(
    categoryId ? resourcePath('/v2/admin/catalog/categories/', categoryId) : '/v2/admin/catalog/categories',
    categoryId ? 'PUT' : 'POST',
    input,
    token,
  );
  if (!isCatalogCategory(body)) throw invalid('Catalog category result does not match the coordinated generated type');
  return body;
}

export async function fetchAdminCatalogTags(token: string, signal?: AbortSignal): Promise<readonly CatalogTag[]> {
  const body = record(await authenticatedGet('/v2/admin/catalog/tags', token, signal));
  if (!Array.isArray(body.tags) || !body.tags.every(isCatalogTag)) {
    throw invalid('Catalog tag list does not match the coordinated generated type');
  }
  return Object.freeze([...body.tags]);
}

export async function saveCatalogTag(tagId: string | null, input: CatalogTagWrite, token: string): Promise<CatalogTag> {
  validateTagWrite(input);
  const body = await authenticatedWrite(
    tagId ? resourcePath('/v2/admin/catalog/tags/', tagId) : '/v2/admin/catalog/tags',
    tagId ? 'PUT' : 'POST',
    input,
    token,
  );
  if (!isCatalogTag(body)) throw invalid('Catalog tag result does not match the coordinated generated type');
  return body;
}

export async function fetchAdminCatalogProducts(token: string, signal?: AbortSignal): Promise<readonly ManagedCatalogProduct[]> {
  const body = record(await authenticatedGet('/v2/admin/catalog/products', token, signal));
  if (!Array.isArray(body.products) || !body.products.every(isManagedCatalogProduct)) {
    throw invalid('Managed catalog product list does not match the coordinated generated type');
  }
  return Object.freeze([...body.products]);
}

export async function fetchAdminProductSlot(
  storeId: string,
  merchantId: string,
  token: string,
  signal?: AbortSignal,
): Promise<ProductSlotProjection> {
  const path = `${resourcePath('/v2/admin/catalog/stores/', storeId)}/product-slot?merchantId=${encodeURIComponent(resourceId(merchantId))}`;
  const body = await authenticatedGet(path, token, signal);
  if (!isProductSlotProjection(body)) throw invalid('Admin product slot does not match the coordinated generated type');
  return body;
}

export async function saveAdminProductSlot(
  storeId: string,
  input: AdminProductSlotInput,
  token: string,
): Promise<ManagedCatalogProduct> {
  validateProductSlot(input);
  const body = await authenticatedWrite(`${resourcePath('/v2/admin/catalog/stores/', storeId)}/product-slot`, 'PUT', input, token);
  if (!isManagedCatalogProduct(body)) throw invalid('Saved admin product does not match the coordinated generated type');
  return body;
}

export async function createAdminConcessionPreview(
  productId: string,
  merchantConcessionBps: number,
  idempotencyKey: string,
  token: string,
): Promise<MerchantConcessionPreview> {
  requireBps(merchantConcessionBps, 'merchantConcessionBps');
  requireIdempotencyKey(idempotencyKey);
  const body = await authenticatedWrite(
    `${resourcePath('/v2/admin/catalog/products/', productId)}/concession-previews`,
    'POST',
    { merchantConcessionBps, idempotencyKey },
    token,
  );
  if (!isConcessionPreview(body)) throw invalid('Concession preview does not match the coordinated generated type');
  return body;
}

export async function submitAdminProductReview(
  productId: string,
  previewId: string,
  idempotencyKey: string,
  token: string,
): Promise<ManagedCatalogProduct> {
  requireBytes32(previewId, 'previewId');
  requireIdempotencyKey(idempotencyKey);
  const body = await authenticatedWrite(
    `${resourcePath('/v2/admin/catalog/products/', productId)}/review-submissions`,
    'POST',
    { previewId, idempotencyKey },
    token,
  );
  if (!isManagedCatalogProduct(body)) throw invalid('Review submission does not match the coordinated generated type');
  return body;
}

export async function decideAdminProductReview(
  productId: string,
  decision: CatalogReviewDecision,
  reasonCode: string,
  idempotencyKey: string,
  token: string,
): Promise<ManagedCatalogProduct> {
  if (!catalogReviewDecisions.includes(decision)) throw invalid('Catalog review decision is invalid', 400);
  requireReasonCode(reasonCode);
  requireIdempotencyKey(idempotencyKey);
  const body = await authenticatedWrite(
    `${resourcePath('/v2/admin/catalog/products/', productId)}/review-decisions`,
    'POST',
    { decision, reasonCode, idempotencyKey },
    token,
  );
  if (!isManagedCatalogProduct(body)) throw invalid('Catalog review result does not match the coordinated generated type');
  return body;
}

export async function adjustAdminCatalogInventory(
  skuId: string,
  delta: string,
  reasonCode: string,
  idempotencyKey: string,
  token: string,
): Promise<InventoryAdjustmentProjection> {
  if (!signedAmountPattern.test(delta)) throw invalid('Inventory delta must be a non-zero signed integer', 400);
  requireReasonCode(reasonCode);
  requireIdempotencyKey(idempotencyKey);
  const body = await authenticatedWrite(
    `${resourcePath('/v2/admin/catalog/skus/', skuId)}/inventory-adjustments`,
    'POST',
    { delta, reasonCode, idempotencyKey },
    token,
  );
  if (!isInventoryAdjustment(body)) throw invalid('Inventory adjustment does not match the coordinated generated type');
  return body;
}

export async function fetchMediaReadAccess(
  assetId: string,
  token: string,
  signal?: AbortSignal,
): Promise<MediaReadAccessProjection> {
  requireBytes32(assetId, 'assetId');
  const body = await authenticatedGet(resourcePath('/v2/media/assets/', assetId) + '/access', token, signal);
  if (!isMediaReadAccess(body)) throw invalid('Media access result does not match the coordinated generated type');
  return body;
}

function validateCategoryWrite(input: CatalogCategoryWrite) {
  requireText(input.name, 'name', 80);
  requireSortOrder(input.sortOrder);
  requireIdempotencyKey(input.idempotencyKey);
  if (input.parentCategoryId !== undefined && input.parentCategoryId !== null) resourceId(input.parentCategoryId);
  if (input.iconAssetId !== undefined) requireBytes32(input.iconAssetId, 'iconAssetId');
  if (input.status !== undefined && !catalogTaxonomyStatuses.includes(input.status)) throw invalid('Category status is invalid', 400);
}

function validateTagWrite(input: CatalogTagWrite) {
  requireText(input.name, 'name', 60);
  requireSortOrder(input.sortOrder);
  requireIdempotencyKey(input.idempotencyKey);
  if (input.example !== undefined) requireText(input.example, 'example', 240);
  if (input.status !== undefined && !catalogTaxonomyStatuses.includes(input.status)) throw invalid('Tag status is invalid', 400);
}

function validateProductSlot(input: AdminProductSlotInput) {
  resourceId(input.merchantId);
  requireIdempotencyKey(input.idempotencyKey);
  requireText(input.title, 'title', 60);
  if (input.subtitle !== undefined) requireText(input.subtitle, 'subtitle', 120);
  if (!isRecord(input.richDetail)) throw invalid('richDetail must be an object', 400);
  requireAmount(input.defaultFreightUsdt, 'defaultFreightUsdt');
  requireBps(input.merchantConcessionBps, 'merchantConcessionBps');
  if (input.fulfillmentModes.length < 1 || input.fulfillmentModes.length > 2 || new Set(input.fulfillmentModes).size !== input.fulfillmentModes.length || !input.fulfillmentModes.every((mode) => fulfillmentModes.includes(mode))) {
    throw invalid('fulfillmentModes are invalid', 400);
  }
  if (input.categoryId !== undefined) resourceId(input.categoryId);
  if (input.tagIds !== undefined && (input.tagIds.length > 20 || new Set(input.tagIds).size !== input.tagIds.length || !input.tagIds.every((id) => validResourceId(id)))) {
    throw invalid('tagIds are invalid', 400);
  }
  if (input.mainImageAssetIds !== undefined && (input.mainImageAssetIds.length > 5 || new Set(input.mainImageAssetIds.map((id) => id.toLowerCase())).size !== input.mainImageAssetIds.length || !input.mainImageAssetIds.every(bytes32Pattern.test.bind(bytes32Pattern)))) {
    throw invalid('mainImageAssetIds are invalid', 400);
  }
  if (input.videoAssetId !== undefined) requireBytes32(input.videoAssetId, 'videoAssetId');
  if (input.skus.length < 1 || input.skus.length > 50) throw invalid('skus must contain 1 to 50 items', 400);
  for (const sku of input.skus) {
    if (sku.skuId !== undefined) resourceId(sku.skuId);
    if (!isRecord(sku.attributes)) throw invalid('SKU attributes must be an object', 400);
    requireAmount(sku.listPriceUsdt, 'listPriceUsdt');
    requireAmount(sku.merchantBaseReceivableUsdt, 'merchantBaseReceivableUsdt');
    if (!Number.isSafeInteger(sku.stockTotal) || sku.stockTotal < 1) throw invalid('SKU stockTotal must be positive', 400);
    if (!Number.isSafeInteger(sku.proposedSeckillInventory) || sku.proposedSeckillInventory < 1 || sku.proposedSeckillInventory > sku.stockTotal) {
      throw invalid('SKU proposedSeckillInventory must be positive and no greater than stockTotal', 400);
    }
  }
}

function isCatalogCategory(value: unknown): value is CatalogCategory {
  return isRecord(value)
    && validResourceId(value.categoryId)
    && amountPattern.test(String(value.version))
    && (value.parentCategoryId === null || validResourceId(value.parentCategoryId))
    && [1, 2, 3].includes(Number(value.level))
    && typeof value.name === 'string'
    && (value.iconAssetId === null || bytes32Pattern.test(String(value.iconAssetId)))
    && Number.isSafeInteger(value.sortOrder)
    && catalogTaxonomyStatuses.includes(value.status as CatalogTaxonomyStatus)
    && isRecord(value.serviceFee)
    && ['Frozen', 'DecisionBlocked'].includes(String(value.serviceFee.state))
    && (value.serviceFee.valueBps === null || isBps(value.serviceFee.valueBps));
}

function isCatalogTag(value: unknown): value is CatalogTag {
  return isRecord(value)
    && validResourceId(value.tagId)
    && amountPattern.test(String(value.version))
    && typeof value.name === 'string'
    && typeof value.example === 'string'
    && Number.isSafeInteger(value.sortOrder)
    && catalogTaxonomyStatuses.includes(value.status as CatalogTaxonomyStatus);
}

function isManagedCatalogProduct(value: unknown): value is ManagedCatalogProduct {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !validResourceId(value.productId)
    || !bytes32Pattern.test(String(value.chainProductId))
    || !validResourceId(value.merchantId)
    || (value.storeId !== null && !validResourceId(value.storeId))
    || (value.supersedesProductId !== null && !validResourceId(value.supersedesProductId))
    || !amountPattern.test(String(value.version))
    || typeof value.title !== 'string'
    || typeof value.subtitle !== 'string'
    || !catalogProductLifecycleStates.includes(value.lifecycleState as never)
    || !bytes32Pattern.test(String(value.productPolicyHash))
    || !isBps(value.merchantConcessionBps)
    || !Array.isArray(value.mainImageAssetIds)
    || !value.mainImageAssetIds.every((id) => bytes32Pattern.test(String(id)))
    || (value.videoAssetId !== null && !bytes32Pattern.test(String(value.videoAssetId)))
    || !isRecord(value.richDetail)
    || !amountPattern.test(String(value.defaultFreightUsdt))
    || !Array.isArray(value.fulfillmentModes)
    || !value.fulfillmentModes.every((mode) => fulfillmentModes.includes(mode as never))
    || (value.categoryId !== null && !validResourceId(value.categoryId))
    || !Array.isArray(value.tagIds)
    || !value.tagIds.every(validResourceId)
    || !Array.isArray(value.allowedActions)
    || !value.allowedActions.every((action) => catalogProductActions.includes(action as never))
    || !isCatalogWriteLock(value.writeLock)
    || !validDate(value.createdAt)
    || !validDate(value.updatedAt)
    || !Array.isArray(value.skus)) return false;
  return value.skus.every((sku) => isRecord(sku)
    && validResourceId(sku.skuId)
    && bytes32Pattern.test(String(sku.chainSkuId))
    && amountPattern.test(String(sku.version))
    && isRecord(sku.attributes)
    && amountPattern.test(String(sku.listPriceUsdt))
    && amountPattern.test(String(sku.merchantBaseReceivableUsdt))
    && amountPattern.test(String(sku.stockTotal))
    && amountPattern.test(String(sku.stockAvailable))
    && amountPattern.test(String(sku.stockReserved))
    && amountPattern.test(String(sku.proposedSeckillInventory))
    && catalogProductLifecycleStates.includes(sku.lifecycleState as never));
}

function isProductSlotProjection(value: unknown): value is ProductSlotProjection {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && validResourceId(value.storeId)
    && validResourceId(value.merchantId)
    && (value.product === null || isManagedCatalogProduct(value.product))
    && Array.isArray(value.allowedActions)
    && value.allowedActions.every((action) => catalogProductActions.includes(action as never))
    && isCatalogWriteLock(value.writeLock);
}

function isConcessionPreview(value: unknown): value is MerchantConcessionPreview {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !bytes32Pattern.test(String(value.previewId))
    || !validResourceId(value.productId)
    || !amountPattern.test(String(value.productVersion))
    || !validResourceId(value.merchantId)
    || !amountPattern.test(String(value.policyVersion))
    || !isBps(value.merchantConcessionBps)
    || !bytes32Pattern.test(String(value.catalogFingerprint))
    || !bytes32Pattern.test(String(value.destinationSetHash))
    || !bytes32Pattern.test(String(value.previewHash))
    || !validDate(value.expiresAt)
    || !validDate(value.createdAt)
    || !isRecord(value.payload)
    || !isRecord(value.authorization)) return false;
  const payload = value.payload;
  const authorization = value.authorization;
  return payload.artifactVersion === artifactVersion
    && payload.productId === value.productId
    && Number.isSafeInteger(payload.productVersion)
    && payload.merchantId === value.merchantId
    && Number.isSafeInteger(payload.policyVersion)
    && payload.merchantConcessionBps === value.merchantConcessionBps
    && payload.catalogFingerprint === value.catalogFingerprint
    && payload.destinationSetHash === value.destinationSetHash
    && Array.isArray(payload.items)
    && payload.items.every((item) => isRecord(item)
      && validResourceId(item.skuId)
      && amountPattern.test(String(item.merchantBaseReceivableUsdt))
      && isBps(item.merchantConcessionBps)
      && amountPattern.test(String(item.merchantConcessionAmount))
      && amountPattern.test(String(item.merchantNetReceivableUsdt))
      && Array.isArray(item.allocations)
      && item.allocations.every((allocation) => isRecord(allocation)
        && addressPattern.test(String(allocation.account))
        && amountPattern.test(String(allocation.amount))))
    && authorization.primaryType === 'MerchantConcessionPreview'
    && bytes32Pattern.test(String(authorization.digest))
    && typeof authorization.signature === 'string'
    && authorization.signature.length > 0
    && addressPattern.test(String(authorization.signer))
    && isRecord(authorization.domain)
    && isRecord(authorization.types)
    && isRecord(authorization.message);
}

function isInventoryAdjustment(value: unknown): value is InventoryAdjustmentProjection {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && bytes32Pattern.test(String(value.adjustmentId))
    && validResourceId(value.skuId)
    && amountPattern.test(String(value.beforeTotal))
    && amountPattern.test(String(value.beforeAvailable))
    && signedAmountPattern.test(String(value.delta))
    && amountPattern.test(String(value.afterTotal))
    && amountPattern.test(String(value.afterAvailable))
    && reasonPattern.test(String(value.reasonCode))
    && addressPattern.test(String(value.actorWallet))
    && validDate(value.createdAt);
}

function isMediaReadAccess(value: unknown): value is MediaReadAccessProjection {
  if (!isRecord(value)
    || value.artifactVersion !== artifactVersion
    || !bytes32Pattern.test(String(value.assetId))
    || !mediaPurposes.includes(value.purpose as never)
    || !mediaResourceTypes.includes(value.resourceType as never)
    || !validResourceId(value.resourceId)
    || !mediaContentTypes.includes(value.contentType as never)
    || !amountPattern.test(String(value.sizeBytes))
    || !bytes32Pattern.test(String(value.contentSha256))
    || !bytes32Pattern.test(String(value.objectVersionHash))
    || !['PUBLIC', 'AUTHENTICATED'].includes(String(value.accessScope))
    || value.method !== 'GET'
    || typeof value.readUrl !== 'string'
    || !validDate(value.expiresAt)
    || !bytes32Pattern.test(String(value.providerReferenceHash))) return false;
  const purpose = String(value.purpose);
  const contentType = String(value.contentType);
  if (purpose === 'PRODUCT_VIDEO') return contentType === 'video/mp4';
  if (['PRODUCT_IMAGE', 'CATEGORY_ICON', 'STORE_IMAGE'].includes(purpose)) return contentType.startsWith('image/');
  return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType);
}

function isCatalogWriteLock(value: unknown): value is ManagedCatalogProduct['writeLock'] {
  return value === null || (isRecord(value) && validResourceId(value.type) && validResourceId(value.id) && validResourceId(value.state));
}

async function authenticatedGet(path: string, token: string, signal?: AbortSignal) {
  return requestCoreJson(path, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
}

async function authenticatedWrite(path: string, method: 'POST' | 'PUT', body: object, token: string) {
  return requestCoreJson(path, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method,
  });
}

function resourcePath(prefix: string, value: string) {
  return `${prefix}${encodeURIComponent(resourceId(value))}`;
}

function resourceId(value: string) {
  if (!validResourceId(value)) throw invalid('Resource ID is required and must be at most 256 characters', 400);
  return value.trim();
}

function validResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 256;
}

function requireText(value: string, label: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maxLength) throw invalid(`${label} is invalid`, 400);
}

function requireSortOrder(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('sortOrder must be a non-negative integer', 400);
}

function requireIdempotencyKey(value: string) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw invalid('idempotencyKey must contain 8 to 128 characters', 400);
}

function requireBytes32(value: string, label: string) {
  if (!bytes32Pattern.test(value)) throw invalid(`${label} must be bytes32`, 400);
}

function requireAmount(value: string, label: string) {
  if (!amountPattern.test(value)) throw invalid(`${label} must be a canonical atomic amount`, 400);
}

function requireBps(value: number, label: string) {
  if (!isBps(value)) throw invalid(`${label} must be an integer between 0 and 10000`, 400);
}

function isBps(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function requireReasonCode(value: string) {
  if (!reasonPattern.test(value)) throw invalid('reasonCode must be an uppercase code', 400);
}

function validDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid('Core response must be an object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string, status = 502) {
  return new CoreApiError({ code: 'InvalidResponse', message, status });
}

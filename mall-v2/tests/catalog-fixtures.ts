import {
  artifactVersion,
  type CatalogCategory,
  type CatalogTag,
  type MediaReadAccessProjection,
} from '@abu24k/core-artifacts';

import { product, productImageAssetId, productVideoAssetId } from './payment-fixtures';

const hash = (value: string) => `0x${value.repeat(64)}`;

export const categoryIconAssetId = hash('7');

export const catalogCategories: readonly CatalogCategory[] = [{
  categoryId: 'footwear',
  version: '1',
  parentCategoryId: null,
  level: 1,
  name: '鞋履',
  iconAssetId: categoryIconAssetId,
  sortOrder: 1,
  status: 'ENABLED',
  serviceFee: { state: 'DecisionBlocked', valueBps: null },
}, {
  categoryId: 'sports-shoes',
  version: '1',
  parentCategoryId: 'footwear',
  level: 2,
  name: '运动鞋',
  iconAssetId: null,
  sortOrder: 1,
  status: 'ENABLED',
  serviceFee: { state: 'DecisionBlocked', valueBps: null },
}];

export const catalogTags: readonly CatalogTag[] = [{
  tagId: 'black-gold',
  version: '1',
  name: '黑金',
  example: '黑金配色',
  sortOrder: 1,
  status: 'ENABLED',
}];

export function publicMediaAccess(assetId: string, readOrigin = 'https://media.mall.test'): MediaReadAccessProjection {
  const identity = assetIdentity(assetId);
  return {
    artifactVersion,
    assetId,
    purpose: identity.purpose,
    resourceType: identity.resourceType,
    resourceId: identity.resourceId,
    contentType: identity.contentType,
    sizeBytes: '1024',
    contentSha256: hash('8'),
    objectVersionHash: hash('9'),
    accessScope: 'PUBLIC',
    method: 'GET',
    readUrl: `${readOrigin}/${assetId}.media`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    providerReferenceHash: hash('6'),
  };
}

function assetIdentity(assetId: string) {
  if (assetId === productImageAssetId) return {
    purpose: 'PRODUCT_IMAGE' as const,
    resourceType: 'PRODUCT' as const,
    resourceId: product.productId,
    contentType: 'image/webp' as const,
  };
  if (assetId === productVideoAssetId) return {
    purpose: 'PRODUCT_VIDEO' as const,
    resourceType: 'PRODUCT' as const,
    resourceId: product.productId,
    contentType: 'video/mp4' as const,
  };
  if (assetId === categoryIconAssetId) return {
    purpose: 'CATEGORY_ICON' as const,
    resourceType: 'CATEGORY' as const,
    resourceId: catalogCategories[0]!.categoryId,
    contentType: 'image/png' as const,
  };
  throw new Error(`Unknown catalog media asset ${assetId}`);
}

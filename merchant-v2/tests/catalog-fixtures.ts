import {
  artifactVersion,
  type CatalogCategory,
  type CatalogTag,
  type ManagedCatalogProduct,
  type MediaAssetProjection,
  type MediaReadAccessProjection,
  type MediaUploadIntentProjection,
  type MerchantConcessionPreview,
  type MerchantManagedStore,
  type MerchantStore,
  type ProductSlotProjection,
} from '@abu24k/core-artifacts';

export const merchantId = 'merchant-1';
export const storeId = 'store-1';
export const productId = 'product-managed-1';
export const skuId = 'sku-managed-1';
export const merchantWallet = '0x1111111111111111111111111111111111111111';
export const mediaAssetId = hash('1');
export const videoAssetId = hash('2');
export const previewId = hash('3');

export const merchantStore: MerchantStore = {
  storeId,
  merchantId,
  name: '上海黄金店',
  regionCode: '310101',
  longitude: 121.4737,
  latitude: 31.2304,
  address: '上海市黄浦区金陵东路 24 号',
  phone: '021-12345678',
  businessHours: '09:00-18:00',
  imageAssetIds: [mediaAssetId],
  status: 'ACTIVE',
  version: 1,
};

export const managedMerchantStore: MerchantManagedStore = {
  ...merchantStore,
  artifactVersion,
  allowedActions: [
    { action: 'UPDATE_PROFILE', enabled: true },
    { action: 'ACTIVATE', enabled: false, reasonCode: 'STORE_STATE_MISMATCH' },
    { action: 'CLOSE', enabled: true },
  ],
};

export const catalogCategories: readonly CatalogCategory[] = [{
  categoryId: 'category-gold',
  version: '2',
  parentCategoryId: null,
  level: 1,
  name: '黄金制品',
  iconAssetId: null,
  sortOrder: 1,
  status: 'ENABLED',
  serviceFee: { state: 'DecisionBlocked', valueBps: null },
}];

export const catalogTags: readonly CatalogTag[] = [{
  tagId: 'tag-24k',
  version: '1',
  name: '24K',
  example: '足金商品',
  sortOrder: 1,
  status: 'ENABLED',
}];

export const managedProduct: ManagedCatalogProduct = {
  artifactVersion,
  productId,
  chainProductId: hash('4'),
  merchantId,
  storeId,
  supersedesProductId: 'product-history-1',
  version: '3',
  title: '24K 足金金片',
  subtitle: '单店限量提报',
  lifecycleState: 'DRAFT',
  productPolicyHash: hash('5'),
  merchantConcessionBps: 2500,
  mainImageAssetIds: [mediaAssetId],
  videoAssetId,
  richDetail: { blocks: [{ type: 'paragraph', text: '足金商品详情' }] },
  defaultFreightUsdt: '0',
  fulfillmentModes: ['DELIVERY', 'PICKUP'],
  categoryId: 'category-gold',
  tagIds: ['tag-24k'],
  skus: [{
    skuId,
    chainSkuId: hash('6'),
    version: '2',
    attributes: { size: '标准款', color: '金色' },
    listPriceUsdt: '1000',
    merchantBaseReceivableUsdt: '690',
    stockTotal: '20',
    stockAvailable: '17',
    stockReserved: '1',
    proposedSeckillInventory: '10',
    lifecycleState: 'DRAFT',
  }],
  allowedActions: ['SAVE_DRAFT', 'CREATE_CONCESSION_PREVIEW', 'SUBMIT_REVIEW', 'DELIST'],
  writeLock: null,
  createdAt: '2026-07-15T02:00:00.000Z',
  updatedAt: '2026-07-15T02:05:00.000Z',
};

export const productSlot: ProductSlotProjection = {
  artifactVersion,
  storeId,
  merchantId,
  product: managedProduct,
  allowedActions: managedProduct.allowedActions,
  writeLock: null,
};

export const concessionPreview: MerchantConcessionPreview = {
  artifactVersion,
  previewId,
  productId,
  productVersion: managedProduct.version,
  merchantId,
  policyVersion: '9',
  merchantConcessionBps: 2500,
  catalogFingerprint: hash('7'),
  destinationSetHash: hash('8'),
  previewHash: hash('9'),
  payload: {
    artifactVersion,
    productId,
    productVersion: 3,
    merchantId,
    policyVersion: 9,
    merchantConcessionBps: 2500,
    destinationSetHash: hash('8'),
    catalogFingerprint: hash('7'),
    items: [{
      skuId,
      merchantBaseReceivableUsdt: '690',
      merchantConcessionBps: 2500,
      merchantConcessionAmount: '172',
      merchantNetReceivableUsdt: '518',
      allocations: [
        { pool: 'SECKILL_PRIZE', amount: '77', balanceState: 'LOCKED' },
        { pool: 'NODE_REWARD', amount: '77', balanceState: 'LOCKED' },
        { pool: 'REWARD_RESERVE', amount: '18', balanceState: 'LOCKED' },
      ],
    }],
    expiresAt: '2030-03-17T17:46:40.000Z',
  },
  authorization: {
    domain: { name: 'Abu24KCatalog', version: '2', chainId: 56 },
    types: {
      MerchantConcessionPreview: [
        { name: 'previewHash', type: 'bytes32' },
        { name: 'previewId', type: 'bytes32' },
        { name: 'productIdHash', type: 'bytes32' },
        { name: 'policyVersion', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'MerchantConcessionPreview',
    message: {
      previewHash: hash('9'),
      previewId,
      productIdHash: hash('a'),
      policyVersion: 9,
      expiresAt: 1_900_000_000,
    },
    digest: hash('b'),
    signature: `0x${'12'.repeat(65)}`,
    signer: '0x4444444444444444444444444444444444444444',
  },
  expiresAt: '2030-03-17T17:46:40.000Z',
  createdAt: '2026-07-15T02:10:00.000Z',
};

export const mediaUploadIntent: MediaUploadIntentProjection = {
  artifactVersion,
  uploadIntentId: hash('c'),
  ownerWallet: merchantWallet,
  purpose: 'PRODUCT_IMAGE',
  resourceType: 'PRODUCT',
  resourceId: productId,
  contentType: 'image/webp',
  sizeBytes: '512',
  contentSha256: hash('d'),
  state: 'UPLOADED',
  expiresAt: '2030-03-17T17:46:40.000Z',
  method: 'PUT',
  uploadUrl: 'https://media.example.test/upload/product-image',
  headers: { 'x-upload-token': 'opaque-upload-token' },
  providerReferenceHash: hash('e'),
  writeOnce: true,
};

export const completedMediaAsset: MediaAssetProjection = {
  artifactVersion,
  assetId: hash('f'),
  uploadIntentId: mediaUploadIntent.uploadIntentId,
  ownerWallet: merchantWallet,
  purpose: mediaUploadIntent.purpose,
  resourceType: mediaUploadIntent.resourceType,
  resourceId: mediaUploadIntent.resourceId,
  contentType: mediaUploadIntent.contentType,
  sizeBytes: mediaUploadIntent.sizeBytes,
  contentSha256: mediaUploadIntent.contentSha256,
  providerEvidenceHash: hash('0'),
  objectVersionHash: hash('1'),
  createdAt: '2026-07-15T02:12:00.000Z',
};

export const mediaReadAccess: MediaReadAccessProjection = {
  artifactVersion,
  assetId: mediaAssetId,
  purpose: 'PRODUCT_IMAGE',
  resourceType: 'PRODUCT',
  resourceId: productId,
  contentType: 'image/webp',
  sizeBytes: '512',
  contentSha256: hash('d'),
  objectVersionHash: hash('1'),
  accessScope: 'PUBLIC',
  method: 'GET',
  readUrl: 'https://media.example.test/read/product-image',
  expiresAt: '2030-03-17T17:46:40.000Z',
  providerReferenceHash: hash('2'),
};

function hash(character: string) {
  return `0x${character.repeat(64)}`;
}

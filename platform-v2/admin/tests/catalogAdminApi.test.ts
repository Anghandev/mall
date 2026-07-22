import { artifactVersion, type AdminProductSlotInput, type ManagedCatalogProduct } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adjustAdminCatalogInventory,
  createAdminConcessionPreview,
  decideAdminProductReview,
  fetchAdminCatalogCategories,
  fetchAdminCatalogProducts,
  fetchAdminCatalogTags,
  fetchAdminProductSlot,
  fetchMediaReadAccess,
  saveAdminProductSlot,
  saveCatalogCategory,
  saveCatalogTag,
  submitAdminProductReview,
} from '../src/catalogAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('catalog/admin coordinated Core client', () => {
  it('reads categories, tags and all managed products with bearer authorization', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/admin/catalog/categories')) return jsonResponse({ categories: [category()] });
      if (url.endsWith('/v2/admin/catalog/tags')) return jsonResponse({ tags: [tag()] });
      if (url.endsWith('/v2/admin/catalog/products')) return jsonResponse({ products: [product()] });
      return jsonResponse({ error: { code: 'InvalidRequest', message: 'Unexpected', correlationId: 'test' } }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAdminCatalogCategories('jwt')).resolves.toMatchObject([{ categoryId: 'category-1', level: 1 }]);
    await expect(fetchAdminCatalogTags('jwt')).resolves.toMatchObject([{ tagId: 'tag-1' }]);
    await expect(fetchAdminCatalogProducts('jwt')).resolves.toMatchObject([{ productId: 'product-1', allowedActions: ['SAVE_DRAFT'] }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) expect(call[1]?.headers).toEqual({ authorization: 'Bearer jwt' });
  });

  it('rejects a managed product from a stale artifact version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ products: [{ ...product(), artifactVersion: '2.0.0-stale' }] })));
    await expect(fetchAdminCatalogProducts('jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('writes versioned categories and tags without inventing a service fee', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/admin/catalog/categories/category-1')) return jsonResponse(category({ version: '2', status: 'DISABLED' }));
      if (url.endsWith('/v2/admin/catalog/tags')) return jsonResponse(tag(), 201);
      return jsonResponse({}, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await saveCatalogCategory('category-1', { name: '黄金', sortOrder: 1, status: 'DISABLED', idempotencyKey: 'category-disable-1' }, 'jwt');
    await saveCatalogTag(null, { name: '新品', example: '新品上架', sortOrder: 2, idempotencyKey: 'tag-create-1' }, 'jwt');

    const categoryCall = fetchMock.mock.calls[0];
    expect(categoryCall?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String(categoryCall?.[1]?.body))).toEqual({ name: '黄金', sortOrder: 1, status: 'DISABLED', idempotencyKey: 'category-disable-1' });
    expect(String(categoryCall?.[1]?.body)).not.toContain('serviceFeeBps');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('sends explicit null when an existing category moves back to the root', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(category({ version: '2', parentCategoryId: null })));
    vi.stubGlobal('fetch', fetchMock);

    await saveCatalogCategory('category-child', {
      name: '纪念章',
      parentCategoryId: null,
      sortOrder: 3,
      idempotencyKey: 'category-move-root-1',
    }, 'jwt');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: '纪念章',
      parentCategoryId: null,
      sortOrder: 3,
      idempotencyKey: 'category-move-root-1',
    });
  });

  it('requires the authoritative store slot before saving the exact proxy product body', async () => {
    const input = productInput();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method) return jsonResponse({ artifactVersion, storeId: 'store-1', merchantId: 'merchant-1', product: null, allowedActions: ['SAVE_DRAFT'], writeLock: null });
      return jsonResponse(product(), 200);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAdminProductSlot('store-1', 'merchant-1', 'jwt')).resolves.toMatchObject({ allowedActions: ['SAVE_DRAFT'] });
    await expect(saveAdminProductSlot('store-1', input, 'jwt')).resolves.toMatchObject({ productId: 'product-1' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v2/admin/catalog/stores/store-1/product-slot?merchantId=merchant-1');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(input);
  });

  it('rejects proposed seckill inventory above total before reaching Core', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = productInput();
    input.skus[0]!.proposedSeckillInventory = 11;

    await expect(saveAdminProductSlot('store-1', input, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('consumes signed preview, submission, decision and inventory endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/concession-previews')) return jsonResponse(preview(), 201);
      if (url.endsWith('/review-submissions')) return jsonResponse(product({ lifecycleState: 'REVIEW', allowedActions: ['APPROVE', 'REJECT'] }), 201);
      if (url.endsWith('/review-decisions')) return jsonResponse(product({ lifecycleState: 'SCHEDULED', allowedActions: ['PUBLISH', 'REJECT'] }));
      if (url.endsWith('/inventory-adjustments')) return jsonResponse(adjustment(), 201);
      return jsonResponse({}, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAdminConcessionPreview('product-1', 2500, 'preview-key-1', 'jwt')).resolves.toMatchObject({ previewId: hash('a') });
    await expect(submitAdminProductReview('product-1', hash('a'), 'submit-key-1', 'jwt')).resolves.toMatchObject({ lifecycleState: 'REVIEW' });
    await expect(decideAdminProductReview('product-1', 'APPROVE', 'CATALOG_APPROVED', 'decision-key-1', 'jwt')).resolves.toMatchObject({ lifecycleState: 'SCHEDULED' });
    await expect(adjustAdminCatalogInventory('sku-1', '-2', 'STOCK_AUDIT', 'inventory-key-1', 'jwt')).resolves.toMatchObject({ afterAvailable: '8' });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ merchantConcessionBps: 2500, idempotencyKey: 'preview-key-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ previewId: hash('a'), idempotencyKey: 'submit-key-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ decision: 'APPROVE', reasonCode: 'CATALOG_APPROVED', idempotencyKey: 'decision-key-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ delta: '-2', reasonCode: 'STOCK_AUDIT', idempotencyKey: 'inventory-key-1' });
  });

  it('preserves the exact blockingResource from a ProductWriteLocked error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: 'ProductWriteLocked',
        message: 'Product is locked against catalog writes',
        correlationId: 'catalog-lock-1',
        details: { blockingResource: { type: 'ORDER', id: 'order-1', state: 'DISPUTED' } },
      },
    }, 409)));

    await expect(saveCatalogTag('tag-1', { name: '新品', sortOrder: 1, status: 'DISABLED', idempotencyKey: 'disable-tag-1' }, 'jwt')).rejects.toMatchObject({
      code: 'ProductWriteLocked',
      correlationId: 'catalog-lock-1',
      details: { blockingResource: { type: 'ORDER', id: 'order-1', state: 'DISPUTED' } },
    });
  });

  it('accepts purpose-bound controlled media and rejects a purpose/content mismatch', async () => {
    const valid = mediaAccess();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(valid))
      .mockResolvedValueOnce(jsonResponse({ ...valid, purpose: 'PRODUCT_IMAGE', contentType: 'video/mp4' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchMediaReadAccess(hash('7'), 'jwt')).resolves.toMatchObject({ purpose: 'PRODUCT_IMAGE', contentType: 'image/webp' });
    await expect(fetchMediaReadAccess(hash('7'), 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });
});

function category(overrides: Record<string, unknown> = {}) {
  return { categoryId: 'category-1', version: '1', parentCategoryId: null, level: 1, name: '黄金', iconAssetId: null, sortOrder: 1, status: 'ENABLED', serviceFee: { state: 'DecisionBlocked', valueBps: null }, ...overrides };
}

function tag(overrides: Record<string, unknown> = {}) {
  return { tagId: 'tag-1', version: '1', name: '新品', example: '新品上架', sortOrder: 1, status: 'ENABLED', ...overrides };
}

function product(overrides: Partial<ManagedCatalogProduct> = {}): ManagedCatalogProduct {
  return {
    artifactVersion, productId: 'product-1', chainProductId: hash('1'), merchantId: 'merchant-1', storeId: 'store-1', supersedesProductId: null,
    version: '1', title: '24K 金章', subtitle: '10g', lifecycleState: 'DRAFT', productPolicyHash: hash('2'), merchantConcessionBps: 2500,
    mainImageAssetIds: [hash('3')], videoAssetId: null, richDetail: {}, defaultFreightUsdt: '1000000', fulfillmentModes: ['DELIVERY'],
    categoryId: 'category-1', tagIds: ['tag-1'], skus: [{ skuId: 'sku-1', chainSkuId: hash('4'), version: '1', attributes: { weight: '10g' }, listPriceUsdt: '7200000000', merchantBaseReceivableUsdt: '7000000000', stockTotal: '10', stockAvailable: '10', stockReserved: '0', proposedSeckillInventory: '3', lifecycleState: 'DRAFT' }],
    allowedActions: ['SAVE_DRAFT'], writeLock: null, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', ...overrides,
  };
}

function productInput(): AdminProductSlotInput {
  return {
    merchantId: 'merchant-1', idempotencyKey: 'product-save-1', title: '24K 金章', richDetail: {}, defaultFreightUsdt: '1000000', merchantConcessionBps: 2500,
    fulfillmentModes: ['DELIVERY'], categoryId: 'category-1', tagIds: ['tag-1'], mainImageAssetIds: [hash('3')],
    skus: [{ attributes: { weight: '10g' }, listPriceUsdt: '7200000000', stockTotal: 10, proposedSeckillInventory: 3 }],
  };
}

function preview() {
  return {
    artifactVersion, previewId: hash('a'), productId: 'product-1', productVersion: '1', merchantId: 'merchant-1', policyVersion: '2', merchantConcessionBps: 2500,
    catalogFingerprint: hash('b'), destinationSetHash: hash('c'), previewHash: hash('d'),
    payload: { artifactVersion, productId: 'product-1', productVersion: 1, merchantId: 'merchant-1', policyVersion: 2, merchantConcessionBps: 2500, destinationSetHash: hash('c'), catalogFingerprint: hash('b'), items: [{ skuId: 'sku-1', merchantBaseReceivableUsdt: '7000000000', merchantConcessionBps: 2500, merchantConcessionAmount: '1750000000', merchantNetReceivableUsdt: '5250000000', allocations: [{ pool: 'SECKILL_PRIZE', amount: '1750000000', balanceState: 'LOCKED' }] }], expiresAt: '2026-07-15T00:05:00.000Z' },
    authorization: { domain: { name: 'Abu24KCatalog' }, types: { MerchantConcessionPreview: [] }, primaryType: 'MerchantConcessionPreview', message: { previewId: hash('a') }, digest: hash('e'), signature: '0xsigned', signer: address('2') },
    expiresAt: '2026-07-15T00:05:00.000Z', createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function adjustment() {
  return { artifactVersion, adjustmentId: hash('8'), skuId: 'sku-1', beforeTotal: '10', beforeAvailable: '10', delta: '-2', afterTotal: '8', afterAvailable: '8', reasonCode: 'STOCK_AUDIT', actorWallet: address('1'), createdAt: '2026-07-15T00:00:00.000Z' };
}

function mediaAccess() {
  return { artifactVersion, assetId: hash('7'), purpose: 'PRODUCT_IMAGE', resourceType: 'PRODUCT', resourceId: 'product-1', contentType: 'image/webp', sizeBytes: '1024', contentSha256: hash('8'), objectVersionHash: hash('9'), accessScope: 'AUTHENTICATED', method: 'GET', readUrl: 'https://media.example/product.webp', expiresAt: '2026-07-15T00:05:00.000Z', providerReferenceHash: hash('a') };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(value: string) { return `0x${value.repeat(64).slice(0, 64)}`; }
function address(value: string) { return `0x${value.repeat(40).slice(0, 40)}`; }

import {
  artifactVersion,
  type AdminGlobalSearchResponse,
  type AdminProductBatchTagResult,
  type AdminProductLifecycleBatchResult,
  type AdminResourceExport,
} from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchAddAdminProductTags,
  batchApplyAdminProductLifecycle,
  downloadAdminResourceExport,
  exportAdminGlobalResources,
  searchAdminGlobalResources,
} from '../src/adminGlobalOperationsApi';
import { CoreApiError } from '../src/coreApi';

afterEach(() => vi.unstubAllGlobals());

describe('Admin global operations API consumer', () => {
  it('serializes repeated resource types and exact AND filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(globalSearchResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchAdminGlobalResources({
      resourceTypes: ['ORDER', 'PRODUCT'],
      productId: 'product-1',
      merchantId: 'merchant-1',
      txHash: hash('a'),
      wallet: address('B'),
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
      pendingReview: true,
      limit: 100,
    }, 'jwt')).resolves.toMatchObject({ relation: 'AND', truncated: false });

    expect(fetchMock).toHaveBeenCalledWith(
      `/v2/admin/global/resources?resourceType=ORDER&resourceType=PRODUCT&relation=AND&productId=product-1&merchantId=merchant-1&txHash=${hash('a')}&wallet=${address('b')}&walletMatch=EXACT&from=2026-07-15T00%3A00%3A00.000Z&to=2026-07-16T00%3A00%3A00.000Z&pendingReview=true&limit=100`,
      expect.objectContaining({ headers: { authorization: 'Bearer jwt' } }),
    );
  });

  it('serializes OR and fuzzy wallet fragments and binds both response modes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(globalSearchResponse({ relation: 'OR', walletMatch: 'FUZZY' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchAdminGlobalResources({ relation: 'OR', wallet: 'AbCdEf', walletMatch: 'FUZZY' }, 'jwt'))
      .resolves.toMatchObject({ relation: 'OR', walletMatch: 'FUZZY' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('relation=OR');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('wallet=abcdef');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('walletMatch=FUZZY');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(globalSearchResponse({ relation: 'AND', walletMatch: 'FUZZY' }))));
    await expect(searchAdminGlobalResources({ relation: 'OR', wallet: 'abcdef', walletMatch: 'FUZZY' }, 'jwt'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('binds audited export content and downloads the returned bytes', async () => {
    const exported = resourceExport();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(exported, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportAdminGlobalResources({
      selection: [{ resourceType: 'PRODUCT', resourceId: 'product-1' }],
      format: 'CSV',
      idempotencyKey: 'export-request-1',
    }, 'jwt');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      selection: [{ resourceType: 'PRODUCT', resourceId: 'product-1' }],
      format: 'CSV',
      idempotencyKey: 'export-request-1',
    });
    const createObjectURL = vi.fn().mockReturnValue('blob:admin-export');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    downloadAdminResourceExport(result);

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:admin-export');
  });

  it('posts generated product/tag IDs and validates the versioned result', async () => {
    const result = batchTagResult();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(batchAddAdminProductTags({
      productIds: ['product-1'],
      tagIds: ['tag-1'],
      idempotencyKey: 'batch-tags-1',
    }, 'jwt')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/catalog/products/batch-tags', expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    }));
  });

  it('posts and validates one atomic product lifecycle batch', async () => {
    const result = lifecycleResult();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(batchApplyAdminProductLifecycle({
      action: 'HIDE',
      productIds: ['product-1'],
      reasonCode: 'OPERATIONS_HIDE',
      idempotencyKey: 'batch-lifecycle-1',
    }, 'jwt')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/v2/admin/catalog/products/batch-lifecycle', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'HIDE', productIds: ['product-1'], reasonCode: 'OPERATIONS_HIDE', idempotencyKey: 'batch-lifecycle-1' }),
    }));
  });

  it('rejects stale artifacts, invalid exact wallets and response/action drift', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...globalSearchResponse(), artifactVersion: 'stale' })));
    await expect(searchAdminGlobalResources({}, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });

    await expect(searchAdminGlobalResources({ wallet: '0x1234' }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });
    await expect(searchAdminGlobalResources({ wallet: '12345', walletMatch: 'FUZZY' }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...batchTagResult(), changedCount: 0 })));
    await expect(batchAddAdminProductTags({
      productIds: ['product-1'], tagIds: ['tag-1'], idempotencyKey: 'batch-tags-2',
    }, 'jwt')).rejects.toBeInstanceOf(CoreApiError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...lifecycleResult(), action: 'DELIST' })));
    await expect(batchApplyAdminProductLifecycle({
      action: 'HIDE', productIds: ['product-1'], reasonCode: 'OPERATIONS_HIDE', idempotencyKey: 'batch-lifecycle-2',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidResponse' });
    await expect(batchApplyAdminProductLifecycle({
      action: 'HIDE', productIds: ['product-1'], reasonCode: 'invalid reason', idempotencyKey: 'batch-lifecycle-3',
    }, 'jwt')).rejects.toMatchObject({ code: 'InvalidRequest' });
  });
});

function globalSearchResponse(overrides: Partial<AdminGlobalSearchResponse> = {}): AdminGlobalSearchResponse {
  return {
    artifactVersion,
    relation: 'AND',
    walletMatch: 'EXACT',
    resources: [{
      resourceType: 'PRODUCT',
      resourceId: 'product-1',
      title: '24K 金章',
      status: 'PUBLISHED',
      merchantId: 'merchant-1',
      productId: 'product-1',
      tagIds: ['tag-1'],
      allowedBatchActions: [
        { action: 'EXPORT_CSV', enabled: true },
        { action: 'EXPORT_EXCEL', enabled: true },
        { action: 'ADD_PRODUCT_TAGS', enabled: true },
      ],
      createdAt: '2026-07-15T00:00:00.000Z',
    }],
    truncated: false,
    unavailableFilters: ['UID', 'PHONE', 'YELLOW_QUEUE'],
    ...overrides,
  };
}

function lifecycleResult(): AdminProductLifecycleBatchResult {
  return {
    artifactVersion,
    operationId: hash('f'),
    action: 'HIDE',
    changedCount: 1,
    products: [{ productId: 'product-1', previousState: 'ACTIVE', state: 'HIDDEN' }],
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function resourceExport(): AdminResourceExport {
  const content = '\uFEFFresourceType,resourceId\r\n"PRODUCT","product-1"\r\n';
  return {
    artifactVersion,
    exportId: hash('e'),
    format: 'CSV',
    filename: 'abu24k-admin-resources.csv',
    mediaType: 'text/csv; charset=utf-8',
    rowCount: 1,
    byteLength: Buffer.byteLength(content),
    contentHash: hash('c'),
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function batchTagResult(): AdminProductBatchTagResult {
  return {
    artifactVersion,
    operationId: hash('d'),
    action: 'ADD_PRODUCT_TAGS',
    tagIds: ['tag-1'],
    changedCount: 1,
    products: [{ productId: 'product-1', previousVersion: '1', version: '2', addedTagIds: ['tag-1'] }],
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hash(character: string) { return `0x${character.repeat(64)}`; }
function address(character: string) { return `0x${character.repeat(40)}`; }

import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactVersion } from '@abu24k/core-artifacts';
import openApi from '@abu24k/core-artifacts/openapi';
import merchantOperations from 'virtual:merchant-store-operations';
import { createCoreApi, putMediaFile } from '../src/core-api';
import { merchantBusinessDashboard } from './business-dashboard-fixtures';
import { merchantAudit, merchantAuditExport, merchantProfile } from './account-fixtures';
import {
  catalogCategories,
  catalogTags,
  completedMediaAsset,
  concessionPreview,
  managedMerchantStore,
  managedProduct,
  mediaReadAccess,
  mediaUploadIntent,
  merchantStore,
  merchantWallet,
  productId,
  productSlot,
  storeId,
} from './catalog-fixtures';
import {
  deliveryOrder,
  deliveryOrderId,
  deliveryTarget,
  evidenceHash,
  merchantOrderExport,
  pickupOrder,
  pickupOrderId,
  pickupTarget,
  trackingNumberHash,
} from './fulfillment-fixtures';
import {
  cmsRules,
  guaranteeDepositResult,
  merchantFinance,
  merchantReceivableStatements,
  merchantReceivableStatementsNext,
  requestedSettlement,
  settlementIntent,
  settlementList,
} from './settlement-fixtures';
import {
  printerBinding,
  printerChallenge,
  waybillBatchResult,
  waybillPrintJob,
} from './logistics-fixtures';
import {
  fundedTakeoverCase,
  takeoverAssignment,
  takeoverCaseDetail,
  takeoverCaseList,
  takeoverTrackingEvidence,
} from './takeover-fixtures';

const originalFetch = globalThis.fetch;
const productHash = `0x${'a'.repeat(64)}`;
const skuHash = `0x${'b'.repeat(64)}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('settlement-admin.16 Core HTTP consumer', () => {
  it('does not expose Admin global operations, notifications or clearing commands', () => {
    const api = createCoreApi('https://core.example.test');
    const adminOnlyOperationIds = [
      'createGovernedSettlementIntent',
      'listAdminSettlementRequests',
      'getAdminSettlementRequest',
      'listAdminSettlementTransfers',
      'getAdminSettlementTransfer',
      'listCoverageBreakerActions',
      'createCoverageBreakerResumeChallenge',
      'authorizeCoverageBreakerResume',
      'batchApplyAdminProductLifecycle',
    ];
    const excludedNotificationOperationIds = [
      'registerNotificationEndpoint',
      'listNotifications',
      'listNotificationCampaigns',
      'createNotificationCampaign',
      'publishNotificationCampaign',
      'retryNotificationCampaignDeliveries',
    ];
    const publishedOperationIds = Object.values(openApi.paths).flatMap((path) => (
      Object.values(path as Record<string, { operationId?: string }>)
        .map((operation) => operation.operationId)
        .filter((operationId): operationId is string => Boolean(operationId))
    ));

    expect(api).not.toHaveProperty('searchAdminGlobalResources');
    expect(api).not.toHaveProperty('createAdminGlobalExport');
    expect(api).not.toHaveProperty('createAdminProductBatchTags');
    for (const operationId of adminOnlyOperationIds) {
      expect(publishedOperationIds).toContain(operationId);
      expect(api).not.toHaveProperty(operationId);
    }
    for (const operationId of excludedNotificationOperationIds) {
      expect(publishedOperationIds).toContain(operationId);
      expect(api).not.toHaveProperty(operationId);
    }
  });

  it('consumes assigned takeover cases, tracking evidence and shipment through published routes', async () => {
    const shipment = {
      orderId: deliveryOrderId,
      state: 'SHIPPED',
      shipmentId: 'replacement-shipment-1',
      carrierCode: 'SF',
      trackingNumberHash,
      recordedAt: '2026-07-16T02:06:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(takeoverCaseList))
      .mockResolvedValueOnce(jsonResponse(takeoverCaseDetail))
      .mockResolvedValueOnce(jsonResponse({ target: deliveryTarget }))
      .mockResolvedValueOnce(jsonResponse(takeoverTrackingEvidence, 201))
      .mockResolvedValueOnce(jsonResponse(shipment, 201));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');

    const listed = await api.listMerchantTakeoverCases('merchant-session', {
      state: 'FUNDED',
      cursor: takeoverCaseList.nextCursor!,
      limit: 25,
    });
    const detail = await api.getMerchantTakeoverCase(fundedTakeoverCase.caseId, 'merchant-session');
    const target = await api.getOrderFulfillmentTarget(fundedTakeoverCase.orderId, 'merchant-session');
    const evidenceInput = {
      carrierCode: 'SF' as const,
      trackingNumber: 'SF-REPLACEMENT-001',
      idempotencyKey: 'merchant-takeover-evidence-1',
    };
    const evidence = await api.createOrderTrackingEvidence(
      fundedTakeoverCase.orderId,
      evidenceInput,
      'merchant-session',
    );
    const shipmentInput = {
      carrierCode: 'SF',
      trackingNumberHash: evidence.trackingNumberHash!,
      evidenceHash: evidence.evidenceHash,
      idempotencyKey: 'merchant-takeover-shipment-1',
    };
    await expect(api.recordShipment(
      fundedTakeoverCase.orderId,
      shipmentInput,
      'merchant-session',
    )).resolves.toMatchObject({ shipmentId: 'replacement-shipment-1' });

    expect(listed.cases[0]?.currentAssignment).toEqual(takeoverAssignment);
    expect(detail.case.allowedActions).toEqual([{ action: 'RECORD_SHIPMENT', enabled: true }]);
    expect(target).toEqual(deliveryTarget);
    expect(evidence).toEqual(takeoverTrackingEvidence);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://core.example.test/v2/merchant/takeover-cases?state=FUNDED&cursorOpenedAt=${encodeURIComponent(takeoverCaseList.nextCursor!.openedAt)}&cursorCaseId=${takeoverCaseList.nextCursor!.caseId}&limit=25`,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, `https://core.example.test/v2/merchant/takeover-cases/${fundedTakeoverCase.caseId}`, expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, `https://core.example.test/v2/orders/${fundedTakeoverCase.orderId}/tracking-evidence`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(evidenceInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, `https://core.example.test/v2/orders/${fundedTakeoverCase.orderId}/shipments`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(shipmentInput),
    }));
  });

  it('rejects takeover details with another or historical replacement assignment', async () => {
    const api = createCoreApi();
    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...takeoverCaseDetail,
      assignments: [
        { ...takeoverAssignment, assignmentId: `0x${'1'.repeat(64)}`, version: 1 },
        takeoverAssignment,
      ],
    })) as typeof fetch;
    await expect(api.getMerchantTakeoverCase(fundedTakeoverCase.caseId, 'merchant-session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...takeoverCaseList,
      cases: [{
        ...fundedTakeoverCase,
        currentAssignment: { ...takeoverAssignment, orderId: `0x${'9'.repeat(64)}` },
      }],
    })) as typeof fetch;
    await expect(api.listMerchantTakeoverCases('merchant-session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('consumes the coordinated merchant store lifecycle routes with versioned commands', async () => {
    const draftStore = {
      ...managedMerchantStore,
      storeId: 'store-created-1',
      status: 'DRAFT' as const,
      imageAssetIds: [],
      allowedActions: [
        { action: 'UPDATE_PROFILE' as const, enabled: true },
        { action: 'ACTIVATE' as const, enabled: false, reasonCode: 'STORE_PROFILE_INCOMPLETE' as const },
        { action: 'CLOSE' as const, enabled: true },
      ],
    };
    const updatedStore = {
      ...draftStore,
      version: 2,
      imageAssetIds: [completedMediaAsset.assetId],
      allowedActions: [
        { action: 'UPDATE_PROFILE' as const, enabled: true },
        { action: 'ACTIVATE' as const, enabled: true },
        { action: 'CLOSE' as const, enabled: true },
      ],
    };
    const activatedStore = {
      ...updatedStore,
      status: 'ACTIVE' as const,
      version: 3,
      allowedActions: managedMerchantStore.allowedActions,
    };
    const closedStore = {
      ...activatedStore,
      status: 'CLOSED' as const,
      version: 4,
      allowedActions: [
        { action: 'UPDATE_PROFILE' as const, enabled: false, reasonCode: 'STORE_CLOSED' as const },
        { action: 'ACTIVATE' as const, enabled: false, reasonCode: 'STORE_CLOSED' as const },
        { action: 'CLOSE' as const, enabled: false, reasonCode: 'STORE_CLOSED' as const },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stores: [managedMerchantStore] }))
      .mockResolvedValueOnce(jsonResponse(draftStore, 201))
      .mockResolvedValueOnce(jsonResponse(updatedStore))
      .mockResolvedValueOnce(jsonResponse(activatedStore))
      .mockResolvedValueOnce(jsonResponse(closedStore));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const createInput = {
      idempotencyKey: 'merchant-store-create-1',
      name: '浦东黄金店',
      phone: '021-87654321',
      businessHours: '10:00-20:00',
      longitude: 121.506,
      latitude: 31.245,
    };
    const updateInput = {
      name: '浦东黄金旗舰店',
      phone: createInput.phone,
      businessHours: createInput.businessHours,
      imageAssetIds: [completedMediaAsset.assetId],
      expectedVersion: 1,
      idempotencyKey: 'merchant-store-update-1',
    };

    await expect(api.listManagedMerchantStores('merchant-session')).resolves.toEqual([managedMerchantStore]);
    await expect(api.createMerchantStore(createInput, 'merchant-session')).resolves.toEqual(draftStore);
    await expect(api.updateMerchantStore(draftStore.storeId, updateInput, 'merchant-session')).resolves.toEqual(updatedStore);
    await expect(api.activateMerchantStore(draftStore.storeId, {
      expectedVersion: 2,
      idempotencyKey: 'merchant-store-activate-1',
    }, 'merchant-session')).resolves.toEqual(activatedStore);
    await expect(api.closeMerchantStore(draftStore.storeId, {
      expectedVersion: 3,
      idempotencyKey: 'merchant-store-close-1',
    }, 'merchant-session')).resolves.toEqual(closedStore);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://core.example.test/v2/merchant/stores', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://core.example.test/v2/merchant/stores', expect.objectContaining({
      method: 'POST', body: JSON.stringify(createInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `https://core.example.test/v2/merchant/stores/${draftStore.storeId}`, expect.objectContaining({
      method: 'PUT', body: JSON.stringify(updateInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, `https://core.example.test/v2/merchant/stores/${draftStore.storeId}/activate`, expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, `https://core.example.test/v2/merchant/stores/${draftStore.storeId}/close`, expect.objectContaining({ method: 'POST' }));
  });

  it('fails closed on malformed managed store location and image projections', async () => {
    for (const malformed of [
      { ...managedMerchantStore, longitude: 181 },
      { ...managedMerchantStore, imageAssetIds: [completedMediaAsset.assetId, completedMediaAsset.assetId] },
    ]) {
      globalThis.fetch = vi.fn(async () => jsonResponse({ stores: [malformed] })) as typeof fetch;
      await expect(createCoreApi().listManagedMerchantStores('merchant-session'))
        .rejects.toMatchObject({ code: 'InvalidResponse' });
    }
  });

  it('consumes signed printer binding, provider waybill and durable print job routes', async () => {
    const acceptedJob = { ...waybillPrintJob, state: 'QUEUED' as const, attempts: 0, errorCode: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse(printerChallenge, 201))
      .mockResolvedValueOnce(jsonResponse(printerBinding))
      .mockResolvedValueOnce(jsonResponse(waybillBatchResult, 201))
      .mockResolvedValueOnce(jsonResponse([waybillPrintJob]))
      .mockResolvedValueOnce(jsonResponse(acceptedJob));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const challengeInput = {
      provider: 'FEIE' as const,
      deviceId: printerBinding.deviceId,
      idempotencyKey: 'printer-challenge-consumer-1',
    };
    const applyInput = {
      challengeId: printerChallenge.challengeId,
      signature: `0x${'12'.repeat(65)}`,
      idempotencyKey: 'printer-apply-consumer-1',
    };
    const waybillInput = {
      provider: 'KUAIDI100' as const,
      carrierCode: 'SF' as const,
      storeId,
      orderIds: [deliveryOrderId],
      idempotencyKey: 'waybill-batch-consumer-1',
    };

    await expect(api.getMerchantPrinterBinding(storeId, 'merchant-session')).resolves.toBeNull();
    await expect(api.createMerchantPrinterBindingChallenge(storeId, challengeInput, 'merchant-session'))
      .resolves.toEqual(printerChallenge);
    await expect(api.applyMerchantPrinterBinding(storeId, applyInput, 'merchant-session'))
      .resolves.toEqual(printerBinding);
    await expect(api.createMerchantWaybillBatch(waybillInput, 'merchant-session'))
      .resolves.toEqual(waybillBatchResult);
    await expect(api.listMerchantPrintJobs('merchant-session', 100)).resolves.toEqual([waybillPrintJob]);
    await expect(api.retryMerchantPrintJob(waybillPrintJob.printJobId, 'print-retry-consumer-1', 'merchant-session'))
      .resolves.toEqual(acceptedJob);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://core.example.test/v2/merchant/stores/${storeId}/printer-binding/challenge`,
      expect.objectContaining({ body: JSON.stringify(challengeInput) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `https://core.example.test/v2/merchant/stores/${storeId}/printer-binding`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(applyInput) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://core.example.test/v2/merchant/waybills/batches',
      expect.objectContaining({ body: JSON.stringify(waybillInput) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://core.example.test/v2/merchant/print-jobs?limit=100',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }) }),
    );
  });

  it('fails closed on an unknown logistics state and mismatched printer signer fields', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse([{ ...waybillPrintJob, state: 'PRINTED' }])) as typeof fetch;
    await expect(createCoreApi().listMerchantPrintJobs('merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...printerChallenge,
      typedData: {
        ...printerChallenge.typedData,
        message: { ...printerChallenge.typedData.message, provider: 'YILIANYUN' },
      },
    }, 201)) as typeof fetch;
    await expect(createCoreApi().createMerchantPrinterBindingChallenge(storeId, {
      provider: 'FEIE',
      deviceId: printerBinding.deviceId,
      idempotencyKey: 'printer-challenge-mismatch-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it.each([
    ['ConfigurationRequired', 503],
    ['InvalidRequest', 400],
  ] as const)('preserves Core %s rejection for a merchant waybill command', async (code, status) => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      error: {
        code,
        message: code === 'ConfigurationRequired'
          ? 'Waybill provider configuration is incomplete'
          : 'Carrier is disabled by the current platform configuration',
        details: {},
      },
    }, status, { 'x-correlation-id': `waybill-${code}` })) as typeof fetch;

    await expect(createCoreApi().createMerchantWaybillBatch({
      provider: 'KUAIDI100',
      carrierCode: 'SF',
      storeId,
      orderIds: [deliveryOrderId],
      idempotencyKey: `waybill-${code}`,
    }, 'merchant-session')).rejects.toMatchObject({
      code,
      correlationId: `waybill-${code}`,
      status,
    });
  });

  it('uses the published SIWE nonce and verify request bodies without a password fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: 'merchant.test wants you to sign in',
        nonce: 'one-use-nonce',
        issuedAt: '2026-07-14T12:00:00.000Z',
        expiresAt: '2026-07-14T12:05:00.000Z',
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        token: 'merchant-session',
        walletAddress: '0x1111111111111111111111111111111111111111',
        roles: ['MERCHANT'],
        merchantId: 'merchant-1',
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi();

    const challenge = await api.createSiweChallenge('0x1111111111111111111111111111111111111111');
    const session = await api.verifySiwe(challenge.message, '0xsigned');

    expect(session.roles).toEqual(['MERCHANT']);
    expect(session.merchantId).toBe('merchant-1');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/v2/auth/nonce', expect.objectContaining({
      body: JSON.stringify({ walletAddress: '0x1111111111111111111111111111111111111111' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/v2/auth/verify', expect.objectContaining({
      body: JSON.stringify({ message: challenge.message, signature: '0xsigned' }),
    }));
  });

  it('consumes versioned merchant profile and tenant audit routes with exact request fields', async () => {
    const updatedProfile = { ...merchantProfile, shopName: '阿步新金店', version: 4 };
    const cursor = { createdAt: '2026-07-15T09:30:00.000Z', entryId: 'audit-merchant-1' };
    const pagedAudit = { ...merchantAudit, nextCursor: cursor };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(merchantProfile))
      .mockResolvedValueOnce(jsonResponse(updatedProfile))
      .mockResolvedValueOnce(jsonResponse(pagedAudit))
      .mockResolvedValueOnce(jsonResponse(merchantAuditExport));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const update = {
      shopName: '阿步新金店',
      logoAssetId: merchantProfile.logoAssetId,
      expectedVersion: 3,
      idempotencyKey: 'merchant-profile-update-1',
    };

    expect((await api.getMerchantProfile('merchant-session')).settlementWalletMutable).toBe(false);
    expect((await api.updateMerchantProfile(update, 'merchant-session')).version).toBe(4);
    const audit = await api.listMerchantAuditEntries('merchant-session', {
      streamName: 'financial',
      eventType: 'SettlementRequestAuthorized',
      resourceType: 'SETTLEMENT_REQUEST',
      cursor,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T23:59:59.000Z',
      limit: 50,
    });
    const exported = await api.exportMerchantAuditEntries({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T23:59:59.000Z',
      streamName: 'financial',
      eventType: 'SettlementRequestAuthorized',
      resourceType: 'SETTLEMENT_REQUEST',
      idempotencyKey: 'merchant-audit-export-1',
    }, 'merchant-session');

    expect(audit.historyStatus).toBe('PARTIAL_PRE_MERCHANT_SCOPE');
    expect(exported.merchantId).toBe('merchant-1');
    expect(exported.csv).toBe(merchantAuditExport.csv);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://core.example.test/v2/merchant/profile', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://core.example.test/v2/merchant/profile', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(update),
    }));
    const profileBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body));
    expect(Object.keys(profileBody).sort()).toEqual([
      'expectedVersion', 'idempotencyKey', 'logoAssetId', 'shopName',
    ]);
    expect(profileBody).not.toHaveProperty('qualificationStatus');
    expect(profileBody).not.toHaveProperty('businessLicense');
    const auditUrl = String(fetchMock.mock.calls[2]?.[0]);
    expect(auditUrl).toContain('/v2/merchant/audit/entries?');
    expect(auditUrl).toContain('streamName=financial');
    expect(auditUrl).toContain('cursorEntryId=audit-merchant-1');
    expect(auditUrl).toContain('limit=50');
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://core.example.test/v2/merchant/audit/exports', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-15T23:59:59.000Z',
        streamName: 'financial',
        eventType: 'SettlementRequestAuthorized',
        resourceType: 'SETTLEMENT_REQUEST',
        idempotencyKey: 'merchant-audit-export-1',
      }),
    }));
  });

  it('consumes the coordinated merchant order export operation with an exact DTO', async () => {
    const input = {
      from: merchantOrderExport.filters.from,
      to: merchantOrderExport.filters.to,
      skuId: merchantOrderExport.filters.skuId!,
      state: merchantOrderExport.filters.state!,
      fulfillmentMode: merchantOrderExport.filters.fulfillmentMode!,
      orderKind: merchantOrderExport.filters.orderKind!,
      limit: 1_000,
      idempotencyKey: 'merchant-order-export-1',
    };
    const fetchMock = vi.fn(async () => jsonResponse(merchantOrderExport));
    globalThis.fetch = fetchMock as typeof fetch;

    const exported = await createCoreApi('https://core.example.test').exportMerchantOrders(
      input,
      'merchant-session',
    );

    const artifactPath = Object.entries(openApi.paths).find(([, entry]) => (
      (entry as { post?: { operationId?: string } }).post?.operationId === 'exportMerchantOrders'
    ))?.[0];
    expect(artifactPath).toBe('/v2/merchant/orders/exports');
    expect(merchantOperations.exportOrders).toBe(artifactPath);
    expect(exported).toEqual(merchantOrderExport);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://core.example.test${merchantOperations.exportOrders}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
        headers: expect.objectContaining({
          authorization: 'Bearer merchant-session',
          'x-abu-artifact-version': artifactVersion,
        }),
      }),
    );
  });

  it('rejects malformed merchant order export metadata, content and cursor fields', async () => {
    const input = { idempotencyKey: 'merchant-order-export-invalid' };
    const api = createCoreApi();
    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantOrderExport,
      filename: '../merchant-orders.xls',
    })) as typeof fetch;
    await expect(api.exportMerchantOrders(input, 'merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantOrderExport,
      contentBase64: 'not base64',
    })) as typeof fetch;
    await expect(api.exportMerchantOrders(input, 'merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantOrderExport,
      filters: { ...merchantOrderExport.filters, cursorCreatedAt: merchantOrderExport.filters.from },
    })) as typeof fetch;
    await expect(api.exportMerchantOrders(input, 'merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('rejects mutable settlement identity, wrong audit order and unsafe export metadata', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantProfile,
      settlementWalletMutable: true,
    })) as typeof fetch;
    await expect(createCoreApi().getMerchantProfile('merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantAudit,
      entries: [...merchantAudit.entries].reverse(),
    })) as typeof fetch;
    await expect(createCoreApi().listMerchantAuditEntries('merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantAuditExport,
      filename: '../merchant-audit.csv',
    })) as typeof fetch;
    await expect(createCoreApi().exportMerchantAuditEntries({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
      idempotencyKey: 'merchant-audit-export-2',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });

    const { merchantId: _merchantId, ...unscopedExport } = merchantAuditExport;
    globalThis.fetch = vi.fn(async () => jsonResponse(unscopedExport)) as typeof fetch;
    await expect(createCoreApi().exportMerchantAuditEntries({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
      idempotencyKey: 'merchant-audit-export-3',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('calls the official Catalog endpoint and validates generated product fields', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      products: [{
        productId: 'product-consumer',
        chainProductId: productHash,
        title: '核验商品',
        subtitle: '公开商品副标题',
        metadata: {},
        mainImageAssetIds: [productHash],
        videoAssetId: null,
        richDetail: { blocks: [] },
        defaultFreightUsdt: '0',
        fulfillmentModes: ['DELIVERY', 'PICKUP'],
        categoryId: 'category-gold',
        tagIds: ['tag-24k'],
        skus: [{
          skuId: 'sku-consumer',
          chainSkuId: skuHash,
          attributes: { size: 'standard' },
          listPriceUsdt: '1000000000000000000',
          stockAvailable: '7',
          seckill: null,
        }],
      }],
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const products = await createCoreApi('https://core.example.test/').listCatalog();

    expect(products[0]?.skus[0]?.stockAvailable).toBe('7');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example.test/v2/catalog/products',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-abu-artifact-version': artifactVersion }),
      }),
    );
  });

  it('consumes the merchant-bound product slot, signed preview and review lifecycle routes', async () => {
    const reviewed = {
      ...managedProduct,
      lifecycleState: 'REVIEW',
      allowedActions: [],
      writeLock: { type: 'PRODUCT_STATE', id: productId, state: 'REVIEW' },
    } as const;
    const delisted = { ...managedProduct, lifecycleState: 'DELISTED', allowedActions: [], writeLock: null } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ categories: catalogCategories }))
      .mockResolvedValueOnce(jsonResponse({ tags: catalogTags }))
      .mockResolvedValueOnce(jsonResponse({ stores: [merchantStore] }))
      .mockResolvedValueOnce(jsonResponse(productSlot))
      .mockResolvedValueOnce(jsonResponse(managedProduct))
      .mockResolvedValueOnce(jsonResponse(concessionPreview, 201))
      .mockResolvedValueOnce(jsonResponse(reviewed, 201))
      .mockResolvedValueOnce(jsonResponse(delisted));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const saveInput = {
      idempotencyKey: 'merchant-product-save-1',
      title: managedProduct.title,
      subtitle: managedProduct.subtitle,
      mainImageAssetIds: managedProduct.mainImageAssetIds,
      videoAssetId: managedProduct.videoAssetId!,
      richDetail: managedProduct.richDetail,
      defaultFreightUsdt: managedProduct.defaultFreightUsdt,
      merchantConcessionBps: managedProduct.merchantConcessionBps,
      fulfillmentModes: managedProduct.fulfillmentModes,
      categoryId: managedProduct.categoryId!,
      tagIds: managedProduct.tagIds,
      skus: managedProduct.skus.map((sku) => ({
        skuId: sku.skuId,
        attributes: sku.attributes,
        listPriceUsdt: sku.listPriceUsdt,
        stockTotal: Number(sku.stockTotal),
        proposedSeckillInventory: Number(sku.proposedSeckillInventory),
      })),
    };

    expect((await api.listCatalogCategories())[0]?.serviceFee.state).toBe('DecisionBlocked');
    expect((await api.listCatalogTags())[0]?.tagId).toBe('tag-24k');
    expect((await api.listMerchantStores())[0]?.merchantId).toBe('merchant-1');
    expect((await api.getMerchantProductSlot(storeId, 'merchant-session')).product?.supersedesProductId)
      .toBe('product-history-1');
    expect((await api.saveMerchantProductSlot(storeId, saveInput, 'merchant-session')).skus[0]?.stockAvailable)
      .toBe('17');
    expect((await api.createMerchantConcessionPreview(productId, {
      merchantConcessionBps: 2500,
      idempotencyKey: 'merchant-preview-1',
    }, 'merchant-session')).payload.items[0]?.merchantNetReceivableUsdt).toBe('518');
    expect((await api.submitMerchantProductReview(productId, {
      previewId: concessionPreview.previewId,
      idempotencyKey: 'merchant-review-1',
    }, 'merchant-session')).lifecycleState).toBe('REVIEW');
    expect((await api.delistMerchantProduct(productId, {
      reasonCode: 'MERCHANT_REQUEST',
      idempotencyKey: 'merchant-delist-1',
    }, 'merchant-session')).lifecycleState).toBe('DELISTED');

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `https://core.example.test/v2/merchant/stores/${storeId}/product-slot`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      `https://core.example.test/v2/merchant/stores/${storeId}/product-slot`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(saveInput) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      `https://core.example.test/v2/merchant/products/${productId}/concession-previews`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      `https://core.example.test/v2/merchant/products/${productId}/review-submissions`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('validates the coordinated media intent, uploads only to its target and completes controlled read access', async () => {
    const createdAccess = { ...mediaReadAccess, assetId: completedMediaAsset.assetId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(mediaUploadIntent, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(completedMediaAsset))
      .mockResolvedValueOnce(jsonResponse(createdAccess));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const request = {
      purpose: 'PRODUCT_IMAGE' as const,
      resourceType: 'PRODUCT' as const,
      resourceId: productId,
      contentType: 'image/webp' as const,
      sizeBytes: 512,
      contentSha256: mediaUploadIntent.contentSha256,
      idempotencyKey: 'merchant-media-upload-1',
    };
    const file = new File([new Uint8Array(512)], 'product.webp', { type: 'image/webp' });

    const intent = await api.createMediaUploadIntent(request, 'merchant-session', merchantWallet);
    await putMediaFile(intent, file);
    const asset = await api.completeMediaUpload(intent, 'merchant-session');
    const access = await api.getMediaReadAccess(asset.assetId, 'merchant-session', {
      purpose: 'PRODUCT_IMAGE',
      resourceType: 'PRODUCT',
      resourceId: productId,
    });

    expect(access.readUrl).toBe(createdAccess.readUrl);
    expect(fetchMock).toHaveBeenNthCalledWith(2, mediaUploadIntent.uploadUrl, expect.objectContaining({
      method: 'PUT',
      body: file,
      headers: expect.any(Headers),
    }));
    const providerOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(providerOptions.headers).has('authorization')).toBe(false);
    expect(new Headers(providerOptions.headers).has('x-abu-artifact-version')).toBe(false);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `https://core.example.test/v2/media/upload-intents/${mediaUploadIntent.uploadIntentId}/complete`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('rejects a concession authorization whose EIP-712 identity no longer binds the preview', async () => {
    const malformed = structuredClone(concessionPreview) as unknown as {
      authorization: { message: Record<string, unknown> };
    };
    malformed.authorization.message.previewId = productHash;
    globalThis.fetch = vi.fn(async () => jsonResponse(malformed, 201)) as typeof fetch;

    await expect(createCoreApi().createMerchantConcessionPreview(productId, {
      merchantConcessionBps: 2500,
      idempotencyKey: 'merchant-preview-invalid-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('sends the bearer session only to the published order-action endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      allowedActions: [{ action: 'RECORD_SHIPMENT', enabled: false, reasonCode: 'ConfigurationRequired' }],
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const actions = await createCoreApi().getOrderAllowedActions('order-1', 'session-token');

    expect(actions).toEqual([{ action: 'RECORD_SHIPMENT', enabled: false, reasonCode: 'ConfigurationRequired' }]);
    expect(fetchMock).toHaveBeenCalledWith('/v2/actions/order', expect.objectContaining({
      body: JSON.stringify({ orderId: 'order-1' }),
      headers: expect.objectContaining({ authorization: 'Bearer session-token' }),
    }));
  });

  it('reads the stable filtered order page, complete rows and immutable target snapshots', async () => {
    const nextCursor = { createdAt: '2026-07-01T07:59:00.000Z', orderId: deliveryOrderId };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ orders: [deliveryOrder, pickupOrder], nextCursor }))
      .mockResolvedValueOnce(jsonResponse({ target: pickupTarget }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');

    const page = await api.listFulfillmentOrders('merchant-session', {
      cursor: { createdAt: '2026-07-02T00:00:00.000Z', orderId: pickupOrderId },
      limit: 20,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
      skuId: 'sku-delivery',
      state: 'DELIVERED',
      fulfillmentMode: 'DELIVERY',
      orderKind: 'SECKILL',
    });
    const target = await api.getOrderFulfillmentTarget(pickupOrderId, 'merchant-session');

    expect(page.orders.map((order) => [
      order.orderId,
      order.quantity,
      order.orderKind,
      order.paymentTxHash,
      order.allowedActions[0]?.action,
    ])).toEqual([
      [deliveryOrderId, '2', 'SECKILL', deliveryOrder.paymentTxHash, 'REQUEST_FORCED_RECEIPT'],
      [pickupOrderId, '2', 'SECKILL', pickupOrder.paymentTxHash, 'VERIFY_PICKUP'],
    ]);
    expect(page.nextCursor).toEqual(nextCursor);
    expect(target).toEqual(pickupTarget);
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('https://core.example.test/v2/orders?'), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(Object.fromEntries(new URL(requestUrl).searchParams)).toMatchObject({
      cursorCreatedAt: '2026-07-02T00:00:00.000Z',
      cursorOrderId: pickupOrderId,
      limit: '20',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
      skuId: 'sku-delivery',
      state: 'DELIVERED',
      fulfillmentMode: 'DELIVERY',
      orderKind: 'SECKILL',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://core.example.test/v2/orders/${pickupOrderId}/fulfillment-target`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }) }),
    );
  });

  it('submits one atomic manual-shipment batch and validates every authoritative result', async () => {
    const batchId = `0x${'8'.repeat(64)}`;
    const input = {
      idempotencyKey: 'shipment-batch-command-key',
      items: [{
        orderId: deliveryOrderId,
        idempotencyKey: 'shipment-batch-item-key',
        evidenceHash,
        carrierCode: 'SF' as const,
        trackingNumberHash,
      }],
    };
    const fetchMock = vi.fn(async () => jsonResponse({
      batchId,
      shipments: [{
        orderId: deliveryOrderId,
        state: 'SHIPPED',
        shipmentId: 'shipment-batch-result-1',
        carrierCode: 'SF',
        trackingNumberHash,
        recordedAt: '2026-07-14T12:10:00.000Z',
      }],
      createdAt: '2026-07-14T12:10:00.000Z',
    }, 201));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await createCoreApi().recordShipmentBatch(input, 'merchant-session');

    expect(result).toMatchObject({ batchId, shipments: [{ orderId: deliveryOrderId, state: 'SHIPPED' }] });
    expect(fetchMock).toHaveBeenCalledWith('/v2/shipments/batches', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(input),
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
  });

  it('submits the three published merchant fulfillment commands with exact generated bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        orderId: deliveryOrderId,
        state: 'SHIPPED',
        shipmentId: 'shipment-command-1',
        carrierCode: 'SF_EXPRESS',
        trackingNumberHash,
        recordedAt: '2026-07-14T12:00:00.000Z',
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        orderId: deliveryOrderId,
        requestId: 'forced-request-1',
        state: 'OPEN',
        platformReviewRequired: true,
        canFinalizeDirectly: false,
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        orderId: pickupOrderId,
        state: 'FULFILLED',
        method: 'PICKUP_VERIFICATION',
        fulfilledAt: '2026-07-14T12:05:00.000Z',
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi();
    const shipment = {
      idempotencyKey: 'shipment-command-key',
      evidenceHash,
      carrierCode: 'SF_EXPRESS',
      trackingNumberHash,
    };
    const receipt = {
      idempotencyKey: 'receipt-command-key',
      evidenceHash,
      reasonCode: 'DELIVERED_REVIEW',
    };
    const pickup = {
      idempotencyKey: 'pickup-command-key',
      evidenceHash,
      code: '123456',
      storeId: pickupTarget.storeId,
    };

    expect(await api.recordShipment(deliveryOrderId, shipment, 'merchant-session')).toMatchObject({ state: 'SHIPPED' });
    expect(await api.requestForcedReceipt(deliveryOrderId, receipt, 'merchant-session')).toMatchObject({
      platformReviewRequired: true,
      canFinalizeDirectly: false,
    });
    expect(await api.verifyPickup(pickupOrderId, pickup, 'merchant-session')).toMatchObject({
      state: 'FULFILLED',
      method: 'PICKUP_VERIFICATION',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/v2/orders/${deliveryOrderId}/shipments`, expect.objectContaining({
      body: JSON.stringify(shipment),
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/v2/orders/${deliveryOrderId}/forced-receipt-requests`, expect.objectContaining({
      body: JSON.stringify(receipt),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/v2/orders/${pickupOrderId}/pickup-verification`, expect.objectContaining({
      body: JSON.stringify(pickup),
    }));
  });

  it('rejects an unknown order state instead of trusting an uncoordinated projection', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      orders: [{ ...deliveryOrder, state: 'REFUNDED' }],
      nextCursor: null,
    })) as typeof fetch;

    await expect(createCoreApi().listFulfillmentOrders('merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('preserves each order artifact snapshot instead of rewriting it to the consumer version', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      orders: [{ ...deliveryOrder, artifactVersion: 'order-snapshot-version' }],
      nextCursor: null,
    })) as typeof fetch;

    const page = await createCoreApi().listFulfillmentOrders('merchant-session');

    expect(page.orders[0]?.artifactVersion).toBe('order-snapshot-version');
  });

  it('rejects an artifact mismatch before the workspace trusts readiness', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      artifactVersion: '2.0.0-stale',
      status: 'CORE_API_READY',
      readiness: {},
    })) as typeof fetch;

    await expect(createCoreApi().bootstrap()).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('consumes the published merchant finance, guarantee and signed settlement routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(merchantFinance))
      .mockResolvedValueOnce(jsonResponse(settlementList))
      .mockResolvedValueOnce(jsonResponse(settlementIntent, 201))
      .mockResolvedValueOnce(jsonResponse(requestedSettlement, 201))
      .mockResolvedValueOnce(jsonResponse(guaranteeDepositResult, 201));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    const settlementInput = {
      rail: 'MERCHANT_USDT' as const,
      amount: '45000000000000000000',
      idempotencyKey: 'merchant-settlement-consumer-1',
    };
    const requestInput = { intentId: settlementIntent.intent.intentId, signature: `0x${'12'.repeat(65)}` };
    const depositInput = {
      policyVersion: '9',
      expectedAmountUsdt: '1000000000000000000000',
      transactionHash: guaranteeDepositResult.transactionHash,
      idempotencyKey: 'merchant-guarantee-consumer-1',
    };

    expect(await api.getMerchantFinance('merchant-session')).toMatchObject({
      merchant: { guarantee_status: 'READY' },
      allowedActions: ['REQUEST_MERCHANT_USDT'],
      settlementEligibility: { mode: 'FORMAL', expiresAt: null },
    });
    const settlements = await api.listSettlements('merchant-session');
    expect(settlements.requests[2]?.final_execution_tx_hashes).toEqual(
      settlementList.requests[2]?.final_execution_tx_hashes,
    );
    expect(settlements.balances.filter((balance) => balance.asset === 'NPL').map((balance) => balance.rewardSubtype))
      .toEqual(['GENESIS', 'DIRECT_REFERRAL', 'DISTRICT', 'CITY', 'PROVINCE', 'REGION', 'OPERATIONS', 'ROUNDING_REMAINDER']);
    expect(settlements.points).toEqual([
      { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'LOCKED', amount: '8800', transferable: false },
      { pointsType: 'BNM', purpose: 'BNM_LIABILITY', state: 'AVAILABLE', amount: '3600', transferable: false },
    ]);
    expect((await api.createSettlementIntent(settlementInput, 'merchant-session')).typedData)
      .toEqual(settlementIntent.typedData);
    expect((await api.submitSettlementRequest(requestInput, 'merchant-session')).state).toBe('REQUESTED');
    expect((await api.submitGuaranteeDeposit(depositInput, 'merchant-session')).state).toBe('SUBMITTED');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://core.example.test/v2/finance/merchant', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://core.example.test/v2/settlements', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://core.example.test/v2/settlement-intents', expect.objectContaining({
      body: JSON.stringify(settlementInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://core.example.test/v2/settlement-requests', expect.objectContaining({
      body: JSON.stringify(requestInput),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'https://core.example.test/v2/finance/merchant/guarantee-deposits',
      expect.objectContaining({ body: JSON.stringify(depositInput) }),
    );
  });

  it('fails closed on unknown merchant finance actions and eligibility modes', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...merchantFinance, allowedActions: ['UNKNOWN_ACTION'] }))
      .mockResolvedValueOnce(jsonResponse({
        ...merchantFinance,
        settlementEligibility: { mode: 'UNKNOWN_MODE', expiresAt: null },
      })) as typeof fetch;
    const api = createCoreApi('https://core.example.test');
    await expect(api.getMerchantFinance('merchant-session')).rejects.toThrow(/allowedActions item/);
    await expect(api.getMerchantFinance('merchant-session')).rejects.toThrow(/settlementEligibility.mode/);
  });

  it('consumes strict merchant receivable statements with the paired stable cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(merchantReceivableStatements))
      .mockResolvedValueOnce(jsonResponse(merchantReceivableStatementsNext));
    globalThis.fetch = fetchMock as typeof fetch;
    const api = createCoreApi('https://core.example.test');

    const firstPage = await api.listMerchantReceivableStatements('merchant-session', {
      kind: 'SECKILL',
      limit: 20,
    });
    const nextPage = await api.listMerchantReceivableStatements('merchant-session', {
      cursor: firstPage.nextCursor!,
      limit: 20,
    });

    expect(firstPage.statements[0]).toMatchObject({
      orderKind: 'SECKILL',
      frozenAmounts: {
        productUsdtPaymentAmount: '8400',
        platformServiceFeeUsdt: '120',
        custodyProductUsdt: '8280',
        freightUsdt: '500',
        merchantBaseReceivableUsdt: '8280',
        merchantConcessionAmount: '828',
        merchantNetReceivableUsdt: '7452',
      },
      currentReceivableUsdt: '0',
      removedFromReceivableUsdt: '7952',
    });
    expect(firstPage.statements[0]?.journalEvidence[0]?.journalId).toBe('journal:a:lifecycle');
    expect(firstPage.statements[0]?.settlementRefs[0]?.finalExecutionTxHash).toBe(`0x${'b'.repeat(64)}`);
    expect(nextPage.statements[0]?.orderKind).toBe('FALLBACK_RETAIL');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://core.example.test/v2/merchant/receivable-statements?kind=SECKILL&limit=20',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://core.example.test/v2/merchant/receivable-statements?cursorCreatedAt=${encodeURIComponent(firstPage.nextCursor!.createdAt)}&cursorOrderId=${firstPage.nextCursor!.orderId}&limit=20`,
      expect.any(Object),
    );
  });

  it('consumes the merchant business dashboard without deriving amounts or queue counts', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(merchantBusinessDashboard));
    globalThis.fetch = fetchMock as typeof fetch;

    const dashboard = await createCoreApi('https://core.example.test').getMerchantBusinessDashboard('merchant-session');

    expect(dashboard).toEqual(merchantBusinessDashboard);
    expect(dashboard.sales.merchantNetReceivableUsdt).toBe('3600000000000000000000');
    expect(dashboard.orders.pendingShipment).toBe('3');
    expect(dashboard.shipmentRate.bps).toBe('5000');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example.test/v2/merchant/dashboard',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
      }),
    );
  });

  it('fails closed on malformed dashboard amounts, timezones and unknown states', async () => {
    const invalidAmount = structuredClone(merchantBusinessDashboard) as unknown as {
      sales: Record<string, unknown>;
    };
    invalidAmount.sales.listPriceUsdt = '8.5';
    globalThis.fetch = vi.fn(async () => jsonResponse(invalidAmount)) as typeof fetch;
    await expect(createCoreApi().getMerchantBusinessDashboard('merchant-session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantBusinessDashboard,
      timezone: 'UTC',
    })) as typeof fetch;
    await expect(createCoreApi().getMerchantBusinessDashboard('merchant-session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });

    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...merchantBusinessDashboard,
      product: { ...merchantBusinessDashboard.product, state: 'LIVE' },
    })) as typeof fetch;
    await expect(createCoreApi().getMerchantBusinessDashboard('merchant-session'))
      .rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('rejects unknown reward subtypes and transferable BNM projections', async () => {
    const unknownSubtype = structuredClone(settlementList) as unknown as {
      balances: Array<Record<string, unknown>>;
    };
    unknownSubtype.balances[5]!.rewardSubtype = 'AFFILIATE';
    globalThis.fetch = vi.fn(async () => jsonResponse(unknownSubtype)) as typeof fetch;
    await expect(createCoreApi().listSettlements('merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });

    const transferablePoints = structuredClone(settlementList) as unknown as {
      points: Array<Record<string, unknown>>;
    };
    transferablePoints.points[0]!.transferable = true;
    globalThis.fetch = vi.fn(async () => jsonResponse(transferablePoints)) as typeof fetch;
    await expect(createCoreApi().listSettlements('merchant-session')).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });

  it('refuses to sign a settlement typed-data message that differs from the immutable intent', async () => {
    const malformed = structuredClone(settlementIntent);
    (malformed.typedData.message as Record<string, unknown>).amount = '1';
    globalThis.fetch = vi.fn(async () => jsonResponse(malformed, 201)) as typeof fetch;

    await expect(createCoreApi().createSettlementIntent({
      rail: 'MERCHANT_USDT',
      amount: settlementIntent.intent.amount,
      idempotencyKey: 'merchant-settlement-malformed-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('rejects unknown guarantee finality states instead of presenting a false success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      ...guaranteeDepositResult,
      state: 'CONFIRMED_ENOUGH',
    }, 201)) as typeof fetch;

    await expect(createCoreApi().submitGuaranteeDeposit({
      policyVersion: '9',
      expectedAmountUsdt: '1',
      transactionHash: guaranteeDepositResult.transactionHash,
      idempotencyKey: 'merchant-guarantee-invalid-state-1',
    }, 'merchant-session')).rejects.toMatchObject({ code: 'InvalidResponse' });
  });

  it('reads authenticated published CMS rules without caller-supplied identity queries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([cmsRules]));
    globalThis.fetch = fetchMock as typeof fetch;

    const items = await createCoreApi('https://core.example.test').listPublicCms('merchant-session');

    expect(items).toEqual([cmsRules]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example.test/v2/cms/public',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer merchant-session' }),
      }),
    );
  });

  it('preserves a typed Core error and correlation ID', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      error: {
        code: 'ProductWriteLocked',
        message: 'Product is locked by an active reservation',
        details: { blockingResource: { type: 'RESERVATION', id: 'reservation-7', state: 'ACTIVE' } },
        correlationId: 'body-correlation',
      },
    }, 409, { 'x-correlation-id': 'header-correlation' })) as typeof fetch;

    await expect(createCoreApi().createSiweChallenge('0x1111111111111111111111111111111111111111'))
      .rejects.toMatchObject({
        code: 'ProductWriteLocked',
        correlationId: 'header-correlation',
        blockingResource: { type: 'RESERVATION', id: 'reservation-7', state: 'ACTIVE' },
      });
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

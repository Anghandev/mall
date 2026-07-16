import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Interface, TypedDataEncoder } from 'ethers';
import * as ts from 'typescript';
import {
  artifactVersion,
  executableOrderActionNames,
  settlementRails,
} from '../../../packages/core-artifacts/generated/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactsRoot = join(repoRoot, 'packages/core-artifacts');
const manifest = readJson('coordinated-manifest.json');
const openapi = readJson('openapi/openapi.json');
const websocket = readJson('websocket-protocol.json');
const enums = readJson('state-error-enums.json');
const abiBundle = readJson('contracts/abi-bundle.json');
const contractManifest = readJson('contracts/contract-manifest.json');
const schemaManifest = readJson('schema/schema-manifest.json');
const declarations = readFileSync(join(artifactsRoot, 'generated/index.d.ts'), 'utf8');

test('settlement admin .15 checkpoint has one identity, resolvable exports and exact checksums', () => {
  assert.equal(artifactVersion, '2.0.0-settlement-admin.15');
  for (const document of [manifest, websocket, enums, abiBundle, contractManifest, schemaManifest]) {
    assert.equal(document.artifactVersion, artifactVersion);
  }
  assert.equal(openapi['x-artifactVersion'], artifactVersion);
  assert.equal(manifest.publicationStatus, 'COORDINATED_SETTLEMENT_ADMIN_CHECKPOINT');
  assert.equal(contractManifest.publicationStatus, 'coordinated-settlement-admin-checkpoint');
  assert.ok(manifest.decisionBlocked.includes('SECKILL_PRIZE_POOL_ACCOUNT'));
  assert.deepEqual(
    manifest.consumerTests.map((item: { path: string }) => item.path),
    ['platform-v2/server/api/api.test.ts', 'platform-v2/test/consumer/core-artifacts.test.ts'],
  );
  for (const item of manifest.consumerTests as Array<{ path: string; sha256: string }>) {
    assert.equal(sha256(readFileSync(join(repoRoot, item.path))), item.sha256, item.path);
  }

  const packageJson = readJson('package.json');
  assert.equal(packageJson.version, artifactVersion);
  for (const target of Object.values(packageJson.exports).flatMap(exportTargets)) {
    assert.doesNotThrow(() => readFileSync(join(artifactsRoot, target)));
  }
  for (const line of readFileSync(join(artifactsRoot, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    assert.ok(match, line);
    assert.equal(sha256(readFileSync(join(artifactsRoot, match[2]!))), match[1], match[2]);
  }
  assert.equal(schemaManifest.formatVersion, 1);
  assert.equal(schemaManifest.databaseEngine, 'postgresql');
  assert.equal(schemaManifest.schemas.core.migrationTable, 'core.schema_migrations');
  assert.equal(schemaManifest.schemas.audit.migrationTable, 'audit.schema_migrations');
  assert.equal(schemaManifest.schemas.core.migrations.length, 27);
  assert.equal(schemaManifest.schemas.audit.migrations.length, 4);
  for (const migration of [
    ...schemaManifest.schemas.core.migrations,
    ...schemaManifest.schemas.audit.migrations,
  ] as Array<{ path: string; sha256: string }>) {
    const artifact = readFileSync(join(artifactsRoot, migration.path));
    const source = readFileSync(join(repoRoot, 'platform-v2/server/data/migrations', migration.path.slice('schema/'.length)));
    assert.deepEqual(artifact, source, migration.path);
    assert.equal(sha256(artifact), migration.sha256, migration.path);
  }
});

test('OpenAPI publishes all implemented Core operations with no dangling refs', () => {
  const operations = Object.entries(openapi.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  assert.deepEqual(operations, [
    'DELETE /v2/buyer/addresses/{addressId}',
    'GET /v2/admin/audit/entries',
    'GET /v2/admin/catalog/categories',
    'GET /v2/admin/catalog/products',
    'GET /v2/admin/catalog/stores/{storeId}/product-slot',
    'GET /v2/admin/catalog/tags',
  'GET /v2/admin/cms/versions/{versionId}',
  'GET /v2/admin/coverage-breaker/actions',
  'GET /v2/admin/dashboard',
    'GET /v2/admin/global/resources',
    'GET /v2/admin/logistics/carriers',
    'GET /v2/admin/logistics/print-jobs',
    'GET /v2/admin/logistics/providers',
    'GET /v2/admin/logistics/warehouses',
    'GET /v2/admin/logistics/waybills',
    'GET /v2/admin/merchants',
    'GET /v2/admin/merchants/{merchantId}',
    'GET /v2/admin/monitoring',
    'GET /v2/admin/notification-campaigns',
    'GET /v2/admin/orders',
    'GET /v2/admin/payments/{orderId}',
    'GET /v2/admin/policy-drafts',
    'GET /v2/admin/policy-drafts/{draftId}',
    'GET /v2/admin/risk/overview',
    'GET /v2/admin/seckill/actions',
    'GET /v2/admin/seckill/actions/{actionId}',
    'GET /v2/admin/settlement-batches',
    'GET /v2/admin/settlement-batches/{batchId}',
    'GET /v2/admin/settlement-requests',
    'GET /v2/admin/settlement-requests/{requestId}',
    'GET /v2/admin/system-config/versions',
    'GET /v2/admin/takeover-cases',
    'GET /v2/admin/takeover-cases/{caseId}',
    'GET /v2/admin/takeover-cases/{caseId}/candidates',
    'GET /v2/admin/takeover-funding/{caseId}',
    'GET /v2/bootstrap',
    'GET /v2/buyer/addresses',
    'GET /v2/buyer/overview',
    'GET /v2/buyer/profile',
    'GET /v2/buyer/shopping-statements',
    'GET /v2/catalog/categories',
    'GET /v2/catalog/products',
    'GET /v2/catalog/products/{productId}',
    'GET /v2/catalog/tags',
    'GET /v2/cms/public',
    'GET /v2/finance/merchant',
    'GET /v2/media/assets/{assetId}/access',
    'GET /v2/merchant/audit/entries',
    'GET /v2/merchant/dashboard',
    'GET /v2/merchant/print-jobs',
    'GET /v2/merchant/profile',
    'GET /v2/merchant/receivable-statements',
    'GET /v2/merchant/stores',
    'GET /v2/merchant/stores/{storeId}/printer-binding',
    'GET /v2/merchant/stores/{storeId}/product-slot',
    'GET /v2/merchant/takeover-cases',
    'GET /v2/merchant/takeover-cases/{caseId}',
    'GET /v2/notifications',
    'GET /v2/orders',
    'GET /v2/orders/{orderId}',
    'GET /v2/orders/{orderId}/fulfillment-target',
    'GET /v2/orders/{orderId}/takeover-timeline',
    'GET /v2/payments/{orderId}',
    'GET /v2/seckill/sessions/current',
    'GET /v2/seckill/sessions/history',
    'GET /v2/seckill/sessions/{sessionId}',
    'GET /v2/seckill/sessions/{sessionId}/events',
    'GET /v2/settlements',
    'GET /v2/stores',
    'POST /v2/actions/order',
    'POST /v2/admin/catalog/categories',
    'POST /v2/admin/catalog/products/batch-lifecycle',
    'POST /v2/admin/catalog/products/batch-tags',
    'POST /v2/admin/catalog/products/{productId}/concession-previews',
    'POST /v2/admin/catalog/products/{productId}/delist',
    'POST /v2/admin/catalog/products/{productId}/review-decisions',
    'POST /v2/admin/catalog/products/{productId}/review-submissions',
    'POST /v2/admin/catalog/skus/{skuId}/inventory-adjustments',
    'POST /v2/admin/catalog/tags',
    'POST /v2/admin/cms/versions',
    'POST /v2/admin/cms/versions/{versionId}/publish',
  'POST /v2/admin/cms/versions/{versionId}/rollback',
      'POST /v2/admin/coverage-breaker/resume-actions',
      'POST /v2/admin/coverage-breaker/resume-challenge',
    'POST /v2/admin/global/exports',
    'POST /v2/admin/logistics/carrier-versions',
    'POST /v2/admin/logistics/print-jobs/{printJobId}/retry',
    'POST /v2/admin/logistics/provider-versions',
    'POST /v2/admin/logistics/warehouses',
    'POST /v2/admin/logistics/warehouses/{warehouseId}/deactivate',
    'POST /v2/admin/logistics/waybills/batches',
    'POST /v2/admin/merchants',
    'POST /v2/admin/merchants/{merchantId}/review-actions/{actionId}/publish',
    'POST /v2/admin/merchants/{merchantId}/review-challenges',
    'POST /v2/admin/monitoring/alerts/{alertKey}/acknowledge',
    'POST /v2/admin/notification-campaigns',
    'POST /v2/admin/notification-campaigns/{campaignId}/publish',
    'POST /v2/admin/notification-campaigns/{campaignId}/retry-failed',
    'POST /v2/admin/orders/batch-actions/preview',
    'POST /v2/admin/policy-drafts',
    'POST /v2/admin/policy-drafts/{draftId}/approval-challenge',
    'POST /v2/admin/policy-drafts/{draftId}/safe-proposal',
    'POST /v2/admin/policy-drafts/{draftId}/secondary-signature',
    'POST /v2/admin/risk/appeals',
    'POST /v2/admin/risk/appeals/{appealId}/decision',
    'POST /v2/admin/risk/restrictions',
    'POST /v2/admin/risk/restrictions/{restrictionId}/override',
    'POST /v2/admin/seckill/actions/{actionId}/approval-challenge',
    'POST /v2/admin/seckill/actions/{actionId}/cancel',
    'POST /v2/admin/seckill/actions/{actionId}/safe-proposal',
    'POST /v2/admin/seckill/actions/{actionId}/secondary-signature',
    'POST /v2/admin/seckill/breaker/resume',
    'POST /v2/admin/seckill/sessions',
    'POST /v2/admin/seckill/sessions/{sessionId}/force-close',
    'POST /v2/admin/seckill/sessions/{sessionId}/prize-injections',
    'POST /v2/admin/settlement-intents',
    'POST /v2/admin/system-config/versions',
    'POST /v2/admin/system-config/versions/{configVersionId}/publish',
    'POST /v2/admin/takeover-cases/{caseId}/assignments',
    'POST /v2/admin/takeover-funding',
    'POST /v2/admin/takeover-funding/approval-challenge',
    'POST /v2/auth/nonce',
    'POST /v2/auth/verify',
    'POST /v2/buyer/addresses',
    'POST /v2/buyer/addresses/parse',
    'POST /v2/buyer/addresses/{addressId}/default',
    'POST /v2/buyer/addresses/{addressId}/fulfillment-target',
    'POST /v2/finance/merchant/guarantee-deposits',
    'POST /v2/fulfillment-targets/delivery',
    'POST /v2/fulfillment-targets/pickup',
    'POST /v2/internal/risk/observations',
    'POST /v2/media/upload-intents',
    'POST /v2/media/upload-intents/{uploadIntentId}/complete',
    'POST /v2/merchant/audit/exports',
    'POST /v2/merchant/orders/exports',
    'POST /v2/merchant/print-jobs/{printJobId}/retry',
    'POST /v2/merchant/products/{productId}/concession-previews',
    'POST /v2/merchant/products/{productId}/delist',
    'POST /v2/merchant/products/{productId}/review-submissions',
    'POST /v2/merchant/stores',
    'POST /v2/merchant/stores/{storeId}/activate',
    'POST /v2/merchant/stores/{storeId}/close',
    'POST /v2/merchant/stores/{storeId}/printer-binding/challenge',
    'POST /v2/merchant/waybills/batches',
    'POST /v2/notification-endpoints',
    'POST /v2/orders/{orderId}/arbitration-decisions',
    'POST /v2/orders/{orderId}/arbitrations',
    'POST /v2/orders/{orderId}/delay-requests',
    'POST /v2/orders/{orderId}/delivery',
    'POST /v2/orders/{orderId}/evidence',
    'POST /v2/orders/{orderId}/exchange-requests',
    'POST /v2/orders/{orderId}/forced-receipt-decisions',
    'POST /v2/orders/{orderId}/forced-receipt-requests',
    'POST /v2/orders/{orderId}/pickup-credential',
    'POST /v2/orders/{orderId}/pickup-verification',
    'POST /v2/orders/{orderId}/receipt-confirmation',
    'POST /v2/orders/{orderId}/request-decisions',
    'POST /v2/orders/{orderId}/shipments',
    'POST /v2/orders/{orderId}/takeover',
    'POST /v2/orders/{orderId}/tracking-evidence',
    'POST /v2/payments/quotes',
    'POST /v2/payments/submissions',
    'POST /v2/providers/cainiao/webhooks/logistics',
    'POST /v2/providers/kuaidi100/webhooks/logistics',
    'POST /v2/seckill/quotes',
    'POST /v2/settlement-intents',
    'POST /v2/settlement-requests',
    'POST /v2/shipments/batches',
    'PUT /v2/admin/catalog/categories/{categoryId}',
    'PUT /v2/admin/catalog/stores/{storeId}/product-slot',
    'PUT /v2/admin/catalog/tags/{tagId}',
    'PUT /v2/admin/logistics/warehouses/{warehouseId}',
    'PUT /v2/admin/merchants/{merchantId}/application',
    'PUT /v2/admin/policy-drafts/{draftId}',
    'PUT /v2/buyer/addresses/{addressId}',
    'PUT /v2/buyer/profile',
    'PUT /v2/merchant/profile',
    'PUT /v2/merchant/stores/{storeId}',
    'PUT /v2/merchant/stores/{storeId}/printer-binding',
    'PUT /v2/merchant/stores/{storeId}/product-slot',
  ]);
  assert.deepEqual([...manifest.httpSurface].sort(), operations);
  const bearerOperations = operations.filter((operation: string) =>
    ![
      'GET /v2/bootstrap',
      'GET /v2/catalog/categories',
      'GET /v2/catalog/products',
      'GET /v2/catalog/products/{productId}',
      'GET /v2/catalog/tags',
      'GET /v2/cms/public',
      'GET /v2/media/assets/{assetId}/access',
      'GET /v2/seckill/sessions/current',
      'GET /v2/seckill/sessions/history',
      'GET /v2/seckill/sessions/{sessionId}',
      'GET /v2/seckill/sessions/{sessionId}/events',
      'GET /v2/stores',
      'POST /v2/auth/nonce',
      'POST /v2/auth/verify',
      'POST /v2/providers/cainiao/webhooks/logistics',
      'POST /v2/providers/kuaidi100/webhooks/logistics',
      'POST /v2/internal/risk/observations',
    ].includes(operation));
  for (const operation of bearerOperations) {
    const [method, path] = operation.split(' ');
    assert.deepEqual(openapi.paths[path!][method!.toLowerCase()].security, [{ bearerAuth: [] }], operation);
  }
  assert.deepEqual(
    openapi.paths['/v2/media/assets/{assetId}/access'].get.security,
    [{ bearerAuth: [] }, {}],
  );
  for (const path of [
    '/v2/providers/cainiao/webhooks/logistics',
    '/v2/providers/kuaidi100/webhooks/logistics',
  ]) assert.deepEqual(openapi.paths[path].post.security, [{ providerSignature: [] }], path);
  assert.deepEqual(
    openapi.paths['/v2/internal/risk/observations'].post.security,
    [{ riskSignalAuth: [] }],
  );
  for (const ref of collectRefs(openapi)) {
    assert.ok(resolveRef(openapi, ref), ref);
  }
  assert.equal(openapi.components.schemas.CanonicalPaymentIntent.properties.requiredConfirmations.const, 15);
  assert.equal(openapi.components.schemas.ApprovalRequirement.properties.approvalMode.const, 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED');
  assert.equal(openapi.components.schemas.ApprovalRequirement.properties.risk.const, 'UNLIMITED_TOKEN_ALLOWANCE');
  assert.deepEqual(openapi.components.schemas.OtherUsdtAllocation.properties.purpose.enum, [
    'POLICY_ALLOCATION',
    'SECKILL_PRIZE_LIABILITY',
  ]);
  assert.ok(openapi.components.schemas.ProductPolicy.required.includes('seckillPrizeBps'));
  assert.ok(openapi.components.schemas.ProductPolicy.required.includes('seckillPrizePoolAccount'));
  assert.deepEqual(openapi.components.schemas.MediaUploadIntentRequest.properties.purpose.enum, [
    'PRODUCT_IMAGE',
    'PRODUCT_VIDEO',
    'CATEGORY_ICON',
    'STORE_IMAGE',
    'FULFILLMENT_EVIDENCE',
    'BUYER_AVATAR',
    'MERCHANT_LOGO',
    'MERCHANT_LICENSE',
  ]);
  assert.equal(openapi.components.schemas.ManagedCatalogProduct.properties.title.maxLength, 60);
  assert.equal(openapi.components.schemas.ProductSlotInput.properties.mainImageAssetIds.maxItems, 5);
  assert.ok(openapi.components.schemas.CatalogProduct.required.includes('richDetail'));
  assert.ok(openapi.components.schemas.CatalogProduct.required.includes('categoryId'));
  assert.ok(openapi.components.schemas.CatalogSku.required.includes('seckill'));
  assert.equal(openapi.components.schemas.CatalogCategoryInput.properties.parentCategoryId.anyOf[1].type, 'null');
  assert.ok(openapi.components.schemas.FulfillmentOrder.required.includes('allowedActions'));
  assert.ok(openapi.components.schemas.FulfillmentOrder.required.includes('orderKind'));
  assert.equal(openapi.components.schemas.ShipmentBatchRequest.properties.items.maxItems, 100);
  for (const contract of manifest.requiredConsumerContracts as string[]) {
    assert.ok(openapi.components.schemas[contract], `OpenAPI ${contract}`);
    assert.match(declarations, new RegExp(`export (?:interface|type) ${contract}\\b`), contract);
  }
});

test('generated payment DTOs match the PaymentRouter tuple and current response surface', () => {
  for (const name of [
    'ProductPolicy',
    'CatalogProduct',
    'CatalogSku',
    'InventoryReservation',
    'AllocationSnapshot',
    'PaymentRouterIntent',
    'CanonicalPaymentIntent',
    'PaymentQuoteResponse',
    'CanonicalSeckillIntent',
    'SeckillQuoteResponse',
    'PaymentFinality',
    'ApprovalRequirement',
  ]) {
    assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  }
  const pay = contractFunction('PaymentRouterV2', 'pay');
  const routerIntentFields = pay.inputs[0].components.map((item: { name: string }) => item.name);
  assert.deepEqual(interfaceFields('PaymentRouterIntent'), routerIntentFields);
  for (const field of [
    'nplQuoteAmount',
    'nplBurnAmount',
    'nplRewardAmount',
    'merchantBaseReceivableUsdt',
    'merchantConcessionAmount',
    'merchantNetReceivableUsdt',
    'concessionAllocationHash',
    'merchantConcessionAllocations',
    'otherUsdtAllocations',
    'nplRewardAllocations',
    'approvalRequirements',
    'classificationAuthority',
    'canonicalBlock',
  ]) {
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
  assert.deepEqual([...settlementRails], [
    'MERCHANT_USDT',
    'REWARD_NPL',
    'PRIZE_USDT',
    'TAKEOVER_USDT',
    'OPERATIONS_REIMBURSEMENT_USDT',
  ]);
  assert.match(declarations, /export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' \| 'SECKILL_PRIZE_LIABILITY'/);
});

test('generated fulfillment DTOs expose exact amounts, immutable evidence and command results', () => {
  for (const name of [
    'MerchantStore',
    'MerchantManagedStore',
    'CreateMerchantStoreRequest',
    'UpdateMerchantStoreRequest',
    'MerchantStoreVersionRequest',
    'DeliveryTarget',
    'PickupTarget',
    'DeliveryTargetPayload',
    'FulfillmentExactAmounts',
    'FulfillmentRequestProjection',
    'ShipmentProjection',
    'LogisticsProjection',
    'FulfillmentBalance',
    'FulfillmentOrder',
    'FulfillmentCommandInput',
    'ShipmentRequest',
    'PickupCredentialRequest',
    'PickupVerificationRequest',
    'FulfillmentReasonRequest',
    'FulfillmentRequestDecision',
    'ArbitrationDecision',
    'FulfillmentDecision',
    'LogisticsWebhookRequest',
    'ShipmentResult',
    'DeliveryResult',
    'LogisticsUpdateResult',
    'PickupCredentialResult',
    'FulfillmentCompletedResult',
    'FulfillmentRequestResult',
    'FulfillmentRequestDecisionResult',
    'ArbitrationOpenedResult',
    'TakeoverOpenedResult',
    'ForcedReceiptRequestResult',
  ]) assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  for (const name of ['FulfillmentTarget', 'ArbitrationDecisionResult', 'ForcedReceiptDecisionResult', 'FulfillmentCommandResult']) {
    assert.match(declarations, new RegExp(`export type ${name}\\b`), name);
  }
  const managedStore = openapi.components.schemas.MerchantManagedStore;
  assert.equal(managedStore.additionalProperties, false);
  assert.equal('allOf' in managedStore, false);
  assert.ok(managedStore.required.includes('artifactVersion'));
  assert.ok(managedStore.required.includes('allowedActions'));
  const merchantOrderExport = openapi.components.schemas.MerchantOrderExport;
  assert.equal(merchantOrderExport.additionalProperties, false);
  assert.ok(merchantOrderExport.required.includes('contentBase64'));
  assert.ok(merchantOrderExport.required.includes('contentHash'));
  assert.equal(openapi.components.schemas.MerchantOrderExportRequest.properties.limit.maximum, 1000);
  assert.deepEqual(openapi.components.schemas.BuyerShoppingStatement.properties.orderKind.enum, [
    'ORDINARY', 'FALLBACK_RETAIL',
  ]);
  assert.deepEqual(openapi.components.schemas.MerchantReceivableLifecycle.properties.state.enum, [
    'LOCKED', 'AVAILABLE', 'REQUESTED', 'BATCHED', 'SETTLED', 'DISPUTED',
  ]);
  assert.equal(openapi.components.schemas.MerchantReceivableJournalEvidence.properties.delta.pattern, '^-?[1-9][0-9]*$');
  assert.deepEqual(Object.keys(openapi.components.schemas.FulfillmentExactAmounts.properties).sort(), [
    'bnmAmount',
    'listPriceUsdt',
    'merchantBaseReceivableUsdt',
    'merchantConcessionAmount',
    'merchantNetReceivableUsdt',
    'nplBurnAmount',
    'nplPaymentAmount',
    'nplQuoteAmount',
    'nplRewardAmount',
    'usdtPaymentAmount',
  ]);
  assert.deepEqual(enums.logisticsProviders, ['KUAIDI100', 'CAINIAO']);
  assert.deepEqual(enums.printProviders, ['FEIE', 'YILIANYUN']);
  assert.deepEqual(enums.waybillProviders, ['KUAIDI100', 'CAINIAO']);
  assert.deepEqual(enums.printJobStates, [
    'CONFIGURATION_REQUIRED', 'QUEUED', 'PROCESSING', 'ACCEPTED', 'RETRYABLE', 'FAILED',
  ]);
  assert.ok(enums.adapterProviders.includes('YILIANYUN'));
  assert.ok(enums.adapterProviders.includes('BNM'));
  assert.ok(openapi.components.schemas.PickupVerificationRequest.required.includes('storeId'));
  assert.deepEqual(enums.takeoverStates, [
    'OPEN',
    'FUNDED',
    'FULFILLING',
    'FULFILLMENT_PENDING',
    'CLOSED',
    'DECISION_BLOCKED',
  ]);
});

test('generated settlement and admin DTOs preserve the implemented naming and state boundaries', () => {
  const source = ts.createSourceFile('index.d.ts', declarations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual((source as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics, []);
  for (const name of [
    'SettlementIntentProjection',
    'SettlementRequestProjection',
    'SettlementListProjection',
    'AdminSettlementRequestList',
    'AdminSettlementRequestDetail',
    'AdminSettlementBatchList',
    'AdminSettlementBatchDetail',
    'BnmPointsBalance',
    'SeckillSessionProjection',
    'SeckillSessionHistoryPage',
    'SeckillGovernanceActionProjection',
    'SeckillGovernanceChallenge',
    'SeckillSessionPlanProjection',
    'SeckillPrizeInjectionProjection',
    'RealtimeEventEnvelope',
    'RealtimeEventPage',
    'GuaranteeDepositProjection',
    'TakeoverFundingChallenge',
    'TakeoverFundingResult',
    'MerchantFinanceProjection',
    'TakeoverFundingDetail',
    'PolicyDraftProjection',
    'PolicyDraftDetail',
    'CmsVersionProjection',
    'CmsPublicItem',
    'NotificationEndpointProjection',
    'NotificationInboxItem',
    'NotificationCampaignProjection',
    'NotificationCampaignRetryResult',
    'SystemConfigProjection',
    'AuditListResponse',
    'MonitoringDashboard',
    'MerchantLifecycleList',
    'MerchantLifecycleDetail',
    'MerchantReviewChallenge',
    'LogisticsCarrierConfig',
    'LogisticsProviderConfigList',
    'LogisticsWarehouseList',
    'AdminWaybillList',
    'AdminPrintJobList',
    'AdminGlobalSearchResponse',
    'AdminResourceExport',
    'AdminProductBatchTagResult',
    'AdminProductLifecycleBatchResult',
  ]) assert.match(declarations, new RegExp(`export interface ${name}\\b`), name);
  assert.deepEqual(enums.merchantLevels, ['V1', 'V2', 'V3', 'V4', 'V5']);
  assert.deepEqual(enums.merchantLifecycleStatuses, [
    'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLACKLISTED',
  ]);
  assert.deepEqual(enums.merchantReviewActions, [
    'APPROVE', 'REJECT', 'BLACKLIST',
  ]);
  assert.deepEqual(enums.merchantQualificationAccess, ['FULL', 'REDACTED', 'UNAVAILABLE']);
  assert.deepEqual(enums.logisticsCarrierCodes, ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS']);
  assert.deepEqual(enums.logisticsProviderReadinessStates, ['READY', 'DISABLED', 'CONFIGURATION_REQUIRED']);
  assert.deepEqual(enums.logisticsWarehouseKinds, ['PLATFORM', 'PARTNER']);
  assert.deepEqual(enums.logisticsWarehouseAccessLevels, ['FULL', 'REDACTED']);
  assert.deepEqual(enums.adminResourceTypes, ['ORDER', 'PRODUCT', 'MERCHANT']);
  assert.deepEqual(enums.adminExportFormats, ['CSV', 'EXCEL']);
  assert.deepEqual(enums.adminBatchActions, [
    'EXPORT_CSV', 'EXPORT_EXCEL', 'ADD_PRODUCT_TAGS', 'APPROVE_PRODUCTS',
    'REJECT_PRODUCTS', 'PUBLISH_PRODUCTS', 'HIDE_PRODUCTS', 'DELIST_PRODUCTS',
  ]);
  assert.deepEqual(enums.merchantGuaranteeDepositStates, ['SUBMITTED', 'MINED', 'FINAL', 'REORGED', 'QUARANTINED']);
  assert.deepEqual(enums.rewardSubtypes, [
    'GENESIS', 'DIRECT_REFERRAL', 'DISTRICT', 'CITY',
    'PROVINCE', 'REGION', 'OPERATIONS', 'ROUNDING_REMAINDER',
  ]);
  assert.deepEqual(enums.seckillStates, ['PREHEAT', 'LIVE', 'SETTLING', 'SETTLED', 'FORCE_CLOSED']);
  assert.deepEqual(enums.policyDraftStates, [
    'DRAFT', 'DECISION_BLOCKED', 'SECONDARY_SIGNED', 'SAFE_PROPOSED',
    'FINALITY_PENDING', 'REORGED', 'REJECTED', 'PUBLISHED',
  ]);
  assert.ok(enums.adapterProviders.includes('TENCENT_SMS'));
  assert.ok(enums.adapterProviders.includes('FIREBASE'));
  assert.deepEqual(Object.keys(openapi.components.schemas.SettlementRequestProjection.properties).sort(), [
    'amount', 'artifact_version', 'asset', 'asset_address', 'batch_id', 'batched_at',
    'final_execution_tx_hash', 'final_safe_tx_hash', 'intent_digest', 'intent_id', 'items',
    'items_hash', 'rail', 'recipient_address', 'request_id', 'requested_at', 'safe_address',
    'settled_at', 'signature_hash', 'state', 'transitions', 'wallet_address',
  ]);
  assert.deepEqual(Object.keys(openapi.components.schemas.MonitoringCoverage.properties).sort(), [
    'asset', 'assets', 'covered', 'observed_at', 'safe_address', 'unsettled_liabilities',
  ]);
  assert.equal(openapi.paths['/v2/cms/public'].get.responses['200'].content['application/json'].schema.type, 'array');
  assert.equal(openapi.paths['/v2/notifications'].get.responses['200'].content['application/json'].schema.type, 'array');
  assert.equal(openapi.paths['/v2/admin/notification-campaigns'].get.responses['200'].content['application/json'].schema.type, 'array');
  assert.equal(openapi.paths['/v2/admin/notification-campaigns/{campaignId}/retry-failed'].post.operationId, 'retryNotificationCampaignDeliveries');
  assert.deepEqual(openapi.components.schemas.NotificationCampaignProjection.properties.allowedActions.items.enum, ['PUBLISH', 'RETRY_FAILED']);
  assert.equal(openapi.paths['/v2/admin/policy-drafts'].get.responses['200'].content['application/json'].schema.type, 'array');
  assert.equal(openapi.paths['/v2/admin/system-config/versions'].get.responses['200'].content['application/json'].schema.type, 'array');
  assert.ok(openapi.components.schemas.SettlementListProjection.required.includes('points'));
  assert.equal(openapi.paths['/v2/admin/payments/{orderId}'].get.operationId, 'getAdminPaymentProjection');
  assert.equal(openapi.paths['/v2/admin/settlement-batches/{batchId}'].get.operationId, 'getAdminSettlementBatch');
  assert.equal(openapi.components.schemas.AdminSettlementBatchEnvelope.properties.chainId.const, 56);
  assert.equal(openapi.components.schemas.AdminSettlementFinality.properties.requiredConfirmations.const, 15);
  assert.equal(openapi.components.schemas.AdminSettlementBatchDetail.properties.reconciliation.$ref, '#/components/schemas/AdminSettlementReconciliation');
  assert.ok(openapi.components.schemas.SettlementBalance.required.includes('rewardSubtype'));
  assert.equal(openapi.components.schemas.BnmPointsBalance.properties.transferable.const, false);
  assert.equal(openapi.components.schemas.RealtimeEventEnvelope.properties.finality.const, 'FINAL');
  assert.equal(openapi.components.schemas.MerchantLifecycleSummary.properties.settlementWalletMutable.const, false);
  assert.deepEqual(openapi.components.schemas.AdminGlobalSearchResponse.properties.relation, { enum: ['AND', 'OR'] });
  assert.ok(openapi.paths['/v2/admin/catalog/products/batch-lifecycle']);
  assert.equal('wallet' in openapi.components.schemas.AdminResourceSummary.properties, false);
  assert.equal('phone' in openapi.components.schemas.AdminResourceSummary.properties, false);
  assert.equal(manifest.decisionBlocked.includes('ADMIN_OR_QUERY_SEMANTICS'), false);
  assert.equal(manifest.decisionBlocked.includes('ADMIN_FUZZY_WALLET_SEARCH_POLICY'), false);
  assert.ok(manifest.decisionBlocked.includes('ADMIN_YELLOW_QUEUE_DEFINITION'));
  assert.deepEqual(
    openapi.components.schemas.MerchantFulfillmentAnalytics.properties.fastShip48h.anyOf.map(
      (schema: { properties: { status: { const: string } } }) => schema.properties.status.const,
    ),
    ['AVAILABLE', 'UNAVAILABLE'],
  );
  assert.deepEqual(
    openapi.components.schemas.MerchantLifecycleDetail.properties.levelPolicy.anyOf.map(
      (schema: { properties: { status: { const: string } } }) => schema.properties.status.const,
    ),
    ['AVAILABLE', 'DecisionBlocked'],
  );
  assert.equal('proposedSettlementWallet' in openapi.components.schemas.MerchantReviewChallengeRequest.properties, false);
  assert.deepEqual(
    Object.keys(openapi.components.schemas.MerchantOrderAnalytics.properties.cumulative.properties),
    ['listPriceUsdt', 'buyerPaidUsdt', 'merchantBaseReceivableUsdt', 'merchantNetReceivableUsdt'],
  );
  for (const resolved of [
    'MERCHANT_LEVEL_PRICE_BASIS',
    'MERCHANT_MONTHLY_SECKILL_QUOTA_WINDOW',
    'MERCHANT_48_HOUR_SHIPPING_RATE_DENOMINATOR',
  ]) assert.equal(manifest.decisionBlocked.includes(resolved), false, resolved);
  assert.ok(manifest.externalBlocked.includes('MERCHANT_PII_ENCRYPTION_KEY'));
  for (const field of ['governanceActionId', 'rulesContentHash', 'publicationTxHash']) {
    assert.ok(openapi.components.schemas.SeckillSessionProjection.required.includes(field), field);
    assert.match(declarations, new RegExp(`\\b${field}\\b`), field);
  }
});

test('published wallet calls encode with the ABI and published EIP-712 messages reproduce authorization digests', () => {
  const router = new Interface(abiBundle.contracts.PaymentRouterV2);
  const paymentIntent = signingVectorRouterIntent();
  const paymentTypes = {
    PaymentAuthorization: [
      { name: 'paymentHash', type: 'bytes32' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'buyer', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'productId', type: 'bytes32' },
      { name: 'skuId', type: 'bytes32' },
      { name: 'quantity', type: 'uint32' },
      { name: 'fulfillmentMode', type: 'uint8' },
      { name: 'listPriceUsdt', type: 'uint256' },
      { name: 'usdtPaymentAmount', type: 'uint256' },
      { name: 'nplPaymentAmount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
  };
  const domain = {
    name: 'Abu24KPaymentRouter',
    version: '2',
    chainId: 56,
    verifyingContract: '0x9999999999999999999999999999999999999999',
  };
  const paymentMessage = {
    paymentHash: '0xc125633288a4ba4ccb0602dae00c885dbe1adb7a0a77cc842f34d3d425d9279f',
    orderId: paymentIntent.orderId,
    buyer: paymentIntent.buyer,
    merchant: paymentIntent.merchant,
    productId: paymentIntent.productId,
    skuId: paymentIntent.skuId,
    quantity: paymentIntent.quantity,
    fulfillmentMode: paymentIntent.fulfillmentMode,
    listPriceUsdt: paymentIntent.listPriceUsdt,
    usdtPaymentAmount: paymentIntent.usdtPaymentAmount,
    nplPaymentAmount: paymentIntent.nplPaymentAmount,
    deadline: paymentIntent.deadline,
  };
  const quoteSignature = `0x${'11'.repeat(65)}`;
  const buyerSignature = `0x${'22'.repeat(65)}`;
  const ordinaryResponse = {
    authorizationDigest: '0x3b991a7728e91bdf283431b553258f94dffe4b516b6283ad3c34a588f7cd21a0',
    buyerAuthorization: {
      domain,
      types: paymentTypes,
      primaryType: 'PaymentAuthorization',
      message: paymentMessage,
      digest: '0x3b991a7728e91bdf283431b553258f94dffe4b516b6283ad3c34a588f7cd21a0',
    },
    routerCall: { functionName: 'pay', intent: paymentIntent, quoteSignature },
  };
  assert.equal(
    TypedDataEncoder.hash(
      ordinaryResponse.buyerAuthorization.domain,
      ordinaryResponse.buyerAuthorization.types,
      ordinaryResponse.buyerAuthorization.message,
    ),
    ordinaryResponse.authorizationDigest,
  );
  const payCalldata = router.encodeFunctionData(ordinaryResponse.routerCall.functionName, [
    ordinaryResponse.routerCall.intent,
    ordinaryResponse.routerCall.quoteSignature,
    buyerSignature,
  ]);
  assert.equal(router.parseTransaction({ data: payCalldata })?.name, 'pay');

  const sessionId = hash('5');
  const seckillPayment = { ...paymentIntent, seckill: true, sessionId };
  const fallbackPayment = {
    ...paymentIntent,
    reservationId: hash('6'),
    reservationHash: hash('7'),
  };
  const seckillTypes = {
    SeckillAuthorization: [
      { name: 'seckillHash', type: 'bytes32' },
      { name: 'orderId', type: 'bytes32' },
      { name: 'buyer', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'productId', type: 'bytes32' },
      { name: 'skuId', type: 'bytes32' },
      { name: 'quantity', type: 'uint32' },
      { name: 'fulfillmentMode', type: 'uint8' },
      { name: 'seckillListPriceUsdt', type: 'uint256' },
      { name: 'seckillUsdtPaymentAmount', type: 'uint256' },
      { name: 'seckillNplPaymentAmount', type: 'uint256' },
      { name: 'fallbackListPriceUsdt', type: 'uint256' },
      { name: 'fallbackUsdtPaymentAmount', type: 'uint256' },
      { name: 'fallbackNplPaymentAmount', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
  };
  const seckillMessage = {
    seckillHash: '0x292fee156f4df5e8469fcff24055093e8820768b91784e417559b0fabd4d1bce',
    orderId: seckillPayment.orderId,
    buyer: seckillPayment.buyer,
    merchant: seckillPayment.merchant,
    productId: seckillPayment.productId,
    skuId: seckillPayment.skuId,
    quantity: seckillPayment.quantity,
    fulfillmentMode: seckillPayment.fulfillmentMode,
    seckillListPriceUsdt: seckillPayment.listPriceUsdt,
    seckillUsdtPaymentAmount: seckillPayment.usdtPaymentAmount,
    seckillNplPaymentAmount: seckillPayment.nplPaymentAmount,
    fallbackListPriceUsdt: fallbackPayment.listPriceUsdt,
    fallbackUsdtPaymentAmount: fallbackPayment.usdtPaymentAmount,
    fallbackNplPaymentAmount: fallbackPayment.nplPaymentAmount,
    deadline: seckillPayment.deadline,
  };
  const seckillResponse = {
    authorizationDigest: '0x8fd49d5723d836b830cc81647eaaad6b4e5e996f560a9bd034402549241e8246',
    buyerAuthorization: {
      domain,
      types: seckillTypes,
      primaryType: 'SeckillAuthorization',
      message: seckillMessage,
      digest: '0x8fd49d5723d836b830cc81647eaaad6b4e5e996f560a9bd034402549241e8246',
    },
    routerCall: {
      functionName: 'paySeckill',
      intent: { sessionId, seckillPayment, fallbackPayment },
      quoteSignature,
    },
  };
  assert.equal(
    TypedDataEncoder.hash(
      seckillResponse.buyerAuthorization.domain,
      seckillResponse.buyerAuthorization.types,
      seckillResponse.buyerAuthorization.message,
    ),
    seckillResponse.authorizationDigest,
  );
  const seckillCalldata = router.encodeFunctionData(seckillResponse.routerCall.functionName, [
    seckillResponse.routerCall.intent,
    seckillResponse.routerCall.quoteSignature,
    buyerSignature,
  ]);
  assert.equal(router.parseTransaction({ data: seckillCalldata })?.name, 'paySeckill');

  for (const [schema, response] of [
    ['PaymentBuyerAuthorization', ordinaryResponse.buyerAuthorization],
    ['OrdinaryRouterCall', ordinaryResponse.routerCall],
    ['SeckillBuyerAuthorization', seckillResponse.buyerAuthorization],
    ['SeckillRouterCall', seckillResponse.routerCall],
  ] as const) assertRequiredSchema(schema, response);
});

test('ABI publication is exactly the four payment contracts and exposes current Router behavior', () => {
  const expectedContracts = [
    'BeneficiaryRegistryV2',
    'PaymentRouterV2',
    'PolicyRegistryV2',
    'TwapOracleAdapterV2',
  ];
  assert.deepEqual(Object.keys(abiBundle.contracts).sort(), expectedContracts);
  assert.deepEqual(
    contractManifest.contracts.map((item: { name: string }) => item.name).sort(),
    expectedContracts,
  );
  assertFunctions('PaymentRouterV2', [
    'getSession',
    'hashPayment',
    'hashSeckill',
    'pay',
    'paySeckill',
    'setNewPaymentsPaused',
    'setSeckillPurchasesPaused',
  ]);
  assertFunctions('PolicyRegistryV2', ['getPolicy', 'publishPolicy']);
  const events = new Set(
    abiBundle.contracts.PaymentRouterV2
      .filter((item: { type: string }) => item.type === 'event')
      .map((item: { name: string }) => item.name),
  );
  for (const name of [
    'PaymentCompleted',
    'MerchantReceivableSnapshotted',
    'SeckillSessionOpened',
    'SeckillRelayExtended',
    'PaymentPauseChanged',
    'SeckillPurchasePauseChanged',
  ]) assert.ok(events.has(name), name);
});

test('publication contains no Claim, BNM token payout, old escrow or old allocation surface', () => {
  const published = JSON.stringify({ manifest, openapi, websocket, enums, abiBundle, contractManifest }) + declarations;
  for (const forbidden of [
    'PaymentEscrowV2',
    'ClaimVaultV2',
    'BNMTokenV2',
    'RewardLedgerV2',
    'MerchantGuaranteeVaultV2',
    'OrderPaid',
    'ClaimProjection',
    'claimRails',
    'merchantUsdtAmount',
    'routedNplAmount',
  ]) {
    assert.equal(published.includes(forbidden), false, forbidden);
  }
  assert.equal(published.toLowerCase().includes('refund'), false);
  assert.equal([...settlementRails].includes('BNM' as never), false);
});

test('catalog, settlement/admin and seckill realtime capabilities are published while deployment stays fail closed', () => {
  assert.equal(websocket.endpoint, '/v2/ws');
  assert.equal(websocket.channels.length, 1);
  assert.equal(websocket.channels[0].pattern, 'seckill:{sessionId}');
  assert.deepEqual(websocket.channels[0].events, ['SeckillRelayExtended']);
  assert.equal(websocket.publicationStatus, 'AVAILABLE');
  const available = new Set([
    'bootstrap',
    'siweAuthentication',
    'orderAllowedActions',
    'catalogHttp',
    'catalogManagementHttp',
    'signedConcessionPreview',
    'immutableMediaEvidence',
    'paymentQuoteHttp',
    'inventoryReservation',
    'paymentSubmissionHttp',
    'paymentProjectionHttp',
    'paymentIndexer',
    'seckillQuoteHttp',
    'seckillSessionHttp',
    'storesHttp',
    'merchantStoreManagementHttp',
    'merchantOrderExportHttp',
    'fulfillmentTargetHttp',
    'fulfillmentHttp',
    'logisticsWebhookHttp',
    'printerBindingHttp',
    'waybillBatchHttp',
    'durablePrintJobs',
    'logisticsAdminConfigHttp',
    'logisticsWarehouseHttp',
    'adminWaybillAndPrintHttp',
    'adminGlobalResourceSearchHttp',
    'adminResourceExportHttp',
    'adminProductBatchTaggingHttp',
    'adminProductLifecycleBatchHttp',
    'takeoverHttp',
    'fulfillmentScheduler',
    'bnmAvailabilityWorker',
    'settlementHttp',
    'settlementSafeBatching',
    'buyerShoppingStatementHttp',
    'merchantReceivableStatementHttp',
    'guaranteeDepositHttp',
    'guaranteeDepositFinality',
    'takeoverFundingHttp',
    'takeoverCaseManagementHttp',
    'replacementMerchantFulfillment',
    'policyGovernanceHttp',
    'cmsHttp',
    'notificationHttp',
    'notificationDelivery',
    'systemConfigGovernanceHttp',
    'auditHttp',
    'buyerAccountHttp',
    'buyerSavedAddressHttp',
    'buyerTakeoverTimelineHttp',
    'merchantProfileHttp',
    'merchantLifecycleHttp',
    'merchantQualificationEncryption',
    'merchantReviewGovernance',
    'merchantDrilldown',
    'merchantScopedAuditHttp',
    'monitoringHttp',
    'riskManagementHttp',
    'riskPaymentEnforcement',
    'coverageMonitoring',
    'websocket',
  ]);
  for (const [capability, status] of Object.entries(manifest.capabilityStatus)) {
    assert.equal(status, available.has(capability) ? 'AVAILABLE' : 'NOT_PUBLISHED_FAIL_CLOSED', capability);
  }
  assert.equal(manifest.deploymentAuthorized, false);
  assert.equal(manifest.deploymentAuthorizationEvidenceHash, null);
  assert.equal(contractManifest.deploymentAuthorized, false);
  assert.equal(contractManifest.deploymentAuthorizationEvidenceHash, null);
  assert.ok(contractManifest.contracts.every((contract: { deploymentBlock: null; deployedCodeHash: null }) =>
    contract.deploymentBlock === null && contract.deployedCodeHash === null));
  const fulfillmentActions = [
    'REQUEST_EXCHANGE',
    'REQUEST_DELAY',
    'DECIDE_FULFILLMENT_REQUEST',
    'CONFIRM_RECEIPT',
    'REQUEST_FORCED_RECEIPT',
    'VERIFY_PICKUP',
    'OPEN_ARBITRATION',
    'OPEN_TAKEOVER',
    'RECORD_SHIPMENT',
    'RECORD_DELIVERY',
    'REGISTER_PICKUP_CREDENTIAL',
    'DECIDE_ARBITRATION',
    'DECIDE_FORCED_RECEIPT',
  ];
  assert.deepEqual([...executableOrderActionNames], fulfillmentActions);
  assert.deepEqual(manifest.executableOrderActionNames, fulfillmentActions);
  assert.ok(manifest.externalBlocked.includes('GOVERNANCE_AND_THREE_SAFE_ADDRESSES'));
  assert.ok(manifest.externalBlocked.includes('PROVIDER_ACCOUNTS_AND_CREDENTIALS'));
  assert.ok(manifest.externalBlocked.includes('BNM_MONOTONIC_CONFORMANCE_EVIDENCE'));
  assert.ok(manifest.decisionBlocked.includes('PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE'));
  assert.equal(manifest.decisionBlocked.includes('REQUIRED_CONFIRMATIONS'), false);
});

function contractFunction(contract: string, name: string) {
  const item = abiBundle.contracts[contract].find(
    (candidate: { type: string; name: string }) => candidate.type === 'function' && candidate.name === name,
  );
  assert.ok(item, `${contract}.${name}`);
  return item;
}

function assertFunctions(contract: string, expected: string[]) {
  const names = new Set(
    abiBundle.contracts[contract]
      .filter((item: { type: string }) => item.type === 'function')
      .map((item: { name: string }) => item.name),
  );
  for (const name of expected) assert.ok(names.has(name), `${contract}.${name}`);
}

function interfaceFields(name: string) {
  const source = ts.createSourceFile('index.d.ts', declarations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  assert.ok(declaration, name);
  return declaration.members.map((member) => {
    assert.ok(ts.isPropertySignature(member) && member.name, `${name} contains only property signatures`);
    return member.name.getText(source);
  });
}

function assertRequiredSchema(name: string, value: Record<string, unknown>) {
  const schema = openapi.components.schemas[name] as { required?: string[] };
  assert.ok(schema, name);
  for (const field of schema.required ?? []) assert.ok(field in value, `${name}.${field}`);
}

function signingVectorRouterIntent() {
  return {
    orderId: hash('a'),
    policyVersion: 1,
    oracleVersion: hash('1'),
    buyer: address('1'),
    merchant: address('2'),
    productId: hash('b'),
    skuId: hash('c'),
    quantity: 2,
    fulfillmentMode: 0,
    fulfillmentTargetHash: hash('d'),
    regionCodeHash: hash('e'),
    productPolicyHash: hash('f'),
    reservationId: hash('2'),
    reservationHash: hash('3'),
    reservationDeadline: 1_800_000_600,
    issuedAt: 1_800_000_000,
    deadline: 1_800_000_300,
    nonce: '7',
    listPriceUsdt: '100000000000000000000',
    usdtPaymentAmount: '70000000000000000000',
    nplQuoteAmount: '1000000000000000000000',
    nplPaymentAmount: '300000000000000000000',
    nplBurnAmount: '200000000000000000000',
    nplRewardAmount: '100000000000000000000',
    merchantBaseReceivableUsdt: '60000000000000000000',
    merchantConcessionBps: 2_500,
    merchantConcessionAmount: '15000000000000000000',
    merchantNetReceivableUsdt: '45000000000000000000',
    concessionAllocationHash: hash('4'),
    bnmAmount: '100000000000000000000',
    seckill: false,
    sessionId: hash('0'),
    beneficiaries: {
      genesis: address('3'),
      directReferral: address('4'),
      district: address('5'),
      city: address('6'),
      province: address('7'),
      region: address('8'),
    },
  };
}

function hash(character: string) {
  return `0x${character.repeat(64)}`;
}

function address(character: string) {
  return `0x${character.repeat(40)}`;
}

function collectRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.$ref === 'string' ? [record.$ref] : []),
    ...Object.values(record).flatMap(collectRefs),
  ];
}

function resolveRef(document: Record<string, unknown>, ref: string) {
  if (!ref.startsWith('#/')) return false;
  return ref.slice(2).split('/').reduce<unknown>((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, document);
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(join(artifactsRoot, path), 'utf8'));
}

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

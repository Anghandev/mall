#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_ARTIFACT_VERSION,
  BSC_CHAIN_ID,
  NPL_ADDRESS,
  USDT_ADDRESS,
  adapterProviders,
  allowedActionNames,
  allowedActionReasonCodes,
  arbitrationOutcomes,
  auditEvidenceProfiles,
  auditStreamNames,
  balanceStates,
  breakerActions,
  breakerCauseTypes,
  breakerScopes,
  catalogProductActions,
  catalogProductLifecycleStates,
  catalogReviewDecisions,
  catalogTaxonomyStatuses,
  cmsContentFormats,
  cmsContentTypes,
  cmsPublicationEventTypes,
  finalityStates,
  executableOrderActionNames,
  fulfillmentAssets,
  fulfillmentMethods,
  fulfillmentModes,
  fulfillmentRequestStates,
  fulfillmentRequestTypes,
  contractOrderStates,
  infrastructureProviders,
  logisticsProviders,
  logisticsStatuses,
  mediaContentTypes,
  mediaPurposes,
  mediaResourceTypes,
  merchantGuaranteeDepositStates,
  guaranteeStatuses,
  notificationCampaignStates,
  notificationCampaignTopics,
  notificationChannels,
  notificationDeliveryStates,
  notificationEndpointStates,
  notificationProviders,
  operationsAlertEventTypes,
  operationsAlertSeverities,
  operationsMetricComponents,
  operationsMetricStatuses,
  operationsMetricUnits,
  orderFinalityStatuses,
  orderProjectionStates,
  policyDraftStates,
  policyPublicationStates,
  providerReadinessStates,
  reservationStates,
  rewardSubtypes,
  seckillStates,
  settlementBatchStates,
  settlementIntentStates,
  settlementRails,
  settlementRequestStates,
  storeStatuses,
  systemConfigKeys,
  takeoverStates,
  userRoles,
} from '../server/api/enums.ts';
import { coreErrorCodes } from '../server/api/errors.ts';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(coreRoot, '..');
const outputRoot = join(repoRoot, 'packages/core-artifacts');
const contractsRoot = join(outputRoot, 'contracts');
const checkOnly = process.argv.includes('--check');
const artifactVersion = CORE_ARTIFACT_VERSION;
const schemaSources = [
  {
    name: 'core',
    directory: 'business',
    migrationTable: 'core.schema_migrations',
    files: [
      '001_core_schema.sql',
      '002_inventory_and_queue.sql',
      '003_indexer.sql',
      '004_parallel_auth_nonces.sql',
      '005_payment_ledger.sql',
      '006_fulfillment.sql',
      '007_settlement_admin.sql',
      '008_admin_services.sql',
      '009_product_surfaces.sql',
      '010_evidence_media.sql',
      '011_catalog_management.sql',
      '012_order_operations.sql',
      '013_business_analytics.sql',
      '014_accounts_and_profiles.sql',
    ],
  },
  {
    name: 'audit',
    directory: 'audit',
    migrationTable: 'audit.schema_migrations',
    files: [
      '001_audit_schema.sql',
      '002_evidence_policy.sql',
      '003_admin_query_and_ingest.sql',
      '004_merchant_scope.sql',
    ],
  },
];
const schemaArtifacts = new Map();
const schemaManifest = {
  artifactVersion,
  formatVersion: 1,
  databaseEngine: 'postgresql',
  schemas: Object.fromEntries(schemaSources.map((schema) => [
    schema.name,
    {
      migrationTable: schema.migrationTable,
      migrations: schema.files.map((name) => {
        const source = readRequired(join(coreRoot, 'server/data/migrations', schema.directory, name));
        const path = `schema/${schema.directory}/${name}`;
        schemaArtifacts.set(path, source);
        return { name, path, sha256: sha256(source) };
      }),
    },
  ])),
};

const enums = {
  artifactVersion,
  orderProjectionStates,
  contractOrderStates,
  orderFinalityStatuses,
  finalityStates,
  userRoles,
  breakerScopes,
  catalogProductActions,
  catalogProductLifecycleStates,
  catalogReviewDecisions,
  catalogTaxonomyStatuses,
  allowedActionNames,
  executableOrderActionNames,
  allowedActionReasonCodes,
  fulfillmentModes,
  fulfillmentMethods,
  storeStatuses,
  fulfillmentRequestTypes,
  fulfillmentRequestStates,
  logisticsProviders,
  logisticsStatuses,
  mediaContentTypes,
  mediaPurposes,
  mediaResourceTypes,
  fulfillmentAssets,
  arbitrationOutcomes,
  settlementRails,
  settlementIntentStates,
  settlementRequestStates,
  settlementBatchStates,
  merchantGuaranteeDepositStates,
  guaranteeStatuses,
  breakerActions,
  breakerCauseTypes,
  reservationStates,
  rewardSubtypes,
  balanceStates,
  takeoverStates,
  seckillStates,
  coreErrorCodes,
  policyPublicationStates,
  policyDraftStates,
  cmsContentTypes,
  cmsContentFormats,
  cmsPublicationEventTypes,
  notificationChannels,
  notificationProviders,
  notificationEndpointStates,
  notificationCampaignTopics,
  notificationCampaignStates,
  notificationDeliveryStates,
  systemConfigKeys,
  auditStreamNames,
  auditEvidenceProfiles,
  operationsMetricComponents,
  operationsMetricUnits,
  operationsMetricStatuses,
  operationsAlertEventTypes,
  operationsAlertSeverities,
  adapterProviders,
  infrastructureProviders,
  providerReadinessStates,
};

const openapi = buildOpenApi();
const websocket = {
  artifactVersion,
  protocolVersion: 1,
  transport: 'wss',
  publicationStatus: 'AVAILABLE',
  endpoint: '/v2/ws',
  channels: [{
    pattern: 'seckill:{sessionId}',
    authorization: 'PUBLIC',
    events: ['SeckillRelayExtended'],
    replayHttp: '/v2/seckill/sessions/{sessionId}/events',
  }],
  clientRule: 'Bind artifactVersion and channel; resume with the last accepted numeric cursor',
  envelope: {
    required: [
      'artifactVersion', 'protocolVersion', 'eventId', 'channel', 'cursor',
      'eventType', 'resourceType', 'resourceId', 'occurredAt', 'finality', 'payload',
    ],
    properties: {
      artifactVersion: { const: artifactVersion },
      protocolVersion: { const: 1 },
      eventId: { type: 'string', minLength: 1 },
      channel: { type: 'string', minLength: 1 },
      cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      eventType: { const: 'SeckillRelayExtended' },
      resourceType: { type: 'string', minLength: 1 },
      resourceId: { type: 'string', minLength: 1 },
      occurredAt: { type: 'string', format: 'date-time' },
      finality: { const: 'FINAL' },
      payload: { type: 'object' },
    },
  },
  delivery: {
    order: 'ASCENDING_CURSOR_PER_CHANNEL',
    deduplicateBy: 'eventId',
    reconnectWith: 'lastAcceptedCursor',
    replay: 'AT_LEAST_ONCE',
    unknownEvent: 'FAIL_CLOSED_AND_RESYNC',
    artifactMismatch: 'CLOSE_4409_AND_RELOAD_MANIFEST',
  },
  closeCodes: {
    4401: 'Unauthorized',
    4403: 'Forbidden',
    4409: 'ArtifactVersionMismatch',
    4503: 'ConfigurationRequired',
  },
};

const files = new Map([
  ['openapi/openapi.json', json(openapi)],
  ['generated/index.js', generatedJavaScript()],
  ['generated/index.d.ts', generatedTypes()],
  ['schema/schema-manifest.json', json(schemaManifest)],
  ['state-error-enums.json', json(enums)],
  ['websocket-protocol.json', json(websocket)],
]);
for (const [path, content] of schemaArtifacts) files.set(path, content);

const componentPaths = {
  packageMetadata: 'package.json',
  openapi: 'openapi/openapi.json',
  generatedRuntime: 'generated/index.js',
  generatedTypes: 'generated/index.d.ts',
  schemaManifest: 'schema/schema-manifest.json',
  stateErrorEnums: 'state-error-enums.json',
  websocketProtocol: 'websocket-protocol.json',
  abiBundle: 'contracts/abi-bundle.json',
  contractManifest: 'contracts/contract-manifest.json',
  eventCatalog: 'contracts/event-catalog.json',
  roleCatalog: 'contracts/role-catalog.json',
};
const consumerTestPaths = [
  'platform-v2/server/api/api.test.ts',
  'platform-v2/test/consumer/core-artifacts.test.ts',
];
for (const path of Object.values(componentPaths)) {
  const content = files.get(path) ?? readRequired(join(outputRoot, path));
  if (path.endsWith('.json')) assertVersion(path, content);
}
const publishedContractManifest = JSON.parse(readRequired(join(contractsRoot, 'contract-manifest.json')));

const coordinatedManifest = {
  artifactVersion,
  publicationStatus: 'COORDINATED_SETTLEMENT_ADMIN_CHECKPOINT',
  deploymentAuthorized: publishedContractManifest.deploymentAuthorized === true,
  deploymentAuthorizationEvidenceHash:
    publishedContractManifest.deploymentAuthorizationEvidenceHash ?? null,
  chain: { name: 'BSC Mainnet', chainId: BSC_CHAIN_ID },
  fixedAssets: { USDT: USDT_ADDRESS, NPL: NPL_ADDRESS },
  components: Object.fromEntries(
    Object.entries(componentPaths).map(([name, path]) => [
      name,
      { path, sha256: sha256(files.get(path) ?? readRequired(join(outputRoot, path))) },
    ]),
  ),
  consumerTests: consumerTestPaths.map((path) => ({
    path,
    sha256: sha256(readRequired(join(repoRoot, path))),
  })),
  httpSurface: openApiHttpSurface(openapi),
  capabilityStatus: {
    bootstrap: 'AVAILABLE',
    siweAuthentication: 'AVAILABLE',
    orderAllowedActions: 'AVAILABLE',
    catalogHttp: 'AVAILABLE',
    catalogManagementHttp: 'AVAILABLE',
    signedConcessionPreview: 'AVAILABLE',
    immutableMediaEvidence: 'AVAILABLE',
    paymentQuoteHttp: 'AVAILABLE',
    inventoryReservation: 'AVAILABLE',
    paymentSubmissionHttp: 'AVAILABLE',
    paymentProjectionHttp: 'AVAILABLE',
    paymentIndexer: 'AVAILABLE',
    settlementHttp: 'AVAILABLE',
    settlementSafeBatching: 'AVAILABLE',
    guaranteeDepositHttp: 'AVAILABLE',
    guaranteeDepositFinality: 'AVAILABLE',
    takeoverFundingHttp: 'AVAILABLE',
    policyGovernanceHttp: 'AVAILABLE',
    cmsHttp: 'AVAILABLE',
    notificationHttp: 'AVAILABLE',
    notificationDelivery: 'AVAILABLE',
    systemConfigGovernanceHttp: 'AVAILABLE',
    auditHttp: 'AVAILABLE',
    buyerAccountHttp: 'AVAILABLE',
    buyerSavedAddressHttp: 'AVAILABLE',
    buyerTakeoverTimelineHttp: 'AVAILABLE',
    merchantProfileHttp: 'AVAILABLE',
    merchantScopedAuditHttp: 'AVAILABLE',
    monitoringHttp: 'AVAILABLE',
    coverageMonitoring: 'AVAILABLE',
    storesHttp: 'AVAILABLE',
    fulfillmentTargetHttp: 'AVAILABLE',
    fulfillmentHttp: 'AVAILABLE',
    logisticsWebhookHttp: 'AVAILABLE',
    takeoverHttp: 'AVAILABLE',
    fulfillmentScheduler: 'AVAILABLE',
    bnmAvailabilityWorker: 'AVAILABLE',
    seckillQuoteHttp: 'AVAILABLE',
    seckillSessionHttp: 'AVAILABLE',
    websocket: 'AVAILABLE',
  },
  executableOrderActionNames,
  decisionBlocked: [
    'PLATFORM_SERVICE_FEE_BPS',
    'SECKILL_PRIZE_POOL_BPS',
    'MERCHANT_STORE_REWARD_BPS',
    'SECKILL_PRIZE_POOL_ACCOUNT',
    'MERCHANT_CONCESSION_DESTINATION_WEIGHTS',
    'FIXED_REMAINDER_ACCOUNTS',
    'GENESIS_CREDENTIAL_CONTRACT_AND_TOKEN_ID',
    'PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE',
    'EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION',
  ],
  externalBlocked: [
    'GOVERNANCE_AND_THREE_SAFE_ADDRESSES',
    'SECONDARY_POLICY_AND_QUOTE_SIGNERS',
    'TWAP_SOURCE',
    'BSC_RPC_URL',
    'DEPLOYED_CONTRACT_ADDRESSES',
    'REMOTE_SIGNER',
    'DATABASE_AUDIT_DATABASE_AND_REDIS',
    'PROVIDER_ACCOUNTS_AND_CREDENTIALS',
    'BNM_MONOTONIC_CONFORMANCE_EVIDENCE',
    'PHYSICAL_PRINTER_AND_MOBILE_DEVICE_EVIDENCE',
    'PRODUCTION_DOMAINS_AND_HTTPS',
    'APPROVED_MERCHANT_AND_ADMIN_WALLETS',
  ],
  requiredConsumerContracts: [
    'ProductPolicy',
    'CatalogProduct',
    'CatalogSku',
    'CatalogCategory',
    'CatalogTag',
    'ManagedCatalogProduct',
    'ManagedCatalogSku',
    'MerchantConcessionPreview',
    'MediaUploadIntentProjection',
    'MediaAssetProjection',
    'MediaReadAccessProjection',
    'PaymentQuoteResponse',
    'SeckillQuoteResponse',
    'PaymentProjection',
    'PaymentRouterIntent',
    'CanonicalPaymentIntent',
    'InventoryReservation',
    'AllocationSnapshot',
    'AllowedAction',
    'PaymentFinality',
    'MerchantStore',
    'FulfillmentTarget',
    'FulfillmentOrder',
    'FulfillmentOrderPage',
    'ShipmentBatchRequest',
    'ShipmentBatchResult',
    'AdminOrderSearchPage',
    'OrderBatchActionPreview',
    'FulfillmentCommandInput',
    'FulfillmentCommandResult',
    'SettlementIntentProjection',
    'SettlementRequestProjection',
    'SettlementListProjection',
    'BnmPointsBalance',
    'SeckillSessionProjection',
    'SeckillSessionHistoryPage',
    'RealtimeEventPage',
    'GuaranteeDepositProjection',
    'TakeoverFundingChallenge',
    'TakeoverFundingResult',
    'MerchantFinanceProjection',
    'TakeoverFundingDetail',
    'PolicyDraftProjection',
    'CmsVersionProjection',
    'CmsPublicItem',
    'NotificationEndpointProjection',
    'NotificationInboxItem',
    'SystemConfigProjection',
    'AuditListResponse',
    'MonitoringDashboard',
    'MerchantBusinessDashboard',
    'AdminBusinessDashboard',
    'BuyerProfile',
    'BuyerSavedAddress',
    'BuyerOverview',
    'BuyerTakeoverTimeline',
    'MerchantProfile',
    'MerchantAuditList',
    'MerchantAuditExport',
  ],
};
files.set('coordinated-manifest.json', json(coordinatedManifest));

const checksumEntries = [...files.entries()];
checksumEntries.push(['package.json', readRequired(join(outputRoot, 'package.json'))]);
for (const path of walkFiles(contractsRoot)) {
  checksumEntries.push([relative(outputRoot, path), readFileSync(path, 'utf8')]);
}
files.set(
  'SHA256SUMS',
  checksumEntries
    .map(([path, content]) => `${sha256(content)}  ${path}`)
    .sort()
    .join('\n') + '\n',
);

if (checkOnly) {
  const mismatches = [];
  for (const [path, expected] of files) {
    const absolute = join(outputRoot, path);
    if (!existsSync(absolute) || readFileSync(absolute, 'utf8') !== expected) mismatches.push(path);
  }
  if (mismatches.length > 0) throw new Error(`Stale or missing coordinated artifacts: ${mismatches.join(', ')}`);
  console.log(`OK coordinated artifacts ${artifactVersion}: ${files.size} generated files`);
  process.exit(0);
}

for (const path of ['openapi', 'generated', 'schema']) rmSync(join(outputRoot, path), { recursive: true, force: true });
for (const [path, content] of files) {
  const absolute = join(outputRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
console.log(`wrote coordinated artifacts ${artifactVersion}: ${files.size} generated files`);

function buildOpenApi() {
  const errorResponse = {
    description: 'Request failed closed',
    headers: { 'x-correlation-id': { schema: { type: 'string' } } },
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  };
  const orderIdParameter = {
    name: 'orderId',
    in: 'path',
    required: true,
    schema: { $ref: '#/components/schemas/Bytes32' },
  };
  const orderPageParameters = [
    { name: 'cursorCreatedAt', in: 'query', schema: { type: 'string', format: 'date-time' } },
    { name: 'cursorOrderId', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 256 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
    { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
    { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
    { name: 'skuId', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 256 } },
    { name: 'state', in: 'query', schema: { enum: [...orderProjectionStates] } },
    { name: 'fulfillmentMode', in: 'query', schema: { enum: [...fulfillmentModes] } },
    { name: 'orderKind', in: 'query', schema: { enum: ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] } },
  ];
  const fulfillmentPost = (operationId, requestSchema, responseSchema, status = 200) => ({
    post: {
      operationId,
      security: [{ bearerAuth: [] }],
      parameters: [orderIdParameter],
      requestBody: body({ $ref: `#/components/schemas/${requestSchema}` }),
      responses: {
        [status]: response('Authoritative idempotent fulfillment result', {
          $ref: `#/components/schemas/${responseSchema}`,
        }),
        default: errorResponse,
      },
    },
  });
  const logisticsWebhook = (provider) => ({
    post: {
      operationId: `record${provider}LogisticsWebhook`,
      security: [{ providerSignature: [] }],
      requestBody: body({ $ref: '#/components/schemas/LogisticsWebhookRequest' }),
      responses: {
        202: response('Authenticated immutable logistics event', {
          $ref: '#/components/schemas/LogisticsUpdateResult',
        }),
        default: errorResponse,
      },
    },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Abu 24K V2 Core API', version: artifactVersion },
    'x-artifactVersion': artifactVersion,
    servers: [],
    paths: {
      ...accountOpenApiPaths(errorResponse),
      ...settlementAdminOpenApiPaths(errorResponse),
      ...seckillRuntimeOpenApiPaths(errorResponse),
      ...catalogManagementOpenApiPaths(errorResponse),
      '/v2/bootstrap': {
        get: {
          operationId: 'getBootstrap',
          responses: {
            200: response('Core identity and redacted readiness', { $ref: '#/components/schemas/BootstrapResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/auth/nonce': {
        post: {
          operationId: 'createSiweNonce',
          requestBody: body({ $ref: '#/components/schemas/NonceRequest' }),
          responses: {
            201: response('Bound one-use SIWE challenge', { $ref: '#/components/schemas/SiweChallenge' }),
            default: errorResponse,
          },
        },
      },
      '/v2/auth/verify': {
        post: {
          operationId: 'verifySiwe',
          requestBody: body({ $ref: '#/components/schemas/VerifyRequest' }),
          responses: {
            200: response('Scoped wallet session', { $ref: '#/components/schemas/SessionResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/actions/order': {
        post: {
          operationId: 'getOrderAllowedActions',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/OrderActionRequest' }),
          responses: {
            200: response('Server-authoritative order actions', { $ref: '#/components/schemas/AllowedActionsResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/stores': {
        get: {
          operationId: 'listMerchantStores',
          parameters: [{
            name: 'regionCode',
            in: 'query',
            required: false,
            schema: { type: 'string', pattern: '^[0-9]{6}$' },
          }],
          responses: {
            200: response('Active pickup stores', {
              type: 'object',
              additionalProperties: false,
              required: ['stores'],
              properties: {
                stores: { type: 'array', items: { $ref: '#/components/schemas/MerchantStore' } },
              },
            }),
            default: errorResponse,
          },
        },
        post: {
          operationId: 'createMerchantStore',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/CreateMerchantStoreRequest' }),
          responses: {
            201: response('AMap-bound merchant store', { $ref: '#/components/schemas/MerchantStore' }),
            default: errorResponse,
          },
        },
      },
      '/v2/fulfillment-targets/delivery': {
        post: {
          operationId: 'createDeliveryTarget',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/CreateDeliveryTargetRequest' }),
          responses: {
            201: response('Encrypted delivery target', { $ref: '#/components/schemas/DeliveryTarget' }),
            default: errorResponse,
          },
        },
      },
      '/v2/fulfillment-targets/pickup': {
        post: {
          operationId: 'createPickupTarget',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/CreatePickupTargetRequest' }),
          responses: {
            201: response('Versioned pickup-store target', { $ref: '#/components/schemas/PickupTarget' }),
            default: errorResponse,
          },
        },
      },
      '/v2/orders': {
        get: {
          operationId: 'listFulfillmentOrders',
          security: [{ bearerAuth: [] }],
          parameters: orderPageParameters,
          responses: {
            200: response('Stable wallet-scoped fulfillment order page', {
              $ref: '#/components/schemas/FulfillmentOrderPage',
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/shipments/batches': {
        post: {
          operationId: 'recordShipmentBatch',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/ShipmentBatchRequest' }),
          responses: {
            201: response('Atomic canonical manual-shipment batch', {
              $ref: '#/components/schemas/ShipmentBatchResult',
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/admin/orders': {
        get: {
          operationId: 'searchAdminOrders',
          security: [{ bearerAuth: [] }],
          parameters: [
            ...orderPageParameters,
            { name: 'orderId', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 256 } },
            { name: 'productId', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 256 } },
            { name: 'txHash', in: 'query', schema: { $ref: '#/components/schemas/Bytes32' } },
            { name: 'wallet', in: 'query', schema: { $ref: '#/components/schemas/Address' } },
            { name: 'pendingReview', in: 'query', schema: { type: 'boolean' } },
            { name: 'breakerScope', in: 'query', schema: { $ref: '#/components/schemas/BreakerScope' } },
          ],
          responses: {
            200: response('Exact scoped admin order search', {
              $ref: '#/components/schemas/AdminOrderSearchPage',
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/admin/orders/batch-actions/preview': {
        post: {
          operationId: 'previewAdminOrderBatchActions',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/OrderBatchActionPreviewRequest' }),
          responses: {
            200: response('Read-only row actions and enabled intersection', {
              $ref: '#/components/schemas/OrderBatchActionPreview',
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/orders/{orderId}': {
        get: {
          operationId: 'getFulfillmentOrder',
          security: [{ bearerAuth: [] }],
          parameters: [orderIdParameter],
          responses: {
            200: response('Wallet-scoped fulfillment order', {
              type: 'object',
              additionalProperties: false,
              required: ['order'],
              properties: { order: { $ref: '#/components/schemas/FulfillmentOrder' } },
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/orders/{orderId}/fulfillment-target': {
        get: {
          operationId: 'getOrderFulfillmentTarget',
          security: [{ bearerAuth: [] }],
          parameters: [orderIdParameter],
          responses: {
            200: response('Authorized decrypted order target', {
              type: 'object',
              additionalProperties: false,
              required: ['target'],
              properties: { target: { $ref: '#/components/schemas/FulfillmentTarget' } },
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/orders/{orderId}/shipments': fulfillmentPost(
        'recordShipment', 'ShipmentRequest', 'ShipmentResult', 201,
      ),
      '/v2/orders/{orderId}/delivery': fulfillmentPost(
        'recordDelivery', 'FulfillmentCommandInput', 'DeliveryResult',
      ),
      '/v2/orders/{orderId}/pickup-credential': fulfillmentPost(
        'registerPickupCredential', 'PickupCredentialRequest', 'PickupCredentialResult', 201,
      ),
      '/v2/orders/{orderId}/pickup-verification': fulfillmentPost(
        'verifyPickup', 'PickupVerificationRequest', 'FulfillmentCompletedResult',
      ),
      '/v2/orders/{orderId}/exchange-requests': fulfillmentPost(
        'requestExchange', 'FulfillmentReasonRequest', 'FulfillmentRequestResult', 201,
      ),
      '/v2/orders/{orderId}/delay-requests': fulfillmentPost(
        'requestDelay', 'FulfillmentReasonRequest', 'FulfillmentRequestResult', 201,
      ),
      '/v2/orders/{orderId}/request-decisions': fulfillmentPost(
        'decideFulfillmentRequest', 'FulfillmentRequestDecision', 'FulfillmentRequestDecisionResult',
      ),
      '/v2/orders/{orderId}/arbitrations': fulfillmentPost(
        'openArbitration', 'FulfillmentReasonRequest', 'ArbitrationOpenedResult', 201,
      ),
      '/v2/orders/{orderId}/arbitration-decisions': fulfillmentPost(
        'decideArbitration', 'ArbitrationDecision', 'ArbitrationDecisionResult',
      ),
      '/v2/orders/{orderId}/takeover': fulfillmentPost(
        'openTakeover', 'FulfillmentReasonRequest', 'TakeoverOpenedResult', 201,
      ),
      '/v2/orders/{orderId}/forced-receipt-requests': fulfillmentPost(
        'requestForcedReceipt', 'FulfillmentReasonRequest', 'ForcedReceiptRequestResult', 201,
      ),
      '/v2/orders/{orderId}/forced-receipt-decisions': fulfillmentPost(
        'decideForcedReceipt', 'FulfillmentDecision', 'ForcedReceiptDecisionResult',
      ),
      '/v2/orders/{orderId}/receipt-confirmation': fulfillmentPost(
        'confirmReceipt', 'FulfillmentCommandInput', 'FulfillmentCompletedResult',
      ),
      '/v2/providers/kuaidi100/webhooks/logistics': logisticsWebhook('Kuaidi100'),
      '/v2/providers/cainiao/webhooks/logistics': logisticsWebhook('Cainiao'),
      '/v2/catalog/products': {
        get: {
          operationId: 'listCatalogProducts',
          responses: {
            200: response('Active products and authoritative SKU prices', {
              type: 'object', required: ['products'],
              properties: { products: { type: 'array', items: { $ref: '#/components/schemas/CatalogProduct' } } },
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/catalog/products/{productId}': {
        get: {
          operationId: 'getCatalogProduct',
          parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: response('Active product detail', {
              type: 'object', required: ['product'],
              properties: { product: { $ref: '#/components/schemas/CatalogProduct' } },
            }),
            default: errorResponse,
          },
        },
      },
      '/v2/payments/quotes': {
        post: {
          operationId: 'createOrdinaryPaymentQuote',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/PaymentQuoteRequest' }),
          responses: {
            201: response('Server-authoritative signed ordinary quote', { $ref: '#/components/schemas/PaymentQuoteResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/seckill/quotes': {
        post: {
          operationId: 'createSeckillPaymentQuote',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/SeckillQuoteRequest' }),
          responses: {
            201: response('Signed seckill and retail fallback quote', { $ref: '#/components/schemas/SeckillQuoteResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/payments/submissions': {
        post: {
          operationId: 'submitPaymentTransaction',
          security: [{ bearerAuth: [] }],
          requestBody: body({ $ref: '#/components/schemas/PaymentSubmissionRequest' }),
          responses: {
            202: response('Bound transaction submission', { $ref: '#/components/schemas/PaymentSubmissionResponse' }),
            default: errorResponse,
          },
        },
      },
      '/v2/payments/{orderId}': {
        get: {
          operationId: 'getPaymentProjection',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'orderId', in: 'path', required: true, schema: { $ref: '#/components/schemas/Bytes32' } }],
          responses: {
            200: response('Quote, submission and indexed payment projection', { $ref: '#/components/schemas/PaymentProjection' }),
            default: errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        providerSignature: { type: 'apiKey', in: 'header', name: 'x-provider-signature' },
      },
      schemas: {
        AtomicAmount: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        Bytes32: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
        Address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        CoreErrorCode: { type: 'string', enum: [...coreErrorCodes] },
        AllowedActionName: { type: 'string', enum: [...allowedActionNames] },
        AllowedActionReasonCode: { type: 'string', enum: [...allowedActionReasonCodes] },
        UserRole: { type: 'string', enum: [...userRoles] },
        BreakerScope: { type: 'string', enum: [...breakerScopes] },
        AllowedAction: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'enabled'],
          properties: {
            action: { $ref: '#/components/schemas/AllowedActionName' },
            enabled: { type: 'boolean' },
            reasonCode: { $ref: '#/components/schemas/AllowedActionReasonCode' },
            deadline: { type: 'string', format: 'date-time' },
          },
        },
        Readiness: {
          type: 'object',
          required: [
            'chainId', 'assets', 'decisionBlocked', 'externalBlocked',
            'paymentDecisionBlocked', 'paymentExternalBlocked', 'providers', 'writesEnabled',
          ],
          properties: {
            chainId: { const: BSC_CHAIN_ID },
            assets: {
              type: 'object',
              required: ['usdt', 'npl'],
              properties: { usdt: { const: USDT_ADDRESS }, npl: { const: NPL_ADDRESS } },
            },
            decisionBlocked: { type: 'array', items: { type: 'string' } },
            externalBlocked: { type: 'array', items: { type: 'string' } },
            paymentDecisionBlocked: { type: 'array', items: { type: 'string' } },
            paymentExternalBlocked: { type: 'array', items: { type: 'string' } },
            providers: { type: 'object', additionalProperties: { enum: ['READY', 'CONFIGURATION_REQUIRED'] } },
            writesEnabled: { type: 'boolean' },
          },
        },
        BootstrapResponse: {
          type: 'object',
          additionalProperties: false,
          required: ['artifactVersion', 'status', 'readiness'],
          properties: {
            artifactVersion: { const: artifactVersion },
            status: { const: 'CORE_API_READY' },
            readiness: { $ref: '#/components/schemas/Readiness' },
          },
        },
        NonceRequest: {
          type: 'object', additionalProperties: false, required: ['walletAddress'],
          properties: { walletAddress: { $ref: '#/components/schemas/Address' } },
        },
        SiweChallenge: {
          type: 'object', additionalProperties: false, required: ['message', 'nonce', 'issuedAt', 'expiresAt'],
          properties: {
            message: { type: 'string' }, nonce: { type: 'string' },
            issuedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        VerifyRequest: {
          type: 'object', additionalProperties: false, required: ['message', 'signature'],
          properties: { message: { type: 'string' }, signature: { type: 'string' } },
        },
        SessionResponse: {
          type: 'object', additionalProperties: false, required: ['token', 'walletAddress', 'roles'],
          properties: {
            token: { type: 'string' }, walletAddress: { $ref: '#/components/schemas/Address' },
            roles: { type: 'array', items: { $ref: '#/components/schemas/UserRole' } },
          },
        },
        OrderActionRequest: {
          type: 'object', additionalProperties: false, required: ['orderId'],
          properties: { orderId: { type: 'string', minLength: 1 } },
        },
        AllowedActionsResponse: {
          type: 'object', additionalProperties: false, required: ['allowedActions'],
          properties: { allowedActions: { type: 'array', items: { $ref: '#/components/schemas/AllowedAction' } } },
        },
        ...fulfillmentOpenApiSchemas(),
        ...paymentOpenApiSchemas(),
        ...catalogManagementOpenApiSchemas(),
        ...settlementAdminOpenApiSchemas(),
        ...seckillRuntimeOpenApiSchemas(),
        ...accountOpenApiSchemas(),
        ErrorResponse: {
          type: 'object', additionalProperties: false, required: ['error'],
          properties: {
            error: {
              type: 'object', required: ['code', 'message', 'correlationId'],
              properties: {
                code: { $ref: '#/components/schemas/CoreErrorCode' }, message: { type: 'string' },
                details: { type: 'object' }, correlationId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

function catalogManagementOpenApiPaths(errorResponse) {
  const security = [{ bearerAuth: [] }];
  const parameter = (name) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
  const securedGet = (operationId, parameters, schema, description) => ({
    get: {
      operationId,
      security,
      parameters,
      responses: { 200: response(description, schema), default: errorResponse },
    },
  });
  const securedWrite = (method, operationId, parameters, requestSchema, responseSchema, status = 200) => ({
    [method]: {
      operationId,
      security,
      parameters,
      requestBody: body({ $ref: `#/components/schemas/${requestSchema}` }),
      responses: {
        [status]: response('Authoritative catalog result', { $ref: `#/components/schemas/${responseSchema}` }),
        default: errorResponse,
      },
    },
  });
  const categories = {
    type: 'object', additionalProperties: false, required: ['categories'],
    properties: { categories: { type: 'array', items: { $ref: '#/components/schemas/CatalogCategory' } } },
  };
  const tags = {
    type: 'object', additionalProperties: false, required: ['tags'],
    properties: { tags: { type: 'array', items: { $ref: '#/components/schemas/CatalogTag' } } },
  };
  return {
    '/v2/catalog/categories': {
      get: {
        operationId: 'listCatalogCategories',
        responses: { 200: response('Enabled three-level categories', categories), default: errorResponse },
      },
    },
    '/v2/catalog/tags': {
      get: {
        operationId: 'listCatalogTags',
        responses: { 200: response('Enabled catalog tags', tags), default: errorResponse },
      },
    },
    '/v2/media/upload-intents': securedWrite(
      'post', 'createMediaUploadIntent', [], 'MediaUploadIntentRequest', 'MediaUploadIntentProjection', 201,
    ),
    '/v2/media/upload-intents/{uploadIntentId}/complete': securedWrite(
      'post', 'completeMediaUpload', [parameter('uploadIntentId')], 'EmptyRequest', 'MediaAssetProjection', 200,
    ),
    '/v2/media/assets/{assetId}/access': {
      get: {
        operationId: 'createMediaReadAccess',
        parameters: [parameter('assetId')],
        security: [{ bearerAuth: [] }, {}],
        responses: {
          200: response('Short-lived authorized media read target', {
            $ref: '#/components/schemas/MediaReadAccessProjection',
          }),
          default: errorResponse,
        },
      },
    },
    '/v2/orders/{orderId}/evidence': securedWrite(
      'post', 'createOrderActionEvidence', [parameter('orderId')],
      'OrderActionEvidenceRequest', 'EvidenceEnvelopeProjection', 201,
    ),
    '/v2/orders/{orderId}/tracking-evidence': securedWrite(
      'post', 'createOrderTrackingEvidence', [parameter('orderId')],
      'TrackingEvidenceRequest', 'EvidenceEnvelopeProjection', 201,
    ),
    '/v2/merchant/stores/{storeId}/product-slot': {
      ...securedGet(
        'getMerchantProductSlot',
        [parameter('storeId')],
        { $ref: '#/components/schemas/ProductSlotProjection' },
        'Merchant-bound unique product slot',
      ),
      ...securedWrite(
        'put', 'saveMerchantProductSlot', [parameter('storeId')],
        'ProductSlotInput', 'ManagedCatalogProduct', 200,
      ),
    },
    '/v2/merchant/products/{productId}/concession-previews': securedWrite(
      'post', 'createMerchantConcessionPreview', [parameter('productId')],
      'ConcessionPreviewRequest', 'MerchantConcessionPreview', 201,
    ),
    '/v2/merchant/products/{productId}/review-submissions': securedWrite(
      'post', 'submitMerchantProductReview', [parameter('productId')],
      'ProductReviewSubmissionRequest', 'ManagedCatalogProduct', 201,
    ),
    '/v2/merchant/products/{productId}/delist': securedWrite(
      'post', 'delistMerchantProduct', [parameter('productId')],
      'CatalogReasonRequest', 'ManagedCatalogProduct', 200,
    ),
    '/v2/admin/catalog/categories': {
      ...securedGet('listAdminCatalogCategories', [], categories, 'All versioned categories'),
      ...securedWrite('post', 'createCatalogCategory', [], 'CatalogCategoryInput', 'CatalogCategory', 201),
    },
    '/v2/admin/catalog/categories/{categoryId}': securedWrite(
      'put', 'updateCatalogCategory', [parameter('categoryId')],
      'CatalogCategoryInput', 'CatalogCategory', 200,
    ),
    '/v2/admin/catalog/tags': {
      ...securedGet('listAdminCatalogTags', [], tags, 'All versioned tags'),
      ...securedWrite('post', 'createCatalogTag', [], 'CatalogTagInput', 'CatalogTag', 201),
    },
    '/v2/admin/catalog/tags/{tagId}': securedWrite(
      'put', 'updateCatalogTag', [parameter('tagId')], 'CatalogTagInput', 'CatalogTag', 200,
    ),
    '/v2/admin/catalog/products': securedGet(
      'listAdminCatalogProducts',
      [],
      {
        type: 'object', additionalProperties: false, required: ['products'],
        properties: { products: { type: 'array', items: { $ref: '#/components/schemas/ManagedCatalogProduct' } } },
      },
      'All managed catalog products',
    ),
    '/v2/admin/catalog/stores/{storeId}/product-slot': {
      ...securedGet(
        'getAdminProductSlot',
        [parameter('storeId'), {
          name: 'merchantId', in: 'query', required: false, schema: { type: 'string', minLength: 1 },
        }],
        { $ref: '#/components/schemas/ProductSlotProjection' },
        'Admin product slot projection',
      ),
      ...securedWrite(
        'put', 'saveAdminProductSlot', [parameter('storeId')],
        'AdminProductSlotInput', 'ManagedCatalogProduct', 200,
      ),
    },
    '/v2/admin/catalog/products/{productId}/concession-previews': securedWrite(
      'post', 'createAdminConcessionPreview', [parameter('productId')],
      'ConcessionPreviewRequest', 'MerchantConcessionPreview', 201,
    ),
    '/v2/admin/catalog/products/{productId}/review-decisions': securedWrite(
      'post', 'decideCatalogProductReview', [parameter('productId')],
      'ProductReviewDecisionRequest', 'ManagedCatalogProduct', 200,
    ),
    '/v2/admin/catalog/products/{productId}/review-submissions': securedWrite(
      'post', 'submitAdminProductReview', [parameter('productId')],
      'ProductReviewSubmissionRequest', 'ManagedCatalogProduct', 201,
    ),
    '/v2/admin/catalog/products/{productId}/delist': securedWrite(
      'post', 'delistAdminProduct', [parameter('productId')],
      'CatalogReasonRequest', 'ManagedCatalogProduct', 200,
    ),
    '/v2/admin/catalog/skus/{skuId}/inventory-adjustments': securedWrite(
      'post', 'adjustCatalogInventory', [parameter('skuId')],
      'InventoryAdjustmentRequest', 'InventoryAdjustmentProjection', 201,
    ),
  };
}

function seckillRuntimeOpenApiPaths(errorResponse) {
  const sessionParameter = {
    name: 'sessionId',
    in: 'path',
    required: true,
    schema: { $ref: '#/components/schemas/Bytes32' },
  };
  const cursorParameters = [
    { name: 'cursor', in: 'query', required: false, schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } },
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
  ];
  const read = (operationId, schema, parameters = []) => ({
    operationId,
    parameters,
    responses: {
      200: response('Authoritative seckill projection', { $ref: `#/components/schemas/${schema}` }),
      default: errorResponse,
    },
  });
  return {
    '/v2/seckill/sessions/current': {
      get: read('getCurrentSeckillSession', 'SeckillSessionProjection'),
    },
    '/v2/seckill/sessions/history': {
      get: read('listSeckillSessionHistory', 'SeckillSessionHistoryPage', cursorParameters),
    },
    '/v2/seckill/sessions/{sessionId}': {
      get: read('getSeckillSession', 'SeckillSessionProjection', [sessionParameter]),
    },
    '/v2/seckill/sessions/{sessionId}/events': {
      get: read('listSeckillSessionEvents', 'RealtimeEventPage', [sessionParameter, ...cursorParameters]),
    },
  };
}

function accountOpenApiPaths(errorResponse) {
  const security = [{ bearerAuth: [] }];
  const pathParameter = (name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 256 },
  });
  const operation = (operationId, responseSchema, description) => ({
    operationId,
    security,
    responses: {
      200: response(description, { $ref: `#/components/schemas/${responseSchema}` }),
      default: errorResponse,
    },
  });
  return {
    '/v2/buyer/profile': {
      get: operation('getBuyerProfile', 'BuyerProfile', 'Encrypted buyer profile projection'),
      put: {
        operationId: 'updateBuyerProfile',
        security,
        requestBody: body({ $ref: '#/components/schemas/UpdateBuyerProfileRequest' }),
        responses: {
          200: response('Updated encrypted buyer profile', { $ref: '#/components/schemas/BuyerProfile' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/addresses/parse': {
      post: {
        operationId: 'parseBuyerAddress',
        security,
        requestBody: body({ $ref: '#/components/schemas/ParseBuyerAddressRequest' }),
        responses: {
          200: response('Ephemeral PII-safe address parse', { $ref: '#/components/schemas/ParsedBuyerAddress' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/addresses': {
      get: operation('listBuyerAddresses', 'BuyerAddressList', 'Wallet-scoped encrypted address list'),
      post: {
        operationId: 'createBuyerAddress',
        security,
        requestBody: body({ $ref: '#/components/schemas/CreateBuyerAddressRequest' }),
        responses: {
          201: response('Created encrypted buyer address', { $ref: '#/components/schemas/BuyerSavedAddress' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/addresses/{addressId}': {
      put: {
        operationId: 'updateBuyerAddress',
        security,
        parameters: [pathParameter('addressId')],
        requestBody: body({ $ref: '#/components/schemas/UpdateBuyerAddressRequest' }),
        responses: {
          200: response('Updated encrypted buyer address', { $ref: '#/components/schemas/BuyerSavedAddress' }),
          default: errorResponse,
        },
      },
      delete: {
        operationId: 'deleteBuyerAddress',
        security,
        parameters: [pathParameter('addressId')],
        requestBody: body({ $ref: '#/components/schemas/VersionedAccountCommand' }),
        responses: {
          200: response('Logically deleted buyer address', { $ref: '#/components/schemas/DeletedBuyerAddress' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/addresses/{addressId}/default': {
      post: {
        operationId: 'setDefaultBuyerAddress',
        security,
        parameters: [pathParameter('addressId')],
        requestBody: body({ $ref: '#/components/schemas/VersionedAccountCommand' }),
        responses: {
          200: response('Transactional default buyer address', { $ref: '#/components/schemas/BuyerSavedAddress' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/addresses/{addressId}/fulfillment-target': {
      post: {
        operationId: 'createSavedAddressFulfillmentTarget',
        security,
        parameters: [pathParameter('addressId')],
        requestBody: body({ $ref: '#/components/schemas/IdempotentAccountCommand' }),
        responses: {
          201: response('Fresh quote-bound delivery target from saved address', { $ref: '#/components/schemas/DeliveryTarget' }),
          default: errorResponse,
        },
      },
    },
    '/v2/buyer/overview': {
      get: operation('getBuyerOverview', 'BuyerOverview', 'Canonical buyer order counts'),
    },
    '/v2/orders/{orderId}/takeover-timeline': {
      get: {
        ...operation('getBuyerTakeoverTimeline', 'BuyerTakeoverTimeline', 'Redacted append-only takeover timeline'),
        parameters: [pathParameter('orderId')],
      },
    },
    '/v2/merchant/profile': {
      get: operation('getMerchantProfile', 'MerchantProfile', 'Tenant-scoped merchant profile'),
      put: {
        operationId: 'updateMerchantProfile',
        security,
        requestBody: body({ $ref: '#/components/schemas/UpdateMerchantProfileRequest' }),
        responses: {
          200: response('Updated tenant-scoped merchant profile', { $ref: '#/components/schemas/MerchantProfile' }),
          default: errorResponse,
        },
      },
    },
    '/v2/merchant/audit/entries': {
      get: {
        ...operation('listMerchantAuditEntries', 'MerchantAuditList', 'Tenant-scoped bounded audit summaries'),
        parameters: [
          { name: 'streamName', in: 'query', schema: { enum: [...auditStreamNames] } },
          ...['eventType', 'resourceType', 'resourceId', 'correlationId', 'cursorEntryId'].map((name) => ({
            name,
            in: 'query',
            schema: { type: 'string', minLength: 1 },
          })),
          ...['from', 'to', 'cursorCreatedAt'].map((name) => ({
            name,
            in: 'query',
            schema: { type: 'string', format: 'date-time' },
          })),
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
      },
    },
    '/v2/merchant/audit/exports': {
      post: {
        operationId: 'exportMerchantAuditEntries',
        security,
        requestBody: body({ $ref: '#/components/schemas/MerchantAuditExportRequest' }),
        responses: {
          200: response('Bounded tenant-scoped CSV export', { $ref: '#/components/schemas/MerchantAuditExport' }),
          default: errorResponse,
        },
      },
    },
  };
}

function accountOpenApiSchemas() {
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  const object = (properties, required = Object.keys(properties)) => ({
    type: 'object', additionalProperties: false, required, properties,
  });
  const string = { type: 'string', minLength: 1 };
  const timestamp = { type: 'string', format: 'date-time' };
  const idempotencyKey = { type: 'string', minLength: 8, maxLength: 128 };
  const version = { type: 'integer', minimum: 0 };
  const addressFields = {
    label: { type: 'string', minLength: 1, maxLength: 32 },
    recipientName: { type: 'string', minLength: 1, maxLength: 64 },
    phone: { type: 'string', pattern: '^1[3-9][0-9]{9}$' },
    detailAddress: { type: 'string', minLength: 5, maxLength: 300 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    isDefault: { type: 'boolean' },
  };
  const availableCount = object({ status: { const: 'AVAILABLE' }, count: ref('AtomicAmount') });
  return {
    BuyerProfile: object({
      artifactVersion: { const: artifactVersion },
      wallet: ref('Address'),
      accountId: { type: 'null' },
      accountIdStatus: { const: 'DecisionBlocked' },
      nickname: nullable(string),
      avatarAssetId: nullable(ref('Bytes32')),
      version,
      updatedAt: nullable(timestamp),
    }),
    UpdateBuyerProfileRequest: object({
      nickname: nullable({ type: 'string', minLength: 1, maxLength: 40 }),
      avatarAssetId: nullable(ref('Bytes32')),
      expectedVersion: version,
      idempotencyKey,
    }),
    ParseBuyerAddressRequest: object({ rawText: { type: 'string', minLength: 5, maxLength: 1000 } }),
    ParsedBuyerAddress: object({
      recipientName: nullable(string),
      phone: nullable({ type: 'string' }),
      province: nullable(string),
      city: nullable(string),
      district: nullable(string),
      detailAddress: nullable(string),
      regionCode: nullable({ type: 'string', pattern: '^[0-9]{6}$' }),
      longitude: nullable({ type: 'number' }),
      latitude: nullable({ type: 'number' }),
      sourceReferenceHash: nullable(ref('Bytes32')),
      canSave: { type: 'boolean' },
      missingFields: { type: 'array', items: string },
    }),
    BuyerSavedAddress: object({
      addressId: string,
      ...addressFields,
      province: string,
      city: string,
      district: string,
      formattedAddress: string,
      regionCode: { type: 'string', pattern: '^[0-9]{6}$' },
      version: { type: 'integer', minimum: 1 },
      updatedAt: timestamp,
    }),
    BuyerAddressList: object({
      artifactVersion: { const: artifactVersion },
      addresses: { type: 'array', items: ref('BuyerSavedAddress') },
    }),
    CreateBuyerAddressRequest: object({ ...addressFields, idempotencyKey }),
    UpdateBuyerAddressRequest: object({
      ...addressFields,
      expectedVersion: { type: 'integer', minimum: 1 },
      idempotencyKey,
    }),
    VersionedAccountCommand: object({
      expectedVersion: { type: 'integer', minimum: 1 },
      idempotencyKey,
    }),
    IdempotentAccountCommand: object({ idempotencyKey }),
    DeletedBuyerAddress: object({ addressId: string, status: { const: 'DELETED' } }),
    BuyerOverview: object({
      artifactVersion: { const: artifactVersion },
      wallet: ref('Address'),
      orderCounts: object({
        pendingPayment: object({
          status: { const: 'DecisionBlocked' },
          count: { type: 'null' },
          blocker: { const: 'BUYER_PENDING_PAYMENT_PROJECTION' },
        }),
        pendingShipment: availableCount,
        pendingReceipt: availableCount,
        afterSale: availableCount,
        total: availableCount,
      }),
    }),
    BuyerTakeoverTransition: object({
      transitionId: string,
      fromState: nullable({ enum: [...takeoverStates] }),
      toState: { enum: [...takeoverStates] },
      evidenceType: string,
      occurredAt: timestamp,
    }),
    BuyerTakeoverTimeline: object({
      artifactVersion: { const: artifactVersion },
      orderId: string,
      historyStatus: { enum: ['COMPLETE', 'PARTIAL_LEGACY'] },
      transitions: { type: 'array', items: ref('BuyerTakeoverTransition') },
    }),
    MerchantProfile: object({
      artifactVersion: { const: artifactVersion },
      merchantId: string,
      shopName: nullable(string),
      logoAssetId: nullable(ref('Bytes32')),
      settlementWallet: ref('Address'),
      settlementWalletMutable: { const: false },
      version: { type: 'integer', minimum: 1 },
      updatedAt: timestamp,
    }),
    UpdateMerchantProfileRequest: object({
      shopName: { type: 'string', minLength: 1, maxLength: 100 },
      logoAssetId: nullable(ref('Bytes32')),
      expectedVersion: { type: 'integer', minimum: 1 },
      idempotencyKey,
    }),
    MerchantAuditEntry: object({
      entryId: string,
      operationTime: timestamp,
      operationType: string,
      module: string,
      detail: string,
      signatureHash: nullable(ref('Bytes32')),
      safeOrChainTxHash: nullable(ref('Bytes32')),
      entryHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    }),
    MerchantAuditList: object({
      entries: { type: 'array', items: ref('MerchantAuditEntry') },
      proofScope: { const: 'MERCHANT_SCOPED_ENTRY_HASHES' },
      historyStatus: { const: 'PARTIAL_PRE_MERCHANT_SCOPE' },
      chainProof: object({
        merchantId: string,
        entries: { type: 'integer', minimum: 0 },
      }),
      nextCursor: nullable(object({ createdAt: timestamp, entryId: string })),
    }),
    MerchantAuditExportRequest: object({
      from: timestamp,
      to: timestamp,
      streamName: { enum: [...auditStreamNames] },
      eventType: string,
      resourceType: string,
      idempotencyKey,
    }, ['from', 'to', 'idempotencyKey']),
    MerchantAuditExport: object({
      contentType: { const: 'text/csv; charset=utf-8' },
      filename: string,
      entryCount: { type: 'integer', minimum: 0, maximum: 1000 },
      csv: { type: 'string' },
    }),
  };
}

function seckillRuntimeOpenApiSchemas() {
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  const timestamp = { type: 'string', format: 'date-time' };
  const atomic = ref('AtomicAmount');
  const string = { type: 'string', minLength: 1 };
  const jsonObject = { type: 'object', additionalProperties: true };
  const object = (properties, required = Object.keys(properties)) => ({
    type: 'object', additionalProperties: false, required, properties,
  });
  const session = object({
    artifactVersion: { const: artifactVersion },
    sessionId: ref('Bytes32'),
    policyVersion: atomic,
    merchantId: string,
    product: object({
      productId: string,
      skuId: string,
      title: string,
      metadata: jsonObject,
      attributes: jsonObject,
      seckillListPriceUsdt: atomic,
    }),
    phase: { enum: [...seckillStates] },
    storedPhase: { enum: [...seckillStates] },
    serverTime: timestamp,
    startsAt: timestamp,
    mainDeadline: timestamp,
    relayDeadline: timestamp,
    settlementEarliestAt: timestamp,
    settlementDeadline: timestamp,
    timers: object({
      mainDurationSeconds: { type: 'integer', minimum: 1 },
      relayInitialSeconds: { type: 'integer', minimum: 1 },
      relayIncrementSeconds: { type: 'integer', minimum: 1 },
      relayCapSeconds: { type: 'integer', minimum: 1 },
    }),
    inventory: object({
      total: atomic,
      sold: atomic,
      reserved: atomic,
      available: atomic,
    }),
    prizePoolUsdt: atomic,
    lastBuyerWallet: nullable(ref('Address')),
    winnerWallet: nullable(ref('Address')),
    snapshot: jsonObject,
    allowedActions: { type: 'array', items: string },
  });
  return {
    SeckillSessionProjection: session,
    SeckillSessionHistoryPage: object({
      items: { type: 'array', items: ref('SeckillSessionProjection') },
      nextCursor: nullable({ type: 'string', pattern: '^(0|[1-9][0-9]*)$' }),
    }),
    RealtimeEventEnvelope: object({
      artifactVersion: { const: artifactVersion },
      protocolVersion: { const: 1 },
      eventId: string,
      channel: string,
      cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      eventType: { const: 'SeckillRelayExtended' },
      resourceType: { const: 'SECKILL_SESSION' },
      resourceId: ref('Bytes32'),
      occurredAt: timestamp,
      finality: { const: 'FINAL' },
      payload: jsonObject,
    }),
    RealtimeEventPage: object({
      items: { type: 'array', items: ref('RealtimeEventEnvelope') },
      nextCursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    }),
  };
}

function settlementAdminOpenApiPaths(errorResponse) {
  const security = [{ bearerAuth: [] }];
  const resourceParameter = (name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1 },
  });
  const operation = (operationId, responseSchema, status = 200, requestSchema) => ({
    operationId,
    security,
    ...(requestSchema ? { requestBody: body({ $ref: `#/components/schemas/${requestSchema}` }) } : {}),
    responses: {
      [status]: response('Authoritative Core result', responseSchema),
      default: errorResponse,
    },
  });
  const resourceOperation = (operationId, parameter, responseSchema, status = 200, requestSchema) => ({
    ...operation(operationId, responseSchema, status, requestSchema),
    parameters: [resourceParameter(parameter)],
  });
  return {
    '/v2/settlement-intents': {
      post: operation('createSettlementIntent', { $ref: '#/components/schemas/SettlementIntentProjection' }, 201, 'SettlementIntentRequest'),
    },
    '/v2/admin/settlement-intents': {
      post: operation('createGovernedSettlementIntent', { $ref: '#/components/schemas/SettlementIntentProjection' }, 201, 'GovernedSettlementIntentRequest'),
    },
    '/v2/settlement-requests': {
      post: operation('submitSettlementRequest', { $ref: '#/components/schemas/SettlementRequestProjection' }, 201, 'SettlementRequestSubmission'),
    },
    '/v2/settlements': {
      get: operation('listSettlements', { $ref: '#/components/schemas/SettlementListProjection' }),
    },
    '/v2/merchant/dashboard': {
      get: operation('getMerchantBusinessDashboard', { $ref: '#/components/schemas/MerchantBusinessDashboard' }),
    },
    '/v2/admin/dashboard': {
      get: operation('getAdminBusinessDashboard', { $ref: '#/components/schemas/AdminBusinessDashboard' }),
    },
    '/v2/finance/merchant': {
      get: {
        ...operation('getMerchantFinance', { $ref: '#/components/schemas/MerchantFinanceProjection' }),
        parameters: [{ name: 'merchantId', in: 'query', required: false, schema: { type: 'string', minLength: 1 } }],
      },
    },
    '/v2/finance/merchant/guarantee-deposits': {
      post: operation('submitMerchantGuaranteeDeposit', { $ref: '#/components/schemas/GuaranteeDepositProjection' }, 201, 'GuaranteeDepositRequest'),
    },
    '/v2/admin/takeover-funding/approval-challenge': {
      post: operation('createTakeoverFundingApprovalChallenge', { $ref: '#/components/schemas/TakeoverFundingChallenge' }, 200, 'TakeoverFundingChallengeRequest'),
    },
    '/v2/admin/takeover-funding': {
      post: operation('fundTakeover', { $ref: '#/components/schemas/TakeoverFundingResult' }, 201, 'TakeoverFundingRequest'),
    },
    '/v2/admin/takeover-funding/{caseId}': {
      get: resourceOperation('getTakeoverFunding', 'caseId', { $ref: '#/components/schemas/TakeoverFundingDetail' }),
    },
    '/v2/cms/public': {
      get: {
        operationId: 'listPublicCms',
        parameters: [
          { name: 'walletAddress', in: 'query', required: false, schema: { $ref: '#/components/schemas/Address' } },
          { name: 'merchantId', in: 'query', required: false, schema: { type: 'string', minLength: 1 } },
          { name: 'regionCode', in: 'query', required: false, schema: { $ref: '#/components/schemas/RegionCode' } },
        ],
        responses: {
          200: response('Published CMS items', { type: 'array', items: { $ref: '#/components/schemas/CmsPublicItem' } }),
          default: errorResponse,
        },
      },
    },
    '/v2/notification-endpoints': {
      post: operation('registerNotificationEndpoint', { $ref: '#/components/schemas/NotificationEndpointProjection' }, 201, 'NotificationEndpointRequest'),
    },
    '/v2/notifications': {
      get: {
        ...operation('listNotifications', { type: 'array', items: { $ref: '#/components/schemas/NotificationInboxItem' } }),
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } }],
      },
    },
    '/v2/admin/policy-drafts': {
      get: operation('listPolicyDrafts', { type: 'array', items: { $ref: '#/components/schemas/PolicyDraftProjection' } }),
      post: operation('createPolicyDraft', { $ref: '#/components/schemas/PolicyDraftDetail' }, 201, 'PolicyDraftCreateRequest'),
    },
    '/v2/admin/policy-drafts/{draftId}': {
      get: resourceOperation('getPolicyDraft', 'draftId', { $ref: '#/components/schemas/PolicyDraftDetail' }),
      put: resourceOperation('updatePolicyDraft', 'draftId', { $ref: '#/components/schemas/PolicyDraftDetail' }, 200, 'PolicyDraftUpdateRequest'),
    },
    '/v2/admin/policy-drafts/{draftId}/approval-challenge': {
      post: resourceOperation('createPolicyApprovalChallenge', 'draftId', { $ref: '#/components/schemas/PolicyApprovalChallenge' }, 200, 'PolicyApprovalChallengeRequest'),
    },
    '/v2/admin/policy-drafts/{draftId}/secondary-signature': {
      post: resourceOperation('submitPolicySecondarySignature', 'draftId', { $ref: '#/components/schemas/PolicyDraftDetail' }, 200, 'PolicySecondarySignatureRequest'),
    },
    '/v2/admin/policy-drafts/{draftId}/safe-proposal': {
      post: resourceOperation('proposePolicyToSafe', 'draftId', { $ref: '#/components/schemas/PolicyDraftDetail' }, 202, 'EmptyObject'),
    },
    '/v2/admin/cms/versions': {
      post: operation('createCmsVersion', { $ref: '#/components/schemas/CmsVersionProjection' }, 201, 'CmsVersionCreateRequest'),
    },
    '/v2/admin/cms/versions/{versionId}': {
      get: resourceOperation('getCmsVersion', 'versionId', { $ref: '#/components/schemas/CmsVersionProjection' }),
    },
    '/v2/admin/cms/versions/{versionId}/publish': {
      post: resourceOperation('publishCmsVersion', 'versionId', { $ref: '#/components/schemas/CmsVersionProjection' }, 200, 'EvidenceHashRequest'),
    },
    '/v2/admin/cms/versions/{versionId}/rollback': {
      post: resourceOperation('rollbackCmsVersion', 'versionId', { $ref: '#/components/schemas/CmsVersionProjection' }, 200, 'EvidenceHashRequest'),
    },
    '/v2/admin/notification-campaigns': {
      post: operation('createNotificationCampaign', { $ref: '#/components/schemas/NotificationCampaignCreateResult' }, 201, 'NotificationCampaignRequest'),
    },
    '/v2/admin/notification-campaigns/{campaignId}/publish': {
      post: resourceOperation('publishNotificationCampaign', 'campaignId', { $ref: '#/components/schemas/NotificationCampaignPublishResult' }, 200, 'EvidenceHashRequest'),
    },
    '/v2/admin/system-config/versions': {
      get: operation('listSystemConfigVersions', { type: 'array', items: { $ref: '#/components/schemas/SystemConfigProjection' } }),
      post: operation('createSystemConfigVersion', { $ref: '#/components/schemas/SystemConfigProjection' }, 201, 'SystemConfigCreateRequest'),
    },
    '/v2/admin/system-config/versions/{configVersionId}/publish': {
      post: resourceOperation('publishSystemConfigVersion', 'configVersionId', { $ref: '#/components/schemas/SystemConfigProjection' }, 200, 'SystemConfigPublishRequest'),
    },
    '/v2/admin/audit/entries': {
      get: {
        ...operation('listAuditEntries', { $ref: '#/components/schemas/AuditListResponse' }),
        parameters: [
          { name: 'streamName', in: 'query', required: false, schema: { enum: [...auditStreamNames] } },
          ...['eventType', 'resourceType', 'resourceId', 'correlationId', 'cursorEntryId'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string', minLength: 1 } })),
          { name: 'actorWallet', in: 'query', required: false, schema: { $ref: '#/components/schemas/Address' } },
          ...['from', 'to', 'cursorCreatedAt'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string', format: 'date-time' } })),
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
      },
    },
    '/v2/admin/monitoring': {
      get: operation('getMonitoringDashboard', { $ref: '#/components/schemas/MonitoringDashboard' }),
    },
    '/v2/admin/monitoring/alerts/{alertKey}/acknowledge': {
      post: resourceOperation('acknowledgeMonitoringAlert', 'alertKey', { $ref: '#/components/schemas/MonitoringAcknowledgeResult' }, 200, 'EmptyObject'),
    },
  };
}

function openApiHttpSurface(document) {
  return Object.entries(document.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

function settlementAdminOpenApiSchemas() {
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({
    type: 'object', additionalProperties, required, properties,
  });
  const timestamp = { type: 'string', format: 'date-time' };
  const nullableTimestamp = nullable(timestamp);
  const string = { type: 'string', minLength: 1 };
  const nullableString = nullable(string);
  const atomic = ref('AtomicAmount');
  const nullableAtomic = nullable(atomic);
  const hash = ref('Bytes32');
  const nullableHash = nullable(hash);
  const auditHash = { type: 'string', pattern: '^[0-9a-f]{64}$' };
  const nullableAuditHash = nullable(auditHash);
  const address = ref('Address');
  const nullableAddress = nullable(address);
  const jsonObject = { type: 'object', additionalProperties: true };
  const idempotencyKey = ref('IdempotencyKey');
  const emptyObject = object({});
  const sensitiveApprovalProperties = {
    action: string,
    resourceType: string,
    resourceId: string,
    policyVersion: atomic,
    oldValueHash: hash,
    newValueHash: hash,
    safeAddress: address,
    nonce: atomic,
    deadline: atomic,
    signature: { type: 'string', pattern: '^0x(?:[0-9a-fA-F]{2})+$' },
  };
  const settlementIntentItem = object({
    itemIndex: { type: 'integer', minimum: 0 },
    orderId: string,
    accountId: string,
    backingSafeAddress: address,
    amount: atomic,
    itemHash: hash,
  });
  const settlementIntent = object({
    intentId: hash,
    artifactVersion: { const: artifactVersion },
    wallet: address,
    recipient: address,
    rail: { enum: [...settlementRails] },
    asset: address,
    safeAddress: address,
    amount: atomic,
    itemsHash: hash,
    nonce: atomic,
    deadline: { type: 'integer', minimum: 1 },
  });
  const eip712TypedData = object({
    domain: jsonObject,
    types: jsonObject,
    primaryType: string,
    message: jsonObject,
  });
  const settlementRequestItem = object({
    item_index: { type: 'integer', minimum: 0 },
    order_id: string,
    account_id: string,
    backing_safe_address: address,
    amount: atomic,
    requested_journal_id: string,
    batched_journal_id: nullableString,
    settled_journal_id: nullableString,
  });
  const settlementTransition = object({
    transition_id: string,
    request_item_index: { type: 'integer', minimum: 0 },
    batch_id: nullableString,
    transition_sequence: atomic,
    transition_type: string,
    journal_id: string,
    created_at: timestamp,
  });
  const settlementRequestProperties = {
    request_id: string,
    intent_id: hash,
    artifact_version: { const: artifactVersion },
    wallet_address: address,
    recipient_address: address,
    rail: { enum: [...settlementRails] },
    asset: { enum: ['USDT', 'NPL'] },
    asset_address: address,
    safe_address: address,
    amount: atomic,
    items_hash: hash,
    intent_digest: hash,
    signature_hash: hash,
    state: { enum: [...settlementRequestStates] },
    batch_id: nullableString,
    final_safe_tx_hash: nullableHash,
    final_execution_tx_hash: nullableHash,
    requested_at: timestamp,
    batched_at: nullableTimestamp,
    settled_at: nullableTimestamp,
    items: { type: 'array', items: settlementRequestItem },
    transitions: { type: 'array', items: settlementTransition },
  };
  const fundingPlan = object({
    caseId: string,
    orderId: string,
    policyVersion: { type: 'integer', minimum: 1 },
    requiredUsdt: atomic,
    operationsSafe: address,
    guaranteeUsedUsdt: atomic,
    receivables: {
      type: 'array',
      items: object({ orderId: string, accountId: string, backingSafeAddress: address, amount: atomic }),
    },
    frozenReceivablesUsedUsdt: atomic,
    platformAdvanceUsdt: atomic,
    oldValueHash: hash,
    newValueHash: hash,
  });
  const fundingProjection = object({
    case_id: string,
    state: { enum: [...takeoverStates] },
    required_usdt: nullableAtomic,
    guarantee_used_usdt: nullableAtomic,
    merchant_available_used_usdt: nullableAtomic,
    future_proceeds_used_usdt: nullableAtomic,
    platform_advance_usdt: nullableAtomic,
    merchant_debt_usdt: nullableAtomic,
  });
  const policyDraftProperties = {
    draftId: string,
    nextPolicyVersion: atomic,
    basePolicyVersion: nullableAtomic,
    artifactVersion: nullableString,
    payload: jsonObject,
    validationErrors: {
      type: 'array',
      items: object({ code: string, field: string }),
    },
    state: { enum: [...policyDraftStates] },
    policyHash: nullableHash,
    operationsHash: nullableHash,
    publicationDigest: nullableHash,
    publicationNonce: nullableAtomic,
    publicationDeadline: nullableTimestamp,
    secondarySigner: nullableAddress,
    secondarySignatureHash: nullableHash,
    safeAddress: nullableAddress,
    safeCalldataHash: nullableHash,
    safeTxHash: nullableHash,
    safeProposalHash: nullableHash,
    createdBy: address,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const cmsProjectionProperties = {
    entryId: string,
    versionId: string,
    version: { type: 'integer', minimum: 1 },
    slug: string,
    contentType: { enum: [...cmsContentTypes] },
    placement: string,
    locale: string,
    contentFormat: { enum: [...cmsContentFormats] },
    content: jsonObject,
    contentHash: hash,
    audience: jsonObject,
    startsAt: nullableTimestamp,
    endsAt: nullableTimestamp,
    frequencyCap: nullable({ type: 'integer', minimum: 1 }),
    policyVersion: nullableAtomic,
    published: { type: 'boolean' },
    publicationType: nullable({ enum: [...cmsPublicationEventTypes] }),
    createdBy: address,
    createdAt: timestamp,
  };
  const configProjectionProperties = {
    configVersionId: string,
    configKey: { enum: [...systemConfigKeys] },
    version: { type: 'integer', minimum: 1 },
    payload: jsonObject,
    payloadHash: hash,
    effectiveFrom: timestamp,
    published: { type: 'boolean' },
    createdBy: address,
    createdAt: timestamp,
  };
  return {
    EmptyObject: emptyObject,
    SensitiveApproval: object(sensitiveApprovalProperties),
    EvidenceHashRequest: object({ evidenceHash: hash }),
    SettlementIntentRequest: object({
      rail: { enum: ['MERCHANT_USDT', 'REWARD_NPL', 'PRIZE_USDT'] },
      amount: atomic,
      idempotencyKey,
    }),
    GovernedSettlementIntentRequest: object({
      rail: { enum: ['TAKEOVER_USDT', 'OPERATIONS_REIMBURSEMENT_USDT'] },
      resourceId: string,
      orderId: string,
      accountId: string,
      recipient: address,
      fulfillmentTargetHash: hash,
      amount: atomic,
      idempotencyKey,
      approval: ref('SensitiveApproval'),
    }, ['rail', 'resourceId', 'orderId', 'accountId', 'recipient', 'amount', 'idempotencyKey', 'approval']),
    SettlementRequestSubmission: object({
      intentId: hash,
      signature: { type: 'string', pattern: '^0x(?:[0-9a-fA-F]{2})+$' },
    }),
    SettlementRequestIntent: settlementIntent,
    SettlementIntentItem: settlementIntentItem,
    SettlementIntentProjection: object({
      intent: ref('SettlementRequestIntent'),
      digest: hash,
      typedData: eip712TypedData,
      items: { type: 'array', items: ref('SettlementIntentItem') },
      createdAt: timestamp,
    }),
    SettlementRequestItem: settlementRequestItem,
    SettlementRequestItemTransition: settlementTransition,
    SettlementRequestProjection: object(settlementRequestProperties),
    RewardSubtype: { type: 'string', enum: [...rewardSubtypes] },
    SettlementBalance: object({
      asset: { enum: ['USDT', 'NPL'] },
      purpose: string,
      rewardSubtype: nullable(ref('RewardSubtype')),
      state: { enum: [...balanceStates] },
      amount: atomic,
    }),
    BnmPointsBalance: object({
      pointsType: { const: 'BNM' },
      purpose: { const: 'BNM_LIABILITY' },
      state: { enum: ['LOCKED', 'AVAILABLE'] },
      amount: atomic,
      transferable: { const: false },
    }),
    SettlementListProjection: object({
      artifactVersion: { const: artifactVersion },
      wallet: address,
      balances: { type: 'array', items: ref('SettlementBalance') },
      points: { type: 'array', items: ref('BnmPointsBalance') },
      requests: { type: 'array', items: ref('SettlementRequestProjection') },
    }),
    GuaranteeDepositRequest: object({
      policyVersion: atomic,
      expectedAmountUsdt: atomic,
      transactionHash: hash,
      idempotencyKey,
    }),
    GuaranteeDepositProjection: object({
      depositId: string,
      merchantId: string,
      policyVersion: { type: 'integer', minimum: 1 },
      transactionHash: hash,
      expectedAmountUsdt: atomic,
      operationsSafeAddress: address,
      state: { enum: [...merchantGuaranteeDepositStates] },
      confirmations: { type: 'integer', minimum: 0 },
      blockNumber: { type: 'integer', minimum: 0 },
      blockHash: hash,
      logIndex: { type: 'integer', minimum: 0 },
    }, [
      'depositId', 'merchantId', 'policyVersion', 'transactionHash', 'expectedAmountUsdt',
      'operationsSafeAddress', 'state', 'confirmations',
    ]),
    TakeoverFundingChallengeRequest: object({ caseId: string, requiredUsdt: atomic, nonce: atomic, deadline: atomic }),
    TakeoverFundingRequest: object({ caseId: string, requiredUsdt: atomic, idempotencyKey, approval: ref('SensitiveApproval') }),
    TakeoverFundingPlan: fundingPlan,
    TakeoverFundingChallenge: object({ plan: ref('TakeoverFundingPlan'), typedData: eip712TypedData }),
    TakeoverFundingResult: object({
      caseId: string,
      state: { const: 'FUNDED' },
      requiredUsdt: atomic,
      guaranteeUsedUsdt: atomic,
      frozenReceivablesUsedUsdt: atomic,
      futureProceedsUsedUsdt: atomic,
      platformAdvanceUsdt: atomic,
      merchantDebtUsdt: atomic,
    }),
    MerchantFinanceMerchant: object({ merchant_id: string, status: string, guarantee_status: { enum: [...guaranteeStatuses] }, settlement_wallet: address }),
    MerchantGuarantee: object({
      backing_safe_address: address,
      balance_usdt: atomic,
      minimum_usdt: atomic,
      source_evidence_hash: hash,
      updated_at: timestamp,
    }),
    MerchantGuaranteeDeposit: object({
      deposit_id: string,
      policy_version: atomic,
      token_address: address,
      operations_safe_address: address,
      expected_amount_usdt: atomic,
      transaction_hash: hash,
      state: { enum: [...merchantGuaranteeDepositStates] },
      observed_block_number: nullableAtomic,
      observed_block_hash: nullableHash,
      observed_log_index: nullable({ type: 'integer', minimum: 0 }),
      confirmations: { type: 'integer', minimum: 0 },
      transfer_evidence_hash: nullableHash,
      created_at: timestamp,
      updated_at: timestamp,
      finalized_at: nullableTimestamp,
    }),
    MerchantDebt: object({
      incurred_usdt: atomic,
      recovered_usdt: atomic,
      outstanding_usdt: atomic,
      latest_evidence_hash: hash,
      updated_at: timestamp,
    }),
    MerchantTakeover: object({
      case_id: string,
      order_id: string,
      state: { enum: [...takeoverStates] },
      required_usdt: nullableAtomic,
      guarantee_used_usdt: nullableAtomic,
      merchant_available_used_usdt: nullableAtomic,
      future_proceeds_used_usdt: nullableAtomic,
      platform_advance_usdt: nullableAtomic,
      disbursed_usdt: nullableAtomic,
      merchant_debt_usdt: nullableAtomic,
      evidence_hash: hash,
      opened_at: timestamp,
      closed_at: nullableTimestamp,
      updated_at: timestamp,
    }),
    MerchantFinanceProjection: object({
      merchant: ref('MerchantFinanceMerchant'),
      guarantee: nullable(ref('MerchantGuarantee')),
      guaranteeDeposits: { type: 'array', items: ref('MerchantGuaranteeDeposit') },
      debt: nullable(ref('MerchantDebt')),
      takeovers: { type: 'array', items: ref('MerchantTakeover') },
    }),
    TakeoverFundingProjection: fundingProjection,
    TakeoverFundingItem: object({ source_type: string, amount_usdt: atomic, journal_id: string, evidence_hash: hash, created_at: timestamp }),
    MerchantDebtRecovery: object({
      recovery_id: string,
      order_id: string,
      amount_usdt: atomic,
      operations_safe_address: address,
      backing_safe_address: address,
      journal_id: string,
      evidence_hash: hash,
      recovered_at: timestamp,
      reversed_at: nullableTimestamp,
      reversal_evidence_hash: nullableHash,
    }),
    TakeoverFundingDetail: object({
      ...fundingProjection.properties,
      items: { type: 'array', items: ref('TakeoverFundingItem') },
      debtRecoveries: { type: 'array', items: ref('MerchantDebtRecovery') },
    }),
    PolicyDraftCreateRequest: object({ payload: jsonObject, idempotencyKey }),
    PolicyDraftUpdateRequest: object({ payload: jsonObject }),
    PolicyApprovalChallengeRequest: object({ nonce: atomic, deadline: atomic }),
    PolicySecondarySignatureRequest: object({
      nonce: atomic,
      deadline: atomic,
      signature: { type: 'string', pattern: '^0x(?:[0-9a-fA-F]{2})+$' },
    }),
    PolicyDraftProjection: object(policyDraftProperties),
    PolicyDraftTransition: object({
      transitionId: string,
      fromState: nullable({ enum: [...policyDraftStates] }),
      toState: { enum: [...policyDraftStates] },
      evidenceHash: hash,
      actorWallet: address,
      createdAt: timestamp,
    }),
    PolicyDraftDetail: object({
      ...policyDraftProperties,
      transitions: { type: 'array', items: ref('PolicyDraftTransition') },
    }),
    PolicyApprovalChallenge: object({
      draftId: string,
      policyVersion: { type: 'integer', minimum: 1 },
      signer: address,
      typedData: eip712TypedData,
      digest: hash,
    }),
    CmsVersionCreateRequest: object({
      entryId: string,
      slug: string,
      contentType: { enum: [...cmsContentTypes] },
      placement: string,
      locale: string,
      contentFormat: { enum: [...cmsContentFormats] },
      content: jsonObject,
      audience: jsonObject,
      startsAt: timestamp,
      endsAt: timestamp,
      frequencyCap: { type: 'integer', minimum: 1, maximum: 1000 },
      policyVersion: atomic,
      idempotencyKey,
    }, ['slug', 'contentType', 'placement', 'locale', 'contentFormat', 'content', 'audience', 'idempotencyKey']),
    CmsVersionProjection: object(cmsProjectionProperties),
    CmsPublicItem: object({
      entryId: string,
      versionId: string,
      version: { type: 'integer', minimum: 1 },
      slug: string,
      contentType: { enum: [...cmsContentTypes] },
      placement: string,
      locale: string,
      content: jsonObject,
      contentHash: hash,
      audience: jsonObject,
      startsAt: nullableTimestamp,
      endsAt: nullableTimestamp,
      frequencyCap: nullable({ type: 'integer', minimum: 1 }),
      policyVersion: nullableAtomic,
    }),
    NotificationEndpointRequest: object({
      channel: { enum: [...notificationChannels] },
      provider: { enum: [...notificationProviders] },
      endpointReference: string,
      topics: { type: 'array', items: string },
      regionCode: ref('RegionCode'),
    }, ['channel', 'provider', 'endpointReference', 'topics']),
    NotificationEndpointProjection: object({
      endpointId: string,
      channel: { enum: [...notificationChannels] },
      provider: { enum: [...notificationProviders] },
      topics: { type: 'array', items: string },
      state: { enum: [...notificationEndpointStates] },
    }),
    NotificationInboxItem: object({
      messageId: string,
      sourceEventType: string,
      topic: string,
      templateData: jsonObject,
      deliveryState: { enum: [...notificationDeliveryStates] },
      createdAt: timestamp,
    }),
    NotificationCampaignRequest: object({
      topic: { enum: [...notificationCampaignTopics] },
      audience: jsonObject,
      message: jsonObject,
      cmsVersionId: string,
      startsAt: timestamp,
      endsAt: timestamp,
      idempotencyKey,
    }, ['topic', 'audience', 'message', 'idempotencyKey']),
    NotificationCampaignCreateResult: object({
      campaignId: string,
      state: { enum: [...notificationCampaignStates] },
      contentHash: hash,
    }),
    NotificationCampaignPublishResult: object({ campaignId: string, state: { const: 'PUBLISHED' } }),
    SystemConfigCreateRequest: object({
      configKey: { enum: [...systemConfigKeys] },
      payload: jsonObject,
      effectiveFrom: timestamp,
      idempotencyKey,
    }),
    SystemConfigPublishRequest: object({ approval: ref('SensitiveApproval') }),
    SystemConfigProjection: object(configProjectionProperties),
    AuditEntry: object({
      entryId: string,
      sourceEventId: string,
      streamName: { enum: [...auditStreamNames] },
      evidenceProfile: { enum: [...auditEvidenceProfiles] },
      sequence: atomic,
      eventType: string,
      resourceType: string,
      resourceId: string,
      actorWallet: nullableAddress,
      actorRole: nullableString,
      correlationId: string,
      requestHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      payload: jsonObject,
      signatureEvidence: nullable(jsonObject),
      authorizationEvidence: nullable(jsonObject),
      transactionEvidence: nullable(jsonObject),
      previousHash: auditHash,
      entryHash: auditHash,
      createdAt: timestamp,
    }),
    AuditChainProof: object({ verified: { type: 'boolean' }, entries: { type: 'integer', minimum: 0 }, headHash: nullableAuditHash }),
    AuditListResponse: object({
      entries: { type: 'array', items: ref('AuditEntry') },
      chainProof: { type: 'object', additionalProperties: ref('AuditChainProof') },
      nextCursor: nullable(object({ createdAt: timestamp, entryId: string })),
    }),
    MonitoringMetric: object({
      snapshotId: string,
      component: { enum: [...operationsMetricComponents] },
      metricName: string,
      unit: { enum: [...operationsMetricUnits] },
      value: nullable({ type: 'number' }),
      status: { enum: [...operationsMetricStatuses] },
      windowStartedAt: timestamp,
      windowEndedAt: timestamp,
      evidence: jsonObject,
      observedAt: timestamp,
    }),
    MonitoringAlert: object({
      alertEventId: string,
      alertKey: string,
      state: { enum: [...operationsAlertEventTypes] },
      severity: { enum: [...operationsAlertSeverities] },
      snapshotId: string,
      actorWallet: nullableAddress,
      createdAt: timestamp,
    }),
    MonitoringCoverage: object({
      asset: { enum: ['USDT', 'NPL'] },
      safe_address: address,
      assets: atomic,
      unsettled_liabilities: atomic,
      covered: { type: 'boolean' },
      observed_at: timestamp,
    }),
    MonitoringDashboard: object({
      metrics: { type: 'array', items: ref('MonitoringMetric') },
      alerts: { type: 'array', items: ref('MonitoringAlert') },
      coverage: { type: 'array', items: ref('MonitoringCoverage') },
    }),
    MonitoringAcknowledgeResult: object({ alertKey: string, state: { const: 'ACKNOWLEDGED' } }),
    BusinessDayWindow: object({ start: timestamp, end: timestamp, generatedAt: timestamp }),
    BusinessRatio: object({ numerator: atomic, denominator: atomic, bps: nullableAtomic }),
    MerchantBusinessDashboard: object({
      artifactVersion: { const: artifactVersion },
      timezone: { const: 'Asia/Shanghai' },
      window: ref('BusinessDayWindow'),
      merchant: object({ merchantId: string, status: string, level: string, guaranteeStatus: { enum: [...guaranteeStatuses] } }),
      product: nullable(object({
        productId: string,
        title: string,
        state: { enum: [...catalogProductLifecycleStates] },
        stock: object({ total: atomic, available: atomic, reserved: atomic }),
        seckill: nullable(object({ sessionId: hash, phase: { enum: [...seckillStates] } })),
        updatedAt: timestamp,
      })),
      orders: object({
        finalizedToday: atomic, pendingShipment: atomic, shipped: atomic, delivered: atomic,
        fulfilled: atomic, arbitration: atomic, takeover: atomic, pickupVerifiedToday: atomic,
      }),
      sales: object({
        listPriceUsdt: atomic, buyerUsdtPaid: atomic,
        merchantBaseReceivableUsdt: atomic, merchantNetReceivableUsdt: atomic,
      }),
      shipmentRate: ref('BusinessRatio'),
      settlements: object({ requestedCount: atomic, requestedUsdt: atomic, settledCount: atomic, settledUsdt: atomic }),
    }),
    AdminBusinessDashboard: object({
      artifactVersion: { const: artifactVersion },
      timezone: { const: 'Asia/Shanghai' },
      window: ref('BusinessDayWindow'),
      orders: object({
        finalizedToday: atomic, listPriceUsdt: atomic, buyerUsdtPaid: atomic,
        pendingShipment: atomic, shipped: atomic, delivered: atomic, fulfilled: atomic,
        shipmentRate: ref('BusinessRatio'),
      }),
      merchants: object({ total: atomic, newToday: atomic, pending: atomic, approved: atomic, suspended: atomic }),
      products: object({ total: atomic, pendingReview: atomic, soldOut: atomic }),
      seckill: object({ createdToday: atomic, active: atomic, settling: atomic }),
      fulfillmentQueues: object({ exchange: atomic, delay: atomic, arbitration: atomic, forcedReceipt: atomic, takeover: atomic }),
      settlements: object({ requestedCount: atomic, requestedUsdt: atomic, settledCount: atomic, settledUsdt: atomic, failedTransactions: atomic }),
      coverage: { type: 'array', items: object({
        snapshotId: string, blockNumber: atomic, recordedAt: timestamp, asset: { enum: ['USDT', 'NPL'] },
        safeAddress: address, verifiedAssets: atomic, unsettledLiabilities: atomic, covered: { type: 'boolean' },
      }) },
      breakers: { type: 'array', items: object({ scope: { enum: [...breakerScopes] }, paused: { type: 'boolean' } }) },
      unavailable: { type: 'array', items: object({ metric: string, reasonCode: { enum: ['DecisionBlocked', 'ExternalBlocked'] }, detail: string }) },
    }),
  };
}

function catalogManagementOpenApiSchemas() {
  const idempotencyKey = { type: 'string', minLength: 8, maxLength: 128 };
  const resourceId = { type: 'string', minLength: 1, maxLength: 256 };
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const nullableWriteLock = {
    anyOf: [{ $ref: '#/components/schemas/CatalogWriteLock' }, { type: 'null' }],
  };
  const taxonomyStatus = { enum: [...catalogTaxonomyStatuses] };
  const productInputProperties = {
    idempotencyKey,
    title: { type: 'string', minLength: 1, maxLength: 60 },
    subtitle: { type: 'string', minLength: 1, maxLength: 120 },
    mainImageAssetIds: {
      type: 'array', maxItems: 5, uniqueItems: true,
      items: { $ref: '#/components/schemas/Bytes32' },
    },
    videoAssetId: { $ref: '#/components/schemas/Bytes32' },
    richDetail: { type: 'object' },
    defaultFreightUsdt: { $ref: '#/components/schemas/AtomicAmount' },
    merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
    fulfillmentModes: {
      type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
      items: { enum: [...fulfillmentModes] },
    },
    categoryId: resourceId,
    tagIds: { type: 'array', maxItems: 20, uniqueItems: true, items: resourceId },
    skus: {
      type: 'array', minItems: 1, maxItems: 50,
      items: { $ref: '#/components/schemas/ProductSkuInput' },
    },
  };
  return {
    EmptyRequest: { type: 'object', additionalProperties: false, properties: {} },
    CatalogCategoryInput: {
      type: 'object', additionalProperties: false,
      required: ['name', 'sortOrder', 'idempotencyKey'],
      properties: {
        parentCategoryId: { anyOf: [resourceId, { type: 'null' }] },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        iconAssetId: { $ref: '#/components/schemas/Bytes32' },
        sortOrder: { type: 'integer', minimum: 0 },
        serviceFeeBps: { type: 'integer', minimum: 0, maximum: 10000 },
        status: taxonomyStatus,
        idempotencyKey,
      },
    },
    CatalogCategory: {
      type: 'object', additionalProperties: false,
      required: [
        'categoryId', 'version', 'parentCategoryId', 'level', 'name',
        'iconAssetId', 'sortOrder', 'status', 'serviceFee',
      ],
      properties: {
        categoryId: resourceId,
        version: { $ref: '#/components/schemas/AtomicAmount' },
        parentCategoryId: nullableString,
        level: { type: 'integer', minimum: 1, maximum: 3 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        iconAssetId: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        sortOrder: { type: 'integer', minimum: 0 },
        status: taxonomyStatus,
        serviceFee: {
          type: 'object', additionalProperties: false, required: ['state', 'valueBps'],
          properties: {
            state: { enum: ['Frozen', 'DecisionBlocked'] },
            valueBps: { anyOf: [{ type: 'integer', minimum: 0, maximum: 10000 }, { type: 'null' }] },
          },
        },
      },
    },
    CatalogTagInput: {
      type: 'object', additionalProperties: false,
      required: ['name', 'sortOrder', 'idempotencyKey'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60 },
        example: { type: 'string', minLength: 1, maxLength: 240 },
        sortOrder: { type: 'integer', minimum: 0 },
        status: taxonomyStatus,
        idempotencyKey,
      },
    },
    CatalogTag: {
      type: 'object', additionalProperties: false,
      required: ['tagId', 'version', 'name', 'example', 'sortOrder', 'status'],
      properties: {
        tagId: resourceId,
        version: { $ref: '#/components/schemas/AtomicAmount' },
        name: { type: 'string', minLength: 1, maxLength: 60 },
        example: { type: 'string', maxLength: 240 },
        sortOrder: { type: 'integer', minimum: 0 },
        status: taxonomyStatus,
      },
    },
    ProductSkuInput: {
      type: 'object', additionalProperties: false,
      required: [
        'attributes', 'listPriceUsdt', 'merchantBaseReceivableUsdt',
        'stockTotal', 'proposedSeckillInventory',
      ],
      properties: {
        skuId: resourceId,
        attributes: { type: 'object' },
        listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        merchantBaseReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        stockTotal: { type: 'integer', minimum: 1 },
        proposedSeckillInventory: { type: 'integer', minimum: 1 },
      },
    },
    ProductSlotInput: {
      type: 'object', additionalProperties: false,
      required: [
        'idempotencyKey', 'title', 'richDetail', 'defaultFreightUsdt',
        'merchantConcessionBps', 'fulfillmentModes', 'skus',
      ],
      properties: productInputProperties,
    },
    AdminProductSlotInput: {
      type: 'object', additionalProperties: false,
      required: [
        'merchantId', 'idempotencyKey', 'title', 'richDetail', 'defaultFreightUsdt',
        'merchantConcessionBps', 'fulfillmentModes', 'skus',
      ],
      properties: { merchantId: resourceId, ...productInputProperties },
    },
    CatalogWriteLock: {
      type: 'object', additionalProperties: false, required: ['type', 'id', 'state'],
      properties: { type: { type: 'string' }, id: resourceId, state: { type: 'string' } },
    },
    ManagedCatalogSku: {
      type: 'object', additionalProperties: false,
      required: [
        'skuId', 'chainSkuId', 'version', 'attributes', 'listPriceUsdt',
        'merchantBaseReceivableUsdt', 'stockTotal', 'stockAvailable',
        'stockReserved', 'proposedSeckillInventory', 'lifecycleState',
      ],
      properties: {
        skuId: resourceId,
        chainSkuId: { $ref: '#/components/schemas/Bytes32' },
        version: { $ref: '#/components/schemas/AtomicAmount' },
        attributes: { type: 'object' },
        listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        merchantBaseReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        stockTotal: { $ref: '#/components/schemas/AtomicAmount' },
        stockAvailable: { $ref: '#/components/schemas/AtomicAmount' },
        stockReserved: { $ref: '#/components/schemas/AtomicAmount' },
        proposedSeckillInventory: { $ref: '#/components/schemas/AtomicAmount' },
        lifecycleState: { enum: [...catalogProductLifecycleStates] },
      },
    },
    ManagedCatalogProduct: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'productId', 'chainProductId', 'merchantId', 'storeId',
        'supersedesProductId', 'version', 'title', 'subtitle', 'lifecycleState',
        'productPolicyHash', 'merchantConcessionBps', 'mainImageAssetIds',
        'videoAssetId', 'richDetail', 'defaultFreightUsdt', 'fulfillmentModes',
        'categoryId', 'tagIds', 'skus', 'allowedActions', 'writeLock',
        'createdAt', 'updatedAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        productId: resourceId,
        chainProductId: { $ref: '#/components/schemas/Bytes32' },
        merchantId: resourceId,
        storeId: nullableString,
        supersedesProductId: nullableString,
        version: { $ref: '#/components/schemas/AtomicAmount' },
        title: { type: 'string', minLength: 1, maxLength: 60 },
        subtitle: { type: 'string', maxLength: 120 },
        lifecycleState: { enum: [...catalogProductLifecycleStates] },
        productPolicyHash: { $ref: '#/components/schemas/Bytes32' },
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        mainImageAssetIds: { type: 'array', maxItems: 5, items: { $ref: '#/components/schemas/Bytes32' } },
        videoAssetId: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        richDetail: { type: 'object' },
        defaultFreightUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        fulfillmentModes: { type: 'array', items: { enum: [...fulfillmentModes] } },
        categoryId: nullableString,
        tagIds: { type: 'array', items: resourceId },
        skus: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/ManagedCatalogSku' } },
        allowedActions: { type: 'array', items: { enum: [...catalogProductActions] } },
        writeLock: nullableWriteLock,
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    ProductSlotProjection: {
      type: 'object', additionalProperties: false,
      required: ['artifactVersion', 'storeId', 'merchantId', 'product', 'allowedActions', 'writeLock'],
      properties: {
        artifactVersion: { const: artifactVersion },
        storeId: resourceId,
        merchantId: resourceId,
        product: { anyOf: [{ $ref: '#/components/schemas/ManagedCatalogProduct' }, { type: 'null' }] },
        allowedActions: { type: 'array', items: { enum: [...catalogProductActions] } },
        writeLock: nullableWriteLock,
      },
    },
    ConcessionPreviewRequest: {
      type: 'object', additionalProperties: false,
      required: ['merchantConcessionBps', 'idempotencyKey'],
      properties: {
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        idempotencyKey,
      },
    },
    MerchantConcessionAllocation: {
      type: 'object', additionalProperties: false, required: ['account', 'amount'],
      properties: {
        account: { $ref: '#/components/schemas/Address' },
        amount: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    MerchantConcessionPreviewItem: {
      type: 'object', additionalProperties: false,
      required: [
        'skuId', 'merchantBaseReceivableUsdt', 'merchantConcessionBps',
        'merchantConcessionAmount', 'merchantNetReceivableUsdt', 'allocations',
      ],
      properties: {
        skuId: resourceId,
        merchantBaseReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        merchantConcessionAmount: { $ref: '#/components/schemas/AtomicAmount' },
        merchantNetReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        allocations: { type: 'array', items: { $ref: '#/components/schemas/MerchantConcessionAllocation' } },
      },
    },
    MerchantConcessionPreviewPayload: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'productId', 'productVersion', 'merchantId', 'policyVersion',
        'merchantConcessionBps', 'destinationSetHash', 'catalogFingerprint', 'items', 'expiresAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        productId: resourceId,
        productVersion: { type: 'integer', minimum: 1 },
        merchantId: resourceId,
        policyVersion: { type: 'integer', minimum: 1 },
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        destinationSetHash: { $ref: '#/components/schemas/Bytes32' },
        catalogFingerprint: { $ref: '#/components/schemas/Bytes32' },
        items: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/MerchantConcessionPreviewItem' } },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    CatalogSignedAuthorization: {
      type: 'object', additionalProperties: false,
      required: ['domain', 'types', 'primaryType', 'message', 'digest', 'signature', 'signer'],
      properties: {
        domain: { type: 'object' },
        types: { type: 'object' },
        primaryType: { const: 'MerchantConcessionPreview' },
        message: { type: 'object' },
        digest: { $ref: '#/components/schemas/Bytes32' },
        signature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
        signer: { $ref: '#/components/schemas/Address' },
      },
    },
    MerchantConcessionPreview: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'previewId', 'productId', 'productVersion', 'merchantId',
        'policyVersion', 'merchantConcessionBps', 'catalogFingerprint',
        'destinationSetHash', 'previewHash', 'payload', 'authorization',
        'expiresAt', 'createdAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        previewId: { $ref: '#/components/schemas/Bytes32' },
        productId: resourceId,
        productVersion: { $ref: '#/components/schemas/AtomicAmount' },
        merchantId: resourceId,
        policyVersion: { $ref: '#/components/schemas/AtomicAmount' },
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        catalogFingerprint: { $ref: '#/components/schemas/Bytes32' },
        destinationSetHash: { $ref: '#/components/schemas/Bytes32' },
        previewHash: { $ref: '#/components/schemas/Bytes32' },
        payload: { $ref: '#/components/schemas/MerchantConcessionPreviewPayload' },
        authorization: { $ref: '#/components/schemas/CatalogSignedAuthorization' },
        expiresAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    ProductReviewSubmissionRequest: {
      type: 'object', additionalProperties: false, required: ['previewId', 'idempotencyKey'],
      properties: { previewId: { $ref: '#/components/schemas/Bytes32' }, idempotencyKey },
    },
    ProductReviewDecisionRequest: {
      type: 'object', additionalProperties: false,
      required: ['decision', 'reasonCode', 'idempotencyKey'],
      properties: {
        decision: { enum: [...catalogReviewDecisions] },
        reasonCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' },
        idempotencyKey,
      },
    },
    CatalogReasonRequest: {
      type: 'object', additionalProperties: false, required: ['reasonCode', 'idempotencyKey'],
      properties: {
        reasonCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' },
        idempotencyKey,
      },
    },
    InventoryAdjustmentRequest: {
      type: 'object', additionalProperties: false,
      required: ['delta', 'reasonCode', 'idempotencyKey'],
      properties: {
        delta: { type: 'string', pattern: '^-?[1-9][0-9]*$' },
        reasonCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' },
        idempotencyKey,
      },
    },
    InventoryAdjustmentProjection: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'adjustmentId', 'skuId', 'beforeTotal', 'beforeAvailable',
        'delta', 'afterTotal', 'afterAvailable', 'reasonCode', 'actorWallet', 'createdAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        adjustmentId: { $ref: '#/components/schemas/Bytes32' },
        skuId: resourceId,
        beforeTotal: { $ref: '#/components/schemas/AtomicAmount' },
        beforeAvailable: { $ref: '#/components/schemas/AtomicAmount' },
        delta: { type: 'string', pattern: '^-?[1-9][0-9]*$' },
        afterTotal: { $ref: '#/components/schemas/AtomicAmount' },
        afterAvailable: { $ref: '#/components/schemas/AtomicAmount' },
        reasonCode: { type: 'string' },
        actorWallet: { $ref: '#/components/schemas/Address' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    MediaUploadIntentRequest: {
      type: 'object', additionalProperties: false,
      required: [
        'purpose', 'resourceType', 'resourceId', 'contentType',
        'sizeBytes', 'contentSha256', 'idempotencyKey',
      ],
      properties: {
        purpose: { enum: [...mediaPurposes] },
        resourceType: { enum: [...mediaResourceTypes] },
        resourceId,
        contentType: { enum: [...mediaContentTypes] },
        sizeBytes: { type: 'integer', minimum: 1, maximum: 10485760 },
        contentSha256: { $ref: '#/components/schemas/Bytes32' },
        idempotencyKey,
      },
    },
    MediaUploadIntentProjection: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'uploadIntentId', 'ownerWallet', 'purpose', 'resourceType',
        'resourceId', 'contentType', 'sizeBytes', 'contentSha256', 'state', 'expiresAt',
        'method', 'uploadUrl', 'headers', 'providerReferenceHash', 'writeOnce',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        uploadIntentId: { $ref: '#/components/schemas/Bytes32' },
        ownerWallet: { $ref: '#/components/schemas/Address' },
        purpose: { enum: [...mediaPurposes] },
        resourceType: { enum: [...mediaResourceTypes] },
        resourceId,
        contentType: { enum: [...mediaContentTypes] },
        sizeBytes: { $ref: '#/components/schemas/AtomicAmount' },
        contentSha256: { $ref: '#/components/schemas/Bytes32' },
        state: { const: 'UPLOADED' },
        expiresAt: { type: 'string', format: 'date-time' },
        method: { const: 'PUT' },
        uploadUrl: { type: 'string', format: 'uri' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        providerReferenceHash: { $ref: '#/components/schemas/Bytes32' },
        writeOnce: { const: true },
      },
    },
    MediaAssetProjection: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'assetId', 'uploadIntentId', 'ownerWallet', 'purpose',
        'resourceType', 'resourceId', 'contentType', 'sizeBytes', 'contentSha256',
        'providerEvidenceHash', 'objectVersionHash', 'createdAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        assetId: { $ref: '#/components/schemas/Bytes32' },
        uploadIntentId: { $ref: '#/components/schemas/Bytes32' },
        ownerWallet: { $ref: '#/components/schemas/Address' },
        purpose: { enum: [...mediaPurposes] },
        resourceType: { enum: [...mediaResourceTypes] },
        resourceId,
        contentType: { enum: [...mediaContentTypes] },
        sizeBytes: { $ref: '#/components/schemas/AtomicAmount' },
        contentSha256: { $ref: '#/components/schemas/Bytes32' },
        providerEvidenceHash: { $ref: '#/components/schemas/Bytes32' },
        objectVersionHash: { $ref: '#/components/schemas/Bytes32' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    MediaReadAccessProjection: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'assetId', 'purpose', 'resourceType', 'resourceId',
        'contentType', 'sizeBytes', 'contentSha256', 'objectVersionHash',
        'accessScope', 'method', 'readUrl', 'expiresAt', 'providerReferenceHash',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        assetId: { $ref: '#/components/schemas/Bytes32' },
        purpose: { enum: [...mediaPurposes] },
        resourceType: { enum: [...mediaResourceTypes] },
        resourceId,
        contentType: { enum: [...mediaContentTypes] },
        sizeBytes: { $ref: '#/components/schemas/AtomicAmount' },
        contentSha256: { $ref: '#/components/schemas/Bytes32' },
        objectVersionHash: { $ref: '#/components/schemas/Bytes32' },
        accessScope: { enum: ['PUBLIC', 'AUTHENTICATED'] },
        method: { const: 'GET' },
        readUrl: { type: 'string', format: 'uri' },
        expiresAt: { type: 'string', format: 'date-time' },
        providerReferenceHash: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    OrderActionEvidenceRequest: {
      type: 'object', additionalProperties: false,
      required: ['action', 'reasonCode', 'idempotencyKey'],
      properties: {
        action: { enum: [
          'REQUEST_EXCHANGE', 'REQUEST_DELAY', 'CONFIRM_RECEIPT',
          'OPEN_ARBITRATION', 'VERIFY_PICKUP', 'REQUEST_FORCED_RECEIPT',
        ] },
        reasonCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' },
        mediaAssetIds: { type: 'array', maxItems: 8, uniqueItems: true, items: { $ref: '#/components/schemas/Bytes32' } },
        idempotencyKey,
      },
    },
    TrackingEvidenceRequest: {
      type: 'object', additionalProperties: false,
      required: ['carrierCode', 'trackingNumber', 'idempotencyKey'],
      properties: {
        carrierCode: { enum: ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] },
        trackingNumber: { type: 'string', minLength: 6, maxLength: 64 },
        idempotencyKey,
      },
    },
    EvidenceEnvelopeProjection: {
      type: 'object', additionalProperties: false,
      required: [
        'artifactVersion', 'evidenceHash', 'ownerWallet', 'actorRole', 'purpose',
        'resourceType', 'resourceId', 'action', 'reasonCode', 'trackingNumberHash',
        'mediaAssetIds', 'payload', 'createdAt',
      ],
      properties: {
        artifactVersion: { const: artifactVersion },
        evidenceHash: { $ref: '#/components/schemas/Bytes32' },
        ownerWallet: { $ref: '#/components/schemas/Address' },
        actorRole: { enum: ['BUYER', 'MERCHANT', 'ADMIN', 'OPERATOR'] },
        purpose: { enum: ['FULFILLMENT_ACTION', 'SHIPMENT_TRACKING'] },
        resourceType: { const: 'ORDER' },
        resourceId,
        action: { type: 'string' },
        reasonCode: nullableString,
        trackingNumberHash: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        mediaAssetIds: { type: 'array', items: { $ref: '#/components/schemas/Bytes32' } },
        payload: { type: 'object' },
        carrierCode: { enum: ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  };
}

function fulfillmentOpenApiSchemas() {
  const idempotencyKey = { $ref: '#/components/schemas/IdempotencyKey' };
  const evidenceHash = { $ref: '#/components/schemas/Bytes32' };
  const timestamp = { type: 'string', format: 'date-time' };
  const nullableTimestamp = { anyOf: [timestamp, { type: 'null' }] };
  const commandProperties = { idempotencyKey, evidenceHash };
  const commandRequired = Object.keys(commandProperties);
  const targetProperties = {
    targetId: { type: 'string', minLength: 1 },
    targetHash: { $ref: '#/components/schemas/Bytes32' },
    fulfillmentMode: { enum: [...fulfillmentModes] },
    regionCode: { $ref: '#/components/schemas/RegionCode' },
    regionCodeHash: { $ref: '#/components/schemas/Bytes32' },
    expiresAt: timestamp,
  };
  return {
    IdempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    RegionCode: { type: 'string', pattern: '^[0-9]{6}$' },
    MerchantStore: {
      type: 'object',
      additionalProperties: false,
      required: [
        'storeId', 'merchantId', 'name', 'regionCode', 'longitude', 'latitude',
        'address', 'phone', 'status', 'version',
      ],
      properties: {
        storeId: { type: 'string', minLength: 1 },
        merchantId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        regionCode: { $ref: '#/components/schemas/RegionCode' },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        address: { type: 'string', minLength: 1 },
        phone: { type: 'string', pattern: '^[+]?[0-9-]{7,20}$' },
        status: { enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
        version: { type: 'integer', minimum: 1 },
      },
    },
    CreateMerchantStoreRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey', 'name', 'phone', 'longitude', 'latitude'],
      properties: {
        idempotencyKey,
        name: { type: 'string', minLength: 1, maxLength: 100 },
        phone: { type: 'string', pattern: '^[+]?[0-9-]{7,20}$' },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
      },
    },
    CreateDeliveryTargetRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey', 'recipientName', 'phone', 'address', 'longitude', 'latitude'],
      properties: {
        idempotencyKey,
        recipientName: { type: 'string', minLength: 1, maxLength: 64 },
        phone: { type: 'string', pattern: '^[+]?[0-9-]{7,20}$' },
        address: { type: 'string', minLength: 5, maxLength: 300 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
      },
    },
    CreatePickupTargetRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['idempotencyKey', 'storeId'],
      properties: {
        idempotencyKey,
        storeId: { type: 'string', minLength: 1 },
      },
    },
    DeliveryTarget: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(targetProperties),
      properties: { ...targetProperties, fulfillmentMode: { const: 'DELIVERY' } },
    },
    PickupTarget: {
      type: 'object',
      additionalProperties: false,
      required: [...Object.keys(targetProperties), 'storeId', 'store'],
      properties: {
        ...targetProperties,
        fulfillmentMode: { const: 'PICKUP' },
        storeId: { type: 'string', minLength: 1 },
        store: { $ref: '#/components/schemas/MerchantStore' },
      },
    },
    DeliveryTargetPayload: {
      type: 'object',
      additionalProperties: false,
      required: ['recipientName', 'phone', 'address', 'longitude', 'latitude', 'regionCode'],
      properties: {
        recipientName: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        longitude: { type: 'number' },
        latitude: { type: 'number' },
        regionCode: { $ref: '#/components/schemas/RegionCode' },
      },
    },
    FulfillmentTarget: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [...Object.keys(targetProperties), 'payload'],
          properties: {
            ...targetProperties,
            fulfillmentMode: { const: 'DELIVERY' },
            payload: { $ref: '#/components/schemas/DeliveryTargetPayload' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [...Object.keys(targetProperties), 'storeId', 'payload'],
          properties: {
            ...targetProperties,
            fulfillmentMode: { const: 'PICKUP' },
            storeId: { type: 'string', minLength: 1 },
            payload: { $ref: '#/components/schemas/MerchantStore' },
          },
        },
      ],
    },
    FulfillmentRequestProjection: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'requestType', 'state', 'requestedAt', 'resolvedAt'],
      properties: {
        requestId: { type: 'string', minLength: 1 },
        requestType: { enum: ['EXCHANGE', 'DELAY', 'ARBITRATION', 'FORCED_RECEIPT'] },
        state: { enum: ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED'] },
        requestedAt: timestamp,
        resolvedAt: nullableTimestamp,
      },
    },
    ShipmentProjection: {
      type: 'object',
      additionalProperties: false,
      required: [
        'shipmentId', 'carrierCode', 'trackingNumberHash', 'providerReferenceHash', 'createdAt',
      ],
      properties: {
        shipmentId: { type: 'string', minLength: 1 },
        carrierCode: { type: 'string', pattern: '^[A-Z0-9_-]{2,32}$' },
        trackingNumberHash: { $ref: '#/components/schemas/Bytes32' },
        providerReferenceHash: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        createdAt: timestamp,
      },
    },
    LogisticsProjection: {
      type: 'object',
      additionalProperties: false,
      required: ['logisticsEventId', 'provider', 'status', 'locationHash', 'occurredAt'],
      properties: {
        logisticsEventId: { type: 'string', minLength: 1 },
        provider: { enum: ['KUAIDI100', 'CAINIAO'] },
        status: { enum: ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] },
        locationHash: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        occurredAt: timestamp,
      },
    },
    FulfillmentBalance: {
      type: 'object',
      additionalProperties: false,
      required: ['asset', 'state', 'amount'],
      properties: {
        asset: { enum: ['USDT', 'NPL', 'BNM_POINTS'] },
        state: { enum: [...balanceStates] },
        amount: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    FulfillmentExactAmounts: {
      type: 'object',
      additionalProperties: false,
      required: [
        'listPriceUsdt', 'usdtPaymentAmount', 'nplQuoteAmount', 'nplPaymentAmount',
        'nplBurnAmount', 'nplRewardAmount', 'merchantBaseReceivableUsdt',
        'merchantConcessionAmount', 'merchantNetReceivableUsdt', 'bnmAmount',
      ],
      properties: Object.fromEntries([
        'listPriceUsdt', 'usdtPaymentAmount', 'nplQuoteAmount', 'nplPaymentAmount',
        'nplBurnAmount', 'nplRewardAmount', 'merchantBaseReceivableUsdt',
        'merchantConcessionAmount', 'merchantNetReceivableUsdt', 'bnmAmount',
      ].map((name) => [name, { $ref: '#/components/schemas/AtomicAmount' }])),
    },
    FulfillmentOrder: {
      type: 'object',
      additionalProperties: false,
      required: [
        'orderId', 'artifactVersion', 'buyerWallet', 'merchantId', 'merchantWallet', 'productId',
        'skuId', 'quantity', 'createdAt', 'orderKind', 'paymentTxHash', 'fulfillmentMode',
        'state', 'finalityStatus', 'exactAmounts', 'paidAt',
        'paymentFinalizedAt', 'shippedAt', 'deliveredAt', 'fulfilledAt', 'takeoverOpenedAt',
        'arbitrationOpenedAt', 'requests', 'shipments', 'logistics', 'balances', 'allowedActions',
      ],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        artifactVersion: { type: 'string', minLength: 1 },
        buyerWallet: { $ref: '#/components/schemas/Address' },
        merchantId: { type: 'string', minLength: 1 },
        merchantWallet: { $ref: '#/components/schemas/Address' },
        productId: { type: 'string', minLength: 1 },
        skuId: { type: 'string', minLength: 1 },
        quantity: { $ref: '#/components/schemas/AtomicAmount' },
        createdAt: timestamp,
        orderKind: { enum: ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] },
        paymentTxHash: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        fulfillmentMode: { enum: [...fulfillmentModes] },
        state: { enum: [...orderProjectionStates] },
        finalityStatus: { enum: [...orderFinalityStatuses] },
        exactAmounts: { $ref: '#/components/schemas/FulfillmentExactAmounts' },
        paidAt: nullableTimestamp,
        paymentFinalizedAt: nullableTimestamp,
        shippedAt: nullableTimestamp,
        deliveredAt: nullableTimestamp,
        fulfilledAt: nullableTimestamp,
        takeoverOpenedAt: nullableTimestamp,
        arbitrationOpenedAt: nullableTimestamp,
        requests: { type: 'array', items: { $ref: '#/components/schemas/FulfillmentRequestProjection' } },
        shipments: { type: 'array', items: { $ref: '#/components/schemas/ShipmentProjection' } },
        logistics: { type: 'array', items: { $ref: '#/components/schemas/LogisticsProjection' } },
        balances: { type: 'array', items: { $ref: '#/components/schemas/FulfillmentBalance' } },
        allowedActions: { type: 'array', items: { $ref: '#/components/schemas/AllowedAction' } },
      },
    },
    FulfillmentOrderCursor: {
      type: 'object', additionalProperties: false, required: ['createdAt', 'orderId'],
      properties: {
        createdAt: timestamp,
        orderId: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
    FulfillmentOrderPage: {
      type: 'object', additionalProperties: false, required: ['orders', 'nextCursor'],
      properties: {
        orders: { type: 'array', items: { $ref: '#/components/schemas/FulfillmentOrder' } },
        nextCursor: {
          anyOf: [{ $ref: '#/components/schemas/FulfillmentOrderCursor' }, { type: 'null' }],
        },
      },
    },
    AdminOrderSearchPage: {
      type: 'object', additionalProperties: false,
      required: ['orders', 'nextCursor', 'pausedScopes', 'breaker', 'pendingProductReview'],
      properties: {
        orders: { type: 'array', items: { $ref: '#/components/schemas/FulfillmentOrder' } },
        nextCursor: {
          anyOf: [{ $ref: '#/components/schemas/FulfillmentOrderCursor' }, { type: 'null' }],
        },
        pausedScopes: { type: 'array', uniqueItems: true, items: { $ref: '#/components/schemas/BreakerScope' } },
        breaker: {
          anyOf: [{
            type: 'object', additionalProperties: false, required: ['scope', 'active'],
            properties: {
              scope: { $ref: '#/components/schemas/BreakerScope' },
              active: { type: 'boolean' },
            },
          }, { type: 'null' }],
        },
        pendingProductReview: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      },
    },
    OrderBatchActionPreviewRequest: {
      type: 'object', additionalProperties: false, required: ['orderIds'],
      properties: {
        orderIds: {
          type: 'array', minItems: 1, maxItems: 100, uniqueItems: true,
          items: { $ref: '#/components/schemas/Bytes32' },
        },
      },
    },
    OrderBatchActionPreviewRow: {
      type: 'object', additionalProperties: false, required: ['orderId', 'allowedActions'],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        allowedActions: { type: 'array', items: { $ref: '#/components/schemas/AllowedAction' } },
      },
    },
    OrderBatchActionPreview: {
      type: 'object', additionalProperties: false,
      required: ['rows', 'enabledActionIntersection'],
      properties: {
        rows: { type: 'array', items: { $ref: '#/components/schemas/OrderBatchActionPreviewRow' } },
        enabledActionIntersection: {
          type: 'array', uniqueItems: true, items: { enum: [...allowedActionNames] },
        },
      },
    },
    FulfillmentCommandInput: {
      type: 'object', additionalProperties: false, required: commandRequired, properties: commandProperties,
    },
    FulfillmentReasonRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'reasonCode'],
      properties: { ...commandProperties, reasonCode: { type: 'string', pattern: '^[A-Z0-9_:-]{2,64}$' } },
    },
    ShipmentRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'carrierCode', 'trackingNumberHash'],
      properties: {
        ...commandProperties,
        carrierCode: { type: 'string', pattern: '^[A-Z0-9_-]{2,32}$' },
        trackingNumberHash: { $ref: '#/components/schemas/Bytes32' },
        providerReferenceHash: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    ShipmentBatchItemRequest: {
      type: 'object', additionalProperties: false,
      required: ['orderId', ...commandRequired, 'carrierCode', 'trackingNumberHash'],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        ...commandProperties,
        carrierCode: { enum: ['SF', 'JD', 'YTO', 'ZTO', 'STO', 'EMS'] },
        trackingNumberHash: { $ref: '#/components/schemas/Bytes32' },
        providerReferenceHash: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    ShipmentBatchRequest: {
      type: 'object', additionalProperties: false, required: ['idempotencyKey', 'items'],
      properties: {
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
        items: {
          type: 'array', minItems: 1, maxItems: 100, uniqueItems: true,
          items: { $ref: '#/components/schemas/ShipmentBatchItemRequest' },
        },
      },
    },
    PickupCredentialRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'code', 'expiresAt'],
      properties: { ...commandProperties, code: { type: 'string', pattern: '^[0-9]{6}$' }, expiresAt: timestamp },
    },
    PickupVerificationRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'code', 'storeId'],
      properties: {
        ...commandProperties,
        code: { type: 'string', pattern: '^[0-9]{6}$' },
        storeId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    FulfillmentRequestDecision: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'requestId', 'approved', 'noteCode'],
      properties: {
        ...commandProperties,
        requestId: { type: 'string', minLength: 1 },
        approved: { type: 'boolean' },
        noteCode: { type: 'string', pattern: '^[A-Z0-9_:-]{2,64}$' },
      },
    },
    FulfillmentDecision: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'approved', 'noteCode'],
      properties: {
        ...commandProperties,
        approved: { type: 'boolean' },
        noteCode: { type: 'string', pattern: '^[A-Z0-9_:-]{2,64}$' },
      },
    },
    ArbitrationDecision: {
      type: 'object',
      additionalProperties: false,
      required: [...commandRequired, 'outcome', 'noteCode'],
      properties: {
        ...commandProperties,
        outcome: { enum: ['FULFILL', 'RESUME_FULFILLMENT'] },
        noteCode: { type: 'string', pattern: '^[A-Z0-9_:-]{2,64}$' },
      },
    },
    LogisticsWebhookRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'orderId', 'status', 'occurredAt'],
      properties: {
        eventId: { type: 'string', minLength: 1 },
        orderId: { $ref: '#/components/schemas/Bytes32' },
        status: { enum: ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] },
        occurredAt: timestamp,
        locationHash: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    ShipmentResult: objectSchema(
      ['orderId', 'state', 'shipmentId', 'carrierCode', 'trackingNumberHash', 'recordedAt'],
      {
        orderId: { $ref: '#/components/schemas/Bytes32' }, state: { const: 'SHIPPED' },
        shipmentId: { type: 'string' }, carrierCode: { type: 'string' },
        trackingNumberHash: { $ref: '#/components/schemas/Bytes32' }, recordedAt: timestamp,
      },
    ),
    ShipmentBatchResult: {
      type: 'object', additionalProperties: false,
      required: ['batchId', 'shipments', 'createdAt'],
      properties: {
        batchId: { $ref: '#/components/schemas/Bytes32' },
        shipments: {
          type: 'array', minItems: 1, maxItems: 100,
          items: { $ref: '#/components/schemas/ShipmentResult' },
        },
        createdAt: timestamp,
      },
    },
    DeliveryResult: objectSchema(['orderId', 'state', 'deliveredAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, state: { const: 'DELIVERED' }, deliveredAt: timestamp,
    }),
    LogisticsUpdateResult: objectSchema(
      ['orderId', 'logisticsEventId', 'provider', 'status', 'state', 'occurredAt'],
      {
        orderId: { $ref: '#/components/schemas/Bytes32' }, logisticsEventId: { type: 'string' },
        provider: { enum: ['KUAIDI100', 'CAINIAO'] },
        status: { enum: ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'] },
        state: { enum: ['SHIPPED', 'DELIVERED'] }, occurredAt: timestamp,
      },
    ),
    PickupCredentialResult: objectSchema(['orderId', 'credentialId', 'expiresAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, credentialId: { type: 'string' }, expiresAt: timestamp,
    }),
    FulfillmentRequestResult: objectSchema(
      ['orderId', 'requestId', 'requestType', 'state', 'requestedAt'],
      {
        orderId: { $ref: '#/components/schemas/Bytes32' }, requestId: { type: 'string' },
        requestType: { enum: ['EXCHANGE', 'DELAY'] }, state: { const: 'OPEN' }, requestedAt: timestamp,
      },
    ),
    FulfillmentRequestDecisionResult: objectSchema(
      ['orderId', 'requestId', 'requestType', 'state', 'decidedAt'],
      {
        orderId: { $ref: '#/components/schemas/Bytes32' }, requestId: { type: 'string' },
        requestType: { enum: ['EXCHANGE', 'DELAY'] }, state: { enum: ['APPROVED', 'REJECTED'] },
        decidedAt: timestamp,
      },
    ),
    ArbitrationOpenedResult: objectSchema(['orderId', 'requestId', 'state', 'openedAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, requestId: { type: 'string' },
      state: { const: 'ARBITRATION' }, openedAt: timestamp,
    }),
    ArbitrationResumedResult: objectSchema(['orderId', 'state', 'outcome', 'decidedAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' },
      state: { enum: ['SHIPPED', 'DELIVERED', 'TAKEOVER', 'FULFILLMENT_PENDING'] },
      outcome: { const: 'RESUME_FULFILLMENT' }, decidedAt: timestamp,
    }),
    TakeoverOpenedResult: objectSchema(['orderId', 'caseId', 'state', 'customerFundsRemainLocked'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, caseId: { type: 'string' },
      state: { const: 'TAKEOVER' }, customerFundsRemainLocked: { const: true },
    }),
    ForcedReceiptRequestResult: objectSchema(
      ['orderId', 'requestId', 'state', 'platformReviewRequired', 'canFinalizeDirectly'],
      {
        orderId: { $ref: '#/components/schemas/Bytes32' }, requestId: { type: 'string' }, state: { const: 'OPEN' },
        platformReviewRequired: { const: true }, canFinalizeDirectly: { const: false },
      },
    ),
    ForcedReceiptRejectedResult: objectSchema(['orderId', 'state', 'approved', 'decidedAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, state: { const: 'DELIVERED' },
      approved: { const: false }, decidedAt: timestamp,
    }),
    FulfillmentCompletedResult: objectSchema(['orderId', 'state', 'method', 'fulfilledAt'], {
      orderId: { $ref: '#/components/schemas/Bytes32' }, state: { const: 'FULFILLED' },
      method: { enum: [...fulfillmentMethods] }, fulfilledAt: timestamp,
    }),
    ArbitrationDecisionResult: {
      oneOf: [
        { $ref: '#/components/schemas/FulfillmentCompletedResult' },
        { $ref: '#/components/schemas/ArbitrationResumedResult' },
      ],
    },
    ForcedReceiptDecisionResult: {
      oneOf: [
        { $ref: '#/components/schemas/FulfillmentCompletedResult' },
        { $ref: '#/components/schemas/ForcedReceiptRejectedResult' },
      ],
    },
    FulfillmentCommandResult: {
      oneOf: [
        'ShipmentResult', 'DeliveryResult', 'LogisticsUpdateResult', 'PickupCredentialResult',
        'FulfillmentRequestResult', 'FulfillmentRequestDecisionResult', 'ArbitrationOpenedResult',
        'ArbitrationResumedResult', 'TakeoverOpenedResult', 'ForcedReceiptRequestResult',
        'ForcedReceiptRejectedResult', 'FulfillmentCompletedResult',
      ].map((name) => ({ $ref: `#/components/schemas/${name}` })),
    },
  };
}

function paymentOpenApiSchemas() {
  const quoteRequestProperties = {
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    productId: { type: 'string', minLength: 1 },
    skuId: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 1 },
    fulfillmentMode: { enum: ['DELIVERY', 'PICKUP'] },
    fulfillmentTargetHash: { $ref: '#/components/schemas/Bytes32' },
    regionCodeHash: { $ref: '#/components/schemas/Bytes32' },
  };
  const quoteRequestRequired = Object.keys(quoteRequestProperties);
  const nullableBytes32 = { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] };
  const quoteState = { enum: ['QUOTED', 'SUBMITTED', 'PAID', 'REORGED', 'EXPIRED'] };
  const quoteResponseProperties = {
    artifactVersion: { const: artifactVersion },
    orderId: { $ref: '#/components/schemas/Bytes32' },
    state: quoteState,
    paymentRouterAddress: { $ref: '#/components/schemas/Address' },
    intent: { $ref: '#/components/schemas/CanonicalPaymentIntent' },
    snapshotHash: { $ref: '#/components/schemas/Bytes32' },
    authorizationDigest: { $ref: '#/components/schemas/Bytes32' },
    buyerAuthorization: { $ref: '#/components/schemas/PaymentBuyerAuthorization' },
    quoteSignature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
    submittedTxHash: nullableBytes32,
    approvalRequirements: {
      type: 'array', minItems: 2, maxItems: 2, items: { $ref: '#/components/schemas/ApprovalRequirement' },
    },
    routerCall: { $ref: '#/components/schemas/OrdinaryRouterCall' },
  };
  const seckillResponseProperties = {
    artifactVersion: { const: artifactVersion },
    orderId: { $ref: '#/components/schemas/Bytes32' },
    state: quoteState,
    paymentRouterAddress: { $ref: '#/components/schemas/Address' },
    dual: { $ref: '#/components/schemas/CanonicalSeckillIntent' },
    seckillHash: { $ref: '#/components/schemas/Bytes32' },
    snapshotHashes: {
      type: 'object', additionalProperties: false, required: ['seckill', 'fallback'],
      properties: {
        seckill: { $ref: '#/components/schemas/Bytes32' },
        fallback: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    authorizationDigest: { $ref: '#/components/schemas/Bytes32' },
    buyerAuthorization: { $ref: '#/components/schemas/SeckillBuyerAuthorization' },
    quoteSignature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
    submittedTxHash: nullableBytes32,
    approvalRequirements: {
      type: 'array', minItems: 2, maxItems: 2, items: { $ref: '#/components/schemas/ApprovalRequirement' },
    },
    routerCall: { $ref: '#/components/schemas/SeckillRouterCall' },
  };
  const schemas = {
    WeightedDestination: {
      type: 'object', additionalProperties: false, required: ['account', 'weightBps'],
      properties: {
        account: { $ref: '#/components/schemas/Address' },
        weightBps: { type: 'integer', minimum: 0, maximum: 10000 },
      },
    },
    ProductPolicy: {
      type: 'object',
      additionalProperties: false,
      required: [
        'policyVersion', 'oracleVersion', 'usdtPaymentBps', 'nplPaymentBps',
        'nplBurnListPriceBps', 'nplRewardListPriceBps', 'genesisBps', 'directReferralBps',
        'districtBps', 'cityBps', 'provinceBps', 'regionBps', 'operationsBps',
        'platformFeeBps', 'seckillPrizeBps',
        'oracleWindowSeconds', 'oracleMaxDeviationBps', 'oracleMaxAgeSeconds',
        'oracleMinimumUsdtLiquidity', 'requiredConfirmations', 'merchantGuaranteeMinimumUsdt',
        'usdtCustodySafe', 'nplRewardSafe', 'operationsTreasurySafe', 'circulationPool',
        'concessionDestinationSetHash', 'concessionDestinations', 'operationsDestinations',
        'otherUsdtDestinations', 'seckillPrizePoolAccount',
      ],
      properties: {
        policyVersion: { type: 'integer', minimum: 1 },
        oracleVersion: { $ref: '#/components/schemas/Bytes32' },
        usdtPaymentBps: { type: 'integer', minimum: 0, maximum: 10000 },
        nplPaymentBps: { type: 'integer', minimum: 0, maximum: 10000 },
        nplBurnListPriceBps: { type: 'integer', minimum: 0, maximum: 10000 },
        nplRewardListPriceBps: { type: 'integer', minimum: 0, maximum: 10000 },
        genesisBps: { type: 'integer', minimum: 0, maximum: 10000 },
        directReferralBps: { type: 'integer', minimum: 0, maximum: 10000 },
        districtBps: { type: 'integer', minimum: 0, maximum: 10000 },
        cityBps: { type: 'integer', minimum: 0, maximum: 10000 },
        provinceBps: { type: 'integer', minimum: 0, maximum: 10000 },
        regionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        operationsBps: { type: 'integer', minimum: 0, maximum: 10000 },
        platformFeeBps: { type: 'integer', minimum: 0, maximum: 10000 },
        seckillPrizeBps: { type: 'integer', minimum: 0, maximum: 10000 },
        oracleWindowSeconds: { const: 1800 },
        oracleMaxDeviationBps: { const: 500 },
        oracleMaxAgeSeconds: { const: 600 },
        oracleMinimumUsdtLiquidity: { $ref: '#/components/schemas/AtomicAmount' },
        requiredConfirmations: { const: 15 },
        merchantGuaranteeMinimumUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        usdtCustodySafe: { $ref: '#/components/schemas/Address' },
        nplRewardSafe: { $ref: '#/components/schemas/Address' },
        operationsTreasurySafe: { $ref: '#/components/schemas/Address' },
        circulationPool: { $ref: '#/components/schemas/Address' },
        concessionDestinationSetHash: { $ref: '#/components/schemas/Bytes32' },
        concessionDestinations: { type: 'array', items: { $ref: '#/components/schemas/WeightedDestination' } },
        operationsDestinations: { type: 'array', items: { $ref: '#/components/schemas/WeightedDestination' } },
        otherUsdtDestinations: { type: 'array', items: { $ref: '#/components/schemas/WeightedDestination' } },
        seckillPrizePoolAccount: { $ref: '#/components/schemas/Address' },
      },
    },
    CatalogSeckillInventory: {
      type: 'object', additionalProperties: false,
      required: ['total', 'sold', 'reserved', 'available'],
      properties: {
        total: { $ref: '#/components/schemas/AtomicAmount' },
        sold: { $ref: '#/components/schemas/AtomicAmount' },
        reserved: { $ref: '#/components/schemas/AtomicAmount' },
        available: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    CatalogSeckillOverlay: {
      type: 'object', additionalProperties: false,
      required: [
        'sessionId', 'policyVersion', 'phase', 'startsAt', 'mainDeadline',
        'relayDeadline', 'seckillListPriceUsdt', 'inventory', 'ordinaryCheckoutAllowed',
      ],
      properties: {
        sessionId: { $ref: '#/components/schemas/Bytes32' },
        policyVersion: { $ref: '#/components/schemas/AtomicAmount' },
        phase: { enum: ['PREHEAT', 'LIVE', 'SETTLING'] },
        startsAt: { type: 'string', format: 'date-time' },
        mainDeadline: { type: 'string', format: 'date-time' },
        relayDeadline: { type: 'string', format: 'date-time' },
        seckillListPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        inventory: { $ref: '#/components/schemas/CatalogSeckillInventory' },
        ordinaryCheckoutAllowed: { type: 'boolean', enum: [false] },
      },
    },
    CatalogSku: {
      type: 'object', additionalProperties: false,
      required: ['skuId', 'chainSkuId', 'attributes', 'listPriceUsdt', 'stockAvailable', 'seckill'],
      properties: {
        skuId: { type: 'string', minLength: 1 },
        chainSkuId: { $ref: '#/components/schemas/Bytes32' },
        attributes: { type: 'object' },
        listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        stockAvailable: { $ref: '#/components/schemas/AtomicAmount' },
        seckill: {
          anyOf: [{ $ref: '#/components/schemas/CatalogSeckillOverlay' }, { type: 'null' }],
        },
      },
    },
    CatalogProduct: {
      type: 'object', additionalProperties: false,
      required: [
        'productId', 'chainProductId', 'title', 'subtitle', 'metadata',
        'mainImageAssetIds', 'videoAssetId', 'richDetail', 'defaultFreightUsdt',
        'fulfillmentModes', 'categoryId', 'tagIds', 'skus',
      ],
      properties: {
        productId: { type: 'string', minLength: 1 },
        chainProductId: { $ref: '#/components/schemas/Bytes32' },
        title: { type: 'string', minLength: 1 },
        subtitle: { type: 'string', maxLength: 120 },
        metadata: { type: 'object' },
        mainImageAssetIds: { type: 'array', maxItems: 5, items: { $ref: '#/components/schemas/Bytes32' } },
        videoAssetId: { anyOf: [{ $ref: '#/components/schemas/Bytes32' }, { type: 'null' }] },
        richDetail: { type: 'object' },
        defaultFreightUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        fulfillmentModes: {
          type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
          items: { enum: [...fulfillmentModes] },
        },
        categoryId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        tagIds: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        skus: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/CatalogSku' } },
      },
    },
    InventoryReservation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'reservationId', 'reservationHash', 'policyVersion', 'skuId', 'buyerWallet',
        'quantity', 'classification', 'state', 'expiresAt',
      ],
      properties: {
        reservationId: { $ref: '#/components/schemas/Bytes32' },
        reservationHash: { $ref: '#/components/schemas/Bytes32' },
        policyVersion: { type: 'integer', minimum: 1 },
        skuId: { $ref: '#/components/schemas/Bytes32' },
        buyerWallet: { $ref: '#/components/schemas/Address' },
        quantity: { type: 'integer', minimum: 1 },
        classification: { enum: ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] },
        state: { enum: [...reservationStates] },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    PaymentQuoteRequest: {
      type: 'object', additionalProperties: false,
      required: quoteRequestRequired,
      properties: quoteRequestProperties,
    },
    SeckillQuoteRequest: {
      type: 'object', additionalProperties: false,
      required: ['sessionId', ...quoteRequestRequired],
      properties: { sessionId: { $ref: '#/components/schemas/Bytes32' }, ...quoteRequestProperties },
    },
    BeneficiarySnapshot: {
      type: 'object', additionalProperties: false,
      required: ['genesis', 'directReferral', 'district', 'city', 'province', 'region'],
      properties: Object.fromEntries(
        ['genesis', 'directReferral', 'district', 'city', 'province', 'region']
          .map((name) => [name, { $ref: '#/components/schemas/Address' }]),
      ),
    },
    MerchantConcessionAllocation: {
      type: 'object', additionalProperties: false, required: ['account', 'amount'],
      properties: {
        account: { $ref: '#/components/schemas/Address' },
        amount: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    OtherUsdtAllocation: {
      type: 'object', additionalProperties: false, required: ['account', 'amount', 'purpose'],
      properties: {
        account: { $ref: '#/components/schemas/Address' },
        amount: { $ref: '#/components/schemas/AtomicAmount' },
        purpose: { type: 'string', enum: ['POLICY_ALLOCATION', 'SECKILL_PRIZE_LIABILITY'] },
      },
    },
    NplRewardAllocation: {
      type: 'object', additionalProperties: false, required: ['role', 'account', 'amount'],
      properties: {
        role: {
          enum: ['genesis', 'directReferral', 'district', 'city', 'province', 'region', 'operations', 'roundingRemainder'],
        },
        account: { $ref: '#/components/schemas/Address' },
        amount: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    AllocationSnapshot: {
      type: 'object',
      additionalProperties: false,
      required: ['beneficiaries', 'concession', 'otherUsdt', 'nplRewards'],
      properties: {
        beneficiaries: { $ref: '#/components/schemas/BeneficiarySnapshot' },
        concession: { type: 'array', items: { $ref: '#/components/schemas/MerchantConcessionAllocation' } },
        otherUsdt: { type: 'array', items: { $ref: '#/components/schemas/OtherUsdtAllocation' } },
        nplRewards: { type: 'array', items: { $ref: '#/components/schemas/NplRewardAllocation' } },
      },
    },
    CanonicalPaymentIntent: {
      type: 'object', additionalProperties: false,
      required: [
        'orderId', 'policyVersion', 'oracleVersion', 'buyer', 'merchant', 'productId', 'skuId', 'quantity',
        'fulfillmentMode', 'fulfillmentTargetHash', 'regionCodeHash', 'productPolicyHash', 'reservationId',
        'reservationHash', 'reservationDeadline', 'issuedAt', 'deadline', 'nonce', 'listPriceUsdt',
        'usdtPaymentAmount', 'nplQuoteAmount', 'nplPaymentAmount', 'nplBurnAmount', 'nplRewardAmount',
        'merchantBaseReceivableUsdt', 'merchantConcessionBps', 'merchantConcessionAmount',
        'merchantNetReceivableUsdt', 'concessionAllocationHash', 'bnmAmount', 'seckill', 'sessionId',
        'beneficiaries', 'merchantConcessionAllocations', 'otherUsdtAllocations', 'nplRewardAllocations',
        'requiredConfirmations',
      ],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        policyVersion: { type: 'integer', minimum: 1 },
        oracleVersion: { $ref: '#/components/schemas/Bytes32' },
        buyer: { $ref: '#/components/schemas/Address' },
        merchant: { $ref: '#/components/schemas/Address' },
        productId: { $ref: '#/components/schemas/Bytes32' },
        skuId: { $ref: '#/components/schemas/Bytes32' },
        quantity: { type: 'integer', minimum: 1 },
        fulfillmentMode: { enum: ['DELIVERY', 'PICKUP'] },
        fulfillmentTargetHash: { $ref: '#/components/schemas/Bytes32' },
        regionCodeHash: { $ref: '#/components/schemas/Bytes32' },
        productPolicyHash: { $ref: '#/components/schemas/Bytes32' },
        reservationId: { $ref: '#/components/schemas/Bytes32' },
        reservationHash: { $ref: '#/components/schemas/Bytes32' },
        reservationDeadline: { type: 'integer', minimum: 1 },
        issuedAt: { type: 'integer', minimum: 1 },
        deadline: { type: 'integer', minimum: 1 },
        nonce: { $ref: '#/components/schemas/AtomicAmount' },
        listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        usdtPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
        nplQuoteAmount: { $ref: '#/components/schemas/AtomicAmount' },
        nplPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
        nplBurnAmount: { $ref: '#/components/schemas/AtomicAmount' },
        nplRewardAmount: { $ref: '#/components/schemas/AtomicAmount' },
        merchantBaseReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        merchantConcessionBps: { type: 'integer', minimum: 0, maximum: 10000 },
        merchantConcessionAmount: { $ref: '#/components/schemas/AtomicAmount' },
        merchantNetReceivableUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        concessionAllocationHash: { $ref: '#/components/schemas/Bytes32' },
        bnmAmount: { $ref: '#/components/schemas/AtomicAmount' },
        seckill: { type: 'boolean' },
        sessionId: { $ref: '#/components/schemas/Bytes32' },
        beneficiaries: { $ref: '#/components/schemas/BeneficiarySnapshot' },
        merchantConcessionAllocations: {
          type: 'array', items: { $ref: '#/components/schemas/MerchantConcessionAllocation' },
        },
        otherUsdtAllocations: { type: 'array', items: { $ref: '#/components/schemas/OtherUsdtAllocation' } },
        nplRewardAllocations: { type: 'array', items: { $ref: '#/components/schemas/NplRewardAllocation' } },
        requiredConfirmations: { const: 15 },
      },
    },
    ApprovalRequirement: {
      type: 'object', additionalProperties: false,
      required: ['token', 'spender', 'requiredAmount', 'requestedAllowance', 'approvalMode', 'risk', 'revocation'],
      properties: {
        token: { $ref: '#/components/schemas/Address' },
        spender: { $ref: '#/components/schemas/Address' },
        requiredAmount: { $ref: '#/components/schemas/AtomicAmount' },
        requestedAllowance: { $ref: '#/components/schemas/AtomicAmount' },
        approvalMode: { const: 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED' },
        risk: { const: 'UNLIMITED_TOKEN_ALLOWANCE' },
        revocation: {
          type: 'object', additionalProperties: false, required: ['method', 'token', 'spender'],
          properties: {
            method: { const: 'ERC20_APPROVE_ZERO' },
            token: { $ref: '#/components/schemas/Address' },
            spender: { $ref: '#/components/schemas/Address' },
          },
        },
      },
    },
    Eip712Field: {
      type: 'object', additionalProperties: false, required: ['name', 'type'],
      properties: { name: { type: 'string' }, type: { type: 'string' } },
    },
    Eip712Domain: {
      type: 'object', additionalProperties: false, required: ['name', 'version', 'chainId', 'verifyingContract'],
      properties: {
        name: { const: 'Abu24KPaymentRouter' },
        version: { const: '2' },
        chainId: { const: 56 },
        verifyingContract: { $ref: '#/components/schemas/Address' },
      },
    },
    PaymentBuyerAuthorization: {
      type: 'object', additionalProperties: false,
      required: ['domain', 'types', 'primaryType', 'message', 'digest'],
      properties: {
        domain: { $ref: '#/components/schemas/Eip712Domain' },
        types: {
          type: 'object', additionalProperties: false, required: ['PaymentAuthorization'],
          properties: {
            PaymentAuthorization: { type: 'array', items: { $ref: '#/components/schemas/Eip712Field' } },
          },
        },
        primaryType: { const: 'PaymentAuthorization' },
        message: {
          type: 'object', additionalProperties: false,
          required: [
            'paymentHash', 'orderId', 'buyer', 'merchant', 'productId', 'skuId', 'quantity',
            'fulfillmentMode', 'listPriceUsdt', 'usdtPaymentAmount', 'nplPaymentAmount', 'deadline',
          ],
          properties: {
            paymentHash: { $ref: '#/components/schemas/Bytes32' },
            orderId: { $ref: '#/components/schemas/Bytes32' },
            buyer: { $ref: '#/components/schemas/Address' },
            merchant: { $ref: '#/components/schemas/Address' },
            productId: { $ref: '#/components/schemas/Bytes32' },
            skuId: { $ref: '#/components/schemas/Bytes32' },
            quantity: { type: 'integer', minimum: 1 },
            fulfillmentMode: { enum: [0, 1] },
            listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
            usdtPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            nplPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            deadline: { type: 'integer', minimum: 1 },
          },
        },
        digest: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    SeckillBuyerAuthorization: {
      type: 'object', additionalProperties: false,
      required: ['domain', 'types', 'primaryType', 'message', 'digest'],
      properties: {
        domain: { $ref: '#/components/schemas/Eip712Domain' },
        types: {
          type: 'object', additionalProperties: false, required: ['SeckillAuthorization'],
          properties: {
            SeckillAuthorization: { type: 'array', items: { $ref: '#/components/schemas/Eip712Field' } },
          },
        },
        primaryType: { const: 'SeckillAuthorization' },
        message: {
          type: 'object', additionalProperties: false,
          required: [
            'seckillHash', 'orderId', 'buyer', 'merchant', 'productId', 'skuId', 'quantity',
            'fulfillmentMode', 'seckillListPriceUsdt', 'seckillUsdtPaymentAmount',
            'seckillNplPaymentAmount', 'fallbackListPriceUsdt', 'fallbackUsdtPaymentAmount',
            'fallbackNplPaymentAmount', 'deadline',
          ],
          properties: {
            seckillHash: { $ref: '#/components/schemas/Bytes32' },
            orderId: { $ref: '#/components/schemas/Bytes32' },
            buyer: { $ref: '#/components/schemas/Address' },
            merchant: { $ref: '#/components/schemas/Address' },
            productId: { $ref: '#/components/schemas/Bytes32' },
            skuId: { $ref: '#/components/schemas/Bytes32' },
            quantity: { type: 'integer', minimum: 1 },
            fulfillmentMode: { enum: [0, 1] },
            seckillListPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
            seckillUsdtPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            seckillNplPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            fallbackListPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
            fallbackUsdtPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            fallbackNplPaymentAmount: { $ref: '#/components/schemas/AtomicAmount' },
            deadline: { type: 'integer', minimum: 1 },
          },
        },
        digest: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    OrdinaryRouterCall: {
      type: 'object', additionalProperties: false, required: ['functionName', 'intent', 'quoteSignature'],
      properties: {
        functionName: { const: 'pay' },
        intent: { $ref: '#/components/schemas/PaymentRouterIntent' },
        quoteSignature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
      },
    },
    SeckillRouterCall: {
      type: 'object', additionalProperties: false, required: ['functionName', 'intent', 'quoteSignature'],
      properties: {
        functionName: { const: 'paySeckill' },
        intent: {
          type: 'object', additionalProperties: false,
          required: ['sessionId', 'seckillPayment', 'fallbackPayment'],
          properties: {
            sessionId: { $ref: '#/components/schemas/Bytes32' },
            seckillPayment: { $ref: '#/components/schemas/PaymentRouterIntent' },
            fallbackPayment: { $ref: '#/components/schemas/PaymentRouterIntent' },
          },
        },
        quoteSignature: { type: 'string', pattern: '^0x[0-9a-fA-F]+$' },
      },
    },
    PaymentQuoteResponse: {
      type: 'object', required: Object.keys(quoteResponseProperties), properties: quoteResponseProperties,
    },
    CanonicalSeckillIntent: {
      type: 'object', additionalProperties: false,
      required: ['sessionId', 'seckill', 'fallback', 'classificationAuthority'],
      properties: {
        sessionId: { $ref: '#/components/schemas/Bytes32' },
        seckill: { $ref: '#/components/schemas/CanonicalPaymentIntent' },
        fallback: { $ref: '#/components/schemas/CanonicalPaymentIntent' },
        classificationAuthority: { const: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP' },
      },
    },
    SeckillQuoteResponse: {
      type: 'object', required: Object.keys(seckillResponseProperties), properties: seckillResponseProperties,
    },
    PaymentSubmissionRequest: {
      type: 'object', additionalProperties: false, required: ['orderId', 'txHash'],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        txHash: { $ref: '#/components/schemas/Bytes32' },
        replacementForTxHash: { $ref: '#/components/schemas/Bytes32' },
      },
    },
    PaymentSubmissionResponse: {
      type: 'object', additionalProperties: false, required: ['orderId', 'txHash', 'state'],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        txHash: { $ref: '#/components/schemas/Bytes32' },
        state: { const: 'SUBMITTED' },
      },
    },
    PaymentFinality: {
      type: 'object', additionalProperties: false,
      required: [
        'transactionHash', 'blockNumber', 'blockHash', 'confirmations', 'requiredConfirmations',
        'receiptStatus', 'state', 'canonicalBlock', 'classification',
      ],
      properties: {
        transactionHash: { $ref: '#/components/schemas/Bytes32' },
        replacementForTxHash: nullableBytes32,
        blockNumber: { type: 'integer', minimum: 0 },
        blockHash: { $ref: '#/components/schemas/Bytes32' },
        confirmations: { type: 'integer', minimum: 0 },
        requiredConfirmations: { const: 15 },
        receiptStatus: { const: 1 },
        state: { enum: ['MINED', 'REORGED', 'FINAL'] },
        canonicalBlock: { type: 'boolean' },
        classification: { enum: ['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'] },
      },
    },
    PaymentProjection: {
      oneOf: [
        {
          allOf: [
            { $ref: '#/components/schemas/PaymentQuoteResponse' },
            { type: 'object', required: ['finality'], properties: { finality: { anyOf: [{ $ref: '#/components/schemas/PaymentFinality' }, { type: 'null' }] } } },
          ],
        },
        {
          allOf: [
            { $ref: '#/components/schemas/SeckillQuoteResponse' },
            { type: 'object', required: ['finality'], properties: { finality: { anyOf: [{ $ref: '#/components/schemas/PaymentFinality' }, { type: 'null' }] } } },
          ],
        },
      ],
    },
  };
  const canonicalIntent = schemas.CanonicalPaymentIntent;
  const offChainFields = new Set([
    'merchantConcessionAllocations',
    'otherUsdtAllocations',
    'nplRewardAllocations',
    'requiredConfirmations',
  ]);
  schemas.PaymentRouterIntent = {
    type: 'object',
    additionalProperties: false,
    required: canonicalIntent.required.filter((name) => !offChainFields.has(name)),
    properties: {
      ...Object.fromEntries(
      Object.entries(canonicalIntent.properties).filter(([name]) => !offChainFields.has(name)),
      ),
      fulfillmentMode: { enum: [0, 1] },
    },
  };
  return schemas;
}

function generatedJavaScript() {
  return `export const artifactVersion = ${JSON.stringify(artifactVersion)};\n` +
    `export const chainIdentity = Object.freeze(${JSON.stringify({ chainId: BSC_CHAIN_ID, usdtAddress: USDT_ADDRESS, nplAddress: NPL_ADDRESS })});\n` +
    Object.entries(enums)
      .filter(([name]) => name !== 'artifactVersion')
      .map(([name, values]) => `export const ${name} = Object.freeze(${JSON.stringify(values)});`)
      .join('\n') + '\n';
}

function generatedTypes() {
  const union = (values) => values.map((value) => JSON.stringify(value)).join(' | ');
  return `export declare const artifactVersion: ${JSON.stringify(artifactVersion)};
export declare const chainIdentity: Readonly<{ chainId: 56; usdtAddress: ${JSON.stringify(USDT_ADDRESS)}; nplAddress: ${JSON.stringify(NPL_ADDRESS)} }>;
export type AtomicAmount = string;
export type Bytes32 = string;
export type Address = string;
export type Timestamp = string;
export type OrderProjectionState = ${union(orderProjectionStates)};
export type ContractOrderState = ${union(contractOrderStates)};
export type OrderFinalityStatus = ${union(orderFinalityStatuses)};
export type TransactionFinalityState = ${union(finalityStates)};
export type UserRole = ${union(userRoles)};
export type BreakerScope = ${union(breakerScopes)};
export type CatalogProductAction = ${union(catalogProductActions)};
export type CatalogProductLifecycleState = ${union(catalogProductLifecycleStates)};
export type CatalogReviewDecision = ${union(catalogReviewDecisions)};
export type CatalogTaxonomyStatus = ${union(catalogTaxonomyStatuses)};
export type AllowedActionName = ${union(allowedActionNames)};
export type AllowedActionReasonCode = ${union(allowedActionReasonCodes)};
export type CoreErrorCode = ${union(coreErrorCodes)};
export type FulfillmentMode = ${union(fulfillmentModes)};
export type OrderKind = 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
export type FulfillmentMethod = ${union(fulfillmentMethods)};
export type StoreStatus = ${union(storeStatuses)};
export type FulfillmentRequestType = ${union(fulfillmentRequestTypes)};
export type FulfillmentRequestState = ${union(fulfillmentRequestStates)};
export type LogisticsProvider = ${union(logisticsProviders)};
export type LogisticsStatus = ${union(logisticsStatuses)};
export type MediaContentType = ${union(mediaContentTypes)};
export type MediaPurpose = ${union(mediaPurposes)};
export type MediaResourceType = ${union(mediaResourceTypes)};
export type FulfillmentAsset = ${union(fulfillmentAssets)};
export type ArbitrationOutcome = ${union(arbitrationOutcomes)};
export type SettlementRail = ${union(settlementRails)};
export type SettlementIntentState = ${union(settlementIntentStates)};
export type SettlementRequestState = ${union(settlementRequestStates)};
export type SettlementBatchState = ${union(settlementBatchStates)};
export type MerchantGuaranteeDepositState = ${union(merchantGuaranteeDepositStates)};
export type GuaranteeStatus = ${union(guaranteeStatuses)};
export type BreakerAction = ${union(breakerActions)};
export type BreakerCauseType = ${union(breakerCauseTypes)};
export type ReservationState = ${union(reservationStates)};
export type BalanceState = ${union(balanceStates)};
export type RewardSubtype = ${union(rewardSubtypes)};
export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' | 'SECKILL_PRIZE_LIABILITY';
export type TakeoverState = ${union(takeoverStates)};
export type SeckillState = ${union(seckillStates)};
export type PolicyPublicationState = ${union(policyPublicationStates)};
export type PolicyDraftState = ${union(policyDraftStates)};
export type CmsContentType = ${union(cmsContentTypes)};
export type CmsContentFormat = ${union(cmsContentFormats)};
export type CmsPublicationEventType = ${union(cmsPublicationEventTypes)};
export type NotificationChannel = ${union(notificationChannels)};
export type NotificationProvider = ${union(notificationProviders)};
export type NotificationEndpointState = ${union(notificationEndpointStates)};
export type NotificationCampaignTopic = ${union(notificationCampaignTopics)};
export type NotificationCampaignState = ${union(notificationCampaignStates)};
export type NotificationDeliveryState = ${union(notificationDeliveryStates)};
export type SystemConfigKey = ${union(systemConfigKeys)};
export type AuditStreamName = ${union(auditStreamNames)};
export type AuditEvidenceProfile = ${union(auditEvidenceProfiles)};
export type OperationsMetricComponent = ${union(operationsMetricComponents)};
export type OperationsMetricUnit = ${union(operationsMetricUnits)};
export type OperationsMetricStatus = ${union(operationsMetricStatuses)};
export type OperationsAlertEventType = ${union(operationsAlertEventTypes)};
export type OperationsAlertSeverity = ${union(operationsAlertSeverities)};
export type AdapterProvider = ${union(adapterProviders)};
export type InfrastructureProvider = ${union(infrastructureProviders)};
export type ProviderReadinessState = ${union(providerReadinessStates)};
export declare const orderProjectionStates: readonly OrderProjectionState[];
export declare const contractOrderStates: readonly ContractOrderState[];
export declare const orderFinalityStatuses: readonly OrderFinalityStatus[];
export declare const finalityStates: readonly TransactionFinalityState[];
export declare const userRoles: readonly UserRole[];
export declare const breakerScopes: readonly BreakerScope[];
export declare const catalogProductActions: readonly CatalogProductAction[];
export declare const catalogProductLifecycleStates: readonly CatalogProductLifecycleState[];
export declare const catalogReviewDecisions: readonly CatalogReviewDecision[];
export declare const catalogTaxonomyStatuses: readonly CatalogTaxonomyStatus[];
export declare const allowedActionNames: readonly AllowedActionName[];
export declare const executableOrderActionNames: readonly AllowedActionName[];
export declare const allowedActionReasonCodes: readonly AllowedActionReasonCode[];
export declare const coreErrorCodes: readonly CoreErrorCode[];
export declare const fulfillmentModes: readonly FulfillmentMode[];
export declare const fulfillmentMethods: readonly FulfillmentMethod[];
export declare const storeStatuses: readonly StoreStatus[];
export declare const fulfillmentRequestTypes: readonly FulfillmentRequestType[];
export declare const fulfillmentRequestStates: readonly FulfillmentRequestState[];
export declare const logisticsProviders: readonly LogisticsProvider[];
export declare const logisticsStatuses: readonly LogisticsStatus[];
export declare const mediaContentTypes: readonly MediaContentType[];
export declare const mediaPurposes: readonly MediaPurpose[];
export declare const mediaResourceTypes: readonly MediaResourceType[];
export declare const fulfillmentAssets: readonly FulfillmentAsset[];
export declare const arbitrationOutcomes: readonly ArbitrationOutcome[];
export declare const settlementRails: readonly SettlementRail[];
export declare const settlementIntentStates: readonly SettlementIntentState[];
export declare const settlementRequestStates: readonly SettlementRequestState[];
export declare const settlementBatchStates: readonly SettlementBatchState[];
export declare const merchantGuaranteeDepositStates: readonly MerchantGuaranteeDepositState[];
export declare const guaranteeStatuses: readonly GuaranteeStatus[];
export declare const breakerActions: readonly BreakerAction[];
export declare const breakerCauseTypes: readonly BreakerCauseType[];
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const rewardSubtypes: readonly RewardSubtype[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const policyDraftStates: readonly PolicyDraftState[];
export declare const cmsContentTypes: readonly CmsContentType[];
export declare const cmsContentFormats: readonly CmsContentFormat[];
export declare const cmsPublicationEventTypes: readonly CmsPublicationEventType[];
export declare const notificationChannels: readonly NotificationChannel[];
export declare const notificationProviders: readonly NotificationProvider[];
export declare const notificationEndpointStates: readonly NotificationEndpointState[];
export declare const notificationCampaignTopics: readonly NotificationCampaignTopic[];
export declare const notificationCampaignStates: readonly NotificationCampaignState[];
export declare const notificationDeliveryStates: readonly NotificationDeliveryState[];
export declare const systemConfigKeys: readonly SystemConfigKey[];
export declare const auditStreamNames: readonly AuditStreamName[];
export declare const auditEvidenceProfiles: readonly AuditEvidenceProfile[];
export declare const operationsMetricComponents: readonly OperationsMetricComponent[];
export declare const operationsMetricUnits: readonly OperationsMetricUnit[];
export declare const operationsMetricStatuses: readonly OperationsMetricStatus[];
export declare const operationsAlertEventTypes: readonly OperationsAlertEventType[];
export declare const operationsAlertSeverities: readonly OperationsAlertSeverity[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];

export type JsonObject = Readonly<Record<string, unknown>>;

export interface SeckillSessionProduct {
  productId: string;
  skuId: string;
  title: string;
  metadata: JsonObject;
  attributes: JsonObject;
  seckillListPriceUsdt: AtomicAmount;
}

export interface SeckillSessionTimers {
  mainDurationSeconds: number;
  relayInitialSeconds: number;
  relayIncrementSeconds: number;
  relayCapSeconds: number;
}

export interface SeckillSessionInventory {
  total: AtomicAmount;
  sold: AtomicAmount;
  reserved: AtomicAmount;
  available: AtomicAmount;
}

export interface SeckillSessionProjection {
  artifactVersion: typeof artifactVersion;
  sessionId: Bytes32;
  policyVersion: AtomicAmount;
  merchantId: string;
  product: SeckillSessionProduct;
  phase: SeckillState;
  storedPhase: SeckillState;
  serverTime: string;
  startsAt: string;
  mainDeadline: string;
  relayDeadline: string;
  settlementEarliestAt: string;
  settlementDeadline: string;
  timers: SeckillSessionTimers;
  inventory: SeckillSessionInventory;
  prizePoolUsdt: AtomicAmount;
  lastBuyerWallet: Address | null;
  winnerWallet: Address | null;
  snapshot: JsonObject;
  allowedActions: readonly string[];
}

export interface SeckillSessionHistoryPage {
  items: readonly SeckillSessionProjection[];
  nextCursor: string | null;
}

export interface RealtimeEventEnvelope {
  artifactVersion: typeof artifactVersion;
  protocolVersion: 1;
  eventId: string;
  channel: string;
  cursor: AtomicAmount;
  eventType: 'SeckillRelayExtended';
  resourceType: 'SECKILL_SESSION';
  resourceId: Bytes32;
  occurredAt: string;
  finality: 'FINAL';
  payload: JsonObject;
}

export interface RealtimeEventPage {
  items: readonly RealtimeEventEnvelope[];
  nextCursor: AtomicAmount;
}

export interface SensitiveApproval {
  action: string;
  resourceType: string;
  resourceId: string;
  policyVersion: AtomicAmount;
  oldValueHash: Bytes32;
  newValueHash: Bytes32;
  safeAddress: Address;
  nonce: AtomicAmount;
  deadline: AtomicAmount;
  signature: string;
}

export interface SettlementIntentRequest {
  rail: 'MERCHANT_USDT' | 'REWARD_NPL' | 'PRIZE_USDT';
  amount: AtomicAmount;
  idempotencyKey: string;
}

export interface GovernedSettlementIntentRequest {
  rail: 'TAKEOVER_USDT' | 'OPERATIONS_REIMBURSEMENT_USDT';
  resourceId: string;
  orderId: string;
  accountId: string;
  recipient: Address;
  fulfillmentTargetHash?: Bytes32;
  amount: AtomicAmount;
  idempotencyKey: string;
  approval: SensitiveApproval;
}

export interface SettlementRequestSubmission {
  intentId: Bytes32;
  signature: string;
}

export interface SettlementRequestIntent {
  intentId: Bytes32;
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  recipient: Address;
  rail: SettlementRail;
  asset: Address;
  safeAddress: Address;
  amount: AtomicAmount;
  itemsHash: Bytes32;
  nonce: AtomicAmount;
  deadline: number;
}

export interface SettlementIntentItem {
  itemIndex: number;
  orderId: string;
  accountId: string;
  backingSafeAddress: Address;
  amount: AtomicAmount;
  itemHash: Bytes32;
}

export interface Eip712TypedData {
  domain: JsonObject;
  types: JsonObject;
  primaryType: string;
  message: JsonObject;
}

export interface SettlementIntentProjection {
  intent: SettlementRequestIntent;
  digest: Bytes32;
  typedData: Eip712TypedData;
  items: readonly SettlementIntentItem[];
  createdAt: string;
}

export interface SettlementRequestItem {
  item_index: number;
  order_id: string;
  account_id: string;
  backing_safe_address: Address;
  amount: AtomicAmount;
  requested_journal_id: string;
  batched_journal_id: string | null;
  settled_journal_id: string | null;
}

export interface SettlementRequestItemTransition {
  transition_id: string;
  request_item_index: number;
  batch_id: string | null;
  transition_sequence: AtomicAmount;
  transition_type: string;
  journal_id: string;
  created_at: string;
}

export interface SettlementRequestProjection {
  request_id: string;
  intent_id: Bytes32;
  artifact_version: typeof artifactVersion;
  wallet_address: Address;
  recipient_address: Address;
  rail: SettlementRail;
  asset: 'USDT' | 'NPL';
  asset_address: Address;
  safe_address: Address;
  amount: AtomicAmount;
  items_hash: Bytes32;
  intent_digest: Bytes32;
  signature_hash: Bytes32;
  state: SettlementRequestState;
  batch_id: string | null;
  final_safe_tx_hash: Bytes32 | null;
  final_execution_tx_hash: Bytes32 | null;
  requested_at: string;
  batched_at: string | null;
  settled_at: string | null;
  items: readonly SettlementRequestItem[];
  transitions: readonly SettlementRequestItemTransition[];
}

export interface SettlementBalance {
  asset: 'USDT' | 'NPL';
  purpose: string;
  rewardSubtype: RewardSubtype | null;
  state: BalanceState;
  amount: AtomicAmount;
}

export interface BnmPointsBalance {
  pointsType: 'BNM';
  purpose: 'BNM_LIABILITY';
  state: 'LOCKED' | 'AVAILABLE';
  amount: AtomicAmount;
  transferable: false;
}

export interface SettlementListProjection {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  balances: readonly SettlementBalance[];
  points: readonly BnmPointsBalance[];
  requests: readonly SettlementRequestProjection[];
}

export interface GuaranteeDepositRequest {
  policyVersion: AtomicAmount;
  expectedAmountUsdt: AtomicAmount;
  transactionHash: Bytes32;
  idempotencyKey: string;
}

export interface GuaranteeDepositProjection {
  depositId: string;
  merchantId: string;
  policyVersion: number;
  transactionHash: Bytes32;
  expectedAmountUsdt: AtomicAmount;
  operationsSafeAddress: Address;
  state: MerchantGuaranteeDepositState;
  confirmations: number;
  blockNumber?: number;
  blockHash?: Bytes32;
  logIndex?: number;
}

export interface TakeoverFundingChallengeRequest {
  caseId: string;
  requiredUsdt: AtomicAmount;
  nonce: AtomicAmount;
  deadline: AtomicAmount;
}

export interface TakeoverFundingRequest {
  caseId: string;
  requiredUsdt: AtomicAmount;
  idempotencyKey: string;
  approval: SensitiveApproval;
}

export interface TakeoverFundingReceivable {
  orderId: string;
  accountId: string;
  backingSafeAddress: Address;
  amount: AtomicAmount;
}

export interface TakeoverFundingPlan {
  caseId: string;
  orderId: string;
  policyVersion: number;
  requiredUsdt: AtomicAmount;
  operationsSafe: Address;
  guaranteeUsedUsdt: AtomicAmount;
  receivables: readonly TakeoverFundingReceivable[];
  frozenReceivablesUsedUsdt: AtomicAmount;
  platformAdvanceUsdt: AtomicAmount;
  oldValueHash: Bytes32;
  newValueHash: Bytes32;
}

export interface TakeoverFundingChallenge {
  plan: TakeoverFundingPlan;
  typedData: Eip712TypedData;
}

export interface TakeoverFundingResult {
  caseId: string;
  state: 'FUNDED';
  requiredUsdt: AtomicAmount;
  guaranteeUsedUsdt: AtomicAmount;
  frozenReceivablesUsedUsdt: AtomicAmount;
  futureProceedsUsedUsdt: AtomicAmount;
  platformAdvanceUsdt: AtomicAmount;
  merchantDebtUsdt: AtomicAmount;
}

export interface MerchantFinanceMerchant {
  merchant_id: string;
  status: string;
  guarantee_status: GuaranteeStatus;
  settlement_wallet: Address;
}

export interface MerchantGuarantee {
  backing_safe_address: Address;
  balance_usdt: AtomicAmount;
  minimum_usdt: AtomicAmount;
  source_evidence_hash: Bytes32;
  updated_at: string;
}

export interface MerchantGuaranteeDeposit {
  deposit_id: string;
  policy_version: AtomicAmount;
  token_address: Address;
  operations_safe_address: Address;
  expected_amount_usdt: AtomicAmount;
  transaction_hash: Bytes32;
  state: MerchantGuaranteeDepositState;
  observed_block_number: AtomicAmount | null;
  observed_block_hash: Bytes32 | null;
  observed_log_index: number | null;
  confirmations: number;
  transfer_evidence_hash: Bytes32 | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}

export interface MerchantDebt {
  incurred_usdt: AtomicAmount;
  recovered_usdt: AtomicAmount;
  outstanding_usdt: AtomicAmount;
  latest_evidence_hash: Bytes32;
  updated_at: string;
}

export interface MerchantTakeover {
  case_id: string;
  order_id: string;
  state: TakeoverState;
  required_usdt: AtomicAmount | null;
  guarantee_used_usdt: AtomicAmount | null;
  merchant_available_used_usdt: AtomicAmount | null;
  future_proceeds_used_usdt: AtomicAmount | null;
  platform_advance_usdt: AtomicAmount | null;
  disbursed_usdt: AtomicAmount | null;
  merchant_debt_usdt: AtomicAmount | null;
  evidence_hash: Bytes32;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

export interface MerchantFinanceProjection {
  merchant: MerchantFinanceMerchant;
  guarantee: MerchantGuarantee | null;
  guaranteeDeposits: readonly MerchantGuaranteeDeposit[];
  debt: MerchantDebt | null;
  takeovers: readonly MerchantTakeover[];
}

export interface TakeoverFundingProjection {
  case_id: string;
  state: TakeoverState;
  required_usdt: AtomicAmount | null;
  guarantee_used_usdt: AtomicAmount | null;
  merchant_available_used_usdt: AtomicAmount | null;
  future_proceeds_used_usdt: AtomicAmount | null;
  platform_advance_usdt: AtomicAmount | null;
  merchant_debt_usdt: AtomicAmount | null;
}

export interface TakeoverFundingItem {
  source_type: string;
  amount_usdt: AtomicAmount;
  journal_id: string;
  evidence_hash: Bytes32;
  created_at: string;
}

export interface MerchantDebtRecovery {
  recovery_id: string;
  order_id: string;
  amount_usdt: AtomicAmount;
  operations_safe_address: Address;
  backing_safe_address: Address;
  journal_id: string;
  evidence_hash: Bytes32;
  recovered_at: string;
  reversed_at: string | null;
  reversal_evidence_hash: Bytes32 | null;
}

export interface TakeoverFundingDetail extends TakeoverFundingProjection {
  items: readonly TakeoverFundingItem[];
  debtRecoveries: readonly MerchantDebtRecovery[];
}

export interface PolicyDraftCreateRequest { payload: JsonObject; idempotencyKey: string }
export interface PolicyDraftUpdateRequest { payload: JsonObject }
export interface PolicyApprovalChallengeRequest { nonce: AtomicAmount; deadline: AtomicAmount }
export interface PolicySecondarySignatureRequest extends PolicyApprovalChallengeRequest { signature: string }

export interface PolicyDraftProjection {
  draftId: string;
  nextPolicyVersion: AtomicAmount;
  basePolicyVersion: AtomicAmount | null;
  artifactVersion: string | null;
  payload: JsonObject;
  validationErrors: readonly Readonly<{ code: string; field: string }>[];
  state: PolicyDraftState;
  policyHash: Bytes32 | null;
  operationsHash: Bytes32 | null;
  publicationDigest: Bytes32 | null;
  publicationNonce: AtomicAmount | null;
  publicationDeadline: string | null;
  secondarySigner: Address | null;
  secondarySignatureHash: Bytes32 | null;
  safeAddress: Address | null;
  safeCalldataHash: Bytes32 | null;
  safeTxHash: Bytes32 | null;
  safeProposalHash: Bytes32 | null;
  createdBy: Address;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDraftTransition {
  transitionId: string;
  fromState: PolicyDraftState | null;
  toState: PolicyDraftState;
  evidenceHash: Bytes32;
  actorWallet: Address;
  createdAt: string;
}

export interface PolicyDraftDetail extends PolicyDraftProjection {
  transitions: readonly PolicyDraftTransition[];
}

export interface PolicyApprovalChallenge {
  draftId: string;
  policyVersion: number;
  signer: Address;
  typedData: Eip712TypedData;
  digest: Bytes32;
}

export interface CmsVersionCreateRequest {
  entryId?: string;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  contentFormat: CmsContentFormat;
  content: JsonObject;
  audience: JsonObject;
  startsAt?: string;
  endsAt?: string;
  frequencyCap?: number;
  policyVersion?: AtomicAmount;
  idempotencyKey: string;
}

export interface CmsVersionProjection {
  entryId: string;
  versionId: string;
  version: number;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  contentFormat: CmsContentFormat;
  content: JsonObject;
  contentHash: Bytes32;
  audience: JsonObject;
  startsAt: string | null;
  endsAt: string | null;
  frequencyCap: number | null;
  policyVersion: AtomicAmount | null;
  published: boolean;
  publicationType: CmsPublicationEventType | null;
  createdBy: Address;
  createdAt: string;
}

export interface CmsPublicItem {
  entryId: string;
  versionId: string;
  version: number;
  slug: string;
  contentType: CmsContentType;
  placement: string;
  locale: string;
  content: JsonObject;
  contentHash: Bytes32;
  audience: JsonObject;
  startsAt: string | null;
  endsAt: string | null;
  frequencyCap: number | null;
  policyVersion: AtomicAmount | null;
}

export interface NotificationEndpointRequest {
  channel: NotificationChannel;
  provider: NotificationProvider;
  endpointReference: string;
  topics: readonly string[];
  regionCode?: string;
}

export interface NotificationEndpointProjection {
  endpointId: string;
  channel: NotificationChannel;
  provider: NotificationProvider;
  topics: readonly string[];
  state: NotificationEndpointState;
}

export interface NotificationInboxItem {
  messageId: string;
  sourceEventType: string;
  topic: string;
  templateData: JsonObject;
  deliveryState: NotificationDeliveryState;
  createdAt: string;
}

export interface NotificationCampaignRequest {
  topic: NotificationCampaignTopic;
  audience: JsonObject;
  message: JsonObject;
  cmsVersionId?: string;
  startsAt?: string;
  endsAt?: string;
  idempotencyKey: string;
}

export interface NotificationCampaignCreateResult {
  campaignId: string;
  state: NotificationCampaignState;
  contentHash: Bytes32;
}

export interface NotificationCampaignPublishResult { campaignId: string; state: 'PUBLISHED' }

export interface SystemConfigCreateRequest {
  configKey: SystemConfigKey;
  payload: JsonObject;
  effectiveFrom: string;
  idempotencyKey: string;
}

export interface SystemConfigProjection {
  configVersionId: string;
  configKey: SystemConfigKey;
  version: number;
  payload: JsonObject;
  payloadHash: Bytes32;
  effectiveFrom: string;
  published: boolean;
  createdBy: Address;
  createdAt: string;
}

export interface AuditEntry {
  entryId: string;
  sourceEventId: string;
  streamName: AuditStreamName;
  evidenceProfile: AuditEvidenceProfile;
  sequence: AtomicAmount;
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorWallet: Address | null;
  actorRole: string | null;
  correlationId: string;
  requestHash: string;
  payload: JsonObject;
  signatureEvidence: JsonObject | null;
  authorizationEvidence: JsonObject | null;
  transactionEvidence: JsonObject | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface AuditChainProof { verified: boolean; entries: number; headHash: string | null }
export interface AuditCursor { createdAt: string; entryId: string }
export interface AuditListResponse {
  entries: readonly AuditEntry[];
  chainProof: Readonly<Partial<Record<AuditStreamName, AuditChainProof>>>;
  nextCursor: AuditCursor | null;
}

export interface MonitoringMetric {
  snapshotId: string;
  component: OperationsMetricComponent;
  metricName: string;
  unit: OperationsMetricUnit;
  value: number | null;
  status: OperationsMetricStatus;
  windowStartedAt: string;
  windowEndedAt: string;
  evidence: JsonObject;
  observedAt: string;
}

export interface MonitoringAlert {
  alertEventId: string;
  alertKey: string;
  state: OperationsAlertEventType;
  severity: OperationsAlertSeverity;
  snapshotId: string;
  actorWallet: Address | null;
  createdAt: string;
}

export interface MonitoringCoverage {
  asset: 'USDT' | 'NPL';
  safe_address: Address;
  assets: AtomicAmount;
  unsettled_liabilities: AtomicAmount;
  covered: boolean;
  observed_at: string;
}

export interface MonitoringDashboard {
  metrics: readonly MonitoringMetric[];
  alerts: readonly MonitoringAlert[];
  coverage: readonly MonitoringCoverage[];
}

export interface MonitoringAcknowledgeResult { alertKey: string; state: 'ACKNOWLEDGED' }

export interface BusinessDayWindow { start: string; end: string; generatedAt: string }
export interface BusinessRatio { numerator: AtomicAmount; denominator: AtomicAmount; bps: AtomicAmount | null }

export interface MerchantBusinessDashboard {
  artifactVersion: typeof artifactVersion;
  timezone: 'Asia/Shanghai';
  window: BusinessDayWindow;
  merchant: { merchantId: string; status: string; level: string; guaranteeStatus: GuaranteeStatus };
  product: {
    productId: string;
    title: string;
    state: CatalogProductLifecycleState;
    stock: { total: AtomicAmount; available: AtomicAmount; reserved: AtomicAmount };
    seckill: { sessionId: Bytes32; phase: SeckillState } | null;
    updatedAt: string;
  } | null;
  orders: {
    finalizedToday: AtomicAmount; pendingShipment: AtomicAmount; shipped: AtomicAmount;
    delivered: AtomicAmount; fulfilled: AtomicAmount; arbitration: AtomicAmount;
    takeover: AtomicAmount; pickupVerifiedToday: AtomicAmount;
  };
  sales: {
    listPriceUsdt: AtomicAmount; buyerUsdtPaid: AtomicAmount;
    merchantBaseReceivableUsdt: AtomicAmount; merchantNetReceivableUsdt: AtomicAmount;
  };
  shipmentRate: BusinessRatio;
  settlements: { requestedCount: AtomicAmount; requestedUsdt: AtomicAmount; settledCount: AtomicAmount; settledUsdt: AtomicAmount };
}

export interface AdminBusinessDashboard {
  artifactVersion: typeof artifactVersion;
  timezone: 'Asia/Shanghai';
  window: BusinessDayWindow;
  orders: {
    finalizedToday: AtomicAmount; listPriceUsdt: AtomicAmount; buyerUsdtPaid: AtomicAmount;
    pendingShipment: AtomicAmount; shipped: AtomicAmount; delivered: AtomicAmount;
    fulfilled: AtomicAmount; shipmentRate: BusinessRatio;
  };
  merchants: { total: AtomicAmount; newToday: AtomicAmount; pending: AtomicAmount; approved: AtomicAmount; suspended: AtomicAmount };
  products: { total: AtomicAmount; pendingReview: AtomicAmount; soldOut: AtomicAmount };
  seckill: { createdToday: AtomicAmount; active: AtomicAmount; settling: AtomicAmount };
  fulfillmentQueues: { exchange: AtomicAmount; delay: AtomicAmount; arbitration: AtomicAmount; forcedReceipt: AtomicAmount; takeover: AtomicAmount };
  settlements: { requestedCount: AtomicAmount; requestedUsdt: AtomicAmount; settledCount: AtomicAmount; settledUsdt: AtomicAmount; failedTransactions: AtomicAmount };
  coverage: readonly {
    snapshotId: string; blockNumber: AtomicAmount; recordedAt: string; asset: 'USDT' | 'NPL';
    safeAddress: Address; verifiedAssets: AtomicAmount; unsettledLiabilities: AtomicAmount; covered: boolean;
  }[];
  breakers: readonly { scope: BreakerScope; paused: boolean }[];
  unavailable: readonly { metric: string; reasonCode: 'DecisionBlocked' | 'ExternalBlocked'; detail: string }[];
}

export interface ProductPolicy {
  policyVersion: number;
  oracleVersion: Bytes32;
  usdtPaymentBps: number;
  nplPaymentBps: number;
  nplBurnListPriceBps: number;
  nplRewardListPriceBps: number;
  genesisBps: number;
  directReferralBps: number;
  districtBps: number;
  cityBps: number;
  provinceBps: number;
  regionBps: number;
  operationsBps: number;
  platformFeeBps: number;
  seckillPrizeBps: number;
  oracleWindowSeconds: 1800;
  oracleMaxDeviationBps: 500;
  oracleMaxAgeSeconds: 600;
  oracleMinimumUsdtLiquidity: AtomicAmount;
  requiredConfirmations: 15;
  merchantGuaranteeMinimumUsdt: AtomicAmount;
  usdtCustodySafe: Address;
  nplRewardSafe: Address;
  operationsTreasurySafe: Address;
  circulationPool: Address;
  concessionDestinationSetHash: Bytes32;
  concessionDestinations: readonly WeightedDestination[];
  operationsDestinations: readonly WeightedDestination[];
  otherUsdtDestinations: readonly WeightedDestination[];
  seckillPrizePoolAccount: Address;
}

export interface WeightedDestination {
  account: Address;
  weightBps: number;
}

export interface CatalogSeckillInventory {
  total: AtomicAmount;
  sold: AtomicAmount;
  reserved: AtomicAmount;
  available: AtomicAmount;
}

export interface CatalogSeckillOverlay {
  sessionId: Bytes32;
  policyVersion: AtomicAmount;
  phase: 'PREHEAT' | 'LIVE' | 'SETTLING';
  startsAt: Timestamp;
  mainDeadline: Timestamp;
  relayDeadline: Timestamp;
  seckillListPriceUsdt: AtomicAmount;
  inventory: CatalogSeckillInventory;
  ordinaryCheckoutAllowed: false;
}

export interface CatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  attributes: Readonly<Record<string, unknown>>;
  listPriceUsdt: AtomicAmount;
  stockAvailable: AtomicAmount;
  seckill: CatalogSeckillOverlay | null;
}

export interface CatalogProduct {
  productId: string;
  chainProductId: Bytes32;
  title: string;
  subtitle: string;
  metadata: Readonly<Record<string, unknown>>;
  mainImageAssetIds: readonly Bytes32[];
  videoAssetId: Bytes32 | null;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId: string | null;
  tagIds: readonly string[];
  skus: readonly CatalogSku[];
}

export interface CatalogCategory {
  categoryId: string;
  version: AtomicAmount;
  parentCategoryId: string | null;
  level: 1 | 2 | 3;
  name: string;
  iconAssetId: Bytes32 | null;
  sortOrder: number;
  status: CatalogTaxonomyStatus;
  serviceFee: Readonly<{ state: 'Frozen' | 'DecisionBlocked'; valueBps: number | null }>;
}

export interface CatalogTag {
  tagId: string;
  version: AtomicAmount;
  name: string;
  example: string;
  sortOrder: number;
  status: CatalogTaxonomyStatus;
}

export interface ProductSkuInput {
  skuId?: string;
  attributes: JsonObject;
  listPriceUsdt: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  stockTotal: number;
  proposedSeckillInventory: number;
}

export interface ProductSlotInput {
  idempotencyKey: string;
  title: string;
  subtitle?: string;
  mainImageAssetIds?: readonly Bytes32[];
  videoAssetId?: Bytes32;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  merchantConcessionBps: number;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId?: string;
  tagIds?: readonly string[];
  skus: readonly ProductSkuInput[];
}

export interface AdminProductSlotInput extends ProductSlotInput {
  merchantId: string;
}

export interface CatalogWriteLock {
  type: string;
  id: string;
  state: string;
}

export interface ManagedCatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  version: AtomicAmount;
  attributes: JsonObject;
  listPriceUsdt: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  stockTotal: AtomicAmount;
  stockAvailable: AtomicAmount;
  stockReserved: AtomicAmount;
  proposedSeckillInventory: AtomicAmount;
  lifecycleState: CatalogProductLifecycleState;
}

export interface ManagedCatalogProduct {
  artifactVersion: typeof artifactVersion;
  productId: string;
  chainProductId: Bytes32;
  merchantId: string;
  storeId: string | null;
  supersedesProductId: string | null;
  version: AtomicAmount;
  title: string;
  subtitle: string;
  lifecycleState: CatalogProductLifecycleState;
  productPolicyHash: Bytes32;
  merchantConcessionBps: number;
  mainImageAssetIds: readonly Bytes32[];
  videoAssetId: Bytes32 | null;
  richDetail: JsonObject;
  defaultFreightUsdt: AtomicAmount;
  fulfillmentModes: readonly FulfillmentMode[];
  categoryId: string | null;
  tagIds: readonly string[];
  skus: readonly ManagedCatalogSku[];
  allowedActions: readonly CatalogProductAction[];
  writeLock: CatalogWriteLock | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSlotProjection {
  artifactVersion: typeof artifactVersion;
  storeId: string;
  merchantId: string;
  product: ManagedCatalogProduct | null;
  allowedActions: readonly CatalogProductAction[];
  writeLock: CatalogWriteLock | null;
}

export interface MerchantConcessionAllocation {
  account: Address;
  amount: AtomicAmount;
}

export interface MerchantConcessionPreviewItem {
  skuId: string;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionBps: number;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  allocations: readonly MerchantConcessionAllocation[];
}

export interface MerchantConcessionPreviewPayload {
  artifactVersion: typeof artifactVersion;
  productId: string;
  productVersion: number;
  merchantId: string;
  policyVersion: number;
  merchantConcessionBps: number;
  destinationSetHash: Bytes32;
  catalogFingerprint: Bytes32;
  items: readonly MerchantConcessionPreviewItem[];
  expiresAt: string;
}

export interface CatalogSignedAuthorization extends Eip712TypedData {
  primaryType: 'MerchantConcessionPreview';
  digest: Bytes32;
  signature: string;
  signer: Address;
}

export interface MerchantConcessionPreview {
  artifactVersion: typeof artifactVersion;
  previewId: Bytes32;
  productId: string;
  productVersion: AtomicAmount;
  merchantId: string;
  policyVersion: AtomicAmount;
  merchantConcessionBps: number;
  catalogFingerprint: Bytes32;
  destinationSetHash: Bytes32;
  previewHash: Bytes32;
  payload: MerchantConcessionPreviewPayload;
  authorization: CatalogSignedAuthorization;
  expiresAt: string;
  createdAt: string;
}

export interface MediaUploadIntentProjection {
  artifactVersion: typeof artifactVersion;
  uploadIntentId: Bytes32;
  ownerWallet: Address;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  state: 'UPLOADED';
  expiresAt: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Readonly<Record<string, string>>;
  providerReferenceHash: Bytes32;
  writeOnce: true;
}

export interface MediaAssetProjection {
  artifactVersion: typeof artifactVersion;
  assetId: Bytes32;
  uploadIntentId: Bytes32;
  ownerWallet: Address;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  providerEvidenceHash: Bytes32;
  objectVersionHash: Bytes32;
  createdAt: string;
}

export interface MediaReadAccessProjection {
  artifactVersion: typeof artifactVersion;
  assetId: Bytes32;
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  resourceId: string;
  contentType: MediaContentType;
  sizeBytes: AtomicAmount;
  contentSha256: Bytes32;
  objectVersionHash: Bytes32;
  accessScope: 'PUBLIC' | 'AUTHENTICATED';
  method: 'GET';
  readUrl: string;
  expiresAt: string;
  providerReferenceHash: Bytes32;
}

export interface EvidenceEnvelopeProjection {
  artifactVersion: typeof artifactVersion;
  evidenceHash: Bytes32;
  ownerWallet: Address;
  actorRole: 'BUYER' | 'MERCHANT' | 'ADMIN' | 'OPERATOR';
  purpose: 'FULFILLMENT_ACTION' | 'SHIPMENT_TRACKING';
  resourceType: 'ORDER';
  resourceId: string;
  action: string;
  reasonCode: string | null;
  trackingNumberHash: Bytes32 | null;
  mediaAssetIds: readonly Bytes32[];
  payload: JsonObject;
  carrierCode?: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
  createdAt: string;
}

export interface InventoryAdjustmentProjection {
  artifactVersion: typeof artifactVersion;
  adjustmentId: Bytes32;
  skuId: string;
  beforeTotal: AtomicAmount;
  beforeAvailable: AtomicAmount;
  delta: string;
  afterTotal: AtomicAmount;
  afterAvailable: AtomicAmount;
  reasonCode: string;
  actorWallet: Address;
  createdAt: string;
}

export interface MerchantStore {
  storeId: string;
  merchantId: string;
  name: string;
  regionCode: string;
  longitude: number;
  latitude: number;
  address: string;
  phone: string;
  status: StoreStatus;
  version: number;
}

export interface CreateMerchantStoreRequest {
  idempotencyKey: string;
  name: string;
  phone: string;
  longitude: number;
  latitude: number;
}

export interface CreateDeliveryTargetRequest {
  idempotencyKey: string;
  recipientName: string;
  phone: string;
  address: string;
  longitude: number;
  latitude: number;
}

export interface CreatePickupTargetRequest {
  idempotencyKey: string;
  storeId: string;
}

export interface FulfillmentTargetSummary {
  targetId: string;
  targetHash: Bytes32;
  fulfillmentMode: FulfillmentMode;
  regionCode: string;
  regionCodeHash: Bytes32;
  expiresAt: string;
}

export interface DeliveryTarget extends FulfillmentTargetSummary {
  fulfillmentMode: 'DELIVERY';
}

export interface PickupTarget extends FulfillmentTargetSummary {
  fulfillmentMode: 'PICKUP';
  storeId: string;
  store: MerchantStore;
}

export interface DeliveryTargetPayload {
  recipientName: string;
  phone: string;
  address: string;
  longitude: number;
  latitude: number;
  regionCode: string;
}

export type FulfillmentTarget =
  | (DeliveryTarget & { payload: DeliveryTargetPayload })
  | (Omit<PickupTarget, 'store'> & { payload: MerchantStore });

export interface FulfillmentExactAmounts {
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplQuoteAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  nplBurnAmount: AtomicAmount;
  nplRewardAmount: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  bnmAmount: AtomicAmount;
}

export interface FulfillmentRequestProjection {
  requestId: string;
  requestType: FulfillmentRequestType;
  state: FulfillmentRequestState;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface ShipmentProjection {
  shipmentId: string;
  carrierCode: string;
  trackingNumberHash: Bytes32;
  providerReferenceHash: Bytes32 | null;
  createdAt: string;
}

export interface LogisticsProjection {
  logisticsEventId: string;
  provider: LogisticsProvider;
  status: LogisticsStatus;
  locationHash: Bytes32 | null;
  occurredAt: string;
}

export interface FulfillmentBalance {
  asset: FulfillmentAsset;
  state: BalanceState;
  amount: AtomicAmount;
}

export interface FulfillmentOrder {
  orderId: Bytes32;
  artifactVersion: string;
  buyerWallet: Address;
  merchantId: string;
  merchantWallet: Address;
  productId: string;
  skuId: string;
  quantity: AtomicAmount;
  createdAt: Timestamp;
  orderKind: OrderKind;
  paymentTxHash: Bytes32 | null;
  fulfillmentMode: FulfillmentMode;
  state: OrderProjectionState;
  finalityStatus: OrderFinalityStatus;
  exactAmounts: FulfillmentExactAmounts;
  paidAt: string | null;
  paymentFinalizedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  fulfilledAt: string | null;
  takeoverOpenedAt: string | null;
  arbitrationOpenedAt: string | null;
  requests: readonly FulfillmentRequestProjection[];
  shipments: readonly ShipmentProjection[];
  logistics: readonly LogisticsProjection[];
  balances: readonly FulfillmentBalance[];
  allowedActions: readonly AllowedAction[];
}

export interface FulfillmentOrderCursor {
  createdAt: Timestamp;
  orderId: string;
}

export interface FulfillmentOrderPage {
  orders: readonly FulfillmentOrder[];
  nextCursor: FulfillmentOrderCursor | null;
}

export interface AdminOrderSearchPage extends FulfillmentOrderPage {
  pausedScopes: readonly BreakerScope[];
  breaker: Readonly<{ scope: BreakerScope; active: boolean }> | null;
  pendingProductReview: boolean | null;
}

export interface OrderBatchActionPreviewRow {
  orderId: Bytes32;
  allowedActions: readonly AllowedAction[];
}

export interface OrderBatchActionPreview {
  rows: readonly OrderBatchActionPreviewRow[];
  enabledActionIntersection: readonly AllowedActionName[];
}

export interface FulfillmentCommandInput {
  idempotencyKey: string;
  evidenceHash: Bytes32;
}

export interface FulfillmentReasonRequest extends FulfillmentCommandInput {
  reasonCode: string;
}

export interface ShipmentRequest extends FulfillmentCommandInput {
  carrierCode: string;
  trackingNumberHash: Bytes32;
  providerReferenceHash?: Bytes32;
}

export interface ShipmentBatchItemRequest extends ShipmentRequest {
  orderId: Bytes32;
  carrierCode: 'SF' | 'JD' | 'YTO' | 'ZTO' | 'STO' | 'EMS';
}

export interface ShipmentBatchRequest {
  idempotencyKey: string;
  items: readonly ShipmentBatchItemRequest[];
}

export interface PickupCredentialRequest extends FulfillmentCommandInput {
  code: string;
  expiresAt: string;
}

export interface PickupVerificationRequest extends FulfillmentCommandInput {
  code: string;
  storeId: string;
}

export interface FulfillmentRequestDecision extends FulfillmentCommandInput {
  requestId: string;
  approved: boolean;
  noteCode: string;
}

export interface FulfillmentDecision extends FulfillmentCommandInput {
  approved: boolean;
  noteCode: string;
}

export interface ArbitrationDecision extends FulfillmentCommandInput {
  outcome: ArbitrationOutcome;
  noteCode: string;
}

export interface LogisticsWebhookRequest {
  eventId: string;
  orderId: Bytes32;
  status: LogisticsStatus;
  occurredAt: string;
  locationHash?: Bytes32;
}

export interface ShipmentResult {
  orderId: Bytes32;
  state: 'SHIPPED';
  shipmentId: string;
  carrierCode: string;
  trackingNumberHash: Bytes32;
  recordedAt: string;
}

export interface ShipmentBatchResult {
  batchId: Bytes32;
  shipments: readonly ShipmentResult[];
  createdAt: Timestamp;
}

export interface DeliveryResult {
  orderId: Bytes32;
  state: 'DELIVERED';
  deliveredAt: string;
}

export interface LogisticsUpdateResult {
  orderId: Bytes32;
  logisticsEventId: string;
  provider: LogisticsProvider;
  status: LogisticsStatus;
  state: 'SHIPPED' | 'DELIVERED';
  occurredAt: string;
}

export interface PickupCredentialResult {
  orderId: Bytes32;
  credentialId: string;
  expiresAt: string;
}

export interface FulfillmentRequestResult {
  orderId: Bytes32;
  requestId: string;
  requestType: 'EXCHANGE' | 'DELAY';
  state: 'OPEN';
  requestedAt: string;
}

export interface FulfillmentRequestDecisionResult {
  orderId: Bytes32;
  requestId: string;
  requestType: 'EXCHANGE' | 'DELAY';
  state: 'APPROVED' | 'REJECTED';
  decidedAt: string;
}

export interface ArbitrationOpenedResult {
  orderId: Bytes32;
  requestId: string;
  state: 'ARBITRATION';
  openedAt: string;
}

export interface ArbitrationResumedResult {
  orderId: Bytes32;
  state: 'SHIPPED' | 'DELIVERED' | 'TAKEOVER' | 'FULFILLMENT_PENDING';
  outcome: 'RESUME_FULFILLMENT';
  decidedAt: string;
}

export interface TakeoverOpenedResult {
  orderId: Bytes32;
  caseId: string;
  state: 'TAKEOVER';
  customerFundsRemainLocked: true;
}

export interface ForcedReceiptRequestResult {
  orderId: Bytes32;
  requestId: string;
  state: 'OPEN';
  platformReviewRequired: true;
  canFinalizeDirectly: false;
}

export interface ForcedReceiptRejectedResult {
  orderId: Bytes32;
  state: 'DELIVERED';
  approved: false;
  decidedAt: string;
}

export interface FulfillmentCompletedResult {
  orderId: Bytes32;
  state: 'FULFILLED';
  method: FulfillmentMethod;
  fulfilledAt: string;
}

export type ArbitrationDecisionResult = FulfillmentCompletedResult | ArbitrationResumedResult;
export type ForcedReceiptDecisionResult = FulfillmentCompletedResult | ForcedReceiptRejectedResult;
export type FulfillmentCommandResult =
  | ShipmentResult
  | DeliveryResult
  | LogisticsUpdateResult
  | PickupCredentialResult
  | FulfillmentRequestResult
  | FulfillmentRequestDecisionResult
  | ArbitrationOpenedResult
  | ArbitrationResumedResult
  | TakeoverOpenedResult
  | ForcedReceiptRequestResult
  | ForcedReceiptRejectedResult
  | FulfillmentCompletedResult;

export interface InventoryReservation {
  reservationId: Bytes32;
  reservationHash: Bytes32;
  policyVersion: number;
  skuId: Bytes32;
  buyerWallet: Address;
  quantity: number;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
  state: ReservationState;
  expiresAt: string;
}

export interface BeneficiarySnapshot {
  genesis: Address;
  directReferral: Address;
  district: Address;
  city: Address;
  province: Address;
  region: Address;
}

export interface MerchantConcessionAllocation {
  account: Address;
  amount: AtomicAmount;
}

export interface OtherUsdtAllocation extends MerchantConcessionAllocation {
  purpose: UsdtLiabilityPurpose;
}

export type NplRewardRole = 'genesis' | 'directReferral' | 'district' | 'city' | 'province' | 'region' | 'operations' | 'roundingRemainder';

export interface NplRewardAllocation extends MerchantConcessionAllocation {
  role: NplRewardRole;
}

export interface AllocationSnapshot {
  beneficiaries: BeneficiarySnapshot;
  concession: readonly MerchantConcessionAllocation[];
  otherUsdt: readonly OtherUsdtAllocation[];
  nplRewards: readonly NplRewardAllocation[];
}

export interface PaymentRouterIntent {
  orderId: Bytes32;
  policyVersion: number;
  oracleVersion: Bytes32;
  buyer: Address;
  merchant: Address;
  productId: Bytes32;
  skuId: Bytes32;
  quantity: number;
  fulfillmentMode: 0 | 1;
  fulfillmentTargetHash: Bytes32;
  regionCodeHash: Bytes32;
  productPolicyHash: Bytes32;
  reservationId: Bytes32;
  reservationHash: Bytes32;
  reservationDeadline: number;
  issuedAt: number;
  deadline: number;
  nonce: AtomicAmount;
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplQuoteAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  nplBurnAmount: AtomicAmount;
  nplRewardAmount: AtomicAmount;
  merchantBaseReceivableUsdt: AtomicAmount;
  merchantConcessionBps: number;
  merchantConcessionAmount: AtomicAmount;
  merchantNetReceivableUsdt: AtomicAmount;
  concessionAllocationHash: Bytes32;
  bnmAmount: AtomicAmount;
  seckill: boolean;
  sessionId: Bytes32;
  beneficiaries: BeneficiarySnapshot;
}

export interface CanonicalPaymentIntent extends Omit<PaymentRouterIntent, 'fulfillmentMode'> {
  fulfillmentMode: FulfillmentMode;
  merchantConcessionAllocations: readonly MerchantConcessionAllocation[];
  otherUsdtAllocations: readonly OtherUsdtAllocation[];
  nplRewardAllocations: readonly NplRewardAllocation[];
  requiredConfirmations: 15;
}

export interface ApprovalRequirement {
  token: Address;
  spender: Address;
  requiredAmount: AtomicAmount;
  requestedAllowance: AtomicAmount;
  approvalMode: 'ONLY_IF_ALLOWANCE_BELOW_REQUIRED';
  risk: 'UNLIMITED_TOKEN_ALLOWANCE';
  revocation: Readonly<{ method: 'ERC20_APPROVE_ZERO'; token: Address; spender: Address }>;
}

export interface Eip712Domain {
  name: 'Abu24KPaymentRouter';
  version: '2';
  chainId: 56;
  verifyingContract: Address;
}

export interface PaymentBuyerAuthorization {
  domain: Eip712Domain;
  types: Readonly<{ PaymentAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
  primaryType: 'PaymentAuthorization';
  message: Readonly<{
    paymentHash: Bytes32;
    orderId: Bytes32;
    buyer: Address;
    merchant: Address;
    productId: Bytes32;
    skuId: Bytes32;
    quantity: number;
    fulfillmentMode: 0 | 1;
    listPriceUsdt: AtomicAmount;
    usdtPaymentAmount: AtomicAmount;
    nplPaymentAmount: AtomicAmount;
    deadline: number;
  }>;
  digest: Bytes32;
}

export interface SeckillBuyerAuthorization {
  domain: Eip712Domain;
  types: Readonly<{ SeckillAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
  primaryType: 'SeckillAuthorization';
  message: Readonly<{
    seckillHash: Bytes32;
    orderId: Bytes32;
    buyer: Address;
    merchant: Address;
    productId: Bytes32;
    skuId: Bytes32;
    quantity: number;
    fulfillmentMode: 0 | 1;
    seckillListPriceUsdt: AtomicAmount;
    seckillUsdtPaymentAmount: AtomicAmount;
    seckillNplPaymentAmount: AtomicAmount;
    fallbackListPriceUsdt: AtomicAmount;
    fallbackUsdtPaymentAmount: AtomicAmount;
    fallbackNplPaymentAmount: AtomicAmount;
    deadline: number;
  }>;
  digest: Bytes32;
}

export interface OrdinaryRouterCall {
  functionName: 'pay';
  intent: PaymentRouterIntent;
  quoteSignature: string;
}

export interface SeckillRouterCall {
  functionName: 'paySeckill';
  intent: Readonly<{
    sessionId: Bytes32;
    seckillPayment: PaymentRouterIntent;
    fallbackPayment: PaymentRouterIntent;
  }>;
  quoteSignature: string;
}

export type PaymentQuoteState = 'QUOTED' | 'SUBMITTED' | 'PAID' | 'REORGED' | 'EXPIRED';

export interface PaymentQuoteResponse {
  artifactVersion: typeof artifactVersion;
  orderId: Bytes32;
  state: PaymentQuoteState;
  paymentRouterAddress: Address;
  intent: CanonicalPaymentIntent;
  snapshotHash: Bytes32;
  authorizationDigest: Bytes32;
  buyerAuthorization: PaymentBuyerAuthorization;
  quoteSignature: string;
  submittedTxHash: Bytes32 | null;
  approvalRequirements: readonly ApprovalRequirement[];
  routerCall: OrdinaryRouterCall;
}

export interface CanonicalSeckillIntent {
  sessionId: Bytes32;
  seckill: CanonicalPaymentIntent;
  fallback: CanonicalPaymentIntent;
  classificationAuthority: 'PAYMENT_ROUTER_BLOCK_TIMESTAMP';
}

export interface SeckillQuoteResponse {
  artifactVersion: typeof artifactVersion;
  orderId: Bytes32;
  state: PaymentQuoteState;
  paymentRouterAddress: Address;
  dual: CanonicalSeckillIntent;
  seckillHash: Bytes32;
  snapshotHashes: Readonly<{ seckill: Bytes32; fallback: Bytes32 }>;
  authorizationDigest: Bytes32;
  buyerAuthorization: SeckillBuyerAuthorization;
  quoteSignature: string;
  submittedTxHash: Bytes32 | null;
  approvalRequirements: readonly ApprovalRequirement[];
  routerCall: SeckillRouterCall;
}

export interface PaymentSubmissionRequest {
  orderId: Bytes32;
  txHash: Bytes32;
  replacementForTxHash?: Bytes32;
}

export interface PaymentSubmissionResponse {
  orderId: Bytes32;
  txHash: Bytes32;
  state: 'SUBMITTED';
}

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: AllowedActionReasonCode;
  deadline?: string;
}

export interface BuyerProfile {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  accountId: null;
  accountIdStatus: 'DecisionBlocked';
  nickname: string | null;
  avatarAssetId: Bytes32 | null;
  version: number;
  updatedAt: Timestamp | null;
}

export interface BuyerSavedAddress {
  addressId: string;
  label: string;
  recipientName: string;
  phone: string;
  detailAddress: string;
  longitude: number;
  latitude: number;
  province: string;
  city: string;
  district: string;
  formattedAddress: string;
  regionCode: string;
  isDefault: boolean;
  version: number;
  updatedAt: Timestamp;
}

export interface BuyerOverviewCount {
  status: 'AVAILABLE';
  count: AtomicAmount;
}

export interface BuyerOverview {
  artifactVersion: typeof artifactVersion;
  wallet: Address;
  orderCounts: Readonly<{
    pendingPayment: Readonly<{
      status: 'DecisionBlocked';
      count: null;
      blocker: 'BUYER_PENDING_PAYMENT_PROJECTION';
    }>;
    pendingShipment: BuyerOverviewCount;
    pendingReceipt: BuyerOverviewCount;
    afterSale: BuyerOverviewCount;
    total: BuyerOverviewCount;
  }>;
}

export interface BuyerTakeoverTransition {
  transitionId: string;
  fromState: TakeoverState | null;
  toState: TakeoverState;
  evidenceType: string;
  occurredAt: Timestamp;
}

export interface BuyerTakeoverTimeline {
  artifactVersion: typeof artifactVersion;
  orderId: string;
  historyStatus: 'COMPLETE' | 'PARTIAL_LEGACY';
  transitions: readonly BuyerTakeoverTransition[];
}

export interface MerchantProfile {
  artifactVersion: typeof artifactVersion;
  merchantId: string;
  shopName: string | null;
  logoAssetId: Bytes32 | null;
  settlementWallet: Address;
  settlementWalletMutable: false;
  version: number;
  updatedAt: Timestamp;
}

export interface MerchantAuditEntry {
  entryId: string;
  operationTime: Timestamp;
  operationType: string;
  module: string;
  detail: string;
  signatureHash: Bytes32 | null;
  safeOrChainTxHash: Bytes32 | null;
  entryHash: string;
}

export interface MerchantAuditList {
  entries: readonly MerchantAuditEntry[];
  proofScope: 'MERCHANT_SCOPED_ENTRY_HASHES';
  historyStatus: 'PARTIAL_PRE_MERCHANT_SCOPE';
  chainProof: Readonly<{ merchantId: string; entries: number }>;
  nextCursor: Readonly<{ createdAt: Timestamp; entryId: string }> | null;
}

export interface MerchantAuditExport {
  contentType: 'text/csv; charset=utf-8';
  filename: string;
  entryCount: number;
  csv: string;
}

export interface PaymentFinality {
  transactionHash: Bytes32;
  replacementForTxHash: Bytes32 | null;
  blockNumber: number;
  blockHash: Bytes32;
  confirmations: number;
  requiredConfirmations: 15;
  receiptStatus: 1;
  state: 'MINED' | 'REORGED' | 'FINAL';
  canonicalBlock: boolean;
  classification: 'ORDINARY' | 'SECKILL' | 'FALLBACK_RETAIL';
}

export type PaymentProjection = (PaymentQuoteResponse | SeckillQuoteResponse) & { finality: PaymentFinality | null };
`;
}

function objectSchema(required, properties) {
  return { type: 'object', additionalProperties: false, required, properties };
}

function response(description, schema) {
  return {
    description,
    headers: { 'x-correlation-id': { schema: { type: 'string' } } },
    content: { 'application/json': { schema } },
  };
}

function body(schema) {
  return { required: true, content: { 'application/json': { schema } } };
}

function assertVersion(path, content) {
  const document = JSON.parse(content);
  const version = document.artifactVersion ?? document['x-artifactVersion'] ?? document.info?.version ?? document.version;
  if (version !== artifactVersion) throw new Error(`${path}: expected artifact version ${artifactVersion}`);
}

function readRequired(path) {
  if (!existsSync(path)) throw new Error(`Missing artifact ${relative(repoRoot, path)}`);
  return readFileSync(path, 'utf8');
}

function walkFiles(root) {
  if (!existsSync(root)) throw new Error('Missing contract artifacts; run contracts:artifacts first');
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? walkFiles(path) : [path];
    })
    .sort();
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

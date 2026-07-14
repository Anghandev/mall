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
  balanceStates,
  breakerScopes,
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
  orderFinalityStatuses,
  orderProjectionStates,
  policyPublicationStates,
  providerReadinessStates,
  reservationStates,
  seckillStates,
  settlementRails,
  storeStatuses,
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

const enums = {
  artifactVersion,
  orderProjectionStates,
  contractOrderStates,
  orderFinalityStatuses,
  finalityStates,
  userRoles,
  breakerScopes,
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
  fulfillmentAssets,
  arbitrationOutcomes,
  settlementRails,
  reservationStates,
  balanceStates,
  takeoverStates,
  seckillStates,
  coreErrorCodes,
  policyPublicationStates,
  adapterProviders,
  infrastructureProviders,
  providerReadinessStates,
};

const openapi = buildOpenApi();
const websocket = {
  artifactVersion,
  protocolVersion: 1,
  transport: 'wss',
  publicationStatus: 'FAIL_CLOSED',
  endpoint: null,
  channels: [],
  reasonCode: 'ConfigurationRequired',
  reason: 'No Core WebSocket endpoint is implemented in this checkpoint',
  clientRule: 'Products must not connect or infer live state while endpoint is null',
  envelope: {
    required: ['artifactVersion', 'protocolVersion', 'eventId', 'channel', 'cursor', 'resourceType', 'resourceId', 'occurredAt', 'payload'],
    properties: {
      artifactVersion: { const: artifactVersion },
      protocolVersion: { const: 1 },
      eventId: { type: 'string', minLength: 1 },
      channel: { type: 'string', minLength: 1 },
      cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      resourceType: { type: 'string', minLength: 1 },
      resourceId: { type: 'string', minLength: 1 },
      occurredAt: { type: 'string', format: 'date-time' },
      finality: { enum: [...finalityStates] },
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
  ['state-error-enums.json', json(enums)],
  ['websocket-protocol.json', json(websocket)],
]);

const componentPaths = {
  packageMetadata: 'package.json',
  openapi: 'openapi/openapi.json',
  generatedRuntime: 'generated/index.js',
  generatedTypes: 'generated/index.d.ts',
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
  publicationStatus: 'COORDINATED_FULFILLMENT_CHECKPOINT',
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
  httpSurface: [
    'GET /v2/bootstrap',
    'POST /v2/auth/nonce',
    'POST /v2/auth/verify',
    'POST /v2/actions/order',
    'GET /v2/stores',
    'POST /v2/stores',
    'POST /v2/fulfillment-targets/delivery',
    'POST /v2/fulfillment-targets/pickup',
    'GET /v2/orders',
    'GET /v2/orders/{orderId}',
    'GET /v2/orders/{orderId}/fulfillment-target',
    'POST /v2/orders/{orderId}/shipments',
    'POST /v2/orders/{orderId}/delivery',
    'POST /v2/orders/{orderId}/pickup-credential',
    'POST /v2/orders/{orderId}/pickup-verification',
    'POST /v2/orders/{orderId}/exchange-requests',
    'POST /v2/orders/{orderId}/delay-requests',
    'POST /v2/orders/{orderId}/request-decisions',
    'POST /v2/orders/{orderId}/arbitrations',
    'POST /v2/orders/{orderId}/arbitration-decisions',
    'POST /v2/orders/{orderId}/takeover',
    'POST /v2/orders/{orderId}/forced-receipt-requests',
    'POST /v2/orders/{orderId}/forced-receipt-decisions',
    'POST /v2/orders/{orderId}/receipt-confirmation',
    'POST /v2/providers/kuaidi100/webhooks/logistics',
    'POST /v2/providers/cainiao/webhooks/logistics',
    'GET /v2/catalog/products',
    'GET /v2/catalog/products/{productId}',
    'POST /v2/payments/quotes',
    'POST /v2/seckill/quotes',
    'POST /v2/payments/submissions',
    'GET /v2/payments/{orderId}',
  ],
  capabilityStatus: {
    bootstrap: 'AVAILABLE',
    siweAuthentication: 'AVAILABLE',
    orderAllowedActions: 'AVAILABLE',
    catalogHttp: 'AVAILABLE',
    paymentQuoteHttp: 'AVAILABLE',
    inventoryReservation: 'AVAILABLE',
    paymentSubmissionHttp: 'AVAILABLE',
    paymentProjectionHttp: 'AVAILABLE',
    paymentIndexer: 'AVAILABLE',
    settlementHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    storesHttp: 'AVAILABLE',
    fulfillmentTargetHttp: 'AVAILABLE',
    fulfillmentHttp: 'AVAILABLE',
    logisticsWebhookHttp: 'AVAILABLE',
    takeoverHttp: 'AVAILABLE',
    fulfillmentScheduler: 'AVAILABLE',
    bnmAvailabilityWorker: 'AVAILABLE',
    seckillQuoteHttp: 'AVAILABLE',
    websocket: 'NOT_PUBLISHED_FAIL_CLOSED',
  },
  executableOrderActionNames,
  decisionBlocked: [
    'PLATFORM_SERVICE_FEE_BPS',
    'SECKILL_PRIZE_POOL_BPS',
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
    'FulfillmentCommandInput',
    'FulfillmentCommandResult',
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

for (const path of ['openapi', 'generated']) rmSync(join(outputRoot, path), { recursive: true, force: true });
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
          responses: {
            200: response('Wallet-scoped fulfillment orders', {
              type: 'object',
              additionalProperties: false,
              required: ['orders'],
              properties: {
                orders: { type: 'array', items: { $ref: '#/components/schemas/FulfillmentOrder' } },
              },
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
        'skuId', 'fulfillmentMode', 'state', 'finalityStatus', 'exactAmounts', 'paidAt',
        'paymentFinalizedAt', 'shippedAt', 'deliveredAt', 'fulfilledAt', 'takeoverOpenedAt',
        'arbitrationOpenedAt', 'requests', 'shipments', 'logistics', 'balances',
      ],
      properties: {
        orderId: { $ref: '#/components/schemas/Bytes32' },
        artifactVersion: { type: 'string', minLength: 1 },
        buyerWallet: { $ref: '#/components/schemas/Address' },
        merchantId: { type: 'string', minLength: 1 },
        merchantWallet: { $ref: '#/components/schemas/Address' },
        productId: { type: 'string', minLength: 1 },
        skuId: { type: 'string', minLength: 1 },
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
    CatalogSku: {
      type: 'object', additionalProperties: false,
      required: ['skuId', 'chainSkuId', 'attributes', 'listPriceUsdt', 'stockAvailable'],
      properties: {
        skuId: { type: 'string', minLength: 1 },
        chainSkuId: { $ref: '#/components/schemas/Bytes32' },
        attributes: { type: 'object' },
        listPriceUsdt: { $ref: '#/components/schemas/AtomicAmount' },
        stockAvailable: { $ref: '#/components/schemas/AtomicAmount' },
      },
    },
    CatalogProduct: {
      type: 'object', additionalProperties: false,
      required: ['productId', 'chainProductId', 'title', 'metadata', 'skus'],
      properties: {
        productId: { type: 'string', minLength: 1 },
        chainProductId: { $ref: '#/components/schemas/Bytes32' },
        title: { type: 'string', minLength: 1 },
        metadata: { type: 'object' },
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
export type OrderProjectionState = ${union(orderProjectionStates)};
export type ContractOrderState = ${union(contractOrderStates)};
export type OrderFinalityStatus = ${union(orderFinalityStatuses)};
export type TransactionFinalityState = ${union(finalityStates)};
export type UserRole = ${union(userRoles)};
export type BreakerScope = ${union(breakerScopes)};
export type AllowedActionName = ${union(allowedActionNames)};
export type AllowedActionReasonCode = ${union(allowedActionReasonCodes)};
export type CoreErrorCode = ${union(coreErrorCodes)};
export type FulfillmentMode = ${union(fulfillmentModes)};
export type FulfillmentMethod = ${union(fulfillmentMethods)};
export type StoreStatus = ${union(storeStatuses)};
export type FulfillmentRequestType = ${union(fulfillmentRequestTypes)};
export type FulfillmentRequestState = ${union(fulfillmentRequestStates)};
export type LogisticsProvider = ${union(logisticsProviders)};
export type LogisticsStatus = ${union(logisticsStatuses)};
export type FulfillmentAsset = ${union(fulfillmentAssets)};
export type ArbitrationOutcome = ${union(arbitrationOutcomes)};
export type SettlementRail = ${union(settlementRails)};
export type ReservationState = ${union(reservationStates)};
export type BalanceState = ${union(balanceStates)};
export type UsdtLiabilityPurpose = 'POLICY_ALLOCATION' | 'SECKILL_PRIZE_LIABILITY';
export type TakeoverState = ${union(takeoverStates)};
export type SeckillState = ${union(seckillStates)};
export type PolicyPublicationState = ${union(policyPublicationStates)};
export type AdapterProvider = ${union(adapterProviders)};
export type InfrastructureProvider = ${union(infrastructureProviders)};
export type ProviderReadinessState = ${union(providerReadinessStates)};
export declare const orderProjectionStates: readonly OrderProjectionState[];
export declare const contractOrderStates: readonly ContractOrderState[];
export declare const orderFinalityStatuses: readonly OrderFinalityStatus[];
export declare const finalityStates: readonly TransactionFinalityState[];
export declare const userRoles: readonly UserRole[];
export declare const breakerScopes: readonly BreakerScope[];
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
export declare const fulfillmentAssets: readonly FulfillmentAsset[];
export declare const arbitrationOutcomes: readonly ArbitrationOutcome[];
export declare const settlementRails: readonly SettlementRail[];
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];

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

export interface CatalogSku {
  skuId: string;
  chainSkuId: Bytes32;
  attributes: Readonly<Record<string, unknown>>;
  listPriceUsdt: AtomicAmount;
  stockAvailable: AtomicAmount;
}

export interface CatalogProduct {
  productId: string;
  chainProductId: Bytes32;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
  skus: readonly CatalogSku[];
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

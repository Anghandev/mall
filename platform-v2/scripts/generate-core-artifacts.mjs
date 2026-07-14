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
  balanceStates,
  breakerScopes,
  settlementRails,
  finalityStates,
  executableOrderActionNames,
  fulfillmentMethods,
  fulfillmentModes,
  contractOrderStates,
  infrastructureProviders,
  orderFinalityStatuses,
  orderProjectionStates,
  policyPublicationStates,
  providerReadinessStates,
  reservationStates,
  seckillStates,
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
  publicationStatus: 'COORDINATED_PAYMENT_CHECKPOINT',
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
    takeoverHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    fulfillmentHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    seckillQuoteHttp: 'AVAILABLE',
    websocket: 'NOT_PUBLISHED_FAIL_CLOSED',
  },
  executableOrderActionNames,
  decisionBlocked: [
    'PLATFORM_SERVICE_FEE_BPS',
    'SECKILL_PRIZE_POOL_BPS',
    'MERCHANT_CONCESSION_DESTINATION_WEIGHTS',
    'FIXED_REMAINDER_ACCOUNTS',
    'GENESIS_CREDENTIAL_CONTRACT_AND_TOKEN_ID',
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
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
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
        purpose: { type: 'string', minLength: 1 },
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
export type SettlementRail = ${union(settlementRails)};
export type ReservationState = ${union(reservationStates)};
export type BalanceState = ${union(balanceStates)};
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
  purpose: string;
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

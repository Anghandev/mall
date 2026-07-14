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
  claimRails,
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
  claimRails,
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

const coordinatedManifest = {
  artifactVersion,
  publicationStatus: 'COORDINATED_RC',
  deploymentAuthorized: false,
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
  ],
  capabilityStatus: {
    bootstrap: 'AVAILABLE',
    siweAuthentication: 'AVAILABLE',
    orderAllowedActions: 'AVAILABLE',
    paymentQuoteHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    reservationHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    settlementHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    takeoverHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    fulfillmentHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    claimHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    seckillHttp: 'NOT_PUBLISHED_FAIL_CLOSED',
    websocket: 'NOT_PUBLISHED_FAIL_CLOSED',
  },
  executableOrderActionNames,
  decisionBlocked: [
    'PLATFORM_SERVICE_FEE_BPS',
    'SECKILL_PRIZE_POOL_BPS',
    'MERCHANT_STORE_NPL_REWARD_BPS',
    'MERCHANT_GUARANTEE_MINIMUM_USDT',
    'PLATFORM_RISK_RESERVE_MINIMUM_USDT',
    'GUARANTEE_TOP_UP_LINE_USDT',
    'FIXED_REMAINDER_ACCOUNTS',
    'ORACLE_MAX_AGE_SECONDS',
    'ORACLE_MINIMUM_LIQUIDITY',
    'GENESIS_CREDENTIAL_CONTRACT_AND_TOKEN_ID',
    'PICKUP_TIMEOUT_AND_TAKEOVER_EVIDENCE',
    'EMPTY_SESSION_INJECTED_PRIZE_ALLOCATION',
    'REQUIRED_CONFIRMATIONS',
  ],
  externalBlocked: [
    'SAFE_AND_ROLE_ADDRESSES',
    'SECONDARY_QUOTE_AND_FINALITY_SIGNERS',
    'TWAP_SOURCE',
    'BSC_RPC_URL',
    'DEPLOYED_CONTRACT_ADDRESSES',
    'REMOTE_SIGNER_AND_EXECUTOR',
    'DATABASE_AUDIT_DATABASE_AND_REDIS',
    'PROVIDER_ACCOUNTS_AND_CREDENTIALS',
    'PHYSICAL_PRINTER_AND_MOBILE_DEVICE_EVIDENCE',
    'PRODUCTION_DOMAINS_AND_HTTPS',
    'APPROVED_MERCHANT_AND_ADMIN_WALLETS',
  ],
  requiredConsumerContracts: [
    'ProductPolicy',
    'SignedOrderIntent',
    'SeckillQuote',
    'FallbackRetailQuote',
    'InventoryReservation',
    'AllocationSnapshot',
    'FulfillmentEvidence',
    'FulfillmentFinality',
    'MerchantTakeoverCase',
    'AllowedAction',
    'TransactionFinality',
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
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        AtomicAmount: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
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
          required: ['chainId', 'assets', 'decisionBlocked', 'externalBlocked', 'providers', 'writesEnabled'],
          properties: {
            chainId: { const: BSC_CHAIN_ID },
            assets: {
              type: 'object',
              required: ['usdt', 'npl'],
              properties: { usdt: { const: USDT_ADDRESS }, npl: { const: NPL_ADDRESS } },
            },
            decisionBlocked: { type: 'array', items: { type: 'string' } },
            externalBlocked: { type: 'array', items: { type: 'string' } },
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
export type ClaimRail = ${union(claimRails)};
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
export declare const claimRails: readonly ClaimRail[];
export declare const reservationStates: readonly ReservationState[];
export declare const balanceStates: readonly BalanceState[];
export declare const takeoverStates: readonly TakeoverState[];
export declare const seckillStates: readonly SeckillState[];
export declare const policyPublicationStates: readonly PolicyPublicationState[];
export declare const adapterProviders: readonly AdapterProvider[];
export declare const infrastructureProviders: readonly InfrastructureProvider[];
export declare const providerReadinessStates: readonly ProviderReadinessState[];

export interface ProductPolicy {
  artifactVersion: typeof artifactVersion;
  policyVersion: number;
  policyHash: Bytes32;
  oracleVersion: Bytes32;
  publicationStatus: 'PUBLISHED';
  usdtPaymentBps: number;
  nplPaymentBps: number;
  burnBps: number;
  routeBps: number;
  genesisBps: number;
  directReferralBps: number;
  districtBps: number;
  cityBps: number;
  provinceBps: number;
  regionBps: number;
  operationsBps: number;
  operationsBeneficiaries: readonly Address[];
  operationsWeights: readonly number[];
  merchantStoreBps: number;
  platformFeeBps: number;
  seckillPrizeBps: number;
  seckillMainDurationSeconds: 3600;
  relayInitialSeconds: 60;
  relayIncrementSeconds: 30;
  relayCapSeconds: 60;
  oracleMaxAgeSeconds: number;
  oracleMinimumLiquidity: AtomicAmount;
  merchantGuaranteeMinimumUsdt: AtomicAmount;
  platformRiskReserveMinimumUsdt: AtomicAmount;
  guaranteeTopupLineUsdt: AtomicAmount;
  platformTreasury: Address;
  circulationPool: Address;
  usdtRemainderAccount: Address;
  genesisCredential: Address;
  genesisTokenId: AtomicAmount;
  genesisCredentialStandard: 'NONE' | 'ERC721' | 'ERC1155';
  beneficiarySetHash: Bytes32;
  decisionEvidenceHash: Bytes32;
  rulesContentHash: Bytes32;
}

export interface AllocationSnapshot {
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  merchantUsdtAmount: AtomicAmount;
  platformUsdtAmount: AtomicAmount;
  prizeUsdtAmount: AtomicAmount;
  usdtRemainderAmount: AtomicAmount;
  burnedNplAmount: AtomicAmount;
  routedNplAmount: AtomicAmount;
  bnmAmount: AtomicAmount;
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
  merchantStore: Address;
}

export interface ContractOrderIntent {
  orderId: Bytes32;
  policyVersion: number;
  oracleVersion: Bytes32;
  buyer: Address;
  merchant: Address;
  productId: Bytes32;
  skuId: Bytes32;
  quantity: number;
  fulfillmentMode: FulfillmentMode;
  fulfillmentTargetHash: Bytes32;
  regionCodeHash: Bytes32;
  productPolicyHash: Bytes32;
  reservationId: Bytes32;
  reservationHash: Bytes32;
  reservationDeadline: number;
  nonce: string;
  deadline: number;
  listPriceUsdt: AtomicAmount;
  usdtPaymentAmount: AtomicAmount;
  nplPaymentAmount: AtomicAmount;
  rewardBaseNpl: AtomicAmount;
  merchantUsdtAmount: AtomicAmount;
  platformUsdtAmount: AtomicAmount;
  prizeUsdtAmount: AtomicAmount;
  usdtRemainderAmount: AtomicAmount;
  bnmAmount: AtomicAmount;
  seckill: boolean;
  sessionId: Bytes32 | '';
  beneficiaries: BeneficiarySnapshot;
}

export interface SignedOrderIntent {
  artifactVersion: typeof artifactVersion;
  intent: ContractOrderIntent;
  allocation: AllocationSnapshot;
  reservation: InventoryReservation;
  quoteSignature: string;
  buyerSignature: string;
}

export interface FallbackRetailQuote extends SignedOrderIntent {
  classification: 'FALLBACK_RETAIL';
  intent: ContractOrderIntent & { seckill: false; sessionId: '' };
  reservation: InventoryReservation & { classification: 'FALLBACK_RETAIL' };
}

export interface SeckillQuote {
  artifactVersion: typeof artifactVersion;
  policyVersion: number;
  sessionId: Bytes32;
  seckillOrder: ContractOrderIntent & { seckill: true };
  fallbackOrder: ContractOrderIntent & { seckill: false; sessionId: '' };
  seckillAllocation: AllocationSnapshot;
  fallbackAllocation: AllocationSnapshot;
  seckillReservation: InventoryReservation & { classification: 'SECKILL' };
  fallbackReservation: InventoryReservation & { classification: 'FALLBACK_RETAIL' };
  deadline: number;
  quoteSignature: string;
  buyerAcknowledgementSignature: string;
  classificationAuthority: 'CHAIN_TIMESTAMP';
}

export interface AllowedAction {
  action: AllowedActionName;
  enabled: boolean;
  reasonCode?: AllowedActionReasonCode;
  deadline?: string;
}

export interface TransactionFinality {
  artifactVersion: typeof artifactVersion;
  resourceType: string;
  resourceId: string;
  chainId: 56;
  contractAddress: Address;
  expectedEventHash: Bytes32;
  txHash: Bytes32;
  replacementForTxHash?: Bytes32;
  blockNumber?: number;
  blockHash?: Bytes32;
  confirmations: number;
  requiredConfirmations: number;
  receiptStatus?: 0 | 1;
  eventResourceId?: string;
  observedEventHash?: Bytes32;
  canonicalBlock: boolean;
  state: TransactionFinalityState;
}

export interface FulfillmentEvidence {
  orderId: Bytes32;
  method: FulfillmentMethod;
  evidenceHash: Bytes32;
  sourceChainId: 56;
  sourceContract: Address;
  sourceEventHash: Bytes32;
  sourceTxHash: Bytes32;
  blockHash: Bytes32;
  confirmations: number;
  receiptStatus: 1;
}

export interface FulfillmentFinality extends TransactionFinality {
  resourceType: 'FULFILLMENT';
  evidence: FulfillmentEvidence;
}

export interface MerchantTakeoverCase {
  caseId: string;
  orderId: Bytes32;
  policyVersion: number;
  fulfillmentMode: FulfillmentMode;
  state: TakeoverState;
  eligibleAt?: string;
  guaranteeReservedUsdt: AtomicAmount;
  merchantAvailableReservedUsdt: AtomicAmount;
  riskReserveReservedUsdt: AtomicAmount;
  actualRiskReserveDisbursedUsdt: AtomicAmount;
  merchantDebtUsdt: AtomicAmount;
  allowedActions: readonly AllowedAction[];
  blockedReason?: 'PickupTakeoverDecisionBlocked';
}

export interface ClaimProjection {
  rail: ClaimRail;
  asset: Address;
  balanceState: BalanceState;
  amount: AtomicAmount;
  allowedAction: AllowedAction;
  finality?: TransactionFinality;
}
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

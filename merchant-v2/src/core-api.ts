import {
  allowedActionNames,
  allowedActionReasonCodes,
  artifactVersion,
  coreErrorCodes,
  userRoles,
  type AllowedAction,
  type AllowedActionName,
  type AllowedActionReasonCode,
  type CatalogProduct,
  type CatalogSku,
  type CoreErrorCode,
  type UserRole,
} from '@abu24k/core-artifacts';

const allowedActionSet = new Set<string>(allowedActionNames);
const allowedActionReasonSet = new Set<string>(allowedActionReasonCodes);
const coreErrorCodeSet = new Set<string>(coreErrorCodes);
const userRoleSet = new Set<string>(userRoles);

export interface CoreReadiness {
  chainId: 56;
  decisionBlocked: readonly string[];
  externalBlocked: readonly string[];
  paymentDecisionBlocked: readonly string[];
  paymentExternalBlocked: readonly string[];
  providers: Readonly<Record<string, 'READY' | 'CONFIGURATION_REQUIRED'>>;
  writesEnabled: boolean;
}

export interface CoreBootstrap {
  artifactVersion: typeof artifactVersion;
  status: 'CORE_API_READY';
  readiness: CoreReadiness;
}

export interface SiweChallenge {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MerchantSession {
  token: string;
  walletAddress: string;
  roles: readonly UserRole[];
}

export interface CoreApi {
  bootstrap(): Promise<CoreBootstrap>;
  createSiweChallenge(walletAddress: string): Promise<SiweChallenge>;
  verifySiwe(message: string, signature: string): Promise<MerchantSession>;
  listCatalog(): Promise<readonly CatalogProduct[]>;
  getOrderAllowedActions(orderId: string, token: string): Promise<readonly AllowedAction[]>;
}

export class CoreApiError extends Error {
  readonly code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable';
  readonly correlationId: string | undefined;

  constructor(
    code: CoreErrorCode | 'InvalidResponse' | 'NetworkUnavailable',
    message: string,
    correlationId?: string,
  ) {
    super(message);
    this.name = 'CoreApiError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

export function createCoreApi(baseUrl = import.meta.env.VITE_CORE_API_BASE_URL ?? ''): CoreApi {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');

  return {
    async bootstrap() {
      const body = await request(normalizedBaseUrl, '/v2/bootstrap');
      const value = record(body, 'bootstrap response');
      exact(value.artifactVersion, artifactVersion, 'artifactVersion');
      exact(value.status, 'CORE_API_READY', 'status');
      return {
        artifactVersion,
        status: 'CORE_API_READY',
        readiness: parseReadiness(value.readiness),
      };
    },

    async createSiweChallenge(walletAddress) {
      const body = await request(normalizedBaseUrl, '/v2/auth/nonce', {
        method: 'POST',
        body: JSON.stringify({ walletAddress }),
      });
      const value = record(body, 'SIWE challenge');
      return {
        message: string(value.message, 'message'),
        nonce: string(value.nonce, 'nonce'),
        issuedAt: dateTime(value.issuedAt, 'issuedAt'),
        expiresAt: dateTime(value.expiresAt, 'expiresAt'),
      };
    },

    async verifySiwe(message, signature) {
      const body = await request(normalizedBaseUrl, '/v2/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ message, signature }),
      });
      const value = record(body, 'SIWE session');
      const roles = array(value.roles, 'roles').map((role) => {
        const parsed = string(role, 'role');
        if (!userRoleSet.has(parsed)) invalid('Unknown session role');
        return parsed as UserRole;
      });
      return {
        token: string(value.token, 'token'),
        walletAddress: address(value.walletAddress, 'walletAddress'),
        roles,
      };
    },

    async listCatalog() {
      const body = await request(normalizedBaseUrl, '/v2/catalog/products');
      const value = record(body, 'catalog response');
      return array(value.products, 'products').map(parseCatalogProduct);
    },

    async getOrderAllowedActions(orderId, token) {
      const body = await request(normalizedBaseUrl, '/v2/actions/order', {
        method: 'POST',
        body: JSON.stringify({ orderId }),
        token,
      });
      const value = record(body, 'allowed-actions response');
      return array(value.allowedActions, 'allowedActions').map(parseAllowedAction);
    },
  };
}

async function request(baseUrl: string, path: string, options: { method?: string; body?: string; token?: string } = {}) {
  let response: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        'x-abu-artifact-version': artifactVersion,
      },
      ...(options.body ? { body: options.body } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new CoreApiError(
      'NetworkUnavailable',
      controller.signal.aborted
        ? 'Core API 请求超时，请检查网络后重试。'
        : '无法连接 Core API，请检查网络或服务配置。',
    );
  } finally {
    window.clearTimeout(timeout);
  }

  const correlationId = response.headers.get('x-correlation-id') ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CoreApiError('InvalidResponse', 'Core 返回了无法识别的响应。', correlationId);
  }
  if (response.ok) return body;

  const value = recordOrUndefined(body);
  const error = recordOrUndefined(value?.error);
  const rawCode = typeof error?.code === 'string' ? error.code : 'UnknownState';
  const code = coreErrorCodeSet.has(rawCode) ? rawCode as CoreErrorCode : 'UnknownState';
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Core 请求失败。';
  throw new CoreApiError(code, message, correlationId);
}

function parseReadiness(input: unknown): CoreReadiness {
  const value = record(input, 'readiness');
  exact(value.chainId, 56, 'chainId');
  const assets = record(value.assets, 'assets');
  exact(
    string(assets.usdt, 'assets.usdt').toLowerCase(),
    '0x55d398326f99059ff775485246999027b3197955',
    'assets.usdt',
  );
  exact(
    string(assets.npl, 'assets.npl').toLowerCase(),
    '0x4e8277ab31e4956b2cd48449793a57656dfc03d2',
    'assets.npl',
  );
  const providers = record(value.providers, 'providers');
  const parsedProviders: Record<string, 'READY' | 'CONFIGURATION_REQUIRED'> = {};
  for (const [name, state] of Object.entries(providers)) {
    if (state !== 'READY' && state !== 'CONFIGURATION_REQUIRED') invalid(`Invalid provider state: ${name}`);
    parsedProviders[name] = state;
  }
  return {
    chainId: 56,
    decisionBlocked: stringArray(value.decisionBlocked, 'decisionBlocked'),
    externalBlocked: stringArray(value.externalBlocked, 'externalBlocked'),
    paymentDecisionBlocked: stringArray(value.paymentDecisionBlocked, 'paymentDecisionBlocked'),
    paymentExternalBlocked: stringArray(value.paymentExternalBlocked, 'paymentExternalBlocked'),
    providers: parsedProviders,
    writesEnabled: boolean(value.writesEnabled, 'writesEnabled'),
  };
}

function parseCatalogProduct(input: unknown): CatalogProduct {
  const value = record(input, 'catalog product');
  const metadata = record(value.metadata, 'product.metadata');
  return {
    productId: string(value.productId, 'productId'),
    chainProductId: bytes32(value.chainProductId, 'chainProductId'),
    title: string(value.title, 'title'),
    metadata,
    skus: array(value.skus, 'skus').map(parseCatalogSku),
  };
}

function parseCatalogSku(input: unknown): CatalogSku {
  const value = record(input, 'catalog SKU');
  return {
    skuId: string(value.skuId, 'skuId'),
    chainSkuId: bytes32(value.chainSkuId, 'chainSkuId'),
    attributes: record(value.attributes, 'sku.attributes'),
    listPriceUsdt: atomicAmount(value.listPriceUsdt, 'listPriceUsdt'),
    stockAvailable: atomicAmount(value.stockAvailable, 'stockAvailable'),
  };
}

function parseAllowedAction(input: unknown): AllowedAction {
  const value = record(input, 'allowed action');
  const action = string(value.action, 'action');
  if (!allowedActionSet.has(action)) invalid('Unknown allowed action');
  const reasonCode = value.reasonCode === undefined ? undefined : string(value.reasonCode, 'reasonCode');
  if (reasonCode !== undefined && !allowedActionReasonSet.has(reasonCode)) invalid('Unknown action reason');
  const deadline = value.deadline === undefined ? undefined : dateTime(value.deadline, 'deadline');
  return {
    action: action as AllowedActionName,
    enabled: boolean(value.enabled, 'enabled'),
    ...(reasonCode ? { reasonCode: reasonCode as AllowedActionReasonCode } : {}),
    ...(deadline ? { deadline } : {}),
  };
}

function record(input: unknown, name: string) {
  const value = recordOrUndefined(input);
  if (!value) invalid(`${name} must be an object`);
  return value;
}

function recordOrUndefined(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function array(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) invalid(`${name} must be an array`);
  return input;
}

function string(input: unknown, name: string) {
  if (typeof input !== 'string' || input.length === 0) invalid(`${name} must be a non-empty string`);
  return input;
}

function stringArray(input: unknown, name: string) {
  return array(input, name).map((value) => string(value, name));
}

function boolean(input: unknown, name: string) {
  if (typeof input !== 'boolean') invalid(`${name} must be a boolean`);
  return input;
}

function exact<T>(input: unknown, expected: T, name: string): asserts input is T {
  if (input !== expected) invalid(`${name} does not match the coordinated artifact`);
}

function address(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(`${name} must be an address`);
  return value;
}

function bytes32(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(`${name} must be bytes32`);
  return value;
}

function atomicAmount(input: unknown, name: string) {
  const value = string(input, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(`${name} must be a canonical integer string`);
  return value;
}

function dateTime(input: unknown, name: string) {
  const value = string(input, name);
  if (!Number.isFinite(Date.parse(value))) invalid(`${name} must be a date-time`);
  return value;
}

function invalid(message: string): never {
  throw new CoreApiError('InvalidResponse', message);
}

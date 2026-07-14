import {
  artifactVersion,
  chainIdentity,
  coreErrorCodes,
  userRoles,
  type CatalogProduct,
  type CoreErrorCode,
  type PaymentProjection,
  type UserRole,
} from '@abu24k/core-artifacts';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const atomicAmountPattern = /^(0|[1-9][0-9]*)$/;
const coreOrigin = (import.meta.env.VITE_CORE_API_ORIGIN ?? '').trim().replace(/\/$/, '');

export type CoreBootstrap = ReturnType<typeof parseBootstrap>;
export type CoreSession = ReturnType<typeof parseSession>;

export type WalletProvider = {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
  removeListener?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
};

export class CoreApiError extends Error {
  readonly code: CoreErrorCode | 'InvalidResponse';
  readonly correlationId?: string;
  readonly status: number;

  constructor(input: {
    code: CoreErrorCode | 'InvalidResponse';
    message: string;
    status: number;
    correlationId?: string;
  }) {
    super(input.message);
    this.name = 'CoreApiError';
    this.code = input.code;
    this.status = input.status;
    if (input.correlationId) this.correlationId = input.correlationId;
  }
}

export async function fetchCoreBootstrap(signal?: AbortSignal) {
  const body = await requestJson('/v2/bootstrap', signal ? { signal } : {});
  return parseBootstrap(body);
}

export async function fetchCatalogProducts(signal?: AbortSignal): Promise<readonly CatalogProduct[]> {
  const body = record(await requestJson('/v2/catalog/products', signal ? { signal } : {}));
  if (!Array.isArray(body.products) || !body.products.every(isCatalogProduct)) {
    throw invalidResponse('Catalog response does not match the coordinated generated type');
  }
  return body.products;
}

export async function fetchPaymentProjection(
  orderId: string,
  token: string,
  signal?: AbortSignal,
): Promise<PaymentProjection> {
  if (!bytes32Pattern.test(orderId)) throw invalidResponse('Order ID must be a bytes32 value');
  const body = await requestJson(`/v2/payments/${encodeURIComponent(orderId)}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!isPaymentProjection(body)) {
    throw invalidResponse('Payment projection does not match the coordinated generated type');
  }
  return body;
}

export async function createWalletSession(provider: WalletProvider): Promise<CoreSession> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const walletAddress = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
  if (!addressPattern.test(walletAddress)) throw invalidResponse('Wallet did not return a valid BSC address');

  const challengeBody = await requestJson('/v2/auth/nonce', {
    body: JSON.stringify({ walletAddress }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const challenge = parseChallenge(challengeBody);
  const signature = await provider.request({
    method: 'personal_sign',
    params: [challenge.message, walletAddress],
  });
  if (typeof signature !== 'string' || signature.length === 0) {
    throw invalidResponse('Wallet did not return a signature');
  }

  return parseSession(await requestJson('/v2/auth/verify', {
    body: JSON.stringify({ message: challenge.message, signature }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }));
}

async function requestJson(path: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${coreOrigin}${path}`, init);
  } catch {
    throw new CoreApiError({
      code: 'ExternalBlocked',
      message: 'Core API is unreachable',
      status: 503,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok && response.status >= 500) {
      throw new CoreApiError({
        code: 'ExternalBlocked',
        message: `Core API gateway is unavailable (${response.status})`,
        status: response.status,
      });
    }
    throw invalidResponse(`Core returned a non-JSON response (${response.status})`, response.status);
  }
  if (response.ok) return body;

  const error = readCoreError(body);
  throw new CoreApiError({
    code: error?.code ?? 'InvalidResponse',
    message: error?.message ?? `Core request failed (${response.status})`,
    status: response.status,
    ...(error?.correlationId ? { correlationId: error.correlationId } : {}),
  });
}

function parseBootstrap(value: unknown) {
  const body = record(value);
  const readiness = record(body.readiness);
  const assets = record(readiness.assets);
  const providers = record(readiness.providers);
  if (
    body.artifactVersion !== artifactVersion
      || body.status !== 'CORE_API_READY'
      || readiness.chainId !== 56
      || assets.usdt !== chainIdentity.usdtAddress
      || assets.npl !== chainIdentity.nplAddress
      || typeof readiness.writesEnabled !== 'boolean'
  ) throw invalidResponse('Core bootstrap is incompatible with this payment checkpoint');

  return Object.freeze({
    artifactVersion,
    status: 'CORE_API_READY' as const,
    readiness: Object.freeze({
      chainId: 56 as const,
      assets: Object.freeze({
        usdt: assets.usdt,
        npl: assets.npl,
        nplUsdtPair: typeof assets.nplUsdtPair === 'string' ? assets.nplUsdtPair : undefined,
      }),
      decisionBlocked: stringArray(readiness.decisionBlocked, 'decisionBlocked'),
      externalBlocked: stringArray(readiness.externalBlocked, 'externalBlocked'),
      paymentDecisionBlocked: stringArray(readiness.paymentDecisionBlocked, 'paymentDecisionBlocked'),
      paymentExternalBlocked: stringArray(readiness.paymentExternalBlocked, 'paymentExternalBlocked'),
      providers: Object.freeze(Object.fromEntries(Object.entries(providers).map(([name, state]) => {
        if (state !== 'READY' && state !== 'CONFIGURATION_REQUIRED') {
          throw invalidResponse(`Unknown provider readiness for ${name}`);
        }
        return [name, state];
      }))),
      writesEnabled: readiness.writesEnabled,
    }),
  });
}

function parseChallenge(value: unknown) {
  const body = record(value);
  if (
    typeof body.message !== 'string'
      || typeof body.nonce !== 'string'
      || typeof body.issuedAt !== 'string'
      || typeof body.expiresAt !== 'string'
  ) throw invalidResponse('SIWE challenge is invalid');
  return body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
}

function parseSession(value: unknown) {
  const body = record(value);
  if (
    typeof body.token !== 'string'
      || !addressPattern.test(String(body.walletAddress))
      || !Array.isArray(body.roles)
      || !body.roles.every((role) => userRoles.includes(role as UserRole))
  ) throw invalidResponse('Core session response is invalid');
  return Object.freeze({
    token: body.token,
    walletAddress: String(body.walletAddress),
    roles: Object.freeze(body.roles as UserRole[]),
  });
}

function isCatalogProduct(value: unknown): value is CatalogProduct {
  if (!isRecord(value) || typeof value.productId !== 'string' || !bytes32Pattern.test(String(value.chainProductId))) {
    return false;
  }
  return typeof value.title === 'string'
    && isRecord(value.metadata)
    && Array.isArray(value.skus)
    && value.skus.every((sku) => isRecord(sku)
      && typeof sku.skuId === 'string'
      && bytes32Pattern.test(String(sku.chainSkuId))
      && isRecord(sku.attributes)
      && atomicAmountPattern.test(String(sku.listPriceUsdt))
      && atomicAmountPattern.test(String(sku.stockAvailable)));
}

function isPaymentProjection(value: unknown): value is PaymentProjection {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !bytes32Pattern.test(String(value.orderId))) {
    return false;
  }
  if (!['QUOTED', 'SUBMITTED', 'PAID', 'REORGED', 'EXPIRED'].includes(String(value.state))) return false;
  if (!addressPattern.test(String(value.paymentRouterAddress))) return false;
  if (value.submittedTxHash !== null && !bytes32Pattern.test(String(value.submittedTxHash))) return false;
  if (!isRecord(value.routerCall) || !['pay', 'paySeckill'].includes(String(value.routerCall.functionName))) return false;
  if (value.finality !== null) {
    if (!isRecord(value.finality) || !bytes32Pattern.test(String(value.finality.transactionHash))) return false;
    if (!['MINED', 'REORGED', 'FINAL'].includes(String(value.finality.state))) return false;
    if (
      !Number.isSafeInteger(value.finality.blockNumber)
        || !Number.isSafeInteger(value.finality.confirmations)
        || value.finality.requiredConfirmations !== 15
        || typeof value.finality.canonicalBlock !== 'boolean'
        || !bytes32Pattern.test(String(value.finality.blockHash))
        || !['ORDINARY', 'SECKILL', 'FALLBACK_RETAIL'].includes(String(value.finality.classification))
    ) return false;
  }
  return ('intent' in value && isCanonicalIntent(value.intent))
    || ('dual' in value && isRecord(value.dual)
      && isCanonicalIntent(value.dual.seckill)
      && isCanonicalIntent(value.dual.fallback));
}

function isCanonicalIntent(value: unknown) {
  return isRecord(value)
    && bytes32Pattern.test(String(value.reservationId))
    && Number.isSafeInteger(value.policyVersion)
    && Number.isSafeInteger(value.reservationDeadline)
    && Number.isSafeInteger(value.quantity)
    && atomicAmountPattern.test(String(value.listPriceUsdt))
    && atomicAmountPattern.test(String(value.usdtPaymentAmount))
    && atomicAmountPattern.test(String(value.nplPaymentAmount))
    && atomicAmountPattern.test(String(value.nplBurnAmount))
    && atomicAmountPattern.test(String(value.nplRewardAmount))
    && atomicAmountPattern.test(String(value.merchantNetReceivableUsdt));
}

function readCoreError(value: unknown) {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const { code, message, correlationId } = value.error;
  if (
    typeof code !== 'string'
      || !coreErrorCodes.includes(code as CoreErrorCode)
      || typeof message !== 'string'
  ) return undefined;
  return {
    code: code as CoreErrorCode,
    message,
    correlationId: typeof correlationId === 'string' ? correlationId : undefined,
  };
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw invalidResponse(`Core bootstrap field ${field} is invalid`);
  }
  return Object.freeze([...value]);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse('Core response must be an object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string, status = 502) {
  return new CoreApiError({ code: 'InvalidResponse', message, status });
}

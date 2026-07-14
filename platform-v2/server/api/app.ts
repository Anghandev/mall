import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createSiweChallenge,
  issueSessionToken,
  normalizeAddress,
  verifySessionToken,
  verifySiwe,
  type NonceRateLimiter,
  type NonceStore,
  type WalletMessageSignatureVerifier,
} from './auth.ts';
import { orderAllowedActions, type ActionContext, type OrderProjection } from './allowed-actions.ts';
import type { CoreConfig, RuntimeReadinessSnapshot } from './config.ts';
import { publicReadiness } from './config.ts';
import { CORE_ARTIFACT_VERSION, executableOrderActionNames, type UserRole } from './enums.ts';
import { CoreError, errorBody } from './errors.ts';
import type { CreateOrdinaryQuoteInput, CreateSeckillQuoteInput } from '../data/catalog-payment-service.ts';

export interface PaymentApiService {
  listCatalog(): Promise<unknown>;
  getProduct(productId: string): Promise<unknown>;
  createOrdinaryQuote(buyerWallet: string, input: CreateOrdinaryQuoteInput): Promise<unknown>;
  createSeckillQuote(buyerWallet: string, input: CreateSeckillQuoteInput): Promise<unknown>;
  submitPayment(
    buyerWallet: string,
    input: { orderId: string; txHash: string; replacementForTxHash?: string },
  ): Promise<unknown>;
  getPayment(buyerWallet: string, orderId: string): Promise<unknown>;
}

export interface ApiDependencies {
  config: CoreConfig;
  runtimeReadiness?: RuntimeReadinessSnapshot | (() => RuntimeReadinessSnapshot | undefined);
  nonceStore: NonceStore;
  nonceRateLimiter: NonceRateLimiter;
  walletSignatureVerifier?: WalletMessageSignatureVerifier;
  authDomain: string;
  authUri: string;
  resolveRoles(walletAddress: string): Promise<{ roles: readonly UserRole[]; merchantId?: string }>;
  getOrderProjection(orderId: string): Promise<OrderProjection | undefined>;
  getPausedScopes(): Promise<ActionContext['pausedScopes']>;
  paymentService: PaymentApiService;
  clock(): Date;
}

export function createApiServer(dependencies: ApiDependencies) {
  return createServer(async (request, response) => {
    const correlationId = request.headers['x-correlation-id']?.toString() ?? randomUUID();
    try {
      await route(dependencies, request, response, correlationId);
    } catch (error) {
      const result = errorBody(error, correlationId);
      sendJson(response, result.status, result.body, correlationId);
    }
  });
}

async function route(
  dependencies: ApiDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  correlationId: string,
) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/v2/bootstrap') {
    sendJson(
      response,
      200,
      {
        artifactVersion: CORE_ARTIFACT_VERSION,
        status: 'CORE_API_READY',
        readiness: publicReadiness(dependencies.config, currentRuntimeReadiness(dependencies), dependencies.clock()),
      },
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/auth/nonce') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['walletAddress']);
    const walletAddress = normalizeAddress(requiredString(body, 'walletAddress'));
    const now = dependencies.clock();
    await dependencies.nonceRateLimiter.consume({
      walletAddress,
      clientAddress: request.socket.remoteAddress ?? 'unknown',
      now,
    });
    const challenge = await createSiweChallenge(dependencies.nonceStore, {
      walletAddress,
      domain: dependencies.authDomain,
      uri: dependencies.authUri,
      statement: 'Sign in to Abu 24K V2',
    }, now);
    sendJson(response, 201, challenge, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/auth/verify') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['message', 'signature']);
    const verified = await verifySiwe(dependencies.nonceStore, {
      message: requiredString(body, 'message'),
      signature: requiredString(body, 'signature'),
      expectedDomain: dependencies.authDomain,
      expectedUri: dependencies.authUri,
    }, dependencies.clock(), dependencies.walletSignatureVerifier);
    const binding = await dependencies.resolveRoles(verified.walletAddress);
    if (binding.roles.length === 0) throw new CoreError('Forbidden', 'Wallet is not authorized', 403);
    if (!dependencies.config.jwtSecret) throw new CoreError('ConfigurationRequired', 'JWT service is unavailable', 503);
    const token = issueSessionToken(
      {
        walletAddress: verified.walletAddress,
        roles: binding.roles,
        ...(binding.merchantId ? { merchantId: binding.merchantId } : {}),
      },
      dependencies.config.jwtSecret,
      dependencies.clock(),
    );
    sendJson(response, 200, { token, walletAddress: verified.walletAddress, roles: binding.roles }, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/actions/order') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['orderId']);
    const orderId = requiredString(body, 'orderId');
    const order = await dependencies.getOrderProjection(orderId);
    if (!order) throw new CoreError('InvalidRequest', 'Order not found', 404);
    const context: ActionContext = {
      actorWallet: claims.sub,
      roles: claims.roles,
      now: dependencies.clock(),
      pausedScopes: await dependencies.getPausedScopes(),
      executableActions: new Set(executableOrderActionNames),
    };
    sendJson(response, 200, { allowedActions: orderAllowedActions(order, context) }, correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/catalog/products') {
    sendJson(response, 200, { products: await dependencies.paymentService.listCatalog() }, correlationId);
    return;
  }
  const productId = pathParameter(url.pathname, '/v2/catalog/products/');
  if (request.method === 'GET' && productId) {
    sendJson(response, 200, { product: await dependencies.paymentService.getProduct(productId) }, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/payments/quotes') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    assertPaymentWritesEnabled(dependencies);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'productId',
      'skuId',
      'quantity',
      'fulfillmentMode',
      'fulfillmentTargetHash',
      'regionCodeHash',
    ]);
    const quoteInput: CreateOrdinaryQuoteInput = {
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      productId: requiredString(body, 'productId'),
      skuId: requiredString(body, 'skuId'),
      quantity: requiredPositiveInteger(body, 'quantity'),
      fulfillmentMode: fulfillmentMode(body.fulfillmentMode),
      fulfillmentTargetHash: requiredString(body, 'fulfillmentTargetHash'),
      regionCodeHash: requiredString(body, 'regionCodeHash'),
    };
    sendJson(
      response,
      201,
      await dependencies.paymentService.createOrdinaryQuote(claims.sub, quoteInput),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/seckill/quotes') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    assertPaymentWritesEnabled(dependencies);
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'sessionId',
      'productId',
      'skuId',
      'quantity',
      'fulfillmentMode',
      'fulfillmentTargetHash',
      'regionCodeHash',
    ]);
    const quoteInput: CreateSeckillQuoteInput = {
      idempotencyKey: requiredString(body, 'idempotencyKey'),
      sessionId: requiredString(body, 'sessionId'),
      productId: requiredString(body, 'productId'),
      skuId: requiredString(body, 'skuId'),
      quantity: requiredPositiveInteger(body, 'quantity'),
      fulfillmentMode: fulfillmentMode(body.fulfillmentMode),
      fulfillmentTargetHash: requiredString(body, 'fulfillmentTargetHash'),
      regionCodeHash: requiredString(body, 'regionCodeHash'),
    };
    sendJson(
      response,
      201,
      await dependencies.paymentService.createSeckillQuote(claims.sub, quoteInput),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/payments/submissions') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['orderId', 'txHash', 'replacementForTxHash']);
    sendJson(
      response,
      202,
      await dependencies.paymentService.submitPayment(claims.sub, {
        orderId: requiredString(body, 'orderId'),
        txHash: requiredString(body, 'txHash'),
        ...(body.replacementForTxHash === undefined
          ? {}
          : { replacementForTxHash: requiredString(body, 'replacementForTxHash') }),
      }),
      correlationId,
    );
    return;
  }
  const paymentOrderId = pathParameter(url.pathname, '/v2/payments/');
  if (request.method === 'GET' && paymentOrderId) {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      await dependencies.paymentService.getPayment(claims.sub, paymentOrderId),
      correlationId,
    );
    return;
  }
  throw new CoreError('InvalidRequest', 'Route not found', 404);
}

function authorize(request: IncomingMessage, config: CoreConfig, now: Date) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !config.jwtSecret) {
    throw new CoreError('Unauthorized', 'Bearer session is required', 401);
  }
  return verifySessionToken(header.slice('Bearer '.length), config.jwtSecret, now);
}

function authorizeBuyer(request: IncomingMessage, config: CoreConfig, now: Date) {
  const claims = authorize(request, config, now);
  if (!claims.roles.includes('BUYER')) throw new CoreError('Forbidden', 'Buyer role is required', 403);
  return claims;
}

function assertPaymentWritesEnabled(dependencies: ApiDependencies) {
  const readiness = publicReadiness(
    dependencies.config,
    currentRuntimeReadiness(dependencies),
    dependencies.clock(),
  );
  if (readiness.writesEnabled) return;
  if (readiness.paymentDecisionBlocked.length > 0) {
    throw new CoreError('DecisionBlocked', 'New payment quotes are blocked by unresolved payment policy', 409, {
      blocked: readiness.paymentDecisionBlocked,
    });
  }
  if (readiness.paymentExternalBlocked.length > 0) {
    throw new CoreError('ExternalBlocked', 'New payment quotes are blocked by unavailable payment infrastructure', 503, {
      blocked: readiness.paymentExternalBlocked,
    });
  }
  throw new CoreError('ConfigurationRequired', 'New payment quotes require a fresh verified runtime readiness snapshot', 503);
}

function currentRuntimeReadiness(dependencies: ApiDependencies) {
  return typeof dependencies.runtimeReadiness === 'function'
    ? dependencies.runtimeReadiness()
    : dependencies.runtimeReadiness;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new CoreError('InvalidRequest', 'Request contains unsupported fields', 400, { unexpected });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new CoreError('InvalidRequest', 'Request body is too large', 413);
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid JSON body');
  }
}

function requiredString(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0) throw new CoreError('InvalidRequest', `${name} is required`);
  return value;
}

function requiredPositiveInteger(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new CoreError('InvalidRequest', `${name} must be a positive integer`);
  }
  return Number(value);
}

function fulfillmentMode(value: unknown): 'DELIVERY' | 'PICKUP' {
  if (value !== 'DELIVERY' && value !== 'PICKUP') {
    throw new CoreError('InvalidRequest', 'fulfillmentMode must be DELIVERY or PICKUP');
  }
  return value;
}

function pathParameter(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length);
  if (!value || value.includes('/')) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid URL path');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, correlationId: string) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-correlation-id': correlationId,
  });
  response.end(payload);
}

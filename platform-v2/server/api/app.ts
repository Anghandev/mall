import { createHash, randomUUID } from 'node:crypto';
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
import type {
  ArbitrationDecisionInput,
  DecisionInput,
  FulfillmentActor,
  FulfillmentCommandInput,
  FulfillmentRequestDecisionInput,
  LogisticsUpdateInput,
  PickupCredentialInput,
  PickupVerificationInput,
  RequestInput,
  ShipmentInput,
} from '../data/fulfillment-service.ts';
import type {
  DeliveryTargetInput,
  PickupTargetInput,
  StoreInput,
} from '../data/fulfillment-target-service.ts';
import { verifyWebhookHmac } from './providers.ts';

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

export interface FulfillmentApiService {
  getOrder(actor: FulfillmentActor, orderId: string): Promise<unknown>;
  listOrders(actor: FulfillmentActor): Promise<unknown>;
  recordShipment(actor: FulfillmentActor, orderId: string, input: ShipmentInput): Promise<unknown>;
  recordDelivery(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput): Promise<unknown>;
  recordLogisticsUpdate(actor: FulfillmentActor, orderId: string, input: LogisticsUpdateInput): Promise<unknown>;
  registerPickupCredential(actor: FulfillmentActor, orderId: string, input: PickupCredentialInput): Promise<unknown>;
  verifyPickup(
    actor: FulfillmentActor,
    orderId: string,
    input: PickupVerificationInput,
  ): Promise<unknown>;
  requestExchange(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  requestDelay(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideFulfillmentRequest(
    actor: FulfillmentActor,
    orderId: string,
    input: FulfillmentRequestDecisionInput,
  ): Promise<unknown>;
  openArbitration(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideArbitration(actor: FulfillmentActor, orderId: string, input: ArbitrationDecisionInput): Promise<unknown>;
  openTakeover(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  requestForcedReceipt(actor: FulfillmentActor, orderId: string, input: RequestInput): Promise<unknown>;
  decideForcedReceipt(actor: FulfillmentActor, orderId: string, input: DecisionInput): Promise<unknown>;
  confirmReceipt(actor: FulfillmentActor, orderId: string, input: FulfillmentCommandInput): Promise<unknown>;
}

export interface FulfillmentTargetApiService {
  createDeliveryTarget(actor: FulfillmentActor, input: DeliveryTargetInput): Promise<unknown>;
  createPickupTarget(actor: FulfillmentActor, input: PickupTargetInput): Promise<unknown>;
  createStore(actor: FulfillmentActor, input: StoreInput): Promise<unknown>;
  listStores(regionCode?: string): Promise<unknown>;
  getOrderTarget(actor: FulfillmentActor, orderId: string): Promise<unknown>;
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
  fulfillmentService: FulfillmentApiService;
  fulfillmentTargetService: FulfillmentTargetApiService;
  logisticsWebhookSecrets?: Readonly<Partial<Record<'KUAIDI100' | 'CAINIAO', string>>>;
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
  const logisticsProvider = logisticsWebhookProvider(url.pathname);
  if (request.method === 'POST' && logisticsProvider) {
    const secret = dependencies.logisticsWebhookSecrets?.[logisticsProvider];
    if (!secret) throw new CoreError('ConfigurationRequired', `${logisticsProvider} webhook is not configured`, 503);
    const signature = request.headers['x-provider-signature']?.toString() ?? '';
    const raw = await readBody(request);
    verifyWebhookHmac(raw, signature, secret);
    const body = parseJsonBody(raw);
    assertOnlyKeys(body, ['eventId', 'orderId', 'status', 'occurredAt', 'locationHash']);
    const systemWallet = dependencies.config.safeAddress;
    if (!systemWallet) throw new CoreError('ExternalBlocked', 'Platform Safe identity is unavailable', 503);
    const eventId = requiredString(body, 'eventId');
    const result = await dependencies.fulfillmentService.recordLogisticsUpdate(
      { walletAddress: systemWallet, roles: ['OPERATOR'] },
      requiredString(body, 'orderId'),
      {
        idempotencyKey: `logistics:${logisticsProvider}:${eventId}`,
        evidenceHash: sha256Hash(raw),
        provider: logisticsProvider,
        providerEventIdHash: sha256Hash(Buffer.from(`${logisticsProvider}:${eventId}`, 'utf8')),
        status: logisticsStatus(body.status),
        occurredAt: requiredDate(body, 'occurredAt'),
        ...(body.locationHash === undefined ? {} : { locationHash: requiredString(body, 'locationHash') }),
      },
    );
    sendJson(response, 202, result, correlationId);
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
      ...(claims.merchantId ? { actorMerchantId: claims.merchantId } : {}),
      now: dependencies.clock(),
      pausedScopes: await dependencies.getPausedScopes(),
      executableActions: new Set(executableOrderActionNames),
    };
    sendJson(response, 200, { allowedActions: orderAllowedActions(order, context) }, correlationId);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/stores') {
    const regionCode = url.searchParams.get('regionCode') ?? undefined;
    sendJson(
      response,
      200,
      { stores: await dependencies.fulfillmentTargetService.listStores(regionCode) },
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/stores') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey', 'name', 'phone', 'longitude', 'latitude']);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createStore(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        name: requiredString(body, 'name'),
        phone: requiredString(body, 'phone'),
        longitude: requiredNumber(body, 'longitude'),
        latitude: requiredNumber(body, 'latitude'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/fulfillment-targets/delivery') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, [
      'idempotencyKey',
      'recipientName',
      'phone',
      'address',
      'longitude',
      'latitude',
    ]);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createDeliveryTarget(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        recipientName: requiredString(body, 'recipientName'),
        phone: requiredString(body, 'phone'),
        address: requiredString(body, 'address'),
        longitude: requiredNumber(body, 'longitude'),
        latitude: requiredNumber(body, 'latitude'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/fulfillment-targets/pickup') {
    const claims = authorizeBuyer(request, dependencies.config, dependencies.clock());
    const body = await readJson(request);
    assertOnlyKeys(body, ['idempotencyKey', 'storeId']);
    sendJson(
      response,
      201,
      await dependencies.fulfillmentTargetService.createPickupTarget(fulfillmentActor(claims), {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        storeId: requiredString(body, 'storeId'),
      }),
      correlationId,
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v2/orders') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      { orders: await dependencies.fulfillmentService.listOrders(fulfillmentActor(claims)) },
      correlationId,
    );
    return;
  }
  const orderPath = matchOrderPath(url.pathname);
  if (orderPath && request.method === 'GET' && !orderPath.action) {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      { order: await dependencies.fulfillmentService.getOrder(fulfillmentActor(claims), orderPath.orderId) },
      correlationId,
    );
    return;
  }
  if (orderPath && request.method === 'GET' && orderPath.action === 'fulfillment-target') {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    sendJson(
      response,
      200,
      { target: await dependencies.fulfillmentTargetService.getOrderTarget(fulfillmentActor(claims), orderPath.orderId) },
      correlationId,
    );
    return;
  }
  if (orderPath && request.method === 'POST' && orderPath.action) {
    const claims = authorize(request, dependencies.config, dependencies.clock());
    const actor = fulfillmentActor(claims);
    const body = await readJson(request);
    const base = () => {
      assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash']);
      return {
        idempotencyKey: requiredString(body, 'idempotencyKey'),
        evidenceHash: requiredString(body, 'evidenceHash'),
      };
    };
    let status = 200;
    let result: unknown;
    switch (orderPath.action) {
      case 'shipments':
        assertOnlyKeys(body, [
          'idempotencyKey',
          'evidenceHash',
          'carrierCode',
          'trackingNumberHash',
          'providerReferenceHash',
        ]);
        status = 201;
        result = await dependencies.fulfillmentService.recordShipment(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          carrierCode: requiredString(body, 'carrierCode'),
          trackingNumberHash: requiredString(body, 'trackingNumberHash'),
          ...(body.providerReferenceHash === undefined
            ? {}
            : { providerReferenceHash: requiredString(body, 'providerReferenceHash') }),
        });
        break;
      case 'delivery':
        result = await dependencies.fulfillmentService.recordDelivery(actor, orderPath.orderId, base());
        break;
      case 'pickup-credential':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'code', 'expiresAt']);
        status = 201;
        result = await dependencies.fulfillmentService.registerPickupCredential(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          code: requiredString(body, 'code'),
          expiresAt: requiredDate(body, 'expiresAt'),
        });
        break;
      case 'pickup-verification':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'code', 'storeId']);
        result = await dependencies.fulfillmentService.verifyPickup(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          code: requiredString(body, 'code'),
          storeId: requiredString(body, 'storeId'),
        });
        break;
      case 'exchange-requests':
        status = 201;
        result = await dependencies.fulfillmentService.requestExchange(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'delay-requests':
        status = 201;
        result = await dependencies.fulfillmentService.requestDelay(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'request-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'requestId', 'approved', 'noteCode']);
        result = await dependencies.fulfillmentService.decideFulfillmentRequest(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          requestId: requiredString(body, 'requestId'),
          approved: requiredBoolean(body, 'approved'),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'arbitrations':
        status = 201;
        result = await dependencies.fulfillmentService.openArbitration(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'arbitration-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'outcome', 'noteCode']);
        result = await dependencies.fulfillmentService.decideArbitration(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          outcome: arbitrationOutcome(body.outcome),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'takeover':
        status = 201;
        result = await dependencies.fulfillmentService.openTakeover(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'forced-receipt-requests':
        status = 201;
        result = await dependencies.fulfillmentService.requestForcedReceipt(
          actor,
          orderPath.orderId,
          requestInput(body),
        );
        break;
      case 'forced-receipt-decisions':
        assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'approved', 'noteCode']);
        result = await dependencies.fulfillmentService.decideForcedReceipt(actor, orderPath.orderId, {
          idempotencyKey: requiredString(body, 'idempotencyKey'),
          evidenceHash: requiredString(body, 'evidenceHash'),
          approved: requiredBoolean(body, 'approved'),
          noteCode: requiredString(body, 'noteCode'),
        });
        break;
      case 'receipt-confirmation':
        result = await dependencies.fulfillmentService.confirmReceipt(actor, orderPath.orderId, base());
        break;
      default:
        throw new CoreError('InvalidRequest', 'Order action route not found', 404);
    }
    sendJson(response, status, result, correlationId);
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
  return parseJsonBody(await readBody(request));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new CoreError('InvalidRequest', 'Request body is too large', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
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

function requiredNumber(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoreError('InvalidRequest', `${name} must be a finite number`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== 'boolean') throw new CoreError('InvalidRequest', `${name} must be boolean`);
  return value;
}

function requiredDate(body: Record<string, unknown>, name: string) {
  const value = requiredString(body, name);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CoreError('InvalidRequest', `${name} must be a canonical ISO timestamp`);
  }
  return date;
}

function requestInput(body: Record<string, unknown>) {
  assertOnlyKeys(body, ['idempotencyKey', 'evidenceHash', 'reasonCode']);
  return {
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    evidenceHash: requiredString(body, 'evidenceHash'),
    reasonCode: requiredString(body, 'reasonCode'),
  };
}

function arbitrationOutcome(value: unknown): 'FULFILL' | 'RESUME_FULFILLMENT' {
  if (value !== 'FULFILL' && value !== 'RESUME_FULFILLMENT') {
    throw new CoreError('InvalidRequest', 'outcome must be FULFILL or RESUME_FULFILLMENT');
  }
  return value;
}

function logisticsStatus(value: unknown): LogisticsUpdateInput['status'] {
  if (!['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION'].includes(String(value))) {
    throw new CoreError('InvalidRequest', 'Unsupported logistics status');
  }
  return value as LogisticsUpdateInput['status'];
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

function matchOrderPath(pathname: string) {
  const match = /^\/v2\/orders\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return { orderId: decodeURIComponent(match[1]!), action: match[2] ? decodeURIComponent(match[2]) : undefined };
  } catch {
    throw new CoreError('InvalidRequest', 'Invalid order URL path');
  }
}

function logisticsWebhookProvider(pathname: string): 'KUAIDI100' | 'CAINIAO' | undefined {
  const match = /^\/v2\/providers\/(kuaidi100|cainiao)\/webhooks\/logistics$/.exec(pathname);
  return match?.[1]?.toUpperCase() as 'KUAIDI100' | 'CAINIAO' | undefined;
}

function sha256Hash(value: Buffer) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function fulfillmentActor(claims: { sub: string; roles: readonly UserRole[]; merchantId?: string }): FulfillmentActor {
  return {
    walletAddress: claims.sub,
    roles: claims.roles,
    ...(claims.merchantId ? { merchantId: claims.merchantId } : {}),
  };
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

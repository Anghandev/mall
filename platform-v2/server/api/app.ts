import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSiweChallenge, issueSessionToken, verifySessionToken, verifySiwe, type NonceStore } from './auth.ts';
import { orderAllowedActions, type ActionContext, type OrderProjection } from './allowed-actions.ts';
import type { CoreConfig } from './config.ts';
import { publicReadiness } from './config.ts';
import { CORE_ARTIFACT_VERSION, executableOrderActionNames, type UserRole } from './enums.ts';
import { CoreError, errorBody } from './errors.ts';

export interface ApiDependencies {
  config: CoreConfig;
  nonceStore: NonceStore;
  authDomain: string;
  authUri: string;
  resolveRoles(walletAddress: string): Promise<{ roles: readonly UserRole[]; merchantId?: string }>;
  getOrderProjection(orderId: string): Promise<OrderProjection | undefined>;
  getPausedScopes(): Promise<ActionContext['pausedScopes']>;
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
      { artifactVersion: CORE_ARTIFACT_VERSION, status: 'CORE_API_READY', readiness: publicReadiness(dependencies.config) },
      correlationId,
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/auth/nonce') {
    const body = await readJson(request);
    assertOnlyKeys(body, ['walletAddress']);
    const walletAddress = requiredString(body, 'walletAddress');
    const challenge = await createSiweChallenge(dependencies.nonceStore, {
      walletAddress,
      domain: dependencies.authDomain,
      uri: dependencies.authUri,
      statement: 'Sign in to Abu 24K V2',
    });
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
    });
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
    );
    sendJson(response, 200, { token, walletAddress: verified.walletAddress, roles: binding.roles }, correlationId);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v2/actions/order') {
    const claims = authorize(request, dependencies.config);
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
  throw new CoreError('InvalidRequest', 'Route not found', 404);
}

function authorize(request: IncomingMessage, config: CoreConfig) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !config.jwtSecret) {
    throw new CoreError('Unauthorized', 'Bearer session is required', 401);
  }
  return verifySessionToken(header.slice('Bearer '.length), config.jwtSecret);
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

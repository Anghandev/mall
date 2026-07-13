import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import {
  getAddress,
  isAddress,
  isHexString,
  TypedDataEncoder,
  verifyTypedData,
  Wallet
} from 'ethers';

const DOMAIN_NAME = '24K Mall Escrow';
const DOMAIN_VERSION = '1';
const REQUEST_VERSION = '24k-order-authorization-v1';
const PRIMARY_TYPE = 'OrderAuthorization';
const OPERATION = 'order-authorization.sign';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const DEFAULT_PORT = 8791;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

const ORDER_AUTHORIZATION_FIELDS = Object.freeze([
  Object.freeze({ name: 'orderId', type: 'bytes32' }),
  Object.freeze({ name: 'buyer', type: 'address' }),
  Object.freeze({ name: 'seller', type: 'address' }),
  Object.freeze({ name: 'productId', type: 'bytes32' }),
  Object.freeze({ name: 'nplAmount', type: 'uint256' }),
  Object.freeze({ name: 'bnmLocked', type: 'uint256' }),
  Object.freeze({ name: 'deadline', type: 'uint64' }),
  Object.freeze({ name: 'orderDigest', type: 'bytes32' }),
  Object.freeze({ name: 'splitVersion', type: 'uint32' })
]);

export const ORDER_AUTHORIZATION_TYPES = Object.freeze({
  OrderAuthorization: ORDER_AUTHORIZATION_FIELDS
});

const TOP_LEVEL_FIELDS = Object.freeze([
  'version',
  'domain',
  'types',
  'primaryType',
  'value',
  'authorizationDigest'
]);
const DOMAIN_FIELDS = Object.freeze(['name', 'version', 'chainId', 'verifyingContract']);
const VALUE_FIELDS = Object.freeze(ORDER_AUTHORIZATION_FIELDS.map(({ name }) => name));

class SignerServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SignerServiceError';
    this.code = code;
  }
}

class HttpFailure extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpFailure';
    this.status = status;
    this.code = code;
  }
}

export function safeServiceErrorCode(error) {
  return error instanceof SignerServiceError
    ? error.code
    : 'ORDER_SIGNER_STARTUP_FAILED';
}

export function loadOrderSignerConfig(env = process.env) {
  const privateKey = requiredEnv(env, 'ORDER_SIGNER_PRIVATE_KEY', 'ORDER_SIGNER_PRIVATE_KEY_INVALID');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new SignerServiceError('ORDER_SIGNER_PRIVATE_KEY_INVALID');
  }

  let wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    throw new SignerServiceError('ORDER_SIGNER_PRIVATE_KEY_INVALID');
  }

  const signerAddress = configAddress(
    requiredEnv(env, 'ORDER_SIGNER_ADDRESS', 'ORDER_SIGNER_ADDRESS_INVALID'),
    'ORDER_SIGNER_ADDRESS_INVALID'
  );
  if (wallet.address !== signerAddress) {
    throw new SignerServiceError('ORDER_SIGNER_ADDRESS_MISMATCH');
  }

  const chainId = configUint(
    requiredEnv(env, 'ORDER_SIGNER_CHAIN_ID', 'ORDER_SIGNER_CHAIN_ID_INVALID'),
    256,
    'ORDER_SIGNER_CHAIN_ID_INVALID',
    true
  );
  const escrowAddress = configAddress(
    requiredEnv(env, 'ORDER_SIGNER_ESCROW_ADDRESS', 'ORDER_SIGNER_ESCROW_ADDRESS_INVALID'),
    'ORDER_SIGNER_ESCROW_ADDRESS_INVALID'
  );

  const token = optionalEnv(env, 'ORDER_SIGNING_WEBHOOK_TOKEN');
  let tokenDigest = null;
  if (token !== null) {
    if (token.length < 32 || token.length > 1024 || !TOKEN_PATTERN.test(token)) {
      throw new SignerServiceError('ORDER_SIGNER_TOKEN_INVALID');
    }
    tokenDigest = tokenHash(token);
  }

  const allowedSources = parseAllowedSources(optionalEnv(env, 'ORDER_SIGNER_ALLOWED_SOURCES'));
  if (!tokenDigest && allowedSources.size === 0) {
    throw new SignerServiceError('ORDER_SIGNER_AUTH_NOT_CONFIGURED');
  }

  const host = optionalEnv(env, 'ORDER_SIGNER_HOST') || '127.0.0.1';
  if (!validHost(host)) throw new SignerServiceError('ORDER_SIGNER_HOST_INVALID');

  const port = configNumber(optionalEnv(env, 'ORDER_SIGNER_PORT') || String(DEFAULT_PORT), {
    minimum: 0,
    maximum: 65_535,
    code: 'ORDER_SIGNER_PORT_INVALID'
  });
  const maxBodyBytes = configNumber(
    optionalEnv(env, 'ORDER_SIGNER_MAX_BODY_BYTES') || String(DEFAULT_MAX_BODY_BYTES),
    {
      minimum: 1024,
      maximum: MAX_BODY_BYTES,
      code: 'ORDER_SIGNER_MAX_BODY_BYTES_INVALID'
    }
  );

  return Object.freeze({
    wallet,
    signerAddress,
    chainId,
    escrowAddress,
    tokenDigest,
    allowedSources,
    host,
    port,
    maxBodyBytes
  });
}

export async function startOrderSignerService({ env = process.env, log = () => {} } = {}) {
  const config = loadOrderSignerConfig(env);
  const server = createServer({
    headersTimeout: 10_000,
    requestTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 8 * 1024
  }, (request, response) => {
    void handleRequest(request, response, config, log);
  });
  server.maxRequestsPerSocket = 1_000;
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  try {
    await listen(server, config.host, config.port);
  } catch {
    throw new SignerServiceError('ORDER_SIGNER_LISTEN_FAILED');
  }

  server.on('error', () => {
    emit(log, {
      level: 'error',
      event: 'order_signer_server_error',
      code: 'ORDER_SIGNER_SERVER_ERROR'
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new SignerServiceError('ORDER_SIGNER_LISTEN_FAILED');
  }

  let closing;
  return Object.freeze({
    host: config.host,
    port: address.port,
    signerAddress: config.signerAddress,
    close() {
      if (!closing) closing = closeServer(server);
      return closing;
    }
  });
}

async function handleRequest(request, response, config, log) {
  try {
    if (request.url === '/health') {
      if (request.method !== 'GET') throw new HttpFailure(405, 'METHOD_NOT_ALLOWED');
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.url !== '/sign-order') throw new HttpFailure(404, 'NOT_FOUND');
    if (request.method !== 'POST') throw new HttpFailure(405, 'METHOD_NOT_ALLOWED');

    authorizeRequest(request, config);
    requireOperationHeader(request);
    requireJsonContentType(request);
    const payload = await readJson(request, config.maxBodyBytes);
    const typedData = validatePayload(payload, config);
    const signed = await signAndRecover(typedData, config);

    sendJson(response, 200, signed);
    emit(log, { level: 'info', event: 'order_authorization_signed' });
  } catch (error) {
    const failure = error instanceof HttpFailure
      ? error
      : new HttpFailure(500, 'INTERNAL_ERROR');
    emit(log, {
      level: failure.status >= 500 ? 'error' : 'warn',
      event: 'order_signer_request_rejected',
      status: failure.status,
      code: failure.code
    });
    if (!response.headersSent) {
      sendJson(response, failure.status, { error: failure.code }, failure.status === 405 ? { allow: allowedMethod(request.url) } : {});
    } else {
      response.destroy();
    }
  }
}

function authorizeRequest(request, config) {
  if (config.allowedSources.size > 0) {
    const source = canonicalIp(request.socket.remoteAddress || '');
    if (!source || !config.allowedSources.has(source)) {
      throw new HttpFailure(403, 'FORBIDDEN');
    }
  }

  if (!config.tokenDigest) return;
  const values = rawHeaderValues(request, 'authorization');
  const match = values.length === 1 ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(values[0]) : null;
  const suppliedDigest = tokenHash(match?.[1] || '');
  if (!timingSafeEqual(suppliedDigest, config.tokenDigest)) {
    throw new HttpFailure(401, 'UNAUTHORIZED');
  }
}

function requireOperationHeader(request) {
  const values = rawHeaderValues(request, 'x-24k-operation');
  if (values.length !== 1 || values[0] !== OPERATION) {
    throw new HttpFailure(400, 'INVALID_REQUEST');
  }
}

function requireJsonContentType(request) {
  const values = rawHeaderValues(request, 'content-type');
  if (values.length !== 1) throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
  const normalized = values[0].toLowerCase().replace(/[ \t]/g, '');
  if (normalized !== 'application/json' && normalized !== 'application/json;charset=utf-8') {
    throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  if (rawHeaderValues(request, 'content-encoding').length > 0) {
    throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

async function readJson(request, maxBodyBytes) {
  const contentLengths = rawHeaderValues(request, 'content-length');
  if (contentLengths.length > 1) throw new HttpFailure(400, 'INVALID_REQUEST');
  if (contentLengths.length === 1) {
    if (!/^(0|[1-9]\d*)$/.test(contentLengths[0])) throw new HttpFailure(400, 'INVALID_REQUEST');
    if (decimalExceeds(contentLengths[0], BigInt(maxBodyBytes))) {
      request.resume();
      throw new HttpFailure(413, 'PAYLOAD_TOO_LARGE');
    }
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxBodyBytes) {
        request.resume();
        throw new HttpFailure(413, 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(400, 'INVALID_REQUEST');
  }

  if (total === 0) throw new HttpFailure(400, 'INVALID_REQUEST');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpFailure(400, 'INVALID_REQUEST');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpFailure(400, 'INVALID_REQUEST');
  }
}

function validatePayload(payload, config) {
  exactObject(payload, TOP_LEVEL_FIELDS);
  if (payload.version !== REQUEST_VERSION || payload.primaryType !== PRIMARY_TYPE) invalidRequest();

  exactObject(payload.domain, DOMAIN_FIELDS);
  if (payload.domain.name !== DOMAIN_NAME || payload.domain.version !== DOMAIN_VERSION) invalidRequest();
  const chainId = jsonUint(payload.domain.chainId, 256, true);
  if (chainId !== config.chainId) invalidRequest();
  const verifyingContract = requestAddress(payload.domain.verifyingContract);
  if (verifyingContract !== config.escrowAddress) invalidRequest();

  validateTypes(payload.types);
  exactObject(payload.value, VALUE_FIELDS);
  const value = {
    orderId: requestBytes32(payload.value.orderId),
    buyer: requestAddress(payload.value.buyer),
    seller: requestAddress(payload.value.seller),
    productId: requestBytes32(payload.value.productId),
    nplAmount: jsonUint(payload.value.nplAmount, 256, true),
    bnmLocked: jsonUint(payload.value.bnmLocked, 256, true),
    deadline: jsonUint(payload.value.deadline, 64, true),
    orderDigest: requestBytes32(payload.value.orderDigest),
    splitVersion: jsonUint(payload.value.splitVersion, 32, true)
  };
  if (value.orderId.toLowerCase() === ZERO_BYTES32) invalidRequest();
  if (value.buyer === ZERO_ADDRESS || value.seller === ZERO_ADDRESS) invalidRequest();

  const suppliedDigest = requestBytes32(payload.authorizationDigest);
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
  let authorizationDigest;
  try {
    authorizationDigest = TypedDataEncoder.hash(domain, ORDER_AUTHORIZATION_TYPES, value);
  } catch {
    invalidRequest();
  }
  if (suppliedDigest.toLowerCase() !== authorizationDigest.toLowerCase()) invalidRequest();

  return { domain, value, authorizationDigest };
}

function validateTypes(types) {
  exactObject(types, [PRIMARY_TYPE]);
  const fields = types[PRIMARY_TYPE];
  if (!Array.isArray(fields) || fields.length !== ORDER_AUTHORIZATION_FIELDS.length) invalidRequest();
  for (let index = 0; index < ORDER_AUTHORIZATION_FIELDS.length; index += 1) {
    exactObject(fields[index], ['name', 'type']);
    const expected = ORDER_AUTHORIZATION_FIELDS[index];
    if (fields[index].name !== expected.name || fields[index].type !== expected.type) invalidRequest();
  }
}

async function signAndRecover({ domain, value, authorizationDigest }, config) {
  let signature;
  let recovered;
  try {
    signature = await config.wallet.signTypedData(domain, ORDER_AUTHORIZATION_TYPES, value);
    recovered = getAddress(verifyTypedData(domain, ORDER_AUTHORIZATION_TYPES, value, signature));
  } catch {
    throw new HttpFailure(500, 'SIGNING_FAILED');
  }
  if (!isHexString(signature, 65) || recovered !== config.signerAddress) {
    throw new HttpFailure(500, 'SIGNING_FAILED');
  }
  return {
    signature,
    signer: config.signerAddress,
    authorizationDigest
  };
}

function exactObject(value, expectedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest();
  const fields = Object.keys(value);
  if (fields.length !== expectedFields.length || !expectedFields.every((field) => Object.hasOwn(value, field))) {
    invalidRequest();
  }
}

function requestAddress(value) {
  if (typeof value !== 'string' || !isAddress(value)) invalidRequest();
  try {
    return getAddress(value);
  } catch {
    invalidRequest();
  }
}

function requestBytes32(value) {
  if (typeof value !== 'string' || !isHexString(value, 32)) invalidRequest();
  return value;
}

function jsonUint(value, bits, positive) {
  const maximum = (1n << BigInt(bits)) - 1n;
  let parsed;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) invalidRequest();
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    if (decimalExceeds(value, maximum)) invalidRequest();
    try {
      parsed = BigInt(value);
    } catch {
      invalidRequest();
    }
  } else {
    invalidRequest();
  }
  if ((positive && parsed === 0n) || parsed > maximum) invalidRequest();
  return parsed;
}

function invalidRequest() {
  throw new HttpFailure(400, 'INVALID_REQUEST');
}

function rawHeaderValues(request, name) {
  const expected = name.toLowerCase();
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === expected) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function sendJson(response, status, body, extraHeaders = {}) {
  const serialized = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(serialized);
}

function allowedMethod(url) {
  return url === '/health' ? 'GET' : 'POST';
}

function requiredEnv(env, name, code) {
  const value = optionalEnv(env, name);
  if (value === null) throw new SignerServiceError(code);
  return value;
}

function optionalEnv(env, name) {
  const value = env?.[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new SignerServiceError('ORDER_SIGNER_CONFIGURATION_INVALID');
  return value;
}

function configAddress(value, code) {
  if (!isAddress(value)) throw new SignerServiceError(code);
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new SignerServiceError(code);
  }
  if (address === ZERO_ADDRESS) throw new SignerServiceError(code);
  return address;
}

function configUint(value, bits, code, positive) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new SignerServiceError(code);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (decimalExceeds(value, maximum)) throw new SignerServiceError(code);
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new SignerServiceError(code);
  }
  if ((positive && parsed === 0n) || parsed > maximum) {
    throw new SignerServiceError(code);
  }
  return parsed;
}

function configNumber(value, { minimum, maximum, code }) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new SignerServiceError(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new SignerServiceError(code);
  }
  return number;
}

function parseAllowedSources(value) {
  const sources = new Set();
  if (value === null) return sources;
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > 128 || entries.some((entry) => !entry)) {
    throw new SignerServiceError('ORDER_SIGNER_ALLOWED_SOURCES_INVALID');
  }
  for (const entry of entries) {
    const source = canonicalIp(entry);
    if (!source || sources.has(source)) {
      throw new SignerServiceError('ORDER_SIGNER_ALLOWED_SOURCES_INVALID');
    }
    sources.add(source);
  }
  return sources;
}

function canonicalIp(value) {
  const candidate = String(value || '');
  if (candidate.toLowerCase().startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) {
    return canonicalIp(candidate.slice(7));
  }
  const version = isIP(candidate);
  if (version === 4) return candidate.split('.').map(Number).join('.');
  if (version !== 6) return null;
  try {
    return new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function validHost(value) {
  if (value.length > 253 || /\s/.test(value)) return false;
  if (isIP(value)) return true;
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function tokenHash(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function decimalExceeds(value, maximum) {
  const maximumText = maximum.toString();
  return value.length > maximumText.length
    || (value.length === maximumText.length && value > maximumText);
}

function emit(log, event) {
  try {
    log(event);
  } catch {
    // Logging must never affect signing availability.
  }
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections?.(), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

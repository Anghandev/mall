const AMAP_ENDPOINT = 'https://restapi.amap.com/v3/geocode/regeo';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

const AMAP_CONFIG = Object.freeze({
  prefix: 'AMAP',
  keyNames: ['AMAP_WEB_SERVICE_KEY', 'AMAP_API_KEY'],
  timeoutName: 'AMAP_TIMEOUT_MS'
});

const WEBHOOKS = Object.freeze({
  electronicWaybill: Object.freeze({
    prefix: 'ELECTRONIC_WAYBILL',
    operation: 'electronic-waybill.create',
    urlNames: ['ELECTRONIC_WAYBILL_WEBHOOK_URL', 'WAYBILL_WEBHOOK_URL'],
    tokenNames: ['ELECTRONIC_WAYBILL_WEBHOOK_TOKEN', 'WAYBILL_WEBHOOK_TOKEN'],
    timeoutName: 'ELECTRONIC_WAYBILL_TIMEOUT_MS'
  }),
  shipment: Object.freeze({
    prefix: 'SHIPMENT',
    operation: 'shipment.query',
    urlNames: ['SHIPMENT_WEBHOOK_URL'],
    tokenNames: ['SHIPMENT_WEBHOOK_TOKEN'],
    timeoutName: 'SHIPMENT_TIMEOUT_MS'
  }),
  print: Object.freeze({
    prefix: 'PRINT',
    operation: 'print.submit',
    urlNames: ['PRINT_WEBHOOK_URL', 'CLOUD_PRINT_WEBHOOK_URL'],
    tokenNames: ['PRINT_WEBHOOK_TOKEN', 'CLOUD_PRINT_WEBHOOK_TOKEN'],
    timeoutName: 'PRINT_TIMEOUT_MS'
  }),
  notification: Object.freeze({
    prefix: 'NOTIFICATION',
    operation: 'notification.send',
    urlNames: ['NOTIFICATION_WEBHOOK_URL'],
    tokenNames: ['NOTIFICATION_WEBHOOK_TOKEN'],
    timeoutName: 'NOTIFICATION_TIMEOUT_MS'
  }),
  orderSigning: Object.freeze({
    prefix: 'ORDER_SIGNING',
    operation: 'order-authorization.sign',
    urlNames: ['ORDER_SIGNING_WEBHOOK_URL'],
    tokenNames: ['ORDER_SIGNING_WEBHOOK_TOKEN'],
    timeoutName: 'ORDER_SIGNING_TIMEOUT_MS'
  })
});

const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'apikey',
  'password',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
  'signature'
]);

export function integrationReadiness(env = process.env) {
  const source = requireEnv(env);
  const services = {
    amap: inspectAmap(source),
    electronicWaybill: inspectWebhook(WEBHOOKS.electronicWaybill, source),
    shipment: inspectWebhook(WEBHOOKS.shipment, source),
    print: inspectWebhook(WEBHOOKS.print, source),
    notification: inspectWebhook(WEBHOOKS.notification, source),
    orderSigning: inspectWebhook(WEBHOOKS.orderSigning, source)
  };

  return {
    ready: Object.values(services).every((service) => service.ready),
    ...services
  };
}

export async function reverseGeocode(coordinates, env = process.env) {
  const source = requireEnv(env);
  const longitude = requireCoordinate(coordinates?.longitude, -180, 180, 'INVALID_LONGITUDE');
  const latitude = requireCoordinate(coordinates?.latitude, -90, 90, 'INVALID_LATITUDE');
  const key = firstConfigured(source, AMAP_CONFIG.keyNames);
  if (!key) throw integrationError('AMAP_NOT_CONFIGURED', 503, { missing: [AMAP_CONFIG.keyNames[0]] });

  const url = new URL(AMAP_ENDPOINT);
  url.searchParams.set('key', key.value);
  url.searchParams.set('location', `${longitude},${latitude}`);
  url.searchParams.set('output', 'json');
  url.searchParams.set('extensions', 'base');

  const response = await requestJson({
    prefix: AMAP_CONFIG.prefix,
    url,
    method: 'GET',
    timeoutMs: timeoutFor(AMAP_CONFIG, source),
    secrets: [key.value]
  });
  const body = response.body;
  const status = String(body.status ?? '');
  const infocode = String(body.infocode ?? '');
  if (status !== '1' || (infocode && infocode !== '10000')) {
    throw integrationError('AMAP_PROVIDER_ERROR', 502, {
      raw: summarizeProviderResponse(body, [key.value])
    });
  }

  const regeo = isRecord(body.regeocode) ? body.regeocode : null;
  const component = regeo && isRecord(regeo.addressComponent) ? regeo.addressComponent : null;
  const adcode = String(component?.adcode ?? '');
  if (!/^\d{6}$/.test(adcode)) {
    throw integrationError('AMAP_INVALID_RESPONSE', 502, {
      raw: summarizeProviderResponse(body, [key.value])
    });
  }

  return {
    provider: 'amap',
    status: 'succeeded',
    longitude,
    latitude,
    adcode,
    regionCode: adcode,
    formattedAddress: textComponent(regeo.formatted_address),
    country: textComponent(component.country),
    province: textComponent(component.province),
    city: textComponent(component.city),
    district: textComponent(component.district),
    township: textComponent(component.township)
  };
}

export async function createElectronicWaybill(payload, env = process.env) {
  requirePayload(payload, 'ELECTRONIC_WAYBILL_INVALID_PAYLOAD');
  return callWebhook(WEBHOOKS.electronicWaybill, payload, env);
}

export async function queryShipment(trackingNo, carrier, env = process.env) {
  const normalizedTrackingNo = requireText(trackingNo, 'INVALID_TRACKING_NO', 128);
  const normalizedCarrier = requireText(carrier, 'INVALID_CARRIER', 80);
  return callWebhook(WEBHOOKS.shipment, {
    trackingNo: normalizedTrackingNo,
    carrier: normalizedCarrier
  }, env);
}

export async function submitPrintJob(job, env = process.env) {
  requirePayload(job, 'PRINT_INVALID_JOB');
  const requestedCopies = job.copies === undefined || job.copies === null
    ? 1
    : Number(job.copies);
  if (!Number.isInteger(requestedCopies) || requestedCopies < 1 || requestedCopies > 10) {
    throw integrationError('PRINT_INVALID_COPIES', 400);
  }
  const copies = isPickupPrintJob(job) ? 2 : requestedCopies;
  return callWebhook(WEBHOOKS.print, { ...job, copies }, env);
}

export async function sendNotification(notification, env = process.env) {
  requirePayload(notification, 'NOTIFICATION_INVALID_PAYLOAD');
  return callWebhook(WEBHOOKS.notification, notification, env);
}

export async function signOrderAuthorization(payload, env = process.env) {
  requirePayload(payload, 'ORDER_SIGNING_INVALID_PAYLOAD');
  const source = requireEnv(env);
  const definition = WEBHOOKS.orderSigning;
  const config = requireWebhookConfig(definition, source);
  const response = await requestJson({
    prefix: definition.prefix,
    operation: definition.operation,
    url: config.url,
    method: 'POST',
    token: config.token,
    payload,
    timeoutMs: config.timeoutMs,
    secrets: [config.token]
  });
  if (providerRejected(response.body)) throw integrationError('ORDER_SIGNING_PROVIDER_ERROR', 502);
  const containers = responseContainers(response.body);
  const signature = scalarText(firstResponseValue(containers, ['signature']), [config.token]);
  const signer = scalarText(firstResponseValue(containers, ['signer', 'signerAddress', 'address']), [config.token]);
  const authorizationDigest = scalarText(firstResponseValue(containers, ['authorizationDigest', 'digest', 'hash']), [config.token]);
  if (!signature || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature)) throw integrationError('ORDER_SIGNING_INVALID_SIGNATURE', 502);
  if (!signer || !/^0x[0-9a-fA-F]{40}$/.test(signer)) throw integrationError('ORDER_SIGNING_INVALID_SIGNER', 502);
  if (!authorizationDigest || !/^0x[0-9a-fA-F]{64}$/.test(authorizationDigest)) throw integrationError('ORDER_SIGNING_INVALID_DIGEST', 502);
  return { signature, signer, authorizationDigest };
}

async function callWebhook(definition, payload, env) {
  const source = requireEnv(env);
  const config = requireWebhookConfig(definition, source);
  const response = await requestJson({
    prefix: definition.prefix,
    operation: definition.operation,
    url: config.url,
    method: 'POST',
    token: config.token,
    payload,
    timeoutMs: config.timeoutMs,
    secrets: [config.token]
  });

  if (providerRejected(response.body)) {
    throw integrationError(`${definition.prefix}_PROVIDER_ERROR`, 502, {
      raw: summarizeProviderResponse(response.body, [config.token])
    });
  }

  return normalizeProviderResponse(response.body, response.httpStatus, [config.token]);
}

async function requestJson({ prefix, operation, url, method, token, payload, timeoutMs, secrets = [] }) {
  let serializedBody;
  if (payload !== undefined) {
    try {
      serializedBody = JSON.stringify(payload);
    } catch {
      throw integrationError(`${prefix}_INVALID_PAYLOAD`, 400);
    }
    if (serializedBody === undefined) throw integrationError(`${prefix}_INVALID_PAYLOAD`, 400);
  }

  const headers = { accept: 'application/json' };
  if (serializedBody !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (operation) headers['x-24k-operation'] = operation;

  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: serializedBody,
      signal,
      redirect: 'error'
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw integrationError(`${prefix}_TIMEOUT`, 504);
    }
    throw integrationError(`${prefix}_NETWORK_ERROR`, 502);
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw integrationError(`${prefix}_TIMEOUT`, 504);
    }
    throw integrationError(`${prefix}_RESPONSE_READ_ERROR`, 502);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw integrationError(`${prefix}_HTTP_ERROR`, 502, {
        httpStatus: response.status,
        raw: redactString(text, secrets).slice(0, 500)
      });
    }
    throw integrationError(`${prefix}_INVALID_JSON`, 502);
  }

  if (!response.ok) {
    throw integrationError(`${prefix}_HTTP_ERROR`, 502, {
      httpStatus: response.status,
      raw: summarizeProviderResponse(body, secrets)
    });
  }
  if (!isRecord(body)) throw integrationError(`${prefix}_INVALID_RESPONSE`, 502);

  return { body, httpStatus: response.status };
}

function inspectAmap(env) {
  const key = firstConfigured(env, AMAP_CONFIG.keyNames);
  const missing = key ? [] : [AMAP_CONFIG.keyNames[0]];
  let error;
  try {
    timeoutFor(AMAP_CONFIG, env);
  } catch (cause) {
    error = cause.code || 'AMAP_INVALID_CONFIGURATION';
  }
  return readinessResult(missing, error);
}

function inspectWebhook(definition, env) {
  const urlEntry = firstConfigured(env, definition.urlNames);
  const tokenEntry = firstConfigured(env, definition.tokenNames);
  const missing = [];
  if (!urlEntry) missing.push(definition.urlNames[0]);
  if (!tokenEntry) missing.push(definition.tokenNames[0]);

  let error;
  try {
    if (urlEntry) validateProviderUrl(urlEntry.value, definition.prefix, env);
    timeoutFor(definition, env);
  } catch (cause) {
    error = cause.code || `${definition.prefix}_INVALID_CONFIGURATION`;
  }
  return readinessResult(missing, error);
}

function readinessResult(missing, error) {
  return {
    ready: missing.length === 0 && !error,
    missing,
    ...(error ? { error } : {})
  };
}

function requireWebhookConfig(definition, env) {
  const urlEntry = firstConfigured(env, definition.urlNames);
  const tokenEntry = firstConfigured(env, definition.tokenNames);
  if (!urlEntry || !tokenEntry) {
    const missing = [];
    if (!urlEntry) missing.push(definition.urlNames[0]);
    if (!tokenEntry) missing.push(definition.tokenNames[0]);
    throw integrationError(`${definition.prefix}_NOT_CONFIGURED`, 503, { missing });
  }
  return {
    url: validateProviderUrl(urlEntry.value, definition.prefix, env),
    token: tokenEntry.value,
    timeoutMs: timeoutFor(definition, env)
  };
}

function validateProviderUrl(value, prefix, env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw integrationError(`${prefix}_INVALID_URL`, 503);
  }

  if (!url.hostname || url.username || url.password || url.hash) {
    throw integrationError(`${prefix}_INVALID_URL`, 503);
  }
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  const localDevelopmentUrl = ['development', 'test'].includes(nodeEnv) && isLocalhost(url.hostname);
  if (url.protocol === 'http:' && localDevelopmentUrl) {
    return url;
  }
  if (url.protocol !== 'https:') throw integrationError(`${prefix}_INSECURE_URL`, 503);
  if (!localDevelopmentUrl && isUnsafeProviderHost(url.hostname)) {
    throw integrationError(`${prefix}_UNSAFE_URL`, 503);
  }
  return url;
}

function isLocalhost(hostname) {
  const host = normalizedHostname(hostname);
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '::1';
}

function isUnsafeProviderHost(hostname) {
  const host = normalizedHostname(hostname);
  if (isLocalhost(host)) return true;
  if (isIpv4Address(host)) return isNonPublicIpv4(host);
  if (host.includes(':')) return true;
  if (!host.includes('.')) return true;
  return ['.internal', '.local', '.lan', '.home', '.corp'].some((suffix) => host.endsWith(suffix));
}

function normalizedHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isIpv4Address(hostname) {
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isNonPublicIpv4(hostname) {
  const [a, b, c] = hostname.split('.').map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function timeoutFor(definition, env) {
  const configured = firstConfigured(env, [definition.timeoutName, 'INTEGRATION_TIMEOUT_MS']);
  if (!configured) return DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number(configured.value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw integrationError(`${definition.prefix}_INVALID_TIMEOUT`, 503);
  }
  return timeoutMs;
}

function normalizeProviderResponse(body, httpStatus, secrets) {
  const containers = responseContainers(body);
  const providerJobIdValue = firstResponseValue(containers, [
    'providerJobId', 'provider_job_id', 'jobId', 'job_id', 'requestId', 'request_id',
    'taskId', 'task_id', 'messageId', 'message_id', 'waybillNo', 'waybill_no',
    'trackingNo', 'tracking_no', 'id'
  ]);
  const statusValue = firstResponseValue(containers, [
    'status', 'state', 'jobStatus', 'job_status', 'shipmentStatus', 'shipment_status',
    'deliveryStatus', 'delivery_status'
  ]);
  const successValue = firstResponseValue(containers, ['success', 'ok']);

  const safeStatusValue = typeof statusValue === 'string'
    ? redactString(statusValue, secrets)
    : statusValue;
  let status = normalizeProviderStatus(safeStatusValue);
  if (status === 'unknown' && successValue === true) status = 'succeeded';
  if (status === 'unknown' && httpStatus === 202) status = 'accepted';

  return {
    providerJobId: scalarText(providerJobIdValue, secrets),
    status,
    raw: summarizeProviderResponse(body, secrets)
  };
}

function responseContainers(body) {
  return [body, body.data, body.result, body.payload].filter(isRecord);
}

function firstResponseValue(containers, keys) {
  for (const container of containers) {
    for (const key of keys) {
      if (Object.hasOwn(container, key) && container[key] !== undefined && container[key] !== null) {
        return container[key];
      }
    }
  }
  return undefined;
}

function normalizeProviderStatus(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
  const status = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!status) return 'unknown';
  const aliases = {
    ok: 'succeeded',
    success: 'succeeded',
    successful: 'succeeded',
    complete: 'succeeded',
    completed: 'succeeded',
    queued: 'accepted',
    submitted: 'accepted',
    received: 'accepted',
    transit: 'in_transit',
    shipping: 'in_transit',
    signed: 'delivered',
    sign: 'delivered',
    rejected: 'failed',
    error: 'failed',
    canceled: 'cancelled'
  };
  return aliases[status] || status;
}

function providerRejected(body) {
  const containers = responseContainers(body);
  const success = firstResponseValue(containers, ['success', 'ok']);
  if (success === false) return true;

  const error = firstResponseValue(containers, ['error']);
  if (error !== undefined && error !== null && error !== '' && error !== false) return true;
  const errors = firstResponseValue(containers, ['errors']);
  if (Array.isArray(errors) && errors.length > 0) return true;

  const errorCode = firstResponseValue(containers, ['errorCode', 'error_code', 'errcode', 'errno']);
  return errorCode !== undefined
    && errorCode !== null
    && errorCode !== ''
    && errorCode !== 0
    && errorCode !== '0';
}

function summarizeProviderResponse(value, secrets) {
  return sanitizeValue(value, secrets, 0);
}

function sanitizeValue(value, secrets, depth) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, secrets).slice(0, 500);
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    const result = value.slice(0, 20).map((entry) => sanitizeValue(entry, secrets, depth + 1));
    if (value.length > 20) result.push(`[TRUNCATED ${value.length - 20} ITEMS]`);
    return result;
  }
  if (!isRecord(value)) return String(value).slice(0, 100);

  const result = {};
  const entries = Object.entries(value);
  for (const [key, entry] of entries.slice(0, 40)) {
    const redactedKey = redactString(key, secrets).slice(0, 100);
    const safeKey = ['__proto__', 'prototype', 'constructor'].includes(redactedKey)
      ? `[${redactedKey}]`
      : redactedKey;
    if (isSecretField(key)) result[safeKey] = '[REDACTED]';
    else result[safeKey] = sanitizeValue(entry, secrets, depth + 1);
  }
  if (entries.length > 40) result.__truncatedKeys = entries.length - 40;
  return result;
}

function isSecretField(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SECRET_FIELD_NAMES.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('secret');
}

function redactString(value, secrets) {
  let result = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(String(secret)).join('[REDACTED]');
  }
  return result;
}

function scalarText(value, secrets) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = redactString(String(value).trim(), secrets).slice(0, 256);
  return text || null;
}

function isPickupPrintJob(job) {
  return [job.fulfillmentMode, job.type, job.kind, job.documentType]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .some((value) => value === 'pickup' || value.startsWith('pickup_') || value.endsWith('_pickup'));
}

function requireCoordinate(value, min, max, code) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw integrationError(code, 400);
  }
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < min || coordinate > max) {
    throw integrationError(code, 400);
  }
  return coordinate;
}

function requireText(value, code, maxLength) {
  if (typeof value !== 'string') throw integrationError(code, 400);
  const text = value.trim();
  if (!text || text.length > maxLength) throw integrationError(code, 400);
  return text;
}

function requirePayload(value, code) {
  if (!isRecord(value)) throw integrationError(code, 400);
}

function textComponent(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function firstConfigured(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return { name, value: normalized };
  }
  return null;
}

function requireEnv(env) {
  if (!env || typeof env !== 'object') throw integrationError('INTEGRATION_ENV_INVALID', 500);
  return env;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integrationError(code, statusCode, details) {
  const error = new Error(code);
  error.name = 'IntegrationError';
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

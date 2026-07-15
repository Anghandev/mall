import {
  artifactVersion,
  seckillStates,
  type RealtimeEventEnvelope,
  type RealtimeEventPage,
  type SeckillSessionHistoryPage,
  type SeckillSessionProjection,
} from '@abu24k/core-artifacts';
import websocketProtocol from '@abu24k/core-artifacts/websocket';
import { CoreApiError, requestCoreJson } from './coreApi';

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const amountPattern = /^(0|[1-9][0-9]*)$/;
const coreOrigin = (import.meta.env.VITE_CORE_API_ORIGIN ?? '').trim().replace(/\/$/, '');

export type SeckillPageQuery = Readonly<{ cursor?: string; limit?: number }>;

export async function fetchCurrentSeckillSession(signal?: AbortSignal): Promise<SeckillSessionProjection> {
  const body = await requestCoreJson('/v2/seckill/sessions/current', signal ? { signal } : {});
  if (!isSeckillSession(body)) throw invalid('Current seckill session does not match the coordinated generated type');
  return body;
}

export async function fetchSeckillSessionHistory(query: SeckillPageQuery = {}, signal?: AbortSignal): Promise<SeckillSessionHistoryPage> {
  const body = await requestCoreJson(`/v2/seckill/sessions/history${queryString(query)}`, signal ? { signal } : {});
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isSeckillSession) || (body.nextCursor !== null && !isCursor(body.nextCursor))) {
    throw invalid('Seckill history does not match the coordinated generated type');
  }
  return body as unknown as SeckillSessionHistoryPage;
}

export async function fetchSeckillSessionEvents(sessionId: string, query: SeckillPageQuery = {}, signal?: AbortSignal): Promise<RealtimeEventPage> {
  requireSessionId(sessionId);
  const body = await requestCoreJson(`/v2/seckill/sessions/${encodeURIComponent(sessionId)}/events${queryString(query)}`, signal ? { signal } : {});
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every((item) => isRealtimeEvent(item, sessionId)) || !isCursor(body.nextCursor)) {
    throw invalid('Seckill event replay does not match the coordinated generated type');
  }
  return body as unknown as RealtimeEventPage;
}

type RealtimeSocket = {
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type RealtimeHandlers = Readonly<{
  onOpen(): void;
  onEvent(event: RealtimeEventEnvelope): void;
  onError(error: CoreApiError): void;
  onClose(code: number, reason: string): void;
}>;

export function subscribeSeckillEvents(
  sessionId: string,
  cursor: string,
  handlers: RealtimeHandlers,
  socketFactory: (url: string) => RealtimeSocket = (url) => new WebSocket(url),
) {
  requireSessionId(sessionId);
  requireCursor(cursor);
  const socket = socketFactory(seckillWebSocketUrl(sessionId, cursor));
  let lastCursor = BigInt(cursor);
  const acceptedEventIds = new Set<string>();

  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (message) => {
    try {
      const event = parseRealtimeEvent(message.data, sessionId);
      if (acceptedEventIds.has(event.eventId)) return;
      const nextCursor = BigInt(event.cursor);
      if (nextCursor <= lastCursor) throw invalid('Realtime seckill cursor is not strictly increasing');
      acceptedEventIds.add(event.eventId);
      lastCursor = nextCursor;
      handlers.onEvent(event);
    } catch (cause) {
      handlers.onError(cause instanceof CoreApiError ? cause : invalid('Realtime seckill payload is not valid JSON'));
      socket.close(4403, 'Protocol violation');
    }
  };
  socket.onerror = () => handlers.onError(new CoreApiError({ code: 'ExternalBlocked', message: 'Seckill realtime connection failed', status: 503 }));
  socket.onclose = (event) => handlers.onClose(event.code, event.reason);

  return {
    close() {
      socket.onclose = null;
      socket.close(1000, 'Admin view closed');
    },
  };
}

export function seckillWebSocketUrl(sessionId: string, cursor = '0', pageOrigin = window.location.origin) {
  requireSessionId(sessionId);
  requireCursor(cursor);
  if (websocketProtocol.publicationStatus !== 'AVAILABLE' || typeof websocketProtocol.endpoint !== 'string') {
    throw new CoreApiError({ code: 'ConfigurationRequired', message: 'Coordinated WebSocket protocol is unavailable', status: 503 });
  }
  const url = new URL(websocketProtocol.endpoint, new URL(coreOrigin || pageOrigin, pageOrigin));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('artifactVersion', artifactVersion);
  url.searchParams.set('channel', `seckill:${sessionId.toLowerCase()}`);
  url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function parseRealtimeEvent(value: unknown, sessionId: string): RealtimeEventEnvelope {
  let body = value;
  if (typeof value === 'string') {
    try { body = JSON.parse(value) as unknown; }
    catch { throw invalid('Realtime seckill payload is not valid JSON'); }
  }
  if (!isRealtimeEvent(body, sessionId)) throw invalid('Realtime seckill event does not match the coordinated protocol');
  return body;
}

function queryString(query: SeckillPageQuery) {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) { requireCursor(query.cursor); params.set('cursor', query.cursor); }
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw invalid('Seckill page limit must be between 1 and 100');
    params.set('limit', String(query.limit));
  }
  return params.size ? `?${params}` : '';
}

function isSeckillSession(value: unknown): value is SeckillSessionProjection {
  if (!isRecord(value) || value.artifactVersion !== artifactVersion || !bytes32Pattern.test(String(value.sessionId))) return false;
  if (!amountPattern.test(String(value.policyVersion)) || typeof value.merchantId !== 'string' || !value.merchantId) return false;
  if (!isRecord(value.product)
    || !nonEmpty(value.product, ['productId', 'skuId', 'title'])
    || !isRecord(value.product.metadata)
    || !isRecord(value.product.attributes)
    || !amountPattern.test(String(value.product.seckillListPriceUsdt))) return false;
  if (!seckillStates.includes(value.phase as never) || !seckillStates.includes(value.storedPhase as never)) return false;
  if (!['serverTime', 'startsAt', 'mainDeadline', 'relayDeadline', 'settlementEarliestAt', 'settlementDeadline'].every((field) => isDateTime(value[field]))) return false;
  const timers = value.timers;
  const inventory = value.inventory;
  if (!isRecord(timers) || !['mainDurationSeconds', 'relayInitialSeconds', 'relayIncrementSeconds', 'relayCapSeconds'].every((field) => positiveInteger(timers[field]))) return false;
  if (!isRecord(inventory) || !['total', 'sold', 'reserved', 'available'].every((field) => amountPattern.test(String(inventory[field])))) return false;
  return amountPattern.test(String(value.prizePoolUsdt))
    && (value.lastBuyerWallet === null || addressPattern.test(String(value.lastBuyerWallet)))
    && (value.winnerWallet === null || addressPattern.test(String(value.winnerWallet)))
    && isRecord(value.snapshot)
    && Array.isArray(value.allowedActions)
    && value.allowedActions.every((item) => typeof item === 'string' && item.length > 0);
}

function isRealtimeEvent(value: unknown, sessionId: string): value is RealtimeEventEnvelope {
  return isRecord(value)
    && value.artifactVersion === artifactVersion
    && value.protocolVersion === 1
    && typeof value.eventId === 'string'
    && value.eventId.length > 0
    && value.channel === `seckill:${sessionId.toLowerCase()}`
    && isCursor(value.cursor)
    && value.eventType === 'SeckillRelayExtended'
    && value.resourceType === 'SECKILL_SESSION'
    && String(value.resourceId).toLowerCase() === sessionId.toLowerCase()
    && bytes32Pattern.test(String(value.resourceId))
    && isDateTime(value.occurredAt)
    && value.finality === 'FINAL'
    && isRecord(value.payload);
}

function requireSessionId(value: string) {
  if (!bytes32Pattern.test(value)) throw invalid('Seckill session ID must be bytes32');
}

function requireCursor(value: string) {
  if (!isCursor(value)) throw invalid('Seckill cursor must be a canonical safe integer');
}

function isCursor(value: unknown) {
  return typeof value === 'string' && amountPattern.test(value) && Number.isSafeInteger(Number(value));
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isDateTime(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmpty(value: Readonly<Record<string, unknown>>, fields: readonly string[]) {
  return fields.every((field) => typeof value[field] === 'string' && String(value[field]).length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
  return new CoreApiError({ code: 'InvalidResponse', message, status: 502 });
}

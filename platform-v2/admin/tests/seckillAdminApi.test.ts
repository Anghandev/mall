import { artifactVersion } from '@abu24k/core-artifacts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCurrentSeckillSession,
  fetchSeckillSessionEvents,
  fetchSeckillSessionHistory,
  parseRealtimeEvent,
  seckillWebSocketUrl,
  subscribeSeckillEvents,
} from '../src/seckillAdminApi';

afterEach(() => vi.unstubAllGlobals());

describe('seckill admin coordinated Core client', () => {
  it('uses only the published current, history and replay operations', async () => {
    const session = seckillSession();
    const event = realtimeEvent(session.sessionId);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/current')) return jsonResponse(session);
      if (url.includes('/history')) return jsonResponse({ items: [session], nextCursor: '20' });
      return jsonResponse({ items: [event], nextCursor: '8' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCurrentSeckillSession()).resolves.toMatchObject({ phase: 'LIVE' });
    await expect(fetchSeckillSessionHistory({ cursor: '10', limit: 20 })).resolves.toMatchObject({ nextCursor: '20' });
    await expect(fetchSeckillSessionEvents(session.sessionId, { cursor: '7', limit: 100 })).resolves.toMatchObject({ nextCursor: '8' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/v2/seckill/sessions/current',
      '/v2/seckill/sessions/history?cursor=10&limit=20',
      `/v2/seckill/sessions/${session.sessionId}/events?cursor=7&limit=100`,
    ]);
  });

  it('binds WebSocket artifact, channel and resume cursor to the published protocol', () => {
    const sessionId = hash('a');
    const url = new URL(seckillWebSocketUrl(sessionId, '19', 'https://admin.abu24k.test'));

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v2/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({ artifactVersion, channel: `seckill:${sessionId}`, cursor: '19' });
  });

  it('rejects mismatched artifacts and non-final realtime events', () => {
    const sessionId = hash('a');
    expect(() => parseRealtimeEvent({ ...realtimeEvent(sessionId), artifactVersion: 'stale' }, sessionId)).toThrow(/coordinated protocol/);
    expect(() => parseRealtimeEvent({ ...realtimeEvent(sessionId), finality: 'MINED' }, sessionId)).toThrow(/coordinated protocol/);
  });

  it('deduplicates event IDs and closes on a non-increasing unseen cursor', () => {
    const sessionId = hash('a');
    const socket = new TestSocket();
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeSeckillEvents(sessionId, '7', { onOpen: vi.fn(), onEvent, onError, onClose: vi.fn() }, () => socket);
    const accepted = realtimeEvent(sessionId);

    socket.message(accepted);
    socket.message(accepted);
    socket.message({ ...accepted, eventId: 'event-2' });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'InvalidResponse' }));
    expect(socket.closedWith).toEqual([4403, 'Protocol violation']);
  });
});

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function hash(digit: string) { return `0x${digit.repeat(64)}`; }
function seckillSession() { return { artifactVersion, sessionId: hash('a'), policyVersion: '2', merchantId: 'merchant-1', product: { productId: 'product-1', skuId: 'sku-1', title: '24K session', metadata: {}, attributes: {}, seckillListPriceUsdt: '88' }, phase: 'LIVE', storedPhase: 'LIVE', serverTime: '2026-07-15T05:00:00.000Z', startsAt: '2026-07-15T05:00:00.000Z', mainDeadline: '2026-07-15T06:00:00.000Z', relayDeadline: '2026-07-15T05:01:00.000Z', settlementEarliestAt: '2026-07-15T05:06:00.000Z', settlementDeadline: '2026-07-15T05:11:00.000Z', timers: { mainDurationSeconds: 3600, relayInitialSeconds: 60, relayIncrementSeconds: 30, relayCapSeconds: 60 }, inventory: { total: '100', sold: '5', reserved: '2', available: '93' }, prizePoolUsdt: '9', lastBuyerWallet: null, winnerWallet: null, snapshot: {}, allowedActions: [] }; }
function realtimeEvent(sessionId: string) { return { artifactVersion, protocolVersion: 1, eventId: 'event-1', channel: `seckill:${sessionId}`, cursor: '8', eventType: 'SeckillRelayExtended', resourceType: 'SECKILL_SESSION', resourceId: sessionId, occurredAt: '2026-07-15T05:00:30.000Z', finality: 'FINAL', payload: {} }; }

class TestSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedWith: [number | undefined, string | undefined] | null = null;

  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  close(code?: number, reason?: string) { this.closedWith = [code, reason]; }
}

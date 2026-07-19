import type { CoreClient } from '../src/core-client';
import { createSeckillRealtimeClient, type SeckillRealtimeState } from '../src/seckill-realtime';
import { relayEvent, seckillSessionId } from './seckill-fixtures';

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  serverClose(code: number, reason = '') {
    this.onclose?.({ code, reason });
  }
}

describe('seckill realtime consumer', () => {
  it('replays HTTP, deduplicates event IDs and reconnects from the last accepted cursor', async () => {
    const first = relayEvent('1');
    const second = relayEvent('2');
    const listEvents = vi.fn<CoreClient['listSeckillSessionEvents']>()
      .mockResolvedValueOnce({ items: [first], nextCursor: '1' })
      .mockResolvedValueOnce({ items: [], nextCursor: '2' });
    const sockets: Array<{ url: string; socket: FakeSocket }> = [];
    const accepted: string[] = [];
    const states: SeckillRealtimeState[] = [];
    const client = createSeckillRealtimeClient({ listSeckillSessionEvents: listEvents } as unknown as CoreClient, {
      baseUrl: '/core',
      reconnectDelayMs: 0,
      createSocket(url) {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
    });

    const subscription = client.subscribe(seckillSessionId, {
      onEvent: (event) => accepted.push(event.eventId),
      onState: (state) => states.push(state),
      onError: vi.fn(),
      onArtifactMismatch: vi.fn(),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.socket.open();
    sockets[0]!.socket.message(first);
    sockets[0]!.socket.message(second);
    expect(accepted).toEqual([first.eventId, second.eventId]);

    sockets[0]!.socket.serverClose(1012, 'restart');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(listEvents).toHaveBeenLastCalledWith(seckillSessionId, '2', 100);
    expect(new URL(sockets[1]!.url).searchParams.get('cursor')).toBe('2');
    expect(new URL(sockets[1]!.url).searchParams.get('channel')).toBe(`seckill:${seckillSessionId}`);
    expect(new URL(sockets[1]!.url).pathname).toBe('/core/v2/ws');
    expect(new URL(sockets[1]!.url).pathname).not.toBe('/v2/ws');
    expect(states).toContain('LIVE');
    expect(states).toContain('RECONNECTING');
    subscription.close();
  });

  it('fails closed and reloads artifacts on close 4409', async () => {
    const socket = new FakeSocket();
    const reloadArtifact = vi.fn();
    const artifactMismatch = vi.fn();
    const states: SeckillRealtimeState[] = [];
    const core = {
      listSeckillSessionEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: '0' }),
    } as unknown as CoreClient;
    const client = createSeckillRealtimeClient(core, {
      baseUrl: 'https://core.mall.test',
      reconnectDelayMs: 0,
      createSocket: () => socket,
      reloadArtifact,
    });

    client.subscribe(seckillSessionId, {
      onEvent: vi.fn(),
      onState: (state) => states.push(state),
      onError: vi.fn(),
      onArtifactMismatch: artifactMismatch,
    });
    await vi.waitFor(() => expect(socket.onclose).not.toBeNull());
    socket.serverClose(4409, 'Artifact version mismatch');

    expect(states.at(-1)).toBe('ARTIFACT_MISMATCH');
    expect(artifactMismatch).toHaveBeenCalledOnce();
    expect(reloadArtifact).toHaveBeenCalledOnce();
  });

  it('rejects a non-final or unknown WebSocket event before delivery', async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const onError = vi.fn();
    const core = {
      listSeckillSessionEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: '0' }),
    } as unknown as CoreClient;
    const subscription = createSeckillRealtimeClient(core, {
      baseUrl: 'https://core.mall.test',
      reconnectDelayMs: 60_000,
      createSocket: () => socket,
    }).subscribe(seckillSessionId, {
      onEvent,
      onState: vi.fn(),
      onError,
      onArtifactMismatch: vi.fn(),
    });
    await vi.waitFor(() => expect(socket.onmessage).not.toBeNull());
    socket.message({ ...relayEvent(), finality: 'PENDING' });

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    subscription.close();
  });
});

import { artifactVersion, type RealtimeEventEnvelope } from '@abu24k/core-artifacts';
import websocketProtocol from '@abu24k/core-artifacts/websocket';

import { CoreClientError, parseRealtimeEvent, type CoreClient } from './core-client';

export type SeckillRealtimeState =
  | 'REPLAYING'
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'FAIL_CLOSED'
  | 'ARTIFACT_MISMATCH';

export interface SeckillRealtimeHandlers {
  onEvent(event: RealtimeEventEnvelope): void;
  onState(state: SeckillRealtimeState): void;
  onError(error: Error): void;
  onArtifactMismatch(): void;
}

export interface SeckillRealtimeSubscription {
  close(): void;
}

export interface SeckillRealtimeClient {
  subscribe(sessionId: string, handlers: SeckillRealtimeHandlers): SeckillRealtimeSubscription;
}

interface RealtimeSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string) => RealtimeSocket;

export function createSeckillRealtimeClient(
  core: CoreClient,
  input: {
    baseUrl?: string;
    createSocket?: SocketFactory;
    reconnectDelayMs?: number;
    reloadArtifact?: () => void;
  } = {},
): SeckillRealtimeClient {
  const createSocket: SocketFactory = input.createSocket
    ?? ((url) => new WebSocket(url) as unknown as RealtimeSocket);
  const reconnectDelayMs = input.reconnectDelayMs ?? 1_000;
  const reloadArtifact = input.reloadArtifact ?? (() => globalThis.location?.reload());

  return {
    subscribe(sessionId, handlers) {
      let stopped = false;
      let socket: RealtimeSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let cursor = '0';
      const acceptedEventIds = new Set<string>();
      const acceptedEventOrder: string[] = [];

      void recover(false);

      return {
        close() {
          stopped = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = null;
          socket?.close(1000, 'Consumer closed');
          socket = null;
        },
      };

      async function recover(reconnecting: boolean) {
        if (stopped) return;
        handlers.onState(reconnecting ? 'RECONNECTING' : 'REPLAYING');
        try {
          await replayHttp();
          if (!stopped) connectWebSocket();
        } catch (reason) {
          failClosed(reason);
          scheduleReconnect();
        }
      }

      async function replayHttp() {
        handlers.onState('REPLAYING');
        for (;;) {
          const previousCursor = cursor;
          const page = await core.listSeckillSessionEvents(sessionId, cursor, 100);
          if (page.items.length === 0 && page.nextCursor !== previousCursor) {
            throw new CoreClientError('InvalidResponse', '空事件页擅自推进恢复游标');
          }
          for (const event of page.items) accept(event);
          if (BigInt(page.nextCursor) < BigInt(cursor)) {
            throw new CoreClientError('InvalidResponse', 'HTTP 恢复游标倒退');
          }
          cursor = page.nextCursor;
          if (page.items.length < 100 || cursor === previousCursor) return;
        }
      }

      function connectWebSocket() {
        handlers.onState('CONNECTING');
        const nextSocket = createSocket(websocketUrl(input.baseUrl, sessionId, cursor));
        socket = nextSocket;
        nextSocket.onopen = () => {
          if (!stopped) handlers.onState('LIVE');
        };
        nextSocket.onmessage = ({ data }) => {
          if (stopped) return;
          try {
            if (typeof data !== 'string') throw new CoreClientError('InvalidResponse', '实时事件不是文本帧');
            accept(parseRealtimeEvent(JSON.parse(data), sessionId));
          } catch (reason) {
            failClosed(reason);
            socket?.close(4001, 'Invalid realtime event');
            scheduleReconnect();
          }
        };
        nextSocket.onerror = () => {
          if (stopped) return;
          failClosed(new CoreClientError('NetworkUnavailable', '秒杀实时连接中断'));
          scheduleReconnect();
        };
        nextSocket.onclose = ({ code, reason }) => {
          socket = null;
          if (stopped || code === 1000) return;
          if (code === 4409) {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            handlers.onState('ARTIFACT_MISMATCH');
            handlers.onError(new CoreClientError('ArtifactVersionMismatch', reason || '实时协议版本不一致'));
            handlers.onArtifactMismatch();
            reloadArtifact();
            return;
          }
          if (code === 4403 || code === 4503) {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            handlers.onState('FAIL_CLOSED');
            handlers.onError(new CoreClientError(
              code === 4503 ? 'ConfigurationRequired' : 'Forbidden',
              reason || '秒杀实时通道拒绝连接',
            ));
            return;
          }
          scheduleReconnect();
        };
      }

      function accept(event: RealtimeEventEnvelope) {
        if (acceptedEventIds.has(event.eventId)) return;
        if (BigInt(event.cursor) <= BigInt(cursor)) {
          throw new CoreClientError('InvalidResponse', '实时事件游标未递增');
        }
        acceptedEventIds.add(event.eventId);
        acceptedEventOrder.push(event.eventId);
        if (acceptedEventOrder.length > 500) acceptedEventIds.delete(acceptedEventOrder.shift()!);
        cursor = event.cursor;
        handlers.onEvent(event);
      }

      function failClosed(reason: unknown) {
        handlers.onState('FAIL_CLOSED');
        handlers.onError(reason instanceof Error ? reason : new Error('秒杀实时同步失败'));
      }

      function scheduleReconnect() {
        if (stopped || reconnectTimer) return;
        handlers.onState('RECONNECTING');
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          socket?.close(1000, 'Recovering from HTTP cursor');
          socket = null;
          void recover(true);
        }, reconnectDelayMs);
      }
    },
  };
}

function websocketUrl(baseUrl: string | undefined, sessionId: string, cursor: string) {
  const browserOrigin = globalThis.location?.origin;
  const origin = baseUrl || browserOrigin;
  if (!origin) throw new CoreClientError('ConfigurationRequired', '缺少实时服务地址');
  if (websocketProtocol.publicationStatus !== 'AVAILABLE' || typeof websocketProtocol.endpoint !== 'string') {
    throw new CoreClientError('ConfigurationRequired', 'Core 实时协议未发布');
  }
  const url = new URL(`${origin.replace(/\/+$/, '')}${websocketProtocol.endpoint}`, browserOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('artifactVersion', artifactVersion);
  url.searchParams.set('channel', `seckill:${sessionId.toLowerCase()}`);
  url.searchParams.set('cursor', cursor);
  return url.toString();
}

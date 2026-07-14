import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { CORE_ARTIFACT_VERSION } from './enums.ts';
import { CoreError } from './errors.ts';

export interface RealtimeEventPage {
  items: unknown[];
  nextCursor: string;
}

export interface RealtimeEventSource {
  events(sessionId: string, input: { cursor?: string; limit?: number }): Promise<RealtimeEventPage>;
}

export function attachRealtimeServer(server: Server, source: RealtimeEventSource) {
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 4_096 });
  server.on('upgrade', (request, socket, head) => {
    const target = websocketTarget(request);
    if (!target) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      if (target.error) {
        client.close(target.error.code, target.error.reason);
        return;
      }
      client.on('message', () => client.close(4403, 'Server-to-client stream only'));
      void streamSeckillEvents(client, source, target.sessionId, target.cursor);
    });
  });
  server.on('close', () => {
    for (const client of websocket.clients) client.terminate();
    websocket.close();
  });
  return websocket;
}

function websocketTarget(request: IncomingMessage):
  | { sessionId: string; cursor: string; error?: undefined }
  | { sessionId: ''; cursor: '0'; error: { code: 4401 | 4403 | 4409; reason: string } }
  | undefined {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/v2/ws') return undefined;
  if (url.searchParams.get('artifactVersion') !== CORE_ARTIFACT_VERSION) {
    return { sessionId: '', cursor: '0', error: { code: 4409, reason: 'Artifact version mismatch' } };
  }
  const channel = url.searchParams.get('channel') ?? '';
  const match = channel.match(/^seckill:(0x[0-9a-fA-F]{64})$/);
  if (!match) return { sessionId: '', cursor: '0', error: { code: 4403, reason: 'Unsupported channel' } };
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
    return { sessionId: '', cursor: '0', error: { code: 4403, reason: 'Invalid cursor' } };
  }
  return { sessionId: match[1]!.toLowerCase(), cursor };
}

async function streamSeckillEvents(
  client: WebSocket,
  source: RealtimeEventSource,
  sessionId: string,
  initialCursor: string,
) {
  let cursor = initialCursor;
  while (client.readyState === WebSocket.OPEN) {
    try {
      const page = await source.events(sessionId, { cursor, limit: 100 });
      if (!/^(0|[1-9][0-9]*)$/.test(page.nextCursor)) {
        throw new CoreError('UnknownState', 'Realtime source returned an invalid cursor', 409);
      }
      for (const event of page.items) {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 1_048_576) {
          client.close(1013, 'Realtime consumer is too slow');
          return;
        }
        client.send(JSON.stringify(event));
      }
      cursor = page.nextCursor;
      if (page.items.length >= 100) continue;
      await delay(500, client);
    } catch (error) {
      const code = error instanceof CoreError && ['ConfigurationRequired', 'ExternalBlocked'].includes(error.code)
        ? 4503
        : 1011;
      client.close(code, error instanceof CoreError ? error.code : 'Realtime stream failed');
      return;
    }
  }
}

function delay(milliseconds: number, client: WebSocket) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      client.off('close', done);
      resolve();
    }
    client.once('close', done);
  });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

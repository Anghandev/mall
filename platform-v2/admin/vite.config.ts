import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vitest/config';

const CORE_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default defineConfig(({ command, mode }) => {
  const coreProxyTarget = process.env.CORE_PROXY_TARGET?.trim().replace(/\/+$/, '');
  return {
    base: '/platform/',
    ...(mode === 'production' || (command === 'serve' && coreProxyTarget) ? {
      define: { 'import.meta.env.VITE_CORE_API_ORIGIN': JSON.stringify('/core') },
    } : {}),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 4313,
      strictPort: true,
      ...(coreProxyTarget ? { proxy: coreProxy(coreProxyTarget) } : {}),
    },
    build: {
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      setupFiles: './tests/setup.ts',
    },
  };
});

function coreProxy(target: string) {
  return {
    '/core': {
      target,
      changeOrigin: true,
      ws: true,
      bypass: rejectCoreWrites,
      rewrite: (path: string) => path.replace(/^\/core/, '') || '/',
    },
  };
}

function rejectCoreWrites(request: IncomingMessage, response: ServerResponse | undefined) {
  const method = request.method?.toUpperCase() ?? 'GET';
  if (!CORE_WRITE_METHODS.has(method)) return undefined;
  if (!response) return false;
  response.statusCode = 405;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: 'READ_ONLY_CORE_PROXY', method }));
  return false;
}

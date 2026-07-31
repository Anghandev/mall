import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vitest/config';
import openApi from '@abu24k/core-artifacts/openapi';
import { merchantDeployment } from './src/bootstrap';

const CORE_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const merchantStoreOperationsId = 'virtual:merchant-store-operations';
const resolvedMerchantStoreOperationsId = `\0${merchantStoreOperationsId}`;

const merchantStoreOperations = Object.freeze({
  list: operationPath('listManagedMerchantStores', 'get'),
  create: operationPath('createMerchantStore', 'post'),
  update: operationPath('updateMerchantStore', 'put'),
  activate: operationPath('activateMerchantStore', 'post'),
  close: operationPath('closeMerchantStore', 'post'),
  exportOrders: operationPath('exportMerchantOrders', 'post'),
});

export default defineConfig(({ command }) => {
  const coreProxyTarget = process.env.CORE_PROXY_TARGET?.trim().replace(/\/+$/, '');
  return {
    base: merchantDeployment.publicBasePath,
    ...(command === 'build' || (command === 'serve' && coreProxyTarget) ? {
      define: { 'import.meta.env.VITE_CORE_API_BASE_URL': JSON.stringify(merchantDeployment.coreApiBaseUrl) },
    } : {}),
    plugins: [{
      name: 'merchant-openapi-operations',
      resolveId(id) {
        return id === merchantStoreOperationsId ? resolvedMerchantStoreOperationsId : undefined;
      },
      load(id) {
        return id === resolvedMerchantStoreOperationsId
          ? `export default ${JSON.stringify(merchantStoreOperations)};`
          : undefined;
      },
    }, react()],
    server: {
      host: '127.0.0.1',
      port: 4312,
      strictPort: true,
      ...(coreProxyTarget ? { proxy: coreProxy(coreProxyTarget) } : {}),
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      setupFiles: ['./tests/setup.ts'],
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

function operationPath(operationId: string, method: 'get' | 'post' | 'put') {
  for (const [path, entry] of Object.entries(openApi.paths)) {
    const operation = (entry as Partial<Record<typeof method, { operationId?: string }>>)[method];
    if (operation?.operationId === operationId) return path;
  }
  throw new Error(`Coordinated OpenAPI operation is missing: ${operationId}`);
}

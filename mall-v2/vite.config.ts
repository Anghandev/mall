import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const CORE_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default defineConfig(({ command }) => {
  const coreProxyTarget = process.env.CORE_PROXY_TARGET?.trim().replace(/\/+$/, '');
  return {
    base: '/mall/',
    ...(command === 'serve' && coreProxyTarget && !process.env.VITE_CORE_API_BASE_URL ? {
      define: { 'import.meta.env.VITE_CORE_API_BASE_URL': JSON.stringify('/core') },
    } : {}),
    plugins: [mallCoreArtifactBoundary(), react()],
    server: {
      host: '127.0.0.1',
      port: 4311,
      strictPort: true,
      ...(coreProxyTarget ? { proxy: coreProxy(coreProxyTarget) } : {}),
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['./tests/**/*.test.ts', './tests/**/*.test.tsx'],
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

function mallCoreArtifactBoundary(): Plugin {
  return {
    name: 'mall-core-artifact-boundary',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = id.split('?')[0] ?? id;
      if (cleanId.endsWith('/core-artifacts/openapi/openapi.json')) {
        const openApi = JSON.parse(code) as { paths: Record<string, unknown> };
        return JSON.stringify({
          paths: Object.fromEntries(
            Object.entries(openApi.paths).filter(([path]) => (
              !path.startsWith('/v2/admin/') && !path.startsWith('/v2/merchant/')
            )),
          ),
        });
      }
      if (cleanId.endsWith('/core-artifacts/coordinated-manifest.json')) {
        const manifest = JSON.parse(code) as {
          artifactVersion: string;
          deploymentAuthorized: boolean;
          capabilityStatus: Record<string, unknown>;
        };
        return JSON.stringify({
          artifactVersion: manifest.artifactVersion,
          deploymentAuthorized: manifest.deploymentAuthorized,
          capabilityStatus: Object.fromEntries(
            Object.entries(manifest.capabilityStatus).filter(([capability]) => (
              !capability.startsWith('admin') && !capability.startsWith('merchant')
              && capability !== 'takeoverCaseManagementHttp'
              && capability !== 'replacementMerchantFulfillment'
            )),
          ),
        });
      }
      return null;
    },
  };
}

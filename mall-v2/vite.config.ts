import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/mall/',
  plugins: [mallCoreArtifactBoundary(), react()],
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['./tests/**/*.test.ts', './tests/**/*.test.tsx'],
  },
});

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

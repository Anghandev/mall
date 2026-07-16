import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import openApi from '@abu24k/core-artifacts/openapi';

const merchantStoreOperationsId = 'virtual:merchant-store-operations';
const resolvedMerchantStoreOperationsId = `\0${merchantStoreOperationsId}`;

const merchantStoreOperations = Object.freeze({
  list: operationPath('listManagedMerchantStores', 'get'),
  create: operationPath('createMerchantStore', 'post'),
  update: operationPath('updateMerchantStore', 'put'),
  activate: operationPath('activateMerchantStore', 'post'),
  close: operationPath('closeMerchantStore', 'post'),
});

export default defineConfig({
  plugins: [{
    name: 'merchant-store-openapi-operations',
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
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
  },
});

function operationPath(operationId: string, method: 'get' | 'post' | 'put') {
  for (const [path, entry] of Object.entries(openApi.paths)) {
    const operation = (entry as Partial<Record<typeof method, { operationId?: string }>>)[method];
    if (operation?.operationId === operationId) return path;
  }
  throw new Error(`Coordinated OpenAPI operation is missing: ${operationId}`);
}

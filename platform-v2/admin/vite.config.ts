import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  base: '/platform/',
  ...(mode === 'production' ? {
    define: { 'import.meta.env.VITE_CORE_API_ORIGIN': JSON.stringify('/core') },
  } : {}),
  plugins: [react()],
  server: {
    proxy: {
      '/v2': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
  },
}));

import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const coreProxyTarget = process.env.CORE_PROXY_TARGET;
if (!coreProxyTarget) throw new Error('CORE_PROXY_TARGET is required for the real read-only smoke');

export default defineConfig({
  testDir: '.',
  testMatch: 'real-readonly.spec.ts',
  outputDir: '/tmp/abu24k-v2-real-readonly-results',
  reporter: 'line',
  fullyParallel: false,
  use: {
    colorScheme: 'light',
    screenshot: 'on',
    trace: 'on',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'pnpm --filter @abu24k/mall dev -- --host 127.0.0.1 --port 4311 --strictPort',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4311',
      env: { ...process.env, CORE_PROXY_TARGET: coreProxyTarget, VITE_CORE_API_BASE_URL: '/core' },
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @abu24k/merchant dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4312',
      env: { ...process.env, CORE_PROXY_TARGET: coreProxyTarget, VITE_CORE_API_BASE_URL: '/core' },
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @abu24k/platform-admin dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4313',
      env: { ...process.env, CORE_PROXY_TARGET: coreProxyTarget, VITE_CORE_API_ORIGIN: '/core' },
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

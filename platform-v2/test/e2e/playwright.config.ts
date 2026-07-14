import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  testDir: '.',
  testMatch: 'products.spec.ts',
  outputDir: '/tmp/abu24k-v2-playwright-results',
  reporter: 'line',
  fullyParallel: false,
  use: {
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @abu24k/mall dev -- --host 127.0.0.1 --port 4311 --strictPort',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4311',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @abu24k/merchant dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4312',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @abu24k/platform-admin dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:4313',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

import { defineConfig } from '@playwright/test';

const e2ePort = process.env.MALL_E2E_PORT ?? '4311';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/playwright',
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}/mall/`,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-375', use: { viewport: { width: 375, height: 844 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
    { name: 'mobile-393', use: { viewport: { width: 393, height: 852 } } },
    { name: 'mobile-430', use: { viewport: { width: 430, height: 932 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: `../scripts/node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: `http://127.0.0.1:${e2ePort}/mall/`,
    env: {
      ...process.env,
      VITE_CORE_API_BASE_URL: '/core',
    },
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

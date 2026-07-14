import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/playwright',
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4311',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-375', use: { viewport: { width: 375, height: 844 } } },
    { name: 'mobile-393', use: { viewport: { width: 393, height: 852 } } },
    { name: 'mobile-430', use: { viewport: { width: 430, height: 932 } } },
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: '../scripts/node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4311 --strictPort',
    url: 'http://127.0.0.1:4311',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

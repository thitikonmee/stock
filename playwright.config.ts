import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the real stack (embedded PostgreSQL + API + web) started by
 * `scripts/dev-stack.mjs`. Uses the locally installed Google Chrome — no browser download.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    channel: 'chrome',
    locale: 'th-TH',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev-stack.mjs',
    url: 'http://localhost:3100/login',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

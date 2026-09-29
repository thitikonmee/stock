import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the real stack (embedded PostgreSQL + API + web) started by
 * `scripts/dev-stack.mjs`. Uses the locally installed Google Chrome — no browser download.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // Default assertion timeout is 5s, tuned for a fast local machine. GitHub Actions runners are
  // noticeably slower (this suite: ~20s locally vs ~2min in CI) and a retry at the same timeout
  // doesn't help a systematically-too-tight wait — so give every `expect(...).toBeVisible()` etc.
  // real round-trip headroom instead of relying on retries to paper over it.
  expect: { timeout: 15_000 },
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

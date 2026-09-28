import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => resolve(import.meta.dirname, 'packages', name, 'src', 'index.ts');

/** Tests run against package sources (no build step needed). */
const alias = {
  '@stockos/shared': pkg('shared'),
  '@stockos/config': pkg('config'),
  '@stockos/database': pkg('database'),
  '@stockos/queue': pkg('queue'),
  '@stockos/core': pkg('core'),
  '@stockos/api': resolve(import.meta.dirname, 'apps', 'api', 'src'),
};

const dbProject = {
  globalSetup: ['tests/support/global-setup.ts'],
  hookTimeout: 180_000,
  pool: 'forks' as const,
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          ...dbProject,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          ...dbProject,
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          testTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

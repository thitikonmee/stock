import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((v) => v === 'true' || v === '1');

/**
 * Environment contract shared by every process. Services fail fast at boot when a value
 * is missing or malformed instead of failing later on first use.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'dev', 'staging', 'prod', 'test']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().default('api'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),
  DATABASE_URL_PLATFORM: z.string().url().optional(),
  DATABASE_URL_ADMIN: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().default('stockos'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(500),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  MARKETPLACE_MOCK: bool('false'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Load `.env` from the repo root (local only) without overriding real environment variables. */
export function loadDotEnv(startDir: string = process.cwd()): void {
  for (const dir of [startDir, resolve(startDir, '..'), resolve(startDir, '../..')]) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

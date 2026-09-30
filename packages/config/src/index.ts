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

  JWT_ISSUER: z.string().url().default('https://api.stockos.local'),
  JWT_AUDIENCE: z.string().default('stockos-api'),
  JWT_KID: z.string().min(1).default('local-1'),
  /** PEM (PKCS#8) EC P-256 private key file. Generate locally with `pnpm gen:keys`. */
  JWT_PRIVATE_KEY_PATH: z.string().default('.secrets/jwt-private.pem'),
  /** Optional JSON file {"kid": "<public PEM>"} of rotated-out keys still accepted for verification. */
  JWT_PREVIOUS_PUBLIC_KEYS_PATH: z.string().optional(),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_TOKEN_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(90),
  PASSWORD_ARGON2_MEMORY_KB: z.coerce.number().int().min(1024).default(65536),
  /** Proxies whose X-Forwarded-For is trusted (proxy-addr syntax: names, IPs, CIDRs). */
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  PUBLIC_WEB_BASE_URL: z.string().url().default('http://localhost:3100'),
  /** Where a marketplace's OAuth redirect lands — must be this API's own public origin. */
  PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:3000'),
  SHOPEE_PARTNER_ID: z.string().optional(),
  SHOPEE_PARTNER_KEY: z.string().optional(),
  SHOPEE_API_BASE_URL: z.string().url().default('https://partner.shopeemobile.com'),
  /** Dev/demo only: swap the adapter's transport for the in-memory fixture server instead of real
   *  Shopee (see channels.ShopeeFixtureServer) — never set true in staging/prod. */
  SHOPEE_FIXTURE_MODE: z.coerce.boolean().default(false),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('StockOS <no-reply@stockos.local>'),
  /** 32 random bytes, base64. Local only — production uses KMS envelope encryption. */
  LOCAL_MASTER_KEY_BASE64: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  /** Product image storage (docs/02 §Object storage). S3_BUCKET_UPLOADS unset = local disk under
   *  UPLOADS_LOCAL_DIR (dev, no Docker/S3 needed); set = S3-compatible bucket (AWS S3, MinIO via
   *  S3_ENDPOINT, Cloudflare R2, ...). */
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-southeast-7'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET_UPLOADS: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool('false'),
  UPLOADS_LOCAL_DIR: z.string().default('.uploads'),
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

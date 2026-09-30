import 'reflect-metadata';
import { resolve } from 'node:path';
import { loadDotEnv, loadEnv } from '@stockos/config';
import { channels, notifications } from '@stockos/core';
import { createDb } from '@stockos/database';
import { createLogger } from '@stockos/shared';
import { createApp } from './app';
import { authConfigFromEnv } from './auth-config';

async function bootstrap() {
  const repoRoot = resolve(__dirname, '..', '..', '..');
  loadDotEnv(repoRoot);
  const env = loadEnv();
  const logger = createLogger('api', env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL, { max: env.DB_POOL_MAX, applicationName: 'api' });
  const platformDb = env.DATABASE_URL_PLATFORM
    ? createDb(env.DATABASE_URL_PLATFORM, { max: 5, applicationName: 'api-platform' })
    : db;

  if (!env.SMTP_HOST && ['staging', 'prod'].includes(env.APP_ENV)) {
    throw new Error('SMTP_HOST is required in staging/prod');
  }
  if (env.SHOPEE_FIXTURE_MODE && ['staging', 'prod'].includes(env.APP_ENV)) {
    throw new Error('SHOPEE_FIXTURE_MODE must never be set in staging/prod');
  }
  const mailer: notifications.EmailSender = env.SMTP_HOST
    ? new notifications.SmtpEmailSender({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        from: env.EMAIL_FROM,
        ...(env.SMTP_USER ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD ?? '' } : {}),
      })
    : {
        // Local development without SMTP: print e-mails (including invitation links) to the log.
        send: async (message) => {
          logger.info(
            { event: 'email.dev', to: message.to, subject: message.subject },
            `\n${message.text}\n`,
          );
        },
      };

  const app = await createApp({
    db,
    platformDb,
    logger,
    auth: authConfigFromEnv(env, repoRoot),
    ...(env.SHOPEE_PARTNER_ID && env.SHOPEE_PARTNER_KEY
      ? {
          shopee: {
            partnerId: env.SHOPEE_PARTNER_ID,
            partnerKey: env.SHOPEE_PARTNER_KEY,
            baseUrl: env.SHOPEE_API_BASE_URL,
            ...(env.SHOPEE_FIXTURE_MODE ? { fetcher: demoShopeeFixture(logger).fetcher() } : {}),
          },
        }
      : {}),
    corsOrigins: env.CORS_ORIGINS,
    mailer,
    webBaseUrl: env.PUBLIC_WEB_BASE_URL,
    apiBaseUrl: env.PUBLIC_API_BASE_URL,
    trustProxy: env.TRUST_PROXY,
    storage: env.S3_BUCKET_UPLOADS
      ? {
          s3: {
            bucket: env.S3_BUCKET_UPLOADS,
            region: env.S3_REGION,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
            ...(env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID } : {}),
            ...(env.S3_SECRET_ACCESS_KEY ? { secretAccessKey: env.S3_SECRET_ACCESS_KEY } : {}),
          },
        }
      : { localDir: resolve(repoRoot, env.UPLOADS_LOCAL_DIR) },
  });
  app.enableShutdownHooks();

  const shutdown = async (signal: string) => {
    logger.info({ event: 'api.shutdown', signal }, 'shutting down');
    await app.close();
    await db.destroy();
    if (platformDb !== db) await platformDb.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(env.PORT, '0.0.0.0');
  logger.info({ event: 'api.started', port: env.PORT }, `api listening on :${env.PORT}`);
}

/** Dev/demo only (`SHOPEE_FIXTURE_MODE=true`): a couple of listings and one in-flight order so the
 *  connect → map → sync → reconcile flow has something to look at without real Shopee credentials. */
function demoShopeeFixture(logger: ReturnType<typeof createLogger>): channels.ShopeeFixtureServer {
  logger.info(
    { event: 'shopee.fixture_mode' },
    'SHOPEE_FIXTURE_MODE on: ShopeeAdapter talks to an in-memory fixture, not real Shopee',
  );
  const fixture = new channels.ShopeeFixtureServer();
  fixture.addProduct({
    itemId: 100001,
    name: 'เสื้อยืดตัวอย่าง',
    status: 'NORMAL',
    variants: [
      { modelId: 1, modelSku: 'DEMO-SKU-1', name: 'M', price: 199, stock: 15 },
      { modelId: 2, modelSku: 'DEMO-SKU-2', name: 'L', price: 199, stock: 8 },
    ],
  });
  const now = Math.floor(Date.now() / 1000);
  fixture.addOrder({
    orderSn: 'DEMOORDER1',
    status: 'READY_TO_SHIP',
    updateTime: now,
    createTime: now - 600,
    items: [
      { itemId: 100001, modelId: 1, sku: 'DEMO-SKU-1', name: 'เสื้อยืดตัวอย่าง M', quantity: 2, price: 199 },
    ],
    total: 398,
  });
  return fixture;
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

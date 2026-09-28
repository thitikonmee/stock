import 'reflect-metadata';
import { resolve } from 'node:path';
import { loadDotEnv, loadEnv } from '@stockos/config';
import { notifications } from '@stockos/core';
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

  if (!env.SMTP_HOST && ['staging', 'prod'].includes(env.APP_ENV)) {
    throw new Error('SMTP_HOST is required in staging/prod');
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
    logger,
    auth: authConfigFromEnv(env, repoRoot),
    corsOrigins: env.CORS_ORIGINS,
    mailer,
    webBaseUrl: env.PUBLIC_WEB_BASE_URL,
    trustProxy: env.TRUST_PROXY,
  });
  app.enableShutdownHooks();

  const shutdown = async (signal: string) => {
    logger.info({ event: 'api.shutdown', signal }, 'shutting down');
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(env.PORT, '0.0.0.0');
  logger.info({ event: 'api.started', port: env.PORT }, `api listening on :${env.PORT}`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

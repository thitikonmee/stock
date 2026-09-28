import 'reflect-metadata';
import { resolve } from 'node:path';
import { loadDotEnv, loadEnv } from '@stockos/config';
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

  const app = await createApp({
    db,
    logger,
    auth: authConfigFromEnv(env, repoRoot),
    corsOrigins: env.CORS_ORIGINS,
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

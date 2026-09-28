import { resolve } from 'node:path';
import { loadDotEnv, loadEnv } from '@stockos/config';
import { createDb } from '@stockos/database';
import { BullMqPublisher, OutboxRelay, type EventRoutes } from '@stockos/queue';
import { createLogger } from '@stockos/shared';

/** Event type → queues. Consumers are added per phase (stock-push in Phase 6, notifications ...). */
const ROUTES: EventRoutes = {
  StockChanged: ['stock-changed'],
};

async function main() {
  loadDotEnv(resolve(__dirname, '..', '..', '..'));
  const env = loadEnv();
  const logger = createLogger('outbox-relay', env.LOG_LEVEL);
  if (!env.DATABASE_URL_PLATFORM)
    throw new Error('DATABASE_URL_PLATFORM is required (relay reads all tenants)');

  const db = createDb(env.DATABASE_URL_PLATFORM, { max: 2, applicationName: 'outbox-relay' });
  const redis = new URL(env.REDIS_URL);
  const publisher = new BullMqPublisher(
    {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      ...(redis.password ? { password: redis.password } : {}),
    },
    ROUTES,
    env.QUEUE_PREFIX,
  );
  const relay = new OutboxRelay(db, publisher, {
    batchSize: env.OUTBOX_BATCH_SIZE,
    intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    logger,
  });

  relay.start();
  logger.info({ event: 'outbox_relay.started' }, 'outbox relay started');

  const shutdown = async () => {
    relay.stop();
    await publisher.close();
    await db.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

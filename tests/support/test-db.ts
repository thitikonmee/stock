import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';
import { createDb, type Db } from '@stockos/database';

export interface TestDatabase {
  name: string;
  /** stockos_app role — RLS enforced, like the API/worker. */
  app: Db;
  /** stockos_platform role — BYPASSRLS, for relay/cross-tenant jobs and assertions. */
  platform: Db;
  appUrl: string;
  drop(): Promise<void>;
}

/** Clone the migrated template into a fresh database for one test file. */
export async function createTestDatabase(options: { appPoolSize?: number } = {}): Promise<TestDatabase> {
  const server = inject('pgServerUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: `${server}/postgres` });
  await admin.connect();
  await admin.query(`create database ${name} template stockos_template`);
  await admin.end();

  const host = new URL(server).host;
  const appUrl = `postgres://stockos_app:stockos_app@${host}/${name}`;
  const app = createDb(appUrl, { max: options.appPoolSize ?? 10, applicationName: 'test-app' });
  const platform = createDb(`postgres://stockos_platform:stockos_platform@${host}/${name}`, {
    max: 5,
    applicationName: 'test-platform',
  });

  return {
    name,
    app,
    platform,
    appUrl,
    async drop() {
      await app.destroy();
      await platform.destroy();
      const c = new Client({ connectionString: `${server}/postgres` });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { LOCAL_ROLES_SQL, MIGRATIONS_DIR, migrate } from '@stockos/database';

export const TEMPLATE_DB = 'stockos_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection URL without database name, e.g. postgres://user:pw@host:port */
    pgServerUrl: string;
  }
}

/**
 * Starts (or connects to) a Postgres server once per test run and prepares a migrated template
 * database. Each test file clones the template (fast) so suites are isolated.
 *
 * - CI / Docker users: set TEST_PG_SERVER_URL=postgres://stockos_admin:stockos_admin@localhost:5432
 * - Otherwise an embedded Postgres binary is started in a temp dir (no Docker required).
 */
export default async function setup(project: TestProject) {
  let stop: () => Promise<void> = async () => {};
  let serverUrl = process.env['TEST_PG_SERVER_URL'];

  if (!serverUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = await freePort();
    const dataDir = await mkdtemp(join(tmpdir(), 'stockos-pg-'));
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'stockos_admin',
      password: 'stockos_admin',
      port,
      persistent: false,
      postgresFlags: ['-c', 'max_connections=400', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    serverUrl = `postgres://stockos_admin:stockos_admin@localhost:${port}`;
    stop = async () => {
      await pg.stop();
      await rm(dataDir, { recursive: true, force: true });
    };
  }

  const admin = new Client({ connectionString: `${serverUrl}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();

  await migrate(`${serverUrl}/${TEMPLATE_DB}`, MIGRATIONS_DIR);

  const template = new Client({ connectionString: `${serverUrl}/${TEMPLATE_DB}` });
  await template.connect();
  await template.query(await readFile(LOCAL_ROLES_SQL, 'utf8'));
  await template.end();

  project.provide('pgServerUrl', serverUrl);
  return stop;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadDotEnv } from '@stockos/config';
import { migrate, migrationStatus } from './migrator';
import { LOCAL_ROLES_SQL, MIGRATIONS_DIR } from './paths';

async function main() {
  loadDotEnv(resolve(__dirname, '..', '..', '..'));
  const url = process.env['DATABASE_URL_ADMIN'];
  if (!url) throw new Error('DATABASE_URL_ADMIN is required (see .env.example)');
  const command = process.argv[2];

  switch (command) {
    case 'migrate': {
      const applied = await migrate(url, MIGRATIONS_DIR, (m) => console.log(m));
      console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
      break;
    }
    case 'status': {
      const status = await migrationStatus(url, MIGRATIONS_DIR);
      console.log(`applied: ${status.applied.join(', ') || '-'}`);
      console.log(`pending: ${status.pending.join(', ') || '-'}`);
      break;
    }
    case 'local-roles': {
      if (['staging', 'prod'].includes(process.env['APP_ENV'] ?? '')) {
        throw new Error('local-roles must never run against staging/prod');
      }
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.query(await readFile(LOCAL_ROLES_SQL, 'utf8'));
      await client.end();
      console.log('local role passwords set');
      break;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Use: migrate | status | local-roles`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

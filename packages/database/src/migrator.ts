import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const NO_TX_DIRECTIVE = '-- migrate:no-transaction';
const LOCK_KEY = 727_001; // arbitrary constant for pg_advisory_lock

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match) throw new Error(`Migration file name must look like 0001_description.sql: ${name}`);
    const sqlText = await readFile(join(dir, name), 'utf8');
    files.push({
      version: match[1]!,
      name,
      sql: sqlText,
      checksum: createHash('sha256').update(sqlText).digest('hex'),
    });
  }
  const versions = files.map((f) => f.version);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');
  return files;
}

/**
 * Apply pending SQL migrations in order. Each file runs in its own transaction unless it starts
 * with `-- migrate:no-transaction` (needed for CREATE INDEX CONCURRENTLY). An advisory lock makes
 * concurrent deploys safe. Editing an applied migration is an error (checksum mismatch).
 */
export async function migrate(connectionString: string, dir: string, log: (msg: string) => void = () => {}) {
  const client = new Client({ connectionString, application_name: 'stockos-migrator' });
  await client.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);
    const applied = await appliedChecksums(client);

    for (const file of await loadMigrations(dir)) {
      const previous = applied.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was modified after being applied. Add a new migration instead.`,
          );
        }
        continue;
      }
      log(`applying ${file.name}`);
      const useTx = !file.sql.trimStart().startsWith(NO_TX_DIRECTIVE);
      if (useTx) await client.query('begin');
      try {
        await client.query(file.sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        if (useTx) await client.query('commit');
      } catch (err) {
        if (useTx) await client.query('rollback');
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
      appliedNow.push(file.name);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return appliedNow;
}

export async function migrationStatus(connectionString: string, dir: string): Promise<MigrationStatus> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensureTable(client);
    const applied = await appliedChecksums(client);
    const files = await loadMigrations(dir);
    return {
      applied: files.filter((f) => applied.has(f.name)).map((f) => f.name),
      pending: files.filter((f) => !applied.has(f.name)).map((f) => f.name),
    };
  } finally {
    await client.end();
  }
}

async function ensureTable(client: Client) {
  await client.query(`create table if not exists schema_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
}

async function appliedChecksums(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'select name, checksum from schema_migrations',
  );
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

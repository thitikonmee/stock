import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './types';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface CreateDbOptions {
  max?: number;
  applicationName?: string;
}

/**
 * Create a Kysely instance backed by a `pg` pool.
 * Use one Db per role: app (`stockos_app`, RLS enforced), platform (cross-tenant jobs), readonly.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 20,
    application_name: options.applicationName ?? 'stockos',
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

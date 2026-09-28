import { resolve } from 'node:path';

/** Absolute path of the SQL migrations directory (works from src/ and dist/). */
export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

/** LOCAL/CI-only script that sets role passwords to match .env.example. */
export const LOCAL_ROLES_SQL = resolve(__dirname, '..', '..', '..', 'db', 'local-roles.sql');

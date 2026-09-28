import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { isUuid, ValidationError } from '@stockos/shared';
import type { Db, Tx } from './db';
import { isRetryableTxError } from './pg-errors';

export interface TxOptions {
  /** Retries on deadlock / serialization failure / lock timeout. Default 3. */
  maxRetries?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

const DEFAULTS = { maxRetries: 3, statementTimeoutMs: 5000, lockTimeoutMs: 2000 } as const;

/**
 * Run `fn` in a transaction scoped to one tenant.
 *
 * - `app.tenant_id` is set with SET LOCAL semantics, so Row-Level Security applies and the value
 *   cannot leak to the next user of the pooled connection (works with PgBouncer transaction mode).
 * - The whole callback is retried on transient concurrency errors, so `fn` must not perform side
 *   effects outside the transaction (no HTTP calls, no queue publishing — use the outbox).
 */
export async function tenantTx<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  if (!isUuid(tenantId)) throw new ValidationError('Invalid tenant id');
  return runTx(db, tenantId, fn, options);
}

/** Transaction without a tenant (platform role only: outbox relay, schedulers, cross-tenant jobs). */
export async function platformTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  return runTx(db, null, fn, options);
}

async function runTx<T>(
  db: Db,
  tenantId: string | null,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const statementTimeout = String(options.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs);
  const lockTimeout = String(options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs);

  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction().execute(async (tx) => {
        await sql`select set_config('app.tenant_id', ${tenantId ?? ''}, true),
                         set_config('statement_timeout', ${statementTimeout}, true),
                         set_config('lock_timeout', ${lockTimeout}, true)`.execute(tx);
        return fn(tx);
      });
    } catch (err) {
      if (attempt < maxRetries && isRetryableTxError(err)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Full-jitter backoff: 10–50ms, 20–100ms, 40–200ms ... */
function backoffMs(attempt: number): number {
  const cap = 50 * 2 ** attempt;
  return Math.max(10, Math.floor(Math.random() * cap));
}

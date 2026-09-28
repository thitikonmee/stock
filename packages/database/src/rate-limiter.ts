import { sql } from 'kysely';
import type { Db } from './db';
import { platformTx } from './tenant-tx';

export interface RateLimitRule {
  /** Maximum hits per window. */
  limit: number;
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in Postgres (`rate_limit_buckets`). Correct across API instances with no
 * extra infrastructure; meant for low-volume, abuse-prone endpoints (login, registration).
 * High-volume API rate limiting belongs in Redis (token bucket) — see docs/08-api-design.md.
 */
export class PgRateLimiter {
  constructor(private readonly db: Db) {}

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const { rows } = await platformTx(this.db, (tx) =>
      sql<{ count: number; reset_in: number }>`
        insert into rate_limit_buckets (key, window_start, count)
        values (${key}, to_timestamp(floor(extract(epoch from now()) / ${rule.windowSec}) * ${rule.windowSec}), 1)
        on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
        returning count,
                  ceil(extract(epoch from window_start + make_interval(secs => ${rule.windowSec}) - now()))::int as reset_in`.execute(
        tx,
      ),
    );
    const row = rows[0]!;
    return { allowed: row.count <= rule.limit, count: row.count, retryAfterSec: Math.max(1, row.reset_in) };
  }

  /** Delete expired windows. Run from the scheduler (cheap, idempotent). */
  async purgeExpired(olderThanSec = 24 * 3600): Promise<number> {
    const result = await platformTx(this.db, (tx) =>
      sql`delete from rate_limit_buckets where window_start < now() - make_interval(secs => ${olderThanSec})`.execute(
        tx,
      ),
    );
    return Number(result.numAffectedRows ?? 0);
  }
}

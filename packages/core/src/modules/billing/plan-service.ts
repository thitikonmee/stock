import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { ForbiddenError, uuidv7 } from '@stockos/shared';

export type LimitedMetric = 'users' | 'branches' | 'pos_devices' | 'skus' | 'channels';

export interface PlanSummary {
  planId: string;
  planName: string;
  status: string;
  currentPeriodEnd: Date | null;
  /** null = unlimited */
  limits: Record<LimitedMetric, number | null>;
  usage: Record<LimitedMetric, number>;
}

const TRIAL_PLAN = 'BUSINESS';
const TRIAL_DAYS = 14;
const FALLBACK_PLAN = 'FREE';

/** Current usage per metric, counted from the source tables (not a cache). */
const USAGE_SQL: Record<LimitedMetric, ReturnType<typeof sql>> = {
  // Active members plus open invitations: an invitation reserves a seat.
  users: sql`select (select count(*) from tenant_memberships where status in ('ACTIVE', 'SUSPENDED'))
                  + (select count(*) from invitations where accepted_at is null and revoked_at is null and expires_at > now()) as n`,
  branches: sql`select count(*) as n from branches where is_active`,
  pos_devices: sql`select count(*) as n from pos_devices where status in ('PENDING', 'ACTIVE')`,
  skus: sql`select count(*) as n from product_variants where deleted_at is null and status <> 'ARCHIVED'`,
  channels: sql`select count(*) as n from channel_accounts where status <> 'DISCONNECTED'`,
};

/**
 * Plan limits (docs/14-saas-and-business-modules.md §35). Hard limits apply to things a tenant
 * creates (users, branches, devices, SKUs, channels). Orders are never blocked — see the doc.
 */
export class PlanService {
  /** Called at signup: every new tenant starts a trial of the Business plan. */
  async startTrial(tx: Tx, tenantId: string): Promise<void> {
    await sql`insert into tenant_subscriptions (tenant_id, id, plan_id, status, billing_cycle, current_period_start, current_period_end)
              values (${tenantId}, ${uuidv7()}, ${TRIAL_PLAN}, 'TRIALING', 'MONTHLY', now(), now() + make_interval(days => ${TRIAL_DAYS}))`.execute(
      tx,
    );
  }

  async summary(tx: Tx): Promise<PlanSummary> {
    const plan = await this.currentPlan(tx);
    const usage = {} as Record<LimitedMetric, number>;
    for (const metric of Object.keys(USAGE_SQL) as LimitedMetric[])
      usage[metric] = await this.usage(tx, metric);
    return { ...plan, usage };
  }

  /**
   * Throw PLAN_LIMIT_EXCEEDED if adding `adding` more of `metric` would exceed the plan.
   * Serialised per (tenant, metric) with a transaction-scoped advisory lock, so two concurrent
   * creates cannot both take the last slot. Call before inserting, inside the same transaction.
   */
  async assertWithinLimit(tx: Tx, tenantId: string, metric: LimitedMetric, adding = 1): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`plan:${tenantId}:${metric}`}, 0))`.execute(tx);
    const plan = await this.currentPlan(tx);
    const limit = plan.limits[metric];
    if (limit === null) return;
    const used = await this.usage(tx, metric);
    if (used + adding > limit) {
      throw new ForbiddenError(
        `Your ${plan.planName} plan allows ${limit} ${metric.replace('_', ' ')}`,
        { metric, limit, used, planId: plan.planId },
        'PLAN_LIMIT_EXCEEDED',
      );
    }
  }

  private async usage(tx: Tx, metric: LimitedMetric): Promise<number> {
    const { rows } = await USAGE_SQL[metric].execute(tx);
    return Number((rows[0] as { n: string | number }).n);
  }

  private async currentPlan(tx: Tx): Promise<Omit<PlanSummary, 'usage'>> {
    const { rows } = await sql<{
      id: string;
      name: string;
      limits: Record<string, number | null>;
      status: string | null;
      current_period_end: Date | null;
    }>`
      select p.id, p.name, p.limits, s.status, s.current_period_end
        from plans p
        left join lateral (
          select plan_id, status, current_period_end from tenant_subscriptions
           where status in ('TRIALING', 'ACTIVE', 'PAST_DUE')
           order by created_at desc limit 1) s on true
       where p.id = coalesce(s.plan_id, ${FALLBACK_PLAN})`.execute(tx);
    const row = rows[0];
    if (!row) throw new Error('Plan catalog is missing');
    const limit = (key: string) => (row.limits[key] === undefined ? null : row.limits[key]!);
    return {
      planId: row.id,
      planName: row.name,
      status: row.status ?? 'NONE',
      currentPeriodEnd: row.current_period_end,
      limits: {
        users: limit('users'),
        branches: limit('branches'),
        pos_devices: limit('pos_devices'),
        skus: limit('skus'),
        channels: limit('channels'),
      },
    };
  }
}

import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import type { SyncJobRow } from '../domain/types';
import type { AdapterRegistry } from './adapter-registry';
import type { TokenManager } from './token-manager';
import type { OrderIngestService } from './order-ingest-service';
import { loadChannelAccount } from './account-repository';

const OVERLAP_MS = 10 * 60 * 1000; // re-pull the last 10 minutes every time — a missed/late webhook still gets picked up
const FIRST_RUN_WINDOW_MS = 15 * 24 * 3600 * 1000; // Shopee's own get_order_list window cap

/**
 * The "missing webhook" safety net (docs/06 §21): pulls every order Shopee has touched since the
 * account's high-water mark and runs it through the same `OrderIngestService` a webhook would.
 * No scheduler/worker in this phase (no Redis — see stockos-dev-workflow memory), so this is
 * exposed as a "sync now" action; a real cron can call the same method later without changing it.
 */
export class SyncJobService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tokens: TokenManager,
    private readonly ingest: OrderIngestService,
  ) {}

  async runOrderPoll(tx: Tx, principal: Principal, channelAccountId: string): Promise<SyncJobRow> {
    assertCan(principal, 'channel.sync');
    const account = await loadChannelAccount(tx, channelAccountId);
    if (!account) throw new NotFoundError('Channel account not found');
    const jobId = uuidv7();
    await sql`insert into sync_jobs (tenant_id, id, channel_account_id, job_type, status, attempts, scheduled_at, started_at)
              values (${principal.tenantId}, ${jobId}, ${channelAccountId}, 'ORDER_PULL', 'RUNNING', 1, now(), now())`.execute(
      tx,
    );

    const adapter = this.registry.get(account.channelCode);
    const accountRef = {
      tenantId: principal.tenantId,
      channelAccountId,
      externalShopId: account.externalShopId,
    };
    const accessToken = await this.tokens.getValidAccessToken(tx, accountRef, account.channelCode);
    const updatedFrom = account.lastOrderSyncAt
      ? new Date(Date.parse(account.lastOrderSyncAt) - OVERLAP_MS)
      : new Date(Date.now() - FIRST_RUN_WINDOW_MS);
    const updatedTo = new Date();

    let pulled = 0;
    let ingested = 0;
    let failed = 0;
    let cursor: string | undefined;
    try {
      do {
        const page = await adapter.listOrders(accountRef, accessToken, { updatedFrom, updatedTo, cursor });
        pulled += page.data.length;
        const batch = page.data.map((o) => o.externalOrderId);
        if (batch.length > 0) {
          const details = await adapter.getOrders(accountRef, accessToken, batch);
          for (const detail of details) {
            try {
              await this.ingest.ingestOne(tx, principal.tenantId, account, detail, 'CHANNEL_POLL');
              ingested++;
            } catch {
              failed++;
            }
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      await sql`update channel_accounts set last_order_sync_at = ${updatedTo}, last_error = null
                where id = ${channelAccountId}`.execute(tx);
      await sql`update sync_jobs set status = 'SUCCEEDED', output = ${JSON.stringify({ pulled, ingested, failed })}::jsonb,
                  finished_at = now() where id = ${jobId}`.execute(tx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await sql`update channel_accounts set last_error = ${message} where id = ${channelAccountId}`.execute(
        tx,
      );
      await sql`update sync_jobs set status = 'FAILED', last_error = ${message}, finished_at = now() where id = ${jobId}`.execute(
        tx,
      );
    }
    return (await this.get(tx, principal, jobId))!;
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<SyncJobRow | null> {
    assertCan(principal, 'channel.read');
    const { rows } = await sql<Row>`
      select id, channel_account_id, job_type, status, attempts, output, last_error, scheduled_at, started_at, finished_at
        from sync_jobs where id = ${id}`.execute(tx);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(tx: Tx, principal: Principal, channelAccountId?: string): Promise<SyncJobRow[]> {
    assertCan(principal, 'channel.read');
    if (channelAccountId && !(await loadChannelAccount(tx, channelAccountId))) {
      throw new NotFoundError('Channel account not found');
    }
    const { rows } = await sql<Row>`
      select id, channel_account_id, job_type, status, attempts, output, last_error, scheduled_at, started_at, finished_at
        from sync_jobs
       where ${channelAccountId ?? null}::uuid is null or channel_account_id = ${channelAccountId ?? null}
       order by scheduled_at desc limit 50`.execute(tx);
    return rows.map(toRow);
  }
}

interface Row {
  id: string;
  channel_account_id: string | null;
  job_type: SyncJobRow['jobType'];
  status: SyncJobRow['status'];
  attempts: number;
  output: unknown;
  last_error: string | null;
  scheduled_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
function toRow(r: Row): SyncJobRow {
  return {
    id: r.id,
    channelAccountId: r.channel_account_id,
    jobType: r.job_type,
    status: r.status,
    attempts: r.attempts,
    output: r.output,
    lastError: r.last_error,
    scheduledAt: r.scheduled_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

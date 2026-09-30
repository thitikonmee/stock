import { sql } from 'kysely';
import type { Db } from '@stockos/database';
import { platformTx, tenantTx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import type { ChannelCode, RawWebhookRequest } from '../domain/channel-adapter';
import type { AdapterRegistry } from './adapter-registry';
import type { TokenManager } from './token-manager';
import type { OrderIngestService } from './order-ingest-service';
import { loadChannelAccount } from './account-repository';

export interface WebhookHandleResult {
  httpStatus: number;
  outcome: 'INVALID_SIGNATURE' | 'DUPLICATE' | 'UNKNOWN_SHOP' | 'PROCESSED' | 'FAILED';
}

/**
 * The public `/webhooks/:channel` endpoint's business logic (docs/06 §21 Inbox pattern). Runs with
 * no Principal — the platform calls this directly, not a logged-in user — so tenant resolution and
 * the dedup insert use `platformTx` (BYPASSRLS role: `channel_accounts` is tenant-isolated and we
 * don't know the tenant until we've looked up the shop_id), then everything past that point runs
 * in an ordinary `tenantTx` once the tenant is known, matching every other write path in the app.
 */
export class WebhookService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tokens: TokenManager,
    private readonly ingest: OrderIngestService,
    private readonly db: Db,
    private readonly platformDb: Db,
  ) {}

  async handle(channelCode: ChannelCode, req: RawWebhookRequest): Promise<WebhookHandleResult> {
    const adapter = this.registry.get(channelCode);
    const verification = adapter.verifyWebhook(req);
    if (!verification.valid) {
      await platformTx(this.platformDb, (tx) =>
        sql`insert into webhook_events (id, tenant_id, channel_code, event_type, dedup_key, signature_valid,
                                        headers, payload, status)
            values (${uuidv7()}, null, ${channelCode}, 'UNVERIFIED', ${`invalid:${uuidv7()}`}, false,
                    ${JSON.stringify(req.headers)}::jsonb, ${safeJson(req.rawBody)}::jsonb, 'IGNORED')`.execute(
          tx,
        ),
      );
      return { httpStatus: 401, outcome: 'INVALID_SIGNATURE' };
    }

    const events = adapter.parseWebhook(req);
    let outcome: WebhookHandleResult['outcome'] = 'PROCESSED';
    for (const event of events) {
      const inserted = await platformTx(this.platformDb, async (tx) => {
        const { rows } = await sql<{ id: string }>`
          insert into webhook_events (id, tenant_id, channel_code, external_shop_id, event_type, external_ref,
                                      dedup_key, signature_valid, headers, payload, event_ts, status)
          values (${uuidv7()}, null, ${channelCode}, ${event.externalShopId}, ${event.eventType}, ${event.externalRef},
                  ${event.dedupKey}, true, ${JSON.stringify(req.headers)}::jsonb, ${JSON.stringify(event.payload)}::jsonb,
                  ${event.eventTs}, 'RECEIVED')
          on conflict (channel_code, dedup_key) do nothing
          returning id`.execute(tx);
        return rows[0]?.id ?? null;
      });
      if (!inserted) {
        outcome = 'DUPLICATE';
        continue;
      }

      const resolved = await platformTx(this.platformDb, (tx) =>
        sql<{
          tenant_id: string;
          id: string;
          channel_code: string;
        }>`select tenant_id, id, channel_code from channel_accounts
            where channel_code = ${channelCode} and external_shop_id = ${event.externalShopId}
              and status <> 'DISCONNECTED'
            limit 1`.execute(tx),
      );
      const accountRow = resolved.rows[0];
      if (!accountRow) {
        await platformTx(this.platformDb, (tx) =>
          sql`update webhook_events set status = 'IGNORED', processed_at = now() where id = ${inserted}`.execute(
            tx,
          ),
        );
        outcome = 'UNKNOWN_SHOP';
        continue;
      }

      try {
        // Stamp the tenant now that it's known — still platform role, since `webhook_events` has
        // no ordinary `tenant_isolation` UPDATE policy (only the custom insert/select ones).
        // `webhook_events` has no `tenant_isolation` policy (only its own custom insert/select
        // ones, and no UPDATE policy at all) — every write to it, including these status stamps,
        // has to go through the BYPASSRLS platform role, never the tenant-scoped `db`.
        await platformTx(this.platformDb, (tx) =>
          sql`update webhook_events set tenant_id = ${accountRow.tenant_id}, channel_account_id = ${accountRow.id},
                status = 'PROCESSING', attempts = attempts + 1 where id = ${inserted}`.execute(tx),
        );

        await tenantTx(this.db, accountRow.tenant_id, async (tx) => {
          const account = (await loadChannelAccount(tx, accountRow.id))!;
          const accessToken = await this.tokens.getValidAccessToken(
            tx,
            {
              tenantId: accountRow.tenant_id,
              channelAccountId: accountRow.id,
              externalShopId: account.externalShopId,
            },
            channelCode,
          );
          const details = await adapter.getOrders(
            {
              tenantId: accountRow.tenant_id,
              channelAccountId: accountRow.id,
              externalShopId: account.externalShopId,
            },
            accessToken,
            [event.externalRef],
          );
          for (const detail of details) {
            await this.ingest.ingestOne(tx, accountRow.tenant_id, account, detail, 'CHANNEL_WEBHOOK');
          }
        });

        await platformTx(this.platformDb, (tx) =>
          sql`update webhook_events set status = 'PROCESSED', processed_at = now() where id = ${inserted}`.execute(
            tx,
          ),
        );
      } catch (err) {
        outcome = 'FAILED';
        const message = err instanceof Error ? err.message : 'unknown error';
        await platformTx(this.platformDb, (tx) =>
          sql`update webhook_events set status = 'FAILED', last_error = ${message},
                next_attempt_at = now() + interval '10 seconds' where id = ${inserted}`.execute(tx),
        );
      }
    }
    return { httpStatus: 200, outcome };
  }
}

function safeJson(rawBody: string): string {
  try {
    JSON.parse(rawBody);
    return rawBody;
  } catch {
    return JSON.stringify({ raw: rawBody.slice(0, 2000) });
  }
}

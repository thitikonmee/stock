import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { NotFoundError } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import type { WebhookEventRow } from '../domain/types';
import { loadChannelAccount } from './account-repository';

/** Read-only admin view over `webhook_events` — the `webhook_read` RLS policy already scopes rows
 *  to the caller's tenant, so this is an ordinary `tenantTx`/`db` read (see WebhookService's doc
 *  comment for why the *writes* to this table need the platform role instead). */
export class WebhookQueryService {
  async list(tx: Tx, principal: Principal, channelAccountId?: string): Promise<WebhookEventRow[]> {
    assertCan(principal, 'channel.read');
    if (channelAccountId && !(await loadChannelAccount(tx, channelAccountId))) {
      throw new NotFoundError('Channel account not found');
    }
    const { rows } = await sql<Row>`
      select id, channel_code, channel_account_id, event_type, external_ref, signature_valid, status, attempts,
             last_error, received_at, processed_at
        from webhook_events
       where ${channelAccountId ?? null}::uuid is null or channel_account_id = ${channelAccountId ?? null}
       order by received_at desc limit 50`.execute(tx);
    return rows.map(toRow);
  }
}

interface Row {
  id: string;
  channel_code: string;
  channel_account_id: string | null;
  event_type: string;
  external_ref: string | null;
  signature_valid: boolean;
  status: WebhookEventRow['status'];
  attempts: number;
  last_error: string | null;
  received_at: Date;
  processed_at: Date | null;
}
function toRow(r: Row): WebhookEventRow {
  return {
    id: r.id,
    channelCode: r.channel_code,
    channelAccountId: r.channel_account_id,
    eventType: r.event_type,
    externalRef: r.external_ref,
    signatureValid: r.signature_valid,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    receivedAt: r.received_at.toISOString(),
    processedAt: r.processed_at?.toISOString() ?? null,
  };
}

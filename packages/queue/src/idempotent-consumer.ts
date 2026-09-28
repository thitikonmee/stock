import { sql } from 'kysely';
import type { Tx } from '@stockos/database';

/**
 * Run a consumer's side of an event exactly once per (consumer, event id), inside the caller's
 * transaction. If the transaction rolls back, the marker rolls back too and the event can be retried.
 */
export async function processOnce(
  tx: Tx,
  consumer: string,
  eventId: string,
  handler: () => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  const { rows } = await sql<{ event_id: string }>`
    insert into processed_events (consumer, event_id) values (${consumer}, ${eventId})
    on conflict do nothing
    returning event_id`.execute(tx);
  if (rows.length === 0) return 'duplicate';
  await handler();
  return 'processed';
}

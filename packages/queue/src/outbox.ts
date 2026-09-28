import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { currentContext, uuidv7 } from '@stockos/shared';

export interface NewOutboxEvent<TPayload = unknown> {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion?: number;
  payload: TPayload;
  headers?: Record<string, string>;
}

/**
 * Record a domain event in the same transaction as the state change (transactional outbox).
 * The event is published only if the transaction commits; the relay delivers it at least once.
 */
export async function addOutboxEvent(tx: Tx, event: NewOutboxEvent): Promise<string> {
  const id = uuidv7();
  const ctx = currentContext();
  const headers: Record<string, string> = {
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx?.actor ? { actorType: ctx.actor.type, ...(ctx.actor.id ? { actorId: ctx.actor.id } : {}) } : {}),
    ...event.headers,
  };
  await sql`
    insert into outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload, headers)
    values (${id}, ${event.tenantId}, ${event.aggregateType}, ${event.aggregateId}, ${event.eventType},
            ${event.eventVersion ?? 1}, ${JSON.stringify(event.payload)}::jsonb, ${JSON.stringify(headers)}::jsonb)
  `.execute(tx);
  return id;
}

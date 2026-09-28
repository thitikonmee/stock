import { sql } from 'kysely';
import { platformTx, type Db } from '@stockos/database';
import type { Logger } from '@stockos/shared';
import type { EventEnvelope, EventPublisher } from './envelope';

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: unknown;
  headers: Record<string, string>;
  created_at: Date;
}

export interface OutboxRelayOptions {
  batchSize?: number;
  intervalMs?: number;
  logger?: Logger;
}

/**
 * Moves committed outbox rows to the event publisher.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED so several relays can run side by side, published,
 * then marked in the same transaction. A crash between publish and commit re-publishes the batch
 * (at-least-once) — consumers dedupe by envelope id. Must use the platform DB role (cross-tenant).
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly batchSize: number;
  private readonly intervalMs: number;

  constructor(
    private readonly db: Db,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.intervalMs = options.intervalMs ?? 200;
  }

  /** Relay one batch. Returns the number of events published. */
  async relayOnce(): Promise<number> {
    return platformTx(this.db, async (tx) => {
      const { rows } = await sql<OutboxRow>`
        select id, tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload, headers, created_at
          from outbox_events
         where published_at is null
         order by created_at, id
         limit ${this.batchSize}
           for update skip locked`.execute(tx);
      if (rows.length === 0) return 0;

      await this.publisher.publish(rows.map(toEnvelope));

      const ids = rows.map((r) => r.id);
      await sql`update outbox_events set published_at = now(), attempts = attempts + 1
                 where id = any(${ids}::uuid[])`.execute(tx);
      return rows.length;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let published = 0;
      try {
        published = await this.relayOnce();
      } catch (err) {
        this.options.logger?.error({ err, event: 'outbox.relay.failed' }, 'outbox relay batch failed');
      }
      // Drain immediately while batches are full, otherwise wait for the next interval.
      const delay = published >= this.batchSize ? 0 : this.intervalMs;
      if (this.running) this.timer = setTimeout(() => void tick(), delay);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

function toEnvelope(row: OutboxRow): EventEnvelope {
  return {
    id: row.id,
    type: row.event_type,
    version: row.event_version,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    occurredAt: row.created_at.toISOString(),
    headers: row.headers,
    payload: row.payload,
  };
}

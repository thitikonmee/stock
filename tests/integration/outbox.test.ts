import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformTx, tenantTx } from '@stockos/database';
import { InMemoryPublisher, OutboxRelay, addOutboxEvent, processOnce } from '@stockos/queue';
import { runWithContext, uuidv7 } from '@stockos/shared';
import { seedTenant } from '../support/seed';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.drop());

async function unpublishedCount() {
  return platformTx(db.platform, async (tx) => {
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from outbox_events where published_at is null`.execute(tx);
    return rows[0]!.n;
  });
}

describe('transactional outbox', () => {
  it('only publishes events whose transaction committed, with request context headers', async () => {
    const t = await seedTenant(db.app);
    const committedId = await runWithContext({ requestId: 'req-1', traceId: 'trace-1' }, () =>
      tenantTx(db.app, t.tenantId, (tx) =>
        addOutboxEvent(tx, {
          tenantId: t.tenantId,
          aggregateType: 'Test',
          aggregateId: uuidv7(),
          eventType: 'TestHappened',
          payload: { n: 1 },
        }),
      ),
    );
    await tenantTx(db.app, t.tenantId, async (tx) => {
      await addOutboxEvent(tx, {
        tenantId: t.tenantId,
        aggregateType: 'Test',
        aggregateId: uuidv7(),
        eventType: 'RolledBack',
        payload: {},
      });
      throw new Error('rollback');
    }).catch(() => undefined);

    const publisher = new InMemoryPublisher();
    const relay = new OutboxRelay(db.platform, publisher, { batchSize: 100 });
    while ((await relay.relayOnce()) > 0);

    const mine = publisher.published.filter((e) => e.tenantId === t.tenantId);
    expect(mine.map((e) => e.type)).toEqual(['TestHappened']);
    expect(mine[0]).toMatchObject({
      id: committedId,
      headers: { requestId: 'req-1', traceId: 'trace-1' },
      payload: { n: 1 },
    });
    expect(await unpublishedCount()).toBe(0);
  });

  it('keeps events unpublished when the publisher fails, then delivers them', async () => {
    const t = await seedTenant(db.app);
    await tenantTx(db.app, t.tenantId, (tx) =>
      addOutboxEvent(tx, {
        tenantId: t.tenantId,
        aggregateType: 'T',
        aggregateId: uuidv7(),
        eventType: 'E',
        payload: {},
      }),
    );
    const publisher = new InMemoryPublisher();
    publisher.failNext = true;
    const relay = new OutboxRelay(db.platform, publisher);

    await expect(relay.relayOnce()).rejects.toThrow('simulated');
    expect(await unpublishedCount()).toBeGreaterThan(0);

    while ((await relay.relayOnce()) > 0);
    expect(await unpublishedCount()).toBe(0);
    expect(publisher.published.some((e) => e.tenantId === t.tenantId)).toBe(true);
  });

  it('lets concurrent relays share the work without double publishing', async () => {
    const t = await seedTenant(db.app);
    await tenantTx(db.app, t.tenantId, async (tx) => {
      for (let i = 0; i < 300; i++) {
        await addOutboxEvent(tx, {
          tenantId: t.tenantId,
          aggregateType: 'T',
          aggregateId: uuidv7(),
          eventType: 'Bulk',
          payload: { i },
        });
      }
    });
    const publisher = new InMemoryPublisher();
    const relays = Array.from(
      { length: 4 },
      () => new OutboxRelay(db.platform, publisher, { batchSize: 25 }),
    );
    await Promise.all(
      relays.map(async (r) => {
        while ((await r.relayOnce()) > 0);
      }),
    );

    const ids = publisher.published.filter((e) => e.type === 'Bulk').map((e) => e.id);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
  });
});

describe('processOnce', () => {
  it('runs a consumer side effect once per event id', async () => {
    const t = await seedTenant(db.app);
    const eventId = uuidv7();
    let calls = 0;
    const run = () =>
      tenantTx(db.app, t.tenantId, (tx) =>
        processOnce(tx, 'test-consumer', eventId, async () => {
          calls++;
        }),
      );

    expect(await run()).toBe('processed');
    expect(await run()).toBe('duplicate');
    expect(calls).toBe(1);
  });
});

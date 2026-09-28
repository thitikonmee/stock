import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformTx, tenantTx } from '@stockos/database';
import { seedTenant, seedVariants } from '../support/seed';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/** Tables that intentionally have tenant_id but no tenant_isolation policy (see schema.sql §16). */
const RLS_EXEMPT = new Set(['webhook_events', 'user_sessions', 'outbox_events']);

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db.drop());

describe('row-level security', () => {
  it('every tenant-scoped table has RLS enabled and forced', async () => {
    const rows = await platformTx(db.platform, async (tx) => {
      const { rows } = await sql<{ table: string; enabled: boolean; forced: boolean }>`
        select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
         where c.relkind in ('r', 'p') and not c.relispartition`.execute(tx);
      return rows;
    });
    const missing = rows
      .filter((r) => !RLS_EXEMPT.has(r.table) && !(r.enabled && r.forced))
      .map((r) => r.table);
    expect(rows.length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('fails closed when no tenant is set', async () => {
    const t = await seedTenant(db.app);
    await seedVariants(db.app, t, 1, '5');
    const visible = await platformTx(db.app, async (tx) => {
      const { rows } = await sql`select 1 from inventory_balances`.execute(tx);
      return rows.length;
    });
    expect(visible).toBe(0);
    await expect(
      platformTx(db.app, (tx) =>
        sql`insert into units (tenant_id, code, name) values (${t.tenantId}, 'BOX', 'box')`.execute(tx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('isolates tenants from each other', async () => {
    const a = await seedTenant(db.app);
    const b = await seedTenant(db.app);
    await seedVariants(db.app, a, 3, '10');

    const seenByB = await tenantTx(db.app, b.tenantId, async (tx) => {
      const balances = await sql`select 1 from inventory_balances`.execute(tx);
      const variants = await sql`select 1 from product_variants`.execute(tx);
      const tenants = await sql<{ id: string }>`select id from tenants`.execute(tx);
      return { balances: balances.rows.length, variants: variants.rows.length, tenants: tenants.rows };
    });
    expect(seenByB).toEqual({ balances: 0, variants: 0, tenants: [{ id: b.tenantId }] });

    // B cannot write rows claiming to belong to A.
    await expect(
      tenantTx(db.app, b.tenantId, (tx) =>
        sql`insert into units (tenant_id, code, name) values (${a.tenantId}, 'X', 'x')`.execute(tx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps the ledger append-only', async () => {
    const t = await seedTenant(db.app);
    await seedVariants(db.app, t, 1, '1');
    await expect(
      tenantTx(db.app, t.tenantId, (tx) => sql`update inventory_transactions set note = 'x'`.execute(tx)),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      platformTx(db.platform, (tx) => sql`delete from inventory_transactions`.execute(tx)),
    ).rejects.toThrow(/append-only/);
  });
});

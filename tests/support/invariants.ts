import { sql } from 'kysely';
import { expect } from 'vitest';
import { tenantTx, type Db } from '@stockos/database';

interface Mismatch {
  warehouse_id: string;
  variant_id: string;
}

/**
 * Σ ledger per bucket must equal the balance row for every (warehouse, variant), and
 * available must equal on_hand − reserved − committed. Mirrors the nightly reconciliation job.
 */
export async function expectLedgerMatchesBalances(db: Db, tenantId: string): Promise<void> {
  const mismatches = await tenantTx(db, tenantId, async (tx) => {
    const { rows } = await sql<Mismatch>`
      with ledger as (
        select warehouse_id, variant_id,
               coalesce(sum(quantity) filter (where bucket = 'ON_HAND'), 0)   as on_hand,
               coalesce(sum(quantity) filter (where bucket = 'RESERVED'), 0)  as reserved,
               coalesce(sum(quantity) filter (where bucket = 'COMMITTED'), 0) as committed,
               coalesce(sum(quantity) filter (where bucket = 'DAMAGED'), 0)   as damaged,
               coalesce(sum(quantity) filter (where bucket = 'INCOMING'), 0)  as incoming
          from inventory_transactions
         group by 1, 2)
      select b.warehouse_id, b.variant_id
        from inventory_balances b
        full join ledger l using (warehouse_id, variant_id)
       where b.on_hand   is distinct from l.on_hand
          or b.reserved  is distinct from l.reserved
          or b.committed is distinct from l.committed
          or b.damaged   is distinct from l.damaged
          or b.incoming  is distinct from l.incoming
          or b.available <> b.on_hand - b.reserved - b.committed`.execute(tx);
    return rows;
  });
  expect(mismatches).toEqual([]);
}

/**
 * Ledger rows of one (warehouse, variant, bucket), ordered by balance_version, must chain:
 * each row's before_quantity equals the previous row's after_quantity, starting from zero.
 */
export async function expectLedgerChainsAreContinuous(db: Db, tenantId: string): Promise<void> {
  const broken = await tenantTx(db, tenantId, async (tx) => {
    const { rows } = await sql<{ id: string }>`
      select id from (
        select id, before_quantity,
               lag(after_quantity, 1, 0::numeric)
                 over (partition by warehouse_id, variant_id, bucket order by balance_version) as prev_after
          from inventory_transactions) t
       where prev_after <> before_quantity`.execute(tx);
    return rows;
  });
  expect(broken).toEqual([]);
}

/** Stored buckets never go below zero (warehouses in these tests do not allow negative stock). */
export async function expectNoNegativeBuckets(db: Db, tenantId: string): Promise<void> {
  const negative = await tenantTx(db, tenantId, async (tx) => {
    const { rows } = await sql<Record<string, string>>`
      select warehouse_id, variant_id, on_hand, reserved, committed, damaged, incoming from inventory_balances
       where on_hand < 0 or reserved < 0 or committed < 0 or damaged < 0 or incoming < 0`.execute(tx);
    return rows;
  });
  expect(negative).toEqual([]);
}

/**
 * available = on_hand − reserved − committed never goes below zero, i.e. nothing was promised
 * that is not physically there. Only holds when no LOSS / MARK_DAMAGED / negative adjustment runs:
 * those record physical facts and may legitimately leave a row OVERCOMMITTED (alerted, not blocked).
 */
export async function expectNotOvercommitted(db: Db, tenantId: string): Promise<void> {
  const overcommitted = await tenantTx(db, tenantId, async (tx) => {
    const { rows } = await sql<Record<string, string>>`
      select warehouse_id, variant_id, on_hand, reserved, committed, available from inventory_balances
       where available < 0`.execute(tx);
    return rows;
  });
  expect(overcommitted).toEqual([]);
}

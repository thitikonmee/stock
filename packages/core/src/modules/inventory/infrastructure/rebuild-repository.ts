import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { Dec, formatQuantity } from '@stockos/shared';
import { BUCKETS, type Bucket } from '../domain/operations';

export interface BucketDiff {
  bucket: Bucket;
  expected: string;
  actual: string;
  diff: string;
}

export interface RebuildOutcome {
  warehouseId: string;
  variantId: string;
  mismatches: BucketDiff[];
  corrected: boolean;
}

/**
 * The one legitimate way to make `inventory_balances` disagree with a guarded engine update: derive
 * the authoritative value straight from the ledger (source of truth) and overwrite the row.
 *
 * This does NOT write a ledger row. `inventory_transactions` was never wrong here — corruption by
 * definition means something changed the *balance* outside InventoryEngine (a bug, a manual DB
 * edit), so the ledger's own sum already equals the correct value; the mismatch is entirely in the
 * cached balance. Writing a "correction" entry would make the ledger's own running total disagree
 * with itself on the next rebuild (it would double the fix in). The `REBUILD_CORRECTION` ledger type
 * exists in the schema for a different case — reconciling against an external source of truth (e.g.
 * a channel) that genuinely requires recording a new fact — not this one. `rebuildFromRun`'s audit
 * log entry is the record of what this operation changed.
 */
export async function computeExpectedBalance(
  tx: Tx,
  tenantId: string,
  warehouseId: string,
  variantId: string,
): Promise<Record<Bucket, string>> {
  const { rows } = await sql<{ bucket: Bucket; total: string }>`
    select bucket, coalesce(sum(quantity), 0)::text as total
      from inventory_transactions
     where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and variant_id = ${variantId}
     group by bucket`.execute(tx);
  const byBucket = new Map(rows.map((r) => [r.bucket, r.total]));
  return Object.fromEntries(
    BUCKETS.map((b) => [b, formatQuantity(new Dec(byBucket.get(b) ?? '0'))]),
  ) as Record<Bucket, string>;
}

/** Locks the balance row, compares it to the ledger, and corrects it in place if they disagree. */
export async function rebuildBalance(
  tx: Tx,
  tenantId: string,
  warehouseId: string,
  variantId: string,
): Promise<RebuildOutcome> {
  const { rows } = await sql<{
    on_hand: string;
    reserved: string;
    committed: string;
    damaged: string;
    incoming: string;
  }>`
    select on_hand, reserved, committed, damaged, incoming
      from inventory_balances
     where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and variant_id = ${variantId}
     for update`.execute(tx);
  const current = rows[0];
  if (!current) return { warehouseId, variantId, mismatches: [], corrected: false };

  const expected = await computeExpectedBalance(tx, tenantId, warehouseId, variantId);
  const currentByBucket: Record<Bucket, string> = {
    ON_HAND: current.on_hand,
    RESERVED: current.reserved,
    COMMITTED: current.committed,
    DAMAGED: current.damaged,
    INCOMING: current.incoming,
  };
  const mismatches: BucketDiff[] = BUCKETS.filter(
    (b) => !new Dec(expected[b]).equals(currentByBucket[b]),
  ).map((b) => ({
    bucket: b,
    expected: expected[b],
    actual: currentByBucket[b],
    diff: formatQuantity(new Dec(expected[b]).minus(currentByBucket[b])),
  }));
  if (mismatches.length === 0) return { warehouseId, variantId, mismatches: [], corrected: false };

  await sql`
    update inventory_balances
       set on_hand = ${expected.ON_HAND}, reserved = ${expected.RESERVED}, committed = ${expected.COMMITTED},
           damaged = ${expected.DAMAGED}, incoming = ${expected.INCOMING}, version = version + 1, updated_at = now()
     where tenant_id = ${tenantId} and warehouse_id = ${warehouseId} and variant_id = ${variantId}`.execute(
    tx,
  );

  return { warehouseId, variantId, mismatches, corrected: true };
}

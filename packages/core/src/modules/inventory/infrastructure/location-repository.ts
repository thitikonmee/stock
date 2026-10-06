import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { Dec, formatQuantity } from '@stockos/shared';

/**
 * Keeps bin stock (inventory_location_balances) in step when stock leaves a warehouse that uses
 * locations (docs/04-inventory.md §9 "Location (bin) inventory"). Called by InventoryEngine right
 * after the balance row's guarded update, so that row is still locked by this transaction and every
 * bin change for the (warehouse, variant) serialises behind it — same lock order as putaway.
 *
 * - `binsFirst` (picking: sale, shipment, transfer out): stock is taken from pickable, active bins,
 *   fullest first — the same order `LocationService.pickSuggestions` tells the picker to follow —
 *   and only what the bins can't cover comes out of unlocated stock.
 * - otherwise (loss, damage, negative adjustment or count): unlocated stock is used first; bins are
 *   only trimmed when the warehouse would otherwise hold less than its bins claim.
 *
 * Either way it ends with Σ bin on_hand ≤ warehouse on_hand.
 */
export async function releaseFromLocations(
  tx: Tx,
  input: { warehouseId: string; variantId: string; quantity: Dec; onHandAfter: Dec; binsFirst: boolean },
): Promise<void> {
  const { rows: wh } = await sql<{ use_locations: boolean }>`
    select use_locations from warehouses where id = ${input.warehouseId}`.execute(tx);
  if (!wh[0]?.use_locations) return;

  if (input.binsFirst) {
    await takeFromBins(tx, input.warehouseId, input.variantId, input.quantity, true);
  }
  const { rows } = await sql<{ located: string }>`
    select coalesce(sum(on_hand), 0) as located from inventory_location_balances
     where warehouse_id = ${input.warehouseId} and variant_id = ${input.variantId}`.execute(tx);
  const excess = new Dec(rows[0]!.located).minus(input.onHandAfter.isNegative() ? 0 : input.onHandAfter);
  if (excess.greaterThan(0)) await takeFromBins(tx, input.warehouseId, input.variantId, excess, false);
}

async function takeFromBins(
  tx: Tx,
  warehouseId: string,
  variantId: string,
  quantity: Dec,
  pickableOnly: boolean,
): Promise<void> {
  const { rows } = await sql<{ location_id: string; on_hand: string }>`
    select b.location_id, b.on_hand
      from inventory_location_balances b join warehouse_locations l on l.id = b.location_id
     where b.warehouse_id = ${warehouseId} and b.variant_id = ${variantId} and b.on_hand > 0
       and (not ${pickableOnly} or (l.is_active and l.is_pickable))
     order by b.on_hand desc, l.full_code
     for update of b`.execute(tx);
  let remaining = quantity;
  for (const bin of rows) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const take = Dec.min(remaining, bin.on_hand);
    await sql`update inventory_location_balances set on_hand = on_hand - ${formatQuantity(take)}, updated_at = now()
               where location_id = ${bin.location_id} and variant_id = ${variantId}`.execute(tx);
    remaining = remaining.minus(take);
  }
}

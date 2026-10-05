import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { Dec, formatCost, formatQuantity, toCost, toQuantity } from '@stockos/shared';

/** Current moving-average unit cost for a variant (0 if it has never been received). */
export async function readAvgCost(tx: Tx, tenantId: string, variantId: string): Promise<string> {
  const { rows } = await sql<{ avg_cost: string }>`
    select avg_cost from variant_costs where tenant_id = ${tenantId} and variant_id = ${variantId}`.execute(
    tx,
  );
  return rows[0]?.avg_cost ?? '0.0000';
}

/**
 * Weighted moving average, folded in on every costed receipt (docs/04-inventory.md §9):
 * new_avg = (qty_basis·avg_cost + received_qty·unit_cost) / (qty_basis + received_qty).
 * Row-locked so two concurrent receipts of the same variant serialise instead of losing an update.
 */
export async function applyMovingAverage(
  tx: Tx,
  tenantId: string,
  variantId: string,
  receivedQty: string,
  unitCost: string,
): Promise<void> {
  const cost = toCost(unitCost);
  const qty = toQuantity(receivedQty);
  const { rows } = await sql<{ avg_cost: string; qty_basis: string }>`
    select avg_cost, qty_basis from variant_costs where tenant_id = ${tenantId} and variant_id = ${variantId}
    for update`.execute(tx);
  const current = rows[0] ?? { avg_cost: '0', qty_basis: '0' };
  const currentBasis = new Dec(current.qty_basis);
  const newBasis = currentBasis.plus(qty);
  const newAvg = newBasis.isZero()
    ? cost
    : currentBasis.times(current.avg_cost).plus(qty.times(cost)).dividedBy(newBasis);

  await sql`insert into variant_costs (tenant_id, variant_id, avg_cost, qty_basis, last_cost, updated_at)
            values (${tenantId}, ${variantId}, ${formatCost(newAvg)}, ${formatQuantity(newBasis)}, ${formatCost(cost)}, now())
            on conflict (tenant_id, variant_id) do update set
              avg_cost = excluded.avg_cost, qty_basis = excluded.qty_basis, last_cost = excluded.last_cost,
              updated_at = now()`.execute(tx);
}

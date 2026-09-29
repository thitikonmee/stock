import { sql } from 'kysely';
import type { Tx } from '@stockos/database';

/** Current moving-average unit cost for a variant (0 if it has never been received). */
export async function readAvgCost(tx: Tx, tenantId: string, variantId: string): Promise<string> {
  const { rows } = await sql<{ avg_cost: string }>`
    select avg_cost from variant_costs where tenant_id = ${tenantId} and variant_id = ${variantId}`.execute(
    tx,
  );
  return rows[0]?.avg_cost ?? '0.0000';
}

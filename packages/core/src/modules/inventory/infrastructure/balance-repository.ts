import { sql, type RawBuilder } from 'kysely';
import { PgErrorCode, pgErrorCode, type Tx } from '@stockos/database';
import { Dec, ValidationError, formatQuantity } from '@stockos/shared';
import type { Bucket, Guard } from '../domain/operations';
import type { BalanceSnapshot } from '../domain/types';

/** Whitelisted column per bucket — never build identifiers from input. */
const COLUMN: Record<Bucket, string> = {
  ON_HAND: 'on_hand',
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  DAMAGED: 'damaged',
  INCOMING: 'incoming',
};

interface BalanceRow {
  warehouse_id: string;
  variant_id: string;
  on_hand: string;
  reserved: string;
  committed: string;
  damaged: string;
  incoming: string;
  available: string;
  version: string;
}

export interface UpdatedBalance extends BalanceSnapshot {
  productId: string;
}

export interface ApplyDeltaInput {
  tenantId: string;
  warehouseId: string;
  variantId: string;
  deltas: Partial<Record<Bucket, Dec>>;
  guard: Guard;
  guardQuantity: Dec;
  minRemaining: Dec;
  allowNegative: boolean;
}

export type ApplyDeltaOutcome =
  { ok: true; balance: UpdatedBalance } | { ok: false; reason: 'GUARD' | 'CHECK' };

const ZERO = new Dec(0);

/**
 * Single-statement conditional update. The row lock taken by UPDATE plus Postgres re-checking the
 * WHERE clause after waiting (READ COMMITTED EvalPlanQual) is what prevents overselling.
 */
export async function applyBalanceDelta(tx: Tx, input: ApplyDeltaInput): Promise<ApplyDeltaOutcome> {
  const d = (bucket: Bucket) => formatQuantity(input.deltas[bucket] ?? ZERO);
  try {
    const { rows } = await sql<BalanceRow & { product_id: string }>`
      update inventory_balances b
         set on_hand    = b.on_hand   + ${d('ON_HAND')}::numeric,
             reserved   = b.reserved  + ${d('RESERVED')}::numeric,
             committed  = b.committed + ${d('COMMITTED')}::numeric,
             damaged    = b.damaged   + ${d('DAMAGED')}::numeric,
             incoming   = b.incoming  + ${d('INCOMING')}::numeric,
             version    = b.version + 1,
             updated_at = now()
        from product_variants pv
       where b.tenant_id = ${input.tenantId}
         and b.warehouse_id = ${input.warehouseId}
         and b.variant_id = ${input.variantId}
         and pv.tenant_id = b.tenant_id
         and pv.id = b.variant_id
         and (${guardSql(input)})
      returning b.warehouse_id, b.variant_id, pv.product_id, b.on_hand, b.reserved, b.committed,
                b.damaged, b.incoming, b.available, b.version`.execute(tx);
    const row = rows[0];
    return row
      ? { ok: true, balance: { ...toSnapshot(row), productId: row.product_id } }
      : { ok: false, reason: 'GUARD' };
  } catch (err) {
    // CHECK constraints (bucket >= 0, on_hand >= 0 unless negative allowed) are the last line of defence.
    if (pgErrorCode(err) === PgErrorCode.CheckViolation) return { ok: false, reason: 'CHECK' };
    throw err;
  }
}

function guardSql(input: ApplyDeltaInput): RawBuilder<unknown> {
  const qty = formatQuantity(input.guardQuantity);
  const negativeOk = sql`(${input.allowNegative}::boolean and b.negative_allowed)`;
  switch (input.guard.kind) {
    case 'NONE':
      return sql`true`;
    case 'AVAILABLE':
      return sql`(b.on_hand - b.reserved - b.committed - ${formatQuantity(input.minRemaining)}::numeric >= ${qty}::numeric
                  or ${negativeOk})`;
    case 'BUCKET': {
      const column = sql.ref(`b.${COLUMN[input.guard.bucket]}`);
      return input.guard.bucket === 'ON_HAND'
        ? sql`(${column} >= ${qty}::numeric or ${negativeOk})`
        : sql`${column} >= ${qty}::numeric`;
    }
  }
}

/**
 * Create the balance row for a (warehouse, variant) if missing, copying the warehouse's
 * negative-stock policy. Does not lock an existing row. Unknown ids (or ids of another tenant,
 * hidden by RLS) insert nothing or fail the FK — both surface as ValidationError.
 */
export async function ensureBalanceRow(tx: Tx, tenantId: string, warehouseId: string, variantId: string) {
  try {
    await sql`
      insert into inventory_balances (tenant_id, warehouse_id, variant_id, negative_allowed)
      select ${tenantId}, w.id, ${variantId}, w.allow_negative_stock
        from warehouses w
       where w.tenant_id = ${tenantId} and w.id = ${warehouseId}
      on conflict do nothing`.execute(tx);
  } catch (err) {
    if (pgErrorCode(err) === PgErrorCode.ForeignKeyViolation) {
      throw new ValidationError('Unknown warehouse or variant', { warehouseId, variantId });
    }
    throw err;
  }
}

export async function readBalances(
  tx: Tx,
  tenantId: string,
  keys: readonly { warehouseId: string; variantId: string }[],
): Promise<BalanceSnapshot[]> {
  if (keys.length === 0) return [];
  const { rows } = await sql<BalanceRow>`
    select b.warehouse_id, b.variant_id, b.on_hand, b.reserved, b.committed,
           b.damaged, b.incoming, b.available, b.version
      from inventory_balances b
      join unnest(${keys.map((k) => k.warehouseId)}::uuid[], ${keys.map((k) => k.variantId)}::uuid[])
           as k(warehouse_id, variant_id)
        on k.warehouse_id = b.warehouse_id and k.variant_id = b.variant_id
     where b.tenant_id = ${tenantId}
     order by b.warehouse_id, b.variant_id`.execute(tx);
  return rows.map(toSnapshot);
}

function toSnapshot(row: BalanceRow): BalanceSnapshot {
  return {
    warehouseId: row.warehouse_id,
    variantId: row.variant_id,
    onHand: row.on_hand,
    reserved: row.reserved,
    committed: row.committed,
    damaged: row.damaged,
    incoming: row.incoming,
    available: row.available,
    version: String(row.version),
  };
}

export function bucketValue(balance: BalanceSnapshot, bucket: Bucket): string {
  switch (bucket) {
    case 'ON_HAND':
      return balance.onHand;
    case 'RESERVED':
      return balance.reserved;
    case 'COMMITTED':
      return balance.committed;
    case 'DAMAGED':
      return balance.damaged;
    case 'INCOMING':
      return balance.incoming;
  }
}

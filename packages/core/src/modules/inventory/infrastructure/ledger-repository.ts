import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { Dec, formatQuantity, uuidv7 } from '@stockos/shared';
import { BUCKETS, type Bucket, type LedgerTransactionType } from '../domain/operations';
import type { MovementCommand } from '../domain/types';
import { bucketValue, type UpdatedBalance } from './balance-repository';

export interface StoredMovement {
  id: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
}

/**
 * Insert the movement header. Returns false when the idempotency key already exists.
 * A concurrent insert with the same key waits for the first transaction, then sees the conflict.
 */
export async function insertMovement(tx: Tx, movementId: string, cmd: MovementCommand): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    insert into inventory_movements (tenant_id, id, idempotency_key, movement_type, reference_type,
                                     reference_id, channel_code, user_id, request_id)
    values (${cmd.tenantId}, ${movementId}, ${cmd.idempotencyKey}, ${cmd.operation}, ${cmd.reference.type},
            ${cmd.reference.id}, ${cmd.channelCode ?? null}, ${cmd.userId ?? null}, ${cmd.requestId ?? null})
    on conflict (tenant_id, idempotency_key) do nothing
    returning id`.execute(tx);
  return rows.length === 1;
}

export async function findMovementByKey(
  tx: Tx,
  tenantId: string,
  idempotencyKey: string,
): Promise<StoredMovement | undefined> {
  const { rows } = await sql<{
    id: string;
    movement_type: string;
    reference_type: string;
    reference_id: string;
  }>`
    select id, movement_type, reference_type, reference_id
      from inventory_movements
     where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`.execute(tx);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        movementType: row.movement_type,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
      }
    : undefined;
}

export async function movementKeys(tx: Tx, tenantId: string, movementId: string) {
  const { rows } = await sql<{ warehouse_id: string; variant_id: string }>`
    select distinct warehouse_id, variant_id
      from inventory_transactions
     where tenant_id = ${tenantId} and movement_id = ${movementId}`.execute(tx);
  return rows.map((r) => ({ warehouseId: r.warehouse_id, variantId: r.variant_id }));
}

export interface LedgerLineInput {
  movementId: string;
  ledgerType: LedgerTransactionType;
  cmd: MovementCommand;
  line: { locationId?: string; referenceLineId?: string; unitCost?: string };
  deltas: Partial<Record<Bucket, Dec>>;
  after: UpdatedBalance;
}

/** One ledger row per bucket touched; before = after − delta, taken from the locked row. */
export async function insertLedgerLines(tx: Tx, input: LedgerLineInput): Promise<void> {
  const { cmd, after, line } = input;
  const occurredAt = cmd.occurredAt ?? new Date();
  const values = BUCKETS.flatMap((bucket) => {
    const delta = input.deltas[bucket];
    if (!delta || delta.isZero()) return [];
    const afterQty = new Dec(bucketValue(after, bucket));
    return [
      sql`(${cmd.tenantId}, ${uuidv7()}, ${input.movementId}, ${after.warehouseId}, ${line.locationId ?? null},
           ${after.productId}, ${after.variantId}, ${input.ledgerType}, ${bucket},
           ${formatQuantity(delta)}::numeric, ${formatQuantity(afterQty.minus(delta))}::numeric,
           ${formatQuantity(afterQty)}::numeric, ${after.version}::bigint, ${line.unitCost ?? null}::numeric,
           ${cmd.reference.type}, ${cmd.reference.id}, ${line.referenceLineId ?? null},
           ${cmd.channelCode ?? null}, ${cmd.channelAccountId ?? null}, ${cmd.userId ?? null},
           ${cmd.deviceId ?? null}, ${cmd.reasonCode ?? null}, ${cmd.note ?? null},
           ${occurredAt}, ${cmd.requestId ?? null})`,
    ];
  });
  if (values.length === 0) return;
  await sql`
    insert into inventory_transactions (tenant_id, id, movement_id, warehouse_id, location_id, product_id,
      variant_id, transaction_type, bucket, quantity, before_quantity, after_quantity, balance_version, unit_cost,
      reference_type, reference_id, reference_line_id, channel_code, channel_account_id, user_id,
      device_id, reason_code, note, occurred_at, request_id)
    values ${sql.join(values)}`.execute(tx);
}

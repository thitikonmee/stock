import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  formatCost,
  formatQuantity,
  isUuid,
  toCost,
  toQuantity,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { InventoryEngine } from './inventory-engine';

export type AdjustmentReasonCode =
  'DAMAGE' | 'LOST' | 'FOUND' | 'COUNT_ERROR' | 'EXPIRED' | 'OPENING' | 'OTHER';
export type AdjustmentStatus =
  'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'REJECTED' | 'CANCELLED';
export type AdjustmentBucket = 'ON_HAND' | 'DAMAGED';

export interface AdjustmentItem {
  id: string;
  variantId: string;
  bucket: AdjustmentBucket;
  quantityDelta: string;
  unitCost: string | null;
  note: string | null;
}
export interface Adjustment {
  id: string;
  docNo: string;
  warehouseId: string;
  reasonCode: AdjustmentReasonCode;
  status: AdjustmentStatus;
  note: string | null;
  requestedBy: string;
  approvedBy: string | null;
  items: AdjustmentItem[];
}

export interface AdjustmentItemInput {
  variantId: string;
  bucket?: AdjustmentBucket;
  quantityDelta: string;
  unitCost?: string;
  note?: string;
}
export interface CreateAdjustmentInput {
  warehouseId: string;
  reasonCode: AdjustmentReasonCode;
  note?: string;
  items: readonly AdjustmentItemInput[];
}

const MAX_ITEMS = 500;

/**
 * Manual stock adjustments always go through a one-step approval (segregation of duties: the DB
 * itself rejects `approved_by = requested_by`), then post through InventoryEngine's signed ADJUST /
 * ADJUST_DAMAGED operations. A configurable auto-approve-below-value threshold is not implemented —
 * every adjustment needs `inventory.adjust.approve` from someone other than the requester.
 */
export class AdjustmentService {
  private readonly engine = new InventoryEngine();

  async create(tx: Tx, principal: Principal, input: CreateAdjustmentInput): Promise<Adjustment> {
    assertCan(principal, 'inventory.adjust', { warehouseId: input.warehouseId });
    if (!isUuid(input.warehouseId)) throw new ValidationError('Unknown warehouse');
    if (input.items.length === 0 || input.items.length > MAX_ITEMS) {
      throw new ValidationError(`An adjustment needs 1..${MAX_ITEMS} items`);
    }
    const { rows: whRows } = await sql`select 1 from warehouses where id = ${input.warehouseId}`.execute(tx);
    if (whRows.length === 0)
      throw new ValidationError('Unknown warehouse', { warehouseId: input.warehouseId });

    const id = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'ADJ');
    await sql`insert into stock_adjustments (tenant_id, id, doc_no, warehouse_id, reason_code, status,
                                             source_type, note, requested_by)
              values (${principal.tenantId}, ${id}, ${docNo}, ${input.warehouseId}, ${input.reasonCode},
                      'PENDING_APPROVAL', 'MANUAL', ${input.note ?? null}, ${principal.membershipId})`.execute(
      tx,
    );

    for (const item of input.items) {
      if (!isUuid(item.variantId))
        throw new ValidationError('Unknown variant', { variantId: item.variantId });
      const { rows: vRows } =
        await sql`select 1 from product_variants where id = ${item.variantId} and deleted_at is null`.execute(
          tx,
        );
      if (vRows.length === 0) throw new ValidationError('Unknown variant', { variantId: item.variantId });
      const delta = toQuantity(item.quantityDelta, { allowNegative: true });
      if (delta.isZero()) throw new ValidationError('quantityDelta must not be zero');
      await sql`insert into stock_adjustment_items (tenant_id, id, adjustment_id, variant_id, bucket,
                                                     quantity_delta, unit_cost, note)
                values (${principal.tenantId}, ${uuidv7()}, ${id}, ${item.variantId}, ${item.bucket ?? 'ON_HAND'},
                        ${formatQuantity(delta)}, ${item.unitCost ? formatCost(toCost(item.unitCost)) : null},
                        ${item.note ?? null})`.execute(tx);
    }

    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.adjustment.create',
      resourceType: 'stock_adjustment',
      resourceId: id,
      after: {
        docNo,
        warehouseId: input.warehouseId,
        reasonCode: input.reasonCode,
        items: input.items.length,
      },
    });
    return this.getOrThrow(tx, id);
  }

  async approve(tx: Tx, principal: Principal, id: string): Promise<Adjustment> {
    const adj = await this.getOrThrow(tx, id);
    assertCan(principal, 'inventory.adjust.approve', { warehouseId: adj.warehouseId });
    if (adj.status !== 'PENDING_APPROVAL') {
      throw new BusinessRuleError(
        'ADJUSTMENT_NOT_PENDING',
        `Adjustment is ${adj.status}, not PENDING_APPROVAL`,
      );
    }
    if (adj.requestedBy === principal.membershipId) {
      throw new ForbiddenError(
        'You cannot approve your own adjustment',
        { adjustmentId: id },
        'PRIVILEGE_ESCALATION',
      );
    }

    await sql`update stock_adjustments set status = 'APPROVED', approved_by = ${principal.membershipId},
                     approved_at = now() where id = ${id}`.execute(tx);

    for (const item of adj.items) {
      const operation = item.bucket === 'DAMAGED' ? 'ADJUST_DAMAGED' : 'ADJUST';
      await this.engine.apply(tx, {
        tenantId: principal.tenantId,
        operation,
        idempotencyKey: `adjustment:${id}:${item.id}`,
        reference: { type: 'ADJUSTMENT', id },
        reasonCode: adj.reasonCode,
        userId: principal.membershipId,
        ...(adj.note ? { note: adj.note } : {}),
        lines: [
          {
            warehouseId: adj.warehouseId,
            variantId: item.variantId,
            quantity: item.quantityDelta,
            ...(item.unitCost ? { unitCost: item.unitCost } : {}),
          },
        ],
      });
    }

    await sql`update stock_adjustments set status = 'POSTED', posted_at = now() where id = ${id}`.execute(tx);
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.adjustment.approve',
      resourceType: 'stock_adjustment',
      resourceId: id,
      after: { status: 'POSTED' },
    });
    return this.getOrThrow(tx, id);
  }

  async reject(tx: Tx, principal: Principal, id: string, note?: string): Promise<Adjustment> {
    const adj = await this.getOrThrow(tx, id);
    assertCan(principal, 'inventory.adjust.approve', { warehouseId: adj.warehouseId });
    if (adj.status !== 'PENDING_APPROVAL') {
      throw new BusinessRuleError(
        'ADJUSTMENT_NOT_PENDING',
        `Adjustment is ${adj.status}, not PENDING_APPROVAL`,
      );
    }
    await sql`update stock_adjustments set status = 'REJECTED', approved_by = ${principal.membershipId},
                     approved_at = now(), note = coalesce(${note ?? null}, note) where id = ${id}`.execute(
      tx,
    );
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'inventory.adjustment.reject',
      resourceType: 'stock_adjustment',
      resourceId: id,
    });
    return this.getOrThrow(tx, id);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Adjustment> {
    assertCan(principal, 'inventory.read');
    return this.getOrThrow(tx, id);
  }

  async list(
    tx: Tx,
    principal: Principal,
    query: { status?: AdjustmentStatus; warehouseId?: string } = {},
  ): Promise<Adjustment[]> {
    assertCan(principal, 'inventory.read');
    const { rows } = await sql<AdjustmentRow>`
      select ${adjCols} from stock_adjustments
       where (${query.status ?? null}::text is null or status = ${query.status ?? null})
         and (${query.warehouseId ?? null}::uuid is null or warehouse_id = ${query.warehouseId ?? null})
       order by created_at desc limit 200`.execute(tx);
    return Promise.all(rows.map((r) => this.hydrate(tx, r)));
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Adjustment> {
    if (!isUuid(id)) throw new NotFoundError('Adjustment not found');
    const { rows } =
      await sql<AdjustmentRow>`select ${adjCols} from stock_adjustments where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Adjustment not found');
    return this.hydrate(tx, row);
  }

  private async hydrate(tx: Tx, row: AdjustmentRow): Promise<Adjustment> {
    const { rows: items } = await sql<ItemRow>`
      select id, variant_id, bucket, quantity_delta, unit_cost, note
        from stock_adjustment_items where adjustment_id = ${row.id} order by id`.execute(tx);
    return {
      id: row.id,
      docNo: row.doc_no,
      warehouseId: row.warehouse_id,
      reasonCode: row.reason_code,
      status: row.status,
      note: row.note,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      items: items.map((i) => ({
        id: i.id,
        variantId: i.variant_id,
        bucket: i.bucket,
        quantityDelta: i.quantity_delta,
        unitCost: i.unit_cost,
        note: i.note,
      })),
    };
  }
}

interface AdjustmentRow {
  id: string;
  doc_no: string;
  warehouse_id: string;
  reason_code: AdjustmentReasonCode;
  status: AdjustmentStatus;
  note: string | null;
  requested_by: string;
  approved_by: string | null;
}
const adjCols = sql`id, doc_no, warehouse_id, reason_code, status, note, requested_by, approved_by`;

interface ItemRow {
  id: string;
  variant_id: string;
  bucket: AdjustmentBucket;
  quantity_delta: string;
  unit_cost: string | null;
  note: string | null;
}

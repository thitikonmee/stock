import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  Dec,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  formatQuantity,
  isUuid,
  toQuantity,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, can, type Principal } from '../../iam/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { InventoryEngine } from './inventory-engine';

export type CountType = 'FULL' | 'CYCLE' | 'BLIND' | 'SPOT';
export type CountStatus =
  'DRAFT' | 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'CANCELLED';

export interface CountItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  /** Hidden (null) from counters on a BLIND count. */
  snapshotQty: string | null;
  countedQty: string | null;
  movementSinceSnapshot: string | null;
  /** counted − (snapshot + movement since snapshot); null until submitted, or never counted. */
  variance: string | null;
  countedAt: string | null;
  recountRequired: boolean;
}

export interface StockCount {
  id: string;
  docNo: string;
  warehouseId: string;
  countType: CountType;
  status: CountStatus;
  varianceTolerance: string;
  createdBy: string;
  approvedBy: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  postedAdjustmentId: string | null;
  version: number;
  createdAt: string;
  totals: { items: number; counted: number; withVariance: number; recountRequired: number };
  items: CountItem[];
}

export interface CreateCountInput {
  warehouseId: string;
  countType: CountType;
  /** CYCLE/SPOT need at least one of these; FULL/BLIND default to every stock-tracked SKU. */
  variantIds?: readonly string[];
  categoryIds?: readonly string[];
  varianceTolerance?: string;
}

export interface CountLineInput {
  variantId: string;
  quantity: string;
  /** When the shelf was actually counted (offline devices sync later). Defaults to now. */
  countedAt?: string;
}

const MAX_LINES_PER_CALL = 1000;

/**
 * Stock counts without stopping sales (docs/04-inventory.md §9 "Stock Count").
 *
 * Creating a count snapshots each SKU's on_hand together with its balance row's `version`. Because
 * the ledger stamps every change with that row's version, the stock that moved between the snapshot
 * and the moment the shelf was counted is Σ ON_HAND deltas with version > snapshot version and
 * occurred_at ≤ counted_at — exact per row, regardless of commit timing or sales happening on other
 * devices meanwhile, and correct for offline counts and offline POS sales (both carry business time).
 *
 * Several devices may record counts at once: `SET` overwrites a line, `ADD` increments it atomically
 * (scanning one unit at a time). Recording holds a FOR SHARE lock on the count, so they run in
 * parallel with each other but never interleave with submit/approve.
 */
export class CountService {
  private readonly engine = new InventoryEngine();

  async create(tx: Tx, principal: Principal, input: CreateCountInput): Promise<StockCount> {
    assertCan(principal, 'inventory.count', { warehouseId: input.warehouseId });
    if (!isUuid(input.warehouseId)) throw new ValidationError('Unknown warehouse');
    const { rows: wh } = await sql`select 1 from warehouses where id = ${input.warehouseId}`.execute(tx);
    if (wh.length === 0) throw new ValidationError('Unknown warehouse');
    const variantIds = [...new Set(input.variantIds ?? [])];
    const categoryIds = [...new Set(input.categoryIds ?? [])];
    for (const id of [...variantIds, ...categoryIds]) {
      if (!isUuid(id)) throw new ValidationError('Invalid id in scope', { id });
    }
    if (
      (input.countType === 'CYCLE' || input.countType === 'SPOT') &&
      variantIds.length + categoryIds.length === 0
    ) {
      throw new ValidationError(`${input.countType} counts need variantIds or categoryIds`);
    }
    const tolerance = input.varianceTolerance
      ? toQuantity(input.varianceTolerance, { allowZero: true })
      : new Dec(0);

    const id = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'CNT');
    await sql`insert into stock_counts (tenant_id, id, doc_no, warehouse_id, count_type, status, scope, freeze_mode,
                                        started_at, created_by, variance_tolerance)
              values (${principal.tenantId}, ${id}, ${docNo}, ${input.warehouseId}, ${input.countType}, 'IN_PROGRESS',
                      ${JSON.stringify({ variant_ids: variantIds, category_ids: categoryIds })}::jsonb, 'SNAPSHOT',
                      now(), ${principal.membershipId}, ${formatQuantity(tolerance)})`.execute(tx);

    // One INSERT…SELECT for the whole scope (thousands of SKUs): snapshot on_hand + row version.
    const { rows: inserted } = await sql`
      insert into stock_count_items (tenant_id, id, count_id, variant_id, snapshot_qty, snapshot_balance_version)
      select ${principal.tenantId}, uuid_generate_v7(), ${id}, v.id, coalesce(b.on_hand, 0), coalesce(b.version, 0)
        from product_variants v
        join products p on p.id = v.product_id
        left join inventory_balances b on b.warehouse_id = ${input.warehouseId} and b.variant_id = v.id
       where v.deleted_at is null and p.deleted_at is null and p.track_inventory and v.status <> 'ARCHIVED'
         and (cardinality(${variantIds}::uuid[]) = 0 and cardinality(${categoryIds}::uuid[]) = 0
              or v.id = any(${variantIds}::uuid[])
              or p.category_id = any(${categoryIds}::uuid[]))
      returning 1`.execute(tx);
    if (inserted.length === 0) {
      throw new ValidationError('No stock-tracked SKUs match this count scope');
    }

    await this.audit(tx, principal, id, 'inventory.count.create', {
      docNo,
      countType: input.countType,
      items: inserted.length,
    });
    return this.getOrThrow(tx, principal, id);
  }

  /** Records counted quantities from one device. Returns how many lines were applied. */
  async record(
    tx: Tx,
    principal: Principal,
    id: string,
    mode: 'SET' | 'ADD',
    lines: readonly CountLineInput[],
  ): Promise<{ applied: number }> {
    if (lines.length === 0 || lines.length > MAX_LINES_PER_CALL) {
      throw new ValidationError(`Send 1..${MAX_LINES_PER_CALL} lines per call`);
    }
    if (!isUuid(id)) throw new NotFoundError('Count not found');
    const { rows } = await sql<{ warehouse_id: string; status: CountStatus }>`
      select warehouse_id, status from stock_counts where id = ${id} for share`.execute(tx);
    const count = rows[0];
    if (!count) throw new NotFoundError('Count not found');
    assertCan(principal, 'inventory.count', { warehouseId: count.warehouse_id });
    if (count.status !== 'IN_PROGRESS') {
      throw new BusinessRuleError('INVALID_STATE_TRANSITION', `Count is ${count.status}`, {
        status: count.status,
      });
    }

    let applied = 0;
    for (const line of lines) {
      if (!isUuid(line.variantId))
        throw new ValidationError('Unknown variant', { variantId: line.variantId });
      const qty = toQuantity(line.quantity, { allowZero: true });
      const countedAt = line.countedAt ? parseTimestamp(line.countedAt) : null;
      const { rows: updated } =
        mode === 'ADD'
          ? await sql`update stock_count_items
                         set counted_qty = coalesce(counted_qty, 0) + ${formatQuantity(qty)},
                             counted_at = greatest(coalesce(counted_at, '-infinity'), coalesce(${countedAt}::timestamptz, now())),
                             counted_by = ${principal.membershipId}, recount_required = false
                       where count_id = ${id} and variant_id = ${line.variantId} and location_id is null
                      returning id`.execute(tx)
          : await sql`update stock_count_items
                         set counted_qty = ${formatQuantity(qty)},
                             counted_at = coalesce(${countedAt}::timestamptz, now()),
                             counted_by = ${principal.membershipId}, recount_required = false
                       where count_id = ${id} and variant_id = ${line.variantId} and location_id is null
                      returning id`.execute(tx);
      if (updated.length === 0) {
        throw new ValidationError('SKU is not part of this count', { variantId: line.variantId });
      }
      applied++;
    }
    return { applied };
  }

  /**
   * IN_PROGRESS → PENDING_APPROVAL. Computes, for every counted line, the stock that moved between
   * the snapshot and its count, the variance, and flags lines beyond the tolerance for a recount.
   */
  async submit(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<StockCount> {
    const c = await this.lock(tx, id);
    assertCan(principal, 'inventory.count', { warehouseId: c.warehouse_id });
    this.checkVersion(c, expectedVersion);
    this.requireStatus(c, ['IN_PROGRESS']);
    const { rows: counted } = await sql<{ n: number }>`
      select count(*)::int as n from stock_count_items where count_id = ${id} and counted_qty is not null`.execute(
      tx,
    );
    if (counted[0]!.n === 0) throw new ValidationError('Nothing has been counted yet');

    await sql`
      update stock_count_items ci
         set movement_since_snapshot = m.moved,
             variance = ci.counted_qty - (ci.snapshot_qty + m.moved),
             recount_required = abs(ci.counted_qty - (ci.snapshot_qty + m.moved)) > ${c.variance_tolerance}
        from (
          select ci2.id,
                 coalesce((select sum(t.quantity) from inventory_transactions t
                            where t.warehouse_id = ${c.warehouse_id} and t.variant_id = ci2.variant_id
                              and t.bucket = 'ON_HAND' and t.balance_version > ci2.snapshot_balance_version
                              and t.occurred_at <= ci2.counted_at), 0) as moved
            from stock_count_items ci2
           where ci2.count_id = ${id} and ci2.counted_qty is not null
        ) m
       where ci.id = m.id`.execute(tx);
    await sql`update stock_counts set status = 'PENDING_APPROVAL', submitted_at = now(), version = version + 1,
                     updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.count.submit');
    return this.getOrThrow(tx, principal, id);
  }

  /** PENDING_APPROVAL → IN_PROGRESS so lines flagged for recount can be counted again. */
  async requestRecount(
    tx: Tx,
    principal: Principal,
    id: string,
    expectedVersion: number,
  ): Promise<StockCount> {
    const c = await this.lock(tx, id);
    assertCan(principal, 'inventory.count.approve', { warehouseId: c.warehouse_id });
    this.checkVersion(c, expectedVersion);
    this.requireStatus(c, ['PENDING_APPROVAL']);
    await sql`update stock_count_items set counted_qty = null, counted_at = null, variance = null,
                     movement_since_snapshot = 0
               where count_id = ${id} and recount_required`.execute(tx);
    await sql`update stock_counts set status = 'IN_PROGRESS', version = version + 1, updated_at = now()
               where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.count.recount');
    return this.getOrThrow(tx, principal, id);
  }

  /**
   * PENDING_APPROVAL → POSTED: every non-zero variance becomes one COUNT_VARIANCE ledger line, under a
   * stock_adjustment (source COUNT) for the audit trail. The variance is a delta relative to what was
   * on the shelf when counted, so stock sold since then doesn't distort it. Approver ≠ creator.
   */
  async approve(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<StockCount> {
    const c = await this.lock(tx, id);
    assertCan(principal, 'inventory.count.approve', { warehouseId: c.warehouse_id });
    this.checkVersion(c, expectedVersion);
    this.requireStatus(c, ['PENDING_APPROVAL']);
    if (c.created_by === principal.membershipId) {
      throw new ForbiddenError('You cannot approve your own count', { countId: id }, 'PRIVILEGE_ESCALATION');
    }
    const { rows: diffs } = await sql<{ variant_id: string; variance: string }>`
      select variant_id, variance from stock_count_items
       where count_id = ${id} and variance is not null and variance <> 0 order by id`.execute(tx);

    let adjustmentId: string | null = null;
    if (diffs.length > 0) {
      adjustmentId = uuidv7();
      const docNo = await nextDocumentNumber(tx, principal.tenantId, 'ADJ');
      await sql`insert into stock_adjustments (tenant_id, id, doc_no, warehouse_id, reason_code, status, source_type,
                                               source_id, note, requested_by, approved_by, approved_at, posted_at)
                values (${principal.tenantId}, ${adjustmentId}, ${docNo}, ${c.warehouse_id}, 'COUNT_ERROR', 'POSTED',
                        'COUNT', ${id}, ${`Stock count ${c.doc_no}`}, ${c.created_by}, ${principal.membershipId},
                        now(), now())`.execute(tx);
      for (const d of diffs) {
        await sql`insert into stock_adjustment_items (tenant_id, id, adjustment_id, variant_id, bucket, quantity_delta)
                  values (${principal.tenantId}, ${uuidv7()}, ${adjustmentId}, ${d.variant_id}, 'ON_HAND',
                          ${d.variance})`.execute(tx);
      }
      await this.engine.apply(tx, {
        tenantId: principal.tenantId,
        operation: 'COUNT_VARIANCE',
        idempotencyKey: `count:${id}:post`,
        reference: { type: 'COUNT', id },
        reasonCode: 'COUNT_ERROR',
        userId: principal.membershipId,
        lines: diffs.map((d) => ({
          warehouseId: c.warehouse_id,
          variantId: d.variant_id,
          quantity: d.variance,
        })),
      });
    }
    await sql`update stock_counts set status = 'POSTED', approved_by = ${principal.membershipId},
                     posted_adjustment_id = ${adjustmentId}, version = version + 1, updated_at = now()
               where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.count.approve', { adjustedLines: diffs.length });
    return this.getOrThrow(tx, principal, id);
  }

  async cancel(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<StockCount> {
    const c = await this.lock(tx, id);
    assertCan(principal, 'inventory.count', { warehouseId: c.warehouse_id });
    this.checkVersion(c, expectedVersion);
    this.requireStatus(c, ['DRAFT', 'IN_PROGRESS', 'PENDING_APPROVAL']);
    await sql`update stock_counts set status = 'CANCELLED', version = version + 1, updated_at = now() where id = ${id}`.execute(
      tx,
    );
    await this.audit(tx, principal, id, 'inventory.count.cancel');
    return this.getOrThrow(tx, principal, id);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<StockCount> {
    assertCan(principal, 'inventory.read');
    return this.getOrThrow(tx, principal, id);
  }

  async list(
    tx: Tx,
    principal: Principal,
    query: { status?: CountStatus; warehouseId?: string } = {},
  ): Promise<Omit<StockCount, 'items'>[]> {
    assertCan(principal, 'inventory.read');
    if (query.warehouseId && !isUuid(query.warehouseId)) return [];
    const { rows } = await sql<{ id: string }>`
      select id from stock_counts
       where (${query.status ?? null}::text is null or status = ${query.status ?? null})
         and (${query.warehouseId ?? null}::uuid is null or warehouse_id = ${query.warehouseId ?? null})
       order by created_at desc limit 200`.execute(tx);
    const out: Omit<StockCount, 'items'>[] = [];
    for (const r of rows) {
      const { items: _items, ...rest } = await this.getOrThrow(tx, principal, r.id, false);
      out.push(rest);
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private async lock(tx: Tx, id: string): Promise<CountRow> {
    if (!isUuid(id)) throw new NotFoundError('Count not found');
    const { rows } = await sql<CountRow>`
      select id, doc_no, warehouse_id, status, created_by, variance_tolerance, version
        from stock_counts where id = ${id} for update`.execute(tx);
    if (!rows[0]) throw new NotFoundError('Count not found');
    return rows[0];
  }

  private checkVersion(c: CountRow, expected: number): void {
    if (c.version !== expected) {
      throw new PreconditionFailedError('Count was changed by someone else', { currentVersion: c.version });
    }
  }

  private requireStatus(c: CountRow, allowed: CountStatus[]): void {
    if (!allowed.includes(c.status)) {
      throw new BusinessRuleError('INVALID_STATE_TRANSITION', `Count is ${c.status}`, {
        status: c.status,
        allowed,
      });
    }
  }

  private async audit(
    tx: Tx,
    principal: Principal,
    id: string,
    action: string,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action,
      resourceType: 'stock_count',
      resourceId: id,
      ...(after ? { after } : {}),
    });
  }

  private async getOrThrow(tx: Tx, principal: Principal, id: string, withItems = true): Promise<StockCount> {
    if (!isUuid(id)) throw new NotFoundError('Count not found');
    const { rows } = await sql<{
      id: string;
      doc_no: string;
      warehouse_id: string;
      count_type: CountType;
      status: CountStatus;
      variance_tolerance: string;
      created_by: string;
      approved_by: string | null;
      started_at: Date | null;
      submitted_at: Date | null;
      posted_adjustment_id: string | null;
      version: number;
      created_at: Date;
      items: number;
      counted: number;
      with_variance: number;
      recount: number;
    }>`
      select c.id, c.doc_no, c.warehouse_id, c.count_type, c.status, c.variance_tolerance, c.created_by,
             c.approved_by, c.started_at, c.submitted_at, c.posted_adjustment_id, c.version, c.created_at,
             (select count(*)::int from stock_count_items i where i.count_id = c.id) as items,
             (select count(*)::int from stock_count_items i where i.count_id = c.id and i.counted_qty is not null) as counted,
             (select count(*)::int from stock_count_items i where i.count_id = c.id and i.variance <> 0) as with_variance,
             (select count(*)::int from stock_count_items i where i.count_id = c.id and i.recount_required) as recount
        from stock_counts c where c.id = ${id}`.execute(tx);
    const c = rows[0];
    if (!c) throw new NotFoundError('Count not found');
    // Blind counts hide the expected figures from whoever is counting; approvers still see them.
    const hide =
      c.count_type === 'BLIND' &&
      c.status === 'IN_PROGRESS' &&
      !can(principal, 'inventory.count.approve', { warehouseId: c.warehouse_id });
    let items: CountItem[] = [];
    if (withItems) {
      const { rows: itemRows } = await sql<{
        id: string;
        variant_id: string;
        sku: string;
        variant_name: string;
        snapshot_qty: string;
        counted_qty: string | null;
        movement_since_snapshot: string;
        variance: string | null;
        counted_at: Date | null;
        recount_required: boolean;
      }>`
        select i.id, i.variant_id, v.sku, v.name as variant_name, i.snapshot_qty, i.counted_qty,
               i.movement_since_snapshot, i.variance, i.counted_at, i.recount_required
          from stock_count_items i join product_variants v on v.id = i.variant_id
         where i.count_id = ${id} order by v.sku`.execute(tx);
      items = itemRows.map((i) => ({
        id: i.id,
        variantId: i.variant_id,
        sku: i.sku,
        variantName: i.variant_name,
        snapshotQty: hide ? null : i.snapshot_qty,
        countedQty: i.counted_qty,
        movementSinceSnapshot: hide || i.variance === null ? null : i.movement_since_snapshot,
        variance: hide ? null : i.variance,
        countedAt: i.counted_at ? i.counted_at.toISOString() : null,
        recountRequired: i.recount_required,
      }));
    }
    return {
      id: c.id,
      docNo: c.doc_no,
      warehouseId: c.warehouse_id,
      countType: c.count_type,
      status: c.status,
      varianceTolerance: c.variance_tolerance,
      createdBy: c.created_by,
      approvedBy: c.approved_by,
      startedAt: c.started_at ? c.started_at.toISOString() : null,
      submittedAt: c.submitted_at ? c.submitted_at.toISOString() : null,
      postedAdjustmentId: c.posted_adjustment_id,
      version: c.version,
      createdAt: c.created_at.toISOString(),
      totals: {
        items: c.items,
        counted: c.counted,
        withVariance: c.with_variance,
        recountRequired: c.recount,
      },
      items,
    };
  }
}

function parseTimestamp(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError('countedAt must be an ISO timestamp');
  if (d.getTime() > Date.now() + 5 * 60_000) throw new ValidationError('countedAt is in the future');
  return d.toISOString();
}

interface CountRow {
  id: string;
  doc_no: string;
  warehouse_id: string;
  status: CountStatus;
  created_by: string;
  variance_tolerance: string;
  version: number;
}

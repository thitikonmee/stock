import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  Dec,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  formatCost,
  formatMoney,
  formatQuantity,
  isUuid,
  toCost,
  toMoney,
  toQuantity,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { InventoryEngine, applyMovingAverage } from '../../inventory/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';

export type PurchaseStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED';

export interface PurchaseItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  unitId: string;
  unitCode: string;
  unitFactor: string;
  /** In the purchase unit (e.g. boxes). */
  orderedQty: string;
  /** Base units, cumulative across goods receipts. */
  receivedQty: string;
  /** Base units written off when the PO was closed short. */
  cancelledQty: string;
  /** Base units still expected: ordered × factor − received − cancelled. */
  outstandingQty: string;
  unitCost: string;
  discountAmount: string;
  taxRate: string;
  lineTotal: string;
}

export interface Purchase {
  id: string;
  docNo: string;
  supplierId: string;
  supplierName: string;
  warehouseId: string;
  status: PurchaseStatus;
  expectedAt: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  note: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
  createdAt: string;
  items: PurchaseItem[];
  receipts: GoodsReceiptSummary[];
}

export interface GoodsReceiptSummary {
  id: string;
  docNo: string;
  supplierInvoiceNo: string | null;
  receivedAt: string;
  lines: number;
}

export interface PurchaseItemInput {
  variantId: string;
  /** Defaults to the product's base unit (factor 1). Otherwise must be one of its unit conversions. */
  unitId?: string;
  orderedQty: string;
  /** Cost per purchase unit, before tax. */
  unitCost: string;
  discountAmount?: string;
  taxRate?: string;
}

export interface CreatePurchaseInput {
  supplierId: string;
  warehouseId: string;
  expectedAt?: string;
  note?: string;
  items: readonly PurchaseItemInput[];
}

export interface ReceiveLineInput {
  purchaseItemId: string;
  /** Base units received in good condition. */
  quantity: string;
  lotNo?: string;
  expiryDate?: string;
}

export interface ReceiveInput {
  idempotencyKey: string;
  supplierInvoiceNo?: string;
  lines: readonly ReceiveLineInput[];
}

export interface PurchaseListQuery {
  status?: PurchaseStatus;
  supplierId?: string;
  warehouseId?: string;
}

export interface SupplierPerformance {
  supplierId: string;
  purchaseOrders: number;
  receivedOrders: number;
  /** Share of received POs whose first receipt landed on or before `expected_at` (null: no data). */
  onTimeRate: string | null;
  /** Σ received ÷ Σ ordered over approved POs, base units (null: nothing ordered yet). */
  fillRate: string | null;
  /** Mean days from approval to first receipt (null: nothing received yet). */
  avgLeadTimeDays: string | null;
  totalSpend: string;
}

const MAX_ITEMS = 500;
/** States that still expect goods (INCOMING was booked at approval). */
const RECEIVABLE: ReadonlySet<PurchaseStatus> = new Set(['APPROVED', 'SENT', 'PARTIALLY_RECEIVED']);

/**
 * Purchase orders (docs/04-inventory.md §9): approval books INCOMING, each goods receipt moves
 * INCOMING → ON_HAND (partial receipts allowed) and folds the line's cost into the moving average,
 * closing short cancels whatever INCOMING is left. Stock only ever changes through InventoryEngine.
 *
 * Every mutating call locks the PO row first, so a receipt racing an approval, a close or another
 * receipt serialises instead of double-booking `received_qty`.
 */
export class PurchaseService {
  private readonly engine = new InventoryEngine();

  async create(tx: Tx, principal: Principal, input: CreatePurchaseInput): Promise<Purchase> {
    assertCan(principal, 'purchase.create', { warehouseId: input.warehouseId });
    if (input.items.length === 0 || input.items.length > MAX_ITEMS) {
      throw new ValidationError(`A purchase order needs 1..${MAX_ITEMS} items`);
    }
    if (!isUuid(input.supplierId)) throw new ValidationError('Unknown supplier');
    if (!isUuid(input.warehouseId)) throw new ValidationError('Unknown warehouse');
    const { rows: sup } = await sql<{ is_active: boolean }>`
      select is_active from suppliers where id = ${input.supplierId}`.execute(tx);
    if (!sup[0]) throw new ValidationError('Unknown supplier');
    if (!sup[0].is_active) throw new ValidationError('Supplier is inactive');
    const { rows: wh } = await sql`select 1 from warehouses where id = ${input.warehouseId}`.execute(tx);
    if (wh.length === 0) throw new ValidationError('Unknown warehouse');
    if (input.expectedAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt)) {
      throw new ValidationError('expectedAt must be YYYY-MM-DD');
    }

    const id = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'PO');
    await sql`insert into purchases (tenant_id, id, doc_no, supplier_id, warehouse_id, status, expected_at,
                                     note, created_by)
              values (${principal.tenantId}, ${id}, ${docNo}, ${input.supplierId}, ${input.warehouseId}, 'DRAFT',
                      ${input.expectedAt ?? null}, ${input.note ?? null}, ${principal.membershipId})`.execute(
      tx,
    );

    const seen = new Set<string>();
    for (const item of input.items) {
      const { unitId, factor } = await this.resolveUnit(tx, item.variantId, item.unitId);
      const key = `${item.variantId}:${unitId}`;
      if (seen.has(key))
        throw new ValidationError('Duplicate variant/unit line', { variantId: item.variantId });
      seen.add(key);
      const ordered = toQuantity(item.orderedQty);
      if (ordered.isZero()) throw new ValidationError('orderedQty must be greater than zero');
      const cost = toCost(item.unitCost);
      const discount = toMoney(item.discountAmount ?? '0');
      const taxRate = new Dec(item.taxRate ?? '7');
      if (taxRate.isNegative() || taxRate.greaterThan(100))
        throw new ValidationError('taxRate must be 0..100');
      if (discount.greaterThan(ordered.times(cost)))
        throw new ValidationError('discountAmount exceeds the line');
      await sql`insert into purchase_items (tenant_id, id, purchase_id, variant_id, unit_id, unit_factor,
                                            ordered_qty, unit_cost, discount_amount, tax_rate)
                values (${principal.tenantId}, ${uuidv7()}, ${id}, ${item.variantId}, ${unitId}, ${factor},
                        ${formatQuantity(ordered)}, ${formatCost(cost)}, ${formatMoney(discount)},
                        ${taxRate.toFixed(2)})`.execute(tx);
    }
    await this.recomputeTotals(tx, id);

    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'purchase.create',
      resourceType: 'purchase',
      resourceId: id,
      after: { docNo, supplierId: input.supplierId, items: input.items.length },
    });
    return this.getOrThrow(tx, id);
  }

  /** DRAFT → PENDING_APPROVAL. Only the author (or anyone with purchase.create) may submit. */
  async submit(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.create', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['DRAFT']);
    await this.setStatus(tx, id, 'PENDING_APPROVAL');
    await this.audit(tx, principal, id, 'purchase.submit');
    return this.getOrThrow(tx, id);
  }

  /**
   * PENDING_APPROVAL → APPROVED and books INCOMING for every line (base units) at the PO's
   * warehouse. Segregation of duties: the creator cannot approve their own PO.
   */
  async approve(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.approve', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['PENDING_APPROVAL']);
    if (po.created_by === principal.membershipId) {
      throw new ForbiddenError(
        'You cannot approve your own purchase order',
        { purchaseId: id },
        'PRIVILEGE_ESCALATION',
      );
    }
    const items = await this.itemRows(tx, id);
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'EXPECT_INCOMING',
      idempotencyKey: `purchase:${id}:incoming`,
      reference: { type: 'PURCHASE', id },
      userId: principal.membershipId,
      lines: items.map((i) => ({
        warehouseId: po.warehouse_id,
        variantId: i.variant_id,
        quantity: formatQuantity(new Dec(i.ordered_qty).times(i.unit_factor)),
      })),
    });
    await sql`update purchases set status = 'APPROVED', approved_by = ${principal.membershipId}, approved_at = now(),
                     version = version + 1, updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'purchase.approve');
    return this.getOrThrow(tx, id);
  }

  /** PENDING_APPROVAL → DRAFT, so the author can fix and resubmit. */
  async reject(
    tx: Tx,
    principal: Principal,
    id: string,
    expectedVersion: number,
    note?: string,
  ): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.approve', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['PENDING_APPROVAL']);
    await sql`update purchases set status = 'DRAFT', note = coalesce(${note ?? null}, note), version = version + 1,
                     updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'purchase.reject', note ? { note } : undefined);
    return this.getOrThrow(tx, id);
  }

  /** APPROVED → SENT (the PO went out to the supplier). Purely informational for stock. */
  async markSent(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.create', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['APPROVED']);
    await this.setStatus(tx, id, 'SENT');
    await this.audit(tx, principal, id, 'purchase.sent');
    return this.getOrThrow(tx, id);
  }

  /**
   * Cancels a PO that has received nothing yet. If it was already approved, the INCOMING it booked
   * is released again.
   */
  async cancel(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.create', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT']);
    if (po.status === 'APPROVED' || po.status === 'SENT') {
      const items = await this.itemRows(tx, id);
      await this.cancelIncoming(tx, principal, po, items, 'cancel');
    }
    await this.setStatus(tx, id, 'CANCELLED');
    await this.audit(tx, principal, id, 'purchase.cancel');
    return this.getOrThrow(tx, id);
  }

  /**
   * Closes a PO short: whatever is still outstanding is written off (INCOMING_CANCEL) and recorded
   * as `cancelled_qty`. Allowed once something has been received; a fully received PO just closes.
   */
  async close(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Purchase> {
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.approve', { warehouseId: po.warehouse_id });
    this.checkVersion(po, expectedVersion);
    this.requireStatus(po, ['PARTIALLY_RECEIVED', 'RECEIVED']);
    const items = await this.itemRows(tx, id);
    await this.cancelIncoming(tx, principal, po, items, 'close');
    await this.setStatus(tx, id, 'CLOSED');
    await this.audit(tx, principal, id, 'purchase.close');
    return this.getOrThrow(tx, id);
  }

  /**
   * Goods receipt against a PO (partial allowed). Idempotent on `idempotencyKey`: the key is checked
   * only after the PO row lock is held, so a concurrent duplicate waits for the first receipt to
   * commit and then sees it (replay) instead of receiving twice.
   */
  async receive(tx: Tx, principal: Principal, id: string, input: ReceiveInput): Promise<Purchase> {
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 200) throw new ValidationError('Idempotency-Key is required (≤200 chars)');
    if (input.lines.length === 0) throw new ValidationError('At least one line is required');
    const po = await this.lock(tx, id);
    assertCan(principal, 'purchase.receive', { warehouseId: po.warehouse_id });

    const { rows: existing } = await sql<{ purchase_id: string | null }>`
      select purchase_id from goods_receipts where idempotency_key = ${key}`.execute(tx);
    if (existing[0]) {
      if (existing[0].purchase_id !== id) {
        throw new BusinessRuleError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used for another receipt');
      }
      return this.getOrThrow(tx, id);
    }
    this.requireStatus(po, [...RECEIVABLE]);

    const items = new Map((await this.itemRows(tx, id)).map((i) => [i.id, i]));
    const receivedNow = new Map<string, Dec>();
    for (const line of input.lines) {
      const item = items.get(line.purchaseItemId);
      if (!item)
        throw new ValidationError('Line is not on this purchase order', {
          purchaseItemId: line.purchaseItemId,
        });
      const qty = toQuantity(line.quantity);
      if (qty.isZero()) throw new ValidationError('quantity must be greater than zero');
      const total = (receivedNow.get(item.id) ?? new Dec(0)).plus(qty);
      if (total.greaterThan(outstanding(item))) {
        throw new BusinessRuleError('OVER_RECEIVE', 'Received quantity exceeds what is outstanding', {
          purchaseItemId: item.id,
          outstanding: formatQuantity(outstanding(item)),
        });
      }
      receivedNow.set(item.id, total);
      if (line.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) {
        throw new ValidationError('expiryDate must be YYYY-MM-DD');
      }
    }

    const receiptId = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'GR');
    await sql`insert into goods_receipts (tenant_id, id, doc_no, purchase_id, supplier_id, warehouse_id,
                                          supplier_invoice_no, status, received_by, idempotency_key)
              values (${principal.tenantId}, ${receiptId}, ${docNo}, ${id}, ${po.supplier_id}, ${po.warehouse_id},
                      ${input.supplierInvoiceNo ?? null}, 'POSTED', ${principal.membershipId}, ${key})`.execute(
      tx,
    );

    for (const line of input.lines) {
      const item = items.get(line.purchaseItemId)!;
      await sql`insert into goods_receipt_items (tenant_id, id, receipt_id, purchase_item_id, variant_id, quantity,
                                                 unit_cost, lot_no, expiry_date)
                values (${principal.tenantId}, ${uuidv7()}, ${receiptId}, ${item.id}, ${item.variant_id},
                        ${formatQuantity(toQuantity(line.quantity))}, ${formatCost(baseUnitCost(item))},
                        ${line.lotNo ?? null}, ${line.expiryDate ?? null})`.execute(tx);
    }

    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'RECEIVE_PURCHASE',
      idempotencyKey: `goods-receipt:${receiptId}`,
      reference: { type: 'GOODS_RECEIPT', id: receiptId },
      userId: principal.membershipId,
      lines: [...receivedNow].map(([itemId, qty]) => {
        const item = items.get(itemId)!;
        return {
          warehouseId: po.warehouse_id,
          variantId: item.variant_id,
          quantity: formatQuantity(qty),
          unitCost: formatCost(baseUnitCost(item)),
        };
      }),
    });

    for (const [itemId, qty] of receivedNow) {
      const item = items.get(itemId)!;
      await applyMovingAverage(
        tx,
        principal.tenantId,
        item.variant_id,
        formatQuantity(qty),
        formatCost(baseUnitCost(item)),
      );
      await sql`update purchase_items set received_qty = received_qty + ${formatQuantity(qty)} where id = ${itemId}`.execute(
        tx,
      );
    }

    const { rows: left } = await sql<{ remaining: string }>`
      select coalesce(sum(ordered_qty * unit_factor - received_qty - cancelled_qty), 0) as remaining
        from purchase_items where purchase_id = ${id}`.execute(tx);
    const status: PurchaseStatus = new Dec(left[0]!.remaining).greaterThan(0)
      ? 'PARTIALLY_RECEIVED'
      : 'RECEIVED';
    await this.setStatus(tx, id, status);

    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'purchase.receive',
      resourceType: 'purchase',
      resourceId: id,
      after: { receiptId, docNo, lines: input.lines.length, status },
    });
    return this.getOrThrow(tx, id);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Purchase> {
    assertCan(principal, 'purchase.read');
    return this.getOrThrow(tx, id);
  }

  async list(tx: Tx, principal: Principal, query: PurchaseListQuery = {}): Promise<Purchase[]> {
    assertCan(principal, 'purchase.read');
    if (query.supplierId && !isUuid(query.supplierId)) return [];
    if (query.warehouseId && !isUuid(query.warehouseId)) return [];
    const { rows } = await sql<{ id: string }>`
      select id from purchases
       where (${query.status ?? null}::text is null or status = ${query.status ?? null})
         and (${query.supplierId ?? null}::uuid is null or supplier_id = ${query.supplierId ?? null})
         and (${query.warehouseId ?? null}::uuid is null or warehouse_id = ${query.warehouseId ?? null})
       order by created_at desc limit 200`.execute(tx);
    return Promise.all(rows.map((r) => this.getOrThrow(tx, r.id)));
  }

  async supplierPerformance(tx: Tx, principal: Principal, supplierId: string): Promise<SupplierPerformance> {
    assertCan(principal, 'purchase.read');
    if (!isUuid(supplierId)) throw new NotFoundError('Supplier not found');
    const { rows: sup } = await sql`select 1 from suppliers where id = ${supplierId}`.execute(tx);
    if (sup.length === 0) throw new NotFoundError('Supplier not found');

    const { rows } = await sql<{
      purchase_orders: number;
      received_orders: number;
      on_time: number;
      with_expected: number;
      ordered: string | null;
      received: string | null;
      avg_lead_days: string | null;
      spend: string | null;
    }>`
      with po as (
        select p.id, p.status, p.expected_at, p.approved_at, p.grand_total,
               (select min(g.received_at) from goods_receipts g where g.purchase_id = p.id and g.status = 'POSTED') as first_receipt
          from purchases p
         where p.supplier_id = ${supplierId} and p.status not in ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
      )
      select count(*)::int as purchase_orders,
             count(first_receipt)::int as received_orders,
             count(*) filter (where first_receipt is not null and expected_at is not null
                                and (first_receipt at time zone 'Asia/Bangkok')::date <= expected_at)::int as on_time,
             count(*) filter (where first_receipt is not null and expected_at is not null)::int as with_expected,
             (select sum(i.ordered_qty * i.unit_factor) from purchase_items i where i.purchase_id in (select id from po)) as ordered,
             (select sum(i.received_qty) from purchase_items i where i.purchase_id in (select id from po)) as received,
             avg(extract(epoch from first_receipt - approved_at) / 86400)
               filter (where first_receipt is not null and approved_at is not null) as avg_lead_days,
             sum(grand_total) as spend
        from po`.execute(tx);
    const r = rows[0]!;
    const ordered = new Dec(r.ordered ?? 0);
    return {
      supplierId,
      purchaseOrders: r.purchase_orders,
      receivedOrders: r.received_orders,
      onTimeRate: r.with_expected > 0 ? new Dec(r.on_time).dividedBy(r.with_expected).toFixed(4) : null,
      fillRate: ordered.isZero() ? null : new Dec(r.received ?? 0).dividedBy(ordered).toFixed(4),
      avgLeadTimeDays: r.avg_lead_days === null ? null : new Dec(r.avg_lead_days).toFixed(1),
      totalSpend: formatMoney(new Dec(r.spend ?? 0)),
    };
  }

  // ---------------------------------------------------------------- internals

  private async resolveUnit(
    tx: Tx,
    variantId: string,
    unitId: string | undefined,
  ): Promise<{ unitId: string; factor: string }> {
    if (!isUuid(variantId)) throw new ValidationError('Unknown variant', { variantId });
    const { rows } = await sql<{ product_id: string; base_unit_id: string }>`
      select v.product_id, p.base_unit_id from product_variants v join products p on p.id = v.product_id
       where v.id = ${variantId} and v.deleted_at is null and p.deleted_at is null`.execute(tx);
    const v = rows[0];
    if (!v) throw new ValidationError('Unknown variant', { variantId });
    if (!unitId || unitId === v.base_unit_id) return { unitId: v.base_unit_id, factor: '1' };
    if (!isUuid(unitId)) throw new ValidationError('Unknown unit', { unitId });
    const { rows: conv } = await sql<{ factor_to_base: string }>`
      select factor_to_base from product_units where product_id = ${v.product_id} and unit_id = ${unitId}`.execute(
      tx,
    );
    if (!conv[0]) throw new ValidationError('Unit has no conversion for this product', { unitId, variantId });
    return { unitId, factor: conv[0].factor_to_base };
  }

  private async recomputeTotals(tx: Tx, id: string): Promise<void> {
    const items = await this.itemRows(tx, id);
    let subtotal = new Dec(0);
    let discount = new Dec(0);
    let tax = new Dec(0);
    for (const i of items) {
      const gross = new Dec(i.ordered_qty).times(i.unit_cost);
      const net = gross.minus(i.discount_amount);
      subtotal = subtotal.plus(gross);
      discount = discount.plus(i.discount_amount);
      tax = tax.plus(toMoney(net.times(i.tax_rate).dividedBy(100).toDecimalPlaces(2)));
    }
    const grand = subtotal.minus(discount).plus(tax);
    await sql`update purchases set subtotal = ${formatMoney(toMoney(subtotal.toDecimalPlaces(2)))},
                     discount_total = ${formatMoney(discount)}, tax_total = ${formatMoney(tax)},
                     grand_total = ${formatMoney(toMoney(grand.toDecimalPlaces(2)))}
               where id = ${id}`.execute(tx);
  }

  private async cancelIncoming(
    tx: Tx,
    principal: Principal,
    po: PurchaseRow,
    items: ItemRow[],
    reason: 'cancel' | 'close',
  ): Promise<void> {
    const lines = items.map((i) => ({ item: i, qty: outstanding(i) })).filter((l) => l.qty.greaterThan(0));
    if (lines.length === 0) return;
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'CANCEL_INCOMING',
      idempotencyKey: `purchase:${po.id}:${reason}`,
      reference: { type: 'PURCHASE', id: po.id },
      userId: principal.membershipId,
      lines: lines.map((l) => ({
        warehouseId: po.warehouse_id,
        variantId: l.item.variant_id,
        quantity: formatQuantity(l.qty),
      })),
    });
    for (const l of lines) {
      await sql`update purchase_items set cancelled_qty = cancelled_qty + ${formatQuantity(l.qty)}
                 where id = ${l.item.id}`.execute(tx);
    }
  }

  private async lock(tx: Tx, id: string): Promise<PurchaseRow> {
    if (!isUuid(id)) throw new NotFoundError('Purchase order not found');
    const { rows } = await sql<PurchaseRow>`
      select id, status, supplier_id, warehouse_id, created_by, version from purchases where id = ${id} for update`.execute(
      tx,
    );
    if (!rows[0]) throw new NotFoundError('Purchase order not found');
    return rows[0];
  }

  private checkVersion(po: PurchaseRow, expected: number): void {
    if (po.version !== expected) {
      throw new PreconditionFailedError('Purchase order was changed by someone else', {
        currentVersion: po.version,
      });
    }
  }

  private requireStatus(po: PurchaseRow, allowed: PurchaseStatus[]): void {
    if (!allowed.includes(po.status)) {
      throw new BusinessRuleError('INVALID_STATE_TRANSITION', `Purchase order is ${po.status}`, {
        status: po.status,
        allowed,
      });
    }
  }

  private async setStatus(tx: Tx, id: string, status: PurchaseStatus): Promise<void> {
    await sql`update purchases set status = ${status}, version = version + 1, updated_at = now() where id = ${id}`.execute(
      tx,
    );
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
      resourceType: 'purchase',
      resourceId: id,
      ...(after ? { after } : {}),
    });
  }

  private async itemRows(tx: Tx, purchaseId: string): Promise<ItemRow[]> {
    const { rows } = await sql<ItemRow>`
      select i.id, i.variant_id, v.sku, v.name as variant_name, i.unit_id, u.code as unit_code, i.unit_factor,
             i.ordered_qty, i.received_qty, i.cancelled_qty, i.unit_cost, i.discount_amount, i.tax_rate
        from purchase_items i
        join product_variants v on v.id = i.variant_id
        join units u on u.id = i.unit_id
       where i.purchase_id = ${purchaseId}
       order by i.id`.execute(tx);
    return rows;
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Purchase> {
    if (!isUuid(id)) throw new NotFoundError('Purchase order not found');
    const { rows } = await sql<{
      id: string;
      doc_no: string;
      supplier_id: string;
      supplier_name: string;
      warehouse_id: string;
      status: PurchaseStatus;
      expected_at: string | null;
      subtotal: string;
      discount_total: string;
      tax_total: string;
      grand_total: string;
      note: string | null;
      created_by: string;
      approved_by: string | null;
      approved_at: Date | null;
      version: number;
      created_at: Date;
    }>`
      select p.id, p.doc_no, p.supplier_id, s.name as supplier_name, p.warehouse_id, p.status,
             to_char(p.expected_at, 'YYYY-MM-DD') as expected_at, p.subtotal, p.discount_total, p.tax_total,
             p.grand_total, p.note, p.created_by, p.approved_by, p.approved_at, p.version, p.created_at
        from purchases p join suppliers s on s.id = p.supplier_id
       where p.id = ${id}`.execute(tx);
    const p = rows[0];
    if (!p) throw new NotFoundError('Purchase order not found');
    const items = await this.itemRows(tx, id);
    const { rows: receipts } = await sql<{
      id: string;
      doc_no: string;
      supplier_invoice_no: string | null;
      received_at: Date;
      lines: number;
    }>`
      select g.id, g.doc_no, g.supplier_invoice_no, g.received_at,
             (select count(*)::int from goods_receipt_items gi where gi.receipt_id = g.id) as lines
        from goods_receipts g where g.purchase_id = ${id} order by g.received_at`.execute(tx);
    return {
      id: p.id,
      docNo: p.doc_no,
      supplierId: p.supplier_id,
      supplierName: p.supplier_name,
      warehouseId: p.warehouse_id,
      status: p.status,
      expectedAt: p.expected_at,
      subtotal: p.subtotal,
      discountTotal: p.discount_total,
      taxTotal: p.tax_total,
      grandTotal: p.grand_total,
      note: p.note,
      createdBy: p.created_by,
      approvedBy: p.approved_by,
      approvedAt: p.approved_at ? p.approved_at.toISOString() : null,
      version: p.version,
      createdAt: p.created_at.toISOString(),
      items: items.map((i) => ({
        id: i.id,
        variantId: i.variant_id,
        sku: i.sku,
        variantName: i.variant_name,
        unitId: i.unit_id,
        unitCode: i.unit_code,
        unitFactor: i.unit_factor,
        orderedQty: i.ordered_qty,
        receivedQty: i.received_qty,
        cancelledQty: i.cancelled_qty,
        outstandingQty: formatQuantity(outstanding(i)),
        unitCost: i.unit_cost,
        discountAmount: i.discount_amount,
        taxRate: i.tax_rate,
        lineTotal: formatMoney(
          toMoney(new Dec(i.ordered_qty).times(i.unit_cost).minus(i.discount_amount).toDecimalPlaces(2)),
        ),
      })),
      receipts: receipts.map((g) => ({
        id: g.id,
        docNo: g.doc_no,
        supplierInvoiceNo: g.supplier_invoice_no,
        receivedAt: g.received_at.toISOString(),
        lines: g.lines,
      })),
    };
  }
}

/** Base units still expected on a line. */
function outstanding(i: ItemRow): Dec {
  return new Dec(i.ordered_qty).times(i.unit_factor).minus(i.received_qty).minus(i.cancelled_qty);
}

/** Landed cost per base unit: (ordered × unit cost − line discount) ÷ (ordered × factor). Tax excluded. */
function baseUnitCost(i: ItemRow): Dec {
  const ordered = new Dec(i.ordered_qty);
  return toCost(
    ordered
      .times(i.unit_cost)
      .minus(i.discount_amount)
      .dividedBy(ordered.times(i.unit_factor))
      .toDecimalPlaces(4),
  );
}

interface PurchaseRow {
  id: string;
  status: PurchaseStatus;
  supplier_id: string;
  warehouse_id: string;
  created_by: string;
  version: number;
}

interface ItemRow {
  id: string;
  variant_id: string;
  sku: string;
  variant_name: string;
  unit_id: string;
  unit_code: string;
  unit_factor: string;
  ordered_qty: string;
  received_qty: string;
  cancelled_qty: string;
  unit_cost: string;
  discount_amount: string;
  tax_rate: string;
}

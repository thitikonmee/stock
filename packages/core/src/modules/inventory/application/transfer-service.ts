import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import {
  BusinessRuleError,
  Dec,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  formatQuantity,
  isUuid,
  toQuantity,
  uuidv7,
} from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { InventoryEngine } from './inventory-engine';

export type TransferStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'APPROVED'
  | 'PICKING'
  | 'SHIPPED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface TransferItem {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  requestedQty: string;
  approvedQty: string | null;
  shippedQty: string;
  receivedQty: string;
  damagedQty: string;
  /** Shipped but neither received nor reported damaged yet. */
  inTransitQty: string;
}

export interface Transfer {
  id: string;
  docNo: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: TransferStatus;
  note: string | null;
  requestedBy: string;
  approvedBy: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  version: number;
  createdAt: string;
  items: TransferItem[];
}

export interface CreateTransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  note?: string;
  items: readonly { variantId: string; quantity: string }[];
}

export interface TransferQtyLine {
  itemId: string;
  quantity: string;
}

export interface TransferReceiveLine {
  itemId: string;
  receivedQty: string;
  damagedQty?: string;
}

const MAX_ITEMS = 500;

/**
 * Inter-warehouse transfers (docs/04-inventory.md §9 "Transfer (partial)"):
 * - approve: COMMIT (direct) the approved qty at the source, so it can no longer be sold;
 * - ship:    TRANSFER_OUT what actually left (on_hand −, committed −), UNCOMMIT the rest, and book
 *            INCOMING at the destination;
 * - receive: TRANSFER_IN (incoming → on_hand) at the destination; damage in transit moves on to the
 *            DAMAGED bucket. Partial receipts allowed;
 * - complete: whatever is still in transit is written off (INCOMING_CANCEL) and audited as loss.
 *
 * Every mutating call locks the transfer row first, so concurrent ships/receipts serialise; a
 * receipt is also idempotent on its key through the engine's own movement idempotency.
 */
export class TransferService {
  private readonly engine = new InventoryEngine();

  async create(tx: Tx, principal: Principal, input: CreateTransferInput): Promise<Transfer> {
    assertCan(principal, 'inventory.transfer', { warehouseId: input.fromWarehouseId });
    if (!isUuid(input.fromWarehouseId) || !isUuid(input.toWarehouseId)) {
      throw new ValidationError('Unknown warehouse');
    }
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new ValidationError('Source and destination warehouses must differ');
    }
    if (input.items.length === 0 || input.items.length > MAX_ITEMS) {
      throw new ValidationError(`A transfer needs 1..${MAX_ITEMS} items`);
    }
    const { rows: wh } = await sql<{ id: string }>`
      select id from warehouses where id in (${input.fromWarehouseId}, ${input.toWarehouseId})`.execute(tx);
    if (wh.length !== 2) throw new ValidationError('Unknown warehouse');

    const id = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'TR');
    await sql`insert into stock_transfers (tenant_id, id, doc_no, from_warehouse_id, to_warehouse_id, status,
                                           requested_by, note)
              values (${principal.tenantId}, ${id}, ${docNo}, ${input.fromWarehouseId}, ${input.toWarehouseId},
                      'REQUESTED', ${principal.membershipId}, ${input.note ?? null})`.execute(tx);
    const seen = new Set<string>();
    for (const item of input.items) {
      if (!isUuid(item.variantId))
        throw new ValidationError('Unknown variant', { variantId: item.variantId });
      if (seen.has(item.variantId))
        throw new ValidationError('Duplicate variant', { variantId: item.variantId });
      seen.add(item.variantId);
      const { rows } =
        await sql`select 1 from product_variants where id = ${item.variantId} and deleted_at is null`.execute(
          tx,
        );
      if (rows.length === 0) throw new ValidationError('Unknown variant', { variantId: item.variantId });
      const qty = toQuantity(item.quantity);
      if (qty.isZero()) throw new ValidationError('quantity must be greater than zero');
      await sql`insert into stock_transfer_items (tenant_id, id, transfer_id, variant_id, requested_qty)
                values (${principal.tenantId}, ${uuidv7()}, ${id}, ${item.variantId}, ${formatQuantity(qty)})`.execute(
        tx,
      );
    }
    await this.audit(tx, principal, id, 'inventory.transfer.create', { docNo, items: input.items.length });
    return this.getOrThrow(tx, id);
  }

  /**
   * REQUESTED → APPROVED. `lines` may approve less than requested per item (omitted items are
   * approved in full; 0 drops an item). Commits the approved qty at the source — fails with
   * STOCK_INSUFFICIENT if it is no longer available.
   */
  async approve(
    tx: Tx,
    principal: Principal,
    id: string,
    expectedVersion: number,
    lines: readonly TransferQtyLine[] = [],
  ): Promise<Transfer> {
    const t = await this.lock(tx, id);
    assertCan(principal, 'inventory.transfer.approve', { warehouseId: t.from_warehouse_id });
    this.checkVersion(t, expectedVersion);
    this.requireStatus(t, ['REQUESTED']);
    const items = await this.itemRows(tx, id);
    const overrides = this.lineMap(lines, items);
    const approved = items.map((i) => {
      const qty = overrides.get(i.id) ?? new Dec(i.requested_qty);
      if (qty.greaterThan(i.requested_qty)) {
        throw new ValidationError('Cannot approve more than requested', { itemId: i.id });
      }
      return { item: i, qty };
    });
    if (approved.every((a) => a.qty.isZero())) throw new ValidationError('Nothing approved');

    const toCommit = approved.filter((a) => a.qty.greaterThan(0));
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'COMMIT_DIRECT',
      idempotencyKey: `transfer:${id}:approve`,
      reference: { type: 'TRANSFER', id },
      userId: principal.membershipId,
      lines: toCommit.map((a) => ({
        warehouseId: t.from_warehouse_id,
        variantId: a.item.variant_id,
        quantity: formatQuantity(a.qty),
      })),
    });
    for (const a of approved) {
      await sql`update stock_transfer_items set approved_qty = ${formatQuantity(a.qty)} where id = ${a.item.id}`.execute(
        tx,
      );
    }
    await sql`update stock_transfers set status = 'APPROVED', approved_by = ${principal.membershipId},
                     version = version + 1, updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.transfer.approve');
    return this.getOrThrow(tx, id);
  }

  /**
   * APPROVED → SHIPPED. Ships `lines` (default: everything approved); anything approved but not
   * shipped is released back to the source's available stock.
   */
  async ship(
    tx: Tx,
    principal: Principal,
    id: string,
    expectedVersion: number,
    lines: readonly TransferQtyLine[] = [],
  ): Promise<Transfer> {
    const t = await this.lock(tx, id);
    assertCan(principal, 'inventory.transfer', { warehouseId: t.from_warehouse_id });
    this.checkVersion(t, expectedVersion);
    this.requireStatus(t, ['APPROVED', 'PICKING']);
    const items = await this.itemRows(tx, id);
    const overrides = this.lineMap(lines, items);
    const plan = items.map((i) => {
      const approved = new Dec(i.approved_qty ?? 0);
      const shipped = overrides.get(i.id) ?? approved;
      if (shipped.greaterThan(approved)) {
        throw new ValidationError('Cannot ship more than approved', { itemId: i.id });
      }
      return { item: i, shipped, unshipped: approved.minus(shipped) };
    });
    if (plan.every((p) => p.shipped.isZero())) throw new ValidationError('Nothing to ship');

    const shipped = plan.filter((p) => p.shipped.greaterThan(0));
    const unshipped = plan.filter((p) => p.unshipped.greaterThan(0));
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'TRANSFER_OUT',
      idempotencyKey: `transfer:${id}:ship`,
      reference: { type: 'TRANSFER', id },
      userId: principal.membershipId,
      lines: shipped.map((p) => ({
        warehouseId: t.from_warehouse_id,
        variantId: p.item.variant_id,
        quantity: formatQuantity(p.shipped),
      })),
    });
    if (unshipped.length > 0) {
      await this.engine.apply(tx, {
        tenantId: principal.tenantId,
        operation: 'UNCOMMIT',
        idempotencyKey: `transfer:${id}:ship-release`,
        reference: { type: 'TRANSFER', id },
        userId: principal.membershipId,
        lines: unshipped.map((p) => ({
          warehouseId: t.from_warehouse_id,
          variantId: p.item.variant_id,
          quantity: formatQuantity(p.unshipped),
        })),
      });
    }
    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'EXPECT_INCOMING',
      idempotencyKey: `transfer:${id}:incoming`,
      reference: { type: 'TRANSFER', id },
      userId: principal.membershipId,
      lines: shipped.map((p) => ({
        warehouseId: t.to_warehouse_id,
        variantId: p.item.variant_id,
        quantity: formatQuantity(p.shipped),
      })),
    });
    for (const p of plan) {
      await sql`update stock_transfer_items set shipped_qty = ${formatQuantity(p.shipped)} where id = ${p.item.id}`.execute(
        tx,
      );
    }
    await sql`update stock_transfers set status = 'SHIPPED', shipped_at = now(), version = version + 1,
                     updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.transfer.ship');
    return this.getOrThrow(tx, id);
  }

  /**
   * Destination receipt, partial allowed. Idempotent on `idempotencyKey`: the engine's movement key
   * is derived from it, and a replay (detected under the transfer row lock) changes nothing.
   */
  async receive(
    tx: Tx,
    principal: Principal,
    id: string,
    idempotencyKey: string,
    lines: readonly TransferReceiveLine[],
  ): Promise<Transfer> {
    const key = idempotencyKey.trim();
    if (!key || key.length > 200) throw new ValidationError('Idempotency-Key is required (≤200 chars)');
    if (lines.length === 0) throw new ValidationError('At least one line is required');
    const t = await this.lock(tx, id);
    assertCan(principal, 'inventory.transfer', { warehouseId: t.to_warehouse_id });
    const movementKey = `transfer:${id}:receive:${key}`;
    const { rows: done } =
      await sql`select 1 from inventory_movements where idempotency_key = ${movementKey}`.execute(tx);
    if (done.length > 0) return this.getOrThrow(tx, id);
    this.requireStatus(t, ['SHIPPED', 'PARTIALLY_RECEIVED']);

    const items = new Map((await this.itemRows(tx, id)).map((i) => [i.id, i]));
    const plan: { item: ItemRow; received: Dec; damaged: Dec }[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const item = items.get(line.itemId);
      if (!item) throw new ValidationError('Line is not on this transfer', { itemId: line.itemId });
      if (seen.has(item.id)) throw new ValidationError('Duplicate line', { itemId: item.id });
      seen.add(item.id);
      const received = toQuantity(line.receivedQty, { allowZero: true });
      const damaged = toQuantity(line.damagedQty ?? '0', { allowZero: true });
      if (received.plus(damaged).isZero()) continue;
      if (received.plus(damaged).greaterThan(inTransit(item))) {
        throw new BusinessRuleError('OVER_RECEIVE', 'Received quantity exceeds what is in transit', {
          itemId: item.id,
          inTransit: formatQuantity(inTransit(item)),
        });
      }
      plan.push({ item, received, damaged });
    }
    if (plan.length === 0) throw new ValidationError('Nothing to receive');

    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'TRANSFER_IN',
      idempotencyKey: movementKey,
      reference: { type: 'TRANSFER', id },
      userId: principal.membershipId,
      lines: plan.map((p) => ({
        warehouseId: t.to_warehouse_id,
        variantId: p.item.variant_id,
        quantity: formatQuantity(p.received.plus(p.damaged)),
      })),
    });
    const damaged = plan.filter((p) => p.damaged.greaterThan(0));
    if (damaged.length > 0) {
      await this.engine.apply(tx, {
        tenantId: principal.tenantId,
        operation: 'MARK_DAMAGED',
        idempotencyKey: `${movementKey}:damaged`,
        reference: { type: 'TRANSFER', id },
        reasonCode: 'DAMAGE',
        userId: principal.membershipId,
        lines: damaged.map((p) => ({
          warehouseId: t.to_warehouse_id,
          variantId: p.item.variant_id,
          quantity: formatQuantity(p.damaged),
        })),
      });
    }
    for (const p of plan) {
      await sql`update stock_transfer_items set received_qty = received_qty + ${formatQuantity(p.received)},
                       damaged_qty = damaged_qty + ${formatQuantity(p.damaged)} where id = ${p.item.id}`.execute(
        tx,
      );
    }
    const { rows: left } = await sql<{ remaining: string }>`
      select coalesce(sum(shipped_qty - received_qty - damaged_qty), 0) as remaining
        from stock_transfer_items where transfer_id = ${id}`.execute(tx);
    const status: TransferStatus = new Dec(left[0]!.remaining).greaterThan(0)
      ? 'PARTIALLY_RECEIVED'
      : 'RECEIVED';
    await sql`update stock_transfers set status = ${status}, received_at = now(), version = version + 1,
                     updated_at = now() where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.transfer.receive', { lines: plan.length, status });
    return this.getOrThrow(tx, id);
  }

  /**
   * Closes the transfer. Anything still in transit (shipped − received − damaged) is written off at
   * the destination (INCOMING_CANCEL) and recorded in the audit log as transit loss to investigate.
   */
  async complete(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Transfer> {
    const t = await this.lock(tx, id);
    assertCan(principal, 'inventory.transfer.approve', { warehouseId: t.to_warehouse_id });
    this.checkVersion(t, expectedVersion);
    this.requireStatus(t, ['PARTIALLY_RECEIVED', 'RECEIVED']);
    const items = await this.itemRows(tx, id);
    const lost = items.map((i) => ({ item: i, qty: inTransit(i) })).filter((l) => l.qty.greaterThan(0));
    if (lost.length > 0) {
      await this.engine.apply(tx, {
        tenantId: principal.tenantId,
        operation: 'CANCEL_INCOMING',
        idempotencyKey: `transfer:${id}:complete`,
        reference: { type: 'TRANSFER', id },
        reasonCode: 'LOST',
        userId: principal.membershipId,
        lines: lost.map((l) => ({
          warehouseId: t.to_warehouse_id,
          variantId: l.item.variant_id,
          quantity: formatQuantity(l.qty),
        })),
      });
    }
    await sql`update stock_transfers set status = 'COMPLETED', version = version + 1, updated_at = now()
               where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.transfer.complete', {
      transitLoss: lost.map((l) => ({ variantId: l.item.variant_id, quantity: formatQuantity(l.qty) })),
    });
    return this.getOrThrow(tx, id);
  }

  /** Cancels before shipping; an approved transfer releases the stock it had committed. */
  async cancel(tx: Tx, principal: Principal, id: string, expectedVersion: number): Promise<Transfer> {
    const t = await this.lock(tx, id);
    assertCan(principal, 'inventory.transfer', { warehouseId: t.from_warehouse_id });
    this.checkVersion(t, expectedVersion);
    this.requireStatus(t, ['DRAFT', 'REQUESTED', 'APPROVED', 'PICKING']);
    if (t.status === 'APPROVED' || t.status === 'PICKING') {
      const items = (await this.itemRows(tx, id)).filter((i) => new Dec(i.approved_qty ?? 0).greaterThan(0));
      if (items.length > 0) {
        await this.engine.apply(tx, {
          tenantId: principal.tenantId,
          operation: 'UNCOMMIT',
          idempotencyKey: `transfer:${id}:cancel`,
          reference: { type: 'TRANSFER', id },
          userId: principal.membershipId,
          lines: items.map((i) => ({
            warehouseId: t.from_warehouse_id,
            variantId: i.variant_id,
            quantity: formatQuantity(new Dec(i.approved_qty!)),
          })),
        });
      }
    }
    await sql`update stock_transfers set status = 'CANCELLED', version = version + 1, updated_at = now()
               where id = ${id}`.execute(tx);
    await this.audit(tx, principal, id, 'inventory.transfer.cancel');
    return this.getOrThrow(tx, id);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Transfer> {
    assertCan(principal, 'inventory.read');
    return this.getOrThrow(tx, id);
  }

  async list(
    tx: Tx,
    principal: Principal,
    query: { status?: TransferStatus; warehouseId?: string } = {},
  ): Promise<Transfer[]> {
    assertCan(principal, 'inventory.read');
    if (query.warehouseId && !isUuid(query.warehouseId)) return [];
    const { rows } = await sql<{ id: string }>`
      select id from stock_transfers
       where (${query.status ?? null}::text is null or status = ${query.status ?? null})
         and (${query.warehouseId ?? null}::uuid is null
              or from_warehouse_id = ${query.warehouseId ?? null} or to_warehouse_id = ${query.warehouseId ?? null})
       order by created_at desc limit 200`.execute(tx);
    return Promise.all(rows.map((r) => this.getOrThrow(tx, r.id)));
  }

  // ---------------------------------------------------------------- internals

  private lineMap(lines: readonly TransferQtyLine[], items: ItemRow[]): Map<string, Dec> {
    const ids = new Set(items.map((i) => i.id));
    const map = new Map<string, Dec>();
    for (const l of lines) {
      if (!ids.has(l.itemId)) throw new ValidationError('Line is not on this transfer', { itemId: l.itemId });
      if (map.has(l.itemId)) throw new ValidationError('Duplicate line', { itemId: l.itemId });
      map.set(l.itemId, toQuantity(l.quantity, { allowZero: true }));
    }
    return map;
  }

  private async lock(tx: Tx, id: string): Promise<TransferRow> {
    if (!isUuid(id)) throw new NotFoundError('Transfer not found');
    const { rows } = await sql<TransferRow>`
      select id, status, from_warehouse_id, to_warehouse_id, version from stock_transfers where id = ${id} for update`.execute(
      tx,
    );
    if (!rows[0]) throw new NotFoundError('Transfer not found');
    return rows[0];
  }

  private checkVersion(t: TransferRow, expected: number): void {
    if (t.version !== expected) {
      throw new PreconditionFailedError('Transfer was changed by someone else', {
        currentVersion: t.version,
      });
    }
  }

  private requireStatus(t: TransferRow, allowed: TransferStatus[]): void {
    if (!allowed.includes(t.status)) {
      throw new BusinessRuleError('INVALID_STATE_TRANSITION', `Transfer is ${t.status}`, {
        status: t.status,
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
      resourceType: 'stock_transfer',
      resourceId: id,
      ...(after ? { after } : {}),
    });
  }

  private async itemRows(tx: Tx, transferId: string): Promise<ItemRow[]> {
    const { rows } = await sql<ItemRow>`
      select i.id, i.variant_id, v.sku, v.name as variant_name, i.requested_qty, i.approved_qty, i.shipped_qty,
             i.received_qty, i.damaged_qty
        from stock_transfer_items i join product_variants v on v.id = i.variant_id
       where i.transfer_id = ${transferId} order by i.id`.execute(tx);
    return rows;
  }

  private async getOrThrow(tx: Tx, id: string): Promise<Transfer> {
    if (!isUuid(id)) throw new NotFoundError('Transfer not found');
    const { rows } = await sql<{
      id: string;
      doc_no: string;
      from_warehouse_id: string;
      to_warehouse_id: string;
      status: TransferStatus;
      note: string | null;
      requested_by: string;
      approved_by: string | null;
      shipped_at: Date | null;
      received_at: Date | null;
      version: number;
      created_at: Date;
    }>`
      select id, doc_no, from_warehouse_id, to_warehouse_id, status, note, requested_by, approved_by, shipped_at,
             received_at, version, created_at
        from stock_transfers where id = ${id}`.execute(tx);
    const t = rows[0];
    if (!t) throw new NotFoundError('Transfer not found');
    const items = await this.itemRows(tx, id);
    return {
      id: t.id,
      docNo: t.doc_no,
      fromWarehouseId: t.from_warehouse_id,
      toWarehouseId: t.to_warehouse_id,
      status: t.status,
      note: t.note,
      requestedBy: t.requested_by,
      approvedBy: t.approved_by,
      shippedAt: t.shipped_at ? t.shipped_at.toISOString() : null,
      receivedAt: t.received_at ? t.received_at.toISOString() : null,
      version: t.version,
      createdAt: t.created_at.toISOString(),
      items: items.map((i) => ({
        id: i.id,
        variantId: i.variant_id,
        sku: i.sku,
        variantName: i.variant_name,
        requestedQty: i.requested_qty,
        approvedQty: i.approved_qty,
        shippedQty: i.shipped_qty,
        receivedQty: i.received_qty,
        damagedQty: i.damaged_qty,
        inTransitQty: formatQuantity(inTransit(i)),
      })),
    };
  }
}

function inTransit(i: ItemRow): Dec {
  return new Dec(i.shipped_qty).minus(i.received_qty).minus(i.damaged_qty);
}

interface TransferRow {
  id: string;
  status: TransferStatus;
  from_warehouse_id: string;
  to_warehouse_id: string;
  version: number;
}

interface ItemRow {
  id: string;
  variant_id: string;
  sku: string;
  variant_name: string;
  requested_qty: string;
  approved_qty: string | null;
  shipped_qty: string;
  received_qty: string;
  damaged_qty: string;
}

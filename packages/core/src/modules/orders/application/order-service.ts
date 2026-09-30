import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { recordAudit } from '../../audit/public-api';
import type { PriceService, ProductService } from '../../catalog/public-api';
import { assertCan, type Principal } from '../../iam/public-api';
import { type ReservationService } from '../../inventory/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { computeOrderTotals, type OrderLineCalcInput, type OrderLineTotals } from '../domain/pricing';
import { initialStatus, transition, type OrderEvent } from '../domain/order-state-machine';
import type { CreateOrderInput, Order, OrderListPage, OrderListQuery } from '../domain/types';

/**
 * The normalized order model (docs/04-inventory.md §5, docs/08-api-design.md Orders). This phase
 * covers the API/website channel only — POS creates orders through `pos.SaleService` directly
 * (its counter-sale flow is a degenerate one-tx path through the same table, not through this
 * service) and marketplace ingestion is Phase 6+.
 */
export class OrderService {
  constructor(
    private readonly products: ProductService,
    private readonly prices: PriceService,
    private readonly reservations: ReservationService,
  ) {}

  async create(tx: Tx, principal: Principal, input: CreateOrderInput): Promise<Order> {
    assertCan(principal, 'order.create');
    if (!isUuid(input.idempotencyKey)) throw new ValidationError('idempotencyKey must be a UUID');
    // The order's id IS the caller's idempotency key — deterministic across retries, so two
    // concurrent identical requests agree on the reference they hand InventoryEngine (see
    // packages/core/src/modules/pos/application/sale-service.ts for why a fresh id per attempt breaks this).
    const orderId = input.idempotencyKey;
    const existing = await this.loadOrder(tx, orderId);
    if (existing) return existing;

    const warehouseId = await this.resolveWarehouse(tx, input.warehouseId);

    const calcLines: OrderLineCalcInput[] = await Promise.all(
      input.lines.map(async (line, i) => {
        const info = await this.products.saleInfo(tx, principal, { variantId: line.variantId });
        if (info.status !== 'ACTIVE') {
          throw new BusinessRuleError('VARIANT_NOT_SELLABLE', `${info.sku} is not active`, { sku: info.sku });
        }
        const priced = await this.prices.resolve(tx, principal, line.variantId, { quantity: line.quantity });
        return {
          lineNo: i + 1,
          variantId: line.variantId,
          sku: info.sku,
          name: info.name,
          quantity: line.quantity,
          unitPrice: priced.price,
          taxRate: info.taxClass === 'VAT7' ? '7' : '0',
          priceIncludesTax: priced.priceIncludesTax,
          ...(line.discountAmount !== undefined ? { discountAmount: line.discountAmount } : {}),
        };
      }),
    );
    const totals = computeOrderTotals(calcLines);

    const paid = input.paid ?? false;
    const status = initialStatus(paid);
    const orderNo = await nextDocumentNumber(tx, principal.tenantId, 'SO');

    // Soft-reserve (unpaid) or commit-direct (already paid) — one reservation row per line, all
    // sharing (referenceType='ORDER', referenceId=orderId); safe to call again on a retry, since
    // ReservationService.reserve() is itself idempotent per its own key.
    if (paid) {
      for (const line of calcLines) {
        const [reservation] = await this.reservations.reserve(tx, principal, {
          referenceType: 'ORDER',
          referenceId: orderId,
          idempotencyKey: `order:${orderId}:reserve:${line.variantId}`,
          items: [{ warehouseId, variantId: line.variantId, quantity: line.quantity }],
        });
        // `reserve()` always returns RESERVED (it never commits) — a concurrent duplicate call could
        // race here, but ReservationService.commit()'s own status guard plus InventoryEngine's
        // idempotency key make a second concurrent commit resolve harmlessly, not error.
        if (reservation) await this.reservations.commit(tx, principal, reservation.id);
      }
    } else {
      for (const line of calcLines) {
        await this.reservations.reserve(tx, principal, {
          referenceType: 'ORDER',
          referenceId: orderId,
          idempotencyKey: `order:${orderId}:reserve:${line.variantId}`,
          ttlSeconds: 30 * 60,
          items: [{ warehouseId, variantId: line.variantId, quantity: line.quantity }],
        });
      }
    }

    // No conflict is possible: we are either fresh (checked above) or racing a concurrent retry of
    // the exact same idempotencyKey/orderId — the loser here still safely wins the ON CONFLICT below.
    const { rows } = await sql<{ id: string }>`
      insert into orders (tenant_id, id, order_no, channel_code, fulfillment_warehouse_id,
                          customer_id, status, payment_status, inventory_status, price_includes_tax,
                          subtotal, discount_total, tax_total, rounding, grand_total, paid_total,
                          placed_at, paid_at, note)
      values (${principal.tenantId}, ${orderId}, ${orderNo}, ${input.channelCode}, ${warehouseId},
              ${input.customerId ?? null}, ${status}, ${paid ? 'PAID' : 'UNPAID'},
              ${paid ? 'COMMITTED' : 'RESERVED'}, true,
              ${totals.subtotal}, ${totals.discountTotal}, ${totals.taxTotal}, '0.00', ${totals.grandTotal},
              ${paid ? totals.grandTotal : '0.00'}, now(), ${paid ? sql`now()` : null}, ${input.note ?? null})
      on conflict (tenant_id, id) do nothing
      returning id`.execute(tx);
    if (rows.length === 0) {
      const replay = await this.loadOrder(tx, orderId);
      if (replay) return replay;
      throw new ValidationError('Idempotency key conflict could not be resolved; retry the request');
    }

    for (const line of totals.lines) await this.insertOrderItem(tx, principal.tenantId, orderId, line);
    if (paid) {
      // A record for RefundService to refund against — this phase has no real payment gateway,
      // so "paid" just means the amount is recorded as already settled (matches how POS records cash).
      await sql`insert into payments (tenant_id, id, order_id, method, status, amount, idempotency_key, paid_at)
                values (${principal.tenantId}, ${uuidv7()}, ${orderId}, 'GATEWAY', 'SUCCEEDED', ${totals.grandTotal},
                        ${`order:${orderId}:payment`}, now())`.execute(tx);
    }
    await this.recordHistory(tx, principal, orderId, null, status, 'USER');
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: 'order.create',
      resourceType: 'order',
      resourceId: orderId,
      after: { orderNo, status, grandTotal: totals.grandTotal },
    });

    return (await this.loadOrder(tx, orderId))!;
  }

  async get(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.read');
    const order = await this.loadOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order not found');
    return order;
  }

  async list(tx: Tx, principal: Principal, query: OrderListQuery): Promise<OrderListPage> {
    assertCan(principal, 'order.read');
    const limit = Math.min(query.limit ?? 30, 100);
    const { rows } = await sql<{ id: string }>`
      select id from orders
       where (${query.status ?? null}::text is null or status = ${query.status ?? null})
         and (${query.channelCode ?? null}::text is null or channel_code = ${query.channelCode ?? null})
         and (${query.cursor ?? null}::uuid is null or id < ${query.cursor ?? null})
       order by placed_at desc, id desc limit ${limit + 1}`.execute(tx);
    const page = rows.slice(0, limit);
    const data = (await Promise.all(page.map((r) => this.loadOrder(tx, r.id)))).filter(
      (o): o is Order => o !== null,
    );
    return { data, page: { nextCursor: rows.length > limit ? page[page.length - 1]!.id : null } };
  }

  /** Marks a PENDING order as paid (e.g. staff confirming a bank transfer for a phone order). No
   *  real payment gateway in this phase — see pos.SaleService/CashierSessionService for the same
   *  simplification on the POS side. */
  async markPaid(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.update');
    const order = await this.applyEvent(tx, principal, orderId, 'PAY');
    const { rows } = await sql<{ id: string }>`
      select id from payments where order_id = ${orderId} and idempotency_key = ${`order:${orderId}:payment`}`.execute(
      tx,
    );
    if (rows.length === 0) {
      await sql`insert into payments (tenant_id, id, order_id, method, status, amount, idempotency_key, paid_at)
                values (${principal.tenantId}, ${uuidv7()}, ${orderId}, 'GATEWAY', 'SUCCEEDED', ${order.grandTotal},
                        ${`order:${orderId}:payment`}, now())`.execute(tx);
    }
    await sql`update orders set payment_status = 'PAID', paid_total = ${order.grandTotal}, paid_at = now()
                where id = ${orderId}`.execute(tx);
    return (await this.loadOrder(tx, orderId))!;
  }

  async confirm(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.update');
    return this.applyEvent(tx, principal, orderId, 'CONFIRM', async (order) => {
      await this.commitReservations(tx, principal, order.id);
    });
  }

  async hold(tx: Tx, principal: Principal, orderId: string, reason: string): Promise<Order> {
    assertCan(principal, 'order.update');
    await this.applyEvent(tx, principal, orderId, 'HOLD');
    await sql`update orders set hold_reason = ${reason} where id = ${orderId}`.execute(tx);
    return (await this.loadOrder(tx, orderId))!;
  }

  async releaseHold(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.update');
    await this.applyEvent(tx, principal, orderId, 'RELEASE_HOLD', async (o) => {
      await this.commitReservations(tx, principal, o.id);
    });
    await sql`update orders set hold_reason = null where id = ${orderId}`.execute(tx);
    return (await this.loadOrder(tx, orderId))!;
  }

  /** Marks a shipped order delivered — staff confirming a COD/phone order, or a channel's
   *  DELIVERED webhook (docs/06 Shopee status TO_CONFIRM_RECEIVE). No inventory effect. */
  async deliver(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.update');
    return this.applyEvent(tx, principal, orderId, 'DELIVER');
  }

  /** Closes out a delivered order. No inventory effect. */
  async complete(tx: Tx, principal: Principal, orderId: string): Promise<Order> {
    assertCan(principal, 'order.update');
    return this.applyEvent(tx, principal, orderId, 'COMPLETE');
  }

  async cancel(tx: Tx, principal: Principal, orderId: string, reason?: string): Promise<Order> {
    assertCan(principal, 'order.cancel');
    return this.applyEvent(tx, principal, orderId, 'CANCEL', async () => {
      const reservationRows = await this.reservations.list(tx, principal, {
        referenceType: 'ORDER',
        referenceId: orderId,
      });
      for (const r of reservationRows) {
        if (r.status === 'RESERVED') await this.reservations.release(tx, principal, r.id);
        else if (r.status === 'COMMITTED') await this.reservations.uncommit(tx, principal, r.id);
      }
      await sql`update orders set cancel_reason = ${reason ?? null}, cancelled_at = now() where id = ${orderId}`.execute(
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- helpers (package-internal)

  /** Promotes every RESERVED hold for this order to COMMITTED — shared by confirm() and releaseHold(). */
  private async commitReservations(tx: Tx, principal: Principal, orderId: string): Promise<void> {
    const reservationRows = await this.reservations.list(tx, principal, {
      referenceType: 'ORDER',
      referenceId: orderId,
      status: 'RESERVED',
    });
    for (const r of reservationRows) await this.reservations.commit(tx, principal, r.id);
    if (reservationRows.length > 0) {
      await sql`update orders set inventory_status = 'COMMITTED' where id = ${orderId}`.execute(tx);
    }
  }

  private async applyEvent(
    tx: Tx,
    principal: Principal,
    orderId: string,
    event: OrderEvent,
    sideEffect?: (order: Order) => Promise<void>,
  ): Promise<Order> {
    const order = await this.get(tx, principal, orderId);
    const nextStatus = transition(order.status, event);
    if (sideEffect) await sideEffect(order);
    await sql`update orders set status = ${nextStatus}, updated_at = now() where id = ${orderId}`.execute(tx);
    await this.recordHistory(tx, principal, orderId, order.status, nextStatus, 'USER');
    await recordAudit(tx, {
      tenantId: principal.tenantId,
      action: `order.${event.toLowerCase()}`,
      resourceType: 'order',
      resourceId: orderId,
      before: { status: order.status },
      after: { status: nextStatus },
    });
    return (await this.loadOrder(tx, orderId))!;
  }

  private async recordHistory(
    tx: Tx,
    principal: Principal,
    orderId: string,
    from: string | null,
    to: string,
    source: string,
  ): Promise<void> {
    await sql`insert into order_status_history (tenant_id, id, order_id, from_status, to_status, source, actor_id)
              values (${principal.tenantId}, ${uuidv7()}, ${orderId}, ${from}, ${to}, ${source}, ${principal.membershipId})`.execute(
      tx,
    );
  }

  private async resolveWarehouse(tx: Tx, warehouseId: string | undefined): Promise<string> {
    if (warehouseId) {
      const { rows } = await sql`select 1 from warehouses where id = ${warehouseId} and is_active`.execute(
        tx,
      );
      if (rows.length === 0) throw new ValidationError('Unknown warehouse', { warehouseId });
      return warehouseId;
    }
    const { rows } = await sql<{ id: string }>`
      select id from warehouses where is_active order by created_at limit 1`.execute(tx);
    const first = rows[0];
    if (!first) throw new BusinessRuleError('NO_WAREHOUSE', 'No active warehouse to fulfil from');
    return first.id;
  }

  private async loadOrder(tx: Tx, orderId: string): Promise<Order | null> {
    const { rows } = await sql<OrderRow>`
      select id, order_no, channel_code, fulfillment_warehouse_id, customer_id, status, payment_status,
             fulfillment_status, inventory_status, hold_reason, subtotal, discount_total, tax_total,
             grand_total, paid_total, refunded_total, note, placed_at
        from orders where id = ${orderId}`.execute(tx);
    const row = rows[0];
    if (!row) return null;
    const { rows: itemRows } = await sql<OrderItemRow>`
      select id, line_no, variant_id, sku, name, quantity, unit_price, tax_rate, discount_amount,
             tax_amount, line_total, fulfilled_qty, cancelled_qty, returned_qty, refunded_amount
        from order_items where order_id = ${orderId} order by line_no`.execute(tx);
    return toOrder(row, itemRows);
  }

  private async insertOrderItem(
    tx: Tx,
    tenantId: string,
    orderId: string,
    line: OrderLineTotals,
  ): Promise<void> {
    const id = uuidv7();
    await sql`
      insert into order_items (tenant_id, id, order_id, line_no, variant_id, sku, name, quantity,
                               unit_price, discount_amount, tax_rate, tax_amount, line_total)
      values (${tenantId}, ${id}, ${orderId}, ${line.lineNo}, ${line.variantId}, ${line.sku}, ${line.name},
              ${line.quantity}, ${line.unitPrice}, ${line.discountAmount}, ${line.taxRate}, ${line.taxAmount},
              ${line.lineTotal})`.execute(tx);
  }
}

interface OrderRow {
  id: string;
  order_no: string;
  channel_code: string;
  fulfillment_warehouse_id: string;
  customer_id: string | null;
  status: Order['status'];
  payment_status: Order['paymentStatus'];
  fulfillment_status: Order['fulfillmentStatus'];
  inventory_status: Order['inventoryStatus'];
  hold_reason: string | null;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  paid_total: string;
  refunded_total: string;
  note: string | null;
  placed_at: Date;
}
interface OrderItemRow {
  id: string;
  line_no: number;
  variant_id: string;
  sku: string;
  name: string;
  quantity: string;
  unit_price: string;
  tax_rate: string;
  discount_amount: string;
  tax_amount: string;
  line_total: string;
  fulfilled_qty: string;
  cancelled_qty: string;
  returned_qty: string;
  refunded_amount: string;
}
function toOrder(r: OrderRow, items: OrderItemRow[]): Order {
  return {
    id: r.id,
    orderNo: r.order_no,
    channelCode: r.channel_code,
    warehouseId: r.fulfillment_warehouse_id,
    customerId: r.customer_id,
    status: r.status,
    paymentStatus: r.payment_status,
    fulfillmentStatus: r.fulfillment_status,
    inventoryStatus: r.inventory_status,
    holdReason: r.hold_reason,
    subtotal: r.subtotal,
    discountTotal: r.discount_total,
    taxTotal: r.tax_total,
    grandTotal: r.grand_total,
    paidTotal: r.paid_total,
    refundedTotal: r.refunded_total,
    note: r.note,
    placedAt: r.placed_at.toISOString(),
    lines: items.map((i) => ({
      id: i.id,
      lineNo: i.line_no,
      variantId: i.variant_id,
      sku: i.sku,
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      taxRate: i.tax_rate,
      discountAmount: i.discount_amount,
      taxAmount: i.tax_amount,
      lineTotal: i.line_total,
      fulfilledQty: i.fulfilled_qty,
      cancelledQty: i.cancelled_qty,
      returnedQty: i.returned_qty,
      refundedAmount: i.refunded_amount,
    })),
  };
}

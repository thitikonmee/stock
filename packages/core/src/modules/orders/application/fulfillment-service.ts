import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import { InventoryEngine, readAvgCost, type ReservationService } from '../../inventory/public-api';
import { transition } from '../domain/order-state-machine';
import type { CreateFulfillmentInput, Fulfillment, ShipInput } from '../domain/types';

/**
 * Pick → pack → ship (docs/04-inventory.md §5, §4 for the FulfillmentRouter). One order can have
 * several fulfillments (partial shipment); the order's own `status`/`fulfillment_status` only move
 * once every line is fully accounted for across all of them.
 */
export class FulfillmentService {
  private readonly engine = new InventoryEngine();

  constructor(private readonly reservations: ReservationService) {}

  async create(
    tx: Tx,
    principal: Principal,
    orderId: string,
    input: CreateFulfillmentInput,
  ): Promise<Fulfillment> {
    assertCan(principal, 'order.fulfill');
    if (!isUuid(input.idempotencyKey)) throw new ValidationError('idempotencyKey must be a UUID');
    if (input.lines.length === 0) throw new ValidationError('A fulfillment needs at least one line');
    const order = await this.loadOrderForFulfillment(tx, orderId);
    if (!['CONFIRMED', 'PROCESSING', 'PACKED'].includes(order.status)) {
      throw new BusinessRuleError('ORDER_NOT_FULFILLABLE', `Order is ${order.status}, not ready to fulfil`);
    }
    const warehouseId = input.warehouseId ?? order.warehouseId;

    for (const line of input.lines) {
      const item = await this.loadOrderItem(tx, orderId, line.orderItemId);
      if (!item) throw new ValidationError('Unknown order line', { orderItemId: line.orderItemId });
      const remaining = new Dec(item.quantity).minus(item.fulfilledQty).minus(item.cancelledQty);
      if (new Dec(line.quantity).greaterThan(remaining)) {
        throw new BusinessRuleError(
          'OVER_FULFILL',
          `${item.sku}: only ${remaining.toFixed(3)} left to fulfil`,
          {
            orderItemId: line.orderItemId,
          },
        );
      }
    }

    const { rows: existing } = await sql<{ id: string }>`
      select id from fulfillments where order_id = ${orderId} and id = ${input.idempotencyKey}`.execute(tx);
    const fulfillmentId = input.idempotencyKey;
    if (existing.length === 0) {
      await sql`insert into fulfillments (tenant_id, id, order_id, warehouse_id, status, picked_by)
                values (${principal.tenantId}, ${fulfillmentId}, ${orderId}, ${warehouseId}, 'PICKING',
                        ${principal.membershipId})
                on conflict (tenant_id, id) do nothing`.execute(tx);
      for (const line of input.lines) {
        await sql`insert into fulfillment_items (tenant_id, fulfillment_id, order_item_id, quantity)
                  values (${principal.tenantId}, ${fulfillmentId}, ${line.orderItemId}, ${line.quantity})
                  on conflict (tenant_id, fulfillment_id, order_item_id) do nothing`.execute(tx);
      }
    }
    if (order.status === 'CONFIRMED') {
      await sql`update orders set status = 'PROCESSING' where id = ${orderId} and status = 'CONFIRMED'`.execute(
        tx,
      );
    }
    return (await this.get(tx, principal, fulfillmentId))!;
  }

  async pack(tx: Tx, principal: Principal, fulfillmentId: string): Promise<Fulfillment> {
    assertCan(principal, 'order.fulfill');
    const f = await this.get(tx, principal, fulfillmentId);
    if (!f) throw new NotFoundError('Fulfillment not found');
    if (f.status !== 'PICKING') throw new BusinessRuleError('NOT_PICKING', `Fulfillment is ${f.status}`);
    await sql`update fulfillments set status = 'PACKED', packed_by = ${principal.membershipId}, updated_at = now()
                where id = ${fulfillmentId}`.execute(tx);
    const { rows } = await sql<{ status: string }>`select status from orders where id = ${f.orderId}`.execute(
      tx,
    );
    if (rows[0]?.status === 'PROCESSING') {
      await sql`update orders set status = 'PACKED' where id = ${f.orderId}`.execute(tx);
    }
    return (await this.get(tx, principal, fulfillmentId))!;
  }

  async ship(tx: Tx, principal: Principal, fulfillmentId: string, input: ShipInput): Promise<Fulfillment> {
    assertCan(principal, 'order.fulfill');
    const f = await this.get(tx, principal, fulfillmentId);
    if (!f) throw new NotFoundError('Fulfillment not found');
    if (f.status === 'SHIPPED') return f; // idempotent: already shipped, nothing more to do
    if (f.status !== 'PACKED' && f.status !== 'PICKING') {
      throw new BusinessRuleError('NOT_READY_TO_SHIP', `Fulfillment is ${f.status}`);
    }

    await this.engine.apply(tx, {
      tenantId: principal.tenantId,
      operation: 'SHIP',
      idempotencyKey: `fulfillment:${fulfillmentId}:ship`,
      reference: { type: 'ORDER', id: f.orderId },
      lines: await Promise.all(
        f.items.map(async (i) => ({
          warehouseId: f.warehouseId,
          variantId: (await this.loadOrderItem(tx, f.orderId, i.orderItemId))!.variantId,
          quantity: i.quantity,
        })),
      ),
    });

    for (const item of f.items) {
      const line = (await this.loadOrderItem(tx, f.orderId, item.orderItemId))!;
      const unitCost = await readAvgCost(tx, principal.tenantId, line.variantId);
      await sql`update order_items set fulfilled_qty = fulfilled_qty + ${item.quantity}::numeric,
                  unit_cost = ${unitCost} where id = ${item.orderItemId}`.execute(tx);
      const orderReservations = await this.reservations.list(tx, principal, {
        referenceType: 'ORDER',
        referenceId: f.orderId,
      });
      const matching = orderReservations.find((r) => r.variantId === line.variantId);
      if (matching) await this.reservations.markFulfilled(tx, principal, matching.id, item.quantity);
    }

    await sql`update fulfillments set status = 'SHIPPED', shipped_at = now(),
                carrier = ${input.carrier ?? null}, tracking_no = ${input.trackingNo ?? null}, updated_at = now()
                where id = ${fulfillmentId}`.execute(tx);

    await this.syncOrderFulfillmentStatus(tx, principal, f.orderId);
    return (await this.get(tx, principal, fulfillmentId))!;
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<Fulfillment | null> {
    assertCan(principal, 'order.read');
    const { rows } = await sql<{
      id: string;
      order_id: string;
      warehouse_id: string;
      status: Fulfillment['status'];
      carrier: string | null;
      tracking_no: string | null;
      shipped_at: Date | null;
    }>`
      select id, order_id, warehouse_id, status, carrier, tracking_no, shipped_at
        from fulfillments where id = ${id}`.execute(tx);
    const row = rows[0];
    if (!row) return null;
    const { rows: items } = await sql<{ order_item_id: string; quantity: string }>`
      select order_item_id, quantity from fulfillment_items where fulfillment_id = ${id}`.execute(tx);
    return {
      id: row.id,
      orderId: row.order_id,
      warehouseId: row.warehouse_id,
      status: row.status,
      carrier: row.carrier,
      trackingNo: row.tracking_no,
      shippedAt: row.shipped_at?.toISOString() ?? null,
      items: items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })),
    };
  }

  async list(tx: Tx, principal: Principal, orderId: string): Promise<Fulfillment[]> {
    assertCan(principal, 'order.read');
    await this.loadOrderForFulfillment(tx, orderId);
    const { rows } = await sql<{ id: string }>`
      select id from fulfillments where order_id = ${orderId} order by created_at`.execute(tx);
    const list = await Promise.all(rows.map((r) => this.get(tx, principal, r.id)));
    return list.filter((f): f is Fulfillment => f !== null);
  }

  // ---------------------------------------------------------------- helpers

  private async syncOrderFulfillmentStatus(tx: Tx, principal: Principal, orderId: string): Promise<void> {
    const { rows } = await sql<{ quantity: string; fulfilled_qty: string; cancelled_qty: string }>`
      select quantity, fulfilled_qty, cancelled_qty from order_items where order_id = ${orderId}`.execute(tx);
    const totalQty = rows.reduce((sum, r) => sum.plus(r.quantity), new Dec(0));
    const doneQty = rows.reduce((sum, r) => sum.plus(r.fulfilled_qty).plus(r.cancelled_qty), new Dec(0));
    const fulfillmentStatus = doneQty.isZero()
      ? 'UNFULFILLED'
      : doneQty.greaterThanOrEqualTo(totalQty)
        ? 'FULFILLED'
        : 'PARTIALLY_FULFILLED';
    await sql`update orders set fulfillment_status = ${fulfillmentStatus} where id = ${orderId}`.execute(tx);

    if (fulfillmentStatus === 'FULFILLED') {
      const { rows: orderRows } = await sql<{
        status: string;
      }>`select status from orders where id = ${orderId}`.execute(tx);
      const current = orderRows[0]?.status as Parameters<typeof transition>[0] | undefined;
      if (current && (current === 'PACKED' || current === 'PROCESSING' || current === 'CONFIRMED')) {
        const next = transition(current, 'SHIP');
        await sql`update orders set status = ${next}, updated_at = now() where id = ${orderId}`.execute(tx);
        await sql`insert into order_status_history (tenant_id, id, order_id, from_status, to_status, source, actor_id)
                  values (${principal.tenantId}, ${uuidv7()}, ${orderId}, ${current}, ${next}, 'SYSTEM', ${principal.membershipId})`.execute(
          tx,
        );
      }
    }
  }

  private async loadOrderForFulfillment(
    tx: Tx,
    orderId: string,
  ): Promise<{ status: string; warehouseId: string }> {
    const { rows } = await sql<{ status: string; fulfillment_warehouse_id: string }>`
      select status, fulfillment_warehouse_id from orders where id = ${orderId}`.execute(tx);
    const row = rows[0];
    if (!row) throw new NotFoundError('Order not found');
    return { status: row.status, warehouseId: row.fulfillment_warehouse_id };
  }

  private async loadOrderItem(
    tx: Tx,
    orderId: string,
    orderItemId: string,
  ): Promise<{
    sku: string;
    variantId: string;
    quantity: string;
    fulfilledQty: string;
    cancelledQty: string;
  } | null> {
    const { rows } = await sql<{
      sku: string;
      variant_id: string;
      quantity: string;
      fulfilled_qty: string;
      cancelled_qty: string;
    }>`
      select sku, variant_id, quantity, fulfilled_qty, cancelled_qty from order_items
       where id = ${orderItemId} and order_id = ${orderId}`.execute(tx);
    const r = rows[0];
    return r
      ? {
          sku: r.sku,
          variantId: r.variant_id,
          quantity: r.quantity,
          fulfilledQty: r.fulfilled_qty,
          cancelledQty: r.cancelled_qty,
        }
      : null;
  }
}

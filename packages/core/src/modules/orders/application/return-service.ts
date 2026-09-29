import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, ValidationError, isUuid, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import { InventoryEngine } from '../../inventory/public-api';
import { transition } from '../domain/order-state-machine';
import type { OrderReturn, ReceiveReturnInput, RequestReturnInput } from '../domain/types';

/** Return request + QC receiving (docs/04-inventory.md §5 "→ RETURNED"). */
export class ReturnService {
  private readonly engine = new InventoryEngine();

  async request(
    tx: Tx,
    principal: Principal,
    orderId: string,
    input: RequestReturnInput,
  ): Promise<OrderReturn> {
    assertCan(principal, 'order.update');
    if (!isUuid(input.idempotencyKey)) throw new ValidationError('idempotencyKey must be a UUID');
    if (input.lines.length === 0) throw new ValidationError('A return needs at least one line');
    const returnId = input.idempotencyKey;
    const existing = await this.get(tx, principal, returnId);
    if (existing) return existing;

    const order = await this.loadOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order not found');
    for (const line of input.lines) {
      const item = await this.loadOrderItem(tx, orderId, line.orderItemId);
      if (!item) throw new ValidationError('Unknown order line', { orderItemId: line.orderItemId });
      const returnable = new Dec(item.fulfilledQty).minus(item.returnedQty);
      if (new Dec(line.quantity).greaterThan(returnable)) {
        throw new BusinessRuleError(
          'OVER_RETURN',
          `${item.sku}: only ${returnable.toFixed(3)} eligible to return`,
          {
            orderItemId: line.orderItemId,
          },
        );
      }
    }

    const { rows } = await sql<{ id: string }>`
      insert into order_returns (tenant_id, id, order_id, status, receive_warehouse_id, reason)
      values (${principal.tenantId}, ${returnId}, ${orderId}, 'REQUESTED',
              ${input.receiveWarehouseId ?? order.warehouseId}, ${input.reason ?? null})
      on conflict (tenant_id, id) do nothing
      returning id`.execute(tx);
    if (rows.length === 0) {
      const replay = await this.get(tx, principal, returnId);
      if (replay) return replay;
      throw new ValidationError('Idempotency key conflict could not be resolved; retry the request');
    }
    for (const line of input.lines) {
      await sql`insert into order_return_items (tenant_id, return_id, order_item_id, quantity)
                values (${principal.tenantId}, ${returnId}, ${line.orderItemId}, ${line.quantity})`.execute(
        tx,
      );
    }
    return (await this.get(tx, principal, returnId))!;
  }

  /** Per-line QC: SELLABLE/DAMAGED restock the warehouse; MISSING restocks nothing. */
  async receive(
    tx: Tx,
    principal: Principal,
    returnId: string,
    input: ReceiveReturnInput,
  ): Promise<OrderReturn> {
    assertCan(principal, 'order.update');
    const ret = await this.get(tx, principal, returnId);
    if (!ret) throw new NotFoundError('Return not found');
    if (ret.status !== 'REQUESTED' && ret.status !== 'IN_TRANSIT') {
      throw new BusinessRuleError('RETURN_NOT_RECEIVABLE', `Return is ${ret.status}`);
    }
    const warehouseId = ret.receiveWarehouseId!;

    for (const line of input.lines) {
      const item = ret.items.find((i) => i.orderItemId === line.orderItemId);
      if (!item) throw new ValidationError('Unknown return line', { orderItemId: line.orderItemId });
      const orderItem = (await this.loadOrderItem(tx, ret.orderId, line.orderItemId))!;

      if (line.condition !== 'MISSING') {
        await this.engine.apply(tx, {
          tenantId: principal.tenantId,
          operation: line.condition === 'SELLABLE' ? 'RETURN_SELLABLE' : 'RETURN_DAMAGED',
          idempotencyKey: `return:${returnId}:item:${line.orderItemId}:restock`,
          reference: { type: 'ORDER_RETURN', id: returnId },
          lines: [{ warehouseId, variantId: orderItem.variantId, quantity: item.quantity }],
        });
        await sql`update order_return_items set restocked_qty = ${item.quantity}, condition = ${line.condition}
                    where tenant_id = ${principal.tenantId} and return_id = ${returnId} and order_item_id = ${line.orderItemId}`.execute(
          tx,
        );
      } else {
        await sql`update order_return_items set condition = 'MISSING'
                    where tenant_id = ${principal.tenantId} and return_id = ${returnId} and order_item_id = ${line.orderItemId}`.execute(
          tx,
        );
      }
      await sql`update order_items set returned_qty = returned_qty + ${item.quantity}::numeric
                  where id = ${line.orderItemId}`.execute(tx);
    }

    await sql`update order_returns set status = 'COMPLETED', updated_at = now() where id = ${returnId}`.execute(
      tx,
    );

    const { rows: orderRows } = await sql<{
      status: string;
    }>`select status from orders where id = ${ret.orderId}`.execute(tx);
    const current = orderRows[0]?.status as Parameters<typeof transition>[0] | undefined;
    if (current === 'SHIPPED' || current === 'DELIVERED') {
      const next = transition(current, 'RETURN');
      await sql`update orders set status = ${next}, fulfillment_status = 'RETURNED', updated_at = now()
                  where id = ${ret.orderId}`.execute(tx);
      await sql`insert into order_status_history (tenant_id, id, order_id, from_status, to_status, source, actor_id)
                values (${principal.tenantId}, ${uuidv7()}, ${ret.orderId}, ${current}, ${next}, 'SYSTEM', ${principal.membershipId})`.execute(
        tx,
      );
    }
    return (await this.get(tx, principal, returnId))!;
  }

  async listForOrder(tx: Tx, principal: Principal, orderId: string): Promise<OrderReturn[]> {
    assertCan(principal, 'order.read');
    if (!(await this.loadOrder(tx, orderId))) throw new NotFoundError('Order not found');
    const { rows } = await sql<{ id: string }>`
      select id from order_returns where order_id = ${orderId} order by created_at`.execute(tx);
    const list = await Promise.all(rows.map((r) => this.get(tx, principal, r.id)));
    return list.filter((r): r is OrderReturn => r !== null);
  }

  async get(tx: Tx, principal: Principal, id: string): Promise<OrderReturn | null> {
    assertCan(principal, 'order.read');
    const { rows } = await sql<{
      id: string;
      order_id: string;
      status: OrderReturn['status'];
      reason: string | null;
      receive_warehouse_id: string | null;
    }>`
      select id, order_id, status, reason, receive_warehouse_id from order_returns where id = ${id}`.execute(
      tx,
    );
    const row = rows[0];
    if (!row) return null;
    const { rows: items } = await sql<{
      order_item_id: string;
      quantity: string;
      condition: OrderReturn['items'][number]['condition'];
      restocked_qty: string;
    }>`
      select order_item_id, quantity, condition, restocked_qty from order_return_items where return_id = ${id}`.execute(
      tx,
    );
    return {
      id: row.id,
      orderId: row.order_id,
      status: row.status,
      reason: row.reason,
      receiveWarehouseId: row.receive_warehouse_id,
      items: items.map((i) => ({
        orderItemId: i.order_item_id,
        quantity: i.quantity,
        condition: i.condition,
        restockedQty: i.restocked_qty,
      })),
    };
  }

  private async loadOrder(tx: Tx, orderId: string): Promise<{ warehouseId: string } | null> {
    const { rows } = await sql<{ fulfillment_warehouse_id: string }>`
      select fulfillment_warehouse_id from orders where id = ${orderId}`.execute(tx);
    return rows[0] ? { warehouseId: rows[0].fulfillment_warehouse_id } : null;
  }

  private async loadOrderItem(
    tx: Tx,
    orderId: string,
    orderItemId: string,
  ): Promise<{ sku: string; variantId: string; fulfilledQty: string; returnedQty: string } | null> {
    const { rows } = await sql<{
      sku: string;
      variant_id: string;
      fulfilled_qty: string;
      returned_qty: string;
    }>`
      select sku, variant_id, fulfilled_qty, returned_qty from order_items
       where id = ${orderItemId} and order_id = ${orderId}`.execute(tx);
    const r = rows[0];
    return r
      ? { sku: r.sku, variantId: r.variant_id, fulfilledQty: r.fulfilled_qty, returnedQty: r.returned_qty }
      : null;
  }
}

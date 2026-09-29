import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, ValidationError, formatMoney, uuidv7 } from '@stockos/shared';
import { InventoryEngine } from '../../inventory/public-api';
import { can, type PosPinService, type Principal } from '../../iam/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import type { Refund, RefundInput } from '../domain/types';
import { verifyManagerOverride } from './manager-override';
import type { ShiftService } from './shift-service';

/** Refund/exchange against an existing sale (docs/05-pos.md §15). Exchange = a refund + a new `sell()` call. */
export class RefundService {
  private readonly engine = new InventoryEngine();

  constructor(
    private readonly pins: PosPinService,
    private readonly shifts: ShiftService,
  ) {}

  async refund(tx: Tx, principal: Principal, input: RefundInput): Promise<Refund> {
    const existing = await this.findByKey(tx, input.idempotencyKey);
    if (existing) return existing;

    if (!can(principal, 'pos.refund')) {
      if (!input.managerOverride)
        throw new BusinessRuleError('MANAGER_APPROVAL_REQUIRED', 'Refund needs a manager');
      await verifyManagerOverride(tx, this.pins, principal.tenantId, input.managerOverride, 'pos.refund');
    }
    if (input.lines.length === 0) throw new ValidationError('At least one refund line is required');

    // Whichever device processes the refund pays it out of its OWN open shift's drawer — not
    // necessarily the shift the original sale was rung up on (docs/05-pos.md §16).
    const shift = await this.shifts.get(tx, principal, input.shiftId);
    if (shift.status !== 'OPEN') throw new BusinessRuleError('SHIFT_NOT_OPEN', 'Shift is not open');

    // Serialize concurrent retries of the same idempotency key: the loser waits here until the
    // winner's transaction ends, then resumes and simply returns what the winner committed — the
    // `refunds.amount > 0` CHECK constraint rules out a claim-a-row-first / fill-it-in-later insert
    // the way InventoryEngine does, so an advisory lock plays that role instead.
    await sql`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`.execute(tx);
    const afterLock = await this.findByKey(tx, input.idempotencyKey);
    if (afterLock) return afterLock;

    const order = await this.loadOrder(tx, input.orderId);
    if (!order) throw new NotFoundError('Order not found');
    if (order.status === 'CANCELLED') throw new BusinessRuleError('ORDER_CANCELLED', 'Order was cancelled');

    const payment = await this.pickPayment(tx, input.orderId, input.method);
    if (!payment) throw new ValidationError('No matching payment to refund');

    let totalAmount = new Dec(0);
    const lineAmounts: { orderItemId: string; variantId: string; quantity: string; amount: string }[] = [];
    for (const line of input.lines) {
      const item = await this.loadOrderItem(tx, input.orderId, line.orderItemId);
      if (!item) throw new ValidationError('Unknown order line', { orderItemId: line.orderItemId });
      const requested = new Dec(line.quantity);
      if (!requested.isPositive()) throw new ValidationError('Refund quantity must be positive');
      const refundedSoFar = await this.refundedQtySoFar(tx, line.orderItemId);
      if (refundedSoFar.plus(requested).greaterThan(item.quantity)) {
        throw new BusinessRuleError('REFUND_EXCEEDS_SOLD', `${item.sku}: refund exceeds quantity sold`, {
          orderItemId: line.orderItemId,
        });
      }
      const amount = new Dec(item.lineTotal).dividedBy(item.quantity).times(requested);
      totalAmount = totalAmount.plus(amount);
      lineAmounts.push({
        orderItemId: line.orderItemId,
        variantId: item.variantId,
        quantity: line.quantity,
        amount: formatMoney(amount),
      });

      if (line.restockCondition) {
        await this.engine.apply(tx, {
          tenantId: principal.tenantId,
          operation: line.restockCondition === 'SELLABLE' ? 'RETURN_SELLABLE' : 'RETURN_DAMAGED',
          idempotencyKey: `refund:${input.idempotencyKey}:item:${line.orderItemId}:restock`,
          reference: { type: 'POS_REFUND', id: input.orderId },
          lines: [{ warehouseId: order.warehouseId, variantId: item.variantId, quantity: line.quantity }],
        });
        await sql`update order_items set returned_qty = returned_qty + ${line.quantity}::numeric
                    where id = ${line.orderItemId}`.execute(tx);
      }
      await sql`update order_items set refunded_amount = refunded_amount + ${formatMoney(amount)}::numeric
                  where id = ${line.orderItemId}`.execute(tx);
    }

    if (new Dec(payment.refundedAmount).plus(totalAmount).greaterThan(payment.amount)) {
      throw new BusinessRuleError('REFUND_EXCEEDS_PAYMENT', 'Refund exceeds the original payment amount');
    }
    await sql`update payments set refunded_amount = refunded_amount + ${formatMoney(totalAmount)}::numeric
                where id = ${payment.id}`.execute(tx);

    const newRefundedTotal = new Dec(order.refundedTotal).plus(totalAmount);
    const fullyRefunded = newRefundedTotal.greaterThanOrEqualTo(order.grandTotal);
    const nextStatus = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await sql`update orders set refunded_total = ${formatMoney(newRefundedTotal)}, status = ${nextStatus},
                payment_status = ${nextStatus} where id = ${input.orderId}`.execute(tx);

    const refundId = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'CN');
    // No conflict is possible here: the advisory lock above makes this transaction the sole holder
    // of `input.idempotencyKey` for as long as it runs.
    await sql`
      insert into refunds (tenant_id, id, order_id, payment_id, doc_no, amount, reason, restock, status,
                           idempotency_key, approved_by, created_by, pos_shift_id)
      values (${principal.tenantId}, ${refundId}, ${input.orderId}, ${payment.id}, ${docNo},
              ${formatMoney(totalAmount)}, ${input.reason}, ${input.lines.some((l) => l.restockCondition)},
              'SUCCEEDED', ${input.idempotencyKey}, ${principal.membershipId}, ${principal.membershipId},
              ${input.shiftId})`.execute(tx);
    for (const l of lineAmounts) {
      await sql`insert into refund_items (tenant_id, refund_id, order_item_id, quantity, amount)
                values (${principal.tenantId}, ${refundId}, ${l.orderItemId}, ${l.quantity}, ${l.amount})`.execute(
        tx,
      );
    }

    return {
      id: refundId,
      docNo,
      orderId: input.orderId,
      amount: formatMoney(totalAmount),
      status: 'SUCCEEDED',
    };
  }

  private async findByKey(tx: Tx, idempotencyKey: string): Promise<Refund | null> {
    const { rows } = await sql<{
      id: string;
      doc_no: string;
      order_id: string;
      amount: string;
      status: string;
    }>`
      select id, doc_no, order_id, amount, status from refunds where idempotency_key = ${idempotencyKey}`.execute(
      tx,
    );
    const r = rows[0];
    return r ? { id: r.id, docNo: r.doc_no, orderId: r.order_id, amount: r.amount, status: r.status } : null;
  }

  private async loadOrder(
    tx: Tx,
    orderId: string,
  ): Promise<{ status: string; warehouseId: string; grandTotal: string; refundedTotal: string } | null> {
    const { rows } = await sql<{
      status: string;
      fulfillment_warehouse_id: string;
      grand_total: string;
      refunded_total: string;
    }>`
      select status, fulfillment_warehouse_id, grand_total, refunded_total from orders where id = ${orderId}`.execute(
      tx,
    );
    const r = rows[0];
    return r
      ? {
          status: r.status,
          warehouseId: r.fulfillment_warehouse_id,
          grandTotal: r.grand_total,
          refundedTotal: r.refunded_total,
        }
      : null;
  }

  private async loadOrderItem(
    tx: Tx,
    orderId: string,
    orderItemId: string,
  ): Promise<{ sku: string; variantId: string; quantity: string; lineTotal: string } | null> {
    const { rows } = await sql<{ sku: string; variant_id: string; quantity: string; line_total: string }>`
      select sku, variant_id, quantity, line_total from order_items
       where id = ${orderItemId} and order_id = ${orderId}`.execute(tx);
    const r = rows[0];
    return r ? { sku: r.sku, variantId: r.variant_id, quantity: r.quantity, lineTotal: r.line_total } : null;
  }

  private async refundedQtySoFar(tx: Tx, orderItemId: string): Promise<Dec> {
    const { rows } = await sql<{ total: string | null }>`
      select sum(ri.quantity) as total from refund_items ri
        join refunds r on r.id = ri.refund_id
       where ri.order_item_id = ${orderItemId} and r.status = 'SUCCEEDED'`.execute(tx);
    return new Dec(rows[0]?.total ?? '0');
  }

  private async pickPayment(
    tx: Tx,
    orderId: string,
    method?: string,
  ): Promise<{ id: string; amount: string; refundedAmount: string } | null> {
    const { rows } = await sql<{ id: string; amount: string; refunded_amount: string }>`
      select id, amount, refunded_amount from payments
       where order_id = ${orderId} and status = 'SUCCEEDED'
         and (${method ?? null}::text is null or method = ${method ?? null})
       order by created_at limit 1`.execute(tx);
    const r = rows[0];
    return r ? { id: r.id, amount: r.amount, refundedAmount: r.refunded_amount } : null;
  }
}

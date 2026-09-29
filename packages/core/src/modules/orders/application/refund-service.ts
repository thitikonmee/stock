import { sql } from 'kysely';
import type { Tx } from '@stockos/database';
import { BusinessRuleError, Dec, NotFoundError, ValidationError, formatMoney, uuidv7 } from '@stockos/shared';
import { assertCan, type Principal } from '../../iam/public-api';
import { nextDocumentNumber } from '../../tenancy/public-api';
import { transition, type OrderStatus } from '../domain/order-state-machine';
import type { OrderRefund, OrderRefundInput } from '../domain/types';

/** Money-only refund against an order (docs/08-api-design.md `POST /orders/:id/refunds`) — stock was
 *  already handled by `ReturnService` if there was a physical return; this never touches stock itself. */
export class RefundService {
  async refund(tx: Tx, principal: Principal, orderId: string, input: OrderRefundInput): Promise<OrderRefund> {
    assertCan(principal, 'order.refund');
    if (input.lines.length === 0) throw new ValidationError('At least one refund line is required');

    // Same reasoning as pos/application/refund-service.ts: serialize concurrent retries of the same
    // key with an advisory lock rather than catch-and-requery, which would poison the transaction.
    await sql`select pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`.execute(tx);
    const afterLock = await this.findByKey(tx, input.idempotencyKey);
    if (afterLock) return afterLock;

    const order = await this.loadOrder(tx, orderId);
    if (!order) throw new NotFoundError('Order not found');
    if (order.status === 'CANCELLED') throw new BusinessRuleError('ORDER_CANCELLED', 'Order was cancelled');

    const payment = await this.pickPayment(tx, orderId);
    if (!payment) throw new ValidationError('No payment on this order to refund');

    let totalAmount = new Dec(0);
    const lineAmounts: { orderItemId: string; quantity: string; amount: string }[] = [];
    for (const line of input.lines) {
      const item = await this.loadOrderItem(tx, orderId, line.orderItemId);
      if (!item) throw new ValidationError('Unknown order line', { orderItemId: line.orderItemId });
      const requested = new Dec(line.quantity);
      if (!requested.isPositive()) throw new ValidationError('Refund quantity must be positive');
      const refundedSoFar = await this.refundedQtySoFar(tx, line.orderItemId);
      if (refundedSoFar.plus(requested).greaterThan(item.quantity)) {
        throw new BusinessRuleError('REFUND_EXCEEDS_SOLD', `${item.sku}: refund exceeds quantity ordered`, {
          orderItemId: line.orderItemId,
        });
      }
      const amount = new Dec(item.lineTotal).dividedBy(item.quantity).times(requested);
      totalAmount = totalAmount.plus(amount);
      lineAmounts.push({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        amount: formatMoney(amount),
      });
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
    // The state machine always passes through PARTIALLY_REFUNDED on the way to REFUNDED (even a
    // refund that happens to be full in one call) — except from RETURNED, which jumps straight there.
    let nextStatus: OrderStatus = order.status;
    if (order.status === 'RETURNED') nextStatus = transition(order.status, 'REFUND');
    else if (order.status === 'PARTIALLY_REFUNDED' && fullyRefunded) {
      nextStatus = transition(order.status, 'REFUND_REMAINING');
    } else if (order.status === 'DELIVERED' || order.status === 'COMPLETED') {
      nextStatus = transition(order.status, 'REFUND');
    }
    // Any other status (e.g. CANCELLED) keeps its status — this refund only moves money.
    await sql`update orders set refunded_total = ${formatMoney(newRefundedTotal)}, status = ${nextStatus},
                payment_status = ${fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'}, updated_at = now()
                where id = ${orderId}`.execute(tx);
    if (nextStatus !== order.status) {
      await sql`insert into order_status_history (tenant_id, id, order_id, from_status, to_status, source, actor_id)
                values (${principal.tenantId}, ${uuidv7()}, ${orderId}, ${order.status}, ${nextStatus}, 'USER', ${principal.membershipId})`.execute(
        tx,
      );
    }

    const refundId = uuidv7();
    const docNo = await nextDocumentNumber(tx, principal.tenantId, 'CN');
    await sql`
      insert into refunds (tenant_id, id, order_id, payment_id, return_id, doc_no, amount, reason, status,
                           idempotency_key, approved_by, created_by)
      values (${principal.tenantId}, ${refundId}, ${orderId}, ${payment.id}, ${input.returnId ?? null}, ${docNo},
              ${formatMoney(totalAmount)}, ${input.reason}, 'SUCCEEDED', ${input.idempotencyKey},
              ${principal.membershipId}, ${principal.membershipId})`.execute(tx);
    for (const l of lineAmounts) {
      await sql`insert into refund_items (tenant_id, refund_id, order_item_id, quantity, amount)
                values (${principal.tenantId}, ${refundId}, ${l.orderItemId}, ${l.quantity}, ${l.amount})`.execute(
        tx,
      );
    }

    return { id: refundId, docNo, orderId, amount: formatMoney(totalAmount), status: 'SUCCEEDED' };
  }

  private async findByKey(tx: Tx, idempotencyKey: string): Promise<OrderRefund | null> {
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
  ): Promise<{ status: OrderStatus; grandTotal: string; refundedTotal: string } | null> {
    const { rows } = await sql<{ status: OrderStatus; grand_total: string; refunded_total: string }>`
      select status, grand_total, refunded_total from orders where id = ${orderId}`.execute(tx);
    const r = rows[0];
    return r ? { status: r.status, grandTotal: r.grand_total, refundedTotal: r.refunded_total } : null;
  }

  private async loadOrderItem(
    tx: Tx,
    orderId: string,
    orderItemId: string,
  ): Promise<{ sku: string; quantity: string; lineTotal: string } | null> {
    const { rows } = await sql<{ sku: string; quantity: string; line_total: string }>`
      select sku, quantity, line_total from order_items where id = ${orderItemId} and order_id = ${orderId}`.execute(
      tx,
    );
    const r = rows[0];
    return r ? { sku: r.sku, quantity: r.quantity, lineTotal: r.line_total } : null;
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
  ): Promise<{ id: string; amount: string; refundedAmount: string } | null> {
    const { rows } = await sql<{ id: string; amount: string; refunded_amount: string }>`
      select id, amount, refunded_amount from payments
       where order_id = ${orderId} and status = 'SUCCEEDED' order by created_at limit 1`.execute(tx);
    const r = rows[0];
    return r ? { id: r.id, amount: r.amount, refundedAmount: r.refunded_amount } : null;
  }
}

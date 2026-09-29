import { InvalidStateTransitionError } from '@stockos/shared';

/** Must match the CHECK constraint on orders.status. */
export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING',
  'PAID',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'RETURNED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ON_HOLD',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_EVENTS = [
  'PAY',
  'CONFIRM',
  'HOLD',
  'RELEASE_HOLD',
  'START_PICKING',
  'PACK',
  'SHIP',
  'DELIVER',
  'COMPLETE',
  'CANCEL',
  'RETURN',
  'REFUND',
  'REFUND_REMAINING',
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

/**
 * The order lifecycle (docs/04-inventory.md §5). Pure and total: every (status, event) pair not
 * listed here is illegal and `transition()` throws rather than silently doing nothing.
 *
 * This table only decides whether a move is legal and where it lands — NOT the inventory side
 * effect, which depends on more than the event alone (e.g. CANCEL releases a soft RESERVE if the
 * order never got past PAID, but un-commits a hard COMMIT if it was already CONFIRMED; PAID itself
 * can be either, depending on whether the order arrived pre-paid). The service layer decides that
 * from the order's actual `inventory_status`, then calls `inventory.ReservationService` accordingly.
 */
const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderEvent, OrderStatus>>> = {
  DRAFT: {},
  PENDING: { PAY: 'PAID', CANCEL: 'CANCELLED' },
  PAID: { CONFIRM: 'CONFIRMED', HOLD: 'ON_HOLD', CANCEL: 'CANCELLED' },
  ON_HOLD: { RELEASE_HOLD: 'CONFIRMED', CANCEL: 'CANCELLED' },
  CONFIRMED: { START_PICKING: 'PROCESSING', CANCEL: 'CANCELLED' },
  // SHIP is legal straight from PROCESSING too, not just PACKED: PACK is a real but optional
  // milestone (a shop with no separate packing station just picks and ships in one motion).
  PROCESSING: { PACK: 'PACKED', SHIP: 'SHIPPED', CANCEL: 'CANCELLED' },
  PACKED: { SHIP: 'SHIPPED', CANCEL: 'CANCELLED' },
  SHIPPED: { DELIVER: 'DELIVERED', RETURN: 'RETURNED' },
  DELIVERED: { COMPLETE: 'COMPLETED', RETURN: 'RETURNED', REFUND: 'PARTIALLY_REFUNDED' },
  COMPLETED: { REFUND: 'PARTIALLY_REFUNDED' },
  RETURNED: { REFUND: 'REFUNDED' },
  PARTIALLY_REFUNDED: { REFUND_REMAINING: 'REFUNDED' },
  CANCELLED: {},
  REFUNDED: {},
};

export function transition(current: OrderStatus, event: OrderEvent): OrderStatus {
  const next = TRANSITIONS[current][event];
  if (!next) {
    throw new InvalidStateTransitionError(`Cannot ${event} an order that is ${current}`, {
      status: current,
      event,
    });
  }
  return next;
}

export function canTransition(current: OrderStatus, event: OrderEvent): boolean {
  return TRANSITIONS[current][event] !== undefined;
}

/** Where a brand-new order starts: paid already (POS/marketplace) skips straight past PENDING. */
export function initialStatus(paidAlready: boolean): OrderStatus {
  return paidAlready ? 'PAID' : 'PENDING';
}

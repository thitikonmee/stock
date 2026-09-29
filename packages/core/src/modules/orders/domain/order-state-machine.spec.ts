import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '@stockos/shared';
import {
  ORDER_EVENTS,
  ORDER_STATUSES,
  canTransition,
  initialStatus,
  transition,
  type OrderStatus,
} from './order-state-machine';

// The legal graph, spelled out once — the test below cross-checks every (status, event) pair
// against it, so adding an illegal edge here (or missing one) fails loudly either way.
const LEGAL: [OrderStatus, string, OrderStatus][] = [
  ['PENDING', 'PAY', 'PAID'],
  ['PENDING', 'CANCEL', 'CANCELLED'],
  ['PAID', 'CONFIRM', 'CONFIRMED'],
  ['PAID', 'HOLD', 'ON_HOLD'],
  ['PAID', 'CANCEL', 'CANCELLED'],
  ['ON_HOLD', 'RELEASE_HOLD', 'CONFIRMED'],
  ['ON_HOLD', 'CANCEL', 'CANCELLED'],
  ['CONFIRMED', 'START_PICKING', 'PROCESSING'],
  ['CONFIRMED', 'CANCEL', 'CANCELLED'],
  ['PROCESSING', 'PACK', 'PACKED'],
  ['PROCESSING', 'SHIP', 'SHIPPED'],
  ['PROCESSING', 'CANCEL', 'CANCELLED'],
  ['PACKED', 'SHIP', 'SHIPPED'],
  ['PACKED', 'CANCEL', 'CANCELLED'],
  ['SHIPPED', 'DELIVER', 'DELIVERED'],
  ['SHIPPED', 'RETURN', 'RETURNED'],
  ['DELIVERED', 'COMPLETE', 'COMPLETED'],
  ['DELIVERED', 'RETURN', 'RETURNED'],
  ['DELIVERED', 'REFUND', 'PARTIALLY_REFUNDED'],
  ['COMPLETED', 'REFUND', 'PARTIALLY_REFUNDED'],
  ['RETURNED', 'REFUND', 'REFUNDED'],
  ['PARTIALLY_REFUNDED', 'REFUND_REMAINING', 'REFUNDED'],
];

describe('order state machine', () => {
  it('accepts every legal (status, event) pair and lands on the right status', () => {
    for (const [from, event, to] of LEGAL) {
      expect(transition(from, event as never)).toBe(to);
      expect(canTransition(from, event as never)).toBe(true);
    }
  });

  it('rejects every (status, event) pair not on the legal list — exhaustive, not sampled', () => {
    const legalSet = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
    for (const status of ORDER_STATUSES) {
      for (const event of ORDER_EVENTS) {
        const key = `${status}:${event}`;
        if (legalSet.has(key)) continue;
        expect(canTransition(status, event)).toBe(false);
        expect(() => transition(status, event)).toThrow(InvalidStateTransitionError);
      }
    }
  });

  it('DRAFT, CANCELLED and REFUNDED are terminal or pre-lifecycle — no event moves them', () => {
    for (const status of ['DRAFT', 'CANCELLED', 'REFUNDED'] as const) {
      for (const event of ORDER_EVENTS) expect(canTransition(status, event)).toBe(false);
    }
  });

  it('a rejected transition names the status and event, never fails silently', () => {
    try {
      transition('COMPLETED', 'SHIP');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      expect((err as InvalidStateTransitionError).meta).toEqual({ status: 'COMPLETED', event: 'SHIP' });
    }
  });

  it('starts PENDING when unpaid, PAID when paid already', () => {
    expect(initialStatus(false)).toBe('PENDING');
    expect(initialStatus(true)).toBe('PAID');
  });
});

import { describe, expect, it } from 'vitest';
import { deriveOrderStatus, mapLazadaLineStatus } from './status-map';

describe('mapLazadaLineStatus', () => {
  it.each([
    ['unpaid', 'PENDING'],
    ['pending', 'CONFIRMED'],
    ['packed', 'PACKED'],
    ['ready_to_ship', 'PACKED'],
    ['shipped', 'SHIPPED'],
    ['delivered', 'DELIVERED'],
    ['failed_delivery', 'RETURN_REQUESTED'],
    ['returned', 'RETURN_REQUESTED'],
    ['canceled', 'CANCELLED'],
    ['cancelled', 'CANCELLED'],
  ] as const)('maps %s to %s', (raw, expected) => {
    expect(mapLazadaLineStatus(raw)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(mapLazadaLineStatus('SHIPPED')).toBe('SHIPPED');
  });

  it('defaults unknown statuses to NO_CHANGE instead of throwing', () => {
    expect(mapLazadaLineStatus('some_future_status')).toBe('NO_CHANGE');
  });
});

describe('deriveOrderStatus', () => {
  it('all lines cancelled -> order CANCELLED', () => {
    expect(deriveOrderStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });

  it('one line cancelled, others confirmed -> order stays CONFIRMED (docs 3-line example)', () => {
    expect(deriveOrderStatus(['CONFIRMED', 'CONFIRMED', 'CANCELLED'])).toBe('CONFIRMED');
  });

  it('takes the least-advanced status among active lines', () => {
    expect(deriveOrderStatus(['SHIPPED', 'PENDING', 'CONFIRMED'])).toBe('PENDING');
  });

  it('a single active line drives the order status directly', () => {
    expect(deriveOrderStatus(['SHIPPED'])).toBe('SHIPPED');
  });

  it('a return on any active line surfaces at the order level', () => {
    expect(deriveOrderStatus(['SHIPPED', 'RETURN_REQUESTED'])).toBe('RETURN_REQUESTED');
  });

  it('every line matching (order-level platforms like Shopee) just reflects that single status', () => {
    expect(deriveOrderStatus(['PACKED', 'PACKED'])).toBe('PACKED');
  });
});

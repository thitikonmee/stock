import { describe, expect, it } from 'vitest';
import { mapShopeeOrderStatus } from './status-map';

describe('mapShopeeOrderStatus', () => {
  it.each([
    ['UNPAID', 'PENDING'],
    ['READY_TO_SHIP', 'CONFIRMED'],
    ['PROCESSED', 'PACKED'],
    ['SHIPPED', 'SHIPPED'],
    ['TO_CONFIRM_RECEIVE', 'DELIVERED'],
    ['COMPLETED', 'COMPLETED'],
    ['CANCELLED', 'CANCELLED'],
    ['TO_RETURN', 'RETURN_REQUESTED'],
  ] as const)('maps %s to %s', (shopee, expected) => {
    expect(mapShopeeOrderStatus(shopee)).toBe(expected);
  });

  it('keeps the current status for IN_CANCEL (do not release stock until it is really cancelled)', () => {
    expect(mapShopeeOrderStatus('IN_CANCEL')).toBe('NO_CHANGE');
  });

  it('defaults unknown statuses to NO_CHANGE instead of throwing', () => {
    expect(mapShopeeOrderStatus('SOME_FUTURE_STATUS')).toBe('NO_CHANGE');
  });
});

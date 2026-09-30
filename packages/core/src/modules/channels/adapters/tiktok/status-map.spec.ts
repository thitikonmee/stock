import { describe, expect, it } from 'vitest';
import { mapTikTokOrderStatus } from './status-map';

describe('mapTikTokOrderStatus', () => {
  it.each([
    ['UNPAID', 'PENDING'],
    ['ON_HOLD', 'NO_CHANGE'],
    ['AWAITING_SHIPMENT', 'CONFIRMED'],
    ['PARTIALLY_SHIPPING', 'SHIPPED'],
    ['AWAITING_COLLECTION', 'PACKED'],
    ['IN_TRANSIT', 'SHIPPED'],
    ['DELIVERED', 'DELIVERED'],
    ['COMPLETED', 'COMPLETED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)('maps %s -> %s', (raw, expected) => {
    expect(mapTikTokOrderStatus(raw)).toBe(expected);
  });

  it('falls back to NO_CHANGE for an unrecognized status', () => {
    expect(mapTikTokOrderStatus('SOME_FUTURE_STATUS')).toBe('NO_CHANGE');
  });
});

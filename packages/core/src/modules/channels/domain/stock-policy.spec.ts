import { describe, expect, it } from 'vitest';
import { computeSellable, DEFAULT_STOCK_POLICY } from './stock-policy';

describe('computeSellable', () => {
  it('pushes full availability with the default (no-op) policy', () => {
    expect(computeSellable('100.000', DEFAULT_STOCK_POLICY)).toBe('100.000');
  });

  it('subtracts safety stock first', () => {
    expect(computeSellable('100', { ...DEFAULT_STOCK_POLICY, safetyStock: '10' })).toBe('90.000');
  });

  it('applies the buffer percentage after safety stock', () => {
    expect(computeSellable('100', { ...DEFAULT_STOCK_POLICY, safetyStock: '0', bufferPercent: '20' })).toBe(
      '80.000',
    );
  });

  it('combines safety stock then buffer', () => {
    // (100 - 10) * (1 - 0.20) = 72
    expect(computeSellable('100', { ...DEFAULT_STOCK_POLICY, safetyStock: '10', bufferPercent: '20' })).toBe(
      '72.000',
    );
  });

  it('never goes negative when safety stock exceeds availability', () => {
    expect(computeSellable('5', { ...DEFAULT_STOCK_POLICY, safetyStock: '10' })).toBe('0.000');
  });

  it('caps at maxPushQty', () => {
    expect(computeSellable('100', { ...DEFAULT_STOCK_POLICY, maxPushQty: '20' })).toBe('20.000');
  });

  it('pushes zero once sellable drops to or below pushZeroBelow', () => {
    expect(computeSellable('3', { ...DEFAULT_STOCK_POLICY, pushZeroBelow: '5' })).toBe('0.000');
    expect(computeSellable('5', { ...DEFAULT_STOCK_POLICY, pushZeroBelow: '5' })).toBe('0.000');
    expect(computeSellable('6', { ...DEFAULT_STOCK_POLICY, pushZeroBelow: '5' })).toBe('6.000');
  });

  it('maxPushQty caps before the pushZeroBelow check, not instead of it', () => {
    // capped to 3, which is <= pushZeroBelow(5) -> zero
    expect(computeSellable('100', { ...DEFAULT_STOCK_POLICY, maxPushQty: '3', pushZeroBelow: '5' })).toBe(
      '0.000',
    );
  });
});

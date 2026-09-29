import { describe, expect, it } from 'vitest';
import { BusinessRuleError, ValidationError } from '@stockos/shared';
import { computeCart, validatePaymentSplit, type CartLineInput } from './cart';

const line = (overrides: Partial<CartLineInput> = {}): CartLineInput => ({
  lineNo: 1,
  variantId: '00000000-0000-0000-0000-000000000001',
  sku: 'SKU-1',
  name: 'Widget',
  quantity: '2',
  unitPrice: '107.00',
  taxRate: '7',
  priceIncludesTax: true,
  ...overrides,
});

describe('computeCart — VAT inclusive', () => {
  it('back-derives VAT from a tax-inclusive price', () => {
    const result = computeCart({ lines: [line()] });
    // 107 * 2 = 214 gross; VAT = 214 - 214/1.07 = 14.00
    expect(result.subtotal).toBe('214.00');
    expect(result.taxTotal).toBe('14.00');
    expect(result.discountTotal).toBe('0.00');
    expect(result.grandTotal).toBe('214.00');
    expect(result.lines[0]!.lineTotal).toBe('214.00');
  });

  it('applies a line discount before computing tax', () => {
    const result = computeCart({ lines: [line({ discountAmount: '14.00' })] });
    expect(result.lines[0]!.lineTotal).toBe('200.00');
    expect(result.discountTotal).toBe('14.00');
  });

  it('prorates a cart-level discount across lines by amount, remainder on the last line', () => {
    const result = computeCart({
      lines: [
        line({ lineNo: 1, unitPrice: '100.00', quantity: '1' }),
        line({ lineNo: 2, unitPrice: '300.00', quantity: '1' }),
      ],
      cartDiscountAmount: '40.00',
    });
    // weights: 100/400 and 300/400 of a 40.00 discount = 10.00 and 30.00
    expect(result.lines[0]!.discountAmount).toBe('10.00');
    expect(result.lines[1]!.discountAmount).toBe('30.00');
    expect(result.discountTotal).toBe('40.00');
  });

  it('rejects a discount larger than the line amount', () => {
    expect(() => computeCart({ lines: [line({ discountAmount: '500.00' })] })).toThrow(BusinessRuleError);
  });

  it('rejects discounting an empty cart', () => {
    expect(() => computeCart({ lines: [], cartDiscountAmount: '1' })).toThrow(ValidationError);
  });
});

describe('computeCart — VAT exclusive', () => {
  it('adds VAT on top of a tax-exclusive price', () => {
    const result = computeCart({ lines: [line({ unitPrice: '100.00', priceIncludesTax: false })] });
    expect(result.subtotal).toBe('200.00');
    expect(result.taxTotal).toBe('14.00');
    expect(result.grandTotal).toBe('214.00');
  });
});

describe('computeCart — rounding', () => {
  it('rounds the grand total to the nearest baht and reports the delta', () => {
    // 3 units at 33.33 (VAT-inclusive) = 99.99
    const result = computeCart({
      lines: [line({ unitPrice: '33.33', quantity: '3' })],
      roundingIncrement: '1.00',
    });
    expect(result.grandTotal).toBe('100.00');
    expect(result.rounding).toBe('0.01');
  });

  it('does not round when no increment is given', () => {
    const result = computeCart({ lines: [line({ unitPrice: '33.33', quantity: '3' })] });
    expect(result.grandTotal).toBe('99.99');
    expect(result.rounding).toBe('0.00');
  });
});

describe('validatePaymentSplit', () => {
  it('accepts an exact single payment', () => {
    expect(validatePaymentSplit([{ method: 'PROMPTPAY', amount: '214.00' }], '214.00')).toEqual({
      changeAmount: '0.00',
    });
  });

  it('computes change for cash tendered above the total', () => {
    expect(
      validatePaymentSplit([{ method: 'CASH', amount: '214.00', tenderedAmount: '300.00' }], '214.00'),
    ).toEqual({ changeAmount: '86.00' });
  });

  it('accepts a split across methods that sums exactly', () => {
    expect(
      validatePaymentSplit(
        [
          { method: 'CASH', amount: '100.00', tenderedAmount: '100.00' },
          { method: 'PROMPTPAY', amount: '114.00' },
        ],
        '214.00',
      ),
    ).toEqual({ changeAmount: '0.00' });
  });

  it('rejects a split that does not cover the total', () => {
    expect(() => validatePaymentSplit([{ method: 'CASH', amount: '200.00' }], '214.00')).toThrow(
      BusinessRuleError,
    );
  });

  it('rejects cash tendered below the amount', () => {
    expect(() =>
      validatePaymentSplit([{ method: 'CASH', amount: '214.00', tenderedAmount: '100.00' }], '214.00'),
    ).toThrow(ValidationError);
  });
});

import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from '@stockos/shared';
import { computeOrderTotals, type OrderLineCalcInput } from './pricing';

const line = (overrides: Partial<OrderLineCalcInput> = {}): OrderLineCalcInput => ({
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

describe('computeOrderTotals', () => {
  it('back-derives VAT from a tax-inclusive price', () => {
    const result = computeOrderTotals([line()]);
    expect(result.subtotal).toBe('214.00');
    expect(result.taxTotal).toBe('14.00');
    expect(result.grandTotal).toBe('214.00');
  });

  it('adds VAT on top of a tax-exclusive price', () => {
    const result = computeOrderTotals([line({ unitPrice: '100.00', priceIncludesTax: false })]);
    expect(result.taxTotal).toBe('14.00');
    expect(result.grandTotal).toBe('214.00');
  });

  it('applies a per-line discount before tax', () => {
    const result = computeOrderTotals([line({ discountAmount: '14.00' })]);
    expect(result.lines[0]!.lineTotal).toBe('200.00');
    expect(result.discountTotal).toBe('14.00');
  });

  it('rejects a discount larger than the line amount', () => {
    expect(() => computeOrderTotals([line({ discountAmount: '500.00' })])).toThrow(BusinessRuleError);
  });

  it('sums multiple lines', () => {
    const result = computeOrderTotals([
      line({ lineNo: 1 }),
      line({ lineNo: 2, unitPrice: '50.00', quantity: '1' }),
    ]);
    expect(result.grandTotal).toBe('264.00');
  });
});

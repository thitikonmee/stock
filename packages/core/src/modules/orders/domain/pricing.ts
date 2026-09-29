import { BusinessRuleError, Dec, ValidationError, formatMoney, toMoney, toQuantity } from '@stockos/shared';

export interface OrderLineCalcInput {
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  priceIncludesTax: boolean;
  discountAmount?: string;
}

export interface OrderLineTotals {
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  discountAmount: string;
  taxAmount: string;
  lineTotal: string;
}

export interface OrderTotals {
  lines: OrderLineTotals[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
}

/**
 * Manual/API order pricing — the same VAT-inclusive/exclusive math as pos/domain/cart.ts, minus
 * bill-level rounding and cart-level discount proration (till-tray concepts a phone/API order
 * doesn't have). Kept as its own small pure function rather than importing from `pos` — modules
 * only reach each other through public-api.ts, and pos is not something orders should depend on.
 */
export function computeOrderTotals(lines: readonly OrderLineCalcInput[]): OrderTotals {
  if (lines.length === 0) throw new ValidationError('An order needs at least one line');

  const computed: OrderLineTotals[] = lines.map((line) => {
    const qty = toQuantity(line.quantity);
    const discountAmount = toMoney(line.discountAmount ?? '0');
    const amount = toMoney(line.unitPrice).times(qty);
    if (discountAmount.greaterThan(amount)) {
      throw new BusinessRuleError('DISCOUNT_EXCEEDS_LINE', `Discount exceeds line amount for ${line.sku}`, {
        sku: line.sku,
      });
    }
    const netOrGross = amount.minus(discountAmount);
    const rate = new Dec(line.taxRate).dividedBy(100);
    const taxAmount = line.priceIncludesTax
      ? netOrGross.minus(netOrGross.dividedBy(rate.plus(1)))
      : netOrGross.times(rate);
    const lineTotal = line.priceIncludesTax ? netOrGross : netOrGross.plus(taxAmount);
    return {
      lineNo: line.lineNo,
      variantId: line.variantId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: formatMoney(toMoney(line.unitPrice)),
      taxRate: line.taxRate,
      discountAmount: formatMoney(discountAmount),
      taxAmount: formatMoney(taxAmount),
      lineTotal: formatMoney(lineTotal),
    };
  });

  return {
    lines: computed,
    subtotal: formatMoney(
      lines.reduce((sum, l) => sum.plus(toMoney(l.unitPrice).times(toQuantity(l.quantity))), new Dec(0)),
    ),
    discountTotal: formatMoney(computed.reduce((sum, l) => sum.plus(l.discountAmount), new Dec(0))),
    taxTotal: formatMoney(computed.reduce((sum, l) => sum.plus(l.taxAmount), new Dec(0))),
    grandTotal: formatMoney(computed.reduce((sum, l) => sum.plus(l.lineTotal), new Dec(0))),
  };
}

import { BusinessRuleError, Dec, ValidationError, formatMoney, toMoney, toQuantity } from '@stockos/shared';

export interface CartLineInput {
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  /** List price per unit, in the basis `priceIncludesTax` says (VAT-inclusive by default in Thai retail). */
  unitPrice: string;
  taxRate: string;
  priceIncludesTax: boolean;
  /** Manual discount for this line only, money, tax-inclusive basis. */
  discountAmount?: string;
}

export interface CartLineTotals {
  lineNo: number;
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  /** Total discount on this line after cart-level discount has been prorated in. */
  discountAmount: string;
  taxAmount: string;
  /** What the customer pays for this line, tax-inclusive. */
  lineTotal: string;
}

export interface CartTotals {
  lines: CartLineTotals[];
  /** Sum of list amounts (unitPrice × qty) before any discount, in each line's own tax basis. */
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  /** Rounding correction applied to land on `roundingIncrement` (e.g. 1.00 THB); can be negative. */
  rounding: string;
  grandTotal: string;
}

export interface ComputeCartInput {
  lines: readonly CartLineInput[];
  /** Extra discount beyond each line's own, prorated across lines by their pre-discount amount. */
  cartDiscountAmount?: string;
  /** Round the final total to this increment (0 = no rounding). Thai till trays: 0, 0.25, 0.50, 1.00. */
  roundingIncrement?: string;
}

const MAX_LINES = 500;

/**
 * pos-engine (docs/05-pos.md): pure cart math — VAT inclusive/exclusive, line + cart discount,
 * bill-level rounding. No I/O, no stock check — SaleService applies InventoryEngine separately.
 */
export function computeCart(input: ComputeCartInput): CartTotals {
  if (input.lines.length === 0 || input.lines.length > MAX_LINES) {
    throw new ValidationError(`A sale needs 1..${MAX_LINES} lines`);
  }

  const bases = input.lines.map((line) => {
    const qty = toQuantity(line.quantity);
    if (!qty.isPositive()) throw new ValidationError('Line quantity must be positive');
    return { line, amount: toMoney(line.unitPrice).times(qty) };
  });
  const cartBase = bases.reduce((sum, b) => sum.plus(b.amount), new Dec(0));
  const cartDiscount = toMoney(input.cartDiscountAmount ?? '0');
  if (cartBase.isZero() && !cartDiscount.isZero()) {
    throw new ValidationError('Cannot discount an empty cart');
  }

  let prorated = new Dec(0);
  const lines: CartLineTotals[] = bases.map(({ line, amount }, i) => {
    const ownDiscount = toMoney(line.discountAmount ?? '0');
    // Last line absorbs the rounding remainder so prorated shares always sum exactly to cartDiscount.
    const share =
      i === bases.length - 1
        ? cartDiscount.minus(prorated)
        : toMoney(cartDiscount.times(amount).dividedBy(cartBase.isZero() ? 1 : cartBase));
    prorated = prorated.plus(share);
    const discountAmount = ownDiscount.plus(share);
    if (discountAmount.greaterThan(amount)) {
      throw new BusinessRuleError('DISCOUNT_EXCEEDS_LINE', `Discount exceeds line amount for ${line.sku}`, {
        sku: line.sku,
      });
    }

    const rate = new Dec(line.taxRate).dividedBy(100);
    const netOrGross = amount.minus(discountAmount);
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

  const subtotal = cartBase;
  const discountTotal = lines.reduce((sum, l) => sum.plus(l.discountAmount), new Dec(0));
  const taxTotal = lines.reduce((sum, l) => sum.plus(l.taxAmount), new Dec(0));
  const preRoundTotal = lines.reduce((sum, l) => sum.plus(l.lineTotal), new Dec(0));

  const increment = new Dec(input.roundingIncrement ?? '0');
  const rounded = increment.isZero() ? preRoundTotal : roundToIncrement(preRoundTotal, increment);
  const rounding = rounded.minus(preRoundTotal);

  return {
    lines,
    subtotal: formatMoney(subtotal),
    discountTotal: formatMoney(discountTotal),
    taxTotal: formatMoney(taxTotal),
    rounding: formatMoney(rounding),
    grandTotal: formatMoney(rounded),
  };
}

function roundToIncrement(amount: Dec, increment: Dec): Dec {
  return amount.dividedBy(increment).toDecimalPlaces(0, Dec.ROUND_HALF_UP).times(increment);
}

export interface PaymentLineInput {
  method: string;
  amount: string;
  tenderedAmount?: string;
}

export interface PaymentSplitResult {
  changeAmount: string;
}

/**
 * Split payments must cover the grand total exactly; only CASH may tender more (the rest is change).
 * Throws `PAYMENT_MISMATCH` when the split under- or over-collects.
 */
export function validatePaymentSplit(
  payments: readonly PaymentLineInput[],
  grandTotal: string,
): PaymentSplitResult {
  if (payments.length === 0) throw new ValidationError('At least one payment line is required');
  const total = new Dec(grandTotal);
  let collected = new Dec(0);
  let change = new Dec(0);
  for (const p of payments) {
    const amount = toMoney(p.amount);
    if (!amount.isPositive()) throw new ValidationError('Payment amount must be positive');
    collected = collected.plus(amount);
    if (p.method === 'CASH' && p.tenderedAmount !== undefined) {
      const tendered = toMoney(p.tenderedAmount);
      if (tendered.lessThan(amount)) throw new ValidationError('Tendered amount is less than the cash line');
      change = change.plus(tendered.minus(amount));
    }
  }
  if (!collected.equals(total)) {
    throw new BusinessRuleError(
      'PAYMENT_MISMATCH',
      `Payments total ${collected.toFixed(2)}, expected ${total.toFixed(2)}`,
      {
        collected: formatMoney(collected),
        expected: formatMoney(total),
      },
    );
  }
  return { changeAmount: formatMoney(change) };
}

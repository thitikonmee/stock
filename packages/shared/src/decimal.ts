import Decimal from 'decimal.js';
import { ValidationError } from './errors';

/** Decimal configured for money/quantity math. Never use JS `number` for money or stock. */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

export const QUANTITY_SCALE = 3;
export const MONEY_SCALE = 2;

export interface QuantityOptions {
  /** Allow negative values (signed adjustments). Default false. */
  allowNegative?: boolean;
  /** Allow zero. Default false. */
  allowZero?: boolean;
}

/** Parse and validate a quantity (NUMERIC(14,3) in the database). */
export function toQuantity(input: string | number | Decimal, options: QuantityOptions = {}): Decimal {
  let value: Decimal;
  try {
    value = new Dec(input);
  } catch {
    throw new ValidationError(`Invalid quantity: ${String(input)}`);
  }
  if (!value.isFinite()) throw new ValidationError(`Invalid quantity: ${String(input)}`);
  if (value.decimalPlaces() > QUANTITY_SCALE) {
    throw new ValidationError(`Quantity supports at most ${QUANTITY_SCALE} decimal places`, {
      value: value.toString(),
    });
  }
  if (value.isZero() && !options.allowZero) throw new ValidationError('Quantity must not be zero');
  if (value.isNegative() && !value.isZero() && !options.allowNegative) {
    throw new ValidationError('Quantity must be positive', { value: value.toString() });
  }
  if (value.abs().greaterThanOrEqualTo('100000000000')) {
    throw new ValidationError('Quantity out of range', { value: value.toString() });
  }
  return value;
}

/** Canonical string for a quantity, matching Postgres NUMERIC(14,3) output. */
export function formatQuantity(value: Decimal): string {
  return value.toFixed(QUANTITY_SCALE);
}

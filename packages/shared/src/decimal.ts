import Decimal from 'decimal.js';
import { ValidationError } from './errors';

/** Decimal configured for money/quantity math. Never use JS `number` for money or stock. */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

export const QUANTITY_SCALE = 3;
export const MONEY_SCALE = 2;
/** Unit cost fields (cost_price, avg_cost, last_cost) are NUMERIC(14,4) — finer than money totals. */
export const COST_SCALE = 4;

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

export interface MoneyOptions {
  /** Allow negative values (e.g. a discount). Default false. */
  allowNegative?: boolean;
}

/** Parse and validate a money amount (NUMERIC(14,2) in the database). Never use `number` for money. */
export function toMoney(input: string | number | Decimal, options: MoneyOptions = {}): Decimal {
  let value: Decimal;
  try {
    value = new Dec(input);
  } catch {
    throw new ValidationError(`Invalid amount: ${String(input)}`);
  }
  if (!value.isFinite()) throw new ValidationError(`Invalid amount: ${String(input)}`);
  if (value.decimalPlaces() > MONEY_SCALE) {
    throw new ValidationError(`Amount supports at most ${MONEY_SCALE} decimal places`, {
      value: value.toString(),
    });
  }
  if (value.isNegative() && !options.allowNegative) {
    throw new ValidationError('Amount must not be negative', { value: value.toString() });
  }
  if (value.abs().greaterThanOrEqualTo('100000000000')) {
    throw new ValidationError('Amount out of range', { value: value.toString() });
  }
  return value;
}

/** Canonical string for a money amount, matching Postgres NUMERIC(14,2) output. */
export function formatMoney(value: Decimal): string {
  return value.toFixed(MONEY_SCALE);
}

/** Parse and validate a unit cost amount (NUMERIC(14,4) in the database). Never negative. */
export function toCost(input: string | number | Decimal): Decimal {
  let value: Decimal;
  try {
    value = new Dec(input);
  } catch {
    throw new ValidationError(`Invalid cost: ${String(input)}`);
  }
  if (!value.isFinite() || value.isNegative()) throw new ValidationError(`Invalid cost: ${String(input)}`);
  if (value.decimalPlaces() > COST_SCALE) {
    throw new ValidationError(`Cost supports at most ${COST_SCALE} decimal places`, {
      value: value.toString(),
    });
  }
  if (value.greaterThanOrEqualTo('100000000000')) throw new ValidationError('Cost out of range');
  return value;
}

/** Canonical string for a unit cost, matching Postgres NUMERIC(14,4) output. */
export function formatCost(value: Decimal): string {
  return value.toFixed(COST_SCALE);
}

import { describe, expect, it } from 'vitest';
import { formatCost, formatMoney, formatQuantity, toCost, toMoney, toQuantity } from './decimal';
import { ValidationError } from './errors';

describe('toQuantity', () => {
  it('accepts up to 3 decimal places and formats like NUMERIC(14,3)', () => {
    expect(formatQuantity(toQuantity('1.5'))).toBe('1.500');
    expect(formatQuantity(toQuantity(2))).toBe('2.000');
    expect(formatQuantity(toQuantity('0.125'))).toBe('0.125');
  });

  it('avoids floating point drift', () => {
    expect(formatQuantity(toQuantity('0.1').plus(toQuantity('0.2')))).toBe('0.300');
  });

  it.each([['0.0001'], ['abc'], ['0'], ['-1'], ['1e12'], [Number.NaN]])('rejects %s by default', (input) => {
    expect(() => toQuantity(input)).toThrow(ValidationError);
  });

  it('allows negative and zero only when asked', () => {
    expect(formatQuantity(toQuantity('-2', { allowNegative: true }))).toBe('-2.000');
    expect(formatQuantity(toQuantity('0', { allowZero: true }))).toBe('0.000');
  });
});

describe('toMoney', () => {
  it('accepts up to 2 decimal places, zero, and formats like NUMERIC(14,2)', () => {
    expect(formatMoney(toMoney('19.9'))).toBe('19.90');
    expect(formatMoney(toMoney(0))).toBe('0.00');
  });

  it.each([['0.001'], ['abc'], ['-1'], [Number.NaN]])('rejects %s by default', (input) => {
    expect(() => toMoney(input)).toThrow(ValidationError);
  });

  it('allows negative only when asked', () => {
    expect(formatMoney(toMoney('-5', { allowNegative: true }))).toBe('-5.00');
  });
});

describe('toCost', () => {
  it('accepts up to 4 decimal places and formats like NUMERIC(14,4)', () => {
    expect(formatCost(toCost('12.3456'))).toBe('12.3456');
    expect(formatCost(toCost(0))).toBe('0.0000');
  });

  it.each([['0.00001'], ['abc'], ['-1']])('rejects %s', (input) => {
    expect(() => toCost(input)).toThrow(ValidationError);
  });
});

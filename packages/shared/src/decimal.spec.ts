import { describe, expect, it } from 'vitest';
import { formatQuantity, toQuantity } from './decimal';
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

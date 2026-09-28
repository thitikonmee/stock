import { describe, expect, it } from 'vitest';
import { isRetryableTxError, pgErrorCode } from './pg-errors';

describe('isRetryableTxError', () => {
  it.each(['40P01', '40001', '55P03'])('retries %s', (code) => {
    expect(isRetryableTxError({ code })).toBe(true);
  });

  it.each(['23505', '23514', '42501', undefined])('does not retry %s', (code) => {
    expect(isRetryableTxError({ code })).toBe(false);
  });

  it('handles non-objects', () => {
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('40P01')).toBeUndefined();
    expect(isRetryableTxError(new Error('x'))).toBe(false);
  });
});

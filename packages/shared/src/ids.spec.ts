import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 / variant 10 ids', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 1);
    const id = uuidv7(now + 5_000_000); // ahead of any earlier call in this process
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBe(now + 5_000_000);
  });

  it('is strictly increasing within a burst in the same millisecond', () => {
    const fixed = Date.UTC(2030, 0, 1);
    const ids = Array.from({ length: 10_000 }, () => uuidv7(fixed));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never goes backwards when the clock does', () => {
    const a = uuidv7(Date.UTC(2031, 0, 1));
    const b = uuidv7(Date.UTC(2020, 0, 1));
    expect(b > a).toBe(true);
  });
});

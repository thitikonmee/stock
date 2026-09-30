import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSign, verifyWebhookSignature } from './signing';

describe('buildSign', () => {
  it('sorts params by key, excludes sign, and uppercases the hex digest', () => {
    const params = { b: '2', a: '1', sign: 'ignored' };
    const base = '/orders/get' + 'a1' + 'b2'; // sorted a, b
    const expected = createHmac('sha256', 'secret').update(base, 'utf8').digest('hex').toUpperCase();
    expect(buildSign('secret', '/orders/get', params)).toBe(expected);
  });

  it('is deterministic regardless of input key order', () => {
    const s1 = buildSign('secret', '/x', { z: '1', a: '2' });
    const s2 = buildSign('secret', '/x', { a: '2', z: '1' });
    expect(s1).toBe(s2);
  });

  it('changes when the secret, path, or any param changes', () => {
    const base = buildSign('secret', '/x', { a: '1' });
    expect(buildSign('other', '/x', { a: '1' })).not.toBe(base);
    expect(buildSign('secret', '/y', { a: '1' })).not.toBe(base);
    expect(buildSign('secret', '/x', { a: '2' })).not.toBe(base);
  });

  it('is all uppercase hex', () => {
    expect(buildSign('secret', '/x', { a: '1' })).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'app_secret_123';
  const appKey = 'app_key_456';
  const body = '{"seller_id":"1","data":{"status":"shipped"}}';

  function sign(s: string, k: string, b: string): string {
    return createHmac('sha256', s)
      .update(k + b, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  it('accepts a correctly computed signature', () => {
    expect(verifyWebhookSignature(secret, appKey, body, sign(secret, appKey, body))).toBe(true);
  });

  it('accepts a lowercase-hex signature too (case-insensitive compare)', () => {
    expect(verifyWebhookSignature(secret, appKey, body, sign(secret, appKey, body).toLowerCase())).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(secret, appKey, body, undefined)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    expect(verifyWebhookSignature(secret, appKey, body, sign('wrong', appKey, body))).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = sign(secret, appKey, body);
    expect(
      verifyWebhookSignature(secret, appKey, '{"seller_id":"1","data":{"status":"cancelled"}}', sig),
    ).toBe(false);
  });
});

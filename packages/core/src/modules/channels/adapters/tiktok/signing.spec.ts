import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSign, isFreshTimestamp, verifyWebhookSignature } from './signing';

describe('buildSign', () => {
  it('sandwiches the secret around path+sorted-params+body and HMACs with the same secret', () => {
    const params = { b: '2', a: '1', sign: 'ignored', access_token: 'ignored-too' };
    const base = 'secret' + '/orders/get' + 'a1' + 'b2' + 'secret'; // sorted a, b; no body
    const expected = createHmac('sha256', 'secret').update(base, 'utf8').digest('hex');
    expect(buildSign('secret', '/orders/get', params)).toBe(expected);
  });

  it('folds a body string into the signed material when present', () => {
    const withBody = buildSign('secret', '/x', { a: '1' }, '{"k":"v"}');
    const withoutBody = buildSign('secret', '/x', { a: '1' });
    expect(withBody).not.toBe(withoutBody);
    const base = 'secret' + '/x' + 'a1' + '{"k":"v"}' + 'secret';
    expect(withBody).toBe(createHmac('sha256', 'secret').update(base, 'utf8').digest('hex'));
  });

  it('excludes both sign and access_token from the signed params', () => {
    const a = buildSign('secret', '/x', { a: '1' });
    const b = buildSign('secret', '/x', { a: '1', sign: 'whatever', access_token: 'whatever-else' });
    expect(a).toBe(b);
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

  it('is lowercase hex', () => {
    expect(buildSign('secret', '/x', { a: '1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'app_secret_123';
  const appKey = 'app_key_456';
  const body = '{"shop_id":"1","data":{"order_status":"AWAITING_SHIPMENT"}}';

  function sign(s: string, k: string, b: string): string {
    return createHmac('sha256', s)
      .update(k + b, 'utf8')
      .digest('hex');
  }

  it('accepts a correctly computed signature', () => {
    expect(verifyWebhookSignature(secret, appKey, body, sign(secret, appKey, body))).toBe(true);
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
      verifyWebhookSignature(secret, appKey, '{"shop_id":"1","data":{"order_status":"CANCELLED"}}', sig),
    ).toBe(false);
  });
});

describe('isFreshTimestamp', () => {
  it('accepts a timestamp within the 5-minute window', () => {
    const now = 1_700_000_000_000;
    expect(isFreshTimestamp(Math.floor(now / 1000) - 60, now)).toBe(true);
  });

  it('rejects a timestamp older than 5 minutes (replay)', () => {
    const now = 1_700_000_000_000;
    expect(isFreshTimestamp(Math.floor(now / 1000) - 301, now)).toBe(false);
  });

  it('rejects a timestamp too far in the future too', () => {
    const now = 1_700_000_000_000;
    expect(isFreshTimestamp(Math.floor(now / 1000) + 301, now)).toBe(false);
  });
});

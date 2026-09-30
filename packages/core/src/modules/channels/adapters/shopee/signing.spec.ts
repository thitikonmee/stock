import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSign, publicSignParts, shopSignParts, verifyWebhookSignature } from './signing';

describe('buildSign', () => {
  it('matches a manually computed HMAC-SHA256 hex digest', () => {
    const expected = createHmac('sha256', 'thekey').update('hello', 'utf8').digest('hex');
    expect(buildSign('thekey', 'hello')).toBe(expected);
  });

  it('is deterministic for the same inputs', () => {
    expect(buildSign('k', 'a')).toBe(buildSign('k', 'a'));
  });

  it('changes when any input changes', () => {
    const base = buildSign('k', 'a');
    expect(buildSign('k2', 'a')).not.toBe(base);
    expect(buildSign('k', 'b')).not.toBe(base);
  });
});

describe('publicSignParts / shopSignParts', () => {
  it('builds the public-call string as partner_id + path + timestamp', () => {
    expect(publicSignParts('123', '/api/v2/auth/token/get', 1700000000)).toBe(
      '123/api/v2/auth/token/get1700000000',
    );
  });

  it('builds the shop-call string with access_token + shop_id appended', () => {
    expect(shopSignParts('123', '/api/v2/product/get_item_list', 1700000000, 'tok', '999')).toBe(
      '123/api/v2/product/get_item_list1700000000tok999',
    );
  });
});

describe('verifyWebhookSignature', () => {
  const key = 'partner_key_123';
  const url = 'https://api.example.com/api/v1/webhooks/shopee';
  const body = '{"shop_id":1,"code":1}';

  it('accepts a correctly computed signature', () => {
    const sig = createHmac('sha256', key).update(`${url}|${body}`, 'utf8').digest('hex');
    expect(verifyWebhookSignature(key, url, body, sig)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyWebhookSignature(key, url, body, 'deadbeef')).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyWebhookSignature(key, url, body, undefined)).toBe(false);
  });

  it('rejects a signature computed with the wrong key', () => {
    const sig = createHmac('sha256', 'other_key').update(`${url}|${body}`, 'utf8').digest('hex');
    expect(verifyWebhookSignature(key, url, body, sig)).toBe(false);
  });

  it('rejects a signature computed over a different body (tamper detection)', () => {
    const sig = createHmac('sha256', key).update(`${url}|${body}`, 'utf8').digest('hex');
    expect(verifyWebhookSignature(key, url, '{"shop_id":1,"code":2}', sig)).toBe(false);
  });

  it('rejects non-hex garbage without throwing', () => {
    expect(verifyWebhookSignature(key, url, body, 'not-hex-!!')).toBe(false);
  });
});

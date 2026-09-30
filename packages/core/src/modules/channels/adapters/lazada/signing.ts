import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `sign = HMAC-SHA256(app_secret, api_path + k1 + v1 + k2 + v2 ...)` uppercase hex, params sorted
 * by key with `sign` excluded (docs/06-channel-integrations.md §18 Signing). Unlike Shopee's
 * position-fixed string, Lazada's covers every request param — including `access_token` when
 * present — so the caller builds the full param map (system params + business params) first and
 * hands the whole thing here, rather than this function special-casing "shop-level vs public".
 */
export function buildSign(
  appSecret: string,
  apiPath: string,
  params: Readonly<Record<string, string>>,
): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort();
  const base = apiPath + sorted.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex').toUpperCase();
}

/** Lazada Push webhook: `Authorization` header == HMAC-SHA256(app_secret, app_key + raw_body) hex
 *  (docs §18 Webhook — "ยืนยันกับ docs", the same caveat every platform's signature carries).
 *  Uppercase per Lazada's own convention, constant-time compare either way. */
export function verifyWebhookSignature(
  appSecret: string,
  appKey: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', appSecret)
    .update(appKey + rawBody, 'utf8')
    .digest('hex')
    .toUpperCase();
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader.trim().toUpperCase(), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

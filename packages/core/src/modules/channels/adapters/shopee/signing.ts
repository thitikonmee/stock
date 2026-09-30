import { createHmac, timingSafeEqual } from 'node:crypto';

/** `sign = HMAC-SHA256(partner_key, ...)` hex (docs/06-channel-integrations.md §17 Request signing). */
export function buildSign(partnerKey: string, parts: string): string {
  return createHmac('sha256', partnerKey).update(parts, 'utf8').digest('hex');
}

/** Public-level call (no shop yet): `partner_id + api_path + timestamp`. */
export function publicSignParts(partnerId: string, apiPath: string, timestamp: number): string {
  return `${partnerId}${apiPath}${timestamp}`;
}

/** Shop-level call: `partner_id + api_path + timestamp + access_token + shop_id`. */
export function shopSignParts(
  partnerId: string,
  apiPath: string,
  timestamp: number,
  accessToken: string,
  shopId: string,
): string {
  return `${partnerId}${apiPath}${timestamp}${accessToken}${shopId}`;
}

/** Webhook push signature: `HMAC-SHA256(partner_key, "{full_url}|{raw_body}")`, constant-time compare. */
export function verifyWebhookSignature(
  partnerKey: string,
  fullUrl: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = buildSign(partnerKey, `${fullUrl}|${rawBody}`);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader.trim(), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

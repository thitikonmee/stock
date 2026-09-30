import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `sign = HMAC-SHA256(app_secret, app_secret + path + concat(sorted params, excluding sign/
 * access_token, as key+value) + body(if present, non-multipart) + app_secret)` hex (docs/06-
 * channel-integrations.md §19 Signing). Unlike Lazada's sign-covers-everything-in-the-querystring
 * approach, TikTok additionally sandwiches the secret itself around the base string and folds a
 * JSON request body into the signed material when the call has one (search/update endpoints).
 */
export function buildSign(
  appSecret: string,
  path: string,
  params: Readonly<Record<string, string>>,
  body?: string,
): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  const base = appSecret + path + sorted.map((k) => `${k}${params[k]}`).join('') + (body ?? '') + appSecret;
  return createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

/** TikTok Shop webhook push: `Authorization` header == HMAC-SHA256(app_secret, app_key + raw_body)
 *  hex, constant-time compare (docs §19 Webhook) — the same shape as Lazada's, minus the uppercase
 *  convention. */
export function verifyWebhookSignature(
  appSecret: string,
  appKey: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', appSecret)
    .update(appKey + rawBody, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader.trim(), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** docs §19 Webhook: "reject ถ้า timestamp เก่ากว่า 5 นาที (replay)" — a genuinely-signed payload
 *  whose own `timestamp` is stale is still a replay risk (a signed push captured and resent later),
 *  so freshness is its own check alongside the signature, not folded into it. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function isFreshTimestamp(unixSeconds: number, now = Date.now()): boolean {
  return Math.abs(now - unixSeconds * 1000) <= REPLAY_WINDOW_MS;
}

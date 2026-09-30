import { ChannelError } from '../../domain/channel-adapter';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** TikTok Shop's own envelope: success and failure both come back HTTP 200, distinguished only by
 *  `code` (0 = success) — the same "200 + error code" convention Lazada uses. docs/06 §19's own
 *  caveat ("ยืนยันกับ official docs") applies especially hard here: exact numeric error codes vary
 *  by API version, so this classifies by keyword in `message` instead of hardcoding a numeric-code
 *  set that could easily be stale by the time a real Partner Center app is wired up. */
export interface TikTokEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: unknown;
}

export function toChannelError(status: number, envelope: TikTokEnvelope): ChannelError | null {
  const code = envelope.code;
  if (code === undefined || code === 0) return null;
  const codeStr = String(code);
  const message = (envelope.message ?? '').toLowerCase();
  if (message.includes('too many request') || message.includes('rate limit'))
    return new ChannelError('RATE_LIMITED', envelope.message ?? codeStr, 1000, codeStr);
  if (message.includes('access token') && message.includes('expired'))
    return new ChannelError('AUTH_EXPIRED', envelope.message ?? codeStr, undefined, codeStr);
  if (message.includes('access token') && (message.includes('invalid') || message.includes('revoked')))
    return new ChannelError('AUTH_REVOKED', envelope.message ?? codeStr, undefined, codeStr);
  if (message.includes('not found'))
    return new ChannelError('NOT_FOUND', envelope.message ?? codeStr, undefined, codeStr);
  if (message.includes('param') || message.includes('invalid') || message.includes('missing'))
    return new ChannelError('VALIDATION', envelope.message ?? codeStr, undefined, codeStr);
  if (status >= 500) return new ChannelError('TRANSIENT', envelope.message ?? codeStr, undefined, codeStr);
  return new ChannelError('PERMANENT', envelope.message ?? codeStr, undefined, codeStr);
}

export async function callTikTok<T = unknown>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  } catch (err) {
    throw new ChannelError('UNKNOWN_OUTCOME', err instanceof Error ? err.message : 'network error');
  }
  let body: TikTokEnvelope & T;
  try {
    body = (await res.json()) as TikTokEnvelope & T;
  } catch {
    throw new ChannelError(
      res.status >= 500 ? 'TRANSIENT' : 'PERMANENT',
      `Non-JSON response (${res.status})`,
    );
  }
  const err = toChannelError(res.status, body);
  if (err) throw err;
  return body;
}

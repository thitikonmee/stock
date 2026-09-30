import { ChannelError } from '../../domain/channel-adapter';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Shopee returns HTTP 200 with `{error, message}` for most failures — never throws on transport. */
export interface ShopeeEnvelope {
  error?: string;
  message?: string;
  request_id?: string;
  response?: unknown;
}

const RATE_LIMIT_CODES = new Set(['error_too_many_request', 'error_rate_limit']);
const AUTH_EXPIRED_CODES = new Set(['error_auth', 'invalid_access_token', 'error_expired_access_token']);
const AUTH_REVOKED_CODES = new Set(['error_permission_denied', 'error_token_revoked']);

/** Maps a Shopee response envelope (or a transport failure) to the shared error taxonomy
 *  (docs/06-channel-integrations.md §"Error taxonomy → action"). */
export function toChannelError(status: number, body: ShopeeEnvelope): ChannelError | null {
  const code = body.error;
  if (!code) return null;
  if (RATE_LIMIT_CODES.has(code)) return new ChannelError('RATE_LIMITED', body.message ?? code, 1000, code);
  if (AUTH_EXPIRED_CODES.has(code))
    return new ChannelError('AUTH_EXPIRED', body.message ?? code, undefined, code);
  if (AUTH_REVOKED_CODES.has(code))
    return new ChannelError('AUTH_REVOKED', body.message ?? code, undefined, code);
  if (status >= 500) return new ChannelError('TRANSIENT', body.message ?? code, undefined, code);
  if (code === 'error_not_found') return new ChannelError('NOT_FOUND', body.message ?? code, undefined, code);
  if (code === 'error_param') return new ChannelError('VALIDATION', body.message ?? code, undefined, code);
  return new ChannelError('PERMANENT', body.message ?? code, undefined, code);
}

export async function callShopee<T = unknown>(
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
  let body: ShopeeEnvelope & T;
  try {
    body = (await res.json()) as ShopeeEnvelope & T;
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

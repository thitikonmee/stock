import { ChannelError } from '../../domain/channel-adapter';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Lazada's own envelope: success and failure both come back HTTP 200, distinguished only by
 *  `code` — "0" (or absent) means success (docs §18 "error response ของ Lazada มาใน HTTP 200 +
 *  code != 0"). A transport-level non-200 (gateway down, auth proxy reject) is handled separately. */
export interface LazadaEnvelope {
  code?: string;
  message?: string;
  type?: string;
  request_id?: string;
  data?: unknown;
}

const RATE_LIMIT_CODES = new Set(['ApiCallLimit', 'IspCallLimit', 'IspBlacklistLimit']);
const AUTH_EXPIRED_CODES = new Set(['IllegalAccessToken', 'AccessTokenExpired']);
const AUTH_REVOKED_CODES = new Set(['InvalidatedAccessToken', 'InvalidatedRefreshToken']);
const NOT_FOUND_CODES = new Set(['ItemNotFound', 'OrderNotFound', 'ProductNotFound']);
const VALIDATION_CODES = new Set(['IllegalParamSize', 'IllegalParamFormat', 'MissingParameter']);

export function toChannelError(envelope: LazadaEnvelope): ChannelError | null {
  const code = envelope.code;
  if (!code || code === '0') return null;
  if (RATE_LIMIT_CODES.has(code))
    return new ChannelError('RATE_LIMITED', envelope.message ?? code, 1000, code);
  if (AUTH_EXPIRED_CODES.has(code))
    return new ChannelError('AUTH_EXPIRED', envelope.message ?? code, undefined, code);
  if (AUTH_REVOKED_CODES.has(code))
    return new ChannelError('AUTH_REVOKED', envelope.message ?? code, undefined, code);
  if (NOT_FOUND_CODES.has(code))
    return new ChannelError('NOT_FOUND', envelope.message ?? code, undefined, code);
  if (VALIDATION_CODES.has(code))
    return new ChannelError('VALIDATION', envelope.message ?? code, undefined, code);
  if (code.startsWith('Internal') || code.startsWith('5')) {
    return new ChannelError('TRANSIENT', envelope.message ?? code, undefined, code);
  }
  return new ChannelError('PERMANENT', envelope.message ?? code, undefined, code);
}

export async function callLazada<T = unknown>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch (err) {
    throw new ChannelError('UNKNOWN_OUTCOME', err instanceof Error ? err.message : 'network error');
  }
  let body: LazadaEnvelope & T;
  try {
    body = (await res.json()) as LazadaEnvelope & T;
  } catch {
    throw new ChannelError(
      res.status >= 500 ? 'TRANSIENT' : 'PERMANENT',
      `Non-JSON response (${res.status})`,
    );
  }
  const err = toChannelError(body);
  if (err) throw err;
  return body;
}

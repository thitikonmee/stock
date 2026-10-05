import { UnauthenticatedError } from '@stockos/shared';

/** Google and Facebook use slightly different error envelopes on a non-2xx response — Google's
 *  token/userinfo endpoints return `{error, error_description}`, Facebook's Graph API returns
 *  `{error: {message, type, code}}`. This reads either, falling back to the HTTP status if the
 *  body isn't JSON or doesn't match. Every failure becomes `UnauthenticatedError`: from the
 *  caller's point of view a bad code, a revoked grant, and a provider outage are all "we could not
 *  verify this identity", not a validation problem on our side. */
export async function readOAuthJson<T>(res: Response, provider: string): Promise<T> {
  if (!res.ok) {
    let detail = `${provider} OAuth request failed (${res.status})`;
    try {
      const body = (await res.json()) as {
        error_description?: string;
        error?: string | { message?: string };
      };
      if (typeof body.error === 'string') detail = body.error_description ?? body.error;
      else if (body.error?.message) detail = body.error.message;
    } catch {
      // non-JSON error body — keep the generic status-based message
    }
    throw new UnauthenticatedError('OAUTH_FAILED', detail);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new UnauthenticatedError('OAUTH_FAILED', `${provider} returned a non-JSON response`);
  }
}

import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { passesCsrfCheck } from '@/lib/server/csrf';
import {
  COOKIES,
  apiBase,
  clearSessionCookies,
  forwardedHeaders,
  problem,
  refreshTokens,
  relay,
  setSessionCookies,
  type TokenPair,
} from '@/lib/server/session';

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * Authenticated pass-through to the API. Attaches the access token from its HttpOnly cookie and,
 * when it has expired, refreshes once using the refresh cookie and retries.
 */
async function handle(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!passesCsrfCheck(req)) return problem(403, 'CSRF_REJECTED', 'Request blocked');
  const { path } = await ctx.params;
  if (path.some((segment) => segment === '..' || segment === '.'))
    return problem(400, 'BAD_PATH', 'Invalid path');
  const target = `${apiBase()}/${path.map(encodeURIComponent).join('/')}${new URL(req.url).search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();

  const jar = await cookies();
  let access = jar.get(COOKIES.access)?.value;
  const refresh = jar.get(COOKIES.refresh)?.value;
  let refreshed: TokenPair | null = null;

  if (!access && refresh) {
    refreshed = await refreshTokens(refresh, req);
    access = refreshed?.accessToken;
  }
  const forward = (token: string | undefined) =>
    fetch(target, {
      method: req.method,
      headers: forwardedHeaders(req, token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && body !== '' ? { body } : {}),
      cache: 'no-store',
    });

  let res = await forward(access);
  if (res.status === 401 && refresh && !refreshed) {
    refreshed = await refreshTokens(refresh, req);
    if (refreshed) res = await forward(refreshed.accessToken);
  }

  const out = await relay(res);
  if (refreshed) setSessionCookies(out, refreshed);
  else if (res.status === 401) clearSessionCookies(out);
  return out;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { passesCsrfCheck } from '@/lib/server/csrf';
import {
  COOKIES,
  apiBase,
  clearSessionCookies,
  forwardedHeaders,
  isTokenPair,
  problem,
  relay,
  setMfaCookie,
  setSessionCookies,
} from '@/lib/server/session';

type Ctx = { params: Promise<{ action: string }> };

/** API endpoint and how its token response is turned into cookies, per session action. */
const ACTIONS: Record<string, { path: string; auth?: 'access' | 'mfa' | 'device' }> = {
  login: { path: '/auth/login' },
  signup: { path: '/auth/signup' },
  'accept-invite': { path: '/auth/invitations/accept' },
  mfa: { path: '/auth/mfa/verify', auth: 'mfa' },
  'step-up': { path: '/auth/step-up', auth: 'access' },
  logout: { path: '/auth/logout', auth: 'access' },
  // Cashier PIN login (docs/05-pos.md §15): the POS terminal holds its own device token (stored in
  // this browser, not a cookie — a device is not a person); the PIN response becomes a normal
  // session, so every other /pos/* call afterwards is just an ordinary authenticated request.
  'pos-login': { path: '/pos/sessions', auth: 'device' },
  'oauth-resolve': { path: '/auth/oauth/resolve' },
  'oauth-signup': { path: '/auth/oauth/signup' },
};

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!passesCsrfCheck(req)) return problem(403, 'CSRF_REJECTED', 'Request blocked');
  const { action } = await ctx.params;
  const spec = ACTIONS[action];
  if (!spec) return problem(404, 'NOT_FOUND', 'Unknown action');

  const jar = await cookies();
  let payload: Record<string, unknown> = {};
  const text = await req.text();
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return problem(400, 'VALIDATION_FAILED', 'Invalid JSON');
    }
  }
  const headers = forwardedHeaders(req, { 'content-type': 'application/json' });
  if (spec.auth === 'mfa') payload = { ...payload, mfaToken: jar.get(COOKIES.mfa)?.value ?? '' };
  if (spec.auth === 'access') {
    const access = jar.get(COOKIES.access)?.value;
    if (access) headers.authorization = `Bearer ${access}`;
  }
  if (spec.auth === 'device') {
    const { deviceToken, ...rest } = payload;
    if (typeof deviceToken !== 'string' || !deviceToken) {
      return problem(400, 'VALIDATION_FAILED', 'deviceToken is required');
    }
    headers.authorization = `Device ${deviceToken}`;
    payload = rest;
  }

  const res = await fetch(`${apiBase()}${spec.path}`, {
    method: 'POST',
    headers,
    body: action === 'logout' ? undefined : JSON.stringify(payload),
    cache: 'no-store',
  });

  if (action === 'logout') {
    const out = NextResponse.json({ status: 'signed-out' });
    clearSessionCookies(out);
    return out;
  }
  if (!res.ok) return relay(res);

  const body: unknown = await res.json();
  if (typeof body === 'object' && body !== null && (body as { mfaRequired?: boolean }).mfaRequired) {
    const out = NextResponse.json({ status: 'mfa-required' });
    setMfaCookie(out, String((body as { mfaToken: string }).mfaToken));
    return out;
  }
  // `oauth-resolve`'s one non-token, non-mfa shape: a verified identity with no existing account
  // yet. Not an error — relay it as-is so the login page can show the one-field "name your shop" step.
  if (typeof body === 'object' && body !== null && (body as { needsSignup?: boolean }).needsSignup) {
    return NextResponse.json(body);
  }
  if (!isTokenPair(body)) return problem(502, 'BAD_UPSTREAM', 'Unexpected response');
  const out = NextResponse.json({ status: 'signed-in' });
  setSessionCookies(out, body);
  return out;
}

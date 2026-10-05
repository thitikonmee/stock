import 'server-only';
import { NextResponse } from 'next/server';

/**
 * BFF session handling. The browser never sees tokens: they live in HttpOnly, SameSite=Strict
 * cookies and are attached server-side when proxying to the API.
 */
export const COOKIES = {
  access: 'so_at',
  refresh: 'so_rt',
  /** Short-lived MFA challenge between password and 2FA code. */
  mfa: 'so_mfa',
} as const;

const REFRESH_MAX_AGE_SEC = 30 * 24 * 3600;
const MFA_MAX_AGE_SEC = 5 * 60;

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function apiBase(): string {
  return `${(process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/v1`;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  };
}

export function isTokenPair(value: unknown): value is TokenPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TokenPair).accessToken === 'string' &&
    typeof (value as TokenPair).refreshToken === 'string'
  );
}

export function setSessionCookies(res: NextResponse, tokens: TokenPair): void {
  // Access cookie expires slightly before the token so the proxy refreshes proactively.
  res.cookies.set(COOKIES.access, tokens.accessToken, cookieOptions(Math.max(30, tokens.expiresIn - 30)));
  res.cookies.set(COOKIES.refresh, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE_SEC));
  res.cookies.delete(COOKIES.mfa);
}

export function setMfaCookie(res: NextResponse, mfaToken: string): void {
  res.cookies.set(COOKIES.mfa, mfaToken, cookieOptions(MFA_MAX_AGE_SEC));
}

export function clearSessionCookies(res: NextResponse): void {
  for (const name of Object.values(COOKIES)) res.cookies.delete(name);
}

/** Headers forwarded to the API: client IP (per-IP rate limits), request id, conditional updates. */
export function forwardedHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  for (const name of [
    'content-type',
    'if-match',
    'idempotency-key',
    'x-request-id',
    'user-agent',
    'x-file-name',
  ]) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }
  const forwardedFor = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return headers;
}

/** Copy an API response (status, body, safe headers) into a NextResponse. */
export async function relay(res: Response): Promise<NextResponse> {
  const headers = new Headers();
  for (const name of ['content-type', 'etag', 'retry-after', 'x-request-id']) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = res.status === 204 ? null : await res.arrayBuffer();
  return new NextResponse(body, { status: res.status, headers });
}

export async function refreshTokens(refreshToken: string, req: Request): Promise<TokenPair | null> {
  const res = await fetch(`${apiBase()}/auth/refresh`, {
    method: 'POST',
    headers: forwardedHeaders(req, { 'content-type': 'application/json' }),
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  return isTokenPair(body) ? body : null;
}

export function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: `https://docs.stockos.co/errors/${code.toLowerCase()}`, title: detail, status, code, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

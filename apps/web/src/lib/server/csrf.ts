/**
 * CSRF defence for cookie-authenticated BFF routes (on top of SameSite=Strict cookies):
 * state-changing requests must carry `x-stockos-csrf: 1` — a custom header that cross-site forms
 * cannot send and cross-site fetch cannot send without a CORS preflight we never approve — and,
 * when the browser sends an Origin, it must be our own host.
 */
export const CSRF_HEADER = 'x-stockos-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function passesCsrfCheck(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  if (req.headers.get(CSRF_HEADER) !== '1') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true; // same-origin requests from some browsers omit Origin; the header check stands
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

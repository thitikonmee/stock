'use client';

/** Problem details returned by the API (RFC 9457) plus our extensions. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(detail || code);
  }
}

type Json = Record<string, unknown> | unknown[];

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Json;
  headers?: Record<string, string>;
}

/** Hook set by <StepUpProvider>: asks the user for a 2FA code, resolves true when re-verified. */
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function registerStepUpHandler(handler: (() => Promise<boolean>) | null) {
  stepUpHandler = handler;
}

export async function send(url: string, options: RequestOptions): Promise<Response> {
  return fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'x-stockos-csrf': '1',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    credentials: 'same-origin',
    cache: 'no-store',
  });
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const p = (await res.json()) as {
      code?: string;
      detail?: string;
      title?: string;
      meta?: Record<string, unknown>;
    };
    return new ApiError(res.status, p.code ?? 'ERROR', p.detail ?? p.title ?? '', p.meta ?? {});
  } catch {
    return new ApiError(res.status, 'ERROR', res.statusText);
  }
}

/**
 * Call the API through the BFF proxy. Handles the cross-cutting flows once:
 * 401 → back to login; MFA enrolment required → security page; step-up → ask for code and retry.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(`/api/proxy${path}`, options);
  if (!res.ok) {
    const err = await toError(res);
    if (err.code === 'STEP_UP_REQUIRED' && stepUpHandler && (await stepUpHandler())) {
      res = await send(`/api/proxy${path}`, options);
      if (!res.ok) throw await toError(res);
    } else {
      if (res.status === 401 && typeof window !== 'undefined') {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      }
      if (
        err.code === 'MFA_ENROLLMENT_REQUIRED' &&
        typeof window !== 'undefined' &&
        !window.location.pathname.startsWith('/settings/security')
      ) {
        window.location.assign('/settings/security?required=1');
      }
      throw err;
    }
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Upload a raw binary body (e.g. an .xlsx catalog import) and parse the JSON response. */
export async function apiUpload<T>(path: string, data: ArrayBuffer): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    method: 'POST',
    headers: { 'x-stockos-csrf': '1', 'content-type': 'application/octet-stream' },
    body: data,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Fetch a binary response (PDF label sheet, xlsx export) and save it via the browser. */
export async function apiDownload(
  path: string,
  filename: string,
  options: RequestOptions = {},
): Promise<void> {
  const res = await send(`/api/proxy${path}`, options);
  if (!res.ok) throw await toError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Session actions (login, signup, mfa, step-up, logout, accept-invite, oauth-*) handled by the
 *  BFF. Generic because one action — `oauth-resolve` — can also come back as a `needsSignup` shape
 *  instead of the usual `{status}`; every other call site keeps the old default unchanged. */
export async function session<T = { status: string }>(action: string, body?: Json): Promise<T> {
  const res = await send(`/api/session/${action}`, { method: 'POST', ...(body ? { body } : {}) });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

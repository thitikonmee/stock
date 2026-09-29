'use client';

import { ApiError, send, session } from './api';

/**
 * Same BFF proxy as `api()`, but without its "401 → redirect to /login" behaviour: a POS terminal
 * that loses its session should fall back to the PIN pad, not the back-office login screen.
 */
export async function posApi<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown> | unknown[];
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const res = await send(`/api/proxy${path}`, options);
  if (!res.ok) {
    try {
      const p = (await res.json()) as {
        code?: string;
        detail?: string;
        title?: string;
        meta?: Record<string, unknown>;
      };
      throw new ApiError(res.status, p.code ?? 'ERROR', p.detail ?? p.title ?? '', p.meta ?? {});
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(res.status, 'ERROR', res.statusText);
    }
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface StoredDevice {
  deviceToken: string;
  deviceId: string;
  branchId: string;
  warehouseId: string;
  tenantSlug: string;
}

const STORAGE_KEY = 'stockos.pos.device';

export function loadDevice(): StoredDevice | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredDevice) : null;
  } catch {
    return null;
  }
}

export function saveDevice(device: StoredDevice): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
}

export function forgetDevice(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/** Cashier PIN login — sets the same session cookies as the back-office login (docs/05-pos.md §15). */
export async function posLogin(deviceToken: string, employeeCode: string, pin: string): Promise<void> {
  await session('pos-login', { deviceToken, employeeCode, pin });
}

export async function posLogout(): Promise<void> {
  await session('logout');
}

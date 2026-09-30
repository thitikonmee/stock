import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { createApp } from '@stockos/api/app';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '@stockos/api/auth/rate-limit.guard';
import type { auth, channels, notifications } from '@stockos/core';
import { createLogger, uuidv7 } from '@stockos/shared';
import { testAuthConfig } from './auth-config';
import type { TestDatabase } from './test-db';

export type Api = NestFastifyApplication;

/** Tests share one client IP, so rate limits are effectively off unless a test sets them. */
const NO_RATE_LIMITS: RateLimits = Object.fromEntries(
  Object.keys(DEFAULT_RATE_LIMITS).map((k) => [k, { limit: 1_000_000, windowSec: 60 }]),
) as RateLimits;

export async function createTestApi(
  db: TestDatabase,
  authOverrides: Partial<auth.AuthConfig> = {},
  appOverrides: {
    rateLimits?: Partial<RateLimits>;
    mailer?: notifications.EmailSender;
    shopee?: channels.ShopeeConfig;
    lazada?: channels.LazadaConfig;
  } = {},
): Promise<Api> {
  return createApp({
    db: db.app,
    platformDb: db.platform,
    logger: createLogger('test', 'error'),
    auth: testAuthConfig(authOverrides),
    rateLimits: { ...NO_RATE_LIMITS, ...appOverrides.rateLimits },
    ...(appOverrides.mailer ? { mailer: appOverrides.mailer } : {}),
    ...(appOverrides.shopee ? { shopee: appOverrides.shopee } : {}),
    ...(appOverrides.lazada ? { lazada: appOverrides.lazada } : {}),
    webBaseUrl: 'https://app.stockos.test',
    apiBaseUrl: 'https://api.stockos.test',
    // Product images: a throwaway temp dir per test file, never the repo's own .uploads/.
    storage: { localDir: mkdtempSync(join(tmpdir(), 'stockos-uploads-')) },
  });
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface Call {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test convenience
  headers: Record<string, unknown>;
}

export async function call(
  api: Api,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Call> {
  const res = await api.inject({
    method,
    url,
    headers: { ...(options.token ? bearer(options.token) : {}), ...options.headers },
    ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
}

export interface BinaryCall {
  status: number;
  body: Buffer;
  headers: Record<string, unknown>;
}

/**
 * Like `call`, but for binary responses (PDF, xlsx, images) — never runs `res.json()` on the way
 * out. `body` may be a JSON-able object (auto-encoded, like `call`) or a raw `Buffer` (sent as-is).
 */
export async function callBinary(
  api: Api,
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<BinaryCall> {
  const res = await api.inject({
    method,
    url,
    headers: { ...(options.token ? bearer(options.token) : {}), ...options.headers },
    ...(options.body !== undefined ? { payload: options.body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.rawPayload, headers: res.headers };
}

export interface SignedUpTenant {
  tenantId: string;
  userId: string;
  slug: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function signup(api: Api, name = 'Shop'): Promise<SignedUpTenant> {
  const suffix = uuidv7().slice(-10);
  const input = {
    companyName: `${name} ${suffix}`,
    slug: `shop-${suffix}`,
    ownerName: 'Owner',
    email: `owner-${suffix}@example.com`,
    password: 'correct horse battery',
  };
  const res = await call(api, 'POST', '/api/v1/auth/signup', { body: input });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    tenantId: res.body.tenantId,
    userId: res.body.userId,
    slug: input.slug,
    email: input.email,
    password: input.password,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
  };
}

/** Invite someone with the given roles and accept as a new user. Returns their tokens. */
export async function addMember(
  api: Api,
  owner: SignedUpTenant,
  roles: { roleCode: string; scopeType?: 'TENANT' | 'BRANCH' | 'WAREHOUSE'; scopeId?: string | null }[],
) {
  const allRoles = (await call(api, 'GET', '/api/v1/roles', { token: owner.accessToken })).body as {
    id: string;
    code: string;
  }[];
  const email = `member-${uuidv7().slice(-10)}@example.com`;
  const invite = await call(api, 'POST', '/api/v1/users/invitations', {
    token: owner.accessToken,
    body: {
      email,
      roles: roles.map((r) => ({
        roleId: allRoles.find((x) => x.code === r.roleCode)!.id,
        scopeType: r.scopeType ?? 'TENANT',
        scopeId: r.scopeId ?? null,
      })),
    },
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const accepted = await call(api, 'POST', '/api/v1/auth/invitations/accept', {
    body: { token: invite.body.token, password: 'member password 1', displayName: 'Member' },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const me = await call(api, 'GET', '/api/v1/me', { token: accepted.body.accessToken });
  return {
    email,
    password: 'member password 1',
    accessToken: accepted.body.accessToken as string,
    refreshToken: accepted.body.refreshToken as string,
    membershipId: me.body.membershipId as string,
  };
}

export interface RegisteredDevice {
  id: string;
  code: string;
  deviceToken: string;
  branchId: string;
  warehouseId: string;
}

/** Create and register a POS device, returning a ready-to-use device token. */
export async function registerDevice(
  api: Api,
  owner: SignedUpTenant,
  opts: { branchId: string; warehouseId: string; code?: string },
): Promise<RegisteredDevice> {
  const code = opts.code ?? `D${uuidv7().slice(-8).toUpperCase()}`;
  const created = await call(api, 'POST', '/api/v1/pos-devices', {
    token: owner.accessToken,
    body: { code, name: code, branchId: opts.branchId, warehouseId: opts.warehouseId },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const registered = await call(api, 'POST', '/api/v1/pos/devices/register', {
    body: { tenantSlug: owner.slug, registrationCode: created.body.registrationCode, platform: 'WEB' },
  });
  expect(registered.status, JSON.stringify(registered.body)).toBe(200);
  return {
    id: created.body.id as string,
    code,
    deviceToken: registered.body.deviceToken as string,
    branchId: opts.branchId,
    warehouseId: opts.warehouseId,
  };
}

/** Set a member's employee code + PIN, the two things cashier PIN login needs. */
export async function setUpCashier(
  api: Api,
  owner: SignedUpTenant,
  membershipId: string,
  memberAccessToken: string,
  opts: { employeeCode?: string; pin?: string } = {},
): Promise<{ employeeCode: string; pin: string }> {
  const employeeCode = opts.employeeCode ?? `E${uuidv7().slice(-8).toUpperCase()}`;
  const pin = opts.pin ?? '1234';
  const coded = await call(api, 'PUT', `/api/v1/users/${membershipId}/employee-code`, {
    token: owner.accessToken,
    body: { employeeCode },
  });
  expect(coded.status, JSON.stringify(coded.body)).toBe(200);
  const pinned = await call(api, 'POST', '/api/v1/me/pos-pin', {
    token: memberAccessToken,
    body: { pin },
  });
  expect(pinned.status, JSON.stringify(pinned.body)).toBe(204);
  return { employeeCode, pin };
}

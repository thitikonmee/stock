import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { createApp } from '@stockos/api/app';
import type { auth } from '@stockos/core';
import { createLogger, uuidv7 } from '@stockos/shared';
import { testAuthConfig } from './auth-config';
import type { TestDatabase } from './test-db';

export type Api = NestFastifyApplication;

export async function createTestApi(
  db: TestDatabase,
  authOverrides: Partial<auth.AuthConfig> = {},
): Promise<Api> {
  return createApp({
    db: db.app,
    logger: createLogger('test', 'error'),
    auth: testAuthConfig(authOverrides),
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

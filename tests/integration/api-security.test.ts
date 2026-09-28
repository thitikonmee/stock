import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@stockos/core';
import { platformTx, tenantTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

/** Enrol TOTP for the signed-in user; returns a code generator for later steps. */
async function enrolMfa(app: Api, accessToken: string) {
  const setup = await call(app, 'POST', '/api/v1/auth/mfa/setup', { token: accessToken });
  expect(setup.status).toBe(200);
  const secret = auth.base32Decode(setup.body.secret);
  let step = auth.currentStep();
  const confirm = await call(app, 'POST', '/api/v1/auth/mfa/confirm', {
    token: accessToken,
    body: { code: auth.totpAt(secret, step) },
  });
  expect(confirm.status).toBe(204);
  // Each code can be used once; the next one comes from the following (still accepted) step.
  return () => auth.totpAt(secret, ++step);
}

const endGracePeriod = (tenantId: string) =>
  platformTx(db.platform, (tx) =>
    sql`update tenants set mfa_enforced_from = now() - interval '1 minute' where id = ${tenantId}`.execute(
      tx,
    ),
  );

describe('rate limiting', () => {
  it('limits login attempts per client IP and says when to retry', async () => {
    const limited = await createTestApi(db, {}, { rateLimits: { login: { limit: 3, windowSec: 60 } } });
    try {
      const attempt = (ip: string) =>
        limited.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          remoteAddress: ip,
          payload: { identifier: 'someone@example.com', password: 'wrong password here' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt('203.0.113.7')).statusCode).toBe(401);
      const blocked = await attempt('203.0.113.7');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // Another client is unaffected.
      expect((await attempt('203.0.113.8')).statusCode).toBe(401);

      // A public client cannot dodge the limit by forging X-Forwarded-For ...
      const forged = await limited.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': '198.51.100.99' },
        payload: { identifier: 'someone@example.com', password: 'wrong password here' },
      });
      expect(forged.statusCode).toBe(429);
      // ... while a trusted private hop (ALB / web BFF) passes the real client IP through.
      const viaProxy = await limited.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.0.3.4',
        headers: { 'x-forwarded-for': '203.0.113.7' },
        payload: { identifier: 'someone@example.com', password: 'wrong password here' },
      });
      expect(viaProxy.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('mandatory 2FA and step-up', () => {
  it('lets members use the product during the grace period, then requires enrolment', async () => {
    const t = await signup(api);
    expect((await call(api, 'GET', '/api/v1/users', { token: t.accessToken })).status).toBe(200);

    await endGracePeriod(t.tenantId);
    const blocked = await call(api, 'GET', '/api/v1/users', { token: t.accessToken });
    expect(blocked).toMatchObject({ status: 403, body: { code: 'MFA_ENROLLMENT_REQUIRED' } });
    const me = await call(api, 'GET', '/api/v1/me', { token: t.accessToken });
    expect(me).toMatchObject({ status: 200, body: { mfaEnrollmentRequired: true } });

    await enrolMfa(api, t.accessToken); // setup/confirm stay reachable
    expect((await call(api, 'GET', '/api/v1/users', { token: t.accessToken })).status).toBe(200);
  });

  it('does not force 2FA on members without dangerous permissions', async () => {
    const t = await signup(api);
    const cashier = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    await endGracePeriod(t.tenantId);
    expect((await call(api, 'GET', '/api/v1/branches', { token: cashier.accessToken })).status).toBe(200);
  });

  it('requires a recent 2FA proof for dangerous actions once 2FA is on', async () => {
    const t = await signup(api);
    const nextCode = await enrolMfa(api, t.accessToken);
    const roles = (await call(api, 'GET', '/api/v1/roles', { token: t.accessToken })).body;
    const invite = (token: string, email: string) =>
      call(api, 'POST', '/api/v1/users/invitations', {
        token,
        body: { email, roles: [{ roleId: roles.find((r: { code: string }) => r.code === 'VIEWER').id }] },
      });

    // Password-only session: reading is fine, inviting (user.manage is dangerous) needs step-up.
    expect((await call(api, 'GET', '/api/v1/users', { token: t.accessToken })).status).toBe(200);
    expect(await invite(t.accessToken, 'a@example.com')).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });

    expect(
      (await call(api, 'POST', '/api/v1/auth/step-up', { token: t.accessToken, body: { code: '000000' } }))
        .status,
    ).toBe(401);
    const stepped = await call(api, 'POST', '/api/v1/auth/step-up', {
      token: t.accessToken,
      body: { code: nextCode() },
    });
    expect(stepped.status).toBe(200);
    expect((await invite(stepped.body.accessToken, 'a@example.com')).status).toBe(201);
  });

  it('expires the step-up proof', async () => {
    const shortApi = await createTestApi(db, { stepUpMaxAgeSec: 1 });
    try {
      const t = await signup(shortApi);
      const nextCode = await enrolMfa(shortApi, t.accessToken);
      const stepped = await call(shortApi, 'POST', '/api/v1/auth/step-up', {
        token: t.accessToken,
        body: { code: nextCode() },
      });
      await new Promise((r) => setTimeout(r, 2100));
      const res = await call(shortApi, 'POST', '/api/v1/roles', {
        token: stepped.body.accessToken,
        body: { code: 'LATE', name: 'Late', permissions: ['product.read'] },
      });
      expect(res).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    } finally {
      await shortApi.close();
    }
  });
});

describe('API keys', () => {
  let t: SignedUpTenant;
  beforeAll(async () => {
    t = await signup(api);
  });

  const createKey = (body: Record<string, unknown>) =>
    call(api, 'POST', '/api/v1/api-keys', { token: t.accessToken, body });

  it('shows the secret once and authenticates with narrowed permissions', async () => {
    const created = await createKey({ name: 'ERP sync', permissions: ['product.read', 'inventory.read'] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^sk_live_[0-9a-f]{12}_/);

    const listed = await call(api, 'GET', '/api/v1/api-keys', { token: t.accessToken });
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    expect(listed.body[0]).toMatchObject({ name: 'ERP sync', prefix: created.body.prefix });

    const me = await call(api, 'GET', '/api/v1/me', { token: created.body.secret });
    expect(me.body.authType).toBe('API_KEY');
    expect(new Set(me.body.grants.map((g: { permission: string }) => g.permission))).toEqual(
      new Set(['product.read', 'inventory.read']),
    );
    expect((await call(api, 'GET', '/api/v1/branches', { token: created.body.secret })).status).toBe(200);
    expect((await call(api, 'GET', '/api/v1/users', { token: created.body.secret })).status).toBe(403);

    // A tampered secret with a valid prefix is rejected.
    expect(
      (await call(api, 'GET', '/api/v1/me', { token: `${created.body.secret.slice(0, -2)}xx` })).status,
    ).toBe(401);
  });

  it('never carries dangerous permissions', async () => {
    const res = await createKey({ name: 'too powerful', permissions: ['user.manage'] });
    expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
  });

  it('enforces the IP allowlist', async () => {
    const key = await createKey({
      name: 'office only',
      permissions: ['product.read'],
      ipAllowlist: ['10.0.0.0/8'],
    });
    const outside = await api.inject({
      method: 'GET',
      url: '/api/v1/me',
      remoteAddress: '203.0.113.9',
      headers: { authorization: `Bearer ${key.body.secret}` },
    });
    expect(outside.statusCode).toBe(403);
    const inside = await api.inject({
      method: 'GET',
      url: '/api/v1/me',
      remoteAddress: '10.1.2.3',
      headers: { authorization: `Bearer ${key.body.secret}` },
    });
    expect(inside.statusCode).toBe(200);
    expect(
      (await createKey({ name: 'bad', permissions: ['product.read'], ipAllowlist: ['not-an-ip'] })).status,
    ).toBe(400);
  });

  it('stops working when revoked or when its creator is suspended', async () => {
    const key = await createKey({ name: 'temp', permissions: ['product.read'] });
    expect(
      (await call(api, 'DELETE', `/api/v1/api-keys/${key.body.id}`, { token: t.accessToken })).status,
    ).toBe(204);
    expect((await call(api, 'GET', '/api/v1/me', { token: key.body.secret })).status).toBe(401);

    const admin = await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    const adminKey = await call(api, 'POST', '/api/v1/api-keys', {
      token: admin.accessToken,
      body: { name: 'admin key', permissions: ['product.read'] },
    });
    expect((await call(api, 'GET', '/api/v1/me', { token: adminKey.body.secret })).status).toBe(200);
    await tenantTx(db.app, t.tenantId, (tx) =>
      sql`update tenant_memberships set status = 'SUSPENDED' where id = ${admin.membershipId}`.execute(tx),
    );
    expect((await call(api, 'GET', '/api/v1/me', { token: adminKey.body.secret })).status).toBe(401);
  });

  it('cannot manage API keys with an API key', async () => {
    const key = await createKey({ name: 'k', permissions: ['product.read'] });
    expect((await call(api, 'GET', '/api/v1/api-keys', { token: key.body.secret })).status).toBe(403);
  });
});

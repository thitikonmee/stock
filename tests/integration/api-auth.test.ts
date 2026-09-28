import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@stockos/core';
import { platformTx, tenantTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api } from '../support/api';
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

const login = (body: Record<string, unknown>) => call(api, 'POST', '/api/v1/auth/login', { body });

describe('signup', () => {
  it('creates the company, owner, system roles, head office and main warehouse', async () => {
    const t = await signup(api);
    const me = await call(api, 'GET', '/api/v1/me', { token: t.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ isOwner: true, tenant: { id: t.tenantId, slug: t.slug } });
    expect(me.body.grants.map((g: { permission: string }) => g.permission)).toContain('billing.manage');

    const branches = await call(api, 'GET', '/api/v1/branches', { token: t.accessToken });
    const warehouses = await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken });
    expect(branches.body).toMatchObject([{ code: 'HQ', taxBranchNo: '00000' }]);
    expect(warehouses.body).toMatchObject([{ code: 'MAIN', type: 'CENTRAL', branchId: branches.body[0].id }]);

    const roles = await call(api, 'GET', '/api/v1/roles', { token: t.accessToken });
    expect(roles.body.map((r: { code: string }) => r.code).sort()).toEqual([
      'ACCOUNTANT',
      'ADMIN',
      'CASHIER',
      'MANAGER',
      'MARKETING',
      'OWNER',
      'PURCHASING',
      'VIEWER',
      'WAREHOUSE_STAFF',
    ]);

    const audit = await tenantTx(db.app, t.tenantId, (tx) =>
      sql<{
        action: string;
        actor_id: string;
      }>`select action, actor_id from audit_logs where action = 'tenant.signup'`.execute(tx),
    );
    expect(audit.rows).toEqual([{ action: 'tenant.signup', actor_id: t.userId }]);
  });

  it('rejects a taken shop URL or e-mail with 409', async () => {
    const t = await signup(api);
    const dupSlug = await call(api, 'POST', '/api/v1/auth/signup', {
      body: {
        companyName: 'XX',
        slug: t.slug,
        ownerName: 'X',
        email: 'new-x@example.com',
        password: 'correct horse battery',
      },
    });
    expect(dupSlug).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });
    const dupEmail = await call(api, 'POST', '/api/v1/auth/signup', {
      body: {
        companyName: 'YY',
        slug: 'unique-y-shop',
        ownerName: 'Y',
        email: t.email,
        password: 'correct horse battery',
      },
    });
    expect(dupEmail).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });
  });

  it('validates input strictly', async () => {
    const res = await call(api, 'POST', '/api/v1/auth/signup', {
      body: {
        companyName: 'X',
        slug: 'Bad Slug!',
        ownerName: 'X',
        email: 'a@b.co',
        password: 'correct horse battery',
        isOwner: true,
      },
    });
    expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
  });
});

describe('login and lockout', () => {
  it('signs in with e-mail + password and rejects wrong passwords generically', async () => {
    const t = await signup(api);
    const ok = await login({ identifier: t.email.toUpperCase(), password: t.password });
    expect(ok).toMatchObject({ status: 200, body: { mfaRequired: false, tokenType: 'Bearer' } });

    const wrong = await login({ identifier: t.email, password: 'wrong password here' });
    const unknown = await login({ identifier: 'nobody@example.com', password: 'wrong password here' });
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.detail).toBe(unknown.body.detail); // no user enumeration
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    const t = await signup(api);
    for (let i = 0; i < 5; i++) await login({ identifier: t.email, password: 'wrong password here' });
    const locked = await login({ identifier: t.email, password: t.password });
    expect(locked).toMatchObject({ status: 401, body: { code: 'ACCOUNT_LOCKED' } });

    // Once the lock expires, one more mistake does not re-lock immediately.
    await platformTx(db.app, (tx) =>
      sql`update users set locked_until = now() - interval '1 second' where email = ${t.email}`.execute(tx),
    );
    expect((await login({ identifier: t.email, password: 'wrong password here' })).body.code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect((await login({ identifier: t.email, password: t.password })).status).toBe(200);
  });

  it('asks which company when a user belongs to several', async () => {
    const a = await signup(api, 'A');
    const b = await signup(api, 'B');
    const member = await addMember(api, a, [{ roleCode: 'VIEWER' }]);
    // Same person joins B with their existing password.
    const roles = await call(api, 'GET', '/api/v1/roles', { token: b.accessToken });
    const invite = await call(api, 'POST', '/api/v1/users/invitations', {
      token: b.accessToken,
      body: {
        email: member.email,
        roles: [{ roleId: roles.body.find((r: { code: string }) => r.code === 'VIEWER').id }],
      },
    });
    const joined = await call(api, 'POST', '/api/v1/auth/invitations/accept', {
      body: { token: invite.body.token, password: member.password },
    });
    expect(joined.status).toBe(200);

    const ambiguous = await login({ identifier: member.email, password: member.password });
    expect(ambiguous).toMatchObject({ status: 422, body: { code: 'TENANT_SELECTION_REQUIRED' } });
    expect(ambiguous.body.meta.tenants.map((x: { slug: string }) => x.slug).sort()).toEqual(
      [a.slug, b.slug].sort(),
    );

    const chosen = await login({ identifier: member.email, password: member.password, tenantSlug: b.slug });
    const me = await call(api, 'GET', '/api/v1/me', { token: chosen.body.accessToken });
    expect(me.body.tenant.id).toBe(b.tenantId);
  });
});

describe('refresh tokens', () => {
  it('rotates, and treats reuse after the grace window as theft (revokes the family)', async () => {
    const strict = await createTestApi(db, { refreshReuseGraceSec: 0 });
    try {
      const t = await signup(strict);
      const first = await call(strict, 'POST', '/api/v1/auth/refresh', {
        body: { refreshToken: t.refreshToken },
      });
      expect(first.status).toBe(200);
      expect(first.body.refreshToken).not.toBe(t.refreshToken);

      await new Promise((r) => setTimeout(r, 20));
      const replay = await call(strict, 'POST', '/api/v1/auth/refresh', {
        body: { refreshToken: t.refreshToken },
      });
      expect(replay).toMatchObject({ status: 401, body: { code: 'TOKEN_REUSED' } });

      // The attacker's replay killed the legitimate chain too.
      const legit = await call(strict, 'POST', '/api/v1/auth/refresh', {
        body: { refreshToken: first.body.refreshToken },
      });
      expect(legit.status).toBe(401);
      expect((await call(strict, 'GET', '/api/v1/me', { token: first.body.accessToken })).status).toBe(401);
    } finally {
      await strict.close();
    }
  });

  it('tolerates a double refresh from the same client within the grace window', async () => {
    const t = await signup(api);
    const first = await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: t.refreshToken } });
    const race = await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: t.refreshToken } });
    expect(race).toMatchObject({ status: 401, body: { code: 'TOKEN_REUSED' } });
    expect((await call(api, 'GET', '/api/v1/me', { token: first.body.accessToken })).status).toBe(200);
  });

  it('logout revokes access and refresh tokens immediately', async () => {
    const t = await signup(api);
    expect((await call(api, 'POST', '/api/v1/auth/logout', { token: t.accessToken })).status).toBe(204);
    expect((await call(api, 'GET', '/api/v1/me', { token: t.accessToken })).status).toBe(401);
    expect(
      (await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: t.refreshToken } })).status,
    ).toBe(401);
  });

  it('logs out when the client sends Content-Type: application/json with an empty body', async () => {
    const t = await signup(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(204);
    expect((await call(api, 'GET', '/api/v1/me', { token: t.accessToken })).status).toBe(401);

    // Malformed and prototype-poisoning JSON are still rejected.
    const bad = await api.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(bad.statusCode).toBe(400);
    const poisoned = await api.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"identifier":"x@y.co","password":"p","__proto__":{"isAdmin":true}}',
    });
    expect(poisoned.statusCode).toBe(400);
  });

  it('stops refreshing when the member is suspended', async () => {
    const t = await signup(api);
    const m = await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    await tenantTx(db.app, t.tenantId, (tx) =>
      sql`update tenant_memberships set status = 'SUSPENDED' where id = ${m.membershipId}`.execute(tx),
    );
    expect((await call(api, 'GET', '/api/v1/me', { token: m.accessToken })).status).toBe(401);
    expect(
      (await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: m.refreshToken } })).status,
    ).toBe(401);
  });
});

describe('two-factor authentication', () => {
  it('enrols TOTP, then requires it at login and rejects replayed codes', async () => {
    const t = await signup(api);
    const setup = await call(api, 'POST', '/api/v1/auth/mfa/setup', { token: t.accessToken });
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = auth.base32Decode(setup.body.secret);
    const step = auth.currentStep();

    expect(
      (
        await call(api, 'POST', '/api/v1/auth/mfa/confirm', {
          token: t.accessToken,
          body: { code: '000000' },
        })
      ).status,
    ).toBe(401);
    const confirm = await call(api, 'POST', '/api/v1/auth/mfa/confirm', {
      token: t.accessToken,
      body: { code: auth.totpAt(secret, step) },
    });
    expect(confirm.status).toBe(204);

    const challenge = await login({ identifier: t.email, password: t.password });
    expect(challenge.body).toMatchObject({ mfaRequired: true });
    expect(challenge.body.accessToken).toBeUndefined();

    // The code used for enrolment cannot be used again.
    const replay = await call(api, 'POST', '/api/v1/auth/mfa/verify', {
      body: { mfaToken: challenge.body.mfaToken, code: auth.totpAt(secret, step) },
    });
    expect(replay).toMatchObject({ status: 401, body: { code: 'INVALID_MFA_CODE' } });

    const ok = await call(api, 'POST', '/api/v1/auth/mfa/verify', {
      body: { mfaToken: challenge.body.mfaToken, code: auth.totpAt(secret, step + 1) },
    });
    expect(ok.status).toBe(200);
    const [, payload] = (ok.body.accessToken as string).split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString()).amr).toEqual(['pwd', 'otp']);

    // An MFA challenge token is not an access token.
    expect((await call(api, 'GET', '/api/v1/me', { token: challenge.body.mfaToken })).status).toBe(401);

    // The TOTP seed is stored encrypted.
    const stored = await platformTx(db.app, (tx) =>
      sql<{ enc: Buffer }>`select mfa_totp_secret_enc as enc from users where id = ${t.userId}`.execute(tx),
    );
    expect(stored.rows[0]!.enc.includes(secret)).toBe(false);
  });
});

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications } from '@stockos/core';
import { tenantTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
const mailer = new notifications.MemoryEmailSender();

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db, {}, { mailer });
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function viewerRoleId(t: SignedUpTenant): Promise<string> {
  const roles = (await call(api, 'GET', '/api/v1/roles', { token: t.accessToken })).body;
  return roles.find((r: { code: string }) => r.code === 'VIEWER').id;
}

describe('invitations', () => {
  it('e-mails an accept link with the token, HTML-escaped', async () => {
    const t = await signup(api, 'Shop <b>&');
    const res = await call(api, 'POST', '/api/v1/users/invitations', {
      token: t.accessToken,
      body: { email: 'New.Person@Example.com', roles: [{ roleId: await viewerRoleId(t) }] },
    });
    expect(res).toMatchObject({ status: 201, body: { emailSent: true, email: 'new.person@example.com' } });
    expect(res.body.acceptUrl).toBe(
      `https://app.stockos.test/invite/accept?token=${encodeURIComponent(res.body.token)}`,
    );

    const mail = mailer.sent.at(-1)!;
    expect(mail.to).toBe('new.person@example.com');
    expect(mail.text).toContain(res.body.acceptUrl);
    expect(mail.html).toContain('Shop &lt;b&gt;&amp;');
    expect(mail.html).not.toContain('<b>&');
  });

  it('still creates the invitation when e-mail fails', async () => {
    const broken = await createTestApi(
      db,
      {},
      { mailer: { send: async () => Promise.reject(new Error('SMTP down')) } },
    );
    try {
      const t = await signup(broken);
      const roles = (await call(broken, 'GET', '/api/v1/roles', { token: t.accessToken })).body;
      const res = await call(broken, 'POST', '/api/v1/users/invitations', {
        token: t.accessToken,
        body: {
          email: 'x@example.com',
          roles: [{ roleId: roles.find((r: { code: string }) => r.code === 'VIEWER').id }],
        },
      });
      expect(res).toMatchObject({ status: 201, body: { emailSent: false } });
      const accept = await call(broken, 'POST', '/api/v1/auth/invitations/accept', {
        body: { token: res.body.token, password: 'a long password 1', displayName: 'X' },
      });
      expect(accept.status).toBe(200);
    } finally {
      await broken.close();
    }
  });

  it('lists open invitations and revoking one kills its link', async () => {
    const t = await signup(api);
    const invite = await call(api, 'POST', '/api/v1/users/invitations', {
      token: t.accessToken,
      body: { email: 'later@example.com', roles: [{ roleId: await viewerRoleId(t) }] },
    });
    const open = await call(api, 'GET', '/api/v1/users/invitations', { token: t.accessToken });
    expect(open.body).toMatchObject([
      { id: invite.body.invitationId, email: 'later@example.com', invitedBy: 'Owner' },
    ]);

    expect(
      (
        await call(api, 'DELETE', `/api/v1/users/invitations/${invite.body.invitationId}`, {
          token: t.accessToken,
        })
      ).status,
    ).toBe(204);
    expect((await call(api, 'GET', '/api/v1/users/invitations', { token: t.accessToken })).body).toEqual([]);
    const accept = await call(api, 'POST', '/api/v1/auth/invitations/accept', {
      body: { token: invite.body.token, password: 'a long password 1', displayName: 'Late' },
    });
    expect(accept.status).toBe(401);
  });
});

describe('member status', () => {
  it('suspends immediately (sessions and API keys) and can reactivate', async () => {
    const t = await signup(api);
    const admin = await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    const key = await call(api, 'POST', '/api/v1/api-keys', {
      token: admin.accessToken,
      body: { name: 'k', permissions: ['product.read'] },
    });

    const suspended = await call(api, 'PATCH', `/api/v1/users/${admin.membershipId}`, {
      token: t.accessToken,
      body: { status: 'SUSPENDED' },
    });
    expect(suspended).toMatchObject({ status: 200, body: { status: 'SUSPENDED' } });
    expect((await call(api, 'GET', '/api/v1/me', { token: admin.accessToken })).status).toBe(401);
    expect((await call(api, 'GET', '/api/v1/me', { token: key.body.secret })).status).toBe(401);
    expect(
      (await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: admin.refreshToken } }))
        .status,
    ).toBe(401);

    await call(api, 'PATCH', `/api/v1/users/${admin.membershipId}`, {
      token: t.accessToken,
      body: { status: 'ACTIVE' },
    });
    const login = await call(api, 'POST', '/api/v1/auth/login', {
      body: { identifier: admin.email, password: admin.password },
    });
    expect(login.status).toBe(200);
    // Old sessions stay dead after reactivation; only new logins work.
    expect(
      (await call(api, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: admin.refreshToken } }))
        .status,
    ).toBe(401);
  });

  it('cannot suspend the owner or yourself', async () => {
    const t = await signup(api);
    const admin = await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    const owner = (await call(api, 'GET', '/api/v1/users', { token: t.accessToken })).body.find(
      (m: { isOwner: boolean }) => m.isOwner,
    );
    for (const [token, id] of [
      [admin.accessToken, owner.membershipId],
      [admin.accessToken, admin.membershipId],
    ]) {
      const res = await call(api, 'PATCH', `/api/v1/users/${id}`, { token, body: { status: 'SUSPENDED' } });
      expect(res).toMatchObject({ status: 403, body: { code: 'PRIVILEGE_ESCALATION' } });
    }
  });
});

describe('API key rate limit', () => {
  it('applies the key’s per-minute limit', async () => {
    const t = await signup(api);
    const key = await call(api, 'POST', '/api/v1/api-keys', {
      token: t.accessToken,
      body: { name: 'k', permissions: ['product.read'] },
    });
    await tenantTx(db.app, t.tenantId, (tx) =>
      sql`update api_keys set rate_limit_per_min = 2 where id = ${key.body.id}`.execute(tx),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await call(api, 'GET', '/api/v1/branches', { token: key.body.secret })).status);
    // A window boundary can split the burst; either way the third call within one minute is refused.
    expect(statuses.filter((s) => s === 429).length).toBeLessThanOrEqual(1);
    const fourth = await call(api, 'GET', '/api/v1/branches', { token: key.body.secret });
    const fifth = await call(api, 'GET', '/api/v1/branches', { token: key.body.secret });
    expect([fourth.status, fifth.status]).toContain(429);
  });
});

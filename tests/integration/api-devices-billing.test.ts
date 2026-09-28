import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iam, notifications, tenancy } from '@stockos/core';
import { platformTx, tenantTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: 20 });
  api = await createTestApi(db);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function orgOf(t: SignedUpTenant) {
  const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: t.accessToken })).body;
  const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  return { branchId: branch.id as string, warehouseId: warehouse.id as string };
}

const setPlan = (tenantId: string, planId: string) =>
  platformTx(db.platform, (tx) =>
    sql`update tenant_subscriptions set plan_id = ${planId} where tenant_id = ${tenantId}`.execute(tx),
  );

describe('POS device registration', () => {
  it('registers with a one-time code and authenticates with the device token', async () => {
    const t = await signup(api);
    const created = await call(api, 'POST', '/api/v1/pos-devices', {
      token: t.accessToken,
      body: { code: 'POS01', name: 'Counter 1', ...(await orgOf(t)) },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'PENDING',
      registrationCode: expect.stringMatching(/^[2-9A-Z]{5}-[2-9A-Z]{5}$/),
    });

    const register = (code: string) =>
      call(api, 'POST', '/api/v1/pos/devices/register', {
        body: {
          tenantSlug: t.slug.toUpperCase(),
          registrationCode: code,
          platform: 'ANDROID',
          appVersion: '1.0.0',
        },
      });
    const typed = ` ${created.body.registrationCode.toLowerCase()} `; // people type sloppily
    const ok = await register(typed.trim());
    expect(ok.status).toBe(200);
    expect(ok.body.deviceToken).toMatch(/^pd_/);
    expect((await register(created.body.registrationCode)).status).toBe(401); // one-time

    const heartbeat = (token: string, scheme = 'Device') =>
      api.inject({
        method: 'POST',
        url: '/api/v1/pos/heartbeat',
        headers: { authorization: `${scheme} ${token}` },
        payload: { appVersion: '1.0.1' },
      });
    const beat = await heartbeat(ok.body.deviceToken);
    expect(beat.statusCode).toBe(200);
    expect(Date.parse(beat.json().serverTime)).toBeGreaterThan(0);
    expect((await heartbeat(ok.body.deviceToken, 'Bearer')).statusCode).toBe(401);
    // A device token is not a user token either.
    expect((await call(api, 'GET', '/api/v1/me', { token: ok.body.deviceToken })).status).toBe(401);

    const device = await call(api, 'GET', `/api/v1/pos-devices/${created.body.id}`, { token: t.accessToken });
    expect(device.body).toMatchObject({ status: 'ACTIVE', platform: 'ANDROID', appVersion: '1.0.1' });

    // Disabling cuts the device off immediately.
    await call(api, 'PATCH', `/api/v1/pos-devices/${created.body.id}`, {
      token: t.accessToken,
      body: { status: 'DISABLED' },
    });
    expect((await heartbeat(ok.body.deviceToken)).statusCode).toBe(401);

    // A new code (replacement hardware) invalidates the old token and registers again.
    const reissued = await call(api, 'POST', `/api/v1/pos-devices/${created.body.id}/registration-code`, {
      token: t.accessToken,
    });
    expect((await register(reissued.body.registrationCode)).status).toBe(200);
    expect((await heartbeat(ok.body.deviceToken)).statusCode).toBe(401);
  });

  it('rejects codes of another shop, expired codes and mismatched warehouses', async () => {
    const a = await signup(api, 'A');
    const b = await signup(api, 'B');
    const created = await call(api, 'POST', '/api/v1/pos-devices', {
      token: a.accessToken,
      body: { code: 'POS01', name: 'x', ...(await orgOf(a)) },
    });
    const wrongShop = await call(api, 'POST', '/api/v1/pos/devices/register', {
      body: { tenantSlug: b.slug, registrationCode: created.body.registrationCode, platform: 'WEB' },
    });
    expect(wrongShop.status).toBe(401);

    await tenantTx(db.app, a.tenantId, (tx) =>
      sql`update pos_devices set registration_expires_at = now() - interval '1 second'`.execute(tx),
    );
    const expired = await call(api, 'POST', '/api/v1/pos/devices/register', {
      body: { tenantSlug: a.slug, registrationCode: created.body.registrationCode, platform: 'WEB' },
    });
    expect(expired.status).toBe(401);

    const bOrg = await orgOf(b);
    const mismatch = await call(api, 'POST', '/api/v1/pos-devices', {
      token: a.accessToken,
      body: { code: 'POS02', name: 'x', branchId: (await orgOf(a)).branchId, warehouseId: bOrg.warehouseId },
    });
    expect(mismatch.status).toBe(400);
  });
});

describe('plan limits', () => {
  it('reports plan, limits and usage', async () => {
    const t = await signup(api);
    const usage = await call(api, 'GET', '/api/v1/billing/usage', { token: t.accessToken });
    expect(usage.body).toMatchObject({
      planId: 'BUSINESS',
      status: 'TRIALING',
      limits: { branches: 5 },
      usage: { branches: 1, users: 1 },
    });
  });

  it('blocks creating beyond the plan and counts open invitations as seats', async () => {
    const t = await signup(api);
    await setPlan(t.tenantId, 'FREE'); // 1 branch, 2 users, 1 POS device
    const branch = await call(api, 'POST', '/api/v1/branches', {
      token: t.accessToken,
      body: { code: 'B2', name: 'Second' },
    });
    expect(branch).toMatchObject({
      status: 403,
      body: { code: 'PLAN_LIMIT_EXCEEDED', meta: { metric: 'branches', limit: 1 } },
    });

    await addMember(api, t, [{ roleCode: 'VIEWER' }]); // seat 2 of 2
    const roles = (await call(api, 'GET', '/api/v1/roles', { token: t.accessToken })).body;
    const third = await call(api, 'POST', '/api/v1/users/invitations', {
      token: t.accessToken,
      body: {
        email: 'third@example.com',
        roles: [{ roleId: roles.find((r: { code: string }) => r.code === 'VIEWER').id }],
      },
    });
    expect(third).toMatchObject({ status: 403, body: { code: 'PLAN_LIMIT_EXCEEDED' } });
  });

  it('serialises the last slot: a concurrent create waits, then is refused', async () => {
    const t = await signup(api);
    await setPlan(t.tenantId, 'FREE');
    await platformTx(db.platform, (tx) =>
      sql`update branches set is_active = false where tenant_id = ${t.tenantId}`.execute(tx),
    );
    // 0 of 1 branch slots used. A takes the slot and keeps its transaction open; B arrives meanwhile.
    const principal = await principalOf(t);
    const org = new tenancy.OrgService();
    const create = (code: string, holdMs: number) =>
      tenantTx(db.app, t.tenantId, async (tx) => {
        const branch = await org.createBranch(tx, principal, { code, name: code });
        await new Promise((r) => setTimeout(r, holdMs));
        return branch;
      }).then(
        () => 'created',
        (e: { code?: string }) => e.code ?? 'error',
      );
    const a = create('A1', 300);
    await new Promise((r) => setTimeout(r, 50));
    const b = create('B1', 0);
    // Without the per-(tenant, metric) lock B would count 0 used slots and also succeed.
    expect(await Promise.all([a, b])).toEqual(['created', 'PLAN_LIMIT_EXCEEDED']);
  });
});

describe('notifications', () => {
  it('tells the inviter when someone joins, and only they can read it', async () => {
    const t = await signup(api);
    const member = await addMember(api, t, [{ roleCode: 'VIEWER' }]);
    const list = await call(api, 'GET', '/api/v1/notifications?unread=true', { token: t.accessToken });
    expect(list.body).toMatchObject([{ eventType: 'MEMBER_JOINED', severity: 'INFO', readAt: null }]);
    const id = list.body[0].id;

    expect(
      (await call(api, 'POST', `/api/v1/notifications/${id}/read`, { token: member.accessToken })).status,
    ).toBe(404);
    expect(
      (await call(api, 'POST', `/api/v1/notifications/${id}/read`, { token: t.accessToken })).status,
    ).toBe(204);
    expect(
      (await call(api, 'GET', '/api/v1/notifications?unread=true', { token: t.accessToken })).body,
    ).toEqual([]);
  });

  it('delivers to everyone holding a permission and throttles duplicates', async () => {
    const t = await signup(api);
    await addMember(api, t, [{ roleCode: 'ADMIN' }]);
    await addMember(api, t, [{ roleCode: 'CASHIER' }]);
    const service = new notifications.NotificationService();
    const send = () =>
      tenantTx(db.app, t.tenantId, (tx) =>
        service.notify(tx, {
          tenantId: t.tenantId,
          toPermission: 'settings.manage',
          eventType: 'TOKEN_EXPIRING',
          severity: 'WARNING',
          title: 'Shopee connection expires in 3 days',
          dedupKey: 'token-expiring:shopee:1',
        }),
      );
    expect(await send()).toBe(2); // owner + admin, not the cashier
    expect(await send()).toBe(0); // throttled
  });
});

describe('document numbers', () => {
  it('are gap-free under concurrency even when some transactions roll back', async () => {
    const t = await signup(api);
    const attempts = Array.from({ length: 30 }, (_, i) =>
      tenantTx(db.app, t.tenantId, async (tx) => {
        const no = await tenancy.nextDocumentNumber(tx, t.tenantId, 'SO', { period: '2610' });
        if (i % 3 === 0) throw new Error('rollback');
        return no;
      }).catch(() => null),
    );
    const committed = (await Promise.all(attempts)).filter((n): n is string => n !== null).sort();
    expect(committed).toHaveLength(20);
    expect(committed).toEqual(
      Array.from({ length: 20 }, (_, i) => `SO-2610-${String(i + 1).padStart(6, '0')}`),
    );
  });

  it('keeps separate counters per scope and uses the tenant timezone period by default', async () => {
    const t = await signup(api);
    const [a1, b1, a2, def] = await tenantTx(db.app, t.tenantId, async (tx) => [
      await tenancy.nextDocumentNumber(tx, t.tenantId, 'RCPT', { scopeKey: 'BKK01-POS01', period: '2610' }),
      await tenancy.nextDocumentNumber(tx, t.tenantId, 'RCPT', { scopeKey: 'BKK01-POS02', period: '2610' }),
      await tenancy.nextDocumentNumber(tx, t.tenantId, 'RCPT', { scopeKey: 'BKK01-POS01', period: '2610' }),
      await tenancy.nextDocumentNumber(tx, t.tenantId, 'PO'),
    ]);
    expect([a1, b1, a2]).toEqual([
      'RCPT-BKK01-POS01-2610-000001',
      'RCPT-BKK01-POS02-2610-000001',
      'RCPT-BKK01-POS01-2610-000002',
    ]);
    expect(def).toMatch(/^PO-\d{4}-000001$/);
  });
});

/** The service-level principal of a signed-up owner (for tests that bypass HTTP). */
async function principalOf(t: SignedUpTenant): Promise<iam.Principal> {
  const me = (await call(api, 'GET', '/api/v1/me', { token: t.accessToken })).body;
  const access = await tenantTx(db.app, t.tenantId, (tx) => iam.loadMembershipAccess(tx, me.membershipId));
  return {
    kind: 'USER',
    userId: t.userId,
    tenantId: t.tenantId,
    membershipId: me.membershipId,
    sessionId: null,
    apiKeyId: null,
    isOwner: true,
    grants: access!.grants,
    amr: ['pwd'],
    authTime: Math.floor(Date.now() / 1000),
    mfaEnabled: false,
    mfaEnforced: false,
  };
}

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registeredRoutes } from '@stockos/api/app';
import { iam } from '@stockos/core';
import { platformTx } from '@stockos/database';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let a: SignedUpTenant;
let b: SignedUpTenant;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  a = await signup(api, 'A');
  b = await signup(api, 'B');
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

/** Reviewed list of unauthenticated endpoints. Adding a public route must update this list. */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /health/ready',
  'POST /api/v1/auth/signup',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/invitations/accept',
  'POST /api/v1/pos/devices/register',
]);

const VALID_BODY: Record<string, unknown> = {
  'PUT /api/v1/users/:id/roles': { roles: [] },
  'PATCH /api/v1/users/:id': { status: 'SUSPENDED' },
  'PUT /api/v1/users/:id/employee-code': { employeeCode: 'EMP1' },
  'POST /api/v1/products/:id/variants': { sku: 'X1' },
  'POST /api/v1/products/:id/images': { contentType: 'image/png', dataBase64: 'AAAA' },
  'POST /api/v1/products/:id/units': { unitId: '00000000-0000-7000-8000-000000000000', factorToBase: '12' },
  'POST /api/v1/variants/:id/barcodes': { barcode: '1234567890128', symbology: 'EAN13' },
  'POST /api/v1/variants/:id/bundle-components': {
    components: [{ variantId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
  },
  'POST /api/v1/suppliers/:id/products': { variantId: '00000000-0000-7000-8000-000000000000' },
  'PUT /api/v1/price-lists/:id/prices': { variantId: '00000000-0000-7000-8000-000000000000', price: '10.00' },
  'POST /api/v1/pos/shifts/:id/close': { countedCash: '0.00' },
  'POST /api/v1/pos/shifts/:id/cash-movements': { type: 'PAY_IN', amount: '1.00' },
  'POST /api/v1/pos/sales/:id/refunds': {
    shiftId: '00000000-0000-7000-8000-000000000000',
    lines: [{ orderItemId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
    reason: 'test',
  },
  'POST /api/v1/orders/:id/hold': { reason: 'test' },
  'POST /api/v1/orders/:id/returns': {
    lines: [{ orderItemId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
  },
  'POST /api/v1/orders/:id/refunds': {
    lines: [{ orderItemId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
    reason: 'test',
  },
  'POST /api/v1/orders/:id/fulfillments': {
    lines: [{ orderItemId: '00000000-0000-7000-8000-000000000000', quantity: '1' }],
  },
  'POST /api/v1/returns/:id/receive': {
    lines: [{ orderItemId: '00000000-0000-7000-8000-000000000000', condition: 'SELLABLE' }],
  },
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const routes = () =>
  registeredRoutes(api).map((r) => ({ method: r.method as Method, url: r.url, key: `${r.method} ${r.url}` }));

describe('access policy coverage (generated from every registered route)', () => {
  it('requires a token on every non-public route', async () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(15);
    expect([...PUBLIC_ROUTES].filter((k) => !all.some((r) => r.key === k))).toEqual([]);

    for (const r of all.filter((r) => !PUBLIC_ROUTES.has(r.key))) {
      const url = r.url.replace(':id', '00000000-0000-7000-8000-000000000000');
      const res = await call(api, r.method, url, { body: {} });
      expect({ route: r.key, status: res.status }).toEqual({ route: r.key, status: 401 });
      const bad = await call(api, r.method, url, { body: {}, token: 'not-a-jwt' });
      expect({ route: r.key, status: bad.status }).toEqual({ route: r.key, status: 401 });
    }
  });

  it('returns 404 — never another tenant’s data — for every route with an :id', async () => {
    const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: a.accessToken })).body;
    const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: a.accessToken })).body;
    const [role] = (await call(api, 'GET', '/api/v1/roles', { token: a.accessToken })).body;
    const member = await addMember(api, a, [{ roleCode: 'VIEWER' }]); // also notifies A's owner
    const [notification] = (await call(api, 'GET', '/api/v1/notifications', { token: a.accessToken })).body;
    const apiKey = (
      await call(api, 'POST', '/api/v1/api-keys', {
        token: a.accessToken,
        body: { name: 'k', permissions: ['product.read'] },
      })
    ).body;
    const device = (
      await call(api, 'POST', '/api/v1/pos-devices', {
        token: a.accessToken,
        body: { code: 'POS01', name: 'x', branchId: branch.id, warehouseId: warehouse.id },
      })
    ).body;
    const invitation = (
      await call(api, 'POST', '/api/v1/users/invitations', {
        token: a.accessToken,
        body: { email: 'pending@example.com', roles: [{ roleId: role.id }] },
      })
    ).body;
    const brand = (
      await call(api, 'POST', '/api/v1/brands', { token: a.accessToken, body: { name: 'BrandA' } })
    ).body;
    const category = (
      await call(api, 'POST', '/api/v1/categories', { token: a.accessToken, body: { name: 'CatA' } })
    ).body;
    const unit = (
      await call(api, 'POST', '/api/v1/units', { token: a.accessToken, body: { code: 'PCS', name: 'Piece' } })
    ).body;
    const product = (
      await call(api, 'POST', '/api/v1/products', {
        token: a.accessToken,
        body: {
          code: 'PROD-A',
          name: 'Product A',
          baseUnitId: unit.id,
          variants: [{ sku: 'SKU-A1', sellingPrice: '100.00' }],
        },
      })
    ).body;
    const variant = product.variants[0];
    await call(api, 'POST', `/api/v1/variants/${variant.id}/barcodes`, {
      token: a.accessToken,
      body: { barcode: '1234567890128', symbology: 'EAN13' },
    });
    const image = (
      await call(api, 'POST', `/api/v1/products/${product.id}/images`, {
        token: a.accessToken,
        body: { contentType: 'image/png', dataBase64: 'AAAA' },
      })
    ).body;
    const [priceList] = (await call(api, 'GET', '/api/v1/price-lists', { token: a.accessToken })).body; // RETAIL, seeded at signup
    const supplier = (
      await call(api, 'POST', '/api/v1/suppliers', {
        token: a.accessToken,
        body: { code: 'SUP1', name: 'Supplier A' },
      })
    ).body;
    await call(api, 'POST', `/api/v1/suppliers/${supplier.id}/products`, {
      token: a.accessToken,
      body: { variantId: variant.id },
    });
    const job = await platformTx(db.platform, (tx) =>
      sql<{ id: string }>`insert into import_jobs (tenant_id, id, type, status, total_rows)
                           values (${a.tenantId}, ${'00000000-0000-7000-8000-0000000000aa'}, 'PRODUCT_IMPORT', 'COMPLETED', 0)
                           returning id`.execute(tx),
    ).then((r) => r.rows[0]!);
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: a.accessToken,
      headers: { 'idempotency-key': `test:receive:${variant.id}` },
      body: { lines: [{ warehouseId: warehouse.id, variantId: variant.id, quantity: '5' }] },
    });
    const [reservation] = (
      await call(api, 'POST', '/api/v1/inventory/reserve', {
        token: a.accessToken,
        headers: { 'idempotency-key': `test:reserve:${variant.id}` },
        body: {
          referenceType: 'TEST',
          referenceId: '00000000-0000-7000-8000-0000000000bb',
          items: [{ warehouseId: warehouse.id, variantId: variant.id, quantity: '1' }],
        },
      })
    ).body;
    const adjustment = (
      await call(api, 'POST', '/api/v1/inventory/adjustments', {
        token: a.accessToken,
        body: {
          warehouseId: warehouse.id,
          reasonCode: 'FOUND',
          items: [{ variantId: variant.id, quantityDelta: '1' }],
        },
      })
    ).body;
    const reconciliationRun = (
      await call(api, 'POST', '/api/v1/inventory/reconciliation-runs', { token: a.accessToken, body: {} })
    ).body;
    const customer = (
      await call(api, 'POST', '/api/v1/customers', { token: a.accessToken, body: { name: 'Walk-in A' } })
    ).body;
    await call(api, 'POST', '/api/v1/pos/devices/register', {
      body: { tenantSlug: a.slug, registrationCode: device.registrationCode, platform: 'WEB' },
    });
    const shift = (
      await call(api, 'POST', '/api/v1/pos/shifts', {
        token: a.accessToken,
        body: { posDeviceId: device.id, openingCash: '0.00' },
      })
    ).body;
    const sale = (
      await call(api, 'POST', '/api/v1/pos/sales', {
        token: a.accessToken,
        body: {
          posDeviceId: device.id,
          shiftId: shift.id,
          clientTxnId: '00000000-0000-7000-8000-0000000000cc',
          lines: [{ variantId: variant.id, quantity: '1' }],
          payments: [{ method: 'CASH', amount: '100.00', tenderedAmount: '100.00' }],
        },
      })
    ).body;

    const orderRes = await call(api, 'POST', '/api/v1/orders', {
      token: a.accessToken,
      headers: { 'idempotency-key': '00000000-0000-7000-8000-0000000000dd' },
      body: {
        channelCode: 'API',
        warehouseId: warehouse.id,
        paid: true,
        lines: [{ variantId: variant.id, quantity: '1' }],
      },
    });
    expect(orderRes.status, JSON.stringify(orderRes.body)).toBe(201);
    const order = orderRes.body;
    const confirmRes = await call(api, 'POST', `/api/v1/orders/${order.id}/confirm`, {
      token: a.accessToken,
    });
    expect(confirmRes.status, JSON.stringify(confirmRes.body)).toBe(201);
    const fulfillmentRes = await call(api, 'POST', `/api/v1/orders/${order.id}/fulfillments`, {
      token: a.accessToken,
      headers: { 'idempotency-key': '00000000-0000-7000-8000-0000000000ee' },
      body: { lines: [{ orderItemId: order.lines[0].id, quantity: '1' }] },
    });
    expect(fulfillmentRes.status, JSON.stringify(fulfillmentRes.body)).toBe(201);
    const fulfillment = fulfillmentRes.body;
    const shipRes = await call(api, 'POST', `/api/v1/fulfillments/${fulfillment.id}/ship`, {
      token: a.accessToken,
      body: {},
    });
    expect(shipRes.status, JSON.stringify(shipRes.body)).toBe(201);
    const orderReturnRes = await call(api, 'POST', `/api/v1/orders/${order.id}/returns`, {
      token: a.accessToken,
      headers: { 'idempotency-key': '00000000-0000-7000-8000-0000000000ff' },
      body: { lines: [{ orderItemId: order.lines[0].id, quantity: '1' }] },
    });
    expect(orderReturnRes.status, JSON.stringify(orderReturnRes.body)).toBe(201);
    const orderReturn = orderReturnRes.body;

    // Resource of tenant A for each route prefix; a new :id route must be added here.
    const idOfA: Record<string, string> = {
      '/api/v1/branches/:id': branch.id,
      '/api/v1/warehouses/:id': warehouse.id,
      '/api/v1/roles/:id': role.id,
      '/api/v1/users/:id': member.membershipId,
      '/api/v1/users/:id/roles': member.membershipId,
      '/api/v1/users/:id/employee-code': member.membershipId,
      '/api/v1/users/invitations/:id': invitation.invitationId,
      '/api/v1/api-keys/:id': apiKey.id,
      '/api/v1/pos-devices/:id': device.id,
      '/api/v1/pos-devices/:id/registration-code': device.id,
      '/api/v1/notifications/:id/read': notification.id,
      '/api/v1/brands/:id': brand.id,
      '/api/v1/categories/:id': category.id,
      '/api/v1/products/:id': product.id,
      '/api/v1/products/:id/variants': product.id,
      '/api/v1/products/:id/images': product.id,
      '/api/v1/products/:id/units': product.id,
      '/api/v1/variants/:id': variant.id,
      '/api/v1/variants/:id/barcodes': variant.id,
      '/api/v1/variants/:id/bundle-components': variant.id,
      '/api/v1/images/:id': image.id,
      '/api/v1/jobs/:id': job.id,
      '/api/v1/suppliers/:id': supplier.id,
      '/api/v1/suppliers/:id/products': supplier.id,
      '/api/v1/price-lists/:id/prices': priceList.id,
      '/api/v1/inventory/reservations/:id': reservation.id,
      '/api/v1/inventory/reservations/:id/release': reservation.id,
      '/api/v1/inventory/reservations/:id/commit': reservation.id,
      '/api/v1/inventory/adjustments/:id': adjustment.id,
      '/api/v1/inventory/adjustments/:id/approve': adjustment.id,
      '/api/v1/inventory/adjustments/:id/reject': adjustment.id,
      '/api/v1/inventory/reconciliation-runs/:id': reconciliationRun.id,
      '/api/v1/inventory/reconciliation-runs/:id/rebuild': reconciliationRun.id,
      '/api/v1/customers/:id': customer.id,
      '/api/v1/pos/shifts/:id': shift.id,
      '/api/v1/pos/shifts/:id/close': shift.id,
      '/api/v1/pos/shifts/:id/cash-movements': shift.id,
      '/api/v1/pos/sales/:id': sale.orderId,
      '/api/v1/pos/sales/:id/refunds': sale.orderId,
      '/api/v1/orders/:id': order.id,
      '/api/v1/orders/:id/pay': order.id,
      '/api/v1/orders/:id/confirm': order.id,
      '/api/v1/orders/:id/cancel': order.id,
      '/api/v1/orders/:id/hold': order.id,
      '/api/v1/orders/:id/release-hold': order.id,
      '/api/v1/orders/:id/returns': order.id,
      '/api/v1/orders/:id/refunds': order.id,
      '/api/v1/orders/:id/fulfillments': order.id,
      '/api/v1/fulfillments/:id/pack': fulfillment.id,
      '/api/v1/fulfillments/:id/ship': fulfillment.id,
      '/api/v1/returns/:id': orderReturn.id,
      '/api/v1/returns/:id/receive': orderReturn.id,
    };

    const withId = routes().filter((r) => r.url.includes(':id'));
    expect(withId.map((r) => r.url).filter((u) => !(u in idOfA))).toEqual([]);

    for (const r of withId) {
      const url = r.url.replace(':id', idOfA[r.url]!);
      const res = await call(api, r.method, url, {
        token: b.accessToken, // tenant B's owner: every permission, wrong tenant
        // A valid body, so the only reason to fail is the foreign id.
        body: VALID_BODY[r.key] ?? {},
        headers: { 'if-match': '"v1"', 'idempotency-key': '00000000-0000-7000-8000-000000001111' },
      });
      expect({ route: r.key, status: res.status }).toEqual({ route: r.key, status: 404 });
    }
    // And tenant A's data is untouched.
    expect(
      (await call(api, 'GET', `/api/v1/users/${member.membershipId}`, { token: a.accessToken })).status,
    ).toBe(200);
  });
});

describe('role-based access', () => {
  it('lets a cashier sell but not manage users, roles or warehouses', async () => {
    const cashier = await addMember(api, a, [{ roleCode: 'CASHIER' }]);
    const me = await call(api, 'GET', '/api/v1/me', { token: cashier.accessToken });
    const perms = me.body.grants.map((g: { permission: string }) => g.permission);
    expect(perms).toContain('pos.sell');
    expect(perms).not.toContain('user.read');

    expect((await call(api, 'GET', '/api/v1/users', { token: cashier.accessToken })).status).toBe(403);
    expect(
      (
        await call(api, 'POST', '/api/v1/warehouses', {
          token: cashier.accessToken,
          body: { code: 'X', name: 'X' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(api, 'POST', '/api/v1/roles', {
          token: cashier.accessToken,
          body: { code: 'X', name: 'X', permissions: [] },
        })
      ).status,
    ).toBe(403);
    // Reading the org structure is allowed to every member.
    expect((await call(api, 'GET', '/api/v1/branches', { token: cashier.accessToken })).status).toBe(200);
  });

  it('scopes a manager to one branch', async () => {
    const [hq] = (await call(api, 'GET', '/api/v1/branches', { token: a.accessToken })).body;
    const manager = await addMember(api, a, [{ roleCode: 'MANAGER', scopeType: 'BRANCH', scopeId: hq.id }]);
    const me = await call(api, 'GET', '/api/v1/me', { token: manager.accessToken });
    expect(
      new Set(
        me.body.grants.map((g: { scopeType: string; scopeId: string }) => `${g.scopeType}:${g.scopeId}`),
      ),
    ).toEqual(new Set([`BRANCH:${hq.id}`]));
  });

  it('rejects scopes pointing at unknown or foreign branches', async () => {
    const [bBranch] = (await call(api, 'GET', '/api/v1/branches', { token: b.accessToken })).body;
    const roles = (await call(api, 'GET', '/api/v1/roles', { token: a.accessToken })).body;
    const res = await call(api, 'POST', '/api/v1/users/invitations', {
      token: a.accessToken,
      body: {
        email: 'scoped@example.com',
        roles: [
          {
            roleId: roles.find((r: { code: string }) => r.code === 'MANAGER').id,
            scopeType: 'BRANCH',
            scopeId: bBranch.id,
          },
        ],
      },
    });
    expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
  });
});

describe('privilege escalation guards', () => {
  let admin: Awaited<ReturnType<typeof addMember>>;
  let roles: { id: string; code: string; version: number }[];

  beforeAll(async () => {
    admin = await addMember(api, a, [{ roleCode: 'ADMIN' }]);
    roles = (await call(api, 'GET', '/api/v1/roles', { token: a.accessToken })).body;
  });
  const roleId = (code: string) => roles.find((r) => r.code === code)!.id;

  it('cannot create a role with permissions the admin does not hold', async () => {
    const res = await call(api, 'POST', '/api/v1/roles', {
      token: admin.accessToken,
      body: { code: 'SNEAKY', name: 'Sneaky', permissions: ['billing.manage'] },
    });
    expect(res).toMatchObject({ status: 403, body: { code: 'PRIVILEGE_ESCALATION' } });
  });

  it('cannot hand out OWNER, change their own roles, or touch the owner', async () => {
    const other = await addMember(api, a, [{ roleCode: 'VIEWER' }]);
    const owner = (await call(api, 'GET', '/api/v1/users', { token: a.accessToken })).body.find(
      (m: { isOwner: boolean }) => m.isOwner,
    );

    const giveOwner = await call(api, 'PUT', `/api/v1/users/${other.membershipId}/roles`, {
      token: admin.accessToken,
      body: { roles: [{ roleId: roleId('OWNER') }] },
    });
    const self = await call(api, 'PUT', `/api/v1/users/${admin.membershipId}/roles`, {
      token: admin.accessToken,
      body: { roles: [{ roleId: roleId('VIEWER') }] },
    });
    const demoteOwner = await call(api, 'PUT', `/api/v1/users/${owner.membershipId}/roles`, {
      token: admin.accessToken,
      body: { roles: [{ roleId: roleId('VIEWER') }] },
    });
    for (const res of [giveOwner, self, demoteOwner])
      expect(res).toMatchObject({ status: 403, body: { code: 'PRIVILEGE_ESCALATION' } });

    // A legitimate change works and is audited.
    const ok = await call(api, 'PUT', `/api/v1/users/${other.membershipId}/roles`, {
      token: admin.accessToken,
      body: { roles: [{ roleId: roleId('CASHIER') }] },
    });
    expect(ok.status).toBe(200);
    const audit = await platformTx(db.platform, (tx) =>
      sql<{ n: number }>`select count(*)::int as n from audit_logs
                          where action = 'membership.roles.replace' and resource_id = ${other.membershipId}`.execute(
        tx,
      ),
    );
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('edits custom roles with optimistic locking and cannot touch system roles', async () => {
    const created = await call(api, 'POST', '/api/v1/roles', {
      token: admin.accessToken,
      body: { code: 'STOCK_CLERK', name: 'Stock clerk', permissions: ['inventory.read', 'inventory.count'] },
    });
    expect(created.status).toBe(201);

    const noIfMatch = await call(api, 'PATCH', `/api/v1/roles/${created.body.id}`, {
      token: admin.accessToken,
      body: { name: 'X' },
    });
    expect(noIfMatch.status).toBe(400);
    const ok = await call(api, 'PATCH', `/api/v1/roles/${created.body.id}`, {
      token: admin.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { permissions: ['inventory.read'] },
    });
    expect(ok).toMatchObject({ status: 200, body: { version: 2, permissions: ['inventory.read'] } });
    expect(ok.headers['etag']).toBe('"v2"');
    const stale = await call(api, 'PATCH', `/api/v1/roles/${created.body.id}`, {
      token: admin.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { name: 'Stale' },
    });
    expect(stale).toMatchObject({ status: 412, body: { code: 'PRECONDITION_FAILED' } });

    const system = await call(api, 'PATCH', `/api/v1/roles/${roleId('CASHIER')}`, {
      token: admin.accessToken,
      headers: { 'if-match': '"v1"' },
      body: { permissions: ['pos.sell', 'pos.refund'] },
    });
    expect(system).toMatchObject({ status: 422, body: { code: 'SYSTEM_ROLE_IMMUTABLE' } });
  });
});

describe('permission catalog', () => {
  it('matches the permissions table seeded by migrations', async () => {
    const { rows } = await platformTx(db.platform, (tx) =>
      sql<{
        code: string;
        is_dangerous: boolean;
      }>`select code, is_dangerous from permissions order by code`.execute(tx),
    );
    expect(rows).toEqual(
      [...iam.PERMISSION_CATALOG]
        .map((p) => ({ code: p.code, is_dangerous: p.dangerous }))
        .sort((x, y) => x.code.localeCompare(y.code)),
    );
  });
});

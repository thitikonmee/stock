import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let owner: SignedUpTenant;
let clerk: Awaited<ReturnType<typeof addMember>>;
let fromWh: string;
let toWh: string;
let pcs: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  owner = await signup(api, 'Transfers');
  clerk = await addMember(api, owner, [{ roleCode: 'WAREHOUSE_STAFF' }]);
  const [main] = (await call(api, 'GET', '/api/v1/warehouses', { token: owner.accessToken })).body;
  fromWh = main.id;
  toWh = (
    await call(api, 'POST', '/api/v1/warehouses', {
      token: owner.accessToken,
      body: { code: 'STORE2', name: 'สาขา 2', branchId: main.branchId },
    })
  ).body.id;
  pcs = (
    await call(api, 'POST', '/api/v1/units', {
      token: owner.accessToken,
      body: { code: 'PCS', name: 'ชิ้น' },
    })
  ).body.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function stockedVariant(qty: string): Promise<string> {
  const tag = uuidv7().slice(-8).toUpperCase();
  const product = await call(api, 'POST', '/api/v1/products', {
    token: owner.accessToken,
    body: { code: `T-${tag}`, name: `Item ${tag}`, baseUnitId: pcs, variants: [{ sku: `T-${tag}` }] },
  });
  const variantId = product.body.variants[0].id as string;
  const recv = await call(api, 'POST', '/api/v1/inventory/receive', {
    token: owner.accessToken,
    headers: { 'idempotency-key': `seed:${variantId}` },
    body: { lines: [{ warehouseId: fromWh, variantId, quantity: qty }] },
  });
  expect(recv.status, JSON.stringify(recv.body)).toBe(201);
  return variantId;
}

async function bal(warehouseId: string, variantId: string) {
  const res = await call(
    api,
    'GET',
    `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouseId}`,
    {
      token: owner.accessToken,
    },
  );
  const b = res.body.data[0];
  return b
    ? {
        onHand: b.onHand,
        committed: b.committed,
        incoming: b.incoming,
        damaged: b.damaged,
        available: b.available,
      }
    : undefined;
}

async function create(variantId: string, quantity: string) {
  const res = await call(api, 'POST', '/api/v1/inventory/transfers', {
    token: clerk.accessToken,
    body: { fromWarehouseId: fromWh, toWarehouseId: toWh, items: [{ variantId, quantity }] },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function act(
  t: { id: string; version: number },
  action: string,
  body: unknown = {},
  token = owner.accessToken,
) {
  return call(api, 'POST', `/api/v1/inventory/transfers/${t.id}/${action}`, {
    token,
    headers: { 'if-match': `"v${t.version}"` },
    body,
  });
}

function receive(t: { id: string }, lines: unknown[], key = uuidv7(), token = clerk.accessToken) {
  return call(api, 'POST', `/api/v1/inventory/transfers/${t.id}/receive`, {
    token,
    headers: { 'idempotency-key': key },
    body: { lines },
  });
}

describe('stock transfers', () => {
  it('approve commits at the source, ship moves it in transit, receive lands it at the destination', async () => {
    const v = await stockedVariant('50');
    const t = await create(v, '20');
    expect(t).toMatchObject({ status: 'REQUESTED', docNo: expect.stringMatching(/^TR-/) });

    const approved = await act(t, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(await bal(fromWh, v)).toMatchObject({
      onHand: '50.000',
      committed: '20.000',
      available: '30.000',
    });

    const shipped = await act(approved.body, 'ship', {}, clerk.accessToken);
    expect(shipped.body.status).toBe('SHIPPED');
    expect(await bal(fromWh, v)).toMatchObject({ onHand: '30.000', committed: '0.000', available: '30.000' });
    expect(await bal(toWh, v)).toMatchObject({ onHand: '0.000', incoming: '20.000' });

    const got = await receive(shipped.body, [{ itemId: t.items[0].id, receivedQty: '20' }]);
    expect(got.body).toMatchObject({ status: 'RECEIVED', items: [{ inTransitQty: '0.000' }] });
    expect(await bal(toWh, v)).toMatchObject({ onHand: '20.000', incoming: '0.000' });

    const done = await act(got.body, 'complete');
    expect(done.body.status).toBe('COMPLETED');
  });

  it('partial approve/ship/receive with damage, then complete writes off the transit shortfall', async () => {
    const v = await stockedVariant('100');
    const t = await create(v, '40');
    const itemId = t.items[0].id;
    const approved = await act(t, 'approve', { lines: [{ itemId, quantity: '30' }] });
    expect(await bal(fromWh, v)).toMatchObject({ committed: '30.000' });

    const shipped = await act(
      approved.body,
      'ship',
      { lines: [{ itemId, quantity: '25' }] },
      clerk.accessToken,
    );
    // 5 approved but not shipped go back to the source's available stock.
    expect(await bal(fromWh, v)).toMatchObject({ onHand: '75.000', committed: '0.000', available: '75.000' });
    expect(await bal(toWh, v)).toMatchObject({ incoming: '25.000' });

    const part = await receive(shipped.body, [{ itemId, receivedQty: '18', damagedQty: '2' }]);
    expect(part.body).toMatchObject({ status: 'PARTIALLY_RECEIVED', items: [{ inTransitQty: '5.000' }] });
    expect(await bal(toWh, v)).toMatchObject({ onHand: '18.000', damaged: '2.000', incoming: '5.000' });

    const done = await act(part.body, 'complete');
    expect(done.body.status).toBe('COMPLETED');
    expect(await bal(toWh, v)).toMatchObject({ onHand: '18.000', incoming: '0.000' });
  });

  it('refuses to approve more than is available at the source', async () => {
    const v = await stockedVariant('5');
    const t = await create(v, '10');
    const res = await act(t, 'approve');
    expect(res).toMatchObject({ status: 409, body: { code: 'STOCK_INSUFFICIENT' } });
    expect(await bal(fromWh, v)).toMatchObject({ committed: '0.000' });
  });

  it('cancelling an approved transfer releases the committed stock', async () => {
    const v = await stockedVariant('10');
    const t = await create(v, '6');
    const approved = await act(t, 'approve');
    const cancelled = await act(approved.body, 'cancel', {}, clerk.accessToken);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await bal(fromWh, v)).toMatchObject({ committed: '0.000', available: '10.000' });
  });

  it('refuses receiving more than is in transit', async () => {
    const v = await stockedVariant('10');
    const t = await create(v, '4');
    const approved = await act(t, 'approve');
    const shipped = await act(approved.body, 'ship', {}, clerk.accessToken);
    const res = await receive(shipped.body, [{ itemId: t.items[0].id, receivedQty: '5' }]);
    expect(res).toMatchObject({ status: 422, body: { code: 'OVER_RECEIVE' } });
  });

  it('a warehouse clerk cannot approve', async () => {
    const v = await stockedVariant('3');
    const t = await create(v, '1');
    const res = await act(t, 'approve', {}, clerk.accessToken);
    expect(res.status).toBe(403);
  });

  it('a receipt replayed concurrently with the same key lands exactly once', async () => {
    const v = await stockedVariant('50');
    const t = await create(v, '30');
    const approved = await act(t, 'approve');
    const shipped = await act(approved.body, 'ship', {}, clerk.accessToken);
    const key = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        receive(shipped.body, [{ itemId: t.items[0].id, receivedQty: '10' }], key),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await bal(toWh, v)).toMatchObject({ onHand: '10.000', incoming: '20.000' });
  });

  it('concurrent distinct receipts never exceed what was shipped', async () => {
    const v = await stockedVariant('50');
    const t = await create(v, '30');
    const approved = await act(t, 'approve');
    const shipped = await act(approved.body, 'ship', {}, clerk.accessToken);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receive(shipped.body, [{ itemId: t.items[0].id, receivedQty: '10' }])),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await bal(toWh, v)).toMatchObject({ onHand: '30.000', incoming: '0.000' });
  });
});

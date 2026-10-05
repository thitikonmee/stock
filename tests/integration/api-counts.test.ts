import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let owner: SignedUpTenant;
let counter: Awaited<ReturnType<typeof addMember>>;
let wh: string;
let pcs: string;

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: 20 });
  api = await createTestApi(db);
  owner = await signup(api, 'Counts');
  counter = await addMember(api, owner, [{ roleCode: 'WAREHOUSE_STAFF' }]);
  wh = (await call(api, 'GET', '/api/v1/warehouses', { token: owner.accessToken })).body[0].id;
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

async function stocked(qty: string): Promise<string> {
  const tag = uuidv7().slice(-8).toUpperCase();
  const product = await call(api, 'POST', '/api/v1/products', {
    token: owner.accessToken,
    body: { code: `C-${tag}`, name: `Count ${tag}`, baseUnitId: pcs, variants: [{ sku: `C-${tag}` }] },
  });
  const variantId = product.body.variants[0].id as string;
  await receiveStock(variantId, qty);
  return variantId;
}

async function receiveStock(variantId: string, qty: string) {
  const res = await call(api, 'POST', '/api/v1/inventory/receive', {
    token: owner.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: { lines: [{ warehouseId: wh, variantId, quantity: qty }] },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function onHand(variantId: string): Promise<string> {
  const res = await call(api, 'GET', `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${wh}`, {
    token: owner.accessToken,
  });
  return res.body.data[0].onHand;
}

async function startCount(
  variantIds: string[],
  extra: Record<string, unknown> = {},
  token = counter.accessToken,
) {
  const res = await call(api, 'POST', '/api/v1/inventory/counts', {
    token,
    body: { warehouseId: wh, countType: 'SPOT', variantIds, ...extra },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function record(id: string, lines: unknown[], mode: 'SET' | 'ADD' = 'SET', token = counter.accessToken) {
  return call(api, 'POST', `/api/v1/inventory/counts/${id}/lines`, { token, body: { mode, lines } });
}

function act(c: { id: string; version: number }, action: string, token = owner.accessToken) {
  return call(api, 'POST', `/api/v1/inventory/counts/${c.id}/${action}`, {
    token,
    headers: { 'if-match': `"v${c.version}"` },
    body: {},
  });
}

const item = (count: { items: { variantId: string }[] }, v: string) =>
  count.items.find((i) => i.variantId === v) as Record<string, unknown>;

describe('stock counts', () => {
  it('posts the variance as a COUNT_VARIANCE adjustment once a second person approves', async () => {
    const v = await stocked('100');
    const c = await startCount([v]);
    expect(c).toMatchObject({ status: 'IN_PROGRESS', docNo: expect.stringMatching(/^CNT-/) });
    expect(item(c, v)).toMatchObject({ snapshotQty: '100.000', countedQty: null });

    expect((await record(c.id, [{ variantId: v, quantity: '97' }])).body).toEqual({ applied: 1 });
    const submitted = await act(c, 'submit', counter.accessToken);
    expect(submitted.body.status).toBe('PENDING_APPROVAL');
    expect(item(submitted.body, v)).toMatchObject({ variance: '-3.000', movementSinceSnapshot: '0.000' });

    const self = await act(submitted.body, 'approve', counter.accessToken);
    expect(self.status).toBe(403); // a warehouse clerk lacks inventory.count.approve
    const posted = await act(submitted.body, 'approve');
    expect(posted.body).toMatchObject({ status: 'POSTED', postedAdjustmentId: expect.any(String) });
    expect(await onHand(v)).toBe('97.000');

    const adj = await call(api, 'GET', `/api/v1/inventory/adjustments/${posted.body.postedAdjustmentId}`, {
      token: owner.accessToken,
    });
    expect(adj.body).toMatchObject({
      status: 'POSTED',
      reasonCode: 'COUNT_ERROR',
      items: [{ quantityDelta: '-3.000' }],
    });
  });

  it('stock that moved during the count does not show up as variance', async () => {
    const v = await stocked('100');
    const c = await startCount([v]);
    await receiveStock(v, '20'); // a delivery lands mid-count; the shelf now really holds 120
    await record(c.id, [{ variantId: v, quantity: '120' }]);
    const submitted = await act(c, 'submit', counter.accessToken);
    expect(item(submitted.body, v)).toMatchObject({ movementSinceSnapshot: '20.000', variance: '0.000' });
    const posted = await act(submitted.body, 'approve');
    expect(posted.body.postedAdjustmentId).toBeNull();
    expect(await onHand(v)).toBe('120.000');
  });

  it('an offline count uses the time it was counted, not when it synced', async () => {
    const v = await stocked('50');
    const c = await startCount([v]);
    const countedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    await receiveStock(v, '10'); // arrives after the (offline) count was taken
    await record(c.id, [{ variantId: v, quantity: '50', countedAt }]);
    const submitted = await act(c, 'submit', counter.accessToken);
    expect(item(submitted.body, v)).toMatchObject({ movementSinceSnapshot: '0.000', variance: '0.000' });
  });

  it('variance is applied as a delta, so stock moving between submit and approval is kept', async () => {
    const v = await stocked('40');
    const c = await startCount([v]);
    await record(c.id, [{ variantId: v, quantity: '38' }]);
    const submitted = await act(c, 'submit', counter.accessToken);
    await receiveStock(v, '5');
    await act(submitted.body, 'approve');
    expect(await onHand(v)).toBe('43.000');
  });

  it('BLIND counts hide the expected quantity from counters but not from approvers', async () => {
    const v = await stocked('12');
    const c = await startCount([v], { countType: 'BLIND' });
    expect(item(c, v)).toMatchObject({ snapshotQty: null });
    const asOwner = await call(api, 'GET', `/api/v1/inventory/counts/${c.id}`, { token: owner.accessToken });
    expect(item(asOwner.body, v)).toMatchObject({ snapshotQty: '12.000' });
  });

  it('flags variances beyond the tolerance for a recount', async () => {
    const a = await stocked('10');
    const b = await stocked('10');
    const c = await startCount([a, b], { varianceTolerance: '1' });
    await record(c.id, [
      { variantId: a, quantity: '9' },
      { variantId: b, quantity: '4' },
    ]);
    const submitted = await act(c, 'submit', counter.accessToken);
    expect(submitted.body.totals).toMatchObject({ recountRequired: 1, withVariance: 2 });
    expect(item(submitted.body, b)).toMatchObject({ recountRequired: true });

    const reopened = await act(submitted.body, 'recount');
    expect(reopened.body.status).toBe('IN_PROGRESS');
    expect(item(reopened.body, b)).toMatchObject({ countedQty: null });
    expect(item(reopened.body, a)).toMatchObject({ countedQty: '9.000' });
    await record(c.id, [{ variantId: b, quantity: '10' }]);
    const again = await act(reopened.body, 'submit', counter.accessToken);
    expect(again.body.totals).toMatchObject({ recountRequired: 0, withVariance: 1 });
  });

  it('rejects lines for SKUs outside the count and recording after submit', async () => {
    const v = await stocked('1');
    const other = await stocked('1');
    const c = await startCount([v]);
    expect((await record(c.id, [{ variantId: other, quantity: '1' }])).status).toBe(400);
    await record(c.id, [{ variantId: v, quantity: '1' }]);
    await act(c, 'submit', counter.accessToken);
    const late = await record(c.id, [{ variantId: v, quantity: '2' }]);
    expect(late).toMatchObject({ status: 422, body: { code: 'INVALID_STATE_TRANSITION' } });
  });

  it('three devices scanning the same SKU at once add up exactly', async () => {
    const v = await stocked('30');
    const c = await startCount([v]);
    const scans = Array.from({ length: 30 }, (_, i) =>
      record(
        c.id,
        [{ variantId: v, quantity: '1' }],
        'ADD',
        i % 3 === 0 ? owner.accessToken : counter.accessToken,
      ),
    );
    const results = await Promise.all(scans);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = await call(api, 'GET', `/api/v1/inventory/counts/${c.id}`, { token: owner.accessToken });
    expect(item(got.body, v)).toMatchObject({ countedQty: '30.000' });
  });

  it('DoD: devices count many SKUs while stock keeps moving — every variance is still exact', async () => {
    const skus = await Promise.all(Array.from({ length: 30 }, () => stocked('100')));
    const c = await startCount(skus);
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));

    // Deliveries (+3 per SKU) land while three devices are counting. Group A counted the shelf
    // before any delivery (offline timestamps), group B after all of them.
    const groupA = skus.slice(0, 15);
    const groupB = skus.slice(15);
    const deliveries = skus.map((v) => receiveStock(v, '3'));
    const devices = [0, 1, 2].map((d) =>
      record(
        c.id,
        groupA
          .filter((_, i) => i % 3 === d)
          .map((v) => ({ variantId: v, quantity: '100', countedAt: before })),
        'SET',
      ),
    );
    await Promise.all([...deliveries, ...devices]);
    await Promise.all(
      [0, 1, 2].map((d) =>
        record(
          c.id,
          groupB.filter((_, i) => i % 3 === d).map((v) => ({ variantId: v, quantity: '103' })),
          'SET',
        ),
      ),
    );

    const submitted = await act(c, 'submit', counter.accessToken);
    expect(submitted.body.totals).toMatchObject({ items: 30, counted: 30, withVariance: 0 });
    for (const v of groupA) expect(item(submitted.body, v)).toMatchObject({ movementSinceSnapshot: '0.000' });
    for (const v of groupB) expect(item(submitted.body, v)).toMatchObject({ movementSinceSnapshot: '3.000' });
    const posted = await act(submitted.body, 'approve');
    expect(posted.body.postedAdjustmentId).toBeNull();
    for (const v of skus) expect(await onHand(v)).toBe('103.000');
  });
});

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantTx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let owner: SignedUpTenant;
let approver: Awaited<ReturnType<typeof addMember>>;
let receiver: Awaited<ReturnType<typeof addMember>>;
let warehouseId: string;
let supplierId: string;
let boxUnitId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  owner = await signup(api, 'Purchasing');
  approver = await addMember(api, owner, [{ roleCode: 'PURCHASING' }]);
  receiver = await addMember(api, owner, [{ roleCode: 'WAREHOUSE_STAFF' }]);
  const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: owner.accessToken })).body;
  warehouseId = warehouse.id;
  await call(api, 'POST', '/api/v1/units', { token: owner.accessToken, body: { code: 'PCS', name: 'ชิ้น' } });
  boxUnitId = (
    await call(api, 'POST', '/api/v1/units', { token: owner.accessToken, body: { code: 'BOX', name: 'ลัง' } })
  ).body.id;
  supplierId = (
    await call(api, 'POST', '/api/v1/suppliers', {
      token: owner.accessToken,
      body: { code: 'SUP1', name: 'ซัพพลายเออร์ หนึ่ง' },
    })
  ).body.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createVariant(): Promise<{ productId: string; variantId: string }> {
  const units = (await call(api, 'GET', '/api/v1/units', { token: owner.accessToken })).body as {
    id: string;
    code: string;
  }[];
  const pcs = units.find((u) => u.code === 'PCS')!.id;
  const tag = uuidv7().slice(-8).toUpperCase();
  const res = await call(api, 'POST', '/api/v1/products', {
    token: owner.accessToken,
    body: { code: `P-${tag}`, name: `Product ${tag}`, baseUnitId: pcs, variants: [{ sku: `S-${tag}` }] },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { productId: res.body.id, variantId: res.body.variants[0].id };
}

async function balance(variantId: string) {
  const res = await call(
    api,
    'GET',
    `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouseId}`,
    {
      token: owner.accessToken,
    },
  );
  return res.body.data[0] as { onHand: string; incoming: string; available: string } | undefined;
}

async function avgCost(variantId: string): Promise<string | undefined> {
  const { rows } = await tenantTx(db.app, owner.tenantId, (tx) =>
    sql<{ avg_cost: string }>`select avg_cost from variant_costs where variant_id = ${variantId}`.execute(tx),
  );
  return rows[0]?.avg_cost;
}

async function createPo(items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const res = await call(api, 'POST', '/api/v1/purchases', {
    token: owner.accessToken,
    body: { supplierId, warehouseId, items, ...extra },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function step(path: string, po: { id: string; version: number }, token = owner.accessToken) {
  return call(api, 'POST', `/api/v1/purchases/${po.id}/${path}`, {
    token,
    headers: { 'if-match': `"v${po.version}"` },
    body: {},
  });
}

async function approvedPo(items: Record<string, unknown>[]) {
  const po = await createPo(items);
  const submitted = await step('submit', po);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  const approved = await step('approve', submitted.body, approver.accessToken);
  expect(approved.status, JSON.stringify(approved.body)).toBe(201);
  return approved.body;
}

function receive(
  poId: string,
  lines: Record<string, unknown>[],
  key = uuidv7(),
  token = receiver.accessToken,
) {
  return call(api, 'POST', `/api/v1/purchases/${poId}/receipts`, {
    token,
    headers: { 'idempotency-key': key },
    body: { lines },
  });
}

describe('purchase orders', () => {
  it('computes totals with discount and VAT', async () => {
    const { variantId } = await createVariant();
    const po = await createPo([{ variantId, orderedQty: '10', unitCost: '100', discountAmount: '50' }]);
    expect(po).toMatchObject({
      status: 'DRAFT',
      subtotal: '1000.00',
      discountTotal: '50.00',
      taxTotal: '66.50',
      grandTotal: '1016.50',
    });
    expect(po.docNo).toMatch(/^PO-\d{4}-\d{6}$/);
  });

  it('approval books INCOMING; partial receipts move it to ON_HAND and update the average cost', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '100', unitCost: '10' }]);
    expect(po.status).toBe('APPROVED');
    expect(await balance(variantId)).toMatchObject({ onHand: '0.000', incoming: '100.000' });

    const first = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '60' }]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: 'PARTIALLY_RECEIVED', items: [{ receivedQty: '60.000' }] });
    expect(await balance(variantId)).toMatchObject({ onHand: '60.000', incoming: '40.000' });
    expect(await avgCost(variantId)).toBe('10.0000');

    const second = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '40' }]);
    expect(second.body).toMatchObject({ status: 'RECEIVED', items: [{ outstandingQty: '0.000' }] });
    expect(second.body.receipts).toHaveLength(2);
    expect(await balance(variantId)).toMatchObject({ onHand: '100.000', incoming: '0.000' });
  });

  it('receives in base units for a PO ordered in boxes, at the per-piece cost', async () => {
    const { productId, variantId } = await createVariant();
    const conv = await call(api, 'POST', `/api/v1/products/${productId}/units`, {
      token: owner.accessToken,
      body: { unitId: boxUnitId, factorToBase: '12', isPurchaseUnit: true },
    });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const po = await approvedPo([{ variantId, unitId: boxUnitId, orderedQty: '5', unitCost: '120' }]);
    expect(await balance(variantId)).toMatchObject({ incoming: '60.000' });
    const res = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '60' }]);
    expect(res.body.status).toBe('RECEIVED');
    expect(await avgCost(variantId)).toBe('10.0000');
  });

  it('rejects receiving more than is outstanding', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '5', unitCost: '1' }]);
    const res = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '6' }]);
    expect(res).toMatchObject({ status: 422, body: { code: 'OVER_RECEIVE' } });
    expect(await balance(variantId)).toMatchObject({ onHand: '0.000', incoming: '5.000' });
  });

  it('closing short cancels the outstanding INCOMING', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '10', unitCost: '5' }]);
    const partial = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '4' }]);
    const closed = await step('close', partial.body, approver.accessToken);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      items: [{ cancelledQty: '6.000', outstandingQty: '0.000' }],
    });
    expect(await balance(variantId)).toMatchObject({ onHand: '4.000', incoming: '0.000' });
  });

  it('cancelling an approved PO releases its INCOMING; receipts are then refused', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '7', unitCost: '5' }]);
    const cancelled = await step('cancel', po);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await balance(variantId)).toMatchObject({ incoming: '0.000' });
    const res = await receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '1' }]);
    expect(res).toMatchObject({ status: 422, body: { code: 'INVALID_STATE_TRANSITION' } });
  });

  it('the creator cannot approve their own PO, and a stale If-Match is refused', async () => {
    const { variantId } = await createVariant();
    const po = await createPo([{ variantId, orderedQty: '1', unitCost: '1' }]);
    const submitted = await step('submit', po);
    const self = await step('approve', submitted.body);
    expect(self).toMatchObject({ status: 403, body: { code: 'PRIVILEGE_ESCALATION' } });
    const stale = await step('approve', po, approver.accessToken);
    expect(stale).toMatchObject({ status: 412, body: { code: 'PRECONDITION_FAILED' } });
    const rejected = await step('reject', submitted.body, approver.accessToken);
    expect(rejected.body.status).toBe('DRAFT');
  });

  it('a warehouse clerk can receive but not create or approve', async () => {
    const { variantId } = await createVariant();
    const create = await call(api, 'POST', '/api/v1/purchases', {
      token: receiver.accessToken,
      body: { supplierId, warehouseId, items: [{ variantId, orderedQty: '1', unitCost: '1' }] },
    });
    expect(create.status).toBe(403);
  });

  it('replays a receipt with the same Idempotency-Key, even when sent concurrently', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '50', unitCost: '2' }]);
    const key = uuidv7();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '10' }], key),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await balance(variantId)).toMatchObject({ onHand: '10.000', incoming: '40.000' });
    const final = await call(api, 'GET', `/api/v1/purchases/${po.id}`, { token: owner.accessToken });
    expect(final.body.receipts).toHaveLength(1);
  });

  it('concurrent distinct receipts never over-receive a line', async () => {
    const { variantId } = await createVariant();
    const po = await approvedPo([{ variantId, orderedQty: '30', unitCost: '2' }]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receive(po.id, [{ purchaseItemId: po.items[0].id, quantity: '10' }])),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.code !== undefined)).toBe(true);
    expect(await balance(variantId)).toMatchObject({ onHand: '30.000', incoming: '0.000' });
  });

  it('reports supplier performance', async () => {
    const { variantId } = await createVariant();
    const supplier = (
      await call(api, 'POST', '/api/v1/suppliers', {
        token: owner.accessToken,
        body: { code: `SUP-${uuidv7().slice(-6).toUpperCase()}`, name: 'Perf supplier' },
      })
    ).body;
    const po = await createPo([{ variantId, orderedQty: '10', unitCost: '3' }], {
      supplierId: supplier.id,
      expectedAt: '2099-01-01',
    });
    const submitted = await step('submit', po);
    const approved = await step('approve', submitted.body, approver.accessToken);
    await receive(approved.body.id, [{ purchaseItemId: approved.body.items[0].id, quantity: '8' }]);
    const perf = await call(api, 'GET', `/api/v1/suppliers/${supplier.id}/performance`, {
      token: owner.accessToken,
    });
    expect(perf.body).toMatchObject({
      purchaseOrders: 1,
      receivedOrders: 1,
      onTimeRate: '1.0000',
      fillRate: '0.8000',
      totalSpend: '32.10',
    });
  });
});

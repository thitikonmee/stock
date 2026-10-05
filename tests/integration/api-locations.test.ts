import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@stockos/shared';
import { addMember, call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let owner: SignedUpTenant;
let clerk: Awaited<ReturnType<typeof addMember>>;
let wh: string;
let pcs: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await createTestApi(db);
  owner = await signup(api, 'Bins');
  clerk = await addMember(api, owner, [{ roleCode: 'WAREHOUSE_STAFF' }]);
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
    body: { code: `B-${tag}`, name: `Bin ${tag}`, baseUnitId: pcs, variants: [{ sku: `B-${tag}` }] },
  });
  const variantId = product.body.variants[0].id as string;
  await call(api, 'POST', '/api/v1/inventory/receive', {
    token: owner.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: { lines: [{ warehouseId: wh, variantId, quantity: qty }] },
  });
  return variantId;
}

async function loc(body: Record<string, unknown>) {
  const res = await call(api, 'POST', `/api/v1/warehouses/${wh}/locations`, {
    token: owner.accessToken,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function move(lines: unknown[], token = clerk.accessToken) {
  return call(api, 'POST', `/api/v1/warehouses/${wh}/locations/moves`, { token, body: { lines } });
}

describe('warehouse locations', () => {
  let binA: string;
  let binB: string;

  beforeAll(async () => {
    const zone = await loc({ level: 'ZONE', code: 'a' });
    const rack = await loc({ level: 'RACK', code: '01', parentId: zone.id });
    const shelf = await loc({ level: 'SHELF', code: '03', parentId: rack.id });
    binA = (await loc({ level: 'BIN', code: '1', parentId: shelf.id })).id;
    binB = (await loc({ level: 'BIN', code: '2', parentId: shelf.id })).id;
  });

  it('builds the zone > rack > shelf > bin hierarchy with full codes', async () => {
    const res = await call(api, 'GET', `/api/v1/warehouses/${wh}/locations`, { token: clerk.accessToken });
    expect(res.body.map((l: { fullCode: string }) => l.fullCode)).toEqual([
      'A',
      'A-01',
      'A-01-03',
      'A-01-03-1',
      'A-01-03-2',
    ]);
  });

  it('rejects an invalid hierarchy and duplicate codes', async () => {
    expect(
      (
        await call(api, 'POST', `/api/v1/warehouses/${wh}/locations`, {
          token: owner.accessToken,
          body: { level: 'BIN', code: 'X' },
        })
      ).status,
    ).toBe(400);
    const dup = await call(api, 'POST', `/api/v1/warehouses/${wh}/locations`, {
      token: owner.accessToken,
      body: { level: 'ZONE', code: 'A' },
    });
    expect(dup).toMatchObject({ status: 409, body: { code: 'DUPLICATE' } });
    expect(
      (
        await call(api, 'POST', `/api/v1/warehouses/${wh}/locations`, {
          token: clerk.accessToken,
          body: { level: 'ZONE', code: 'Z' },
        })
      ).status,
    ).toBe(403);
  });

  it('puts away, moves and picks; bins never claim more than the warehouse holds', async () => {
    const v = await stocked('10');
    expect((await move([{ variantId: v, quantity: '7', toLocationId: binA }])).status).toBe(201);
    const tooMuch = await move([{ variantId: v, quantity: '4', toLocationId: binB }]);
    expect(tooMuch).toMatchObject({ status: 422, body: { code: 'LOCATION_STOCK_INSUFFICIENT' } });

    await move([{ variantId: v, quantity: '2', fromLocationId: binA, toLocationId: binB }]);
    const stock = await call(api, 'GET', `/api/v1/warehouses/${wh}/locations/stock?variantId=${v}`, {
      token: clerk.accessToken,
    });
    expect(stock.body.map((s: { fullCode: string; onHand: string }) => [s.fullCode, s.onHand])).toEqual([
      ['A-01-03-1', '5.000'],
      ['A-01-03-2', '2.000'],
    ]);

    const pick = await call(
      api,
      'GET',
      `/api/v1/warehouses/${wh}/locations/pick-suggestions?variantId=${v}&quantity=6`,
      {
        token: clerk.accessToken,
      },
    );
    expect(pick.body).toEqual({
      suggestions: [
        { locationId: binA, fullCode: 'A-01-03-1', quantity: '5.000' },
        { locationId: binB, fullCode: 'A-01-03-2', quantity: '1.000' },
      ],
      shortfall: '0.000',
    });

    const overPick = await move([{ variantId: v, quantity: '6', fromLocationId: binA }]);
    expect(overPick.status).toBe(422);
    expect((await move([{ variantId: v, quantity: '5', fromLocationId: binA }])).status).toBe(201);

    const disc = await call(api, 'GET', `/api/v1/warehouses/${wh}/locations/discrepancies`, {
      token: clerk.accessToken,
    });
    expect(disc.body.find((d: { variantId: string }) => d.variantId === v)).toMatchObject({
      warehouseOnHand: '10.000',
      locatedOnHand: '2.000',
      unlocated: '8.000',
    });
  });

  it('concurrent putaways cannot over-assign the same unlocated stock', async () => {
    const v = await stocked('10');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        move([{ variantId: v, quantity: '1', toLocationId: i % 2 ? binA : binB }]),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    const stock = await call(api, 'GET', `/api/v1/warehouses/${wh}/locations/stock?variantId=${v}`, {
      token: clerk.accessToken,
    });
    const total = stock.body.reduce((s: number, r: { onHand: string }) => s + Number(r.onHand), 0);
    expect(total).toBe(10);
  });

  it('a bin with stock cannot be deactivated', async () => {
    const v = await stocked('1');
    await move([{ variantId: v, quantity: '1', toLocationId: binB }]);
    const res = await call(api, 'PATCH', `/api/v1/warehouses/${wh}/locations/${binB}`, {
      token: owner.accessToken,
      body: { isActive: false },
    });
    expect(res).toMatchObject({ status: 422, body: { code: 'LOCATION_NOT_EMPTY' } });
  });
});

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantTx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import {
  addMember,
  call,
  createTestApi,
  registerDevice,
  setUpCashier,
  signup,
  type Api,
  type SignedUpTenant,
} from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * docs/15 Phase 9 DoD: "นับ stock 5,000 SKU ด้วยมือถือ 3 เครื่องพร้อมกันระหว่างเปิดขาย → variance ถูกต้อง".
 *
 * 5,000 SKUs with 100 on hand each. Three counting devices work through disjoint shards at the same
 * time while the POS keeps selling: for every chunk a device counts, some SKUs were sold just
 * before the shelf was counted (must NOT show up as variance) and some right after (must not
 * either), and a few SKUs are really short by one (must show up as exactly −1). After approval
 * every SKU's on_hand must equal what is physically left.
 */
const SKUS = 5000;
const DEVICES = 3;
const CHUNK = 100;
const PRICE = 10;

const soldBefore = (i: number) => i % 3;
const soldAfter = (i: number) => (i % 5 === 0 ? 1 : 0);
const shrink = (i: number) => (i % 97 === 0 ? 1 : 0);

let db: TestDatabase;
let api: Api;
let owner: SignedUpTenant;
let warehouseId: string;
let variantIds: string[];
let cashierToken: string;
let pos: { deviceId: string; shiftId: string };
let counters: string[];

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: 30 });
  api = await createTestApi(db);
  owner = await signup(api, 'CountDoD');
  const [branch] = (await call(api, 'GET', '/api/v1/branches', { token: owner.accessToken })).body;
  const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: owner.accessToken })).body;
  warehouseId = warehouse.id;
  const unitId = (
    await call(api, 'POST', '/api/v1/units', {
      token: owner.accessToken,
      body: { code: 'PCS', name: 'ชิ้น' },
    })
  ).body.id as string;

  // Catalog seeded in bulk (the catalog itself is not under test here); stock goes in through the API.
  await tenantTx(db.app, owner.tenantId, async (tx) => {
    await sql`
      insert into products (tenant_id, id, code, name, base_unit_id)
      select ${owner.tenantId}, uuid_generate_v7(), 'DOD-' || lpad(g::text, 5, '0'), 'DoD item ' || g, ${unitId}
        from generate_series(1, ${SKUS}) g`.execute(tx);
    await sql`
      insert into product_variants (tenant_id, id, product_id, sku, name, selling_price)
      select p.tenant_id, uuid_generate_v7(), p.id, p.code, p.name, ${PRICE} from products p
       where p.code like 'DOD-%'`.execute(tx);
  });
  const { rows } = await tenantTx(db.app, owner.tenantId, (tx) =>
    sql<{ id: string }>`select id from product_variants where sku like 'DOD-%' order by sku`.execute(tx),
  );
  variantIds = rows.map((r) => r.id);
  expect(variantIds).toHaveLength(SKUS);

  for (let i = 0; i < SKUS; i += 500) {
    const res = await call(api, 'POST', '/api/v1/inventory/receive', {
      token: owner.accessToken,
      headers: { 'idempotency-key': `dod-seed-${i}` },
      body: {
        lines: variantIds.slice(i, i + 500).map((variantId) => ({ warehouseId, variantId, quantity: '100' })),
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  const device = await registerDevice(api, owner, { branchId: branch.id, warehouseId });
  const cashier = await addMember(api, owner, [{ roleCode: 'CASHIER' }]);
  await setUpCashier(api, owner, cashier.membershipId, cashier.accessToken);
  cashierToken = cashier.accessToken;
  const shift = await call(api, 'POST', '/api/v1/pos/shifts', {
    token: cashierToken,
    body: { posDeviceId: device.id, openingCash: '0.00' },
  });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  pos = { deviceId: device.id, shiftId: shift.body.id };

  counters = [];
  for (let d = 0; d < DEVICES; d++) {
    counters.push((await addMember(api, owner, [{ roleCode: 'WAREHOUSE_STAFF' }])).accessToken);
  }
}, 600_000);

afterAll(async () => {
  await api.close();
  await db.drop();
});

async function sell(lines: { variantId: string; quantity: number }[]) {
  if (lines.length === 0) return;
  const total = (lines.reduce((s, l) => s + l.quantity, 0) * PRICE).toFixed(2);
  const res = await call(api, 'POST', '/api/v1/pos/sales', {
    token: cashierToken,
    body: {
      posDeviceId: pos.deviceId,
      shiftId: pos.shiftId,
      clientTxnId: uuidv7(),
      lines: lines.map((l) => ({ variantId: l.variantId, quantity: String(l.quantity) })),
      payments: [{ method: 'CASH', amount: total, tenderedAmount: total }],
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

describe('Phase 9 DoD: 5,000-SKU count on 3 devices while the POS keeps selling', () => {
  it('every variance is exact and on_hand ends at what is really on the shelf', async () => {
    const started = await call(api, 'POST', '/api/v1/inventory/counts', {
      token: counters[0],
      body: { warehouseId, countType: 'FULL' },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const countId = started.body.id as string;
    expect(started.body.totals.items).toBe(SKUS);

    const device = async (d: number) => {
      const shard = variantIds.map((v, i) => ({ v, i })).filter(({ i }) => i % DEVICES === d);
      for (let c = 0; c < shard.length; c += CHUNK) {
        const chunk = shard.slice(c, c + CHUNK);
        // Customers buy from these shelves just before the counter reaches them ...
        await sell(
          chunk
            .filter(({ i }) => soldBefore(i) > 0)
            .map(({ v, i }) => ({ variantId: v, quantity: soldBefore(i) })),
        );
        // ... the counter records what is physically there ...
        const recorded = await call(api, 'POST', `/api/v1/inventory/counts/${countId}/lines`, {
          token: counters[d],
          body: {
            mode: 'SET',
            lines: chunk.map(({ v, i }) => ({
              variantId: v,
              quantity: String(100 - soldBefore(i) - shrink(i)),
            })),
          },
        });
        expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
        // ... and sales carry on afterwards.
        await sell(
          chunk
            .filter(({ i }) => soldAfter(i) > 0)
            .map(({ v, i }) => ({ variantId: v, quantity: soldAfter(i) })),
        );
      }
    };
    await Promise.all(Array.from({ length: DEVICES }, (_, d) => device(d)));

    const before = await call(api, 'GET', `/api/v1/inventory/counts/${countId}`, {
      token: owner.accessToken,
    });
    const submitted = await call(api, 'POST', `/api/v1/inventory/counts/${countId}/submit`, {
      token: counters[0],
      headers: { 'if-match': `"v${before.body.version}"` },
      body: {},
    });
    expect(submitted.status, JSON.stringify(submitted.body).slice(0, 500)).toBe(201);

    const expectedShort = variantIds.filter((_, i) => shrink(i) > 0).length;
    expect(submitted.body.totals).toMatchObject({ items: SKUS, counted: SKUS, withVariance: expectedShort });
    const index = new Map(variantIds.map((v, i) => [v, i]));
    const wrong = (
      submitted.body.items as { variantId: string; variance: string; movementSinceSnapshot: string }[]
    )
      .filter((it) => {
        const i = index.get(it.variantId)!;
        return Number(it.variance) !== -shrink(i) || Number(it.movementSinceSnapshot) !== -soldBefore(i);
      })
      .slice(0, 5);
    expect(wrong).toEqual([]);

    const approved = await call(api, 'POST', `/api/v1/inventory/counts/${countId}/approve`, {
      token: owner.accessToken,
      headers: { 'if-match': `"v${submitted.body.version}"` },
      body: {},
    });
    expect(approved.status, JSON.stringify(approved.body).slice(0, 500)).toBe(201);

    const { rows } = await tenantTx(db.app, owner.tenantId, (tx) =>
      sql<{ variant_id: string; on_hand: string }>`
        select variant_id, on_hand from inventory_balances where warehouse_id = ${warehouseId}`.execute(tx),
    );
    const onHand = new Map(rows.map((r) => [r.variant_id, Number(r.on_hand)]));
    const mismatched = variantIds
      .map((v, i) => ({ i, expected: 100 - soldBefore(i) - soldAfter(i) - shrink(i), actual: onHand.get(v) }))
      .filter((x) => x.actual !== x.expected)
      .slice(0, 5);
    expect(mismatched).toEqual([]);
  });
});

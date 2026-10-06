import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { tenantTx } from '@stockos/database';
import { uuidv7 } from '@stockos/shared';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * docs/15 Phase 9 test "allocation concurrency": a shop's CHANNEL_ALLOCATION quota must hold no
 * matter how its own orders and everybody else's interleave. 30 in stock, 20 allocated to Shopee;
 * 25 Shopee orders (signed webhooks) and 30 manual orders, 1 unit each, all fired at once — the
 * manual side alone could take all 30 units if the quota weren't enforced.
 */
const STOCK = 30;
/** Large on purpose: unguarded, the (faster) manual side wins about two thirds of the races, so a
 *  quota this size is only met if the engine really keeps it out of everyone else's reach. */
const QUOTA = 20;
const SHOPEE_ORDERS = 25;
/** Enough to empty the whole shelf on their own if the quota weren't enforced. */
const MANUAL_ORDERS = 30;
const PARTNER_KEY = 'allocation_concurrency_key';
const WEBHOOK_URL = 'https://api.stockos.test/api/v1/webhooks/shopee';
const SHOP_ID = 820001;

let db: TestDatabase;
let api: Api;
let fixture: channels.ShopeeFixtureServer;
let t: SignedUpTenant;
let warehouseId: string;
let variantId: string;
let accountId: string;

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: SHOPEE_ORDERS + MANUAL_ORDERS });
  fixture = new channels.ShopeeFixtureServer();
  api = await createTestApi(
    db,
    {},
    {
      shopee: {
        partnerId: '2000000',
        partnerKey: PARTNER_KEY,
        baseUrl: 'https://partner.shopeemobile.test',
        fetcher: fixture.fetcher(),
      },
    },
  );
  t = await signup(api, 'AllocConcurrency');
  warehouseId = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body[0].id;
  const unitId = (
    await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'PCS', name: 'ชิ้น' } })
  ).body.id;
  const product = await call(api, 'POST', '/api/v1/products', {
    token: t.accessToken,
    body: {
      code: 'ALC-1',
      name: 'Allocated widget',
      baseUnitId: unitId,
      variants: [{ sku: 'ALC-1', sellingPrice: '100' }],
    },
  });
  variantId = product.body.variants[0].id;
  await call(api, 'POST', '/api/v1/inventory/receive', {
    token: t.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: { lines: [{ warehouseId, variantId, quantity: String(STOCK) }] },
  });

  const connect = await call(api, 'POST', '/api/v1/channels/shopee/connect', { token: t.accessToken });
  fixture.issuedShopId = SHOP_ID;
  const cb = await call(
    api,
    'GET',
    `/api/v1/channels/shopee/callback?state=${encodeURIComponent(connect.body.state)}&code=x&shop_id=${SHOP_ID}`,
  );
  accountId = new URL(String(cb.headers.location), 'https://x.test').searchParams.get('connected')!;
  await call(api, 'PUT', `/api/v1/channel-accounts/${accountId}/default-warehouse`, {
    token: t.accessToken,
    body: { warehouseId },
  });
  fixture.addProduct({
    itemId: 1,
    name: 'Allocated widget',
    status: 'NORMAL',
    variants: [{ modelId: 1, modelSku: 'ALC-1', name: 'Default', price: 100, stock: 0 }],
  });
  await call(api, 'POST', `/api/v1/channel-accounts/${accountId}/mappings/import`, { token: t.accessToken });
  const alloc = await call(api, 'PUT', `/api/v1/channel-accounts/${accountId}/allocations`, {
    token: t.accessToken,
    body: { lines: [{ variantId, allocatedQty: String(QUOTA) }] },
  });
  expect(alloc.status, JSON.stringify(alloc.body)).toBe(200);
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

function shopeeOrder(n: number) {
  const now = Math.floor(Date.now() / 1000);
  const orderSn = `ALC-SN-${n}`;
  fixture.addOrder({
    orderSn,
    status: 'READY_TO_SHIP',
    updateTime: now,
    createTime: now - 10,
    items: [{ itemId: 1, modelId: 1, sku: 'ALC-1', name: 'Allocated widget', quantity: 1, price: 100 }],
    total: 100,
  });
  const body = {
    shop_id: SHOP_ID,
    code: 3,
    timestamp: now,
    data: { ordersn: orderSn, status: 'READY_TO_SHIP' },
  };
  const signature = createHmac('sha256', PARTNER_KEY)
    .update(`${WEBHOOK_URL}|${JSON.stringify(body)}`, 'utf8')
    .digest('hex');
  return () => call(api, 'POST', '/api/v1/webhooks/shopee', { body, headers: { authorization: signature } });
}

function manualOrder() {
  return () =>
    call(api, 'POST', '/api/v1/orders', {
      token: t.accessToken,
      headers: { 'idempotency-key': uuidv7() },
      body: { channelCode: 'API', warehouseId, paid: false, lines: [{ variantId, quantity: '1' }] },
    });
}

describe('CHANNEL_ALLOCATION under concurrency', () => {
  it("a shop's quota survives any interleaving with other channels' orders", async () => {
    const shopee = Array.from({ length: SHOPEE_ORDERS }, (_, n) => shopeeOrder(n));
    const manual = Array.from({ length: MANUAL_ORDERS }, () => manualOrder());
    // Interleave the two sides so neither gets a head start.
    const burst = manual.flatMap((m, i) => (shopee[i] ? [shopee[i]!, m] : [m]));
    const results = await Promise.all(burst.map((send) => send()));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);

    const { shopeeHeld, manualHeld, consumed, allocated, onHand, reserved, committed } = await tenantTx(
      db.app,
      t.tenantId,
      async (tx) => {
        const holds = await sql<{ shopee: number; manual: number }>`
          select (count(*) filter (where channel_account_id = ${accountId}))::int as shopee,
                 (count(*) filter (where channel_account_id is null))::int as manual
            from inventory_reservations
           where variant_id = ${variantId} and status in ('RESERVED', 'COMMITTED')`.execute(tx);
        const quota = await sql<{ consumed_qty: string; allocated_qty: string }>`
          select consumed_qty, allocated_qty from channel_allocations where channel_account_id = ${accountId}`.execute(
          tx,
        );
        const bal = await sql<{ on_hand: string; reserved: string; committed: string }>`
          select on_hand, reserved, committed from inventory_balances
           where warehouse_id = ${warehouseId} and variant_id = ${variantId}`.execute(tx);
        return {
          shopeeHeld: holds.rows[0]!.shopee,
          manualHeld: holds.rows[0]!.manual,
          consumed: Number(quota.rows[0]!.consumed_qty),
          allocated: Number(quota.rows[0]!.allocated_qty),
          onHand: Number(bal.rows[0]!.on_hand),
          reserved: Number(bal.rows[0]!.reserved),
          committed: Number(bal.rows[0]!.committed),
        };
      },
    );

    // Shopee always gets at least its quota, whatever the interleaving.
    expect(shopeeHeld).toBeGreaterThanOrEqual(QUOTA);
    // Nobody oversold and the books balance.
    expect(shopeeHeld + manualHeld).toBeLessThanOrEqual(STOCK);
    expect(reserved + committed).toBe(shopeeHeld + manualHeld);
    expect(onHand).toBe(STOCK);
    // Consumption tracks Shopee's own holds up to the quota (anything beyond came from the pool).
    expect(allocated).toBe(QUOTA);
    expect(consumed).toBe(Math.min(QUOTA, shopeeHeld));
    // Manual orders never dipped into what is still reserved for Shopee.
    expect(manualHeld).toBeLessThanOrEqual(STOCK - shopeeHeld - (QUOTA - consumed));
    // Stock was scarce (55 wanted, 30 exist): the burst really competed.
    expect(shopeeHeld + manualHeld).toBe(STOCK);
  });
});

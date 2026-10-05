import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { uuidv7 } from '@stockos/shared';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let wh: string;
let pcs: string;
let fixture: channels.ShopeeFixtureServer;
let accountId: string;
let variantId: string;
// Fixture update_time must stay in the past (the poller pulls up to "now"), yet strictly increase.
let orderClock = Math.floor(Date.now() / 1000) - 600;
const knownOrders = new Set<string>();

beforeAll(async () => {
  db = await createTestDatabase();
  fixture = new channels.ShopeeFixtureServer();
  api = await createTestApi(
    db,
    {},
    {
      shopee: {
        partnerId: '2000000',
        partnerKey: 'alloc_test_key',
        baseUrl: 'https://partner.shopeemobile.test',
        fetcher: fixture.fetcher(),
      },
    },
  );
  t = await signup(api, 'Alloc');
  wh = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body[0].id;
  pcs = (
    await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'PCS', name: 'ชิ้น' } })
  ).body.id;

  const connect = await call(api, 'POST', '/api/v1/channels/shopee/connect', { token: t.accessToken });
  fixture.issuedShopId = 810001;
  const cb = await call(
    api,
    'GET',
    `/api/v1/channels/shopee/callback?state=${encodeURIComponent(connect.body.state)}&code=x&shop_id=810001`,
  );
  accountId = new URL(String(cb.headers.location), 'https://x.test').searchParams.get('connected')!;
  await call(api, 'PUT', `/api/v1/channel-accounts/${accountId}/default-warehouse`, {
    token: t.accessToken,
    body: { warehouseId: wh },
  });

  const product = await call(api, 'POST', '/api/v1/products', {
    token: t.accessToken,
    body: {
      code: 'ALLOC-1',
      name: 'Allocated',
      baseUnitId: pcs,
      variants: [{ sku: 'ALLOC-1', sellingPrice: '100' }],
    },
  });
  variantId = product.body.variants[0].id;
  await call(api, 'POST', '/api/v1/inventory/receive', {
    token: t.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: { lines: [{ warehouseId: wh, variantId, quantity: '100' }] },
  });
  fixture.addProduct({
    itemId: 9101,
    name: 'Allocated',
    status: 'NORMAL',
    variants: [{ modelId: 1, modelSku: 'ALLOC-1', name: 'Default', price: 100, stock: 0 }],
  });
  await call(api, 'POST', `/api/v1/channel-accounts/${accountId}/mappings/import`, { token: t.accessToken });
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

function allocate(qty: string) {
  return call(api, 'PUT', `/api/v1/channel-accounts/${accountId}/allocations`, {
    token: t.accessToken,
    body: { lines: [{ variantId, allocatedQty: qty }] },
  });
}

async function quota() {
  return (
    await call(api, 'GET', `/api/v1/channel-accounts/${accountId}/allocations`, { token: t.accessToken })
  ).body[0];
}

function manualOrder(quantity: string) {
  return call(api, 'POST', '/api/v1/orders', {
    token: t.accessToken,
    headers: { 'idempotency-key': uuidv7() },
    body: { channelCode: 'API', warehouseId: wh, paid: false, lines: [{ variantId, quantity }] },
  });
}

async function pushedStock(): Promise<number> {
  fixture.stockPushLog.length = 0;
  const res = await call(api, 'POST', `/api/v1/channel-accounts/${accountId}/sync/stock`, {
    token: t.accessToken,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return fixture.stockPushLog.find((p) => p.itemId === 9101)!.stock;
}

async function shopeeOrder(orderSn: string, status: string, quantity: number) {
  orderClock += 10;
  if (!knownOrders.has(orderSn)) {
    knownOrders.add(orderSn);
    fixture.addOrder({
      orderSn,
      status,
      updateTime: orderClock,
      createTime: orderClock - 50,
      items: [{ itemId: 9101, modelId: 1, sku: 'ALLOC-1', name: 'Allocated', quantity, price: 100 }],
      total: 100 * quantity,
    });
  } else {
    fixture.setOrderStatus(orderSn, status, orderClock);
  }
  const res = await call(api, 'POST', `/api/v1/channel-accounts/${accountId}/sync/orders`, {
    token: t.accessToken,
  });
  expect(res.body.output, JSON.stringify(res.body)).toMatchObject({ failed: 0 });
}

describe('channel allocation', () => {
  it('refuses to allocate more than is free', async () => {
    const res = await allocate('101');
    expect(res).toMatchObject({ status: 422, body: { code: 'OVER_ALLOCATED' } });
  });

  it('keeps the quota out of reach of other sales channels', async () => {
    const res = await allocate('30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]).toMatchObject({
      allocatedQty: '30.000',
      consumedQty: '0.000',
      unallocatedQty: '70.000',
    });

    const tooMuch = await manualOrder('71');
    expect(tooMuch).toMatchObject({ status: 409, body: { code: 'STOCK_INSUFFICIENT' } });
    const ok = await manualOrder('70');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await quota()).toMatchObject({ remainingQty: '30.000', unallocatedQty: '0.000' });

    // Release that manual order so later tests start from 100 free again.
    const cancel = await call(api, 'POST', `/api/v1/orders/${ok.body.id}/cancel`, {
      token: t.accessToken,
      body: { reason: 'test' },
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(201);
  });

  it('GLOBAL_POOL pushes everything not allocated elsewhere; CHANNEL_ALLOCATION pushes only its quota', async () => {
    expect(await pushedStock()).toBe(100); // own quota is still sellable by this shop under GLOBAL_POOL
    const policy = await call(api, 'PUT', '/api/v1/channel-stock-policies', {
      token: t.accessToken,
      body: { channelAccountId: accountId, strategy: 'CHANNEL_ALLOCATION' },
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    expect(await pushedStock()).toBe(30);
  });

  it("a marketplace order consumes its shop's quota and a cancellation gives it back", async () => {
    await shopeeOrder('ALLOC-SN1', 'READY_TO_SHIP', 4);
    expect(await quota()).toMatchObject({ consumedQty: '4.000', remainingQty: '26.000' });
    expect(await pushedStock()).toBe(26);

    await shopeeOrder('ALLOC-SN1', 'CANCELLED', 4);
    expect(await quota()).toMatchObject({ consumedQty: '0.000', remainingQty: '30.000' });
  });

  it('cannot lower a quota below what was already consumed', async () => {
    await shopeeOrder('ALLOC-SN2', 'READY_TO_SHIP', 5);
    const res = await allocate('3');
    expect(res).toMatchObject({ status: 422, body: { code: 'ALLOCATION_BELOW_CONSUMED' } });
  });
});

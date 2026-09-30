import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const APP_KEY = 'tiktok_test_app_key';
const APP_SECRET = 'tiktok_test_app_secret';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let warehouseId: string;
let fixture: channels.TikTokFixtureServer;
let channelAccountId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  fixture = new channels.TikTokFixtureServer();
  api = await createTestApi(
    db,
    {},
    {
      tiktok: {
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        apiBaseUrl: 'https://open-api.tiktok.test',
        authBaseUrl: 'https://auth.tiktok.test',
        fetcher: fixture.fetcher(),
      },
    },
  );
  t = await signup(api, 'ChannelsTikTok');
  const [w] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;
  warehouseId = w.id;
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

async function createVariant(sku: string, qty = '10') {
  const unit = (
    await call(api, 'POST', '/api/v1/units', {
      token: t.accessToken,
      body: { code: `U${Date.now()}`, name: 'U' },
    })
  ).body;
  const product = (
    await call(api, 'POST', '/api/v1/products', {
      token: t.accessToken,
      body: {
        code: `P-${sku}`,
        name: `Product ${sku}`,
        baseUnitId: unit.id,
        variants: [{ sku, sellingPrice: '259.00' }],
      },
    })
  ).body;
  const variantId = product.variants[0].id as string;
  await call(api, 'POST', '/api/v1/inventory/receive', {
    token: t.accessToken,
    headers: { 'idempotency-key': `recv:${variantId}` },
    body: { lines: [{ warehouseId, variantId, quantity: qty }] },
  });
  return variantId as string;
}

async function balanceOf(variantId: string) {
  return (
    await call(api, 'GET', `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouseId}`, {
      token: t.accessToken,
    })
  ).body.data[0];
}

function signWebhook(body: string): string {
  return createHmac('sha256', APP_SECRET)
    .update(APP_KEY + body, 'utf8')
    .digest('hex');
}

let capVariantId: string;
let orderIdApi: string;

describe('TikTok: proves the Phase 6 framework generalizes to a third adapter (shop_cipher + order-level status)', () => {
  it('connects via the same generic /channels/:code endpoints Shopee/Lazada use', async () => {
    const connect = await call(api, 'POST', '/api/v1/channels/tiktok/connect', { token: t.accessToken });
    expect(connect.status, JSON.stringify(connect.body)).toBe(201);
    expect(connect.body.authorizeUrl).toContain('auth.tiktok.test');

    fixture.issuedShopId = '910001';
    fixture.issuedShopCipher = 'cipher_910001';
    const cb = await call(
      api,
      'GET',
      `/api/v1/channels/tiktok/callback?state=${encodeURIComponent(connect.body.state)}&code=abc`,
    );
    expect(cb.status).toBe(302);
    channelAccountId = new URL(String(cb.headers.location), 'https://x.test').searchParams.get('connected')!;
    expect(channelAccountId).toBeTruthy();

    await call(api, 'PUT', `/api/v1/channel-accounts/${channelAccountId}/default-warehouse`, {
      token: t.accessToken,
      body: { warehouseId },
    });
  });

  it('imports products keyed by sku_id (not seller_sku), auto-mapping by seller_sku hint', async () => {
    capVariantId = await createVariant('DEMO-CAP-1');
    fixture.addProduct({
      id: '1',
      title: 'Cap',
      status: 'ACTIVATE',
      skus: [{ id: '10', sellerSku: 'DEMO-CAP-1', price: 259, stock: 18 }],
    });
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/mappings/import`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ imported: 1, autoMapped: 1 });
  });

  it('polls an order and confirms it: shop_cipher + access-token header both survive the round trip', async () => {
    fixture.addOrder({
      id: '800001',
      status: 'AWAITING_SHIPMENT',
      createTime: Math.floor((Date.now() - 3600_000) / 1000),
      updateTime: Math.floor(Date.now() / 1000),
      total: 259,
      items: [{ id: '1', productId: '1', skuId: '10', sellerSku: 'DEMO-CAP-1', name: 'Cap', price: 259 }],
    });
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/orders`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.output).toMatchObject({ pulled: 1, ingested: 1, failed: 0 });

    expect((await balanceOf(capVariantId)).committed).toBe('1.000');

    const orders = await call(api, 'GET', '/api/v1/orders?channelCode=TIKTOK', { token: t.accessToken });
    const created = orders.body.data.find((o: { grandTotal: string }) => o.grandTotal === '259.00');
    expect(created).toBeTruthy();
    expect(created.status).toBe('CONFIRMED'); // AWAITING_SHIPMENT -> CONFIRMED
    orderIdApi = created.id;
  });

  it('advances the order to SHIPPED via a correctly signed, fresh webhook', async () => {
    // +10s, not just "now" again: the initial poll's snapshot and this update could otherwise land
    // in the same wall-clock second, which `OrderIngestService` (correctly) treats as not-newer and
    // skips — a real flake the Phase 6 postmortem already hit once for the same reason.
    const updateTime = Math.floor(Date.now() / 1000) + 10;
    fixture.setOrderStatus('800001', 'IN_TRANSIT', updateTime);
    const body = JSON.stringify({
      shop_id: '910001',
      type: 'ORDER_STATUS_CHANGE',
      timestamp: Math.floor(Date.now() / 1000),
      data: { order_id: '800001', order_status: 'IN_TRANSIT', update_time: updateTime },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/tiktok', {
      body: JSON.parse(body),
      headers: { authorization: signWebhook(body) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED');

    const order = await call(api, 'GET', `/api/v1/orders/${orderIdApi}`, { token: t.accessToken });
    expect(order.body.status).toBe('SHIPPED');
    expect((await balanceOf(capVariantId)).onHand).toBe('9.000'); // 10 - 1 shipped
  });

  it('rejects a webhook with an invalid signature', async () => {
    const res = await call(api, 'POST', '/api/v1/webhooks/tiktok', {
      body: { shop_id: '910001', data: { order_id: '800001', order_status: 'DELIVERED' } },
      headers: { authorization: 'not-a-real-signature' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a correctly-signed but stale (replayed) webhook', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const body = JSON.stringify({
      shop_id: '910001',
      type: 'ORDER_STATUS_CHANGE',
      timestamp: staleTs,
      data: { order_id: '800001', order_status: 'DELIVERED', update_time: staleTs },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/tiktok', {
      body: JSON.parse(body),
      headers: { authorization: signWebhook(body) },
    });
    expect(res.status).toBe(401);

    const order = await call(api, 'GET', `/api/v1/orders/${orderIdApi}`, { token: t.accessToken });
    expect(order.body.status).toBe('SHIPPED'); // unaffected — the stale webhook never got processed
  });

  it('pushes stock for the mapped SKU', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/stock`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pushed).toBe(1);
    expect(fixture.stockPushLog.some((p) => p.skuId === '10')).toBe(true);
  });

  it('runs a reconciliation', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/reconciliation-runs`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.checkedCount).toBe(1);
  });
});

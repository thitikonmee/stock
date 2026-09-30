import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const APP_KEY = 'lazada_test_app_key';
const APP_SECRET = 'lazada_test_app_secret';

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let warehouseId: string;
let fixture: channels.LazadaFixtureServer;
let channelAccountId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  fixture = new channels.LazadaFixtureServer();
  api = await createTestApi(
    db,
    {},
    {
      lazada: {
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        apiBaseUrl: 'https://api.lazada.test/rest',
        authBaseUrl: 'https://auth.lazada.test/rest',
        fetcher: fixture.fetcher(),
      },
    },
  );
  t = await signup(api, 'ChannelsLazada');
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
        variants: [{ sku, sellingPrice: '590.00' }],
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
    .digest('hex')
    .toUpperCase();
}

let redVariantId: string;
let blueVariantId: string;
let orderIdApi: string;

describe('Lazada: proves the Phase 6 framework generalizes to a second, item-level-status adapter', () => {
  it('connects via the same generic /channels/:code endpoints Shopee uses', async () => {
    const connect = await call(api, 'POST', '/api/v1/channels/lazada/connect', { token: t.accessToken });
    expect(connect.status, JSON.stringify(connect.body)).toBe(201);
    expect(connect.body.authorizeUrl).toContain('auth.lazada.com');

    fixture.issuedSellerId = '600001';
    const cb = await call(
      api,
      'GET',
      `/api/v1/channels/lazada/callback?state=${encodeURIComponent(connect.body.state)}&code=abc`,
    );
    expect(cb.status).toBe(302);
    channelAccountId = new URL(String(cb.headers.location), 'https://x.test').searchParams.get('connected')!;
    expect(channelAccountId).toBeTruthy();

    await call(api, 'PUT', `/api/v1/channel-accounts/${channelAccountId}/default-warehouse`, {
      token: t.accessToken,
      body: { warehouseId },
    });
  });

  it('imports products and auto-maps by SellerSku through the same MappingService Shopee uses', async () => {
    redVariantId = await createVariant('BAG-RED');
    blueVariantId = await createVariant('BAG-BLUE');
    fixture.addProduct({
      itemId: 1,
      name: 'Bag',
      status: 'active',
      skus: [
        { skuId: 10, sellerSku: 'BAG-RED', price: 590, stock: 20 },
        { skuId: 11, sellerSku: 'BAG-BLUE', price: 590, stock: 6 },
      ],
    });
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/mappings/import`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ imported: 2, autoMapped: 2 });
  });

  it('polls a two-line order: both lines pending -> order CONFIRMED, both committed', async () => {
    fixture.addOrder({
      orderId: 500,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      updatedAt: new Date().toISOString(),
      total: 1180,
      items: [
        { orderItemId: 1, productId: 1, sku: 'BAG-RED', name: 'Bag Red', status: 'pending', price: 590 },
        { orderItemId: 2, productId: 1, sku: 'BAG-BLUE', name: 'Bag Blue', status: 'pending', price: 590 },
      ],
    });
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/orders`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.output).toMatchObject({ pulled: 1, ingested: 1, failed: 0 });

    expect((await balanceOf(redVariantId)).committed).toBe('1.000');
    expect((await balanceOf(blueVariantId)).committed).toBe('1.000');

    const orders = await call(api, 'GET', '/api/v1/orders?channelCode=LAZADA', { token: t.accessToken });
    const created = orders.body.data.find((o: { grandTotal: string }) => o.grandTotal === '1180.00');
    expect(created).toBeTruthy();
    expect(created.status).toBe('CONFIRMED');
    orderIdApi = created.id;
  });

  it('cancels one line via webhook: order stays CONFIRMED, only that line releases stock', async () => {
    fixture.setLineStatus(500, 2, 'canceled');
    const body = JSON.stringify({
      seller_id: '600001',
      msg_type: 'ORDER_STATUS_UPDATE',
      timestamp: Date.now(),
      data: { order_id: '500', status: 'canceled' },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/lazada', {
      body: JSON.parse(body),
      headers: { authorization: signWebhook(body) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED');

    const order = await call(api, 'GET', `/api/v1/orders/${orderIdApi}`, { token: t.accessToken });
    expect(order.body.status).toBe('CONFIRMED'); // partial cancel never advances/changes the order itself
    const blueLine = order.body.lines.find((l: { sku: string }) => l.sku === 'BAG-BLUE');
    expect(blueLine.cancelledQty).toBe('1.000');
    const redLine = order.body.lines.find((l: { sku: string }) => l.sku === 'BAG-RED');
    expect(redLine.cancelledQty).toBe('0.000');

    expect((await balanceOf(blueVariantId)).committed).toBe('0.000'); // released
    expect((await balanceOf(redVariantId)).committed).toBe('1.000'); // untouched
  });

  it('re-delivering the same cancel webhook is a no-op (idempotent)', async () => {
    const before = await balanceOf(blueVariantId);
    fixture.setLineStatus(500, 2, 'canceled', new Date(Date.now() + 1000).toISOString());
    const body = JSON.stringify({
      seller_id: '600001',
      msg_type: 'ORDER_STATUS_UPDATE',
      timestamp: Date.now() + 1,
      data: { order_id: '500', status: 'canceled' },
    });
    await call(api, 'POST', '/api/v1/webhooks/lazada', {
      body: JSON.parse(body),
      headers: { authorization: signWebhook(body) },
    });
    const after = await balanceOf(blueVariantId);
    expect(after.committed).toBe(before.committed);
    expect(after.available).toBe(before.available);
  });

  it('ships the remaining active line: fulfillment excludes the cancelled one, order advances to SHIPPED', async () => {
    fixture.setLineStatus(500, 1, 'shipped', new Date(Date.now() + 2000).toISOString());
    const body = JSON.stringify({
      seller_id: '600001',
      msg_type: 'ORDER_STATUS_UPDATE',
      timestamp: Date.now() + 2,
      data: { order_id: '500', status: 'shipped' },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/lazada', {
      body: JSON.parse(body),
      headers: { authorization: signWebhook(body) },
    });
    expect(res.body.outcome).toBe('PROCESSED');

    const order = await call(api, 'GET', `/api/v1/orders/${orderIdApi}`, { token: t.accessToken });
    expect(order.body.status).toBe('SHIPPED');

    const fulfillments = await call(api, 'GET', `/api/v1/orders/${orderIdApi}/fulfillments`, {
      token: t.accessToken,
    });
    expect(fulfillments.body).toHaveLength(1);
    expect(fulfillments.body[0].items).toHaveLength(1); // only the shipped line, not the cancelled one

    expect((await balanceOf(redVariantId)).committed).toBe('0.000');
    expect((await balanceOf(redVariantId)).onHand).toBe('9.000'); // 10 - 1 shipped
    expect((await balanceOf(blueVariantId)).onHand).toBe('10.000'); // untouched by the ship
  });

  it('rejects a webhook with an invalid signature', async () => {
    const res = await call(api, 'POST', '/api/v1/webhooks/lazada', {
      body: { seller_id: '600001', data: { order_id: '500', status: 'shipped' } },
      headers: { authorization: 'not-a-real-signature' },
    });
    expect(res.status).toBe(401);
  });

  it('pushes stock for both mapped SKUs', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/stock`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pushed).toBe(2);
    expect(fixture.stockPushLog.some((p) => p.sellerSku === 'BAG-RED')).toBe(true);
    expect(fixture.stockPushLog.some((p) => p.sellerSku === 'BAG-BLUE')).toBe(true);
  });

  it('runs a reconciliation', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/reconciliation-runs`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.checkedCount).toBe(2);
  });
});

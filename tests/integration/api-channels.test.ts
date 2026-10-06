import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const PARTNER_ID = '2000000';
const PARTNER_KEY = 'test_partner_key';
const API_BASE_URL = 'https://api.stockos.test';
const WEBHOOK_URL = `${API_BASE_URL}/api/v1/webhooks/shopee`;

let db: TestDatabase;
let api: Api;
let t: SignedUpTenant;
let warehouseId: string;
let fixture: channels.ShopeeFixtureServer;

beforeAll(async () => {
  db = await createTestDatabase();
  fixture = new channels.ShopeeFixtureServer();
  api = await createTestApi(
    db,
    {},
    {
      shopee: {
        partnerId: PARTNER_ID,
        partnerKey: PARTNER_KEY,
        baseUrl: 'https://partner.shopeemobile.test',
        fetcher: fixture.fetcher(),
      },
    },
  );
  t = await signup(api, 'Channels');
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
        variants: [{ sku, sellingPrice: '107.00' }],
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

function signWebhookBody(body: string): string {
  return createHmac('sha256', PARTNER_KEY).update(`${WEBHOOK_URL}|${body}`, 'utf8').digest('hex');
}

let channelAccountId: string;
// Shopee's `update_time` is second-resolution and our out-of-order guard is `>=` — two edits to
// the same fixture order inside one fast test run can otherwise land in the same wall-clock
// second and the second one gets (correctly) treated as not-newer. Advance this explicitly
// instead of calling Date.now() twice.
let snpoll1Time = Math.floor(Date.now() / 1000);

describe('channel connect + mapping + sync', () => {
  it('starts a connect, completes it via the (public) callback, and lists the account', async () => {
    const connect = await call(api, 'POST', '/api/v1/channels/shopee/connect', { token: t.accessToken });
    expect(connect.status, JSON.stringify(connect.body)).toBe(201);
    expect(connect.body.authorizeUrl).toContain('/api/v2/shop/auth_partner');
    expect(connect.body.authorizeUrl).toContain(`partner_id=${PARTNER_ID}`);

    fixture.issuedShopId = 700001;
    const cb = await call(
      api,
      'GET',
      `/api/v1/channels/shopee/callback?state=${encodeURIComponent(connect.body.state)}&code=abc&shop_id=700001`,
    );
    expect(cb.status).toBe(302);
    const location = String(cb.headers.location);
    expect(location).toContain('/channels?connected=');
    channelAccountId = new URL(location, 'https://x.test').searchParams.get('connected')!;
    expect(channelAccountId).toBeTruthy();

    const acc = await call(api, 'GET', `/api/v1/channel-accounts/${channelAccountId}`, {
      token: t.accessToken,
    });
    expect(acc.body).toMatchObject({ channelCode: 'SHOPEE', externalShopId: '700001', status: 'CONNECTED' });

    const list = await call(api, 'GET', '/api/v1/channel-accounts', { token: t.accessToken });
    expect(list.body.map((a: { id: string }) => a.id)).toContain(channelAccountId);
  });

  it('rejects a connect state that was already consumed or forged', async () => {
    const cb = await call(api, 'GET', '/api/v1/channels/shopee/callback?state=garbage&code=x&shop_id=1');
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toContain('/channels?error=');
  });

  it('sets the default warehouse', async () => {
    const res = await call(api, 'PUT', `/api/v1/channel-accounts/${channelAccountId}/default-warehouse`, {
      token: t.accessToken,
      body: { warehouseId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.defaultWarehouseId).toBe(warehouseId);
  });

  let mappedVariantId: string;
  let unmappedRowId: string;

  it('imports products and auto-maps by exact SKU match', async () => {
    mappedVariantId = await createVariant('SHOPEE-SHIRT-M');
    fixture.addProduct({
      itemId: 5001,
      name: 'Shirt',
      status: 'NORMAL',
      variants: [{ modelId: 1, modelSku: 'SHOPEE-SHIRT-M', name: 'M', price: 199, stock: 20 }],
    });
    fixture.addProduct({
      itemId: 5002,
      name: 'Unknown Thing',
      status: 'NORMAL',
      variants: [{ modelId: 2, modelSku: 'NO-INTERNAL-MATCH', name: 'Default', price: 50, stock: 5 }],
    });

    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/mappings/import`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ imported: 2, autoMapped: 1 });

    const mappings = (
      await call(api, 'GET', `/api/v1/channel-accounts/${channelAccountId}/mappings`, {
        token: t.accessToken,
      })
    ).body as channels.ChannelProductVariantRow[];
    const mapped = mappings.find((m) => m.externalItemId === '5001')!;
    expect(mapped.mappingStatus).toBe('AUTO_MAPPED');
    expect(mapped.variantId).toBe(mappedVariantId);
    const unmapped = mappings.find((m) => m.externalItemId === '5002')!;
    expect(unmapped.mappingStatus).toBe('UNMAPPED');
    unmappedRowId = unmapped.id;
  });

  it('confirms an unmapped row manually', async () => {
    const manualVariantId = await createVariant('MANUAL-MATCH');
    const res = await call(api, 'PUT', `/api/v1/channel-mappings/${unmappedRowId}`, {
      token: t.accessToken,
      body: { variantId: manualVariantId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mappingStatus).toBe('CONFIRMED');
    expect(res.body.mappingMethod).toBe('MANUAL');
  });

  it('re-importing does not clobber a confirmed/auto-mapped row', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/mappings/import`, {
      token: t.accessToken,
    });
    // item 5001 still matches by SKU every import (legitimately re-counted as AUTO_MAPPED each
    // time); item 5002 is now human-CONFIRMED, so the upsert's CASE guard leaves it untouched.
    expect(res.body.autoMapped).toBe(1);
    const mappings = (
      await call(api, 'GET', `/api/v1/channel-accounts/${channelAccountId}/mappings`, {
        token: t.accessToken,
      })
    ).body as channels.ChannelProductVariantRow[];
    expect(mappings.find((m) => m.externalItemId === '5002')!.mappingStatus).toBe('CONFIRMED');
  });

  it('pushes sellable stock to the channel', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/stock`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pushed).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(fixture.stockPushLog.some((p) => p.itemId === 5001 && p.modelId === 1 && p.stock === 10)).toBe(
      true,
    );
  });

  it('polls orders: pulls, maps, and advances a READY_TO_SHIP order to CONFIRMED with committed stock', async () => {
    const before = await balanceOf(mappedVariantId);
    fixture.addOrder({
      orderSn: 'SNPOLL1',
      status: 'READY_TO_SHIP',
      updateTime: snpoll1Time,
      createTime: snpoll1Time - 100,
      items: [{ itemId: 5001, modelId: 1, sku: 'SHOPEE-SHIRT-M', name: 'Shirt M', quantity: 2, price: 199 }],
      total: 398,
    });

    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/orders`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.output).toMatchObject({ pulled: 1, ingested: 1, failed: 0 });

    const after = await balanceOf(mappedVariantId);
    expect(after.committed).toBe('2.000');
    expect(Number(before.available) - Number(after.available)).toBe(2);

    const orders = await call(api, 'GET', '/api/v1/orders?channelCode=SHOPEE', { token: t.accessToken });
    const created = orders.body.data.find((o: { grandTotal: string }) => o.grandTotal === '398.00');
    expect(created).toBeTruthy();
    expect(created.status).toBe('CONFIRMED');
  });

  it('is idempotent: polling again with no new update_time does not double-reserve', async () => {
    const before = await balanceOf(mappedVariantId);
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/orders`, {
      token: t.accessToken,
    });
    expect(res.body.output.ingested).toBe(1); // still fetched (in the window), but ingestOne treats it as stale
    const after = await balanceOf(mappedVariantId);
    expect(after.committed).toBe(before.committed);
  });

  it('advances the same order to SHIPPED via a correctly signed webhook, deducting stock', async () => {
    const before = await balanceOf(mappedVariantId);
    snpoll1Time += 10;
    fixture.setOrderStatus('SNPOLL1', 'SHIPPED', snpoll1Time);
    const body = JSON.stringify({
      shop_id: 700001,
      code: 3,
      timestamp: snpoll1Time,
      data: { ordersn: 'SNPOLL1', status: 'SHIPPED' },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/shopee', {
      body: JSON.parse(body),
      headers: { authorization: signWebhookBody(body) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED');

    const after = await balanceOf(mappedVariantId);
    expect(after.committed).toBe('0.000');
    expect(Number(before.onHand) - Number(after.onHand)).toBe(2);

    const events = await call(api, 'GET', `/api/v1/channel-accounts/${channelAccountId}/webhook-events`, {
      token: t.accessToken,
    });
    expect(events.body[0]).toMatchObject({ status: 'PROCESSED', signatureValid: true });
  });

  it('rejects a webhook with an invalid signature', async () => {
    const res = await call(api, 'POST', '/api/v1/webhooks/shopee', {
      body: {
        shop_id: 700001,
        code: 3,
        timestamp: Math.floor(Date.now() / 1000),
        data: { ordersn: 'SNX', status: 'SHIPPED' },
      },
      headers: { authorization: 'not-a-real-signature' },
    });
    expect(res.status).toBe(401);
  });

  it('dedupes a re-delivered webhook (same shop/order/status/timestamp)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    fixture.addOrder({
      orderSn: 'SNDUP',
      status: 'READY_TO_SHIP',
      updateTime: ts,
      createTime: ts - 10,
      items: [{ itemId: 5001, modelId: 1, sku: 'SHOPEE-SHIRT-M', name: 'Shirt M', quantity: 1, price: 199 }],
      total: 199,
    });
    const body = JSON.stringify({
      shop_id: 700001,
      code: 3,
      timestamp: ts,
      data: { ordersn: 'SNDUP', status: 'READY_TO_SHIP' },
    });
    const sig = signWebhookBody(body);
    const first = await call(api, 'POST', '/api/v1/webhooks/shopee', {
      body: JSON.parse(body),
      headers: { authorization: sig },
    });
    const second = await call(api, 'POST', '/api/v1/webhooks/shopee', {
      body: JSON.parse(body),
      headers: { authorization: sig },
    });
    expect(first.body.outcome).toBe('PROCESSED');
    expect(second.body.outcome).toBe('DUPLICATE');
  });

  it('flags an order with an unmapped SKU as ON_HOLD instead of creating a broken order', async () => {
    fixture.addProduct({
      itemId: 6001,
      name: 'Mystery',
      status: 'NORMAL',
      variants: [{ modelId: 1, modelSku: 'NEVER-IMPORTED', name: 'Default', price: 10, stock: 1 }],
    });
    const ts = Math.floor(Date.now() / 1000);
    fixture.addOrder({
      orderSn: 'SNUNMAPPED',
      status: 'READY_TO_SHIP',
      updateTime: ts,
      createTime: ts - 5,
      items: [{ itemId: 6001, modelId: 1, sku: 'NEVER-IMPORTED', name: 'Mystery', quantity: 1, price: 10 }],
      total: 10,
    });
    const body = JSON.stringify({
      shop_id: 700001,
      code: 3,
      timestamp: ts,
      data: { ordersn: 'SNUNMAPPED', status: 'READY_TO_SHIP' },
    });
    const res = await call(api, 'POST', '/api/v1/webhooks/shopee', {
      body: JSON.parse(body),
      headers: { authorization: signWebhookBody(body) },
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('PROCESSED'); // webhook itself is handled; the *order* goes on hold internally

    const orders = await call(api, 'GET', '/api/v1/orders?channelCode=SHOPEE', { token: t.accessToken });
    expect(orders.body.data.some((o: { grandTotal: string }) => o.grandTotal === '10.00')).toBe(false);
  });

  it('runs a reconciliation and reports matches for what was just pushed', async () => {
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/reconciliation-runs`, {
      token: t.accessToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.checkedCount).toBeGreaterThan(0);

    const items = await call(api, 'GET', `/api/v1/reconciliation-runs/${res.body.id}/items`, {
      token: t.accessToken,
    });
    expect(items.body.length).toBe(res.body.checkedCount);
  });

  it('sets a stock policy and it changes what gets pushed', async () => {
    await call(api, 'PUT', '/api/v1/channel-stock-policies', {
      token: t.accessToken,
      body: { channelAccountId, variantId: mappedVariantId, safetyStock: '3' },
    });
    const res = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/sync/stock`, {
      token: t.accessToken,
    });
    expect(res.status).toBe(201);
    // onHand 10 - 2 shipped (SNPOLL1) = 8; committed 1 (SNDUP, still CONFIRMED) -> available 7;
    // safety stock 3 -> push 4
    const pushedFor5001 = [...fixture.stockPushLog]
      .reverse()
      .find((p) => p.itemId === 5001 && p.modelId === 1);
    expect(pushedFor5001).toMatchObject({ stock: 4 });
  });

  it('pauses, resumes and disconnects the channel account', async () => {
    const paused = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/pause`, {
      token: t.accessToken,
    });
    expect(paused.body.status).toBe('PAUSED');
    const resumed = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/resume`, {
      token: t.accessToken,
    });
    expect(resumed.body.status).toBe('CONNECTED');
    const disconnected = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/disconnect`, {
      token: t.accessToken,
    });
    expect(disconnected.body.status).toBe('DISCONNECTED');
    const again = await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/disconnect`, {
      token: t.accessToken,
    });
    expect(again.status).toBe(422); // BusinessRuleError CHANNEL_DISCONNECTED
  });
});

describe('a shop belongs to one tenant', () => {
  async function connectShop(token: string, shopId: number) {
    const connect = await call(api, 'POST', '/api/v1/channels/shopee/connect', { token });
    fixture.issuedShopId = shopId;
    const cb = await call(
      api,
      'GET',
      `/api/v1/channels/shopee/callback?state=${encodeURIComponent(connect.body.state)}&code=abc&shop_id=${shopId}`,
    );
    expect(cb.status).toBe(302);
    return new URL(String(cb.headers.location), 'https://x.test');
  }

  it("refuses to connect a shop another tenant already has, with a clear error and the first tenant's link intact", async () => {
    const first = await signup(api, 'ShopOwnerA');
    const second = await signup(api, 'ShopOwnerB');
    const ok = await connectShop(first.accessToken, 700555);
    const firstAccountId = ok.searchParams.get('connected')!;
    expect(firstAccountId).toBeTruthy();

    const refused = await connectShop(second.accessToken, 700555);
    expect(refused.pathname).toBe('/channels');
    expect(refused.searchParams.get('connected')).toBeNull();
    expect(refused.searchParams.get('code')).toBe('SHOP_ALREADY_CONNECTED');
    expect(refused.searchParams.get('error')).not.toMatch(/row-level security/i);

    const mine = await call(api, 'GET', `/api/v1/channel-accounts/${firstAccountId}`, {
      token: first.accessToken,
    });
    expect(mine.body).toMatchObject({ status: 'CONNECTED', externalShopId: '700555' });
    const theirs = await call(api, 'GET', '/api/v1/channel-accounts', { token: second.accessToken });
    expect(theirs.body).toEqual([]);
  });
});

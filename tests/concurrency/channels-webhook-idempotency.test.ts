import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels } from '@stockos/core';
import { call, createTestApi, signup, type Api, type SignedUpTenant } from '../support/api';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const CONCURRENCY = 20;
const PARTNER_KEY = 'concurrency_test_key';
const WEBHOOK_URL = 'https://api.stockos.test/api/v1/webhooks/shopee';

let db: TestDatabase;
let api: Api;
let fixture: channels.ShopeeFixtureServer;

beforeAll(async () => {
  db = await createTestDatabase({ appPoolSize: CONCURRENCY });
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
});
afterAll(async () => {
  await api.close();
  await db.drop();
});

function sign(body: string): string {
  return createHmac('sha256', PARTNER_KEY).update(`${WEBHOOK_URL}|${body}`, 'utf8').digest('hex');
}

describe('POST /webhooks/shopee idempotency under concurrency', () => {
  it('the same webhook delivered 20x at once is processed exactly once (order created once, reserved once)', async () => {
    const t: SignedUpTenant = await signup(api, 'ChannelsConcurrency');
    const [warehouse] = (await call(api, 'GET', '/api/v1/warehouses', { token: t.accessToken })).body;

    const unit = (
      await call(api, 'POST', '/api/v1/units', { token: t.accessToken, body: { code: 'CU1', name: 'U' } })
    ).body;
    const product = (
      await call(api, 'POST', '/api/v1/products', {
        token: t.accessToken,
        body: {
          code: 'CCONC-1',
          name: 'Channel Concurrency Widget',
          baseUnitId: unit.id,
          variants: [{ sku: 'CCONC-1-A', sellingPrice: '107.00' }],
        },
      })
    ).body;
    const variantId = product.variants[0].id as string;
    await call(api, 'POST', '/api/v1/inventory/receive', {
      token: t.accessToken,
      headers: { 'idempotency-key': `recv:${variantId}` },
      body: { lines: [{ warehouseId: warehouse.id, variantId, quantity: '10' }] },
    });

    const connect = await call(api, 'POST', '/api/v1/channels/shopee/connect', { token: t.accessToken });
    fixture.issuedShopId = 800001;
    const cb = await call(
      api,
      'GET',
      `/api/v1/channels/shopee/callback?state=${encodeURIComponent(connect.body.state)}&code=x&shop_id=800001`,
    );
    const channelAccountId = new URL(String(cb.headers.location), 'https://x.test').searchParams.get(
      'connected',
    )!;
    await call(api, 'PUT', `/api/v1/channel-accounts/${channelAccountId}/default-warehouse`, {
      token: t.accessToken,
      body: { warehouseId: warehouse.id },
    });

    fixture.addProduct({
      itemId: 1,
      name: 'Widget',
      status: 'NORMAL',
      variants: [{ modelId: 1, modelSku: 'CCONC-1-A', name: 'Default', price: 100, stock: 10 }],
    });
    await call(api, 'POST', `/api/v1/channel-accounts/${channelAccountId}/mappings/import`, {
      token: t.accessToken,
    });

    fixture.addOrder({
      orderSn: 'SNBURST',
      status: 'READY_TO_SHIP',
      updateTime: Math.floor(Date.now() / 1000),
      createTime: Math.floor(Date.now() / 1000) - 10,
      items: [{ itemId: 1, modelId: 1, sku: 'CCONC-1-A', name: 'Widget', quantity: 3, price: 100 }],
      total: 300,
    });
    const body = JSON.stringify({
      shop_id: 800001,
      code: 3,
      timestamp: Math.floor(Date.now() / 1000),
      data: { ordersn: 'SNBURST', status: 'READY_TO_SHIP' },
    });
    const headers = { authorization: sign(body) };
    const parsedBody = JSON.parse(body);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        call(api, 'POST', '/api/v1/webhooks/shopee', { body: parsedBody, headers }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const outcomes = results.map((r) => r.body.outcome as string);
    expect(outcomes.filter((o) => o === 'PROCESSED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(CONCURRENCY - 1);

    const orders = await call(api, 'GET', '/api/v1/orders?channelCode=SHOPEE', { token: t.accessToken });
    const created = orders.body.data.filter((o: { grandTotal: string }) => o.grandTotal === '300.00');
    expect(created).toHaveLength(1); // not created 20x

    const balance = (
      await call(
        api,
        'GET',
        `/api/v1/inventory/balances?variantId=${variantId}&warehouseId=${warehouse.id}`,
        { token: t.accessToken },
      )
    ).body.data[0];
    expect(balance.committed).toBe('3.000'); // not committed 20x
  });
});

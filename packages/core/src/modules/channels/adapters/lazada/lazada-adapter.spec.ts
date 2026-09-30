import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LazadaAdapter } from './lazada-adapter';
import { LazadaFixtureServer } from './fixtures/fixture-fetcher';

const APP_KEY = 'test_app_key';
const APP_SECRET = 'test_app_secret';

function makeAdapter(fixture: LazadaFixtureServer) {
  return new LazadaAdapter({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    apiBaseUrl: 'https://api.lazada.test/rest',
    authBaseUrl: 'https://auth.lazada.test/rest',
    fetcher: fixture.fetcher(),
  });
}

describe('LazadaAdapter', () => {
  let fixture: LazadaFixtureServer;
  let adapter: LazadaAdapter;

  beforeEach(() => {
    fixture = new LazadaFixtureServer();
    adapter = makeAdapter(fixture);
  });

  it('builds an authorize URL with client_id and the redirect+state', () => {
    const url = adapter.buildAuthorizeUrl({
      tenantId: 't1',
      redirectUri: 'https://api.stockos.test/api/v1/channels/lazada/callback',
      state: 'opaque-state',
    });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('auth.lazada.com');
    expect(parsed.searchParams.get('client_id')).toBe(APP_KEY);
    expect(parsed.searchParams.get('redirect_uri')).toContain('state=opaque-state');
  });

  it('exchanges an OAuth code for a token set via the fixture token endpoint', async () => {
    fixture.issuedSellerId = '777001';
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'somecode' },
    );
    expect(tokens.accessToken).toMatch(/^fixture_lazada_token_/);
    expect(tokens.externalShopId).toBe('777001');
    expect(tokens.refreshExpiresAt).toBeInstanceOf(Date);
  });

  it('refreshes a token', async () => {
    const refreshed = await adapter.refreshToken(
      { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' },
      { accessToken: 'old', refreshToken: 'old_refresh', accessExpiresAt: null, refreshExpiresAt: null },
    );
    expect(refreshed.accessToken).toMatch(/^fixture_lazada_token_/);
  });

  it('round-trips verify+parse for a correctly signed webhook', () => {
    const body = JSON.stringify({
      seller_id: '777001',
      msg_type: 'ORDER_STATUS_UPDATE',
      timestamp: 1700000000,
      data: { order_id: '555', status: 'shipped' },
    });
    const sig = createHmac('sha256', APP_SECRET)
      .update(APP_KEY + body, 'utf8')
      .digest('hex')
      .toUpperCase();
    const req = {
      rawBody: body,
      url: 'https://api.stockos.test/api/v1/webhooks/lazada',
      headers: { authorization: sig },
    };
    expect(adapter.verifyWebhook(req).valid).toBe(true);
    const events = adapter.parseWebhook(req);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalShopId: '777001', externalRef: '555' });
  });

  it('rejects a webhook with a bad signature', () => {
    const req = { rawBody: '{}', url: 'https://x.test/webhooks/lazada', headers: { authorization: 'bad' } };
    expect(adapter.verifyWebhook(req).valid).toBe(false);
  });

  it('lists and fetches products with their SKUs', async () => {
    fixture.addProduct({
      itemId: 1,
      name: 'Bag',
      status: 'active',
      skus: [
        { skuId: 10, sellerSku: 'BAG-RED', price: 599, stock: 12 },
        { skuId: 11, sellerSku: 'BAG-BLUE', price: 599, stock: 7 },
      ],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' };
    const page = await adapter.listProducts(account, 'tok');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.variants.map((v) => v.externalSku)).toEqual(['BAG-RED', 'BAG-BLUE']);

    const single = await adapter.getProduct(account, 'tok', '1');
    expect(single?.title).toBe('Bag');
  });

  it('normalizes a multi-line order with item-level status: one cancelled line does not drag the whole order down', async () => {
    fixture.addOrder({
      orderId: 900,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      total: 300,
      items: [
        { orderItemId: 1, productId: 1, sku: 'BAG-RED', name: 'Bag Red', status: 'shipped', price: 150 },
        { orderItemId: 2, productId: 1, sku: 'BAG-BLUE', name: 'Bag Blue', status: 'canceled', price: 150 },
      ],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' };
    const [detail] = await adapter.getOrders(account, 'tok', ['900']);
    expect(detail!.normalizedStatus).toBe('SHIPPED'); // only active line is SHIPPED; cancelled one excluded
    expect(detail!.lines).toHaveLength(2);
    expect(detail!.lines.find((l) => l.externalSku === 'BAG-BLUE')?.lineStatus).toBe('CANCELLED');
    expect(detail!.lines.find((l) => l.externalSku === 'BAG-RED')?.lineStatus).toBe('SHIPPED');
  });

  it('derives CANCELLED at the order level once every line is cancelled', async () => {
    fixture.addOrder({
      orderId: 901,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      total: 100,
      items: [{ orderItemId: 3, productId: 2, sku: 'X', name: 'X', status: 'canceled', price: 100 }],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' };
    const [detail] = await adapter.getOrders(account, 'tok', ['901']);
    expect(detail!.normalizedStatus).toBe('CANCELLED');
  });

  it('pushes stock and reads it back through getInventory', async () => {
    fixture.addProduct({
      itemId: 2,
      name: 'Mug',
      status: 'active',
      skus: [{ skuId: 20, sellerSku: 'MUG-1', price: 99, stock: 3 }],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' };
    const results = await adapter.updateInventory(account, 'tok', [
      { externalItemId: '2', externalVariantId: 'MUG-1', quantity: '42' },
    ]);
    expect(results).toEqual([{ externalItemId: '2', externalVariantId: 'MUG-1', ok: true }]);

    const stock = await adapter.getInventory!(account, 'tok', [
      { externalItemId: '2', externalVariantId: 'MUG-1' },
    ]);
    expect(stock[0]!.quantity).toBe('42');
  });
});

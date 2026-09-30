import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShopeeAdapter } from './shopee-adapter';
import { ShopeeFixtureServer } from './fixtures/fixture-fetcher';

const PARTNER_ID = '2000000';
const PARTNER_KEY = 'test_partner_key';

function makeAdapter(fixture: ShopeeFixtureServer) {
  return new ShopeeAdapter({
    partnerId: PARTNER_ID,
    partnerKey: PARTNER_KEY,
    baseUrl: 'https://partner.shopeemobile.test',
    fetcher: fixture.fetcher(),
  });
}

describe('ShopeeAdapter', () => {
  let fixture: ShopeeFixtureServer;
  let adapter: ShopeeAdapter;

  beforeEach(() => {
    fixture = new ShopeeFixtureServer();
    adapter = makeAdapter(fixture);
  });

  it('builds a signed authorize URL containing partner_id, timestamp, sign and the redirect+state', () => {
    const url = adapter.buildAuthorizeUrl({
      tenantId: 't1',
      redirectUri: 'https://api.stockos.test/api/v1/channels/shopee/callback',
      state: 'opaque-state-value',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v2/shop/auth_partner');
    expect(parsed.searchParams.get('partner_id')).toBe(PARTNER_ID);
    expect(parsed.searchParams.get('sign')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('redirect')).toContain('state=opaque-state-value');
  });

  it('exchanges an OAuth code for a token set through the fixture token endpoint', async () => {
    fixture.issuedShopId = 555001;
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'somecode', shop_id: '555001' },
    );
    expect(tokens.accessToken).toBe('fixture_access_token');
    expect(tokens.externalShopId).toBe('555001');
    expect(tokens.accessExpiresAt).toBeInstanceOf(Date);
    expect(tokens.refreshToken).toBe('fixture_refresh_token');
  });

  it('refreshes a token and gets a new access token back', async () => {
    const refreshed = await adapter.refreshToken(
      { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '555001' },
      { accessToken: 'old', refreshToken: 'old_refresh', accessExpiresAt: null, refreshExpiresAt: null },
    );
    expect(refreshed.accessToken).toMatch(/^fixture_access_token_/);
  });

  it('round-trips verify+parse for a correctly signed webhook', () => {
    const url = 'https://api.stockos.test/api/v1/webhooks/shopee';
    const body = JSON.stringify({
      shop_id: 555001,
      code: 3,
      timestamp: 1700000000,
      data: { ordersn: 'SN123', status: 'SHIPPED' },
    });
    const sig = createHmac('sha256', PARTNER_KEY).update(`${url}|${body}`, 'utf8').digest('hex');
    const req = { rawBody: body, url, headers: { authorization: sig } };

    expect(adapter.verifyWebhook(req).valid).toBe(true);
    const events = adapter.parseWebhook(req);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalShopId: '555001', externalRef: 'SN123' });
  });

  it('rejects a webhook with a bad signature', () => {
    const req = { rawBody: '{}', url: 'https://x.test/webhooks/shopee', headers: { authorization: 'bad' } };
    expect(adapter.verifyWebhook(req).valid).toBe(false);
  });

  it('lists and fetches products with variants (fixture: get_item_list -> get_item_base_info -> get_model_list)', async () => {
    fixture.addProduct({
      itemId: 111,
      name: 'Shirt',
      status: 'NORMAL',
      variants: [
        { modelId: 1, modelSku: 'SHIRT-M', name: 'M', price: 199, stock: 10 },
        { modelId: 2, modelSku: 'SHIRT-L', name: 'L', price: 199, stock: 5 },
      ],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '555001' };
    const page = await adapter.listProducts(account, 'tok');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.variants.map((v) => v.externalSku)).toEqual(['SHIRT-M', 'SHIRT-L']);

    const single = await adapter.getProduct(account, 'tok', '111');
    expect(single?.title).toBe('Shirt');
  });

  it('lists and gets order detail, normalizing status and totals', async () => {
    fixture.addOrder({
      orderSn: 'SN999',
      status: 'READY_TO_SHIP',
      updateTime: 1700000500,
      createTime: 1700000000,
      items: [{ itemId: 111, modelId: 1, sku: 'SHIRT-M', name: 'Shirt M', quantity: 2, price: 199 }],
      total: 398,
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '555001' };
    const list = await adapter.listOrders(account, 'tok', {
      updatedFrom: new Date(1699999000 * 1000),
      updatedTo: new Date(1700001000 * 1000),
    });
    expect(list.data.map((o) => o.externalOrderId)).toEqual(['SN999']);

    const [detail] = await adapter.getOrders(account, 'tok', ['SN999']);
    expect(detail!.normalizedStatus).toBe('CONFIRMED');
    expect(detail!.amounts.grandTotal).toBe('398.00');
    expect(detail!.lines[0]!.quantity).toBe('2');
  });

  it('pushes stock and reads it back through getInventory', async () => {
    fixture.addProduct({
      itemId: 222,
      name: 'Mug',
      status: 'NORMAL',
      variants: [{ modelId: 9, modelSku: 'MUG-1', name: 'Default', price: 99, stock: 3 }],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '555001' };
    const results = await adapter.updateInventory(account, 'tok', [
      { externalItemId: '222', externalVariantId: '9', quantity: '42' },
    ]);
    expect(results).toEqual([{ externalItemId: '222', externalVariantId: '9', ok: true }]);

    const stock = await adapter.getInventory!(account, 'tok', [
      { externalItemId: '222', externalVariantId: '9' },
    ]);
    expect(stock[0]!.quantity).toBe('42');
  });
});

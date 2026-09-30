import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { TikTokAdapter } from './tiktok-adapter';
import { TikTokFixtureServer } from './fixtures/fixture-fetcher';

const APP_KEY = 'test_app_key';
const APP_SECRET = 'test_app_secret';

function makeAdapter(fixture: TikTokFixtureServer) {
  return new TikTokAdapter({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    apiBaseUrl: 'https://open-api.tiktok.test',
    authBaseUrl: 'https://auth.tiktok.test',
    fetcher: fixture.fetcher(),
  });
}

describe('TikTokAdapter', () => {
  let fixture: TikTokFixtureServer;
  let adapter: TikTokAdapter;

  beforeEach(() => {
    fixture = new TikTokFixtureServer();
    adapter = makeAdapter(fixture);
  });

  it('builds an authorize URL with app_key and the state', () => {
    const url = adapter.buildAuthorizeUrl({
      tenantId: 't1',
      redirectUri: 'https://api.stockos.test/api/v1/channels/tiktok/callback',
      state: 'opaque-state',
    });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('auth.tiktok.test');
    expect(parsed.searchParams.get('app_key')).toBe(APP_KEY);
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
  });

  it('exchanges an auth code for a token set, pulling shop_id + shop_cipher via Get Authorized Shops', async () => {
    fixture.issuedShopId = '777001';
    fixture.issuedShopCipher = 'cipher_777001';
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'somecode' },
    );
    expect(tokens.externalShopId).toBe('777001');
    expect(tokens.extra).toEqual({ shopCipher: 'cipher_777001' });
    expect(tokens.refreshExpiresAt).toBeInstanceOf(Date);

    // The returned `accessToken` must round-trip through a real shop-level call: this is the whole
    // reason shop_cipher rides inside it (see the adapter's class doc comment).
    fixture.addProduct({ id: '1', title: 'T', status: 'ACTIVATE', skus: [] });
    const page = await adapter.listProducts(
      { tenantId: 't1', channelAccountId: 'ca1', externalShopId: '777001' },
      tokens.accessToken,
    );
    expect(page.data).toHaveLength(1);
  });

  it('refreshes a token and carries the shop_cipher over (the refresh endpoint does not re-hand it out)', async () => {
    const first = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'somecode' },
    );
    const refreshed = await adapter.refreshToken(
      { tenantId: 't1', channelAccountId: 'ca1', externalShopId: fixture.issuedShopId },
      {
        accessToken: first.accessToken,
        refreshToken: first.refreshToken,
        accessExpiresAt: null,
        refreshExpiresAt: null,
      },
    );
    expect(refreshed.extra).toEqual({ shopCipher: fixture.issuedShopCipher });

    fixture.addProduct({ id: '2', title: 'T2', status: 'ACTIVATE', skus: [] });
    const page = await adapter.listProducts(
      { tenantId: 't1', channelAccountId: 'ca1', externalShopId: fixture.issuedShopId },
      refreshed.accessToken,
    );
    expect(page.data).toHaveLength(1);
  });

  it('round-trips verify+parse for a correctly signed, fresh webhook', () => {
    const body = JSON.stringify({
      shop_id: '777001',
      type: 'ORDER_STATUS_CHANGE',
      timestamp: Math.floor(Date.now() / 1000),
      data: { order_id: '555', order_status: 'AWAITING_SHIPMENT', update_time: 1700000000 },
    });
    const sig = createHmac('sha256', APP_SECRET)
      .update(APP_KEY + body, 'utf8')
      .digest('hex');
    const req = { rawBody: body, url: 'https://x.test/webhooks/tiktok', headers: { authorization: sig } };
    expect(adapter.verifyWebhook(req).valid).toBe(true);
    const events = adapter.parseWebhook(req);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalShopId: '777001', externalRef: '555' });
  });

  it('rejects a webhook with a bad signature', () => {
    const req = { rawBody: '{}', url: 'https://x.test/webhooks/tiktok', headers: { authorization: 'bad' } };
    expect(adapter.verifyWebhook(req).valid).toBe(false);
  });

  it('rejects a correctly-signed but stale (replayed) webhook', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400; // > 5 minutes old
    const body = JSON.stringify({
      shop_id: '777001',
      type: 'ORDER_STATUS_CHANGE',
      timestamp: staleTs,
      data: { order_id: '555', order_status: 'AWAITING_SHIPMENT' },
    });
    const sig = createHmac('sha256', APP_SECRET)
      .update(APP_KEY + body, 'utf8')
      .digest('hex');
    const req = { rawBody: body, url: 'https://x.test/webhooks/tiktok', headers: { authorization: sig } };
    const result = adapter.verifyWebhook(req);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/stale|replay/i);
  });

  it('fails a shop-level call with no access token at all', async () => {
    await expect(
      adapter.listProducts({ tenantId: 't1', channelAccountId: 'ca1', externalShopId: '1' }, ''),
    ).rejects.toThrow();
  });

  it('lists and fetches products keyed by sku_id, not seller_sku', async () => {
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'x' },
    );
    fixture.addProduct({
      id: '1',
      title: 'Bag',
      status: 'ACTIVATE',
      skus: [
        { id: '10', sellerSku: 'BAG-RED', price: 599, stock: 12 },
        { id: '11', sellerSku: 'BAG-BLUE', price: 599, stock: 7 },
      ],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: fixture.issuedShopId };
    const page = await adapter.listProducts(account, tokens.accessToken);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.variants.map((v) => v.externalVariantId)).toEqual(['10', '11']);
    expect(page.data[0]!.variants.map((v) => v.externalSku)).toEqual(['BAG-RED', 'BAG-BLUE']);

    const single = await adapter.getProduct(account, tokens.accessToken, '1');
    expect(single?.title).toBe('Bag');
  });

  it('normalizes an order and maps its status', async () => {
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'x' },
    );
    fixture.addOrder({
      id: '900',
      status: 'AWAITING_SHIPMENT',
      createTime: 1700000000,
      updateTime: 1700000100,
      total: 300,
      items: [{ id: '1', productId: '1', skuId: '10', sellerSku: 'BAG-RED', name: 'Bag Red', price: 300 }],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: fixture.issuedShopId };
    const [detail] = await adapter.getOrders(account, tokens.accessToken, ['900']);
    expect(detail!.normalizedStatus).toBe('CONFIRMED');
    expect(detail!.lines).toHaveLength(1);
    expect(detail!.lines[0]!.externalVariantId).toBe('10');
  });

  it('pushes stock and reads it back through getInventory', async () => {
    const tokens = await adapter.exchangeCode(
      { tenantId: 't1', redirectUri: 'https://x.test/callback', state: '' },
      { code: 'x' },
    );
    fixture.addProduct({
      id: '2',
      title: 'Mug',
      status: 'ACTIVATE',
      skus: [{ id: '20', sellerSku: 'MUG-1', price: 99, stock: 3 }],
    });
    const account = { tenantId: 't1', channelAccountId: 'ca1', externalShopId: fixture.issuedShopId };
    const results = await adapter.updateInventory(account, tokens.accessToken, [
      { externalItemId: '2', externalVariantId: '20', quantity: '42' },
    ]);
    expect(results).toEqual([{ externalItemId: '2', externalVariantId: '20', ok: true }]);

    const stock = await adapter.getInventory!(account, tokens.accessToken, [
      { externalItemId: '2', externalVariantId: '20' },
    ]);
    expect(stock[0]!.quantity).toBe('42');
  });
});

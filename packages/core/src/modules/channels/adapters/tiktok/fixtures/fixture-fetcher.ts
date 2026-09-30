import type { Fetcher } from '../http';

export interface FixtureSku {
  id: string;
  sellerSku: string;
  price: number;
  stock: number;
}
export interface FixtureProduct {
  id: string;
  title: string;
  status: string;
  skus: FixtureSku[];
}
export interface FixtureLineItem {
  id: string;
  productId: string;
  skuId: string;
  sellerSku: string;
  name: string;
  price: number;
}
export interface FixtureOrder {
  id: string;
  status: string;
  createTime: number;
  updateTime: number;
  total: number;
  items: FixtureLineItem[];
}

/** In-memory stand-in for TikTok Shop's Partner Center API (both the `auth.tiktok-shops.com` and
 *  `open-api.tiktokglobalshop.com` hosts — keyed by pathname only, same technique as
 *  `channels.ShopeeFixtureServer`/`LazadaFixtureServer`). Lets the real `TikTokAdapter` (signing,
 *  the token→shop_cipher round trip, param/body shaping, response parsing) run end to end without
 *  real TikTok Partner Center credentials. Every shop-level route asserts the access-token header
 *  and `shop_cipher` param are actually present — a bug that dropped either one would 401 against
 *  the real API, and this fixture makes that failure loud instead of silently succeeding. */
export class TikTokFixtureServer {
  readonly products = new Map<string, FixtureProduct>();
  readonly orders = new Map<string, FixtureOrder>();
  readonly stockPushLog: { productId: string; skuId: string; quantity: number }[] = [];
  issuedShopId = '9990001';
  issuedShopCipher = 'fixture_shop_cipher_abc';

  addProduct(p: FixtureProduct): void {
    this.products.set(p.id, p);
  }
  addOrder(o: FixtureOrder): void {
    this.orders.set(o.id, o);
  }
  setOrderStatus(orderId: string, status: string, updateTime = Math.floor(Date.now() / 1000)): void {
    const o = this.orders.get(orderId);
    if (o) {
      o.status = status;
      o.updateTime = updateTime;
    }
  }

  fetcher(): Fetcher {
    return async (url, init) => {
      const u = new URL(url);
      const path = u.pathname;
      const p = u.searchParams;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify({ code: 0, message: 'success', data }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const error = (code: number, message: string) =>
        new Response(JSON.stringify({ code, message }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (path === '/api/v2/token/get' || path === '/api/v2/token/refresh') {
        return json({
          access_token: `fixture_tiktok_token_${Date.now()}`,
          refresh_token: `fixture_tiktok_refresh_${Date.now()}`,
          access_token_expire_in: 86400,
          refresh_token_expire_in: 2592000 * 4,
        });
      }
      if (path === '/authorization/202309/shops') {
        return json({
          shops: [{ id: this.issuedShopId, cipher: this.issuedShopCipher, name: 'Fixture Shop' }],
        });
      }

      // Every route below is shop-level — real TikTok would 401 without both of these.
      const accessTokenHeader = (init?.headers as Record<string, string> | undefined)?.['x-tts-access-token'];
      if (!accessTokenHeader) return error(105002, 'Invalid access token');
      if (p.get('shop_cipher') === null) return error(105005, 'Missing shop_cipher');

      if (path === '/product/202309/products/search') {
        const pageSize = Number(p.get('page_size') ?? 50);
        const offset = Number(p.get('page_token') ?? 0);
        const all = [...this.products.values()];
        const page = all.slice(offset, offset + pageSize);
        return json({
          products: page.map(toWireProduct),
          next_page_token: offset + page.length < all.length ? String(offset + pageSize) : '',
          total_count: all.length,
        });
      }
      if (path === '/order/202309/orders/search') {
        const pageSize = Number(p.get('page_size') ?? 50);
        const offset = Number(p.get('page_token') ?? 0);
        const all = [...this.orders.values()];
        const page = all.slice(offset, offset + pageSize);
        return json({
          orders: page.map((o) => ({ id: o.id, update_time: o.updateTime })),
          next_page_token: offset + page.length < all.length ? String(offset + pageSize) : '',
          total_count: all.length,
        });
      }
      if (path === '/order/202309/orders') {
        const ids = JSON.parse(p.get('ids') ?? '[]') as string[];
        const orders = ids.map((id) => this.orders.get(id)).filter((o): o is FixtureOrder => !!o);
        return json({ orders: orders.map(toWireOrder) });
      }
      const inventoryMatch = /^\/product\/202309\/products\/([^/]+)\/inventory\/update$/.exec(path);
      if (inventoryMatch) {
        const productId = inventoryMatch[1]!;
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          skus?: { id: string; inventory: { quantity: number }[] }[];
        };
        for (const s of body.skus ?? []) {
          this.stockPushLog.push({ productId, skuId: s.id, quantity: s.inventory[0]?.quantity ?? 0 });
          const sku = this.products.get(productId)?.skus.find((x) => x.id === s.id);
          if (sku) sku.stock = s.inventory[0]?.quantity ?? sku.stock;
        }
        return json({});
      }
      const productMatch = /^\/product\/202309\/products\/([^/]+)$/.exec(path);
      if (productMatch) {
        const product = this.products.get(productMatch[1]!);
        return json(product ? toWireProduct(product) : null);
      }
      return new Response(JSON.stringify({ code: 40404, message: `No fixture route for ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
}

function toWireProduct(p: FixtureProduct) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    skus: p.skus.map((s) => ({
      id: s.id,
      seller_sku: s.sellerSku,
      price: { sale_price: String(s.price) },
      inventory: [{ warehouse_id: 'fixture_wh', quantity: s.stock }],
    })),
  };
}

function toWireOrder(o: FixtureOrder) {
  return {
    id: o.id,
    status: o.status,
    create_time: o.createTime,
    update_time: o.updateTime,
    payment: { shipping_fee: '0', total_amount: String(o.total) },
    line_items: o.items.map((i) => ({
      id: i.id,
      product_id: i.productId,
      sku_id: i.skuId,
      seller_sku: i.sellerSku,
      product_name: i.name,
      sale_price: String(i.price),
    })),
  };
}

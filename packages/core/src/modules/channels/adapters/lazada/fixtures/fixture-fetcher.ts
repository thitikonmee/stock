import type { Fetcher } from '../http';

export interface FixtureSku {
  skuId: number;
  sellerSku: string;
  price: number;
  stock: number;
}
export interface FixtureProduct {
  itemId: number;
  name: string;
  status: string;
  skus: FixtureSku[];
}
export interface FixtureOrderItem {
  orderItemId: number;
  productId: number;
  sku: string;
  name: string;
  status: string;
  price: number;
}
export interface FixtureOrder {
  orderId: number;
  createdAt: string;
  updatedAt: string;
  total: number;
  items: FixtureOrderItem[];
}

/** In-memory stand-in for Lazada's Open Platform (both the `auth.lazada.com` and
 *  `api.lazada.co.th` hosts — keyed by pathname only, same technique as
 *  `channels.ShopeeFixtureServer`). Lets the real `LazadaAdapter` (signing, param shaping,
 *  response parsing, per-line status derivation) run end to end without real Lazada credentials. */
export class LazadaFixtureServer {
  readonly products = new Map<number, FixtureProduct>();
  readonly orders = new Map<number, FixtureOrder>();
  readonly stockPushLog: { sellerSku: string; quantity: number }[] = [];
  issuedSellerId = '888001';

  addProduct(p: FixtureProduct): void {
    this.products.set(p.itemId, p);
  }
  addOrder(o: FixtureOrder): void {
    this.orders.set(o.orderId, o);
  }
  setLineStatus(
    orderId: number,
    orderItemId: number,
    status: string,
    updatedAt = new Date().toISOString(),
  ): void {
    const o = this.orders.get(orderId);
    const item = o?.items.find((i) => i.orderItemId === orderItemId);
    if (o && item) {
      item.status = status;
      o.updatedAt = updatedAt;
    }
  }

  fetcher(): Fetcher {
    return async (url) => {
      const u = new URL(url);
      // The real gateway's own base URL already ends in `/rest` (docs §18 — see .env.example's
      // LAZADA_API_BASE_URL) — strip it so route matching below doesn't have to special-case it.
      const path = u.pathname.replace(/^\/rest/, '');
      const p = u.searchParams;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify({ code: '0', data }), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (path === '/auth/token/create' || path === '/auth/token/refresh') {
        return new Response(
          JSON.stringify({
            code: '0',
            access_token: `fixture_lazada_token_${Date.now()}`,
            refresh_token: `fixture_lazada_refresh_${Date.now()}`,
            expires_in: 14400,
            refresh_expires_in: 2592000,
            country_user_info: [{ seller_id: this.issuedSellerId, country: 'TH' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path === '/products/get') {
        const offset = Number(p.get('offset') ?? 0);
        const limit = Number(p.get('limit') ?? 50);
        const all = [...this.products.values()];
        const page = all.slice(offset, offset + limit);
        return json({
          products: page.map((prod) => ({
            item_id: prod.itemId,
            attributes: { name: prod.name },
            status: prod.status,
            skus: prod.skus.map((s) => ({
              SkuId: s.skuId,
              SellerSku: s.sellerSku,
              price: String(s.price),
              quantity: s.stock,
            })),
          })),
          total_products: all.length,
        });
      }
      if (path === '/product/item/get') {
        const itemId = Number(p.get('item_id'));
        const prod = this.products.get(itemId);
        return json({
          products: prod
            ? [
                {
                  item_id: prod.itemId,
                  attributes: { name: prod.name },
                  status: prod.status,
                  skus: prod.skus.map((s) => ({
                    SkuId: s.skuId,
                    SellerSku: s.sellerSku,
                    price: String(s.price),
                    quantity: s.stock,
                  })),
                },
              ]
            : [],
        });
      }
      if (path === '/orders/get') {
        const offset = Number(p.get('offset') ?? 0);
        const limit = Number(p.get('limit') ?? 50);
        const all = [...this.orders.values()];
        const page = all.slice(offset, offset + limit);
        return json({
          orders: page.map((o) => ({ order_id: o.orderId, updated_at: o.updatedAt })),
          count: all.length,
        });
      }
      if (path === '/order/get') {
        const orderId = Number(p.get('order_id'));
        const o = this.orders.get(orderId);
        return json({
          order_id: o?.orderId,
          created_at: o?.createdAt,
          updated_at: o?.updatedAt,
          statuses: o ? [...new Set(o.items.map((i) => i.status))] : [],
          price: String(o?.total ?? '0'),
          customer_first_name: 'Fixture',
          customer_last_name: 'Buyer',
        });
      }
      if (path === '/order/items/get') {
        const orderId = Number(p.get('order_id'));
        const o = this.orders.get(orderId);
        return json(
          (o?.items ?? []).map((i) => ({
            order_item_id: i.orderItemId,
            product_id: i.productId,
            sku: i.sku,
            shop_sku: i.sku,
            name: i.name,
            status: i.status,
            item_price: String(i.price),
            paid_price: String(i.price),
            voucher_amount: '0',
          })),
        );
      }
      if (path === '/product/stock/sellable/update') {
        const payload = JSON.parse(p.get('payload') ?? '{}') as {
          Request?: { Product?: { Skus?: { Sku?: { SellerSku: string; SellableQuantity: number }[] } } };
        };
        const skus = payload.Request?.Product?.Skus?.Sku ?? [];
        for (const s of skus) {
          this.stockPushLog.push({ sellerSku: s.SellerSku, quantity: s.SellableQuantity });
          for (const prod of this.products.values()) {
            const sku = prod.skus.find((x) => x.sellerSku === s.SellerSku);
            if (sku) sku.stock = s.SellableQuantity;
          }
        }
        return json({ result: 'success' });
      }
      return new Response(JSON.stringify({ code: 'NotFound', message: `No fixture route for ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
  }
}

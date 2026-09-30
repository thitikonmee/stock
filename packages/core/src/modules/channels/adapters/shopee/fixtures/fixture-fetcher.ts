import type { Fetcher } from '../http';

export interface FixtureVariant {
  modelId: number;
  modelSku: string;
  name: string;
  price: number;
  stock: number;
}
export interface FixtureProduct {
  itemId: number;
  name: string;
  status: string;
  variants: FixtureVariant[];
}
export interface FixtureOrderLine {
  itemId: number;
  modelId: number;
  sku: string;
  name: string;
  quantity: number;
  price: number;
}
export interface FixtureOrder {
  orderSn: string;
  status: string;
  updateTime: number;
  createTime: number;
  payTime?: number;
  items: FixtureOrderLine[];
  total: number;
}

/** In-memory stand-in for `partner.shopeemobile.com` — same wire format Shopee's real Open
 *  Platform v2 API returns, driven by fixture data instead of a live shop. Lets the *real*
 *  `ShopeeAdapter` code (signing, request shaping, response parsing) run end to end — unit tests,
 *  integration tests and the local dev demo all exercise the same translator logic a production
 *  deploy would, only the transport is swapped (docs/15 Phase 6 test list: "marketplace mock E2E").
 */
export class ShopeeFixtureServer {
  readonly products = new Map<number, FixtureProduct>();
  readonly orders = new Map<string, FixtureOrder>();
  readonly stockPushLog: { itemId: number; modelId: number; stock: number }[] = [];
  issuedShopId = 999001;
  issuedCode = 'FIXTURE_CODE';

  addProduct(p: FixtureProduct): void {
    this.products.set(p.itemId, p);
  }
  addOrder(o: FixtureOrder): void {
    this.orders.set(o.orderSn, o);
  }
  setOrderStatus(orderSn: string, status: string, updateTime = Math.floor(Date.now() / 1000)): void {
    const o = this.orders.get(orderSn);
    if (o) {
      o.status = status;
      o.updateTime = updateTime;
    }
  }

  fetcher(): Fetcher {
    return async (url, init) => {
      const u = new URL(url);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

      if (u.pathname === '/api/v2/auth/token/get') {
        return json({
          response: {},
          access_token: 'fixture_access_token',
          refresh_token: 'fixture_refresh_token',
          expire_in: 14400,
          shop_id: this.issuedShopId,
        });
      }
      if (u.pathname === '/api/v2/auth/access_token/get') {
        return json({
          response: {},
          access_token: `fixture_access_token_${Date.now()}`,
          refresh_token: `fixture_refresh_token_${Date.now()}`,
          expire_in: 14400,
        });
      }
      if (u.pathname === '/api/v2/product/get_item_list') {
        const items = [...this.products.values()];
        return json({
          response: {
            item: items.map((p) => ({ item_id: p.itemId, item_status: p.status })),
            has_next_page: false,
            next_offset: 0,
          },
        });
      }
      if (u.pathname === '/api/v2/product/get_item_base_info') {
        const ids = body.item_id_list as number[];
        const list = ids.map((id) => this.products.get(id)).filter((p): p is FixtureProduct => !!p);
        return json({
          response: {
            item_list: list.map((p) => ({ item_id: p.itemId, item_name: p.name, item_status: p.status })),
          },
        });
      }
      if (u.pathname === '/api/v2/product/get_model_list') {
        const p = this.products.get(body.item_id as number);
        return json({
          response: {
            model: (p?.variants ?? []).map((v) => ({
              model_id: v.modelId,
              model_name: v.name,
              model_sku: v.modelSku,
              price_info: [{ current_price: v.price }],
              stock_info_v2: { summary_info: { total_available_stock: v.stock } },
            })),
          },
        });
      }
      if (u.pathname === '/api/v2/product/update_stock') {
        const itemId = body.item_id as number;
        const stockList = body.stock_list as { model_id: number; seller_stock: { stock: number }[] }[];
        for (const s of stockList) {
          this.stockPushLog.push({ itemId, modelId: s.model_id, stock: s.seller_stock[0]?.stock ?? 0 });
          const product = this.products.get(itemId);
          const variant = product?.variants.find((v) => v.modelId === s.model_id);
          if (variant) variant.stock = s.seller_stock[0]?.stock ?? variant.stock;
        }
        return json({
          response: { result_list: stockList.map((s) => ({ model_id: s.model_id, success: true })) },
        });
      }
      if (u.pathname === '/api/v2/order/get_order_list') {
        const from = Number(u.searchParams.get('time_from') ?? body.time_from ?? 0);
        const to = Number(u.searchParams.get('time_to') ?? body.time_to ?? 0);
        const timeFrom = from || (body.time_from as number) || 0;
        const timeTo = to || (body.time_to as number) || Number.MAX_SAFE_INTEGER;
        const list = [...this.orders.values()].filter(
          (o) => o.updateTime >= timeFrom && o.updateTime <= timeTo,
        );
        return json({
          response: {
            order_list: list.map((o) => ({ order_sn: o.orderSn, update_time: o.updateTime })),
            more: false,
            next_cursor: '',
          },
        });
      }
      if (u.pathname === '/api/v2/order/get_order_detail') {
        const ids = body.order_sn_list as string[];
        const list = ids.map((id) => this.orders.get(id)).filter((o): o is FixtureOrder => !!o);
        return json({
          response: {
            order_list: list.map((o) => ({
              order_sn: o.orderSn,
              order_status: o.status,
              update_time: o.updateTime,
              create_time: o.createTime,
              ...(o.payTime ? { pay_time: o.payTime } : {}),
              buyer_username: 'fixture_buyer',
              total_amount: o.total,
              item_list: o.items.map((l) => ({
                item_id: l.itemId,
                model_id: l.modelId,
                model_sku: l.sku,
                item_name: l.name,
                model_quantity_purchased: l.quantity,
                model_discounted_price: l.price,
                model_original_price: l.price,
              })),
            })),
          },
        });
      }
      return json({ error: 'error_not_found', message: `No fixture route for ${u.pathname}` }, 404);
    };
  }
}

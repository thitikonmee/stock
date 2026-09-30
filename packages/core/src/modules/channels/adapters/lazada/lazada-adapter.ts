import type {
  AccountRef,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelTokenSet,
  ConnectContext,
  ExternalOrderRef,
  ExternalProduct,
  ExternalStock,
  ExternalVariant,
  NormalizedChannelOrder,
  NormalizedOrderLine,
  Page,
  ParsedWebhook,
  RawWebhookRequest,
  StockUpdate,
  StockUpdateResult,
  WebhookVerification,
} from '../../domain/channel-adapter';
import { callLazada, type Fetcher } from './http';
import { buildSign, verifyWebhookSignature } from './signing';
import { deriveOrderStatus, mapLazadaLineStatus } from './status-map';

export interface LazadaConfig {
  appKey: string;
  appSecret: string;
  /** e.g. `https://api.lazada.co.th/rest` (Thailand gateway per docs §18). */
  apiBaseUrl: string;
  /** e.g. `https://auth.lazada.com/rest` — separate host for the OAuth token endpoints. */
  authBaseUrl: string;
  fetcher?: Fetcher;
}

const CAPABILITIES: ChannelCapabilities = {
  webhook: true,
  orderPolling: true,
  stockPush: true,
  stockRead: false,
  pricePush: false,
  cancel: false,
  partialShipment: true,
  maxStockUpdateBatch: 50,
  maxOrderDetailBatch: 50,
  orderListMaxWindowDays: 15,
};

/** Lazada Open Platform adapter (docs/06-channel-integrations.md §18) — the second adapter, proving
 *  the framework from Phase 6 generalizes: this file plus its own domain-neutral additions in
 *  `order-ingest-service.ts` are the only new code this phase needs; nothing in `modules/orders` or
 *  `modules/inventory` changes. Its defining difference from Shopee is that Lazada's status lives
 *  on the order *item*, not the order — `getOrders` derives one order-level `normalizedStatus` via
 *  `deriveOrderStatus` while keeping each line's own `lineStatus` for per-line cancellation. */
export class LazadaAdapter implements ChannelAdapter {
  readonly code = 'LAZADA' as const;
  readonly capabilities = CAPABILITIES;
  private readonly fetcher: Fetcher;

  constructor(private readonly config: LazadaConfig) {
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  buildAuthorizeUrl(ctx: ConnectContext): string {
    const qs = new URLSearchParams({
      response_type: 'code',
      force_auth: 'true',
      redirect_uri: `${ctx.redirectUri}?state=${encodeURIComponent(ctx.state)}`,
      client_id: this.config.appKey,
    });
    return `https://auth.lazada.com/oauth/authorize?${qs.toString()}`;
  }

  async exchangeCode(
    _ctx: ConnectContext,
    callback: Record<string, string>,
  ): Promise<ChannelTokenSet & { externalShopId: string; shopName?: string }> {
    const body = await this.publicCall<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
      country_user_info: { seller_id: string; country: string }[];
    }>('/auth/token/create', { code: callback.code ?? '' });
    const sellerId = body.country_user_info?.[0]?.seller_id ?? '';
    return { ...tokenSetFrom(body), externalShopId: sellerId };
  }

  async refreshToken(_account: AccountRef, current: ChannelTokenSet): Promise<ChannelTokenSet> {
    const body = await this.publicCall<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
    }>('/auth/token/refresh', { refresh_token: current.refreshToken ?? '' });
    return tokenSetFrom(body);
  }

  verifyWebhook(req: RawWebhookRequest): WebhookVerification {
    const valid = verifyWebhookSignature(
      this.config.appSecret,
      this.config.appKey,
      req.rawBody,
      req.headers.authorization,
    );
    return valid ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
  }

  parseWebhook(req: RawWebhookRequest): ParsedWebhook[] {
    const body = JSON.parse(req.rawBody) as {
      seller_id?: string;
      shop_id?: string;
      msg_type?: string;
      timestamp?: number;
      data?: { trade_order_id?: string; order_id?: string; status?: string };
    };
    const externalShopId = body.seller_id ?? body.shop_id ?? '';
    const orderId = body.data?.trade_order_id ?? body.data?.order_id ?? '';
    const eventTs = new Date(
      (body.timestamp ?? Date.now() / 1000) * (body.timestamp && body.timestamp > 1e12 ? 1 : 1000),
    );
    return [
      {
        eventType: body.msg_type ?? 'ORDER_STATUS_UPDATE',
        externalShopId,
        externalRef: orderId,
        eventTs,
        dedupKey: `${externalShopId}|${orderId}|${body.data?.status ?? ''}|${body.timestamp ?? ''}`,
        payload: body,
      },
    ];
  }

  async listProducts(
    account: AccountRef,
    accessToken: string,
    cursor?: string,
  ): Promise<Page<ExternalProduct>> {
    const offset = cursor ? Number(cursor) : 0;
    const limit = 50;
    const body = await this.shopCall<{
      data: { products: LazadaProduct[]; total_products: number };
    }>(account, accessToken, '/products/get', {
      filter: 'all',
      offset: String(offset),
      limit: String(limit),
    });
    const products = body.data?.products ?? [];
    return {
      data: products.map(toExternalProduct),
      nextCursor: offset + products.length < (body.data?.total_products ?? 0) ? String(offset + limit) : null,
    };
  }

  async getProduct(
    account: AccountRef,
    accessToken: string,
    externalItemId: string,
  ): Promise<ExternalProduct | null> {
    const body = await this.shopCall<{ data: { products: LazadaProduct[] } }>(
      account,
      accessToken,
      '/product/item/get',
      { item_id: externalItemId },
    );
    const product = body.data?.products?.[0];
    return product ? toExternalProduct(product) : null;
  }

  async listOrders(
    account: AccountRef,
    accessToken: string,
    q: { updatedFrom: Date; updatedTo: Date; cursor?: string },
  ): Promise<Page<ExternalOrderRef>> {
    const offset = q.cursor ? Number(q.cursor) : 0;
    const limit = 50;
    const body = await this.shopCall<{
      data: { orders: { order_id: number; updated_at: string }[]; count: number };
    }>(account, accessToken, '/orders/get', {
      created_after: q.updatedFrom.toISOString(),
      update_after: q.updatedFrom.toISOString(),
      sort_by: 'updated_at',
      offset: String(offset),
      limit: String(limit),
    });
    const orders = body.data?.orders ?? [];
    return {
      data: orders.map((o) => ({ externalOrderId: String(o.order_id), updateTime: new Date(o.updated_at) })),
      nextCursor: offset + orders.length < (body.data?.count ?? 0) ? String(offset + limit) : null,
    };
  }

  async getOrders(
    account: AccountRef,
    accessToken: string,
    externalOrderIds: string[],
  ): Promise<NormalizedChannelOrder[]> {
    const results: NormalizedChannelOrder[] = [];
    for (const orderId of externalOrderIds) {
      const [orderBody, itemsBody] = await Promise.all([
        this.shopCall<{ data: LazadaOrder }>(account, accessToken, '/order/get', { order_id: orderId }),
        this.shopCall<{ data: LazadaOrderItem[] }>(account, accessToken, '/order/items/get', {
          order_id: orderId,
        }),
      ]);
      const order = orderBody.data;
      const items = itemsBody.data ?? [];
      if (!order || items.length === 0) continue;
      results.push(toNormalizedOrder(order, items));
    }
    return results;
  }

  async updateInventory(
    account: AccountRef,
    accessToken: string,
    updates: StockUpdate[],
  ): Promise<StockUpdateResult[]> {
    try {
      await this.shopCall(account, accessToken, '/product/stock/sellable/update', {
        payload: JSON.stringify({
          Request: {
            Product: {
              Skus: {
                // `externalVariantId` is SellerSku (see `toExternalProduct` below).
                Sku: updates.map((u) => ({
                  SellerSku: u.externalVariantId,
                  SellableQuantity: Math.trunc(Number(u.quantity)),
                })),
              },
            },
          },
        }),
      });
      return updates.map((u) => ({
        externalItemId: u.externalItemId,
        externalVariantId: u.externalVariantId,
        ok: true,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return updates.map((u) => ({
        externalItemId: u.externalItemId,
        externalVariantId: u.externalVariantId,
        ok: false,
        error: message,
      }));
    }
  }

  async getInventory(
    account: AccountRef,
    accessToken: string,
    refs: { externalItemId: string; externalVariantId: string }[],
  ): Promise<ExternalStock[]> {
    const itemIds = [...new Set(refs.map((r) => r.externalItemId))];
    const stocks: ExternalStock[] = [];
    for (const itemId of itemIds) {
      const product = await this.getProduct(account, accessToken, itemId);
      for (const v of product?.variants ?? []) {
        stocks.push({ externalItemId: itemId, externalVariantId: v.externalVariantId, quantity: v.stock });
      }
    }
    return stocks;
  }

  // ---------------------------------------------------------------- helpers

  private async publicCall<T>(path: string, params: Record<string, string>): Promise<T> {
    const systemParams = {
      app_key: this.config.appKey,
      timestamp: String(Date.now()),
      sign_method: 'sha256',
    };
    const all = { ...systemParams, ...params };
    const sign = buildSign(this.config.appSecret, path, all);
    const qs = new URLSearchParams({ ...all, sign });
    return callLazada<T>(this.fetcher, `${this.config.authBaseUrl}${path}?${qs.toString()}`, {
      method: 'GET',
    });
  }

  private async shopCall<T>(
    account: AccountRef,
    accessToken: string,
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const systemParams = {
      app_key: this.config.appKey,
      timestamp: String(Date.now()),
      sign_method: 'sha256',
      access_token: accessToken,
    };
    const all = { ...systemParams, ...params };
    const sign = buildSign(this.config.appSecret, path, all);
    const qs = new URLSearchParams({ ...all, sign });
    return callLazada<T>(this.fetcher, `${this.config.apiBaseUrl}${path}?${qs.toString()}`, {
      method: 'GET',
    });
  }
}

function tokenSetFrom(body: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}): ChannelTokenSet {
  const now = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now + body.expires_in * 1000),
    refreshExpiresAt: new Date(now + body.refresh_expires_in * 1000),
  };
}

interface LazadaSku {
  SkuId: number;
  SellerSku: string;
  ShopSku?: string;
  quantity?: number;
  price?: string;
}
interface LazadaProduct {
  item_id: number;
  attributes?: { name?: string };
  status?: string;
  skus: LazadaSku[];
}
function toExternalProduct(p: LazadaProduct): ExternalProduct {
  // Keyed by SellerSku, not the numeric SkuId: Lazada's order-item response (toNormalizedOrder
  // below) only ever carries the seller's own SKU text, never SkuId — using SkuId here would make
  // resolveLines() (which joins a line back to its `channel_product_variants` mapping row by
  // externalItemId+externalVariantId) never match a real order. SellerSku is also what docs §18
  // means by "auto-map ง่าย" — it usually already equals our internal SKU.
  const variants: ExternalVariant[] = p.skus.map((s) => ({
    externalItemId: String(p.item_id),
    externalVariantId: s.SellerSku,
    externalSku: s.SellerSku || null,
    name: s.ShopSku || s.SellerSku || String(s.SkuId),
    price: String(s.price ?? '0'),
    stock: String(s.quantity ?? 0),
  }));
  return {
    externalItemId: String(p.item_id),
    title: p.attributes?.name ?? String(p.item_id),
    status: p.status ?? 'active',
    variants,
    raw: p,
  };
}

interface LazadaOrder {
  order_id: number;
  created_at: string;
  updated_at: string;
  statuses?: string[];
  price: string;
  shipping_fee_original?: string;
  voucher?: string;
  customer_first_name?: string;
  customer_last_name?: string;
  address_shipping?: Record<string, unknown>;
}
interface LazadaOrderItem {
  order_item_id: number;
  product_id: number;
  sku: string;
  shop_sku?: string;
  name: string;
  status: string;
  item_price: string;
  voucher_amount?: string;
  paid_price?: string;
}

function toNormalizedOrder(order: LazadaOrder, items: LazadaOrderItem[]): NormalizedChannelOrder {
  const lines: NormalizedOrderLine[] = items.map((i) => ({
    externalLineId: String(i.order_item_id),
    externalItemId: String(i.product_id),
    // SellerSku — same join key `toExternalProduct` uses, not `shop_sku` (a different Lazada field).
    externalVariantId: i.sku,
    externalSku: i.sku || null,
    name: i.name,
    quantity: '1', // Lazada returns one row per unit for order items
    unitPrice: i.paid_price ?? i.item_price,
    discount: i.voucher_amount ?? '0',
    lineStatus: mapLazadaLineStatus(i.status),
  }));
  const normalizedStatus = deriveOrderStatus(lines.map((l) => l.lineStatus!));
  const subtotal = lines.reduce((sum, l) => sum + Number(l.unitPrice) * Number(l.quantity), 0);
  return {
    externalOrderId: String(order.order_id),
    externalStatus: order.statuses?.[0] ?? items[0]?.status ?? 'unknown',
    normalizedStatus,
    updateTime: new Date(order.updated_at),
    createdAt: new Date(order.created_at),
    buyer: { name: [order.customer_first_name, order.customer_last_name].filter(Boolean).join(' ') },
    ...(order.address_shipping ? { shippingAddress: order.address_shipping } : {}),
    lines,
    amounts: {
      subtotal: subtotal.toFixed(2),
      shippingFee: order.shipping_fee_original ?? '0.00',
      discount: order.voucher ?? '0.00',
      grandTotal: order.price,
      currency: 'THB',
    },
    raw: { order, items },
  };
}

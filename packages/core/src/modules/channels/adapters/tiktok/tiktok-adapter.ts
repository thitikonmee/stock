import { createHash } from 'node:crypto';
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
import { ChannelError } from '../../domain/channel-adapter';
import { callTikTok, type Fetcher } from './http';
import { buildSign, isFreshTimestamp, verifyWebhookSignature } from './signing';
import { mapTikTokOrderStatus } from './status-map';

export interface TikTokConfig {
  appKey: string;
  appSecret: string;
  /** e.g. `https://open-api.tiktokglobalshop.com` (docs §19). */
  apiBaseUrl: string;
  /** e.g. `https://auth.tiktok-shops.com` — separate host for the OAuth token endpoints. */
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

/**
 * TikTok Shop Partner Center adapter (docs/06-channel-integrations.md §19) — the third adapter,
 * proving the Phase 6 framework generalizes across every signing style docs describes: Shopee's
 * position-fixed string, Lazada's sorted-params, and now TikTok's secret-sandwiched-with-body
 * variant. Order status here lives on the order itself (like Shopee, unlike Lazada), so this file
 * needs no `order-ingest-service.ts` changes at all — Phase 7's per-line-cancel additions and
 * Phase 6's own state walk already cover it.
 *
 * TikTok's one real wrinkle: every shop-level call must also carry a `shop_cipher` obtained from
 * "Get Authorized Shops" right after token exchange (docs §19 Auth) — but `ChannelAdapter`'s
 * shop-level methods only take a plain `accessToken: string` (`TokenManager.getValidAccessToken`
 * discards `ChannelTokenSet.extra` before returning it, and widening that return type would ripple
 * into every adapter/call site for a need only this one has). So the shop_cipher rides inside the
 * `accessToken` string itself as a small JSON envelope (`encodeToken`/`decodeToken` below) — opaque
 * to everything outside this file, since `CredentialVault`/`TokenManager` already treat
 * `accessToken` as an opaque sealed string end to end. `extra.shopCipher` is still set on the
 * returned `ChannelTokenSet` too, matching the interface's own doc comment ("e.g. TikTok's
 * shop_cipher") for anyone inspecting stored credentials directly.
 */
export class TikTokAdapter implements ChannelAdapter {
  readonly code = 'TIKTOK' as const;
  readonly capabilities = CAPABILITIES;
  private readonly fetcher: Fetcher;

  constructor(private readonly config: TikTokConfig) {
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  buildAuthorizeUrl(ctx: ConnectContext): string {
    const qs = new URLSearchParams({
      app_key: this.config.appKey,
      state: ctx.state,
      redirect_uri: ctx.redirectUri,
    });
    return `${this.config.authBaseUrl}/api/v2/authorization?${qs.toString()}`;
  }

  async exchangeCode(
    _ctx: ConnectContext,
    callback: Record<string, string>,
  ): Promise<ChannelTokenSet & { externalShopId: string; shopName?: string }> {
    const tokenBody = await this.publicCall<{
      data: {
        access_token: string;
        refresh_token: string;
        access_token_expire_in: number;
        refresh_token_expire_in: number;
      };
    }>('/api/v2/token/get', { auth_code: callback.code ?? '', grant_type: 'authorization_code' });
    const shop = (await this.getAuthorizedShops(tokenBody.data.access_token))[0];
    if (!shop) throw new ChannelError('PERMANENT', 'No authorized shop returned for this app');
    const now = Date.now();
    return {
      accessToken: encodeToken(tokenBody.data.access_token, shop.cipher),
      refreshToken: tokenBody.data.refresh_token,
      accessExpiresAt: new Date(now + tokenBody.data.access_token_expire_in * 1000),
      refreshExpiresAt: new Date(now + tokenBody.data.refresh_token_expire_in * 1000),
      extra: { shopCipher: shop.cipher },
      externalShopId: shop.id,
      shopName: shop.name,
    };
  }

  async refreshToken(_account: AccountRef, current: ChannelTokenSet): Promise<ChannelTokenSet> {
    const body = await this.publicCall<{
      data: {
        access_token: string;
        refresh_token: string;
        access_token_expire_in: number;
        refresh_token_expire_in: number;
      };
    }>('/api/v2/token/refresh', { refresh_token: current.refreshToken ?? '', grant_type: 'refresh_token' });
    // The refresh endpoint doesn't re-hand us the shop; carry the cipher over from what we already have.
    const { shopCipher } = decodeToken(current.accessToken);
    const now = Date.now();
    return {
      accessToken: encodeToken(body.data.access_token, shopCipher),
      refreshToken: body.data.refresh_token,
      accessExpiresAt: new Date(now + body.data.access_token_expire_in * 1000),
      refreshExpiresAt: new Date(now + body.data.refresh_token_expire_in * 1000),
      extra: { shopCipher },
    };
  }

  verifyWebhook(req: RawWebhookRequest): WebhookVerification {
    const valid = verifyWebhookSignature(
      this.config.appSecret,
      this.config.appKey,
      req.rawBody,
      req.headers.authorization,
    );
    if (!valid) return { valid: false, reason: 'Signature mismatch' };
    let timestamp: number | undefined;
    try {
      timestamp = (JSON.parse(req.rawBody) as { timestamp?: number }).timestamp;
    } catch {
      return { valid: false, reason: 'Malformed payload' };
    }
    if (typeof timestamp === 'number' && !isFreshTimestamp(timestamp)) {
      return { valid: false, reason: 'Stale timestamp (possible replay)' };
    }
    return { valid: true };
  }

  parseWebhook(req: RawWebhookRequest): ParsedWebhook[] {
    const body = JSON.parse(req.rawBody) as {
      shop_id?: string;
      type?: string;
      timestamp?: number;
      data?: { order_id?: string; order_status?: string; update_time?: number };
    };
    const externalShopId = body.shop_id ?? '';
    const orderId = body.data?.order_id ?? '';
    const eventTs = new Date((body.timestamp ?? Date.now() / 1000) * 1000);
    // docs §19: "dedup key = sha256(shop_id|type|order_id|update_time|status)".
    const dedupKey = createHash('sha256')
      .update(
        `${externalShopId}|${body.type ?? ''}|${orderId}|${body.data?.update_time ?? ''}|${body.data?.order_status ?? ''}`,
      )
      .digest('hex');
    return [
      {
        eventType: body.type ?? 'ORDER_STATUS_CHANGE',
        externalShopId,
        externalRef: orderId,
        eventTs,
        dedupKey,
        payload: body,
      },
    ];
  }

  async listProducts(
    _account: AccountRef,
    accessToken: string,
    cursor?: string,
  ): Promise<Page<ExternalProduct>> {
    const body = await this.shopCall<{
      data: { products: TikTokProduct[]; next_page_token?: string; total_count: number };
    }>(
      accessToken,
      'POST',
      '/product/202309/products/search',
      { page_size: '50', ...(cursor ? { page_token: cursor } : {}) },
      { status: 'ALL' },
    );
    const products = body.data?.products ?? [];
    return {
      data: products.map(toExternalProduct),
      nextCursor: body.data?.next_page_token || null,
    };
  }

  async getProduct(
    _account: AccountRef,
    accessToken: string,
    externalItemId: string,
  ): Promise<ExternalProduct | null> {
    const body = await this.shopCall<{ data: TikTokProduct | null }>(
      accessToken,
      'GET',
      `/product/202309/products/${externalItemId}`,
    );
    return body.data ? toExternalProduct(body.data) : null;
  }

  async listOrders(
    _account: AccountRef,
    accessToken: string,
    q: { updatedFrom: Date; updatedTo: Date; cursor?: string },
  ): Promise<Page<ExternalOrderRef>> {
    const body = await this.shopCall<{
      data: { orders: { id: string; update_time: number }[]; next_page_token?: string; total_count: number };
    }>(
      accessToken,
      'POST',
      '/order/202309/orders/search',
      { page_size: '50', ...(q.cursor ? { page_token: q.cursor } : {}) },
      {
        update_time_ge: Math.floor(q.updatedFrom.getTime() / 1000),
        update_time_lt: Math.floor(q.updatedTo.getTime() / 1000),
      },
    );
    const orders = body.data?.orders ?? [];
    return {
      data: orders.map((o) => ({ externalOrderId: o.id, updateTime: new Date(o.update_time * 1000) })),
      nextCursor: body.data?.next_page_token || null,
    };
  }

  async getOrders(
    _account: AccountRef,
    accessToken: string,
    externalOrderIds: string[],
  ): Promise<NormalizedChannelOrder[]> {
    const body = await this.shopCall<{ data: { orders: TikTokOrder[] } }>(
      accessToken,
      'GET',
      '/order/202309/orders',
      { ids: JSON.stringify(externalOrderIds) },
    );
    return (body.data?.orders ?? []).map(toNormalizedOrder);
  }

  async updateInventory(
    _account: AccountRef,
    accessToken: string,
    updates: StockUpdate[],
  ): Promise<StockUpdateResult[]> {
    const byProduct = new Map<string, StockUpdate[]>();
    for (const u of updates) {
      const list = byProduct.get(u.externalItemId) ?? [];
      list.push(u);
      byProduct.set(u.externalItemId, list);
    }
    const results: StockUpdateResult[] = [];
    for (const [productId, group] of byProduct) {
      try {
        // docs §19 Inventory: body = skus[{id, inventory:[{warehouse_id, quantity}]}] — `warehouse_id`
        // is omitted here (single-default-warehouse shops only, same deferral as Shopee/Lazada's
        // single-fulfillment-per-order scope; multi-warehouse TikTok stock push is a follow-up).
        await this.shopCall(
          accessToken,
          'PUT',
          `/product/202309/products/${productId}/inventory/update`,
          {},
          {
            skus: group.map((u) => ({
              id: u.externalVariantId,
              inventory: [{ quantity: Math.trunc(Number(u.quantity)) }],
            })),
          },
        );
        for (const u of group)
          results.push({
            externalItemId: u.externalItemId,
            externalVariantId: u.externalVariantId,
            ok: true,
          });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        for (const u of group)
          results.push({
            externalItemId: u.externalItemId,
            externalVariantId: u.externalVariantId,
            ok: false,
            error: message,
          });
      }
    }
    return results;
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

  private async getAuthorizedShops(
    accessToken: string,
  ): Promise<{ id: string; cipher: string; name?: string }[]> {
    const path = '/authorization/202309/shops';
    const params = { app_key: this.config.appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
    const sign = buildSign(this.config.appSecret, path, params);
    const qs = new URLSearchParams({ ...params, sign });
    const body = await callTikTok<{
      data: { shops: { id: string; cipher: string; name?: string }[] };
    }>(this.fetcher, `${this.config.apiBaseUrl}${path}?${qs.toString()}`, {
      method: 'GET',
      headers: { 'x-tts-access-token': accessToken },
    });
    return body.data?.shops ?? [];
  }

  private async publicCall<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({
      app_key: this.config.appKey,
      app_secret: this.config.appSecret,
      ...params,
    });
    return callTikTok<T>(this.fetcher, `${this.config.authBaseUrl}${path}?${qs.toString()}`, {
      method: 'POST',
    });
  }

  private async shopCall<T>(
    accessToken: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const { accessToken: at, shopCipher } = decodeToken(accessToken);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const allParams = {
      app_key: this.config.appKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
      shop_cipher: shopCipher,
      ...params,
    };
    const sign = buildSign(this.config.appSecret, path, allParams, bodyStr);
    const qs = new URLSearchParams({ ...allParams, sign });
    return callTikTok<T>(this.fetcher, `${this.config.apiBaseUrl}${path}?${qs.toString()}`, {
      method,
      headers: { 'x-tts-access-token': at },
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
    });
  }
}

/** `accessToken` as stored/handed around by `CredentialVault`/`TokenManager` is treated as an
 *  opaque string everywhere outside this file (sealed/unsealed as bytes, never inspected) — see
 *  the class doc comment above for why the shop_cipher has to travel inside it. */
function encodeToken(accessToken: string, shopCipher: string): string {
  return JSON.stringify({ at: accessToken, sc: shopCipher });
}
function decodeToken(token: string): { accessToken: string; shopCipher: string } {
  try {
    const parsed = JSON.parse(token) as { at?: string; sc?: string };
    if (typeof parsed.at === 'string') return { accessToken: parsed.at, shopCipher: parsed.sc ?? '' };
  } catch {
    // not our composite shape (e.g. a test's plain token) — treat the whole string as the token.
  }
  return { accessToken: token, shopCipher: '' };
}

interface TikTokSku {
  id: string;
  seller_sku?: string;
  sales_attributes?: { value_name: string }[];
  price?: { sale_price?: string };
  inventory?: { warehouse_id?: string; quantity: number }[];
}
interface TikTokProduct {
  id: string;
  title: string;
  status: string;
  skus: TikTokSku[];
}
function toExternalProduct(p: TikTokProduct): ExternalProduct {
  const variants: ExternalVariant[] = (p.skus ?? []).map((s) => ({
    externalItemId: p.id,
    // Keyed by TikTok's own `sku_id`, not `seller_sku` — docs §19's "Product/SKU" row is explicit
    // that the mapping key is (product_id, sku_id), unlike Lazada's SellerSku-keyed join. `seller_sku`
    // is kept only as display/auto-map-hint metadata via `externalSku`.
    externalVariantId: s.id,
    externalSku: s.seller_sku || null,
    name: (s.sales_attributes ?? []).map((a) => a.value_name).join(' / ') || p.title,
    price: String(s.price?.sale_price ?? '0'),
    stock: String(s.inventory?.[0]?.quantity ?? 0),
  }));
  return { externalItemId: p.id, title: p.title, status: p.status, variants, raw: p };
}

interface TikTokLineItem {
  id: string;
  product_id: string;
  sku_id: string;
  seller_sku?: string;
  product_name: string;
  sku_name?: string;
  sale_price?: string;
}
interface TikTokOrder {
  id: string;
  status: string;
  create_time: number;
  update_time: number;
  paid_time?: number;
  buyer_email?: string;
  recipient_address?: Record<string, unknown>;
  payment?: { shipping_fee?: string; total_amount?: string };
  line_items: TikTokLineItem[];
}
function toNormalizedOrder(o: TikTokOrder): NormalizedChannelOrder {
  const lines: NormalizedOrderLine[] = (o.line_items ?? []).map((li) => ({
    externalLineId: li.id,
    externalItemId: li.product_id,
    externalVariantId: li.sku_id,
    externalSku: li.seller_sku || null,
    name: li.sku_name || li.product_name,
    quantity: '1', // TikTok returns one line_item row per unit, same convention as Lazada's order items
    unitPrice: li.sale_price ?? '0',
    discount: '0',
  }));
  const subtotal = lines.reduce((sum, l) => sum + Number(l.unitPrice) * Number(l.quantity), 0);
  return {
    externalOrderId: o.id,
    externalStatus: o.status,
    normalizedStatus: mapTikTokOrderStatus(o.status),
    updateTime: new Date(o.update_time * 1000),
    createdAt: new Date(o.create_time * 1000),
    ...(o.paid_time ? { paidAt: new Date(o.paid_time * 1000) } : {}),
    buyer: { email: o.buyer_email },
    ...(o.recipient_address ? { shippingAddress: o.recipient_address } : {}),
    lines,
    amounts: {
      subtotal: subtotal.toFixed(2),
      shippingFee: o.payment?.shipping_fee ?? '0.00',
      discount: '0.00',
      grandTotal: o.payment?.total_amount ?? subtotal.toFixed(2),
      currency: 'THB',
    },
    raw: o,
  };
}

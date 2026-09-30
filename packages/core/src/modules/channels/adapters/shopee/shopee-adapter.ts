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
  Page,
  ParsedWebhook,
  RawWebhookRequest,
  StockUpdate,
  StockUpdateResult,
  WebhookVerification,
} from '../../domain/channel-adapter';
import { callShopee, type Fetcher } from './http';
import { buildSign, publicSignParts, shopSignParts, verifyWebhookSignature } from './signing';
import { mapShopeeOrderStatus } from './status-map';

export interface ShopeeConfig {
  partnerId: string;
  partnerKey: string;
  /** e.g. `https://partner.shopeemobile.com` in production. */
  baseUrl: string;
  fetcher?: Fetcher;
}

const CAPABILITIES: ChannelCapabilities = {
  webhook: true,
  orderPolling: true,
  stockPush: true,
  stockRead: false, // no live getInventory in this phase — reconciliation uses the last-imported snapshot
  pricePush: false, // off by default per docs (most shops price on Shopee directly)
  cancel: false,
  partialShipment: true,
  maxStockUpdateBatch: 50,
  maxOrderDetailBatch: 50,
  orderListMaxWindowDays: 15,
};

/** Shopee Open Platform v2 adapter (docs/06-channel-integrations.md §17). Pure translator +
 *  transport: every method either builds a signed request or parses a response — no business
 *  decision (stock effects, order status persistence) lives here. */
export class ShopeeAdapter implements ChannelAdapter {
  readonly code = 'SHOPEE' as const;
  readonly capabilities = CAPABILITIES;
  private readonly fetcher: Fetcher;

  constructor(private readonly config: ShopeeConfig) {
    this.fetcher = config.fetcher ?? ((url, init) => fetch(url, init));
  }

  buildAuthorizeUrl(ctx: ConnectContext): string {
    const path = '/api/v2/shop/auth_partner';
    const ts = nowSec();
    const sign = buildSign(this.config.partnerKey, publicSignParts(this.config.partnerId, path, ts));
    const redirect = `${ctx.redirectUri}?state=${encodeURIComponent(ctx.state)}`;
    const qs = new URLSearchParams({
      partner_id: this.config.partnerId,
      timestamp: String(ts),
      sign,
      redirect,
    });
    return `${this.config.baseUrl}${path}?${qs.toString()}`;
  }

  async exchangeCode(
    _ctx: ConnectContext,
    callback: Record<string, string>,
  ): Promise<ChannelTokenSet & { externalShopId: string; shopName?: string }> {
    const path = '/api/v2/auth/token/get';
    const body = await this.publicCall<{
      access_token: string;
      refresh_token: string;
      expire_in: number;
      shop_id: number;
    }>(path, {
      code: callback.code,
      shop_id: Number(callback.shop_id),
      partner_id: Number(this.config.partnerId),
    });
    return { ...tokenSetFrom(body), externalShopId: String(body.shop_id) };
  }

  async refreshToken(account: AccountRef, current: ChannelTokenSet): Promise<ChannelTokenSet> {
    const body = await this.publicCall<{ access_token: string; refresh_token: string; expire_in: number }>(
      '/api/v2/auth/access_token/get',
      {
        refresh_token: current.refreshToken,
        shop_id: Number(account.externalShopId),
        partner_id: Number(this.config.partnerId),
      },
    );
    return tokenSetFrom(body);
  }

  verifyWebhook(req: RawWebhookRequest): WebhookVerification {
    const valid = verifyWebhookSignature(
      this.config.partnerKey,
      req.url,
      req.rawBody,
      req.headers.authorization,
    );
    return valid ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
  }

  parseWebhook(req: RawWebhookRequest): ParsedWebhook[] {
    const body = JSON.parse(req.rawBody) as {
      shop_id: number;
      code: number;
      timestamp: number;
      data?: { ordersn?: string; status?: string };
    };
    const orderSn = body.data?.ordersn ?? '';
    const eventTs = new Date((body.timestamp ?? Date.now() / 1000) * 1000);
    const dedupKey = createHash('sha256')
      .update(`${body.shop_id}|${orderSn}|${body.data?.status ?? ''}|${body.timestamp}`)
      .digest('hex');
    return [
      {
        eventType: 'ORDER_STATUS_UPDATE',
        externalShopId: String(body.shop_id),
        externalRef: orderSn,
        eventTs,
        dedupKey,
        payload: body,
      },
    ];
  }

  async listProducts(
    account: AccountRef,
    accessToken: string,
    cursor?: string,
  ): Promise<Page<ExternalProduct>> {
    const body = await this.shopCall<{
      response: {
        item: { item_id: number; item_status: string }[];
        has_next_page: boolean;
        next_offset: number;
      };
    }>(account, accessToken, '/api/v2/product/get_item_list', {
      offset: cursor ? Number(cursor) : 0,
      page_size: 50,
      item_status: ['NORMAL', 'BANNED', 'UNLIST'],
    });
    const items = body.response?.item ?? [];
    const data = await Promise.all(
      items.map((i) => this.fetchProductDetail(account, accessToken, i.item_id, i.item_status)),
    );
    return {
      data: data.filter((p): p is ExternalProduct => p !== null),
      nextCursor: body.response?.has_next_page ? String(body.response.next_offset) : null,
    };
  }

  async getProduct(
    account: AccountRef,
    accessToken: string,
    externalItemId: string,
  ): Promise<ExternalProduct | null> {
    return this.fetchProductDetail(account, accessToken, Number(externalItemId), null);
  }

  async listOrders(
    account: AccountRef,
    accessToken: string,
    q: { updatedFrom: Date; updatedTo: Date; cursor?: string },
  ): Promise<Page<ExternalOrderRef>> {
    const body = await this.shopCall<{
      response: {
        order_list: { order_sn: string; update_time: number }[];
        more: boolean;
        next_cursor: string;
      };
    }>(account, accessToken, '/api/v2/order/get_order_list', {
      time_range_field: 'update_time',
      time_from: Math.floor(q.updatedFrom.getTime() / 1000),
      time_to: Math.floor(q.updatedTo.getTime() / 1000),
      page_size: 50,
      cursor: q.cursor ?? '',
    });
    const list = body.response?.order_list ?? [];
    return {
      data: list.map((o) => ({ externalOrderId: o.order_sn, updateTime: new Date(o.update_time * 1000) })),
      nextCursor: body.response?.more ? body.response.next_cursor : null,
    };
  }

  async getOrders(
    account: AccountRef,
    accessToken: string,
    externalOrderIds: string[],
  ): Promise<NormalizedChannelOrder[]> {
    const body = await this.shopCall<{ response: { order_list: ShopeeOrderDetail[] } }>(
      account,
      accessToken,
      '/api/v2/order/get_order_detail',
      { order_sn_list: externalOrderIds },
    );
    return (body.response?.order_list ?? []).map(toNormalizedOrder);
  }

  async updateInventory(
    account: AccountRef,
    accessToken: string,
    updates: StockUpdate[],
  ): Promise<StockUpdateResult[]> {
    const byItem = new Map<string, StockUpdate[]>();
    for (const u of updates) {
      const list = byItem.get(u.externalItemId) ?? [];
      list.push(u);
      byItem.set(u.externalItemId, list);
    }
    const results: StockUpdateResult[] = [];
    for (const [itemId, group] of byItem) {
      try {
        await this.shopCall(account, accessToken, '/api/v2/product/update_stock', {
          item_id: Number(itemId),
          stock_list: group.map((u) => ({
            model_id: u.externalVariantId ? Number(u.externalVariantId) : 0,
            seller_stock: [{ stock: Math.trunc(Number(u.quantity)) }],
          })),
        });
        for (const u of group)
          results.push({
            externalItemId: u.externalItemId,
            externalVariantId: u.externalVariantId,
            ok: true,
          });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        for (const u of group) {
          results.push({
            externalItemId: u.externalItemId,
            externalVariantId: u.externalVariantId,
            ok: false,
            error: message,
          });
        }
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
      const product = await this.fetchProductDetail(account, accessToken, Number(itemId), null);
      for (const v of product?.variants ?? []) {
        stocks.push({ externalItemId: itemId, externalVariantId: v.externalVariantId, quantity: v.stock });
      }
    }
    return stocks;
  }

  // ---------------------------------------------------------------- helpers

  private async fetchProductDetail(
    account: AccountRef,
    accessToken: string,
    itemId: number,
    knownStatus: string | null,
  ): Promise<ExternalProduct | null> {
    const base = await this.shopCall<{
      response: { item_list: { item_id: number; item_name: string; item_status: string }[] };
    }>(account, accessToken, '/api/v2/product/get_item_base_info', { item_id_list: [itemId] });
    const info = base.response?.item_list?.[0];
    if (!info) return null;
    const models = await this.shopCall<{ response: { model: ShopeeModel[] } }>(
      account,
      accessToken,
      '/api/v2/product/get_model_list',
      { item_id: itemId },
    );
    const modelList = models.response?.model ?? [];
    const variants: ExternalVariant[] =
      modelList.length > 0
        ? modelList.map((m) => ({
            externalItemId: String(itemId),
            externalVariantId: String(m.model_id),
            externalSku: m.model_sku || null,
            name: m.model_name,
            price: String(m.price_info?.[0]?.current_price ?? '0'),
            stock: String(m.stock_info_v2?.summary_info?.total_available_stock ?? 0),
          }))
        : [
            {
              externalItemId: String(itemId),
              externalVariantId: '',
              externalSku: null,
              name: info.item_name,
              price: '0',
              stock: '0',
            },
          ];
    return {
      externalItemId: String(itemId),
      title: info.item_name,
      status: knownStatus ?? info.item_status,
      variants,
      raw: { base: info, models: modelList },
    };
  }

  private async publicCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const ts = nowSec();
    const sign = buildSign(this.config.partnerKey, publicSignParts(this.config.partnerId, path, ts));
    const qs = new URLSearchParams({ partner_id: this.config.partnerId, timestamp: String(ts), sign });
    return callShopee<T>(this.fetcher, `${this.config.baseUrl}${path}?${qs.toString()}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async shopCall<T>(
    account: AccountRef,
    accessToken: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const ts = nowSec();
    const sign = buildSign(
      this.config.partnerKey,
      shopSignParts(this.config.partnerId, path, ts, accessToken, account.externalShopId),
    );
    const qs = new URLSearchParams({
      partner_id: this.config.partnerId,
      timestamp: String(ts),
      sign,
      access_token: accessToken,
      shop_id: account.externalShopId,
    });
    return callShopee<T>(this.fetcher, `${this.config.baseUrl}${path}?${qs.toString()}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function tokenSetFrom(body: {
  access_token: string;
  refresh_token: string;
  expire_in: number;
}): ChannelTokenSet {
  const now = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now + body.expire_in * 1000),
    refreshExpiresAt: new Date(now + 30 * 24 * 3600 * 1000), // Shopee: refresh token valid ~30 days
  };
}

interface ShopeeModel {
  model_id: number;
  model_name: string;
  model_sku: string | null;
  price_info?: { current_price: number }[];
  stock_info_v2?: { summary_info?: { total_available_stock: number } };
}

interface ShopeeOrderDetail {
  order_sn: string;
  order_status: string;
  update_time: number;
  create_time: number;
  pay_time?: number;
  buyer_username?: string;
  recipient_address?: Record<string, unknown>;
  item_list: {
    item_id: number;
    model_id: number;
    item_sku?: string;
    model_sku?: string;
    item_name: string;
    model_quantity_purchased: number;
    model_discounted_price: number;
    model_original_price: number;
  }[];
  total_amount: number;
  currency?: string;
}

function toNormalizedOrder(o: ShopeeOrderDetail): NormalizedChannelOrder {
  const subtotal = o.item_list.reduce(
    (sum, l) => sum + l.model_discounted_price * l.model_quantity_purchased,
    0,
  );
  return {
    externalOrderId: o.order_sn,
    externalStatus: o.order_status,
    normalizedStatus: mapShopeeOrderStatus(o.order_status),
    updateTime: new Date(o.update_time * 1000),
    createdAt: new Date(o.create_time * 1000),
    ...(o.pay_time ? { paidAt: new Date(o.pay_time * 1000) } : {}),
    buyer: { name: o.buyer_username },
    ...(o.recipient_address ? { shippingAddress: o.recipient_address } : {}),
    lines: o.item_list.map((l, i) => ({
      externalLineId: `${o.order_sn}-${i}`,
      externalItemId: String(l.item_id),
      externalVariantId: l.model_id ? String(l.model_id) : '',
      externalSku: l.model_sku || l.item_sku || null,
      name: l.item_name,
      quantity: String(l.model_quantity_purchased),
      unitPrice: String(l.model_discounted_price),
      discount: String(Math.max(0, l.model_original_price - l.model_discounted_price)),
    })),
    amounts: {
      subtotal: subtotal.toFixed(2),
      shippingFee: '0.00',
      discount: '0.00',
      grandTotal: o.total_amount.toFixed(2),
      currency: 'THB',
    },
    raw: o,
  };
}

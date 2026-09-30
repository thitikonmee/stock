/**
 * Adapter interface every marketplace integration implements (docs/06-channel-integrations.md §20).
 * An adapter is a translator + transport only — it converts a platform's API to this normalized
 * shape and back; it never decides stock/order state (that is `application/*` in this module).
 */

export type ChannelCode = 'SHOPEE' | 'LAZADA' | 'TIKTOK' | 'WEBSITE' | 'POS' | 'API';

export interface ChannelCapabilities {
  webhook: boolean;
  orderPolling: boolean;
  stockPush: boolean;
  stockRead: boolean;
  pricePush: boolean;
  cancel: boolean;
  partialShipment: boolean;
  maxStockUpdateBatch: number;
  maxOrderDetailBatch: number;
  orderListMaxWindowDays: number;
}

export interface ConnectContext {
  tenantId: string;
  /** Absolute URL Shopee (etc.) redirects back to after the merchant authorizes. */
  redirectUri: string;
  /** Opaque value round-tripped through the platform, used to recover ConnectContext on callback. */
  state: string;
}

export interface ChannelTokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes?: string[];
  /** Platform-specific extra credential material (e.g. TikTok's shop_cipher). */
  extra?: Record<string, string>;
}

export interface AccountRef {
  tenantId: string;
  channelAccountId: string;
  externalShopId: string;
}

export interface RawWebhookRequest {
  /** Exact bytes/string as received — signatures are computed over the raw body, not re-serialized JSON. */
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  /** Full URL as the platform called it (scheme+host+path+query), needed by some signature schemes. */
  url: string;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

export interface ParsedWebhook {
  eventType: string;
  externalShopId: string;
  externalRef: string;
  eventTs: Date;
  dedupKey: string;
  payload: unknown;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ExternalVariant {
  externalItemId: string;
  externalVariantId: string; // '' if the item has no variation
  externalSku: string | null;
  name: string;
  price: string;
  stock: string;
}

export interface ExternalProduct {
  externalItemId: string;
  title: string;
  status: string;
  variants: ExternalVariant[];
  raw: unknown;
}

export interface ExternalOrderRef {
  externalOrderId: string;
  updateTime: Date;
}

export type NormalizedOrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'PACKED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'NO_CHANGE'; // platform is mid-transition (e.g. Shopee IN_CANCEL) — keep current internal status

export interface NormalizedOrderLine {
  externalLineId: string;
  externalItemId: string;
  externalVariantId: string;
  externalSku: string | null;
  name: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  /** Platforms whose status lives per line, not per order (Lazada, TikTok packages) set this;
   *  `normalizedStatus` on the order itself is still the adapter's derived, order-level summary —
   *  see `lazada-adapter.ts`'s `deriveOrderStatus`. Omitted entirely for order-level platforms
   *  (Shopee), where every line always matches the order's own status. */
  lineStatus?: NormalizedOrderStatus;
}

export interface NormalizedChannelOrder {
  externalOrderId: string;
  externalStatus: string;
  normalizedStatus: NormalizedOrderStatus;
  updateTime: Date;
  createdAt: Date;
  paidAt?: Date;
  buyer: { externalBuyerId?: string; name?: string; phone?: string; email?: string };
  shippingAddress?: Record<string, unknown>;
  lines: NormalizedOrderLine[];
  amounts: { subtotal: string; shippingFee: string; discount: string; grandTotal: string; currency: 'THB' };
  raw: unknown;
}

export interface StockUpdate {
  externalItemId: string;
  externalVariantId: string;
  quantity: string;
}

export interface StockUpdateResult {
  externalItemId: string;
  externalVariantId: string;
  ok: boolean;
  error?: string;
}

export interface ExternalStock {
  externalItemId: string;
  externalVariantId: string;
  quantity: string;
}

export type ChannelErrorKind =
  | 'AUTH_EXPIRED'
  | 'AUTH_REVOKED'
  | 'RATE_LIMITED'
  | 'TRANSIENT'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'PERMANENT'
  | 'UNKNOWN_OUTCOME';

export class ChannelError extends Error {
  constructor(
    readonly kind: ChannelErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly platformCode?: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface ChannelAdapter {
  readonly code: ChannelCode;
  readonly capabilities: ChannelCapabilities;

  buildAuthorizeUrl(ctx: ConnectContext): string;
  exchangeCode(
    ctx: ConnectContext,
    callback: Record<string, string>,
  ): Promise<ChannelTokenSet & { externalShopId: string; shopName?: string }>;
  refreshToken(account: AccountRef, current: ChannelTokenSet): Promise<ChannelTokenSet>;

  verifyWebhook(req: RawWebhookRequest): WebhookVerification;
  parseWebhook(req: RawWebhookRequest): ParsedWebhook[];

  // Shop-level calls take the caller's already-valid access token: `TokenManager` owns refresh
  // (which needs the database) and hands the adapter a plain string, so the adapter stays pure
  // transport + translation with no DB access of its own (docs §20's "adapter = translator + transport").
  listProducts(account: AccountRef, accessToken: string, cursor?: string): Promise<Page<ExternalProduct>>;
  getProduct(
    account: AccountRef,
    accessToken: string,
    externalItemId: string,
  ): Promise<ExternalProduct | null>;

  listOrders(
    account: AccountRef,
    accessToken: string,
    q: { updatedFrom: Date; updatedTo: Date; cursor?: string },
  ): Promise<Page<ExternalOrderRef>>;
  getOrders(
    account: AccountRef,
    accessToken: string,
    externalOrderIds: string[],
  ): Promise<NormalizedChannelOrder[]>;

  updateInventory(
    account: AccountRef,
    accessToken: string,
    updates: StockUpdate[],
  ): Promise<StockUpdateResult[]>;
  getInventory?(
    account: AccountRef,
    accessToken: string,
    refs: { externalItemId: string; externalVariantId: string }[],
  ): Promise<ExternalStock[]>;
}

import type { NormalizedOrderStatus } from '../../domain/channel-adapter';

/**
 * docs/06-channel-integrations.md §19 "Order status" — status lives on the order itself (unlike
 * Lazada's per-line status), same shape as Shopee's map. `ON_HOLD` (buyer already paid, can still
 * cancel) deliberately maps to `NO_CHANGE`: the reserve made at order creation already covers this
 * window, nothing to advance yet — the next real status (`AWAITING_SHIPMENT`) walks
 * PENDING->PAID->CONFIRMED in one hop once it lands. `PARTIALLY_SHIPPING`/`IN_TRANSIT` both
 * collapse to `SHIPPED` — multi-package split-shipment tracking is deferred, same scope cut as
 * Shopee/Lazada's single-fulfillment-per-order.
 */
const TIKTOK_STATUS_MAP: Record<string, NormalizedOrderStatus> = {
  UNPAID: 'PENDING',
  ON_HOLD: 'NO_CHANGE',
  AWAITING_SHIPMENT: 'CONFIRMED',
  PARTIALLY_SHIPPING: 'SHIPPED',
  AWAITING_COLLECTION: 'PACKED',
  IN_TRANSIT: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

export function mapTikTokOrderStatus(status: string): NormalizedOrderStatus {
  return TIKTOK_STATUS_MAP[status] ?? 'NO_CHANGE';
}

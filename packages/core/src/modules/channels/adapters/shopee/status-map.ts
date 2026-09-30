import type { NormalizedOrderStatus } from '../../domain/channel-adapter';

/** docs/06-channel-integrations.md §17 "Shopee status → internal". */
const SHOPEE_STATUS_MAP: Record<string, NormalizedOrderStatus> = {
  UNPAID: 'PENDING',
  READY_TO_SHIP: 'CONFIRMED',
  PROCESSED: 'PACKED',
  SHIPPED: 'SHIPPED',
  TO_CONFIRM_RECEIVE: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  IN_CANCEL: 'NO_CHANGE', // keep current status; don't release stock until the real CANCELLED lands
  CANCELLED: 'CANCELLED',
  TO_RETURN: 'RETURN_REQUESTED',
};

export function mapShopeeOrderStatus(shopeeStatus: string): NormalizedOrderStatus {
  return SHOPEE_STATUS_MAP[shopeeStatus] ?? 'NO_CHANGE';
}

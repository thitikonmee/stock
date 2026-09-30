import type { NormalizedOrderStatus } from '../../domain/channel-adapter';

/** docs/06-channel-integrations.md §18 "Order status (item)". Lazada's status lives on the order
 *  *item*, not the order — this maps one line's raw status to our normalized vocabulary; deriving
 *  the order-level status from every line's mapped status is `deriveOrderStatus` below. */
const LAZADA_LINE_STATUS_MAP: Record<string, NormalizedOrderStatus> = {
  unpaid: 'PENDING',
  pending: 'CONFIRMED',
  packed: 'PACKED',
  ready_to_ship: 'PACKED',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  failed_delivery: 'RETURN_REQUESTED',
  returned: 'RETURN_REQUESTED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
};

export function mapLazadaLineStatus(lazadaStatus: string): NormalizedOrderStatus {
  return LAZADA_LINE_STATUS_MAP[lazadaStatus.toLowerCase()] ?? 'NO_CHANGE';
}

/** Least-advanced-wins: an order can't be considered e.g. "shipped" while one of its still-active
 *  lines hasn't shipped yet (docs' 3-line-order example: one line cancelled, order "ยังเป็น
 *  CONFIRMED" — i.e. a partial cancel never advances the order, it only removes that line from
 *  consideration). All lines cancelled collapses the whole order to CANCELLED. */
const PROGRESSION: NormalizedOrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
];

export function deriveOrderStatus(lineStatuses: readonly NormalizedOrderStatus[]): NormalizedOrderStatus {
  const active = lineStatuses.filter((s) => s !== 'CANCELLED');
  if (active.length === 0) return 'CANCELLED';
  if (active.some((s) => s === 'RETURN_REQUESTED')) return 'RETURN_REQUESTED';
  let least: NormalizedOrderStatus = active[0]!;
  let leastIdx = PROGRESSION.indexOf(least);
  for (const s of active.slice(1)) {
    const idx = PROGRESSION.indexOf(s);
    if (idx === -1) continue; // NO_CHANGE or anything outside the known line — ignore for derivation
    if (leastIdx === -1 || idx < leastIdx) {
      least = s;
      leastIdx = idx;
    }
  }
  return least;
}

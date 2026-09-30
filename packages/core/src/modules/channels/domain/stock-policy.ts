import { Dec } from '@stockos/shared';

export interface StockPolicy {
  safetyStock: string;
  bufferPercent: string;
  maxPushQty: string | null;
  pushZeroBelow: string;
}

export const DEFAULT_STOCK_POLICY: StockPolicy = {
  safetyStock: '0',
  bufferPercent: '0',
  maxPushQty: null,
  pushZeroBelow: '0',
};

/**
 * What quantity to push to a channel for one SKU, given our internal `available` stock and the
 * policy for (channel_account, variant) — docs/06-channel-integrations.md §Shopee Stock,
 * docs/15 Phase 6 features ("safety stock + buffer"). Pure so it is exhaustively unit-testable
 * without a database.
 */
export function computeSellable(available: string, policy: StockPolicy): string {
  const afterSafety = new Dec(available).minus(policy.safetyStock);
  const buffered = afterSafety.times(new Dec(1).minus(new Dec(policy.bufferPercent).div(100)));
  let sellable = buffered.lessThan(0) ? new Dec(0) : buffered;
  if (policy.maxPushQty !== null && sellable.greaterThan(policy.maxPushQty)) {
    sellable = new Dec(policy.maxPushQty);
  }
  if (sellable.lessThanOrEqualTo(policy.pushZeroBelow)) sellable = new Dec(0);
  return sellable.toFixed(3);
}

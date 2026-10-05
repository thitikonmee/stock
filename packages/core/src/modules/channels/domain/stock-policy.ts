import { Dec } from '@stockos/shared';

export interface StockPolicy {
  /** GLOBAL_POOL: sell from the shared pool. CHANNEL_ALLOCATION: never push more than this
   *  account's remaining quota (`channel_allocations`); no quota row means nothing to push. */
  strategy: 'GLOBAL_POOL' | 'CHANNEL_ALLOCATION';
  safetyStock: string;
  bufferPercent: string;
  maxPushQty: string | null;
  pushZeroBelow: string;
}

export const DEFAULT_STOCK_POLICY: StockPolicy = {
  strategy: 'GLOBAL_POOL',
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

export interface QuotaPosition {
  /** This account's allocated − consumed at the warehouse; null when it has no allocation row. */
  ownRemaining: string | null;
  /** Σ allocated − consumed of every *other* account: stock this account can never sell. */
  othersRemaining: string;
}

/**
 * docs/04-inventory.md §8: what a channel account may sell is the warehouse `available` minus the
 * quota held for other accounts (the same thing InventoryEngine's AVAILABLE guard enforces); under
 * CHANNEL_ALLOCATION it is further capped at the account's own remaining quota.
 */
export function computeAccountSellable(available: string, policy: StockPolicy, quota: QuotaPosition): string {
  const usable = new Dec(available).minus(quota.othersRemaining);
  let sellable = new Dec(computeSellable(usable.toFixed(3), policy));
  if (policy.strategy === 'CHANNEL_ALLOCATION') {
    const own = new Dec(quota.ownRemaining ?? 0);
    if (sellable.greaterThan(own)) sellable = own.isNegative() ? new Dec(0) : own;
  }
  return sellable.toFixed(3);
}

-- Phase 9 (Warehouse). Tables were created in 0001; this adds what the implementation needed.

-- Stock counts: the snapshot's position in each balance row's own history. `inventory_balances.version`
-- increments on every change of that (warehouse, variant) row and the ledger stamps it on each line,
-- so "movement since snapshot" = Σ ledger deltas with balance_version > this — exact commit order per
-- row, unlike timestamps or uuid ids.
ALTER TABLE stock_count_items ADD COLUMN snapshot_balance_version bigint NOT NULL DEFAULT 0;

ALTER TABLE stock_counts
  ADD COLUMN variance_tolerance numeric(14,3) NOT NULL DEFAULT 0 CHECK (variance_tolerance >= 0),
  ADD COLUMN posted_adjustment_id uuid,
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- CHANNEL_ALLOCATION: InventoryEngine's AVAILABLE guard sums other accounts' remaining quota per
-- (warehouse, variant) on every reserve/sale — the PK leads with channel_account_id, so it needs this.
CREATE INDEX channel_allocations_balance ON channel_allocations (tenant_id, warehouse_id, variant_id);

-- Which channel account a reservation consumed quota for, so releasing it gives the quota back.
ALTER TABLE inventory_reservations ADD COLUMN channel_account_id uuid;

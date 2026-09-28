import type { ColumnType, Generated } from 'kysely';

/**
 * Hand-written subset of the schema for typed queries used so far.
 * Replace with `kysely-codegen` output once the schema stabilises (Phase 1).
 * NUMERIC and BIGINT columns come back from `pg` as strings on purpose (no float drift).
 */
type Numeric = ColumnType<string, string | undefined, string>;
type BigIntString = ColumnType<string, string | number | undefined, string | number>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type JsonColumn = ColumnType<unknown, string, string>;

export interface TenantsTable {
  id: string;
  slug: string;
  name: string;
  status: Generated<string>;
  settings: ColumnType<unknown, string | undefined, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WarehousesTable {
  tenant_id: string;
  id: string;
  branch_id: string | null;
  code: string;
  name: string;
  type: Generated<string>;
  allow_negative_stock: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UnitsTable {
  tenant_id: string;
  id: string;
  code: string;
  name: string;
  allow_decimal: Generated<boolean>;
}

export interface ProductsTable {
  tenant_id: string;
  id: string;
  code: string;
  name: string;
  base_unit_id: string;
  type: Generated<string>;
  status: Generated<string>;
  version: Generated<number>;
  deleted_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductVariantsTable {
  tenant_id: string;
  id: string;
  product_id: string;
  sku: string;
  name: string;
  status: Generated<string>;
  version: Generated<number>;
  deleted_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface InventoryBalancesTable {
  tenant_id: string;
  warehouse_id: string;
  variant_id: string;
  on_hand: Numeric;
  reserved: Numeric;
  committed: Numeric;
  damaged: Numeric;
  incoming: Numeric;
  available: ColumnType<string, never, never>;
  negative_allowed: Generated<boolean>;
  version: BigIntString;
  updated_at: Timestamp;
}

export interface InventoryMovementsTable {
  tenant_id: string;
  id: string;
  idempotency_key: string;
  movement_type: string;
  reference_type: string;
  reference_id: string;
  channel_code: string | null;
  user_id: string | null;
  request_id: string | null;
  created_at: Timestamp;
}

export interface InventoryTransactionsTable {
  tenant_id: string;
  id: string;
  movement_id: string;
  warehouse_id: string;
  location_id: string | null;
  product_id: string;
  variant_id: string;
  transaction_type: string;
  bucket: string;
  quantity: Numeric;
  before_quantity: Numeric;
  after_quantity: Numeric;
  balance_version: BigIntString;
  unit_cost: string | null;
  reference_type: string;
  reference_id: string;
  reference_line_id: string | null;
  channel_code: string | null;
  channel_account_id: string | null;
  user_id: string | null;
  device_id: string | null;
  reason_code: string | null;
  note: string | null;
  occurred_at: Timestamp;
  created_at: Timestamp;
  request_id: string | null;
}

export interface OutboxEventsTable {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: Generated<number>;
  payload: JsonColumn;
  headers: JsonColumn;
  created_at: Timestamp;
  published_at: Date | null;
  attempts: Generated<number>;
}

export interface ProcessedEventsTable {
  consumer: string;
  event_id: string;
  processed_at: Timestamp;
}

export interface Database {
  tenants: TenantsTable;
  warehouses: WarehousesTable;
  units: UnitsTable;
  products: ProductsTable;
  product_variants: ProductVariantsTable;
  inventory_balances: InventoryBalancesTable;
  inventory_movements: InventoryMovementsTable;
  inventory_transactions: InventoryTransactionsTable;
  outbox_events: OutboxEventsTable;
  processed_events: ProcessedEventsTable;
}

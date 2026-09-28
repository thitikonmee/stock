-- =============================================================================
-- StockOS — PostgreSQL 16 schema (reference snapshot)
-- -----------------------------------------------------------------------------
-- Conventions
--   * PK ของ tenant-scoped table = (tenant_id, id)  → FK ข้าม tenant เป็นไปไม่ได้ทางโครงสร้าง
--     และพร้อมสำหรับ Citus/sharding by tenant_id
--   * id = UUIDv7 (สร้างใน app; default ใน DB เป็น fallback)
--   * เงิน NUMERIC(14,2), จำนวน NUMERIC(14,3)
--   * enum ใช้ TEXT + CHECK (migrate ง่ายกว่า PG ENUM)
--   * ทุก tenant table เปิด RLS (ดูท้ายไฟล์)
--   * ตารางนี้เป็น snapshot; การเปลี่ยนแปลงจริงทำผ่าน db/migrations/*.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- -----------------------------------------------------------------------------
-- Roles (สร้างครั้งเดียวต่อ cluster; รหัสผ่านตั้งจาก Secrets Manager)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockos_app') THEN
    CREATE ROLE stockos_app LOGIN NOBYPASSRLS;          -- api/worker ใช้ role นี้
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockos_platform') THEN
    CREATE ROLE stockos_platform LOGIN BYPASSRLS;       -- platform-admin / cross-tenant jobs (audited)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockos_readonly') THEN
    CREATE ROLE stockos_readonly LOGIN NOBYPASSRLS;     -- reporting replica
  END IF;
END$$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  b bytea := gen_random_bytes(16);
BEGIN
  b := set_byte(b, 0, ((ts_ms >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts_ms >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts_ms >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts_ms >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts_ms >> 8) & 255)::int);
  b := set_byte(b, 5, (ts_ms & 255)::int);
  b := set_byte(b, 6, ((get_byte(b, 6) & 15) | 112));   -- version 7
  b := set_byte(b, 8, ((get_byte(b, 8) & 63) | 128));   -- variant
  RETURN encode(b, 'hex')::uuid;
END$$;

-- tenant ปัจจุบันของ session (ตั้งด้วย SET LOCAL app.tenant_id = '...' ทุก transaction)
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

-- =============================================================================
-- 1. PLATFORM (ไม่ผูก tenant)
-- =============================================================================
CREATE TABLE plans (
  id              text PRIMARY KEY,                       -- FREE, STARTER, BUSINESS, ENTERPRISE
  name            text NOT NULL,
  monthly_price   numeric(14,2) NOT NULL DEFAULT 0,
  yearly_price    numeric(14,2) NOT NULL DEFAULT 0,
  limits          jsonb NOT NULL,                         -- {"branches":1,"pos_devices":1,"skus":200,"orders_per_month":300,"channels":0,"users":2}
  features        jsonb NOT NULL DEFAULT '{}',            -- {"offline_pos":true,"channel_allocation":false,...}
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug            citext NOT NULL UNIQUE,
  name            text NOT NULL,
  legal_name      text,
  tax_id          text,                                   -- เลขประจำตัวผู้เสียภาษี 13 หลัก
  vat_registered  boolean NOT NULL DEFAULT false,
  timezone        text NOT NULL DEFAULT 'Asia/Bangkok',
  currency        char(3) NOT NULL DEFAULT 'THB',
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','LOCKED','CLOSED')),
  data_region     text NOT NULL DEFAULT 'ap-southeast-7',
  db_cluster      text NOT NULL DEFAULT 'main',           -- tenant routing (สำหรับ shard ในอนาคต)
  settings        jsonb NOT NULL DEFAULT '{}',            -- {"inventory":{"deduct_on":"SHIPPED","reservation_ttl_min":30},...}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (                                      -- global identity (1 คนอยู่ได้หลาย tenant)
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  email           citext UNIQUE,
  phone           text UNIQUE,
  password_hash   text,                                   -- argon2id
  display_name    text NOT NULL,
  locale          text NOT NULL DEFAULT 'th-TH',
  mfa_totp_secret_enc bytea,                              -- encrypted (KMS envelope)
  mfa_enabled     boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE user_sessions (                              -- refresh token (opaque, hashed, rotation)
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES tenants(id),
  family_id       uuid NOT NULL,                          -- token family: reuse → revoke ทั้ง family
  refresh_token_hash bytea NOT NULL UNIQUE,
  device_id       uuid,
  ip              inet,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE permissions (                                -- catalog (global, seed จาก code)
  code            text PRIMARY KEY,                       -- 'inventory.adjust'
  module          text NOT NULL,
  description     text NOT NULL,
  is_dangerous    boolean NOT NULL DEFAULT false          -- ต้อง step-up auth / 2FA
);

-- =============================================================================
-- 2. TENANT: IAM
-- =============================================================================
CREATE TABLE tenant_subscriptions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  plan_id         text NOT NULL REFERENCES plans(id),
  status          text NOT NULL CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  billing_cycle   text NOT NULL CHECK (billing_cycle IN ('MONTHLY','YEARLY')),
  addons          jsonb NOT NULL DEFAULT '{}',            -- {"extra_pos":2,"extra_channels":1}
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  provider        text,                                   -- stripe / omise
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE usage_counters (                             -- metering (aggregate ต่อรอบบิล)
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  metric          text NOT NULL,                          -- orders, skus, pos_devices, channels, users, api_calls
  period          date NOT NULL,                          -- วันแรกของรอบบิล
  value           bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);

CREATE TABLE roles (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- OWNER, ADMIN, ... หรือ custom slug
  name            text NOT NULL,
  is_system       boolean NOT NULL DEFAULT false,
  description     text,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE role_permissions (
  tenant_id       uuid NOT NULL,
  role_id         uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  constraints     jsonb NOT NULL DEFAULT '{}',            -- {"max_discount_pct":10,"max_amount":50000,"max_qty":20}
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tenant_memberships (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES users(id),
  employee_code   text,
  pos_pin_hash    text,                                   -- PIN สำหรับ cashier login บน POS ที่ register แล้ว
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),
  is_owner        boolean NOT NULL DEFAULT false,
  ip_allowlist    cidr[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);
CREATE UNIQUE INDEX one_owner_per_tenant ON tenant_memberships (tenant_id) WHERE is_owner;

CREATE TABLE membership_roles (
  tenant_id       uuid NOT NULL,
  membership_id   uuid NOT NULL,
  role_id         uuid NOT NULL,
  scope_type      text NOT NULL DEFAULT 'TENANT' CHECK (scope_type IN ('TENANT','BRANCH','WAREHOUSE')),
  scope_id        uuid,                                   -- branch_id / warehouse_id
  granted_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
  CHECK ((scope_type = 'TENANT') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX membership_roles_uq ON membership_roles (tenant_id, membership_id, role_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE api_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  name            text NOT NULL,
  prefix          text NOT NULL UNIQUE,                   -- 'sk_live_ab12cd' แสดงใน UI
  key_hash        bytea NOT NULL,                         -- sha256(secret) ; secret แสดงครั้งเดียว
  permissions     text[] NOT NULL,                        -- subset ของ permission catalog
  ip_allowlist    cidr[],
  rate_limit_per_min int NOT NULL DEFAULT 600,
  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- =============================================================================
-- 3. ORGANIZATION
-- =============================================================================
CREATE TABLE branches (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- BKK01
  name            text NOT NULL,
  tax_branch_no   text NOT NULL DEFAULT '00000',          -- สำนักงานใหญ่ = 00000
  address         jsonb,
  phone           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE warehouses (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  branch_id       uuid,                                   -- null = คลังกลาง/ออนไลน์
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL DEFAULT 'STORE' CHECK (type IN ('STORE','CENTRAL','ONLINE','MARKETPLACE_FULFILLMENT','TRANSIT','VIRTUAL')),
  allow_negative_stock boolean NOT NULL DEFAULT false,    -- true เฉพาะคลังหน้าร้านที่ยอมให้ offline POS ขายติดลบได้
  use_locations   boolean NOT NULL DEFAULT false,
  address         jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

CREATE TABLE warehouse_locations (                        -- Zone > Rack > Shelf > Bin
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  warehouse_id    uuid NOT NULL,
  parent_id       uuid,
  level           text NOT NULL CHECK (level IN ('ZONE','RACK','SHELF','BIN')),
  code            text NOT NULL,                          -- A / 01 / 03
  full_code       text NOT NULL,                          -- WH01-A-01-03
  barcode         text,
  is_pickable     boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, full_code),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES warehouse_locations(tenant_id, id)
);

CREATE TABLE pos_devices (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  branch_id       uuid NOT NULL,
  warehouse_id    uuid NOT NULL,                          -- คลังที่ POS นี้ตัด stock
  code            text NOT NULL,                          -- POS01
  name            text NOT NULL,
  rd_registration_no text,                                -- เลขอนุมัติเครื่อง POS จากกรมสรรพากร
  device_secret_hash bytea,                               -- สำหรับ device auth (mTLS/HMAC)
  platform        text CHECK (platform IN ('WINDOWS','MACOS','ANDROID','IPADOS','WEB')),
  app_version     text,
  last_seen_at    timestamptz,
  last_synced_seq bigint NOT NULL DEFAULT 0,              -- sequence ล่าสุดที่ server รับแล้ว
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','DISABLED','LOST')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);

CREATE TABLE document_sequences (                         -- เลขเอกสาร gap-free (ใช้ SELECT ... FOR UPDATE)
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  doc_type        text NOT NULL,                          -- SO, PO, GR, TR, ADJ, CNT, RCPT
  scope_key       text NOT NULL DEFAULT '',               -- เช่น branch/device code สำหรับใบเสร็จ
  period          text NOT NULL DEFAULT '',               -- '2610' (yyMM) ถ้า reset รายเดือน
  next_value      bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, doc_type, scope_key, period)
);

-- =============================================================================
-- 4. CATALOG
-- =============================================================================
CREATE TABLE brands (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  name            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE categories (                                 -- tree (materialized path)
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  parent_id       uuid,
  name            text NOT NULL,
  path            text NOT NULL,                          -- '/shoes/running/'
  sort_order      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories(tenant_id, id)
);
CREATE INDEX ON categories (tenant_id, path text_pattern_ops);

CREATE TABLE units (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- PCS, PACK, BOX, KG
  name            text NOT NULL,
  allow_decimal   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE suppliers (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,
  name            text NOT NULL,
  tax_id          text,
  branch_no       text,
  contact         jsonb,                                  -- [{name, phone, email, role}]
  address         jsonb,
  payment_terms_days int NOT NULL DEFAULT 30,
  default_lead_time_days int NOT NULL DEFAULT 7,
  currency        char(3) NOT NULL DEFAULT 'THB',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE products (                                   -- product family (Nike Air Max)
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- internal product code
  name            text NOT NULL,
  description     text,
  brand_id        uuid,
  category_id     uuid,
  base_unit_id    uuid NOT NULL,
  type            text NOT NULL DEFAULT 'STANDARD' CHECK (type IN ('STANDARD','BUNDLE','SERVICE','NON_STOCK')),
  options         jsonb NOT NULL DEFAULT '[]',            -- [{"name":"Color","values":["Black","White"]},{"name":"Size","values":["40","41","42"]}]
  tax_class       text NOT NULL DEFAULT 'VAT7' CHECK (tax_class IN ('VAT7','VAT0','EXEMPT')),
  track_inventory boolean NOT NULL DEFAULT true,
  attributes      jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  version         int NOT NULL DEFAULT 1,                 -- optimistic lock
  deleted_at      timestamptz,                            -- soft delete เท่านั้น (ledger อ้างอิงอยู่)
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands(tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id),
  FOREIGN KEY (tenant_id, base_unit_id) REFERENCES units(tenant_id, id)
);
CREATE UNIQUE INDEX products_code_uq ON products (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

CREATE TABLE product_variants (                           -- SKU level (Black / 41) — หน่วยที่มี stock
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  product_id      uuid NOT NULL,
  sku             text NOT NULL,
  name            text NOT NULL,                          -- 'Nike Air Max - Black / 41'
  option_values   jsonb NOT NULL DEFAULT '{}',            -- {"Color":"Black","Size":"41"}
  cost_price      numeric(14,4) NOT NULL DEFAULT 0,       -- standard/last cost (ค่าอ้างอิง)
  selling_price   numeric(14,2) NOT NULL DEFAULT 0,       -- default retail price
  weight_grams    int,
  dimensions_cm   jsonb,
  reorder_point   numeric(14,3),
  reorder_qty     numeric(14,3),
  low_stock_threshold numeric(14,3),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
  version         int NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);
CREATE UNIQUE INDEX variants_sku_uq ON product_variants (tenant_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX ON product_variants (tenant_id, product_id);
CREATE INDEX variants_name_trgm ON product_variants USING gin (name gin_trgm_ops);

CREATE TABLE variant_barcodes (                           -- 1 variant มีได้หลาย barcode (EAN ผู้ผลิต + barcode ภายใน + ต่อ unit)
  tenant_id       uuid NOT NULL,
  barcode         text NOT NULL,
  variant_id      uuid NOT NULL,
  symbology       text NOT NULL CHECK (symbology IN ('EAN13','EAN8','UPCA','UPCE','CODE128','QR','INTERNAL')),
  unit_id         uuid,                                   -- scan barcode ลัง = 12 ชิ้น
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, barcode),                       -- barcode unique ต่อ tenant → scan แล้วได้ variant เดียว
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);
CREATE INDEX ON variant_barcodes (tenant_id, variant_id);

CREATE TABLE product_units (                              -- unit conversion ต่อ product: 1 BOX = 12 PCS
  tenant_id       uuid NOT NULL,
  product_id      uuid NOT NULL,
  unit_id         uuid NOT NULL,
  factor_to_base  numeric(14,6) NOT NULL CHECK (factor_to_base > 0),
  is_purchase_unit boolean NOT NULL DEFAULT false,
  is_sales_unit   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, product_id, unit_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE bundle_components (                          -- Bundle/Kit: stock คำนวณจาก component
  tenant_id       uuid NOT NULL,
  bundle_variant_id uuid NOT NULL,
  component_variant_id uuid NOT NULL,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, bundle_variant_id, component_variant_id),
  FOREIGN KEY (tenant_id, bundle_variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, component_variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (bundle_variant_id <> component_variant_id)
);

CREATE TABLE product_images (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  product_id      uuid NOT NULL,
  variant_id      uuid,
  storage_key     text NOT NULL,
  sort_order      int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE supplier_products (
  tenant_id       uuid NOT NULL,
  supplier_id     uuid NOT NULL,
  variant_id      uuid NOT NULL,
  supplier_sku    text,
  last_cost       numeric(14,4),
  min_order_qty   numeric(14,3),
  lead_time_days  int,
  is_preferred    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, supplier_id, variant_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);

-- =============================================================================
-- 5. INVENTORY  ★
-- =============================================================================
-- Current state: 1 แถวต่อ (tenant, warehouse, variant). แก้ได้เฉพาะผ่าน InventoryService
CREATE TABLE inventory_balances (
  tenant_id       uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  variant_id      uuid NOT NULL,
  on_hand         numeric(14,3) NOT NULL DEFAULT 0,       -- ของจริงที่อยู่ในคลัง (สภาพดี)
  reserved        numeric(14,3) NOT NULL DEFAULT 0,       -- soft hold: order ยังไม่จ่าย/ยังไม่ยืนยัน (มี TTL)
  committed       numeric(14,3) NOT NULL DEFAULT 0,       -- hard hold: order ยืนยันแล้ว รอส่ง
  damaged         numeric(14,3) NOT NULL DEFAULT 0,       -- ชำรุด/รอตรวจ (ไม่นับใน on_hand)
  incoming        numeric(14,3) NOT NULL DEFAULT 0,       -- PO อนุมัติแล้ว/transfer in-transit ยังไม่รับ
  available       numeric(14,3) GENERATED ALWAYS AS (on_hand - reserved - committed) STORED,
  negative_allowed boolean NOT NULL DEFAULT false,        -- copy จาก warehouse policy
  version         bigint NOT NULL DEFAULT 0,              -- เพิ่มทุกครั้งที่เปลี่ยน (ใช้ส่ง channel/ETag)
  last_transaction_id uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, warehouse_id, variant_id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (reserved >= 0 AND committed >= 0 AND damaged >= 0 AND incoming >= 0),
  CHECK (negative_allowed OR on_hand >= 0)
  -- หมายเหตุ: available < 0 ไม่ใช่ CHECK เพราะ adjustment (ของหาย) ขณะมี reservation อาจทำให้ติดลบได้จริง
  -- → กรณีนี้คือ OVERCOMMITTED: ระบบ alert + ไม่ให้ reserve เพิ่ม (บังคับใน conditional UPDATE)
);
CREATE INDEX inventory_balances_variant ON inventory_balances (tenant_id, variant_id);
CREATE INDEX inventory_balances_low ON inventory_balances (tenant_id, warehouse_id) WHERE available <= 0;

-- Location-level balance (ใช้เมื่อ warehouse.use_locations = true) — ผลรวมต้องเท่ากับ inventory_balances.on_hand
CREATE TABLE inventory_location_balances (
  tenant_id       uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  location_id     uuid NOT NULL,
  variant_id      uuid NOT NULL,
  on_hand         numeric(14,3) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, location_id, variant_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);

-- Movement header: 1 business operation = 1 movement (idempotency อยู่ที่นี่)
CREATE TABLE inventory_movements (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  idempotency_key text NOT NULL,                          -- 'order:{id}:reserve:v1', 'pos:{device}:{client_txn_id}:sale'
  movement_type   text NOT NULL,                          -- เหมือน transaction_type หลักของ movement
  reference_type  text NOT NULL,
  reference_id    uuid NOT NULL,
  channel_code    text,
  user_id         uuid,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ON inventory_movements (tenant_id, reference_type, reference_id);

-- LEDGER (source of truth, append-only). 1 แถว = การเปลี่ยน 1 bucket ของ 1 (warehouse, variant)
CREATE TABLE inventory_transactions (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  movement_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  location_id     uuid,
  product_id      uuid NOT NULL,
  variant_id      uuid NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN (
      'OPENING','PURCHASE_RECEIPT','SALE','RETURN','ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN',
      'DAMAGE','LOSS','FOUND','COUNT_VARIANCE','RESERVATION','RELEASE','COMMIT','UNCOMMIT',
      'CANCEL','REFUND_RESTOCK','INCOMING','INCOMING_CANCEL','BUNDLE_ASSEMBLE','BUNDLE_DISASSEMBLE','REBUILD_CORRECTION')),
  bucket          text NOT NULL CHECK (bucket IN ('ON_HAND','RESERVED','COMMITTED','DAMAGED','INCOMING')),
  quantity        numeric(14,3) NOT NULL CHECK (quantity <> 0),  -- signed delta ของ bucket นี้
  before_quantity numeric(14,3) NOT NULL,
  after_quantity  numeric(14,3) NOT NULL,
  balance_version bigint NOT NULL,                        -- inventory_balances.version หลังการเปลี่ยน → ลำดับที่แท้จริงต่อแถว
                                                          -- (created_at = เวลาเริ่ม tx ไม่ใช่ลำดับ commit)
  unit_cost       numeric(14,4),                          -- cost ณ เวลานั้น (สำหรับ COGS/valuation)
  reference_type  text NOT NULL,                          -- ORDER, ORDER_ITEM, POS_SALE, PURCHASE_RECEIPT, TRANSFER, ADJUSTMENT, COUNT, RECONCILIATION
  reference_id    uuid NOT NULL,
  reference_line_id uuid,
  channel_code    text,                                   -- POS, SHOPEE, LAZADA, TIKTOK, WEBSITE, API, SYSTEM
  channel_account_id uuid,
  user_id         uuid,                                   -- ใครเป็นคนทำ (null = system)
  device_id       uuid,                                   -- POS device
  reason_code     text,                                   -- DAMAGE, LOST, FOUND, COUNT_ERROR, EXPIRED, OTHER
  note            text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),     -- เวลาทางธุรกิจ (offline POS = เวลาขายจริง)
  created_at      timestamptz NOT NULL DEFAULT now(),     -- เวลาที่บันทึกเข้า server
  request_id      text,
  PRIMARY KEY (tenant_id, id, created_at),
  CHECK (after_quantity = before_quantity + quantity)
) PARTITION BY RANGE (created_at);

CREATE TABLE inventory_transactions_default PARTITION OF inventory_transactions DEFAULT;
CREATE TABLE inventory_transactions_2026_10 PARTITION OF inventory_transactions
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- partition รายเดือนสร้างล่วงหน้าด้วย pg_partman (premake = 3)

CREATE INDEX inv_tx_variant_time ON inventory_transactions (tenant_id, variant_id, warehouse_id, created_at);
CREATE INDEX inv_tx_stock_card   ON inventory_transactions (tenant_id, warehouse_id, variant_id, balance_version);
CREATE INDEX inv_tx_reference    ON inventory_transactions (tenant_id, reference_type, reference_id);
CREATE INDEX inv_tx_movement     ON inventory_transactions (tenant_id, movement_id);

-- Ledger immutability
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END$$;
CREATE TRIGGER inventory_transactions_immutable
  BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reservation: ติดตามทุก hold ระดับ order line (release/commit ต้องอ้างอิงที่นี่)
CREATE TABLE inventory_reservations (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  warehouse_id    uuid NOT NULL,
  variant_id      uuid NOT NULL,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  fulfilled_qty   numeric(14,3) NOT NULL DEFAULT 0,       -- ส่งไปแล้ว (partial shipment)
  released_qty    numeric(14,3) NOT NULL DEFAULT 0,       -- ปล่อยคืนแล้ว (partial cancel)
  status          text NOT NULL CHECK (status IN ('RESERVED','COMMITTED','PARTIALLY_FULFILLED','FULFILLED','RELEASED','EXPIRED')),
  reference_type  text NOT NULL,                          -- ORDER_ITEM, TRANSFER_ITEM
  reference_id    uuid NOT NULL,
  channel_code    text,
  expires_at      timestamptz,                            -- เฉพาะ RESERVED (soft)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reference_type, reference_id, warehouse_id, variant_id),
  FOREIGN KEY (tenant_id, warehouse_id, variant_id) REFERENCES inventory_balances(tenant_id, warehouse_id, variant_id),
  CHECK (fulfilled_qty + released_qty <= quantity)
);
CREATE INDEX reservations_expiry ON inventory_reservations (expires_at) WHERE status = 'RESERVED';
CREATE INDEX ON inventory_reservations (tenant_id, variant_id, warehouse_id) WHERE status IN ('RESERVED','COMMITTED','PARTIALLY_FULFILLED');

-- Moving weighted average cost ต่อ variant (ระดับ tenant)
CREATE TABLE variant_costs (
  tenant_id       uuid NOT NULL,
  variant_id      uuid NOT NULL,
  avg_cost        numeric(14,4) NOT NULL DEFAULT 0,
  qty_basis       numeric(14,3) NOT NULL DEFAULT 0,
  last_cost       numeric(14,4),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, variant_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);

CREATE TABLE stock_adjustments (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  doc_no          text NOT NULL,
  warehouse_id    uuid NOT NULL,
  reason_code     text NOT NULL CHECK (reason_code IN ('DAMAGE','LOST','FOUND','COUNT_ERROR','EXPIRED','OPENING','OTHER')),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','POSTED','REJECTED','CANCELLED')),
  source_type     text,                                   -- COUNT, MANUAL, RECONCILIATION, AI_SUGGESTION
  source_id       uuid,
  note            text,
  requested_by    uuid NOT NULL,
  approved_by     uuid,
  approved_at     timestamptz,
  posted_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)  -- segregation of duties
);

CREATE TABLE stock_adjustment_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  adjustment_id   uuid NOT NULL,
  variant_id      uuid NOT NULL,
  location_id     uuid,
  bucket          text NOT NULL DEFAULT 'ON_HAND' CHECK (bucket IN ('ON_HAND','DAMAGED')),
  quantity_delta  numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost       numeric(14,4),
  note            text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES stock_adjustments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);

CREATE TABLE stock_transfers (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  doc_no          text NOT NULL,
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id uuid NOT NULL,
  status          text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('DRAFT','REQUESTED','APPROVED','PICKING','SHIPPED','PARTIALLY_RECEIVED','RECEIVED','COMPLETED','CANCELLED')),
  requested_by    uuid NOT NULL,
  approved_by     uuid,
  shipped_at      timestamptz,
  received_at     timestamptz,
  note            text,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, from_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouses(tenant_id, id),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE stock_transfer_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  transfer_id     uuid NOT NULL,
  variant_id      uuid NOT NULL,
  requested_qty   numeric(14,3) NOT NULL CHECK (requested_qty > 0),
  approved_qty    numeric(14,3),
  shipped_qty     numeric(14,3) NOT NULL DEFAULT 0,
  received_qty    numeric(14,3) NOT NULL DEFAULT 0,
  damaged_qty     numeric(14,3) NOT NULL DEFAULT 0,       -- เสียหายระหว่างขนส่ง
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, transfer_id, variant_id),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (received_qty + damaged_qty <= shipped_qty)
);

CREATE TABLE stock_counts (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  doc_no          text NOT NULL,
  warehouse_id    uuid NOT NULL,
  count_type      text NOT NULL CHECK (count_type IN ('FULL','CYCLE','BLIND','SPOT')),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_PROGRESS','SUBMITTED','PENDING_APPROVAL','APPROVED','POSTED','CANCELLED')),
  scope           jsonb NOT NULL DEFAULT '{}',            -- {"category_ids":[...],"location_ids":[...]}
  freeze_mode     text NOT NULL DEFAULT 'SNAPSHOT' CHECK (freeze_mode IN ('SNAPSHOT','FREEZE')),
  started_at      timestamptz,
  submitted_at    timestamptz,
  approved_by     uuid,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);

CREATE TABLE stock_count_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  count_id        uuid NOT NULL,
  variant_id      uuid NOT NULL,
  location_id     uuid,
  snapshot_qty    numeric(14,3),                          -- on_hand ตอนเริ่มนับ (ซ่อนจากพนักงานถ้า BLIND)
  snapshot_tx_id  uuid,                                   -- ledger position ตอน snapshot
  counted_qty     numeric(14,3),
  movement_since_snapshot numeric(14,3) NOT NULL DEFAULT 0,  -- ขาย/รับ ระหว่างนับ (คำนวณจาก ledger)
  variance        numeric(14,3),                          -- counted - (snapshot + movement_since)
  counted_by      uuid,
  counted_at      timestamptz,
  recount_required boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, count_id, variant_id, location_id),
  FOREIGN KEY (tenant_id, count_id) REFERENCES stock_counts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);

-- =============================================================================
-- 6. CUSTOMERS / LOYALTY
-- =============================================================================
CREATE TABLE membership_tiers (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- SILVER, GOLD, PLATINUM
  name            text NOT NULL,
  rank            int NOT NULL,
  min_spend_12m   numeric(14,2) NOT NULL DEFAULT 0,
  points_multiplier numeric(6,3) NOT NULL DEFAULT 1,
  price_list_id   uuid,
  benefits        jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE customers (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text,
  name            text NOT NULL,
  phone_e164      text,                                   -- +66812345678 (normalize ก่อนเก็บ)
  email           citext,
  tax_id          text,
  company_name    text,
  birth_date      date,
  tags            text[] NOT NULL DEFAULT '{}',
  total_spent     numeric(14,2) NOT NULL DEFAULT 0,       -- denormalized (update async)
  order_count     int NOT NULL DEFAULT 0,
  last_order_at   timestamptz,
  merged_into_id  uuid,                                   -- customer merge (ไม่ลบ record เดิม)
  pdpa_consent    jsonb NOT NULL DEFAULT '{}',            -- {"marketing":{"granted":true,"at":"...","source":"POS"}}
  deleted_at      timestamptz,                            -- PDPA erasure → anonymize + deleted_at
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id) REFERENCES customers(tenant_id, id)
);
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND merged_into_id IS NULL AND deleted_at IS NULL;
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);

CREATE TABLE customer_addresses (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  customer_id     uuid NOT NULL,
  label           text,
  recipient       text,
  phone           text,
  address_line    text,
  subdistrict     text, district text, province text, postal_code text,
  is_default      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE customer_identities (                        -- ใช้ merge ลูกค้าข้าม channel
  tenant_id       uuid NOT NULL,
  channel_code    text NOT NULL,                          -- SHOPEE, LAZADA, TIKTOK, LINE, WEBSITE
  external_id     text NOT NULL,                          -- buyer_user_id / hashed
  customer_id     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_code, external_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE memberships (
  tenant_id       uuid NOT NULL,
  customer_id     uuid NOT NULL,
  member_no       text NOT NULL,
  tier_id         uuid,
  points_balance  numeric(14,2) NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  tier_expires_at date,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  version         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, customer_id),
  UNIQUE (tenant_id, member_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, tier_id) REFERENCES membership_tiers(tenant_id, id)
);

CREATE TABLE loyalty_transactions (                       -- points ledger (เหมือน inventory ledger)
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  customer_id     uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('EARN','REDEEM','EXPIRE','ADJUST','REVERSE')),
  points          numeric(14,2) NOT NULL,
  balance_after   numeric(14,2) NOT NULL,
  reference_type  text, reference_id uuid,
  idempotency_key text NOT NULL,
  expires_at      date,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES memberships(tenant_id, customer_id)
);

-- =============================================================================
-- 7. PRICING / PROMOTION
-- =============================================================================
CREATE TABLE price_lists (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,                          -- RETAIL, WHOLESALE, MEMBER, VIP, SHOPEE, LAZADA, TIKTOK
  name            text NOT NULL,
  channel_code    text,                                   -- ผูกกับ channel (optional)
  price_includes_tax boolean NOT NULL DEFAULT true,
  priority        int NOT NULL DEFAULT 100,
  is_default      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE prices (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  price_list_id   uuid NOT NULL,
  variant_id      uuid NOT NULL,
  min_qty         numeric(14,3) NOT NULL DEFAULT 1,       -- tier pricing
  price           numeric(14,2) NOT NULL CHECK (price >= 0),
  valid_from      timestamptz NOT NULL DEFAULT '-infinity',
  valid_to        timestamptz NOT NULL DEFAULT 'infinity', -- scheduled pricing
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (valid_from < valid_to)
);
CREATE INDEX prices_lookup ON prices (tenant_id, price_list_id, variant_id, valid_from, valid_to);
-- (production: EXCLUDE USING gist กันช่วงเวลาทับซ้อนต่อ (price_list, variant, min_qty) — ต้องใช้ btree_gist)

CREATE TABLE promotions (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('PERCENT_OFF','FIXED_OFF','BUY_X_GET_Y','BUNDLE_PRICE','FREE_ITEM','TIER_PRICE','CART_THRESHOLD')),
  conditions      jsonb NOT NULL,                         -- {"channels":["POS"],"branches":[...],"min_subtotal":500,"variant_ids":[...],"tiers":["GOLD"]}
  reward          jsonb NOT NULL,                         -- {"percent":10,"max_discount":200} / {"buy":2,"get":1,"get_variant_ids":[...]}
  priority        int NOT NULL DEFAULT 100,               -- น้อย = ทำก่อน
  stackable       boolean NOT NULL DEFAULT false,
  exclusive_group text,                                   -- promotion ในกลุ่มเดียวกันใช้ได้แค่ 1
  usage_limit     int,
  usage_count     int NOT NULL DEFAULT 0,
  per_customer_limit int,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','PAUSED','ENDED')),
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE coupons (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  promotion_id    uuid NOT NULL,
  code            citext NOT NULL,
  customer_id     uuid,                                   -- coupon เฉพาะบุคคล
  max_redemptions int NOT NULL DEFAULT 1,
  redeemed_count  int NOT NULL DEFAULT 0,
  expires_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions(tenant_id, id),
  CHECK (redeemed_count <= max_redemptions)
);

CREATE TABLE coupon_redemptions (
  tenant_id       uuid NOT NULL,
  coupon_id       uuid NOT NULL,
  order_id        uuid NOT NULL,
  customer_id     uuid,
  amount          numeric(14,2) NOT NULL,
  reversed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, coupon_id, order_id)
);

-- =============================================================================
-- 8. CHANNELS
-- =============================================================================
CREATE TABLE channels (                                   -- platform catalog (global)
  code            text PRIMARY KEY,                       -- POS, SHOPEE, LAZADA, TIKTOK, WEBSITE, API, LINE_SHOPPING, SHOPIFY
  name            text NOT NULL,
  capabilities    jsonb NOT NULL,                         -- {"webhook":true,"stock_push":true,"price_push":true,"partial_ship":false,"order_cancel":true}
  is_marketplace  boolean NOT NULL,
  is_enabled      boolean NOT NULL DEFAULT true
);

CREATE TABLE channel_accounts (                           -- ร้านที่เชื่อม (1 Shopee shop = 1 แถว)
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_code    text NOT NULL REFERENCES channels(code),
  external_shop_id text NOT NULL,                         -- Shopee shop_id / Lazada seller_id / TikTok shop_id
  shop_name       text,
  region          text NOT NULL DEFAULT 'TH',
  status          text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTING','CONNECTED','TOKEN_EXPIRED','ERROR','PAUSED','DISCONNECTED')),
  default_warehouse_id uuid,                              -- คลังที่ fulfill order ของ shop นี้
  price_list_id   uuid,
  settings        jsonb NOT NULL DEFAULT '{}',            -- {"auto_import_orders":true,"push_stock":true,"push_price":false,"polling_interval_sec":300}
  last_order_sync_at timestamptz,                         -- high-water mark สำหรับ polling
  last_error      text,
  connected_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouses(tenant_id, id)
);
-- shop หนึ่งเชื่อมได้กับ tenant เดียว (กันร้านเดียวถูก 2 tenant ดึง stock)
CREATE UNIQUE INDEX channel_accounts_shop_uq ON channel_accounts (channel_code, region, external_shop_id) WHERE status <> 'DISCONNECTED';

CREATE TABLE channel_credentials (                        -- แยก table + เข้ารหัส; app อ่านผ่าน CredentialVault เท่านั้น
  tenant_id       uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  access_token_enc  bytea NOT NULL,                       -- AES-256-GCM, DEK wrapped ด้วย KMS
  refresh_token_enc bytea,
  dek_wrapped     bytea NOT NULL,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  scopes          text[],
  extra_enc       bytea,                                  -- เช่น TikTok shop_cipher
  refreshed_at    timestamptz,
  version         bigint NOT NULL DEFAULT 0,              -- กัน refresh ซ้อนกัน (optimistic)
  PRIMARY KEY (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX channel_credentials_expiry ON channel_credentials (access_expires_at);

CREATE TABLE channel_warehouses (                         -- channel นี้ขายจาก stock ของคลังไหนบ้าง
  tenant_id       uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  priority        int NOT NULL DEFAULT 100,               -- ใช้เลือกคลัง fulfill
  PRIMARY KEY (tenant_id, channel_account_id, warehouse_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);

CREATE TABLE channel_stock_policies (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_account_id uuid,                                -- null = default ของ tenant
  variant_id      uuid,                                   -- null = ทุก SKU
  strategy        text NOT NULL DEFAULT 'GLOBAL_POOL' CHECK (strategy IN ('GLOBAL_POOL','CHANNEL_ALLOCATION')),
  safety_stock    numeric(14,3) NOT NULL DEFAULT 0,       -- ไม่ส่งส่วนนี้ให้ channel
  buffer_percent  numeric(5,2) NOT NULL DEFAULT 0,        -- ส่งแค่ (100 - x)% ของ available
  max_push_qty    numeric(14,3),                          -- เพดาน
  push_zero_below numeric(14,3) NOT NULL DEFAULT 0,       -- ถ้า sellable <= x → push 0
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id)
);
CREATE UNIQUE INDEX channel_stock_policies_uq ON channel_stock_policies (
  tenant_id,
  coalesce(channel_account_id, '00000000-0000-0000-0000-000000000000'),
  coalesce(variant_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE channel_allocations (                        -- ใช้เมื่อ strategy = CHANNEL_ALLOCATION
  tenant_id       uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  variant_id      uuid NOT NULL,
  allocated_qty   numeric(14,3) NOT NULL CHECK (allocated_qty >= 0),   -- โควต้าที่ให้ channel นี้
  consumed_qty    numeric(14,3) NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0), -- reserve/sold แล้วจากโควต้า
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_account_id, warehouse_id, variant_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id, variant_id) REFERENCES inventory_balances(tenant_id, warehouse_id, variant_id)
);

CREATE TABLE channel_products (                           -- listing ระดับ item บน platform
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_account_id uuid NOT NULL,
  external_item_id text NOT NULL,                         -- Shopee item_id / Lazada item_id / TikTok product_id
  product_id      uuid,                                   -- internal (null = ยังไม่ map)
  title           text,
  status          text,                                   -- NORMAL/UNLIST/BANNED/DELETED (ตาม platform, normalize)
  raw             jsonb,                                  -- snapshot ล่าสุด
  last_synced_at  timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id, external_item_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE channel_product_variants (                   -- ★ SKU MAPPING: internal variant ↔ external model/sku
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_account_id uuid NOT NULL,
  channel_product_id uuid NOT NULL,
  external_item_id  text NOT NULL,
  external_variant_id text NOT NULL DEFAULT '',           -- Shopee model_id / Lazada SkuId / TikTok sku_id ('' = no variation)
  external_sku    text,                                   -- seller SKU ที่กรอกบน platform
  variant_id      uuid,                                   -- internal (null = UNMAPPED)
  quantity_multiplier numeric(14,3) NOT NULL DEFAULT 1,   -- listing "แพ็ค 3" = 3 x variant
  mapping_status  text NOT NULL DEFAULT 'UNMAPPED' CHECK (mapping_status IN ('UNMAPPED','AUTO_MAPPED','CONFIRMED','CONFLICT','BROKEN')),
  mapping_method  text,                                   -- SKU_MATCH, BARCODE_MATCH, MANUAL
  sync_stock      boolean NOT NULL DEFAULT true,
  sync_price      boolean NOT NULL DEFAULT false,
  last_pushed_qty numeric(14,3),                          -- ค่าที่ push สำเร็จล่าสุด
  last_pushed_balance_version bigint,                     -- กัน push ค่าเก่าทับค่าใหม่
  last_pushed_at  timestamptz,
  last_channel_qty numeric(14,3),                         -- ค่าที่อ่านจาก platform ล่าสุด (reconcile)
  last_channel_read_at timestamptz,
  external_status text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id, external_item_id, external_variant_id),
  FOREIGN KEY (tenant_id, channel_product_id) REFERENCES channel_products(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);
CREATE INDEX cpv_by_variant ON channel_product_variants (tenant_id, variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX cpv_unmapped ON channel_product_variants (tenant_id, channel_account_id) WHERE mapping_status IN ('UNMAPPED','CONFLICT','BROKEN');

-- =============================================================================
-- 9. ORDERS
-- =============================================================================
CREATE TABLE orders (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_no        text NOT NULL,                          -- SO-2610-000123 หรือ receipt no. สำหรับ POS
  channel_code    text NOT NULL REFERENCES channels(code),
  channel_account_id uuid,
  channel_order_id text,                                  -- external order sn / id
  branch_id       uuid,
  fulfillment_warehouse_id uuid,
  pos_device_id   uuid,
  pos_shift_id    uuid,
  client_txn_id   uuid,                                   -- POS client-generated id (offline idempotency)
  device_seq      bigint,                                 -- sequence ต่อ device
  customer_id     uuid,
  cashier_id      uuid,
  status          text NOT NULL CHECK (status IN ('DRAFT','PENDING','PAID','CONFIRMED','PROCESSING','PACKED','SHIPPED','DELIVERED','COMPLETED','CANCELLED','RETURNED','REFUNDED','PARTIALLY_REFUNDED','ON_HOLD')),
  payment_status  text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PENDING','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED','FAILED')),
  fulfillment_status text NOT NULL DEFAULT 'UNFULFILLED' CHECK (fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED','FULFILLED','RETURNED','PARTIALLY_RETURNED')),
  inventory_status text NOT NULL DEFAULT 'NONE' CHECK (inventory_status IN ('NONE','RESERVED','PARTIALLY_RESERVED','COMMITTED','DEDUCTED','RELEASED','BACKORDER','FAILED')),
  hold_reason     text,                                   -- UNMAPPED_SKU, INSUFFICIENT_STOCK, FRAUD_CHECK
  currency        char(3) NOT NULL DEFAULT 'THB',
  price_includes_tax boolean NOT NULL DEFAULT true,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  shipping_fee    numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  rounding        numeric(14,2) NOT NULL DEFAULT 0,       -- ปัดเศษสตางค์
  grand_total     numeric(14,2) NOT NULL DEFAULT 0,
  platform_fee_total numeric(14,2) NOT NULL DEFAULT 0,    -- commission/fee จาก marketplace (สำหรับกำไร)
  paid_total      numeric(14,2) NOT NULL DEFAULT 0,
  refunded_total  numeric(14,2) NOT NULL DEFAULT 0,
  buyer_snapshot  jsonb,                                  -- ชื่อ/เบอร์ ณ เวลาสั่ง (PII — mask ตาม permission)
  shipping_address jsonb,
  shipping_carrier text,
  tracking_no     text,
  channel_status  text,                                   -- status ดิบจาก platform
  channel_updated_at timestamptz,                         -- update_time จาก platform → กัน out-of-order
  placed_at       timestamptz NOT NULL,
  paid_at         timestamptz,
  shipped_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    text,                                   -- BUYER, SELLER, SYSTEM, PLATFORM
  note            text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_no),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, fulfillment_warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, pos_device_id) REFERENCES pos_devices(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
-- ★ กัน order ซ้ำจาก webhook/polling/retry
CREATE UNIQUE INDEX orders_channel_uq ON orders (tenant_id, channel_account_id, channel_order_id) WHERE channel_order_id IS NOT NULL;
-- ★ กัน POS offline sync ซ้ำ
CREATE UNIQUE INDEX orders_pos_client_uq ON orders (tenant_id, pos_device_id, client_txn_id) WHERE client_txn_id IS NOT NULL;
CREATE INDEX orders_list ON orders (tenant_id, placed_at DESC);
CREATE INDEX orders_status ON orders (tenant_id, status, placed_at DESC);
CREATE INDEX orders_channel_time ON orders (tenant_id, channel_code, placed_at DESC);
CREATE INDEX orders_customer ON orders (tenant_id, customer_id, placed_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX orders_on_hold ON orders (tenant_id) WHERE status = 'ON_HOLD';

CREATE TABLE order_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  line_no         int NOT NULL,
  variant_id      uuid,                                   -- null = unmapped (order ON_HOLD)
  parent_item_id  uuid,                                   -- component ของ bundle ชี้ไปที่ bundle line
  is_bundle_parent boolean NOT NULL DEFAULT false,        -- bundle line ไม่ตัด stock ตัวเอง (ตัด component)
  sku             text NOT NULL,
  name            text NOT NULL,
  channel_item_ref jsonb,                                 -- {"item_id":"12345","model_id":"67890","order_item_id":"..."}
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,2) NOT NULL,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate        numeric(5,2) NOT NULL DEFAULT 7,
  tax_amount      numeric(14,2) NOT NULL DEFAULT 0,
  line_total      numeric(14,2) NOT NULL,
  unit_cost       numeric(14,4),                          -- COGS snapshot ตอนตัด stock
  fulfilled_qty   numeric(14,3) NOT NULL DEFAULT 0,
  cancelled_qty   numeric(14,3) NOT NULL DEFAULT 0,
  returned_qty    numeric(14,3) NOT NULL DEFAULT 0,
  refunded_amount numeric(14,2) NOT NULL DEFAULT 0,
  promotion_ids   uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (fulfilled_qty + cancelled_qty <= quantity),
  CHECK (returned_qty <= fulfilled_qty)
);
CREATE INDEX order_items_variant ON order_items (tenant_id, variant_id);

CREATE TABLE order_status_history (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  from_status     text,
  to_status       text NOT NULL,
  source          text NOT NULL,                          -- USER, CHANNEL_WEBHOOK, CHANNEL_POLL, SYSTEM, POS_SYNC
  source_ref      text,                                   -- webhook_event id ฯลฯ
  actor_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ON order_status_history (tenant_id, order_id, created_at);

CREATE TABLE fulfillments (                               -- รองรับ partial shipment (1 order หลาย package)
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('PENDING','PICKING','PACKED','SHIPPED','DELIVERED','CANCELLED','RETURNED')),
  channel_package_id text,                                -- package_number (Shopee) / package_id (TikTok)
  carrier         text,
  tracking_no     text,
  picked_by       uuid, packed_by uuid,
  shipped_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);

CREATE TABLE fulfillment_items (
  tenant_id       uuid NOT NULL,
  fulfillment_id  uuid NOT NULL,
  order_item_id   uuid NOT NULL,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, fulfillment_id, order_item_id),
  FOREIGN KEY (tenant_id, fulfillment_id) REFERENCES fulfillments(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id)
);

CREATE TABLE order_returns (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  channel_return_id text,
  status          text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','REJECTED','IN_TRANSIT','RECEIVED','INSPECTED','COMPLETED','CANCELLED')),
  receive_warehouse_id uuid,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);
CREATE UNIQUE INDEX order_returns_channel_uq ON order_returns (tenant_id, order_id, channel_return_id) WHERE channel_return_id IS NOT NULL;

CREATE TABLE order_return_items (
  tenant_id       uuid NOT NULL,
  return_id       uuid NOT NULL,
  order_item_id   uuid NOT NULL,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  condition       text CHECK (condition IN ('SELLABLE','DAMAGED','MISSING')),  -- ผลตรวจ QC → ON_HAND / DAMAGED / ไม่คืน stock
  restocked_qty   numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, return_id, order_item_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES order_returns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id)
);

-- External order snapshot (raw state จาก platform; order ภายในสร้างจากที่นี่)
CREATE TABLE channel_orders (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_account_id uuid NOT NULL,
  external_order_id text NOT NULL,
  order_id        uuid,                                   -- internal order
  external_status text NOT NULL,
  external_update_time timestamptz NOT NULL,              -- ใช้ตัดสิน out-of-order: รับเฉพาะที่ใหม่กว่า
  payload         jsonb NOT NULL,                         -- order detail ล่าสุด (ดึงจาก API, ไม่ใช่จาก webhook body)
  payload_hash    bytea NOT NULL,
  processing_status text NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','PROCESSED','ON_HOLD','FAILED')),
  error           text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel_account_id, external_order_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES channel_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

CREATE TABLE channel_order_items (
  tenant_id       uuid NOT NULL,
  channel_order_id uuid NOT NULL,
  external_line_id text NOT NULL,
  external_item_id text NOT NULL,
  external_variant_id text NOT NULL DEFAULT '',
  external_sku    text,
  quantity        numeric(14,3) NOT NULL,
  mapped_variant_id uuid,
  order_item_id   uuid,
  PRIMARY KEY (tenant_id, channel_order_id, external_line_id),
  FOREIGN KEY (tenant_id, channel_order_id) REFERENCES channel_orders(tenant_id, id) ON DELETE CASCADE
);

-- =============================================================================
-- 10. PAYMENTS
-- =============================================================================
CREATE TABLE payments (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  method          text NOT NULL CHECK (method IN ('CASH','CREDIT_CARD','DEBIT_CARD','PROMPTPAY','QR','BANK_TRANSFER','GATEWAY','MARKETPLACE','STORE_CREDIT','POINTS','VOUCHER')),
  provider        text,                                   -- opn, 2c2p, kbank, edc_manual, shopee
  provider_ref    text,                                   -- charge id / approval code
  status          text NOT NULL CHECK (status IN ('PENDING','AUTHORIZED','SUCCEEDED','FAILED','CANCELLED','EXPIRED')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  tendered_amount numeric(14,2),                          -- เงินสดที่รับมา
  change_amount   numeric(14,2),                          -- เงินทอน
  fee_amount      numeric(14,2) NOT NULL DEFAULT 0,       -- MDR / gateway fee
  refunded_amount numeric(14,2) NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  failure_code    text,
  paid_at         timestamptz,
  pos_shift_id    uuid,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  CHECK (refunded_amount <= amount)
);
CREATE UNIQUE INDEX payments_provider_uq ON payments (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX ON payments (tenant_id, order_id);

CREATE TABLE refunds (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  order_id        uuid NOT NULL,
  payment_id      uuid,
  return_id       uuid,
  doc_no          text NOT NULL,                          -- ใบลดหนี้ (credit note) no.
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  reason          text NOT NULL,
  restock         boolean NOT NULL DEFAULT false,
  status          text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  provider_ref    text,
  idempotency_key text NOT NULL,
  approved_by     uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id)
);

CREATE TABLE refund_items (
  tenant_id       uuid NOT NULL,
  refund_id       uuid NOT NULL,
  order_item_id   uuid NOT NULL,
  quantity        numeric(14,3) NOT NULL DEFAULT 0,
  amount          numeric(14,2) NOT NULL,
  PRIMARY KEY (tenant_id, refund_id, order_item_id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id)
);

-- =============================================================================
-- 11. POS
-- =============================================================================
CREATE TABLE pos_shifts (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL,                          -- client-generated (เปิด shift ตอน offline ได้)
  pos_device_id   uuid NOT NULL,
  cashier_id      uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('OPEN','CLOSED','RECONCILED')),
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz,
  opening_cash    numeric(14,2) NOT NULL,
  expected_cash   numeric(14,2),
  counted_cash    numeric(14,2),
  cash_variance   numeric(14,2),
  summary         jsonb,                                  -- ยอดแยก payment method, จำนวนบิล, void, refund
  closed_by       uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, pos_device_id) REFERENCES pos_devices(tenant_id, id)
);
CREATE UNIQUE INDEX one_open_shift_per_device ON pos_shifts (tenant_id, pos_device_id) WHERE status = 'OPEN';

CREATE TABLE pos_cash_movements (                         -- เงินเข้า/ออกลิ้นชัก (ไม่ใช่การขาย)
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL,
  shift_id        uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('PAY_IN','PAY_OUT','DROP','NO_SALE_OPEN')),
  amount          numeric(14,2) NOT NULL,
  reason          text,
  user_id         uuid NOT NULL,
  approved_by     uuid,
  occurred_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES pos_shifts(tenant_id, id)
);

CREATE TABLE pos_sync_batches (                           -- offline sync log
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL,                          -- client batch id (idempotent)
  pos_device_id   uuid NOT NULL,
  from_seq        bigint NOT NULL,
  to_seq          bigint NOT NULL,
  event_count     int NOT NULL,
  status          text NOT NULL CHECK (status IN ('RECEIVED','APPLIED','PARTIAL','FAILED')),
  result          jsonb,                                  -- per-event result / conflicts
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, pos_device_id) REFERENCES pos_devices(tenant_id, id)
);

CREATE TABLE pos_device_events (                          -- raw event จาก device (inbox ของ POS) — unique ต่อ (device, seq)
  tenant_id       uuid NOT NULL,
  pos_device_id   uuid NOT NULL,
  seq             bigint NOT NULL,
  event_id        uuid NOT NULL,
  event_type      text NOT NULL,                          -- SALE_COMPLETED, REFUND_COMPLETED, SHIFT_OPENED, SHIFT_CLOSED, CASH_MOVEMENT, CUSTOMER_CREATED
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','CONFLICT','FAILED')),
  conflict        jsonb,
  applied_at      timestamptz,
  PRIMARY KEY (tenant_id, pos_device_id, seq),
  UNIQUE (tenant_id, event_id)
);

-- =============================================================================
-- 12. PURCHASING
-- =============================================================================
CREATE TABLE purchases (                                  -- Purchase Order
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  doc_no          text NOT NULL,
  supplier_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
  expected_at     date,
  currency        char(3) NOT NULL DEFAULT 'THB',
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  discount_total  numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  grand_total     numeric(14,2) NOT NULL DEFAULT 0,
  note            text,
  created_by      uuid NOT NULL,
  approved_by     uuid,
  approved_at     timestamptz,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id)
);

CREATE TABLE purchase_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  purchase_id     uuid NOT NULL,
  variant_id      uuid NOT NULL,
  unit_id         uuid NOT NULL,
  unit_factor     numeric(14,6) NOT NULL DEFAULT 1,       -- สั่งเป็นลัง 12
  ordered_qty     numeric(14,3) NOT NULL CHECK (ordered_qty > 0),
  received_qty    numeric(14,3) NOT NULL DEFAULT 0,       -- (base unit) รับแล้วสะสม
  cancelled_qty   numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost       numeric(14,4) NOT NULL,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tax_rate        numeric(5,2) NOT NULL DEFAULT 7,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, purchase_id, variant_id, unit_id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  CHECK (received_qty + cancelled_qty <= ordered_qty * unit_factor)
);

CREATE TABLE goods_receipts (                             -- 1 PO รับได้หลายครั้ง (partial receive)
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  doc_no          text NOT NULL,
  purchase_id     uuid,
  supplier_id     uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  supplier_invoice_no text,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  received_by     uuid NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, doc_no),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id)
);

CREATE TABLE goods_receipt_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  receipt_id      uuid NOT NULL,
  purchase_item_id uuid,
  variant_id      uuid NOT NULL,
  location_id     uuid,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),   -- base unit
  damaged_qty     numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost       numeric(14,4) NOT NULL,
  lot_no          text,
  expiry_date     date,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES goods_receipts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, purchase_item_id) REFERENCES purchase_items(tenant_id, id)
);

-- =============================================================================
-- 13. INTEGRATION INFRASTRUCTURE
-- =============================================================================
-- Webhook Inbox (ไม่ partition เพราะต้องการ unique dedup_key ทั้งตาราง; archive > 30 วันไป S3)
CREATE TABLE webhook_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid,                                   -- resolve จาก shop_id (null ถ้าหาไม่เจอ)
  channel_code    text NOT NULL,
  channel_account_id uuid,
  external_shop_id text,
  event_type      text NOT NULL,                          -- ORDER_STATUS_UPDATE, ...
  external_ref    text,                                   -- order_sn / order_id
  dedup_key       text NOT NULL,                          -- sha256(channel|shop|event_type|ref|event_ts) หรือ event id ของ platform
  signature_valid boolean NOT NULL,
  headers         jsonb NOT NULL,
  payload         jsonb NOT NULL,
  event_ts        timestamptz,                            -- timestamp ใน payload
  status          text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','IGNORED','FAILED','DEAD')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (channel_code, dedup_key)
);
CREATE INDEX webhook_events_pending ON webhook_events (next_attempt_at) WHERE status IN ('RECEIVED','FAILED');
CREATE INDEX webhook_events_tenant ON webhook_events (tenant_id, received_at DESC);

CREATE TABLE sync_jobs (                                  -- ประวัติ + สถานะงาน sync (มองเห็นใน admin console)
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  channel_account_id uuid,
  job_type        text NOT NULL CHECK (job_type IN ('ORDER_PULL','ORDER_DETAIL','PRODUCT_IMPORT','STOCK_PUSH','PRICE_PUSH','STATUS_PUSH','RECONCILE','TOKEN_REFRESH')),
  dedup_key       text,                                   -- เช่น 'stock:{account}:{variant}' (coalesce งานซ้ำ)
  status          text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELLED')),
  priority        int NOT NULL DEFAULT 5,
  attempts        int NOT NULL DEFAULT 0,
  input           jsonb NOT NULL DEFAULT '{}',
  output          jsonb,
  last_error      text,
  queue_job_id    text,
  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX sync_jobs_status ON sync_jobs (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX sync_jobs_active_dedup ON sync_jobs (tenant_id, dedup_key) WHERE status IN ('QUEUED') AND dedup_key IS NOT NULL;

CREATE TABLE reconciliation_runs (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  type            text NOT NULL CHECK (type IN ('CHANNEL_STOCK','LEDGER_BALANCE','ORDER','PAYMENT')),
  channel_account_id uuid,
  status          text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  checked_count   int NOT NULL DEFAULT 0,
  mismatch_count  int NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE reconciliation_items (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  run_id          uuid NOT NULL,
  variant_id      uuid,
  channel_product_variant_id uuid,
  expected_qty    numeric(14,3),                          -- ค่าที่ระบบคำนวณว่าควรเป็น
  actual_qty      numeric(14,3),                          -- ค่าที่ channel/ledger มี
  diff            numeric(14,3),
  classification  text,                                   -- PENDING_SYNC, IN_FLIGHT_ORDER, TRUE_MISMATCH, UNMAPPED
  resolution      text CHECK (resolution IN ('OPEN','PUSHED_INTERNAL','PULLED_CHANNEL','IGNORED','AUTO_RESOLVED')),
  resolved_by     uuid,
  resolved_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES reconciliation_runs(tenant_id, id) ON DELETE CASCADE
);

-- Transactional Outbox
CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id       uuid NOT NULL,
  aggregate_type  text NOT NULL,                          -- Order, InventoryBalance, Product
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,                          -- OrderCreated, InventoryReserved, StockUpdated ...
  event_version   int NOT NULL DEFAULT 1,
  payload         jsonb NOT NULL,
  headers         jsonb NOT NULL DEFAULT '{}',            -- trace_id, request_id, actor
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (                           -- consumer-side dedup (at-least-once → effectively-once)
  consumer        text NOT NULL,
  event_id        uuid NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE idempotency_keys (                           -- HTTP Idempotency-Key
  tenant_id       uuid NOT NULL,
  key             text NOT NULL,
  principal_id    uuid NOT NULL,                          -- user / api key
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    bytea NOT NULL,                         -- key เดิมแต่ body ต่าง → 422
  status          text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_status int,
  response_body   jsonb,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, principal_id, key)
);

-- =============================================================================
-- 14. AUDIT / NOTIFICATION
-- =============================================================================
CREATE TABLE audit_logs (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  actor_type      text NOT NULL CHECK (actor_type IN ('USER','API_KEY','SYSTEM','PLATFORM_ADMIN','POS_DEVICE','CHANNEL')),
  actor_id        uuid,
  impersonator_id uuid,                                   -- platform admin ที่ impersonate
  action          text NOT NULL,                          -- 'inventory.adjust.approve', 'role.update', 'auth.login.failed'
  resource_type   text NOT NULL,
  resource_id     text,
  before          jsonb,                                  -- diff เฉพาะ field ที่เปลี่ยน (PII masked)
  after           jsonb,
  ip              inet,
  user_agent      text,
  request_id      text,
  trace_id        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX audit_resource ON audit_logs (tenant_id, resource_type, resource_id, created_at DESC);
CREATE INDEX audit_actor ON audit_logs (tenant_id, actor_id, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE notification_rules (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  event_type      text NOT NULL,                          -- LOW_STOCK, OUT_OF_STOCK, SYNC_FAILED, TOKEN_EXPIRING, NEGATIVE_STOCK ...
  channels        text[] NOT NULL,                        -- IN_APP, EMAIL, LINE, WEBHOOK
  recipients      jsonb NOT NULL,                         -- {"roles":["OWNER"],"user_ids":[],"line_group_id":"...","webhook_url":"..."}
  throttle_minutes int NOT NULL DEFAULT 60,
  is_active       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE notifications (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  user_id         uuid,
  event_type      text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title           text NOT NULL,
  body            text,
  data            jsonb,
  dedup_key       text,                                   -- กัน alert ถี่ (throttle)
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX notifications_user ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;

-- =============================================================================
-- 15. updated_at triggers
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
                   t || '_touch', t);
  END LOOP;
END$$;

-- =============================================================================
-- 16. ROW-LEVEL SECURITY (defense-in-depth สำหรับ tenant isolation)
-- -----------------------------------------------------------------------------
-- ทุก transaction ของ app ต้อง:  SET LOCAL app.tenant_id = '<uuid>';
-- ถ้าไม่ได้ตั้ง → current_tenant_id() = NULL → policy ไม่ match → เห็น 0 แถว / insert ไม่ได้ (fail closed)
-- ตารางที่ tenant_id เป็น nullable (webhook_events) ใช้ policy แยก: app role เขียนได้, อ่านเฉพาะ tenant ตัวเอง
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND pc.relkind IN ('r','p')
      AND NOT pc.relispartition
      AND c.table_name NOT IN ('webhook_events','user_sessions','outbox_events')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = current_tenant_id())
                     WITH CHECK (tenant_id = current_tenant_id())$p$, t);
  END LOOP;
END$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

-- webhook_events: gateway insert ก่อนรู้ tenant ได้; อ่านได้เฉพาะของ tenant ตัวเอง (worker ใช้ stockos_platform)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_insert ON webhook_events FOR INSERT WITH CHECK (true);
CREATE POLICY webhook_read ON webhook_events FOR SELECT USING (tenant_id = current_tenant_id());

-- Grants
GRANT USAGE ON SCHEMA public TO stockos_app, stockos_readonly, stockos_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stockos_app, stockos_platform;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stockos_readonly;
-- ledger & audit: app INSERT/SELECT เท่านั้น (trigger กันซ้ำอีกชั้น)
REVOKE UPDATE, DELETE ON inventory_transactions, audit_logs, loyalty_transactions FROM stockos_app;

-- =============================================================================
-- 17. SEED: channels & plans
-- =============================================================================
INSERT INTO channels (code, name, capabilities, is_marketplace) VALUES
 ('POS',     'Point of Sale', '{"webhook":false,"stock_push":false,"price_push":false}', false),
 ('SHOPEE',  'Shopee',        '{"webhook":true,"stock_push":true,"price_push":true,"order_cancel":true,"partial_ship":true}', true),
 ('LAZADA',  'Lazada',        '{"webhook":true,"stock_push":true,"price_push":true,"order_cancel":true,"partial_ship":true}', true),
 ('TIKTOK',  'TikTok Shop',   '{"webhook":true,"stock_push":true,"price_push":true,"order_cancel":true,"partial_ship":true}', true),
 ('WEBSITE', 'Website',       '{"webhook":true,"stock_push":true,"price_push":true}', false),
 ('API',     'External API',  '{"webhook":false,"stock_push":false}', false)
ON CONFLICT DO NOTHING;

INSERT INTO plans (id, name, monthly_price, yearly_price, limits, features) VALUES
 ('FREE',       'Free',       0,    0,     '{"branches":1,"pos_devices":1,"skus":200,"orders_per_month":300,"channels":0,"users":2}', '{"offline_pos":false}'),
 ('STARTER',    'Starter',    590,  5900,  '{"branches":1,"pos_devices":2,"skus":2000,"orders_per_month":3000,"channels":2,"users":5}', '{"offline_pos":true}'),
 ('BUSINESS',   'Business',   1990, 19900, '{"branches":5,"pos_devices":10,"skus":20000,"orders_per_month":30000,"channels":6,"users":30}', '{"offline_pos":true,"channel_allocation":true,"purchasing":true,"api":true}'),
 ('ENTERPRISE', 'Enterprise', 0,    0,     '{"branches":null,"pos_devices":null,"skus":null,"orders_per_month":null,"channels":null,"users":null}', '{"offline_pos":true,"channel_allocation":true,"purchasing":true,"api":true,"sso":true,"dedicated_db":true}')
ON CONFLICT DO NOTHING;

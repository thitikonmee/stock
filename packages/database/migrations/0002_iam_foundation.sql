-- Phase 1: IAM foundation (auth sessions, MFA, invitations, permission catalog)

-- Tables created by later migrations get the same grants as the baseline.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stockos_app, stockos_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stockos_readonly;

-- ---------------------------------------------------------------------------
-- Sessions & MFA
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN mfa_last_step bigint;               -- last accepted TOTP step (replay protection)

ALTER TABLE user_sessions
  ADD COLUMN membership_id     uuid,
  ADD COLUMN amr               text[] NOT NULL DEFAULT '{pwd}',  -- carried across refreshes
  ADD COLUMN auth_time         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN family_expires_at timestamptz;                       -- absolute lifetime of the login
CREATE INDEX user_sessions_family ON user_sessions (family_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Invitations (token = tenant id + invitation id + secret; only the hash is stored)
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  id               uuid NOT NULL DEFAULT uuid_generate_v7(),
  email            citext NOT NULL,
  role_assignments jsonb NOT NULL,                                -- [{"roleId","scopeType","scopeId"}]
  token_hash       bytea NOT NULL,
  invited_by       uuid NOT NULL,                                 -- membership id
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_membership_id uuid,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX invitations_open_email ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Login needs "which tenants does this user belong to?" before any tenant context exists.
-- Narrow SECURITY DEFINER function owned by the BYPASSRLS platform role; returns ids only.
-- (On RDS the migration role must be a member of stockos_platform for ALTER ... OWNER.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_user_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, tenant_status text,
               membership_id uuid, membership_status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.slug::text, t.name, t.status, m.id, m.status
    FROM tenant_memberships m
    JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id
     AND m.status IN ('ACTIVE', 'SUSPENDED')
   ORDER BY t.name
$$;
ALTER FUNCTION auth_user_memberships(uuid) OWNER TO stockos_platform;
REVOKE ALL ON FUNCTION auth_user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_memberships(uuid) TO stockos_app;

-- ---------------------------------------------------------------------------
-- Permission catalog (generated from packages/core/src/modules/iam/domain/permissions.ts)
-- ---------------------------------------------------------------------------
-- @generated-permissions-begin
INSERT INTO permissions (code, module, description, is_dangerous) VALUES
  ('tenant.manage', 'tenancy', 'Change company settings, close tenant', true),
  ('billing.manage', 'billing', 'Change plan and payment method', true),
  ('user.read', 'iam', 'List users and their roles', false),
  ('user.manage', 'iam', 'Invite, suspend users and assign roles', true),
  ('role.manage', 'iam', 'Create and edit custom roles', true),
  ('branch.manage', 'tenancy', 'Create and edit branches', false),
  ('warehouse.manage', 'tenancy', 'Create and edit warehouses', false),
  ('device.manage', 'tenancy', 'Register and disable POS devices', false),
  ('product.read', 'catalog', 'View products', false),
  ('product.create', 'catalog', 'Create products', false),
  ('product.update', 'catalog', 'Edit products', false),
  ('product.delete', 'catalog', 'Archive products', false),
  ('product.cost.read', 'catalog', 'View cost prices', false),
  ('price.read', 'pricing', 'View price lists', false),
  ('price.manage', 'pricing', 'Edit price lists', false),
  ('inventory.read', 'inventory', 'View stock and stock cards', false),
  ('inventory.adjust', 'inventory', 'Request stock adjustments', false),
  ('inventory.adjust.approve', 'inventory', 'Approve stock adjustments', false),
  ('inventory.transfer', 'inventory', 'Request stock transfers', false),
  ('inventory.transfer.approve', 'inventory', 'Approve stock transfers', false),
  ('inventory.receive', 'inventory', 'Receive goods', false),
  ('inventory.count', 'inventory', 'Perform stock counts', false),
  ('inventory.count.approve', 'inventory', 'Approve stock count results', false),
  ('order.read', 'orders', 'View orders', false),
  ('order.create', 'orders', 'Create manual orders', false),
  ('order.update', 'orders', 'Edit orders', false),
  ('order.cancel', 'orders', 'Cancel orders', false),
  ('order.refund', 'orders', 'Refund orders', false),
  ('order.fulfill', 'orders', 'Pick, pack and ship', false),
  ('pos.sell', 'pos', 'Sell at the POS', false),
  ('pos.discount', 'pos', 'Give discounts within limit', false),
  ('pos.discount.override', 'pos', 'Approve discounts above limit', false),
  ('pos.refund', 'pos', 'Refund at the POS', false),
  ('pos.void', 'pos', 'Void POS lines and bills', false),
  ('pos.shift.open', 'pos', 'Open a shift', false),
  ('pos.shift.close', 'pos', 'Close a shift', false),
  ('pos.cash.in_out', 'pos', 'Pay in / pay out cash', false),
  ('pos.reprint', 'pos', 'Reprint receipts', false),
  ('purchase.read', 'purchasing', 'View purchase orders', false),
  ('purchase.create', 'purchasing', 'Create purchase orders', false),
  ('purchase.approve', 'purchasing', 'Approve purchase orders', false),
  ('purchase.receive', 'purchasing', 'Receive against purchase orders', false),
  ('supplier.read', 'purchasing', 'View suppliers', false),
  ('supplier.manage', 'purchasing', 'Edit suppliers', false),
  ('customer.read', 'customers', 'View customers', false),
  ('customer.manage', 'customers', 'Edit customers', false),
  ('customer.pii.read', 'customers', 'See unmasked phone/address', false),
  ('customer.export', 'customers', 'Export customer data', true),
  ('promotion.read', 'pricing', 'View promotions', false),
  ('promotion.manage', 'pricing', 'Edit promotions', false),
  ('coupon.manage', 'pricing', 'Edit coupons', false),
  ('loyalty.manage', 'customers', 'Edit loyalty settings', false),
  ('payment.read', 'payments', 'View payments', false),
  ('payment.refund', 'payments', 'Refund payments', false),
  ('report.read', 'reporting', 'View reports', false),
  ('report.export', 'reporting', 'Export reports', false),
  ('report.financial', 'reporting', 'View profit and cost reports', false),
  ('channel.read', 'channels', 'View channel connections', false),
  ('channel.manage', 'channels', 'Connect and disconnect channels', true),
  ('channel.mapping', 'channels', 'Map channel SKUs', false),
  ('channel.sync', 'channels', 'Trigger channel syncs', false),
  ('settings.manage', 'tenancy', 'Change business settings', true),
  ('audit.read', 'audit', 'View the audit log', false),
  ('api_key.manage', 'iam', 'Create and revoke API keys', true),
  ('webhook.manage', 'integrations', 'Manage outbound webhooks', true)
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous;
-- @generated-permissions-end

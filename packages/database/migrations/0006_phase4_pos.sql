-- Phase 4: POS (cashier PIN login lockout + employee code lookup)
-- pos_pin_hash itself already exists on tenant_memberships since 0001_baseline.sql.

ALTER TABLE tenant_memberships
  ADD COLUMN pos_pin_failed_count int NOT NULL DEFAULT 0,
  ADD COLUMN pos_pin_locked_until timestamptz;

-- Cashier login looks a person up by employee code within the device's tenant.
CREATE UNIQUE INDEX tenant_memberships_employee_code_uq
  ON tenant_memberships (tenant_id, employee_code) WHERE employee_code IS NOT NULL;

-- Which shift's drawer a refund paid cash out of — a refund can be issued on a different device/shift
-- than the original sale, so this cannot be inferred from the order. Nullable: only POS refunds set it.
ALTER TABLE refunds ADD COLUMN pos_shift_id uuid;
ALTER TABLE refunds ADD CONSTRAINT refunds_pos_shift_fk
  FOREIGN KEY (tenant_id, pos_shift_id) REFERENCES pos_shifts(tenant_id, id);
CREATE INDEX refunds_pos_shift ON refunds (tenant_id, pos_shift_id) WHERE pos_shift_id IS NOT NULL;

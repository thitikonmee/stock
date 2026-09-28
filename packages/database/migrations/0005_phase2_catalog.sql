-- Phase 2: Product catalog — image metadata, bulk import job tracking.
-- All Phase 2 master-data tables (brands, categories, units, suppliers, products, product_variants,
-- variant_barcodes, product_units, bundle_components, product_images, supplier_products, price_lists,
-- prices) already exist in 0001_baseline.sql with RLS applied by its blanket loop. This migration only
-- adds what Phase 2 needs on top of that snapshot.

-- ---------------------------------------------------------------------------
-- product_images: the baseline only had storage_key + sort_order. Track content type/size (needed to
-- serve correct headers and to cap upload size) and who/when for audit.
-- ---------------------------------------------------------------------------
ALTER TABLE product_images
  ADD COLUMN content_type text NOT NULL DEFAULT 'application/octet-stream',
  ADD COLUMN size_bytes   bigint NOT NULL DEFAULT 0,
  ADD COLUMN alt_text     text,
  ADD COLUMN created_by   uuid,
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_images ALTER COLUMN content_type DROP DEFAULT;
ALTER TABLE product_images ALTER COLUMN size_bytes DROP DEFAULT;
ALTER TABLE product_images
  ADD CONSTRAINT product_images_variant_fk
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id);
CREATE INDEX ON product_images (tenant_id, product_id, sort_order);

-- ---------------------------------------------------------------------------
-- categories: the baseline had no uniqueness on the materialized path, so two categories could end
-- up with an identical path (silently ambiguous tree). Enforce it now that Phase 2 writes real data.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX categories_path_uq ON categories (tenant_id, path);

-- ---------------------------------------------------------------------------
-- Bulk import/export jobs (xlsx). Processed synchronously by the API in this phase — the row exists
-- so the client can poll a stable job id/shape; a future phase can move processing to a worker without
-- changing the API contract.
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  id              uuid NOT NULL DEFAULT uuid_generate_v7(),
  type            text NOT NULL CHECK (type IN ('PRODUCT_IMPORT')),
  status          text NOT NULL CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
  file_name       text,
  total_rows      int NOT NULL DEFAULT 0,
  created_products int NOT NULL DEFAULT 0,
  created_variants int NOT NULL DEFAULT 0,
  updated_variants int NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]',            -- [{"row":2,"message":"..."}]
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON import_jobs (tenant_id, created_at DESC);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_jobs
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

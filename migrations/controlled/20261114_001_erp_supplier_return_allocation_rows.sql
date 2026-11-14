-- Immutable import-row-to-offload allocation evidence for ERP supplier returns.
-- Snapshot actual purchase rate at posting; older batches remain nullable.
ALTER TABLE erp_supplier_return_lines
  ADD COLUMN IF NOT EXISTS source_purchase_rate NUMERIC(20,7);
-- Requires the existing 20261113_001_erp_supplier_offload_returns.sql migration.
-- A single requested Excel row may map to multiple original source offloads;
-- multiple requested rows may also map to the same offload line.
CREATE TABLE IF NOT EXISTS erp_supplier_return_allocation_rows (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  batch_id BIGINT NOT NULL REFERENCES erp_supplier_return_batches(id) ON DELETE RESTRICT,
  return_line_id BIGINT NOT NULL REFERENCES erp_supplier_return_lines(id) ON DELETE RESTRICT,
  input_row INTEGER NOT NULL CHECK (input_row >= 2),
  requested_article_code VARCHAR(50) NOT NULL,
  requested_quantity NUMERIC(15,3) NOT NULL CHECK (requested_quantity > 0),
  allocated_quantity NUMERIC(15,3) NOT NULL CHECK (allocated_quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id, input_row, return_line_id)
);
CREATE INDEX IF NOT EXISTS erp_supplier_return_allocation_rows_batch_idx
  ON erp_supplier_return_allocation_rows(company_id, batch_id, input_row);

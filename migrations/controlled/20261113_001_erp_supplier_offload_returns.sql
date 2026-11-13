-- Supplier return audit ledger, linked to an original ERP container offload.
-- Original purchase orders, offloads and their historic vouchers remain immutable.
CREATE TABLE IF NOT EXISTS erp_supplier_return_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  request_key VARCHAR(128) NOT NULL,
  return_date DATE NOT NULL,
  file_name TEXT,
  reason TEXT,
  created_by_user_id TEXT,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_quantity NUMERIC(15,3) NOT NULL DEFAULT 0,
  supplier_credit_usd NUMERIC(20,2) NOT NULL DEFAULT 0,
  inventory_reduction_usd NUMERIC(20,2) NOT NULL DEFAULT 0,
  UNIQUE(company_id, request_key)
);
CREATE INDEX IF NOT EXISTS erp_supplier_return_batches_company_created_idx
  ON erp_supplier_return_batches(company_id, created_at DESC);
CREATE TABLE IF NOT EXISTS erp_supplier_return_lines (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES erp_supplier_return_batches(id) ON DELETE RESTRICT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  offload_item_id INTEGER NOT NULL REFERENCES container_offload_items(id) ON DELETE RESTRICT,
  offload_id INTEGER NOT NULL REFERENCES container_offloads(id) ON DELETE RESTRICT,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE RESTRICT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  article_code VARCHAR(50) NOT NULL,
  item_name TEXT NOT NULL,
  quantity NUMERIC(15,3) NOT NULL CHECK(quantity > 0),
  supplier_credit_usd NUMERIC(20,2) NOT NULL,
  inventory_reduction_usd NUMERIC(20,2) NOT NULL,
  voucher_id INTEGER REFERENCES vouchers(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id, offload_item_id)
);
CREATE INDEX IF NOT EXISTS erp_supplier_return_lines_offload_idx
  ON erp_supplier_return_lines(company_id, offload_item_id);
CREATE INDEX IF NOT EXISTS erp_supplier_return_lines_stock_idx
  ON erp_supplier_return_lines(company_id, location_id, stock_item_id);
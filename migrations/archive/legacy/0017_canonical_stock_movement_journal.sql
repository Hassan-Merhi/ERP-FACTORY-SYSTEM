-- Phase 4 Accounting & Inventory Convergence
-- Append-only canonical stock movement evidence plus idempotency/audit records.
-- Authored for final programme migration execution; intentionally not applied here.

CREATE TABLE IF NOT EXISTS canonical_stock_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity_delta NUMERIC(18, 6) NOT NULL,
  unit_cost NUMERIC(18, 6) NOT NULL,
  movement_kind TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reversal_of_movement_id BIGINT REFERENCES canonical_stock_movements(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canonical_stock_movements_quantity_nonzero CHECK (quantity_delta <> 0),
  CONSTRAINT canonical_stock_movements_unit_cost_nonnegative CHECK (unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS canonical_stock_movements_company_source_idx
  ON canonical_stock_movements(company_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS canonical_stock_movements_company_item_location_idx
  ON canonical_stock_movements(company_id, stock_item_id, location_id);
CREATE INDEX IF NOT EXISTS canonical_stock_movements_reversal_idx
  ON canonical_stock_movements(reversal_of_movement_id)
  WHERE reversal_of_movement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_stock_movement_requests (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  movement_ids BIGINT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canonical_stock_movement_requests_company_key_unique
    UNIQUE(company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS canonical_stock_movement_requests_source_idx
  ON canonical_stock_movement_requests(company_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS canonical_stock_movement_audit (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  movement_ids BIGINT[] NOT NULL,
  quantity NUMERIC(18, 6) NOT NULL,
  value NUMERIC(24, 6) NOT NULL,
  actor_user_id TEXT,
  actor_username TEXT,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canonical_stock_movement_audit_company_source_idx
  ON canonical_stock_movement_audit(company_id, source_type, source_id);

-- Accounting audit phase 25 (AR-4, AR-9): open-item allocations, payment terms
-- per party and the factory supplier opening's side and currency. Additive and
-- idempotent: no existing row is changed (a NULL side keeps the old meaning,
-- Cr; NULL terms are 30 days). Also applied at boot by ensureOpenItemSchema
-- (server/services/accounting/allocations/ensureOpenItemSchema.ts).

CREATE TABLE IF NOT EXISTS party_open_item_allocations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  party_kind VARCHAR(20) NOT NULL,
  party_id INTEGER NOT NULL,
  invoice_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  payment_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  amount NUMERIC(20, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  method VARCHAR(20) NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  released_by TEXT,
  release_reason TEXT,
  CONSTRAINT party_open_item_allocations_amount_positive CHECK (amount > 0),
  CONSTRAINT party_open_item_allocations_kind_valid
    CHECK (party_kind IN ('customer', 'supplier', 'employee', 'factorySupplier')),
  CONSTRAINT party_open_item_allocations_method_valid CHECK (method IN ('auto_fifo', 'manual', 'note')),
  CONSTRAINT party_open_item_allocations_sides_differ CHECK (invoice_voucher_id IS DISTINCT FROM payment_voucher_id)
);
CREATE INDEX IF NOT EXISTS party_open_item_allocations_party_idx
  ON party_open_item_allocations (company_id, party_kind, party_id);
CREATE INDEX IF NOT EXISTS party_open_item_allocations_invoice_idx
  ON party_open_item_allocations (invoice_voucher_id);
CREATE INDEX IF NOT EXISTS party_open_item_allocations_payment_idx
  ON party_open_item_allocations (payment_voucher_id);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER;
ALTER TABLE factory_suppliers
  ADD COLUMN IF NOT EXISTS opening_balance_side VARCHAR(2),
  ADD COLUMN IF NOT EXISTS opening_balance_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount NUMERIC(20, 4),
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER;

-- Integration review (phases 23-29): the automatic FIFO run and the realized FX
-- it triggers stay off for a company until its Owner has reviewed and run the
-- first allocation (server/services/accounting/allocations/allocationEnablement.ts).
CREATE TABLE IF NOT EXISTS open_item_allocation_enablements (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled_on DATE NOT NULL,
  enabled_by TEXT NOT NULL,
  plan_hash TEXT NOT NULL
);

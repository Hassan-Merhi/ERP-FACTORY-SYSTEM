-- Retail Wave 1: payments, cashier shifts, financial account mapping and
-- append-only accounting bridge. Historical rows are retained and are not
-- retroactively posted or rewritten.

CREATE TABLE IF NOT EXISTS retail_cashier_shifts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  cashier_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_cash NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  opened_at TIMESTAMP NOT NULL DEFAULT now(),
  open_idempotency_key VARCHAR(191) NOT NULL,
  cash_sales_total NUMERIC(20,6),
  refund_total NUMERIC(20,6),
  cash_in_total NUMERIC(20,6),
  cash_out_total NUMERIC(20,6),
  expected_closing_cash NUMERIC(20,6),
  actual_counted_cash NUMERIC(20,6),
  variance NUMERIC(20,6),
  closed_by VARCHAR REFERENCES users(id) ON DELETE RESTRICT,
  closed_at TIMESTAMP,
  close_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS retail_cashier_shifts_company_location_opened_idx
  ON retail_cashier_shifts(company_id, location_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS retail_cashier_shifts_cashier_opened_idx
  ON retail_cashier_shifts(cashier_id, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS retail_cashier_shifts_open_idempotency_unique
  ON retail_cashier_shifts(company_id, open_idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS retail_cashier_shifts_one_open_per_cashier_location_unique
  ON retail_cashier_shifts(company_id, location_id, cashier_id) WHERE status = 'open';

ALTER TABLE retail_pos_sales
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS checkout_version INTEGER,
  ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES retail_cashier_shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0;

-- Keep all historical sales visible. Before this wave, total_amount was the
-- captured gross; it is the only durable source for the subtotal snapshot.
UPDATE retail_pos_sales
SET subtotal_amount = total_amount
WHERE subtotal_amount = 0 AND total_amount <> 0;

ALTER TABLE retail_pos_sale_items
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(20,6) NOT NULL DEFAULT 0;

UPDATE retail_pos_sale_items
SET gross_amount = quantity * unit_price
WHERE gross_amount = 0 AND quantity <> 0 AND unit_price <> 0;

UPDATE retail_pos_sale_items
SET total_amount = gross_amount - discount_amount + tax_amount
WHERE total_amount = 0 AND (gross_amount <> 0 OR discount_amount <> 0 OR tax_amount <> 0);

ALTER TABLE retail_pos_returns
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(20,6) NOT NULL DEFAULT 0;

ALTER TABLE retail_pos_return_items
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(20,6) NOT NULL DEFAULT 0;

UPDATE retail_pos_return_items
SET gross_amount = quantity * unit_price,
    total_amount = quantity * unit_price
WHERE gross_amount = 0 AND quantity <> 0 AND unit_price <> 0;

CREATE TABLE IF NOT EXISTS retail_pos_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL REFERENCES retail_pos_sales(id) ON DELETE RESTRICT,
  return_id INTEGER REFERENCES retail_pos_returns(id) ON DELETE SET NULL,
  shift_id INTEGER REFERENCES retail_cashier_shifts(id) ON DELETE SET NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  operation_type VARCHAR(24) NOT NULL CHECK (operation_type IN ('sale', 'refund', 'cancellation')),
  method VARCHAR(32) NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'mobile_other', 'store_credit')),
  amount NUMERIC(20,6) NOT NULL CHECK (
    (operation_type = 'sale' AND amount > 0) OR
    (operation_type <> 'sale' AND amount < 0)
  ),
  amount_tendered NUMERIC(20,6),
  change_due NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  reference VARCHAR(191),
  cashier_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(191) NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CHECK (method = 'cash' OR (amount_tendered IS NULL AND change_due = 0))
);

CREATE INDEX IF NOT EXISTS retail_pos_payments_company_sale_created_idx
  ON retail_pos_payments(company_id, sale_id, created_at);
CREATE INDEX IF NOT EXISTS retail_pos_payments_shift_method_created_idx
  ON retail_pos_payments(shift_id, method, created_at);
CREATE INDEX IF NOT EXISTS retail_pos_payments_company_location_created_idx
  ON retail_pos_payments(company_id, location_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS retail_pos_payments_company_idempotency_line_unique
  ON retail_pos_payments(company_id, idempotency_key, line_number);

CREATE TABLE IF NOT EXISTS retail_cash_movements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES retail_cashier_shifts(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('cash_in', 'cash_out')),
  amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  idempotency_key VARCHAR(191) NOT NULL,
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retail_cash_movements_shift_created_idx
  ON retail_cash_movements(shift_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS retail_cash_movements_company_idempotency_unique
  ON retail_cash_movements(company_id, idempotency_key);

CREATE TABLE IF NOT EXISTS retail_account_mappings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_key VARCHAR(40) NOT NULL CHECK (account_key IN (
    'cash', 'card_clearing', 'bank', 'sales_revenue', 'inventory_asset',
    'cogs', 'discounts', 'tax_payable', 'store_credit_liability'
  )),
  ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  updated_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS retail_account_mappings_company_key_unique
  ON retail_account_mappings(company_id, account_key);
CREATE INDEX IF NOT EXISTS retail_account_mappings_ledger_account_idx
  ON retail_account_mappings(ledger_account_id);

CREATE TABLE IF NOT EXISTS retail_accounting_postings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL REFERENCES retail_pos_sales(id) ON DELETE RESTRICT,
  reference_key VARCHAR(191) NOT NULL,
  posting_type VARCHAR(24) NOT NULL CHECK (posting_type IN ('sale', 'return', 'cancellation')),
  account_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
  subtotal_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  total_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  cogs_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  created_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_postings_company_reference_unique
  ON retail_accounting_postings(company_id, reference_key);
CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_postings_voucher_unique
  ON retail_accounting_postings(voucher_id);

ALTER TABLE retail_accounting_postings
  ADD COLUMN IF NOT EXISTS account_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS retail_accounting_postings_company_sale_created_idx
  ON retail_accounting_postings(company_id, sale_id, created_at);

-- Retail Wave 1 financial core: payments, cashier cash movements and accounting mapping.
-- Additive and idempotent; historical retail sales/stock movements are not rewritten.

ALTER TABLE retail_pos_sales
  ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES pos_shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accounting_voucher_id INTEGER;

ALTER TABLE retail_pos_return_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(20,6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS retail_pos_sales_shift_idx ON retail_pos_sales (shift_id);

CREATE TABLE IF NOT EXISTS retail_pos_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL REFERENCES retail_pos_sales(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  shift_id INTEGER REFERENCES pos_shifts(id) ON DELETE SET NULL,
  payment_type VARCHAR(20) NOT NULL DEFAULT 'payment',
  method VARCHAR(20) NOT NULL,
  amount NUMERIC(20,6) NOT NULL,
  tendered_amount NUMERIC(20,6),
  change_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  reference VARCHAR(191),
  ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  related_payment_id INTEGER,
  idempotency_key VARCHAR(191) NOT NULL,
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retail_pos_payments_company_idx ON retail_pos_payments(company_id);
CREATE INDEX IF NOT EXISTS retail_pos_payments_sale_idx ON retail_pos_payments(sale_id);
CREATE INDEX IF NOT EXISTS retail_pos_payments_shift_idx ON retail_pos_payments(shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS retail_pos_payments_company_idempotency_unique
  ON retail_pos_payments(company_id, idempotency_key);

CREATE TABLE IF NOT EXISTS retail_cash_movements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  shift_id INTEGER NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
  movement_type VARCHAR(20) NOT NULL,
  amount NUMERIC(20,6) NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retail_cash_movements_shift_idx ON retail_cash_movements(shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS retail_cash_movements_company_idempotency_unique
  ON retail_cash_movements(company_id, idempotency_key);

CREATE TABLE IF NOT EXISTS retail_accounting_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  cash_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  card_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  bank_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  mobile_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  other_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  sales_revenue_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  inventory_asset_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  cogs_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  discounts_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  tax_payable_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  store_credit_ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retail_accounting_settings_company_idx ON retail_accounting_settings(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_settings_company_location_unique
  ON retail_accounting_settings(company_id, location_id)
  WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS retail_accounting_settings_company_default_unique
  ON retail_accounting_settings(company_id)
  WHERE location_id IS NULL;

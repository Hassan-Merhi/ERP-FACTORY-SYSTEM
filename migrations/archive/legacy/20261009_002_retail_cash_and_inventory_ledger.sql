-- Accounting audit wave 17 (D), owner decisions 2 and 3 of 2026-10-09: Retail
-- cash movements journalled by reason code, and the Retail inventory opening.
-- Additive and idempotent; historical movements keep a null reason code and
-- voucher (listed by the integrity diagnostic, not back-filled).

ALTER TABLE retail_cash_movements
  ADD COLUMN IF NOT EXISTS reason_code VARCHAR(40),
  ADD COLUMN IF NOT EXISTS voucher_id INTEGER;

CREATE TABLE IF NOT EXISTS retail_cash_reason_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reason_code VARCHAR(40) NOT NULL,
  ledger_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT retail_cash_reason_accounts_one_target
    CHECK (ledger_account_id IS NULL OR bank_account_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS retail_cash_reason_accounts_company_reason_unique
  ON retail_cash_reason_accounts(company_id, reason_code);

CREATE TABLE IF NOT EXISTS retail_inventory_openings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  opening_date DATE NOT NULL,
  voucher_id INTEGER,
  sub_ledger_value NUMERIC(20,2) NOT NULL,
  ledger_balance_before NUMERIC(20,2) NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  plan_hash VARCHAR(64) NOT NULL,
  applied_by VARCHAR NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS retail_inventory_openings_company_unique
  ON retail_inventory_openings(company_id);

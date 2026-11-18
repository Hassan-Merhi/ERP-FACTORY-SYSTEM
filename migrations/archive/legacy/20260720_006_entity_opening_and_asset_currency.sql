-- Preserve native amounts separately while keeping legacy amount columns in
-- historical company-base currency for backward-compatible reports.
-- Structural only: existing rows remain unresolved until explicitly reviewed.

ALTER TABLE ledger_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount numeric(20, 6);

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount numeric(20, 6);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS opening_balance_currency varchar(10),
  ADD COLUMN IF NOT EXISTS opening_balance_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS opening_balance_base_amount numeric(20, 6);

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS opening_balance_side varchar(2) DEFAULT 'Cr',
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS opening_balance_currency varchar(10),
  ADD COLUMN IF NOT EXISTS opening_balance_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS opening_balance_base_amount numeric(20, 6);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS opening_balance_side varchar(2) DEFAULT 'Cr',
  ADD COLUMN IF NOT EXISTS opening_balance_native_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS opening_balance_currency varchar(10),
  ADD COLUMN IF NOT EXISTS opening_balance_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS opening_balance_base_amount numeric(20, 6);

ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS purchase_native_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS purchase_currency varchar(10),
  ADD COLUMN IF NOT EXISTS purchase_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS purchase_base_amount numeric(20, 6);

COMMENT ON COLUMN ledger_accounts.opening_balance_native_amount IS 'Original native-currency opening amount.';
COMMENT ON COLUMN bank_accounts.opening_balance_native_amount IS 'Original native-currency opening amount.';
COMMENT ON COLUMN customers.opening_balance_native_amount IS 'Original native-currency customer opening amount.';
COMMENT ON COLUMN suppliers.opening_balance_native_amount IS 'Original native-currency supplier opening amount.';
COMMENT ON COLUMN employees.opening_balance_native_amount IS 'Original native-currency employee opening amount.';
COMMENT ON COLUMN fixed_assets.purchase_native_amount IS 'Original native-currency fixed-asset acquisition amount.';

-- Preserve the native currency and historical base value of ledger-account opening balances.
-- Structural migration only: existing opening balances remain unresolved until explicitly reviewed.

ALTER TABLE ledger_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_currency varchar(10),
  ADD COLUMN IF NOT EXISTS opening_balance_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS opening_balance_base_amount numeric(20, 6);

COMMENT ON COLUMN ledger_accounts.opening_balance_currency IS
  'Native currency of the opening balance. NULL means unresolved legacy data.';
COMMENT ON COLUMN ledger_accounts.opening_balance_historical_rate IS
  'Historical exchange rate used to establish the opening balance base amount.';
COMMENT ON COLUMN ledger_accounts.opening_balance_base_amount IS
  'Historical company-base-currency value of the opening balance.';

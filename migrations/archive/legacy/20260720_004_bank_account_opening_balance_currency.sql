-- Preserve native and historical base values for standalone bank-account opening balances.
-- Existing non-zero opening balances remain unresolved until explicitly classified.

ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_currency varchar(10),
  ADD COLUMN IF NOT EXISTS opening_balance_historical_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS opening_balance_base_amount numeric(20, 6);

COMMENT ON COLUMN bank_accounts.opening_balance_currency IS
  'Native currency of the opening balance. NULL means unresolved legacy data.';
COMMENT ON COLUMN bank_accounts.opening_balance_historical_rate IS
  'Historical exchange rate used to establish the opening balance base amount.';
COMMENT ON COLUMN bank_accounts.opening_balance_base_amount IS
  'Historical company-base-currency value of the opening balance.';

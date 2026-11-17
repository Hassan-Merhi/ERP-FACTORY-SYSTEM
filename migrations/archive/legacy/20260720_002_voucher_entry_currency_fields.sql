-- Multi-currency accounting foundation.
-- Structural migration only: no historical data is modified here.

ALTER TABLE voucher_entries
  ADD COLUMN IF NOT EXISTS transaction_currency varchar(3),
  ADD COLUMN IF NOT EXISTS transaction_debit_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS transaction_credit_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS base_debit_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS base_credit_amount numeric(20, 6),
  ADD COLUMN IF NOT EXISTS historical_exchange_rate numeric(20, 10),
  ADD COLUMN IF NOT EXISTS rate_convention varchar(30);

COMMENT ON COLUMN voucher_entries.transaction_currency IS
  'Original transaction currency. The project stores CFA rather than XOF.';
COMMENT ON COLUMN voucher_entries.transaction_debit_amount IS
  'Original transaction-currency debit amount.';
COMMENT ON COLUMN voucher_entries.transaction_credit_amount IS
  'Original transaction-currency credit amount.';
COMMENT ON COLUMN voucher_entries.base_debit_amount IS
  'Historical company-base-currency debit amount at posting time.';
COMMENT ON COLUMN voucher_entries.base_credit_amount IS
  'Historical company-base-currency credit amount at posting time.';
COMMENT ON COLUMN voucher_entries.historical_exchange_rate IS
  'Historical rate locked when the entry was posted.';
COMMENT ON COLUMN voucher_entries.rate_convention IS
  'IDENTITY, TRANSACTION_PER_BASE, or BASE_PER_TRANSACTION.';

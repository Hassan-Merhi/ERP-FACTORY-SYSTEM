-- Append-only reversal of an unused FX agent USD -> EUR conversion.
-- Execute in TablePlus on a reviewed database AFTER the 20261019 wallet migration.
-- Does not alter existing wallet operations or historic vouchers.
BEGIN;
ALTER TABLE factory_fx_agent_wallet_operations
  ADD COLUMN IF NOT EXISTS reverses_operation_id BIGINT;

ALTER TABLE factory_fx_agent_wallet_operations
  DROP CONSTRAINT IF EXISTS factory_fx_agent_wallet_operations_kind_check;
ALTER TABLE factory_fx_agent_wallet_operations
  ADD CONSTRAINT factory_fx_agent_wallet_operations_kind_check
  CHECK (kind IN ('USD_TO_EUR', 'EUR_SETTLEMENT', 'EUR_TO_USD_REVERSAL'));

ALTER TABLE factory_fx_agent_wallet_operations
  DROP CONSTRAINT IF EXISTS fx_agent_operation_shape;
ALTER TABLE factory_fx_agent_wallet_operations
  ADD CONSTRAINT fx_agent_operation_shape CHECK (
    (kind = 'USD_TO_EUR' AND source_currency = 'USD' AND target_currency = 'EUR'
      AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL AND reverses_operation_id IS NULL)
    OR
    (kind = 'EUR_SETTLEMENT' AND source_currency = 'EUR' AND target_currency = 'USD'
      AND target_kind IS NOT NULL AND target_id IS NOT NULL AND voucher_id IS NOT NULL AND reverses_operation_id IS NULL)
    OR
    (kind = 'EUR_TO_USD_REVERSAL' AND source_currency = 'EUR' AND target_currency = 'USD'
      AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL AND reverses_operation_id IS NOT NULL)
  );

-- This reviewed migration runs once; the new column has no FK on the existing tables.
ALTER TABLE factory_fx_agent_wallet_operations
  ADD CONSTRAINT fx_agent_reverses_operation_fkey
  FOREIGN KEY (reverses_operation_id) REFERENCES factory_fx_agent_wallet_operations(id);

CREATE UNIQUE INDEX IF NOT EXISTS fx_agent_one_reversal_per_conversion
  ON factory_fx_agent_wallet_operations(company_id, reverses_operation_id);
COMMIT;

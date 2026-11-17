-- Enable same-currency EUR supplier payments from the FX agent's EUR wallet.
-- Run once in production before using the new "Pay EUR" Payment Voucher option.
-- Existing USD settlement operations are unchanged.
BEGIN;
ALTER TABLE factory_fx_agent_wallet_operations
  DROP CONSTRAINT IF EXISTS fx_agent_operation_shape;
ALTER TABLE factory_fx_agent_wallet_operations
  ADD CONSTRAINT fx_agent_operation_shape CHECK (
    (kind = 'USD_TO_EUR' AND source_currency = 'USD' AND target_currency = 'EUR'
      AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL AND reverses_operation_id IS NULL)
    OR
    (kind = 'EUR_TO_USD_REVERSAL' AND source_currency = 'EUR' AND target_currency = 'USD'
      AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL AND reverses_operation_id IS NOT NULL)
    OR
    (kind = 'EUR_SETTLEMENT' AND source_currency = 'EUR'
      AND (
        (target_currency = 'USD' AND target_kind IN ('factorySupplier', 'ledger'))
        OR
        (target_currency = 'EUR' AND target_kind = 'factorySupplier')
      )
      AND target_id IS NOT NULL AND voucher_id IS NOT NULL AND reverses_operation_id IS NULL)
  );
COMMIT;

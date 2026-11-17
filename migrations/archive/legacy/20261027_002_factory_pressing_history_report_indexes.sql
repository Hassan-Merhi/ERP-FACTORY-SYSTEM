-- Pressing Machines Phase 6: efficient previous accepted-scan lookup.
-- Only an index; historical rows and stock/accounting are not modified.
CREATE INDEX IF NOT EXISTS factory_pressing_confirmations_machine_time_idx
ON factory_pressing_confirmations (company_id, machine_id, confirmed_at DESC, id DESC)
WHERE voided_at IS NULL;

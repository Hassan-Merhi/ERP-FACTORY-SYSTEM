-- Bring production container_charges in line with shared/schema/containers.ts.
-- Safe to run repeatedly.
ALTER TABLE container_charges
  ADD COLUMN IF NOT EXISTS ledger_account_id INTEGER;

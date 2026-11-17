-- Accounting audit phase 21 (A), AT3/AT5/AT6: voucher actor columns, the
-- original number of a retired voucher, and request metadata plus the hash
-- chain on audit rows. Additive and idempotent; existing rows keep NULL
-- ("before tracking", not back-filled). The triggers that fill them are
-- installed on every boot (server/services/audit/voucherAuditTrigger.ts).

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS original_voucher_number VARCHAR(100);

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS ip TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_hash TEXT;

CREATE INDEX IF NOT EXISTS audit_log_chain_idx ON audit_log (id) WHERE prev_hash IS NOT NULL;

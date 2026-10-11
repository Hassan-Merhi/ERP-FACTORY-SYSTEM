-- Accounting audit phase 26 (multi-company and consolidation). Additive and
-- idempotent; also ensured at boot by
-- server/services/accounting/intercompany/ensureMultiCompanySchema.ts.

-- MC-1 / MC-11: the intercompany accounts each leg posted against, what wrote
-- the link, and soft delete / update tracking (links are never hard-deleted).
ALTER TABLE inter_company_transfers
  ADD COLUMN IF NOT EXISTS from_ic_account_id INTEGER,
  ADD COLUMN IF NOT EXISTS to_ic_account_id INTEGER,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;
CREATE INDEX IF NOT EXISTS inter_company_transfers_live_from_idx
  ON inter_company_transfers (from_company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS inter_company_transfers_live_to_idx
  ON inter_company_transfers (to_company_id) WHERE deleted_at IS NULL;

-- MC-9: the parent's receivable from a subsidiary, by id (in the subsidiary's settings).
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS parent_receivable_account_id INTEGER;

-- MC-12: drop the legacy GLOBAL unique on ledger_accounts.code once the
-- per-company unique index exists (codes stay unique per company).
DO $mc12$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ledger_accounts_company_code_unique')
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_accounts_code_unique'
                  AND conrelid = 'public.ledger_accounts'::regclass) THEN
    ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_code_unique;
  ELSIF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ledger_accounts_company_code_unique')
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ledger_accounts_code_unique') THEN
    DROP INDEX ledger_accounts_code_unique;
  END IF;
END
$mc12$;

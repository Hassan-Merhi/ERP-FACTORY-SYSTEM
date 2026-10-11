/**
 * Boot-time schema of phase 26 (multi-company and consolidation; same
 * statements as migrations/20261011_027_multi_company.sql). Additive and
 * idempotent; no data is changed, except MC-12: the legacy GLOBAL unique
 * constraint on ledger_accounts.code (from the first drizzle snapshot,
 * `ledger_accounts_code_unique`) is dropped when present AND the per-company
 * unique index exists, because it contradicts per-company system codes
 * (every company has its own CASH, IC-TO-…, RETAINED_EARNINGS). Codes stay
 * unique per company. The multi-company diagnostic reports whether it was
 * found.
 */
import type { DatabasePool } from "../../../db";
import { logger } from "../../../lib/logger";

export const MULTI_COMPANY_SCHEMA_SQL = [
  `ALTER TABLE inter_company_transfers
     ADD COLUMN IF NOT EXISTS from_ic_account_id INTEGER,
     ADD COLUMN IF NOT EXISTS to_ic_account_id INTEGER,
     ADD COLUMN IF NOT EXISTS source_type TEXT,
     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP,
     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
     ADD COLUMN IF NOT EXISTS deleted_by TEXT,
     ADD COLUMN IF NOT EXISTS delete_reason TEXT`,
  `CREATE INDEX IF NOT EXISTS inter_company_transfers_live_from_idx
     ON inter_company_transfers (from_company_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS inter_company_transfers_live_to_idx
     ON inter_company_transfers (to_company_id) WHERE deleted_at IS NULL`,
  `ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS parent_receivable_account_id INTEGER`,
  `DO $mc12$
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
   $mc12$`,
] as const;

export async function ensureMultiCompanySchema(pool: DatabasePool): Promise<void> {
  for (const statement of MULTI_COMPANY_SCHEMA_SQL) {
    await pool.query(statement);
  }
  logger.info("[startup] ✓ Multi-company (phase 26) schema ensured");
}

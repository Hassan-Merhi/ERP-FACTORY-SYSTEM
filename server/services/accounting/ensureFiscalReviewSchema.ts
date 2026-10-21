/**
 * Phase 13: additive fiscal review evidence. No change to fiscal closing
 * journals or production vouchers, no automatic close on schema startup.
 */
import type {Pool} from "pg";
export async function ensureFiscalReviewSchema(pool:Pool):Promise<void>{
 await pool.query(`
 CREATE TABLE IF NOT EXISTS accounting_fiscal_review_signoffs(
   id BIGSERIAL PRIMARY KEY,
   company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
   period_start_date DATE NOT NULL,
   period_end_date DATE NOT NULL,
   retained_earnings_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
   evidence_hash CHAR(64) NOT NULL,
   review_kind VARCHAR(20) NOT NULL CHECK (review_kind IN ('ACCOUNTING','OWNER')),
   reviewer_id TEXT NOT NULL,
   reviewer_name TEXT NOT NULL,
   reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   note TEXT NOT NULL,
   revoked_at TIMESTAMPTZ,
   revoked_by TEXT,
   revoke_reason TEXT,
   CONSTRAINT fiscal_signoff_period CHECK(period_start_date<=period_end_date),
   CONSTRAINT fiscal_signoff_revoke CHECK(
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
   )
 );
 CREATE UNIQUE INDEX IF NOT EXISTS accounting_fiscal_review_live_unique
   ON accounting_fiscal_review_signoffs
     (company_id,period_start_date,period_end_date,retained_earnings_account_id,
      evidence_hash,review_kind)
   WHERE revoked_at IS NULL;
 CREATE INDEX IF NOT EXISTS accounting_fiscal_review_history_idx
   ON accounting_fiscal_review_signoffs(company_id,period_end_date,reviewed_at DESC);

 CREATE TABLE IF NOT EXISTS accounting_fiscal_review_policy(
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  enforce_reviewed_close BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS accounting_fiscal_reviewed_closures(
   id BIGSERIAL PRIMARY KEY,
   company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
   -- Reopening intentionally deletes the current fiscal_period_closures row.
   -- Preserve review evidence even after an audited reopen, rather than
   -- blocking the existing valid reopen operation.
   fiscal_closure_id INTEGER REFERENCES fiscal_period_closures(id) ON DELETE SET NULL,
   closing_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
   accounting_signoff_id BIGINT NOT NULL REFERENCES accounting_fiscal_review_signoffs(id) ON DELETE RESTRICT,
   owner_signoff_id BIGINT NOT NULL REFERENCES accounting_fiscal_review_signoffs(id) ON DELETE RESTRICT,
   evidence_hash CHAR(64) NOT NULL,
   certified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
   reviewed_by TEXT NOT NULL,
   CONSTRAINT fiscal_reviewed_closure_distinct_signoffs
    CHECK(accounting_signoff_id<>owner_signoff_id),
   CONSTRAINT fiscal_reviewed_closure_unique UNIQUE(company_id,fiscal_closure_id)
 );
 CREATE INDEX IF NOT EXISTS accounting_fiscal_reviewed_closures_date_idx
   ON accounting_fiscal_reviewed_closures(company_id,certified_at DESC);

 ALTER TABLE accounting_fiscal_review_policy ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_fiscal_review_policy FORCE ROW LEVEL SECURITY;
 ALTER TABLE accounting_fiscal_review_signoffs ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_fiscal_review_signoffs FORCE ROW LEVEL SECURITY;
 ALTER TABLE accounting_fiscal_reviewed_closures ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_fiscal_reviewed_closures FORCE ROW LEVEL SECURITY;
 DO $fiscal_review_rls$
 DECLARE tab TEXT;
 BEGIN
  FOREACH tab IN ARRAY ARRAY['accounting_fiscal_review_signoffs',
    'accounting_fiscal_reviewed_closures','accounting_fiscal_review_policy'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_policies
     WHERE schemaname=current_schema() AND tablename=tab
       AND policyname='fiscal_review_company_scope') THEN
    EXECUTE format('CREATE POLICY fiscal_review_company_scope ON %I
     USING(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)
     WITH CHECK(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)',tab);
   END IF;
  END LOOP;
 END $fiscal_review_rls$;
 `);
}

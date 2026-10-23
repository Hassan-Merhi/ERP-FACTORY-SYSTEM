/**
 * Phase 13: additive fiscal review evidence. No change to fiscal closing
 * journals or production vouchers, no automatic close on schema startup.
 */
import type { Pool } from "pg";
export async function ensureFiscalReviewSchema(pool: Pool): Promise<void> {
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

 CREATE UNIQUE INDEX IF NOT EXISTS accounting_fiscal_review_signoffs_company_id_uq
   ON accounting_fiscal_review_signoffs(company_id,id);
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
 -- Do not permit evidence from another company's signoffs to be used.
 DO $review_fk$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fiscal_review_accounting_company_fk') THEN
   ALTER TABLE accounting_fiscal_reviewed_closures
    ADD CONSTRAINT fiscal_review_accounting_company_fk
    FOREIGN KEY(company_id,accounting_signoff_id)
    REFERENCES accounting_fiscal_review_signoffs(company_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fiscal_review_owner_company_fk') THEN
   ALTER TABLE accounting_fiscal_reviewed_closures
    ADD CONSTRAINT fiscal_review_owner_company_fk
    FOREIGN KEY(company_id,owner_signoff_id)
    REFERENCES accounting_fiscal_review_signoffs(company_id,id) ON DELETE RESTRICT;
  END IF;
 END $review_fk$;

 -- The original closure is mutable through audited reopen; the reviewed
 -- evidence is immutable, and a closure can only be attested once.
 CREATE OR REPLACE FUNCTION fiscal_review_assert_evidence()
 RETURNS TRIGGER LANGUAGE plpgsql AS $review_evidence$
 DECLARE a RECORD; o RECORD; c RECORD; v RECORD;
 BEGIN
  SELECT * INTO a FROM accounting_fiscal_review_signoffs
   WHERE id=NEW.accounting_signoff_id AND company_id=NEW.company_id;
  SELECT * INTO o FROM accounting_fiscal_review_signoffs
   WHERE id=NEW.owner_signoff_id AND company_id=NEW.company_id;
  SELECT * INTO c FROM fiscal_period_closures
   WHERE id=NEW.fiscal_closure_id AND company_id=NEW.company_id;
  SELECT * INTO v FROM vouchers
   WHERE id=NEW.closing_voucher_id AND company_id=NEW.company_id;
  IF a.id IS NULL OR o.id IS NULL OR c.id IS NULL OR v.id IS NULL
     OR a.review_kind<>'ACCOUNTING' OR o.review_kind<>'OWNER'
     OR a.reviewer_id=o.reviewer_id
     OR a.revoked_at IS NOT NULL OR o.revoked_at IS NOT NULL
     OR a.evidence_hash<>NEW.evidence_hash OR o.evidence_hash<>NEW.evidence_hash
     OR a.period_start_date<>c.period_start_date OR o.period_start_date<>c.period_start_date
     OR a.period_end_date<>c.period_end_date OR o.period_end_date<>c.period_end_date
     OR a.retained_earnings_account_id<>c.retained_earnings_account_id
     OR o.retained_earnings_account_id<>c.retained_earnings_account_id
     OR c.closing_voucher_id<>NEW.closing_voucher_id THEN
    RAISE EXCEPTION 'FISCAL_REVIEW_EVIDENCE_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $review_evidence$;
 DROP TRIGGER IF EXISTS fiscal_review_evidence_guard
   ON accounting_fiscal_reviewed_closures;
 CREATE TRIGGER fiscal_review_evidence_guard
 BEFORE INSERT ON accounting_fiscal_reviewed_closures
 FOR EACH ROW EXECUTE FUNCTION fiscal_review_assert_evidence();

 CREATE INDEX IF NOT EXISTS accounting_fiscal_reviewed_closures_date_idx
   ON accounting_fiscal_reviewed_closures(company_id,certified_at DESC);

 -- Immutable review evidence. Only a one-time reviewed signoff revocation
 -- with actor/reason is permitted, and it cannot be revoked once consumed.
 CREATE OR REPLACE FUNCTION fiscal_review_signoff_immutability()
 RETURNS TRIGGER LANGUAGE plpgsql AS $review_signoff_lock$
 BEGIN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'FISCAL_SIGNOFF_DELETE_FORBIDDEN' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-'revoked_at'-'revoked_by'-'revoke_reason')
    IS DISTINCT FROM
     (to_jsonb(OLD)-'revoked_at'-'revoked_by'-'revoke_reason')
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NULLIF(TRIM(NEW.revoked_by),'') IS NULL
    OR LENGTH(TRIM(COALESCE(NEW.revoke_reason,'')))<10
    OR EXISTS(SELECT 1 FROM accounting_fiscal_reviewed_closures c
       WHERE c.accounting_signoff_id=OLD.id OR c.owner_signoff_id=OLD.id)
  THEN
   RAISE EXCEPTION 'FISCAL_SIGNOFF_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $review_signoff_lock$;
 DROP TRIGGER IF EXISTS fiscal_review_signoff_immutable
  ON accounting_fiscal_review_signoffs;
 CREATE TRIGGER fiscal_review_signoff_immutable
 BEFORE UPDATE OR DELETE ON accounting_fiscal_review_signoffs
 FOR EACH ROW EXECUTE FUNCTION fiscal_review_signoff_immutability();

 -- A reopen drops fiscal_period_closures. FK ON DELETE SET NULL may blank
 -- that link, but the reviewed close identity, source voucher, approvers,
 -- fingerprint, creator and timestamp can never be rewritten/deleted.
 CREATE OR REPLACE FUNCTION fiscal_review_close_immutability()
 RETURNS TRIGGER LANGUAGE plpgsql AS $review_closure_lock$
 BEGIN
  IF TG_OP='UPDATE' AND OLD.fiscal_closure_id IS NOT NULL
    AND NEW.fiscal_closure_id IS NULL
    AND (to_jsonb(NEW)-'fiscal_closure_id')
        IS NOT DISTINCT FROM (to_jsonb(OLD)-'fiscal_closure_id') THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FISCAL_REVIEWED_CLOSE_IMMUTABLE' USING ERRCODE='23514';
 END $review_closure_lock$;
 DROP TRIGGER IF EXISTS fiscal_review_close_immutable
  ON accounting_fiscal_reviewed_closures;
 CREATE TRIGGER fiscal_review_close_immutable
 BEFORE UPDATE OR DELETE ON accounting_fiscal_reviewed_closures
 FOR EACH ROW EXECUTE FUNCTION fiscal_review_close_immutability();

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

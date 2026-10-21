/**
 * Phase 15 release governance metadata. These tables contain no accounting
 * vouchers, FX amounts, bank balances, inventory value or master openings.
 * READ_ONLY is the implicit state for every company until a separately
 * reviewed Owner action explicitly permits new analytic metadata writes.
 */
import type { Pool } from "pg";
export async function ensureUnifiedAccountingRolloutSchema(pool: Pool): Promise<void> {
  await pool.query(`
 CREATE TABLE IF NOT EXISTS accounting_unified_release_reviews (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  release_sha VARCHAR(64) NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40,64}$'),
  review_kind VARCHAR(16) NOT NULL CHECK(review_kind IN ('TECHNICAL','SECURITY','FINANCE')),
  evidence_reference VARCHAR(500) NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  notes TEXT NOT NULL CHECK(length(trim(notes)) BETWEEN 10 AND 2000),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ, revoked_by TEXT, revoke_reason TEXT,
  CONSTRAINT unified_release_review_revocation_consistent CHECK(
   (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
   OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND
       length(trim(revoke_reason)) BETWEEN 10 AND 1000)
  )
 );
 CREATE UNIQUE INDEX IF NOT EXISTS unified_release_reviews_unique_live
  ON accounting_unified_release_reviews(company_id,release_sha,review_kind)
  WHERE revoked_at IS NULL;
 CREATE INDEX IF NOT EXISTS unified_release_reviews_company_idx
  ON accounting_unified_release_reviews(company_id,reviewed_at DESC);

 CREATE TABLE IF NOT EXISTS accounting_unified_rollout_policy (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  release_mode VARCHAR(24) NOT NULL DEFAULT 'READ_ONLY'
   CHECK(release_mode IN ('READ_ONLY','METADATA_PILOT')),
  release_sha VARCHAR(64),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 1000),
  CONSTRAINT unified_rollout_release_sha_required CHECK(
    release_mode='READ_ONLY' OR
      (release_sha IS NOT NULL AND release_sha ~ '^[0-9a-f]{40,64}$')
  )
 );

 ALTER TABLE accounting_unified_release_reviews ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_unified_release_reviews FORCE ROW LEVEL SECURITY;
 ALTER TABLE accounting_unified_rollout_policy ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_unified_rollout_policy FORCE ROW LEVEL SECURITY;
 DO $unified_rollout_rls$
 DECLARE tab TEXT;
 BEGIN
  FOREACH tab IN ARRAY ARRAY['accounting_unified_release_reviews',
    'accounting_unified_rollout_policy'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_policies
     WHERE schemaname=current_schema() AND tablename=tab
       AND policyname='accounting_rollout_company_scope') THEN
    EXECUTE format('CREATE POLICY accounting_rollout_company_scope ON %I
     USING(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)
     WITH CHECK(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)',tab);
   END IF;
  END LOOP;
 END $unified_rollout_rls$;

 -- Reviews are immutable except for a one-time audited revocation. A policy
 -- references the source release SHA but cannot remove this evidence.
 CREATE OR REPLACE FUNCTION unified_release_review_immutable()
 RETURNS TRIGGER LANGUAGE plpgsql AS $release_immutable$
 BEGIN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'RELEASE_REVIEW_DELETE_FORBIDDEN' USING ERRCODE='23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
   OR (to_jsonb(NEW)-'revoked_at'-'revoked_by'-'revoke_reason')
      IS DISTINCT FROM
      (to_jsonb(OLD)-'revoked_at'-'revoked_by'-'revoke_reason')
   OR NULLIF(TRIM(COALESCE(NEW.revoked_by,'')),'') IS NULL
   OR LENGTH(TRIM(COALESCE(NEW.revoke_reason,'')))<10
  THEN RAISE EXCEPTION 'RELEASE_REVIEW_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $release_immutable$;
 DROP TRIGGER IF EXISTS unified_release_review_immutable_guard
  ON accounting_unified_release_reviews;
 CREATE TRIGGER unified_release_review_immutable_guard
 BEFORE UPDATE OR DELETE ON accounting_unified_release_reviews
 FOR EACH ROW EXECUTE FUNCTION unified_release_review_immutable();

 `);
}

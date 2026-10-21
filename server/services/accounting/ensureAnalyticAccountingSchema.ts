/**
 * Phase 12: additive analytic cost-center metadata, never a financial GL.
 * No voucher, posting, monetary rate or balance is touched by this DDL.
 */
import type {Pool} from "pg";
export async function ensureAnalyticAccountingSchema(pool:Pool):Promise<void>{
 await pool.query(`
 CREATE TABLE IF NOT EXISTS accounting_cost_centers (
   id BIGSERIAL PRIMARY KEY,
   company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
   code VARCHAR(40) NOT NULL,
   name VARCHAR(180) NOT NULL,
   module VARCHAR(12) NOT NULL CHECK(module IN('ERP','FACTORY','PROPERTIES','SHARED')),
   parent_id BIGINT REFERENCES accounting_cost_centers(id) ON DELETE RESTRICT,
   sort_order INTEGER NOT NULL DEFAULT 0,
   active BOOLEAN NOT NULL DEFAULT TRUE,
   note TEXT,
   created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   CONSTRAINT accounting_cost_center_no_self_parent CHECK(parent_id IS DISTINCT FROM id),
   CONSTRAINT accounting_cost_center_code_chars CHECK(code ~ '^[A-Za-z0-9_.-]{1,40}$')
 );
 CREATE UNIQUE INDEX IF NOT EXISTS accounting_cost_centers_code_uq
   ON accounting_cost_centers(company_id,LOWER(code));
 CREATE INDEX IF NOT EXISTS accounting_cost_centers_parent_idx
   ON accounting_cost_centers(company_id,parent_id,sort_order,id);

 CREATE TABLE IF NOT EXISTS accounting_cost_allocations (
   id BIGSERIAL PRIMARY KEY,
   company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
   voucher_entry_id INTEGER NOT NULL REFERENCES voucher_entries(id) ON DELETE RESTRICT,
   cost_center_id BIGINT NOT NULL REFERENCES accounting_cost_centers(id) ON DELETE RESTRICT,
   amount_usd NUMERIC(20,6) NOT NULL CHECK(amount_usd>0),
   client_request_key VARCHAR(128) NOT NULL,
   note TEXT,
   allocated_by TEXT NOT NULL, allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   voided_at TIMESTAMPTZ, voided_by TEXT, void_reason TEXT,
   CONSTRAINT accounting_cost_allocation_void_consistent CHECK(
     (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
     (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
   ),
   CONSTRAINT accounting_cost_allocation_request_uq UNIQUE(company_id,client_request_key)
 );
 CREATE INDEX IF NOT EXISTS accounting_cost_allocations_entry_idx
  ON accounting_cost_allocations(company_id,voucher_entry_id)
  WHERE voided_at IS NULL;
 CREATE INDEX IF NOT EXISTS accounting_cost_allocations_center_idx
  ON accounting_cost_allocations(company_id,cost_center_id)
  WHERE voided_at IS NULL;

 CREATE TABLE IF NOT EXISTS accounting_cost_budgets (
   id BIGSERIAL PRIMARY KEY,
   company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
   cost_center_id BIGINT NOT NULL REFERENCES accounting_cost_centers(id) ON DELETE RESTRICT,
   month_start DATE NOT NULL,
   category VARCHAR(20) NOT NULL CHECK(category IN ('income','cost_of_sales','expense')),
   planned_usd NUMERIC(20,6) NOT NULL CHECK(planned_usd>=0),
   state VARCHAR(12) NOT NULL DEFAULT 'DRAFT'
     CHECK(state IN ('DRAFT','APPROVED','ARCHIVED')),
   created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   approved_by TEXT, approved_at TIMESTAMPTZ,
   archived_by TEXT, archived_at TIMESTAMPTZ, archive_reason TEXT,
   notes TEXT,
   CONSTRAINT accounting_budget_calendar_month CHECK(EXTRACT(DAY FROM month_start)=1),
   CONSTRAINT accounting_budget_approval_consistent CHECK(
     (state='DRAFT' AND approved_at IS NULL AND archived_at IS NULL)
     OR (state='APPROVED' AND approved_at IS NOT NULL AND archived_at IS NULL)
     OR (state='ARCHIVED' AND archived_at IS NOT NULL AND archive_reason IS NOT NULL)
   )
 );
 CREATE UNIQUE INDEX IF NOT EXISTS accounting_cost_budgets_live_uq
  ON accounting_cost_budgets(company_id,cost_center_id,month_start,category)
  WHERE state<>'ARCHIVED';
 CREATE INDEX IF NOT EXISTS accounting_cost_budgets_period_idx
  ON accounting_cost_budgets(company_id,month_start,category,state);

 ALTER TABLE accounting_cost_centers ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_cost_centers FORCE ROW LEVEL SECURITY;
 ALTER TABLE accounting_cost_allocations ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_cost_allocations FORCE ROW LEVEL SECURITY;
 ALTER TABLE accounting_cost_budgets ENABLE ROW LEVEL SECURITY;
 ALTER TABLE accounting_cost_budgets FORCE ROW LEVEL SECURITY;
 DO $cost_center_rls$
 DECLARE tab TEXT;
 BEGIN
  FOREACH tab IN ARRAY ARRAY['accounting_cost_centers',
   'accounting_cost_allocations','accounting_cost_budgets'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_policies
     WHERE schemaname=current_schema() AND tablename=tab
       AND policyname='analytic_company_isolation') THEN
    EXECUTE format('CREATE POLICY analytic_company_isolation ON %I
     USING(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)
     WITH CHECK(company_id=NULLIF(current_setting(''app.current_company_id'',true),'''')::integer)',tab);
   END IF;
  END LOOP;
 END $cost_center_rls$;
 `);
}

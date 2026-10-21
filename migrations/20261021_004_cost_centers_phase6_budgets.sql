-- Phase 6: period budgets for analytical cost centers (USD historical book basis).
-- No GL entries, inventory movements, source documents, or old allocations change.
CREATE TABLE IF NOT EXISTS cost_center_monthly_budgets (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  cost_center_id INTEGER NOT NULL,
  budget_month DATE NOT NULL,
  amount_usd NUMERIC(20,6) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_monthly_budgets_company_fk
    FOREIGN KEY (company_id,cost_center_id)
    REFERENCES cost_centers(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT cost_center_monthly_budgets_first_day CHECK (
    extract(day from budget_month) = 1
  ),
  CONSTRAINT cost_center_monthly_budgets_amount_check CHECK (
    amount_usd >= 0
  ),
  CONSTRAINT cost_center_monthly_budgets_unique
    UNIQUE(company_id,cost_center_id,budget_month)
);
CREATE INDEX IF NOT EXISTS cost_center_monthly_budgets_period_idx
  ON cost_center_monthly_budgets(company_id,budget_month,cost_center_id);

ALTER TABLE cost_center_monthly_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_monthly_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_monthly_budgets_company_scope_policy
  ON cost_center_monthly_budgets;
CREATE POLICY cost_center_monthly_budgets_company_scope_policy
  ON cost_center_monthly_budgets
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

-- Budget company and cost center are immutable; retain historical budgets of
-- archived cost centers, but avoid making new budgets for archived centers.
CREATE OR REPLACE FUNCTION cost_center_monthly_budgets_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_budget$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id OR
    NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id
  ) THEN
    RAISE EXCEPTION 'Budget company and cost center are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cost_centers c WHERE c.company_id=NEW.company_id
      AND c.id=NEW.cost_center_id AND c.active
  ) THEN
    RAISE EXCEPTION 'New or updated budgets require an active cost center';
  END IF;
  RETURN NEW;
END
$cc_budget$;
DROP TRIGGER IF EXISTS cost_center_monthly_budgets_guard_trg
  ON cost_center_monthly_budgets;
CREATE TRIGGER cost_center_monthly_budgets_guard_trg
  BEFORE INSERT OR UPDATE ON cost_center_monthly_budgets
  FOR EACH ROW EXECUTE FUNCTION cost_center_monthly_budgets_guard();

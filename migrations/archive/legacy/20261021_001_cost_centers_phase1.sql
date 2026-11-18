-- Phase 1: ERP + Factory Mode cost-center accounting dimensions.
-- Additive only. No voucher, inventory, daybook, or historical data is rewritten.
-- Requires company-scope helpers installed by 0016_company_scope_rls_readiness.sql.
-- Allocation values are analytical snapshots, NEVER new GL postings.

CREATE TABLE IF NOT EXISTS cost_centers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code VARCHAR(50) NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_id INTEGER,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_centers_code_nonblank CHECK (length(btrim(code)) > 0),
  CONSTRAINT cost_centers_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT cost_centers_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT cost_centers_company_code_unique UNIQUE (company_id, code),
  CONSTRAINT cost_centers_company_id_unique UNIQUE (company_id, id),
  CONSTRAINT cost_centers_company_parent_fk FOREIGN KEY (company_id, parent_id)
    REFERENCES cost_centers(company_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS cost_centers_company_parent_idx
  ON cost_centers(company_id, parent_id);
CREATE INDEX IF NOT EXISTS cost_centers_company_active_idx
  ON cost_centers(company_id, active);

-- Lock hierarchy edits by company. A recursive ancestry check disallows cycles
-- even in concurrent parent edits; the composite FK disallows cross-company parents.
CREATE OR REPLACE FUNCTION cost_centers_guard_hierarchy()
RETURNS trigger LANGUAGE plpgsql AS $cc_hierarchy$
BEGIN
  PERFORM pg_advisory_xact_lock(721030, NEW.company_id);

  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Cost centers cannot be moved between companies';
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM cost_centers
        WHERE company_id = NEW.company_id AND id = NEW.parent_id
        UNION
        SELECT p.id, p.parent_id
        FROM cost_centers p
        INNER JOIN ancestors a ON p.id = a.parent_id
        WHERE p.company_id = NEW.company_id
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Cost center hierarchy cannot contain a cycle';
    END IF;
  END IF;

  RETURN NEW;
END
$cc_hierarchy$;
DROP TRIGGER IF EXISTS cost_centers_guard_hierarchy_trg ON cost_centers;
CREATE TRIGGER cost_centers_guard_hierarchy_trg
  BEFORE INSERT OR UPDATE OF company_id, parent_id
  ON cost_centers FOR EACH ROW EXECUTE FUNCTION cost_centers_guard_hierarchy();

-- A single authoritative source is linked to each analytical allocation.
-- A factory transaction that already posts an ERP/Factory voucher must be
-- allocated via voucher_entry_id only; do not also allocate its daybook copy.
-- Full vs partial allocation is determined by comparing source amounts to sums.
CREATE TABLE IF NOT EXISTS cost_center_allocations (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  cost_center_id INTEGER NOT NULL,
  voucher_entry_id INTEGER REFERENCES voucher_entries(id) ON DELETE CASCADE,
  factory_daybook_entry_id INTEGER REFERENCES factory_daybook_entries(id) ON DELETE CASCADE,
  amount_native NUMERIC(20,6) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  amount_base NUMERIC(20,6) NOT NULL,
  base_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  historical_rate NUMERIC(20,10),
  rate_convention VARCHAR(30),
  cost_treatment VARCHAR(24) NOT NULL DEFAULT 'EXPENSE',
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT cost_center_allocations_cost_center_company_fk
    FOREIGN KEY (company_id, cost_center_id)
    REFERENCES cost_centers(company_id, id) ON DELETE RESTRICT,
  CONSTRAINT cost_center_allocations_one_source_check CHECK (
    (voucher_entry_id IS NOT NULL AND factory_daybook_entry_id IS NULL)
    OR (voucher_entry_id IS NULL AND factory_daybook_entry_id IS NOT NULL)
  ),
  CONSTRAINT cost_center_allocations_native_positive_check CHECK (amount_native > 0),
  CONSTRAINT cost_center_allocations_base_nonnegative_check CHECK (amount_base >= 0),
  CONSTRAINT cost_center_allocations_currency_nonblank_check CHECK (
    length(btrim(currency)) > 0 AND length(btrim(base_currency)) > 0
  ),
  CONSTRAINT cost_center_allocations_rate_positive_check
    CHECK (historical_rate IS NULL OR historical_rate > 0),
  CONSTRAINT cost_center_allocations_treatment_check
    CHECK (cost_treatment IN ('EXPENSE', 'INVENTORY_COST', 'OTHER'))
);
CREATE INDEX IF NOT EXISTS cost_center_allocations_company_center_idx
  ON cost_center_allocations(company_id, cost_center_id);
CREATE INDEX IF NOT EXISTS cost_center_allocations_voucher_entry_idx
  ON cost_center_allocations(voucher_entry_id)
  WHERE voucher_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_center_allocations_factory_daybook_idx
  ON cost_center_allocations(factory_daybook_entry_id)
  WHERE factory_daybook_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_allocations_voucher_center_unique
  ON cost_center_allocations(company_id, voucher_entry_id, cost_center_id)
  WHERE voucher_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_allocations_daybook_center_unique
  ON cost_center_allocations(company_id, factory_daybook_entry_id, cost_center_id)
  WHERE factory_daybook_entry_id IS NOT NULL;

-- Validate tenant/source agreement and both currency totals atomically.
-- Advisory company lock serializes concurrent splits to prevent over-allocation.
-- Source modifications after allocations are a Phase 2+ lifecycle responsibility:
-- update allocations in the same transaction, or reject the source change.
CREATE OR REPLACE FUNCTION cost_center_allocations_guard()
RETURNS trigger LANGUAGE plpgsql AS $cc_allocation$
DECLARE
  source_company_id INTEGER;
  source_currency VARCHAR(10);
  source_native NUMERIC(20,6);
  source_base NUMERIC(20,6);
  previous_native NUMERIC(20,6);
  previous_base NUMERIC(20,6);
BEGIN
  PERFORM pg_advisory_xact_lock(721031, NEW.company_id);

  IF NEW.base_currency <> 'USD' THEN
    RAISE EXCEPTION 'Phase 1 cost center base snapshots must use USD';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.voucher_entry_id IS DISTINCT FROM OLD.voucher_entry_id
    OR NEW.factory_daybook_entry_id IS DISTINCT FROM OLD.factory_daybook_entry_id
  ) THEN
    RAISE EXCEPTION 'Allocation company and source are immutable; reallocate instead';
  END IF;

  IF NEW.voucher_entry_id IS NOT NULL THEN
    SELECT ve.company_id,
      COALESCE(ve.transaction_currency, v.currency, 'USD'),
      GREATEST(
        abs(COALESCE(ve.transaction_debit_amount, ve.debit_amount, 0)),
        abs(COALESCE(ve.transaction_credit_amount, ve.credit_amount, 0))
      ),
      GREATEST(
        abs(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)),
        abs(COALESCE(ve.base_credit_amount, ve.credit_amount, 0))
      )
      INTO source_company_id, source_currency, source_native, source_base
    FROM voucher_entries ve
    JOIN vouchers v ON v.id = ve.voucher_id
    WHERE ve.id = NEW.voucher_entry_id
      AND v.deleted_at IS NULL
    FOR SHARE OF ve, v;
  ELSE
    SELECT f.company_id, f.currency_code,
      abs(f.amount_currency), abs(f.amount_usd)
      INTO source_company_id, source_currency, source_native, source_base
    FROM factory_daybook_entries f
    WHERE f.id = NEW.factory_daybook_entry_id
    FOR SHARE;
  END IF;

  IF source_company_id IS NULL OR source_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'Cost center source must exist in the same company';
  END IF;
  IF upper(btrim(NEW.currency)) <> upper(btrim(source_currency)) THEN
    RAISE EXCEPTION 'Cost center allocation currency differs from source currency';
  END IF;

  SELECT COALESCE(sum(amount_native), 0), COALESCE(sum(amount_base), 0)
    INTO previous_native, previous_base
  FROM cost_center_allocations
  WHERE company_id = NEW.company_id
    AND id <> NEW.id
    AND (
      (NEW.voucher_entry_id IS NOT NULL AND voucher_entry_id = NEW.voucher_entry_id)
      OR (NEW.factory_daybook_entry_id IS NOT NULL AND factory_daybook_entry_id = NEW.factory_daybook_entry_id)
    );

  IF source_native IS NULL OR source_base IS NULL
     OR previous_native + NEW.amount_native > source_native
     OR previous_base + NEW.amount_base > source_base THEN
    RAISE EXCEPTION 'Cost center allocations exceed the source transaction amount';
  END IF;

  RETURN NEW;
END
$cc_allocation$;
DROP TRIGGER IF EXISTS cost_center_allocations_guard_trg ON cost_center_allocations;
CREATE TRIGGER cost_center_allocations_guard_trg
  BEFORE INSERT OR UPDATE ON cost_center_allocations
  FOR EACH ROW EXECUTE FUNCTION cost_center_allocations_guard();

-- The existing company-scope helper fails closed without tenant context;
-- FORCE RLS protects even application table-owner connections.
ALTER TABLE cost_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_centers_company_scope_policy ON cost_centers;
CREATE POLICY cost_centers_company_scope_policy ON cost_centers
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

ALTER TABLE cost_center_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_center_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_center_allocations_company_scope_policy ON cost_center_allocations;
CREATE POLICY cost_center_allocations_company_scope_policy ON cost_center_allocations
  USING (erp_company_scope_matches(company_id))
  WITH CHECK (erp_company_scope_matches(company_id));

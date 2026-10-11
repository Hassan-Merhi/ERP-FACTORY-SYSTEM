-- Accounting audit phase 26 (MC-8): row-level company scope on the remaining
-- company-owned tables.
--
-- Migration 0016 installed the fail-closed company scope (app.current_company_id,
-- app.authorized_company_ids, app.company_scope_maintenance) and protected nine
-- tables. Suppliers, employees, factory suppliers, customer_balances, the
-- intercompany transfer links, fiscal closures and the factory money tables
-- relied on application filters only, and 36 lookups read them by id alone.
-- This migration extends the same policy to them; it uses the 0016 functions
-- and is applied right after 0016 by server/companyScopeRlsBridge.mjs, in the
-- same transaction, and verified there. Replayable: every policy is dropped and
-- recreated.
--
-- Three tables need more than company_id = scope:
--   * suppliers: a subsidiary posts against its parent's suppliers (the ledger
--     guard allows a supplier of the parent or of a subsidiary), and legacy
--     suppliers with no company (company_id NULL, listed by the supplier
--     company-scope migration) stay visible as before;
--   * inter_company_transfers: a link names two companies; it is visible to,
--     and written by, either of them (the legs themselves are protected by the
--     vouchers policy);
--   * fiscal_period_closures: company_id is nullable in the schema; a NULL row
--     is visible only in maintenance scope.
--
-- Rollback: NO FORCE / DISABLE ROW LEVEL SECURITY on the tables below and drop
-- their *_company_scope_policy policies and erp_company_group_scope_matches.

CREATE OR REPLACE FUNCTION erp_company_group_scope_matches(row_company_id integer)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $company_group_scope_match$
DECLARE
  current_company_id integer;
BEGIN
  IF erp_company_scope_matches(row_company_id) THEN
    RETURN true;
  END IF;
  current_company_id := erp_current_company_id();
  RETURN EXISTS (
    SELECT 1
      FROM companies c
     WHERE (c.id = current_company_id AND c.parent_company_id = row_company_id)
        OR (c.id = row_company_id AND c.parent_company_id = current_company_id)
  );
END
$company_group_scope_match$;

DO $rls_extension$
DECLARE
  tenant_table text;
  policy_name text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'employees',
    'factory_suppliers',
    'customer_balances',
    'factory_containers',
    'factory_supplier_payments',
    'factory_supplier_fx_transfers',
    'factory_pos_sales',
    'factory_daybook_entries',
    'factory_container_commissions',
    'factory_container_other_charges',
    'factory_offload_additional_charges',
    'factory_transporter_transactions',
    'factory_stock_value_events',
    'factory_payrolls',
    'factory_worker_advances',
    'fiscal_period_closures'
  ]
  LOOP
    IF to_regclass('public.' || tenant_table) IS NULL
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = tenant_table AND column_name = 'company_id') THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    policy_name := tenant_table || '_company_scope_policy';
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (erp_company_scope_matches(company_id)) WITH CHECK (erp_company_scope_matches(company_id))',
      policy_name,
      tenant_table
    );
  END LOOP;

  IF to_regclass('public.suppliers') IS NOT NULL THEN
    -- The supplier company-scope migration (20260728_001) adds this column too;
    -- it runs after this bridge on a fresh database.
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS company_id INTEGER;
    ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS suppliers_company_scope_policy ON suppliers;
    CREATE POLICY suppliers_company_scope_policy ON suppliers
      USING (company_id IS NULL OR erp_company_group_scope_matches(company_id))
      WITH CHECK (company_id IS NULL OR erp_company_group_scope_matches(company_id));
  END IF;

  IF to_regclass('public.inter_company_transfers') IS NOT NULL THEN
    ALTER TABLE inter_company_transfers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inter_company_transfers FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS inter_company_transfers_company_scope_policy ON inter_company_transfers;
    CREATE POLICY inter_company_transfers_company_scope_policy ON inter_company_transfers
      USING (erp_company_scope_matches(from_company_id) OR erp_company_scope_matches(to_company_id))
      WITH CHECK (erp_company_scope_matches(from_company_id) OR erp_company_scope_matches(to_company_id));
  END IF;
END
$rls_extension$;

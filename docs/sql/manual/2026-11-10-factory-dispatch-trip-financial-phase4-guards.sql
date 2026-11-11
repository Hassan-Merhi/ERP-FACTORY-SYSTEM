-- Phase 4 manual SQL ADDENDUM. NOT EXECUTED.
-- Run in TablePlus AFTER the Phase 2 financial-table DDL at final handoff.
-- Guards protect already-posted barcode/order evidence even if a legacy API or
-- SQL writer bypasses the client-side warning. No existing rows updated.
BEGIN;

-- Physically shipped and financially posted bales must never be silently
-- repriced, detached, exchanged or reattached to another loading.
CREATE OR REPLACE FUNCTION factory_dispatch_guard_order_bale_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  old_company_id INTEGER;
  order_status TEXT;
  order_invoice_number TEXT;
  has_live BOOLEAN;
  is_posted_bale BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT company_id, status, invoice_number
      INTO old_company_id, order_status, order_invoice_number
      FROM customer_orders WHERE id = NEW.order_id;
    IF old_company_id IS NULL THEN RETURN NEW; END IF;
    -- Financially completed orders remain immutable. Earlier POSTED trucks do
    -- not lock future additions to an unfinished loading; existing posted
    -- bales, their prices, and their truck evidence are still guarded below.
    SELECT EXISTS(
      SELECT 1 FROM factory_dispatch_trip_financials
       WHERE company_id=old_company_id AND order_id=NEW.order_id
         AND status = 'CONSOLIDATED'
    ) INTO has_live;
    IF has_live THEN
      RAISE EXCEPTION 'Cannot add bales after the dispatch invoice is consolidated';
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM factory_dispatch_trip_financials
       WHERE company_id=old_company_id AND order_id=NEW.order_id
         AND status = 'POSTED'
    ) INTO has_live;
    IF has_live AND (
      order_status NOT IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION')
      OR order_invoice_number IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Cannot add bales to a completed dispatch loading';
    END IF;
    RETURN NEW;
  END IF;

  SELECT company_id INTO old_company_id FROM customer_orders WHERE id = OLD.order_id;
  IF old_company_id IS NULL THEN RETURN OLD; END IF;
  SELECT EXISTS(
    SELECT 1 FROM factory_dispatch_trip_financials
     WHERE company_id=old_company_id AND order_id=OLD.order_id
       AND status IN ('POSTED','CONSOLIDATED')
  ) INTO has_live;
  IF NOT has_live THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM factory_dispatch_trip_financial_bales b
      JOIN factory_dispatch_trip_financials f
        ON f.id=b.financial_id AND f.company_id=b.company_id
       AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
     WHERE b.company_id=old_company_id AND b.order_id=OLD.order_id
       AND b.bale_id=OLD.bale_id AND b.snapshot_revision=f.snapshot_revision
       AND f.status IN ('POSTED','CONSOLIDATED')
  ) INTO is_posted_bale;

  IF TG_OP = 'UPDATE' THEN
    -- No silent valuation or identity changes while trip balances exist;
    -- only the later approved consolidation procedure can remove the hold.
    RAISE EXCEPTION 'Loading bale records are locked while dispatch trips have live financial postings';
  END IF;
  IF is_posted_bale THEN
    RAISE EXCEPTION 'Financially posted dispatch bale cannot be removed from Pending Loading';
  END IF;
  -- Unshipped/unscanned bale removals remain possible through the authorized
  -- reconciliation endpoint, which checks status and approver on the server.
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_order_bale_financial_guard ON customer_order_bales;
CREATE TRIGGER factory_dispatch_order_bale_financial_guard
  BEFORE INSERT OR UPDATE OR DELETE ON customer_order_bales
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_order_bale_evidence();

-- A completed dispatch with customer accounting cannot be reopened or have
-- its active barcode evidence rewritten. Reversal is a distinct transaction.
CREATE OR REPLACE FUNCTION factory_dispatch_guard_posted_physical_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c INTEGER;
  o INTEGER;
  d BIGINT;
  posted BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'factory_loading_dispatches' THEN
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    c := OLD.company_id; o := OLD.order_id; d := OLD.id;
  ELSIF TG_TABLE_NAME = 'factory_loading_dispatch_scans' THEN
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    c := OLD.company_id; o := OLD.order_id; d := OLD.dispatch_id;
  ELSE
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    c := OLD.company_id; o := OLD.order_id; d := OLD.dispatch_id;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM factory_dispatch_trip_financials
     WHERE company_id=c AND order_id=o AND dispatch_id=d
       AND status IN ('POSTED','CONSOLIDATED')
  ) INTO posted;
  IF posted THEN
    IF TG_TABLE_NAME = 'factory_loading_dispatches' AND TG_OP = 'UPDATE' THEN
      IF NEW.status = OLD.status AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
         AND NEW.closed_by_user_id IS NOT DISTINCT FROM OLD.closed_by_user_id THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Cannot alter signed physical dispatch evidence after financial posting';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_physical_posted_guard ON factory_loading_dispatches;
CREATE TRIGGER factory_dispatch_physical_posted_guard
  BEFORE UPDATE OR DELETE ON factory_loading_dispatches
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_physical_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_physical_scan_posted_guard ON factory_loading_dispatch_scans;
CREATE TRIGGER factory_dispatch_physical_scan_posted_guard
  BEFORE UPDATE OR DELETE ON factory_loading_dispatch_scans
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_physical_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_closure_posted_guard ON factory_loading_dispatch_closure_history;
CREATE TRIGGER factory_dispatch_closure_posted_guard
  BEFORE UPDATE OR DELETE ON factory_loading_dispatch_closure_history
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_physical_evidence();


-- Source-owned vouchers and their original/reversal entries remain immutable.
-- No generic voucher editor, retirement, direct SQL update or extra entry may
-- silently change the linked Factory trip customer amount.
CREATE OR REPLACE FUNCTION factory_dispatch_guard_posted_vouchers()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  protected_voucher_id INTEGER;
  protected_company_id INTEGER;
  linked BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'voucher_entries' THEN
    IF TG_OP = 'INSERT' THEN
      protected_voucher_id := NEW.voucher_id;
    ELSE
      protected_voucher_id := OLD.voucher_id;
    END IF;
    SELECT company_id INTO protected_company_id FROM vouchers WHERE id = protected_voucher_id;
  ELSIF TG_TABLE_NAME = 'accounting_posting_requests' THEN
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    protected_voucher_id := OLD.voucher_id;
    protected_company_id := OLD.company_id;
  ELSE
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    protected_voucher_id := OLD.id;
    protected_company_id := OLD.company_id;
  END IF;

  IF protected_voucher_id IS NOT NULL AND protected_company_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM factory_dispatch_trip_postings p
       WHERE p.company_id=protected_company_id
         AND p.voucher_ids @> jsonb_build_array(protected_voucher_id)
    ) INTO linked;
    IF linked THEN
      RAISE EXCEPTION 'Source-owned Factory dispatch voucher cannot be changed or retired; use trip financial correction';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'voucher_entries' AND NEW.voucher_id IS DISTINCT FROM OLD.voucher_id THEN
    SELECT company_id INTO protected_company_id FROM vouchers WHERE id = NEW.voucher_id;
    IF EXISTS (
      SELECT 1 FROM factory_dispatch_trip_postings p
       WHERE p.company_id=protected_company_id
         AND p.voucher_ids @> jsonb_build_array(NEW.voucher_id)
    ) THEN
      RAISE EXCEPTION 'Cannot transfer an entry into a finalized Factory dispatch voucher';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_source_voucher_guard ON vouchers;
CREATE TRIGGER factory_dispatch_source_voucher_guard
  BEFORE UPDATE OR DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_vouchers();
DROP TRIGGER IF EXISTS factory_dispatch_source_voucher_entries_guard ON voucher_entries;
CREATE TRIGGER factory_dispatch_source_voucher_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_vouchers();
DROP TRIGGER IF EXISTS factory_dispatch_source_posting_identity_guard ON accounting_posting_requests;
CREATE TRIGGER factory_dispatch_source_posting_identity_guard
  BEFORE UPDATE OR DELETE ON accounting_posting_requests
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_guard_posted_vouchers();

-- Apply the same fail-closed company RLS as the existing ERP vouchers and
-- ledger_accounts. A missing app.current_company_id MUST NOT expose all trips.
DO $dispatch_rls$
DECLARE
  tenant_table TEXT;
  policy_name TEXT;
BEGIN
  IF to_regprocedure('public.erp_company_scope_matches(integer)') IS NULL THEN
    RAISE EXCEPTION 'ERP company scope RLS migration 0016 must be installed first';
  END IF;
  FOREACH tenant_table IN ARRAY ARRAY[
    'factory_dispatch_trip_financials',
    'factory_dispatch_trip_financial_bales',
    'factory_dispatch_trip_charges',
    'factory_dispatch_trip_postings',
    'factory_dispatch_trip_exports',
    'factory_dispatch_order_consolidations',
    'factory_dispatch_financial_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tenant_table);
    policy_name := tenant_table || '_company_scope_policy';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO public '
      || 'USING (erp_company_scope_matches(company_id)) '
      || 'WITH CHECK (erp_company_scope_matches(company_id))',
      policy_name, tenant_table
    );
  END LOOP;
END
$dispatch_rls$;

COMMIT;

-- Phase 8 will need its own explicitly controlled consolidated invoice write
-- path, not a blanket disablement of these guards. Do NOT run at this stage.

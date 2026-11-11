/**
 * Phase 7, TablePlus-only. Applied AFTER Phase 2/4/5/6 scripts,
 * BEFORE the Phase 8 consolidated invoice is implemented.
 * The user runs this manually in TablePlus at the end of all phases.
 * Never execute automatically in the API, boot process or CI.
 */
BEGIN;
DO $phase7_dependency$
BEGIN
  IF to_regclass('public.factory_dispatch_order_consolidations') IS NULL
     OR to_regclass('public.factory_dispatch_trip_financials') IS NULL
     OR to_regclass('public.factory_dispatch_financial_events') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 financial tables are required before Phase 7 reconciliation';
  END IF;
END $phase7_dependency$;

ALTER TABLE public.factory_dispatch_order_consolidations
  ADD COLUMN IF NOT EXISTS reconciliation_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciled_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;
DO $check7$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='factory_dispatch_order_consolidations_signoff_ck') THEN
    ALTER TABLE public.factory_dispatch_order_consolidations
      ADD CONSTRAINT factory_dispatch_order_consolidations_signoff_ck
      CHECK (
        (reconciled_at IS NULL AND reconciled_by_user_id IS NULL
         AND reconciliation_reason IS NULL)
        OR (reconciled_at IS NOT NULL AND reconciled_by_user_id IS NOT NULL
            AND length(trim(reconciliation_reason)) BETWEEN 10 AND 1000
            AND reconciliation_fingerprint ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof(reconciliation_snapshot)='object'
            AND included_posting_ids <> '[]'::jsonb)
      );
  END IF;
END $check7$;

-- A signed order-wide reconciliation cannot be replaced with a different
-- fingerprint, financial totals or included trip postings. Phase 8 may set
-- status FINALIZED and invoice_number without changing signed evidence.
CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_signed_consolidation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.reconciled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Signed Factory dispatch reconciliation cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reconciled_at IS NOT NULL THEN
    IF NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at
       OR NEW.reconciled_by_user_id IS DISTINCT FROM OLD.reconciled_by_user_id
       OR NEW.reconciliation_reason IS DISTINCT FROM OLD.reconciliation_reason
       OR NEW.reconciliation_fingerprint IS DISTINCT FROM OLD.reconciliation_fingerprint
       OR NEW.reconciliation_snapshot IS DISTINCT FROM OLD.reconciliation_snapshot
       OR NEW.included_posting_ids IS DISTINCT FROM OLD.included_posting_ids
       OR NEW.goods_subtotal IS DISTINCT FROM OLD.goods_subtotal
       OR NEW.billable_charges_total IS DISTINCT FROM OLD.billable_charges_total
       OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
       OR NEW.customer_total IS DISTINCT FROM OLD.customer_total
    THEN
      RAISE EXCEPTION 'Signed Factory dispatch reconciliation evidence is immutable';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_signed_consolidation_guard
  ON public.factory_dispatch_order_consolidations;
CREATE TRIGGER factory_dispatch_signed_consolidation_guard
  BEFORE UPDATE OR DELETE ON public.factory_dispatch_order_consolidations
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_consolidation();

-- Protect all barcode evidence, loaded order links and order-level charges
-- after all trucks have been matched and the supervisor signs the result.
CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_signed_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_order INTEGER;
  target_company INTEGER;
  is_signed BOOLEAN;
  new_target_signed BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='factory_loading_dispatches'
     OR TG_TABLE_NAME='factory_loading_dispatch_scans'
     OR TG_TABLE_NAME='factory_loading_dispatch_closure_history' THEN
    IF TG_OP='INSERT' THEN
      target_company:=NEW.company_id;
      target_order:=NEW.order_id;
    ELSE
      target_company:=OLD.company_id;
      target_order:=OLD.order_id;
    END IF;
  ELSE
    IF TG_OP='INSERT' THEN target_order:=NEW.order_id;
    ELSE target_order:=OLD.order_id;
    END IF;
    SELECT company_id INTO target_company FROM customer_orders WHERE id=target_order;
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM factory_dispatch_order_consolidations
     WHERE company_id=target_company AND order_id=target_order
       AND reconciled_at IS NOT NULL AND status IN ('DRAFT','FINALIZED')
  ) INTO is_signed;
  IF is_signed THEN
    -- Phase 8 may link a previously unposted original loading charge to its
    -- newly created customer voucher *during DRAFT consolidation only*.
    -- Amount, ledger mapping, name and order ownership remain immutable.
    IF TG_TABLE_NAME='customer_order_charges' AND TG_OP='UPDATE'
       AND OLD.voucher_id IS NULL AND NEW.voucher_id IS NOT NULL
       AND NEW.id=OLD.id AND NEW.order_id=OLD.order_id
       AND NEW.name IS NOT DISTINCT FROM OLD.name
       AND NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.charge_type IS NOT DISTINCT FROM OLD.charge_type
       AND NEW.ledger_account_id IS NOT DISTINCT FROM OLD.ledger_account_id
       AND EXISTS (
         SELECT 1 FROM factory_dispatch_order_consolidations c
          WHERE c.company_id=target_company AND c.order_id=target_order
            AND c.reconciled_at IS NOT NULL AND c.status='DRAFT'
       )
       AND EXISTS (
         SELECT 1 FROM vouchers v
         JOIN customer_orders co ON co.id=NEW.order_id AND co.company_id=target_company
          WHERE v.id=NEW.voucher_id AND v.company_id=target_company
            AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE
            AND EXISTS(
              SELECT 1 FROM voucher_entries ve
               WHERE ve.voucher_id=v.id AND ve.customer_id=co.customer_id
                 AND ve.debit_amount=OLD.amount
            )
            AND EXISTS(
              SELECT 1 FROM voucher_entries ve
               WHERE ve.voucher_id=v.id AND ve.ledger_account_id=OLD.ledger_account_id
                 AND ve.credit_amount=OLD.amount
            )
       )
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This order has a signed all-truck reconciliation; change of scanned/loaded/charge evidence is forbidden';
  END IF;
  -- Also reject moving a row FROM an unsigned order INTO a signed order.
  -- Without checking NEW ownership, UPDATE order_id could evade an OLD-only
  -- guard and pollute the signed bale/scan/charge evidence.
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='factory_loading_dispatches'
       OR TG_TABLE_NAME='factory_loading_dispatch_scans'
       OR TG_TABLE_NAME='factory_loading_dispatch_closure_history' THEN
      SELECT EXISTS(
        SELECT 1 FROM factory_dispatch_order_consolidations
         WHERE company_id=NEW.company_id AND order_id=NEW.order_id
           AND reconciled_at IS NOT NULL AND status IN ('DRAFT','FINALIZED')
      ) INTO new_target_signed;
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM factory_dispatch_order_consolidations c
        JOIN customer_orders o ON o.id=NEW.order_id
         WHERE c.company_id=o.company_id AND c.order_id=NEW.order_id
           AND c.reconciled_at IS NOT NULL AND c.status IN ('DRAFT','FINALIZED')
      ) INTO new_target_signed;
    END IF;
    IF new_target_signed THEN
      RAISE EXCEPTION 'Cannot move barcode, trip or charge evidence into a signed Factory order';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_signed_trip_guard ON public.factory_loading_dispatches;
CREATE TRIGGER factory_dispatch_signed_trip_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.factory_loading_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_signed_scan_guard ON public.factory_loading_dispatch_scans;
CREATE TRIGGER factory_dispatch_signed_scan_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.factory_loading_dispatch_scans
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_signed_closure_guard ON public.factory_loading_dispatch_closure_history;
CREATE TRIGGER factory_dispatch_signed_closure_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.factory_loading_dispatch_closure_history
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_signed_order_bale_guard ON public.customer_order_bales;
CREATE TRIGGER factory_dispatch_signed_order_bale_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.customer_order_bales
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_evidence();
DROP TRIGGER IF EXISTS factory_dispatch_signed_order_charge_guard ON public.customer_order_charges;
CREATE TRIGGER factory_dispatch_signed_order_charge_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.customer_order_charges
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_evidence();

-- After signoff, do not allow a posted truck to be reversed/re-priced: its
-- posting reference is part of the immutable combined-invoice source.
-- Phase 8 may promote POSTED -> CONSOLIDATED but not alter any financial
-- evidence or amounts during that status transition.
CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_signed_financials()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  signed BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM factory_dispatch_order_consolidations
     WHERE company_id=OLD.company_id AND order_id=OLD.order_id
       AND reconciled_at IS NOT NULL AND status IN ('DRAFT','FINALIZED')
  ) INTO signed;
  IF signed THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Signed order financials cannot be removed';
    END IF;
    IF TG_OP='UPDATE' AND NEW.status='CONSOLIDATED'
       AND OLD.status='POSTED'
       AND NEW.goods_subtotal IS NOT DISTINCT FROM OLD.goods_subtotal
       AND NEW.billable_charges_total IS NOT DISTINCT FROM OLD.billable_charges_total
       AND NEW.discount_total IS NOT DISTINCT FROM OLD.discount_total
       AND NEW.customer_total IS NOT DISTINCT FROM OLD.customer_total
       AND NEW.source_fingerprint IS NOT DISTINCT FROM OLD.source_fingerprint
       AND NEW.manifest_fingerprint IS NOT DISTINCT FROM OLD.manifest_fingerprint
       AND NEW.snapshot_revision IS NOT DISTINCT FROM OLD.snapshot_revision
       AND NEW.posting_revision IS NOT DISTINCT FROM OLD.posting_revision
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Signed dispatch financial postings cannot be edited or reversed';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS factory_dispatch_signed_financial_guard ON public.factory_dispatch_trip_financials;
CREATE TRIGGER factory_dispatch_signed_financial_guard
  BEFORE UPDATE OR DELETE ON public.factory_dispatch_trip_financials
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_signed_financials();

COMMIT;

-- Future Phase 8 consolidation MUST re-evaluate the signed fingerprint under
-- the original order/trip locks and must post no duplicate receivable.

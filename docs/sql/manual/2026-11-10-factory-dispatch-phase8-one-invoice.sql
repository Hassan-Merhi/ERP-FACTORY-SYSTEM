-- Phase 8 manual TablePlus script, to run LAST after Phase 2 / 4 / 5 / 6 / 7.
-- NOT EXECUTED. This file is for the operator's final SQL handoff only.
-- Does NOT post vouchers, create invoices, alter stock, or transfer ERP data.
BEGIN;
DO $phase8_preflight$
BEGIN
  IF to_regclass('public.factory_dispatch_order_consolidations') IS NULL THEN
    RAISE EXCEPTION 'Install Phase 2 financial/consolidation and Phase 7 signoff SQL first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='factory_dispatch_order_consolidations'
       AND column_name='reconciliation_snapshot'
  ) THEN
    RAISE EXCEPTION 'Install the signed Phase 7 reconciliation_snapshot columns first';
  END IF;
END $phase8_preflight$;

ALTER TABLE public.factory_dispatch_order_consolidations
  ADD COLUMN IF NOT EXISTS finalization_details JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $phase8_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='factory_dispatch_order_consolidations_final_invoice_ck'
       AND conrelid='public.factory_dispatch_order_consolidations'::regclass
  ) THEN
    ALTER TABLE public.factory_dispatch_order_consolidations
      ADD CONSTRAINT factory_dispatch_order_consolidations_final_invoice_ck
      CHECK (
        status <> 'FINALIZED' OR
        (reconciled_at IS NOT NULL AND finalized_at IS NOT NULL
         AND finalized_by_user_id IS NOT NULL
         AND invoice_number IS NOT NULL AND length(trim(invoice_number))>0
         AND COALESCE(finalization_details->>'invoiceNumber'=invoice_number,FALSE)
         AND COALESCE(finalization_details->>'customerReceivableReposted'='false',FALSE)
         AND COALESCE(jsonb_typeof(finalization_details->'voucherIds')='array',FALSE)
         AND COALESCE(jsonb_typeof(finalization_details->'includedPostingIds')='array',FALSE))
      );
  END IF;
END $phase8_checks$;

-- A combined invoice may be finalized once and only once; future attempts
-- replay the immutable final document/receipt, not repeat accounting writes.
CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_final_invoice()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='FINALIZED' THEN
      RAISE EXCEPTION 'Finalized Factory dispatch combined invoice is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='FINALIZED' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Finalized Factory dispatch combined invoice cannot be modified or reversed by legacy workflows';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='FINALIZED' THEN
    IF OLD.status<>'DRAFT' OR OLD.reconciled_at IS NULL
       OR OLD.invoice_number IS NOT NULL OR OLD.finalized_at IS NOT NULL
       OR NEW.invoice_number IS NULL OR NEW.finalized_at IS NULL
       OR NEW.finalized_by_user_id IS NULL
    THEN
      RAISE EXCEPTION 'Combined invoice requires one signed DRAFT -> FINALIZED transition';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_final_invoice_guard
  ON public.factory_dispatch_order_consolidations;
CREATE TRIGGER factory_dispatch_final_invoice_guard
  BEFORE UPDATE OR DELETE ON public.factory_dispatch_order_consolidations
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_invoice();

CREATE UNIQUE INDEX IF NOT EXISTS factory_dispatch_final_invoice_number_uq
  ON public.factory_dispatch_order_consolidations (company_id,invoice_number)
  WHERE invoice_number IS NOT NULL;

-- A signed final invoice has its own new clearing / COGS / original-charge
-- voucher IDs. Unlike original FDTR truck vouchers (covered by Phase 4),
-- these are only referenced by finalization_details and MUST also be locked.
-- Otherwise a generic voucher editor could rewrite sales after the customer
-- invoice is final without changing the immutable invoice receipt.
CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_final_vouchers()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  protected_old INTEGER;
  protected_new INTEGER;
  old_company INTEGER;
  new_company INTEGER;
BEGIN
  IF TG_TABLE_NAME='voucher_entries' THEN
    IF TG_OP<>'INSERT' THEN protected_old:=OLD.voucher_id; END IF;
    IF TG_OP<>'DELETE' THEN protected_new:=NEW.voucher_id; END IF;
  ELSIF TG_TABLE_NAME='accounting_posting_requests' THEN
    IF TG_OP<>'INSERT' THEN protected_old:=OLD.voucher_id; END IF;
    IF TG_OP<>'DELETE' THEN protected_new:=NEW.voucher_id; END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN protected_old:=OLD.id; END IF;
    IF TG_OP<>'DELETE' THEN protected_new:=NEW.id; END IF;
  END IF;

  IF protected_old IS NOT NULL THEN
    SELECT company_id INTO old_company FROM vouchers WHERE id=protected_old;
    IF old_company IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.factory_dispatch_order_consolidations c
       WHERE c.company_id=old_company AND c.status='FINALIZED'
         AND c.finalization_details->'voucherIds' @> jsonb_build_array(protected_old)
    ) THEN
      RAISE EXCEPTION 'Finalized Factory combined-invoice source voucher is immutable';
    END IF;
  END IF;
  -- Also reject inserting/moving entries into a protected voucher.
  IF protected_new IS NOT NULL AND protected_new IS DISTINCT FROM protected_old THEN
    SELECT company_id INTO new_company FROM vouchers WHERE id=protected_new;
    IF new_company IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.factory_dispatch_order_consolidations c
       WHERE c.company_id=new_company AND c.status='FINALIZED'
         AND c.finalization_details->'voucherIds' @> jsonb_build_array(protected_new)
    ) THEN
      RAISE EXCEPTION 'Cannot insert entries into an immutable Factory combined-invoice voucher';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_final_voucher_guard ON public.vouchers;
CREATE TRIGGER factory_dispatch_final_voucher_guard
  BEFORE UPDATE OR DELETE ON public.vouchers
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_vouchers();

DROP TRIGGER IF EXISTS factory_dispatch_final_voucher_entries_guard ON public.voucher_entries;
CREATE TRIGGER factory_dispatch_final_voucher_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.voucher_entries
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_vouchers();

DROP TRIGGER IF EXISTS factory_dispatch_final_posting_identity_guard ON public.accounting_posting_requests;
CREATE TRIGGER factory_dispatch_final_posting_identity_guard
  BEFORE UPDATE OR DELETE ON public.accounting_posting_requests
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_vouchers();

-- A finalized invoice is not just a consolidation row: the original order
-- number/totals, its commercial lines and the exact SOLD bale valuation are
-- also immutable historical evidence. Generic pre-existing editors must not
-- change these after a combined invoice has already been finalized.

CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_final_order_source()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.factory_dispatch_order_consolidations c
     WHERE c.company_id=OLD.company_id AND c.order_id=OLD.id
       AND c.status='FINALIZED'
  ) THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Finalized Factory dispatch customer order cannot be deleted';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.subtotal_bales IS DISTINCT FROM OLD.subtotal_bales
       OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
       OR NEW.freight_amount IS DISTINCT FROM OLD.freight_amount
       OR NEW.other_charges_total IS DISTINCT FROM OLD.other_charges_total
       OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
       OR NEW.order_date IS DISTINCT FROM OLD.order_date
       OR NEW.total_qty_bales IS DISTINCT FROM OLD.total_qty_bales
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    THEN
      RAISE EXCEPTION 'Finalized Factory dispatch invoice identity and totals are immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_final_order_source_guard ON public.customer_orders;
CREATE TRIGGER factory_dispatch_final_order_source_guard
  BEFORE UPDATE OR DELETE ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_order_source();

CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_final_commercial_lines()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  target_order INTEGER;
BEGIN
  IF TG_OP<>'INSERT' THEN
    target_order := OLD.order_id;
    IF EXISTS(
      SELECT 1 FROM public.factory_dispatch_order_consolidations c
       WHERE c.order_id=target_order AND c.status='FINALIZED'
    ) THEN
      RAISE EXCEPTION 'Finalized Factory dispatch commercial invoice lines are immutable';
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    target_order := NEW.order_id;
    IF EXISTS(
      SELECT 1 FROM public.factory_dispatch_order_consolidations c
       WHERE c.order_id=target_order AND c.status='FINALIZED'
    ) THEN
      RAISE EXCEPTION 'Cannot insert or move lines into a finalized Factory dispatch invoice';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_final_commercial_lines_guard ON public.customer_order_lines;
CREATE TRIGGER factory_dispatch_final_commercial_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.customer_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_commercial_lines();

CREATE OR REPLACE FUNCTION public.factory_dispatch_guard_final_sold_bales()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  finalized BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1
      FROM public.factory_dispatch_trip_financial_bales b
      JOIN public.factory_dispatch_trip_financials f
        ON f.id=b.financial_id AND f.company_id=b.company_id
       AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
      JOIN public.factory_dispatch_order_consolidations c
        ON c.company_id=f.company_id AND c.order_id=f.order_id
     WHERE b.company_id=OLD.company_id AND b.bale_id=OLD.id
       AND b.snapshot_revision=f.snapshot_revision
       AND f.status='CONSOLIDATED' AND c.status='FINALIZED'
  ) INTO finalized;
  IF finalized THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Bale belonging to a finalized combined dispatch invoice cannot be deleted';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.reference_number IS DISTINCT FROM OLD.reference_number
       OR NEW.article_code IS DISTINCT FROM OLD.article_code
       OR NEW.product_name IS DISTINCT FROM OLD.product_name
       OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
       OR NEW.total_cost IS DISTINCT FROM OLD.total_cost
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    THEN
      RAISE EXCEPTION 'Finalized Factory dispatch SOLD bale identity, status and cost are immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS factory_dispatch_final_sold_bales_guard ON public.factory_bales;
CREATE TRIGGER factory_dispatch_final_sold_bales_guard
  BEFORE UPDATE OR DELETE ON public.factory_bales
  FOR EACH ROW EXECUTE FUNCTION public.factory_dispatch_guard_final_sold_bales();

COMMIT;

-- After applying, verify:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='factory_dispatch_order_consolidations'
-- AND column_name IN ('reconciliation_snapshot','finalization_details');
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname='public' AND tablename='factory_dispatch_order_consolidations';
--
-- NEVER create new customer_balances SALE cache row for a combined invoice.
-- Do not use legacy /customer-orders/:id/finalize for dispatch-managed orders.

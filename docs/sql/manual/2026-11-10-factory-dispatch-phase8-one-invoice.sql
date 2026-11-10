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

-- Phase 6: Normal ERP receipt identity and duplicate supplier-charge prevention.
-- NOT EXECUTED. Operator will run via TablePlus at the final handoff.
-- Prerequisite: existing ERP schema + company_scope RLS migration 0016.
BEGIN;
DO $ready$
BEGIN
  IF to_regprocedure('public.erp_company_scope_matches(integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply the existing fail-closed company-scope RLS migration before Phase 6.';
  END IF;
END $ready$;

-- This table is only a durable record of the operator-driven Normal ERP
-- PO Import. It is NOT an intercompany transfer, Factory receivable posting,
-- or proof of an automatic supplier payment.
CREATE TABLE IF NOT EXISTS public.factory_dispatch_erp_po_receipts (
  id BIGSERIAL PRIMARY KEY,
  erp_company_id INTEGER NOT NULL,
  factory_company_id INTEGER NOT NULL,
  factory_order_id INTEGER NOT NULL,
  factory_dispatch_id BIGINT NOT NULL,
  po_number VARCHAR(100) NOT NULL,
  container_number VARCHAR(100) NOT NULL,
  supplier_id INTEGER NOT NULL,
  supplier_code VARCHAR(50) NOT NULL,
  file_hash VARCHAR(64) NOT NULL,
  payload_fingerprint VARCHAR(64) NOT NULL,
  invoice_total NUMERIC(20,2) NOT NULL,
  file_name TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
  container_id INTEGER,
  import_log_id INTEGER,
  created_by_user_id TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_at TIMESTAMPTZ,
  CONSTRAINT fd_erp_po_receipt_status_ck
    CHECK(status IN ('PENDING_REVIEW','IMPORTED')),
  CONSTRAINT fd_erp_po_receipt_amount_ck CHECK(invoice_total > 0),
  CONSTRAINT fd_erp_po_receipt_company_ck
    CHECK(erp_company_id > 0 AND factory_company_id > 0
      AND factory_order_id > 0 AND factory_dispatch_id > 0),
  CONSTRAINT fd_erp_po_receipt_complete_ck
    CHECK (
      (status = 'PENDING_REVIEW' AND container_id IS NULL AND import_log_id IS NULL AND imported_at IS NULL)
      OR (status = 'IMPORTED' AND container_id IS NOT NULL AND import_log_id IS NOT NULL AND imported_at IS NOT NULL)
    ),
  CONSTRAINT fd_erp_po_receipt_fingerprint_ck
    CHECK (length(payload_fingerprint)=64),
  CONSTRAINT fd_erp_po_receipt_canonical_ck
    CHECK (
      container_number = 'FD-'||factory_company_id::text||'-'||factory_order_id::text||'-'||factory_dispatch_id::text
      AND po_number = 'FDPO-'||factory_company_id::text||'-'||factory_order_id::text||'-'||factory_dispatch_id::text
    )
);

-- Global source uniqueness (not only file hash, name, or ERP container).
-- This intentionally blocks importing one Factory truck to TWO ERP companies.
CREATE UNIQUE INDEX IF NOT EXISTS factory_dispatch_erp_po_receipts_origin_uq
  ON public.factory_dispatch_erp_po_receipts
    (factory_company_id,factory_order_id,factory_dispatch_id);
CREATE UNIQUE INDEX IF NOT EXISTS factory_dispatch_erp_po_receipts_container_uq
  ON public.factory_dispatch_erp_po_receipts (container_number);
CREATE UNIQUE INDEX IF NOT EXISTS factory_dispatch_erp_po_receipts_completed_container_uq
  ON public.factory_dispatch_erp_po_receipts (erp_company_id,container_id)
  WHERE container_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS factory_dispatch_erp_po_receipts_company_idx
  ON public.factory_dispatch_erp_po_receipts
    (erp_company_id,status,reserved_at DESC);

ALTER TABLE public.factory_dispatch_erp_po_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_dispatch_erp_po_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS factory_dispatch_erp_po_receipts_scope ON public.factory_dispatch_erp_po_receipts;
CREATE POLICY factory_dispatch_erp_po_receipts_scope
  ON public.factory_dispatch_erp_po_receipts
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (erp_company_scope_matches(erp_company_id))
  WITH CHECK (erp_company_scope_matches(erp_company_id));

-- Once a Factory origin is reserved, it must never be silently changed to
-- a different trip, supplier, invoice amount or company. Allow exactly one
-- PENDING_REVIEW -> IMPORTED completion; a failed posting needs independent
-- reconciliation rather than direct legacy retry.
CREATE OR REPLACE FUNCTION public.guard_factory_dispatch_erp_po_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Factory dispatch ERP receipts cannot be deleted; reconcile the original PO/vouchers';
  END IF;
  IF NEW.erp_company_id IS DISTINCT FROM OLD.erp_company_id
    OR NEW.factory_company_id IS DISTINCT FROM OLD.factory_company_id
    OR NEW.factory_order_id IS DISTINCT FROM OLD.factory_order_id
    OR NEW.factory_dispatch_id IS DISTINCT FROM OLD.factory_dispatch_id
    OR NEW.po_number IS DISTINCT FROM OLD.po_number
    OR NEW.container_number IS DISTINCT FROM OLD.container_number
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.supplier_code IS DISTINCT FROM OLD.supplier_code
    OR NEW.file_hash IS DISTINCT FROM OLD.file_hash
    OR NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
    OR NEW.invoice_total IS DISTINCT FROM OLD.invoice_total
    OR NEW.file_name IS DISTINCT FROM OLD.file_name
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
  THEN
    RAISE EXCEPTION 'Cannot mutate Factory dispatch ERP import provenance';
  END IF;
  IF NOT (
    OLD.status = 'PENDING_REVIEW' AND NEW.status = 'IMPORTED'
    AND OLD.imported_at IS NULL AND NEW.imported_at IS NOT NULL
    AND NEW.container_id IS NOT NULL AND NEW.import_log_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Only completion of a pending Factory dispatch ERP import is permitted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_erp_po_receipt_guard ON public.factory_dispatch_erp_po_receipts;
CREATE TRIGGER factory_dispatch_erp_po_receipt_guard
  BEFORE UPDATE OR DELETE ON public.factory_dispatch_erp_po_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_factory_dispatch_erp_po_receipt();

COMMIT;

-- No SQL is executed automatically by the application.
-- If an import fails after reserving the origin, inspect the ERP container,
-- PO, voucher and import log and follow an approved manual recovery. DO NOT
-- delete the receipt or run a second supplier import to fix a partial failure.

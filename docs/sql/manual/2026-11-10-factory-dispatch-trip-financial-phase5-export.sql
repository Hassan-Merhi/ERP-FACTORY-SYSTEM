-- Phase 5: manual-only ERP PO export identity and duplicate guard.
-- NOT EXECUTED. To be delivered with Phase 2 + Phase 4 SQL at the very end.
-- Must run after: 2026-11-10-factory-dispatch-trip-financial-phase2.sql
-- and 2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql.
-- This file does not create ERP purchase orders, import documents, vouchers
-- or supplier balances. It only constrains Factory file-generation history.
BEGIN;
DO $ensure_export_ready$
BEGIN
  IF to_regclass('public.factory_dispatch_trip_exports') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 Factory trip financial tables must be installed before Phase 5';
  END IF;
  IF EXISTS(
    SELECT 1 FROM factory_dispatch_trip_exports
     GROUP BY financial_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Existing duplicate ERP PO export records need a manual reconciliation before installing one-file-per-trip protection';
  END IF;
END $ensure_export_ready$;

-- Each physical trip can generate one canonical PO document identity. Repeated
-- identical downloads reuse the same row. A changed supplier, cost or charge
-- cannot create another importable PO for the same trip.
CREATE UNIQUE INDEX IF NOT EXISTS factory_dispatch_trip_exports_financial_once_uq
  ON public.factory_dispatch_trip_exports (financial_id);

-- Re-export is bounded by company, original loading, and immutable financial
-- evidence, and never marks an ERP import as completed.
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_exports_source_lookup_idx
  ON public.factory_dispatch_trip_exports (company_id,order_id,dispatch_id,source_fingerprint);

COMMIT;

-- FACTORY DISPATCH — ONE FINAL MANUAL TABLEPLUS SCRIPT
-- Date 2026-11-10 | Feature branch: feature/factory-dispatch-trip-accounting-20261110
-- Phases 2 -> 4 -> 5 -> 6 -> 7 -> 8, including Phase 10 safeguards.
-- SOURCE ONLY: NOT RUN, NOT TESTED, NOT DEPLOYED.
--
-- OPERATOR MUST CONFIRM database connection/company, RLS prerequisites,
-- migration history and VERIFIED BACKUP before running in TablePlus.
-- The established erp_company_scope_matches(integer) RLS function is required.
-- STOP at the first error. Do NOT continue or retry blindly.
-- This script does not bill customers, post vouchers, import ERP POs or move stock.
-- Each section has a separate BEGIN / COMMIT block.
--
-- ===========================================================================
-- SECTION 1 OF 6: 2026-11-10-factory-dispatch-trip-financial-phase2.sql
-- ===========================================================================
-- PHASE 2: MANUAL TABLEPLUS INSTALLATION FILE (NOT RUN).
-- Retain with the other phases and hand to the user at the END of the program.
-- Prerequisite: existing Factory dispatch Phase 1-7 tables are already installed.
-- No vouchers, customer balances, stock, or existing order data are modified.
-- Review company/tenant RLS policies before production use.
BEGIN;

DO $precheck$
BEGIN
  IF to_regclass('public.factory_loading_dispatches') IS NULL
     OR to_regclass('public.factory_loading_dispatch_scans') IS NULL
     OR to_regclass('public.factory_loading_dispatch_closure_history') IS NULL THEN
    RAISE EXCEPTION 'Factory Dispatch Phase 1-7 must be installed before Phase 2';
  END IF;
END;
$precheck$;

-- Existing physical evidence has a globally unique primary id, but its
-- company/order/trip scope must also be verifiable by a composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS factory_loading_dispatch_closure_financial_scope_uq
  ON factory_loading_dispatch_closure_history (id, company_id, order_id, dispatch_id);
CREATE UNIQUE INDEX IF NOT EXISTS factory_loading_dispatch_scan_financial_scope_uq
  ON factory_loading_dispatch_scans (id, company_id, order_id, dispatch_id, bale_id);

CREATE TABLE IF NOT EXISTS factory_dispatch_trip_financials (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT NOT NULL,
  closure_history_id BIGINT,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  snapshot_revision INTEGER NOT NULL DEFAULT 0,
  posting_revision INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  fx_rate NUMERIC(20,8),
  valuation_date DATE,
  manifest_fingerprint VARCHAR(64),
  source_fingerprint VARCHAR(64),
  goods_subtotal NUMERIC(20,2) NOT NULL DEFAULT 0,
  billable_charges_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  customer_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  posted_at TIMESTAMPTZ,
  posted_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_trip_financials_trip_uq UNIQUE (company_id, order_id, dispatch_id),
  CONSTRAINT factory_dispatch_trip_financials_scope_uq UNIQUE (id, company_id, order_id, dispatch_id),
  CONSTRAINT factory_dispatch_trip_financials_status_ck CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED', 'CONSOLIDATED')),
  CONSTRAINT factory_dispatch_trip_financials_revision_ck CHECK (snapshot_revision >= 0 AND posting_revision >= 0),
  CONSTRAINT factory_dispatch_trip_financials_totals_ck CHECK (
    goods_subtotal >= 0 AND billable_charges_total >= 0 AND discount_total >= 0 AND customer_total >= 0
  ),
  CONSTRAINT factory_dispatch_trip_financials_posted_source_ck CHECK (
    status IN ('DRAFT', 'REVERSED') OR (
      closure_history_id IS NOT NULL AND snapshot_revision > 0 AND posting_revision > 0
      AND source_fingerprint IS NOT NULL AND manifest_fingerprint IS NOT NULL AND posted_at IS NOT NULL
    )
  ),
  CONSTRAINT factory_dispatch_trip_financials_total_math_ck CHECK (
    customer_total = goods_subtotal + billable_charges_total - discount_total
  ),
  CONSTRAINT factory_dispatch_trip_financials_dispatch_fk FOREIGN KEY (dispatch_id, company_id, order_id)
    REFERENCES factory_loading_dispatches (id, company_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_financials_closure_fk FOREIGN KEY (closure_history_id, company_id, order_id, dispatch_id)
    REFERENCES factory_loading_dispatch_closure_history (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_financials_order_idx
  ON factory_dispatch_trip_financials (company_id, order_id, status);

CREATE TABLE IF NOT EXISTS factory_dispatch_trip_financial_bales (
  id BIGSERIAL PRIMARY KEY,
  financial_id BIGINT NOT NULL,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT NOT NULL,
  closure_history_id BIGINT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  source_scan_id BIGINT NOT NULL,
  bale_id INTEGER NOT NULL,
  bale_reference TEXT NOT NULL,
  article_code VARCHAR(50) NOT NULL,
  product_name TEXT NOT NULL,
  weight_kg NUMERIC(18,3) NOT NULL,
  price_source VARCHAR(40) NOT NULL,
  pricing_mode VARCHAR(20) NOT NULL DEFAULT 'per_bale',
  unit_price NUMERIC(20,6) NOT NULL,
  line_total NUMERIC(20,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_trip_financial_bales_bale_uq UNIQUE (financial_id, snapshot_revision, bale_id),
  CONSTRAINT factory_dispatch_trip_financial_bales_scan_uq UNIQUE (financial_id, snapshot_revision, source_scan_id),
  CONSTRAINT factory_dispatch_trip_financial_bales_revision_ck CHECK (snapshot_revision > 0),
  CONSTRAINT factory_dispatch_trip_financial_bales_amounts_ck CHECK (weight_kg >= 0 AND unit_price >= 0 AND line_total >= 0),
  CONSTRAINT factory_dispatch_trip_financial_bales_financial_fk
    FOREIGN KEY (financial_id, company_id, order_id, dispatch_id)
    REFERENCES factory_dispatch_trip_financials (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_financial_bales_closure_fk
    FOREIGN KEY (closure_history_id, company_id, order_id, dispatch_id)
    REFERENCES factory_loading_dispatch_closure_history (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_financial_bales_scan_fk
    FOREIGN KEY (source_scan_id, company_id, order_id, dispatch_id, bale_id)
    REFERENCES factory_loading_dispatch_scans (id, company_id, order_id, dispatch_id, bale_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_financial_bales_order_idx
  ON factory_dispatch_trip_financial_bales (company_id, order_id, dispatch_id);

CREATE TABLE IF NOT EXISTS factory_dispatch_trip_charges (
  id BIGSERIAL PRIMARY KEY,
  financial_id BIGINT NOT NULL,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  ledger_account_id INTEGER NOT NULL,
  offset_ledger_account_id INTEGER,
  erp_charge_type VARCHAR(32),
  notes TEXT,
  posted_voucher_id INTEGER,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_trip_charges_kind_ck CHECK (kind IN ('BILLABLE', 'INTERNAL', 'DISCOUNT')),
  CONSTRAINT factory_dispatch_trip_charges_revision_ck CHECK (revision > 0),
  CONSTRAINT factory_dispatch_trip_charges_amount_ck CHECK (amount >= 0),
  CONSTRAINT factory_dispatch_trip_charges_financial_fk
    FOREIGN KEY (financial_id, company_id, order_id, dispatch_id)
    REFERENCES factory_dispatch_trip_financials (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_charges_ledger_fk FOREIGN KEY (ledger_account_id)
    REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_charges_offset_fk FOREIGN KEY (offset_ledger_account_id)
    REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_charges_voucher_fk FOREIGN KEY (posted_voucher_id)
    REFERENCES vouchers (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_charges_trip_idx
  ON factory_dispatch_trip_charges (company_id, order_id, dispatch_id);

CREATE TABLE IF NOT EXISTS factory_dispatch_trip_postings (
  id BIGSERIAL PRIMARY KEY,
  financial_id BIGINT NOT NULL,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT NOT NULL,
  posting_revision INTEGER NOT NULL,
  kind VARCHAR(16) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  voucher_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reverses_posting_id BIGINT,
  reason TEXT,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_by_user_id TEXT NOT NULL,
  CONSTRAINT factory_dispatch_trip_postings_revision_uq UNIQUE (financial_id, posting_revision, kind),
  CONSTRAINT factory_dispatch_trip_postings_idempotency_uq UNIQUE (company_id, idempotency_key),
  CONSTRAINT factory_dispatch_trip_postings_kind_ck CHECK (kind IN ('POST', 'REVERSAL', 'ADJUSTMENT')),
  CONSTRAINT factory_dispatch_trip_postings_amount_ck CHECK (amount >= 0 AND posting_revision > 0),
  CONSTRAINT factory_dispatch_trip_postings_vouchers_ck CHECK (jsonb_typeof(voucher_ids) = 'array'),
  CONSTRAINT factory_dispatch_trip_postings_financial_fk
    FOREIGN KEY (financial_id, company_id, order_id, dispatch_id)
    REFERENCES factory_dispatch_trip_financials (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_trip_postings_reverse_fk FOREIGN KEY (reverses_posting_id)
    REFERENCES factory_dispatch_trip_postings (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_postings_trip_idx
  ON factory_dispatch_trip_postings (company_id, order_id, dispatch_id);

CREATE TABLE IF NOT EXISTS factory_dispatch_trip_exports (
  id BIGSERIAL PRIMARY KEY,
  financial_id BIGINT NOT NULL,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  export_fingerprint VARCHAR(64) NOT NULL,
  target_erp_company_id INTEGER,
  supplier_code VARCHAR(100) NOT NULL,
  po_number VARCHAR(100) NOT NULL,
  erp_container_number VARCHAR(100) NOT NULL,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  exported_by_user_id TEXT NOT NULL,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_trip_exports_content_uq UNIQUE (financial_id, export_fingerprint),
  CONSTRAINT factory_dispatch_trip_exports_container_uq UNIQUE (company_id, erp_container_number),
  CONSTRAINT factory_dispatch_trip_exports_revision_ck CHECK (snapshot_revision > 0),
  CONSTRAINT factory_dispatch_trip_exports_financial_fk
    FOREIGN KEY (financial_id, company_id, order_id, dispatch_id)
    REFERENCES factory_dispatch_trip_financials (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_trip_exports_order_idx
  ON factory_dispatch_trip_exports (company_id, order_id);

CREATE TABLE IF NOT EXISTS factory_dispatch_order_consolidations (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  reconciliation_fingerprint VARCHAR(64),
  invoice_number VARCHAR(50),
  included_posting_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  goods_subtotal NUMERIC(20,2) NOT NULL DEFAULT 0,
  billable_charges_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  customer_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  finalized_at TIMESTAMPTZ,
  finalized_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_order_consolidations_order_uq UNIQUE (company_id, order_id),
  CONSTRAINT factory_dispatch_order_consolidations_status_ck CHECK (status IN ('DRAFT', 'FINALIZED', 'REVERSED')),
  CONSTRAINT factory_dispatch_order_consolidations_totals_ck CHECK (
    goods_subtotal >= 0 AND billable_charges_total >= 0 AND discount_total >= 0 AND customer_total >= 0
  ),
  CONSTRAINT factory_dispatch_order_consolidations_postings_ck CHECK (jsonb_typeof(included_posting_ids) = 'array'),
  CONSTRAINT factory_dispatch_order_consolidations_total_math_ck CHECK (
    customer_total = goods_subtotal + billable_charges_total - discount_total
  ),
  CONSTRAINT factory_dispatch_order_consolidations_order_fk FOREIGN KEY (order_id, company_id)
    REFERENCES customer_orders (id, company_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS factory_dispatch_financial_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  dispatch_id BIGINT,
  financial_id BIGINT,
  event_type VARCHAR(64) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT,
  actor_user_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_dispatch_financial_events_order_fk FOREIGN KEY (order_id, company_id)
    REFERENCES customer_orders (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_financial_events_dispatch_fk FOREIGN KEY (dispatch_id, company_id, order_id)
    REFERENCES factory_loading_dispatches (id, company_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT factory_dispatch_financial_events_financial_fk
    FOREIGN KEY (financial_id, company_id, order_id, dispatch_id)
    REFERENCES factory_dispatch_trip_financials (id, company_id, order_id, dispatch_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS factory_dispatch_financial_events_order_idx
  ON factory_dispatch_financial_events (company_id, order_id, id);
CREATE INDEX IF NOT EXISTS factory_dispatch_financial_events_trip_idx
  ON factory_dispatch_financial_events (company_id, dispatch_id, id);

-- Do not permit edits to historical monetary evidence or claim that a downloaded
-- file was received by ERP. Earlier revisions remain auditable after reversal.
CREATE OR REPLACE FUNCTION factory_dispatch_financial_prevent_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Factory dispatch financial historical rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_financial_bales_immutable ON factory_dispatch_trip_financial_bales;
CREATE TRIGGER factory_dispatch_financial_bales_immutable
  BEFORE UPDATE OR DELETE ON factory_dispatch_trip_financial_bales
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_financial_prevent_history_mutation();

DROP TRIGGER IF EXISTS factory_dispatch_postings_immutable ON factory_dispatch_trip_postings;
CREATE TRIGGER factory_dispatch_postings_immutable
  BEFORE UPDATE OR DELETE ON factory_dispatch_trip_postings
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_financial_prevent_history_mutation();

DROP TRIGGER IF EXISTS factory_dispatch_exports_immutable ON factory_dispatch_trip_exports;
CREATE TRIGGER factory_dispatch_exports_immutable
  BEFORE UPDATE OR DELETE ON factory_dispatch_trip_exports
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_financial_prevent_history_mutation();

DROP TRIGGER IF EXISTS factory_dispatch_events_immutable ON factory_dispatch_financial_events;
CREATE TRIGGER factory_dispatch_events_immutable
  BEFORE UPDATE OR DELETE ON factory_dispatch_financial_events
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_financial_prevent_history_mutation();

-- Draft charges can be edited; once frozen, historical charge values are
-- immutable even if the trip is reversed. New revisions get fresh charge rows.
CREATE OR REPLACE FUNCTION factory_dispatch_financial_guard_charge_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_id BIGINT;
  parent_status VARCHAR(16);
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.financial_id;
  ELSE
    parent_id := NEW.financial_id;
  END IF;

  SELECT status INTO parent_status
    FROM factory_dispatch_trip_financials WHERE id = parent_id FOR UPDATE;

  IF parent_status IS NULL OR parent_status NOT IN ('DRAFT', 'REVERSED') THEN
    RAISE EXCEPTION 'Only draft/reversed trip charges can be modified';
  END IF;

  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A previously posted trip charge cannot be changed';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.financial_id <> OLD.financial_id OR NEW.company_id <> OLD.company_id OR
       NEW.order_id <> OLD.order_id OR NEW.dispatch_id <> OLD.dispatch_id OR
       NEW.revision <> OLD.revision THEN
      RAISE EXCEPTION 'Trip charge ownership and revision cannot be changed';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factory_dispatch_charge_draft_guard ON factory_dispatch_trip_charges;
CREATE TRIGGER factory_dispatch_charge_draft_guard
  BEFORE INSERT OR UPDATE OR DELETE ON factory_dispatch_trip_charges
  FOR EACH ROW EXECUTE FUNCTION factory_dispatch_financial_guard_charge_mutation();

COMMIT;

-- IMPORTANT: no Phase 2 INSERT/UPDATE touches accounting or existing dispatches.
-- Phase 3/4 must add locked financial writers and status/amount guards.
-- Do not execute this file until the owner requests the final TablePlus bundle.


-- ===========================================================================
-- SECTION 2 OF 6: 2026-11-10-factory-dispatch-trip-financial-phase4-guards.sql
-- ===========================================================================
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


-- ===========================================================================
-- SECTION 3 OF 6: 2026-11-10-factory-dispatch-trip-financial-phase5-export.sql
-- ===========================================================================
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


-- ===========================================================================
-- SECTION 4 OF 6: 2026-11-10-factory-dispatch-erp-po-phase6-receipts.sql
-- ===========================================================================
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


-- ===========================================================================
-- SECTION 5 OF 6: 2026-11-10-factory-dispatch-phase7-order-reconciliation.sql
-- ===========================================================================
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


-- ===========================================================================
-- SECTION 6 OF 6: 2026-11-10-factory-dispatch-phase8-one-invoice.sql
-- ===========================================================================
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

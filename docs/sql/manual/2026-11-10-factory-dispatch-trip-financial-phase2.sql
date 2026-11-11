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

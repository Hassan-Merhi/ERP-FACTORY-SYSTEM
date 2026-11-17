-- Phase 3: linked PO editing, immutable edit revisions, and shared-charge invoice allocations.
-- Adds no new cash entries, does not edit historical vouchers, and preserves the original invoice face amount.
CREATE TABLE IF NOT EXISTS intercompany_trade_line_links (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_line_id INTEGER NOT NULL UNIQUE REFERENCES po_line_items(id) ON DELETE RESTRICT,
  destination_line_id INTEGER NOT NULL UNIQUE REFERENCES po_line_items(id) ON DELETE RESTRICT,
  original_excel_row INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_trade_line_excel_row_unique UNIQUE(trade_id, original_excel_row),
  CONSTRAINT ic_trade_line_not_same CHECK(source_line_id <> destination_line_id)
);
CREATE INDEX IF NOT EXISTS ic_trade_line_trade_idx ON intercompany_trade_line_links(trade_id);

CREATE TABLE IF NOT EXISTS intercompany_trade_revisions (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  kind VARCHAR(40) NOT NULL,
  request_key VARCHAR(160) NOT NULL UNIQUE,
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiating_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  state VARCHAR(20) NOT NULL DEFAULT 'posting',
  amount_before NUMERIC(20,2) NOT NULL,
  amount_after NUMERIC(20,2) NOT NULL,
  posting_date DATE NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  posted_voucher_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ic_trade_revision_version_positive CHECK(revision_number > 1),
  CONSTRAINT ic_trade_revision_kind CHECK(kind IN ('line_edit','shared_invoice_confirm','shared_invoice_reallocate')),
  CONSTRAINT ic_trade_revision_state CHECK(state IN ('posting','completed')),
  CONSTRAINT ic_trade_revision_amounts CHECK(amount_before > 0 AND amount_after > 0),
  CONSTRAINT ic_trade_revision_completion CHECK(state <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT ic_trade_revision_number_unique UNIQUE(trade_id, revision_number)
);
CREATE INDEX IF NOT EXISTS ic_trade_revision_trade_idx ON intercompany_trade_revisions(trade_id, created_at);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_invoices (
  id BIGSERIAL PRIMARY KEY,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  external_invoice_key VARCHAR(120) NOT NULL,
  charge_type VARCHAR(32) NOT NULL,
  face_amount NUMERIC(20,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  evidence_reference TEXT NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_by VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT ic_invoice_unique_source_key UNIQUE(source_company_id, external_invoice_key),
  CONSTRAINT ic_invoice_amount_positive CHECK(face_amount > 0),
  CONSTRAINT ic_invoice_only_usd CHECK(currency = 'USD'),
  CONSTRAINT ic_invoice_type CHECK(charge_type IN ('freight','surcharge','fumigation','documentCharges','otherCharges')),
  CONSTRAINT ic_invoice_state CHECK(state IN ('draft','confirmed')),
  CONSTRAINT ic_invoice_version CHECK(version > 0),
  CONSTRAINT ic_invoice_evidence CHECK(length(btrim(evidence_reference)) >= 3),
  CONSTRAINT ic_invoice_confirm_date CHECK(state <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ic_shared_invoice_source_idx ON intercompany_shared_charge_invoices(source_company_id, created_at);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_allocations (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES intercompany_shared_charge_invoices(id) ON DELETE RESTRICT,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  amount NUMERIC(20,2) NOT NULL,
  container_charge_id INTEGER REFERENCES container_charges(id) ON DELETE RESTRICT,
  CONSTRAINT ic_charge_trade_unique UNIQUE(invoice_id, trade_id),
  CONSTRAINT ic_charge_trade_nonnegative CHECK(amount >= 0),
  CONSTRAINT ic_charge_container_row_unique UNIQUE(container_charge_id)
);
CREATE INDEX IF NOT EXISTS ic_shared_charge_trade_idx ON intercompany_shared_charge_allocations(trade_id);

CREATE TABLE IF NOT EXISTS intercompany_shared_charge_po_allocations (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES intercompany_shared_charge_invoices(id) ON DELETE RESTRICT,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  amount NUMERIC(20,2) NOT NULL,
  CONSTRAINT ic_charge_po_unique UNIQUE(invoice_id, source_po_id),
  CONSTRAINT ic_charge_po_nonnegative CHECK(amount >= 0)
);
CREATE INDEX IF NOT EXISTS ic_shared_charge_po_trade_idx ON intercompany_shared_charge_po_allocations(trade_id);

ALTER TABLE intercompany_permission_grants
  DROP CONSTRAINT IF EXISTS intercompany_grant_scope,
  DROP CONSTRAINT IF EXISTS intercompany_grant_scope_target;
ALTER TABLE intercompany_permission_grants
  ADD CONSTRAINT intercompany_grant_scope CHECK(scope IN ('invoice','relationship')),
  ADD CONSTRAINT intercompany_grant_scope_target CHECK(
    (scope='invoice' AND invoice_key IS NOT NULL AND length(btrim(invoice_key))>0)
    OR (scope='relationship' AND invoice_key IS NULL)
  );

-- A live revision is a transaction-local capability, scoped to precisely one trade.
-- Existing direct editing routes have no such revision and remain blocked.
CREATE OR REPLACE FUNCTION ic_edit_scope_matches(target_trade_id INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM intercompany_trade_revisions r
    JOIN intercompany_trades t ON t.id = r.trade_id
    WHERE r.id = NULLIF(current_setting('erp.ic_edit_revision',true),'')::bigint
      AND r.trade_id = target_trade_id AND r.state = 'posting'
      AND r.revision_number = t.version + 1
  );
$fn$;

CREATE OR REPLACE FUNCTION intercompany_block_legacy_po_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE old_po_id INTEGER; protected_trade_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'po_line_items' THEN
    old_po_id := CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSE
    old_po_id := CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  END IF;
  SELECT t.id INTO protected_trade_id FROM intercompany_trades t
   WHERE t.state='active' AND (t.destination_po_id=old_po_id OR t.original_supplier_po_id=old_po_id)
   UNION
   SELECT t.id FROM intercompany_trade_source_pos l
   JOIN intercompany_trades t ON t.id=l.trade_id
   WHERE t.state='active' AND l.source_po_id=old_po_id LIMIT 1;
  IF protected_trade_id IS NOT NULL THEN
    IF TG_OP <> 'UPDATE' OR NOT ic_edit_scope_matches(protected_trade_id) THEN
      RAISE EXCEPTION 'Linked intercompany purchase orders require the Phase 3 synchronized editing workflow';
    END IF;
    IF TG_TABLE_NAME = 'po_line_items' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id OR
        (to_jsonb(NEW) - ARRAY['quantity','rate','line_total','item_name']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['quantity','rate','line_total','item_name']::text[])
      THEN
        RAISE EXCEPTION 'Only synchronized linked PO line pricing and descriptions can change';
      END IF;
    ELSE
      IF (to_jsonb(NEW) - ARRAY['items_total','freight','surcharge','fumigation','document_charges',
                                'discount','other_charges','charges_edited']::text[])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['items_total','freight','surcharge','fumigation','document_charges',
                                'discount','other_charges','charges_edited']::text[]) THEN
         RAISE EXCEPTION 'Only synchronized PO cost fields can change';
      END IF;
    END IF;
  END IF;
  -- Guard the new po_id too; moving unrelated lines INTO a linked PO is never legal.
  IF TG_TABLE_NAME='po_line_items' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id THEN
        IF EXISTS (SELECT 1 FROM intercompany_trades t WHERE t.state='active'
           AND (t.destination_po_id=NEW.po_id OR t.original_supplier_po_id=NEW.po_id))
          OR EXISTS (SELECT 1 FROM intercompany_trade_source_pos l JOIN intercompany_trades t ON t.id=l.trade_id
                     WHERE t.state='active' AND l.source_po_id=NEW.po_id) THEN
          RAISE EXCEPTION 'Cannot move PO line into a linked intercompany purchase order';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $blocked$;

CREATE OR REPLACE FUNCTION intercompany_block_legacy_charge_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE physical_id INTEGER; protected_trade_id INTEGER;
BEGIN
  physical_id := CASE WHEN TG_OP='INSERT' THEN NEW.container_id ELSE OLD.container_id END;
  SELECT id INTO protected_trade_id FROM intercompany_trades
   WHERE physical_container_id = physical_id AND state='active' LIMIT 1;
  IF protected_trade_id IS NOT NULL THEN
    IF TG_OP='DELETE' OR NOT ic_edit_scope_matches(protected_trade_id) THEN
      RAISE EXCEPTION 'Linked intercompany charges require the Phase 3 synchronized allocation workflow';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.container_id IS DISTINCT FROM OLD.container_id
          OR NEW.charge_type IS DISTINCT FROM OLD.charge_type
          OR NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id) THEN
      RAISE EXCEPTION 'Linked confirmed charge identity cannot change';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.container_id IS DISTINCT FROM OLD.container_id AND EXISTS (
    SELECT 1 FROM intercompany_trades WHERE physical_container_id=NEW.container_id AND state='active'
  ) THEN
    RAISE EXCEPTION 'Cannot move charge into a linked intercompany container';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $blocked$;

CREATE OR REPLACE FUNCTION ic_guard_container_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE protected_trade_id INTEGER;
BEGIN
  SELECT id INTO protected_trade_id FROM intercompany_trades
   WHERE physical_container_id=OLD.id AND state='active' LIMIT 1;
  IF protected_trade_id IS NOT NULL AND NOT ic_edit_scope_matches(protected_trade_id) THEN
    RAISE EXCEPTION 'Active intercompany container cost requires a synchronized revision';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS ic_container_financial_guard ON containers;
CREATE TRIGGER ic_container_financial_guard
BEFORE UPDATE OF items_total, charges_total, grand_total ON containers
FOR EACH ROW WHEN (
  NEW.items_total IS DISTINCT FROM OLD.items_total
  OR NEW.charges_total IS DISTINCT FROM OLD.charges_total
  OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
)
EXECUTE FUNCTION ic_guard_container_cost();

CREATE OR REPLACE FUNCTION ic_guard_import_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF NEW.trade_id IS DISTINCT FROM OLD.trade_id
     OR NEW.physical_container_id IS DISTINCT FROM OLD.physical_container_id
     OR NEW.destination_company_id IS DISTINCT FROM OLD.destination_company_id THEN
     RAISE EXCEPTION 'Linked import ownership and source evidence cannot change';
  END IF;
  IF (NEW.confirmed_landed_cost IS DISTINCT FROM OLD.confirmed_landed_cost
       OR NEW.charges_confirmed IS DISTINCT FROM OLD.charges_confirmed
       OR NEW.charge_evidence_reference IS DISTINCT FROM OLD.charge_evidence_reference)
     AND OLD.trade_id IS NOT NULL
     AND NOT ic_edit_scope_matches(OLD.trade_id) THEN
    RAISE EXCEPTION 'Linked import cost requires a synchronized revision';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS ic_import_cost_guard ON intercompany_import_batch_containers;
CREATE TRIGGER ic_import_cost_guard BEFORE UPDATE ON intercompany_import_batch_containers
FOR EACH ROW EXECUTE FUNCTION ic_guard_import_cost();

CREATE OR REPLACE FUNCTION ic_guard_trade_line_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE trade_record RECORD;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Linked source/destination line identities are immutable';
  END IF;
  SELECT source_company_id, destination_company_id, original_supplier_po_id, destination_po_id
    INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT EXISTS(
    SELECT 1 FROM po_line_items src
      JOIN purchase_orders spo ON spo.id=src.po_id
      JOIN po_line_items dst ON dst.id=NEW.destination_line_id
      JOIN purchase_orders dpo ON dpo.id=dst.po_id
     WHERE src.id=NEW.source_line_id AND spo.company_id=trade_record.source_company_id
       AND dpo.company_id=trade_record.destination_company_id
       AND dpo.id=trade_record.destination_po_id
       AND spo.container_id=dpo.container_id
       AND (spo.id=trade_record.original_supplier_po_id OR EXISTS(
           SELECT 1 FROM intercompany_trade_source_pos t
           WHERE t.trade_id=NEW.trade_id AND t.source_po_id=spo.id))
  ) THEN
     RAISE EXCEPTION 'Line links must connect the source and destination POs of one trade';
  END IF;
  RETURN NEW;
END $block$;
CREATE TRIGGER ic_trade_line_link_guard BEFORE INSERT OR UPDATE OR DELETE
  ON intercompany_trade_line_links FOR EACH ROW EXECUTE FUNCTION ic_guard_trade_line_link();

CREATE OR REPLACE FUNCTION ic_guard_charge_invoice()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Confirmed shared-charge invoices cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.face_amount IS DISTINCT FROM OLD.face_amount OR NEW.source_company_id IS DISTINCT FROM OLD.source_company_id
       OR NEW.external_invoice_key IS DISTINCT FROM OLD.external_invoice_key
       OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.charge_type IS DISTINCT FROM OLD.charge_type
       OR NEW.evidence_reference IS DISTINCT FROM OLD.evidence_reference
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN RAISE EXCEPTION 'Original external invoice face and evidence cannot change'; END IF;
    IF OLD.state='confirmed' AND (NEW.state <> 'confirmed' OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
       RAISE EXCEPTION 'Confirmed charge invoice cannot be reopened or unconfirmed'; END IF;
    IF NEW.version <> OLD.version + 1 AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'Invalid confirmed invoice revision'; END IF;
  END IF;
  RETURN NEW;
END $blocked$;
CREATE TRIGGER ic_shared_charge_invoice_immutability BEFORE UPDATE OR DELETE
ON intercompany_shared_charge_invoices FOR EACH ROW EXECUTE FUNCTION ic_guard_charge_invoice();

-- Deferred verification permits one atomic multi-container allocation update, but no
-- committed invoice may have allocations summing to anything other than its face amount.
CREATE OR REPLACE FUNCTION ic_check_shared_charge_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE invoice_id_to_check BIGINT; face NUMERIC(20,2); total NUMERIC(20,2);
BEGIN
  invoice_id_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT face_amount INTO face FROM intercompany_shared_charge_invoices
  WHERE id=invoice_id_to_check AND state='confirmed';
  IF face IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_allocations
   WHERE invoice_id=invoice_id_to_check;
  IF total <> face THEN
    RAISE EXCEPTION 'Shared invoice allocation % does not equal original face amount %', total, face;
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_charge_totals_after_allocation
AFTER INSERT OR UPDATE OR DELETE ON intercompany_shared_charge_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_check_shared_charge_totals();
CREATE OR REPLACE FUNCTION ic_check_shared_invoice_face()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE total NUMERIC(20,2);
BEGIN
  IF NEW.state <> 'confirmed' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_allocations
    WHERE invoice_id=NEW.id;
  IF total <> NEW.face_amount THEN
    RAISE EXCEPTION 'Shared invoice face amount and confirmed allocations disagree';
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_invoice_face_after_confirm
AFTER INSERT OR UPDATE ON intercompany_shared_charge_invoices
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ic_check_shared_invoice_face();

CREATE OR REPLACE FUNCTION ic_check_shared_po_allocations()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE invoice_to_check BIGINT; trade_to_check INTEGER; expected NUMERIC(20,2); total NUMERIC(20,2);
BEGIN
  invoice_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  trade_to_check := CASE WHEN TG_OP='DELETE' THEN OLD.trade_id ELSE NEW.trade_id END;
  SELECT amount INTO expected FROM intercompany_shared_charge_allocations
   WHERE invoice_id=invoice_to_check AND trade_id=trade_to_check;
  IF expected IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO total FROM intercompany_shared_charge_po_allocations
   WHERE invoice_id=invoice_to_check AND trade_id=trade_to_check;
  IF expected <> total THEN
    RAISE EXCEPTION 'Shared charge source PO allocations do not equal container allocation';
  END IF;
  RETURN NULL;
END $check$;
CREATE CONSTRAINT TRIGGER ic_shared_charge_po_sum_guard AFTER INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_po_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_check_shared_po_allocations();

-- Recheck source-PO totals when the parent container allocation changes too.
CREATE CONSTRAINT TRIGGER ic_shared_charge_parent_po_sum_guard AFTER INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_check_shared_po_allocations();

-- All trade/PO allocation references must be ownership-consistent.
CREATE OR REPLACE FUNCTION ic_guard_shared_charge_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE inv RECORD; trade_record RECORD;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Shared charge allocations must be revised, not deleted';
  END IF;
  SELECT source_company_id, state INTO inv FROM intercompany_shared_charge_invoices WHERE id=NEW.invoice_id;
  SELECT source_company_id, state INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF inv.source_company_id IS DISTINCT FROM trade_record.source_company_id OR trade_record.state <> 'active' THEN
    RAISE EXCEPTION 'Shared invoice allocation must target an active container of its source company';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.invoice_id <> NEW.invoice_id OR OLD.trade_id <> NEW.trade_id THEN
      RAISE EXCEPTION 'Shared charge allocation ownership cannot change';
    END IF;
  END IF;
  IF inv.state='confirmed' AND NOT ic_edit_scope_matches(NEW.trade_id) THEN
    RAISE EXCEPTION 'Confirmed shared charge allocation requires an authorized transaction revision';
  END IF;
  RETURN NEW;
END $check$;
CREATE TRIGGER ic_shared_charge_allocation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON intercompany_shared_charge_allocations FOR EACH ROW EXECUTE FUNCTION ic_guard_shared_charge_allocation();

CREATE OR REPLACE FUNCTION ic_guard_shared_charge_po_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE inv_state VARCHAR; trade_company INTEGER; po_company INTEGER; po_container INTEGER; trade_container INTEGER;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Confirmed source PO allocations cannot be deleted'; END IF;
  SELECT state INTO inv_state FROM intercompany_shared_charge_invoices WHERE id=NEW.invoice_id;
  SELECT source_company_id, physical_container_id INTO trade_company, trade_container
   FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT company_id, container_id INTO po_company, po_container FROM purchase_orders WHERE id=NEW.source_po_id;
  IF trade_company <> po_company OR trade_container <> po_container
    OR NOT EXISTS (SELECT 1 FROM intercompany_trade_source_pos l
      WHERE l.trade_id=NEW.trade_id AND l.source_po_id=NEW.source_po_id) THEN
    RAISE EXCEPTION 'Source PO allocation does not belong to this trade';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.invoice_id <> OLD.invoice_id OR NEW.trade_id <> OLD.trade_id OR NEW.source_po_id <> OLD.source_po_id) THEN
    RAISE EXCEPTION 'Source PO allocation identities cannot change';
  END IF;
  IF inv_state='confirmed' AND NOT ic_edit_scope_matches(NEW.trade_id) THEN
    RAISE EXCEPTION 'Confirmed source PO allocation requires an authorized transaction revision';
  END IF;
  RETURN NEW;
END $check$;
CREATE TRIGGER ic_shared_charge_po_allocation_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_shared_charge_po_allocations FOR EACH ROW EXECUTE FUNCTION ic_guard_shared_charge_po_allocation();

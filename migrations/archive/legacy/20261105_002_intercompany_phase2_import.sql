-- Phase 2: configuration references and original supplier PO provenance.
-- Inert until an Owner/Developer explicitly enables a configured company pair.
-- Never rewrites existing purchase orders, containers, journals or stock.
ALTER TABLE intercompany_relationship_policies
  ADD COLUMN IF NOT EXISTS destination_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_purchase_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_sales_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_cost_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_charge_accrual_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_git_account_id INTEGER REFERENCES ledger_accounts(id) ON DELETE RESTRICT;

ALTER TABLE intercompany_relationship_policies
  DROP CONSTRAINT IF EXISTS intercompany_policy_phase2_configuration;
ALTER TABLE intercompany_relationship_policies
  ADD CONSTRAINT intercompany_policy_phase2_configuration CHECK (
    NOT trade_enabled OR (
      destination_supplier_id IS NOT NULL AND
      source_purchase_account_id IS NOT NULL AND
      source_sales_account_id IS NOT NULL AND
      source_cost_account_id IS NOT NULL AND
      source_charge_accrual_account_id IS NOT NULL AND
      destination_git_account_id IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS intercompany_trade_source_pos (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  source_po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  original_po_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT intercompany_trade_source_po_unique UNIQUE(source_po_id),
  CONSTRAINT intercompany_trade_source_po_pair_unique UNIQUE(trade_id, source_po_id)
);
CREATE INDEX IF NOT EXISTS intercompany_trade_source_pos_trade_idx
  ON intercompany_trade_source_pos(trade_id);

ALTER TABLE intercompany_import_batch_containers
  ADD COLUMN IF NOT EXISTS charges_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS charge_evidence_reference TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_landed_cost NUMERIC(20,2);

ALTER TABLE intercompany_import_batch_containers
  DROP CONSTRAINT IF EXISTS intercompany_import_confirmed_charge_evidence;
ALTER TABLE intercompany_import_batch_containers
  ADD CONSTRAINT intercompany_import_confirmed_charge_evidence CHECK (
    NOT charges_confirmed OR
    (charge_evidence_reference IS NOT NULL AND length(btrim(charge_evidence_reference)) >= 3)
  );

-- Verify that configuration references their actual company owners.
CREATE OR REPLACE FUNCTION intercompany_check_policy_accounts()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE checks RECORD;
BEGIN
  FOR checks IN
    SELECT 'source receivable' AS label, NEW.source_receivable_account_id AS account_id,
           NEW.source_company_id AS company_id
    UNION ALL SELECT 'destination payable', NEW.destination_payable_account_id, NEW.destination_company_id
    UNION ALL SELECT 'source purchases', NEW.source_purchase_account_id, NEW.source_company_id
    UNION ALL SELECT 'source sales', NEW.source_sales_account_id, NEW.source_company_id
    UNION ALL SELECT 'source cost', NEW.source_cost_account_id, NEW.source_company_id
    UNION ALL SELECT 'source charge accrual', NEW.source_charge_accrual_account_id, NEW.source_company_id
    UNION ALL SELECT 'destination goods in transit', NEW.destination_git_account_id, NEW.destination_company_id
  LOOP
    IF checks.account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ledger_accounts a
       WHERE a.id = checks.account_id AND a.company_id = checks.company_id AND a.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Intercompany % account must belong to its configured company', checks.label;
    END IF;
  END LOOP;
  IF NEW.destination_supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM suppliers s
     WHERE s.id = NEW.destination_supplier_id
       AND s.company_id = NEW.destination_company_id
       AND s.deleted_at IS NULL AND s.active = TRUE
  ) THEN
    RAISE EXCEPTION 'Intercompany destination supplier must belong to destination company';
  END IF;
  RETURN NEW;
END $check$;

DROP TRIGGER IF EXISTS intercompany_policy_account_scope ON intercompany_relationship_policies;
CREATE TRIGGER intercompany_policy_account_scope
BEFORE INSERT OR UPDATE OF
  source_company_id, destination_company_id,
  source_receivable_account_id, destination_payable_account_id,
  source_purchase_account_id, source_sales_account_id, source_cost_account_id, source_charge_accrual_account_id,
  destination_git_account_id, destination_supplier_id
ON intercompany_relationship_policies
FOR EACH ROW EXECUTE FUNCTION intercompany_check_policy_accounts();

-- A linked trade has one immutable physical source and cannot be marked active
-- until the complete source/destination purchase order linkage exists.
CREATE OR REPLACE FUNCTION intercompany_check_source_po_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $check$
DECLARE trade_record RECORD;
BEGIN
  SELECT source_company_id, physical_container_id INTO trade_record
    FROM intercompany_trades WHERE id = NEW.trade_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM purchase_orders po
     WHERE po.id = NEW.source_po_id
       AND po.company_id = trade_record.source_company_id
       AND po.container_id = trade_record.physical_container_id
  ) THEN
    RAISE EXCEPTION 'Linked external supplier PO must belong to source company and physical container';
  END IF;
  RETURN NEW;
END $check$;

DROP TRIGGER IF EXISTS intercompany_source_po_integrity ON intercompany_trade_source_pos;
CREATE TRIGGER intercompany_source_po_integrity
BEFORE INSERT OR UPDATE ON intercompany_trade_source_pos
FOR EACH ROW EXECUTE FUNCTION intercompany_check_source_po_link();

-- A future offload or physical container state change must be handled by the
-- Phase 5 stock-ownership service. Until then fail closed, not with duplicate stock.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_offload()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE physical_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'container_offloads' THEN
    physical_id := NEW.container_id;
  ELSE
    physical_id := NEW.id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = physical_id AND state = 'active'
  ) THEN
    RAISE EXCEPTION 'Linked intercompany container offloading requires the Phase 5 ownership workflow';
  END IF;
  RETURN NEW;
END $block$;

DROP TRIGGER IF EXISTS intercompany_legacy_offload_guard ON container_offloads;
CREATE TRIGGER intercompany_legacy_offload_guard
BEFORE INSERT ON container_offloads
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_offload();

DROP TRIGGER IF EXISTS intercompany_legacy_container_state_guard ON containers;
CREATE TRIGGER intercompany_legacy_container_state_guard
BEFORE UPDATE OF status ON containers
FOR EACH ROW WHEN (NEW.status IN ('OFFLOADED', 'SOLD') AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION intercompany_block_legacy_offload();


-- Existing PO edit routes do not know how to mirror an intercompany transaction.
-- Fail closed until Phase 3 replaces these protections with linked sync logic.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_po_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE po_id INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'po_line_items' THEN
    po_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSE
    po_id := OLD.id;
  END IF;
  IF TG_TABLE_NAME = 'po_line_items' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.po_id IS DISTINCT FROM OLD.po_id THEN
        IF EXISTS (
          SELECT 1 FROM intercompany_trades t WHERE t.state='active'
          AND (t.destination_po_id=NEW.po_id OR t.original_supplier_po_id=NEW.po_id)
        ) OR EXISTS (
          SELECT 1 FROM intercompany_trade_source_pos sp
          JOIN intercompany_trades t ON t.id=sp.trade_id
          WHERE t.state='active' AND sp.source_po_id=NEW.po_id
        ) THEN
          RAISE EXCEPTION 'Cannot move PO line into an active intercompany purchase order';
        END IF;
      END IF;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE t.state = 'active' AND
      (t.destination_po_id = po_id OR t.original_supplier_po_id = po_id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    INNER JOIN intercompany_trades t ON t.id = link.trade_id
    WHERE t.state = 'active' AND link.source_po_id = po_id
  ) THEN
    RAISE EXCEPTION 'Linked intercompany purchase orders require the Phase 3 synchronized editing workflow';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_po_guard ON purchase_orders;
CREATE TRIGGER intercompany_legacy_po_guard
BEFORE UPDATE OR DELETE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_po_change();

DROP TRIGGER IF EXISTS intercompany_legacy_po_line_guard ON po_line_items;
CREATE TRIGGER intercompany_legacy_po_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON po_line_items
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_po_change();

CREATE OR REPLACE FUNCTION intercompany_block_legacy_charge_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE physical_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    physical_id := NEW.container_id;
  ELSE
    physical_id := OLD.container_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.container_id IS DISTINCT FROM OLD.container_id AND EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = NEW.container_id AND state='active'
  ) THEN
    RAISE EXCEPTION 'Cannot move charge into a linked intercompany container';
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades
    WHERE physical_container_id = physical_id AND state = 'active'
  ) THEN
    RAISE EXCEPTION 'Linked intercompany charges require the Phase 3 synchronized allocation workflow';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_charge_guard ON container_charges;
CREATE TRIGGER intercompany_legacy_charge_guard
BEFORE INSERT OR UPDATE OR DELETE ON container_charges
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_charge_change();

-- Financial vouchers linked to these POs or their original at-cost resale must
-- not be retired or changed by standalone voucher tools.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_voucher_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
    LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
    WHERE t.state = 'active'
      AND (src.voucher_id = OLD.id OR dst.voucher_id = OLD.id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    JOIN intercompany_trades t ON t.id = link.trade_id
    JOIN purchase_orders po ON po.id = link.source_po_id
    WHERE t.state = 'active' AND po.voucher_id = OLD.id
  ) OR EXISTS (
    SELECT 1 FROM intercompany_audit_events audit
    JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
    WHERE t.state = 'active' AND audit.event_type = 'container-import-confirmed'
      AND ((audit.payload->>'sourceSaleVoucherId')::integer = OLD.id OR
           (audit.payload->>'sourceCostVoucherId')::integer = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Linked intercompany vouchers require a coordinated reversal or update';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;

DROP TRIGGER IF EXISTS intercompany_legacy_voucher_guard ON vouchers;
CREATE TRIGGER intercompany_legacy_voucher_guard
BEFORE UPDATE OR DELETE ON vouchers
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_voucher_change();


-- Voucher-entry edits can bypass a voucher-header trigger. Protect BOTH levels.
-- Pre-trade entries can be written because no active linkage exists yet.
CREATE OR REPLACE FUNCTION intercompany_block_legacy_voucher_entry_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
DECLARE posted_voucher_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    posted_voucher_id := NEW.voucher_id;
  ELSE
    posted_voucher_id := OLD.voucher_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
    LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
    WHERE t.state = 'active'
      AND (src.voucher_id = posted_voucher_id OR dst.voucher_id = posted_voucher_id)
  ) OR EXISTS (
    SELECT 1 FROM intercompany_trade_source_pos link
    JOIN intercompany_trades t ON t.id = link.trade_id
    JOIN purchase_orders po ON po.id = link.source_po_id
    WHERE t.state = 'active' AND po.voucher_id = posted_voucher_id
  ) OR EXISTS (
    SELECT 1 FROM intercompany_audit_events audit
    JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
    WHERE t.state = 'active'
      AND audit.event_type = 'container-import-confirmed'
      AND (
        (audit.payload->>'sourceSaleVoucherId')::integer = posted_voucher_id OR
        (audit.payload->>'sourceCostVoucherId')::integer = posted_voucher_id
      )
  ) THEN
    RAISE EXCEPTION 'Linked intercompany voucher entries require coordinated changes';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.voucher_id <> OLD.voucher_id THEN
    -- Relinking an unrelated entry INTO a protected voucher must not bypass guard.
    IF EXISTS (
      SELECT 1 FROM intercompany_trades t
      LEFT JOIN purchase_orders src ON src.id = t.original_supplier_po_id
      LEFT JOIN purchase_orders dst ON dst.id = t.destination_po_id
      WHERE t.state = 'active'
        AND (src.voucher_id = NEW.voucher_id OR dst.voucher_id = NEW.voucher_id)
    ) OR EXISTS (
      SELECT 1 FROM intercompany_trade_source_pos link
      JOIN intercompany_trades t ON t.id = link.trade_id
      JOIN purchase_orders po ON po.id = link.source_po_id
      WHERE t.state = 'active' AND po.voucher_id = NEW.voucher_id
    ) OR EXISTS (
      SELECT 1 FROM intercompany_audit_events audit
      JOIN intercompany_trades t ON t.id::text = split_part(audit.event_key, ':', 3)
      WHERE t.state = 'active' AND audit.event_type = 'container-import-confirmed'
        AND (
          (audit.payload->>'sourceSaleVoucherId')::integer = NEW.voucher_id OR
          (audit.payload->>'sourceCostVoucherId')::integer = NEW.voucher_id
        )
    ) THEN
      RAISE EXCEPTION 'Cannot move voucher lines into a protected intercompany voucher';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $blocked$;
DROP TRIGGER IF EXISTS intercompany_legacy_voucher_entry_guard ON voucher_entries;
CREATE TRIGGER intercompany_legacy_voucher_entry_guard
BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries
FOR EACH ROW EXECUTE FUNCTION intercompany_block_legacy_voucher_entry_change();


-- Container tracking may continue, but no legacy form may change canonical
-- ownership, original supplier, number or offload date after a trade is active.
CREATE OR REPLACE FUNCTION intercompany_block_container_identity_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $blocked$
BEGIN
  IF EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE t.physical_container_id = OLD.id AND t.state = 'active'
  ) THEN
    RAISE EXCEPTION 'Active intercompany container ownership and offload identity are protected';
  END IF;
  RETURN NEW;
END $blocked$;
DROP TRIGGER IF EXISTS intercompany_container_identity_guard ON containers;
CREATE TRIGGER intercompany_container_identity_guard
BEFORE UPDATE OF company_id, container_number, supplier_id, offload_date
ON containers
FOR EACH ROW
WHEN (
  NEW.company_id IS DISTINCT FROM OLD.company_id OR
  NEW.container_number IS DISTINCT FROM OLD.container_number OR
  NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
  NEW.offload_date IS DISTINCT FROM OLD.offload_date
)
EXECUTE FUNCTION intercompany_block_container_identity_change();

-- Phase 5: dedicated destination receipt and pre-receipt trade cancellation.
-- Keep the ONE physical container in Properties. This migration posts NO live
-- stock, cash, supplier, or GL changes and does not activate any workflow.

CREATE TABLE intercompany_destination_receipts (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL UNIQUE REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  inventory_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  git_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  receipt_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  request_key VARCHAR(128) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64) NOT NULL,
  posting_date DATE NOT NULL,
  landed_cost NUMERIC(20,2) NOT NULL CHECK(landed_cost>0),
  arrival_evidence TEXT NOT NULL CHECK(length(btrim(arrival_evidence))>=8),
  reason TEXT NOT NULL CHECK(length(btrim(reason))>=3),
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_receipt_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$')
);
CREATE INDEX ic_destination_receipts_company_idx ON intercompany_destination_receipts(destination_company_id, posting_date);
CREATE TABLE intercompany_destination_receipt_items (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES intercompany_destination_receipts(id) ON DELETE RESTRICT,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,3) NOT NULL CHECK(quantity>0),
  landed_value NUMERIC(20,2) NOT NULL CHECK(landed_value>=0),
  value_moved NUMERIC(20,2) NOT NULL,
  -- The canonical movement table is created at runtime, not by Drizzle migrations.
  -- Ownership is enforced by the append-only guard below instead of a DDL FK.
  canonical_movement_id BIGINT NOT NULL UNIQUE,
  CONSTRAINT ic_receipt_one_item UNIQUE(receipt_id,stock_item_id),
  CONSTRAINT ic_receipt_no_cost_variance CHECK(landed_value=value_moved)
);

CREATE TABLE intercompany_trade_cancellations (
  id BIGSERIAL PRIMARY KEY,
  trade_id INTEGER NOT NULL UNIQUE REFERENCES intercompany_trades(id) ON DELETE RESTRICT,
  relationship_id INTEGER NOT NULL REFERENCES intercompany_relationship_policies(id) ON DELETE RESTRICT,
  source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  destination_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request_key VARCHAR(128) NOT NULL UNIQUE,
  request_fingerprint VARCHAR(64) NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>0),
  posting_date DATE NOT NULL,
  landed_cost NUMERIC(20,2) NOT NULL CHECK(landed_cost>0),
  source_sale_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  source_cost_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  destination_git_reversal_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(btrim(reason))>=3),
  cancellation_evidence TEXT NOT NULL CHECK(length(btrim(cancellation_evidence))>=8),
  released_credit NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK(released_credit>=0),
  actor_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ic_cancellation_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$')
);

-- Credit released by canceling an unreceived trade stays available only to
-- its ORIGINAL payment / original company pair; NO cash vouchers are posted.
ALTER TABLE intercompany_payment_allocations DROP CONSTRAINT ic_payment_allocation_kind;
ALTER TABLE intercompany_payment_allocations ADD CONSTRAINT ic_payment_allocation_kind CHECK(
  allocation_kind IN ('manual','new_import_credit','cancel_credit_reallocate',
    'edit_release','reversal_release','cancel_release')
);
ALTER TABLE intercompany_payment_allocations DROP CONSTRAINT ic_payment_allocation_signed_kind;
ALTER TABLE intercompany_payment_allocations ADD CONSTRAINT ic_payment_allocation_signed_kind CHECK(
  (amount>0 AND allocation_kind IN ('manual','new_import_credit','cancel_credit_reallocate'))
  OR (amount<0 AND allocation_kind IN ('edit_release','reversal_release','cancel_release'))
);

CREATE OR REPLACE FUNCTION ic_phase5_receipt_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE t RECORD; p RECORD; v RECORD; l RECORD; a RECORD; actual NUMERIC(20,2); n INTEGER;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Confirmed intercompany receipt cannot be edited or deleted'; END IF;
  SELECT * INTO t FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT * INTO p FROM intercompany_relationship_policies WHERE id=NEW.relationship_id;
  SELECT * INTO v FROM vouchers WHERE id=NEW.receipt_voucher_id;
  SELECT * INTO l FROM locations WHERE id=NEW.location_id;
  SELECT * INTO a FROM ledger_accounts WHERE id=NEW.inventory_account_id;
  IF t.id IS NULL OR l.id IS NULL OR a.id IS NULL OR v.id IS NULL OR t.state<>'active' OR t.relationship_id<>NEW.relationship_id
     OR t.destination_company_id<>NEW.destination_company_id
     OR p.id IS NULL OR p.destination_git_account_id<>NEW.git_account_id
     OR l.company_id<>NEW.destination_company_id OR l.deleted_at IS NOT NULL
     OR a.company_id<>NEW.destination_company_id OR a.code<>'INVENTORY'
     OR a.account_type NOT IN ('Asset','Current Asset') OR a.deleted_at IS NOT NULL
     OR a.active IS DISTINCT FROM TRUE OR NEW.inventory_account_id=NEW.git_account_id
     OR v.company_id<>NEW.destination_company_id OR v.voucher_type<>'Journal'
     OR v.deleted_at IS NOT NULL OR v.total_amount<>NEW.landed_cost THEN
    RAISE EXCEPTION 'Intercompany destination receipt ownership, inventory account or journal mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM containers c WHERE c.id=t.physical_container_id
        AND c.company_id=t.source_company_id AND c.status='OTW' AND c.offload_date IS NULL)
     OR NOT EXISTS (SELECT 1 FROM intercompany_import_batch_containers b
        WHERE b.trade_id=NEW.trade_id AND b.confirmed_landed_cost=NEW.landed_cost) THEN
    RAISE EXCEPTION 'Receipt must use the canonical unreceived container and confirmed landed cost';
  END IF;
  SELECT COUNT(*) INTO n FROM voucher_entries WHERE voucher_id=v.id;
  SELECT COALESCE(SUM(debit_amount),0) INTO actual FROM voucher_entries
    WHERE voucher_id=v.id AND ledger_account_id=NEW.inventory_account_id
      AND bank_account_id IS NULL AND supplier_id IS NULL AND COALESCE(credit_amount,0)=0;
  IF n<>2 OR actual<>NEW.landed_cost OR NOT EXISTS (
       SELECT 1 FROM voucher_entries WHERE voucher_id=v.id
         AND ledger_account_id=NEW.git_account_id AND credit_amount=NEW.landed_cost
         AND COALESCE(debit_amount,0)=0 AND bank_account_id IS NULL AND supplier_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Destination stock receipt must have the exact inventory/GIT voucher legs';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_destination_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_destination_receipts FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_immutable();

CREATE OR REPLACE FUNCTION ic_phase5_receipt_item_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; movement RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Destination stock receipt evidence is append-only'; END IF;
  SELECT * INTO r FROM intercompany_destination_receipts WHERE id=NEW.receipt_id;
  SELECT * INTO movement FROM canonical_stock_movements WHERE id=NEW.canonical_movement_id;
  IF r.id IS NULL OR movement.id IS NULL
    OR NEW.quantity IS DISTINCT FROM (
      SELECT COALESCE(SUM(li.quantity),0)::numeric
      FROM intercompany_trades t
      JOIN po_line_items li ON li.po_id=t.destination_po_id
      WHERE t.id=r.trade_id AND li.stock_item_id=NEW.stock_item_id
    )
    OR movement.company_id<>r.destination_company_id
    OR movement.stock_item_id<>NEW.stock_item_id
    OR movement.location_id<>r.location_id OR movement.movement_kind<>'receipt'
    OR movement.source_type<>'intercompany-destination-receipt'
    OR movement.source_id<>r.trade_id::text
    OR movement.quantity_delta<>NEW.quantity
    OR ROUND(movement.quantity_delta*movement.unit_cost,2)<>NEW.landed_value
    OR NOT EXISTS (SELECT 1 FROM stock_items s
        WHERE s.id=NEW.stock_item_id AND s.company_id=r.destination_company_id) THEN
    RAISE EXCEPTION 'Destination receipt movement must be in the ERP destination only';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_destination_receipt_item_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_destination_receipt_items FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_item_guard();

CREATE OR REPLACE FUNCTION ic_phase5_receipt_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE receipt_id_to_check BIGINT; r RECORD; total NUMERIC(20,2);
BEGIN
  IF TG_TABLE_NAME='intercompany_destination_receipts' THEN
    receipt_id_to_check := NEW.id;
  ELSE
    receipt_id_to_check := NEW.receipt_id;
  END IF;
  SELECT landed_cost, trade_id INTO r FROM intercompany_destination_receipts WHERE id=receipt_id_to_check;
  SELECT COALESCE(SUM(landed_value),0) INTO total
     FROM intercompany_destination_receipt_items WHERE receipt_id=receipt_id_to_check;
  IF r.landed_cost IS NULL OR r.landed_cost<>total THEN
    RAISE EXCEPTION 'All received destination item values must equal confirmed linked GIT cost';
  END IF;
  -- Matching the total is insufficient: a missing zero-cost/free PO item
  -- would otherwise never enter destination stock, even though the GL balances.
  IF EXISTS (
    SELECT DISTINCT li.stock_item_id
    FROM intercompany_trades t
    JOIN po_line_items li ON li.po_id=t.destination_po_id
    WHERE t.id=r.trade_id
    EXCEPT
    SELECT ri.stock_item_id FROM intercompany_destination_receipt_items ri
    WHERE ri.receipt_id=receipt_id_to_check
  ) THEN
    RAISE EXCEPTION 'Destination receipt items must cover all linked purchase stock items';
  END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER ic_destination_receipt_sum
AFTER INSERT ON intercompany_destination_receipts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_totals();
CREATE CONSTRAINT TRIGGER ic_destination_receipt_item_sum
AFTER INSERT ON intercompany_destination_receipt_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ic_phase5_receipt_totals();

CREATE OR REPLACE FUNCTION ic_phase5_trade_cancellation_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.state='active' AND NEW.state='canceled' THEN
    IF current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM OLD.id::text
       OR NEW.version<>OLD.version+1 OR NEW.canceled_at IS NULL
       OR (to_jsonb(NEW)-ARRAY['state','version','canceled_at']::text[])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','canceled_at']::text[])
       OR NOT EXISTS (SELECT 1 FROM intercompany_trade_cancellations c
            WHERE c.trade_id=OLD.id AND c.expected_version=OLD.version) THEN
      RAISE EXCEPTION 'Cancel the intercompany trade only through synchronized Phase 5 accounting';
    END IF;
  ELSIF OLD.state='canceled' THEN
    RAISE EXCEPTION 'Canceled trade is immutable; never rewrite status, version or financial evidence';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_trade_cancel_guard BEFORE UPDATE ON intercompany_trades
FOR EACH ROW EXECUTE FUNCTION ic_phase5_trade_cancellation_guard();

CREATE OR REPLACE FUNCTION ic_validate_payment_allocation_row()
RETURNS TRIGGER LANGUAGE plpgsql AS $guard$
DECLARE payment_row RECORD; trade_row RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Intercompany payment allocations are append-only; post a release entry';
  END IF;
  SELECT * INTO payment_row FROM intercompany_container_payments WHERE id=NEW.payment_id;
  SELECT * INTO trade_row FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT FOUND OR trade_row.state <> 'active'
    OR payment_row.status <> 'confirmed'
    OR payment_row.relationship_id <> trade_row.relationship_id
    OR payment_row.source_company_id <> trade_row.source_company_id
    OR payment_row.destination_company_id <> trade_row.destination_company_id THEN
    RAISE EXCEPTION 'Payment credit may be applied only to the same active company pair';
  END IF;
  IF NEW.amount < 0 AND NEW.allocation_kind NOT IN ('edit_release','reversal_release','cancel_release') THEN
    RAISE EXCEPTION 'Only audited payment releases may reduce allocation';
  END IF;
  IF NEW.allocation_kind = 'cancel_release'
    AND current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM NEW.trade_id::text THEN
    RAISE EXCEPTION 'Phase 5 payment release requires the same atomic cancellation request';
  END IF;
  RETURN NEW;
END $guard$;

-- Verify ALL THREE real cancellation journals, not merely their headers.
-- Source sale: Dr Sales / Cr Receivable. Source cost: Dr Purchases /
-- Cr COGS. Destination: Dr Properties Supplier / Cr Goods In Transit.
CREATE OR REPLACE FUNCTION ic_phase5_exact_cancel_journal(
  vid INTEGER, debit_type TEXT, debit_id INTEGER, credit_type TEXT, credit_id INTEGER, usd NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN (SELECT COUNT(*)=2 FROM voucher_entries WHERE voucher_id=vid)
    AND EXISTS (SELECT 1 FROM voucher_entries e
      WHERE e.voucher_id=vid AND e.debit_amount=usd AND COALESCE(e.credit_amount,0)=0
        AND e.bank_account_id IS NULL
        AND ((debit_type='ledger' AND e.ledger_account_id=debit_id AND e.supplier_id IS NULL)
          OR (debit_type='supplier' AND e.supplier_id=debit_id AND e.ledger_account_id IS NULL)))
    AND EXISTS (SELECT 1 FROM voucher_entries e
      WHERE e.voucher_id=vid AND e.credit_amount=usd AND COALESCE(e.debit_amount,0)=0
        AND e.bank_account_id IS NULL
        AND ((credit_type='ledger' AND e.ledger_account_id=credit_id AND e.supplier_id IS NULL)
          OR (credit_type='supplier' AND e.supplier_id=credit_id AND e.ledger_account_id IS NULL)));
END $fn$;
CREATE OR REPLACE FUNCTION ic_phase5_cancellation_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE t RECORD; p RECORD; v1 RECORD; v2 RECORD; v3 RECORD;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Intercompany cancellation evidence cannot be modified'; END IF;
  IF current_setting('erp.ic_phase5_cancel',true) IS DISTINCT FROM NEW.trade_id::text THEN
    RAISE EXCEPTION 'Cancellation evidence requires the same atomic cancellation transaction';
  END IF;
  SELECT * INTO t FROM intercompany_trades WHERE id=NEW.trade_id;
  SELECT * INTO p FROM intercompany_relationship_policies WHERE id=NEW.relationship_id;
  SELECT * INTO v1 FROM vouchers WHERE id=NEW.source_sale_reversal_voucher_id;
  SELECT * INTO v2 FROM vouchers WHERE id=NEW.source_cost_reversal_voucher_id;
  SELECT * INTO v3 FROM vouchers WHERE id=NEW.destination_git_reversal_voucher_id;
  IF t.id IS NULL OR p.id IS NULL OR t.state<>'active' OR t.version<>NEW.expected_version
    OR t.relationship_id<>NEW.relationship_id
    OR t.source_company_id<>NEW.source_company_id OR t.destination_company_id<>NEW.destination_company_id
    OR v1.id IS NULL OR v2.id IS NULL OR v3.id IS NULL
    OR v1.id=v2.id OR v1.id=v3.id OR v2.id=v3.id
    OR v1.company_id<>NEW.source_company_id OR v2.company_id<>NEW.source_company_id
    OR v3.company_id<>NEW.destination_company_id
    OR v1.voucher_type<>'Journal' OR v2.voucher_type<>'Journal' OR v3.voucher_type<>'Journal'
    OR v1.deleted_at IS NOT NULL OR v2.deleted_at IS NOT NULL OR v3.deleted_at IS NOT NULL
    OR v1.total_amount<>NEW.landed_cost OR v2.total_amount<>NEW.landed_cost
    OR v3.total_amount<>NEW.landed_cost
    OR p.source_receivable_account_id IS NULL OR p.source_sales_account_id IS NULL
    OR p.source_cost_account_id IS NULL OR p.source_purchase_account_id IS NULL
    OR p.destination_git_account_id IS NULL OR p.destination_supplier_id IS NULL THEN
    RAISE EXCEPTION 'Cancellation requires exact original-pair balanced voucher evidence';
  END IF;
  IF NOT ic_phase5_exact_cancel_journal(v1.id,'ledger',p.source_sales_account_id,
      'ledger',p.source_receivable_account_id,NEW.landed_cost)
    OR NOT ic_phase5_exact_cancel_journal(v2.id,'ledger',p.source_purchase_account_id,
      'ledger',p.source_cost_account_id,NEW.landed_cost)
    OR NOT ic_phase5_exact_cancel_journal(v3.id,'supplier',p.destination_supplier_id,
      'ledger',p.destination_git_account_id,NEW.landed_cost) THEN
    RAISE EXCEPTION 'Cancellation reversal journal lines must exactly offset the original pair';
  END IF;
  IF NEW.released_credit IS DISTINCT FROM (
      SELECT COALESCE(SUM(-allocation.amount),0)::numeric
      FROM intercompany_payment_allocations allocation
      WHERE allocation.trade_id=NEW.trade_id AND allocation.allocation_kind='cancel_release'
    ) THEN
    RAISE EXCEPTION 'Cancellation credit evidence must match original pair release rows';
  END IF;
  IF EXISTS(SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=NEW.trade_id)
     OR EXISTS(SELECT 1 FROM intercompany_shared_charge_allocations
       WHERE trade_id=NEW.trade_id AND amount<>0) THEN
    RAISE EXCEPTION 'Received stock or unreassigned shared invoice charge prevents cancellation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER ic_phase5_cancellation_insert_guard BEFORE INSERT OR UPDATE OR DELETE
ON intercompany_trade_cancellations FOR EACH ROW EXECUTE FUNCTION ic_phase5_cancellation_immutable();

-- Financial evidence must remain locked even AFTER a trade is canceled.
-- Phase 3's linked PO trigger deliberately checks active trades only; without
-- this additional guard a canceled PO could be edited by legacy routes.
CREATE OR REPLACE FUNCTION ic_phase5_preserve_closed_trade_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE pid INTEGER; cid INTEGER; vid INTEGER;
BEGIN
  IF TG_TABLE_NAME='purchase_orders' THEN
    pid:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  ELSIF TG_TABLE_NAME='po_line_items' THEN
    pid:=CASE WHEN TG_OP='INSERT' THEN NEW.po_id ELSE OLD.po_id END;
  ELSIF TG_TABLE_NAME='container_charges' THEN
    cid:=CASE WHEN TG_OP='INSERT' THEN NEW.container_id ELSE OLD.container_id END;
  ELSIF TG_TABLE_NAME='containers' THEN
    cid:=OLD.id;
  ELSIF TG_TABLE_NAME='voucher_entries' THEN
    vid:=CASE WHEN TG_OP='INSERT' THEN NEW.voucher_id ELSE OLD.voucher_id END;
  ELSE
    vid:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
  END IF;
  IF pid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trades t
    WHERE (t.state='canceled' OR EXISTS(
      SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id
    )) AND (
      t.destination_po_id=pid OR t.original_supplier_po_id=pid
      OR EXISTS(SELECT 1 FROM intercompany_trade_source_pos sp WHERE sp.trade_id=t.id AND sp.source_po_id=pid)
    )
  ) THEN RAISE EXCEPTION 'Received or canceled intercompany purchase orders and lines are immutable'; END IF;
  IF cid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trades t WHERE (t.state='canceled' OR EXISTS(
      SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id
    )) AND t.physical_container_id=cid
  ) THEN RAISE EXCEPTION 'Received or canceled intercompany physical container and charge evidence cannot be altered'; END IF;
  IF vid IS NOT NULL AND EXISTS (
    SELECT 1 FROM intercompany_trade_cancellations c
    WHERE vid IN (c.source_sale_reversal_voucher_id,c.source_cost_reversal_voucher_id,c.destination_git_reversal_voucher_id)
    UNION ALL
    SELECT 1 FROM intercompany_destination_receipts r WHERE vid=r.receipt_voucher_id
  ) THEN RAISE EXCEPTION 'Phase 5 posted vouchers and their entries are immutable'; END IF;
  -- Updates may not move an unrelated journal entry INTO an existing
  -- protected Phase 5 voucher, even if the old voucher was unprotected.
  IF TG_TABLE_NAME='voucher_entries' THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id
        AND (
          EXISTS (SELECT 1 FROM intercompany_trade_cancellations c
            WHERE NEW.voucher_id IN (c.source_sale_reversal_voucher_id,
              c.source_cost_reversal_voucher_id,c.destination_git_reversal_voucher_id))
          OR EXISTS (SELECT 1 FROM intercompany_destination_receipts r
            WHERE r.receipt_voucher_id=NEW.voucher_id)
        ) THEN
        RAISE EXCEPTION 'Cannot move a journal entry into a protected Phase 5 voucher';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $fn$;
CREATE TRIGGER ic_phase5_canceled_po_lock
BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_line_lock
BEFORE INSERT OR UPDATE OR DELETE ON po_line_items FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_charge_lock
BEFORE INSERT OR UPDATE OR DELETE ON container_charges FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_canceled_container_lock
BEFORE UPDATE OF company_id,supplier_id,status,offload_date,items_total,charges_total,grand_total
 OR DELETE ON containers FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_evidence_voucher_lock
BEFORE UPDATE OR DELETE ON vouchers FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();
CREATE TRIGGER ic_phase5_evidence_entry_lock
BEFORE INSERT OR UPDATE OR DELETE ON voucher_entries FOR EACH ROW EXECUTE FUNCTION ic_phase5_preserve_closed_trade_history();

-- A completed ERP destination receipt locks the financial value and quantity
-- of both linked PO sides. Explicit verified inventory/COGS adjustments are a
-- later separate workflow, not a backdoor through Phase 3 revisions.
CREATE OR REPLACE FUNCTION ic_phase5_guard_received_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=NEW.trade_id) THEN
    RAISE EXCEPTION 'ERP stock already received; PO and charge changes need a reviewed inventory/COGS correction';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_no_reprice_received_trade
BEFORE INSERT ON intercompany_trade_revisions FOR EACH ROW EXECUTE FUNCTION ic_phase5_guard_received_revision();

-- A received trade may NOT be canceled, and legacy receipt paths still cannot
-- offload its Properties-owned physical container.
CREATE OR REPLACE FUNCTION ic_phase5_block_cancel_after_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state='canceled' AND OLD.state<>'canceled' AND EXISTS (
      SELECT 1 FROM intercompany_destination_receipts WHERE trade_id=OLD.id) THEN
    RAISE EXCEPTION 'Offloaded ERP stock needs an approved inventory and COGS correction, not trade cancellation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ic_phase5_stock_cancel_guard BEFORE UPDATE OF state ON intercompany_trades
FOR EACH ROW EXECUTE FUNCTION ic_phase5_block_cancel_after_receipt();

-- Existing voucher mutation and archival guards remain enabled.

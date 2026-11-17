-- Allow an explicitly authorized, transaction-scoped hard deletion of the
-- complete, unreceived, financially untouched intercompany PO pair.
-- Ordinary UPDATE/DELETE remains immutable and cancellation retains history.
CREATE OR REPLACE FUNCTION ic_guard_trade_line_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $block$
DECLARE trade_record RECORD;
DECLARE allowed_trade TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    allowed_trade := NULLIF(current_setting('erp.ic_physical_delete', true), '');
    IF TG_OP = 'DELETE' AND allowed_trade = OLD.trade_id::text
       AND EXISTS (
         SELECT 1 FROM intercompany_trades t
         JOIN containers c ON c.id=t.physical_container_id
         WHERE t.id=OLD.trade_id AND t.state='active' AND c.status='OTW'
           AND c.offload_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM intercompany_destination_receipts r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_payment_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_trade_revisions r WHERE r.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_shared_charge_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_shared_charge_po_allocations a WHERE a.trade_id=t.id)
           AND NOT EXISTS (SELECT 1 FROM intercompany_trade_cancellations c WHERE c.trade_id=t.id)
       )
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Linked source/destination line identities are immutable';
  END IF;
  SELECT source_company_id, destination_company_id, original_supplier_po_id, destination_po_id
    INTO trade_record FROM intercompany_trades WHERE id=NEW.trade_id;
  IF NOT EXISTS (
    SELECT 1 FROM po_line_items src
      JOIN purchase_orders spo ON spo.id=src.po_id
      JOIN po_line_items dst ON dst.id=NEW.destination_line_id
      JOIN purchase_orders dpo ON dpo.id=dst.po_id
     WHERE src.id=NEW.source_line_id AND spo.company_id=trade_record.source_company_id
       AND dpo.company_id=trade_record.destination_company_id
       AND dpo.id=trade_record.destination_po_id
       AND spo.container_id=dpo.container_id
       AND (spo.id=trade_record.original_supplier_po_id OR EXISTS (
         SELECT 1 FROM intercompany_trade_source_pos t
         WHERE t.trade_id=NEW.trade_id AND t.source_po_id=spo.id
       ))
  ) THEN
    RAISE EXCEPTION 'Line links must connect the source and destination POs of one trade';
  END IF;
  RETURN NEW;
END $block$;

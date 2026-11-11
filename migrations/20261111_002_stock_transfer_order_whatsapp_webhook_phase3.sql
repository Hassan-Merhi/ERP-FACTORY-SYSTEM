-- Phase 3: refuse competing DONE/DECLINE replies on the same batch.
-- No existing transfers, inventory, vouchers or accounting entries change.
CREATE UNIQUE INDEX IF NOT EXISTS sto_wa_batch_decision_once_uk ON stock_transfer_order_approval_events (company_id,batch_id) WHERE event_type IN ('done_received','decline_received');

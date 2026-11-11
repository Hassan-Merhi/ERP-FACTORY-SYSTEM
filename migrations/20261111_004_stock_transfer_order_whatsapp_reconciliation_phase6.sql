-- Phase 6: admin-verified WhatsApp delivery evidence and carefully authorized retries.
-- Non-destructive and additive; no stock, GL or voucher data is changed.
ALTER TABLE stock_transfer_order_approval_deliveries ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0;

DO $sto_delivery_status$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sto_wa_delivery_status_ck'
   AND conrelid='stock_transfer_order_approval_deliveries'::regclass
   AND pg_get_constraintdef(oid) NOT LIKE '%verified%') THEN
  ALTER TABLE stock_transfer_order_approval_deliveries DROP CONSTRAINT sto_wa_delivery_status_ck;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sto_wa_delivery_status_ck'
   AND conrelid='stock_transfer_order_approval_deliveries'::regclass) THEN
  ALTER TABLE stock_transfer_order_approval_deliveries
   ADD CONSTRAINT sto_wa_delivery_status_ck
   CHECK (status IN ('pending','sending','accepted','failed','uncertain','verified')) NOT VALID;
 END IF;
 END $sto_delivery_status$;

DO $sto_delivery_events$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sto_wa_event_type_ck'
   AND conrelid='stock_transfer_order_approval_events'::regclass
   AND pg_get_constraintdef(oid) NOT LIKE '%delivery_manual_retry%') THEN
  ALTER TABLE stock_transfer_order_approval_events DROP CONSTRAINT sto_wa_event_type_ck;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sto_wa_event_type_ck'
   AND conrelid='stock_transfer_order_approval_events'::regclass) THEN
  ALTER TABLE stock_transfer_order_approval_events
   ADD CONSTRAINT sto_wa_event_type_ck CHECK (event_type IN
    ('draft_created','request_sent','request_stale','done_received','decline_received',
     'approved','declined','ignored','delivery_queued','delivery_accepted','delivery_failed',
     'delivery_uncertain','cancelled','delivery_manually_verified','delivery_manual_retry'))
   NOT VALID;
 END IF;
 END $sto_delivery_events$;

DO $sto_manual_retry_ck$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sto_wa_manual_retry_count_ck'
   AND conrelid='stock_transfer_order_approval_deliveries'::regclass) THEN
  ALTER TABLE stock_transfer_order_approval_deliveries
   ADD CONSTRAINT sto_wa_manual_retry_count_ck
   CHECK (manual_retry_count BETWEEN 0 AND 3) NOT VALID;
 END IF;
 END $sto_manual_retry_ck$;

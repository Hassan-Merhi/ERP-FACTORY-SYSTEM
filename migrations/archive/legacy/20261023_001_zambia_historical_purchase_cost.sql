-- Phase 8 source-only additive migration. DO NOT apply to production during implementation.
-- Existing USD, CFA and historical stock cost values are untouched.
-- All existing purchase_orders numeric monetary columns remain historical USD.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS historical_exchange_rate numeric(20,10),
  ADD COLUMN IF NOT EXISTS historical_rate_date date,
  ADD COLUMN IF NOT EXISTS native_line_count integer,
  ADD COLUMN IF NOT EXISTS native_items_total numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_freight numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_surcharge numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_fumigation numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_document_charges numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_discount numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_other_charges numeric(20,2);

ALTER TABLE po_line_items
  ADD COLUMN IF NOT EXISTS native_rate numeric(20,2),
  ADD COLUMN IF NOT EXISTS native_line_total numeric(20,2);

-- NOT VALID avoids rewriting historical rows. PostgreSQL still enforces the
-- constraint on future inserts/updates, including ZMW relabel attempts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_zmw_historical_rate_ck' AND conrelid = 'purchase_orders'::regclass) THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_zmw_historical_rate_ck
      CHECK (upper(currency) <> 'ZMW' OR (
        historical_exchange_rate > 0
        AND historical_rate_date IS NOT NULL
        AND native_line_count > 0
        AND native_items_total IS NOT NULL
        AND native_freight IS NOT NULL
        AND native_surcharge IS NOT NULL
        AND native_fumigation IS NOT NULL
        AND native_document_charges IS NOT NULL
        AND native_discount IS NOT NULL
        AND native_other_charges IS NOT NULL
      )) NOT VALID;
  END IF;
END $$;

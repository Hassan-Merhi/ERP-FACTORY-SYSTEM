ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS previous_status text;

-- Backfill only from durable workflow evidence. Loading-created orders always
-- carry one of these timestamps; direct draft invoices do not.
UPDATE customer_orders
SET previous_status = CASE
  WHEN loading_started_at IS NOT NULL OR loading_finalized_at IS NOT NULL THEN 'LOADING'
  ELSE 'DRAFT'
END
WHERE status = 'FINALIZED'
  AND previous_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customer_orders_previous_status_check'
  ) THEN
    ALTER TABLE customer_orders
      ADD CONSTRAINT customer_orders_previous_status_check
      CHECK (previous_status IS NULL OR previous_status IN ('DRAFT', 'LOADING'));
  END IF;
END $$;

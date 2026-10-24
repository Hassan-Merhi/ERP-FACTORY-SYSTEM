/**
 * Zambia Phase 8: original Kwacha purchase evidence and the locked rate of the
 * purchase date, alongside the historical USD money columns (which remain the
 * values every ledger, goods-in-transit and stock writer stores).
 *
 * Mirrors migrations/20261023_001_zambia_historical_purchase_cost.sql for the
 * production boot path, which applies startup statements rather than the
 * versioned runner. Every statement is additive and idempotent; existing USD,
 * CFA and stock cost values are untouched, and the check constraint is NOT
 * VALID so no historical row is rewritten or re-validated.
 */
export const zambiaHistoricalPurchaseCostSchema: string[] = [
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS historical_exchange_rate numeric(20,10)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS historical_rate_date date",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_line_count integer",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_items_total numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_freight numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_surcharge numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_fumigation numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_document_charges numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_discount numeric(20,2)",
  "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS native_other_charges numeric(20,2)",
  "ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS native_rate numeric(20,2)",
  "ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS native_line_total numeric(20,2)",
  // A Kwacha-labelled PO must carry its native evidence and locked rate. NOT
  // VALID keeps historical rows as they are while enforcing future writes.
  `DO $$
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
  END $$`,
];

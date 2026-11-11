-- Phase 3 controlled extraction from 031-inventory-valuation-overrides.ts.
-- Additive schema only. Does not post journals, rewrite valuation or touch history.
-- Requires reviewed manual migration release; no automatic production execution.

updateCostPricesByBarcode;

updateInventory;

CREATE TABLE IF NOT EXISTS inventory_valuation_overrides (
     id BIGSERIAL PRIMARY KEY,
     company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
     stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
     inventory_id INTEGER,
     source_type TEXT NOT NULL,
     before_quantity NUMERIC(18, 6) NOT NULL,
     before_average_rate NUMERIC(18, 6) NOT NULL,
     before_total_value NUMERIC(24, 6) NOT NULL,
     after_quantity NUMERIC(18, 6) NOT NULL,
     after_average_rate NUMERIC(18, 6) NOT NULL,
     after_total_value NUMERIC(24, 6) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

CREATE INDEX IF NOT EXISTS inventory_valuation_overrides_company_item_location_idx
     ON inventory_valuation_overrides(company_id, stock_item_id, location_id, created_at);

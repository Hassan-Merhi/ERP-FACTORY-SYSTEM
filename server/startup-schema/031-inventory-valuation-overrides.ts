/**
 * Append-only evidence for direct inventory valuation overrides.
 *
 * The location cost-price import (`updateCostPricesByBarcode`) and the direct
 * location inventory import (`updateInventory`) overwrite an inventory row's
 * average_rate / total_value outright. The canonical journal can only record a
 * quantity change, so a rate-only rewrite left no movement and no audit row,
 * and historical cost reconstruction could not cross it (2026-09-01 rewrites
 * in company 10 are the known case). Each override now records the exact row
 * state before and after, in the same transaction that writes inventory, so a
 * later replay can treat it as a pinned valuation reset.
 *
 * Every statement is idempotent. The table is also created by
 * ensureCanonicalStockMovementJournal(), which runs in every migration mode,
 * because production skips this ordered pass.
 */
export const inventoryValuationOverrides: string[] = [
  `CREATE TABLE IF NOT EXISTS inventory_valuation_overrides (
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
   )`,
  `CREATE INDEX IF NOT EXISTS inventory_valuation_overrides_company_item_location_idx
     ON inventory_valuation_overrides(company_id, stock_item_id, location_id, created_at)`,
];

import type { Pool } from "pg";
import { ensurePhase3InventoryValuationBaselines } from "./phase3InventoryValuation";

/**
 * Runtime-safe schema for the Phase 3 stock-value cutover.
 *
 * Production can disable the bulk startup migration array, so these two small
 * internal reconciliation tables are ensured directly before their baseline is
 * captured. The baseline rows are immutable after creation; only the append-only
 * canonical stock journal advances the reconstructed value.
 */
export async function ensurePhase3InventoryValuationSchema(pool: Pool): Promise<number> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS phase3_inventory_valuation_cutovers (
      company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
      movement_cutoff_id BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS phase3_inventory_valuation_baselines (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      stock_item_id BIGINT NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
      location_id BIGINT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      quantity NUMERIC(18,3) NOT NULL,
      average_rate NUMERIC(20,2) NOT NULL,
      total_value NUMERIC(20,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT phase3_inventory_valuation_baseline_unique
        UNIQUE(company_id,stock_item_id,location_id)
    );

    CREATE INDEX IF NOT EXISTS phase3_inventory_valuation_baselines_company_idx
      ON phase3_inventory_valuation_baselines(company_id);
  `);

  return ensurePhase3InventoryValuationBaselines(pool);
}

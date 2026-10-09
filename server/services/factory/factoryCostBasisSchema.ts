/**
 * Wave 11 factory cost basis tables, ensured on every boot (production runs
 * with RUN_STARTUP_MIGRATIONS=false). Same columns and constraint names as
 * shared/schema/factory/cost-basis.ts, so a schema push agrees with them.
 *
 *   - factory_pos_sale_bales: the bales each factory POS sale took;
 *   - factory_stock_value_events: factory stock value changes tagged by
 *     source for the daily factory stock journal;
 *   - factory_bale_recost_runs: applied, Owner-confirmed bale re-costs;
 *   - factory_v3_loads.customer_order_id: the invoice a V3 load finalize
 *     created (wave 17 B).
 *
 * Every statement is idempotent (CREATE ... IF NOT EXISTS, a column added only
 * when missing; no table rewrite). The routes
 * that write these tables cannot work without them, so a failure is fatal,
 * like the required wave-11 columns (inventoryFidelitySchema.ts).
 */
import type { Pool } from "pg";

import { logger } from "../../lib/logger";

export const FACTORY_COST_BASIS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS factory_pos_sale_bales (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     sale_id integer NOT NULL
       CONSTRAINT factory_pos_sale_bales_sale_id_factory_pos_sales_id_fk REFERENCES factory_pos_sales(id) ON DELETE RESTRICT,
     bale_id integer NOT NULL
       CONSTRAINT factory_pos_sale_bales_bale_id_factory_bales_id_fk REFERENCES factory_bales(id) ON DELETE RESTRICT,
     cost_at_sale numeric(20,7) NOT NULL DEFAULT 0,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS factory_pos_sale_bales_sale_bale_unique ON factory_pos_sale_bales (sale_id, bale_id)`,
  `CREATE INDEX IF NOT EXISTS factory_pos_sale_bales_sale_idx ON factory_pos_sale_bales (sale_id)`,
  `CREATE TABLE IF NOT EXISTS factory_stock_value_events (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     event_date date NOT NULL,
     kind text NOT NULL,
     amount numeric(20,7) NOT NULL,
     source_type text NOT NULL,
     source_id text,
     journal_date date,
     created_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS factory_stock_value_events_company_journal_idx
     ON factory_stock_value_events (company_id, journal_date)`,
  `CREATE TABLE IF NOT EXISTS factory_bale_recost_runs (
     id serial PRIMARY KEY,
     company_id integer NOT NULL,
     plan_hash text NOT NULL,
     plan jsonb NOT NULL,
     voucher_id integer,
     applied_by text,
     applied_at timestamp NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS factory_bale_recost_runs_company_idx ON factory_bale_recost_runs (company_id)`,
  // Wave 17 B: the factory invoice a V3 load finalize created (re-finalize is
  // idempotent on it). A nullable column, added only when missing, so a
  // repeated boot takes no table lock.
  `DO $v3_load_order$ BEGIN
     IF to_regclass('factory_v3_loads') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'factory_v3_loads' AND column_name = 'customer_order_id'
     ) THEN
       ALTER TABLE factory_v3_loads ADD COLUMN customer_order_id integer;
     END IF;
   END $v3_load_order$`,
];

/** Creates the tables. Throws on failure (see the module comment). */
export async function ensureFactoryCostBasisSchema(pool: Pool): Promise<void> {
  for (const statement of FACTORY_COST_BASIS_DDL) await pool.query(statement);
  logger.info("[startup] ✓ Factory cost basis tables ensured (POS sale bales, stock value events, re-cost runs)");
}

/**
 * Wave 11 ("inventory fidelity") schema, ensured on every boot.
 *
 * Production runs with RUN_STARTUP_MIGRATIONS=false, so like the wave-8
 * cut-over table (ensureInventoryCutoverSchema) these changes are applied by an
 * always-on boot step (server/index.ts), and match shared/schema so a schema
 * push agrees with them:
 *
 *   - `value_moved numeric(20,2)` (nullable) on sales_items, credit_note_items
 *     (credit and debit notes), stock_adjustment_items and stock_transfer_items:
 *     the exact sub-ledger value each line moved, so a reversal restores that
 *     value. NULL marks a legacy line written before wave 11 (readers fall back
 *     to the COGS journal pro rata or the line's total).
 *     container_offload_items carries it too, with `cogs_variance numeric(20,2)`:
 *     the part of the line's landed value the receipt charged to COGS instead
 *     of inventory (a covered shortage's settlement variance, the sold share of
 *     a charge re-pricing), so the stock-in journal debits Inventory with
 *     exactly what the sub-ledger received.
 *   - `inventory.average_rate` widened from numeric(20,2) to numeric(20,7). The
 *     rate is display precision and cost memory; stock value stays
 *     `inventory.total_value` numeric(20,2). Widening only adds scale, so no
 *     stored value changes (integer digits go from 18 to 13: a stored rate of
 *     10^13 or more would make this step fail rather than truncate).
 *
 * Every step checks the catalog first and changes nothing when already
 * applied, so a repeated boot takes no table lock. The two steps run in
 * separate transactions:
 *   - adding `value_moved` is fatal on failure: Drizzle selects the new columns
 *     on full-row reads of these tables, so serving requests without them
 *     would break sales and stock documents (a nullable column is a catalog
 *     change and takes no table rewrite);
 *   - widening `average_rate` rewrites the inventory table, so on a busy
 *     database it can hit the lock timeout. It is logged and retried on the
 *     next boot rather than blocking startup: until it runs, rates keep being
 *     stored at 2dp, exactly as before.
 */
import type { Pool } from "pg";

import { logger } from "../../lib/logger";

/** The tables that record the value each line moved. */
export const VALUE_MOVED_TABLES = [
  "sales_items",
  "credit_note_items",
  "stock_adjustment_items",
  "stock_transfer_items",
  "container_offload_items",
] as const;

export const INVENTORY_AVERAGE_RATE_SCALE = 7;

export const INVENTORY_VALUE_MOVED_DDL = `
DO $wave11$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[${VALUE_MOVED_TABLES.map((table) => `'${table}'`).join(", ")}] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = target AND column_name = 'value_moved'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN value_moved numeric(20,2)', target);
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'container_offload_items' AND column_name = 'cogs_variance'
  ) THEN
    ALTER TABLE container_offload_items ADD COLUMN cogs_variance numeric(20,2);
  END IF;
END
$wave11$`;

export const INVENTORY_AVERAGE_RATE_DDL = `
DO $wave11$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'inventory' AND column_name = 'average_rate'
       AND numeric_scale < ${INVENTORY_AVERAGE_RATE_SCALE}
  ) THEN
    ALTER TABLE inventory ALTER COLUMN average_rate TYPE numeric(20,${INVENTORY_AVERAGE_RATE_SCALE});
  END IF;
END
$wave11$`;

async function applyInTransaction(pool: Pool, statement: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A busy table must not hold the boot forever.
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applies the wave-11 schema. Throws when `value_moved` cannot be added (see the
 * module comment); a failed `average_rate` widening is logged and retried on the
 * next boot.
 */
export async function ensureInventoryFidelitySchema(pool: Pool): Promise<void> {
  await applyInTransaction(pool, INVENTORY_VALUE_MOVED_DDL);
  try {
    await applyInTransaction(pool, INVENTORY_AVERAGE_RATE_DDL);
    logger.info("[startup] ✓ Inventory fidelity schema ensured (value_moved, average_rate scale)");
  } catch (error) {
    logger.error("[startup] ✗ inventory.average_rate could not be widened; retried on the next boot", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

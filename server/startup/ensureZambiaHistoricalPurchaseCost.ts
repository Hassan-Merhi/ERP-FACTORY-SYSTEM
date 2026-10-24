import type { Pool } from "pg";
import { logger } from "../lib/logger";
import { zambiaHistoricalPurchaseCostSchema } from "../startup-schema/036-zambia-historical-purchase-cost";

/**
 * Zambia Phase 8 purchase evidence columns, applied by the always-on startup
 * guard. Production boots with the bulk startup pass disabled
 * (RUN_STARTUP_MIGRATIONS=false) and never runs migrations/*.sql, so stage 036
 * alone never reaches it; this guard runs the same statements before HTTP
 * starts. Every statement is an idempotent ADD COLUMN IF NOT EXISTS or a
 * guarded NOT VALID constraint, so a re-run is a no-op and no historical row
 * is rewritten or re-validated. On a freshly empty database the purchase
 * tables do not exist yet, so defer to the bulk migration that creates them.
 */
export async function ensureZambiaHistoricalPurchaseCost(pool: Pool): Promise<void> {
  const prerequisite = await pool.query<{ ready: boolean }>(
    `SELECT to_regclass('purchase_orders') IS NOT NULL
         AND to_regclass('po_line_items') IS NOT NULL AS ready`
  );
  if (!prerequisite.rows[0]?.ready) {
    logger.info("[startup] Zambia native purchase cost columns deferred: purchase tables not created yet");
    return;
  }
  // One multi-statement query runs as a single implicit transaction, so the
  // columns and the constraint land together or not at all.
  await pool.query(zambiaHistoricalPurchaseCostSchema.join(";\n"));
  logger.info("[startup] ✓ Zambia native purchase cost columns ensured");
}

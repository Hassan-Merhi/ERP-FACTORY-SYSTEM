/**
 * Reconcile completed customer-order bales that were incorrectly restored to
 * IN_STOCK by legacy writers. This runs before listening, including when the
 * bulk startup migration pass is disabled.
 *
 * Physical stock is already excluded from Inventory via order links; changing
 * these stale statuses therefore does NOT post a second sale or mutate any
 * invoice, voucher, customer balance, cost, or stock movement.
 *
 * Data only. The audit table factory_bale_order_status_repairs and the guard
 * trigger factory_bale_completed_order_stock_guard (which refuses restoring such
 * bales to IN_STOCK) are defined by migrations/0001_baseline_schema.sql.
 */
import type { Pool } from "pg";
import { logger } from "../lib/logger";

export async function repairCompletedOrderBaleStatuses(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    // Exclude any bale also assigned to an unfinished order. Such a conflict
    // needs human review rather than guessing which order owns the bale.
    const repaired = await client.query<{ bale_id: number }>(`
      WITH candidates AS (
        SELECT fb.id, fb.company_id, MIN(co.id) AS completed_order_id
          FROM factory_bales fb
          JOIN customer_order_bales cob ON cob.bale_id = fb.id
          JOIN customer_orders co ON co.id = cob.order_id
         WHERE fb.status = 'IN_STOCK'
           AND fb.deleted_at IS NULL
           AND co.company_id = fb.company_id
           AND co.deleted_at IS NULL
           AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
           AND NOT EXISTS (
             SELECT 1
               FROM customer_order_bales open_cob
               JOIN customer_orders open_order ON open_order.id = open_cob.order_id
              WHERE open_cob.bale_id = fb.id
                AND open_order.company_id = fb.company_id
                AND open_order.deleted_at IS NULL
                AND open_order.status IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
           )
         GROUP BY fb.id, fb.company_id
      ), changed AS (
        UPDATE factory_bales fb
           SET status = 'SOLD', updated_at = NOW()
          FROM candidates c
         WHERE fb.id = c.id
           AND fb.company_id = c.company_id
           AND fb.status = 'IN_STOCK'
           AND fb.deleted_at IS NULL
        RETURNING fb.id, fb.company_id
      ), logged AS (
        INSERT INTO factory_bale_order_status_repairs
          (bale_id, company_id, completed_order_id, old_status, new_status)
        SELECT changed.id, changed.company_id, candidates.completed_order_id, 'IN_STOCK', 'SOLD'
          FROM changed
          JOIN candidates ON candidates.id = changed.id
        ON CONFLICT (bale_id) DO NOTHING
        RETURNING bale_id
      )
      SELECT bale_id FROM logged
    `);
    const conflicts = await client.query<{ count: string }>(`
      SELECT COUNT(DISTINCT fb.id)::text AS count
        FROM factory_bales fb
        JOIN customer_order_bales cob ON cob.bale_id = fb.id
        JOIN customer_orders co ON co.id = cob.order_id
       WHERE fb.status = 'IN_STOCK'
         AND fb.deleted_at IS NULL
         AND co.company_id = fb.company_id
         AND co.deleted_at IS NULL
         AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
    `);
    await client.query("COMMIT");
    const remaining = Number(conflicts.rows[0]?.count ?? 0);
    logger.info(
      `[FactoryBaleIntegrity] Restored completed-order status on ${repaired.rowCount ?? 0} bales; remaining conflicts: ${remaining}`
    );
    if (remaining > 0) {
      logger.warn(`[FactoryBaleIntegrity] ${remaining} bales need manual review (conflicting order links)`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error; // Prevent a new deployment from serving with unreconciled bale statuses.
  } finally {
    client.release();
  }
}

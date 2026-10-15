/**
 * One-time repair for order 207, which was confirmed on 2026-10-13 and then
 * returned to LOADING by the old workflow that cleared loading_finalized_at.
 * Owner-authorized company 12 only; it does not alter accounting or bale state.
 */
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const ENABLE_ENV = "FACTORY_CUSTOMER_RETURNED_LOADING_DATE_REPAIR_20261015";

export async function runApprovedReturnedLoadingDateRepair(pool: Pool): Promise<void> {
  if (process.env[ENABLE_ENV] !== "approved-company-12-order-207") return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT set_config('app.current_company_id', '12', true)");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('customer_loading_date_repair'), 12)");

    await client.query(`CREATE TABLE IF NOT EXISTS factory_customer_returned_loading_date_repair_audit (
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      source_daybook_entry_id INTEGER NOT NULL,
      old_loading_finalized_at TIMESTAMP WITHOUT TIME ZONE,
      new_loading_finalized_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      status_before TEXT NOT NULL,
      repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, order_id)
    )`);

    const existing = await client.query(
      "SELECT new_loading_finalized_at FROM factory_customer_returned_loading_date_repair_audit WHERE company_id=12 AND order_id=207"
    );
    if (existing.rowCount) {
      const check = await client.query(`
        SELECT 1 FROM customer_orders o
        JOIN factory_customer_returned_loading_date_repair_audit a
          ON a.company_id=o.company_id AND a.order_id=o.id
        WHERE o.company_id=12 AND o.id=207
          AND o.loading_finalized_at=a.new_loading_finalized_at`);
      if (check.rowCount !== 1) {
        throw new Error("Order 207 date repair audit exists, but the saved date no longer matches");
      }
      await client.query("COMMIT");
      logger.info("[ReturnedLoadingDateRepair] Order 207 already repaired; no repeat changes");
      return;
    }

    // The earliest recorded LOADING_SUBMITTED event contains the originally
    // selected business date. Do not infer it from latest status or invoice date.
    const eligible = await client.query(`
      SELECT o.id
        FROM customer_orders o
        JOIN factory_daybook_entries fde
          ON fde.company_id=o.company_id AND fde.reference_id=o.id
         AND fde.reference_table='customer_orders'
         AND fde.tx_type='LOADING_SUBMITTED'
        WHERE o.company_id=12 AND o.id=207 AND o.deleted_at IS NULL
          AND o.status='LOADING' AND o.loading_finalized_at IS NULL
          AND fde.id=30945 AND fde.tx_date=DATE '2026-10-13'
          AND NOT EXISTS (
            SELECT 1 FROM factory_daybook_entries earlier
            WHERE earlier.company_id=12
              AND earlier.reference_table='customer_orders'
              AND earlier.reference_id=207
              AND earlier.tx_type='LOADING_SUBMITTED'
              AND (earlier.created_at,earlier.id)<(fde.created_at,fde.id)
          )
      FOR UPDATE OF o`);
    if (eligible.rowCount !== 1) {
      throw new Error("Returned loading date repair refused: order 207 or its original event changed");
    }

    const audit = await client.query(`
      INSERT INTO factory_customer_returned_loading_date_repair_audit
        (company_id,order_id,source_daybook_entry_id,old_loading_finalized_at,
         new_loading_finalized_at,status_before)
      SELECT o.company_id,o.id,30945,o.loading_finalized_at,
             DATE '2026-10-13' + INTERVAL '12 hours',o.status
      FROM customer_orders o
      WHERE o.company_id=12 AND o.id=207 AND o.loading_finalized_at IS NULL
      RETURNING order_id`);
    if (audit.rowCount !== 1) throw new Error("Returned loading date repair backup failed");

    const updated = await client.query(`
      UPDATE customer_orders o
         SET loading_finalized_at=a.new_loading_finalized_at
        FROM factory_customer_returned_loading_date_repair_audit a
       WHERE o.company_id=12 AND o.id=207 AND o.status='LOADING'
         AND o.deleted_at IS NULL AND o.loading_finalized_at IS NULL
         AND a.company_id=o.company_id AND a.order_id=o.id
      RETURNING o.id`);
    if (updated.rowCount !== 1) throw new Error("Returned loading date repair update failed");

    const verified = await client.query(`
      SELECT 1 FROM customer_orders o
      JOIN factory_customer_returned_loading_date_repair_audit a
        ON a.company_id=o.company_id AND a.order_id=o.id
      WHERE o.company_id=12 AND o.id=207
        AND o.loading_finalized_at=a.new_loading_finalized_at`);
    if (verified.rowCount !== 1) throw new Error("Returned loading date repair verification failed");

    await client.query("COMMIT");
    logger.info("[ReturnedLoadingDateRepair] Order 207 repaired to 2026-10-13; status remains LOADING");
  } catch (error) {
    logger.error("[ReturnedLoadingDateRepair] Refused", { error });
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

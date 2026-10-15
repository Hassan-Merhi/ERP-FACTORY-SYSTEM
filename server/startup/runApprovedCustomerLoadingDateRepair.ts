/**
 * Owner-approved one-time repair of historically overwritten loading completion dates.
 * The source of truth is the earliest RECORDED LOADING_SUBMITTED daybook event,
 * whose tx_date is the business date chosen in Validate Loading.
 *
 * Company 12 only. No invoice, journal, verification timestamp, stock, or money edits.
 * Audit records store the exact before/after timestamps for safe reversal.
 * Disabled unless explicitly enabled by a Render environment flag.
 */
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const COMPANY_ID = 12;
const RUN_KEY = "customer-loading-date-20261015-company12-v1";
const ENABLE_ENV = "FACTORY_CUSTOMER_LOADING_DATE_REPAIR_20261015";

// [order ID, first LOADING_SUBMITTED entry ID, currently stored date, originally selected date].
// Every entry was inspected directly in production on 2026-10-15.
const PLAN: ReadonlyArray<readonly [number, number, string, string]> = [
  [129, 19222, "2026-07-23", "2026-07-22"],
  [135, 19637, "2026-07-27", "2026-07-25"],
  [137, 20590, "2026-08-05", "2026-08-03"],
  [140, 20960, "2026-08-10", "2026-08-08"],
  [145, 22082, "2026-08-25", "2026-08-22"],
  [150, 23654, "2026-09-22", "2026-09-01"],
  [152, 21453, "2026-08-17", "2026-08-14"],
  [165, 23739, "2026-09-04", "2026-09-03"],
  [166, 23880, "2026-09-22", "2026-09-04"],
  [169, 26226, "2026-09-17", "2026-09-16"],
  [178, 30508, "2026-10-12", "2026-10-09"],
  [183, 29266, "2026-10-12", "2026-10-05"],
  [185, 27328, "2026-10-13", "2026-09-23"],
  [189, 29343, "2026-10-06", "2026-10-05"],
  [205, 29761, "2026-10-07", "2026-10-06"],
];

export async function runApprovedCustomerLoadingDateRepair(pool: Pool): Promise<void> {
  if (process.env[ENABLE_ENV] !== "approved-company-12-15-orders") return;

  const client = await pool.connect();
  let stage = "begin";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    // Tenant-guarded tables must be accessed in the explicit, approved company.
    await client.query("SELECT set_config('app.current_company_id', '12', true)");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('customer_loading_date_repair'), $1)", [COMPANY_ID]);

    stage = "create-before-image-audit-table";
    // Durable before-image. Must be written in the SAME transaction as the changes.
    await client.query(`CREATE TABLE IF NOT EXISTS factory_customer_loading_date_repair_audit (
      company_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      run_key TEXT NOT NULL,
      source_daybook_entry_id INTEGER NOT NULL,
      old_loading_finalized_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      new_loading_finalized_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
      selected_loading_date DATE NOT NULL,
      old_status TEXT NOT NULL,
      invoice_number TEXT,
      container_number TEXT,
      repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, order_id)
    )`);

    stage = "read-existing-repair";
    const existing = await client.query(
      "SELECT order_id FROM factory_customer_loading_date_repair_audit WHERE company_id = $1 AND run_key = $2",
      [COMPANY_ID, RUN_KEY]
    );
    if (existing.rowCount) {
      if (existing.rowCount !== PLAN.length) {
        throw new Error("Historical loading date repair refused: incomplete/foreign existing audit");
      }
      const verified = await client.query(`
        SELECT count(*)::int AS count
          FROM factory_customer_loading_date_repair_audit a
          JOIN customer_orders o ON o.id = a.order_id AND o.company_id = a.company_id
         WHERE a.company_id = $1 AND a.run_key = $2
           AND o.loading_finalized_at = a.new_loading_finalized_at`,
        [COMPANY_ID, RUN_KEY]
      );
      if (verified.rows[0]?.count !== PLAN.length) {
        throw new Error("Historical loading date repair refused: audit exists but saved dates were altered");
      }
      await client.query("COMMIT");
      logger.info("[CustomerLoadingDateRepair] Already applied and verified; no repeated changes");
      return;
    }

    stage = "create-temporary-plan";
    await client.query(`CREATE TEMP TABLE customer_loading_date_plan (
      order_id INTEGER PRIMARY KEY,
      daybook_entry_id INTEGER NOT NULL,
      expected_old_date DATE NOT NULL,
      selected_date DATE NOT NULL
    ) ON COMMIT DROP`);
    const placeholders = PLAN.map(
      (_, index) =>
        `(${index * 4 + 1}::integer, ${index * 4 + 2}::integer, ${index * 4 + 3}::date, ${index * 4 + 4}::date)`
    ).join(", ");
    stage = "insert-fifteen-plan-rows";
    await client.query(
      `INSERT INTO customer_loading_date_plan (order_id, daybook_entry_id, expected_old_date, selected_date)
       VALUES ${placeholders}`,
      PLAN.flatMap((row) => [...row])
    );

    // Lock all orders, then verify company, status, unchanged previous value,
    // referenced event, selected date, and EARLIEST RECORDED event (not MIN tx_date).
    stage = "lock-and-validate-first-events";
    const locked = await client.query(`
      SELECT o.id
        FROM customer_loading_date_plan p
        JOIN customer_orders o ON o.id = p.order_id AND o.company_id = 12
        JOIN factory_daybook_entries fde
          ON fde.id = p.daybook_entry_id AND fde.company_id = o.company_id
         AND fde.reference_table = 'customer_orders' AND fde.reference_id = o.id
         AND fde.tx_type = 'LOADING_SUBMITTED' AND fde.tx_date = p.selected_date
       WHERE o.deleted_at IS NULL AND o.status IN ('VERIFIED', 'FINALIZED')
         AND o.loading_finalized_at::date = p.expected_old_date
         AND NOT EXISTS (
           SELECT 1 FROM factory_daybook_entries older
            WHERE older.company_id = o.company_id
              AND older.reference_table = 'customer_orders'
              AND older.reference_id = o.id
              AND older.tx_type = 'LOADING_SUBMITTED'
              AND (older.created_at, older.id) < (fde.created_at, fde.id)
         )
       ORDER BY o.id
       FOR UPDATE OF o`);
    if (locked.rowCount !== PLAN.length) {
      throw new Error(
        `Historical loading date repair refused: preflight matched ${locked.rowCount}/${PLAN.length} orders`
      );
    }

    stage = "persist-before-after-audit";
    const audit = await client.query(`
      INSERT INTO factory_customer_loading_date_repair_audit
        (company_id, order_id, run_key, source_daybook_entry_id,
         old_loading_finalized_at, new_loading_finalized_at,
         selected_loading_date, old_status, invoice_number, container_number)
      SELECT o.company_id, o.id, $1, p.daybook_entry_id,
             o.loading_finalized_at, p.selected_date::timestamp + INTERVAL '12 hours',
             p.selected_date, o.status, o.invoice_number, o.container_number
        FROM customer_loading_date_plan p
        JOIN customer_orders o ON o.company_id = 12 AND o.id = p.order_id
      RETURNING order_id`, [RUN_KEY]);
    if (audit.rowCount !== PLAN.length) {
      throw new Error("Historical loading date repair refused: incomplete before-image");
    }

    stage = "update-confirmed-loading-dates";
    const updated = await client.query(`
      UPDATE customer_orders o
         SET loading_finalized_at = a.new_loading_finalized_at
        FROM factory_customer_loading_date_repair_audit a
       WHERE o.company_id = 12
         AND o.id = a.order_id AND a.company_id = o.company_id
         AND a.run_key = $1
         AND o.loading_finalized_at = a.old_loading_finalized_at
      RETURNING o.id`, [RUN_KEY]);
    if (updated.rowCount !== PLAN.length) {
      throw new Error("Historical loading date repair refused: incomplete update");
    }

    stage = "verify-persisted-dates";
    const verified = await client.query(`
      SELECT count(*)::int AS count
        FROM factory_customer_loading_date_repair_audit a
        JOIN customer_orders o ON o.id = a.order_id AND o.company_id = a.company_id
       WHERE a.company_id = 12 AND a.run_key = $1
         AND o.loading_finalized_at = a.new_loading_finalized_at`, [RUN_KEY]);
    if (verified.rows[0]?.count !== PLAN.length) {
      throw new Error("Historical loading date repair refused: verification failed");
    }

    await client.query("COMMIT");
    logger.info(
      `[CustomerLoadingDateRepair] Applied ${PLAN.length} audited dates to company 12; accounting and balances untouched`
    );
  } catch (error) {
    logger.error(`[CustomerLoadingDateRepair] Refused at stage ${stage}`, { error });
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

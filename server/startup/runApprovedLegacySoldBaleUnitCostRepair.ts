/**
 * One-time, explicitly gated follow-up to runApprovedLegacyBaleUnitCostRepair
 * (issue #2238): the same legacy stock-entry bug used the product's price PER
 * BALE as a price PER KILOGRAM. The 2026-10-14 run corrected unsold stock only;
 * the owner has since asked (2026-10-17) for the remaining historical bales —
 * sold ones included — to show the corrected cost in place of the old one.
 *
 * Scope: company 12, no-mix bales in SOLD / AVAILABLE / DELETED status that
 * exactly match the legacy signature (cost_per_kg = per-bale production price
 * and total_cost = weight_kg * cost_per_kg). Only factory_bales.cost_per_kg and
 * total_cost are overwritten: sale prices, invoices, orders and journals are
 * untouched. Company 12 has no inventory GL cutover, so these stored costs have
 * no posted ledger effect; refuse if that ever changes.
 *
 * Every before/after row goes to factory_legacy_bale_cost_repairs (internal
 * rollback record, not shown in the UI) and one factory_bale_recost_runs row
 * captures the plan. Set the flag to `preview-company-12` to log the plan and
 * roll back, or `approved-company-12` to apply. Repeat runs are no-ops.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const COMPANY_ID = 12;
const RUN_TYPE = "legacy-sold-bale-per-bale-price-repair-20261017-v1";
const ENABLE_ENV = "FACTORY_LEGACY_SOLD_BALE_COST_REPAIR_20261017";
// Read-only production audit on 2026-10-17: 28,437 SOLD + 111 DELETED + 1 AVAILABLE.
const MAX_ROWS = 28549;
const MAX_VALUE_CHANGE = 42204434.5;

type Totals = { total: string; difference: string };

// Startup-only operator diagnostics (logged on boot, never shown in the UI).
const refused = (reason: string): Error => new Error([RUN_TYPE, "refused", reason].join(" "));

export async function runApprovedLegacySoldBaleUnitCostRepair(pool: Pool): Promise<void> {
  const mode = process.env[ENABLE_ENV];
  if (mode !== "approved-company-12" && mode !== "preview-company-12") return;
  const preview = mode === "preview-company-12";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(COMPANY_ID)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('factory_bale_recost'), $1)", [COMPANY_ID]);

    const [existing] = (
      await client.query<{ id: number }>(
        "SELECT id FROM factory_bale_recost_runs WHERE company_id=$1 AND plan->>'repairType'=$2 LIMIT 1",
        [COMPANY_ID, RUN_TYPE]
      )
    ).rows;
    if (existing) {
      await client.query("COMMIT");
      logger.info("[LegacySoldBaleUnitCost] Already applied; no repeat changes");
      return;
    }
    const cutover = await client.query("SELECT 1 FROM gl_inventory_cutovers WHERE company_id=$1 LIMIT 1", [COMPANY_ID]);
    if (cutover.rowCount) {
      throw refused("inventory GL cutover exists; costs now affect the ledger");
    }

    await client.query(`
      CREATE TEMP TABLE legacy_sold_bale_cost_candidates ON COMMIT DROP AS
      SELECT b.id AS bale_id, b.company_id, b.article_code, b.reference_number,
             b.status AS old_status, b.weight_kg,
             b.cost_per_kg AS old_cost_per_kg, b.total_cost AS old_total_cost,
             p.production_price::numeric(20,7) AS new_total_cost,
             ROUND(p.production_price / b.weight_kg, 7) AS new_cost_per_kg
        FROM factory_bales b
        JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = b.company_id
       WHERE b.company_id = 12
         AND b.deleted_at IS NULL
         AND b.mix_batch_id IS NULL
         AND b.status IN ('SOLD', 'AVAILABLE', 'DELETED')
         AND p.deleted_at IS NULL
         AND p.production_price > 0
         AND b.weight_kg > 1
         AND ABS(b.cost_per_kg - p.production_price) < 0.001
         AND ABS(b.total_cost - b.cost_per_kg * b.weight_kg) < 0.01
         AND b.total_cost > p.production_price + 0.01
         AND NOT EXISTS (SELECT 1 FROM factory_legacy_bale_cost_repairs r WHERE r.bale_id = b.id)
    `);
    const [totals] = (
      await client.query<Totals>(`
      SELECT COUNT(*)::text AS total,
             COALESCE(SUM(old_total_cost - new_total_cost),0)::text AS difference
        FROM legacy_sold_bale_cost_candidates
    `)
    ).rows;
    const count = Number(totals.total);
    const delta = Number(totals.difference);
    if (count === 0) {
      await client.query("COMMIT");
      logger.info("[LegacySoldBaleUnitCost] No matching bales; no changes applied");
      return;
    }
    if (count > MAX_ROWS || delta <= 0 || delta > MAX_VALUE_CHANGE + 0.01) {
      throw refused(`scope grew unexpectedly (${count} bales, USD ${delta})`);
    }

    const byStatus = (
      await client.query<{ old_status: string; n: string; diff: string }>(`
      SELECT old_status, COUNT(*)::text AS n, SUM(old_total_cost - new_total_cost)::text AS diff
        FROM legacy_sold_bale_cost_candidates GROUP BY old_status ORDER BY old_status
    `)
    ).rows;
    const summary = byStatus.map((r) => `${r.old_status}=${r.n} (USD ${Number(r.diff).toFixed(2)})`).join(", ");

    if (preview) {
      await client.query("ROLLBACK");
      logger.info(
        `[LegacySoldBaleUnitCost] PREVIEW only: ${count} bales, stored cost lowered by USD ${delta.toFixed(2)} [${summary}]; nothing written`
      );
      return;
    }

    // Lock the candidates and re-check their old values; any concurrent change
    // rolls the whole run back rather than applying a partial repair.
    const locked = await client.query(`
      SELECT b.id
        FROM factory_bales b
        JOIN legacy_sold_bale_cost_candidates c ON c.bale_id=b.id
       WHERE b.status = c.old_status
         AND b.cost_per_kg = c.old_cost_per_kg
         AND b.total_cost = c.old_total_cost
         AND b.weight_kg = c.weight_kg
       ORDER BY b.id FOR UPDATE OF b
    `);
    if (locked.rowCount !== count) {
      throw refused("a bale changed during review");
    }

    const beforeAfter = await client.query(`
      INSERT INTO factory_legacy_bale_cost_repairs (
        bale_id,company_id,article_code,reference_number,old_status,weight_kg,
        old_cost_per_kg,new_cost_per_kg,old_total_cost,new_total_cost
      )
      SELECT bale_id,company_id,article_code,reference_number,old_status,weight_kg,
             old_cost_per_kg,new_cost_per_kg,old_total_cost,new_total_cost
        FROM legacy_sold_bale_cost_candidates
      RETURNING bale_id
    `);
    if (beforeAfter.rowCount !== count) {
      throw refused("audit row count does not match plan");
    }
    const updated = await client.query(`
      UPDATE factory_bales b
         SET cost_per_kg = c.new_cost_per_kg,
             total_cost = c.new_total_cost,
             updated_at = NOW()
        FROM legacy_sold_bale_cost_candidates c
       WHERE b.id = c.bale_id
         AND b.company_id=12
         AND b.status = c.old_status
         AND b.cost_per_kg = c.old_cost_per_kg
         AND b.total_cost = c.old_total_cost
      RETURNING b.id
    `);
    if (updated.rowCount !== count) {
      throw refused("applied row count does not match plan");
    }

    const fingerprint = createHash("sha256")
      .update(`${RUN_TYPE}:${count}:${delta.toFixed(2)}`)
      .digest("hex");
    const [run] = (
      await client.query<{ id: number }>(
        `
      INSERT INTO factory_bale_recost_runs (company_id,plan_hash,plan,applied_by)
      SELECT 12, $1,
        jsonb_build_object(
          'repairType', $2::text,
          'approvedBy', 'owner-requested-2026-10-17',
          'perpetual', false,
          'eligibleCount', $3::int,
          'finishedChange', $4::numeric * -1
        ),
        'owner-requested-2026-10-17'
      RETURNING id
    `,
        [fingerprint, RUN_TYPE, count, delta]
      )
    ).rows;
    await client.query(
      "UPDATE factory_legacy_bale_cost_repairs SET repair_run_id=$1 WHERE company_id=12 AND repair_run_id IS NULL AND bale_id IN (SELECT bale_id FROM legacy_sold_bale_cost_candidates)",
      [run.id]
    );

    await client.query("COMMIT");
    logger.info(
      `[LegacySoldBaleUnitCost] Applied audit run ${run.id}: ${count} bales, stored cost lowered by USD ${delta.toFixed(2)} [${summary}]; sale prices, invoices and journals untouched`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error; // Never let production boot after a partial monetary repair.
  } finally {
    client.release();
  }
}

/**
 * One-time, explicitly gated reconciliation for the legacy stock-entry bug
 * that used the product's price PER BALE as a price PER KILOGRAM.
 *
 * Scope: company 12, unsold/no-mix factory bales only, exactly matching
 * historic total_cost = weight_kg * cost_per_kg and the current catalog's
 * per-bale production price. Never touches sold bales, invoices or journals.
 * This company has not cut over to perpetual inventory; refuse otherwise.
 *
 * All before/after rows are preserved in factory_legacy_bale_cost_repairs,
 * and a single factory_bale_recost_runs entry captures the immutable plan.
 * The run is one-time even if the environment flag is left enabled.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const COMPANY_ID = 12;
const RUN_TYPE = "legacy-bale-per-bale-price-repair-20261014-v1";
const ENABLE_ENV = "FACTORY_LEGACY_BALE_UNIT_COST_REPAIR_20261014";
const MAX_ROWS = 3312;
const MAX_VALUE_CHANGE = 3996608.00;

type Totals = { total: string; difference: string };
type ChangedRow = { id: number };

export async function runApprovedLegacyBaleUnitCostRepair(pool: Pool): Promise<void> {
  if (process.env[ENABLE_ENV] !== "approved-company-12") return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query("SET LOCAL statement_timeout = '180s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('factory_bale_recost'), $1)",
      [COMPANY_ID]
    );
    await client.query("SELECT erp_assert_accounting_date_open($1, CURRENT_DATE)", [COMPANY_ID]);

    const [existing] = (await client.query<{ id: number }>(
      "SELECT id FROM factory_bale_recost_runs WHERE company_id=$1 AND plan->>'repairType'=$2 LIMIT 1",
      [COMPANY_ID, RUN_TYPE]
    )).rows;
    if (existing) {
      await client.query("COMMIT");
      logger.info("[LegacyBaleUnitCost] Already applied; no repeat changes");
      return;
    }
    const cutover = await client.query(
      "SELECT 1 FROM gl_inventory_cutovers WHERE company_id=$1 LIMIT 1", [COMPANY_ID]
    );
    if (cutover.rowCount) {
      throw new Error("Legacy unit-cost repair refused: inventory GL cutover exists; use reviewed journal-posted recost");
    }

    await client.query(`
      CREATE TEMP TABLE legacy_bale_cost_candidates ON COMMIT DROP AS
      SELECT b.id AS bale_id, b.company_id, b.article_code, b.reference_number,
             b.product_id, b.status AS old_status, b.weight_kg,
             b.cost_per_kg AS old_cost_per_kg, b.total_cost AS old_total_cost,
             p.production_price::numeric(20,7) AS new_total_cost,
             ROUND(p.production_price / b.weight_kg, 7) AS new_cost_per_kg
        FROM factory_bales b
        JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = b.company_id
       WHERE b.company_id = 12
         AND b.deleted_at IS NULL
         AND b.mix_batch_id IS NULL
         AND b.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
         AND p.deleted_at IS NULL
         AND p.production_price > 0
         AND b.weight_kg > 1
         AND ABS(b.cost_per_kg - p.production_price) < 0.001
         AND ABS(b.total_cost - b.cost_per_kg * b.weight_kg) < 0.01
         AND b.total_cost > p.production_price + 0.01
         AND NOT EXISTS (
           SELECT 1
             FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id
              AND co.company_id = b.company_id
              AND co.deleted_at IS NULL
              AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
         )
    `);
    const [totals] = (await client.query<Totals>(`
      SELECT COUNT(*)::text AS total,
             COALESCE(SUM(old_total_cost - new_total_cost),0)::text AS difference
        FROM legacy_bale_cost_candidates
    `)).rows;
    const count = Number(totals.total);
    const delta = Number(totals.difference);
    if (count === 0) {
      await client.query("COMMIT");
      logger.info("[LegacyBaleUnitCost] No matching stock bales; no changes applied");
      return;
    }
    if (count > MAX_ROWS || delta <= 0 || delta > MAX_VALUE_CHANGE + 0.01) {
      throw new Error(`Legacy unit-cost repair refused: scope grew unexpectedly (${count} bales, USD ${delta})`);
    }

    // Lock the candidates and re-check all their old monetary values before
    // making any change. A concurrent sale, weight edit, or product movement
    // causes an all-or-nothing rollback, never a partial repair.
    const locked = await client.query<ChangedRow>(`
      SELECT b.id
        FROM factory_bales b
        JOIN legacy_bale_cost_candidates c ON c.bale_id=b.id
       WHERE b.status = c.old_status
         AND b.cost_per_kg = c.old_cost_per_kg
         AND b.total_cost = c.old_total_cost
         AND b.weight_kg = c.weight_kg
       ORDER BY b.id FOR UPDATE OF b
    `);
    if (locked.rowCount !== count) {
      throw new Error("Legacy unit-cost repair refused: a bale changed during review");
    }
    const ordersNow = await client.query(`
      SELECT 1 FROM legacy_bale_cost_candidates c
      JOIN customer_order_bales cob ON cob.bale_id=c.bale_id
      JOIN customer_orders o ON o.id=cob.order_id
       WHERE o.company_id=12 AND o.deleted_at IS NULL
         AND o.status IN ('FINALIZED','DISPATCHED','SOLD','INVOICED','COMPLETED')
      LIMIT 1
    `);
    if (ordersNow.rowCount) {
      throw new Error("Legacy unit-cost repair refused: candidate was assigned to a completed order");
    }

    const duplicates = await client.query(`
      SELECT 1 FROM factory_legacy_bale_cost_repairs r
      JOIN legacy_bale_cost_candidates c ON c.bale_id=r.bale_id LIMIT 1
    `);
    if (duplicates.rowCount) {
      throw new Error("Legacy unit-cost repair refused: previously repaired bale was selected again");
    }

    const beforeAfter = await client.query(`
      INSERT INTO factory_legacy_bale_cost_repairs (
        bale_id,company_id,article_code,reference_number,old_status,weight_kg,
        old_cost_per_kg,new_cost_per_kg,old_total_cost,new_total_cost
      )
      SELECT bale_id,company_id,article_code,reference_number,old_status,weight_kg,
             old_cost_per_kg,new_cost_per_kg,old_total_cost,new_total_cost
        FROM legacy_bale_cost_candidates
      RETURNING bale_id
    `);
    if (beforeAfter.rowCount !== count) {
      throw new Error("Legacy unit-cost repair refused: audit row count does not match plan");
    }
    const updated = await client.query(`
      UPDATE factory_bales b
         SET cost_per_kg = c.new_cost_per_kg,
             total_cost = c.new_total_cost,
             updated_at = NOW()
        FROM legacy_bale_cost_candidates c
       WHERE b.id = c.bale_id
         AND b.company_id=12
         AND b.status = c.old_status
         AND b.cost_per_kg = c.old_cost_per_kg
         AND b.total_cost = c.old_total_cost
      RETURNING b.id
    `);
    if (updated.rowCount !== count) {
      throw new Error("Legacy unit-cost repair refused: applied row count does not match plan");
    }

    const fingerprint = createHash("sha256")
      .update(`${RUN_TYPE}:${count}:${delta.toFixed(2)}`)
      .digest("hex");
    const [run] = (await client.query<{ id: number }>(`
      INSERT INTO factory_bale_recost_runs (company_id,plan_hash,plan,applied_by)
      SELECT 12, $1,
        jsonb_build_object(
          'repairType', $2::text,
          'approvedBy', 'owner-requested-2026-10-14',
          'perpetual', false,
          'eligibleCount', $3::int,
          'finishedChange', $4::numeric * -1,
          'bales', (SELECT jsonb_agg(jsonb_build_object(
            'baleId',bale_id,'referenceNumber',reference_number,'articleCode',article_code,
            'oldStatus',old_status,'weightKg',weight_kg,
            'oldCostPerKg',old_cost_per_kg,'newCostPerKg',new_cost_per_kg,
            'oldTotalCost',old_total_cost,'newTotalCost',new_total_cost
          ) ORDER BY bale_id) FROM legacy_bale_cost_candidates)
        ),
        'owner-requested-2026-10-14'
      RETURNING id
    `, [fingerprint,RUN_TYPE,count,delta])).rows;
    await client.query(
      "UPDATE factory_legacy_bale_cost_repairs SET repair_run_id=$1 WHERE company_id=12 AND repair_run_id IS NULL AND bale_id IN (SELECT bale_id FROM legacy_bale_cost_candidates)",
      [run.id]
    );

    await client.query("COMMIT");
    logger.info(`[LegacyBaleUnitCost] Applied audit run ${run.id}: ${count} unsold no-mix bales; stock cost corrected downward USD ${delta.toFixed(2)}; sold bales and posted invoices untouched`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error; // Do not replace production with an unreviewed partial accounting repair.
  } finally {
    client.release();
  }
}

/**
 * Owner-approved 2026-10-26 one-time Factory destination cleanup.
 * Company 12, customer 23 only. No accounting or voucher data is changed.
 * Disabled until the production Render opt-in flag is set.
 */
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const ENV = "ERP_FACTORY_DESTINATION_NORMALIZE_20261026";
const OPT_IN = "approved-company12-customer23";
const RUN_KEY = "company12-customer23-lshi-normalization-20261026-v1";
const TARGET = "L'SHI";
const COMPANY = 12;
const CUSTOMER = 23;
const PLAN: ReadonlyArray<readonly [number, string]> = [
  [14, "LUBUMBASHI"], [32, "LUBUMBASHI"],
  [35, "LUBUMBASHI"], [46, "LUBUMBASHI"],
  [51, "LUBUMBASHI"], [61, "LUBUMBASHI"],
  [74, "LUBUMBASHI"], [83, "LUBUMBASHI"],
  [100, "L’SHI"], [189, "LSHI"],
];
const expected = new Map<number, string>(PLAN);

export async function runApprovedFactoryDestinationNormalization(pool: Pool): Promise<void> {
  if (process.env[ENV] !== OPT_IN) return;
  if (process.env.RENDER_SERVICE_ID !== "srv-d6kibgtactks739u7vl0") {
    throw new Error("Destination repair refused: wrong Render service");
  }
  const database = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (database.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
    throw new Error("Destination repair refused: wrong database");
  }
  const client = await pool.connect();
  let stage = "begin";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(COMPANY)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [RUN_KEY]);

    stage = "audit-table";
    await client.query("CREATE TABLE IF NOT EXISTS factory_destination_normalization_audit (company_id integer NOT NULL, customer_id integer NOT NULL, order_id integer NOT NULL, run_key text NOT NULL, old_destination text NOT NULL, new_destination text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_id, order_id, run_key))");
    const auditQuery = "SELECT a.order_id,a.old_destination,a.new_destination,o.destination AS current_destination FROM factory_destination_normalization_audit a LEFT JOIN customer_orders o ON o.id=a.order_id AND o.company_id=a.company_id WHERE a.company_id=$1 AND a.customer_id=$2 AND a.run_key=$3";
    const prior = await client.query<{ order_id: number; old_destination: string; new_destination: string; current_destination: string }>(
      auditQuery, [COMPANY, CUSTOMER, RUN_KEY]
    );
    if (prior.rowCount) {
      if (prior.rowCount !== PLAN.length || prior.rows.some(row =>
        expected.get(row.order_id) !== row.old_destination ||
        row.new_destination !== TARGET || row.current_destination !== TARGET
      )) throw new Error("Destination repair refused: existing audit mismatch");
      await client.query("COMMIT");
      logger.info("[FactoryDestinationNormalization] Existing 10-row audit verified; no-op");
      return;
    }

    stage = "preflight";
    const before = await client.query<{ id: number; customer_id: number; destination: string; status: string }>(
      "SELECT id,customer_id,destination,status FROM customer_orders WHERE company_id=$1 AND deleted_at IS NULL AND upper(btrim(destination)) IN ('LUBUMBASHI','LSHI','L’SHI') ORDER BY id FOR UPDATE",
      [COMPANY]
    );
    if (before.rowCount !== PLAN.length || before.rows.some(row =>
      row.customer_id !== CUSTOMER || row.status !== "FINALIZED" ||
      expected.get(row.id) !== row.destination
    )) throw new Error("Destination repair refused: data changed since preflight");

    stage = "before-image";
    const ids = PLAN.map(([id]) => id);
    const added = await client.query(
      "INSERT INTO factory_destination_normalization_audit (company_id,customer_id,order_id,run_key,old_destination,new_destination) SELECT company_id,customer_id,id,$3,destination,$4 FROM customer_orders WHERE company_id=$1 AND customer_id=$2 AND id=ANY($5::integer[]) AND deleted_at IS NULL RETURNING order_id",
      [COMPANY, CUSTOMER, RUN_KEY, TARGET, ids]
    );
    if (added.rowCount !== PLAN.length) throw new Error("Destination repair refused: audit incomplete");

    stage = "update";
    const updated = await client.query(
      "UPDATE customer_orders o SET destination=$4,updated_at=now() FROM factory_destination_normalization_audit a WHERE o.company_id=$1 AND o.customer_id=$2 AND o.id=a.order_id AND a.company_id=o.company_id AND a.customer_id=o.customer_id AND a.run_key=$3 AND o.destination=a.old_destination AND o.deleted_at IS NULL RETURNING o.id",
      [COMPANY, CUSTOMER, RUN_KEY, TARGET]
    );
    if (updated.rowCount !== PLAN.length) throw new Error("Destination repair refused: update incomplete");

    stage = "verify";
    const verification = await client.query<{ changed: number; remaining: number }>(
      "SELECT (SELECT count(*)::int FROM customer_orders o JOIN factory_destination_normalization_audit a ON a.order_id=o.id AND a.company_id=o.company_id WHERE a.company_id=$1 AND a.customer_id=$2 AND a.run_key=$3 AND o.destination=$4) AS changed, (SELECT count(*)::int FROM customer_orders WHERE company_id=$1 AND deleted_at IS NULL AND upper(btrim(destination)) IN ('LUBUMBASHI','LSHI','L’SHI')) AS remaining",
      [COMPANY, CUSTOMER, RUN_KEY, TARGET]
    );
    if (verification.rows[0]?.changed !== PLAN.length || verification.rows[0]?.remaining !== 0) {
      throw new Error("Destination repair refused: post-update verification failed");
    }
    await client.query("COMMIT");
    logger.info("[FactoryDestinationNormalization] Updated and verified 10 Factory customer destinations");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error("[FactoryDestinationNormalization] Rolled back", { stage, error });
    throw error;
  } finally {
    client.release();
  }
}

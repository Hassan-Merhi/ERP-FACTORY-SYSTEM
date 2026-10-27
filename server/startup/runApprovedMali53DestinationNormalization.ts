/**
 * Owner-approved one-time Factory customer destination normalization:
 * "MALI 53" -> "MALI" for finalized container SEKU4476196.
 *
 * Original posted amounts, ledgers, invoice references, and cancelled order
 * 173 ("MALI / 53") stay untouched. Change is reversible from before-image audit.
 * Disabled until the exact production Render environment opt-in is set.
 */
import type { Pool } from "pg";
import { logger } from "../lib/logger";

const ENV = "ERP_FACTORY_MALI53_NORMALIZE_20261026";
const ENABLE = "approved-company12-order177";
const RUN_KEY = "factory-company12-order177-mali53-20261026";
const COMPANY_ID = 12;
const CUSTOMER_ID = 23;
const ORDER_ID = 177;
const CONTAINER = "SEKU4476196";
const INVOICE = "INV-011950";
const ORIGINAL = "MALI 53";
const CANONICAL = "MALI";

export async function runApprovedMali53DestinationNormalization(pool: Pool): Promise<void> {
  if (process.env[ENV] !== ENABLE) return;
  if (process.env.RENDER_SERVICE_ID !== "srv-d6kibgtactks739u7vl0") {
    throw new Error("MALI 53 destination repair: wrong Render service");
  }
  const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (identity.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
    throw new Error("MALI 53 destination repair: wrong database");
  }

  const client = await pool.connect();
  let step = "begin";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(COMPANY_ID)]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [RUN_KEY]);

    step = "audit";
    await client.query(
      "CREATE TABLE IF NOT EXISTS factory_destination_normalization_audit (company_id integer NOT NULL, customer_id integer NOT NULL, order_id integer NOT NULL, run_key text NOT NULL, old_destination text NOT NULL, new_destination text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_id, order_id, run_key))"
    );
    const previouslyApplied = await client.query<{
      old_destination: string;
      new_destination: string;
      destination: string;
    }>(
      "SELECT a.old_destination, a.new_destination, o.destination FROM factory_destination_normalization_audit a JOIN customer_orders o ON o.id=a.order_id AND o.company_id=a.company_id AND o.customer_id=a.customer_id WHERE a.company_id=$1 AND a.customer_id=$2 AND a.order_id=$3 AND a.run_key=$4",
      [COMPANY_ID, CUSTOMER_ID, ORDER_ID, RUN_KEY]
    );
    if (previouslyApplied.rowCount) {
      const a = previouslyApplied.rows[0];
      if (previouslyApplied.rowCount !== 1 || a.old_destination !== ORIGINAL ||
        a.new_destination !== CANONICAL || a.destination !== CANONICAL) {
        throw new Error("MALI 53 destination repair: existing audit does not match");
      }
      await client.query("COMMIT");
      logger.info("[FactoryMali53Destination] Already applied; verified canonical MALI");
      return;
    }

    step = "lock-preflight";
    // Fail closed if any *other* active order in the same company uses these
    // spellings: a future record must never be silently left inconsistent.
    const rows = await client.query<{
      id: number;
      customer_id: number;
      container_number: string;
      invoice_number: string;
      status: string;
      destination: string;
    }>(
      "SELECT id, customer_id, container_number, invoice_number, status, destination FROM customer_orders WHERE company_id=$1 AND deleted_at IS NULL AND btrim(destination) IN ('MALI 53', 'MALI / 53') ORDER BY id FOR UPDATE",
      [COMPANY_ID]
    );
    if (rows.rowCount !== 1 || rows.rows[0].id !== ORDER_ID ||
      rows.rows[0].customer_id !== CUSTOMER_ID ||
      rows.rows[0].container_number !== CONTAINER ||
      rows.rows[0].invoice_number !== INVOICE ||
      rows.rows[0].status !== "FINALIZED" ||
      rows.rows[0].destination !== ORIGINAL) {
      throw new Error("MALI 53 destination repair: active order preflight mismatch");
    }

    step = "audit-original";
    const audit = await client.query(
      "INSERT INTO factory_destination_normalization_audit (company_id,customer_id,order_id,run_key,old_destination,new_destination) SELECT company_id,customer_id,id,$4,destination,$5 FROM customer_orders WHERE company_id=$1 AND customer_id=$2 AND id=$3 AND deleted_at IS NULL AND destination=$6 RETURNING order_id",
      [COMPANY_ID, CUSTOMER_ID, ORDER_ID, RUN_KEY, CANONICAL, ORIGINAL]
    );
    if (audit.rowCount !== 1) throw new Error("MALI 53 destination repair: audit write mismatch");

    step = "update";
    const update = await client.query(
      "UPDATE customer_orders SET destination=$4,updated_at=now() WHERE company_id=$1 AND customer_id=$2 AND id=$3 AND destination=$5 AND deleted_at IS NULL RETURNING id",
      [COMPANY_ID, CUSTOMER_ID, ORDER_ID, CANONICAL, ORIGINAL]
    );
    if (update.rowCount !== 1) throw new Error("MALI 53 destination repair: update write mismatch");

    step = "postcheck";
    const check = await client.query<{ canonical: number; variants: number }>(
      "SELECT (SELECT count(*)::integer FROM customer_orders WHERE company_id=$1 AND customer_id=$2 AND id=$3 AND destination=$4 AND deleted_at IS NULL) AS canonical, (SELECT count(*)::integer FROM customer_orders WHERE company_id=$1 AND deleted_at IS NULL AND btrim(destination) IN ('MALI 53', 'MALI / 53')) AS variants",
      [COMPANY_ID, CUSTOMER_ID, ORDER_ID, CANONICAL]
    );
    if (check.rows[0]?.canonical !== 1 || check.rows[0]?.variants !== 0) {
      throw new Error("MALI 53 destination repair: verification failed");
    }
    await client.query("COMMIT");
    logger.info("[FactoryMali53Destination] Corrected and audited order 177 destination MALI 53 -> MALI");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error("[FactoryMali53Destination] Atomic change rolled back", { step, error });
    throw error;
  } finally {
    client.release();
  }
}

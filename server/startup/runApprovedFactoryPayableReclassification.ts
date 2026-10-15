/**
 * Owner-authorized, one-time company-12 payable reclassification.
 * Disabled on all normal deployments. The Render production service may run
 * exactly the 18 reviewed vouchers only after its explicit opt-in value is set.
 *
 * To disable after confirming posted journals:
 * FACTORY_IMPORT_PAYABLE_RECLASS_20261015=disabled
 */
import { pool } from "../db";
import { logger } from "../lib/logger";

const ENABLE_ENV = "FACTORY_IMPORT_PAYABLE_RECLASS_20261015";
const APPROVED_VALUE = "approved-company-12-18-vouchers";
const PRODUCTION_SERVICE_ID = "srv-d6kibgtactks739u7vl0";
const PRODUCTION_DATABASE_NAME = "erp_db_qscj_64lv_e7rz_8744_2lm3";

export async function runApprovedFactoryPayableReclassification(): Promise<void> {
  if (process.env[ENABLE_ENV] !== APPROVED_VALUE) return;

  // Fail closed: neither the development DB nor the historical reference copy
  // is an eligible repair destination.
  if (process.env.RENDER_SERVICE_ID !== PRODUCTION_SERVICE_ID) {
    throw new Error("FPR_BAD_SVC");
  }
  const target = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (target.rows[0]?.name !== PRODUCTION_DATABASE_NAME) {
    throw new Error("FPR_BAD_DB");
  }

  const { reclassifyFactoryImportPayables20261015 } = await import(
    "../../scripts/reclassify-factory-import-payables-20261015"
  );
  const result = await reclassifyFactoryImportPayables20261015(true);
  if (result.inspected !== 18 || result.pending !== 0) {
    throw new Error("FPR_RESULT");
  }
  logger.info("FPR_APPLIED", {
    inspected: result.inspected,
    postedNow: result.posted,
  });
}

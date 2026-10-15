/** Disabled unless explicitly previewing or applying the nine-transaction owner-verified JABER correction. */
import { pool } from "../db";
import { logger } from "../lib/logger";

export async function runApprovedAboJaberPayableFix(): Promise<void> {
  const mode = process.env.FACTORY_ABO_JABER_REASSIGN_20261015;
  const apply = mode === "approved-company12-nine-jaber";
  if (!apply && mode !== "preview-company12-nine-jaber") return;
  if (process.env.RENDER_SERVICE_ID !== "srv-d6kibgtactks739u7vl0") {
    throw new Error("jaber_reassign_wrong_service");
  }
  const result = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (result.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
    throw new Error("jaber_reassign_wrong_database");
  }
  const { repairAboJaberSupplierAttribution } =
    await import("../../scripts/repair-abo-jaber-supplier-attribution-20261015");
  const report = await repairAboJaberSupplierAttribution(apply);
  if (
    report.checked !== 9 ||
    (apply && (report.pending !== 0 || report.balanceEur !== "0.00")) ||
    (!apply && ![0, 9].includes(report.pending))
  ) {
    throw new Error("jaber_reassign_validation_failed");
  }
  logger.info(apply ? "JABER_REASSIGN_VERIFIED" : "JABER_REASSIGN_PREVIEW", report);
}

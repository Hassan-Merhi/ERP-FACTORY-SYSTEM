/** Audited, disabled-by-default reversal of Oct 15 company-12 party transfers. */
import { pool } from "../db";
import { logger } from "../lib/logger";

export async function runApprovedFactoryPayableUndo(): Promise<void> {
  const mode = process.env.FACTORY_IMPORT_PAYABLE_UNDO_20261015;
  const apply = mode === "approved-company12-reverse-18";
  if (!apply && mode !== "preview-company12-reverse-18") return;
  if (process.env.RENDER_SERVICE_ID !== "srv-d6kibgtactks739u7vl0") {
    throw new Error("FPR_UNDO_WRONG_SERVICE");
  }
  const target = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (target.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
    throw new Error("FPR_UNDO_WRONG_DATABASE");
  }
  const { reverseFactoryPayableReclass20261015 } = await import(
    "../../scripts/reverse-factory-payable-reclass-20261015"
  );
  const result = await reverseFactoryPayableReclass20261015(apply);
  if (result.checked !== 18 || (apply ? result.pending !== 0 : result.pending !== 18)) {
    throw new Error("FPR_UNDO_NOT_VERIFIED");
  }
  logger.info(apply ? "FPR_UNDO_VERIFIED" : "FPR_UNDO_PREFLIGHT", { checked: result.checked, pending: result.pending, posted: result.posted });
}

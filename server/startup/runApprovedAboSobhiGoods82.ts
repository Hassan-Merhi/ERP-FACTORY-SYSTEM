/** One-time, owner-approved ledger-only goods value correction; disabled by default. */
import { pool } from "../db";
import { logger } from "../lib/logger";

export async function runApprovedAboSobhiGoods82(): Promise<void> {
  const mode = process.env.FACTORY_ABO_SOBHI_GOODS82_20261015;
  const apply = mode === "approved-company12-abo82";
  if (!apply && mode !== "preview-company12-abo82") return;
  if (process.env.RENDER_SERVICE_ID !== "srv-d6kibgtactks739u7vl0") {
    throw new Error("ABO82_WRONG_PRODUCTION_SERVICE");
  }
  const target = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (target.rows[0]?.name !== "erp_db_qscj_64lv_e7rz_8744_2lm3") {
    throw new Error("ABO82_WRONG_PRODUCTION_DATABASE");
  }
  const { repairAboSobhiGoods82 } = await import(
    "../../scripts/repair-abo-sobhi-goods-82-20261015"
  );
  const result = await repairAboSobhiGoods82(apply);
  if (result.checked !== 1 ||
      (apply ? result.pending !== 0 : (result.pending !== 1 && result.pending !== 0)) ||
      (apply && result.nativeBalance !== "42430.40")) {
    throw new Error("ABO82_REPAIR_NOT_VERIFIED");
  }
  logger.info(apply ? "ABO82_APPLIED_AND_VERIFIED" : "ABO82_PREFLIGHT", {
    checked: result.checked,
    pending: result.pending,
    posted: result.posted,
    nativeBalance: result.nativeBalance,
  });
}

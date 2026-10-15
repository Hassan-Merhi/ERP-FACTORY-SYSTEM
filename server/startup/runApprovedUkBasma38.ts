/** Guarded one-time UK BASMA source reconciliation. Never auto-runs. */
import { pool } from "../db";
import { logger } from "../lib/logger";

export async function runApprovedUkBasma38(): Promise<void> {
  const mode=process.env.FACTORY_UK_BASMA_REPAIR_20261015;
  const apply=mode==="approved-company12-uk-basma";
  if(!apply&&mode!=="preview-company12-uk-basma") return;
  if(process.env.RENDER_SERVICE_ID!=="srv-d6kibgtactks739u7vl0")
    throw new Error("BASMA_REPAIR_WRONG_SERVICE");
  const q=await pool.query<{name:string}>("SELECT current_database() AS name");
  if(q.rows[0]?.name!=="erp_db_qscj_64lv_e7rz_8744_2lm3")
    throw new Error("BASMA_REPAIR_WRONG_DATABASE");
  const {repairUkBasma38}=await import("../../scripts/repair-uk-basma-38-20261015");
  const r=await repairUkBasma38(apply);
  if(r.checked!==2||(apply&&(r.pending!==0||r.baseBalance!=="0.00"))||
    (!apply&&![0,2].includes(r.pending)))
    throw new Error("BASMA_REPAIR_NOT_VERIFIED");
  logger.info(apply?"BASMA_REPAIR_APPLIED_AND_VERIFIED":"BASMA_REPAIR_PREFLIGHT",r);
}

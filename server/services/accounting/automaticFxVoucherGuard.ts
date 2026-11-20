/** Stable source-identity check, not a voucher-description/name heuristic. */
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import type { DbTransaction } from "../../db";

export async function isAutomaticFxRevaluationVoucherTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number,
  voucherId: number
): Promise<boolean> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      !Number.isSafeInteger(voucherId) || voucherId <= 0) {
    throw new Error("A positive company and voucher ID are required");
  }
  const rows = resultRows<{ id: number }>(await tx.execute(sql`
    SELECT id FROM accounting_posting_requests
     WHERE company_id = ${companyId}
       AND voucher_id = ${voucherId}
       AND source_type = 'fx-unrealized-revaluation'
     LIMIT 1
  `));
  return rows.length > 0;
}

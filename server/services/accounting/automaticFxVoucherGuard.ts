/** Stable source-identity check, not a voucher-description/name heuristic. */
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import type { DbTransaction } from "../../db";

export async function isAutomaticFxRevaluationVoucherTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number,
  voucherId: number
): Promise<boolean> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(voucherId) || voucherId <= 0) {
    throw new Error("A positive company and voucher ID are required");
  }
  const rows = resultRows<{ id: number }>(
    await tx.execute(sql`
    SELECT id FROM accounting_posting_requests
     WHERE company_id = ${companyId}
       AND voucher_id = ${voucherId}
       AND source_type = 'fx-unrealized-revaluation'
     LIMIT 1
  `)
  );
  return rows.length > 0;
}

/**
 * The same check, read under the voucher's own company scope, and then the
 * transaction's previous scope restored. For a voucher whose company the
 * caller has already validated (assertVoucherEditableTx locks it in its
 * company): an intercompany edit checks its counterpart in the other company
 * without the request's company check refusing it, and without leaving the
 * rest of the edit running under the other company. A failed read is thrown
 * as it is (the transaction is aborted and rolls back).
 */
export async function isAutomaticFxRevaluationVoucherInOwnScopeTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number,
  voucherId: number
): Promise<boolean> {
  const [current] = resultRows<{ value: string | null }>(
    await tx.execute(sql`SELECT current_setting('app.current_company_id', true) AS value`)
  );
  await tx.execute(sql`SELECT set_config('app.current_company_id', ${String(companyId)}, true)`);
  const automatic = await isAutomaticFxRevaluationVoucherTx(tx, companyId, voucherId);
  await tx.execute(sql`SELECT set_config('app.current_company_id', ${current?.value ?? ""}, true)`);
  return automatic;
}

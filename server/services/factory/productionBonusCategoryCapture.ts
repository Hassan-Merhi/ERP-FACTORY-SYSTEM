import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows } from "../../lib/queryResult";

/** Use exactly the same physical stock statuses as daily Production Targets. */
export const BONUS_CATEGORY_COUNTED_BALE_STATUSES = [
  "IN_STOCK", "SOLD", "RESERVED_FOR_ORDER", "DISPATCHED", "FINALIZED",
] as const;

export interface CategoryCaptureCarry {
  date: string;
  endedAt: Date | string;
}

/** Called only inside the End Production transaction, after the daily
 * production matrix has been saved and before its closure is written.
 * Source bale ID, worker ID and category are frozen once. No re-snapshot of
 * historical days, and the absence of evidence is never backfilled from
 * mutable current stock or a current product catalogue.
 */
export async function freezeProductionBonusCategoryEvidence(
  tx: DatabaseOrTransaction,
  companyId: number,
  productionDate: string,
  workerIds: number[],
  actor: string | null,
  carryFrom: CategoryCaptureCarry | null,
): Promise<number> {
  const captured = resultRows(await tx.execute(sql`
    INSERT INTO factory_target_bonus_category_day_captures
      (company_id, production_date, captured_by)
    VALUES (${companyId}, ${productionDate}::date, ${actor})
    ON CONFLICT (company_id, production_date) DO NOTHING
    RETURNING company_id
  `));
  if (!captured.length) throw new Error("Production bonus category snapshot already captured");

  if (!workerIds.length) return 0;
  const workerIdsSorted = [...new Set(workerIds)].sort((a,b)=>a-b);
  const dateCondition = carryFrom
    ? sql`(
        (stock_entry_date >= ${productionDate}::date AND stock_entry_date <= ${productionDate}::date)
        OR (stock_entry_date = ${carryFrom.date}::date
          AND COALESCE(finalized_at, created_at) > ${carryFrom.endedAt})
      )`
    : sql`stock_entry_date = ${productionDate}::date`;
  const inserted = resultRows(await tx.execute(sql`
    INSERT INTO factory_target_bonus_category_bale_snapshots (
      company_id, production_date, bale_id, worker_id, category_label,
      finalized_at, source_stock_date
    )
    SELECT fb.company_id, ${productionDate}::date,
           fb.id, fb.finalized_by, NULLIF(BTRIM(fb.category), ''),
           fb.finalized_at, fb.stock_entry_date
    FROM factory_bales fb
    WHERE fb.company_id = ${companyId}
      AND ${dateCondition}
      AND fb.finalized_by = ANY(${sqlArray(workerIdsSorted)})
      AND fb.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status=>sql`${status}`),sql`, `)})
    ORDER BY fb.id
    RETURNING bale_id
  `));
  return inserted.length;
}

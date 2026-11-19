// Extracted from ./historicalSalesCostRepairLoadersLoadCanonicalMovements.ts
import type { PoolClient } from "pg";
import { hscrError } from "./historicalSalesCostRepairTypes";

/**
 * Phase 19 (B), PE11: refuses (HSCR_PERIOD_CLOSED) when a target sale is dated
 * on or before its company's closed-books date (its voucher's date or
 * effective date, else the row's occurrence date). `source` names the target
 * rows: the run's ready rows, or a partial apply's log rows.
 */
export async function assertSalesCostTargetsInOpenPeriods(
  client: PoolClient,
  source: { kind: "run"; runId: number } | { kind: "partial-apply"; partialApplyId: number }
): Promise<void> {
  const targets =
    source.kind === "run"
      ? "SELECT company_id, voucher_id, occurred_at FROM historical_sales_cost_repair_rows WHERE run_id=$1 AND status='ready'"
      : "SELECT company_id, voucher_id, occurred_at FROM historical_sales_cost_repair_apply_log WHERE partial_apply_id=$1";
  const id = source.kind === "run" ? source.runId : source.partialApplyId;
  const closed = await client.query<{ count: number }>(
    `WITH targets AS (${targets}),
          locks AS (SELECT company_id, max(period_end_date) AS locked_through
                      FROM fiscal_period_closures WHERE status = 'CLOSED' GROUP BY company_id)
     SELECT COUNT(*)::int AS count
       FROM targets t
       JOIN locks l ON l.company_id = t.company_id
       LEFT JOIN vouchers v ON v.id = t.voucher_id
      WHERE COALESCE(v.voucher_date, t.occurred_at::date) <= l.locked_through
         OR COALESCE(v.effective_date, v.voucher_date, t.occurred_at::date) <= l.locked_through`,
    [id]
  );
  const count = Number(closed.rows[0]?.count ?? 0);
  if (count > 0) throw hscrError(`HSCR_PERIOD_CLOSED:${count}`);
}

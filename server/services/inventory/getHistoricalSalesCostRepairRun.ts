// Extracted from ./historicalSalesCostRepair.ts to keep that module under the source-size cap.
import { pool } from "../../db";

export async function getHistoricalSalesCostRepairRun(runId: number): Promise<Record<string, unknown> | null> {
  const run = await pool.query(
    `SELECT id,algorithm_version,status,source_cutoff_at,requested_company_ids,created_by,created_at,
            completed_at,applied_by,applied_at,audit_hash,total_sales_rows,changed_rows,blocked_rows,
            blocked_item_locations,original_total_cost,proposed_total_cost,original_total_profit,
            proposed_total_profit,report,error
       FROM historical_sales_cost_repair_runs
      WHERE id=$1`,
    [runId]
  );
  if (!run.rows[0]) return null;

  const [blockers, monthly, rowStatus] = await Promise.all([
    pool.query(
      `SELECT company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status IN ('block','warning')
        ORDER BY company_id,stock_item_id,location_id NULLS FIRST,check_code
        LIMIT 500`,
      [runId]
    ),
    pool.query(
      `SELECT company_id,
              to_char(date_trunc('month',occurred_at),'YYYY-MM') AS month,
              COUNT(*)::int AS sale_lines,
              COUNT(*) FILTER (WHERE changed)::int AS changed_lines,
              SUM(original_total_cost)::text AS original_cogs,
              SUM(proposed_total_cost)::text AS proposed_cogs,
              SUM(original_profit)::text AS original_profit,
              SUM(proposed_profit)::text AS proposed_profit
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY company_id,date_trunc('month',occurred_at)
        ORDER BY company_id,month`,
      [runId]
    ),
    pool.query(
      `SELECT status,COUNT(*)::int AS rows
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY status
        ORDER BY status`,
      [runId]
    ),
  ]);
  return {
    ...run.rows[0],
    blockers: blockers.rows,
    monthlyReconciliation: monthly.rows,
    rowStatus: rowStatus.rows,
  };
}

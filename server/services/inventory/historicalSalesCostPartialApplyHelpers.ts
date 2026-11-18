// Extracted from ./historicalSalesCostPartialApply.ts
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { enableMaintenanceScope, hscrError } from "./historicalSalesCostRepair";
import { nonTargetDriftCount, reconciliation, sequential } from "./historicalSalesCostPartialApplyGuards";

/** Read-only, independent post-apply verification against live sales_items. */
export async function verifyHistoricalSalesCostPartialApplyWithClient(client: PoolClient, runId: number) {
  const recordResult = await client.query<{ id: number; status: string; target_rows: number; report: unknown }>(
    `SELECT id,status,target_rows,report FROM historical_sales_cost_repair_partial_applies WHERE run_id=$1`,
    [runId]
  );
  const record = recordResult.rows[0];
  if (!record) throw hscrError("HSCR_PARTIAL_APPLY_NOT_FOUND");
  const partialApplyId = Number(record.id);
  const [live, nonReadyLogged, nonTargetDrift, recon] = await sequential([
    () =>
      client.query<{
        rows: number;
        at_after: number;
        at_before: number;
        before_cogs: string;
        after_cogs: string;
        live_cogs: string;
        before_profit: string;
        after_profit: string;
        live_profit: string;
      }>(
        `SELECT COUNT(*)::int AS rows,
              (COUNT(*) FILTER (WHERE si.cost_price=l.after_cost_price AND si.total_cost=l.after_total_cost
                                  AND si.profit=l.after_profit))::int AS at_after,
              (COUNT(*) FILTER (WHERE si.cost_price=l.before_cost_price AND si.total_cost=l.before_total_cost
                                  AND si.profit=l.before_profit))::int AS at_before,
              SUM(l.before_total_cost)::numeric(24,2)::text AS before_cogs,
              SUM(l.after_total_cost)::numeric(24,2)::text AS after_cogs,
              SUM(si.total_cost)::numeric(24,2)::text AS live_cogs,
              SUM(l.before_profit)::numeric(24,2)::text AS before_profit,
              SUM(l.after_profit)::numeric(24,2)::text AS after_profit,
              SUM(si.profit)::numeric(24,2)::text AS live_profit
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN sales_items si ON si.id=l.sales_item_id
        WHERE l.partial_apply_id=$1`,
        [partialApplyId]
      ),
    () =>
      client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM historical_sales_cost_repair_apply_log l
         LEFT JOIN historical_sales_cost_repair_rows r ON r.run_id=l.run_id AND r.sales_item_id=l.sales_item_id
        WHERE l.partial_apply_id=$1 AND (r.id IS NULL OR r.status<>'ready')`,
        [partialApplyId]
      ),
    () => nonTargetDriftCount(client, runId),
    () => reconciliation(client, runId),
  ]);
  const row = live.rows[0];
  const expectedAtAfter = record.status === "applied";
  const ok =
    Number(row.rows) === Number(record.target_rows) &&
    Number(row.rows) === recon.target.rows &&
    Number(nonReadyLogged.rows[0].count) === 0 &&
    (expectedAtAfter
      ? Number(row.at_after) === Number(row.rows) && row.live_cogs === recon.target.proposedCogs
      : Number(row.at_before) === Number(row.rows));
  return {
    runId,
    partialApplyId,
    status: record.status,
    ok,
    targetRows: Number(record.target_rows),
    loggedRows: Number(row.rows),
    rowsAtProposed: Number(row.at_after),
    rowsAtOriginal: Number(row.at_before),
    loggedRowsNotReady: Number(nonReadyLogged.rows[0].count),
    blockedOrUnchangedRowsDifferingFromOriginal: nonTargetDrift,
    cogs: { before: row.before_cogs, after: row.after_cogs, live: row.live_cogs },
    profit: { before: row.before_profit, after: row.after_profit, live: row.live_profit },
    reconciliation: recon,
  };
}

export async function withReadOnlyClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await enableMaintenanceScope(client);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

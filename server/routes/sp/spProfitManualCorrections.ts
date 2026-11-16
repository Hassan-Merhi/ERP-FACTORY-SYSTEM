import type { Request } from "express";
import { sql } from "drizzle-orm";
import { resultRows } from "../../lib/queryResult";
import type { DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";

/**
 * Append-only, company/month-scoped developer profit corrections.
 * The underlying POS source sales and stock costs are never rewritten.
 */
export interface ManualProfitCorrection {
  id: number;
  periodMonth: string;
  targetNetProfit: string;
  originalNetProfit: string;
  reason: string;
  actorId: string;
  actorName: string | null;
  createdAt: string;
}

export async function getLatestSpProfitCorrection(
  conn: DbLike,
  companyId: number,
  periodMonth: string
): Promise<ManualProfitCorrection | null> {
  const rows = resultRows(await conn.execute(sql`
    SELECT id, period_month, target_net_profit, original_net_profit,
           reason, actor_id, actor_name, created_at
    FROM sp_profit_manual_corrections
    WHERE company_id = ${companyId} AND period_month = ${periodMonth}
    ORDER BY id DESC LIMIT 1
  `));
  const row = rows[0];
  return row ? {
    id: Number(row.id),
    periodMonth: String(row.period_month),
    targetNetProfit: String(row.target_net_profit),
    originalNetProfit: String(row.original_net_profit),
    reason: String(row.reason),
    actorId: String(row.actor_id),
    actorName: row.actor_name == null ? null : String(row.actor_name),
    createdAt: String(row.created_at),
  } : null;
}

export function isDeveloperForProfitCorrection(req: Request): boolean {
  // Use the server-authenticated identity, not any client-supplied role.
  return req.user?.role === "Developer";
}

export const GC_MANUAL_PROFIT_SUSPENSE_SUBTYPE = "sp_profit_correction_suspense";

import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import type { DbLike } from "./spGoldenCoastPhase4CutoverFifoRoutes";

/**
 * Append-only, company/month-scoped developer profit corrections.
 * The underlying POS source sales and stock costs are never rewritten.
 */
let storageReady: Promise<void> | null = null;
export function ensureSpProfitManualCorrectionStorage(): Promise<void> {
  if (!storageReady) {
    storageReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS sp_profit_manual_corrections (
        id bigserial PRIMARY KEY,
        company_id integer NOT NULL,
        period_month varchar(7) NOT NULL,
        target_net_profit numeric(20,2) NOT NULL,
        original_net_profit numeric(20,2) NOT NULL,
        reason text NOT NULL,
        actor_id text NOT NULL,
        actor_name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sp_manual_profit_period CHECK (period_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        CONSTRAINT sp_manual_profit_reason CHECK (char_length(reason) BETWEEN 5 AND 500)
      )
    `).then(() => db.execute(sql`
      CREATE INDEX IF NOT EXISTS sp_profit_manual_corrections_period_idx
        ON sp_profit_manual_corrections(company_id, period_month, id DESC)
    `)).then(() => {}).catch((error) => {
      storageReady = null;
      throw error;
    });
  }
  return storageReady;
}

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
  await ensureSpProfitManualCorrectionStorage();
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

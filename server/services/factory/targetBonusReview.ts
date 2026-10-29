import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

export type TargetBonusStatus = "pending" | "approved" | "rejected";

export interface TargetBonusRow {
  date: string;
  workerId: number;
  workerName: string;
  category: string;
  linkGroupId: number | null;
  targetBales: number;
  producedBales: number;
  extraBales: number;
  ratePerBale: number | null;
  proposedAmount: number;
  status: TargetBonusStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lockedAmount: number | null;
}

type DbRow = {
  date: string; workerId: string | number; workerName: string; category: string | null;
  linkGroupId: string | number | null; targetBales: string | number;
  producedBales: string | number; extraBales: string | number;
  ratePerBale: string | number | null; proposedAmount: string | number;
  status: TargetBonusStatus | null; reviewedBy: string | null; reviewedAt: string | null;
  lockedAmount: string | number | null;
};

/** Finalized daily targets are the source of truth.
 * Linked workers display the entire group's output, so bonuses instead count
 * only each individual's attributed stock-entry bales at production closure.
 * Approved/rejected rows keep an immutable, separately stored snapshot.
 */
export async function loadTargetBonusRows(
  executor: DatabaseOrTransaction,
  companyId: number,
  start: string,
  end: string
): Promise<TargetBonusRow[]> {
  const result = await executor.execute(sql`
    SELECT
      e.period_start::text AS date,
      e.person_id AS "workerId",
      w.full_name AS "workerName",
      COALESCE(e.category, '') AS category,
      links.id AS "linkGroupId",
      COALESCE(e.target_bales, 0) AS "targetBales",
      COALESCE(output.count, 0)::integer AS "producedBales",
      GREATEST(0::numeric, COALESCE(output.count, 0) - COALESCE(e.target_bales, 0)) AS "extraBales",
      rate.rate_per_bale AS "ratePerBale",
      ROUND(
        GREATEST(0::numeric, COALESCE(output.count, 0) - COALESCE(e.target_bales, 0))
        * COALESCE(rate.rate_per_bale, 0), 2
      ) AS "proposedAmount",
      COALESCE(review.status, 'pending') AS status,
      review.reviewed_by AS "reviewedBy",
      review.reviewed_at::text AS "reviewedAt",
      review.bonus_amount AS "lockedAmount"
    FROM factory_staff_tracking_entries e
    JOIN factory_staff_tracking_period_closures closure
      ON closure.company_id = e.company_id
     AND closure.page_type = 'production'
     AND closure.period_type = 'daily'
     AND closure.period_start = e.period_start
     AND closure.period_end = e.period_end
    JOIN factory_workers w ON w.id = e.person_id AND w.company_id = e.company_id
    LEFT JOIN LATERAL (
      SELECT l.id
      FROM factory_worker_production_links l
      JOIN factory_worker_production_link_members lm
        ON lm.link_id = l.id AND lm.company_id = l.company_id
      WHERE l.company_id = e.company_id AND lm.worker_id = e.person_id
        AND l.effective_from <= e.period_start
        AND (l.effective_to IS NULL OR l.effective_to > e.period_start)
      ORDER BY l.effective_from DESC, l.id DESC LIMIT 1
    ) links ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS count
      FROM factory_bales b
      WHERE b.company_id = e.company_id
        AND b.finalized_by = e.person_id
        AND b.stock_entry_date = e.period_start
        AND COALESCE(b.finalized_at, b.created_at) <= closure.ended_at
        AND b.status IN ('IN_STOCK', 'SOLD', 'RESERVED_FOR_ORDER', 'DISPATCHED', 'FINALIZED')
    ) output ON true
    LEFT JOIN LATERAL (
      SELECT r.rate_per_bale
      FROM factory_target_bonus_rates r
      WHERE r.company_id = e.company_id
        AND r.worker_id = e.person_id
        AND r.effective_from <= e.period_start
      ORDER BY r.effective_from DESC, r.id DESC LIMIT 1
    ) rate ON true
    LEFT JOIN factory_target_bonus_reviews review
      ON review.company_id = e.company_id
     AND review.production_date = e.period_start
     AND review.worker_id = e.person_id
    WHERE e.company_id = ${companyId}
      AND e.page_type = 'production'
      AND e.period_type = 'daily'
      AND e.person_type = 'worker'
      AND e.period_start BETWEEN ${start}::date AND ${end}::date
    ORDER BY e.period_start DESC, w.full_name ASC, e.person_id ASC
  `);
  return (resultRows(result) as DbRow[]).map((row) => ({
    date: String(row.date).slice(0, 10),
    workerId: Number(row.workerId),
    workerName: String(row.workerName),
    category: String(row.category ?? ""),
    linkGroupId: row.linkGroupId == null ? null : Number(row.linkGroupId),
    targetBales: Number(row.targetBales),
    producedBales: Number(row.producedBales),
    extraBales: Number(row.extraBales),
    ratePerBale: row.ratePerBale == null ? null : Number(row.ratePerBale),
    proposedAmount: Number(row.proposedAmount),
    status: row.status ?? "pending",
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    lockedAmount: row.lockedAmount == null ? null : Number(row.lockedAmount),
  }));
}

export function targetBonusIsValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = new Date(date + "T00:00:00Z");
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === date;
}

export function targetBonusValidRange(start: unknown, end: unknown): boolean {
  if (!targetBonusIsValidDate(start) || !targetBonusIsValidDate(end) || start > end) return false;
  return (Date.parse(end) - Date.parse(start)) / 86400000 <= 31;
}

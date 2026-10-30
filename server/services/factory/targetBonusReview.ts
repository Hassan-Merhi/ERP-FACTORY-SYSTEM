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
 * Linked workers display the team's shared total, which is split into integer
 * shares; unlinked workers keep their individually attributed stock-entry count.
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
      COALESCE(review.target_bales, e.target_bales, 0) AS "targetBales",
      COALESCE(review.produced_bales, output.count, 0)::integer AS "producedBales",
      COALESCE(review.extra_bales, GREATEST(0::numeric, COALESCE(output.count, 0) - COALESCE(e.target_bales, 0))) AS "extraBales",
      COALESCE(review.rate_per_bale, rate.rate_per_bale) AS "ratePerBale",
      COALESCE(review.bonus_amount,
        ROUND(
          GREATEST(0::numeric, COALESCE(output.count, 0) - COALESCE(e.target_bales, 0))
          * COALESCE(rate.rate_per_bale, 0), 2
        )
      ) AS "proposedAmount",
      COALESCE(review.status, 'pending') AS status,
      review.reviewed_by AS "reviewedBy",
      review.reviewed_at::text AS "reviewedAt",
      review.bonus_amount AS "lockedAmount"
    FROM factory_staff_tracking_entries e
    LEFT JOIN factory_staff_tracking_period_closures closure
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
    -- Finalization captures e.produced_bales; open days use live stock entry.
    -- Linked entries each store the TEAM total. Allocate that total to members
    -- once, with any odd-bale remainder assigned by stable worker-id order.
    -- Unlinked entries store their own worker's stock-entry total.
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS members,
        COUNT(*) FILTER (WHERE lm.worker_id <= e.person_id)::integer AS member_order
      FROM factory_worker_production_link_members lm
      WHERE lm.company_id = e.company_id AND lm.link_id = links.id
    ) assignment ON true
    -- Open days use live physical bales; the latest saved target remains the
    -- source of truth. Closing the day freezes its existing saved count.
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS count
      FROM factory_bales fb
      WHERE fb.company_id = e.company_id
        AND fb.status IN ('IN_STOCK','SOLD','RESERVED_FOR_ORDER','DISPATCHED','FINALIZED')
        AND (
          fb.stock_entry_date = e.period_start
          OR (fb.stock_entry_date = e.period_start - 1 AND
              COALESCE(fb.finalized_at, fb.created_at) >
                (SELECT c.ended_at FROM factory_staff_tracking_period_closures c
                 WHERE c.company_id = e.company_id AND c.page_type='production'
                   AND c.period_type='daily' AND c.period_start = e.period_start - 1
                   AND c.period_end = e.period_start - 1 LIMIT 1))
        )
        AND (
          (links.id IS NULL AND fb.finalized_by = e.person_id) OR
          (links.id IS NOT NULL AND EXISTS (
             SELECT 1 FROM factory_worker_production_link_members lm
             WHERE lm.company_id = e.company_id AND lm.link_id = links.id
               AND lm.worker_id = fb.finalized_by
          ))
        )
    ) live ON closure.company_id IS NULL
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN links.id IS NULL THEN
          CASE WHEN closure.company_id IS NULL THEN COALESCE(live.count, 0)
               ELSE COALESCE(e.produced_bales, 0)::integer END
        ELSE (
          FLOOR((CASE WHEN closure.company_id IS NULL THEN COALESCE(live.count, 0)
                      ELSE COALESCE(e.produced_bales, 0)::integer END)::numeric /
                      GREATEST(assignment.members, 1))
          + CASE WHEN assignment.member_order <=
               MOD((CASE WHEN closure.company_id IS NULL THEN COALESCE(live.count, 0)
                         ELSE COALESCE(e.produced_bales, 0)::integer END),
                         GREATEST(assignment.members, 1))
            THEN 1 ELSE 0 END
        )::integer
      END AS count
    ) output
    -- The review uses the SAME effective-dated company and worker rate
    -- history as the Phase 1/2 read-only bonus calculation.
    LEFT JOIN LATERAL (
      SELECT CASE WHEN r.enabled THEN r.rate_per_extra_bale ELSE NULL END AS rate_per_bale
      FROM factory_production_target_bonus_rates r
      WHERE r.company_id = e.company_id
        AND r.effective_from <= e.period_start
        AND (r.scope = 'company' OR (r.scope = 'worker' AND r.worker_id = e.person_id))
      ORDER BY CASE WHEN r.scope = 'worker' THEN 0 ELSE 1 END,
               r.effective_from DESC, r.id DESC LIMIT 1
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

/** Mirror the SQL linked-team split for validation and downstream exports. */
export function allocateLinkedBales(totalBales: number, memberIds: number[], workerId: number): number {
  const members = [...new Set(memberIds)].sort((a, b) => a - b);
  const rank = members.indexOf(workerId);
  if (!Number.isSafeInteger(totalBales) || totalBales < 0 || rank < 0 || members.length === 0) {
    throw new Error("Invalid linked production allocation");
  }
  return Math.floor(totalBales / members.length) + (rank < totalBales % members.length ? 1 : 0);
}

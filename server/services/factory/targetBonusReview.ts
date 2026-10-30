import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { loadLiveTargetBonusRows } from "./targetBonusLivePreview";
import { BONUS_CATEGORY_COUNTED_BALE_STATUSES } from "./productionBonusCategoryCapture";

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
  targetConfigured?: boolean;
  sourceFinalized?: boolean;
}

type DbRow = {
  date: string; workerId: string | number; workerName: string; category: string | null;
  linkGroupId: string | number | null; targetBales: string | number;
  producedBales: string | number; extraBales: string | number;
  ratePerBale: string | number | null; proposedAmount: string | number;
  status: TargetBonusStatus | null; reviewedBy: string | null; reviewedAt: string | null;
  lockedAmount: string | number | null;
  targetConfigured?: boolean;
};

/** Finalized daily targets and per-bale worker attribution are the source of truth.
 * Linked workers retain their OWN Stock Entry credit and individual targets.
 * A finalized category capture is preferred over mutable live stock statuses.
 * Previously reviewed rows keep their recorded amounts and credits.
 */
export async function loadTargetBonusRows(
  executor: DatabaseOrTransaction,
  companyId: number,
  start: string,
  end: string
): Promise<TargetBonusRow[]> {
  const result = await executor.execute(sql`
    WITH captured_days AS MATERIALIZED (
      SELECT production_date FROM factory_target_bonus_category_day_captures
      WHERE company_id = ${companyId} AND production_date BETWEEN ${start}::date AND ${end}::date
    ),
    captured_bales AS MATERIALIZED (
      SELECT production_date AS work_date, worker_id, COUNT(*)::integer AS bales
      FROM factory_target_bonus_category_bale_snapshots
      WHERE company_id = ${companyId} AND production_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY production_date, worker_id
    ),
    stock_bale_days AS MATERIALIZED (
      -- A closed day's late-scanned bales move to the next day, not both days.
      SELECT b.stock_entry_date AS work_date, b.finalized_by AS worker_id, COUNT(*)::integer AS bales
      FROM factory_bales b
      LEFT JOIN factory_staff_tracking_period_closures c
        ON c.company_id = b.company_id AND c.page_type = 'production'
       AND c.period_type = 'daily' AND c.period_start = b.stock_entry_date
       AND c.period_end = b.stock_entry_date
      WHERE b.company_id = ${companyId} AND b.finalized_by IS NOT NULL
        AND b.stock_entry_date BETWEEN ${start}::date AND ${end}::date
        AND b.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status => sql`${status}`), sql`, `)})
        AND (c.ended_at IS NULL OR COALESCE(b.finalized_at,b.created_at) <= c.ended_at)
      GROUP BY b.stock_entry_date, b.finalized_by
      UNION ALL
      SELECT (b.stock_entry_date + 1) AS work_date, b.finalized_by AS worker_id,
        COUNT(*)::integer AS bales
      FROM factory_bales b
      JOIN factory_staff_tracking_period_closures c
        ON c.company_id = b.company_id AND c.page_type = 'production'
       AND c.period_type = 'daily' AND c.period_start = b.stock_entry_date
       AND c.period_end = b.stock_entry_date
      WHERE b.company_id = ${companyId} AND b.finalized_by IS NOT NULL
        AND b.stock_entry_date BETWEEN (${start}::date - 1) AND (${end}::date - 1)
        AND b.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status => sql`${status}`), sql`, `)})
        AND COALESCE(b.finalized_at,b.created_at) > c.ended_at
      GROUP BY b.stock_entry_date, b.finalized_by
    ),
    stock_bales AS MATERIALIZED (
      SELECT work_date, worker_id, SUM(bales)::integer AS bales
      FROM stock_bale_days GROUP BY work_date, worker_id
    )
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
      review.bonus_amount AS "lockedAmount",
      (e.target_bales IS NOT NULL OR review.id IS NOT NULL) AS "targetConfigured"
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
    -- Saved linked production repeats the team's total; never divide that
    -- repeated value. Attribute captured/live physical bales to their finalizer.
    LEFT JOIN captured_days captured_day ON captured_day.production_date=e.period_start
    LEFT JOIN captured_bales captured_credit
      ON captured_credit.work_date=e.period_start AND captured_credit.worker_id=e.person_id
    LEFT JOIN stock_bales own_credit
      ON own_credit.work_date=e.period_start AND own_credit.worker_id=e.person_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN captured_day.production_date IS NOT NULL
        THEN COALESCE(captured_credit.bales,0)
        ELSE COALESCE(own_credit.bales,0) END::integer AS count
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
  const finalizedRows = (resultRows(result) as DbRow[]).map((row): TargetBonusRow => ({
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
    targetConfigured: Boolean(row.targetConfigured),
    sourceFinalized: true,
  }));
  const liveRows = await loadLiveTargetBonusRows(executor, companyId, start, end);
  return [...finalizedRows, ...liveRows].sort((a,b) =>
    b.date.localeCompare(a.date) || a.workerName.localeCompare(b.workerName) || a.workerId - b.workerId);
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

import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { BONUS_CATEGORY_COUNTED_BALE_STATUSES } from "./productionBonusCategoryCapture";
import type { TargetBonusRow, TargetBonusStatus } from "./targetBonusReview";

type LiveRow = {
  date: string; workerId: number | string; workerName: string;
  category: string | null; linkGroupId: number | string | null;
  targetBales: number | string | null; producedBales: number | string;
  extraBales: number | string; ratePerBale: number | string | null;
  proposedAmount: number | string; status: TargetBonusStatus | null;
  reviewedBy: string | null; reviewedAt: string | null;
  lockedAmount: number | string | null; targetConfigured: boolean;
};

/** Read authoritative physical bales, active links and effective dated targets.
 * Explicit approval persists the resulting worker/day snapshot permanently.
 * Production does not need to be closed to calculate or approve a daily bonus.
 */
export async function loadLiveTargetBonusRows(
  executor: DatabaseOrTransaction, companyId: number, start: string, end: string,
): Promise<TargetBonusRow[]> {
  const result = await executor.execute(sql`
    WITH work_days AS (
      SELECT day::date AS work_date
      FROM generate_series(${start}::date, ${end}::date, '1 day'::interval) days(day)
      WHERE day::date <= (now() AT TIME ZONE 'Asia/Beirut')::date
    ),
    -- Count physical bales ONCE by work date and person. The old correlated
    -- subquery scanned factory_bales for every worker/day (thousands of times).
    -- Keeping the two date paths separate also preserves carry-over after
    -- yesterday's End Production timestamp without duplicating today's bales.
    bale_work_days AS MATERIALIZED (
      SELECT b.stock_entry_date AS work_date, b.finalized_by AS worker_id,
        COUNT(*)::integer AS bales
      FROM factory_bales b
      WHERE b.company_id = ${companyId}
        AND b.finalized_by IS NOT NULL
        AND b.stock_entry_date BETWEEN ${start}::date AND ${end}::date
        AND b.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status=>sql`${status}`),sql`, `)})
      GROUP BY b.stock_entry_date, b.finalized_by
      UNION ALL
      SELECT (b.stock_entry_date + 1) AS work_date, b.finalized_by AS worker_id,
        COUNT(*)::integer AS bales
      FROM factory_bales b
      JOIN factory_staff_tracking_period_closures c
        ON c.company_id = b.company_id
       AND c.page_type = 'production' AND c.period_type = 'daily'
       AND c.period_start = b.stock_entry_date AND c.period_end = b.stock_entry_date
      WHERE b.company_id = ${companyId}
        AND b.finalized_by IS NOT NULL
        AND b.stock_entry_date BETWEEN (${start}::date - 1) AND (${end}::date - 1)
        AND b.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status=>sql`${status}`),sql`, `)})
        AND COALESCE(b.finalized_at,b.created_at) > c.ended_at
      GROUP BY b.stock_entry_date, b.finalized_by
    ),
    credited_bales AS MATERIALIZED (
      SELECT work_date, worker_id, SUM(bales)::integer AS bales
      FROM bale_work_days GROUP BY work_date, worker_id
    )
    SELECT d.work_date::text AS date, w.id AS "workerId",
      w.full_name AS "workerName",
      COALESCE(CASE WHEN saved.category_overridden THEN saved.category
        ELSE defaults.category END, w.position, w.department, '') AS category,
      link.id AS "linkGroupId",
      COALESCE(review.target_bales, resolved.target, 0)::numeric AS "targetBales",
      COALESCE(review.produced_bales, credit.credited, 0)::integer AS "producedBales",
      COALESCE(review.extra_bales,
        GREATEST(0::numeric, credit.credited - COALESCE(resolved.target,0)))::numeric AS "extraBales",
      COALESCE(review.rate_per_bale, rate.rate_per_bale) AS "ratePerBale",
      COALESCE(review.bonus_amount,
        ROUND(GREATEST(0::numeric, credit.credited - COALESCE(resolved.target,0))
          * COALESCE(rate.rate_per_bale,0),2))::numeric AS "proposedAmount",
      COALESCE(review.status, 'pending') AS status,
      review.reviewed_by AS "reviewedBy",
      review.reviewed_at::text AS "reviewedAt",
      review.bonus_amount AS "lockedAmount",
      (resolved.target IS NOT NULL OR review.id IS NOT NULL) AS "targetConfigured"
    FROM work_days d
    JOIN factory_workers w ON w.company_id = ${companyId}
    LEFT JOIN factory_staff_tracking_entries saved
      ON saved.company_id=w.company_id AND saved.person_id=w.id
      AND saved.person_type='worker' AND saved.page_type='production'
      AND saved.period_type='daily' AND saved.period_start=d.work_date
      AND saved.period_end=d.work_date
    LEFT JOIN LATERAL (
      SELECT TRUE AS found, x.target_bales, x.category FROM factory_worker_production_target_defaults x
      WHERE x.company_id=w.company_id AND x.worker_id=w.id
        AND x.effective_from<=d.work_date
      ORDER BY x.effective_from DESC,x.id DESC LIMIT 1
    ) defaults ON TRUE
    LEFT JOIN LATERAL (
      SELECT l.id FROM factory_worker_production_links l
      JOIN factory_worker_production_link_members lm
        ON lm.company_id=l.company_id AND lm.link_id=l.id AND lm.worker_id=w.id
      WHERE l.company_id=w.company_id AND l.effective_from<=d.work_date
        AND (l.effective_to IS NULL OR l.effective_to>d.work_date)
      ORDER BY l.effective_from DESC,l.id DESC LIMIT 1
    ) link ON TRUE
    LEFT JOIN LATERAL (
      SELECT x.target_bales FROM factory_worker_production_link_target_defaults x
      WHERE x.company_id=w.company_id AND x.link_id=link.id
        AND x.effective_from<=d.work_date
      ORDER BY x.effective_from DESC,x.id DESC LIMIT 1
    ) link_default ON TRUE
    -- A linked table never replaces an individual's saved/default target.
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN saved.target_overridden THEN saved.target_bales
        WHEN defaults.found THEN defaults.target_bales
        WHEN link.id IS NOT NULL THEN link_default.target_bales
        ELSE saved.target_bales
      END AS target
    ) resolved
    -- Link membership only affects table/roster metadata, NEVER bonus credit.
    -- Stock Entry already records the worker who finalized each physical bale.
    LEFT JOIN credited_bales single_bales
      ON single_bales.work_date=d.work_date AND single_bales.worker_id=w.id
    CROSS JOIN LATERAL (
      SELECT COALESCE(single_bales.bales,0)::integer AS credited
    ) credit
    LEFT JOIN LATERAL (
      SELECT CASE WHEN r.enabled THEN r.rate_per_extra_bale ELSE NULL END AS rate_per_bale
      FROM factory_production_target_bonus_rates r
      WHERE r.company_id=w.company_id AND r.effective_from<=d.work_date
        AND (r.scope='company' OR (r.scope='worker' AND r.worker_id=w.id))
      ORDER BY CASE WHEN r.scope='worker' THEN 0 ELSE 1 END,
               r.effective_from DESC,r.id DESC LIMIT 1
    ) rate ON TRUE
    LEFT JOIN factory_target_bonus_reviews review
      ON review.company_id=w.company_id AND review.production_date=d.work_date
      AND review.worker_id=w.id
    WHERE EXISTS (
      -- Production Targets only lists workers assigned to a saved Production
      -- Planner group; other Stock Entry workers are not bonus candidates.
      SELECT 1 FROM factory_worker_categories planner
      WHERE planner.company_id=w.company_id
        AND (
          planner.worker_ids @> jsonb_build_array(w.id)
          OR planner.worker_ids @> jsonb_build_array(w.id::text)
        )
    )
      AND NOT EXISTS (
      SELECT 1 FROM factory_staff_tracking_period_closures c
      WHERE c.company_id=w.company_id AND c.page_type='production'
        AND c.period_type='daily' AND c.period_start=d.work_date
        AND c.period_end=d.work_date
    )
      -- Mirror the Production Targets daily roster: all current planner
      -- workers are listed, even when their target and made counts are 0.
      -- Saved day records and linked workers remain visible if inactive.
      AND (saved.person_id IS NOT NULL OR link.id IS NOT NULL OR
           (w.active=TRUE AND (w.date_joined IS NULL OR w.date_joined<=d.work_date)))
    ORDER BY d.work_date DESC,w.full_name,w.id
  `);
  return (resultRows(result) as LiveRow[]).map(row=>({
    date:String(row.date).slice(0,10),workerId:Number(row.workerId),
    workerName:String(row.workerName),category:String(row.category??""),
    linkGroupId:row.linkGroupId==null?null:Number(row.linkGroupId),
    targetBales:Number(row.targetBales),producedBales:Number(row.producedBales),
    extraBales:Number(row.extraBales),
    ratePerBale:row.ratePerBale==null?null:Number(row.ratePerBale),
    proposedAmount:Number(row.proposedAmount),status:row.status??"pending",
    reviewedBy:row.reviewedBy,reviewedAt:row.reviewedAt,
    lockedAmount:row.lockedAmount==null?null:Number(row.lockedAmount),
    targetConfigured:Boolean(row.targetConfigured),sourceFinalized:false,
  }));
}

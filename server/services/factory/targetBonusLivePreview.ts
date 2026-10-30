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
      AND (w.date_joined IS NULL OR w.date_joined <= d.work_date)
    LEFT JOIN factory_staff_tracking_entries saved
      ON saved.company_id=w.company_id AND saved.person_id=w.id
      AND saved.person_type='worker' AND saved.page_type='production'
      AND saved.period_type='daily' AND saved.period_start=d.work_date
      AND saved.period_end=d.work_date
    LEFT JOIN LATERAL (
      SELECT x.target_bales, x.category FROM factory_worker_production_target_defaults x
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
    LEFT JOIN LATERAL (
      SELECT TRUE AS found,e.target_bales
      FROM factory_worker_production_link_members lm
      JOIN factory_staff_tracking_entries e
        ON e.company_id=lm.company_id AND e.person_id=lm.worker_id
        AND e.person_type='worker' AND e.page_type='production'
        AND e.period_type='daily' AND e.period_start=d.work_date
        AND e.period_end=d.work_date AND e.target_overridden=TRUE
      WHERE lm.company_id=w.company_id AND lm.link_id=link.id
      ORDER BY e.person_id LIMIT 1
    ) link_override ON TRUE
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN link_override.found THEN link_override.target_bales
        WHEN saved.target_overridden THEN saved.target_bales
        WHEN link.id IS NOT NULL THEN link_default.target_bales
        ELSE COALESCE(defaults.target_bales,saved.target_bales)
      END AS target
    ) resolved
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS member_count,
        COUNT(*) FILTER (WHERE lm.worker_id<=w.id)::integer AS member_order
      FROM factory_worker_production_link_members lm
      WHERE lm.company_id=w.company_id AND lm.link_id=link.id
    ) members ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.ended_at
      FROM factory_staff_tracking_period_closures c
      WHERE c.company_id=w.company_id AND c.page_type='production'
        AND c.period_type='daily'
        AND c.period_start=d.work_date - 1 AND c.period_end=d.work_date - 1
      LIMIT 1
    ) previous_close ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS bales FROM factory_bales b
      WHERE b.company_id=w.company_id
        AND (b.stock_entry_date=d.work_date
          OR (previous_close.ended_at IS NOT NULL
            AND b.stock_entry_date=d.work_date - 1
            AND COALESCE(b.finalized_at,b.created_at)>previous_close.ended_at))
        AND b.status IN (${sql.join(BONUS_CATEGORY_COUNTED_BALE_STATUSES.map(status=>sql`${status}`),sql`, `)})
        AND ((link.id IS NULL AND b.finalized_by=w.id)
          OR (link.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM factory_worker_production_link_members lm
            WHERE lm.company_id=w.company_id AND lm.link_id=link.id
              AND lm.worker_id=b.finalized_by)))
    ) produced ON TRUE
    CROSS JOIN LATERAL (
      SELECT CASE WHEN link.id IS NULL THEN produced.bales
        ELSE (FLOOR(produced.bales::numeric/GREATEST(members.member_count,1))
          + CASE WHEN members.member_order<=
              MOD(produced.bales,GREATEST(members.member_count,1)) THEN 1 ELSE 0 END)::integer
      END AS credited
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
    WHERE NOT EXISTS (
      SELECT 1 FROM factory_staff_tracking_period_closures c
      WHERE c.company_id=w.company_id AND c.page_type='production'
        AND c.period_type='daily' AND c.period_start=d.work_date
        AND c.period_end=d.work_date
    )
      AND (w.active=TRUE OR saved.person_id IS NOT NULL)
      AND (saved.person_id IS NOT NULL OR defaults.target_bales IS NOT NULL
        OR link.id IS NOT NULL OR credit.credited>0 OR review.id IS NOT NULL)
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

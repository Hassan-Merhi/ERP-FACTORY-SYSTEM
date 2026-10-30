/**
 * Read-only weekly/monthly Production Targets rollup.
 * Targets and attendance are DAILY even when the requested report is weekly.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { loadTargetBonusRows, type TargetBonusRow } from "./targetBonusReview";

export type PeriodTargetDay = {
  date: string; workerId: number; target: number | null; category: string;
  status: "Present" | "Absent" | "New";
};
export type ProductionPeriodWorker = {
  workerId: number; targetBales: number | null; absentTargetBales: number;
  producedBales: number; category: string; status: "Present" | "Absent" | "New";
  absentDays: number; days: number; missingTargetDays: number;
};
type SqlDay = {
  date: string; workerId: number | string; target: string | number | null;
  category: string | null; status: "Present" | "Absent" | "New" | null;
};

/** Pure reducer: physical bales are credited once per worker/day. */
export function aggregateProductionPeriodDays(
  days: readonly PeriodTargetDay[],
  credited: readonly Pick<TargetBonusRow,"date" | "workerId" | "producedBales">[],
): Map<number,ProductionPeriodWorker> {
  const workers=new Map<number,ProductionPeriodWorker>();
  const latest=new Map<number,string>();
  for(const day of days){
    let worker=workers.get(day.workerId);
    if(!worker){
      worker={workerId:day.workerId,targetBales:null,absentTargetBales:0,
        producedBales:0,category:"",status:"Present",absentDays:0,days:0,missingTargetDays:0};
      workers.set(day.workerId,worker);
    }
    if(day.target===null)worker.missingTargetDays++;
    if(day.target!==null){
      worker.targetBales=(worker.targetBales??0)+day.target;
      if(day.status==="Absent")worker.absentTargetBales+=day.target;
    }
    if(day.status==="Absent")worker.absentDays++;
    worker.days++;
    if(!latest.has(day.workerId) || day.date>=latest.get(day.workerId)!){
      worker.category=day.category;
      worker.status=day.status;
      latest.set(day.workerId,day.date);
    }
  }
  for(const row of credited){
    const worker=workers.get(row.workerId);
    if(worker)worker.producedBales+=row.producedBales;
  }
  return workers;
}

/**
 * Resolve each workday with the exact daily defaults/overrides and finalization
 * rules from Production Targets. Separately use the bonus source's unique
 * per-worker bale credits so linked teams are never counted twice.
 */
export async function loadProductionPeriodSummary(
  companyId:number,start:string,end:string,workerIds:readonly number[],
):Promise<Map<number,ProductionPeriodWorker>>{
  if(workerIds.length===0)return new Map();
  const difference=(Date.parse(end+"T12:00:00Z")-Date.parse(start+"T12:00:00Z"))/86400000;
  if(!Number.isInteger(difference)||difference<0||difference>30)
    throw new Error("Production Targets period exceeds 31 days");
  const [result,credits]=await Promise.all([
    db.execute(sql`
      WITH work_days AS (
        SELECT day::date AS work_date
        FROM generate_series(${start}::date,${end}::date,'1 day'::interval) dates(day)
      )
      SELECT d.work_date::text AS date, w.id AS "workerId",
        CASE
          WHEN closed.ended_at IS NOT NULL THEN saved.target_bales
          WHEN saved.target_overridden IS TRUE THEN saved.target_bales
          WHEN defaults.found IS TRUE THEN defaults.target_bales
          WHEN link_default.target_bales IS NOT NULL THEN link_default.target_bales
          ELSE saved.target_bales
        END AS target,
        CASE
          WHEN closed.ended_at IS NOT NULL
            THEN COALESCE(saved.category,w.position,w.department,'')
          WHEN saved.category_overridden IS TRUE THEN COALESCE(saved.category,'')
          ELSE COALESCE(defaults.category,w.position,w.department,'')
        END AS category,
        CASE
          WHEN closed.ended_at IS NOT NULL THEN COALESCE(saved.status,'Present')
          WHEN w.date_joined = d.work_date THEN 'New'
          WHEN attendance.status='Absent' THEN 'Absent'
          ELSE 'Present'
        END AS status
      FROM work_days d
      JOIN factory_workers w ON w.company_id=${companyId}
        AND w.id=ANY(${sqlArray([...workerIds])})
      LEFT JOIN factory_staff_tracking_period_closures closed
        ON closed.company_id=w.company_id AND closed.page_type='production'
          AND closed.period_type='daily' AND closed.period_start=d.work_date
          AND closed.period_end=d.work_date
      LEFT JOIN factory_staff_tracking_entries saved
        ON saved.company_id=w.company_id AND saved.person_type='worker'
          AND saved.person_id=w.id AND saved.page_type='production'
          AND saved.period_type='daily' AND saved.period_start=d.work_date
          AND saved.period_end=d.work_date
      LEFT JOIN LATERAL (
        SELECT TRUE AS found,x.target_bales,x.category
        FROM factory_worker_production_target_defaults x
        WHERE x.company_id=w.company_id AND x.worker_id=w.id
          AND x.effective_from<=d.work_date
        ORDER BY x.effective_from DESC,x.id DESC LIMIT 1
      ) defaults ON TRUE
      LEFT JOIN LATERAL (
        SELECT l.id
        FROM factory_worker_production_links l
        JOIN factory_worker_production_link_members lm
          ON lm.company_id=l.company_id AND lm.link_id=l.id
        WHERE l.company_id=w.company_id AND lm.worker_id=w.id
          AND l.effective_from<=d.work_date
          AND (l.effective_to IS NULL OR l.effective_to>d.work_date)
        ORDER BY l.effective_from DESC,l.id DESC LIMIT 1
      ) link ON TRUE
      LEFT JOIN LATERAL (
        SELECT x.target_bales FROM factory_worker_production_link_target_defaults x
        WHERE x.company_id=w.company_id AND x.link_id=link.id
          AND x.effective_from<=d.work_date
        ORDER BY x.effective_from DESC,x.id DESC LIMIT 1
      ) link_default ON TRUE
      LEFT JOIN factory_attendance attendance
        ON attendance.company_id=w.company_id
          AND attendance.worker_id=w.id AND attendance.attendance_date=d.work_date
      WHERE (
        (closed.ended_at IS NOT NULL AND saved.person_id IS NOT NULL)
        OR
        (closed.ended_at IS NULL
         AND EXISTS (
           SELECT 1 FROM factory_worker_categories planner
           WHERE planner.company_id=w.company_id AND
             (planner.worker_ids @> jsonb_build_array(w.id)
              OR planner.worker_ids @> jsonb_build_array(w.id::text))
         )
         AND (saved.person_id IS NOT NULL OR link.id IS NOT NULL
           OR (w.active=TRUE AND (w.date_joined IS NULL OR w.date_joined<=d.work_date))))
      )
      ORDER BY d.work_date,w.id
    `),
    loadTargetBonusRows(db,companyId,start,end),
  ]);
  const ids=new Set(workerIds);
  const targetDays=(resultRows(result) as SqlDay[])
    .filter(row=>ids.has(Number(row.workerId)))
    .map((row):PeriodTargetDay=>({
      date:String(row.date).slice(0,10),workerId:Number(row.workerId),
      target:row.target===null?null:Number(row.target),
      category:String(row.category??""),
      status:row.status==="Absent"||row.status==="New"?row.status:"Present",
    }));
  return aggregateProductionPeriodDays(targetDays,credits.filter(row=>ids.has(row.workerId)));
}

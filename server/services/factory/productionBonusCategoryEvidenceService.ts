import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import {
  buildCategoryEvidence,
  type CategoryEvidenceResult,
  type CategoryEvidenceWorker,
  type CategoryEvidenceLink,
  type CategoryEvidenceBale,
} from "@shared/productionTargetBonusCategoryAttribution";

type SqlWorker = { workerId: number | string; workerName: string; targetBales: string | null; producedBales: string | null; status: string };
type SqlLink = { id: number | string; ids: number[] | string };
type SqlBale = { baleId: number | string; workerId: number | string | null; category: string | null; finalizedAt: string | null };
type SqlAllocation = { workerId: number | string; categoryKey: string; categoryLabel: string; creditedBales: number | string; targetBales: string; allocatedAt: string };
type SqlCapture = { capturedAt: string };
export interface CategoryEvidenceWithAllocations extends CategoryEvidenceResult {
  productionDate: string;
  finalized: boolean;
  capturedAt: string | null;
  allocations: Array<{ workerId: number; categoryKey: string; categoryLabel: string;
    creditedBales: number; targetBales: number; allocatedAt: string }>;
}

export async function loadProductionBonusCategoryEvidence(
  executor: DatabaseOrTransaction,
  companyId: number,
  date: string,
): Promise<CategoryEvidenceWithAllocations> {
  const [closure, capture, workers, links, bales, allocations] = await Promise.all([
    executor.execute(sql`
      SELECT 1 AS present FROM factory_staff_tracking_period_closures
      WHERE company_id = ${companyId} AND page_type = 'production'
        AND period_type = 'daily' AND period_start = ${date}::date
        AND period_end = ${date}::date LIMIT 1
    `),
    executor.execute(sql`
      SELECT captured_at::text AS "capturedAt" FROM factory_target_bonus_category_day_captures
      WHERE company_id = ${companyId} AND production_date = ${date}::date LIMIT 1
    `),
    executor.execute(sql`
      SELECT e.person_id AS "workerId", w.full_name AS "workerName", e.target_bales::text AS "targetBales",
             e.produced_bales::text AS "producedBales", e.status
      FROM factory_staff_tracking_entries e
      JOIN factory_workers w ON w.id=e.person_id AND w.company_id=e.company_id
      WHERE e.company_id = ${companyId} AND e.page_type = 'production'
        AND e.period_type = 'daily' AND e.person_type = 'worker'
        AND e.period_start = ${date}::date AND e.period_end = ${date}::date
      ORDER BY e.person_id
    `),
    executor.execute(sql`
      SELECT l.id, ARRAY_AGG(m.worker_id ORDER BY m.worker_id) AS ids
      FROM factory_worker_production_links l
      JOIN factory_worker_production_link_members m
        ON m.company_id = l.company_id AND m.link_id = l.id
      WHERE l.company_id = ${companyId}
        AND l.effective_from <= ${date}::date
        AND (l.effective_to IS NULL OR l.effective_to > ${date}::date)
      GROUP BY l.id ORDER BY l.id
    `),
    executor.execute(sql`
      SELECT bale_id AS "baleId", worker_id AS "workerId",
             category_label AS category, finalized_at::text AS "finalizedAt"
      FROM factory_target_bonus_category_bale_snapshots
      WHERE company_id = ${companyId} AND production_date = ${date}::date
      ORDER BY bale_id LIMIT 50001
    `),
    executor.execute(sql`
      SELECT s.worker_id AS "workerId", a.category_key AS "categoryKey",
             a.category_label AS "categoryLabel", a.credited_bales AS "creditedBales",
             a.target_bales::text AS "targetBales", s.allocated_at::text AS "allocatedAt"
      FROM factory_target_bonus_category_allocation_sets s
      JOIN factory_target_bonus_category_allocations a ON a.allocation_set_id = s.id
      WHERE s.company_id = ${companyId} AND s.production_date = ${date}::date
      ORDER BY s.worker_id, a.category_key
    `),
  ]);
  const baleRows=resultRows(bales) as SqlBale[];
  if(baleRows.length>50000)throw new Error("Production bonus category evidence too large");
  const savedWorkers = (resultRows(workers) as SqlWorker[]).map((w): CategoryEvidenceWorker => ({
    workerId: Number(w.workerId), workerName: w.workerName,
    targetBales: w.targetBales === null ? null : Number(w.targetBales),
    savedProducedBales: Number(w.producedBales ?? 0),
    status: w.status === "Absent" ? "Absent" : w.status === "New" ? "New" : "Present",
  }));
  const linkRows = (resultRows(links) as SqlLink[]).map((l): CategoryEvidenceLink => ({
    id: Number(l.id),
    workerIds: (Array.isArray(l.ids) ? l.ids : String(l.ids).replace(/[{}]/g,"").split(",")).map(Number),
  }));
  const source=(baleRows).map((b): CategoryEvidenceBale=>({
    baleId:Number(b.baleId),workerId:b.workerId==null?null:Number(b.workerId),
    category:b.category, finalizedAt:b.finalizedAt,
  }));
  const captured = (resultRows(capture) as SqlCapture[])[0] ?? null;
  const preview=buildCategoryEvidence(savedWorkers,linkRows,source,Boolean(captured));
  return {
    ...preview, productionDate:date, finalized:resultRows(closure).length>0,
    capturedAt:captured?.capturedAt??null,
    readyForTargetAllocation:resultRows(closure).length>0 && preview.readyForTargetAllocation,
    allocations:(resultRows(allocations) as SqlAllocation[]).map(a=>({
      workerId:Number(a.workerId),categoryKey:a.categoryKey,categoryLabel:a.categoryLabel,
      creditedBales:Number(a.creditedBales),targetBales:Number(a.targetBales),
      allocatedAt:a.allocatedAt,
    })),
  };
}

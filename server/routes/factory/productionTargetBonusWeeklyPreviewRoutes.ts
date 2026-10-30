import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db, type DatabaseOrTransaction } from "../../db";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { isBonusCategoryDate } from "@shared/productionTargetBonusCategoryRates";
import { mondayOfProductionBonusWeek, type ProductionBonusMethod } from "@shared/productionTargetBonusWeeklyMethod";
import { calculateWeeklyFlatBonus, type WeeklyFlatDayEvidence } from "@shared/productionTargetBonusWeeklyCalculation";
import { loadProductionBonusCategoryEvidence } from "../../services/factory/productionBonusCategoryEvidenceService";

const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");
const allowed = (req: Request): boolean =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));
const companyFor = (req: Request): number | null => {
  const id = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
function todayBeirut(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}
function addDays(date: string, count: number): string {
  const d = new Date(date + "T12:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
type ActivityRow = { date: string; finalized: boolean };
type ReviewRow = { date: string; workerId: string | number };
type MethodRow = { id: string | number; method: ProductionBonusMethod; flatBonusUsd: string };

/** Shared authoritative transactional source for Phase 13 preview and Phase 14 approval. */
export async function loadWeeklyFlatBonusProposal(
  companyId: number, weekStart: string, executor: DatabaseOrTransaction = db,
) {
  const today = todayBeirut();
  const weekEnd = addDays(weekStart, 6);
        // Resolve the correct historical method independently of history-list limits.
        const [methodResult, activityResult, reviewResult, payrollResult, duplicateResult] = await Promise.all([
          executor.execute(sql`
            SELECT id, method, flat_bonus_usd::text AS "flatBonusUsd"
            FROM factory_production_target_bonus_weekly_methods
            WHERE company_id = ${companyId} AND effective_week <= ${weekStart}::date
            ORDER BY effective_week DESC, id DESC LIMIT 1
          `),
          executor.execute(sql`
            SELECT source_date::text AS date, bool_or(finalized) AS finalized
            FROM (
              SELECT period_start AS source_date, FALSE AS finalized
              FROM factory_staff_tracking_entries
              WHERE company_id = ${companyId} AND page_type = 'production'
                AND period_type = 'daily' AND person_type = 'worker'
                AND period_start = period_end
                AND period_start BETWEEN ${weekStart}::date AND ${weekEnd}::date
              UNION ALL
              SELECT period_start AS source_date, TRUE AS finalized
              FROM factory_staff_tracking_period_closures
              WHERE company_id = ${companyId} AND page_type = 'production'
                AND period_type = 'daily' AND period_start = period_end
                AND period_start BETWEEN ${weekStart}::date AND ${weekEnd}::date
              UNION ALL
              SELECT production_date AS source_date, FALSE AS finalized
              FROM factory_target_bonus_category_day_captures
              WHERE company_id = ${companyId}
                AND production_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
            ) source
            GROUP BY source_date ORDER BY source_date
          `),
          executor.execute(sql`
            SELECT production_date::text AS date, worker_id AS "workerId"
            FROM factory_target_bonus_reviews
            WHERE company_id = ${companyId}
              AND production_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
            UNION
            SELECT production_date::text AS date, worker_id AS "workerId"
            FROM factory_target_bonus_category_reviews
            WHERE company_id = ${companyId}
              AND production_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
          `),
          executor.execute(sql`
            SELECT run.production_date::text AS date, a.worker_id AS "workerId"
            FROM factory_production_bonus_allocations a
            JOIN factory_production_bonus_runs run ON run.id = a.run_id
              AND run.company_id = a.company_id
            WHERE a.company_id = ${companyId}
              AND run.production_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
              AND a.amount > 0
              AND (a.decision_status = 'APPROVED' OR a.payroll_id IS NOT NULL)
          `),
          executor.execute(sql`
            SELECT 1
            FROM factory_target_bonus_category_bale_snapshots
            WHERE company_id = ${companyId}
              AND production_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
            GROUP BY bale_id HAVING COUNT(DISTINCT production_date) > 1
            LIMIT 1
          `),
        ]);
        const method = (resultRows(methodResult) as MethodRow[])[0];
        const activity = resultRows(activityResult) as ActivityRow[];
        const dayEvidence = await Promise.all(activity.map(async (day): Promise<WeeklyFlatDayEvidence> => {
          const evidence = await loadProductionBonusCategoryEvidence(executor, companyId, day.date);
          return {
            date: day.date,
            finalized: Boolean(day.finalized) && evidence.finalized,
            captured: evidence.captured,
            verified: evidence.readyForTargetAllocation,
            issues: [...evidence.issues],
            sourceBales: evidence.sourceBales,
            creditedBales: evidence.creditedBales,
            workers: evidence.workers.map(worker => ({
              workerId: worker.workerId,
              workerName: worker.workerName ?? "Worker #" + worker.workerId,
              status: worker.status,
              targetBales: worker.dailyTargetBales,
              creditedBales: worker.creditedBales,
              categories: worker.categories.map(category => ({
                categoryKey: category.categoryKey,
                categoryLabel: category.categoryLabel,
                creditedBales: category.creditedBales,
              })),
            })),
          };
        }));
        const toKeys = (rows: ReviewRow[]) => new Set(rows.map(row => row.date + ":" + Number(row.workerId)));
        const proposal = calculateWeeklyFlatBonus({
          weekStart, todayBeirut: today,
          method: method?.method ?? "per_extra_bale",
          methodVersionId: method ? Number(method.id) : null,
          flatBonusUsd: method?.flatBonusUsd ?? "0.00",
          days: dayEvidence,
          unfinalizedDates: activity.filter(day => !day.finalized).map(day => day.date),
          repeatedBaleInWeek: resultRows(duplicateResult).length > 0,
          previouslyReviewedWorkerDays: toKeys(resultRows(reviewResult) as ReviewRow[]),
          payrollClaimedWorkerDays: toKeys(resultRows(payrollResult) as ReviewRow[]),
        });
        return {
          ...proposal, dayCount: dayEvidence.length, weekStartsOn: "Monday",
          source: "immutable-finalized-physical-bale-category-evidence",
          note: "Phase 14 review is audit-only. Posting and payment are not available.",
        };

}

/** Phase 13: read-only, finalized-week eligibility. No new award or payment path. */
export function registerProductionTargetBonusWeeklyPreviewRoutes(app: Express): void {
  app.get("/api/factory/production-target-bonuses/weekly-preview",
    requireAuth, guard, async (req: Request, res: Response) => {
      if (!allowed(req)) return res.status(403).json({ message: "Admin or Owner required" });
      const companyId = companyFor(req);
      if (!companyId) return res.status(400).json({ message: "Factory company required" });
      const weekOf = req.query.weekOf;
      if (!isBonusCategoryDate(weekOf) || weekOf > todayBeirut())
        return res.status(400).json({ message: "Select a valid past or current production date" });
      const weekStart = mondayOfProductionBonusWeek(weekOf)!;
      try {
        const proposal = await loadWeeklyFlatBonusProposal(companyId, weekStart);
        res.setHeader("Cache-Control", "private, no-store");
        return res.json(proposal);
      } catch (error) {
        logger.error("Production Targets weekly bonus preview failed", { error });
        return res.status(500).json({ message: "Could not calculate weekly bonus eligibility" });
      }
    },
  );
}

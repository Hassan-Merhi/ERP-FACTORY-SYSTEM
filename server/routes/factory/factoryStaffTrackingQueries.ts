/**
 * Shared lookups and query parsing for the factory staff-tracking routes,
 * split out of factoryStaffTrackingRoutes.ts to keep it under the
 * 900-line repository limit. Behaviour is unchanged.
 */
import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { BONUS_CATEGORY_COUNTED_BALE_STATUSES } from "../../services/factory/productionBonusCategoryCapture";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { factoryUserProfiles } from "@shared/schema";

import {
  addIsoDays,
  parseWorkerIds,
  type PeriodType,
  type TrackingPage,
  type TrackingStatus,
} from "./factoryStaffTrackingValueHelpers";

export const PAGE_TYPES = new Set<TrackingPage>(["production", "attendance"]);
export const PERIOD_TYPES = new Set<PeriodType>(["daily", "weekly", "monthly"]);
export const STATUSES = new Set<TrackingStatus>(["Present", "Absent", "New"]);
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const COUNTED_PRODUCTION_BALE_STATUSES = BONUS_CATEGORY_COUNTED_BALE_STATUSES;

export function getFactoryCompanyId(req: Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

export const STAFF_TRACKING_HIDDEN_TAB_KEYS: Record<TrackingPage, string> = {
  production: "hide_tab_stockentry_production_targets",
  attendance: "hide_tab_workers_attendance",
};

export async function canAccessTrackingPage(req: Request, companyId: number, page: TrackingPage): Promise<boolean> {
  const role = String(req.session.currentRole || req.user?.role || "");
  if (["Admin", "Owner", "Developer"].includes(role)) return true;

  const userId = req.session.userId;
  if (!userId) return false;

  const [profile] = await db
    .select({ hiddenCostFields: factoryUserProfiles.hiddenCostFields })
    .from(factoryUserProfiles)
    .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)))
    .limit(1);

  return !(profile?.hiddenCostFields ?? []).includes(STAFF_TRACKING_HIDDEN_TAB_KEYS[page]);
}

export function parseTrackingQuery(req: Request): {
  page: TrackingPage;
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
} | null {
  const page = String(req.query.page || "") as TrackingPage;
  const periodType = String(req.query.periodType || "") as PeriodType;
  const periodStart = String(req.query.periodStart || "");
  const periodEnd = String(req.query.periodEnd || "");
  if (!PAGE_TYPES.has(page) || !PERIOD_TYPES.has(periodType)) return null;
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd) || periodEnd < periodStart) return null;
  if (page === "production" && periodType !== "daily") {
    const from = new Date(periodStart + "T00:00:00Z");
    const to = new Date(periodEnd + "T00:00:00Z");
    const dayCount = (to.getTime() - from.getTime()) / 86400000 + 1;
    if (
      !Number.isInteger(dayCount) ||
      dayCount < 1 ||
      dayCount > 31 ||
      from.toISOString().slice(0, 10) !== periodStart ||
      to.toISOString().slice(0, 10) !== periodEnd
    )
      return null;
  }
  return { page, periodType, periodStart, periodEnd };
}

export async function loadWorkerGroupNames(companyId: number): Promise<Map<number, string[]>> {
  const result = await db.execute(sql`
    SELECT name, worker_ids AS "workerIds"
    FROM factory_worker_categories
    WHERE company_id = ${companyId}
    ORDER BY id
  `);
  const groups = resultRows(result) as Array<{ name: string; workerIds: unknown }>;
  const workerGroupNames = new Map<number, string[]>();

  for (const group of groups) {
    for (const workerId of parseWorkerIds(group.workerIds)) {
      const names = workerGroupNames.get(workerId) ?? [];
      if (!names.includes(group.name)) names.push(group.name);
      workerGroupNames.set(workerId, names);
    }
  }

  return workerGroupNames;
}

export async function loadClosure(
  companyId: number,
  page: TrackingPage,
  periodType: PeriodType,
  periodStart: string,
  periodEnd: string
): Promise<{ endedAt: Date | string } | null> {
  const result = await db.execute(sql`
    SELECT ended_at AS "endedAt"
    FROM factory_staff_tracking_period_closures
    WHERE company_id = ${companyId}
      AND page_type = ${page}
      AND period_type = ${periodType}
      AND period_start = ${periodStart}
      AND period_end = ${periodEnd}
    LIMIT 1
  `);
  const rows = resultRows(result) as Array<{ endedAt: Date | string }>;
  return rows[0] ?? null;
}

export async function loadPreviousDailyCarry(
  companyId: number,
  periodStart: string
): Promise<{ date: string; endedAt: Date | string } | null> {
  const previousDate = addIsoDays(periodStart, -1);
  const closure = await loadClosure(companyId, "production", "daily", previousDate, previousDate);
  return closure ? { date: previousDate, endedAt: closure.endedAt } : null;
}

export async function loadProducedByWorker(
  companyId: number,
  periodStart: string,
  periodEnd: string,
  workerIds: number[],
  carryFrom: { date: string; endedAt: Date | string } | null = null
): Promise<Map<number, number>> {
  const producedByWorker = new Map<number, number>();
  if (workerIds.length === 0) return producedByWorker;

  const dateCondition = carryFrom
    ? sql`(
        (stock_entry_date >= ${periodStart} AND stock_entry_date <= ${periodEnd})
        OR (
          stock_entry_date = ${carryFrom.date}
          AND COALESCE(finalized_at, created_at) > ${carryFrom.endedAt}
        )
      )`
    : sql`stock_entry_date >= ${periodStart} AND stock_entry_date <= ${periodEnd}`;

  const productionResult = await db.execute(sql`
    SELECT finalized_by AS "workerId", COUNT(*)::integer AS "producedBales"
    FROM factory_bales
    WHERE company_id = ${companyId}
      AND ${dateCondition}
      AND finalized_by = ANY(${sqlArray(workerIds)})
      AND status IN (${sql.join(
        COUNTED_PRODUCTION_BALE_STATUSES.map((status) => sql`${status}`),
        sql`, `
      )})
    GROUP BY finalized_by
  `);
  const productionRows = resultRows(productionResult) as Array<{
    workerId: number | string;
    producedBales: number | string;
  }>;
  for (const row of productionRows) {
    producedByWorker.set(Number(row.workerId), Number(row.producedBales) || 0);
  }
  return producedByWorker;
}

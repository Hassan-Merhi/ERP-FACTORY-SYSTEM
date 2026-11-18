// Extracted from ./factoryStaffTrackingRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { registerProductionTargetBonusCoreRoutes } from "./productionTargetBonusCoreRoutes";
import { registerProductionTargetBonusCategoryRateRoutes } from "./productionTargetBonusCategoryRateRoutes";
import { registerProductionTargetBonusWeeklyMethodRoutes } from "./productionTargetBonusWeeklyMethodRoutes";
import { registerProductionTargetBonusWeeklyPreviewRoutes } from "./productionTargetBonusWeeklyPreviewRoutes";
import { registerProductionTargetBonusWeeklyReviewRoutes } from "./productionTargetBonusWeeklyReviewRoutes";
import { registerProductionTargetBonusWeeklyPaymentRoutes } from "./productionTargetBonusWeeklyPaymentRoutes";
import { registerProductionTargetBonusWeeklyReconciliationRoutes } from "./productionTargetBonusWeeklyReconciliationRoutes";
import { registerProductionBonusCategoryEvidenceRoutes } from "./productionBonusCategoryEvidenceRoutes";
import { registerProductionBonusCategoryReviewRoutes } from "./productionBonusCategoryReviewRoutes";
import { registerProductionBonusCheckoutRoutes } from "./productionBonusCheckoutRoutes";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { isProductionTargetsRosterWorker } from "../../services/factory/productionTargetsRoster";
import { loadProductionPeriodSummary } from "../../services/factory/productionPeriodSummary";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { factoryAttendance, factoryWorkers } from "@shared/schema";
import {
  indexProductionWorkerLinks,
  loadActiveProductionWorkerLinks,
} from "../../services/factory/productionWorkerLinks";
import {
  loadProductionTargetDefaults,
  type ProductionTargetDefault,
} from "../../services/factory/productionTargetDefaults";
import {
  isNew,
  joinedByPeriodEnd,
  type SavedTrackingRow,
  type TrackingStatus,
} from "./factoryStaffTrackingValueHelpers";
import {
  canAccessTrackingPage,
  getFactoryCompanyId,
  ISO_DATE,
  loadClosure,
  loadPreviousDailyCarry,
  loadProducedByWorker,
  loadWorkerGroupNames,
  parseTrackingQuery,
} from "./factoryStaffTrackingQueries";

export function registerFactoryStaffTrackingRoutesPart1(app: Express) {
  registerProductionTargetBonusCoreRoutes(app);
  registerProductionTargetBonusCategoryRateRoutes(app);
  registerProductionTargetBonusWeeklyMethodRoutes(app);
  registerProductionTargetBonusWeeklyPreviewRoutes(app);
  registerProductionTargetBonusWeeklyReviewRoutes(app);
  registerProductionTargetBonusWeeklyPaymentRoutes(app);
  registerProductionTargetBonusWeeklyReconciliationRoutes(app);
  registerProductionBonusCategoryEvidenceRoutes(app);
  registerProductionBonusCategoryReviewRoutes(app);
  registerProductionBonusCheckoutRoutes(app);
  app.get("/api/factory/staff-tracking", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
      const query = parseTrackingQuery(req);
      if (!query) return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
      if (!(await canAccessTrackingPage(req, companyId, query.page))) {
        return res.status(403).json({
          message: factoryStaffTrackingMessages.forbiddenTab,
        });
      }

      const closure =
        query.page === "production"
          ? await loadClosure(companyId, query.page, query.periodType, query.periodStart, query.periodEnd)
          : null;
      const finalized = Boolean(closure);

      const savedResult = await db.execute(sql`
        SELECT
          person_type AS "personType",
          person_id AS "personId",
          group_name AS "groupName",
          category,
          category_overridden AS "categoryOverridden",
          target_bales AS "targetBales",
          target_overridden AS "targetBalesOverridden",
          produced_bales AS "producedBales",
          status,
          notes
        FROM factory_staff_tracking_entries
        WHERE company_id = ${companyId}
          AND page_type = ${query.page}
          AND period_type = ${query.periodType}
          AND period_start = ${query.periodStart}
          AND period_end = ${query.periodEnd}
      `);
      const saved = resultRows(savedResult) as SavedTrackingRow[];
      const savedMap = new Map(saved.map((row) => [`${row.personType}:${row.personId}`, row]));

      const workers = await db
        .select({
          id: factoryWorkers.id,
          fullName: factoryWorkers.fullName,
          employeeCode: factoryWorkers.employeeCode,
          department: factoryWorkers.department,
          position: factoryWorkers.position,
          dateJoined: factoryWorkers.dateJoined,
          active: factoryWorkers.active,
        })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.companyId, companyId))
        .orderBy(factoryWorkers.fullName);

      const workerGroupNames = await loadWorkerGroupNames(companyId);
      const activeProductionLinks =
        query.page === "production" && query.periodType === "daily"
          ? await loadActiveProductionWorkerLinks(companyId, query.periodStart)
          : [];
      const productionLinkByWorker = indexProductionWorkerLinks(activeProductionLinks);
      const includedWorkers = workers.filter((person) => {
        const savedForPeriod = savedMap.has(`worker:${person.id}`);
        if (query.page === "production") {
          // Keep today's Production Targets table and bonus checkout on the
          // exact same per-day membership contract.
          return isProductionTargetsRosterWorker({
            finalized,
            savedForPeriod,
            plannerAssigned: workerGroupNames.has(person.id),
            linkedForPeriod: productionLinkByWorker.has(person.id),
            active: person.active,
            joinedByPeriodEnd: joinedByPeriodEnd(person.dateJoined, query.periodEnd),
          });
        }

        // Attendance must include every factory worker, regardless of Production Planner group membership.
        // The separate ERP employees table is intentionally not included here.
        return savedForPeriod || (person.active && joinedByPeriodEnd(person.dateJoined, query.periodEnd));
      });

      // Weekly/monthly Production Targets are read-only rollups of DAILY
      // targets, attendance and physical bale credits. A saved weekly row
      // does not contain the worker's date-effective daily target.
      if (query.page === "production" && query.periodType !== "daily") {
        // Use the union of workers actually present on ANY date in the range.
        // Restricting to the roster at periodEnd loses workers removed or
        // reassigned before the last day, along with their daily target totals.
        const rollup = await loadProductionPeriodSummary(
          companyId,
          query.periodStart,
          query.periodEnd,
          workers.map((worker) => worker.id)
        );
        const periodWorkers = workers.filter((worker) => rollup.has(worker.id));
        const periodRows = periodWorkers.map((worker) => {
          const total = rollup.get(worker.id);
          return {
            personType: "worker" as const,
            personId: worker.id,
            name: worker.fullName,
            code: worker.employeeCode,
            groupName: workerGroupNames.get(worker.id)?.[0] ?? "",
            category: total?.category || worker.position || worker.department || "",
            targetBales: total?.targetBales ?? null,
            absentTargetBales: total?.absentTargetBales ?? 0,
            producedBales: total?.producedBales ?? 0,
            status: total?.status ?? "Present",
            absentDays: total?.absentDays ?? 0,
            periodDays: total?.days ?? 0,
            missingTargetDays: total?.missingTargetDays ?? 0,
            notes: "",
            active: worker.active,
            // A link can change in the middle of the week/month. Credited
            // worker totals are already distributed by day, so do not
            // collapse the entire period under a single link group.
            linkGroupId: null,
            linkedWorkerIds: [],
            linkedWorkers: [],
          };
        });
        res.setHeader("Cache-Control", "private, no-store");
        return res.json({
          page: query.page,
          periodType: query.periodType,
          periodStart: query.periodStart,
          periodEnd: query.periodEnd,
          finalized: false,
          finalizedAt: null,
          rows: periodRows,
        });
      }

      const workerAttendance = new Map<number, string>();
      if (query.periodType === "daily") {
        const workerIds = includedWorkers.map((worker) => worker.id);
        if (workerIds.length > 0) {
          const rows = await db
            .select({ workerId: factoryAttendance.workerId, status: factoryAttendance.status })
            .from(factoryAttendance)
            .where(
              and(
                eq(factoryAttendance.companyId, companyId),
                eq(factoryAttendance.attendanceDate, query.periodStart),
                inArray(factoryAttendance.workerId, workerIds)
              )
            );
          rows.forEach((row) => workerAttendance.set(row.workerId, row.status));
        }
      }

      let producedByWorker = new Map<number, number>();
      if (query.page === "production" && !finalized) {
        const carryFrom =
          query.periodType === "daily" ? await loadPreviousDailyCarry(companyId, query.periodStart) : null;
        producedByWorker = await loadProducedByWorker(
          companyId,
          query.periodStart,
          query.periodEnd,
          includedWorkers.map((worker) => worker.id),
          carryFrom
        );
      }

      // Daily defaults are the template for every open production day. A saved
      // tracking row only replaces category or target when Edit Targets explicitly
      // marked that field as a day-specific override.
      const productionTargetDefaults =
        query.page === "production" && query.periodType === "daily" && !finalized
          ? await loadProductionTargetDefaults(companyId, query.periodStart)
          : new Map<number, ProductionTargetDefault>();

      const workerRows = includedWorkers.map((worker) => {
        const savedRow = savedMap.get(`worker:${worker.id}`);
        const attendanceStatus = workerAttendance.get(worker.id);
        const defaultStatus: TrackingStatus = isNew(worker.dateJoined, query.periodStart, query.periodEnd)
          ? "New"
          : attendanceStatus === "Absent"
            ? "Absent"
            : "Present";
        const currentGroupName =
          query.page === "attendance" ? "All Workers" : (workerGroupNames.get(worker.id)?.[0] ?? "");
        const groupName = finalized ? (savedRow?.groupName ?? currentGroupName) : currentGroupName;
        const savedTargetBales =
          savedRow?.targetBales === null || savedRow?.targetBales === undefined ? null : Number(savedRow.targetBales);
        const productionDefault =
          query.page === "production" && query.periodType === "daily" && !finalized
            ? productionTargetDefaults.get(worker.id)
            : undefined;
        const defaultCategory = productionDefault?.category ?? worker.position ?? worker.department ?? "";
        const categoryOverridden =
          query.page === "production" &&
          query.periodType === "daily" &&
          !finalized &&
          savedRow?.categoryOverridden === true;
        const category = finalized
          ? (savedRow?.category ?? worker.position ?? worker.department ?? "")
          : query.page === "production" && query.periodType === "daily"
            ? categoryOverridden
              ? (savedRow?.category ?? "")
              : defaultCategory
            : (savedRow?.category ?? worker.position ?? worker.department ?? "");
        const defaultTargetBales =
          query.page === "production" && query.periodType === "daily" && !finalized
            ? (productionDefault?.targetBales ?? null)
            : null;
        const productionLink = productionLinkByWorker.get(worker.id);
        const targetBalesOverridden =
          query.page === "production" &&
          query.periodType === "daily" &&
          !finalized &&
          savedRow?.targetBalesOverridden === true;
        const targetBales = finalized
          ? savedTargetBales
          : query.page === "production" && query.periodType === "daily"
            ? targetBalesOverridden
              ? savedTargetBales
              : defaultTargetBales
            : savedTargetBales;
        const linkedProducedBales =
          productionLink && query.page === "production" && !finalized
            ? productionLink.members.reduce((sum, member) => sum + (producedByWorker.get(member.workerId) ?? 0), 0)
            : null;

        return {
          personType: "worker" as const,
          personId: worker.id,
          name: worker.fullName,
          code: worker.employeeCode,
          groupName,
          category,
          defaultCategory,
          categoryOverridden,
          targetBales,
          defaultTargetBales,
          targetBalesOverridden,
          producedBales:
            query.page === "production"
              ? finalized
                ? Number(savedRow?.producedBales ?? 0)
                : (linkedProducedBales ?? producedByWorker.get(worker.id) ?? 0)
              : savedRow?.producedBales === null || savedRow?.producedBales === undefined
                ? null
                : Number(savedRow.producedBales),
          status: query.page === "production" && !finalized ? defaultStatus : (savedRow?.status ?? defaultStatus),
          notes: savedRow?.notes ?? "",
          active: worker.active,
          linkGroupId: productionLink?.id ?? null,
          linkedWorkerIds: productionLink?.members.map((member) => member.workerId) ?? [],
          linkedWorkers: productionLink?.members ?? [],
        };
      });

      res.json({
        page: query.page,
        periodType: query.periodType,
        periodStart: query.periodStart,
        periodEnd: query.periodEnd,
        finalized,
        finalizedAt: closure?.endedAt ?? null,
        rows: workerRows,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    "/api/factory/staff-tracking/production-target-defaults",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
        if (!(await canAccessTrackingPage(req, companyId, "production"))) {
          return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
        }

        const asOf = String(req.query.asOf || "");
        if (!ISO_DATE.test(asOf)) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
        }

        const defaults = await loadProductionTargetDefaults(companyId, asOf);
        res.json({
          asOf,
          targets: [...defaults.entries()].map(([workerId, defaultsForWorker]) => ({
            workerId,
            category: defaultsForWorker.category,
            targetBales: defaultsForWorker.targetBales,
          })),
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

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
import {
  freezeProductionBonusCategoryEvidence,
  type CategoryCaptureCarry,
} from "../../services/factory/productionBonusCategoryCapture";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { isProductionTargetsRosterWorker } from "../../services/factory/productionTargetsRoster";
import { loadProductionPeriodSummary } from "../../services/factory/productionPeriodSummary";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { attendanceApprovalRateLimiter, requireAttendanceEditApproval } from "./attendanceEditPolicy";
import { logAudit } from "../helpers/auditWriteAdapter";
import { employees, factoryAttendance, factoryWorkers } from "@shared/schema";
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
  numberOrNull,
  type NormalizedTrackingRow,
  type PeriodType,
  type PersonType,
  type SavedTrackingRow,
  type TrackingPage,
  type TrackingStatus,
} from "./factoryStaffTrackingValueHelpers";

import {
  PAGE_TYPES,
  PERIOD_TYPES,
  STATUSES,
  ISO_DATE,
  getFactoryCompanyId,
  canAccessTrackingPage,
  parseTrackingQuery,
  loadWorkerGroupNames,
  loadClosure,
  loadPreviousDailyCarry,
  loadProducedByWorker,
} from "./factoryStaffTrackingQueries";

export function registerFactoryStaffTrackingRoutes(app: Express): void {
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

  app.post(
    "/api/factory/staff-tracking/production-target-defaults",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
        if (!(await canAccessTrackingPage(req, companyId, "production"))) {
          return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
        }

        const effectiveFrom = String(req.body?.effectiveFrom || "");
        const records = Array.isArray(req.body?.records) ? req.body.records : [];
        if (!ISO_DATE.test(effectiveFrom)) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
        }
        if (records.length === 0 || records.length > 500) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidRecordCount });
        }

        const allWorkers = await db
          .select({ id: factoryWorkers.id })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.companyId, companyId));
        const workerIds = new Set(allWorkers.map((row) => row.id));
        const workerGroupNames = await loadWorkerGroupNames(companyId);
        const normalized: Array<{ workerId: number; category: string; targetBales: number | null }> = [];
        const seen = new Set<number>();

        for (const raw of records) {
          const workerId = Number(raw?.workerId);
          const category = String(raw?.category ?? "")
            .trim()
            .slice(0, 150);
          const targetBales = numberOrNull(raw?.targetBales);

          if (!Number.isInteger(workerId) || workerId <= 0 || !workerIds.has(workerId)) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.personOutsideFactory });
          }
          if (!workerGroupNames.has(workerId)) {
            return res.status(400).json({ message: "Worker is not assigned to a saved Production Planner group" });
          }
          if (seen.has(workerId)) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.duplicatePersonInBatch });
          }
          if (
            raw?.targetBales !== null &&
            raw?.targetBales !== undefined &&
            raw?.targetBales !== "" &&
            targetBales === null
          ) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.invalidBaleNumbers });
          }

          seen.add(workerId);
          normalized.push({ workerId, category, targetBales });
        }

        const values = normalized.map(
          ({ workerId, category, targetBales }) => sql`(
          ${companyId}, ${workerId}, ${effectiveFrom}, ${category}, ${targetBales},
          ${req.session.userId || null}, now(), now()
        )`
        );

        await db.execute(sql`
        INSERT INTO factory_worker_production_target_defaults (
          company_id, worker_id, effective_from, category, target_bales, created_by, created_at, updated_at
        ) VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (company_id, worker_id, effective_from)
        DO UPDATE SET
          category = EXCLUDED.category,
          target_bales = EXCLUDED.target_bales,
          created_by = EXCLUDED.created_by,
          updated_at = now()
      `);

        res.json({ success: true, saved: normalized.length, effectiveFrom });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/staff-tracking/bulk",
    requireAuth,
    attendanceApprovalRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });

        const page = String(req.body?.page || "") as TrackingPage;
        const periodType = String(req.body?.periodType || "") as PeriodType;
        const periodStart = String(req.body?.periodStart || "");
        const periodEnd = String(req.body?.periodEnd || "");
        const finalize = req.body?.finalize === true;
        const records = Array.isArray(req.body?.records) ? req.body.records : [];

        if (
          !PAGE_TYPES.has(page) ||
          !PERIOD_TYPES.has(periodType) ||
          !ISO_DATE.test(periodStart) ||
          !ISO_DATE.test(periodEnd) ||
          periodEnd < periodStart
        ) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
        }
        if (!(await canAccessTrackingPage(req, companyId, page))) {
          return res.status(403).json({
            message: factoryStaffTrackingMessages.forbiddenTab,
          });
        }
        if (finalize && (page !== "production" || periodType !== "daily" || periodStart !== periodEnd)) {
          return res
            .status(400)
            .json({ message: "End Production is only available for a single daily production date" });
        }
        if (records.length === 0 || records.length > 500) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidRecordCount });
        }

        const attendanceApprover =
          page === "attendance"
            ? await requireAttendanceEditApproval(req, res, companyId, [periodStart, periodEnd], {
                adminUsername: req.body?.adminUsername,
                adminPassword: req.body?.adminPassword,
              })
            : null;
        if (attendanceApprover === undefined) return;

        if (page === "production") {
          const existingClosure = await loadClosure(companyId, page, periodType, periodStart, periodEnd);
          if (existingClosure) {
            return res.status(409).json({
              message: "Production has already ended for this day and is locked",
              finalized: true,
              finalizedAt: existingClosure.endedAt,
            });
          }
        }

        const allWorkers = await db
          .select({ id: factoryWorkers.id, dateJoined: factoryWorkers.dateJoined })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.companyId, companyId));
        const allEmployees = await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              eq(employees.companyId, companyId),
              eq(employees.employeeType, "Employee"),
              sql`${employees.deletedAt} IS NULL`
            )
          );
        const workerIds = new Set(allWorkers.map((row) => row.id));
        const workerJoinDates = new Map(allWorkers.map((row) => [row.id, row.dateJoined]));
        const employeeIds = new Set(allEmployees.map((row) => row.id));
        const workerGroupNames = await loadWorkerGroupNames(companyId);
        const activeProductionLinks =
          page === "production" && periodType === "daily"
            ? await loadActiveProductionWorkerLinks(companyId, periodStart)
            : [];
        const productionAttendance = new Map<number, string>();

        if (page === "production" && periodType === "daily" && workerIds.size > 0) {
          const attendanceRows = await db
            .select({ workerId: factoryAttendance.workerId, status: factoryAttendance.status })
            .from(factoryAttendance)
            .where(
              and(
                eq(factoryAttendance.companyId, companyId),
                eq(factoryAttendance.attendanceDate, periodStart),
                inArray(factoryAttendance.workerId, [...workerIds])
              )
            );
          attendanceRows.forEach((row) => productionAttendance.set(row.workerId, row.status));
        }

        const normalizedRecords: NormalizedTrackingRow[] = [];
        const recordKeys = new Set<string>();

        for (const raw of records) {
          const personType = String(raw?.personType || "") as PersonType;
          const personId = Number(raw?.personId);
          const requestedStatus = String(raw?.status || "Present") as TrackingStatus;
          if (
            !Number.isInteger(personId) ||
            personId <= 0 ||
            (page === "attendance" && !STATUSES.has(requestedStatus))
          ) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.invalidRow });
          }
          if (
            (personType === "worker" && !workerIds.has(personId)) ||
            (personType === "employee" && !employeeIds.has(personId))
          ) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.personOutsideFactory });
          }
          if (personType !== "worker" && personType !== "employee") {
            return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPersonType });
          }
          if (page === "production" && personType !== "worker") {
            return res.status(400).json({ message: "Production Targets only supports factory workers" });
          }
          if (page === "production" && personType === "worker" && !workerGroupNames.has(personId)) {
            return res.status(400).json({ message: "Worker is not assigned to a saved Production Planner group" });
          }

          const recordKey = `${personType}:${personId}`;
          if (recordKeys.has(recordKey)) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.duplicatePersonInBatch });
          }
          recordKeys.add(recordKey);

          const category =
            String(raw?.category || "")
              .trim()
              .slice(0, 150) || null;
          const notes =
            String(raw?.notes || "")
              .trim()
              .slice(0, 4000) || null;
          const categoryOverridden =
            page === "production" && periodType === "daily" && raw?.categoryOverridden === true;
          const targetBales = numberOrNull(raw?.targetBales);
          const targetBalesOverridden =
            page === "production" && periodType === "daily" && raw?.targetBalesOverridden === true;
          const requestedProducedBales = numberOrNull(raw?.producedBales);
          const producedBales = page === "production" ? null : requestedProducedBales;
          if (
            (raw?.targetBales !== null &&
              raw?.targetBales !== undefined &&
              raw?.targetBales !== "" &&
              targetBales === null) ||
            (page !== "production" &&
              raw?.producedBales !== null &&
              raw?.producedBales !== undefined &&
              raw?.producedBales !== "" &&
              requestedProducedBales === null)
          ) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.invalidBaleNumbers });
          }

          const status: TrackingStatus =
            page === "production"
              ? isNew(workerJoinDates.get(personId), periodStart, periodEnd)
                ? "New"
                : productionAttendance.get(personId) === "Absent"
                  ? "Absent"
                  : "Present"
              : requestedStatus;

          normalizedRecords.push({
            personType,
            personId,
            groupName:
              personType === "worker"
                ? page === "attendance"
                  ? "All Workers"
                  : (workerGroupNames.get(personId)?.[0] ?? null)
                : null,
            category,
            categoryOverridden,
            notes,
            targetBales,
            targetBalesOverridden,
            producedBales,
            status,
          });
        }

        let finalizeCarryFrom: CategoryCaptureCarry | null = null;
        let finalizedSourceCount: number | null = null;
        if (finalize) {
          const finalizeWorkerIds = normalizedRecords
            .filter((row) => row.personType === "worker")
            .map((row) => row.personId);
          const carryFrom = await loadPreviousDailyCarry(companyId, periodStart);
          finalizeCarryFrom = carryFrom;
          const producedByWorker = await loadProducedByWorker(
            companyId,
            periodStart,
            periodEnd,
            finalizeWorkerIds,
            carryFrom
          );
          finalizedSourceCount = [...producedByWorker.values()].reduce((total, count) => total + count, 0);
          for (const row of normalizedRecords) {
            if (row.personType === "worker") row.producedBales = producedByWorker.get(row.personId) ?? 0;
          }

          // Every linked worker displays the shared team output. The production
          // summary de-duplicates the link so the factory total is still counted once.
          for (const link of activeProductionLinks) {
            const teamProduced = link.members.reduce(
              (sum, member) => sum + (producedByWorker.get(member.workerId) ?? 0),
              0
            );
            const memberIds = new Set(link.members.map((member) => member.workerId));
            for (const row of normalizedRecords) {
              if (row.personType === "worker" && memberIds.has(row.personId)) {
                row.producedBales = teamProduced;
              }
            }
          }
        }

        const values = normalizedRecords.map(
          ({
            personType,
            personId,
            groupName,
            category,
            categoryOverridden,
            targetBales,
            targetBalesOverridden,
            producedBales,
            status,
            notes,
          }) => sql`(
          ${companyId}, ${page}, ${periodType}, ${periodStart}, ${periodEnd},
          ${personType}, ${personId}, ${groupName}, ${category}, ${categoryOverridden},
          ${targetBales}, ${targetBalesOverridden}, ${producedBales}, ${status}, ${notes},
          ${req.session.userId || null}, now()
        )`
        );

        await db.transaction(async (tx) => {
          if (attendanceApprover) {
            await logAudit(
              {
                userId: String(req.session.userId || req.user?.id || ""),
                username: String((req.user as { username?: string } | undefined)?.username || req.session.userId || ""),
                companyId,
                action: "update",
                tableName: "factory_staff_tracking_entries",
                recordIdentifier: `attendance:${periodType}:${periodStart}:${periodEnd}`,
                changes: {
                  approvedBy: { new: attendanceApprover.username },
                  approvedByUserId: { new: attendanceApprover.id },
                  authorizationMethod: { new: attendanceApprover.authorizationMethod },
                  periodStart: { new: periodStart },
                  periodEnd: { new: periodEnd },
                  personIds: { new: normalizedRecords.map(({ personType, personId }) => `${personType}:${personId}`) },
                },
              },
              tx
            );
          }
          if (finalize) {
            // Serialize closing the production day with bonus approval/payment
            // (84023). An in-flight live bonus decision cannot race the immutable
            // finalized source at the same company.
            await tx.execute(sql`SELECT pg_advisory_xact_lock(84023, ${companyId})`);
            // Recheck inside the serialized close transaction, not just before
            // calculating the daily matrix; conflicting closes must roll back.
            await tx.execute(sql`SELECT pg_advisory_xact_lock(7643, ${companyId})`);
            const locked = resultRows(
              await tx.execute(sql`
            SELECT 1 FROM factory_staff_tracking_period_closures
            WHERE company_id = ${companyId} AND page_type = 'production'
              AND period_type = 'daily' AND period_start = ${periodStart}::date
              AND period_end = ${periodEnd}::date LIMIT 1
          `)
            );
            if (locked.length) throw new Error("Production already finalized; category evidence is immutable");
          }
          if (page === "production") {
            const currentWorkerIds = normalizedRecords.map((row) => row.personId);
            await tx.execute(sql`
            DELETE FROM factory_staff_tracking_entries
            WHERE company_id = ${companyId}
              AND page_type = ${page}
              AND period_type = ${periodType}
              AND period_start = ${periodStart}
              AND period_end = ${periodEnd}
              AND person_type = 'worker'
              AND NOT (person_id = ANY(${sqlArray(currentWorkerIds)}))
          `);
          }

          await tx.execute(sql`
          INSERT INTO factory_staff_tracking_entries (
            company_id, page_type, period_type, period_start, period_end,
            person_type, person_id, group_name, category, category_overridden,
            target_bales, target_overridden, produced_bales, status, notes, created_by, updated_at
          ) VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT (company_id, page_type, period_type, period_start, period_end, person_type, person_id)
          DO UPDATE SET
            group_name = EXCLUDED.group_name,
            category = EXCLUDED.category,
            category_overridden = EXCLUDED.category_overridden,
            target_bales = EXCLUDED.target_bales,
            target_overridden = EXCLUDED.target_overridden,
            produced_bales = EXCLUDED.produced_bales,
            status = EXCLUDED.status,
            notes = EXCLUDED.notes,
            updated_at = now()
        `);

          if (finalize) {
            const frozenBales = await freezeProductionBonusCategoryEvidence(
              tx,
              companyId,
              periodStart,
              normalizedRecords.filter((row) => row.personType === "worker").map((row) => row.personId),
              String(req.session.userId || ""),
              finalizeCarryFrom
            );
            if (frozenBales !== finalizedSourceCount)
              throw new Error("Production changed while finalizing; bale category evidence and totals disagree");
            await tx.execute(sql`
            INSERT INTO factory_staff_tracking_period_closures (
              company_id, page_type, period_type, period_start, period_end, ended_by, ended_at
            ) VALUES (
              ${companyId}, ${page}, ${periodType}, ${periodStart}, ${periodEnd}, ${req.session.userId || null}, now()
            )
            ON CONFLICT (company_id, page_type, period_type, period_start, period_end) DO NOTHING
          `);
          }
        });

        res.json({ success: true, saved: records.length, finalized: finalize });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

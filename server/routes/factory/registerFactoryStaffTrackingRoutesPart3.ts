// Extracted from ./factoryStaffTrackingRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  type CategoryCaptureCarry,
  freezeProductionBonusCategoryEvidence,
} from "../../services/factory/productionBonusCategoryCapture";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { attendanceApprovalRateLimiter, requireAttendanceEditApproval } from "./attendanceEditPolicy";
import { logAudit } from "../helpers/auditWriteAdapter";
import { employees, factoryAttendance, factoryWorkers } from "@shared/schema";
import { loadActiveProductionWorkerLinks } from "../../services/factory/productionWorkerLinks";
import {
  isNew,
  type NormalizedTrackingRow,
  numberOrNull,
  type PeriodType,
  type PersonType,
  type TrackingPage,
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
  PAGE_TYPES,
  PERIOD_TYPES,
  STATUSES,
} from "./factoryStaffTrackingQueries";

// The handler keeps its own period, count and per-record checks and messages;
// this fixes the shape the Production Targets screens send.
const trackingNumber = z.union([z.number(), z.string()]);
const bulkTrackingInput = {
  query: emptyQuery,
  body: z.strictObject({
    page: z.string().optional(),
    periodType: z.string().optional(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    finalize: z.boolean().optional(),
    adminUsername: z.string().nullable().optional(),
    adminPassword: z.string().nullable().optional(),
    records: z
      .array(
        z.strictObject({
          personType: z.string().optional(),
          personId: trackingNumber,
          status: z.string().nullable().optional(),
          category: z.string().nullable().optional(),
          categoryOverridden: z.boolean().optional(),
          targetBales: trackingNumber.nullable().optional(),
          targetBalesOverridden: z.boolean().optional(),
          producedBales: trackingNumber.nullable().optional(),
          notes: z.string().nullable().optional(),
          groupName: z.unknown().optional(), // sent by client/src/pages/factory/useFactoryProductionTargetsState.ts; not used
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

export function registerFactoryStaffTrackingRoutesPart3(app: Express) {
  app.post(
    "/api/factory/staff-tracking/bulk",
    requireAuth,
    attendanceApprovalRateLimiter,
    validateRequest(bulkTrackingInput),
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

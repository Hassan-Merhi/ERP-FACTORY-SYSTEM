import type { Express, Request, Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { employees, factoryAttendance, factoryWorkers } from "@shared/schema";

type TrackingPage = "production" | "attendance";
type PeriodType = "daily" | "weekly" | "monthly";
type PersonType = "worker" | "employee";
type TrackingStatus = "Present" | "Absent" | "New";

type SavedTrackingRow = {
  personType: PersonType;
  personId: number;
  groupName: string | null;
  category: string | null;
  targetBales: string | null;
  producedBales: string | null;
  status: TrackingStatus;
  notes: string | null;
};

type NormalizedTrackingRow = {
  personType: PersonType;
  personId: number;
  groupName: string | null;
  category: string | null;
  notes: string | null;
  targetBales: number | null;
  producedBales: number | null;
  status: TrackingStatus;
};

const PAGE_TYPES = new Set<TrackingPage>(["production", "attendance"]);
const PERIOD_TYPES = new Set<PeriodType>(["daily", "weekly", "monthly"]);
const STATUSES = new Set<TrackingStatus>(["Present", "Absent", "New"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTED_PRODUCTION_BALE_STATUSES = [
  "IN_STOCK",
  "SOLD",
  "RESERVED_FOR_ORDER",
  "DISPATCHED",
  "FINALIZED",
] as const;

function getFactoryCompanyId(req: Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

function parseTrackingQuery(req: Request): {
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
  return { page, periodType, periodStart, periodEnd };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isNew(joinDate: string | null | undefined, start: string, end: string): boolean {
  return Boolean(joinDate && joinDate >= start && joinDate <= end);
}

function joinedByPeriodEnd(joinDate: string | null | undefined, periodEnd: string): boolean {
  return !joinDate || joinDate <= periodEnd;
}

function parseWorkerIds(value: unknown): number[] {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const json = JSON.parse(value);
      return Array.isArray(json) ? json : [];
    } catch {
      return [];
    }
  })();

  return parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

function addIsoDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadWorkerGroupNames(companyId: number): Promise<Map<number, string[]>> {
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

async function loadClosure(
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

async function loadPreviousDailyCarry(
  companyId: number,
  periodStart: string
): Promise<{ date: string; endedAt: Date | string } | null> {
  const previousDate = addIsoDays(periodStart, -1);
  const closure = await loadClosure(companyId, "production", "daily", previousDate, previousDate);
  return closure ? { date: previousDate, endedAt: closure.endedAt } : null;
}

async function loadProducedByWorker(
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

export function registerFactoryStaffTrackingRoutes(app: Express): void {
  app.get("/api/factory/staff-tracking", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
      const query = parseTrackingQuery(req);
      if (!query) return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });

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
          target_bales AS "targetBales",
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
      const includedWorkers = workers.filter((person) => {
        const savedForPeriod = savedMap.has(`worker:${person.id}`);
        if (query.page === "production" && finalized) return savedForPeriod;
        return (
          workerGroupNames.has(person.id) &&
          (savedForPeriod || (person.active && joinedByPeriodEnd(person.dateJoined, query.periodEnd)))
        );
      });

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

      const workerRows = includedWorkers.map((worker) => {
        const savedRow = savedMap.get(`worker:${worker.id}`);
        const attendanceStatus = workerAttendance.get(worker.id);
        const defaultStatus: TrackingStatus = isNew(worker.dateJoined, query.periodStart, query.periodEnd)
          ? "New"
          : attendanceStatus === "Absent"
            ? "Absent"
            : "Present";
        const currentGroupName = workerGroupNames.get(worker.id)?.[0] ?? "";
        const groupName = finalized ? (savedRow?.groupName ?? currentGroupName) : currentGroupName;

        return {
          personType: "worker" as const,
          personId: worker.id,
          name: worker.fullName,
          code: worker.employeeCode,
          groupName,
          category: savedRow?.category ?? worker.position ?? worker.department ?? "",
          targetBales:
            savedRow?.targetBales === null || savedRow?.targetBales === undefined ? null : Number(savedRow.targetBales),
          producedBales:
            query.page === "production"
              ? finalized
                ? Number(savedRow?.producedBales ?? 0)
                : (producedByWorker.get(worker.id) ?? 0)
              : savedRow?.producedBales === null || savedRow?.producedBales === undefined
                ? null
                : Number(savedRow.producedBales),
          status: savedRow?.status ?? defaultStatus,
          notes: savedRow?.notes ?? "",
          active: worker.active,
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

  app.post("/api/factory/staff-tracking/bulk", requireAuth, async (req: Request, res: Response) => {
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
      if (finalize && (page !== "production" || periodType !== "daily" || periodStart !== periodEnd)) {
        return res.status(400).json({ message: "End Production is only available for a single daily production date" });
      }
      if (records.length === 0 || records.length > 500) {
        return res.status(400).json({ message: factoryStaffTrackingMessages.invalidRecordCount });
      }

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
        .select({ id: factoryWorkers.id })
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
      const employeeIds = new Set(allEmployees.map((row) => row.id));
      const workerGroupNames = await loadWorkerGroupNames(companyId);

      const normalizedRecords: NormalizedTrackingRow[] = [];
      const recordKeys = new Set<string>();

      for (const raw of records) {
        const personType = String(raw?.personType || "") as PersonType;
        const personId = Number(raw?.personId);
        const status = String(raw?.status || "Present") as TrackingStatus;
        if (!Number.isInteger(personId) || personId <= 0 || !STATUSES.has(status)) {
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
        if (personType === "worker" && !workerGroupNames.has(personId)) {
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
        const targetBales = numberOrNull(raw?.targetBales);
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

        normalizedRecords.push({
          personType,
          personId,
          groupName: personType === "worker" ? (workerGroupNames.get(personId)?.[0] ?? null) : null,
          category,
          notes,
          targetBales,
          producedBales,
          status,
        });
      }

      if (finalize) {
        const finalizeWorkerIds = normalizedRecords
          .filter((row) => row.personType === "worker")
          .map((row) => row.personId);
        const carryFrom = await loadPreviousDailyCarry(companyId, periodStart);
        const producedByWorker = await loadProducedByWorker(
          companyId,
          periodStart,
          periodEnd,
          finalizeWorkerIds,
          carryFrom
        );
        for (const row of normalizedRecords) {
          if (row.personType === "worker") row.producedBales = producedByWorker.get(row.personId) ?? 0;
        }
      }

      const values = normalizedRecords.map(
        ({ personType, personId, groupName, category, targetBales, producedBales, status, notes }) => sql`(
          ${companyId}, ${page}, ${periodType}, ${periodStart}, ${periodEnd},
          ${personType}, ${personId}, ${groupName}, ${category}, ${targetBales}, ${producedBales},
          ${status}, ${notes}, ${req.session.userId || null}, now()
        )`
      );

      await db.transaction(async (tx) => {
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
            person_type, person_id, group_name, category, target_bales, produced_bales,
            status, notes, created_by, updated_at
          ) VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT (company_id, page_type, period_type, period_start, period_end, person_type, person_id)
          DO UPDATE SET
            group_name = EXCLUDED.group_name,
            category = EXCLUDED.category,
            target_bales = EXCLUDED.target_bales,
            produced_bales = EXCLUDED.produced_bales,
            status = EXCLUDED.status,
            notes = EXCLUDED.notes,
            updated_at = now()
        `);

        if (finalize) {
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
  });
}
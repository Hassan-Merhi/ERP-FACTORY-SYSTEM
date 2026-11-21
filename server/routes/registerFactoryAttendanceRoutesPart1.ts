// Extracted from ./factoryAttendanceRoutes.ts
import type { Database } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import type { Express, Request, Response, RequestHandler } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { factoryAttendance, factoryWorkers } from "@shared/schema";
import { logAudit } from "./helpers/auditWriteAdapter";
import { attendanceApprovalRateLimiter, requireAttendanceEditApproval } from "./factory/attendanceEditPolicy";

export function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

export function registerFactoryAttendanceRoutesPart1(app: Express, requireAuth: RequestHandler, db: Database) {
  // GET /api/factory/attendance?date=YYYY-MM-DD&shift=
  // Returns active workers + merged attendance for that date
  app.get("/api/factory/attendance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company" });

      const { date } = req.query as { date?: string; shift?: string };
      if (!date) return res.status(400).json({ message: "date is required" });

      // Return ALL workers (active + inactive) with the active flag so the
      // frontend can split them for the two-sheet Excel export while still
      // only showing active workers in the UI.
      const workers = await db
        .select({
          id: factoryWorkers.id,
          fullName: factoryWorkers.fullName,
          employeeCode: factoryWorkers.employeeCode,
          department: factoryWorkers.department,
          position: factoryWorkers.position,
          shiftType: factoryWorkers.shiftType,
          active: factoryWorkers.active,
        })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.companyId, companyId))
        .orderBy(factoryWorkers.fullName);

      if (workers.length === 0) return res.json({ workers: [], attendance: [] });

      const workerIds = workers.map((w) => w.id);

      const existing = await db
        .select()
        .from(factoryAttendance)
        .where(
          and(
            eq(factoryAttendance.companyId, companyId),
            eq(factoryAttendance.attendanceDate, date),
            inArray(factoryAttendance.workerId, workerIds)
          )
        );

      res.json({ workers, attendance: existing });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // POST /api/factory/attendance/bulk
  // Upsert attendance records
  app.post(
    "/api/factory/attendance/bulk",
    requireAuth,
    attendanceApprovalRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company" });

        const { records, adminUsername, adminPassword } = (req.body ?? {}) as {
          records: Array<{
            workerId: number;
            attendanceDate: string;
            shift?: string;
            status: string;
            notes?: string;
          }>;
          adminUsername?: string;
          adminPassword?: string;
        };

        if (!Array.isArray(records) || !records.length || records.length > 500) {
          return res.status(400).json({ message: "Provide 1–500 attendance records" });
        }
        const allowedStatuses = new Set(["Present", "Absent", "Late", "Half Day", "Leave"]);
        const seen = new Set<string>();
        for (const record of records) {
          if (
            !Number.isSafeInteger(record?.workerId) ||
            record.workerId <= 0 ||
            !allowedStatuses.has(record?.status) ||
            (record?.notes !== undefined && (typeof record.notes !== "string" || record.notes.length > 4000)) ||
            (record?.shift !== undefined && (typeof record.shift !== "string" || record.shift.length > 50))
          ) {
            return res.status(400).json({ message: "Invalid attendance record" });
          }
          const key = `${record.workerId}:${record.attendanceDate}`;
          if (seen.has(key)) return res.status(400).json({ message: "Duplicate worker/date in attendance batch" });
          seen.add(key);
        }

        // Validate all dates. Earlier attendance requires fresh, company-scoped
        // Admin approval, including when the requester is an Owner.
        const approvedBy = await requireAttendanceEditApproval(
          req,
          res,
          companyId,
          records.map((record) => record.attendanceDate),
          { adminUsername, adminPassword }
        );
        if (approvedBy === undefined) return;

        const workerIds = [...new Set(records.map((record) => record.workerId))];
        const companyWorkers = await db
          .select({
            id: factoryWorkers.id,
            active: factoryWorkers.active,
            contractEndDate: factoryWorkers.contractEndDate,
          })
          .from(factoryWorkers)
          .where(and(eq(factoryWorkers.companyId, companyId), inArray(factoryWorkers.id, workerIds)));
        if (companyWorkers.length !== workerIds.length) {
          return res.status(400).json({ message: "Attendance includes a worker outside this factory company" });
        }

        // Never allow ordinary bulk saves to overwrite an inactive period with
        // Present. Reactivation preserves those historical Absent rows.
        const workerById = new Map(companyWorkers.map((worker) => [worker.id, worker]));
        for (const record of records) {
          const worker = workerById.get(record.workerId)!;
          if (
            !worker.active &&
            worker.contractEndDate &&
            record.attendanceDate >= String(worker.contractEndDate).slice(0, 10) &&
            record.status !== "Absent"
          ) {
            return res.status(409).json({ message: "Inactive worker dates must remain Absent" });
          }
        }

        const now = new Date();
        const requesterId = String(req.session.userId || req.user?.id || "");
        const requesterName = String((req.user as { username?: string } | undefined)?.username || requesterId);
        await db.transaction(async (tx) => {
          for (const record of records) {
            const [before] = approvedBy
              ? await tx
                  .select()
                  .from(factoryAttendance)
                  .where(
                    and(
                      eq(factoryAttendance.companyId, companyId),
                      eq(factoryAttendance.workerId, record.workerId),
                      eq(factoryAttendance.attendanceDate, record.attendanceDate)
                    )
                  )
                  .limit(1)
              : [];

            await tx
              .insert(factoryAttendance)
              .values({
                companyId,
                workerId: record.workerId,
                attendanceDate: record.attendanceDate,
                shift: record.shift || null,
                status: record.status,
                notes: record.notes || null,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [factoryAttendance.workerId, factoryAttendance.attendanceDate],
                set: {
                  status: record.status,
                  shift: record.shift || null,
                  notes: record.notes || null,
                  updatedAt: now,
                },
              });

            // The audit event is committed with the historical attendance change.
            if (
              approvedBy &&
              (!before ||
                before.status !== record.status ||
                (before.notes || null) !== (record.notes || null) ||
                (before.shift || null) !== (record.shift || null))
            ) {
              await logAudit(
                {
                  userId: requesterId,
                  username: requesterName,
                  companyId,
                  action: "update",
                  tableName: "factory_attendance",
                  recordId: before?.id ?? null,
                  recordIdentifier: `${record.workerId}:${record.attendanceDate}`,
                  changes: {
                    status: { old: before?.status ?? null, new: record.status },
                    notes: { old: before?.notes ?? null, new: record.notes || null },
                    shift: { old: before?.shift ?? null, new: record.shift || null },
                    approvedBy: { new: approvedBy.username },
                    approvedByUserId: { new: approvedBy.id },
                    authorizationMethod: { new: approvedBy.authorizationMethod },
                    attendanceDate: { new: record.attendanceDate },
                  },
                },
                tx
              );
            }
          }
        });

        res.json({ success: true, count: records.length });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}

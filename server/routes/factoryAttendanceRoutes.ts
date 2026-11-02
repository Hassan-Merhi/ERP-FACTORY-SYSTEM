import type { Database } from "../db";
import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import type { Express, Request, Response, RequestHandler } from "express";
import { eq, and, inArray, gte, lte } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { factoryAttendance, factoryWorkers } from "@shared/schema";
import { logAudit } from "./helpers/auditWriteAdapter";
import { attendanceApprovalRateLimiter, requireAttendanceEditApproval } from "./factory/attendanceEditPolicy";

function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

export function registerFactoryAttendanceRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
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
  app.post("/api/factory/attendance/bulk", requireAuth, attendanceApprovalRateLimiter, async (req: Request, res: Response) => {
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
        if (!Number.isSafeInteger(record?.workerId) || record.workerId <= 0 ||
            !allowedStatuses.has(record?.status) ||
            (record?.notes !== undefined && (typeof record.notes !== "string" || record.notes.length > 4000)) ||
            (record?.shift !== undefined && (typeof record.shift !== "string" || record.shift.length > 50))) {
          return res.status(400).json({ message: "Invalid attendance record" });
        }
        const key = `${record.workerId}:${record.attendanceDate}`;
        if (seen.has(key)) return res.status(400).json({ message: "Duplicate worker/date in attendance batch" });
        seen.add(key);
      }

      // Validate all dates and require a freshly entered, company-scoped Admin password
      // for *every* save that includes past days, even from an Owner/Admin account.
      const approvedBy = await requireAttendanceEditApproval(
        req, res, companyId, records.map((record) => record.attendanceDate), { adminUsername, adminPassword }
      );
      if (approvedBy === undefined) return;

      const workerIds = [...new Set(records.map((record) => record.workerId))];
      const companyWorkers = await db.select({ id: factoryWorkers.id }).from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), inArray(factoryWorkers.id, workerIds)));
      if (companyWorkers.length !== workerIds.length) {
        return res.status(400).json({ message: "Attendance includes a worker outside this factory company" });
      }

      const now = new Date();
      const requesterId = String(req.session.userId || req.user?.id || "");
      const requesterName = String((req.user as { username?: string } | undefined)?.username || requesterId);
      await db.transaction(async (tx) => {
        for (const record of records) {
          const [before] = approvedBy ? await tx.select().from(factoryAttendance)
            .where(and(eq(factoryAttendance.companyId, companyId), eq(factoryAttendance.workerId, record.workerId),
              eq(factoryAttendance.attendanceDate, record.attendanceDate))).limit(1) : [];

          await tx.insert(factoryAttendance).values({
            companyId,
            workerId: record.workerId,
            attendanceDate: record.attendanceDate,
            shift: record.shift || null,
            status: record.status,
            notes: record.notes || null,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: [factoryAttendance.workerId, factoryAttendance.attendanceDate],
            set: {
              status: record.status,
              shift: record.shift || null,
              notes: record.notes || null,
              updatedAt: now,
            },
          });

          // The audit event is committed with the historical attendance change.
          if (approvedBy && (!before || before.status !== record.status ||
              (before.notes || null) !== (record.notes || null) ||
              (before.shift || null) !== (record.shift || null))) {
            await logAudit({
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
                attendanceDate: { new: record.attendanceDate },
              },
            }, tx);
          }
        }
      });

      res.json({ success: true, count: records.length });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // GET /api/factory/attendance/worker/:workerId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Returns all attendance records for a single worker across a date range.
  app.get("/api/factory/attendance/worker/:workerId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company" });

      const workerId = parseId(req.params.workerId);

      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      if (!workerId || isNaN(workerId)) return res.status(400).json({ message: "Invalid workerId" });

      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });

      const records = await db
        .select()
        .from(factoryAttendance)
        .where(
          and(
            eq(factoryAttendance.companyId, companyId),
            eq(factoryAttendance.workerId, workerId),
            gte(factoryAttendance.attendanceDate, startDate),
            lte(factoryAttendance.attendanceDate, endDate)
          )
        )
        .orderBy(factoryAttendance.attendanceDate);

      res.json(records);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // GET /api/factory/attendance/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  // Returns all workers + all attendance records for a date range (for range export)
  app.get("/api/factory/attendance/range", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company" });

      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });

      // Include ALL workers (active + inactive) — the frontend will split them
      // across two sheets in the Excel export.
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

      const attendance = await db
        .select()
        .from(factoryAttendance)
        .where(
          and(
            eq(factoryAttendance.companyId, companyId),
            gte(factoryAttendance.attendanceDate, startDate),
            lte(factoryAttendance.attendanceDate, endDate),
            inArray(factoryAttendance.workerId, workerIds)
          )
        )
        .orderBy(factoryAttendance.attendanceDate);

      res.json({ workers, attendance });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // GET /api/factory/attendance/pdf?date=YYYY-MM-DD&shift=
  app.get("/api/factory/attendance/pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company" });

      const { date, shift } = req.query as { date?: string; shift?: string };
      if (!date) return res.status(400).json({ message: "date is required" });

      const workers = await db
        .select({
          id: factoryWorkers.id,
          fullName: factoryWorkers.fullName,
          employeeCode: factoryWorkers.employeeCode,
          department: factoryWorkers.department,
        })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)))
        .orderBy(factoryWorkers.fullName);

      const workerIds = workers.map((w) => w.id);

      const existing =
        workerIds.length > 0
          ? await db
              .select()
              .from(factoryAttendance)
              .where(
                and(
                  eq(factoryAttendance.companyId, companyId),
                  eq(factoryAttendance.attendanceDate, date),
                  inArray(factoryAttendance.workerId, workerIds)
                )
              )
          : [];

      const attendanceMap: Record<number, string> = {};
      for (const a of existing) attendanceMap[a.workerId] = a.status;

      const rows = workers.map((w) => ({
        ...w,
        status: attendanceMap[w.id] || "—",
      }));

      const present = rows.filter((r: { status: string }) => r.status === "Present").length;
      const absent = rows.filter((r: { status: string }) => r.status === "Absent").length;
      const other = rows.filter(
        (r: { status: string }) => r.status !== "Present" && r.status !== "Absent" && r.status !== "—"
      ).length;
      const unmarked = rows.filter((r: { status: string }) => r.status === "—").length;

      const doc = new PDFDocument({ margin: 40, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="attendance-${date}.pdf"`);
      doc.pipe(res);

      // Title
      const attLogoPath = require("path").join(process.cwd(), "server", "hmd-logo.png");
      if (require("fs").existsSync(attLogoPath)) {
        try {
          doc.image(attLogoPath, (doc.page.width - 220) / 2, doc.y, { width: 220 });
          doc.moveDown(0.4);
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }
      doc.fontSize(18).font("Helvetica-Bold").text("Attendance Report", { align: "center" });
      doc.moveDown(0.3);
      doc
        .fontSize(11)
        .font("Helvetica")
        .text(`Date: ${date}${shift ? `   Shift: ${shift}` : ""}`, { align: "center" });
      doc.moveDown(0.8);

      // Summary
      doc.fontSize(10).font("Helvetica-Bold");
      const summaryY = doc.y;
      doc.text(`Total Workers: ${rows.length}`, 40, summaryY);
      doc.text(`Present: ${present}`, 160, summaryY);
      doc.text(`Absent: ${absent}`, 250, summaryY);
      doc.text(`Other: ${other}`, 330, summaryY);
      doc.text(`Unmarked: ${unmarked}`, 410, summaryY);
      doc.moveDown(1.2);

      // Table header
      const colX = [40, 200, 300, 390, 480];
      const headers = ["Worker Name", "Employee Code", "Department", "Status"];
      const colW = [155, 95, 85, 85];

      doc.fontSize(9).font("Helvetica-Bold");
      const headerY = doc.y;
      doc.rect(40, headerY - 4, 515, 18).fill("#e5e7eb");
      doc.fillColor("#111827");
      headers.forEach((h, i) => {
        doc.text(h, colX[i], headerY, { width: colW[i] });
      });
      doc.moveDown(0.4);

      // Table rows
      doc.font("Helvetica").fontSize(9);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const y = doc.y;

        if (i % 2 === 1) {
          doc.rect(40, y - 2, 515, 16).fill("#f9fafb");
        }

        const statusColor =
          row.status === "Present"
            ? "#15803d"
            : row.status === "Absent"
              ? "#b91c1c"
              : row.status === "Late"
                ? "#b45309"
                : "#374151";

        doc.fillColor("#111827").text(row.fullName || "", colX[0], y, { width: colW[0] });
        doc.text(row.employeeCode || "—", colX[1], y, { width: colW[1] });
        doc.text(row.department || "—", colX[2], y, { width: colW[2] });
        doc.fillColor(statusColor).text(row.status, colX[3], y, { width: colW[3] });
        doc.fillColor("#111827");

        doc.moveDown(0.4);

        // New page if needed
        if (doc.y > 750) {
          doc.addPage();
          doc.fontSize(9).font("Helvetica-Bold");
          const nextHeaderY = doc.y;
          doc
            .rect(40, nextHeaderY - 4, 515, 18)
            .fill("#e5e7eb")
            .fillColor("#111827");
          headers.forEach((h, hi) => {
            doc.text(h, colX[hi], nextHeaderY, { width: colW[hi] });
          });
          doc.font("Helvetica").moveDown(0.4);
        }
      }

      doc.end();
    } catch (err: unknown) {
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}

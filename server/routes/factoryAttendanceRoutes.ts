import type { Database } from "../db";
import { parseId } from "../lib/parseId";
import { getErrorMessage } from "../lib/httpHandlers";
import type { Express, Request, Response, RequestHandler } from "express";
import { eq, and, inArray, gte, lte } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { factoryAttendance, factoryWorkers } from "@shared/schema";

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
  app.post("/api/factory/attendance/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company" });

      const { records } = req.body as {
        records: Array<{
          workerId: number;
          attendanceDate: string;
          shift?: string;
          status: string;
          notes?: string;
        }>;
      };

      if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ message: "records array is required" });
      }

      const now = new Date();

      for (const r of records) {
        await db
          .insert(factoryAttendance)
          .values({
            companyId,
            workerId: r.workerId,
            attendanceDate: r.attendanceDate,
            shift: r.shift || null,
            status: r.status,
            notes: r.notes || null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [factoryAttendance.workerId, factoryAttendance.attendanceDate],
            set: {
              status: r.status,
              shift: r.shift || null,
              notes: r.notes || null,
              updatedAt: now,
            },
          });
      }

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

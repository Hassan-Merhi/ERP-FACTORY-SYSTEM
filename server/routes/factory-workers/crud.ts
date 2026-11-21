/**
 * factoryWorkerRoutes: FactoryWorkerCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { eq, and } from "drizzle-orm";
import {
  factoryWorkers,
  insertFactoryWorkerSchema,
  factoryBales,
  factoryPayrolls,
  factoryAttendance,
} from "@shared/schema";

import { getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import { sumMoney } from "../../lib/money";
import { registerFactoryWorkerCrudRoutesPart1 } from "./registerFactoryWorkerCrudRoutesPart1";

export function registerFactoryWorkerCrudRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // GET /api/factory/workers/:id - Get single worker with computed stats
  app.get("/api/factory/workers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [worker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)));

      if (!worker) return res.status(404).json({ message: "Worker not found" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.finalizedBy, id), eq(factoryBales.companyId, companyId)));

      const totalBales = bales.length;
      const totalKg = sumMoney(bales.map((b) => b.weightKg));

      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.workerId, id), eq(factoryPayrolls.companyId, companyId)));

      const totalEarnings = sumMoney(payrolls.map((p) => p.netSalary));

      res.json({
        ...worker,
        stats: {
          totalBales,
          totalKg: totalKg.toFixed(3),
          totalEarnings: totalEarnings.toFixed(2),
          payrollCount: payrolls.length,
        },
      });
    } catch (error: unknown) {
      logger.error("Error fetching factory worker:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers - Create worker
  app.post("/api/factory/workers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawData = { ...req.body, companyId };
      for (const f of [
        "dateOfBirth",
        "dateJoined",
        "contractStartDate",
        "contractEndDate",
        "visaExpiry",
        "workPermitExpiry",
        "residentialPermitExpiry",
      ]) {
        if (rawData[f] === "" || rawData[f] === undefined) rawData[f] = null;
      }
      for (const f of [
        "baseSalary",
        "perBaleRate",
        "perKgRate",
        "overtimeRate",
        "hourlyRate",
        "weeklySalary",
        "biWeeklySalary",
      ]) {
        if (rawData[f] === "" || rawData[f] === undefined) rawData[f] = "0";
      }
      if (rawData.transportAllowance === "" || rawData.transportAllowance === undefined)
        rawData.transportAllowance = null;
      if (rawData.numberOfChildren === "" || rawData.numberOfChildren === undefined) rawData.numberOfChildren = 0;
      const parsed = insertFactoryWorkerSchema.parse(rawData);
      const [worker] = await db.insert(factoryWorkers).values(parsed).returning();

      if (!worker.employeeCode) {
        const prefix = "HMD";
        const existing = await db
          .select({ employeeCode: factoryWorkers.employeeCode })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.companyId, companyId));
        const maxNum = existing.reduce((max: number, w: { employeeCode: string | null }) => {
          if (!w.employeeCode) return max;
          const m = w.employeeCode.match(new RegExp(`^${prefix}(\\d+)$`));
          if (!m) return max;
          return Math.max(max, parseInt(m[1], 10));
        }, 0);
        const code = `${prefix}${String(maxNum + 1).padStart(3, "0")}`;
        const [updated] = await db
          .update(factoryWorkers)
          .set({ employeeCode: code })
          .where(eq(factoryWorkers.id, worker.id))
          .returning();
        Object.assign(worker, updated);
      }

      const today = getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "WORKER_CREATED",
        referenceId: worker.id,
        referenceTable: "factory_workers",
        description: `New worker created: ${worker.fullName} (${worker.employeeCode})`,
        createdBy: req.session.userId ?? undefined,
      });

      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const joinDate = worker.dateJoined ? new Date(worker.dateJoined) : now;
      const absentEnd = new Date(joinDate);
      absentEnd.setDate(absentEnd.getDate() - 1);

      if (absentEnd >= yearStart) {
        const absentRecords = [];
        const cursor = new Date(yearStart);
        while (cursor <= absentEnd) {
          absentRecords.push({
            companyId,
            workerId: worker.id,
            attendanceDate: cursor.toISOString().split("T")[0],
            status: "Absent",
            notes: "Auto-absent (pre-join)",
          });
          cursor.setDate(cursor.getDate() + 1);
        }
        if (absentRecords.length > 0) {
          const BATCH = 500;
          for (let i = 0; i < absentRecords.length; i += BATCH) {
            await db
              .insert(factoryAttendance)
              .values(absentRecords.slice(i, i + BATCH))
              .onConflictDoNothing();
          }
        }
      }

      res.json(worker);
    } catch (error: unknown) {
      logger.error("Error creating factory worker:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryWorkerCrudRoutesPart1(app, requireAuth, db);
}

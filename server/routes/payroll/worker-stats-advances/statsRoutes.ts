import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc } from "drizzle-orm";
import { factoryWorkers, factoryBales, factoryPayrolls } from "@shared/schema";
import { getFactoryCompanyId } from "./helpers";
import { MoneyDecimal, lineAmount, sumMoney, toMoney } from "../../../lib/money";

export function registerWorkerStatsRoutes(app: Express) {
  app.get("/api/factory/workers/:id/stats", requireAuth, async (req: Request, res: Response) => {
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

      let estimatedEarnings = new MoneyDecimal(0);
      const salaryType = worker.salaryType || "Monthly";

      if (salaryType === "Per Bale") {
        estimatedEarnings = lineAmount(totalBales, worker.perBaleRate);
      } else if (salaryType === "Per KG") {
        estimatedEarnings = lineAmount(totalKg, worker.perKgRate);
      } else if (salaryType === "Monthly" || salaryType === "Daily") {
        estimatedEarnings = toMoney(worker.baseSalary);
      }

      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.workerId, id), eq(factoryPayrolls.companyId, companyId)))
        .orderBy(desc(factoryPayrolls.periodEnd));

      const totalPaid = sumMoney(payrolls.map((p) => p.netSalary));

      res.json({
        workerId: id,
        workerName: worker.fullName,
        salaryType,
        totalBales,
        totalKg: totalKg.toFixed(3),
        estimatedEarnings: estimatedEarnings.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        payrollCount: payrolls.length,
        recentPayrolls: payrolls.slice(0, 5),
      });
    } catch (error: unknown) {
      logger.error("Error fetching worker stats:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── FACTORY WORKER ADVANCES ─────────────────────────────────────────

  // GET /api/factory/advance-repayments - List all repayments company-wide
}

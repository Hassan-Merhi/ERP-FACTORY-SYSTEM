/**
 * payrollCoreRoutes: PayrollCoreRead endpoints.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { factoryWorkers, factoryPayrolls, ledgerAccounts } from "@shared/schema";
import { getFactoryCompanyId } from "./_helpers";
import {
  attachProductionBonusesToPayroll,
  getProductionBonusTotalsForPayrollIds,
  syncProductionBonusProposalsForPeriod,
} from "../../../services/payroll/productionBonusPayrollService";
import { registerPayrollCoreReadRoutesPart1 } from "./registerPayrollCoreReadRoutesPart1";
import { ledgerPostingLeafCondition } from "../../../services/accounting/postableLedgerAccountPolicy";

const emptyBonusTotals = () => ({
  approved: 0,
  pending: 0,
  rejected: 0,
  totalSuggested: 0,
  pendingCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
});

export function registerPayrollCoreReadRoutes(app: Express) {
  app.get("/api/factory/cash-accounts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accounts = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, code: ledgerAccounts.code })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            isNull(ledgerAccounts.deletedAt),
            ledgerPostingLeafCondition(companyId)
          )
        )
        .orderBy(ledgerAccounts.name);
      res.json(accounts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/payrolls - live Workers Hub payroll records with production-bonus state.
  app.get("/api/factory/payrolls", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(eq(factoryPayrolls.companyId, companyId))
        .orderBy(desc(factoryPayrolls.periodEnd));

      // Only DRAFT periods may generate/attach new proposals. Locked payrolls
      // remain historical and side-effect free.
      const draftPeriods = new Set<string>();
      for (const payroll of payrolls) {
        if (payroll.status !== "DRAFT") continue;
        const key = `${payroll.periodStart}:${payroll.periodEnd}`;
        if (draftPeriods.has(key)) continue;
        draftPeriods.add(key);
        await syncProductionBonusProposalsForPeriod(db, companyId, payroll.periodStart, payroll.periodEnd);
      }
      for (const payroll of payrolls) {
        if (payroll.status === "DRAFT") await attachProductionBonusesToPayroll(db, payroll.id);
      }

      const workerIds = [...new Set(payrolls.map((payroll) => payroll.workerId))];
      const workers = workerIds.length
        ? await db
            .select({
              id: factoryWorkers.id,
              fullName: factoryWorkers.fullName,
              employeeCode: factoryWorkers.employeeCode,
              position: factoryWorkers.position,
            })
            .from(factoryWorkers)
            .where(inArray(factoryWorkers.id, workerIds))
        : [];
      const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrolls.map((payroll) => payroll.id)
      );
      const result = payrolls.map((payroll) => {
        const production = productionTotals.get(payroll.id) ?? emptyBonusTotals();
        return {
          ...payroll,
          worker: workerMap.get(payroll.workerId) || null,
          productionBonus: production.approved.toFixed(2),
          pendingProductionBonus: production.pending.toFixed(2),
          rejectedProductionBonus: production.rejected.toFixed(2),
          suggestedProductionBonus: production.totalSuggested.toFixed(2),
          productionBonusPendingCount: production.pendingCount,
          productionBonusApprovedCount: production.approvedCount,
          productionBonusRejectedCount: production.rejectedCount,
          otherBonuses: Math.max(0, Number(payroll.bonuses ?? 0) - production.approved).toFixed(2),
        };
      });
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerPayrollCoreReadRoutesPart1(app);

  app.get("/api/factory/workers/:id/payrolls", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.workerId, id), eq(factoryPayrolls.companyId, companyId)))
        .orderBy(desc(factoryPayrolls.periodEnd));
      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrolls.map((payroll) => payroll.id)
      );
      res.json(
        payrolls.map((payroll) => {
          const production = productionTotals.get(payroll.id) ?? emptyBonusTotals();
          return {
            ...payroll,
            productionBonus: production.approved.toFixed(2),
            pendingProductionBonus: production.pending.toFixed(2),
            rejectedProductionBonus: production.rejected.toFixed(2),
            otherBonuses: Math.max(0, Number(payroll.bonuses ?? 0) - production.approved).toFixed(2),
          };
        })
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

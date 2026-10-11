/**
 * factoryIntelligenceRoutes: FactoryCashflow endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, gte, lte } from "drizzle-orm";
import { factoryWorkers, containerFreight, containerFreightPayments, customerOrders } from "@shared/schema";
import { MoneyDecimal, moneyString, sumMoney, toMoney } from "../../lib/money";

export function registerFactoryCashflowRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.get("/api/factory/cashflow", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const days = parseInt(req.query.days as string) || 30;
      const today = new Date();
      const futureDate = new Date();
      futureDate.setDate(today.getDate() + days);
      const todayStr = today.toISOString().split("T")[0];
      const futureDateStr = futureDate.toISOString().split("T")[0];

      const freightEntries = await db
        .select()
        .from(containerFreight)
        .where(
          and(
            eq(containerFreight.companyId, companyId),
            gte(containerFreight.dueDate, todayStr),
            lte(containerFreight.dueDate, futureDateStr)
          )
        );

      const freightPayments = await db
        .select()
        .from(containerFreightPayments)
        .where(eq(containerFreightPayments.companyId, companyId));

      const upcomingFreight = [];
      let totalFreightOutgoing = new MoneyDecimal(0);

      for (const f of freightEntries) {
        const amount = toMoney(f.freightAmount);
        const paid = sumMoney(freightPayments.filter((p) => p.containerFreightId === f.id).map((p) => p.amount));
        const remaining = amount.minus(paid);
        if (remaining.gt("0.01")) {
          upcomingFreight.push({
            vendorName: f.vendorName || "Unknown",
            amount: Number(moneyString(amount)),
            dueDate: f.dueDate,
            remaining: Number(moneyString(remaining)),
          });
          totalFreightOutgoing = totalFreightOutgoing.plus(remaining);
        }
      }

      const activeWorkers = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));

      const totalMonthlyPayroll = sumMoney(activeWorkers.map((w) => w.baseSalary));

      const payPeriods = Math.ceil(days / 30);
      const payrollEstimate = totalMonthlyPayroll.times(payPeriods);

      const totalOutgoing = totalFreightOutgoing.plus(payrollEstimate);

      const pendingOrders = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.companyId, companyId), eq(customerOrders.status, "FINALIZED")));

      const expectedIncome = sumMoney(pendingOrders.map((o) => o.grandTotal));

      res.json({
        upcomingFreight,
        payrollEstimate: Number(moneyString(payrollEstimate)),
        totalOutgoing: Number(moneyString(totalOutgoing)),
        expectedIncome: Number(moneyString(expectedIncome)),
      });
    } catch (error: unknown) {
      logger.error("Error fetching cash flow forecast:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

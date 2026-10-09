/** Read routes of the factory advances (split out of advanceManagementRoutes.ts, each registered at its old position). */
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";

import { logger } from "../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { eq, and, desc, sql } from "drizzle-orm";
import { factoryWorkers, factoryWorkerAdvances, vouchers } from "@shared/schema";
import { sumMoney } from "../../lib/money";

import { getFactoryCompanyId } from "./advanceRouteHelpers";

export function registerUnvoucheredAdvancesRoute(app: Express): void {
  app.get("/api/factory/advances/unvouchered", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allAdvances = await db
        .select({
          id: factoryWorkerAdvances.id,
          workerId: factoryWorkerAdvances.workerId,
          advanceDate: factoryWorkerAdvances.advanceDate,
          amount: factoryWorkerAdvances.amount,
          remainingBalance: factoryWorkerAdvances.remainingBalance,
          cashAccountId: factoryWorkerAdvances.cashAccountId,
          notes: factoryWorkerAdvances.notes,
          repaymentType: factoryWorkerAdvances.repaymentType,
          workerName: factoryWorkers.fullName,
        })
        .from(factoryWorkerAdvances)
        .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
        .where(eq(factoryWorkerAdvances.companyId, companyId))
        .orderBy(desc(factoryWorkerAdvances.advanceDate));

      const existingVoucherAdvanceIds = await db
        .select({ voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));

      const voucheredIds = new Set<number>();
      for (const v of existingVoucherAdvanceIds) {
        const match = v.voucherNumber.match(/^PAYMENT-ADV-(\d+)-/);
        if (match) voucheredIds.add(parseInt(match[1]));
      }

      const unvouchered = allAdvances.filter((a) => !voucheredIds.has(a.id) || a.cashAccountId === null);

      res.json(unvouchered);
    } catch (error: unknown) {
      logger.error("Error fetching unvouchered advances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

export function registerWorkerAdvanceBalanceRoute(app: Express): void {
  app.get("/api/factory/workers/:id/advance-balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });

      const outstanding = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.workerId, workerId),
            eq(factoryWorkerAdvances.fullyPaid, false)
          )
        );

      const totalBalance = sumMoney(outstanding.map((a) => a.remainingBalance));
      res.json({ totalBalance: totalBalance.toFixed(2), count: outstanding.length });
    } catch (error: unknown) {
      logger.error("Error fetching advance balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/repay-by-month - Bulk repay all outstanding advances for a given month
}

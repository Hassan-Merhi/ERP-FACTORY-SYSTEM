/**
 * workerStatementRoutes: WorkerRepaymentDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and } from "drizzle-orm";
import { factoryWorkers, factoryWorkerAdvances, factoryAdvanceRepayments } from "@shared/schema";

import { getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import { toMoney } from "../../../lib/money";

export function registerWorkerRepaymentDeleteRoutes(app: Express) {
  app.delete("/api/factory/advance-repayments/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can delete repayments" });
      }
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const repaymentId = parseId(req.params.id);
      if (repaymentId === null) return res.status(400).json({ message: "Invalid id" });

      const [repayment] = await db
        .select()
        .from(factoryAdvanceRepayments)
        .where(and(eq(factoryAdvanceRepayments.id, repaymentId), eq(factoryAdvanceRepayments.companyId, companyId)));
      if (!repayment) return res.status(404).json({ message: "Repayment not found" });

      const [advance] = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(eq(factoryWorkerAdvances.id, repayment.advanceId));

      const repayAmt = toMoney(repayment.amount);
      const restoredBal = toMoney(advance?.remainingBalance).plus(repayAmt);

      await db.transaction(async (tx) => {
        await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.id, repaymentId));

        if (advance) {
          await tx
            .update(factoryWorkerAdvances)
            .set({
              remainingBalance: restoredBal.toFixed(2),
              fullyPaid: false,
            })
            .where(eq(factoryWorkerAdvances.id, advance.id));
        }
      });

      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, repayment.workerId));

      await writeDaybookEntry(db, {
        companyId,
        txDate: getClientDate(req),
        txType: "ADVANCE_REPAYMENT_DELETED",
        referenceId: repaymentId,
        referenceTable: "factory_advance_repayments",
        description: `Repayment deleted for ${worker?.fullName || "Worker"}: $${repayAmt.toFixed(2)} (advance #${repayment.advanceId})`,
        amountCurrency: repayAmt.toNumber(),
        currencyCode: "USD",
        amountUsd: repayAmt.toNumber(),
        createdBy: req.session.userId ?? undefined,
      });

      res.json({ message: "Repayment deleted", restoredBalance: restoredBal.toFixed(2) });
    } catch (error: unknown) {
      logger.error("Error deleting repayment:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

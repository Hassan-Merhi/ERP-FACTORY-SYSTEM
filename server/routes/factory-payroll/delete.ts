/**
 * factoryPayrollRoutes: FactoryPayrollDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { DbTransaction } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { logAudit } from "../helpers/auditHelpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getClientDate } from "../../lib/dateUtils";
import { removeDaybookEntriesForSource } from "../../services/factory/daybookSourceIntegrity";
import { eq, and } from "drizzle-orm";
import { rebuildPayrollGenVoucher } from "../payroll/_payrollAccountingHelper";
import { factoryPayrolls, factoryWorkerAdvances, factoryAdvanceRepayments } from "@shared/schema";

import { writeDaybookEntry } from "./_helpers";
import { toMoney } from "../../lib/money";

export function registerFactoryPayrollDeleteRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  app.delete("/api/factory/payroll/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId
        ? parseOptionalId(req.query.companyId)
        : req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.id, id), eq(factoryPayrolls.companyId, companyId)));

      if (!existing) return res.status(404).json({ message: "Payroll record not found" });
      if (existing.status !== "DRAFT")
        return res.status(400).json({ message: "Only draft payroll records can be deleted" });

      await db.transaction(async (tx: DbTransaction) => {
        // Restore advance balances that were settled at generate time
        const advDeducted = toMoney(existing.advances);
        if (advDeducted.gt(0)) {
          const repayments = await tx
            .select()
            .from(factoryAdvanceRepayments)
            .where(
              and(
                eq(factoryAdvanceRepayments.companyId, companyId),
                eq(factoryAdvanceRepayments.workerId, existing.workerId),
                eq(factoryAdvanceRepayments.payrollId, id)
              )
            );
          for (const rep of repayments) {
            const [adv] = await tx
              .select()
              .from(factoryWorkerAdvances)
              .where(eq(factoryWorkerAdvances.id, rep.advanceId));
            if (!adv) continue;
            // Exact: restoring a repayment puts back exactly the cents it took.
            const newBal = toMoney(adv.remainingBalance).plus(toMoney(rep.amount));
            await tx
              .update(factoryWorkerAdvances)
              .set({
                remainingBalance: newBal.toFixed(2),
                fullyPaid: false,
              })
              .where(eq(factoryWorkerAdvances.id, adv.id));
          }
          await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.payrollId, id));
        }

        // Delete PAYROLL_PAYMENT/PAYROLL_GENERATED daybook entries for this payroll,
        // including legacy rows written before referenceTable was populated.
        await removeDaybookEntriesForSource(tx, {
          companyId,
          referenceTable: "factory_payrolls",
          referenceId: id,
          txTypes: ["PAYROLL_PAYMENT", "PAYROLL_GENERATED"],
        });

        // Remove and rebuild the PAYROLL-GEN expense voucher for this period so the
        // expense account reflects only the payrolls that still exist.
        await rebuildPayrollGenVoucher(tx, companyId, existing.periodStart, existing.periodEnd, id);

        await tx.delete(factoryPayrolls).where(eq(factoryPayrolls.id, id));

        // Wave 7: the deletion's daybook and audit rows commit with it.
        await writeDaybookEntry(tx, {
          companyId,
          txDate: getClientDate(req),
          txType: "PAYROLL_DELETED",
          referenceId: id,
          referenceTable: "factory_payrolls",
          description: `Draft payroll #${id} deleted (Worker #${existing.workerId}, period ${existing.periodStart}–${existing.periodEnd}, net $${toMoney(existing.netSalary).toFixed(2)})`,
          createdBy: req.session.userId ?? undefined,
        });
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "delete",
            tableName: "factory_payrolls",
            recordId: id,
            recordIdentifier: `Payroll #${id} (Worker #${existing.workerId}, period ${existing.periodStart}–${existing.periodEnd})`,
            changes: { status: { old: existing.status, new: "DELETED" } },
          },
          tx
        );
      });

      res.json({ message: "Payroll record deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting payroll:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

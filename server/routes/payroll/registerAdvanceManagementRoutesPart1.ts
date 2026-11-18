// Extracted from ./advanceManagementRoutes.ts to keep that module under the source-size cap.
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage, HttpError, sendHttpError } from "../../lib/httpHandlers";
import { logAudit } from "../helpers/auditHelpers";
import { retireVouchersForRequestTx } from "../../services/accounting/voucherRetirement";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  factoryAdvanceRepayments,
  factoryDaybookEntries,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryWorkers,
  vouchers,
} from "@shared/schema";
import { MoneyDecimal, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import { getFactoryCompanyId, writeDaybookEntry } from "./advanceRouteHelpers";

export const ADVANCE_HAS_REPAYMENTS_MESSAGE =
  "This advance has repayments. Reverse the repayments first, then delete the advance.";

export const ADVANCE_HAS_PAYROLL_RECOVERY_MESSAGE =
  "This advance has been settled against historical payroll deductions. Correct the affected payroll before deleting the advance.";

export function registerAdvanceManagementRoutesPart1(app: Express) {
  app.post("/api/factory/advances/reconcile", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Load all salary-deduction advances for company (oldest first)
      const allAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        )
        .orderBy(factoryWorkerAdvances.workerId, factoryWorkerAdvances.advanceDate);

      // Load all payrolls that have advance deductions
      const allPayrolls = await db
        .select({
          workerId: factoryPayrolls.workerId,
          advances: factoryPayrolls.advances,
          periodStart: factoryPayrolls.periodStart,
        })
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.companyId, companyId)))
        .orderBy(factoryPayrolls.workerId, factoryPayrolls.periodStart);

      // Load all manual repayments (linked to specific advance IDs)
      const allRepayments = await db
        .select()
        .from(factoryAdvanceRepayments)
        .where(eq(factoryAdvanceRepayments.companyId, companyId))
        .orderBy(factoryAdvanceRepayments.advanceId, factoryAdvanceRepayments.repaymentDate);

      // Group by worker
      const advancesByWorker = new Map<number, typeof allAdvances>();
      for (const adv of allAdvances) {
        const list = advancesByWorker.get(adv.workerId) || [];
        list.push(adv);
        advancesByWorker.set(adv.workerId, list);
      }

      const zero = new MoneyDecimal(0);
      const payrollDeductionByWorker = new Map<number, Decimal>();
      for (const pr of allPayrolls) {
        const amt = toMoney(pr.advances);
        if (amt.gt(0)) {
          payrollDeductionByWorker.set(pr.workerId, (payrollDeductionByWorker.get(pr.workerId) ?? zero).plus(amt));
        }
      }

      // Manual repayments keyed by advanceId
      const manualRepaymentByAdvance = new Map<number, Decimal>();
      for (const rep of allRepayments) {
        manualRepaymentByAdvance.set(
          rep.advanceId,
          (manualRepaymentByAdvance.get(rep.advanceId) ?? zero).plus(toMoney(rep.amount))
        );
      }

      let updatedCount = 0;
      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        for (const [workerId, advances] of advancesByWorker) {
          // Step 1: Reset each advance to its original amount minus manual repayments
          const balances: { id: number; bal: Decimal }[] = [];
          for (const adv of advances) {
            const original = toMoney(adv.amount);
            const manualPaid = manualRepaymentByAdvance.get(adv.id) ?? zero;
            balances.push({ id: adv.id, bal: MoneyDecimal.max(0, original.minus(manualPaid)) });
          }

          // Step 2: Apply total payroll deductions oldest-first
          let remaining = payrollDeductionByWorker.get(workerId) ?? zero;
          for (const entry of balances) {
            if (remaining.lte(0)) break;
            const deduct = MoneyDecimal.min(entry.bal, remaining);
            entry.bal = entry.bal.minus(deduct);
            remaining = remaining.minus(deduct);
          }

          // Step 3: Persist updated balances
          for (let i = 0; i < advances.length; i++) {
            const newBal = MoneyDecimal.max(0, balances[i].bal);
            const newBal2dp = newBal.toFixed(2);
            const fullyPaid = newBal.lte(0.001);
            const adv = advances[i];
            if (adv.remainingBalance !== newBal2dp || adv.fullyPaid !== fullyPaid) {
              await tx
                .update(factoryWorkerAdvances)
                .set({ remainingBalance: newBal2dp, fullyPaid })
                .where(eq(factoryWorkerAdvances.id, adv.id));
              updatedCount++;
            }
          }
        }
      });

      res.json({ message: `Reconciliation complete — ${updatedCount} advance record(s) updated` });
    } catch (e: unknown) {
      logger.error("Advance reconcile error:", { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // DELETE /api/factory/advances/:id - Delete advance (admin/owner only)
  app.delete("/api/factory/advances/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can delete advances" });
      }
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [advance] = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.id, id), eq(factoryWorkerAdvances.companyId, companyId)));
      if (!advance) return res.status(404).json({ message: "Advance not found" });

      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, advance.workerId));

      const today = getClientDate(req);

      // Owner decision (wave 7): an advance with a live repayment is not deleted
      // (its repayment vouchers would be left behind); the repayments are
      // reversed first. An advance with none goes with its PAYMENT-ADV voucher,
      // its daybook rows and an audit row, in one transaction.
      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [locked] = await tx
          .select({
            id: factoryWorkerAdvances.id,
            amount: factoryWorkerAdvances.amount,
            remainingBalance: factoryWorkerAdvances.remainingBalance,
            fullyPaid: factoryWorkerAdvances.fullyPaid,
            repaymentType: factoryWorkerAdvances.repaymentType,
            workerId: factoryWorkerAdvances.workerId,
          })
          .from(factoryWorkerAdvances)
          .where(and(eq(factoryWorkerAdvances.id, id), eq(factoryWorkerAdvances.companyId, companyId)))
          .for("update");
        if (!locked) throw new HttpError(404, "Advance not found");

        const repayments = await tx
          .select({ id: factoryAdvanceRepayments.id })
          .from(factoryAdvanceRepayments)
          .where(eq(factoryAdvanceRepayments.advanceId, id));
        if (repayments.length > 0) {
          throw new HttpError(409, ADVANCE_HAS_REPAYMENTS_MESSAGE);
        }

        // Prior to deleting a settled salary-deduction advance, check paid
        // payrolls. Payroll recovery isn't represented by a repayment row:
        // deleting the original payment voucher would otherwise leave behind
        // an orphan credit to Factory Worker Advances (observed in production).
        // Worker-level deductions are not linked to an individual advance,
        // so conservatively block an ambiguous historical deletion.
        if (
          locked.repaymentType === "salary_deduction" &&
          (locked.fullyPaid || toMoney(locked.remainingBalance).lt(toMoney(locked.amount)))
        ) {
          const [historicalPayroll] = await tx
            .select({ id: factoryPayrolls.id })
            .from(factoryPayrolls)
            .where(
              and(
                eq(factoryPayrolls.companyId, companyId),
                eq(factoryPayrolls.workerId, locked.workerId),
                inArray(factoryPayrolls.status, ["APPROVED", "PAID"]),
                sql`CAST(${factoryPayrolls.advances} AS NUMERIC) > 0`
              )
            )
            .limit(1);
          if (historicalPayroll) {
            throw new HttpError(409, ADVANCE_HAS_PAYROLL_RECOVERY_MESSAGE);
          }
        }

        // Delete the advance payment voucher (PAYMENT-ADV-{id}-*) and its entries.
        // These were created when the advance was given with a cash account:
        //   DR Factory Worker Advances / CR Cash.
        const advanceVouchers = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE ${"PAYMENT-ADV-" + id + "-%"}`)
          );
        if (advanceVouchers.length > 0) {
          const vIds = advanceVouchers.map((v) => v.id);
          // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
          await retireVouchersForRequestTx(tx, req, companyId, vIds, "advance-delete-or-reverse");
        }

        await tx
          .delete(factoryWorkerAdvances)
          .where(and(eq(factoryWorkerAdvances.id, id), eq(factoryWorkerAdvances.companyId, companyId)));

        // Remove the original ADVANCE_GIVEN daybook row(s) so they no longer
        // appear in the daybook after deletion (prevents duplicates when a new
        // advance is created for the same worker afterwards).
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.referenceTable, "factory_worker_advances"),
              eq(factoryDaybookEntries.referenceId, id)
            )
          );

        const voucherNote = advanceVouchers.length > 0 ? "; voucher reversed" : "";
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "ADVANCE_DELETED",
          referenceId: id,
          referenceTable: "factory_worker_advances",
          description: `Advance deleted for ${worker?.fullName || "Unknown"}: $${toMoney(advance.amount).toFixed(2)}${voucherNote}`,
          createdBy: req.session.userId ?? undefined,
        });
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "delete",
            tableName: "factory_worker_advances",
            recordId: id,
            recordIdentifier: `Advance #${id} (${worker?.fullName || `Worker #${advance.workerId}`})`,
            changes: {
              amount: { old: advance.amount, new: null },
              remainingBalance: { old: advance.remainingBalance, new: null },
              vouchersRemoved: { old: advanceVouchers.map((v) => v.id).join(", ") || null, new: null },
            },
          },
          tx
        );
      });

      res.json({ message: "Advance deleted" });
    } catch (error: unknown) {
      if (error instanceof HttpError && error.message === ADVANCE_HAS_REPAYMENTS_MESSAGE) {
        return res.status(409).json({ message: error.message, code: "ADVANCE_HAS_REPAYMENTS" });
      }
      if (error instanceof HttpError && error.message === ADVANCE_HAS_PAYROLL_RECOVERY_MESSAGE) {
        return res.status(409).json({ message: error.message, code: "ADVANCE_HAS_PAYROLL_RECOVERY" });
      }
      if (!(error instanceof HttpError)) logger.error("Error deleting advance:", { error: error });
      sendHttpError(res, error);
    }
  });
}

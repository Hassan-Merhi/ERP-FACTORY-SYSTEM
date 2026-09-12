import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { getFactoryCompanyId, writeDaybookEntry } from "./helpers";

export function registerWorkerAdvanceAdminRoutes(app: Express) {
  app.post("/api/factory/advances/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { items, advanceDate, cashAccountId: rawCashAccountId, repaymentType: rawRepaymentType, notes } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "No items provided" });
      }

      const advDate = advanceDate || getClientDate(req);
      const cashAccountId = rawCashAccountId ? parseInt(rawCashAccountId) : null;
      const repaymentType = rawRepaymentType === "manual_repayment" ? "manual_repayment" : "salary_deduction";

      if (cashAccountId) {
        const [acct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
        if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });
      }

      const results = await db.transaction(async (tx) => {
        // Resolve or create the "Factory Worker Advances" ledger account once
        let advancesAccountId: number | null = null;
        if (cashAccountId) {
          let [advancesAccount] = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));
          if (!advancesAccount) {
            const maxCodeResult = await tx
              .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
              .from(ledgerAccounts)
              .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\d+$'`));
            const nextCode = String((maxCodeResult[0]?.maxCode ?? 0) + 1);
            [advancesAccount] = await tx
              .insert(ledgerAccounts)
              .values({
                companyId,
                code: nextCode,
                name: "Factory Worker Advances",
                accountType: "Asset",
                active: true,
                isHidden: false,
              })
              .returning();
          }
          advancesAccountId = advancesAccount.id;
        }

        const created: unknown[] = [];
        for (const item of items) {
          const workerId = parseInt(item.workerId);
          const amount = parseFloat(item.amount);
          if (!workerId || !amount || amount <= 0) continue;

          const [worker] = await tx
            .select({ fullName: factoryWorkers.fullName })
            .from(factoryWorkers)
            .where(and(eq(factoryWorkers.id, workerId), eq(factoryWorkers.companyId, companyId)));
          if (!worker) continue;

          const [advance] = await tx
            .insert(factoryWorkerAdvances)
            .values({
              companyId,
              workerId,
              advanceDate: advDate,
              amount: amount.toFixed(2),
              remainingBalance: amount.toFixed(2),
              cashAccountId,
              notes: notes || null,
              repaymentType,
            })
            .returning();

          if (cashAccountId && advancesAccountId) {
            const narration = `Advance to ${worker.fullName}: $${amount.toFixed(2)}`;
            const voucherNumber = `PAYMENT-ADV-${advance.id}-${Date.now()}`;
            const [createdVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber,
                voucherType: "Payment",
                voucherDate: advDate,
                description: narration,
                totalAmount: amount.toFixed(2),
                currency: "USD",
                sourceModule: "FACTORY",
              })
              .returning();
            await tx.insert(voucherEntries).values([
              {
                voucherId: createdVoucher.id,
                ledgerAccountId: advancesAccountId,
                debitAmount: amount.toFixed(2),
                creditAmount: "0",
                narration,
              },
              {
                voucherId: createdVoucher.id,
                ledgerAccountId: cashAccountId,
                debitAmount: "0",
                creditAmount: amount.toFixed(2),
                narration,
              },
            ]);
          }

          await writeDaybookEntry(tx, {
            companyId,
            txDate: advDate,
            txType: "ADVANCE_GIVEN",
            referenceId: advance.id,
            referenceTable: "factory_worker_advances",
            description: `Advance given to ${worker.fullName}: $${amount.toFixed(2)}`,
            amountCurrency: amount,
            amountUsd: amount,
            createdBy: req.session.userId ?? undefined,
          });

          created.push({ ...advance, workerName: worker.fullName });
        }
        return created;
      });

      res.json({ created: results.length, advances: results });
    } catch (error: unknown) {
      logger.error("Error creating bulk advances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/factory/advances/:id - Edit advance (admin/owner only)
  app.patch("/api/factory/advances/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can edit advances" });
      }
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const updates: Partial<typeof factoryWorkerAdvances.$inferInsert> = {};
      if (req.body.notes !== undefined) updates.notes = req.body.notes;
      if (req.body.advanceDate) updates.advanceDate = req.body.advanceDate;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No advance fields to update" });
      }

      const [updated] = await db
        .update(factoryWorkerAdvances)
        .set(updates)
        .where(and(eq(factoryWorkerAdvances.id, id), eq(factoryWorkerAdvances.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Advance not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/advances/reconcile/preview - Dry-run reconciliation, returns what would change
  app.get("/api/factory/advances/reconcile/preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

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

      const allPayrolls = await db
        .select({
          workerId: factoryPayrolls.workerId,
          advances: factoryPayrolls.advances,
          periodStart: factoryPayrolls.periodStart,
        })
        .from(factoryPayrolls)
        .where(eq(factoryPayrolls.companyId, companyId))
        .orderBy(factoryPayrolls.workerId, factoryPayrolls.periodStart);

      const allRepayments = await db
        .select()
        .from(factoryAdvanceRepayments)
        .where(eq(factoryAdvanceRepayments.companyId, companyId))
        .orderBy(factoryAdvanceRepayments.advanceId, factoryAdvanceRepayments.repaymentDate);

      // Worker names
      const workerIds = [...new Set(allAdvances.map((a) => a.workerId))];
      let workerMap: Record<number, string> = {};
      if (workerIds.length > 0) {
        const wRows = await db
          .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
          .from(factoryWorkers)
          .where(inArray(factoryWorkers.id, workerIds));
        workerMap = Object.fromEntries(wRows.map((w) => [w.id, w.fullName]));
      }

      const advancesByWorker = new Map<number, typeof allAdvances>();
      for (const adv of allAdvances) {
        const list = advancesByWorker.get(adv.workerId) || [];
        list.push(adv);
        advancesByWorker.set(adv.workerId, list);
      }

      const payrollDeductionByWorker = new Map<number, number>();
      for (const pr of allPayrolls) {
        const amt = parseFloat(pr.advances || "0");
        if (amt > 0) payrollDeductionByWorker.set(pr.workerId, (payrollDeductionByWorker.get(pr.workerId) || 0) + amt);
      }

      const manualRepaymentByAdvance = new Map<number, number>();
      for (const rep of allRepayments) {
        manualRepaymentByAdvance.set(
          rep.advanceId,
          (manualRepaymentByAdvance.get(rep.advanceId) || 0) + parseFloat(rep.amount || "0")
        );
      }

      const changes: unknown[] = [];
      for (const [workerId, advances] of advancesByWorker) {
        const balances: { id: number; bal: number }[] = [];
        for (const adv of advances) {
          const original = parseFloat(adv.amount || "0");
          const manualPaid = manualRepaymentByAdvance.get(adv.id) || 0;
          balances.push({ id: adv.id, bal: Math.max(0, original - manualPaid) });
        }
        let remaining = payrollDeductionByWorker.get(workerId) || 0;
        for (const entry of balances) {
          if (remaining <= 0) break;
          const deduct = Math.min(entry.bal, remaining);
          entry.bal = entry.bal - deduct;
          remaining -= deduct;
        }
        for (let i = 0; i < advances.length; i++) {
          const adv = advances[i];
          const newBal = Math.max(0, balances[i].bal);
          const newBal2dp = newBal.toFixed(2);
          const newFullyPaid = newBal <= 0.001;
          const currentBal = parseFloat(adv.remainingBalance || "0");
          const changed = adv.remainingBalance !== newBal2dp || adv.fullyPaid !== newFullyPaid;
          changes.push({
            advanceId: adv.id,
            workerId,
            workerName: workerMap[workerId] || `Worker #${workerId}`,
            advanceDate: adv.advanceDate,
            originalAmount: adv.amount,
            currentBalance: currentBal.toFixed(2),
            newBalance: newBal2dp,
            currentFullyPaid: adv.fullyPaid,
            newFullyPaid,
            changed,
          });
        }
      }

      res.json({ changes, totalAdvances: allAdvances.length });
    } catch (e: unknown) {
      logger.error("Advance reconcile preview error:", { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/factory/advances/reconcile - Recalculate all advance remaining balances from historical payrolls
}

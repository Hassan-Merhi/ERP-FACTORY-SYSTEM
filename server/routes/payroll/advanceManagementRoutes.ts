import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage, HttpError, sendHttpError } from "../../lib/httpHandlers";
import { logAudit } from "../helpers/auditHelpers";
import { retireVouchersForRequestTx } from "../../services/accounting/voucherRetirement";

export const ADVANCE_HAS_REPAYMENTS_MESSAGE =
  "This advance has repayments. Reverse the repayments first, then delete the advance.";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import type { AttendanceStatusRow } from "../../services/payroll/factoryPayrollGenerationPolicy";
import {
  factoryWorkers,
  factoryDaybookEntries,
  factoryPayrolls,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { MoneyDecimal, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import { getFactoryCompanyId, writeDaybookEntry } from "./advanceRouteHelpers";
import { registerUnvoucheredAdvancesRoute, registerWorkerAdvanceBalanceRoute } from "./advanceReadRoutes";

/** Find or create a ledger account by name for a company. Returns the account row.
 *  Skips soft-deleted accounts and handles race-condition unique-constraint failures. */
async function _findOrCreateLedger(companyId: number, name: string, accountType: string): Promise<{ id: number }> {
  const [existing] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [maxCodeRow] = await db
      .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
    const nextCode = String((maxCodeRow?.maxCode ?? 0) + 1 + attempt);
    try {
      const [created] = await db
        .insert(ledgerAccounts)
        .values({ companyId, code: nextCode, name, accountType, active: true, isHidden: false })
        .returning({ id: ledgerAccounts.id });
      return created;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505" || getErrorMessage(err)?.includes("unique")) {
        const [nowFound] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.name, name),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (nowFound) return nowFound;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Unable to create ledger account "${name}" after multiple attempts`);
}

const _workerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(process.cwd(), "uploads", "workers");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
});

function _computeMonthlyPay(salary: number, startStr: string, endStr: string): number {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let total = 0;
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const monthLastDay = new Date(year, month + 1, 0);
    const daysInThisMonth = monthLastDay.getDate();
    const segStart = new Date(Math.max(cur.getTime(), start.getTime()));
    const segEnd = new Date(Math.min(monthLastDay.getTime(), end.getTime()));
    const daysInSeg = Math.floor((segEnd.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    total += salary * (daysInSeg / daysInThisMonth);
    cur = new Date(year, month + 1, 1);
  }
  return total;
}

// Helper: Compute monthly pay from actual attendance records.
// Monthly payroll uses attendance-based calculation (Present/Late = 1 day, Half Day = 0.5 day)
// rather than calendar-day proration to match actual work performed.
function _computeMonthlyPayFromAttendance(
  baseSalary: number,
  periodStart: string,
  attendanceRows: readonly AttendanceStatusRow[]
): number {
  const daysInMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  };

  // Count actual days worked: Present/Late = 1 full day, Half Day = 0.5
  let attendedDays = 0;
  for (const row of attendanceRows) {
    const s = row.status || "Absent";
    if (s === "Present" || s === "Late") attendedDays += 1;
    else if (s === "Half Day") attendedDays += 0.5;
  }

  // Daily rate: salary / days in the month of periodStart
  const daysInStartMonth = daysInMonth(periodStart);
  const dailyRate = baseSalary / daysInStartMonth;
  return attendedDays * dailyRate;
}

export function registerAdvanceManagementRoutes(app: Express) {
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
          .select({ id: factoryWorkerAdvances.id })
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
      if (!(error instanceof HttpError)) logger.error("Error deleting advance:", { error: error });
      sendHttpError(res, error);
    }
  });

  // POST /api/factory/advances/:id/reverse - Reverse a paid advance (restore to outstanding)
  app.post("/api/factory/advances/:id/reverse", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin, Owner, or Developer can reverse advances" });
      }
      const companyId = req.body.companyId || getFactoryCompanyId(req);
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

      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Delete all repayment records for this advance
        const repayments = await tx
          .select()
          .from(factoryAdvanceRepayments)
          .where(eq(factoryAdvanceRepayments.advanceId, id));

        if (repayments.length > 0) {
          // Wave 7: each repayment's receipt voucher (RECEIPT-REPAY-{id}-* /
          // REPAY-SAL-{id}-*) goes with it, so reversing repayments leaves no
          // credit on Factory Worker Advances behind.
          for (const repayment of repayments) {
            const receiptVouchers = await tx
              .select({ id: vouchers.id })
              .from(vouchers)
              .where(
                and(
                  eq(vouchers.companyId, companyId),
                  sql`(${vouchers.voucherNumber} LIKE ${"RECEIPT-REPAY-" + repayment.id + "-%"} OR ${vouchers.voucherNumber} LIKE ${"REPAY-SAL-" + repayment.id + "-%"})`
                )
              );
            const receiptIds = receiptVouchers.map((v) => v.id);
            if (receiptIds.length === 0) continue;
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersForRequestTx(tx, req, companyId, receiptIds, "advance-delete-or-reverse");
          }
          await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.advanceId, id));
        }

        // Reset advance back to outstanding
        await tx
          .update(factoryWorkerAdvances)
          .set({ fullyPaid: false, remainingBalance: advance.amount })
          .where(eq(factoryWorkerAdvances.id, id));

        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "ADVANCE_REVERSED",
          referenceId: id,
          referenceTable: "factory_worker_advances",
          description: `Advance reversed for ${worker?.fullName || "Unknown"}: $${toMoney(advance.amount).toFixed(2)} restored to outstanding (${repayments.length} repayment(s) removed)`,
          createdBy: req.session.userId ?? undefined,
        });
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_worker_advances",
            recordId: id,
            recordIdentifier: `Advance #${id} reversed`,
            changes: {
              remainingBalance: { old: advance.remainingBalance, new: advance.amount },
              repaymentsRemoved: { old: repayments.map((r) => r.id).join(", ") || null, new: null },
            },
          },
          tx
        );
      });

      res.json({ message: "Advance reversed and restored to outstanding" });
    } catch (error: unknown) {
      logger.error("Error reversing advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerUnvoucheredAdvancesRoute(app);

  app.post("/api/factory/advances/post-accounting", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can post accounting" });
      }
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "Cash account is required" });

      const [acct] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });

      const result = await db.transaction(async (tx) => {
        const allAdvances = await tx
          .select({
            id: factoryWorkerAdvances.id,
            amount: factoryWorkerAdvances.amount,
            advanceDate: factoryWorkerAdvances.advanceDate,
            workerId: factoryWorkerAdvances.workerId,
            cashAccountId: factoryWorkerAdvances.cashAccountId,
            workerName: factoryWorkers.fullName,
          })
          .from(factoryWorkerAdvances)
          .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
          .where(eq(factoryWorkerAdvances.companyId, companyId));

        const existingVouchers = await tx
          .select({ voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));
        const alreadyPostedIds = new Set<number>();
        for (const v of existingVouchers) {
          const match = v.voucherNumber.match(/^PAYMENT-ADV-(\d+)-/);
          if (match) alreadyPostedIds.add(parseInt(match[1]));
        }

        const eligible = allAdvances.filter((a) => !alreadyPostedIds.has(a.id) || a.cashAccountId === null);
        const eligibleIds = new Set(eligible.map((a) => a.id));

        if (eligibleIds.size === 0) {
          return { posted: 0, skipped: 0 };
        }

        let [advancesAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));

        if (!advancesAccount) {
          const maxCodeResult = await tx
            .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^[0-9]+$'`));
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

        let posted = 0;
        let skipped = 0;
        for (const adv of eligible) {
          if (alreadyPostedIds.has(adv.id)) {
            if (adv.cashAccountId === null) {
              await tx
                .update(factoryWorkerAdvances)
                .set({ cashAccountId: cashAccountId })
                .where(eq(factoryWorkerAdvances.id, adv.id));
            }
            skipped++;
            continue;
          }

          const amount = toMoney(adv.amount);
          const voucherNumber = `PAYMENT-ADV-${adv.id}-${Date.now()}`;
          const narration = `Advance to ${adv.workerName}: $${amount.toFixed(2)} (retroactive)`;

          const [createdVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber,
              voucherType: "Payment",
              voucherDate: adv.advanceDate,
              description: narration,
              totalAmount: amount.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();

          await tx.insert(voucherEntries).values([
            {
              voucherId: createdVoucher.id,
              ledgerAccountId: advancesAccount.id,
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

          await tx
            .update(factoryWorkerAdvances)
            .set({ cashAccountId: cashAccountId })
            .where(eq(factoryWorkerAdvances.id, adv.id));

          posted++;
        }

        return { posted, skipped };
      });

      res.json({
        message: `Posted accounting for ${result.posted} advance(s)${result.skipped ? ` (${result.skipped} already posted, skipped)` : ""}`,
        posted: result.posted,
        skipped: result.skipped,
      });
    } catch (error: unknown) {
      logger.error("Error posting advance accounting:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/bulk-update-cash-account
  // Updates cashAccountId on selected advances, creates/patches PAYMENT-ADV-* vouchers, and writes daybook entries.
  app.post("/api/factory/advances/bulk-update-cash-account", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentRole = req.session.currentRole;
      if (currentRole !== "Admin" && currentRole !== "Owner" && currentRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin or Owner can update advance cash accounts" });
      }
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { advanceIds, cashAccountId: rawCashAccountId } = req.body;
      if (!Array.isArray(advanceIds) || advanceIds.length === 0) {
        return res.status(400).json({ message: "advanceIds must be a non-empty array" });
      }
      const cashAccountId = rawCashAccountId ? parseInt(rawCashAccountId) : null;
      if (!cashAccountId) return res.status(400).json({ message: "cashAccountId is required" });

      // Verify cash account belongs to this company
      const [acct] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!acct) return res.status(400).json({ message: "Cash account not found for this company" });

      const ids = advanceIds.map((x) => parseInt(x)).filter((x: number) => !isNaN(x));
      const today = getClientDate(req);

      const result = await db.transaction(async (tx) => {
        // Load the advance records we're updating (need amount, date, workerId)
        const advanceRows = await tx
          .select()
          .from(factoryWorkerAdvances)
          .where(and(eq(factoryWorkerAdvances.companyId, companyId), inArray(factoryWorkerAdvances.id, ids)));

        // Load worker names for narration
        const workerIds = [...new Set(advanceRows.map((a) => a.workerId))];
        const workerRows =
          workerIds.length > 0
            ? await tx
                .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
                .from(factoryWorkers)
                .where(inArray(factoryWorkers.id, workerIds as number[]))
            : [];
        const workerMap = new Map<number, string>(workerRows.map((w) => [w.id, w.fullName]));

        // Find or create the "Factory Worker Advances" asset ledger account
        let [advancesAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));
        if (!advancesAccount) {
          const maxCodeResult = await tx
            .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
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
        const advancesAccountId = advancesAccount.id;

        // Update cashAccountId on each advance record
        await tx
          .update(factoryWorkerAdvances)
          .set({ cashAccountId })
          .where(and(eq(factoryWorkerAdvances.companyId, companyId), inArray(factoryWorkerAdvances.id, ids)));

        // Find existing PAYMENT-ADV-* vouchers for these advances
        const matchingVouchers = await tx
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE 'PAYMENT-ADV-%'`));

        // Map advance id → voucher id (for those that already have a voucher)
        const advVoucherMap = new Map<number, number>();
        for (const v of matchingVouchers) {
          const match = v.voucherNumber.match(/^PAYMENT-ADV-(\d+)-/);
          if (match) {
            const advId = parseInt(match[1]);
            if (ids.includes(advId)) advVoucherMap.set(advId, v.id);
          }
        }

        let vouchersPatched = 0;
        let vouchersCreated = 0;

        for (const adv of advanceRows) {
          const workerName = workerMap.get(adv.workerId) ?? "Worker";
          const amount = toMoney(adv.amount);
          const advDate = adv.advanceDate ?? today;
          const narration = `Advance to ${workerName}: $${amount.toFixed(2)}`;

          if (advVoucherMap.has(adv.id)) {
            // Patch the credit leg of the existing voucher to the new cash account
            const voucherId = advVoucherMap.get(adv.id)!;
            const entries = await tx
              .select({ id: voucherEntries.id, creditAmount: voucherEntries.creditAmount })
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, voucherId));

            const creditEntry = entries
              .filter((e) => toMoney(e.creditAmount).gt(0))
              .sort((a, b) => toMoney(b.creditAmount).comparedTo(toMoney(a.creditAmount)))[0];

            if (creditEntry) {
              await tx
                .update(voucherEntries)
                .set({ ledgerAccountId: cashAccountId })
                .where(eq(voucherEntries.id, creditEntry.id));
              vouchersPatched++;
            }
          } else {
            // No voucher existed — create one now: DR Factory Worker Advances / CR Cash
            const voucherNumber = `PAYMENT-ADV-${adv.id}-${Date.now()}`;
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
            vouchersCreated++;
          }

          // Daybook entry for every advance updated
          await writeDaybookEntry(tx, {
            companyId,
            txDate: today,
            txType: "ADVANCE_CASH_UPDATED",
            referenceId: adv.id,
            referenceTable: "factory_worker_advances",
            description: `Cash account assigned for advance to ${workerName}: $${amount.toFixed(2)} → ${acct.name}`,
            amountCurrency: amount.toNumber(),
            amountUsd: amount.toNumber(),
            createdBy: req.session.userId ?? undefined,
          });
        }

        return { updated: advanceRows.length, vouchersPatched, vouchersCreated };
      });

      res.json({
        message: `Updated ${result.updated} advance(s); ${result.vouchersCreated} voucher(s) created, ${result.vouchersPatched} patched`,
        updated: result.updated,
        vouchersCreated: result.vouchersCreated,
        vouchersPatched: result.vouchersPatched,
      });
    } catch (error: unknown) {
      logger.error("Error bulk-updating advance cash accounts:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/workers/:id/advance-balance - Get total outstanding advance balance
  registerWorkerAdvanceBalanceRoute(app);
}

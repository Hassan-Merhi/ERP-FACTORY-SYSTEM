import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { eq, and, desc, sql, inArray, isNull } from "drizzle-orm";
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

/** Prefer the factory-pinned company ID so cross-tab ERP company switches don't corrupt factory writes. */
function getFactoryCompanyId(req: import("express").Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

/** Write a single daybook entry (factory audit log). */
async function writeDaybookEntry(
  dbOrTx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    companyId: number;
    txDate: string;
    txType: string;
    referenceId?: number;
    referenceTable?: string;
    description: string;
    metaJson?: string;
    currencyCode?: string;
    amountCurrency?: number;
    fxRateToUsd?: number;
    amountUsd?: number;
    createdBy?: string | null;
  }
) {
  const currency = opts.currencyCode || "USD";
  const fxRate = opts.fxRateToUsd || 1;
  const amtCurrency = opts.amountCurrency || 0;
  const amtUsd =
    opts.amountUsd !== undefined ? opts.amountUsd : currency === "USD" ? amtCurrency : amtCurrency * fxRate;
  await dbOrTx.insert(factoryDaybookEntries).values({
    companyId: opts.companyId,
    txDate: opts.txDate,
    txType: opts.txType,
    referenceId: opts.referenceId || null,
    referenceTable: opts.referenceTable || null,
    description: opts.description,
    metaJson: opts.metaJson || null,
    currencyCode: currency,
    amountCurrency: String(amtCurrency),
    fxRateToUsd: String(fxRate),
    amountUsd: String(amtUsd),
    createdBy: opts.createdBy || null,
  });
}

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

      const payrollDeductionByWorker = new Map<number, number>();
      for (const pr of allPayrolls) {
        const amt = parseFloat(pr.advances || "0");
        if (amt > 0) {
          payrollDeductionByWorker.set(pr.workerId, (payrollDeductionByWorker.get(pr.workerId) || 0) + amt);
        }
      }

      // Manual repayments keyed by advanceId
      const manualRepaymentByAdvance = new Map<number, number>();
      for (const rep of allRepayments) {
        manualRepaymentByAdvance.set(
          rep.advanceId,
          (manualRepaymentByAdvance.get(rep.advanceId) || 0) + parseFloat(rep.amount || "0")
        );
      }

      let updatedCount = 0;
      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        for (const [workerId, advances] of advancesByWorker) {
          // Step 1: Reset each advance to its original amount minus manual repayments
          const balances: { id: number; bal: number }[] = [];
          for (const adv of advances) {
            const original = parseFloat(adv.amount || "0");
            const manualPaid = manualRepaymentByAdvance.get(adv.id) || 0;
            balances.push({ id: adv.id, bal: Math.max(0, original - manualPaid) });
          }

          // Step 2: Apply total payroll deductions oldest-first
          let remaining = payrollDeductionByWorker.get(workerId) || 0;
          for (const entry of balances) {
            if (remaining <= 0) break;
            const deduct = Math.min(entry.bal, remaining);
            entry.bal = entry.bal - deduct;
            remaining -= deduct;
          }

          // Step 3: Persist updated balances
          for (let i = 0; i < advances.length; i++) {
            const newBal = Math.max(0, balances[i].bal);
            const newBal2dp = newBal.toFixed(2);
            const fullyPaid = newBal <= 0.001;
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

      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const repayments = await tx
          .select()
          .from(factoryAdvanceRepayments)
          .where(eq(factoryAdvanceRepayments.advanceId, id));

        if (repayments.length > 0) {
          // Delete ADVANCE_REPAYMENT daybook entries for these repayments before
          // removing the repayment records so orphaned daybook rows don't linger.
          const repaymentIds = repayments.map((r) => r.id);
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.referenceTable, "factory_advance_repayments"),
                inArray(factoryDaybookEntries.referenceId, repaymentIds)
              )
            );
          await tx.delete(factoryAdvanceRepayments).where(eq(factoryAdvanceRepayments.advanceId, id));
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
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, vIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, vIds));
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

        const repayNote = repayments.length > 0 ? ` (${repayments.length} repayment(s) also removed)` : "";
        const voucherNote = advanceVouchers.length > 0 ? "; voucher reversed" : "";
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "ADVANCE_DELETED",
          referenceId: id,
          referenceTable: "factory_worker_advances",
          description: `Advance deleted for ${worker?.fullName || "Unknown"}: $${parseFloat(advance.amount).toFixed(2)}${repayNote}${voucherNote}`,
          createdBy: req.session.userId ?? undefined,
        });
      });

      res.json({ message: "Advance deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
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
          description: `Advance reversed for ${worker?.fullName || "Unknown"}: $${parseFloat(advance.amount).toFixed(2)} restored to outstanding (${repayments.length} repayment(s) removed)`,
          createdBy: req.session.userId ?? undefined,
        });
      });

      res.json({ message: "Advance reversed and restored to outstanding" });
    } catch (error: unknown) {
      logger.error("Error reversing advance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

          const amount = parseFloat(adv.amount);
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
          const amount = parseFloat(adv.amount || "0");
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
              .filter((e) => parseFloat(e.creditAmount || "0") > 0)
              .sort((a, b) => parseFloat(b.creditAmount || "0") - parseFloat(a.creditAmount || "0"))[0];

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
            amountCurrency: amount,
            amountUsd: amount,
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

      const totalBalance = outstanding.reduce((s: number, a) => s + parseFloat(a.remainingBalance || "0"), 0);
      res.json({ totalBalance: totalBalance.toFixed(2), count: outstanding.length });
    } catch (error: unknown) {
      logger.error("Error fetching advance balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/repay-by-month - Bulk repay all outstanding advances for a given month
}

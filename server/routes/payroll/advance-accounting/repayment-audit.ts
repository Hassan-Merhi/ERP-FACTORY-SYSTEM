/**
 * advanceAccountingRoutes: AdvanceRepaymentAudit endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import { toMoney } from "../../../lib/money";

export function registerAdvanceRepaymentAuditRoutes(app: Express) {
  // GET /api/factory/advances/repayment-audit — find salary deduction advances missing cash vouchers
  app.get("/api/factory/advances/repayment-audit", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // 1. All salary_deduction advances
      const allAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        )
        .orderBy(desc(factoryWorkerAdvances.advanceDate));

      const advanceIds = allAdvances.map((r) => r.factory_worker_advances.id);

      // 2. All repayment records for those advances
      const repayments =
        advanceIds.length > 0
          ? await db
              .select()
              .from(factoryAdvanceRepayments)
              .where(
                and(
                  eq(factoryAdvanceRepayments.companyId, companyId),
                  inArray(factoryAdvanceRepayments.advanceId, advanceIds)
                )
              )
          : [];

      // 3. All repayment vouchers for this company (both old RECEIPT-REPAY and new REPAY-SAL patterns)
      const repayVouchers = await db
        .select({ voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            sql`(${vouchers.voucherNumber} LIKE 'RECEIPT-REPAY-%' OR ${vouchers.voucherNumber} LIKE 'REPAY-SAL-%')`
          )
        );

      const voucheredRepayIds = new Set<number>();
      for (const v of repayVouchers) {
        const m = v.voucherNumber.match(/^(?:RECEIPT-REPAY|REPAY-SAL)-(\d+)-/);
        if (m) voucheredRepayIds.add(parseInt(m[1]));
      }

      // 4. Build repayments map by advanceId
      const repaysByAdvId = new Map<number, typeof repayments>();
      for (const r of repayments) {
        const list = repaysByAdvId.get(r.advanceId) || [];
        list.push(r);
        repaysByAdvId.set(r.advanceId, list);
      }

      // 5. Categorize
      const auditAdvances = [];
      for (const row of allAdvances) {
        const adv = row.factory_worker_advances;
        const worker = row.factory_workers;
        const advRepays = repaysByAdvId.get(adv.id) || [];
        const isPaid = adv.fullyPaid || toMoney(adv.remainingBalance).lte("0.005");

        if (advRepays.length === 0) {
          if (isPaid) {
            auditAdvances.push({
              id: adv.id,
              workerId: adv.workerId,
              workerName: worker.fullName,
              advanceDate: adv.advanceDate,
              amount: adv.amount,
              remainingBalance: adv.remainingBalance,
              fullyPaid: adv.fullyPaid,
              caseType: "no_repayment",
              repayments: [],
              missingVoucherRepayments: [],
            });
          }
        } else {
          const missingVoucherRepays = advRepays.filter((r) => !voucheredRepayIds.has(r.id));
          if (missingVoucherRepays.length > 0) {
            auditAdvances.push({
              id: adv.id,
              workerId: adv.workerId,
              workerName: worker.fullName,
              advanceDate: adv.advanceDate,
              amount: adv.amount,
              remainingBalance: adv.remainingBalance,
              fullyPaid: adv.fullyPaid,
              caseType: "missing_voucher",
              repayments: advRepays,
              missingVoucherRepayments: missingVoucherRepays,
            });
          }
        }
      }

      res.json({
        advances: auditAdvances,
        summary: {
          total: allAdvances.length,
          ok: allAdvances.length - auditAdvances.length,
          missingVoucher: auditAdvances.filter((a) => a.caseType === "missing_voucher").length,
          noRepayment: auditAdvances.filter((a) => a.caseType === "no_repayment").length,
        },
      });
    } catch (error: unknown) {
      logger.error("Error in repayment-audit:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/post-repayment-vouchers — fix missing repayment accounting
  app.post("/api/factory/advances/post-repayment-vouchers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { cashAccountId: rawAcctId, repaymentDate } = req.body;
      const cashAccountId = parseInt(rawAcctId);
      if (!cashAccountId || isNaN(cashAccountId)) return res.status(400).json({ message: "cashAccountId is required" });
      if (!repaymentDate) return res.status(400).json({ message: "repaymentDate is required" });

      const [cashAcct] = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAcct) return res.status(400).json({ message: "Cash account not found" });

      // Resolve or auto-create "Factory Workers Salary Payable" as the contra for salary-deduction repayments
      // (DR Salary Payable / CR Factory Worker Advances — salary deductions don't touch cash)
      let [payableAcct] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Workers Salary Payable")));
      if (!payableAcct) {
        const [maxCodeRow] = await db
          .select({ maxCode: sql<string>`MAX(${ledgerAccounts.code})` })
          .from(ledgerAccounts)
          .where(eq(ledgerAccounts.companyId, companyId));
        const nextCode = String((parseInt(maxCodeRow?.maxCode || "1000") || 1000) + 1);
        [payableAcct] = await db
          .insert(ledgerAccounts)
          .values({
            companyId,
            code: nextCode,
            name: "Factory Workers Salary Payable",
            accountType: "Accounts Payable",
            openingBalance: "0",
            openingBalanceSide: "Cr",
          })
          .returning({ id: ledgerAccounts.id, name: ledgerAccounts.name });
      }

      // Re-run audit to get fresh list
      const allAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .innerJoin(factoryWorkers, eq(factoryWorkerAdvances.workerId, factoryWorkers.id))
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.repaymentType, "salary_deduction")
          )
        );

      const advanceIds = allAdvances.map((r) => r.factory_worker_advances.id);
      const repayments =
        advanceIds.length > 0
          ? await db
              .select()
              .from(factoryAdvanceRepayments)
              .where(
                and(
                  eq(factoryAdvanceRepayments.companyId, companyId),
                  inArray(factoryAdvanceRepayments.advanceId, advanceIds)
                )
              )
          : [];

      const repayVouchers = await db
        .select({ voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            sql`(${vouchers.voucherNumber} LIKE 'RECEIPT-REPAY-%' OR ${vouchers.voucherNumber} LIKE 'REPAY-SAL-%')`
          )
        );

      const voucheredRepayIds = new Set<number>();
      for (const v of repayVouchers) {
        const m = v.voucherNumber.match(/^(?:RECEIPT-REPAY|REPAY-SAL)-(\d+)-/);
        if (m) voucheredRepayIds.add(parseInt(m[1]));
      }

      const repaysByAdvId = new Map<number, typeof repayments>();
      for (const r of repayments) {
        const list = repaysByAdvId.get(r.advanceId) || [];
        list.push(r);
        repaysByAdvId.set(r.advanceId, list);
      }

      const result = await db.transaction(async (tx) => {
        // Resolve/create Factory Worker Advances ledger account once
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

        let posted = 0;

        for (const row of allAdvances) {
          const adv = row.factory_worker_advances;
          const worker = row.factory_workers;
          const advRepays = repaysByAdvId.get(adv.id) || [];
          const isPaid = adv.fullyPaid || toMoney(adv.remainingBalance).lte("0.005");
          const workerName = worker.fullName || `Worker #${adv.workerId}`;

          if (advRepays.length === 0 && isPaid) {
            // Case B: no repayment record — create one + voucher
            const amount = toMoney(adv.amount);
            if (amount.lte(0)) continue;

            const [repayment] = await tx
              .insert(factoryAdvanceRepayments)
              .values({
                companyId,
                advanceId: adv.id,
                workerId: adv.workerId,
                repaymentDate,
                amount: amount.toFixed(2),
                cashAccountId,
                notes: "Auto-created by Repayment Audit",
              })
              .returning();

            const narration = `Salary deduction repayment — ${workerName}: $${amount.toFixed(2)} (advance #${adv.id})`;
            const voucherNumber = `REPAY-SAL-${repayment.id}-${Date.now()}`;
            const [voucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber,
                voucherType: "Journal",
                voucherDate: repaymentDate,
                description: narration,
                totalAmount: amount.toFixed(2),
                currency: "USD",
                sourceModule: "FACTORY",
              })
              .returning();

            // DR Factory Workers Salary Payable / CR Factory Worker Advances
            // Salary deductions reduce the company's wage obligation — no cash movement
            await tx.insert(voucherEntries).values([
              {
                voucherId: voucher.id,
                ledgerAccountId: payableAcct.id,
                debitAmount: amount.toFixed(2),
                creditAmount: "0",
                narration,
              },
              {
                voucherId: voucher.id,
                ledgerAccountId: advancesAccount.id,
                debitAmount: "0",
                creditAmount: amount.toFixed(2),
                narration,
              },
            ]);
            posted++;
          } else {
            // Case A: repayment records exist, re-create missing vouchers
            const missingRepays = advRepays.filter((r) => !voucheredRepayIds.has(r.id));
            for (const repay of missingRepays) {
              const amount = toMoney(repay.amount);
              if (amount.lte(0)) continue;
              const rDate = repay.repaymentDate || repaymentDate;
              const narration = `Salary deduction repayment — ${workerName}: $${amount.toFixed(2)} (advance #${adv.id})`;
              const voucherNumber = `REPAY-SAL-${repay.id}-${Date.now()}`;
              const [voucher] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber,
                  voucherType: "Journal",
                  voucherDate: rDate,
                  description: narration,
                  totalAmount: amount.toFixed(2),
                  currency: "USD",
                  sourceModule: "FACTORY",
                })
                .returning();

              await tx.insert(voucherEntries).values([
                {
                  voucherId: voucher.id,
                  ledgerAccountId: payableAcct.id,
                  debitAmount: amount.toFixed(2),
                  creditAmount: "0",
                  narration,
                },
                {
                  voucherId: voucher.id,
                  ledgerAccountId: advancesAccount.id,
                  debitAmount: "0",
                  creditAmount: amount.toFixed(2),
                  narration,
                },
              ]);
              posted++;
            }
          }
        }

        return posted;
      });

      res.json({ message: `Posted ${result} missing repayment voucher(s) successfully.`, posted: result });
    } catch (error: unknown) {
      logger.error("Error in post-repayment-vouchers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── ADVANCE REPAYMENTS ─────────────────────────────────────────
}

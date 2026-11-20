// Extracted from ./repayment-audit.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  factoryWorkers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
} from "@shared/schema";
import { getFactoryCompanyId } from "./_helpers";
import { toMoney } from "../../../lib/money";
import { postErpVoucherTx } from "../../../services/accounting/erpVoucherPosting";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The handler parses the account with parseInt and answers its own 400s.
const postRepaymentVouchersInput = {
  query: emptyQuery,
  body: z.strictObject({
    // Read before the session company (no client sends it).
    companyId: z.union([z.number(), z.string()]).optional(),
    cashAccountId: z.union([z.number(), z.string()]).nullable().optional(),
    repaymentDate: z.string().nullable().optional(),
    // Request identity: the client fetch guard adds it and operationalVoucherRequestBoundary claims it.
    clientRequestId: z.string().optional(),
  }),
} satisfies RequestSchemas;

export function registerAdvanceRepaymentAuditRoutesPart1(app: Express) {
  // POST /api/factory/advances/post-repayment-vouchers — fix missing repayment accounting
  app.post(
    "/api/factory/advances/post-repayment-vouchers",
    requireAuth,
    validateRequest(postRepaymentVouchersInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.body.companyId || getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { cashAccountId: rawAcctId, repaymentDate } = req.body;
        const cashAccountId = parseInt(rawAcctId);
        if (!cashAccountId || isNaN(cashAccountId))
          return res.status(400).json({ message: "cashAccountId is required" });
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
          .where(
            and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Workers Salary Payable"))
          );
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
              const voucherNumber = `REPAY-SAL-${repayment.id}-1`;
              // DR Factory Workers Salary Payable / CR Factory Worker Advances
              // Salary deductions reduce the company's wage obligation — no cash movement

              await await postErpVoucherTx(tx, {
                companyId,
                voucherNumber,
                voucherType: "Journal",
                voucherDate: repaymentDate,
                description: narration,
                currency: "USD",
                sourceModule: "FACTORY",
                lines: [
                  { ledgerAccountId: payableAcct.id, debit: amount.toFixed(2), narration: narration },
                  { ledgerAccountId: advancesAccount.id, credit: amount.toFixed(2), narration: narration },
                ],
                source: { type: "advance-repayment-salary", id: repayment.id },
              });
              posted++;
            } else {
              // Case A: repayment records exist, re-create missing vouchers
              const missingRepays = advRepays.filter((r) => !voucheredRepayIds.has(r.id));
              for (const repay of missingRepays) {
                const amount = toMoney(repay.amount);
                if (amount.lte(0)) continue;
                const rDate = repay.repaymentDate || repaymentDate;
                const narration = `Salary deduction repayment — ${workerName}: $${amount.toFixed(2)} (advance #${adv.id})`;
                const voucherNumber = `REPAY-SAL-${repay.id}-1`;
                await await postErpVoucherTx(tx, {
                  companyId,
                  voucherNumber,
                  voucherType: "Journal",
                  voucherDate: rDate,
                  description: narration,
                  currency: "USD",
                  sourceModule: "FACTORY",
                  lines: [
                    { ledgerAccountId: payableAcct.id, debit: amount.toFixed(2), narration: narration },
                    { ledgerAccountId: advancesAccount.id, credit: amount.toFixed(2), narration: narration },
                  ],
                  source: { type: "advance-repayment-salary", id: repay.id },
                });
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
    }
  );
}

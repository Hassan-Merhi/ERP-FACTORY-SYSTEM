/**
 * advanceAccountingRoutes: AdvanceBulkRepay endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql } from "drizzle-orm";
import {
  factoryWorkers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";

import { getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export function registerAdvanceBulkRepayRoutes(app: Express) {
  app.post("/api/factory/workers/:id/bulk-repay-advances", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });

      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;
      const repaymentDate = req.body.repaymentDate || getClientDate(req);
      const notes = req.body.notes || null;
      // Per-advance repayment dates sent from the frontend preview (each loan on its own month)
      const perAdvanceDates: Record<number, string> = {};
      if (Array.isArray(req.body.advances)) {
        for (const a of req.body.advances) {
          if (a.id && a.repaymentDate) perAdvanceDates[parseInt(a.id)] = a.repaymentDate;
        }
      }

      if (cashAccountId) {
        const [acct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
        if (!acct) return res.status(400).json({ message: "Cash account not found" });
      }

      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, workerId));
      if (!worker) return res.status(404).json({ message: "Worker not found" });

      const outstandingAdvances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(
          and(
            eq(factoryWorkerAdvances.companyId, companyId),
            eq(factoryWorkerAdvances.workerId, workerId),
            eq(factoryWorkerAdvances.repaymentType, "manual_repayment"),
            eq(factoryWorkerAdvances.fullyPaid, false)
          )
        );

      const toRepay = outstandingAdvances.filter((a) => toMoney(a.remainingBalance).gt("0.001"));
      if (toRepay.length === 0) {
        return res.status(400).json({ message: "No outstanding manual repayment advances found for this worker" });
      }

      const result = await db.transaction(async (tx) => {
        let advancesAccountId: number | null = null;
        if (cashAccountId) {
          let [found] = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Worker Advances")));
          if (!found) {
            const maxCodeResult = await tx
              .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
              .from(ledgerAccounts)
              .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
            const nextCode = String((maxCodeResult[0]?.maxCode ?? 0) + 1);
            [found] = await tx
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
          advancesAccountId = found.id;
        }

        const repaymentResults = [];
        let totalRepaid: Decimal = new MoneyDecimal(0);

        for (const advance of toRepay) {
          const effectiveAmount = toMoney(advance.remainingBalance).toDecimalPlaces(2);
          if (effectiveAmount.lte(0)) continue;

          // Use per-advance date if provided (each loan on its own month), else fall back to global date
          const effectiveRepaymentDate = perAdvanceDates[advance.id] || repaymentDate;

          const [repayment] = await tx
            .insert(factoryAdvanceRepayments)
            .values({
              companyId,
              advanceId: advance.id,
              workerId,
              repaymentDate: effectiveRepaymentDate,
              amount: effectiveAmount.toFixed(2),
              cashAccountId,
              notes,
            })
            .returning();

          await tx
            .update(factoryWorkerAdvances)
            .set({
              remainingBalance: "0.00",
              fullyPaid: true,
            })
            .where(eq(factoryWorkerAdvances.id, advance.id));

          if (cashAccountId && advancesAccountId) {
            const voucherNumber = `RECEIPT-REPAY-${repayment.id}-${Date.now()}`;
            const narration = `Bulk advance repayment from ${worker.fullName}: $${effectiveAmount.toFixed(2)} (advance #${advance.id})`;
            const [createdVoucher] = await tx
              .insert(vouchers)
              .values({
                companyId,
                voucherNumber,
                voucherType: "Receipt",
                voucherDate: effectiveRepaymentDate,
                description: narration,
                totalAmount: effectiveAmount.toFixed(2),
                currency: "USD",
                sourceModule: "FACTORY",
              })
              .returning();

            await tx.insert(voucherEntries).values([
              {
                voucherId: createdVoucher.id,
                ledgerAccountId: cashAccountId,
                debitAmount: effectiveAmount.toFixed(2),
                creditAmount: "0",
                narration,
              },
              {
                voucherId: createdVoucher.id,
                ledgerAccountId: advancesAccountId,
                debitAmount: "0",
                creditAmount: effectiveAmount.toFixed(2),
                narration,
              },
            ]);
          }

          await writeDaybookEntry(tx, {
            companyId,
            txDate: effectiveRepaymentDate,
            txType: "ADVANCE_REPAYMENT",
            referenceId: repayment.id,
            referenceTable: "factory_advance_repayments",
            description: `Bulk advance repayment from ${worker.fullName}: $${effectiveAmount.toFixed(2)} (advance #${advance.id})`,
            amountCurrency: effectiveAmount.toNumber(),
            currencyCode: "USD",
            amountUsd: effectiveAmount.toNumber(),
            createdBy: req.session.userId ?? undefined,
          });

          repaymentResults.push(repayment);
          totalRepaid = totalRepaid.plus(effectiveAmount);
        }

        return { count: repaymentResults.length, totalRepaid: totalRepaid.toNumber(), repayments: repaymentResults };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error bulk repaying advances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

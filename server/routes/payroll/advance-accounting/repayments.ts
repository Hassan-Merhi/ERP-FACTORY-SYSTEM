/**
 * advanceAccountingRoutes: AdvanceRepayment endpoints.
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
import { eq, and, desc, sql } from "drizzle-orm";
import {
  factoryWorkers,
  factoryWorkerAdvances,
  factoryAdvanceRepayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";

import { getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import { MoneyDecimal, moneyString, parseMoneyInput, toMoney } from "../../../lib/money";

export function registerAdvanceRepaymentRoutes(app: Express) {
  app.get("/api/factory/advances/:id/repayments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advanceId = parseId(req.params.id);
      if (advanceId === null) return res.status(400).json({ message: "Invalid id" });

      const [advance] = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.id, advanceId), eq(factoryWorkerAdvances.companyId, companyId)));
      if (!advance) return res.status(404).json({ message: "Advance not found" });

      const repayments = await db
        .select()
        .from(factoryAdvanceRepayments)
        .where(
          and(eq(factoryAdvanceRepayments.advanceId, advanceId), eq(factoryAdvanceRepayments.companyId, companyId))
        )
        .orderBy(desc(factoryAdvanceRepayments.repaymentDate));

      res.json(repayments);
    } catch (error: unknown) {
      logger.error("Error fetching advance repayments:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/advances/:id/repayments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const advanceId = parseId(req.params.id);
      if (advanceId === null) return res.status(400).json({ message: "Invalid id" });

      const [advance] = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(eq(factoryWorkerAdvances.id, advanceId), eq(factoryWorkerAdvances.companyId, companyId)));
      if (!advance) return res.status(404).json({ message: "Advance not found" });
      if (advance.repaymentType !== "manual_repayment") {
        return res.status(400).json({ message: "Only manual repayment advances can receive repayments" });
      }
      if (advance.fullyPaid) {
        return res.status(400).json({ message: "This advance is already fully paid" });
      }

      const amount = parseMoneyInput(req.body.amount);
      if (!amount || amount.lte(0)) return res.status(400).json({ message: "Amount must be positive" });

      const bal = toMoney(advance.remainingBalance);
      if (amount.gt(bal.plus("0.01"))) {
        return res
          .status(400)
          .json({ message: `Repayment ($${amount.toFixed(2)}) exceeds remaining balance ($${bal.toFixed(2)})` });
      }
      // At cents, so the repayment, the voucher and the new balance agree exactly.
      const effectiveAmount = MoneyDecimal.min(amount, bal).toDecimalPlaces(2);

      const repaymentDate = req.body.repaymentDate || getClientDate(req);
      const cashAccountId = req.body.cashAccountId ? parseInt(req.body.cashAccountId) : null;

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
        .where(eq(factoryWorkers.id, advance.workerId));

      const result = await db.transaction(async (tx) => {
        const [repayment] = await tx
          .insert(factoryAdvanceRepayments)
          .values({
            companyId,
            advanceId,
            workerId: advance.workerId,
            repaymentDate,
            amount: effectiveAmount.toFixed(2),
            cashAccountId,
            notes: req.body.notes || null,
          })
          .returning();

        const newBalance = bal.minus(effectiveAmount);
        const isFullyPaid = newBalance.lte("0.005");

        await tx
          .update(factoryWorkerAdvances)
          .set({
            remainingBalance: moneyString(MoneyDecimal.max(0, newBalance)),
            fullyPaid: isFullyPaid,
          })
          .where(eq(factoryWorkerAdvances.id, advanceId));

        if (cashAccountId) {
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

          const voucherNumber = `RECEIPT-REPAY-${repayment.id}-${Date.now()}`;
          const narration = `Advance repayment from ${worker?.fullName || "Worker"}: $${effectiveAmount.toFixed(2)}`;

          const [createdVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber,
              voucherType: "Receipt",
              voucherDate: repaymentDate,
              description: narration,
              totalAmount: effectiveAmount.toFixed(2),
              currency: "USD",
              sourceModule: "FACTORY",
            })
            .returning();

          const repayNarration = `Advance repayment from ${worker?.fullName || "Worker"}: $${effectiveAmount.toFixed(2)}`;
          await tx.insert(voucherEntries).values([
            {
              voucherId: createdVoucher.id,
              ledgerAccountId: cashAccountId,
              debitAmount: effectiveAmount.toFixed(2),
              creditAmount: "0",
              narration: repayNarration,
            },
            {
              voucherId: createdVoucher.id,
              ledgerAccountId: advancesAccount.id,
              debitAmount: "0",
              creditAmount: effectiveAmount.toFixed(2),
              narration: repayNarration,
            },
          ]);
        }

        await writeDaybookEntry(tx, {
          companyId,
          txDate: repaymentDate,
          txType: "ADVANCE_REPAYMENT",
          referenceId: repayment.id,
          referenceTable: "factory_advance_repayments",
          description: `Advance repayment from ${worker?.fullName || "Worker"}: $${effectiveAmount.toFixed(2)} (advance #${advanceId})`,
          amountCurrency: effectiveAmount.toNumber(),
          currencyCode: "USD",
          amountUsd: effectiveAmount.toNumber(),
          createdBy: req.session.userId ?? undefined,
        });

        const [updatedAdvance] = await tx
          .select()
          .from(factoryWorkerAdvances)
          .where(eq(factoryWorkerAdvances.id, advanceId));

        return { repayment, advance: updatedAdvance };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error recording advance repayment:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

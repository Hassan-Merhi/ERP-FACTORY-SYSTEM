import Decimal from "decimal.js";
/**
 * advanceAccountingRoutes: AdvanceCash endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql, isNull } from "drizzle-orm";
import { ledgerAccounts, bankAccounts, vouchers, voucherEntries } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";

export function registerAdvanceCashRoutes(app: Express) {
  // GET /api/factory/cash-account-balance/:id — current DR-CR balance for a ledger account
  app.get("/api/factory/cash-account-balance/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseId(req.params.id);
      if (accountId === null) return res.status(400).json({ message: "Invalid id" });

      const [acct] = await db
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
          openingBalance: ledgerAccounts.openingBalance,
          openingBalanceSide: ledgerAccounts.openingBalanceSide,
        })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
      if (!acct) return res.status(404).json({ message: "Account not found" });

      // Some cash entries are stored with bankAccountId (bank-linked), not ledgerAccountId.
      // Find any bankAccounts record whose linkedLedgerId = this ledger account.
      const linkedBanks = await db
        .select({
          id: bankAccounts.id,
          openingBalance: bankAccounts.openingBalance,
          openingBalanceSide: bankAccounts.openingBalanceSide,
        })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.linkedLedgerId, accountId), eq(bankAccounts.companyId, companyId)));

      // Sum entries via ledgerAccountId
      const [ledgerTotals] = await db
        .select({
          totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)`,
          totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)`,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, accountId),
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            isNull(vouchers.deletedAt)
          )
        );

      // Deleted and optional (provisional) vouchers are outside every ledger
      // balance; this one is shown before posting cash adjustments.
      const signed = (amount: string | null, side: string | null) =>
        side === "Cr" ? new Decimal(amount || "0").negated() : new Decimal(amount || "0");
      let balance = signed(acct.openingBalance, acct.openingBalanceSide)
        .plus(ledgerTotals.totalDebit)
        .minus(ledgerTotals.totalCredit);

      // Also sum entries via bankAccountId for each linked bank account
      for (const bank of linkedBanks) {
        const [bankTotals] = await db
          .select({
            totalDebit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}::numeric), 0)`,
            totalCredit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}::numeric), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              eq(voucherEntries.bankAccountId, bank.id),
              eq(vouchers.companyId, companyId),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt)
            )
          );
        balance = balance
          .plus(bankTotals.totalDebit)
          .minus(bankTotals.totalCredit)
          .plus(signed(bank.openingBalance, bank.openingBalanceSide));
      }

      res.json({ accountId, name: acct.name, balance: balance.toFixed(2) });
    } catch (error: unknown) {
      logger.error("Error fetching account balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/advances/cash-adjustment — post a correcting journal entry on a cash account
  app.post("/api/factory/advances/cash-adjustment", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { cashAccountId: rawAcctId, amount: rawAmount, direction, date, narration } = req.body;
      const cashAccountId = parseInt(rawAcctId);
      if (!cashAccountId || isNaN(cashAccountId)) return res.status(400).json({ message: "cashAccountId is required" });
      const amount = parseFloat(rawAmount);
      if (!amount || amount <= 0) return res.status(400).json({ message: "amount must be a positive number" });
      if (!date) return res.status(400).json({ message: "date is required" });
      const isCredit = direction !== "debit"; // default credit (reduces cash)

      const [cashAcct] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!cashAcct) return res.status(400).json({ message: "Cash account not found" });

      await db.transaction(async (tx) => {
        // Resolve or auto-create the contra "Factory Advance Adjustments" account
        let [adjAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, "Factory Advance Adjustments")));
        if (!adjAccount) {
          const maxCodeResult = await tx
            .select({ maxCode: sql<number | null>`MAX(CAST(code AS INTEGER))` })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), sql`code ~ '^\\d+$'`));
          const nextCode = String((maxCodeResult[0]?.maxCode ?? 0) + 1);
          [adjAccount] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code: nextCode,
              name: "Factory Advance Adjustments",
              accountType: "Equity",
              active: true,
              isHidden: false,
            })
            .returning();
        }

        const voucherNumber = `ADJ-CASH-${cashAccountId}-${Date.now()}`;
        const desc = narration || "Cash balance adjustment";

        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: "Journal",
            voucherDate: date,
            description: desc,
            totalAmount: amount.toFixed(2),
            currency: "USD",
            sourceModule: "FACTORY",
          })
          .returning();

        // isCredit = true  → CR Cash / DR Adjustments  (reduces cash balance)
        // isCredit = false → DR Cash / CR Adjustments  (increases cash balance)
        await tx.insert(voucherEntries).values([
          {
            voucherId: voucher.id,
            ledgerAccountId: adjAccount.id,
            debitAmount: isCredit ? amount.toFixed(2) : "0",
            creditAmount: isCredit ? "0" : amount.toFixed(2),
            narration: desc,
          },
          {
            voucherId: voucher.id,
            ledgerAccountId: cashAccountId,
            debitAmount: isCredit ? "0" : amount.toFixed(2),
            creditAmount: isCredit ? amount.toFixed(2) : "0",
            narration: desc,
          },
        ]);
      });

      res.json({
        message: `Cash adjustment posted — ${isCredit ? "CR" : "DR"} ${cashAcct.name} $${amount.toFixed(2)}`,
      });
    } catch (error: unknown) {
      logger.error("Error posting cash adjustment:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

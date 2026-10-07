import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../auth";
import { voucherEntries, vouchers } from "@shared/schema";
import { voucherMutationBlockReason } from "../lib/migratedVoucherGuard";
import { normalizeVoucherEntryAmounts } from "../services/accounting/currencyAmounts";
import { autoReallocateLoansAccounts } from "../lib/transporterAllocation";

function canEditVoucherDate(role: string, voucherDate: string | Date): boolean {
  if (role === "Admin" || role === "Owner" || role === "Developer") return true;
  if (role !== "Manager") return false;
  const date = new Date(voucherDate);
  const today = new Date();
  date.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return date.getTime() === today.getTime();
}

export function registerVoucherEntryCurrencyEditRoutes(app: Express) {
  // Registered before voucherEntryRoutes. Existing clients keep the same URL,
  // but CFA amounts are interpreted as original transaction-currency values.
  app.patch("/api/voucher-entries/:id", requireAuth, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "Invalid voucher entry ID" });
      }

      const [row] = await db
        .select({ entry: voucherEntries, voucher: vouchers })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
        .where(and(eq(voucherEntries.id, id), eq(vouchers.companyId, req.session.currentCompanyId!)))
        .limit(1);

      if (!row) return res.status(404).json({ message: "Voucher entry not found" });
      const blockedVoucherReason = voucherMutationBlockReason(row.voucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      const role = req.session.currentRole;
      if (!role || !canEditVoucherDate(role, row.voucher.voucherDate)) {
        return res.status(403).json({ message: "Insufficient permissions to edit this voucher entry" });
      }

      const amountWasSubmitted =
        req.body.debitAmount !== undefined ||
        req.body.creditAmount !== undefined ||
        req.body.transactionDebitAmount !== undefined ||
        req.body.transactionCreditAmount !== undefined ||
        req.body.historicalExchangeRate !== undefined;

      if (!amountWasSubmitted) {
        if (req.body.narration === undefined) {
          return res.status(400).json({ message: "No supported updates supplied" });
        }
        const [updated] = await db.transaction((tx) =>
          tx.update(voucherEntries).set({ narration: req.body.narration }).where(eq(voucherEntries.id, id)).returning()
        );
        return res.json(updated);
      }

      const transactionCurrency =
        req.body.transactionCurrency || row.entry.transactionCurrency || row.voucher.currency || "USD";
      const isLegacyForeign =
        !row.entry.transactionCurrency && String(row.voucher.currency || "USD").toUpperCase() !== "USD";

      if (
        isLegacyForeign &&
        req.body.transactionDebitAmount === undefined &&
        req.body.transactionCreditAmount === undefined
      ) {
        return res.status(409).json({
          code: "HISTORICAL_CURRENCY_DATA_UNRESOLVED",
          message:
            "This legacy foreign-currency entry has no preserved transaction amount. " +
            "Run the backfill dry-run and review it before editing the amount.",
        });
      }

      // For migrated entries, legacy debitAmount/creditAmount inputs are treated as
      // transaction-currency values. New clients may submit explicit transaction fields.
      const txDebit =
        req.body.transactionDebitAmount ??
        req.body.debitAmount ??
        row.entry.transactionDebitAmount ??
        row.entry.debitAmount ??
        "0";
      const txCredit =
        req.body.transactionCreditAmount ??
        req.body.creditAmount ??
        row.entry.transactionCreditAmount ??
        row.entry.creditAmount ??
        "0";
      const historicalRate =
        req.body.historicalExchangeRate ?? row.entry.historicalExchangeRate ?? row.voucher.exchangeRate ?? null;

      const normalized = normalizeVoucherEntryAmounts({
        transactionCurrency,
        baseCurrency: "USD",
        transactionDebitAmount: txDebit,
        transactionCreditAmount: txCredit,
        historicalRate,
      });

      const [updated] = await db.transaction((tx) =>
        tx
          .update(voucherEntries)
          .set({
            transactionCurrency: normalized.transactionCurrency,
            transactionDebitAmount: normalized.transactionDebitAmount,
            transactionCreditAmount: normalized.transactionCreditAmount,
            baseDebitAmount: normalized.baseDebitAmount,
            baseCreditAmount: normalized.baseCreditAmount,
            historicalExchangeRate: normalized.historicalExchangeRate,
            rateConvention: normalized.rateConvention,
            debitAmount: normalized.debitAmount,
            creditAmount: normalized.creditAmount,
            narration: req.body.narration ?? row.entry.narration,
          })
          .where(eq(voucherEntries.id, id))
          .returning()
      );

      if (row.entry.ledgerAccountId && req.session.currentCompanyId) {
        autoReallocateLoansAccounts(req.session.currentCompanyId, [row.entry.ledgerAccountId]).catch(() => {});
      }

      return res.json(updated);
    } catch (error: unknown) {
      const status = /rate|required|cannot have both|must have either/i.test(getErrorMessage(error)) ? 400 : 500;
      return res.status(status).json({ message: getErrorMessage(error) });
    }
  });
}

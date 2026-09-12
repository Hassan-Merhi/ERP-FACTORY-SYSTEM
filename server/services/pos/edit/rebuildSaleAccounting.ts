/**
 * server/services/pos/edit/rebuildSaleAccounting.ts
 *
 * PHASE 20 structural split — moved (unchanged) from
 * server/routes/pos/posEditSaleRoutes.ts:
 *   - voucher_entries recreation (debit payment entry + credit entry/entries)
 *   - normal-ERP single revenue credit
 *   - supplier-partner split accounting (payable / deduction clearing) for edits
 *
 * Phase 15 update: entries now carry all 7 dual-currency fields via
 * normalizeVoucherEntryAmounts(). The voucher's stored currency and historical
 * exchange rate are loaded before calling this function so that the repair
 * uses the rate that was in effect at the time of the original sale, never
 * the current company rate.
 */
import type { DbTransaction } from "../../../db";
import type { VoucherEntryRow } from "./posEditSaleTypes";
import { voucherEntries } from "@shared/schema";
import { logger } from "../../../lib/logger";
import { normalizeVoucherEntryAmounts } from "../../../services/accounting/currencyAmounts";

/**
 * Normalize a single entry amount with the voucher's historical currency and rate.
 * Soft-fails to legacy storage when normalization is not possible (missing rate etc.).
 */
function normalizePosEntry(
  debitAmt: number,
  creditAmt: number,
  currency: string,
  exchangeRate: string | null | undefined
): {
  debitAmount: string;
  creditAmount: string;
  transactionCurrency: string;
  transactionDebitAmount: string;
  transactionCreditAmount: string;
  baseDebitAmount: string;
  baseCreditAmount: string;
  historicalExchangeRate: string;
  rateConvention: string;
} {
  try {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: currency || "USD",
      baseCurrency: "USD",
      transactionDebitAmount: String(Math.abs(debitAmt)),
      transactionCreditAmount: String(Math.abs(creditAmt)),
      historicalRate: exchangeRate,
    });
    return {
      debitAmount: norm.debitAmount,
      creditAmount: norm.creditAmount,
      transactionCurrency: norm.transactionCurrency,
      transactionDebitAmount: norm.transactionDebitAmount,
      transactionCreditAmount: norm.transactionCreditAmount,
      baseDebitAmount: norm.baseDebitAmount,
      baseCreditAmount: norm.baseCreditAmount,
      historicalExchangeRate: norm.historicalExchangeRate,
      rateConvention: norm.rateConvention,
    };
  } catch (e) {
    logger.warn(
      "[POS Edit] normalizeVoucherEntryAmounts failed, using legacy storage:",
      (e as unknown as { message: Parameters<typeof logger.warn>[1] })?.message
    );
    const dStr = Math.abs(debitAmt).toFixed(2);
    const cStr = Math.abs(creditAmt).toFixed(2);
    return {
      debitAmount: dStr,
      creditAmount: cStr,
      transactionCurrency: currency || "USD",
      transactionDebitAmount: dStr,
      transactionCreditAmount: cStr,
      baseDebitAmount: dStr,
      baseCreditAmount: cStr,
      historicalExchangeRate: "1.0000000000",
      rateConvention: "IDENTITY",
    };
  }
}

/**
 * Recreates voucher entries with the new total. Throws "Original voucher
 * entries not found" (matching the original) if the old debit/credit entries
 * cannot be located.
 *
 * `currency` and `exchangeRate` must be the values stored on the ORIGINAL voucher —
 * never substitute the current company rate. The caller loads them from the existing
 * voucher row (existingVoucher.currency / existingVoucher.exchangeRate).
 */
export async function rebuildSaleAccountingEntries(
  tx: DbTransaction,
  params: {
    voucherId: number;
    oldEntries: VoucherEntryRow[];
    grandTotal: number;
    paymentAccountType: unknown;
    paymentAccountId: unknown;
    isSpCompanyEdit: boolean;
    editSpPayableAccountId: number | null;
    editSpDeductionClrAccountId: number | null;
    totalQtySoldEdit: number;
    editSpDeductionPerQty: number;
    /** Voucher's stored transaction currency — loaded from the original voucher, NOT substituted. */
    currency?: string | null;
    /** Voucher's stored historical exchange rate — loaded from original voucher row. */
    exchangeRate?: string | null;
  }
): Promise<void> {
  const {
    voucherId,
    oldEntries,
    grandTotal,
    paymentAccountType,
    paymentAccountId,
    isSpCompanyEdit,
    editSpPayableAccountId,
    editSpDeductionClrAccountId,
    totalQtySoldEdit,
    editSpDeductionPerQty,
    currency,
    exchangeRate,
  } = params;

  // Get original entries for reference
  const paymentEntry = oldEntries.find((e) => parseFloat(e.debitAmount || "0") > 0);
  const revenueEntry = oldEntries.find((e) => parseFloat(e.creditAmount || "0") > 0);

  if (!paymentEntry || !revenueEntry) {
    throw new Error("Original voucher entries not found");
  }

  const voucherCurrency = currency || "USD";
  const voucherRate = exchangeRate || null;

  // Debit entry (payment account) with dual-currency fields
  const normDR = normalizePosEntry(Math.abs(grandTotal), 0, voucherCurrency, voucherRate);
  const newDebitEntry: typeof voucherEntries.$inferInsert = {
    voucherId,
    debitAmount: grandTotal >= 0 ? normDR.debitAmount : "0",
    creditAmount: grandTotal < 0 ? normDR.debitAmount : "0",
    transactionCurrency: normDR.transactionCurrency,
    transactionDebitAmount: grandTotal >= 0 ? normDR.transactionDebitAmount : "0",
    transactionCreditAmount: grandTotal < 0 ? normDR.transactionDebitAmount : "0",
    baseDebitAmount: grandTotal >= 0 ? normDR.baseDebitAmount : "0",
    baseCreditAmount: grandTotal < 0 ? normDR.baseDebitAmount : "0",
    historicalExchangeRate: normDR.historicalExchangeRate,
    rateConvention: normDR.rateConvention,
    narration: paymentEntry.narration || "",
  };

  if (paymentAccountType && paymentAccountId) {
    // User changed payment account - use new values. parseInt's coercion of
    // the raw JSON value is preserved by stringifying exactly what arrived.
    if (paymentAccountType === "cash" || paymentAccountType === "credit") {
      newDebitEntry.ledgerAccountId = parseInt(String(paymentAccountId));
      newDebitEntry.bankAccountId = null;
    } else if (paymentAccountType === "bank") {
      newDebitEntry.bankAccountId = parseInt(String(paymentAccountId));
      newDebitEntry.ledgerAccountId = null;
    }
    newDebitEntry.supplierId = null;
    newDebitEntry.employeeId = null;
    newDebitEntry.fixedAssetId = null;
  } else {
    // Preserve original payment account
    newDebitEntry.ledgerAccountId = paymentEntry.ledgerAccountId;
    newDebitEntry.bankAccountId = paymentEntry.bankAccountId;
    newDebitEntry.supplierId = paymentEntry.supplierId;
    newDebitEntry.employeeId = paymentEntry.employeeId;
    newDebitEntry.fixedAssetId = paymentEntry.fixedAssetId;
  }

  // Create new debit entry (payment account)
  await tx.insert(voucherEntries).values(newDebitEntry);

  if (!isSpCompanyEdit) {
    // Normal ERP: single credit to Sales Revenue account
    const normCR = normalizePosEntry(0, Math.abs(grandTotal), voucherCurrency, voucherRate);
    await tx.insert(voucherEntries).values({
      voucherId,
      ledgerAccountId: revenueEntry.ledgerAccountId,
      bankAccountId: revenueEntry.bankAccountId,
      supplierId: revenueEntry.supplierId,
      employeeId: revenueEntry.employeeId,
      fixedAssetId: revenueEntry.fixedAssetId,
      debitAmount: grandTotal < 0 ? normCR.creditAmount : "0",
      creditAmount: grandTotal >= 0 ? normCR.creditAmount : "0",
      transactionCurrency: normCR.transactionCurrency,
      transactionDebitAmount: grandTotal < 0 ? normCR.transactionCreditAmount : "0",
      transactionCreditAmount: grandTotal >= 0 ? normCR.transactionCreditAmount : "0",
      baseDebitAmount: grandTotal < 0 ? normCR.baseCreditAmount : "0",
      baseCreditAmount: grandTotal >= 0 ? normCR.baseCreditAmount : "0",
      historicalExchangeRate: normCR.historicalExchangeRate,
      rateConvention: normCR.rateConvention,
      narration: revenueEntry.narration || "",
    });
  } else {
    // Supplier Partner edit accounting (mirrors new-sale logic):
    //   Dr Cash / Receivable              = grandTotal  (debit entry already written above)
    //   Cr Supplier Cash Payable          = grandTotal − deductionAmount
    //   Cr Deduction Clearing (hidden)    = deductionAmount          (if deduction > 0)
    const grandTotalRounded = Number(grandTotal.toFixed(2));
    const editDeductionAmount = Number((totalQtySoldEdit * editSpDeductionPerQty).toFixed(2));
    if (editDeductionAmount > Math.abs(grandTotalRounded)) {
      throw new Error(
        `Supplier payable deduction (${editDeductionAmount}) exceeds the sale total (${grandTotalRounded}). ` +
          `Adjust the deduction per qty setting on this location.`
      );
    }
    const editSpPayableAmount = Number((grandTotalRounded - editDeductionAmount).toFixed(2));

    if (grandTotalRounded > 0) {
      if (editSpPayableAmount > 0) {
        const normSP = normalizePosEntry(0, editSpPayableAmount, voucherCurrency, voucherRate);
        await tx.insert(voucherEntries).values({
          voucherId,
          ledgerAccountId: editSpPayableAccountId!,
          debitAmount: "0",
          creditAmount: normSP.creditAmount,
          transactionCurrency: normSP.transactionCurrency,
          transactionDebitAmount: "0",
          transactionCreditAmount: normSP.transactionCreditAmount,
          baseDebitAmount: "0",
          baseCreditAmount: normSP.baseCreditAmount,
          historicalExchangeRate: normSP.historicalExchangeRate,
          rateConvention: normSP.rateConvention,
          narration: `Supplier Cash Payable`,
        });
      }
      if (editDeductionAmount > 0 && editSpDeductionClrAccountId) {
        const normDD = normalizePosEntry(0, editDeductionAmount, voucherCurrency, voucherRate);
        await tx.insert(voucherEntries).values({
          voucherId,
          ledgerAccountId: editSpDeductionClrAccountId,
          debitAmount: "0",
          creditAmount: normDD.creditAmount,
          transactionCurrency: normDD.transactionCurrency,
          transactionDebitAmount: "0",
          transactionCreditAmount: normDD.transactionCreditAmount,
          baseDebitAmount: "0",
          baseCreditAmount: normDD.baseCreditAmount,
          historicalExchangeRate: normDD.historicalExchangeRate,
          rateConvention: normDD.rateConvention,
          narration: `Supplier Payable Deduction (${totalQtySoldEdit} qty × ${editSpDeductionPerQty})`,
        });
      }
    } else if (grandTotalRounded < 0) {
      if (editSpPayableAmount < 0) {
        const normSPR = normalizePosEntry(Math.abs(editSpPayableAmount), 0, voucherCurrency, voucherRate);
        await tx.insert(voucherEntries).values({
          voucherId,
          ledgerAccountId: editSpPayableAccountId!,
          debitAmount: normSPR.debitAmount,
          creditAmount: "0",
          transactionCurrency: normSPR.transactionCurrency,
          transactionDebitAmount: normSPR.transactionDebitAmount,
          transactionCreditAmount: "0",
          baseDebitAmount: normSPR.baseDebitAmount,
          baseCreditAmount: "0",
          historicalExchangeRate: normSPR.historicalExchangeRate,
          rateConvention: normSPR.rateConvention,
          narration: `Supplier Cash Payable reversal`,
        });
      }
      if (editDeductionAmount > 0 && editSpDeductionClrAccountId) {
        const normDDR = normalizePosEntry(editDeductionAmount, 0, voucherCurrency, voucherRate);
        await tx.insert(voucherEntries).values({
          voucherId,
          ledgerAccountId: editSpDeductionClrAccountId,
          debitAmount: normDDR.debitAmount,
          creditAmount: "0",
          transactionCurrency: normDDR.transactionCurrency,
          transactionDebitAmount: normDDR.transactionDebitAmount,
          transactionCreditAmount: "0",
          baseDebitAmount: normDDR.baseDebitAmount,
          baseCreditAmount: "0",
          historicalExchangeRate: normDDR.historicalExchangeRate,
          rateConvention: normDDR.rateConvention,
          narration: `Supplier Payable Deduction reversal`,
        });
      }
    }
  }
}

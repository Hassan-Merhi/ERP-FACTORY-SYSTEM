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
import { toMoney } from "../../../lib/money";
import { buildErpVoucherEntries } from "../../accounting/erpVoucherPosting";
import { posSaleLines, type PosLineTarget } from "../saleAccountingLines";

/**
 * Recreates voucher entries with the new total. Throws "Original voucher
 * entries not found" (matching the original) if the old debit/credit entries
 * cannot be located.
 *
 * Phase 22 (B): the lines are built by `posSaleLines` (the sale create's
 * builder) in exact cents and normalized by the engine's line builder; the old
 * float normalization with its silent "legacy storage" fallback is gone (a CFA
 * sale without a rate is refused, never stored as USD). The caller checks the
 * correction policy (open period) and audits the edit in the same transaction.
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
  const { voucherId, oldEntries, grandTotal, paymentAccountType, paymentAccountId } = params;

  // Get original entries for reference
  const paymentEntry = oldEntries.find((e) => toMoney(e.debitAmount).gt(0));
  const revenueEntry = oldEntries.find((e) => toMoney(e.creditAmount).gt(0));

  if (!paymentEntry || !revenueEntry) {
    throw new Error("Original voucher entries not found");
  }

  let payment: PosLineTarget;
  if (paymentAccountType && paymentAccountId) {
    // User changed payment account - use new values. parseInt's coercion of
    // the raw JSON value is preserved by stringifying exactly what arrived.
    // Wave 16 (B): "ledger" is a ledger account like cash/credit; any other
    // type used to leave the payment line with no account at all (the
    // line-target guard now refuses that line).
    if (paymentAccountType === "cash" || paymentAccountType === "credit" || paymentAccountType === "ledger") {
      payment = { ledgerAccountId: parseInt(String(paymentAccountId)) };
    } else if (paymentAccountType === "bank") {
      payment = { bankAccountId: parseInt(String(paymentAccountId)) };
    } else {
      throw new Error("Unsupported payment account type");
    }
  } else {
    // Preserve original payment account
    payment = {
      ledgerAccountId: paymentEntry.ledgerAccountId,
      bankAccountId: paymentEntry.bankAccountId,
      supplierId: paymentEntry.supplierId,
      employeeId: paymentEntry.employeeId,
      fixedAssetId: paymentEntry.fixedAssetId,
      customerId: paymentEntry.customerId,
    };
  }

  const lines = posSaleLines({
    grandTotal,
    payment,
    paymentNarration: paymentEntry.narration || "",
    revenue: params.isSpCompanyEdit
      ? null
      : {
          target: {
            ledgerAccountId: revenueEntry.ledgerAccountId,
            bankAccountId: revenueEntry.bankAccountId,
            supplierId: revenueEntry.supplierId,
            employeeId: revenueEntry.employeeId,
            fixedAssetId: revenueEntry.fixedAssetId,
          },
          narration: revenueEntry.narration || "",
        },
    supplierPartner: params.isSpCompanyEdit
      ? {
          payableAccountId: params.editSpPayableAccountId!,
          deductionClearingAccountId: params.editSpDeductionClrAccountId,
          quantitySold: params.totalQtySoldEdit,
          deductionPerQty: params.editSpDeductionPerQty,
          payableNarration: "Supplier Cash Payable",
          deductionNarration: `Supplier Payable Deduction (${params.totalQtySoldEdit} qty × ${params.editSpDeductionPerQty})`,
        }
      : null,
    currency: params.currency || "USD",
    exchangeRate: params.exchangeRate || null,
  });

  const entries = buildErpVoucherEntries(lines);
  if (entries.length > 0) {
    await tx.insert(voucherEntries).values(entries.map((entry) => ({ voucherId, ...entry })));
  }
}

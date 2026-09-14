/**
 * Form-state and API-payload mapping for the voucher edit dialog.
 *
 * Extracted from VoucherEditDialog.tsx during the P1 god-file split. These
 * pure functions own the edit round-trip contract: which multi-currency
 * fields survive the round-trip, how the PUT payload is assembled, how the
 * debits/credits balance is judged, and how Consumption/Production narration
 * strings are re-parsed for display.
 */

import { format } from "date-fns";
import type { VoucherEntry, VoucherFormData } from "./voucherEditSchema";

/**
 * Structural subset of a stored voucher (the full @shared/schema Voucher row
 * satisfies it) as consumed by the edit dialog — keeps this module testable
 * without importing the database schema.
 */
export interface StoredVoucherForEdit {
  voucherNumber: string;
  voucherType: string;
  voucherDate: string | Date;
  description?: string | null;
  optional?: boolean | null;
  entries?: VoucherEntry[];
}

/** Empty entry used both as the form default and when the stored voucher has none. */
export const emptyVoucherEntry = {
  ledgerAccountId: null,
  bankAccountId: null,
  fixedAssetId: null,
  supplierId: null,
  employeeId: null,
  debitAmount: "0",
  creditAmount: "0",
  narration: "",
};

/**
 * Maps a stored voucher (with its entries) onto the edit form's default
 * values. Multi-currency fields are preserved so they survive the round-trip.
 */
export function voucherDataToFormValues(voucherData: StoredVoucherForEdit): VoucherFormData {
  const voucherDate = new Date(voucherData.voucherDate);
  return {
    voucherNumber: voucherData.voucherNumber || "",
    voucherType: voucherData.voucherType || "Journal",
    voucherDate,
    description: voucherData.description || "",
    optional: voucherData.optional || false,
    entries:
      voucherData.entries && voucherData.entries.length > 0
        ? voucherData.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId || null,
            bankAccountId: entry.bankAccountId || null,
            fixedAssetId: entry.fixedAssetId || null,
            supplierId: entry.supplierId || null,
            employeeId: entry.employeeId || null,
            debitAmount: entry.debitAmount || "0",
            creditAmount: entry.creditAmount || "0",
            narration: entry.narration || "",
            // Preserve historical multi-currency fields so they survive the round-trip
            transactionCurrency: entry.transactionCurrency ?? null,
            transactionDebitAmount: entry.transactionDebitAmount ?? null,
            transactionCreditAmount: entry.transactionCreditAmount ?? null,
            historicalExchangeRate: entry.historicalExchangeRate ?? null,
            rateConvention: entry.rateConvention ?? null,
          }))
        : [emptyVoucherEntry],
  };
}

/**
 * Assembles the PUT /api/vouchers/:id/with-entries body from form data.
 * Multi-currency fields are re-submitted so the server can keep
 * baseDebitAmount / baseCreditAmount consistent after an edit.
 */
export function voucherFormToPayload(data: VoucherFormData): {
  voucher: {
    voucherType: string;
    voucherDate: string;
    description: string;
    optional: boolean;
  };
  entries: Array<{
    ledgerAccountId: number | null;
    bankAccountId: number | null;
    fixedAssetId: number | null;
    supplierId: number | null;
    employeeId: number | null;
    debitAmount: string;
    creditAmount: string;
    narration: string;
    transactionCurrency?: string | null;
    historicalExchangeRate?: string | null;
    rateConvention?: string | null;
  }>;
} {
  const voucherPayload = {
    voucherType: data.voucherType,
    voucherDate: format(data.voucherDate, "yyyy-MM-dd"),
    description: data.description,
    optional: data.optional,
  };

  const entriesPayload = data.entries.map((entry) => ({
    ledgerAccountId: entry.ledgerAccountId,
    bankAccountId: entry.bankAccountId,
    fixedAssetId: entry.fixedAssetId,
    supplierId: entry.supplierId,
    employeeId: entry.employeeId,
    debitAmount: entry.debitAmount,
    creditAmount: entry.creditAmount,
    narration: entry.narration,
    // Preserve historical multi-currency fields so the server can keep
    // baseDebitAmount / baseCreditAmount consistent after an edit.
    transactionCurrency: entry.transactionCurrency ?? undefined,
    historicalExchangeRate: entry.historicalExchangeRate ?? undefined,
    rateConvention: entry.rateConvention ?? undefined,
  }));

  return { voucher: voucherPayload, entries: entriesPayload };
}

/** Summed debits/credits and the balance check (0.01 tolerance, as in the UI). */
export function computeEntryTotals(entries: VoucherFormData["entries"]): {
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
} {
  const totalDebits = entries.reduce((sum, entry) => sum + parseFloat(entry.debitAmount || "0"), 0);
  const totalCredits = entries.reduce((sum, entry) => sum + parseFloat(entry.creditAmount || "0"), 0);
  return { totalDebits, totalCredits, isBalanced: Math.abs(totalDebits - totalCredits) < 0.01 };
}

export interface ParsedConsumptionNarration {
  qty: number;
  itemName: string;
  rate: number;
}

/**
 * Parses "Consumption of -1.000 x ITEM NAME @ $98.62" style narration into
 * qty (abs), item name, and rate. Returns null when the pattern does not
 * match.
 */
export function parseConsumptionNarration(narration: string): ParsedConsumptionNarration | null {
  const match = narration.match(/of\s+([-\d.]+)\s+x\s+(.+?)\s+@\s+\$?([\d.]+)/);
  if (!match) return null;
  return {
    qty: Math.abs(parseFloat(match[1])),
    itemName: match[2],
    rate: parseFloat(match[3]),
  };
}

/**
 * Qty-only variant used by the totals row: matches "of -1.000 x" even when
 * the "@ rate" tail is missing. Returns null when there is no qty token.
 */
export function parseConsumptionNarrationQty(narration: string): number | null {
  const match = narration.match(/of\s+([-\d.]+)\s+x/);
  return match ? Math.abs(parseFloat(match[1])) : null;
}

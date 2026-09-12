/**
 * Pure selectors for the Daybook voucher-balance lookups.
 *
 * Extracted from Daybook.tsx during the god-file split so the page stays
 * under the repository size limit. These pick which account balance to fetch
 * for the voucher details dialog; the fetching itself stays in the page.
 */
import type { ViewVoucherEntry, Voucher } from "./types";

export function selectCashAccountId(selectedVoucher: Voucher | null, viewVoucherEntries: ViewVoucherEntry[]) {
  if (!selectedVoucher) return null;
  const vt = selectedVoucher.voucherType;

  // Sales / POS — cash-in account is the debit non-stock entry
  if (vt === "Sales" || vt === "POS") {
    const e = viewVoucherEntries.find((e) => !e.isStockItem && !e.stockItemId && parseFloat(e.debitAmount || "0") > 0);
    return e?.ledgerAccountId || e?.bankAccountId || null;
  }

  // Payment / Credit Note / Debit Note — source is the credit side (money going out)
  if (vt === "Payment" || vt === "Credit Note" || vt === "Debit Note") {
    const e = viewVoucherEntries.find((e) => parseFloat(e.creditAmount || "0") > 0);
    return e?.ledgerAccountId || e?.bankAccountId || null;
  }

  // Receipt — source is the debit side (money coming in)
  if (vt === "Receipt") {
    const e = viewVoucherEntries.find((e) => parseFloat(e.debitAmount || "0") > 0);
    return e?.ledgerAccountId || e?.bankAccountId || null;
  }

  // Journal / Transfer / Stock Transfer / Purchase and anything else —
  // use the first non-stock entry that has a cash or bank account
  const e = viewVoucherEntries.find((e) => !e.isStockItem && !e.stockItemId && (e.ledgerAccountId || e.bankAccountId));
  return e?.ledgerAccountId || e?.bankAccountId || null;
}

export function selectBalanceDisplayEntries(
  voucherType: string,
  viewVoucherEntries: ViewVoucherEntry[]
): ViewVoucherEntry[] {
  // Which entries to show balances for per voucher type
  return viewVoucherEntries.filter((e) => {
    if (voucherType === "Payment") return parseFloat(e.debitAmount || "0") > 0;
    if (voucherType === "Receipt") return parseFloat(e.creditAmount || "0") > 0;
    if (voucherType === "Sales" || voucherType === "POS") return !e.isStockItem && !e.stockItemId;
    // Journal, Credit Note, Debit Note, Purchase, Transfer, Stock Transfer, and all
    // other types — show balance for every entry that has an account reference
    return !!(
      e.ledgerAccountId ||
      e.bankAccountId ||
      e.customerId ||
      e.employeeId ||
      e.supplierId ||
      e.factorySupplierId
    );
  });
}

export function entryBalanceUrl(entry: ViewVoucherEntry): string | null {
  if (entry.ledgerAccountId) return `/api/accounts/ledger/${entry.ledgerAccountId}/balance`;
  if (entry.bankAccountId) return `/api/accounts/ledger/${entry.bankAccountId}/balance`;
  if (entry.customerId) return `/api/customers/${entry.customerId}/balance`;
  if (entry.employeeId) return `/api/employees/${entry.employeeId}/balance`;
  if (entry.supplierId) return `/api/suppliers/${entry.supplierId}/balance`;
  if (entry.factorySupplierId) return `/api/factory/suppliers/${entry.factorySupplierId}/balance`;
  return null;
}

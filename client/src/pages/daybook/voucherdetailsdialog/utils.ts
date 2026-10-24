/**
 * Pure helpers and lookup tables for the VoucherDetailsDialog page.
 *
 * Extracted from VoucherDetailsDialog.tsx during the Phase 4 god-file split.
 */
import { ViewVoucherEntry, Employee, LedgerAccount, BankAccount } from ".././types";

/** Voucher types whose entries are stock lines rather than ledger debit/credit pairs. */
export const STOCK_ENTRY_VOUCHER_TYPES = [
  "Consumption",
  "Production",
  "Mixed",
  "Stock Transfer",
  "StockTransfer",
  "Transfer",
];

/** Voucher types rendered as a single "Amount" column instead of debit/credit. */
export const SINGLE_AMOUNT_VOUCHER_TYPES = ["Payment", "Receipt"];

export function isStockEntryVoucherType(voucherType: string | undefined): boolean {
  return STOCK_ENTRY_VOUCHER_TYPES.includes(voucherType ?? "");
}

export function isSingleAmountVoucherType(voucherType: string | undefined): boolean {
  return SINGLE_AMOUNT_VOUCHER_TYPES.includes(voucherType ?? "");
}

/**
 * Builds the entry display-name resolver. The lookup order is unchanged from
 * the original dialog: server-provided account name first, then employee,
 * ledger account and bank account references.
 */
export function createEntryNameResolver(
  employees: Employee[],
  ledgerAccounts: LedgerAccount[],
  bankAccounts: BankAccount[]
): (entry: ViewVoucherEntry) => string {
  return function resolveEntryName(entry: ViewVoucherEntry): string {
    if (entry.accountName && entry.accountName !== "Unknown Account") return entry.accountName;
    if (entry.employeeId) {
      const emp = employees.find((e) => e.id === entry.employeeId);
      if (emp) return `${emp.firstName} ${emp.lastName}`;
    }
    if (entry.ledgerAccountId) {
      const acct = ledgerAccounts.find((a) => a.id === entry.ledgerAccountId);
      if (acct) return acct.name;
    }
    if (entry.bankAccountId) {
      const bank = bankAccounts.find((b) => b.id === entry.bankAccountId);
      if (bank) return bank.name;
    }
    return entry.accountName || "Unknown Account";
  };
}

export /**
 * Returns a formatted string of the original transaction-currency amount
 * when it differs from USD (i.e. for CFA vouchers).  Returns null for USD
 * or when multi-currency fields are not populated yet (pre-backfill rows).
 */
function txCurrencyLabel(entry: ViewVoucherEntry): string | null {
  if (!entry.transactionCurrency || entry.transactionCurrency === "USD") return null;
  const debit = parseFloat(entry.transactionDebitAmount || "0");
  const credit = parseFloat(entry.transactionCreditAmount || "0");
  const amt = Math.max(debit, credit);
  if (!amt) return null;
  if (entry.transactionCurrency === "CFA") {
    return `CFA ${Math.round(amt).toLocaleString()}`;
  }
  if (entry.transactionCurrency === "ZMW") {
    return `K${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${entry.transactionCurrency} ${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

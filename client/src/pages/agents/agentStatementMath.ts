/**
 * Pure statement calculations for the Agent Ledger page.
 *
 * Extracted from pages/Agents.tsx; every function reproduces the original
 * inline calculation exactly (grouping, opening/running/closing balances,
 * Dr/Cr side labelling) so the rendered statement is unchanged.
 */

export interface Account {
  id: string;
  accountId: number;
  type: string;
  code: string;
  name: string;
  balance: number;
  balanceSide: string | null;
  openingBalance?: number;
  openingBalanceSide?: string | null;
  active: boolean;
}

export interface Transaction {
  entryId: number;
  voucherId: number;
  debitAmount: string;
  creditAmount: string;
  narration: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string;
}

export interface GroupedVoucher {
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string;
  narration: string;
  totalDebit: number;
  totalCredit: number;
  runningBalance?: number;
}

export function parseBalance(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Aggregates transaction rows per voucher and sorts by date, then number. */
export function groupTransactions(transactions: Transaction[]): GroupedVoucher[] {
  const map = new Map<number, GroupedVoucher>();
  transactions.forEach((txn) => {
    const vid = Number(txn.voucherId);
    const debit = parseBalance(txn.debitAmount);
    const credit = parseBalance(txn.creditAmount);
    const existing = map.get(vid);
    if (existing) {
      existing.totalDebit += debit;
      existing.totalCredit += credit;
      if (!existing.narration && txn.narration) existing.narration = txn.narration;
    } else {
      map.set(vid, {
        voucherId: vid,
        voucherNumber: txn.voucherNumber,
        voucherType: txn.voucherType,
        voucherDate: txn.voucherDate,
        voucherDescription: txn.voucherDescription,
        narration: txn.voucherDescription || txn.narration || "",
        totalDebit: debit,
        totalCredit: credit,
      });
    }
  });
  return Array.from(map.values()).sort((a, b) => {
    const dc = new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime();
    return dc !== 0 ? dc : a.voucherNumber.localeCompare(b.voucherNumber);
  });
}

/**
 * Opening balance: the pre-period balance wins when a from-date is set;
 * otherwise the account opening balance with the supplier/cr-side sign rule.
 */
export function computeOpeningBalance(
  account: Account | null,
  hasFromDate: boolean,
  prePeriodData: { balance: number } | undefined
): number {
  if (hasFromDate && prePeriodData !== undefined) return prePeriodData.balance;
  const raw = parseBalance(account?.openingBalance ?? 0);
  if (account?.type === "supplier") return raw;
  return account?.openingBalanceSide === "Cr" ? -raw : raw;
}

/** Running balances: supplier accounts accumulate credit-debit, others debit-credit. */
export function computeRunningBalances(
  groupedVouchers: GroupedVoucher[],
  openingBalance: number,
  accountType: string | undefined
): GroupedVoucher[] {
  let running = openingBalance;
  return groupedVouchers.map((v) => {
    if (accountType === "supplier") {
      running += v.totalCredit - v.totalDebit;
    } else {
      running += v.totalDebit - v.totalCredit;
    }
    return { ...v, runningBalance: running };
  });
}

export function computeClosingBalance(vouchersWithBalance: GroupedVoucher[], openingBalance: number): number {
  return vouchersWithBalance.length > 0
    ? (vouchersWithBalance[vouchersWithBalance.length - 1].runningBalance ?? openingBalance)
    : openingBalance;
}

export function computePeriodTotals(vouchersWithBalance: GroupedVoucher[]): {
  periodDebit: number;
  periodCredit: number;
} {
  return {
    periodDebit: vouchersWithBalance.reduce((s, v) => s + v.totalDebit, 0),
    periodCredit: vouchersWithBalance.reduce((s, v) => s + v.totalCredit, 0),
  };
}

/** Dr/Cr side label shown next to opening, running, and closing balances. */
export function balanceSideLabel(balance: number, accountType: string | undefined): "Dr" | "Cr" {
  return balance >= 0 ? (accountType === "supplier" ? "Cr" : "Dr") : accountType === "supplier" ? "Dr" : "Cr";
}

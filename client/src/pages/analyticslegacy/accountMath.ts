import type { Account } from "./types";

/**
 * Balance arithmetic for the Analytics account tables.
 *
 * These were closures inside the Analytics component but never read any of its
 * state - each one is a function of its arguments alone. Out here they are unit
 * testable, which matters more than the line count: the hierarchical
 * deduplication in calculateTotal is subtle and was previously only exercised by
 * rendering the page.
 */

/**
 * Only the Assets panel of legacy Analytics hides these internal control rows.
 * Keep them in the account API and general ledger so vouchers, stock costing,
 * statements and other reports can still reconcile against the posted books.
 */
export function isVisibleAnalyticsAssetAccount(account: Account): boolean {
  if (account.type === "bank" || account.type === "fixedAsset") return true;
  if (account.type !== "ledger" || account.accountType !== "Asset") return false;

  const code = (account.code || "").trim().toUpperCase();
  const subType = (account.subType || "").trim().toLowerCase();
  const name = (account.name || "").trim().replace(/\s+/g, " ").toLowerCase();

  return (
    code !== "INVENTORY" &&
    code !== "SP-PROFIT-ADJ-SUSPENSE" &&
    subType !== "sp_profit_correction_suspense" &&
    name !== "inventory" &&
    name !== "sp profit correction suspense"
  );
}

/** Balances arrive as either a number or a numeric string, depending on the endpoint. */
export function parseBalance(balance: number | string): number {
  if (typeof balance === "string") {
    return parseFloat(balance) || 0;
  }
  return balance || 0;
}

/** Cr is positive, Dr is negative. */
export function signedBalance(acc: Account): number {
  return acc.balanceSide === "Cr" ? parseBalance(acc.balance) : -parseBalance(acc.balance);
}

/** Cash is an asset: a debit adds cash and a credit reduces it. */
export function cashSignedBalance(acc: Account): number {
  return -signedBalance(acc);
}

/**
 * Partition a flat account list into roots and a parentId -> children map.
 * An account counts as a root when its parent is absent from the same list,
 * so a filtered view never renders children without their parent.
 */
export function groupAccountsByParent(accountList: Account[]): {
  parentAccounts: Account[];
  accountMap: Map<number, Account[]>;
} {
  const accountIdsInList = new Set(accountList.map((acc) => acc.accountId));
  const parentAccounts: Account[] = [];
  const childAccounts: Account[] = [];

  accountList.forEach((acc) => {
    if (!acc.parentId || !accountIdsInList.has(acc.parentId)) {
      parentAccounts.push(acc);
    } else {
      childAccounts.push(acc);
    }
  });

  const accountMap = new Map<number, Account[]>();
  childAccounts.forEach((child) => {
    const parentId = child.parentId!;
    if (!accountMap.has(parentId)) {
      accountMap.set(parentId, []);
    }
    accountMap.get(parentId)!.push(child);
  });

  return { parentAccounts, accountMap };
}

export function calculateChildrenTotal(parentAccountId: number, accountMap: Map<number, Account[]>): number {
  const children = accountMap.get(parentAccountId) || [];
  return children.reduce((sum, acc) => sum + parseBalance(acc.balance), 0);
}

/**
 * Signed total with hierarchical deduplication: a parent that has children in
 * the same list contributes its children's sum rather than its own balance, and
 * those children are then not counted again on their own.
 */
export function calculateTotal(accountList: Account[]): number {
  const accountIds = new Set(accountList.map((acc) => acc.accountId));
  const parentAccountIds = new Set(accountList.filter((acc) => acc.parentId).map((acc) => acc.parentId!));

  let total = 0;
  accountList.forEach((acc) => {
    const hasChildrenInList = parentAccountIds.has(acc.accountId);
    const isChildOfParentInList = acc.parentId && accountIds.has(acc.parentId);

    if (hasChildrenInList) {
      const children = accountList.filter((child) => child.parentId === acc.accountId);
      total += children.reduce((sum, child) => sum + signedBalance(child), 0);
    } else if (!isChildOfParentInList) {
      total += signedBalance(acc);
    }
  });

  return total;
}

/** Net cash debit-minus-credit, using the same parent/child deduplication as calculateTotal. */
export function calculateCashTotal(accountList: Account[]): number {
  return -calculateTotal(accountList);
}

/**
 * Same deduplication as calculateTotal but over displayed (absolute) balances.
 * Used for the Cash, Loans/Banks, Assets and Liabilities sections so the footer
 * total always equals the sum of the rows shown above it.
 */
export function calculateAbsoluteTotal(accountList: Account[]): number {
  const accountIds = new Set(accountList.map((acc) => acc.accountId));
  const parentAccountIds = new Set(accountList.filter((acc) => acc.parentId).map((acc) => acc.parentId!));
  let total = 0;
  accountList.forEach((acc) => {
    const hasChildrenInList = parentAccountIds.has(acc.accountId);
    const isChildOfParentInList = acc.parentId && accountIds.has(acc.parentId);
    if (hasChildrenInList) {
      const children = accountList.filter((child) => child.parentId === acc.accountId);
      total += children.reduce((sum, child) => sum + parseBalance(child.balance), 0);
    } else if (!isChildOfParentInList) {
      total += parseBalance(acc.balance);
    }
  });
  return total;
}

/** P&L sections are flat, so no deduplication - just a signed sum. */
export function calculatePLTotal(accountList: Account[]): number {
  return accountList.reduce((sum, acc) => {
    const balance = parseBalance(acc.balance);
    const amount = acc.balanceSide === "Cr" ? balance : -balance;
    return sum + amount;
  }, 0);
}

/** Absolute value, currency-formatted; whole amounts drop the decimals. */
export function formatCurrency(value: number): string {
  const isWhole = Math.abs(value) % 1 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
}

/** As formatCurrency, but built from toLocaleString so the $ is never spaced. */
export function formatSmartCurrency(value: number): string {
  const absValue = Math.abs(value);
  const isWholeNumber = absValue % 1 === 0;
  if (isWholeNumber) {
    return "$" + absValue.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return "$" + absValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Preserve the sign of a credit/negative balance in cash analytics. */
export function formatSignedSmartCurrency(value: number): string {
  return value < 0 ? `-${formatSmartCurrency(value)}` : formatSmartCurrency(value);
}

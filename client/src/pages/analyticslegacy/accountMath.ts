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

/**
 * The accounts API returns a magnitude plus a Dr/Cr side. All Analytics
 * account-balance panels display net Dr minus Cr, irrespective of account type.
 * Use the sign of the raw value only when the API has no side at all.
 */
export function debitSignedBalance(acc: Account): number {
  const balance = parseBalance(acc.balance);
  if (acc.balanceSide?.toUpperCase() === "CR") return -Math.abs(balance);
  if (acc.balanceSide?.toUpperCase() === "DR") return Math.abs(balance);
  return balance;
}

/** Compatibility alias for the Cash panel's previously added helper. */
export function cashSignedBalance(acc: Account): number {
  return debitSignedBalance(acc);
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
  // Only ledger accounts can own ledger children. Bank/fixed-asset IDs live
  // in different tables and may happen to equal a ledger account's ID.
  const ledgerIds = new Set(accountList.filter((acc) => acc.type === "ledger").map((acc) => acc.accountId));
  const parentAccounts: Account[] = [];
  const childAccounts: Account[] = [];

  accountList.forEach((acc) => {
    if (acc.type !== "ledger" || !acc.parentId || acc.parentId === acc.accountId || !ledgerIds.has(acc.parentId)) {
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

/**
 * The visible balance of a ledger group is the net of its descendants.
 * Its stored aggregate is not counted alongside those descendants.
 * Supports more than two levels without double counting or infinite cycles.
 */
export function accountDisplayBalance(
  account: Account,
  accountMap: Map<number, Account[]>,
  visited: Set<number> = new Set()
): number {
  if (account.type !== "ledger" || visited.has(account.accountId)) return debitSignedBalance(account);
  const children = accountMap.get(account.accountId) ?? [];
  if (children.length === 0) return debitSignedBalance(account);

  const path = new Set(visited);
  path.add(account.accountId);
  return children.reduce((total, child) => total + (path.has(child.accountId) ? 0 : accountDisplayBalance(child, accountMap, path)), 0);
}

/** Header/footer total equals the sum of the root rows and includes each ledger leaf once. */
export function calculateNetAccountTotal(accountList: Account[]): number {
  const { parentAccounts, accountMap } = groupAccountsByParent(accountList);
  return parentAccounts.reduce((sum, account) => sum + accountDisplayBalance(account, accountMap), 0);
}

/** Retained Cash API name; all account-balance panels now use the same sign rules. */
export function calculateCashTotal(accountList: Account[]): number {
  return calculateNetAccountTotal(accountList);
}

/**
 * Same deduplication as calculateTotal but over displayed (absolute) balances.
 * Kept for compatibility with legacy magnitude-only reports; Analytics account
 * panels now use calculateNetAccountTotal and never discard Dr/Cr direction.
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

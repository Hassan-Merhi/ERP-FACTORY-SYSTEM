import type { Account, NetProfitAccount } from "./types";
import { accountDisplayBalance, debitSignedBalance, groupAccountsByParent } from "./accountMath";

/** One account row as an Analytics account table shows it. */
export interface AnalyticsExportRow {
  name: string;
  /** 0 for a top-level row, 1 for a child, and so on. */
  depth: number;
  balance: number;
}

function keepsZeroBalanceChildren(parentName: string): boolean {
  const normalized = parentName.trim().toLowerCase();
  return normalized === "salary expense - workers" || normalized === "bonus expense - workers";
}

/**
 * Rows of an account-balance panel (Assets, Liabilities, Cash, Loans / Banks)
 * in screen order: the same visibility, roll-up and expanded groups as
 * `renderHierarchicalAccounts`.
 */
export function hierarchicalAccountRows(accountList: Account[], expanded: ReadonlySet<number>): AnalyticsExportRow[] {
  const { parentAccounts, accountMap } = groupAccountsByParent(accountList);
  const hasVisibleBalance = (account: Account, visited: Set<number> = new Set()): boolean => {
    if (visited.has(account.accountId)) return false;
    const children = account.type === "ledger" ? (accountMap.get(account.accountId) ?? []) : [];
    if (children.length === 0) return debitSignedBalance(account) !== 0;
    const path = new Set(visited);
    path.add(account.accountId);
    return children.some((child) => hasVisibleBalance(child, path));
  };
  const rows: AnalyticsExportRow[] = [];
  const visit = (account: Account, depth: number, ancestors: Set<number>) => {
    if (ancestors.has(account.accountId) && account.type === "ledger") return;
    if (!hasVisibleBalance(account)) return;
    const children = account.type === "ledger" ? (accountMap.get(account.accountId) ?? []) : [];
    rows.push({ name: account.name, depth, balance: accountDisplayBalance(account, accountMap) });
    if (children.length === 0 || !expanded.has(account.accountId)) return;
    const path = new Set(ancestors);
    if (account.type === "ledger") path.add(account.accountId);
    children.filter((child) => hasVisibleBalance(child)).forEach((child) => visit(child, depth + 1, path));
  };
  parentAccounts.forEach((account) => visit(account, 0, new Set()));
  return rows;
}

/**
 * Rows of a period expense panel in screen order: the same visible accounts,
 * group roll-ups and expanded groups as `renderNetProfitAccountsList`.
 */
export function netProfitAccountRows(accts: NetProfitAccount[], expanded: ReadonlySet<number>): AnalyticsExportRow[] {
  const payrollParentIds = new Set(accts.filter((a) => keepsZeroBalanceChildren(a.name)).map((a) => a.id));
  const activityAccounts = accts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);
  const payrollChildren = accts.filter((a) => a.parentId && payrollParentIds.has(a.parentId));
  const visibleById = new Map<number, NetProfitAccount>();
  [...activityAccounts, ...payrollChildren].forEach((account) => visibleById.set(account.id, account));
  const visibleAccounts = [...visibleById.values()];
  const visibleParentIds = new Set(visibleAccounts.filter((a) => a.parentId).map((a) => a.parentId!));
  const groupParents = accts.filter(
    (a) => visibleParentIds.has(a.id) && Number(a.debit) === 0 && Number(a.credit) === 0
  );
  const allVisibleById = new Map<number, NetProfitAccount>();
  [...visibleAccounts, ...groupParents].forEach((account) => allVisibleById.set(account.id, account));
  const allVisible = [...allVisibleById.values()];
  const acctIds = new Set(allVisible.map((a) => a.id));
  const childMap = new Map<number, NetProfitAccount[]>();
  allVisible
    .filter((a) => a.parentId && acctIds.has(a.parentId))
    .forEach((child) => {
      if (!childMap.has(child.parentId!)) childMap.set(child.parentId!, []);
      childMap.get(child.parentId!)!.push(child);
    });
  return allVisible
    .filter((a) => !a.parentId || !acctIds.has(a.parentId))
    .flatMap((acc) => {
      const kids = childMap.get(acc.id) || [];
      const balance = Number(acc.balance) + kids.reduce((sum, child) => sum + Number(child.balance), 0);
      const row: AnalyticsExportRow = { name: acc.name, depth: 0, balance };
      if (kids.length === 0 || !expanded.has(acc.id)) return [row];
      return [row, ...kids.map((child) => ({ name: child.name, depth: 1, balance: Number(child.balance) }))];
    });
}

import { Fragment } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, ChevronRight, ChevronDown } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { drCrClass } from "@/lib/formatNumber";

import type { Account, NetProfitAccount } from "./types";
import {
  calculateChildrenTotal,
  calculatePLTotal,
  formatCurrency,
  formatSmartCurrency,
  groupAccountsByParent,
  parseBalance,
} from "./accountMath";

/**
 * State, queries and derived values for the legacy Analytics page.
 *
 * Extracted so the page is a layout shell and each section panel is its own
 * file. Panels take this hook's return as one prop typed via ReturnType, which
 * avoids both a hand-maintained props interface that drifts and the
 * `props: any` shortcut that would raise the type-escape ceiling.
 */

/**
 * Payroll expense groups are historical ledgers, not just current-period rows.
 * Workers can leave after being paid, but their account still needs to remain
 * visible under the group so the expense history is traceable.
 */
function keepsZeroBalanceChildren(parentName: string): boolean {
  const normalized = parentName.trim().toLowerCase();
  return normalized === "salary expense - workers" || normalized === "bonus expense - workers";
}

/**
 * The three account-table renderers used by the Analytics panels.
 *
 * Split out of useAnalyticsLegacy because that hook reached 902 lines — two over
 * the repository limit — and a split that creates a new god file has not
 * actually split anything.
 */
export function useAccountRenderers(deps: {
  accountsLoading: boolean;
  appMode: string;
  expandedAccounts: Set<number>;
  navigate: (to: string) => void;
  goToStatement: (accountId: number, customerId?: number, accountType?: string) => void;
  toggleAccount: (id: number) => void;
  totalExpenses: number;
  totalIncome: number;
}) {
  const { accountsLoading, expandedAccounts, goToStatement, toggleAccount } = deps;
  const renderNetProfitAccountsList = (accts: NetProfitAccount[]) => {
    const payrollParentIds = new Set(accts.filter((a) => keepsZeroBalanceChildren(a.name)).map((a) => a.id));
    const activityAccounts = accts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);
    const payrollChildren = accts.filter((a) => a.parentId && payrollParentIds.has(a.parentId));
    const visibleById = new Map<number, NetProfitAccount>();
    [...activityAccounts, ...payrollChildren].forEach((account) => visibleById.set(account.id, account));
    const visibleAccounts = [...visibleById.values()];

    if (visibleAccounts.length === 0)
      return (
        <TableRow>
          <TableCell colSpan={2} className="text-center text-muted-foreground py-8">
            No transactions in this period
          </TableCell>
        </TableRow>
      );

    // Include group-parent accounts (zero-balance containers) when they have visible children.
    const visibleParentIds = new Set(visibleAccounts.filter((a) => a.parentId).map((a) => a.parentId!));
    const groupParents = accts.filter(
      (a) => visibleParentIds.has(a.id) && Number(a.debit) === 0 && Number(a.credit) === 0
    );
    const allVisibleById = new Map<number, NetProfitAccount>();
    [...visibleAccounts, ...groupParents].forEach((account) => allVisibleById.set(account.id, account));
    const allVisible = [...allVisibleById.values()];

    const acctIds = new Set(allVisible.map((a) => a.id));
    const parents = allVisible.filter((a) => !a.parentId || !acctIds.has(a.parentId));
    const childrenList = allVisible.filter((a) => a.parentId && acctIds.has(a.parentId));
    const childMap = new Map<number, NetProfitAccount[]>();
    childrenList.forEach((c) => {
      if (!childMap.has(c.parentId!)) childMap.set(c.parentId!, []);
      childMap.get(c.parentId!)!.push(c);
    });

    return parents.map((acc) => {
      const kids = childMap.get(acc.id) || [];
      const hasKids = kids.length > 0;
      const isExpanded = expandedAccounts.has(acc.id);
      const displayBalance = hasKids
        ? kids.reduce((s, k) => s + Math.abs(Number(k.balance)), 0)
        : Math.abs(Number(acc.balance));

      return (
        <Fragment key={acc.id}>
          <TableRow
            className="hover-elevate cursor-pointer"
            onClick={() => {
              if (hasKids) toggleAccount(acc.id);
              else goToStatement(acc.id, undefined, "ledger");
            }}
          >
            <TableCell className="text-sm font-medium">
              <div className="flex items-center gap-2">
                {hasKids && (
                  <span className="text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                )}
                <span className={hasKids ? "font-semibold" : "hover:underline"}>{acc.name}</span>
              </div>
            </TableCell>
            <TableCell className="text-right font-mono text-sm text-green-600 dark:text-green-400">
              {formatSmartCurrency(displayBalance)}
            </TableCell>
          </TableRow>
          {hasKids &&
            isExpanded &&
            kids.map((child) => (
              <TableRow
                key={child.id}
                className="hover-elevate cursor-pointer"
                onClick={() => goToStatement(child.id, undefined, "ledger")}
              >
                <TableCell className="pl-8 text-sm text-muted-foreground hover:underline">{child.name}</TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {formatSmartCurrency(Math.abs(Number(child.balance)))}
                </TableCell>
              </TableRow>
            ))}
        </Fragment>
      );
    });
  };

  // Render hierarchical accounts (ordinary zero-balance accounts stay hidden).
  const renderHierarchicalAccounts = (accountList: Account[]) => {
    const { parentAccounts, accountMap } = groupAccountsByParent(accountList);

    return (
      <>
        {parentAccounts.map((parent) => {
          const children = accountMap.get(parent.accountId) || [];
          const hasChildren = children.length > 0;
          const isExpanded = expandedAccounts.has(parent.accountId);
          const childrenTotal = hasChildren ? calculateChildrenTotal(parent.accountId, accountMap) : 0;
          const parentBalance = parseBalance(parent.balance);
          const displayBalance = hasChildren ? childrenTotal : parentBalance;
          const preservePayrollChildren = keepsZeroBalanceChildren(parent.name);
          const visibleChildren = preservePayrollChildren
            ? children
            : children.filter((child) => parseBalance(child.balance) !== 0);

          // Payroll worker ledgers are historical audit rows. Keep the group and its
          // children visible even when the selected period has zero movement, so
          // paid/deactivated workers do not disappear from Salary Expense - Workers.
          if (displayBalance === 0 && !(preservePayrollChildren && visibleChildren.length > 0)) return null;

          return (
            <Fragment key={parent.id}>
              <TableRow
                data-testid={`row-account-${parent.id}`}
                className={`hover-elevate cursor-pointer font-medium`}
                onClick={() => {
                  if (hasChildren) {
                    toggleAccount(parent.accountId);
                  } else {
                    goToStatement(parent.accountId, parent.customerId, parent.type);
                  }
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {hasChildren ? (
                      <span className="text-muted-foreground">
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    ) : null}
                    <span className={hasChildren ? "" : "hover:underline"}>{parent.name}</span>
                  </div>
                </TableCell>
                <TableCell className={`text-right font-mono font-medium ${drCrClass(parent.balanceSide || "Dr")}`}>
                  {formatSmartCurrency(displayBalance)}
                </TableCell>
              </TableRow>
              {hasChildren &&
                isExpanded &&
                visibleChildren.map((child) => (
                  <TableRow
                    key={child.id}
                    data-testid={`row-account-${child.id}`}
                    className="hover-elevate cursor-pointer"
                    onClick={() => goToStatement(child.accountId, child.customerId, child.type)}
                  >
                    <TableCell className="pl-8 text-muted-foreground hover:underline">{child.name}</TableCell>
                    <TableCell className={`text-right font-mono ${drCrClass(child.balanceSide || "Dr")}`}>
                      {formatSmartCurrency(parseBalance(child.balance))}
                    </TableCell>
                  </TableRow>
                ))}
            </Fragment>
          );
        })}
      </>
    );
  };

  const renderPLAccountTable = (accountList: Account[], showTotal: boolean = true) => {
    if (accountsLoading) {
      return (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      );
    }

    if (accountList.length === 0) {
      return (
        <EmptyState
          icon={FileText}
          title="No accounts in this category"
          description="Once you add accounts, they will appear here."
        />
      );
    }

    const total = calculatePLTotal(accountList);

    return (
      <div className="rounded-md border table-responsive">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead>Account Name</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accountList.map((account) => (
              <TableRow
                key={account.id}
                className="hover-elevate cursor-pointer"
                onClick={() => goToStatement(account.accountId, account.customerId, account.type)}
              >
                <TableCell className="hover:underline">{account.name}</TableCell>
                <TableCell className="text-right font-mono">{formatCurrency(account.balance)}</TableCell>
              </TableRow>
            ))}
            {showTotal && (
              <TableRow className="font-semibold bg-muted/50">
                <TableCell>Total</TableCell>
                <TableCell className="text-right font-mono">{formatCurrency(Math.abs(total))}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    );
  };

  return { renderNetProfitAccountsList, renderHierarchicalAccounts, renderPLAccountTable };
}

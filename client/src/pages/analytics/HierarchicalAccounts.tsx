import { Fragment } from "react";
import { TableRow, TableCell } from "@/components/ui/table";
import { ChevronRight, ChevronDown } from "lucide-react";
import { drCrClass } from "@/lib/formatNumber";
import { parseBalance, calculateChildrenTotal, formatSmartCurrency, goToStatement } from "./analyticsHelpers";
import type { Account } from "./analyticsTypes";

interface HierarchicalAccountsProps {
  accountList: Account[];
  expandedAccounts: Set<number>;
  toggleAccount: (accountId: number) => void;
  appMode: string;
  accountMap: Map<number, Account[]>;
  parentAccounts: Account[];
}

function keepsZeroBalanceChildren(parentName: string): boolean {
  const normalized = parentName.trim().toLowerCase();
  return normalized === "salary expense - workers" || normalized === "bonus expense - workers";
}

export function HierarchicalAccounts({
  expandedAccounts,
  toggleAccount,
  appMode,
  accountMap,
  parentAccounts,
}: HierarchicalAccountsProps) {
  return (
    <>
      {parentAccounts.map((parent) => {
        const children = accountMap.get(parent.accountId) || [];
        const hasChildren = children.length > 0;
        const isExpanded = expandedAccounts.has(parent.accountId);
        const childrenTotal = hasChildren ? calculateChildrenTotal(parent.accountId, accountMap) : 0;
        const parentBalance = parseBalance(parent.balance);
        const displayBalance = hasChildren ? childrenTotal : parentBalance;
        const displayBalanceSide =
          hasChildren && childrenTotal !== 0 ? (childrenTotal > 0 ? "Cr" : "Dr") : parent.balanceSide || "Dr";
        const preservePayrollChildren = keepsZeroBalanceChildren(parent.name);
        const visibleChildren = preservePayrollChildren
          ? children
          : children.filter((child) => parseBalance(child.balance) !== 0);

        // Ordinary zero-balance accounts stay hidden. Payroll worker groups are different:
        // their children are historical expense accounts, so a worker who is inactive or
        // has no movement in the currently selected period must still remain visible.
        if (displayBalance === 0 && !(preservePayrollChildren && visibleChildren.length > 0)) return null;

        return (
          <Fragment key={parent.id}>
            <TableRow
              data-testid={`row-account-${parent.id}`}
              className={`hover-elevate cursor-pointer font-medium`}
              onClick={() => goToStatement(parent.accountId, appMode, parent.customerId, parent.type)}
            >
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {hasChildren && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAccount(parent.accountId);
                      }}
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  )}
                  <span className="hover:underline">{parent.name}</span>
                </div>
              </TableCell>
              <TableCell className={`text-right font-mono font-medium ${drCrClass(displayBalanceSide)}`}>
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
                  onClick={() => goToStatement(child.accountId, appMode, child.customerId, child.type)}
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
}

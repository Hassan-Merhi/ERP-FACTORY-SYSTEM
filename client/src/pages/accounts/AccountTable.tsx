import { Fragment, useState, useMemo } from "react";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import type { Account } from "./accountTypes";
import type { AccountDisplayLayout } from "./DisplayAccountGroups";
import { cn } from "@/lib/utils";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface AccountTableProps {
  filteredAccounts: Account[];
  expandedParents: Set<string>;
  toggleParent: (id: string) => void;
  handleAccountChange: (id: string) => void;
  hideBalances: boolean;
  formatAmount: (amt: number) => string;
  onEdit?: (account: Account) => void;
  displayLayout?: AccountDisplayLayout;
}

export function AccountTable({
  filteredAccounts,
  expandedParents,
  toggleParent,
  handleAccountChange,
  hideBalances,
  onEdit,
  displayLayout,
}: AccountTableProps) {
  const { formatHistoricalBaseAmount } = useCurrencyContext();

  function fmtBalance(amount: number, type: string): string {
    void type;
    return formatHistoricalBaseAmount(amount);
  }
  const [showZeroBalances, setShowZeroBalances] = useState(false);


  // Display grouping is a pure projection: synthetic negative IDs are only used
  // for rendering, and no real account parentId / balance is ever mutated.
  const orderedAccounts = useMemo(() => {
    if (!displayLayout?.nodes?.length) return filteredAccounts;
    const groups = displayLayout.nodes.filter(n => n.type === "group");
    const ledgerNodes = displayLayout.nodes.filter(n => n.type === "ledger");
    const groupIdByKey = new Map(groups.map((n, i) => [n.key, -(i + 1)]));
    const accountByKey = new Map(filteredAccounts.filter(a => a.type === "ledger").map(a => [`ledger:${a.accountId}`, a]));
    const groupedLedger = new Set<string>();
    const result: Account[] = [];
    const rootNodes = [...displayLayout.nodes.filter(n => !n.parentKey)].sort((a, b) => a.order - b.order);
    for (const node of rootNodes) {
      if (node.type === "group") {
        const virtualId = groupIdByKey.get(node.key)!;
        const members = ledgerNodes
          .filter(n => n.parentKey === node.key)
          .sort((a, b) => a.order - b.order)
          .map(n => accountByKey.get(n.key))
          .filter((a): a is Account => !!a);
        for (const member of members) groupedLedger.add(`ledger:${member.accountId}`);
        const signedTotal = members.reduce((sum, a) => sum + (
          a.balanceSide === "Cr" ? -Math.abs(a.balance) :
          a.balanceSide === "Dr" ? Math.abs(a.balance) : a.balance
        ), 0);
        result.push({
          id: `display:${node.key}`, accountId: virtualId, type: "displayGroup",
          code: "", name: node.name || "Group", balance: signedTotal,
          balanceSide: signedTotal < 0 ? "Cr" : "Dr", active: true, subType: "Group",
        });
        result.push(...members.map(a => ({ ...a, parentId: virtualId })));
      } else {
        const account = accountByKey.get(node.key);
        if (account && !groupedLedger.has(node.key)) result.push(account);
      }
    }
    const used = new Set(result.filter(a => a.type !== "displayGroup").map(a => a.id));
    // Untracked accounts and all non-ledger types retain their existing list order.
    result.push(...filteredAccounts.filter(a => !used.has(a.id)));
    return result;
  }, [filteredAccounts, displayLayout]);

  const visibleAccounts = useMemo(() => {
    if (showZeroBalances) return orderedAccounts;

    const nonZeroAccounts = orderedAccounts.filter((account) => Math.abs(Number(account.balance) || 0) > 0.001);
    const parentIdsWithVisibleChildren = new Set(nonZeroAccounts.map((account) => account.parentId).filter(Boolean));

    return orderedAccounts.filter(
      (account) => Math.abs(Number(account.balance) || 0) > 0.001 || parentIdsWithVisibleChildren.has(account.accountId)
    );
  }, [orderedAccounts, showZeroBalances]);

  const accountIds = new Set(visibleAccounts.map((a) => a.accountId));
  const parents = visibleAccounts.filter((a) => !a.parentId || !accountIds.has(a.parentId));
  const childrenList = visibleAccounts.filter((a) => a.parentId && accountIds.has(a.parentId));
  const childMap = new Map<number, Account[]>();
  childrenList.forEach((child) => {
    if (child.parentId == null) return;
    const parentId = child.parentId;
    if (!childMap.has(parentId)) childMap.set(parentId, []);
    childMap.get(parentId)!.push(child);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button
          variant={showZeroBalances ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setShowZeroBalances((visible) => !visible)}
          data-testid="button-show-zero-balances"
        >
          {showZeroBalances ? "Hide 0 Balance" : "Show 0 Balance"}
        </Button>
      </div>

      <div className="rounded-xl border overflow-hidden">
        {/* Fixed layout on phones so long account names truncate instead of pushing balances off-screen. */}
        <Table className="max-sm:table-fixed">
          <TableBody>
            {parents.map((account) => {
              const kids = childMap.get(account.accountId) || [];
              const hasKids = kids.length > 0;
              const isExpanded = expandedParents.has(account.id);
              const isGroup = account.subType === "Group" || hasKids;
              const balanceSide = account.balanceSide || (account.balance >= 0 ? "Dr" : "Cr");

              return (
                <Fragment key={account.id}>
                  <TableRow
                    className="cursor-pointer transition-colors hover:bg-muted/30 group/row"
                    onClick={() => {
                      if (hasKids) toggleParent(account.id);
                      else handleAccountChange(account.id);
                    }}
                    data-testid={`row-account-${account.id}`}
                  >
                    <TableCell className={cn("py-3", isGroup && "font-medium")}>
                      <div className="flex items-center gap-2.5 min-w-0">
                        {hasKids ? (
                          <span className="text-muted-foreground shrink-0">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </span>
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="truncate text-sm max-sm:min-w-0 max-sm:flex-1 max-sm:whitespace-normal max-sm:line-clamp-2 max-sm:wrap-break-word">
                          {account.name}
                        </span>
                        {account.accountId && !isGroup && (
                          <span className="text-[11px] text-muted-foreground font-mono shrink-0 max-sm:hidden">
                            #{account.accountId}
                          </span>
                        )}
                        {onEdit && account.type === "ledger" && (
                          <button
                            className="opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:p-2.5 transition-opacity ml-1 p-0.5 rounded-sm hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEdit(account);
                            }}
                            title="Edit account"
                            data-testid={`button-edit-account-${account.accountId}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </TableCell>
                    {!hideBalances && (
                      <TableCell className="text-right py-3 max-sm:w-28">
                        {hasKids && account.type !== "displayGroup" ? (
                          <span className="text-muted-foreground text-xs">
                            {kids.length} {kids.length === 1 ? "account" : "accounts"}
                          </span>
                        ) : (
                          <span
                            className={cn(
                              "font-mono tabular-nums text-sm font-medium",
                              balanceSide === "Dr"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400"
                            )}
                          >
                            {fmtBalance(Math.abs(account.balance), account.type)}
                            <span className="ml-1 text-[11px] opacity-60">{balanceSide}</span>
                          </span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>

                  {hasKids &&
                    isExpanded &&
                    kids.map((child) => {
                      const childSide = child.balanceSide || (child.balance >= 0 ? "Dr" : "Cr");
                      return (
                        <TableRow
                          key={child.id}
                          className="cursor-pointer hover:bg-muted/20 group/child"
                          onClick={() => handleAccountChange(child.id)}
                          data-testid={`row-account-${child.id}`}
                        >
                          <TableCell className="py-2.5 pl-14">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate text-sm text-muted-foreground">{child.name}</span>
                              {child.accountId && (
                                <span className="text-[11px] text-muted-foreground/60 font-mono shrink-0">
                                  #{child.accountId}
                                </span>
                              )}
                              {onEdit && child.type === "ledger" && (
                                <button
                                  className="opacity-0 group-hover/child:opacity-100 transition-opacity p-0.5 rounded-sm hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onEdit(child);
                                  }}
                                  title="Edit account"
                                  data-testid={`button-edit-account-${child.accountId}`}
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          </TableCell>
                          {!hideBalances && (
                            <TableCell className="text-right py-2.5">
                              <span
                                className={cn(
                                  "font-mono tabular-nums text-sm",
                                  childSide === "Dr"
                                    ? "text-emerald-600/80 dark:text-emerald-400/80"
                                    : "text-amber-600/80 dark:text-amber-400/80"
                                )}
                              >
                                {fmtBalance(Math.abs(child.balance), child.type)}
                                <span className="ml-1 text-[11px] opacity-60">{childSide}</span>
                              </span>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                </Fragment>
              );
            })}

            {parents.length === 0 && (
              <TableRow>
                <TableCell colSpan={hideBalances ? 1 : 2} className="text-center py-12 text-muted-foreground text-sm">
                  No accounts found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

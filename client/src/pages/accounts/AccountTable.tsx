import { ErpListTable } from "@/erp-core";
import { Fragment, useState, useMemo } from "react";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FolderClosed, GripVertical, Pencil, Wallet } from "lucide-react";
import type { Account } from "./accountTypes";
import { FxAgentNativeBalance } from "./FxAgentNativeBalance";
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
  canArrange?: boolean;
  arranging?: boolean;
  onArrangeChange?: (next: boolean) => void;
  onSwap?: (key: string, targetKey: string) => void;
  onMove?: (key: string, targetKey: string) => void;
  isSavingOrder?: boolean;
  searchActive?: boolean;
}

export function AccountTable({
  filteredAccounts,
  expandedParents,
  toggleParent,
  handleAccountChange,
  hideBalances,
  onEdit,
  displayLayout,
  canArrange = false,
  arranging = false,
  onArrangeChange,
  onSwap,
  onMove,
  isSavingOrder = false,
  searchActive = false,
}: AccountTableProps) {
  const { formatHistoricalBaseAmount } = useCurrencyContext();

  function fmtBalance(amount: number, type: string): string {
    void type;
    return formatHistoricalBaseAmount(amount);
  }
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const layoutKey = (a: Account): string | null =>
    a.type === "displayGroup"
      ? a.id.slice("display:".length)
      : a.type === "ledger" && a.accountId > 0
        ? `ledger:${a.accountId}`
        : null;
  const moveButtons = (account: Account, siblings: Account[]) => {
    const key = layoutKey(account);
    if (!arranging || !canArrange || !key) return null;
    const ordered = siblings.filter(
      (a) => layoutKey(a) && (a.type === "displayGroup") === (account.type === "displayGroup")
    );
    const index = ordered.findIndex((a) => a.id === account.id);
    const previousKey = index > 0 ? layoutKey(ordered[index - 1]) : null;
    const nextKey = index >= 0 && index < ordered.length - 1 ? layoutKey(ordered[index + 1]) : null;
    return (
      <span className="inline-flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={`Move ${account.name} up`}
          disabled={!previousKey || isSavingOrder}
          onClick={() => previousKey && onSwap?.(key, previousKey)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={`Move ${account.name} down`}
          disabled={!nextKey || isSavingOrder}
          onClick={() => nextKey && onSwap?.(key, nextKey)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
      </span>
    );
  };

  // Display grouping is a pure projection: synthetic negative IDs are only used
  // for rendering, and no real account parentId / balance is ever mutated.
  const orderedAccounts = useMemo(() => {
    if (!displayLayout?.nodes?.length) return filteredAccounts;
    const groups = displayLayout.nodes.filter((n) => n.type === "group");
    const ledgerNodes = displayLayout.nodes.filter((n) => n.type === "ledger");
    const legacyGroupKeys = new Set(groups.map((n) => n.key));
    const groupIdByKey = new Map(groups.map((n, i) => [n.key, -(i + 1)]));
    const accountByKey = new Map(
      filteredAccounts.filter((a) => a.type === "ledger").map((a) => [`ledger:${a.accountId}`, a])
    );
    const groupedLedger = new Set<string>();
    const result: Account[] = [];
    const rootNodes = [...displayLayout.nodes.filter((n) => !n.parentKey)].sort((a, b) => a.order - b.order);
    for (const node of rootNodes) {
      if (node.type === "group") {
        const virtualId = groupIdByKey.get(node.key)!;
        const members = ledgerNodes
          .filter((n) => n.parentKey === node.key)
          .sort((a, b) => a.order - b.order)
          .map((n) => accountByKey.get(n.key))
          .filter((a): a is Account => !!a);
        for (const member of members) groupedLedger.add(`ledger:${member.accountId}`);
        const signedTotal = members.reduce(
          (sum, a) =>
            sum +
            (a.balanceSide === "Cr" ? -Math.abs(a.balance) : a.balanceSide === "Dr" ? Math.abs(a.balance) : a.balance),
          0
        );
        result.push({
          id: `display:${node.key}`,
          accountId: virtualId,
          type: "displayGroup",
          code: "",
          name: node.name || "Group",
          balance: signedTotal,
          balanceSide: signedTotal < 0 ? "Cr" : "Dr",
          active: true,
          subType: "Group",
        });
        result.push(...members.map((a) => ({ ...a, parentId: virtualId })));
      } else {
        const account = accountByKey.get(node.key);
        if (account && !groupedLedger.has(node.key)) result.push(account);
      }
    }
    const used = new Set(result.filter((a) => a.type !== "displayGroup").map((a) => a.id));
    // Untracked accounts and all non-ledger types retain their existing list order.
    result.push(
      ...filteredAccounts.filter(
        (a) =>
          !used.has(a.id) &&
          !(a.subType === "Group" && legacyGroupKeys.has(`group:legacy-${a.accountId}`) && Math.abs(a.balance) < 0.001)
      )
    );
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canArrange && (
          <Button
            size="sm"
            variant={arranging ? "default" : "outline"}
            disabled={isSavingOrder}
            onClick={() => onArrangeChange?.(!arranging)}
            data-testid="button-arrange-accounts"
          >
            {arranging ? "Finish arranging" : "Arrange accounts"}
          </Button>
        )}
        {arranging && (
          <span className="text-xs text-muted-foreground">Use arrows or drag rows. Changes save for all users.</span>
        )}
        <Button
          variant={showZeroBalances ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          onClick={() => setShowZeroBalances((visible) => !visible)}
          data-testid="button-show-zero-balances"
          aria-pressed={showZeroBalances}
        >
          <span aria-hidden="true" className={cn("mr-2 flex h-3.5 w-7 items-center rounded-full p-0.5 transition-colors", showZeroBalances ? "bg-blue-500" : "bg-muted-foreground/30")}>
            <span className={cn("h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform", showZeroBalances && "translate-x-3")} />
          </span>
          {showZeroBalances ? "Hide 0 Balance" : "Show 0 Balance"}
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-card shadow-sm dark:border-[#2c4267] dark:bg-[#0b1425]">
        {/* Fixed layout on phones so long account names truncate instead of pushing balances off-screen. */}
        <ErpListTable pageKey="account-list" className="max-sm:table-fixed" scrollLabel="ERP accounts">
          <TableHeader>
            <TableRow className="border-b border-slate-200/80 bg-slate-100/80 hover:bg-slate-100/80 dark:border-blue-800/60 dark:bg-[#1d3354] dark:hover:bg-[#1d3354]">
              <TableHead className="h-10 pl-5 text-xs font-semibold text-slate-700 dark:text-slate-100">Account Name / Code</TableHead>
              {!hideBalances && <TableHead className="h-10 text-right pr-5 text-xs font-semibold text-slate-700 dark:text-slate-100">Balance</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {parents.map((account) => {
              const kids = childMap.get(account.accountId) || [];
              const hasKids = kids.length > 0;
              const isExpanded = searchActive || expandedParents.has(account.id);
              const isGroup = account.subType === "Group" || hasKids;
              const balanceSide = account.balanceSide || (account.balance >= 0 ? "Dr" : "Cr");

              return (
                <Fragment key={account.id}>
                  <TableRow
                    draggable={arranging && !!layoutKey(account)}
                    onDragStart={(e) => {
                      const key = layoutKey(account);
                      if (key) {
                        setDragging(key);
                        e.dataTransfer.setData("text/plain", key);
                      }
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      if (arranging) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (!arranging) return;
                      e.preventDefault();
                      const key = dragging || e.dataTransfer.getData("text/plain");
                      const target = layoutKey(account);
                      if (key && target) onMove?.(key, target);
                      setDragging(null);
                    }}
                    className="group/row cursor-pointer border-b border-border/60 bg-white transition-colors hover:bg-blue-50/70 dark:border-slate-700/50 dark:bg-[#101b30] dark:hover:bg-[#1a3354]"
                    onClick={() => {
                      if (hasKids) toggleParent(account.id);
                      else handleAccountChange(account.id);
                    }}
                    data-testid={`row-account-${account.id}`}
                  >
                    <TableCell className={cn("py-2.5 pl-4", isGroup && "font-medium")}>
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
                        <span aria-hidden="true" className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", isGroup ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
                          {isGroup ? <FolderClosed className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
                        </span>
                        <span className="truncate text-sm max-sm:min-w-0 max-sm:flex-1 max-sm:whitespace-normal max-sm:line-clamp-2 max-sm:wrap-break-word">
                          {account.name}
                        </span>
                        {account.accountId && !isGroup && (
                          <span className="shrink-0 rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground max-sm:hidden dark:bg-blue-950/60">
                            #{account.accountId}
                          </span>
                        )}
                        {moveButtons(account, parents)}
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
                      <TableCell className="py-2.5 pr-5 text-right max-sm:w-28">
                        {account.fxWallet ? (
                          <FxAgentNativeBalance wallet={account.fxWallet} compact />
                        ) : hasKids && account.type !== "displayGroup" ? (
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
                          draggable={arranging && !!layoutKey(child)}
                          onDragStart={(e) => {
                            const key = layoutKey(child);
                            if (key) {
                              setDragging(key);
                              e.dataTransfer.setData("text/plain", key);
                            }
                            e.stopPropagation();
                          }}
                          onDragEnd={() => setDragging(null)}
                          onDragOver={(e) => {
                            if (arranging) e.preventDefault();
                          }}
                          onDrop={(e) => {
                            if (!arranging) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const key = dragging || e.dataTransfer.getData("text/plain");
                            const target = layoutKey(child);
                            if (key && target) onMove?.(key, target);
                            setDragging(null);
                          }}
                          className="group/child cursor-pointer border-b border-border/50 bg-slate-50/40 transition-colors hover:bg-blue-50/70 dark:border-slate-700/50 dark:bg-[#0b1629] dark:hover:bg-[#1a3354]"
                          onClick={() => handleAccountChange(child.id)}
                          data-testid={`row-account-${child.id}`}
                        >
                          <TableCell className="py-2.5 pl-14">
                            <div className="flex items-center gap-2 min-w-0">
                              <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-300"><Wallet className="h-3.5 w-3.5" /></span>
                              <span className="truncate text-sm text-muted-foreground">{child.name}</span>
                              {child.accountId && (
                                <span className="shrink-0 rounded-md bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground/80 dark:bg-blue-950/60">
                                  #{child.accountId}
                                </span>
                              )}
                              {moveButtons(child, kids)}
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
                            <TableCell className="py-2.5 pr-5 text-right">
                              {child.fxWallet ? (
                                <FxAgentNativeBalance wallet={child.fxWallet} compact />
                              ) : (
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
                              )}
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
        </ErpListTable>
      </div>
    </div>
  );
}

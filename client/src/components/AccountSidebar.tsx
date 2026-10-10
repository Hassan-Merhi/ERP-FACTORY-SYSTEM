import { useEffect, useRef, KeyboardEvent } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus, Loader2 } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

export interface Account {
  id: number;
  type: "bank" | "ledger" | "supplier" | "employee" | "fixedAsset" | "customer" | "factorySupplier";
  name: string;
  code: string;
  balance?: number;
}

export interface VoucherEntry {
  accountType: string;
  accountId: number;
  accountName: string;
  amount: string;
}

interface AccountSidebarProps {
  accounts: Account[];
  filteredAccounts: Account[];
  onSelectAccount: (account: Account) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedAccountId: number | null;
  selectedAccountType: string | null;
  highlightedIndex: number;
  onHighlightedIndexChange: (index: number) => void;
  entries?: VoucherEntry[];
  mode?: "payment" | "receipt";
  paymentAccountId?: number;
  paymentAccountType?: string;
  voucherTotal?: number;
  onCreateAccount?: () => void;
  isFactoryCompany?: boolean;
  onAutoCreateAccount?: (name: string) => Promise<Account | null>;
  isAutoCreating?: boolean;
  activeTargetLabel?: string;
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  bank: { label: "Bank", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
  ledger: { label: "Ledger", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  supplier: { label: "Supplier", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" },
  employee: { label: "Staff", cls: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300" },
  fixedAsset: { label: "Asset", cls: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300" },
  customer: { label: "Customer", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" },
  factorySupplier: { label: "F.Supp", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300" },
};

export default function AccountSidebar({
  accounts: _accounts,
  filteredAccounts,
  onSelectAccount,
  searchValue,
  onSearchChange,
  selectedAccountId,
  selectedAccountType,
  highlightedIndex,
  onHighlightedIndexChange,
  entries = [],
  mode = "payment",
  paymentAccountId = 0,
  paymentAccountType = "",
  voucherTotal = 0,
  onCreateAccount,
  isFactoryCompany = false,
  onAutoCreateAccount,
  isAutoCreating = false,
  activeTargetLabel,
}: AccountSidebarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { formatAmount } = useCurrencyContext();

  // Accounts already used by a line in this voucher. `useSidebarSync` floats these to the
  // top of `filteredAccounts` while the search box is empty, so the boundary between the
  // two groups is simply the first account that is not used.
  const usedAccountKeys = new Set(
    entries.filter((e) => (e?.accountId ?? 0) > 0).map((e) => `${e.accountType}:${e.accountId}`)
  );
  const isGrouped = !searchValue.trim() && usedAccountKeys.size > 0;
  const usedCount = isGrouped ? filteredAccounts.filter((a) => usedAccountKeys.has(`${a.type}:${a.id}`)).length : 0;

  const handleAutoCreate = async () => {
    if (!onAutoCreateAccount) return;
    const trimmedName = searchValue.trim();
    if (!trimmedName) return;
    const newAccount = await onAutoCreateAccount(trimmedName);
    if (newAccount) onSelectAccount(newAccount);
  };

  const handleKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredAccounts.length > 0) {
        onHighlightedIndexChange(Math.min(highlightedIndex + 1, filteredAccounts.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredAccounts.length > 0) {
        onHighlightedIndexChange(Math.max(highlightedIndex - 1, 0));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredAccounts.length > 0) {
        // Accounts exist — select highlighted (or first) just like ERP
        const idx = highlightedIndex >= 0 && highlightedIndex < filteredAccounts.length ? highlightedIndex : 0;
        onSelectAccount(filteredAccounts[idx]);
      } else if (isFactoryCompany && onAutoCreateAccount && searchValue.trim()) {
        // No accounts found and factory mode — auto-create
        await handleAutoCreate();
      }
    }
  };

  // Calculate projected balances based on voucher entries
  const getProjectedBalance = (account: Account): number => {
    const currentBalance = account.balance ?? 0;
    let adjustment = 0;

    const isPaymentAccount = account.id === paymentAccountId && account.type === paymentAccountType;

    // Check if this is the payment/receipt account
    if (isPaymentAccount && voucherTotal > 0) {
      // For payment vouchers, the payment account balance decreases
      // For receipt vouchers, the receipt account balance increases
      adjustment = mode === "payment" ? -voucherTotal : voucherTotal;
    }

    // For non-payment accounts, check if they appear in the entries
    if (!isPaymentAccount) {
      const entryAmount = entries
        .filter(
          (entry) =>
            entry.accountId === account.id &&
            entry.accountType === account.type &&
            entry.amount &&
            !isNaN(Number(entry.amount))
        )
        .reduce((sum, entry) => sum + Number(entry.amount), 0);

      // Payment: debit entry increases the balance (moves liability toward zero, increases asset/expense).
      // Receipt: credit entry decreases the balance.
      // The sign convention on the stored balance handles the visual interpretation.
      if (entryAmount > 0) {
        adjustment += mode === "payment" ? entryAmount : -entryAmount;
      }
    }

    return currentBalance + adjustment;
  };

  // Keep keyboard highlighting visible without asking the browser to scroll every
  // ancestor. Element.scrollIntoView() can move the whole vouchers page when the
  // highlighted account is far down the 200+ account list, which makes the active
  // row/search input appear to disappear while typing. Only adjust this list's own
  // scrollTop instead.
  useEffect(() => {
    const list = listRef.current;
    if (!list || highlightedIndex < 0) return;

    const highlightedElement = list.querySelector<HTMLElement>(`[data-index="${highlightedIndex}"]`);
    if (!highlightedElement) return;

    const listRect = list.getBoundingClientRect();
    const itemRect = highlightedElement.getBoundingClientRect();

    if (itemRect.top < listRect.top) {
      list.scrollTop -= listRect.top - itemRect.top;
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollTop += itemRect.bottom - listRect.bottom;
    }
  }, [highlightedIndex]);

  const formatBalance = (balance: number | undefined) => {
    if (balance === undefined) return "—";
    const absBalance = Math.abs(balance);
    const formatted = formatAmount(absBalance);
    return balance < 0 ? `(${formatted})` : formatted;
  };

  const getBalanceColorClass = (balance: number | undefined, _accountType?: string) => {
    if (balance === undefined) return "text-muted-foreground";
    // All account types use the same sign convention in the sidebar:
    // negative = credit balance (red), positive = debit balance (green).
    // Suppliers/employees are stored as negative when we owe them, which naturally turns them red.
    if (balance < 0) return "text-destructive";
    if (balance > 0) return "text-chart-2";
    return "text-muted-foreground";
  };

  return (
    <Card className="flex flex-col h-full">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <span className="text-sm font-medium">Select Account</span>
            {activeTargetLabel && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate" data-testid="text-active-target">
                Selecting for: <span className="font-medium text-foreground">{activeTargetLabel}</span>
              </p>
            )}
          </div>
          {onCreateAccount && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCreateAccount}
              data-testid="button-create-new-account"
            >
              <Plus className="h-4 w-4 mr-1" />
              New
            </Button>
          )}
        </div>

        <div className="relative">
          {isAutoCreating ? (
            <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          )}
          <Input
            ref={searchInputRef}
            placeholder={isFactoryCompany ? "Type expense name & Enter..." : "Search accounts..."}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-9"
            data-testid="input-search-account"
            disabled={isAutoCreating}
          />
        </div>

        <div className="flex items-center justify-between gap-2 mt-2">
          <p className="text-[11px] text-muted-foreground font-mono tabular-nums" data-testid="text-account-count">
            {searchValue.trim()
              ? `Showing ${filteredAccounts.length} of ${_accounts.length}`
              : `${_accounts.length} accounts`}
          </p>
          <p className="text-[11px] text-muted-foreground hidden sm:block">
            <kbd className="px-1 py-0.5 bg-muted rounded-sm text-[10px]">↑↓</kbd> move{" "}
            <kbd className="px-1 py-0.5 bg-muted rounded-sm text-[10px] ml-1">↵</kbd> select
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3" ref={listRef}>
        <div className="space-y-1">
          {filteredAccounts.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              {isFactoryCompany && searchValue.trim() && onAutoCreateAccount ? (
                <div className="space-y-3">
                  <p>No match for "{searchValue.trim()}"</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAutoCreate}
                    disabled={isAutoCreating}
                    data-testid="button-create-account-inline"
                    className="gap-1.5"
                  >
                    {isAutoCreating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Create "{searchValue.trim()}"
                  </Button>
                  <p className="text-xs">
                    or press <kbd className="px-1.5 py-0.5 bg-muted rounded-sm">Enter</kbd>
                  </p>
                </div>
              ) : (
                "No accounts found"
              )}
            </div>
          ) : (
            filteredAccounts.map((account, idx) => {
              const isSelected = account.id === selectedAccountId && account.type === selectedAccountType;
              const isHighlighted = idx === highlightedIndex;
              const projectedBalance = getProjectedBalance(account);
              const hasProjection = projectedBalance !== (account.balance ?? 0);
              const isUsed = isGrouped && usedAccountKeys.has(`${account.type}:${account.id}`);

              // Group headings only appear in the unsearched browse list, where
              // `useSidebarSync` has floated the voucher's own accounts to the front.
              const heading = !isGrouped
                ? null
                : idx === 0
                  ? "In this voucher"
                  : idx === usedCount
                    ? "All accounts"
                    : null;

              return (
                <div key={`${account.type}-${account.id}`}>
                  {heading && (
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pt-2 pb-1">
                      {heading}
                    </p>
                  )}
                  <button
                    data-index={idx}
                    onClick={() => onSelectAccount(account)}
                    className={`w-full text-left px-2 py-2 rounded-md hover-elevate active-elevate-2 transition-colors ${
                      isSelected ? "ring-2 ring-primary" : ""
                    } ${isHighlighted ? "bg-accent" : ""} ${
                      isUsed ? "shadow-[inset_2px_0_0_hsl(var(--primary))]" : ""
                    }`}
                    data-testid={`account-${idx}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {account.name || account.code || `${account.type}-${account.id}`}
                        </div>
                        {TYPE_BADGE[account.type] && (
                          <span
                            className={`inline-block text-[9px] font-medium px-1.5 py-0 rounded-sm mt-0.5 ${TYPE_BADGE[account.type].cls}`}
                          >
                            {TYPE_BADGE[account.type].label}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        {hasProjection && (
                          <div className="text-xs text-muted-foreground font-mono tabular-nums line-through">
                            {formatBalance(account.balance)}
                          </div>
                        )}
                        <div
                          className={`text-xs font-mono tabular-nums font-semibold shrink-0 ${getBalanceColorClass(projectedBalance, account.type)}`}
                        >
                          {formatBalance(projectedBalance)}
                        </div>
                      </div>
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Card>
  );
}

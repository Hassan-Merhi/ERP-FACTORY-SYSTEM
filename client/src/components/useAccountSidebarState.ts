// Extracted from ./AccountSidebar.tsx
import { useEffect, useRef, KeyboardEvent } from "react";
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

export interface AccountSidebarProps {
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

export function useAccountSidebarState({
  filteredAccounts,
  onSelectAccount,
  searchValue,
  highlightedIndex,
  onHighlightedIndexChange,
  entries = [],
  mode = "payment",
  paymentAccountId = 0,
  paymentAccountType = "",
  voucherTotal = 0,
  isFactoryCompany = false,
  onAutoCreateAccount,
}: Pick<
  AccountSidebarProps,
  | "filteredAccounts"
  | "onSelectAccount"
  | "searchValue"
  | "highlightedIndex"
  | "onHighlightedIndexChange"
  | "entries"
  | "mode"
  | "paymentAccountId"
  | "paymentAccountType"
  | "voucherTotal"
  | "isFactoryCompany"
  | "onAutoCreateAccount"
>) {
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
  return {
    searchInputRef,
    listRef,
    usedAccountKeys,
    isGrouped,
    usedCount,
    handleAutoCreate,
    handleKeyDown,
    getProjectedBalance,
    formatBalance,
    getBalanceColorClass,
  };
}

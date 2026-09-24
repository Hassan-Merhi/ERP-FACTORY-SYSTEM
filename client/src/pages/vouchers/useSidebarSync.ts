import { searchAny } from "@shared/searchNormalization";
import { useMemo, useEffect } from "react";
import type { Account } from "@/components/AccountSidebar";
import type { CombinedAccount } from "@/components/AccountAutocomplete";

interface UseSidebarSyncProps {
  sidebarAccounts: Account[];
  sidebarSearchValue: string;
  paymentAccountId: number;
  paymentAccountType: string;
  sidebarHighlightedIndex: number;
  setSidebarHighlightedIndex: (i: number) => void;
  entries: { accountType: "customer" | "supplier" | "employee" | "bank" | "ledger" | "fixedAsset" | "factorySupplier"; accountId: number; accountName: string; amount: string; }[];
  activeRowIndex: number | null;
  allAccounts: CombinedAccount[];
}

export function useSidebarSync({
  sidebarAccounts,
  sidebarSearchValue,
  paymentAccountId,
  paymentAccountType,
  sidebarHighlightedIndex,
  setSidebarHighlightedIndex,
  entries,
  activeRowIndex,
  allAccounts,
}: UseSidebarSyncProps) {
  // Accounts already used by a voucher line — used to float them to the top of the
  // browse list. Keyed as `type:id` so the two account namespaces never collide.
  const usedAccountKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if ((entry?.accountId ?? 0) > 0) keys.add(`${entry.accountType}:${entry.accountId}`);
    }
    return keys;
  }, [entries]);

  const filteredSidebarAccounts = useMemo(() => {
    const hasSearch = sidebarSearchValue.trim().length > 0;
    const matches = sidebarAccounts
      .filter((acc) => {
        if (paymentAccountId > 0 && acc.id === paymentAccountId && acc.type === paymentAccountType) {
          return false;
        }
        if (acc.type === "employee" && !hasSearch) return false;
        return searchAny(sidebarSearchValue, acc.name, acc.code);
      })
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    // While the user is searching, order stays strictly alphabetical so that the
    // highlighted-on-Enter account is exactly what it has always been. Only the
    // unsearched browse list reorders, where nothing is being matched by typing.
    if (hasSearch || usedAccountKeys.size === 0) return matches;

    const used: Account[] = [];
    const rest: Account[] = [];
    for (const acc of matches) {
      (usedAccountKeys.has(`${acc.type}:${acc.id}`) ? used : rest).push(acc);
    }
    return used.concat(rest);
  }, [sidebarAccounts, sidebarSearchValue, paymentAccountId, paymentAccountType, usedAccountKeys]);

  const activeRowAccountId =
    activeRowIndex !== null && entries[activeRowIndex] ? entries[activeRowIndex].accountId : null;
  const activeRowAccountType =
    activeRowIndex !== null && entries[activeRowIndex] ? entries[activeRowIndex].accountType : null;

  useEffect(() => {
    if (filteredSidebarAccounts.length === 0) {
      setSidebarHighlightedIndex(-1);
      return;
    }
    if (activeRowAccountId && activeRowAccountType) {
      const accountIndex = filteredSidebarAccounts.findIndex(
        (acc) => acc.id === activeRowAccountId && acc.type === activeRowAccountType
      );
      if (accountIndex >= 0) {
        setSidebarHighlightedIndex(accountIndex);
        return;
      }
    }
    setSidebarHighlightedIndex(0);
  }, [sidebarSearchValue, activeRowIndex, activeRowAccountId, activeRowAccountType, filteredSidebarAccounts, setSidebarHighlightedIndex]);

  useEffect(() => {
    if (filteredSidebarAccounts.length === 0) return;
    const maxIndex = filteredSidebarAccounts.length - 1;
    if (sidebarHighlightedIndex > maxIndex) {
      setSidebarHighlightedIndex(maxIndex);
    }
  }, [filteredSidebarAccounts.length, setSidebarHighlightedIndex, sidebarHighlightedIndex]);

  const selectedAccount = useMemo(
    () => allAccounts.find((acc) => acc.type === paymentAccountType && acc.id === paymentAccountId),
    [allAccounts, paymentAccountType, paymentAccountId]
  );

  return { filteredSidebarAccounts, selectedAccount };
}

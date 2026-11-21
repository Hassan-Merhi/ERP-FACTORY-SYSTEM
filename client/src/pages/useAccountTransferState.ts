// Extracted from ./AccountTransfer.tsx
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useDeferredValue, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { ENTRY_PAGE_SIZE, type Account, type EntryPage } from "./AccountCombobox";

export function useAccountTransferState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [toAccountId, setToAccountId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [searchEntries, setSearchEntries] = useState("");
  const [entryPage, setEntryPage] = useState(1);
  const [done, setDone] = useState<{ moved: number; toAccount: string } | null>(null);
  const deferredEntrySearch = useDeferredValue(searchEntries.trim());

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ["/api/ledger-accounts?profile=picker"],
    enabled: !!selectedCompany,
  });

  const {
    data: entryData,
    isLoading: loadingEntries,
    isError: entriesError,
    refetch: refetchEntries,
  } = useQuery<EntryPage>({
    queryKey: ["/api/voucher-entries/by-account", fromAccountId, entryPage, deferredEntrySearch],
    queryFn: async () => {
      const params = new URLSearchParams({
        pagination: "1",
        page: String(entryPage),
        pageSize: String(ENTRY_PAGE_SIZE),
      });
      if (deferredEntrySearch) params.set("search", deferredEntrySearch);
      const response = await fetch(`/api/voucher-entries/by-account/${fromAccountId}?${params}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(response.statusText || String(response.status));
      return response.json();
    },
    enabled: !!fromAccountId,
  });
  const entries = useMemo(() => entryData?.items ?? [], [entryData?.items]);

  const filteredEntries = useMemo(() => {
    if (!searchEntries.trim()) return entries;
    return entries.filter((e) =>
      searchAny(searchEntries, e.voucherNumber, e.narration, e.voucherDescription, e.voucherType)
    );
  }, [entries, searchEntries]);

  const allChecked = filteredEntries.length > 0 && filteredEntries.every((e) => selectedIds.has(e.id));
  const someChecked = filteredEntries.some((e) => selectedIds.has(e.id));

  function toggleAll() {
    if (allChecked) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((e) => next.delete(e.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((e) => next.add(e.id));
        return next;
      });
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedEntries = entries.filter((e) => selectedIds.has(e.id));
  const totalDebit = selectedEntries.reduce((s, e) => s + Number(e.debitAmount || 0), 0);
  const totalCredit = selectedEntries.reduce((s, e) => s + Number(e.creditAmount || 0), 0);

  const fromAccount = accounts.find((a) => a.id === fromAccountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);

  const transfer = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/voucher-entries/transfer-account", {
        entryIds: Array.from(selectedIds),
        toAccountId,
      });
      return (await res.json()) as { moved: number; toAccount: string };
    },
    onSuccess: (data) => {
      setDone({ moved: data.moved, toAccount: data.toAccount });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/voucher-entries/by-account", fromAccountId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts?profile=picker"] });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Transfer failed", description: e.message, variant: "destructive" }),
  });

  function resetAll() {
    setFromAccountId(null);
    setToAccountId(null);
    setSelectedIds(new Set());
    setSearchEntries("");
    setEntryPage(1);
    setDone(null);
  }
  return {
    fromAccountId,
    setFromAccountId,
    toAccountId,
    setToAccountId,
    setSelectedIds,
    selectedIds,
    setSearchEntries,
    searchEntries,
    setEntryPage,
    done,
    setDone,
    accounts,
    loadingEntries,
    entryData,
    entriesError,
    refetchEntries,
    entries,
    filteredEntries,
    allChecked,
    someChecked,
    toggleAll,
    toggleOne,
    totalDebit,
    totalCredit,
    fromAccount,
    toAccount,
    transfer,
    resetAll,
  };
}

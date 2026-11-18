// Extracted from ./PropertiesDashboard.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { ClientErrorLike } from "@/lib/clientError";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type AccountsAllPayload, selectAccountsArray } from "@/lib/accountsAllPayload";
import type {
  Account,
  DashboardCashAccount,
  ImportCycleBalanceData,
  PayableAccount,
  ProfitData,
} from "./propertiesdashboard/types";

export function usePropertiesDashboardState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  // Dashboard account lists are shared settings: read-only roles see them but cannot change them.
  const canConfigureDashboard = useExistingRecordChangeAccess().allowed;
  const { formatAmount: legacyFormatAmount, formatHistoricalBaseAmount } = useCurrencyContext();
  const formatAmount = formatHistoricalBaseAmount ?? legacyFormatAmount;
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isAddPayableDialogOpen, setIsAddPayableDialogOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number>(0);
  const [selectedPayableAccountId, setSelectedPayableAccountId] = useState<number>(0);
  const [payableComboboxOpen, setPayableComboboxOpen] = useState(false);
  const [cashComboboxOpen, setCashComboboxOpen] = useState(false);

  // Fetch net profit data
  const {
    data: profitData,
    isLoading,
    isError,
  } = useQuery<ProfitData>({
    queryKey: ["/api/stats/net-profit", selectedCompany?.id],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/stats/net-profit");
      if (!response.ok) throw new Error("Failed to fetch net profit");
      return await response.json();
    },
    enabled: !!selectedCompany,
  });

  // Fetch import cycle balance data
  const { data: importCycleData } = useQuery<ImportCycleBalanceData>({
    queryKey: ["/api/stats/import-cycle-balance", selectedCompany?.id],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/stats/import-cycle-balance");
      if (!response.ok) throw new Error("Failed to fetch import cycle balance");
      return await response.json();
    },
    enabled: !!selectedCompany,
  });

  // Fetch dashboard cash accounts
  const { data: dashboardCashAccounts = [], error: cashAccountsError } = useQuery<DashboardCashAccount[]>({
    queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 30 * 1000,
  });

  // Fetch all accounts for selection without assuming the shared cache is a bare array.
  const { data: allAccounts = [] } = useQuery<AccountsAllPayload<Account>, Error, Account[]>({
    queryKey: ["/api/accounts/all", selectedCompany?.id],
    select: selectAccountsArray,
    enabled: !!selectedCompany,
  });

  // The ledger-only endpoint already returns a plain array. Do not fetch the
  // enveloped /api/accounts/all response under this different query key.
  const { data: allPayableAccounts = [] } = useQuery<PayableAccount[]>({
    queryKey: ["/api/accounts/all-ledger", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  // Fetch dashboard payable accounts
  const { data: dashboardPayableAccounts = [], error: payableAccountsError } = useQuery<PayableAccount[]>({
    queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 30 * 1000,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  // Add dashboard cash account mutation
  const addAccountMutation = useMutation({
    mutationFn: async (data: { accountType: string; accountId: number }) => {
      return await apiRequest("POST", "/api/dashboard-cash-accounts", data);
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id] });
      setIsAddDialogOpen(false);
      setSelectedAccountId(0);
      toast({ title: "Saved", description: "Account added to dashboard" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message || "Failed to add account", variant: "destructive" });
    },
  });

  // Remove dashboard cash account mutation
  const removeAccountMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest("DELETE", `/api/dashboard-cash-accounts/${id}`);
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id] });
      toast({ title: "Updated", description: "Account removed from dashboard" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Remove failed",
        description: error.message || "Failed to remove account",
        variant: "destructive",
      });
    },
  });

  // Add dashboard payable account mutation
  const addPayableAccountMutation = useMutation({
    mutationFn: async (data: { accountId: number }) => {
      return await apiRequest("POST", "/api/dashboard-payable-accounts", data);
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id] });
      setIsAddPayableDialogOpen(false);
      setSelectedPayableAccountId(0);
      toast({ title: "Saved", description: "Payable account added to dashboard" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Save failed",
        description: error.message || "Failed to add payable account",
        variant: "destructive",
      });
    },
  });

  // Remove dashboard payable account mutation
  const removePayableAccountMutation = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest("DELETE", `/api/dashboard-payable-accounts/${id}`);
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id] });
      toast({ title: "Updated", description: "Payable account removed from dashboard" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Remove failed",
        description: error.message || "Failed to remove payable account",
        variant: "destructive",
      });
    },
  });

  // Drag refs for reordering
  const dragCashRef = useRef<number | null>(null);
  const dragPayableRef = useRef<number | null>(null);

  // Reorder cash accounts mutation
  const reorderCashMutation = useMutation({
    mutationFn: async (orderedIds: number[]) => {
      await apiRequest("PATCH", "/api/dashboard-cash-accounts/reorder", { orderedIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id] });
    },
  });

  // Reorder payable accounts mutation
  const reorderPayableMutation = useMutation({
    mutationFn: async (orderedIds: number[]) => {
      await apiRequest("PATCH", "/api/dashboard-payable-accounts/reorder", { orderedIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id] });
    },
  });

  const displayedCashAccounts = dashboardCashAccounts;

  const handleCashDrop = (targetId: number) => {
    const fromId = dragCashRef.current;
    if (!canConfigureDashboard || fromId === null || fromId === targetId) return;
    const ids = displayedCashAccounts.map((d) => d.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...ids];
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, fromId);
    queryClient.setQueryData(
      ["/api/dashboard-cash-accounts", selectedCompany?.id],
      (old: DashboardCashAccount[] | undefined) => {
        if (!old) return old;
        const lookup = Object.fromEntries(old.map((a) => [a.id, a]));
        return reordered.map((id) => lookup[id]).filter(Boolean);
      }
    );
    reorderCashMutation.mutate(reordered);
    dragCashRef.current = null;
  };

  const handlePayableDrop = (targetId: number) => {
    const fromId = dragPayableRef.current;
    if (!canConfigureDashboard || fromId === null || fromId === targetId) return;
    const paIds = dashboardPayableAccounts.map((d) => d.id);
    const fromIdx = paIds.indexOf(fromId);
    const toIdx = paIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...paIds];
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, fromId);
    queryClient.setQueryData(
      ["/api/dashboard-payable-accounts", selectedCompany?.id],
      (old: PayableAccount[] | undefined) => {
        if (!old) return old;
        const lookup = Object.fromEntries(old.map((a) => [a.id, a]));
        return reordered.map((id) => lookup[id]).filter(Boolean);
      }
    );
    reorderPayableMutation.mutate(reordered);
    dragPayableRef.current = null;
  };

  // Get available cash accounts (excluding ones already added)
  const availableCashAccounts = allAccounts
    .filter((acc) => {
      const alreadyAdded = dashboardCashAccounts.some(
        (dca) => dca.accountType === (acc.type || "").toLowerCase() && dca.accountId === acc.accountId
      );
      return !alreadyAdded;
    })
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  // Get available payable accounts (excluding ones already added)
  const availablePayableAccounts = allPayableAccounts
    .filter((acc) => {
      const alreadyAdded = dashboardPayableAccounts.some((dpa) => dpa.accountId === acc.accountId);
      return !alreadyAdded;
    })
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return {
    addAccountMutation,
    addPayableAccountMutation,
    allAccounts,
    availableCashAccounts,
    availablePayableAccounts,
    canConfigureDashboard,
    cashAccountsError,
    cashComboboxOpen,
    dashboardPayableAccounts,
    displayedCashAccounts,
    dragCashRef,
    dragPayableRef,
    formatAmount,
    handleCashDrop,
    handlePayableDrop,
    importCycleData,
    isAddDialogOpen,
    isAddPayableDialogOpen,
    isError,
    isLoading,
    payableAccountsError,
    payableComboboxOpen,
    profitData,
    removeAccountMutation,
    removePayableAccountMutation,
    selectedAccountId,
    selectedPayableAccountId,
    setCashComboboxOpen,
    setIsAddDialogOpen,
    setIsAddPayableDialogOpen,
    setPayableComboboxOpen,
    setSelectedAccountId,
    setSelectedPayableAccountId,
  };
}

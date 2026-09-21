import { visibleTabInterval } from "@/lib/queryPolicies";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { selectAccountsArray, type AccountsAllPayload } from "@/lib/accountsAllPayload";
import { useToast } from "@/hooks/use-toast";

import type {
  Account,
  DashboardCashAccount,
  FactoryDashboardKPIs,
  ImportCycleBalanceData,
  PayableAccount,
  ProfitData,
} from "./types";

type GlobalErrorMarker = {
  _handledGlobally?: unknown;
};

function isGloballyHandled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    Boolean((error as GlobalErrorMarker)._handledGlobally)
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useDashboard() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatHistoricalBaseAmount: formatAmount, formatCashAmount } = useCurrencyContext();
  const appMode = useAppMode();
  const modePrefix = useModePrefix();
  const modeApiRequest = getApiRequest(appMode);
  const [, setLocation] = useLocation();
  const isFactoryMode = appMode === "factory";

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isAddPayableDialogOpen, setIsAddPayableDialogOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number>(0);
  const [selectedPayableAccountId, setSelectedPayableAccountId] = useState<number>(0);
  const [payableComboboxOpen, setPayableComboboxOpen] = useState(false);
  const [cashComboboxOpen, setCashComboboxOpen] = useState(false);
  const [balesExpanded, setBalesExpanded] = useState(false);
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);
  const [importCycleExpanded, setImportCycleExpanded] = useState(false);

  const {
    data: profitData,
    isLoading,
    isError,
    refetch: refetchProfit,
  } = useQuery<ProfitData>({
    queryKey: ["/api/stats/net-profit", selectedCompany?.id],
    queryFn: async () => {
      const response = await modeApiRequest("GET", "/api/stats/net-profit");
      if (!response.ok) throw new Error("Failed to fetch net profit");
      return await response.json();
    },
    enabled: !!selectedCompany,
  });

  const {
    data: importCycleData,
    isError: importCycleIsError,
    isLoading: importCycleIsLoading,
  } = useQuery<ImportCycleBalanceData>({
    queryKey: ["/api/stats/import-cycle-balance", selectedCompany?.id, appMode],
    queryFn: async () => {
      const response = await modeApiRequest("GET", "/api/stats/import-cycle-balance");
      if (!response.ok) throw new Error("Failed to fetch import cycle balance");
      return await response.json();
    },
    enabled: !!selectedCompany,
    retry: 1,
  });

  const { data: factoryKPIs } = useQuery<FactoryDashboardKPIs>({
    queryKey: ["/api/factory/dashboard-kpis", selectedCompany?.id],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/dashboard-kpis");
      if (!res.ok) throw new Error("Failed to fetch factory KPIs");
      return res.json();
    },
    enabled: !!selectedCompany && isFactoryMode,
    refetchInterval: visibleTabInterval(5 * 60_000), // 5 min — KPIs don't need sub-minute freshness; was 60 s causing steady background load on Android
  });

  const { data: dashboardCashAccounts = [], error: cashAccountsError } = useQuery<DashboardCashAccount[]>({
    queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 30 * 1000,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  // Keep the shared /api/accounts/all cache in its server envelope shape and
  // normalize only for this observer. Other screens use the exact same query
  // key and may already have cached either the envelope or a legacy bare array.
  const { data: allAccounts = [] } = useQuery<AccountsAllPayload<Account>, Error, Account[]>({
    queryKey: ["/api/accounts/all", selectedCompany?.id],
    queryFn: async () => {
      const response = await modeApiRequest("GET", "/api/accounts/all");
      if (!response.ok) throw new Error("Failed to fetch accounts");
      return (await response.json()) as AccountsAllPayload<Account>;
    },
    select: selectAccountsArray,
    enabled: !!selectedCompany,
  });

  // Use the dedicated ledger-only endpoint — returns a plain array, no extraction needed.
  const { data: allPayableAccounts = [] } = useQuery<PayableAccount[]>({
    queryKey: ["/api/accounts/all-ledger", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: dashboardPayableAccounts = [], error: payableAccountsError } = useQuery<PayableAccount[]>({
    queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id],
    enabled: !!selectedCompany,
    staleTime: 30 * 1000,
    refetchInterval: visibleTabInterval(5 * 60_000),
  });

  const addAccountMutation = useMutation({
    mutationFn: async (data: { accountType: string; accountId: number }) => {
      return await modeApiRequest("POST", "/api/dashboard-cash-accounts", data);
    },
    onSuccess: () => {
      queryClient.refetchQueries({
        queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id],
      });
      setIsAddDialogOpen(false);
      setSelectedAccountId(0);
      toast({ title: "Success", description: "Account added to dashboard" });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "Error",
        description: getErrorMessage(error, "Failed to add account"),
        variant: "destructive",
      });
    },
  });

  const removeAccountMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/dashboard-cash-accounts/${id}`);
    },
    onSuccess: () => {
      queryClient.refetchQueries({
        queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id],
      });
      toast({
        title: "Success",
        description: "Account removed from dashboard",
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "Error",
        description: getErrorMessage(error, "Failed to remove account"),
        variant: "destructive",
      });
    },
  });

  const addPayableAccountMutation = useMutation({
    mutationFn: async (data: { accountId: number }) => {
      return await modeApiRequest("POST", "/api/dashboard-payable-accounts", data);
    },
    onSuccess: () => {
      queryClient.refetchQueries({
        queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id],
      });
      setIsAddPayableDialogOpen(false);
      setSelectedPayableAccountId(0);
      toast({
        title: "Success",
        description: "Payable account added to dashboard",
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "Error",
        description: getErrorMessage(error, "Failed to add payable account"),
        variant: "destructive",
      });
    },
  });

  const removePayableAccountMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/dashboard-payable-accounts/${id}`);
    },
    onSuccess: () => {
      queryClient.refetchQueries({
        queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id],
      });
      toast({
        title: "Success",
        description: "Account removed from dashboard",
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandled(error)) return;
      toast({
        title: "Error",
        description: getErrorMessage(error, "Failed to remove payable account"),
        variant: "destructive",
      });
    },
  });

  const dragCashRef = useRef<number | null>(null);
  const dragPayableRef = useRef<number | null>(null);

  const reorderCashMutation = useMutation({
    mutationFn: async (orderedIds: number[]) => {
      await modeApiRequest("PATCH", "/api/dashboard-cash-accounts/reorder", {
        orderedIds,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/dashboard-cash-accounts", selectedCompany?.id],
      });
    },
  });

  const reorderPayableMutation = useMutation({
    mutationFn: async (orderedIds: number[]) => {
      await modeApiRequest("PATCH", "/api/dashboard-payable-accounts/reorder", {
        orderedIds,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/dashboard-payable-accounts", selectedCompany?.id],
      });
    },
  });

  const handleCashDrop = (targetId: number) => {
    const fromId = dragCashRef.current;
    if (fromId === null || fromId === targetId) return;
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
    if (fromId === null || fromId === targetId) return;
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

  const availableCashAccounts = useMemo(
    () =>
      allAccounts
        .filter((acc) => {
          const alreadyAdded = dashboardCashAccounts.some(
            (dca) => dca.accountType === (acc.type || "").toLowerCase() && dca.accountId === acc.accountId
          );
          return !alreadyAdded;
        })
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [allAccounts, dashboardCashAccounts]
  );

  const displayedCashAccounts = dashboardCashAccounts;

  const availablePayableAccounts = useMemo(
    () =>
      allPayableAccounts
        .filter((acc) => {
          const alreadyAdded = dashboardPayableAccounts.some((dpa) => dpa.accountId === acc.accountId);
          return !alreadyAdded;
        })
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [allPayableAccounts, dashboardPayableAccounts]
  );

  const totalAvailable = useMemo(
    () =>
      displayedCashAccounts.reduce(
        (s, d) => s + parseFloat(String(d.account.balance || d.account.currentBalance || 0)),
        0
      ),
    [displayedCashAccounts]
  );
  const totalPayable = useMemo(
    () => dashboardPayableAccounts.reduce((s, a) => s + Math.abs(a.balance), 0),
    [dashboardPayableAccounts]
  );
  const netCashPosition = totalAvailable - totalPayable;

  // isError from net-profit: show the rest of the dashboard with an inline warning
  // rather than a blank error screen.  Other queries are unaffected.

  const importCycleBalance = importCycleData?.netImportCycleBalance ?? null;
  const isImportCycleBalanced = importCycleBalance !== null && Math.abs(importCycleBalance) < 1;

  return {
    selectedCompany,
    formatAmount,
    formatCashAmount,
    appMode,
    modePrefix,
    setLocation,
    isFactoryMode,
    isAddDialogOpen,
    setIsAddDialogOpen,
    isAddPayableDialogOpen,
    setIsAddPayableDialogOpen,
    selectedAccountId,
    setSelectedAccountId,
    selectedPayableAccountId,
    setSelectedPayableAccountId,
    payableComboboxOpen,
    setPayableComboboxOpen,
    cashComboboxOpen,
    setCashComboboxOpen,
    balesExpanded,
    setBalesExpanded,
    categoriesExpanded,
    setCategoriesExpanded,
    importCycleExpanded,
    setImportCycleExpanded,
    profitData,
    isLoading,
    isError,
    refetchProfit,
    importCycleData,
    importCycleIsError,
    importCycleIsLoading,
    factoryKPIs,
    cashAccountsError,
    allAccounts,
    dashboardPayableAccounts,
    payableAccountsError,
    addAccountMutation,
    removeAccountMutation,
    addPayableAccountMutation,
    removePayableAccountMutation,
    dragCashRef,
    dragPayableRef,
    handleCashDrop,
    handlePayableDrop,
    availableCashAccounts,
    displayedCashAccounts,
    availablePayableAccounts,
    totalAvailable,
    totalPayable,
    netCashPosition,
    importCycleBalance,
    isImportCycleBalanced,
  };
}

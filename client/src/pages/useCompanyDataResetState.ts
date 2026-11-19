// Extracted from ./CompanyDataReset.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { Company, LedgerAccount } from "@shared/schema";

export function useCompanyDataResetState() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [clearStockOpeningBalances, setClearStockOpeningBalances] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);

  const { data: companies = [], isLoading: loadingCompanies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: accounts = [], isLoading: loadingAccounts } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompanyId],
    enabled: !!selectedCompanyId,
  });

  // All ledger accounts - suppliers are stored separately in the suppliers table
  const allLedgerAccounts = accounts;

  const resetMutation = useMutation({
    mutationFn: async () => {
      return modeApiRequest("POST", "/api/admin/company-data-reset", {
        companyId: parseInt(selectedCompanyId),
        accountIds: selectedAccountIds,
        clearStockOpeningBalances,
      });
    },
    onSuccess: () => {
      toast({ title: "Reset Complete", description: "Selected data has been cleared successfully" });
      setSelectedAccountIds([]);
      setClearStockOpeningBalances(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Reset Failed", description: error.message, variant: "destructive" });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      return modeApiRequest("POST", "/api/admin/undo-company-reset", {
        companyId: parseInt(selectedCompanyId),
      });
    },
    onSuccess: async (res) => {
      const data = (await res.json()) as { vouchersRestored?: number };
      toast({
        title: "Undo Complete",
        description: `Restored ${data.vouchersRestored || 0} vouchers successfully`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Undo Failed", description: error.message, variant: "destructive" });
    },
  });

  const handleUndo = () => {
    setUndoDialogOpen(true);
  };

  const confirmUndo = () => {
    setUndoDialogOpen(false);
    undoMutation.mutate();
  };

  const toggleAccount = (accountId: number) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    );
  };

  const selectAll = () => {
    setSelectedAccountIds(allLedgerAccounts.map((a) => a.id));
  };

  const clearSelection = () => {
    setSelectedAccountIds([]);
  };

  const handleReset = () => {
    setConfirmDialogOpen(true);
  };

  const confirmReset = () => {
    setConfirmDialogOpen(false);
    resetMutation.mutate();
  };
  return {
    selectedCompanyId,
    setSelectedCompanyId,
    selectedAccountIds,
    clearStockOpeningBalances,
    setClearStockOpeningBalances,
    confirmDialogOpen,
    setConfirmDialogOpen,
    undoDialogOpen,
    setUndoDialogOpen,
    loadingCompanies,
    companies,
    loadingAccounts,
    allLedgerAccounts,
    resetMutation,
    undoMutation,
    handleUndo,
    confirmUndo,
    toggleAccount,
    selectAll,
    clearSelection,
    handleReset,
    confirmReset,
  };
}

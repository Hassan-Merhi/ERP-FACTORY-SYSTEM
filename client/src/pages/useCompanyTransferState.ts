// Extracted from ./CompanyTransfer.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, keyStartsWith, queryClient } from "@/lib/queryClient";
import { companyKeys } from "@/lib/queryKeys";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";

interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

interface Transfer {
  id: number;
  fromCompanyId: number;
  toCompanyId: number;
  fromCompanyName: string;
  toCompanyName: string;
  fromAccountName: string;
  toAccountName: string;
  amount: string;
  transferDate: string;
  description: string | null;
  createdAt: string;
}

interface AutoTransferConfig {
  id: number;
  companyId: number;
  module: string;
  destCompanyId: number;
  destLedgerAccountId: number;
  sourceCashAccountIds: number[];
  enabled: boolean;
  destCompanyName?: string | null;
  destAccountName?: string | null;
  sourceAccountNames?: { id: number; name: string }[];
}

export const MODULE_LABELS: Record<string, string> = {
  PROPERTIES: "Properties Rentals",
  ERP: "ERP Rentals",
  FACTORY: "Factory Rentals",
};

const MODULE_PREFIXES: Record<string, string> = {
  PROPERTIES: "/api/properties/rental",
  ERP: "/api/erp/rental",
  FACTORY: "/api/factory/rental",
};

export const MODULES = ["PROPERTIES", "ERP", "FACTORY"] as const;

// Transfer history stores the common USD accounting base, never a current
// Kwacha translation. Formatting through the active company's currency context
// mislabeled parent and Zambia accounting balances on this screen.
export const formatUsdBase = (value: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));

export function useCompanyTransferState() {
  const { companies, selectedCompany: currentCompany } = useCompany();
  const { toast } = useToast();

  const [undoTarget, setUndoTarget] = useState<Transfer | null>(null);
  const [addingModule, setAddingModule] = useState<string | null>(null);
  const [ruleDestCompanyId, setRuleDestCompanyId] = useState("");
  const [ruleDestAccountId, setRuleDestAccountId] = useState("");
  const [ruleCashAccountIds, setRuleCashAccountIds] = useState<number[]>([]);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [deleteConfirmRuleId, setDeleteConfirmRuleId] = useState<{ id: number; module: string } | null>(null);

  const fromCompanyId = currentCompany?.id;
  const otherCompanies = useMemo(
    () => companies.filter((company) => company.id !== fromCompanyId),
    [companies, fromCompanyId]
  );

  const { data: fromAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyKeys.companyAccounts(fromCompanyId, fromCompanyId),
    enabled: !!fromCompanyId,
  });

  const { data: ruleDestAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyKeys.companyAccounts(fromCompanyId, ruleDestCompanyId || null),
    enabled: !!fromCompanyId && !!ruleDestCompanyId,
  });

  const transferKey = companyKeys.simpleTransfers(fromCompanyId);
  const { data: transfers = [], isLoading } = useQuery<Transfer[]>({
    queryKey: transferKey,
    enabled: !!fromCompanyId,
  });

  const cfgProperties = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.PROPERTIES),
    enabled: !!fromCompanyId,
  });
  const cfgErp = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.ERP),
    enabled: !!fromCompanyId,
  });
  const cfgFactory = useQuery<AutoTransferConfig[]>({
    queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES.FACTORY),
    enabled: !!fromCompanyId,
  });
  const autoConfigQueries = [cfgProperties, cfgErp, cfgFactory];

  const undoMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/simple-company-transfer/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: transferKey });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/accounts"), refetchType: "active" });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/stats"), refetchType: "active" });
      toast({ title: "Transfer reversed", description: "Both company balances were restored." });
      setUndoTarget(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Undo failed", description: error.message, variant: "destructive" });
      setUndoTarget(null);
    },
  });

  const saveRuleMutation = useMutation({
    mutationFn: ({ module, body }: { module: string; body: object }) =>
      apiRequest("POST", `${MODULE_PREFIXES[module]}/auto-transfer-config`, body),
    onSuccess: (_, { module }) => {
      queryClient.invalidateQueries({
        queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES[module]),
      });
      toast({ title: "Rule added", description: "Auto-transfer rule is now active." });
      setAddingModule(null);
      setRuleDestCompanyId("");
      setRuleDestAccountId("");
      setRuleCashAccountIds([]);
      setRuleEnabled(true);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: ({ module, id }: { module: string; id: number }) =>
      apiRequest("DELETE", `${MODULE_PREFIXES[module]}/auto-transfer-config/${id}`),
    onSuccess: (_, { module }) => {
      queryClient.invalidateQueries({
        queryKey: companyKeys.autoTransferConfig(fromCompanyId, MODULE_PREFIXES[module]),
      });
      toast({ title: "Rule removed", description: "Auto-transfer rule deleted." });
      setDeleteConfirmRuleId(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      setDeleteConfirmRuleId(null);
    },
  });

  const openAddRule = (module: string) => {
    setAddingModule(module);
    setRuleDestCompanyId("");
    setRuleDestAccountId("");
    setRuleCashAccountIds([]);
    setRuleEnabled(true);
  };

  const toggleCashAccount = (id: number) => {
    setRuleCashAccountIds((previous) =>
      previous.includes(id) ? previous.filter((accountId) => accountId !== id) : [...previous, id]
    );
  };

  const handleSaveRule = () => {
    if (!addingModule || !ruleDestCompanyId || !ruleDestAccountId) {
      toast({
        title: "Missing fields",
        description: "Select destination company and account.",
        variant: "destructive",
      });
      return;
    }

    saveRuleMutation.mutate({
      module: addingModule,
      body: {
        destCompanyId: Number.parseInt(ruleDestCompanyId, 10),
        destLedgerAccountId: Number.parseInt(ruleDestAccountId, 10),
        sourceCashAccountIds: ruleCashAccountIds,
        enabled: ruleEnabled,
      },
    });
  };

  const accountOptions = (accounts: LedgerAccount[]) =>
    accounts.filter((account) => account.code !== "TRANSFER-CLEARING");
  return {
    accountOptions,
    addingModule,
    autoConfigQueries,
    deleteConfirmRuleId,
    deleteRuleMutation,
    fromAccounts,
    handleSaveRule,
    isLoading,
    openAddRule,
    otherCompanies,
    ruleCashAccountIds,
    ruleDestAccountId,
    ruleDestAccounts,
    ruleDestCompanyId,
    ruleEnabled,
    saveRuleMutation,
    setAddingModule,
    setDeleteConfirmRuleId,
    setRuleDestAccountId,
    setRuleDestCompanyId,
    setRuleEnabled,
    setUndoTarget,
    toggleCashAccount,
    transfers,
    undoMutation,
    undoTarget,
  };
}
